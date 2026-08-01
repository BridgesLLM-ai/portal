import crypto from 'crypto';
import { Prisma, ProjectChatTurnStatus } from '@prisma/client';
import { prisma } from '../config/database';
import {
  PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX,
  ProjectChatLeaseError,
  type ProjectChatRuntimeAdmissionGrant,
} from './projectChatTurnLease';

type ResetTransaction = Pick<
  Prisma.TransactionClient,
  | 'projectIdentity'
  | 'projectChatState'
  | 'projectChatTurn'
  | 'projectChatMessage'
  | 'projectChatSession'
  | 'projectChatProviderBinding'
  | 'projectChatDestructiveResetJournal'
  | 'legacyOpenClawProjectImport'
  | 'legacyOpenClawProjectQuarantine'
  | 'legacyOpenClawProjectClearTombstone'
>;

export interface ProjectChatDestructiveResetDatabase {
  $transaction<T>(
    callback: (transaction: ResetTransaction) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
}

const defaultDatabase = prisma as unknown as ProjectChatDestructiveResetDatabase;
const MAX_SERIALIZABLE_ATTEMPTS = 4;
const MAX_LEGACY_CLEAR_PROOFS = 4096;

function legacyClearInventoryFingerprint(rows: readonly Record<string, any>[]): string {
  const inventory = rows.map((row) => ({
    actorUserId: row.actorUserId,
    projectIdentityId: row.projectIdentityId,
    projectGeneration: row.projectGeneration,
    sourceAgentId: row.sourceAgentId,
    sourceAgentHash: row.sourceAgentHash,
    sourceSessionKey: row.sourceSessionKey,
    sessionKeyHash: row.sessionKeyHash,
    sourceKind: row.sourceKind,
    providerSessionId: row.providerSessionId,
    providerSessionIdHash: row.providerSessionIdHash,
    sourceFingerprint: row.sourceFingerprint,
    agentInventoryFingerprint: row.agentInventoryFingerprint,
    totalMessages: row.totalMessages,
    importedMessages: row.importedMessages,
    transcriptDigest: row.transcriptDigest,
    projectionDigest: row.projectionDigest,
    completedAt: row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt,
    retiredAt: row.retiredAt instanceof Date ? row.retiredAt.toISOString() : row.retiredAt,
    sourceStatus: 'CLEARED',
  })).sort((left, right) => (
    String(left.sourceAgentHash).localeCompare(String(right.sourceAgentHash))
    || String(left.sessionKeyHash).localeCompare(String(right.sessionKeyHash))
  ));
  return crypto.createHash('sha256').update(JSON.stringify(inventory), 'utf8').digest('hex');
}

export class ProjectChatDestructiveResetActiveError extends Error {
  readonly code = 'PROJECT_CHAT_RESET_PENDING';

  constructor() {
    super('Project lifecycle work is paused until the pending Project Chat reset finishes.');
    this.name = 'ProjectChatDestructiveResetActiveError';
  }
}

export async function assertProjectChatDestructiveResetInactive(
  projectIdentityId: string,
  database: Pick<typeof prisma, 'projectChatDestructiveResetJournal'> = prisma,
): Promise<void> {
  const normalizedProjectIdentityId = requiredIdentifier(projectIdentityId, 'project identity');
  const pending = await database.projectChatDestructiveResetJournal.findFirst({
    where: { projectIdentityId: normalizedProjectIdentityId, status: 'RESETTING' },
    select: { id: true },
  });
  if (pending) throw new ProjectChatDestructiveResetActiveError();
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || normalized.includes('\u0000')) {
    throw new ProjectChatLeaseError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return normalized;
}

function matchesLeaseToken(storedDigest: string, token: string): boolean {
  const candidate = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const stored = Buffer.from(storedDigest, 'hex');
  const supplied = Buffer.from(candidate, 'hex');
  return stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === 'P2034' || error.code === 'P2002');
}

async function serializable<T>(
  database: ProjectChatDestructiveResetDatabase,
  operation: (transaction: ResetTransaction) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5));
    }
  }
  throw lastError;
}

export interface ProjectChatDestructiveResetResult {
  deletedMessages: number;
  expiredSessions: number;
  resetBindings: number;
  deletedPriorTurns: number;
}

/**
 * Commits a reset tombstone before the first external provider mutation. The
 * generic runtime admission may later finalize ERROR, but this row remains
 * RESETTING until the authoritative SQL transcript deletion commits.
 */
