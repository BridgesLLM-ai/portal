import { prisma } from '../config/database';
import { canUseInteractivePortal } from '../utils/authz';
import { deriveOpenClawProjectSessionKey } from './openclawProjectSandbox';
import {
  AskUserQuestionError,
  readPendingAskUserQuestionForActor,
  registerAskUserQuestion,
  type AskUserQuestionRecord,
} from './askUserQuestionBroker';

interface FindManyDelegate {
  findMany(args: Record<string, unknown>): Promise<any[]>;
}

export interface AskUserQuestionOwnerDatabase {
  agentSession: FindManyDelegate;
  openClawHostRun: FindManyDelegate;
  projectAuthorizationTransition: FindManyDelegate;
  projectChatProviderBinding: FindManyDelegate;
  projectChatSession: FindManyDelegate;
  projectChatState: FindManyDelegate;
  projectChatTurn: FindManyDelegate;
  projectIdentity: FindManyDelegate;
  user: FindManyDelegate;
}

export interface AskUserQuestionRunIdentity {
  sessionKey: string;
  runId: string;
  toolCallId: string;
}

export interface AskUserQuestionRunOwnership extends AskUserQuestionRunIdentity {
  ownerUserId: string;
  surface: 'agent-chat' | 'project-chat';
  authorityId: string;
  actorAuthorizationVersion: number;
  projectIdentityId: string | null;
}

export type AskUserQuestionRunCandidate = Omit<AskUserQuestionRunOwnership, 'toolCallId'>;

function requiredIdentifier(
  value: unknown,
  label: 'actor identity' | 'session key' | 'run identity' | 'tool-call identity',
  maxLength: number,
): string {
  const normalized = String(value || '').trim();
  if (
    !normalized
    || normalized.length > maxLength
    || /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_IDENTITY_REQUIRED',
      `A valid ${label} is required.`,
    );
  }
  return normalized;
}

function exactSingle<T>(rows: T[]): T | null {
  return rows.length === 1 ? rows[0] : null;
}

function acceptedProjectDispatch(row: any): boolean {
  return row?.resultMetadata
    && typeof row.resultMetadata === 'object'
    && row.resultMetadata.providerDispatchStage === 'DISPATCH_ACCEPTED';
}

async function actorIsCurrentlyAuthorized(
  database: AskUserQuestionOwnerDatabase,
  actorUserId: string,
  authorizationVersion: unknown,
): Promise<boolean> {
  const actors = await database.user.findMany({
    where: {
      id: actorUserId,
      authorizationVersion: Number(authorizationVersion),
      accountStatus: 'ACTIVE',
      isActive: true,
    },
    select: {
      id: true,
      role: true,
      authorizationVersion: true,
      accountStatus: true,
      isActive: true,
    },
    take: 2,
  });
  const actor = exactSingle(actors);
  return Boolean(
    actor
    && actor.id === actorUserId
    && Number(actor.authorizationVersion) === Number(authorizationVersion)
    && actor.accountStatus === 'ACTIVE'
    && actor.isActive === true
    && canUseInteractivePortal(actor.role, actor.accountStatus, actor.isActive)
  );
}

async function resolveAgentChatOwner(
  identity: AskUserQuestionRunIdentity,
  hostRuns: any[],
  database: AskUserQuestionOwnerDatabase,
): Promise<AskUserQuestionRunOwnership | null> {
  const run = exactSingle(hostRuns);
  if (!run) return null;
  if (
    run.provider !== 'OPENCLAW'
    || run.executionScope !== 'HOST_OPERATOR'
    || run.status !== 'DISPATCHED'
    || run.sessionKey !== identity.sessionKey
    || run.upstreamRunId !== identity.runId
  ) return null;

  const claims = await database.agentSession.findMany({
    where: {
      provider: 'OPENCLAW',
      externalId: identity.sessionKey,
      status: 'active',
    },
    select: { userId: true, status: true },
    take: 2,
  });
  const claim = exactSingle(claims);
  if (
    !claim
    || claim.userId !== run.actorUserId
    || claim.status !== 'active'
  ) return null;
  if (!await actorIsCurrentlyAuthorized(
    database,
    run.actorUserId,
    run.actorAuthorizationVersion,
  )) return null;
  return {
    ...identity,
    ownerUserId: run.actorUserId,
    surface: 'agent-chat',
    authorityId: run.id,
    actorAuthorizationVersion: Number(run.actorAuthorizationVersion),
    projectIdentityId: null,
  };
}

