import { ProjectChatTurnStatus } from '@prisma/client';
import { prisma } from '../config/database';
import type { ProjectIdentityRecord } from './projectIdentity';
import {
  isProjectChatRuntimeAdmissionTurn,
  type ProjectChatPersistedProvider,
} from './projectChatTurnLease';

export const PROJECT_RUNTIME_CLEANUP_PROVIDERS = Object.freeze([
  'OPENCLAW',
  'CLAUDE_CODE',
  'CODEX',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
  'GROK_BUILD',
] as const satisfies readonly ProjectChatPersistedProvider[]);

export type ProjectRuntimeCleanupProvider = typeof PROJECT_RUNTIME_CLEANUP_PROVIDERS[number];

export type ProjectRuntimeResourceKind =
  | 'OPENCLAW_AGENT'
  | 'OPENCLAW_SESSION'
  | 'OPENCLAW_CONTAINER'
  | 'NATIVE_SESSION'
  | 'NATIVE_RUN_BROKER'
  | 'NATIVE_RUNTIME_CONTAINER'
  | 'NATIVE_CREDENTIAL'
  | 'AGENT_ZERO_SESSION'
  | 'AGENT_ZERO_CONTAINER'
  | 'AGENT_ZERO_NETWORK'
  | 'AGENT_ZERO_VOLUME'
  | 'AGENT_ZERO_CREDENTIAL'
  | 'AGENT_ZERO_FIREWALL'
  | 'EGRESS_PROXY_CONTAINER'
  | 'EGRESS_INTERNAL_NETWORK'
  | 'EGRESS_PUBLIC_NETWORK'
  | 'EGRESS_FIREWALL_CHAIN';

const OPENCLAW_RESOURCE_KINDS = new Set<ProjectRuntimeResourceKind>([
  'OPENCLAW_AGENT',
  'OPENCLAW_SESSION',
  'OPENCLAW_CONTAINER',
]);

const NATIVE_RESOURCE_KINDS = new Set<ProjectRuntimeResourceKind>([
  'NATIVE_SESSION',
  'NATIVE_RUN_BROKER',
  'NATIVE_RUNTIME_CONTAINER',
  'NATIVE_CREDENTIAL',
]);

const AGENT_ZERO_RESOURCE_KINDS = new Set<ProjectRuntimeResourceKind>([
  ...NATIVE_RESOURCE_KINDS,
  'AGENT_ZERO_SESSION',
  'AGENT_ZERO_CONTAINER',
  'AGENT_ZERO_NETWORK',
  'AGENT_ZERO_VOLUME',
  'AGENT_ZERO_CREDENTIAL',
  'AGENT_ZERO_FIREWALL',
]);

const EGRESS_RESOURCE_KINDS = new Set<ProjectRuntimeResourceKind>([
  'EGRESS_PROXY_CONTAINER',
  'EGRESS_INTERNAL_NETWORK',
  'EGRESS_PUBLIC_NETWORK',
  'EGRESS_FIREWALL_CHAIN',
]);

const ACTIVE_TURN_STATUSES = new Set<string>([
  ProjectChatTurnStatus.RUNNING,
  ProjectChatTurnStatus.ABORTING,
]);

const CLEANUP_PENDING_STATUS = 'cleanup_pending';
const CLEANUP_COMPLETE_STATUS = 'cleanup_complete';
const MAX_IDENTIFIER_LENGTH = 512;

export interface ProjectRuntimeCleanupBinding {
  id: string;
  userId: string;
  projectId: string;
  provider: string;
  runtime: string;
  sessionKey: string | null;
  externalSessionId: string | null;
  status: string;
}

export interface ProjectRuntimeCleanupSession {
  id: string;
  userId: string;
  projectId: string;
  sessionKey: string;
  activeProvider: string;
  runtime: string;
  status: string;
}

export interface ProjectRuntimeCleanupState {
  id: string;
  actorUserId: string;
  projectIdentityId: string;
  activeTurnId: string | null;
}

export interface ProjectRuntimeCleanupTurn {
  id: string;
  stateId: string;
  actorUserId: string;
  projectIdentityId: string;
  provider: ProjectRuntimeCleanupProvider;
  runtime: string;
  requestId: string;
  status: 'RUNNING' | 'ABORTING';
  leaseExpiresAt: Date;
  providerSessionId: string | null;
}

export interface ProjectRuntimeCleanupSnapshot {
  bindings: ProjectRuntimeCleanupBinding[];
  sessions: ProjectRuntimeCleanupSession[];
  states: ProjectRuntimeCleanupState[];
  activeTurns: ProjectRuntimeCleanupTurn[];
}

export interface ProjectRuntimeResource {
  /** Provider-owned immutable resource identifier, never a display name or project path. */
  id: string;
  kind: ProjectRuntimeResourceKind;
  projectIdentityId: string;
  /** Null only for one project-global resource such as a provider-owned network. */
  actorUserId: string | null;
  provider: ProjectRuntimeCleanupProvider | null;
}

export interface ProjectRuntimeCleanupScope {
  authenticatedActorId: string;
  workspaceOwnerId: string;
  projectIdentity: Readonly<ProjectIdentityRecord>;
  knownActorIds: readonly string[];
  cleanupSessionEvidence?: readonly ProjectRuntimeCleanupSessionEvidence[];
  bindings: readonly ProjectRuntimeCleanupBinding[];
  sessions: readonly ProjectRuntimeCleanupSession[];
  activeTurns: readonly ProjectRuntimeCleanupTurn[];
}

