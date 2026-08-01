import crypto from 'crypto';
import {
  AgentProviderType,
  Prisma,
  ProjectChatTurnStatus,
  type ProjectChatState,
  type ProjectChatTurn,
  type ProjectChatTurnEvent,
  type ProjectChatProviderBinding,
  type ProjectChatMessage,
} from '@prisma/client';
import { prisma } from '../config/database';

export const PROJECT_CHAT_DEFAULT_LEASE_MS = 2 * 60_000;
export const PROJECT_CHAT_MIN_LEASE_MS = 15_000;
export const PROJECT_CHAT_MAX_LEASE_MS = 15 * 60_000;
export const PROJECT_CHAT_MAX_REPLAY_PAYLOAD_BYTES = 128 * 1024;
export const PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX = 'portal-runtime-admission:';
export const PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED = 'DISPATCH_UNCONFIRMED';
export const PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED = 'DISPATCH_ACCEPTED';
const PROJECT_CHAT_DISPATCH_METADATA_VERSION = 1;

export type ProjectChatPersistedProvider =
  | 'OPENCLAW'
  | 'CLAUDE_CODE'
  | 'CODEX'
  | 'AGENT_ZERO'
  | 'GEMINI'
  | 'OLLAMA'
  | 'GROK_BUILD';

export type ProjectChatLeaseErrorCode =
  | 'INVALID_INPUT'
  | 'STATE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'PROVIDER_MISMATCH'
  | 'TURN_ACTIVE'
  | 'TURN_NOT_FOUND'
  | 'TURN_NOT_ACTIVE'
  | 'LEASE_REJECTED'
  | 'REQUEST_REPLAY'
  | 'HANDOFF_CONFLICT'
  | 'PROJECT_CLOSED'
  | 'AUTHORIZATION_CHANGED'
  | 'STATE_CORRUPT';

export class ProjectChatLeaseError extends Error {
  constructor(
    public readonly code: ProjectChatLeaseErrorCode,
    message: string,
    public readonly httpStatus = 409,
  ) {
    super(message);
    this.name = 'ProjectChatLeaseError';
  }
}

type LeaseTransaction = Pick<
  Prisma.TransactionClient,
  | 'projectIdentity'
  | 'projectChatState'
  | 'projectChatTurn'
  | 'projectChatTurnEvent'
  | 'projectChatProviderBinding'
  | 'projectChatMessage'
  | 'projectAuthorizationTransition'
  | 'user'
>;

export interface ProjectChatLeaseDatabase {
  $transaction<T>(
    callback: (transaction: LeaseTransaction) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
}

export interface ProjectChatDispatchPersistenceGate {
  waitUntilAccepted: Promise<void>;
  release(): void;
  releaseAfter<T>(acceptance: Promise<T>): Promise<T>;
}

/**
 * Defers replay-event row writes until the exact provider-dispatch CAS has
 * either committed or failed. The native broker emits its first status event
 * synchronously, so without this boundary the event append and dispatch fence
 * can start competing Serializable transactions against the same turn row.
 */
export function createProjectChatDispatchPersistenceGate(): ProjectChatDispatchPersistenceGate {
  let releaseWait!: () => void;
  let released = false;
  const waitUntilAccepted = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const release = () => {
    if (released) return;
    released = true;
    releaseWait();
  };
  return {
    waitUntilAccepted,
    release,
    async releaseAfter<T>(acceptance: Promise<T>): Promise<T> {
      try {
        return await acceptance;
      } finally {
        release();
      }
    },
  };
}

const defaultDatabase = prisma as unknown as ProjectChatLeaseDatabase;
const PROJECT_CHAT_SERIALIZABLE_MAX_ATTEMPTS = 4;
const PROJECT_CHAT_SERIALIZABLE_RETRY_BASE_MS = 5;
const ACTIVE_TURN_STATUSES: ProjectChatTurnStatus[] = [
  ProjectChatTurnStatus.RUNNING,
  ProjectChatTurnStatus.ABORTING,
];
const TERMINAL_TURN_STATUSES = new Set<ProjectChatTurnStatus>([
  ProjectChatTurnStatus.COMPLETED,
  ProjectChatTurnStatus.ERROR,
  ProjectChatTurnStatus.ABORTED,
  ProjectChatTurnStatus.EXPIRED,
]);

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || normalized.includes('\u0000')) {
    throw new ProjectChatLeaseError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return normalized;
}

function persistedProvider(value: unknown): AgentProviderType {
  const normalized = String(value || '').trim().toUpperCase();
  if (!Object.values(AgentProviderType).includes(normalized as AgentProviderType)) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Unsupported Project Chat provider', 400);
  }
  return normalized as AgentProviderType;
}

function boundedLeaseDuration(value: unknown): number {
  const duration = value == null ? PROJECT_CHAT_DEFAULT_LEASE_MS : Number(value);
  if (!Number.isInteger(duration) || duration < PROJECT_CHAT_MIN_LEASE_MS || duration > PROJECT_CHAT_MAX_LEASE_MS) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Invalid Project Chat lease duration', 400);
  }
  return duration;
}

function nonNegativeCursor(value: unknown, label: string): number {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new ProjectChatLeaseError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return cursor;
}

function positiveAuthorizationVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProjectChatLeaseError(
      'INVALID_INPUT',
      'Invalid actor authorization generation',
      400,
    );
  }
  return version;
}

async function assertDurableActorAuthorization(
  transaction: LeaseTransaction,
  actorUserId: string,
  expectedAuthorizationVersion: number,
): Promise<void> {
  const [actor, transition] = await Promise.all([
    transaction.user.findUnique({
      where: { id: actorUserId },
      select: {
        authorizationVersion: true,
        accountStatus: true,
        isActive: true,
      },
    } as any),
    transaction.projectAuthorizationTransition.findFirst({
      where: { phase: { not: 'COMPLETE' } },
      select: { id: true },
    } as any),
  ]);
  if (transition) {
    throw new ProjectChatLeaseError(
      'AUTHORIZATION_CHANGED',
      'Project runtime admission is closed during an authorization transition',
      503,
    );
  }
  if (
    !actor
    || actor.isActive !== true
    || String((actor as any).accountStatus || '') !== 'ACTIVE'
    || Number((actor as any).authorizationVersion ?? 1) !== expectedAuthorizationVersion
  ) {
    throw new ProjectChatLeaseError(
      'AUTHORIZATION_CHANGED',
      'Project runtime authorization changed before provider admission',
      409,
    );
  }
}

function leaseDigest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function matchesLeaseDigest(storedDigest: string, token: string): boolean {
  const candidate = leaseDigest(token);
  const stored = Buffer.from(storedDigest, 'hex');
  const supplied = Buffer.from(candidate, 'hex');
  return stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
}

function assertLease(turn: ProjectChatTurn, token: unknown): void {
  const normalized = requiredIdentifier(token, 'lease token');
  if (!matchesLeaseDigest(turn.leaseTokenHash, normalized)) {
    throw new ProjectChatLeaseError('LEASE_REJECTED', 'Project Chat turn lease was rejected', 403);
  }
}

function assertReplayPayload(payload: Prisma.InputJsonValue): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Replay event is not valid JSON', 400);
  }
  if (Buffer.byteLength(encoded, 'utf8') > PROJECT_CHAT_MAX_REPLAY_PAYLOAD_BYTES) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Replay event exceeds the persistence limit', 413);
  }
}

function isTerminal(status: ProjectChatTurnStatus): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}

function translateTransactionError(error: unknown): never {
  if (error instanceof ProjectChatLeaseError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034' || error.code === 'P2002') {
      throw new ProjectChatLeaseError(
        'VERSION_CONFLICT',
        'Project Chat state changed concurrently; refresh and retry',
      );
    }
  }
  throw error;
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === 'P2034' || error.code === 'P2002');
}

async function waitForTransactionRetry(attempt: number): Promise<void> {
  const exponentialDelay = PROJECT_CHAT_SERIALIZABLE_RETRY_BASE_MS * (2 ** (attempt - 1));
  const jitter = crypto.randomInt(0, PROJECT_CHAT_SERIALIZABLE_RETRY_BASE_MS + 1);
  await new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
}