async function resolveProjectChatOwner(
  identity: AskUserQuestionRunIdentity,
  projectTurns: any[],
  database: AskUserQuestionOwnerDatabase,
  now: Date,
): Promise<AskUserQuestionRunOwnership | null> {
  const turn = exactSingle(projectTurns);
  if (!turn) return null;
  if (
    identity.runId !== `portal-${turn.id}`
    || turn.provider !== 'OPENCLAW'
    || turn.status !== 'RUNNING'
    || turn.providerSessionId !== identity.sessionKey
    || deriveOpenClawProjectSessionKey({
      userId: turn.actorUserId,
      projectId: turn.projectIdentityId,
    }) !== identity.sessionKey
    || turn.activeProjectKey !== turn.projectIdentityId
    || !(turn.leaseExpiresAt instanceof Date)
    || turn.leaseExpiresAt.getTime() <= now.getTime()
    || !acceptedProjectDispatch(turn)
  ) return null;

  const [states, bindings, sessions, projects] = await Promise.all([
    database.projectChatState.findMany({
      where: {
        id: turn.stateId,
        actorUserId: turn.actorUserId,
        projectIdentityId: turn.projectIdentityId,
        selectedProvider: 'OPENCLAW',
        activeTurnId: turn.id,
      },
      select: {
        id: true,
        actorUserId: true,
        projectIdentityId: true,
        selectedProvider: true,
        activeTurnId: true,
      },
      take: 2,
    }),
    database.projectChatProviderBinding.findMany({
      where: {
        userId: turn.actorUserId,
        projectId: turn.projectIdentityId,
        provider: 'OPENCLAW',
        status: 'active',
        sessionKey: identity.sessionKey,
        externalSessionId: identity.sessionKey,
      },
      select: {
        userId: true,
        projectId: true,
        provider: true,
        status: true,
        sessionKey: true,
        externalSessionId: true,
      },
      take: 2,
    }),
    database.projectChatSession.findMany({
      where: {
        userId: turn.actorUserId,
        projectId: turn.projectIdentityId,
        sessionKey: identity.sessionKey,
        status: 'active',
        activeProvider: 'OPENCLAW',
      },
      select: {
        userId: true,
        projectId: true,
        sessionKey: true,
        status: true,
        activeProvider: true,
      },
      take: 2,
    }),
    database.projectIdentity.findMany({
      where: {
        id: turn.projectIdentityId,
        lifecycleStatus: 'ACTIVE',
        legacyOpenClawMigrationStatus: { not: 'PENDING' },
      },
      select: { id: true, lifecycleStatus: true, legacyOpenClawMigrationStatus: true },
      take: 2,
    }),
  ]);

  const state = exactSingle(states);
  const binding = exactSingle(bindings);
  const session = exactSingle(sessions);
  const project = exactSingle(projects);
  if (
    !state
    || state.actorUserId !== turn.actorUserId
    || state.projectIdentityId !== turn.projectIdentityId
    || state.selectedProvider !== 'OPENCLAW'
    || state.activeTurnId !== turn.id
    || !binding
    || binding.userId !== turn.actorUserId
    || binding.projectId !== turn.projectIdentityId
    || binding.provider !== 'OPENCLAW'
    || binding.status !== 'active'
    || binding.sessionKey !== identity.sessionKey
    || binding.externalSessionId !== identity.sessionKey
    || !session
    || session.userId !== turn.actorUserId
    || session.projectId !== turn.projectIdentityId
    || session.sessionKey !== identity.sessionKey
    || session.status !== 'active'
    || session.activeProvider !== 'OPENCLAW'
    || !project
    || project.id !== turn.projectIdentityId
    || project.lifecycleStatus !== 'ACTIVE'
    || project.legacyOpenClawMigrationStatus === 'PENDING'
  ) return null;
  if (!await actorIsCurrentlyAuthorized(
    database,
    turn.actorUserId,
    turn.actorAuthorizationVersion,
  )) return null;
  return {
    ...identity,
    ownerUserId: turn.actorUserId,
    surface: 'project-chat',
    authorityId: turn.id,
    actorAuthorizationVersion: Number(turn.actorAuthorizationVersion),
    projectIdentityId: turn.projectIdentityId,
  };
}