export interface ProjectRuntimeCleanupSessionEvidence {
  provider: ProjectRuntimeCleanupProvider;
  actorUserId: string;
  sessionId: string;
}

export interface ProjectRuntimeQuiesceEvidence {
  quiesced: true;
  /** Non-secret attestation identifier/log cursor produced after the abort probe. */
  evidence: string;
}

/**
 * Provider adapters are deliberately strict. Discovery must scan provider-owned
 * state by the immutable ProjectIdentity UUID, including orphan resources that
 * no longer have a Portal binding. Cleanup is not considered successful until
 * a fresh verification scan returns an empty set.
 */
export interface ProjectRuntimeCleanupAdapter {
  readonly provider: ProjectRuntimeCleanupProvider;
  enumerate(scope: ProjectRuntimeCleanupScope): Promise<readonly ProjectRuntimeResource[]>;
  quiesceTurn(
    scope: ProjectRuntimeCleanupScope,
    turn: ProjectRuntimeCleanupTurn,
  ): Promise<ProjectRuntimeQuiesceEvidence>;
  cleanup(
    scope: ProjectRuntimeCleanupScope,
    resources: readonly ProjectRuntimeResource[],
  ): Promise<void>;
  verifyClean(scope: ProjectRuntimeCleanupScope): Promise<readonly ProjectRuntimeResource[]>;
}

/**
 * The egress adapter owns the proxy sidecar, both networks, and firewall chains.
 * It runs after every provider runtime is gone so a runtime cannot be stranded
 * on an unverified network during a partial deletion.
 */
export interface ProjectEgressCleanupAdapter {
  enumerate(scope: ProjectRuntimeCleanupScope): Promise<readonly ProjectRuntimeResource[]>;
  cleanup(
    scope: ProjectRuntimeCleanupScope,
    resources: readonly ProjectRuntimeResource[],
  ): Promise<void>;
  verifyClean(scope: ProjectRuntimeCleanupScope): Promise<readonly ProjectRuntimeResource[]>;
}

export type ProjectRuntimeCleanupAdapterRegistry = Readonly<
  Record<ProjectRuntimeCleanupProvider, ProjectRuntimeCleanupAdapter>
>;

export interface ProjectRuntimeCleanupRepository {
  loadSnapshot(projectIdentityId: string): Promise<ProjectRuntimeCleanupSnapshot>;
  loadCleanupEvidence(
    projectIdentityId: string,
  ): Promise<readonly ProjectRuntimeCleanupSessionEvidence[]>;
  recordCleanupActors(
    projectIdentityId: string,
    resources: readonly ProjectRuntimeResource[],
  ): Promise<void>;
  clearCleanupActors(projectIdentityId: string): Promise<void>;
  markBindingsCleanupPending(projectIdentityId: string, bindingIds: readonly string[]): Promise<void>;
  beginTurnAbort(turn: ProjectRuntimeCleanupTurn): Promise<ProjectRuntimeCleanupTurn>;
  finishTurnAbort(
    turn: ProjectRuntimeCleanupTurn,
    evidence: string,
    lifecycleReason: 'delete' | 'rename' | 'authorization_change',
  ): Promise<void>;
  markBindingsCleanupComplete(projectIdentityId: string, bindingIds: readonly string[]): Promise<void>;
}

export type ProjectRuntimeCleanupErrorCode =
  | 'INVALID_INPUT'
  | 'IDENTITY_MISMATCH'
  | 'ADAPTER_MISSING'
  | 'ENUMERATION_FAILED'
  | 'RESOURCE_IDENTITY_MISMATCH'
  | 'TURN_ABORT_FAILED'
  | 'TURN_STILL_ACTIVE'
  | 'CLEANUP_FAILED'
  | 'RESIDUAL_RESOURCE';

export class ProjectRuntimeCleanupError extends Error {
  constructor(
    public readonly code: ProjectRuntimeCleanupErrorCode,
    message: string,
    public readonly provider: ProjectRuntimeCleanupProvider | 'EGRESS' | null = null,
    /**
     * How much longer the blocking condition can last, when that is knowable.
     * A held turn lease has an expiry, so callers can say when to try again
     * rather than presenting a self-clearing state as a dead end.
     */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProjectRuntimeCleanupError';
  }
}

/** Milliseconds until a held lease lapses, clamped to a sane retry hint. */
export function projectRuntimeLeaseRetryAfterMs(leaseExpiresAt: Date): number {
  const remaining = leaseExpiresAt.getTime() - Date.now();
  if (!Number.isFinite(remaining)) return 5_000;
  return Math.max(1_000, Math.min(remaining + 1_000, 120_000));
}

export interface ProjectRuntimeCleanupInput {
  authenticatedActorId: string;
  workspaceOwnerId: string;
  projectIdentity: ProjectIdentityRecord;
  /**
   * Additional server-attested Portal actors to scan when a global operation
   * must discover provider state that never reached a binding/session row.
   */
  candidateActorIds?: readonly string[];
  lifecycleReason?: 'delete' | 'rename' | 'authorization_change';
}