async function serializable<T>(
  database: ProjectChatLeaseDatabase,
  operation: (transaction: LeaseTransaction) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_CHAT_SERIALIZABLE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === PROJECT_CHAT_SERIALIZABLE_MAX_ATTEMPTS) {
        return translateTransactionError(error);
      }
      // PostgreSQL can abort a Serializable transaction at commit time even
      // when every statement succeeded. The callback is safe to replay because
      // its writes were rolled back atomically and all externally visible
      // provider work happens outside this helper.
      await waitForTransactionRetry(attempt);
    }
  }
  return translateTransactionError(lastError);
}

interface StateKey {
  actorUserId: string;
  projectIdentityId: string;
}

function normalizeStateKey(input: StateKey): StateKey {
  return {
    actorUserId: requiredIdentifier(input.actorUserId, 'authenticated actor'),
    projectIdentityId: requiredIdentifier(input.projectIdentityId, 'project identity'),
  };
}

/**
 * Detaches only a turn whose terminal state is already durable. Lease expiry
 * is not provider-stop evidence: a provider may outlive the Portal process
 * that stopped renewing the row. Missing turn rows are likewise not proof
 * that the external runtime stopped. Both cases must keep the project CAS
 * slot blocked until an authenticated recovery path attests provider
 * quiescence and explicitly confirms the abort.
 */
async function clearFinishedTurn(
  transaction: LeaseTransaction,
  key: StateKey,
  _now: Date,
): Promise<ProjectChatState | null> {
  const state = await transaction.projectChatState.findUnique({
    where: { actorUserId_projectIdentityId: key },
  });
  if (!state?.activeTurnId) return state;

  const turn = await transaction.projectChatTurn.findUnique({ where: { id: state.activeTurnId } });
  if (!turn) {
    throw new ProjectChatLeaseError(
      'STATE_CORRUPT',
      'Project Chat active-turn evidence is missing; provider recovery is required before this project can continue',
      500,
    );
  }

  if (isTerminal(turn.status)) {
    await transaction.projectChatTurn.updateMany({
      where: { id: turn.id, activeProjectKey: turn.projectIdentityId },
      data: { activeProjectKey: null },
    });
    const cleared = await transaction.projectChatState.updateMany({
      where: { id: state.id, activeTurnId: turn.id },
      data: { activeTurnId: null, version: { increment: 1 } },
    });
    if (cleared.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat state changed concurrently');
    }
    return transaction.projectChatState.findUnique({ where: { id: state.id } });
  }

  // A stale heartbeat quarantines the actor/project slot. Provider I/O is
  // deliberately outside this transaction; /assistant/abort and destructive
  // reset are the only paths allowed to prove quiescence and detach the row.
  return state;
}

