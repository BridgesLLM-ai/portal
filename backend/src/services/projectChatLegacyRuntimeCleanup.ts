import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import {
  deleteSession,
  gatewayRpcCall,
  getSessionInfo,
} from '../utils/openclawGatewayRpc';
import { attestLegacyOpenClawProjectSessionKeys } from './projectChatLegacyMigration';
import { LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE } from './legacyOpenClawRetirementPolicy';
import {
  assertLegacyOpenClawProjectMigrationInactive,
  assertNoLegacyOpenClawProjectEvidence,
} from './legacyOpenClawProjectRetirement';

const LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED = false as const;

interface LegacyOpenClawBindingReference {
  id: string;
  projectId: string;
  sessionKey: string | null;
  externalSessionId: string | null;
}

interface LegacyOpenClawSessionReference {
  id: string;
  projectId: string;
  sessionKey: string;
  activeProvider: string;
}

export interface LegacyOpenClawRuntimeCleanupDatabase {
  projectChatProviderBinding: {
    findMany(args: unknown): Promise<LegacyOpenClawBindingReference[]>;
  };
  projectChatSession: {
    findMany(args: unknown): Promise<LegacyOpenClawSessionReference[]>;
  };
}

export interface LegacyOpenClawRuntimeCleanupDependencies {
  database: LegacyOpenClawRuntimeCleanupDatabase;
  abort(sessionKey: string): Promise<{ ok: boolean; error?: unknown }>;
  delete(
    sessionKey: string,
    options?: { deleteTranscript: boolean },
  ): Promise<{ ok: boolean; error?: unknown }>;
  inspect(sessionKey: string): Promise<{ ok: boolean; error?: unknown }>;
  deleteAgent(
    agentId: string,
    options?: { deleteFiles: boolean },
  ): Promise<{ ok: boolean; error?: unknown }>;
  inspectAgents(): Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  listAgentSessions(input: {
    agentId: string;
    archived: boolean;
    offset: number;
    limit: number;
  }): Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  attestAgentWorkspace(agentId: string, openClawHome: string): void;
}