export interface ProjectRuntimeCleanupOptions {
  repository?: ProjectRuntimeCleanupRepository;
  adapters: ProjectRuntimeCleanupAdapterRegistry;
  egressAdapter: ProjectEgressCleanupAdapter;
}

export interface ProjectRuntimeCleanupResult {
  projectIdentityId: string;
  actorCount: number;
  bindingCount: number;
  sessionCount: number;
  quiescedTurnCount: number;
  removedResourceCount: number;
  alreadyClean: boolean;
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (
    !normalized
    || normalized.length > MAX_IDENTIFIER_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ProjectRuntimeCleanupError('INVALID_INPUT', `Invalid ${label}`);
  }
  return normalized;
}

function normalizeProvider(value: unknown): ProjectRuntimeCleanupProvider {
  const candidate = String(value || '').trim().toUpperCase();
  // AgentProviderName uses GROK while the durable Prisma enum intentionally
  // uses GROK_BUILD. Cleanup has one canonical persisted identity.
  const normalized = candidate === 'GROK' ? 'GROK_BUILD' : candidate;
  if (!PROJECT_RUNTIME_CLEANUP_PROVIDERS.includes(normalized as ProjectRuntimeCleanupProvider)) {
    throw new ProjectRuntimeCleanupError('RESOURCE_IDENTITY_MISMATCH', 'Project runtime provider identity is invalid');
  }
  return normalized as ProjectRuntimeCleanupProvider;
}

function validateIdentity(input: ProjectRuntimeCleanupInput): {
  authenticatedActorId: string;
  workspaceOwnerId: string;
  projectIdentity: Readonly<ProjectIdentityRecord>;
  candidateActorIds: readonly string[];
} {
  const authenticatedActorId = requiredIdentifier(input.authenticatedActorId, 'authenticated actor');
  const workspaceOwnerId = requiredIdentifier(input.workspaceOwnerId, 'workspace owner');
  const identity = input.projectIdentity;
  if (!identity || typeof identity !== 'object') {
    throw new ProjectRuntimeCleanupError('INVALID_INPUT', 'Project identity is required');
  }
  const id = requiredIdentifier(identity.id, 'project identity');
  const identityOwner = requiredIdentifier(identity.workspaceOwnerId, 'project identity owner');
  requiredIdentifier(identity.rootDevice, 'project root device');
  requiredIdentifier(identity.rootInode, 'project root inode');
  requiredIdentifier(identity.rootBirthtimeNs, 'project root birth time');
  if (identityOwner !== workspaceOwnerId) {
    throw new ProjectRuntimeCleanupError(
      'IDENTITY_MISMATCH',
      'Project identity does not belong to the supplied workspace owner',
    );
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new ProjectRuntimeCleanupError('IDENTITY_MISMATCH', 'Project identity generation is invalid');
  }
  return {
    authenticatedActorId,
    workspaceOwnerId,
    projectIdentity: Object.freeze({ ...identity, id, workspaceOwnerId: identityOwner }),
    candidateActorIds: Object.freeze(Array.from(new Set(
      (input.candidateActorIds || []).map((actorId) => requiredIdentifier(
        actorId,
        'candidate Project runtime actor',
      )),
    )).sort()),
  };
}

function assertCompleteAdapterRegistry(registry: ProjectRuntimeCleanupAdapterRegistry): void {
  for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
    const adapter = registry?.[provider];
    if (
      !adapter
      || adapter.provider !== provider
      || typeof adapter.enumerate !== 'function'
      || typeof adapter.quiesceTurn !== 'function'
      || typeof adapter.cleanup !== 'function'
      || typeof adapter.verifyClean !== 'function'
    ) {
      throw new ProjectRuntimeCleanupError(
        'ADAPTER_MISSING',
        `Project runtime cleanup adapter is unavailable for ${provider}`,
        provider,
      );
    }
  }
}

function assertEgressAdapter(adapter: ProjectEgressCleanupAdapter): void {
  if (
    !adapter
    || typeof adapter.enumerate !== 'function'
    || typeof adapter.cleanup !== 'function'
    || typeof adapter.verifyClean !== 'function'
  ) {
    throw new ProjectRuntimeCleanupError(
      'ADAPTER_MISSING',
      'Project egress cleanup adapter is unavailable',
      'EGRESS',
    );
  }
}