/**
 * Bind a plugin registration to the exact active Portal-owned OpenClaw run.
 * Session ownership by itself is not enough: session keys persist after turns
 * settle and can be re-bound during authorization changes. The hook-supplied
 * upstream run identity is corroborated against the active Agent Chat journal
 * or the active Project Chat turn and all of that turn's durable authority.
 */
export async function resolveAskUserQuestionRunOwner(
  input: {
    sessionKey: unknown;
    runId: unknown;
    toolCallId: unknown;
  },
  database: AskUserQuestionOwnerDatabase = prisma as unknown as AskUserQuestionOwnerDatabase,
  now = new Date(),
): Promise<AskUserQuestionRunOwnership> {
  const identity: AskUserQuestionRunIdentity = {
    sessionKey: requiredIdentifier(input.sessionKey, 'session key', 512),
    runId: requiredIdentifier(input.runId, 'run identity', 512),
    toolCallId: requiredIdentifier(input.toolCallId, 'tool-call identity', 256),
  };
  const projectTurnId = identity.runId.startsWith('portal-')
    ? identity.runId.slice('portal-'.length)
    : '';

  const [transitions, hostRuns, projectTurns] = await Promise.all([
    database.projectAuthorizationTransition.findMany({
      where: { phase: { not: 'COMPLETE' } },
      select: { id: true },
      take: 1,
    }),
    database.openClawHostRun.findMany({
      where: {
        provider: 'OPENCLAW',
        executionScope: 'HOST_OPERATOR',
        sessionKey: identity.sessionKey,
        status: 'DISPATCHED',
        upstreamRunId: identity.runId,
      },
      select: {
        id: true,
        actorUserId: true,
        actorAuthorizationVersion: true,
        provider: true,
        executionScope: true,
        sessionKey: true,
        status: true,
        upstreamRunId: true,
      },
      take: 2,
    }),
    projectTurnId
      ? database.projectChatTurn.findMany({
        where: {
          id: projectTurnId,
          provider: 'OPENCLAW',
          status: 'RUNNING',
          providerSessionId: identity.sessionKey,
          activeProjectKey: { not: null },
          leaseExpiresAt: { gt: now },
        },
        select: {
          id: true,
          stateId: true,
          actorUserId: true,
          actorAuthorizationVersion: true,
          projectIdentityId: true,
          activeProjectKey: true,
          provider: true,
          status: true,
          providerSessionId: true,
          leaseExpiresAt: true,
          resultMetadata: true,
        },
        take: 2,
      })
      : Promise.resolve([]),
  ]);

  if (transitions.length > 0) {
    throw new AskUserQuestionError(
      'ASK_USER_AUTHORIZATION_TRANSITION',
      'Question registration is unavailable during an authorization change.',
      503,
    );
  }
  if (hostRuns.length > 1 || projectTurns.length > 1) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_AMBIGUOUS',
      'The question run has conflicting ownership evidence.',
      409,
    );
  }

  const proofs = (await Promise.all([
    resolveAgentChatOwner(identity, hostRuns, database),
    resolveProjectChatOwner(identity, projectTurns, database, now),
  ])).filter((proof): proof is AskUserQuestionRunOwnership => Boolean(proof));
  if (proofs.length === 0) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_UNOWNED',
      'The question does not match an active Portal-owned run.',
      403,
    );
  }
  if (proofs.length !== 1) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_AMBIGUOUS',
      'The question run has conflicting ownership evidence.',
      409,
    );
  }
  return proofs[0];
}