export async function markProjectChatDestructiveResetStarted(input: {
  actorUserId: string;
  projectIdentityId: string;
  legacyProjectId?: string;
  admission: ProjectChatRuntimeAdmissionGrant;
  now?: Date;
}, database: ProjectChatDestructiveResetDatabase = defaultDatabase): Promise<void> {
  const actorUserId = requiredIdentifier(input.actorUserId, 'authenticated actor');
  const projectIdentityId = requiredIdentifier(input.projectIdentityId, 'project identity');
  const legacyProjectId = input.legacyProjectId == null
    ? null
    : requiredIdentifier(input.legacyProjectId, 'legacy project identity');
  const admissionTurnId = requiredIdentifier(input.admission.turn.id, 'runtime admission turn');
  const leaseToken = requiredIdentifier(input.admission.leaseToken, 'runtime admission lease');
  const expectedStateVersion = Number(input.admission.state.version);
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Invalid runtime admission state version', 400);
  }
  const now = input.now || new Date();

  await serializable(database, async (transaction) => {
    const [state, admissionTurn, identity, resetJournal] = await Promise.all([
      transaction.projectChatState.findUnique({
        where: { actorUserId_projectIdentityId: { actorUserId, projectIdentityId } },
      }),
      transaction.projectChatTurn.findUnique({ where: { id: admissionTurnId } }),
      transaction.projectIdentity.findUnique({ where: { id: projectIdentityId } }),
      transaction.projectChatDestructiveResetJournal.findUnique({
        where: { actorUserId_projectIdentityId: { actorUserId, projectIdentityId } },
      }),
    ]);
    if (
      !state
      || state.activeTurnId !== admissionTurnId
      || state.version !== expectedStateVersion
      || !admissionTurn
      || admissionTurn.actorUserId !== actorUserId
      || admissionTurn.projectIdentityId !== projectIdentityId
      || admissionTurn.status !== ProjectChatTurnStatus.RUNNING
      || !String(admissionTurn.requestId || '').startsWith(PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX)
      || !matchesLeaseToken(admissionTurn.leaseTokenHash, leaseToken)
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset admission could not establish its durable tombstone',
        500,
      );
    }
    if (
      !identity
      || identity.lifecycleStatus !== 'ACTIVE'
      || (identity.legacyOpenClawMigrationStatus === 'PENDING' && !resetJournal)
      || !Number.isSafeInteger(identity.generation)
      || identity.generation <= 0
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset could not attest the active project generation',
        500,
      );
    }
    if (
      resetJournal
      && (
        resetJournal.status !== 'RESETTING'
        || resetJournal.projectGeneration !== identity.generation
        || resetJournal.legacyProjectId !== legacyProjectId
      )
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset collided with a different durable tombstone',
        500,
      );
    }
    await transaction.projectChatDestructiveResetJournal.upsert({
      where: { actorUserId_projectIdentityId: { actorUserId, projectIdentityId } },
      update: {
        admissionTurnId,
        projectGeneration: identity.generation,
        legacyProjectId,
        status: 'RESETTING',
        externalMutationStartedAt: now,
        completedAt: null,
      },
      create: {
        actorUserId,
        projectIdentityId,
        projectGeneration: identity.generation,
        admissionTurnId,
        legacyProjectId,
        status: 'RESETTING',
        externalMutationStartedAt: now,
      },
    });
  });
}

/**
 * Turns provider cancellation into a fail-closed reset prerequisite. Both a
 * `false` result and an exception remain blocking while the durable turn is
 * active; neither is silently converted into permission to delete history.
 */
export async function requireConfirmedProjectChatAbortForReset(input: {
  hasExactBrokerRun: boolean;
  abortBroker: () => Promise<boolean>;
  waitForBrokerSettlement: () => Promise<boolean>;
  abortProvider: () => Promise<boolean>;
  isTurnStillActive: () => Promise<boolean>;
}): Promise<void> {
  let providerStopConfirmed = false;
  try {
    const brokerConfirmed = await input.abortBroker();
    providerStopConfirmed = brokerConfirmed || await input.abortProvider();

    // A provider's synchronous abort acknowledgement can precede rejection of
    // sendMessage and the broker's onError/onSettled callbacks (notably
    // Ollama). When this process owns the exact run, the callback boundary is
    // the authoritative stop proof and must settle before reset can continue.
    if (input.hasExactBrokerRun) {
      if (await input.waitForBrokerSettlement()) return;
    } else if (providerStopConfirmed) {
      // After a backend restart no process-local callbacks exist. The exact
      // provider/session abort acknowledgement is therefore sufficient.
      return;
    }
  } catch (error) {
    if (!(await input.isTurnStillActive())) return;
    const resetError = new ProjectChatLeaseError(
      'TURN_ACTIVE',
      'The provider process raised an error while confirming cancellation; no Project Chat data was cleared.',
      409,
    );
    (resetError as Error & { cause?: unknown }).cause = error;
    throw resetError;
  }
  if (!(await input.isTurnStillActive())) return;
  throw new ProjectChatLeaseError(
    'TURN_ACTIVE',
    'The provider process could not confirm cancellation; no Project Chat data was cleared.',
    409,
  );
}