function immutableSnapshot(
  snapshot: ProjectRuntimeCleanupSnapshot,
  projectIdentityId: string,
): ProjectRuntimeCleanupSnapshot {
  const bindings = snapshot.bindings.map((binding) => {
    if (binding.projectId !== projectIdentityId) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'A Project Chat binding escaped the immutable project identity',
      );
    }
    const provider = normalizeProvider(binding.provider);
    requiredIdentifier(binding.id, 'Project Chat binding');
    requiredIdentifier(binding.userId, 'Project Chat binding actor');
    return Object.freeze({ ...binding, provider });
  });
  const sessions = snapshot.sessions.map((session) => {
    if (session.projectId !== projectIdentityId) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'A Project Chat session escaped the immutable project identity',
      );
    }
    const activeProvider = normalizeProvider(session.activeProvider);
    requiredIdentifier(session.id, 'Project Chat session');
    requiredIdentifier(session.userId, 'Project Chat session actor');
    return Object.freeze({ ...session, activeProvider });
  });
  const states = snapshot.states.map((state) => {
    if (state.projectIdentityId !== projectIdentityId) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'A Project Chat state escaped the immutable project identity',
      );
    }
    requiredIdentifier(state.id, 'Project Chat state');
    requiredIdentifier(state.actorUserId, 'Project Chat state actor');
    return Object.freeze({ ...state });
  });
  const activeTurns = snapshot.activeTurns.map((turn) => {
    if (turn.projectIdentityId !== projectIdentityId || !ACTIVE_TURN_STATUSES.has(turn.status)) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'A Project Chat turn escaped the immutable project identity',
      );
    }
    const provider = normalizeProvider(turn.provider);
    requiredIdentifier(turn.id, 'Project Chat turn');
    requiredIdentifier(turn.actorUserId, 'Project Chat turn actor');
    requiredIdentifier(turn.requestId, 'Project Chat turn request');
    if (!(turn.leaseExpiresAt instanceof Date) || !Number.isFinite(turn.leaseExpiresAt.getTime())) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'A Project Chat turn has an invalid lease expiry',
        provider,
      );
    }
    return Object.freeze({ ...turn, provider });
  });
  const turnsById = new Map(activeTurns.map((turn) => [turn.id, turn]));
  const statesById = new Map(states.map((state) => [state.id, state]));
  for (const state of states) {
    if (!state.activeTurnId) continue;
    const activeTurn = turnsById.get(state.activeTurnId);
    if (
      !activeTurn
      || activeTurn.stateId !== state.id
      || activeTurn.actorUserId !== state.actorUserId
    ) {
      throw new ProjectRuntimeCleanupError(
        'TURN_STILL_ACTIVE',
        'Project Chat durable state contains an unresolvable active turn',
      );
    }
  }
  for (const activeTurn of activeTurns) {
    const state = statesById.get(activeTurn.stateId);
    if (
      !state
      || state.actorUserId !== activeTurn.actorUserId
      || state.activeTurnId !== activeTurn.id
    ) {
      throw new ProjectRuntimeCleanupError(
        'TURN_STILL_ACTIVE',
        'Project Chat durable turn is detached from its coordination state',
        activeTurn.provider,
      );
    }
  }
  return Object.freeze({ bindings, sessions, states, activeTurns });
}

function buildScope(
  identity: ReturnType<typeof validateIdentity>,
  snapshot: ProjectRuntimeCleanupSnapshot,
  cleanupEvidence: readonly ProjectRuntimeCleanupSessionEvidence[] = [],
): ProjectRuntimeCleanupScope {
  // The immutable ProjectIdentity owner is authoritative even when a
  // SUB_ADMIN initiated deletion and qualification crashed before a binding
  // row was written. Provider cleanup can therefore derive and remove the
  // owner's server-generated OpenClaw agent/session identities without
  // guessing from a mutable project name or writable project files.
  const actors = new Set<string>([
    identity.authenticatedActorId,
    identity.workspaceOwnerId,
    ...identity.candidateActorIds,
    ...cleanupEvidence.map((entry) => entry.actorUserId),
  ]);
  for (const binding of snapshot.bindings) actors.add(binding.userId);
  for (const session of snapshot.sessions) actors.add(session.userId);
  for (const state of snapshot.states) actors.add(state.actorUserId);
  for (const turn of snapshot.activeTurns) actors.add(turn.actorUserId);
  return Object.freeze({
    ...identity,
    knownActorIds: Object.freeze([...actors].sort()),
    cleanupSessionEvidence: Object.freeze(cleanupEvidence.map((entry) => Object.freeze({ ...entry }))),
    bindings: Object.freeze([...snapshot.bindings]),
    sessions: Object.freeze([...snapshot.sessions]),
    activeTurns: Object.freeze([...snapshot.activeTurns]),
  });
}

function validateResources(input: {
  resources: readonly ProjectRuntimeResource[];
  projectIdentityId: string;
  provider: ProjectRuntimeCleanupProvider | 'EGRESS';
}): readonly ProjectRuntimeResource[] {
  if (!Array.isArray(input.resources)) {
    throw new ProjectRuntimeCleanupError(
      'RESOURCE_IDENTITY_MISMATCH',
      'Project runtime discovery returned an invalid resource list',
      input.provider,
    );
  }
  const seen = new Set<string>();
  return Object.freeze(input.resources.map((resource) => {
    const id = requiredIdentifier(resource?.id, 'external runtime resource');
    if (resource.projectIdentityId !== input.projectIdentityId) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'External runtime resource did not match the immutable project identity',
        input.provider,
      );
    }
    if (input.provider === 'EGRESS') {
      if (!EGRESS_RESOURCE_KINDS.has(resource.kind)) {
        throw new ProjectRuntimeCleanupError(
          'RESOURCE_IDENTITY_MISMATCH',
          'Project egress discovery returned a non-egress resource',
          'EGRESS',
        );
      }
      if (resource.provider !== null) normalizeProvider(resource.provider);
    } else {
      const allowedKinds = input.provider === 'OPENCLAW'
        ? OPENCLAW_RESOURCE_KINDS
        : input.provider === 'AGENT_ZERO'
          ? AGENT_ZERO_RESOURCE_KINDS
          : NATIVE_RESOURCE_KINDS;
      if (!allowedKinds.has(resource.kind) || resource.provider !== input.provider) {
        throw new ProjectRuntimeCleanupError(
          'RESOURCE_IDENTITY_MISMATCH',
          'Provider discovery returned a resource owned by another cleanup adapter',
          input.provider,
        );
      }
    }
    if (resource.actorUserId !== null) requiredIdentifier(resource.actorUserId, 'external resource actor');
    const duplicateKey = `${resource.kind}\u0000${id}`;
    if (seen.has(duplicateKey)) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'Project runtime discovery returned a duplicate resource identity',
        input.provider,
      );
    }
    seen.add(duplicateKey);
    return Object.freeze({ ...resource, id });
  }));
}