function attestLegacyAgentWorkspace(agentId: string, openClawHome: string): void {
  if (agentId.length > 64 || !LEGACY_AGENT_ID_PATTERN.test(agentId)) {
    throw new Error('Legacy OpenClaw Project agent workspace identity was invalid');
  }
  const sandboxesRoot = path.join(openClawHome, 'sandboxes');
  const workspace = path.join(sandboxesRoot, `${agentId}-workspace`);
  for (const [candidate, label] of [
    [openClawHome, 'OpenClaw home'],
    [sandboxesRoot, 'OpenClaw sandbox root'],
    [workspace, 'legacy agent workspace'],
  ] as const) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      throw new Error(`${label} could not be authoritatively inspected`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} was not an exact directory`);
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(candidate);
    } catch {
      throw new Error(`${label} could not be authoritatively resolved`);
    }
    if (canonical !== candidate) {
      throw new Error(`${label} resolved through an unexpected filesystem path`);
    }
  }
}

const defaultDependencies: LegacyOpenClawRuntimeCleanupDependencies = {
  database: prisma as unknown as LegacyOpenClawRuntimeCleanupDatabase,
  abort: async (sessionKey) => gatewayRpcCall('chat.abort', { sessionKey }, 15_000),
  delete: async (sessionKey, options) => (
    options?.deleteTranscript === false
      ? gatewayRpcCall('sessions.delete', { key: sessionKey, deleteTranscript: false }, 15_000)
      : deleteSession(sessionKey)
  ),
  inspect: getSessionInfo,
  deleteAgent: async (agentId, options) => gatewayRpcCall(
    'agents.delete',
    { agentId, deleteFiles: options?.deleteFiles !== false },
    20_000,
  ),
  inspectAgents: async () => gatewayRpcCall('config.get', {}, 15_000),
  listAgentSessions: async (input) => gatewayRpcCall('sessions.list', {
    agentId: input.agentId,
    archived: input.archived,
    includeGlobal: false,
    includeUnknown: true,
    offset: input.offset,
    limit: input.limit,
  }, 15_000),
  attestAgentWorkspace: attestLegacyAgentWorkspace,
};

const LEGACY_AGENT_ID_PATTERN = /^portal-[a-f0-9]{8}-[a-z0-9][a-z0-9_-]*$/;
const LEGACY_SANDBOX_IMAGE = 'openclaw-sandbox:bookworm-slim';
const MAX_LEGACY_AGENTS_PER_PROJECT = 128;
const MAX_SESSION_ROWS_PER_AGENT = 2_000;
const SESSION_PAGE_SIZE = 200;

interface AttestedLegacyAgent {
  agentId: string;
  signature: string;
}

interface AttestedLegacySession {
  agentId: string;
  sessionKey: string;
  portalFallbackSessionKey: string;
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const normalized = requiredIdentifier(value, label);
  if (!path.isAbsolute(normalized) || path.resolve(normalized) !== normalized) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function configAgents(result: { ok: boolean; data?: unknown; error?: unknown }): Record<string, any>[] {
  if (!result.ok) throw new Error('Legacy OpenClaw Project agents could not be inspected');
  const data = isRecord(result.data) ? result.data : {};
  const config = isRecord(data.config)
    ? data.config
    : isRecord(data.parsed)
      ? data.parsed
      : null;
  if (!config) throw new Error('Legacy OpenClaw Project agent inspection returned an invalid shape');
  const agents = isRecord(config.agents) ? config.agents.list : undefined;
  if (agents === undefined) return [];
  if (!Array.isArray(agents) || agents.length > 2_048 || agents.some((entry) => !isRecord(entry))) {
    throw new Error('Legacy OpenClaw Project agent inspection returned an invalid shape');
  }
  return agents;
}

function attestLegacyAgentEntry(input: {
  agentId: string;
  entry: Record<string, any>;
  targetCanonicalRoot: string;
  openClawHome: string;
}): AttestedLegacyAgent {
  if (
    input.agentId.length > 64
    || !LEGACY_AGENT_ID_PATTERN.test(input.agentId)
    || input.entry.id !== input.agentId
  ) {
    throw new Error('Legacy OpenClaw Project agent identity was not exact');
  }
  const expectedWorkspace = path.join(
    input.openClawHome,
    'sandboxes',
    `${input.agentId}-workspace`,
  );
  const sandbox = isRecord(input.entry.sandbox) ? input.entry.sandbox : {};
  const docker = isRecord(sandbox.docker) ? sandbox.docker : {};
  const binds = Array.isArray(docker.binds) ? docker.binds : [];
  const expectedWorkBind = `${input.targetCanonicalRoot}:/home/user/project:rw`;
  const expectedWorkspaceBind = `${input.targetCanonicalRoot}:/workspace/project:rw`;
  const legacyWork = binds.length === 1
    && binds[0] === expectedWorkBind
    && sandbox.workspaceAccess === 'none'
    && docker.workdir === '/work'
    && docker.dangerouslyAllowReservedContainerTargets !== true;
  const legacyWorkspace = binds.length === 1
    && binds[0] === expectedWorkspaceBind
    && sandbox.workspaceAccess === 'rw'
    && docker.workdir === '/workspace'
    && docker.dangerouslyAllowReservedContainerTargets === true;
  if (
    input.entry.workspace !== expectedWorkspace
    || sandbox.mode !== 'all'
    || sandbox.scope !== 'session'
    || (sandbox.backend !== undefined && sandbox.backend !== 'docker')
    || docker.image !== LEGACY_SANDBOX_IMAGE
    || docker.network !== 'bridge'
    || docker.dangerouslyAllowExternalBindSources !== true
    || (!legacyWork && !legacyWorkspace)
  ) {
    throw new Error('Legacy OpenClaw Project agent did not match the exact target workspace and bind');
  }
  return Object.freeze({
    agentId: input.agentId,
    signature: JSON.stringify({
      workspace: input.entry.workspace,
      sandbox: {
        mode: sandbox.mode,
        scope: sandbox.scope,
        backend: sandbox.backend,
        workspaceAccess: sandbox.workspaceAccess,
        docker: {
          image: docker.image,
          network: docker.network,
          workdir: docker.workdir,
          dangerouslyAllowExternalBindSources: docker.dangerouslyAllowExternalBindSources,
          dangerouslyAllowReservedContainerTargets: docker.dangerouslyAllowReservedContainerTargets,
          binds,
        },
      },
    }),
  });
}

function entryClaimsTargetRoot(entry: Record<string, any>, targetCanonicalRoot: string): boolean {
  const sandbox = isRecord(entry.sandbox) ? entry.sandbox : {};
  const docker = isRecord(sandbox.docker) ? sandbox.docker : {};
  const binds = Array.isArray(docker.binds) ? docker.binds : [];
  return binds.some((bind) => (
    typeof bind === 'string' && bind.startsWith(`${targetCanonicalRoot}:`)
  ));
}

class LegacySessionActorMismatchError extends Error {}

async function inspectAttestedLegacyAgents(input: {
  actorUserId: string;
  knownAgentIds: readonly string[];
  targetCanonicalRoot: string;
  openClawHome: string;
  inspectAgents(): Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  listAgentSessions(input: {
    agentId: string;
    archived: boolean;
    offset: number;
    limit: number;
  }): Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  attestAgentWorkspace(agentId: string, openClawHome: string): void;
  retireRootAttestedConfigOnlyAgents: boolean;
}): Promise<Map<string, AttestedLegacyAgent>> {
  const agents = configAgents(await input.inspectAgents());
  const attested = new Map<string, AttestedLegacyAgent>();
  const candidateAgentIds = new Set(input.knownAgentIds);
  const actorAgentPrefix = `portal-${input.actorUserId.slice(0, 8)}-`;
  for (const entry of agents) {
    const agentId = typeof entry.id === 'string' ? entry.id : '';
    if (
      agentId.startsWith(actorAgentPrefix)
      && entryClaimsTargetRoot(entry, input.targetCanonicalRoot)
    ) {
      // The legacy agent id contains only an eight-character actor prefix.
      // A root match alone cannot distinguish two actors with that prefix.
      // Actor-scoped Clear preserves config-only candidates unless a bounded
      // session proves the full actor identity. Project-wide rename/delete may
      // retire an exact root-attested config orphan under its lifecycle lock.
      if (input.retireRootAttestedConfigOnlyAgents) {
        candidateAgentIds.add(agentId);
        continue;
      }
      try {
        const listed = await listAttestedLegacySessionsForAgent({
          actorUserId: input.actorUserId,
          agentId,
          listAgentSessions: input.listAgentSessions,
        });
        if (listed.length > 0) candidateAgentIds.add(agentId);
      } catch (error) {
        if (!(error instanceof LegacySessionActorMismatchError)) throw error;
        // Same-eight-character-prefix ownership remains ambiguous for Clear.
      }
    }
  }
  if (candidateAgentIds.size > MAX_LEGACY_AGENTS_PER_PROJECT) {
    throw new Error('Legacy OpenClaw Project agent count exceeded the cleanup safety limit');
  }
  for (const agentId of candidateAgentIds) {
    const matches = agents.filter((entry) => entry.id === agentId);
    if (matches.length > 1) {
      throw new Error('Legacy OpenClaw Project agent identity was duplicated');
    }
    if (matches.length === 0) continue;
    input.attestAgentWorkspace(agentId, input.openClawHome);
    attested.set(agentId, attestLegacyAgentEntry({
      agentId,
      entry: matches[0],
      targetCanonicalRoot: input.targetCanonicalRoot,
      openClawHome: input.openClawHome,
    }));
  }
  return attested;
}

function deriveLegacySessionIdentity(input: {
  actorUserId: string;
  agentId: string;
}): AttestedLegacySession {
  const agentPrefix = `portal-${input.actorUserId.slice(0, 8)}-`;
  if (!input.agentId.startsWith(agentPrefix)) {
    throw new Error('Legacy OpenClaw Project agent did not match its authenticated actor');
  }
  const stableSlug = input.agentId.slice(agentPrefix.length);
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(stableSlug)) {
    throw new Error('Legacy OpenClaw Project agent stable slug was invalid');
  }
  const sessionId = `portal-${input.actorUserId}-${stableSlug}`;
  return Object.freeze({
    agentId: input.agentId,
    sessionKey: `agent:${input.agentId}:${sessionId}`,
    portalFallbackSessionKey: `agent:portal:${sessionId}`,
  });
}

function attestListedLegacySession(input: {
  actorUserId: string;
  agentId: string;
  row: Record<string, any>;
}): AttestedLegacySession {
  const sessionKey = requiredIdentifier(input.row.key, 'Legacy OpenClaw Project session key');
  const prefix = `agent:${input.agentId}:`;
  if (!sessionKey.startsWith(prefix)) {
    throw new Error('Legacy OpenClaw Project session listing crossed its exact agent boundary');
  }
  const sessionId = sessionKey.slice(prefix.length);
  const actorPrefix = `portal-${input.actorUserId}-`;
  if (!sessionId.startsWith(actorPrefix)) {
    throw new LegacySessionActorMismatchError(
      'Legacy OpenClaw Project session did not match its authenticated actor',
    );
  }
  const stableSlug = sessionId.slice(actorPrefix.length);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stableSlug)) {
    throw new Error('Legacy OpenClaw Project session stable slug was invalid');
  }
  return Object.freeze({
    agentId: input.agentId,
    sessionKey,
    portalFallbackSessionKey: `agent:portal:${sessionId}`,
  });
}

async function listAttestedLegacySessionsForAgent(input: {
  actorUserId: string;
  agentId: string;
  listAgentSessions: LegacyOpenClawRuntimeCleanupDependencies['listAgentSessions'];
}): Promise<readonly AttestedLegacySession[]> {
  const found = new Map<string, AttestedLegacySession>();
  let totalRows = 0;
  for (const archived of [false, true]) {
    let offset = 0;
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > Math.ceil(MAX_SESSION_ROWS_PER_AGENT / SESSION_PAGE_SIZE) + 1) {
        throw new Error('Legacy OpenClaw Project session pagination exceeded its safety limit');
      }
      const response = await input.listAgentSessions({
        agentId: input.agentId,
        archived,
        offset,
        limit: SESSION_PAGE_SIZE,
      });
      if (!response.ok || !isRecord(response.data) || !Array.isArray(response.data.sessions)) {
        throw new Error('Legacy OpenClaw Project sessions could not be authoritatively enumerated');
      }
      const rows = response.data.sessions;
      if (rows.length > SESSION_PAGE_SIZE || rows.some((row) => !isRecord(row))) {
        throw new Error('Legacy OpenClaw Project session listing returned an invalid shape');
      }
      totalRows += rows.length;
      if (totalRows > MAX_SESSION_ROWS_PER_AGENT) {
        throw new Error('Legacy OpenClaw Project session count exceeded its safety limit');
      }
      for (const row of rows) {
        const session = attestListedLegacySession({
          actorUserId: input.actorUserId,
          agentId: input.agentId,
          row,
        });
        if (found.has(session.sessionKey)) {
          throw new Error('Legacy OpenClaw Project session listing returned a duplicate identity');
        }
        found.set(session.sessionKey, session);
      }
      if (response.data.hasMore === false || response.data.hasMore === undefined) break;
      if (response.data.hasMore !== true) {
        throw new Error('Legacy OpenClaw Project session listing returned invalid pagination');
      }
      const nextOffset = response.data.nextOffset;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
        throw new Error('Legacy OpenClaw Project session listing returned invalid pagination');
      }
      offset = nextOffset;
    }
  }
  return Object.freeze(Array.from(found.values()));
}

function assertAgentSnapshotsMatch(
  expected: ReadonlyMap<string, AttestedLegacyAgent>,
  current: ReadonlyMap<string, AttestedLegacyAgent>,
): void {
  if (expected.size !== current.size) {
    throw new Error('Legacy OpenClaw Project agent set changed during cleanup');
  }
  for (const [agentId, expectedAgent] of expected) {
    if (current.get(agentId)?.signature !== expectedAgent.signature) {
      throw new Error('Legacy OpenClaw Project agent changed before deletion');
    }
  }
}

function gatewaySessionIsAuthoritativelyAbsent(error: unknown): boolean {
  return /(?:\b(?:session|agent)\b[^\n]{0,80}\b(?:not found|does not exist|unknown)\b|\b(?:no|unknown)\s+(?:session|agent)\b)/i
    .test(String(error || ''));
}

/**
 * Retire the actor-scoped 3.x OpenClaw identities for one immutable Project.
 * The caller must hold its lifecycle/runtime admission and must run all other
 * provider enumerations first. This helper performs no OAuth/model checks and
 * refuses a v3 stable-slug collision before sending the first Gateway RPC.
 */
export async function retireLegacyOpenClawProjectRuntime(input: {
  actorUserId: string;
  targetProjectIds: readonly string[];
  targetCanonicalRoot: string;
  exactServerOwnedSessionKeys: readonly string[];
  adapterOwnedSessionKeys: readonly string[];
  preserveTranscriptFiles?: boolean;
  retireRootAttestedConfigOnlyAgents?: boolean;
  openClawHome?: string;
}, overrides: Partial<LegacyOpenClawRuntimeCleanupDependencies> = {}): Promise<{
  sessionKeys: readonly string[];
  agentIds: readonly string[];
}> {
  const dependencies = { ...defaultDependencies, ...overrides };
  await assertLegacyOpenClawProjectMigrationInactive();
  await assertNoLegacyOpenClawProjectEvidence();
  const actorUserId = requiredIdentifier(input.actorUserId, 'Project Chat actor');
  const targetCanonicalRoot = requiredAbsolutePath(input.targetCanonicalRoot, 'Project canonical root');
  const openClawHome = requiredAbsolutePath(
    input.openClawHome || process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw'),
    'OpenClaw home',
  );
  const targetProjectIds = Array.from(new Set(
    input.targetProjectIds.map((value) => requiredIdentifier(value, 'Project identity')),
  ));
  if (targetProjectIds.length === 0) throw new Error('At least one Project identity is required');

  const [bindings, sessions] = await Promise.all([
    dependencies.database.projectChatProviderBinding.findMany({
      where: {
        userId: actorUserId,
        projectId: { in: targetProjectIds },
        provider: 'OPENCLAW',
      },
    }),
    dependencies.database.projectChatSession.findMany({
      where: { userId: actorUserId, projectId: { in: targetProjectIds } },
    }),
  ]);
  const bindingSessionKeys = bindings
    .flatMap((binding) => [binding.sessionKey, binding.externalSessionId])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const oldActorSessionPrefix = `portal-${actorUserId}-`;
  const storedSessionIds = sessions
    .filter((session) => (
      session.activeProvider === 'OPENCLAW'
      || session.sessionKey.startsWith(oldActorSessionPrefix)
    ))
    .map((session) => session.sessionKey);
  const databaseCleanupKeys = attestLegacyOpenClawProjectSessionKeys({
    actorUserId,
    storedSessionIds,
    storedBindingSessionKeys: bindingSessionKeys,
    exactServerOwnedSessionKeys: input.exactServerOwnedSessionKeys,
    adapterOwnedSessionKeys: input.adapterOwnedSessionKeys,
  });

  const databaseLegacyAgentIds = Array.from(new Set(databaseCleanupKeys.flatMap((sessionKey) => {
    const match = /^agent:(portal-[^:]+):/.exec(sessionKey);
    return match && LEGACY_AGENT_ID_PATTERN.test(match[1]) ? [match[1]] : [];
  }))).sort();
  if (databaseLegacyAgentIds.length > MAX_LEGACY_AGENTS_PER_PROJECT) {
    throw new Error('Legacy OpenClaw Project agent count exceeded the cleanup safety limit');
  }

  // A 3.x process could die after config.patch created the dedicated agent but
  // before Portal persisted its binding/session row. Discover those exact
  // actor/root-bound config entries as well as the database-derived identities.
  // The config snapshot and every bounded session listing are read-only
  // preflight: no Gateway mutation occurs until all candidates are attested.
  // The release-disabled path conservatively treats a root-attested config-only
  // signal as pending; it never has to assign ownership for deletion.
  const includeRootAttestedConfigOnlyAgents = input.retireRootAttestedConfigOnlyAgents === true
    || !LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED;
  const preflightAgents = await inspectAttestedLegacyAgents({
    actorUserId,
    knownAgentIds: databaseLegacyAgentIds,
    targetCanonicalRoot,
    openClawHome,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
    retireRootAttestedConfigOnlyAgents: includeRootAttestedConfigOnlyAgents,
  });
  const legacyAgentIds = Array.from(new Set([
    ...databaseLegacyAgentIds,
    ...preflightAgents.keys(),
  ])).sort();
  if (legacyAgentIds.length > MAX_LEGACY_AGENTS_PER_PROJECT) {
    throw new Error('Legacy OpenClaw Project agent count exceeded the cleanup safety limit');
  }

  const cleanupKeySet = new Set(databaseCleanupKeys);
  for (const agentId of legacyAgentIds) {
    // Include the exact identities derivable from the attested 3.x agent even
    // when sessions.list cannot see its cross-agent `portal` fallback.
    const derived = deriveLegacySessionIdentity({ actorUserId, agentId });
    cleanupKeySet.add(derived.sessionKey);
    cleanupKeySet.add(derived.portalFallbackSessionKey);
    const listed = await listAttestedLegacySessionsForAgent({
      actorUserId,
      agentId,
      listAgentSessions: dependencies.listAgentSessions,
    });
    for (const session of listed) {
      cleanupKeySet.add(session.sessionKey);
      cleanupKeySet.add(session.portalFallbackSessionKey);
    }
  }
  const cleanupKeys = Object.freeze(Array.from(cleanupKeySet).sort());

  const collisionCandidates = Array.from(new Set([
    ...storedSessionIds,
    ...bindingSessionKeys,
    ...cleanupKeys,
  ])).filter(Boolean);
  if (collisionCandidates.length > 0) {
    const [otherSessions, otherBindings] = await Promise.all([
      dependencies.database.projectChatSession.findMany({
        where: {
          userId: actorUserId,
          projectId: { notIn: targetProjectIds },
          sessionKey: { in: collisionCandidates },
        },
        select: { id: true },
        take: 1,
      }),
      dependencies.database.projectChatProviderBinding.findMany({
        where: {
          userId: actorUserId,
          projectId: { notIn: targetProjectIds },
          provider: 'OPENCLAW',
          OR: [
            { sessionKey: { in: collisionCandidates } },
            { externalSessionId: { in: collisionCandidates } },
          ],
        },
        select: { id: true },
        take: 1,
      }),
    ]);
    if (otherSessions.length > 0 || otherBindings.length > 0) {
      throw new Error('A legacy OpenClaw session is shared with another Project');
    }
  }

  // Close the preflight-to-mutation window: the exact actor/root-bound config
  // set must still match, including the absence of any newly appeared orphan.
  const preMutationAgents = await inspectAttestedLegacyAgents({
    actorUserId,
    knownAgentIds: legacyAgentIds,
    targetCanonicalRoot,
    openClawHome,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
    retireRootAttestedConfigOnlyAgents: includeRootAttestedConfigOnlyAgents,
  });
  assertAgentSnapshotsMatch(preflightAgents, preMutationAgents);
  await assertLegacyOpenClawProjectMigrationInactive();
  await assertNoLegacyOpenClawProjectEvidence();

  // OpenClaw 2026.7.1 cannot atomically fence a configured agent against a
  // newly admitted direct-Gateway session. In this release every legacy key,
  // agent, or runtime signal therefore remains preserved. Even an exact empty
  // read cannot authorize the next mutation because new evidence can appear
  // immediately afterward. No environment variable can opt into the dormant
  // destructive implementation below.
  if (!LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED) {
    throw new Error(LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE);
  }

  if (input.retireRootAttestedConfigOnlyAgents) {
    let presentSession = false;
    for (const sessionKey of cleanupKeys) {
      const current = await dependencies.inspect(sessionKey);
      if (current.ok) {
        presentSession = true;
      } else if (!gatewaySessionIsAuthoritativelyAbsent(current.error)) {
        throw new Error('Legacy OpenClaw Project session absence could not be verified');
      }
    }
    if (preMutationAgents.size > 0 || presentSession) {
      throw new Error(
        'Legacy OpenClaw Project runtime cleanup requires an atomic Gateway admission fence and remains pending',
      );
    }
    // The Project lifecycle barrier prevents new Portal admission. With every
    // exact legacy identity proven absent, return without sending a delete RPC
    // that could race an out-of-band Gateway writer and mutate new state.
    return Object.freeze({ sessionKeys: [], agentIds: [] });
  }

  for (const sessionKey of cleanupKeys) {
    const aborted = await dependencies.abort(sessionKey);
    if (!aborted.ok && !gatewaySessionIsAuthoritativelyAbsent(aborted.error)) {
      throw new Error('Legacy OpenClaw Project execution could not be authoritatively aborted');
    }
    const deleted = input.preserveTranscriptFiles
      ? await dependencies.delete(sessionKey, { deleteTranscript: false })
      : await dependencies.delete(sessionKey);
    if (!deleted.ok && !gatewaySessionIsAuthoritativelyAbsent(deleted.error)) {
      throw new Error('Legacy OpenClaw Project session deletion could not be confirmed');
    }
    const readback = await dependencies.inspect(sessionKey);
    if (readback.ok || !gatewaySessionIsAuthoritativelyAbsent(readback.error)) {
      throw new Error('Legacy OpenClaw Project session remained after deletion readback');
    }
  }

  // agents.delete purges files but is not an execution-abort primitive. Prove
  // the agent-scoped listings are empty after the explicit abort/delete/readback
  // phase and before removing each configured agent identity.
  for (const agentId of legacyAgentIds) {
    const residue = await listAttestedLegacySessionsForAgent({
      actorUserId,
      agentId,
      listAgentSessions: dependencies.listAgentSessions,
    });
    if (residue.length > 0) {
      throw new Error('Legacy OpenClaw Project sessions remained before agent deletion');
    }
  }

  const remainingAgents = new Map(preflightAgents);
  for (const agentId of legacyAgentIds) {
    const currentAgents = await inspectAttestedLegacyAgents({
      actorUserId,
      knownAgentIds: legacyAgentIds,
      targetCanonicalRoot,
      openClawHome,
      inspectAgents: dependencies.inspectAgents,
      listAgentSessions: dependencies.listAgentSessions,
      attestAgentWorkspace: dependencies.attestAgentWorkspace,
      retireRootAttestedConfigOnlyAgents: false,
    });
    assertAgentSnapshotsMatch(remainingAgents, currentAgents);
    const expected = remainingAgents.get(agentId);
    const current = currentAgents.get(agentId);
    if (!expected || !current) continue;
    const deleted = input.preserveTranscriptFiles
      ? await dependencies.deleteAgent(agentId, { deleteFiles: false })
      : await dependencies.deleteAgent(agentId);
    if (!deleted.ok && !gatewaySessionIsAuthoritativelyAbsent(deleted.error)) {
      throw new Error('Legacy OpenClaw Project agent deletion could not be confirmed');
    }
    remainingAgents.delete(agentId);
  }
  const residue = await inspectAttestedLegacyAgents({
    actorUserId,
    knownAgentIds: legacyAgentIds,
    targetCanonicalRoot,
    openClawHome,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
    retireRootAttestedConfigOnlyAgents: false,
  });
  if (residue.size > 0) {
    throw new Error('Legacy OpenClaw Project agent remained after deletion readback');
  }
  return Object.freeze({
    sessionKeys: cleanupKeys,
    agentIds: Object.freeze(legacyAgentIds),
  });
}