/**
 * Recovers a management admission captured in a backup/host migration only
 * after the authenticated destructive-reset route has terminated every
 * attested provider binding. Unlike ordinary admission takeover, this path
 * does not trust a hostname/PID or lease expiry as provider-stop evidence;
 * the caller must first perform the destructive provider-session boundary.
 */
export async function recoverExpiredProjectChatRuntimeAdmissionForDestructiveReset(input: {
  actorUserId: string;
  projectIdentityId: string;
  turnId: string;
  expectedVersion: number;
  now?: Date;
}, database: ProjectChatDestructiveResetDatabase = defaultDatabase): Promise<void> {
  const actorUserId = requiredIdentifier(input.actorUserId, 'authenticated actor');
  const projectIdentityId = requiredIdentifier(input.projectIdentityId, 'project identity');
  const turnId = requiredIdentifier(input.turnId, 'runtime admission turn');
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Invalid runtime admission state version', 400);
  }
  const now = input.now || new Date();

  await serializable(database, async (transaction) => {
    const [state, turn] = await Promise.all([
      transaction.projectChatState.findUnique({
        where: { actorUserId_projectIdentityId: { actorUserId, projectIdentityId } },
      }),
      transaction.projectChatTurn.findUnique({ where: { id: turnId } }),
    ]);
    if (
      !state
      || state.version !== expectedVersion
      || state.activeTurnId !== turnId
      || !turn
      || turn.actorUserId !== actorUserId
      || turn.projectIdentityId !== projectIdentityId
      || !String(turn.requestId || '').startsWith(PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX)
      || (turn.status !== ProjectChatTurnStatus.RUNNING
        && turn.status !== ProjectChatTurnStatus.ABORTING)
      || turn.leaseExpiresAt.getTime() > now.getTime()
    ) {
      throw new ProjectChatLeaseError(
        'TURN_ACTIVE',
        'Project Chat runtime admission is not an expired exact reset-recovery candidate',
        409,
      );
    }
    const finalized = await transaction.projectChatTurn.updateMany({
      where: {
        id: turn.id,
        status: { in: [ProjectChatTurnStatus.RUNNING, ProjectChatTurnStatus.ABORTING] },
        leaseExpiresAt: { lte: now },
        requestId: { startsWith: PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX },
      },
      data: {
        status: ProjectChatTurnStatus.ERROR,
        activeProjectKey: null,
        completedAt: now,
        errorCode: 'DESTRUCTIVE_RESET_RECOVERED_RUNTIME_ADMISSION',
        errorMessage: 'Destructive reset retired an expired management admission after provider-session termination.',
      },
    });
    if (finalized.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Runtime admission changed during reset recovery');
    }
    const detached = await transaction.projectChatState.updateMany({
      where: { id: state.id, version: expectedVersion, activeTurnId: turn.id },
      data: { activeTurnId: null, version: { increment: 1 } },
    });
    if (detached.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Runtime admission lost its reset recovery fence');
    }
  });
}

/**
 * Clears every provider's shared Project Chat state while a runtime admission
 * owns the actor/project CAS slot. Prior durable turns are reset tombstones:
 * projection repair and delayed settlement must re-read a turn from the
 * database, so deleting it in this same Serializable transaction prevents an
 * old callback from recreating a cleared assistant row.
 */