function cleanupError(
  code: ProjectRuntimeCleanupErrorCode,
  provider: ProjectRuntimeCleanupProvider | 'EGRESS',
  action: string,
): ProjectRuntimeCleanupError {
  return new ProjectRuntimeCleanupError(code, `${provider} Project runtime ${action} failed`, provider);
}

async function enumerateProvider(
  adapter: ProjectRuntimeCleanupAdapter,
  scope: ProjectRuntimeCleanupScope,
): Promise<readonly ProjectRuntimeResource[]> {
  try {
    return validateResources({
      resources: await adapter.enumerate(scope),
      projectIdentityId: scope.projectIdentity.id,
      provider: adapter.provider,
    });
  } catch (error) {
    if (error instanceof ProjectRuntimeCleanupError) throw error;
    throw cleanupError('ENUMERATION_FAILED', adapter.provider, 'enumeration');
  }
}

async function enumerateEgress(
  adapter: ProjectEgressCleanupAdapter,
  scope: ProjectRuntimeCleanupScope,
): Promise<readonly ProjectRuntimeResource[]> {
  try {
    return validateResources({
      resources: await adapter.enumerate(scope),
      projectIdentityId: scope.projectIdentity.id,
      provider: 'EGRESS',
    });
  } catch (error) {
    if (error instanceof ProjectRuntimeCleanupError) throw error;
    throw cleanupError('ENUMERATION_FAILED', 'EGRESS', 'enumeration');
  }
}

async function verifyProviderClean(
  adapter: ProjectRuntimeCleanupAdapter,
  scope: ProjectRuntimeCleanupScope,
): Promise<void> {
  let residual: readonly ProjectRuntimeResource[];
  try {
    residual = validateResources({
      resources: await adapter.verifyClean(scope),
      projectIdentityId: scope.projectIdentity.id,
      provider: adapter.provider,
    });
  } catch (error) {
    if (error instanceof ProjectRuntimeCleanupError) throw error;
    throw cleanupError('CLEANUP_FAILED', adapter.provider, 'verification');
  }
  if (residual.length > 0) {
    throw new ProjectRuntimeCleanupError(
      'RESIDUAL_RESOURCE',
      `${adapter.provider} still owns ${residual.length} resource(s) for this project`,
      adapter.provider,
    );
  }
}

async function verifyEgressClean(
  adapter: ProjectEgressCleanupAdapter,
  scope: ProjectRuntimeCleanupScope,
): Promise<void> {
  let residual: readonly ProjectRuntimeResource[];
  try {
    residual = validateResources({
      resources: await adapter.verifyClean(scope),
      projectIdentityId: scope.projectIdentity.id,
      provider: 'EGRESS',
    });
  } catch (error) {
    if (error instanceof ProjectRuntimeCleanupError) throw error;
    throw cleanupError('CLEANUP_FAILED', 'EGRESS', 'verification');
  }
  if (residual.length > 0) {
    throw new ProjectRuntimeCleanupError(
      'RESIDUAL_RESOURCE',
      `Project egress still owns ${residual.length} resource(s) for this project`,
      'EGRESS',
    );
  }
}