const MAX_DISCOVERED_ACTIVE_RUNS = 64;

/**
 * Discover active Portal-owned OpenClaw runs from server-side journals only.
 * The browser supplies, at most, a session filter; it never supplies a run or
 * native request identity. Multiple active claims for one session fail closed.
 */
export async function discoverAskUserQuestionRunsForActor(
  input: {
    actorUserId: unknown;
    sessionKey?: unknown;
    actorAuthorizationVersion?: unknown;
  },
  database: AskUserQuestionOwnerDatabase = prisma as unknown as AskUserQuestionOwnerDatabase,
  now = new Date(),
): Promise<AskUserQuestionRunCandidate[]> {
  const actorUserId = requiredIdentifier(input.actorUserId, 'actor identity', 128);
  const sessionKey = input.sessionKey == null || String(input.sessionKey).trim() === ''
    ? ''
    : requiredIdentifier(input.sessionKey, 'session key', 512);
  const requestedAuthorizationVersion = input.actorAuthorizationVersion == null
    ? null
    : Number(input.actorAuthorizationVersion);
  if (
    requestedAuthorizationVersion !== null
    && (!Number.isSafeInteger(requestedAuthorizationVersion) || requestedAuthorizationVersion < 1)
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_UNOWNED',
      'No active Portal-owned run is available.',
      403,
    );
  }

  const [transitions, hostRuns, projectTurns] = await Promise.all([
    database.projectAuthorizationTransition.findMany({
      where: { phase: { not: 'COMPLETE' } },
      select: { id: true },
      take: 1,
    }),
    database.openClawHostRun.findMany({
      where: {
        provider: 'OPENCLAW',
        executionScope: 'HOST_OPERATOR',
        actorUserId,
        status: 'DISPATCHED',
        ...(sessionKey ? { sessionKey } : {}),
      },
      select: {
        id: true,
        actorUserId: true,
        actorAuthorizationVersion: true,
        provider: true,
        executionScope: true,
        sessionKey: true,
        status: true,
        upstreamRunId: true,
      },
      take: MAX_DISCOVERED_ACTIVE_RUNS + 1,
    }),
    database.projectChatTurn.findMany({
      where: {
        actorUserId,
        provider: 'OPENCLAW',
        status: 'RUNNING',
        activeProjectKey: { not: null },
        leaseExpiresAt: { gt: now },
        ...(sessionKey ? { providerSessionId: sessionKey } : {}),
      },
      select: {
        id: true,
        stateId: true,
        actorUserId: true,
        actorAuthorizationVersion: true,
        projectIdentityId: true,
        activeProjectKey: true,
        provider: true,
        status: true,
        providerSessionId: true,
        leaseExpiresAt: true,
        resultMetadata: true,
      },
      take: MAX_DISCOVERED_ACTIVE_RUNS + 1,
    }),
  ]);
  if (transitions.length > 0) {
    throw new AskUserQuestionError(
      'ASK_USER_AUTHORIZATION_TRANSITION',
      'Question discovery is unavailable during an authorization change.',
      503,
    );
  }
  if (hostRuns.length + projectTurns.length > MAX_DISCOVERED_ACTIVE_RUNS) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_AMBIGUOUS',
      'Too many active runs match the authenticated actor.',
      409,
    );
  }

  const identities = [
    ...hostRuns.map((run) => ({
      sessionKey: run.sessionKey,
      runId: run.upstreamRunId,
      toolCallId: 'runtime-pending-discovery',
    })),
    ...projectTurns.map((turn) => ({
      sessionKey: turn.providerSessionId,
      runId: `portal-${turn.id}`,
      toolCallId: 'runtime-pending-discovery',
    })),
  ];
  const resolvedCandidates = await Promise.all(identities.map(async (identity) => {
    try {
      const proof = await resolveAskUserQuestionRunOwner(identity, database, now);
      if (
        proof.ownerUserId !== actorUserId
        || (
          requestedAuthorizationVersion !== null
          && proof.actorAuthorizationVersion !== requestedAuthorizationVersion
        )
      ) return null;
      const { toolCallId: _discarded, ...candidate } = proof;
      return candidate;
    } catch (error) {
      if (error instanceof AskUserQuestionError && error.code === 'ASK_USER_RUN_UNOWNED') return null;
      throw error;
    }
  }));
  const candidates = resolvedCandidates.filter(
    (candidate): candidate is AskUserQuestionRunCandidate => Boolean(candidate),
  );

  const seenSessions = new Set<string>();
  const seenRuns = new Set<string>();
  for (const candidate of candidates) {
    const runKey = `${candidate.sessionKey}\u0000${candidate.runId}`;
    if (seenSessions.has(candidate.sessionKey) || seenRuns.has(runKey)) {
      throw new AskUserQuestionError(
        'ASK_USER_RUN_AMBIGUOUS',
        'The session has conflicting active-run ownership evidence.',
        409,
      );
    }
    seenSessions.add(candidate.sessionKey);
    seenRuns.add(runKey);
  }
  return candidates;
}