export async function commitProjectChatDestructiveReset(input: {
  actorUserId: string;
  projectIdentityId: string;
  legacyProjectId?: string;
  admission: ProjectChatRuntimeAdmissionGrant;
  now?: Date;
}, database: ProjectChatDestructiveResetDatabase = defaultDatabase): Promise<ProjectChatDestructiveResetResult> {
  const actorUserId = requiredIdentifier(input.actorUserId, 'authenticated actor');
  const projectIdentityId = requiredIdentifier(input.projectIdentityId, 'project identity');
  const legacyProjectIdInput = input.legacyProjectId == null
    ? null
    : requiredIdentifier(input.legacyProjectId, 'legacy project identity');
  const legacyProjectId = legacyProjectIdInput && legacyProjectIdInput !== projectIdentityId
    ? legacyProjectIdInput
    : null;
  const admissionTurnId = requiredIdentifier(input.admission.turn.id, 'runtime admission turn');
  const leaseToken = requiredIdentifier(input.admission.leaseToken, 'runtime admission lease');
  const expectedStateVersion = Number(input.admission.state.version);
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Invalid runtime admission state version', 400);
  }
  const now = input.now || new Date();

  return serializable(database, async (transaction) => {
    const [state, admissionTurn, identity, resetJournal] = await Promise.all([
      transaction.projectChatState.findUnique({
        where: { actorUserId_projectIdentityId: { actorUserId, projectIdentityId } },
      }),
      transaction.projectChatTurn.findUnique({ where: { id: admissionTurnId } }),
      transaction.projectIdentity.findUnique({ where: { id: projectIdentityId } }),
      transaction.projectChatDestructiveResetJournal.findUnique({
        where: { actorUserId_projectIdentityId: { actorUserId, projectIdentityId } },
      }),
    ]);
    if (
      !state
      || state.activeTurnId !== admissionTurnId
      || state.version !== expectedStateVersion
    ) {
      throw new ProjectChatLeaseError(
        'VERSION_CONFLICT',
        'Project Chat reset lost its exclusive runtime admission',
      );
    }
    if (
      !admissionTurn
      || admissionTurn.actorUserId !== actorUserId
      || admissionTurn.projectIdentityId !== projectIdentityId
      || admissionTurn.status !== ProjectChatTurnStatus.RUNNING
      || !String(admissionTurn.requestId || '').startsWith(PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX)
      || !matchesLeaseToken(admissionTurn.leaseTokenHash, leaseToken)
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset admission could not be attested',
        500,
      );
    }
    if (
      !resetJournal
      || !identity
      || identity.generation !== resetJournal.projectGeneration
      || resetJournal.status !== 'RESETTING'
      || resetJournal.admissionTurnId !== admissionTurnId
      || resetJournal.legacyProjectId !== legacyProjectIdInput
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset lost its durable external-mutation tombstone',
        500,
      );
    }

    const importProofs = await transaction.legacyOpenClawProjectImport.findMany({
      where: { actorUserId, projectIdentityId },
      orderBy: [{ sourceAgentHash: 'asc' }, { sessionKeyHash: 'asc' }],
      take: MAX_LEGACY_CLEAR_PROOFS + 1,
    });
    if (importProofs.length > MAX_LEGACY_CLEAR_PROOFS) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat clear proof inventory exceeded its safety limit',
        500,
      );
    }
    if (importProofs.some((proof) => !['RETIRED', 'CLEARED'].includes(proof.sourceStatus))) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat history cannot be cleared before every legacy source is retired',
        500,
      );
    }
    const sourceInventoryFingerprint = legacyClearInventoryFingerprint(importProofs);
    const existingClearTombstone = await transaction.legacyOpenClawProjectClearTombstone.findUnique({
      where: {
        actorUserId_projectIdentityId_projectGeneration: {
          actorUserId,
          projectIdentityId,
          projectGeneration: resetJournal.projectGeneration,
        },
      },
    });
    if (existingClearTombstone) {
      if (existingClearTombstone.sourceInventoryFingerprint !== sourceInventoryFingerprint) {
        throw new ProjectChatLeaseError(
          'STATE_CORRUPT',
          'Project Chat clear tombstone collided with a different legacy source inventory',
          500,
        );
      }
    } else {
      await transaction.legacyOpenClawProjectClearTombstone.create({
        data: {
          actorUserId,
          projectIdentityId,
          projectGeneration: resetJournal.projectGeneration,
          admissionTurnId,
          sourceInventoryFingerprint,
          clearedAt: now,
        },
      });
    }

    const [
      messages,
      sessions,
      bindings,
      turns,
      legacyMessages,
      legacySessions,
      legacyBindings,
    ] = await Promise.all([
      transaction.projectChatMessage.deleteMany({ where: { userId: actorUserId, projectId: projectIdentityId } }),
      transaction.projectChatSession.updateMany({
        where: { userId: actorUserId, projectId: projectIdentityId },
        data: { status: 'expired', lastActivity: now },
      }),
      transaction.projectChatProviderBinding.updateMany({
        where: { userId: actorUserId, projectId: projectIdentityId },
        data: {
          status: 'reset',
          sessionKey: null,
          externalSessionId: null,
          handoffCursor: 0,
          handoffVersion: { increment: 1 },
          lastActivity: now,
        },
      }),
      transaction.projectChatTurn.deleteMany({
        where: {
          actorUserId,
          projectIdentityId,
          id: { not: admissionTurnId },
        },
      }),
      legacyProjectId
        ? transaction.projectChatMessage.deleteMany({ where: { userId: actorUserId, projectId: legacyProjectId } })
        : Promise.resolve({ count: 0 }),
      legacyProjectId
        ? transaction.projectChatSession.deleteMany({ where: { userId: actorUserId, projectId: legacyProjectId } })
        : Promise.resolve({ count: 0 }),
      legacyProjectId
        ? transaction.projectChatProviderBinding.deleteMany({ where: { userId: actorUserId, projectId: legacyProjectId } })
        : Promise.resolve({ count: 0 }),
      transaction.legacyOpenClawProjectQuarantine.deleteMany({
        where: { actorUserId, projectIdentityId },
      }),
      transaction.legacyOpenClawProjectImport.updateMany({
        where: { actorUserId, projectIdentityId, sourceStatus: 'RETIRED' },
        data: { sourceStatus: 'CLEARED', clearedAt: now },
      }),
    ]);

    const [
      remainingMessages,
      remainingPriorTurns,
      staleBindings,
      liveSessions,
      remainingLegacyMessages,
      remainingLegacySessions,
      remainingLegacyBindings,
      remainingQuarantines,
      remainingImportProofs,
    ] = await Promise.all([
      transaction.projectChatMessage.count({ where: { userId: actorUserId, projectId: projectIdentityId } }),
      transaction.projectChatTurn.count({
        where: { actorUserId, projectIdentityId, id: { not: admissionTurnId } },
      }),
      transaction.projectChatProviderBinding.count({
        where: {
          userId: actorUserId,
          projectId: projectIdentityId,
          OR: [
            { status: { not: 'reset' } },
            { sessionKey: { not: null } },
            { externalSessionId: { not: null } },
            { handoffCursor: { not: 0 } },
          ],
        },
      }),
      transaction.projectChatSession.count({
        where: { userId: actorUserId, projectId: projectIdentityId, status: { not: 'expired' } },
      }),
      legacyProjectId
        ? transaction.projectChatMessage.count({ where: { userId: actorUserId, projectId: legacyProjectId } })
        : Promise.resolve(0),
      legacyProjectId
        ? transaction.projectChatSession.count({ where: { userId: actorUserId, projectId: legacyProjectId } })
        : Promise.resolve(0),
      legacyProjectId
        ? transaction.projectChatProviderBinding.count({ where: { userId: actorUserId, projectId: legacyProjectId } })
        : Promise.resolve(0),
      transaction.legacyOpenClawProjectQuarantine.count({
        where: { actorUserId, projectIdentityId },
      }),
      transaction.legacyOpenClawProjectImport.count({
        where: { actorUserId, projectIdentityId, sourceStatus: { not: 'CLEARED' } },
      }),
    ]);
    if (
      remainingMessages !== 0
      || remainingPriorTurns !== 0
      || staleBindings !== 0
      || liveSessions !== 0
      || remainingLegacyMessages !== 0
      || remainingLegacySessions !== 0
      || remainingLegacyBindings !== 0
      || remainingQuarantines !== 0
      || remainingImportProofs !== 0
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset did not converge every provider and transcript record',
        500,
      );
    }

    const clearedJournal = await transaction.projectChatDestructiveResetJournal.deleteMany({
      where: {
        id: resetJournal.id,
        actorUserId,
        projectIdentityId,
        projectGeneration: resetJournal.projectGeneration,
        admissionTurnId,
        status: 'RESETTING',
      },
    });
    if (clearedJournal.count !== 1) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat reset tombstone changed before transcript commit',
        500,
      );
    }

    return {
      deletedMessages: messages.count + legacyMessages.count,
      expiredSessions: sessions.count + legacySessions.count,
      resetBindings: bindings.count + legacyBindings.count,
      deletedPriorTurns: turns.count,
    };
  });
}