const defaultRepository: ProjectRuntimeCleanupRepository = {
  async loadSnapshot(projectIdentityId) {
    const [bindings, sessions, states, activeTurns] = await Promise.all([
      prisma.projectChatProviderBinding.findMany({ where: { projectId: projectIdentityId } }),
      prisma.projectChatSession.findMany({ where: { projectId: projectIdentityId } }),
      prisma.projectChatState.findMany({ where: { projectIdentityId } }),
      prisma.projectChatTurn.findMany({
        where: {
          projectIdentityId,
          status: { in: [ProjectChatTurnStatus.RUNNING, ProjectChatTurnStatus.ABORTING] },
        },
      }),
    ]);
    return {
      bindings: bindings as unknown as ProjectRuntimeCleanupBinding[],
      sessions: sessions as unknown as ProjectRuntimeCleanupSession[],
      states: states as unknown as ProjectRuntimeCleanupState[],
      activeTurns: activeTurns as unknown as ProjectRuntimeCleanupTurn[],
    };
  },

  async loadCleanupEvidence(projectIdentityId) {
    const rows = await prisma.projectRuntimeCleanupActor.findMany({
      where: { projectIdentityId },
      select: { provider: true, actorUserId: true, sessionId: true },
    });
    return Object.freeze(rows.map((row) => Object.freeze({
      provider: normalizeProvider(row.provider),
      actorUserId: requiredIdentifier(row.actorUserId, 'cleanup journal actor'),
      sessionId: String(row.sessionId || ''),
    })).sort((left, right) => (
      `${left.provider}\0${left.actorUserId}\0${left.sessionId}`
        .localeCompare(`${right.provider}\0${right.actorUserId}\0${right.sessionId}`)
    )));
  },

  async recordCleanupActors(projectIdentityId, resources) {
    const evidence = new Map<string, {
      provider: ProjectRuntimeCleanupProvider;
      actorUserId: string;
      sessionId: string;
    }>();
    for (const resource of resources) {
      if (!resource.provider || !resource.actorUserId) continue;
      const provider = normalizeProvider(resource.provider);
      const actorUserId = requiredIdentifier(resource.actorUserId, 'cleanup resource actor');
      evidence.set(`${provider}\0${actorUserId}\0`, { provider, actorUserId, sessionId: '' });
      const sessionId = resource.kind === 'AGENT_ZERO_SESSION'
        ? resource.id.slice('agent-zero-session:'.length)
        : resource.kind === 'NATIVE_SESSION'
          ? resource.id.slice('native-session:'.length)
          : '';
      if (sessionId) {
        evidence.set(`${provider}\0${actorUserId}\0${sessionId}`, {
          provider,
          actorUserId,
          sessionId: requiredIdentifier(sessionId, 'cleanup resource session'),
        });
      }
    }
    if (evidence.size === 0) return;
    await prisma.projectRuntimeCleanupActor.createMany({
      data: Array.from(evidence.values()).map((entry) => ({ projectIdentityId, ...entry })),
      skipDuplicates: true,
    });
  },

  async clearCleanupActors(projectIdentityId) {
    await prisma.projectRuntimeCleanupActor.deleteMany({ where: { projectIdentityId } });
  },

  async markBindingsCleanupPending(projectIdentityId, bindingIds) {
    if (bindingIds.length === 0) return;
    const updated = await prisma.projectChatProviderBinding.updateMany({
      where: { projectId: projectIdentityId, id: { in: [...bindingIds] } },
      data: { status: CLEANUP_PENDING_STATUS, lastActivity: new Date() },
    });
    if (updated.count !== new Set(bindingIds).size) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'Project bindings changed while cleanup was starting',
      );
    }
  },

  async beginTurnAbort(turn) {
    if (turn.status === ProjectChatTurnStatus.RUNNING) {
      const updated = await prisma.projectChatTurn.updateMany({
        where: {
          id: turn.id,
          actorUserId: turn.actorUserId,
          projectIdentityId: turn.projectIdentityId,
          status: ProjectChatTurnStatus.RUNNING,
        },
        data: { status: ProjectChatTurnStatus.ABORTING },
      });
      if (updated.count !== 1) {
        const raced = await prisma.projectChatTurn.findUnique({ where: { id: turn.id } });
        if (!raced || raced.status !== ProjectChatTurnStatus.ABORTING) {
          throw new ProjectRuntimeCleanupError('TURN_ABORT_FAILED', 'Project turn changed before abort');
        }
      }
    }
    const current = await prisma.projectChatTurn.findUnique({ where: { id: turn.id } });
    if (
      !current
      || current.actorUserId !== turn.actorUserId
      || current.projectIdentityId !== turn.projectIdentityId
      || current.status !== ProjectChatTurnStatus.ABORTING
    ) {
      throw new ProjectRuntimeCleanupError('TURN_ABORT_FAILED', 'Project turn could not enter aborting state');
    }
    return current as unknown as ProjectRuntimeCleanupTurn;
  },

  async finishTurnAbort(turn, evidence, lifecycleReason) {
    const sanitizedEvidence = requiredIdentifier(evidence, 'turn quiescence evidence');
    await prisma.$transaction(async (transaction) => {
      const finalized = await transaction.projectChatTurn.updateMany({
        where: {
          id: turn.id,
          actorUserId: turn.actorUserId,
          projectIdentityId: turn.projectIdentityId,
          status: ProjectChatTurnStatus.ABORTING,
        },
        data: {
          status: ProjectChatTurnStatus.ABORTED,
          activeProjectKey: null,
          completedAt: new Date(),
          errorCode: lifecycleReason === 'rename'
            ? 'PROJECT_RENAMED'
            : lifecycleReason === 'authorization_change'
              ? 'PROJECT_AUTHORIZATION_CHANGED'
              : 'PROJECT_DELETED',
          errorMessage: lifecycleReason === 'rename'
            ? `Project runtime quiesced before rename (${sanitizedEvidence.slice(0, 384)})`
            : lifecycleReason === 'authorization_change'
              ? `Project runtime quiesced before authorization change (${sanitizedEvidence.slice(0, 384)})`
              : `Project runtime quiesced before deletion (${sanitizedEvidence.slice(0, 384)})`,
        },
      });
      if (finalized.count !== 1) {
        const current = await transaction.projectChatTurn.findUnique({ where: { id: turn.id } });
        if (current?.status !== ProjectChatTurnStatus.ABORTED) {
          throw new ProjectRuntimeCleanupError('TURN_ABORT_FAILED', 'Project turn could not be finalized as aborted');
        }
      }
      await transaction.projectChatState.updateMany({
        where: {
          actorUserId: turn.actorUserId,
          projectIdentityId: turn.projectIdentityId,
          activeTurnId: turn.id,
        },
        data: { activeTurnId: null, version: { increment: 1 } },
      });
    });
  },

  async markBindingsCleanupComplete(projectIdentityId, bindingIds) {
    if (bindingIds.length === 0) return;
    const updated = await prisma.projectChatProviderBinding.updateMany({
      where: {
        projectId: projectIdentityId,
        id: { in: [...bindingIds] },
        status: CLEANUP_PENDING_STATUS,
      },
      data: { status: CLEANUP_COMPLETE_STATUS, lastActivity: new Date() },
    });
    if (updated.count !== new Set(bindingIds).size) {
      throw new ProjectRuntimeCleanupError(
        'RESOURCE_IDENTITY_MISMATCH',
        'Project bindings changed before cleanup completion could be recorded',
      );
    }
  },
};