export async function ensureProjectChatState(input: {
  actorUserId: string;
  projectIdentityId: string;
  initialProvider: ProjectChatPersistedProvider;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatState> {
  const key = normalizeStateKey(input);
  const provider = persistedProvider(input.initialProvider);
  return serializable(database, async (transaction) => transaction.projectChatState.upsert({
    where: { actorUserId_projectIdentityId: key },
    update: {},
    create: { ...key, selectedProvider: provider },
  }));
}

export interface ProjectChatTurnLeaseGrant {
  state: ProjectChatState;
  turn: ProjectChatTurn;
  leaseToken: string;
  idempotentReplay: boolean;
}

export function projectChatTurnDispatchStage(
  turn: Pick<ProjectChatTurn, 'resultMetadata'> | null | undefined,
): typeof PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED | typeof PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED | null {
  const metadata = turn?.resultMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const stage = (metadata as Record<string, unknown>).providerDispatchStage;
  return stage === PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED
    || stage === PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED
    ? stage
    : null;
}

export async function acquireProjectChatTurn(input: StateKey & {
  actorAuthorizationVersion: number;
  provider: ProjectChatPersistedProvider;
  runtime: string;
  requestId: string;
  leaseOwner: string;
  expectedVersion: number;
  leaseToken?: string;
  leaseDurationMs?: number;
  providerSessionId?: string | null;
  model?: string | null;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurnLeaseGrant> {
  const key = normalizeStateKey(input);
  const actorAuthorizationVersion = positiveAuthorizationVersion(input.actorAuthorizationVersion);
  const provider = persistedProvider(input.provider);
  const runtime = requiredIdentifier(input.runtime, 'runtime');
  const requestId = requiredIdentifier(input.requestId, 'request ID');
  const leaseOwner = requiredIdentifier(input.leaseOwner, 'lease owner');
  const expectedVersion = nonNegativeCursor(input.expectedVersion, 'state version');
  const leaseDurationMs = boundedLeaseDuration(input.leaseDurationMs);
  const now = input.now || new Date();
  const leaseToken = input.leaseToken
    ? requiredIdentifier(input.leaseToken, 'lease token')
    : crypto.randomBytes(32).toString('base64url');
  const tokenHash = leaseDigest(leaseToken);
  const expiresAt = new Date(now.getTime() + leaseDurationMs);

  return serializable(database, async (transaction) => {
    await assertDurableActorAuthorization(
      transaction,
      key.actorUserId,
      actorAuthorizationVersion,
    );
    let state = await clearFinishedTurn(transaction, key, now);
    if (!state) {
      throw new ProjectChatLeaseError('STATE_NOT_FOUND', 'Project Chat state has not been initialized', 404);
    }

    const existing = await transaction.projectChatTurn.findUnique({
      where: { actorUserId_projectIdentityId_requestId: { ...key, requestId } },
    });
    if (existing) {
      if (!matchesLeaseDigest(existing.leaseTokenHash, leaseToken)) {
        throw new ProjectChatLeaseError('REQUEST_REPLAY', 'Project Chat request ID was already used', 409);
      }
      if (ACTIVE_TURN_STATUSES.includes(existing.status) && state.activeTurnId !== existing.id) {
        throw new ProjectChatLeaseError('STATE_CORRUPT', 'Retried turn is detached from its project', 500);
      }
      if (Number((existing as any).actorAuthorizationVersion) !== actorAuthorizationVersion) {
        throw new ProjectChatLeaseError(
          'AUTHORIZATION_CHANGED',
          'Project Chat request replay belongs to an older authorization generation',
        );
      }
      return { state, turn: existing, leaseToken, idempotentReplay: true };
    }
    const projectIdentity = await transaction.projectIdentity.findUnique({
      where: { id: key.projectIdentityId },
      select: { lifecycleStatus: true, legacyOpenClawMigrationStatus: true },
    });
    if (
      !projectIdentity
      || projectIdentity.lifecycleStatus !== 'ACTIVE'
      || projectIdentity.legacyOpenClawMigrationStatus === 'PENDING'
    ) {
      throw new ProjectChatLeaseError(
        'PROJECT_CLOSED',
        'Project Chat admission is closed during Project lifecycle reconciliation',
      );
    }
    if (state.version !== expectedVersion) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat state version is stale');
    }
    if (state.selectedProvider !== provider) {
      throw new ProjectChatLeaseError(
        'PROVIDER_MISMATCH',
        `Project Chat is set to ${state.selectedProvider}, not ${provider}`,
      );
    }
    if (state.activeTurnId) {
      throw new ProjectChatLeaseError('TURN_ACTIVE', 'Another Project Chat turn is already active');
    }

    const turn = await transaction.projectChatTurn.create({
      data: {
        stateId: state.id,
        ...key,
        actorAuthorizationVersion,
        activeProjectKey: key.projectIdentityId,
        provider,
        runtime,
        requestId,
        status: ProjectChatTurnStatus.RUNNING,
        leaseTokenHash: tokenHash,
        leaseOwner,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        providerSessionId: input.providerSessionId || null,
        model: input.model || null,
        startedAt: now,
      },
    });
    const claimed = await transaction.projectChatState.updateMany({
      where: {
        id: state.id,
        version: expectedVersion,
        selectedProvider: provider,
        activeTurnId: null,
      },
      data: { activeTurnId: turn.id, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat changed before the turn could start');
    }
    state = await transaction.projectChatState.findUnique({ where: { id: state.id } }) as ProjectChatState;
    return { state, turn, leaseToken, idempotentReplay: false };
  });
}

export function isProjectChatRuntimeAdmissionTurn(
  turn: Pick<ProjectChatTurn, 'requestId'> | { requestId?: string | null },
): boolean {
  return String(turn?.requestId || '').startsWith(PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX);
}

export interface ProjectChatRuntimeAdmissionGrant extends ProjectChatTurnLeaseGrant {
  operation: string;
}

/**
 * Claims the same durable, project-wide CAS slot as a user turn before a route
 * is allowed to attest, stop, recreate, or otherwise mutate provider runtime.
 * This prevents an ensure/qualification request in another process from
 * interrupting a leased turn between a read-only coordination check and the
 * first runtime mutation.
 */
export async function acquireProjectChatRuntimeAdmission(input: StateKey & {
  actorAuthorizationVersion: number;
  provider: ProjectChatPersistedProvider;
  runtime: string;
  operation: string;
  leaseOwner: string;
  expectedVersion: number;
  leaseDurationMs?: number;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatRuntimeAdmissionGrant> {
  const operation = requiredIdentifier(input.operation, 'runtime admission operation')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 96);
  const grant = await acquireProjectChatTurn({
    actorUserId: input.actorUserId,
    actorAuthorizationVersion: input.actorAuthorizationVersion,
    projectIdentityId: input.projectIdentityId,
    provider: input.provider,
    runtime: input.runtime,
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}${operation}:${crypto.randomUUID()}`,
    leaseOwner: input.leaseOwner,
    expectedVersion: input.expectedVersion,
    leaseDurationMs: input.leaseDurationMs,
    now: input.now,
  }, database);
  return { ...grant, operation };
}

export async function finishProjectChatRuntimeAdmission(input: StateKey & {
  turnId: string;
  leaseToken: string;
  status: 'COMPLETED' | 'ERROR';
  requestedProviderAfterSuccess?: ProjectChatPersistedProvider;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<{
  state: ProjectChatState;
  turn: ProjectChatTurn;
}> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const now = input.now || new Date();
  const terminalStatus = input.status === 'COMPLETED'
    ? ProjectChatTurnStatus.COMPLETED
    : ProjectChatTurnStatus.ERROR;
  const requestedProvider = input.status === 'COMPLETED' && input.requestedProviderAfterSuccess
    ? persistedProvider(input.requestedProviderAfterSuccess)
    : null;

  return serializable(database, async (transaction) => {
    let turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat runtime admission was not found', 404);
    }
    if (!isProjectChatRuntimeAdmissionTurn(turn)) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'A user turn cannot finalize runtime admission', 500);
    }
    assertLease(turn, input.leaseToken);
    if (isTerminal(turn.status)) {
      if (
        turn.status !== terminalStatus
        || turn.errorCode === 'STALE_RUNTIME_ADMISSION_RECOVERED'
        || turn.errorCode === 'DESTRUCTIVE_RESET_RECOVERED_RUNTIME_ADMISSION'
      ) {
        throw new ProjectChatLeaseError(
          'TURN_NOT_ACTIVE',
          'Project Chat runtime admission was superseded before this operation finalized',
        );
      }
      const terminalState = await transaction.projectChatState.findUnique({
        where: { actorUserId_projectIdentityId: key },
      });
      if (!terminalState) {
        throw new ProjectChatLeaseError('STATE_NOT_FOUND', 'Project Chat state was not found', 404);
      }
      return { state: terminalState, turn };
    }

    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Runtime admission is detached from its project', 500);
    }
    const finalized = await transaction.projectChatTurn.updateMany({
      where: { id: turnId, leaseTokenHash: turn.leaseTokenHash, status: { in: ACTIVE_TURN_STATUSES } },
      data: {
        status: terminalStatus,
        activeProjectKey: null,
        completedAt: now,
        errorCode: input.errorCode || null,
        errorMessage: input.errorMessage ? String(input.errorMessage).slice(0, 80_000) : null,
      },
    });
    if (finalized.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat runtime admission changed concurrently');
    }
    const released = await transaction.projectChatState.updateMany({
      where: { id: state.id, activeTurnId: turnId, selectedProvider: turn.provider },
      data: {
        activeTurnId: null,
        version: { increment: 1 },
        ...(requestedProvider ? { selectedProvider: requestedProvider } : {}),
      },
    });
    if (released.count !== 1) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Runtime admission could not be released', 500);
    }
    const [releasedState, finalizedTurn] = await Promise.all([
      transaction.projectChatState.findUnique({ where: { id: state.id } }),
      transaction.projectChatTurn.findUnique({ where: { id: turnId } }),
    ]);
    if (!releasedState || !finalizedTurn) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Runtime admission finalization was not durable', 500);
    }
    turn = finalizedTurn;
    return { state: releasedState, turn };
  });
}

/**
 * Atomically converts a runtime admission into the user turn that required the
 * runtime mutation. The project CAS slot and lease token never become free in
 * between attestation and provider dispatch.
 */
export async function promoteProjectChatRuntimeAdmissionToTurn(input: StateKey & {
  turnId: string;
  leaseToken: string;
  runtime: string;
  providerSessionId?: string | null;
  model?: string | null;
  userMessage: {
    sessionKey: string;
    content: string;
    messageId: string;
  };
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<
  ProjectChatTurnLeaseGrant & { userMessage: ProjectChatMessage }
> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const runtime = requiredIdentifier(input.runtime, 'runtime');
  const sessionKey = requiredIdentifier(input.userMessage.sessionKey, 'user message session key');
  const messageId = requiredIdentifier(input.userMessage.messageId, 'user message ID');
  const content = typeof input.userMessage.content === 'string' ? input.userMessage.content : '';
  if (!content) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Project Chat user message content is required', 400);
  }
  const providerSessionId = input.providerSessionId
    ? requiredIdentifier(input.providerSessionId, 'provider session ID')
    : null;
  const model = input.model == null ? null : String(input.model).trim() || null;
  return serializable(database, async (transaction) => {
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat runtime admission was not found', 404);
    }
    if (!isProjectChatRuntimeAdmissionTurn(turn)) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Only runtime admission can be promoted to a user turn', 500);
    }
    await assertDurableActorAuthorization(
      transaction,
      key.actorUserId,
      positiveAuthorizationVersion((turn as any).actorAuthorizationVersion),
    );
    assertLease(turn, input.leaseToken);
    if (turn.status !== ProjectChatTurnStatus.RUNNING) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat runtime admission is no longer active');
    }
    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId || state.selectedProvider !== turn.provider) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Runtime admission is detached from provider state', 500);
    }

    let userMessage = await transaction.projectChatMessage.findFirst({
      where: {
        userId: key.actorUserId,
        projectId: key.projectIdentityId,
        messageId,
      },
    });
    if (userMessage) {
      if (
        userMessage.role !== 'user'
        || userMessage.content !== content
        || userMessage.provider !== turn.provider
        || userMessage.runtime !== runtime
        || userMessage.sessionKey !== sessionKey
        || (userMessage.providerSessionId || null) !== providerSessionId
        || (userMessage.model || null) !== model
        || userMessage.turnId != null
      ) {
        throw new ProjectChatLeaseError(
          'REQUEST_REPLAY',
          'Project Chat message identity was already used for a different request',
        );
      }
      const existingTurn = await transaction.projectChatTurn.findUnique({
        where: {
          actorUserId_projectIdentityId_requestId: {
            ...key,
            requestId: userMessage.id,
          },
        },
      });
      if (existingTurn && existingTurn.id !== turnId) {
        throw new ProjectChatLeaseError(
          'REQUEST_REPLAY',
          'Project Chat message identity is already attached to another turn',
        );
      }
    } else {
      userMessage = await transaction.projectChatMessage.create({
        data: {
          projectId: key.projectIdentityId,
          userId: key.actorUserId,
          sessionKey,
          role: 'user',
          content,
          messageId,
          provider: turn.provider,
          runtime,
          model,
          providerSessionId,
        },
      });
    }
    const promoted = await transaction.projectChatTurn.updateMany({
      where: {
        id: turnId,
        requestId: turn.requestId,
        leaseTokenHash: turn.leaseTokenHash,
        status: ProjectChatTurnStatus.RUNNING,
        activeProjectKey: key.projectIdentityId,
      },
      data: {
        requestId: userMessage.id,
        runtime,
        providerSessionId,
        model,
        resultMetadata: {
          dispatchMetadataVersion: PROJECT_CHAT_DISPATCH_METADATA_VERSION,
          providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
        } as Prisma.InputJsonValue,
      },
    });
    if (promoted.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Runtime admission changed before provider dispatch');
    }
    const promotedTurn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!promotedTurn || isProjectChatRuntimeAdmissionTurn(promotedTurn)) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Runtime admission promotion was not durable', 500);
    }
    return {
      state,
      turn: promotedTurn,
      leaseToken: input.leaseToken,
      idempotentReplay: false,
      userMessage,
    };
  });
}

/**
 * Records that startProjectNativeRun synchronously accepted the exact durable
 * turn. A crash before this fence is intentionally not resumed: the provider
 * call may or may not have crossed its external delivery boundary, and the
 * transports do not share a universal exactly-once contract. Stable replay
 * must surface recovery-required rather than assert either outcome or risk a
 * duplicate dispatch.
 */
export async function markProjectChatTurnProviderDispatchAccepted(input: StateKey & {
  turnId: string;
  leaseToken: string;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurn> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const now = input.now || new Date();
  return serializable(database, async (transaction) => {
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    }
    assertLease(turn, input.leaseToken);
    if (isTerminal(turn.status)) {
      if (projectChatTurnDispatchStage(turn) === PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED) return turn;
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Terminal Project Chat settlement did not attest provider dispatch',
        500,
      );
    }
    if (isProjectChatRuntimeAdmissionTurn(turn)) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Runtime admission was not promoted before provider dispatch', 500);
    }
    await assertDurableActorAuthorization(
      transaction,
      key.actorUserId,
      positiveAuthorizationVersion((turn as any).actorAuthorizationVersion),
    );
    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn lost admission before provider dispatch');
    }
    const projectIdentity = await transaction.projectIdentity.findUnique({
      where: { id: key.projectIdentityId },
      select: { lifecycleStatus: true, legacyOpenClawMigrationStatus: true },
    });
    if (
      !projectIdentity
      || projectIdentity.lifecycleStatus !== 'ACTIVE'
      || projectIdentity.legacyOpenClawMigrationStatus === 'PENDING'
    ) {
      throw new ProjectChatLeaseError(
        'PROJECT_CLOSED',
        'Project Chat dispatch is closed during Project lifecycle reconciliation',
      );
    }
    const stage = projectChatTurnDispatchStage(turn);
    if (stage === PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED) return turn;
    if (stage !== PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Project Chat dispatch lifecycle metadata is missing', 500);
    }
    const metadata = turn.resultMetadata as Record<string, unknown>;
    const accepted = await transaction.projectChatTurn.updateMany({
      where: {
        id: turnId,
        leaseTokenHash: turn.leaseTokenHash,
        status: { in: ACTIVE_TURN_STATUSES },
        activeProjectKey: key.projectIdentityId,
      },
      data: {
        resultMetadata: {
          ...metadata,
          dispatchMetadataVersion: PROJECT_CHAT_DISPATCH_METADATA_VERSION,
          providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
          providerDispatchAcceptedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    if (accepted.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat dispatch acceptance changed concurrently');
    }
    const persisted = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!persisted || projectChatTurnDispatchStage(persisted) !== PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Project Chat dispatch acceptance was not durable', 500);
    }
    return persisted;
  });
}

export async function withProjectChatRuntimeAdmission<T>(input: StateKey & {
  actorAuthorizationVersion: number;
  provider: ProjectChatPersistedProvider;
  runtime: string;
  operation: string;
  leaseOwner: string;
  expectedVersion: number;
  leaseDurationMs?: number;
  requestedProviderAfterSuccess?: ProjectChatPersistedProvider;
  now?: Date;
}, operation: (grant: ProjectChatRuntimeAdmissionGrant) => Promise<T>,
database: ProjectChatLeaseDatabase = defaultDatabase): Promise<{
  result: T;
  state: ProjectChatState;
  turn: ProjectChatTurn;
}> {
  const grant = await acquireProjectChatRuntimeAdmission(input, database);
  const leaseDurationMs = boundedLeaseDuration(input.leaseDurationMs);
  let heartbeatFailure: unknown = null;
  let renewing = false;
  let heartbeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (renewing || heartbeatFailure) return;
    renewing = true;
    heartbeat = renewProjectChatTurnLease({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      turnId: grant.turn.id,
      leaseToken: grant.leaseToken,
      leaseDurationMs,
    }, database).then(() => undefined).catch((error) => {
      heartbeatFailure = error;
    }).finally(() => {
      renewing = false;
    });
  }, Math.max(5_000, Math.min(30_000, Math.floor(leaseDurationMs / 3))));
  timer.unref?.();

  let result: T;
  try {
    result = await operation(grant);
  } catch (error) {
    clearInterval(timer);
    await heartbeat;
    await finishProjectChatRuntimeAdmission({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      turnId: grant.turn.id,
      leaseToken: grant.leaseToken,
      status: 'ERROR',
      errorCode: 'RUNTIME_ADMISSION_OPERATION_FAILED',
      errorMessage: error instanceof Error ? error.message : 'Project runtime operation failed',
      now: input.now,
    }, database);
    throw error;
  }

  clearInterval(timer);
  await heartbeat;
  if (heartbeatFailure) {
    await finishProjectChatRuntimeAdmission({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      turnId: grant.turn.id,
      leaseToken: grant.leaseToken,
      status: 'ERROR',
      errorCode: 'RUNTIME_ADMISSION_LEASE_LOST',
      errorMessage: heartbeatFailure instanceof Error
        ? heartbeatFailure.message
        : 'Project runtime admission lease was lost',
      now: input.now,
    }, database);
    throw heartbeatFailure;
  }
  const completed = await finishProjectChatRuntimeAdmission({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
    turnId: grant.turn.id,
    leaseToken: grant.leaseToken,
    status: 'COMPLETED',
    requestedProviderAfterSuccess: input.requestedProviderAfterSuccess,
    now: input.now,
  }, database);
  return { result, ...completed };
}

export async function renewProjectChatTurnLease(input: StateKey & {
  turnId: string;
  leaseToken: string;
  leaseDurationMs?: number;
  providerSessionId?: string | null;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurn> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const leaseDurationMs = boundedLeaseDuration(input.leaseDurationMs);
  const now = input.now || new Date();
  return serializable(database, async (transaction) => {
    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn is not active');
    }
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn) throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    assertLease(turn, input.leaseToken);
    if (!ACTIVE_TURN_STATUSES.includes(turn.status)) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn is already terminal');
    }
    if (turn.leaseExpiresAt.getTime() <= now.getTime()) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn lease has expired');
    }
    const renewed = await transaction.projectChatTurn.updateMany({
      where: { id: turnId, leaseTokenHash: turn.leaseTokenHash, status: { in: ACTIVE_TURN_STATUSES } },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
      },
    });
    if (renewed.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat lease changed concurrently');
    }
    return transaction.projectChatTurn.findUnique({ where: { id: turnId } }) as Promise<ProjectChatTurn>;
  });
}

export async function appendProjectChatTurnEvent(input: StateKey & {
  turnId: string;
  leaseToken: string;
  expectedSeq: number;
  eventType: string;
  payload: Prisma.InputJsonValue;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurnEvent> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const expectedSeq = nonNegativeCursor(input.expectedSeq, 'event sequence');
  const eventType = requiredIdentifier(input.eventType, 'event type').slice(0, 128);
  assertReplayPayload(input.payload);
  return serializable(database, async (transaction) => {
    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn is not active');
    }
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn) throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    assertLease(turn, input.leaseToken);
    if (!ACTIVE_TURN_STATUSES.includes(turn.status)) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn is already terminal');
    }
    if (turn.lastEventSeq !== expectedSeq) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat replay cursor is stale');
    }
    const advanced = await transaction.projectChatTurn.updateMany({
      where: { id: turnId, lastEventSeq: expectedSeq, status: { in: ACTIVE_TURN_STATUSES } },
      data: { lastEventSeq: { increment: 1 } },
    });
    if (advanced.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat replay cursor changed concurrently');
    }
    return transaction.projectChatTurnEvent.create({
      data: { turnId, seq: expectedSeq + 1, eventType, payload: input.payload },
    });
  });
}

export async function requestProjectChatTurnAbort(input: StateKey & {
  turnId: string;
  expectedProvider?: ProjectChatPersistedProvider;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurn> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const expectedProvider = input.expectedProvider ? persistedProvider(input.expectedProvider) : null;
  return serializable(database, async (transaction) => {
    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      const existing = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
      if (
        existing
        && existing.actorUserId === key.actorUserId
        && existing.projectIdentityId === key.projectIdentityId
        && isTerminal(existing.status)
      ) return existing;
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn is not active');
    }
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn) throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    if (expectedProvider && turn.provider !== expectedProvider) {
      throw new ProjectChatLeaseError('PROVIDER_MISMATCH', 'Abort provider does not own the active turn');
    }
    if (turn.status === ProjectChatTurnStatus.ABORTING || isTerminal(turn.status)) return turn;
    const changed = await transaction.projectChatTurn.updateMany({
      where: { id: turnId, status: ProjectChatTurnStatus.RUNNING },
      data: { status: ProjectChatTurnStatus.ABORTING },
    });
    if (changed.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat turn changed concurrently');
    }
    return transaction.projectChatTurn.findUnique({ where: { id: turnId } }) as Promise<ProjectChatTurn>;
  });
}

/**
 * Finalize an abort only after the provider transport has synchronously
 * confirmed cancellation. This deliberately does not accept a lease token:
 * it is the recovery-safe counterpart used by the authenticated Portal abort
 * route after a backend restart has erased the in-memory token.
 */
export async function confirmProjectChatTurnAbort(input: StateKey & {
  turnId: string;
  expectedProvider: ProjectChatPersistedProvider;
  providerSessionId?: string | null;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurn> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const expectedProvider = persistedProvider(input.expectedProvider);
  const now = input.now || new Date();
  return serializable(database, async (transaction) => {
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    }
    if (turn.provider !== expectedProvider) {
      throw new ProjectChatLeaseError('PROVIDER_MISMATCH', 'Abort provider does not own the active turn');
    }
    if (isTerminal(turn.status)) return turn;
    if (turn.status !== ProjectChatTurnStatus.ABORTING) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'Project Chat turn is not awaiting abort confirmation');
    }
    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Aborting Project Chat turn is detached from its project', 500);
    }
    const finalized = await transaction.projectChatTurn.updateMany({
      where: { id: turnId, status: ProjectChatTurnStatus.ABORTING },
      data: {
        status: ProjectChatTurnStatus.ABORTED,
        activeProjectKey: null,
        completedAt: now,
        errorCode: 'USER_ABORTED',
        errorMessage: 'The authenticated user cancelled this Project Chat turn.',
        ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
      },
    });
    if (finalized.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat abort state changed concurrently');
    }
    const detached = await transaction.projectChatState.updateMany({
      where: { id: state.id, activeTurnId: turnId },
      data: { activeTurnId: null, version: { increment: 1 } },
    });
    if (detached.count !== 1) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Aborted Project Chat turn could not be detached', 500);
    }
    return transaction.projectChatTurn.findUnique({ where: { id: turnId } }) as Promise<ProjectChatTurn>;
  });
}

/**
 * Release an expired user turn only after an out-of-transaction provider
 * inspector has proved that the exact bound session reached a terminal state.
 *
 * A Portal restart destroys the raw lease token and every process-local broker
 * callback. Lease expiry alone is therefore never sufficient. The caller must
 * first attest provider quiescence; this transaction then rechecks every
 * durable identity, binding, dispatch, and expiry fence before marking the
 * interrupted turn EXPIRED. It deliberately does not claim provider success
 * or advance transcript handoff without the original settlement callback.
 */
export async function recoverExpiredProjectChatTurnAfterProviderTerminal(input: StateKey & {
  turnId: string;
  expectedProvider: ProjectChatPersistedProvider;
  expectedRuntime: string;
  expectedLeaseOwner: string;
  providerSessionId: string;
  providerStatus: string;
  providerStartedAt: Date;
  providerEndedAt: Date;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurn> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const expectedProvider = persistedProvider(input.expectedProvider);
  const expectedRuntime = requiredIdentifier(input.expectedRuntime, 'Project runtime');
  const expectedLeaseOwner = requiredIdentifier(input.expectedLeaseOwner, 'lease owner');
  const providerSessionId = requiredIdentifier(input.providerSessionId, 'provider session ID');
  const providerStatus = requiredIdentifier(input.providerStatus, 'provider terminal status')
    .toLowerCase()
    .slice(0, 64);
  const providerStartedAt = input.providerStartedAt;
  const providerEndedAt = input.providerEndedAt;
  const now = input.now || new Date();
  for (const [label, value] of [
    ['provider start time', providerStartedAt],
    ['provider end time', providerEndedAt],
  ] as const) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ProjectChatLeaseError('INVALID_INPUT', `Invalid ${label}`, 400);
    }
  }
  if (
    providerStartedAt.getTime() > providerEndedAt.getTime()
    || providerEndedAt.getTime() > now.getTime()
  ) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Invalid provider terminal interval', 400);
  }

  return serializable(database, async (transaction) => {
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    }
    if (isTerminal(turn.status)) return turn;
    if (isProjectChatRuntimeAdmissionTurn(turn)) {
      throw new ProjectChatLeaseError(
        'TURN_NOT_ACTIVE',
        'Runtime admission requires its dedicated recovery path',
      );
    }
    if (
      turn.provider !== expectedProvider
      || turn.runtime !== expectedRuntime
      || turn.leaseOwner !== expectedLeaseOwner
      || turn.providerSessionId !== providerSessionId
    ) {
      throw new ProjectChatLeaseError(
        'PROVIDER_MISMATCH',
        'Provider terminal evidence does not match the active Project turn',
      );
    }
    if (
      turn.leaseExpiresAt.getTime() > now.getTime()
      || providerStartedAt.getTime() < turn.startedAt.getTime()
      || providerStartedAt.getTime() > turn.leaseExpiresAt.getTime()
    ) {
      throw new ProjectChatLeaseError(
        'TURN_NOT_ACTIVE',
        'Provider terminal evidence is outside the expired Project turn lease',
      );
    }
    if (projectChatTurnDispatchStage(turn) !== PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED) {
      throw new ProjectChatLeaseError(
        'TURN_NOT_ACTIVE',
        'Provider dispatch was not durably accepted for restart recovery',
      );
    }

    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (
      !state
      || state.activeTurnId !== turnId
      || state.selectedProvider !== expectedProvider
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Expired Project Chat turn is detached from its project',
        500,
      );
    }
    const binding = await transaction.projectChatProviderBinding.findUnique({
      where: {
        userId_projectId_provider: {
          userId: key.actorUserId,
          projectId: key.projectIdentityId,
          provider: expectedProvider,
        },
      },
    });
    const boundSessions = new Set(
      [binding?.sessionKey, binding?.externalSessionId]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    if (
      !binding
      || binding.status !== 'active'
      || binding.runtime !== expectedRuntime
      || !boundSessions.has(providerSessionId)
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Expired Project Chat turn no longer matches its provider binding',
        500,
      );
    }

    const existingMetadata = turn.resultMetadata
      && typeof turn.resultMetadata === 'object'
      && !Array.isArray(turn.resultMetadata)
      ? turn.resultMetadata as Record<string, unknown>
      : {};
    const finalized = await transaction.projectChatTurn.updateMany({
      where: {
        id: turnId,
        status: { in: ACTIVE_TURN_STATUSES },
        provider: expectedProvider,
        runtime: expectedRuntime,
        leaseOwner: expectedLeaseOwner,
        providerSessionId,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: ProjectChatTurnStatus.EXPIRED,
        activeProjectKey: null,
        completedAt: now,
        errorCode: 'PORTAL_RESTART_PROVIDER_TERMINAL',
        errorMessage: 'Portal restarted before it could record the terminal response. The provider is no longer running; retry the turn if needed.',
        resultMetadata: {
          ...existingMetadata,
          restartRecoveryVersion: 1,
          restartRecoveryProviderStatus: providerStatus,
          restartRecoveryProviderStartedAt: providerStartedAt.toISOString(),
          restartRecoveryProviderEndedAt: providerEndedAt.toISOString(),
          restartRecoveredAt: now.toISOString(),
          presentationMaterialized: false,
        } as Prisma.InputJsonValue,
      },
    });
    if (finalized.count !== 1) {
      throw new ProjectChatLeaseError(
        'VERSION_CONFLICT',
        'Project Chat turn changed during restart recovery',
      );
    }
    const detached = await transaction.projectChatState.updateMany({
      where: {
        id: state.id,
        activeTurnId: turnId,
        selectedProvider: expectedProvider,
        version: state.version,
      },
      data: { activeTurnId: null, version: { increment: 1 } },
    });
    if (detached.count !== 1) {
      throw new ProjectChatLeaseError(
        'VERSION_CONFLICT',
        'Project Chat state changed during restart recovery',
      );
    }
    return transaction.projectChatTurn.findUnique({ where: { id: turnId } }) as Promise<ProjectChatTurn>;
  });
}

interface ProjectChatSettlementHandoff {
  provider: ProjectChatPersistedProvider;
  expectedHandoffVersion: number;
  expectedCursor: number;
  nextCursor?: number;
}

export interface ProjectChatAssistantProjection {
  sessionKey: string;
  content: string;
  messageId?: string;
  presentation?: Prisma.InputJsonValue | null;
}

async function settleProjectChatBindingHandoff(
  transaction: LeaseTransaction,
  key: StateKey,
  input: ProjectChatSettlementHandoff,
  options: {
    allowLegacyConvergence?: boolean;
    attestedBinding?: ProjectChatProviderBinding;
  } = {},
): Promise<ProjectChatProviderBinding> {
  const provider = persistedProvider(input.provider);
  const expectedHandoffVersion = nonNegativeCursor(input.expectedHandoffVersion, 'handoff version');
  const expectedCursor = nonNegativeCursor(input.expectedCursor, 'handoff cursor');
  const nextCursor = nonNegativeCursor(input.nextCursor, 'next handoff cursor');
  const bindingWhere = {
    userId_projectId_provider: {
      userId: key.actorUserId,
      projectId: key.projectIdentityId,
      provider,
    },
  };
  const readBinding = () => transaction.projectChatProviderBinding.findUnique({ where: bindingWhere }) as Promise<
    ProjectChatProviderBinding | null
  >;

  if (options.allowLegacyConvergence) {
    if (nextCursor < expectedCursor) {
      const current = await readBinding();
      if (
        current
        && current.handoffVersion > expectedHandoffVersion
        && current.handoffCursor <= expectedCursor
      ) return current;
      throw new ProjectChatLeaseError('INVALID_INPUT', 'Provider handoff cursor cannot move backwards', 400);
    }
    if (nextCursor === expectedCursor) {
      const current = await readBinding();
      if (!current) {
        throw new ProjectChatLeaseError('STATE_CORRUPT', 'Project Chat provider binding was not found', 500);
      }
      if (
        current.handoffVersion < expectedHandoffVersion
        || (current.handoffVersion === expectedHandoffVersion && current.handoffCursor !== expectedCursor)
      ) {
        throw new ProjectChatLeaseError('HANDOFF_CONFLICT', 'Provider handoff state changed concurrently');
      }
      return current;
    }
    const changed = await transaction.projectChatProviderBinding.updateMany({
      where: {
        userId: key.actorUserId,
        projectId: key.projectIdentityId,
        provider,
        handoffVersion: expectedHandoffVersion,
        handoffCursor: expectedCursor,
      },
      data: { handoffCursor: nextCursor, handoffVersion: { increment: 1 }, lastActivity: new Date() },
    });
    let current = await readBinding();
    if (changed.count === 1) {
      if (!current) {
        throw new ProjectChatLeaseError('STATE_CORRUPT', 'Provider handoff advancement was not durable', 500);
      }
      return current;
    }
    if (!current) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Project Chat provider binding was not found', 500);
    }
    if (current.handoffVersion <= expectedHandoffVersion) {
      throw new ProjectChatLeaseError('HANDOFF_CONFLICT', 'Provider handoff state changed concurrently');
    }
    if (current.handoffCursor >= nextCursor || current.handoffCursor <= expectedCursor) return current;
    const converged = await transaction.projectChatProviderBinding.updateMany({
      where: {
        userId: key.actorUserId,
        projectId: key.projectIdentityId,
        provider,
        handoffVersion: current.handoffVersion,
        handoffCursor: current.handoffCursor,
      },
      data: { handoffCursor: nextCursor, handoffVersion: { increment: 1 }, lastActivity: new Date() },
    });
    if (converged.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat handoff changed during settlement');
    }
    current = await readBinding();
    if (!current || current.handoffCursor !== nextCursor) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Provider handoff convergence was not durable', 500);
    }
    return current;
  }

  const current = options.attestedBinding || await readBinding();
  if (
    !current
    || current.handoffVersion !== expectedHandoffVersion
    || current.handoffCursor !== expectedCursor
    || current.status === 'reset'
  ) {
    throw new ProjectChatLeaseError(
      'HANDOFF_CONFLICT',
      'Project Chat provider generation changed before terminal settlement',
    );
  }

  if (nextCursor < expectedCursor) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Provider handoff cursor cannot move backwards', 400);
  }

  if (nextCursor === expectedCursor) return current;

  const changed = await transaction.projectChatProviderBinding.updateMany({
    where: {
      userId: key.actorUserId,
      projectId: key.projectIdentityId,
      provider,
      handoffVersion: expectedHandoffVersion,
      handoffCursor: expectedCursor,
    },
    data: { handoffCursor: nextCursor, handoffVersion: { increment: 1 }, lastActivity: new Date() },
  });
  const binding = await readBinding();
  if (changed.count === 1) {
    if (!binding) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Provider handoff advancement was not durable', 500);
    }
    return binding;
  }
  throw new ProjectChatLeaseError('HANDOFF_CONFLICT', 'Provider handoff state changed concurrently');
}

export async function finishProjectChatTurn(input: StateKey & {
  turnId: string;
  leaseToken: string;
  status: 'COMPLETED' | 'ERROR' | 'ABORTED';
  transcriptCursor?: number;
  providerSessionId?: string | null;
  resultMetadata?: Prisma.InputJsonValue;
  errorCode?: string | null;
  errorMessage?: string | null;
  handoff?: ProjectChatSettlementHandoff;
  assistantProjection?: ProjectChatAssistantProjection;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatTurn> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const terminalStatus = ProjectChatTurnStatus[input.status];
  const now = input.now || new Date();
  if (input.resultMetadata !== undefined) assertReplayPayload(input.resultMetadata);
  if (input.assistantProjection?.presentation != null) {
    assertReplayPayload(input.assistantProjection.presentation);
  }
  const transcriptCursor = input.transcriptCursor == null
    ? null
    : nonNegativeCursor(input.transcriptCursor, 'transcript cursor');

  return serializable(database, async (transaction) => {
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    }
    assertLease(turn, input.leaseToken);
    if (isTerminal(turn.status)) return turn;

    const state = await transaction.projectChatState.findUnique({
      where: { actorUserId_projectIdentityId: key },
    });
    if (!state || state.activeTurnId !== turnId) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Active Project Chat turn is detached from its project', 500);
    }
    let attestedBinding: ProjectChatProviderBinding | null = null;
    if (input.handoff) {
      attestedBinding = await transaction.projectChatProviderBinding.findUnique({
        where: {
          userId_projectId_provider: {
            userId: key.actorUserId,
            projectId: key.projectIdentityId,
            provider: persistedProvider(input.handoff.provider),
          },
        },
      });
      if (
        !attestedBinding
        || attestedBinding.status === 'reset'
        || attestedBinding.handoffVersion !== input.handoff.expectedHandoffVersion
        || attestedBinding.handoffCursor !== input.handoff.expectedCursor
      ) {
        throw new ProjectChatLeaseError(
          'HANDOFF_CONFLICT',
          'Project Chat provider generation changed before terminal projection',
        );
      }
    }
    let projectedTranscriptCursor: number | null = null;
    if (input.assistantProjection) {
      const sessionKey = requiredIdentifier(input.assistantProjection.sessionKey, 'projection session key');
      const messageId = String(
        input.assistantProjection.messageId || `project-turn:${turn.id}`,
      ).trim();
      requiredIdentifier(messageId, 'projection message ID');
      const projectionData = {
        content: String(input.assistantProjection.content || ''),
        presentation: input.assistantProjection.presentation == null
          ? Prisma.JsonNull
          : input.assistantProjection.presentation,
        model: turn.model,
        providerSessionId: input.providerSessionId || turn.providerSessionId,
      };
      const existingProjection = await transaction.projectChatMessage.findUnique({
        where: { turnId: turn.id },
      });
      if (existingProjection) {
        if (
          existingProjection.userId !== key.actorUserId
          || existingProjection.projectId !== key.projectIdentityId
          || existingProjection.role !== 'assistant'
        ) {
          throw new ProjectChatLeaseError(
            'STATE_CORRUPT',
            'Project Chat terminal projection ownership is inconsistent',
            500,
          );
        }
        await transaction.projectChatMessage.update({
          where: { id: existingProjection.id },
          data: projectionData,
        });
      } else {
        const legacyProjection = await transaction.projectChatMessage.findFirst({
          where: {
            userId: key.actorUserId,
            projectId: key.projectIdentityId,
            role: 'assistant',
            messageId,
            turnId: null,
          },
        });
        if (legacyProjection) {
          await transaction.projectChatMessage.update({
            where: { id: legacyProjection.id },
            data: { ...projectionData, turnId: turn.id },
          });
        } else {
          await transaction.projectChatMessage.create({
            data: {
              projectId: key.projectIdentityId,
              userId: key.actorUserId,
              sessionKey,
              role: 'assistant',
              content: projectionData.content,
              messageId,
              turnId: turn.id,
              presentation: input.assistantProjection.presentation == null
                ? undefined
                : input.assistantProjection.presentation,
              provider: turn.provider,
              runtime: turn.runtime,
              model: turn.model,
              providerSessionId: input.providerSessionId || turn.providerSessionId,
            },
          });
        }
      }
      projectedTranscriptCursor = await transaction.projectChatMessage.count({
        where: { userId: key.actorUserId, projectId: key.projectIdentityId },
      });
    }
    const observedTranscriptCursor = projectedTranscriptCursor ?? transcriptCursor;
    // State remains a monotonic high-water mark. A smaller caller observation
    // can only be stale; the assistant projection count above is authoritative
    // because it was measured inside this same Serializable transaction.
    const settledTranscriptCursor = observedTranscriptCursor == null
      ? null
      : Math.max(state.transcriptCursor, observedTranscriptCursor);
    const handoffNextCursor = input.handoff
      ? projectedTranscriptCursor ?? input.handoff.nextCursor ?? transcriptCursor
      : null;
    if (input.handoff && handoffNextCursor == null) {
      throw new ProjectChatLeaseError(
        'INVALID_INPUT',
        'Completed Project Chat settlement requires an authoritative handoff cursor',
        400,
      );
    }
    let settledBinding: ProjectChatProviderBinding | null = null;
    if (terminalStatus === ProjectChatTurnStatus.COMPLETED && input.handoff) {
      settledBinding = await settleProjectChatBindingHandoff(transaction, key, {
        ...input.handoff,
        nextCursor: handoffNextCursor!,
      }, { attestedBinding: attestedBinding! });
    }
    const existingResultMetadata = turn.resultMetadata && typeof turn.resultMetadata === 'object'
      && !Array.isArray(turn.resultMetadata)
      ? turn.resultMetadata as Record<string, unknown>
      : {};
    const resultMetadata = input.resultMetadata && typeof input.resultMetadata === 'object'
      && !Array.isArray(input.resultMetadata)
      ? input.resultMetadata as Record<string, unknown>
      : {};
    const finalized = await transaction.projectChatTurn.updateMany({
      where: { id: turnId, leaseTokenHash: turn.leaseTokenHash, status: { in: ACTIVE_TURN_STATUSES } },
      data: {
        status: terminalStatus,
        activeProjectKey: null,
        completedAt: now,
        ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
        ...(input.resultMetadata !== undefined || input.assistantProjection ? {
          resultMetadata: {
            ...existingResultMetadata,
            ...resultMetadata,
            atomicSettlementVersion: 2,
            presentationMaterialized: Boolean(input.assistantProjection),
            ...(settledTranscriptCursor != null ? { settledTranscriptCursor } : {}),
            ...(settledBinding ? {
              settledHandoffCursor: settledBinding.handoffCursor,
              settledHandoffVersion: settledBinding.handoffVersion,
            } : {}),
          } as Prisma.InputJsonValue,
        } : {}),
        errorCode: input.errorCode || null,
        errorMessage: input.errorMessage ? String(input.errorMessage).slice(0, 80_000) : null,
      },
    });
    if (finalized.count !== 1) {
      const terminal = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
      if (terminal && isTerminal(terminal.status)) return terminal;
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat turn changed concurrently');
    }
    const detached = await transaction.projectChatState.updateMany({
      where: {
        id: state.id,
        activeTurnId: turnId,
        version: state.version,
        transcriptCursor: state.transcriptCursor,
      },
      data: {
        activeTurnId: null,
        version: { increment: 1 },
        ...(settledTranscriptCursor != null ? { transcriptCursor: settledTranscriptCursor } : {}),
      },
    });
    if (detached.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat state changed during turn settlement');
    }
    return transaction.projectChatTurn.findUnique({ where: { id: turnId } }) as Promise<ProjectChatTurn>;
  });
}

/**
 * Repairs rows written by Portal builds that finalized/detached a turn before
 * advancing the provider binding. The repair runs only while the caller owns
 * the exact runtime-admission lease and only for the same still-bound provider
 * session. It advances to the position of the newest legacy assistant row,
 * not to the current transcript tail, so newer cross-provider context still
 * bootstraps normally.
 */
export async function reconcileLegacyProjectChatTerminalHandoff(input: StateKey & {
  provider: ProjectChatPersistedProvider;
  admission: ProjectChatRuntimeAdmissionGrant;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatProviderBinding> {
  const key = normalizeStateKey(input);
  const provider = persistedProvider(input.provider);
  const admissionTurnId = requiredIdentifier(input.admission.turn.id, 'runtime admission turn');
  const expectedStateVersion = nonNegativeCursor(
    input.admission.state.version,
    'runtime admission state version',
  );
  const now = input.now || new Date();

  return serializable(database, async (transaction) => {
    const [state, admissionTurn, binding] = await Promise.all([
      transaction.projectChatState.findUnique({
        where: { actorUserId_projectIdentityId: key },
      }),
      transaction.projectChatTurn.findUnique({ where: { id: admissionTurnId } }),
      transaction.projectChatProviderBinding.findUnique({
        where: {
          userId_projectId_provider: {
            userId: key.actorUserId,
            projectId: key.projectIdentityId,
            provider,
          },
        },
      }),
    ]);
    if (
      !state
      || state.activeTurnId !== admissionTurnId
      || state.version !== expectedStateVersion
    ) {
      throw new ProjectChatLeaseError(
        'VERSION_CONFLICT',
        'Project Chat legacy settlement repair lost runtime admission',
      );
    }
    if (
      !admissionTurn
      || !isProjectChatRuntimeAdmissionTurn(admissionTurn)
      || admissionTurn.status !== ProjectChatTurnStatus.RUNNING
      || admissionTurn.actorUserId !== key.actorUserId
      || admissionTurn.projectIdentityId !== key.projectIdentityId
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat legacy settlement repair could not attest runtime admission',
        500,
      );
    }
    assertLease(admissionTurn, input.admission.leaseToken);
    if (!binding) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Project Chat provider binding was not found', 500);
    }
    const providerSessionIds = Array.from(new Set(
      [binding.sessionKey, binding.externalSessionId]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ));
    if (binding.status === 'reset' || providerSessionIds.length === 0) return binding;

    const legacyTurns = await transaction.projectChatTurn.findMany({
      where: {
        actorUserId: key.actorUserId,
        projectIdentityId: key.projectIdentityId,
        provider,
        providerSessionId: { in: providerSessionIds },
        // Only a successfully completed legacy turn consumed the provider's
        // transcript handoff. Error, abort, and expiry rows must remain in
        // bootstrap context for the next attempt, matching current atomic
        // settlement semantics.
        status: ProjectChatTurnStatus.COMPLETED,
        NOT: { requestId: { startsWith: PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const legacyTurnIds = new Set(legacyTurns
      .filter((turn) => {
        if (turn.status !== ProjectChatTurnStatus.COMPLETED) return false;
        const metadata = turn.resultMetadata && typeof turn.resultMetadata === 'object'
          && !Array.isArray(turn.resultMetadata)
          ? turn.resultMetadata as Record<string, unknown>
          : {};
        return metadata.atomicSettlementVersion !== 2;
      })
      .map((turn) => turn.id));
    if (legacyTurnIds.size === 0) return binding;

    const transcript = await transaction.projectChatMessage.findMany({
      where: { userId: key.actorUserId, projectId: key.projectIdentityId },
      orderBy: [{ timestamp: 'asc' }, { sourceSortKey: 'asc' }, { id: 'asc' }],
      select: { id: true, turnId: true },
    });
    let legacyCursor = binding.handoffCursor;
    for (let index = 0; index < transcript.length; index += 1) {
      const turnId = String(transcript[index]?.turnId || '');
      if (legacyTurnIds.has(turnId)) legacyCursor = Math.max(legacyCursor, index + 1);
    }
    const targetCursor = Math.min(legacyCursor, state.transcriptCursor);
    if (targetCursor <= binding.handoffCursor) return binding;

    const advanced = await transaction.projectChatProviderBinding.updateMany({
      where: {
        id: binding.id,
        status: binding.status,
        handoffVersion: binding.handoffVersion,
        handoffCursor: binding.handoffCursor,
        OR: providerSessionIds.flatMap((sessionId) => ([
          { sessionKey: sessionId },
          { externalSessionId: sessionId },
        ])),
      },
      data: {
        handoffCursor: targetCursor,
        handoffVersion: { increment: 1 },
        lastActivity: now,
      },
    });
    if (advanced.count !== 1) {
      throw new ProjectChatLeaseError(
        'HANDOFF_CONFLICT',
        'Project Chat provider binding changed during legacy settlement repair',
      );
    }
    const repaired = await transaction.projectChatProviderBinding.findUnique({
      where: {
        userId_projectId_provider: {
          userId: key.actorUserId,
          projectId: key.projectIdentityId,
          provider,
        },
      },
    });
    if (!repaired || repaired.handoffCursor !== targetCursor) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat legacy handoff repair was not durable',
        500,
      );
    }
    return repaired;
  });
}

export async function switchProjectChatProvider(input: StateKey & {
  expectedVersion: number;
  requestedProvider: ProjectChatPersistedProvider;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatState> {
  const key = normalizeStateKey(input);
  const expectedVersion = nonNegativeCursor(input.expectedVersion, 'state version');
  const requestedProvider = persistedProvider(input.requestedProvider);
  const now = input.now || new Date();
  return serializable(database, async (transaction) => {
    const state = await clearFinishedTurn(transaction, key, now);
    if (!state) throw new ProjectChatLeaseError('STATE_NOT_FOUND', 'Project Chat state was not found', 404);
    if (state.version !== expectedVersion) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat state version is stale');
    }
    if (state.activeTurnId) {
      throw new ProjectChatLeaseError('TURN_ACTIVE', 'Cannot switch providers during an active turn');
    }
    if (state.selectedProvider === requestedProvider) return state;
    const switched = await transaction.projectChatState.updateMany({
      where: { id: state.id, version: expectedVersion, activeTurnId: null },
      data: { selectedProvider: requestedProvider, version: { increment: 1 } },
    });
    if (switched.count !== 1) {
      throw new ProjectChatLeaseError('VERSION_CONFLICT', 'Project Chat changed before the provider switch');
    }
    return transaction.projectChatState.findUnique({ where: { id: state.id } }) as Promise<ProjectChatState>;
  });
}

export async function advanceProjectChatBindingHandoff(input: StateKey & {
  provider: ProjectChatPersistedProvider;
  expectedHandoffVersion: number;
  expectedCursor: number;
  nextCursor: number;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatProviderBinding> {
  const key = normalizeStateKey(input);
  const provider = persistedProvider(input.provider);
  const expectedHandoffVersion = nonNegativeCursor(input.expectedHandoffVersion, 'handoff version');
  const expectedCursor = nonNegativeCursor(input.expectedCursor, 'handoff cursor');
  const nextCursor = nonNegativeCursor(input.nextCursor, 'next handoff cursor');
  if (nextCursor < expectedCursor) {
    throw new ProjectChatLeaseError('INVALID_INPUT', 'Provider handoff cursor cannot move backwards', 400);
  }
  return serializable(database, async (transaction) => {
    const changed = await transaction.projectChatProviderBinding.updateMany({
      where: {
        userId: key.actorUserId,
        projectId: key.projectIdentityId,
        provider,
        handoffVersion: expectedHandoffVersion,
        handoffCursor: expectedCursor,
      },
      data: { handoffCursor: nextCursor, handoffVersion: { increment: 1 }, lastActivity: new Date() },
    });
    if (changed.count !== 1) {
      throw new ProjectChatLeaseError('HANDOFF_CONFLICT', 'Provider handoff state changed concurrently');
    }
    return transaction.projectChatProviderBinding.findUnique({
      where: {
        userId_projectId_provider: {
          userId: key.actorUserId,
          projectId: key.projectIdentityId,
          provider,
        },
      },
    }) as Promise<ProjectChatProviderBinding>;
  });
}

export function projectChatBindingNeedsHandoff(binding: Pick<
  ProjectChatProviderBinding,
  'handoffCursor' | 'handoffVersion'
>, portalTranscriptCursor: number): boolean {
  nonNegativeCursor(binding.handoffCursor, 'handoff cursor');
  nonNegativeCursor(binding.handoffVersion, 'handoff version');
  const transcriptCursor = nonNegativeCursor(portalTranscriptCursor, 'Portal transcript cursor');
  return binding.handoffCursor === 0 || binding.handoffCursor < transcriptCursor;
}

/**
 * A provider only owns the transcript cursor after its assistant response and
 * terminal turn have both been durably committed. Failed or aborted first
 * attempts deliberately leave cursor zero so a retry receives the handoff.
 */
export async function advanceProjectChatBindingHandoffAfterSettlement(input: StateKey & {
  provider: ProjectChatPersistedProvider;
  settlementStatus: 'COMPLETED' | 'ERROR' | 'ABORTED' | 'EXPIRED';
  expectedHandoffVersion: number;
  expectedCursor: number;
  nextCursor: number;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<ProjectChatProviderBinding | null> {
  if (input.settlementStatus !== 'COMPLETED') return null;
  const key = normalizeStateKey(input);
  return serializable(database, (transaction) => settleProjectChatBindingHandoff(
    transaction,
    key,
    input,
    { allowLegacyConvergence: true },
  ));
}

export async function readProjectChatTurnReplay(input: StateKey & {
  turnId: string;
  afterSeq?: number;
  limit?: number;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<{
  turn: ProjectChatTurn;
  events: ProjectChatTurnEvent[];
}> {
  const key = normalizeStateKey(input);
  const turnId = requiredIdentifier(input.turnId, 'turn ID');
  const afterSeq = nonNegativeCursor(input.afterSeq || 0, 'replay cursor');
  const limit = Math.min(1_000, Math.max(1, Number(input.limit) || 250));
  return serializable(database, async (transaction) => {
    const turn = await transaction.projectChatTurn.findUnique({ where: { id: turnId } });
    if (!turn || turn.actorUserId !== key.actorUserId || turn.projectIdentityId !== key.projectIdentityId) {
      throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
    }
    const events = await transaction.projectChatTurnEvent.findMany({
      where: { turnId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
    return { turn, events };
  });
}

export async function readProjectChatCoordinationState(input: StateKey & {
  recoverStale?: boolean;
  now?: Date;
}, database: ProjectChatLeaseDatabase = defaultDatabase): Promise<{
  state: ProjectChatState | null;
  activeTurn: ProjectChatTurn | null;
}> {
  const key = normalizeStateKey(input);
  const now = input.now || new Date();
  return serializable(database, async (transaction) => {
    const state = input.recoverStale === false
      ? await transaction.projectChatState.findUnique({
        where: { actorUserId_projectIdentityId: key },
      })
      : await clearFinishedTurn(transaction, key, now);
    if (!state?.activeTurnId) return { state, activeTurn: null };
    const activeTurn = await transaction.projectChatTurn.findUnique({
      where: { id: state.activeTurnId },
    });
    if (
      !activeTurn
      || activeTurn.actorUserId !== key.actorUserId
      || activeTurn.projectIdentityId !== key.projectIdentityId
      || !ACTIVE_TURN_STATUSES.includes(activeTurn.status)
    ) {
      throw new ProjectChatLeaseError('STATE_CORRUPT', 'Project Chat active-turn pointer is invalid', 500);
    }
    return { state, activeTurn };
  });
}