/** Re-attest a runtime-discovered native request against the same authority. */
export async function attestAskUserQuestionRuntimeRequest(
  candidate: AskUserQuestionRunCandidate,
  requestId: unknown,
  database: AskUserQuestionOwnerDatabase = prisma as unknown as AskUserQuestionOwnerDatabase,
  now = new Date(),
): Promise<AskUserQuestionRunOwnership> {
  const proof = await resolveAskUserQuestionRunOwner({
    sessionKey: candidate.sessionKey,
    runId: candidate.runId,
    toolCallId: requestId,
  }, database, now);
  if (
    proof.ownerUserId !== candidate.ownerUserId
    || proof.surface !== candidate.surface
    || proof.authorityId !== candidate.authorityId
    || proof.actorAuthorizationVersion !== candidate.actorAuthorizationVersion
    || proof.projectIdentityId !== candidate.projectIdentityId
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_NOT_FOUND',
      'That question is no longer open.',
      404,
    );
  }
  return proof;
}

export async function registerOwnedAskUserQuestion(
  input: {
    sessionKey: unknown;
    runId: unknown;
    toolCallId: unknown;
    questions: unknown;
    waitMs?: number;
    createdAt?: number;
    expiresAt?: number;
  },
  database: AskUserQuestionOwnerDatabase = prisma as unknown as AskUserQuestionOwnerDatabase,
): Promise<AskUserQuestionRecord> {
  const ownership = await resolveAskUserQuestionRunOwner(input, database);
  return registerAskUserQuestion({
    sessionKey: ownership.sessionKey,
    runId: ownership.runId,
    toolCallId: ownership.toolCallId,
    ownerUserId: ownership.ownerUserId,
    surface: ownership.surface,
    authorityId: ownership.authorityId,
    actorAuthorizationVersion: ownership.actorAuthorizationVersion,
    projectIdentityId: ownership.projectIdentityId,
    questions: input.questions,
    waitMs: input.waitMs,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export async function reattestAskUserQuestionRunForActor(
  id: string,
  actorUserId: string,
  database: AskUserQuestionOwnerDatabase = prisma as unknown as AskUserQuestionOwnerDatabase,
): Promise<AskUserQuestionRecord> {
  const record = readPendingAskUserQuestionForActor(id, actorUserId);
  const proof = await resolveAskUserQuestionRunOwner({
    sessionKey: record.sessionKey,
    runId: record.runId,
    toolCallId: record.toolCallId,
  }, database);
  if (
    proof.ownerUserId !== record.ownerUserId
    || proof.surface !== record.surface
    || proof.authorityId !== record.authorityId
    || proof.actorAuthorizationVersion !== record.actorAuthorizationVersion
    || proof.projectIdentityId !== record.projectIdentityId
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_NOT_FOUND',
      'That question is no longer open.',
      404,
    );
  }
  return record;
}