const cleanupLocks = new Map<string, Promise<void>>();

async function withProjectCleanupLock<T>(projectIdentityId: string, operation: () => Promise<T>): Promise<T> {
  const prior = cleanupLocks.get(projectIdentityId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.catch(() => undefined).then(() => current);
  cleanupLocks.set(projectIdentityId, queued);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (cleanupLocks.get(projectIdentityId) === queued) cleanupLocks.delete(projectIdentityId);
  }
}

async function runProjectRuntimeCleanup(
  input: ProjectRuntimeCleanupInput,
  options: ProjectRuntimeCleanupOptions,
): Promise<ProjectRuntimeCleanupResult> {
  const identity = validateIdentity(input);
  const lifecycleReason = input.lifecycleReason || 'delete';
  assertCompleteAdapterRegistry(options.adapters);
  assertEgressAdapter(options.egressAdapter);
  const repository = options.repository || defaultRepository;

  const initial = immutableSnapshot(
    await repository.loadSnapshot(identity.projectIdentity.id),
    identity.projectIdentity.id,
  );
  let cleanupEvidence = await repository.loadCleanupEvidence(identity.projectIdentity.id);
  let scope = buildScope(identity, initial, cleanupEvidence);

  const liveRuntimeAdmission = initial.activeTurns.find((turn) => (
    isProjectChatRuntimeAdmissionTurn(turn)
    && turn.leaseExpiresAt.getTime() > Date.now()
  ));
  if (liveRuntimeAdmission) {
    // Self-clearing: the lease lapses on its own, so report when, and let the
    // caller present this as "try again shortly" rather than a hard failure.
    throw new ProjectRuntimeCleanupError(
      'TURN_STILL_ACTIVE',
      'Project deletion was rejected while a leased runtime admission is still mutating provider state',
      liveRuntimeAdmission.provider,
      projectRuntimeLeaseRetryAfterMs(liveRuntimeAdmission.leaseExpiresAt),
    );
  }

  // Preflight every provider, even without a Portal binding. Managed runtime
  // resources can outlive a failed DB write and must be found by UUID labels.
  const initialProviderResources = new Map<ProjectRuntimeCleanupProvider, readonly ProjectRuntimeResource[]>();
  for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
    initialProviderResources.set(provider, await enumerateProvider(options.adapters[provider], scope));
  }
  const initialEgressResources = await enumerateEgress(options.egressAdapter, scope);
  await repository.recordCleanupActors(
    identity.projectIdentity.id,
    Array.from(initialProviderResources.values()).flat(),
  );
  cleanupEvidence = await repository.loadCleanupEvidence(identity.projectIdentity.id);
  scope = buildScope(identity, initial, cleanupEvidence);

  const bindingIds = initial.bindings.map((binding) => binding.id);
  await repository.markBindingsCleanupPending(identity.projectIdentity.id, bindingIds);

  let quiescedTurnCount = 0;
  for (const turn of initial.activeTurns) {
    const adapter = options.adapters[turn.provider];
    let aborting: ProjectRuntimeCleanupTurn;
    try {
      aborting = await repository.beginTurnAbort(turn);
      const proof = await adapter.quiesceTurn(scope, aborting);
      if (!proof || proof.quiesced !== true) {
        throw new Error('Provider did not prove turn quiescence');
      }
      const evidence = requiredIdentifier(proof.evidence, 'turn quiescence evidence');
      await repository.finishTurnAbort(aborting, evidence, lifecycleReason);
      quiescedTurnCount += 1;
    } catch {
      throw new ProjectRuntimeCleanupError(
        'TURN_ABORT_FAILED',
        `${turn.provider} could not prove that Project turn ${turn.id} stopped`,
        turn.provider,
      );
    }
  }

  const afterQuiesce = immutableSnapshot(
    await repository.loadSnapshot(identity.projectIdentity.id),
    identity.projectIdentity.id,
  );
  if (afterQuiesce.activeTurns.length > 0) {
    throw new ProjectRuntimeCleanupError(
      'TURN_STILL_ACTIVE',
      'Project deletion was rejected because a durable turn is still active',
    );
  }
  scope = buildScope(identity, afterQuiesce, cleanupEvidence);

  // Re-enumerate after abort: providers may materialize a session/container as
  // part of the abort handshake. Only this fresh set is passed to cleanup.
  const freshProviderResources = new Map<ProjectRuntimeCleanupProvider, readonly ProjectRuntimeResource[]>();
  for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
    freshProviderResources.set(provider, await enumerateProvider(options.adapters[provider], scope));
  }
  const freshEgressResources = await enumerateEgress(options.egressAdapter, scope);
  await repository.recordCleanupActors(
    identity.projectIdentity.id,
    Array.from(freshProviderResources.values()).flat(),
  );
  cleanupEvidence = await repository.loadCleanupEvidence(identity.projectIdentity.id);
  scope = buildScope(identity, afterQuiesce, cleanupEvidence);

  for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
    const adapter = options.adapters[provider];
    try {
      await adapter.cleanup(scope, freshProviderResources.get(provider) || []);
      await verifyProviderClean(adapter, scope);
    } catch (error) {
      if (error instanceof ProjectRuntimeCleanupError) throw error;
      throw cleanupError('CLEANUP_FAILED', provider, 'cleanup');
    }
  }

  try {
    await options.egressAdapter.cleanup(scope, freshEgressResources);
    await verifyEgressClean(options.egressAdapter, scope);
  } catch (error) {
    if (error instanceof ProjectRuntimeCleanupError) throw error;
    throw cleanupError('CLEANUP_FAILED', 'EGRESS', 'cleanup');
  }

  const finalSnapshot = immutableSnapshot(
    await repository.loadSnapshot(identity.projectIdentity.id),
    identity.projectIdentity.id,
  );
  if (finalSnapshot.activeTurns.length > 0) {
    throw new ProjectRuntimeCleanupError(
      'TURN_STILL_ACTIVE',
      'Project deletion was rejected because a durable turn started during cleanup',
    );
  }
  const initialBindingIds = new Set(initial.bindings.map((binding) => binding.id));
  const initialSessionIds = new Set(initial.sessions.map((session) => session.id));
  const initialStateIds = new Set(initial.states.map((state) => state.id));
  if (
    finalSnapshot.bindings.some((binding) => !initialBindingIds.has(binding.id))
    || finalSnapshot.sessions.some((session) => !initialSessionIds.has(session.id))
    || finalSnapshot.states.some((state) => !initialStateIds.has(state.id))
  ) {
    throw new ProjectRuntimeCleanupError(
      'TURN_STILL_ACTIVE',
      'Project deletion was rejected because new Project Chat state appeared during cleanup',
    );
  }
  // Verification is intentionally repeated after the final durable-state read.
  // A provider cannot win a race by materializing state between cleanup and the
  // database barrier check.
  for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
    await verifyProviderClean(options.adapters[provider], scope);
  }
  await verifyEgressClean(options.egressAdapter, scope);
  await repository.markBindingsCleanupComplete(identity.projectIdentity.id, bindingIds);
  await repository.clearCleanupActors(identity.projectIdentity.id);

  const initialResourceCount = [...initialProviderResources.values()]
    .reduce((total, resources) => total + resources.length, initialEgressResources.length);
  const removedResourceCount = [...freshProviderResources.values()]
    .reduce((total, resources) => total + resources.length, freshEgressResources.length);
  return {
    projectIdentityId: identity.projectIdentity.id,
    actorCount: scope.knownActorIds.length,
    bindingCount: initial.bindings.length,
    sessionCount: initial.sessions.length,
    quiescedTurnCount,
    removedResourceCount,
    alreadyClean: initialResourceCount === 0
      && initial.activeTurns.length === 0
      && initial.bindings.every((binding) => binding.status === CLEANUP_COMPLETE_STATUS),
  };
}

/**
 * Quiesce and remove every provider-owned resource for one immutable project.
 * Calls for the same UUID are serialized in-process; durable turn state and
 * idempotent adapter verification make a retry safe after process restart.
 * The deletion route must first close new Project Chat admission (normally by
 * quarantining the attested root); the repeated state/resource checks here are
 * the second line of defense, not a substitute for an admission barrier.
 */
export async function cleanupProjectRuntime(
  input: ProjectRuntimeCleanupInput,
  options: ProjectRuntimeCleanupOptions,
): Promise<ProjectRuntimeCleanupResult> {
  const projectIdentityId = requiredIdentifier(input.projectIdentity?.id, 'project identity');
  return withProjectCleanupLock(projectIdentityId, () => runProjectRuntimeCleanup(input, options));
}

/**
 * Explicit fail-closed adapter for providers whose real deletion APIs are not
 * wired yet. It makes integration gaps visible instead of reporting success.
 */
export function unavailableProjectRuntimeCleanupAdapter(
  provider: ProjectRuntimeCleanupProvider,
  reason = 'provider cleanup API is not implemented',
): ProjectRuntimeCleanupAdapter {
  const unavailable = async (): Promise<never> => {
    throw new Error(`${provider}: ${reason}`);
  };
  return {
    provider,
    enumerate: unavailable,
    quiesceTurn: unavailable,
    cleanup: unavailable,
    verifyClean: unavailable,
  };
}

export const __projectRuntimeCleanupTest = {
  CLEANUP_PENDING_STATUS,
  CLEANUP_COMPLETE_STATUS,
  resetLocks(): void {
    cleanupLocks.clear();
  },
};
