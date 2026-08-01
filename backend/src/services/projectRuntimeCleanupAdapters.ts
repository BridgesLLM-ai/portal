import crypto from 'crypto';
import type {
  AgentProviderName,
  AttestedProjectRuntimeCleanup,
} from '../agents/AgentProvider.interface';
import { AgentRegistry } from '../agents';
import {
  deleteNativeSession,
  listNativeProjectSessions,
  type NativeSessionData,
} from '../agents/providers/NativeSessionStore';
import {
  discoverAgentZeroProjectRuntimeResources,
  teardownAgentZeroProjectRuntimeResources,
  type AgentZeroProjectRuntimeResource,
} from '../agents/providers/agentZero/AgentZeroProjectCleanup';
import {
  hardAbortAgentZeroProjectRuntime,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import {
  OLLAMA_PROJECT_ACTOR_LABEL,
  OLLAMA_PROJECT_IDENTITY_LABEL,
  OLLAMA_PROJECT_POLICY_LABEL,
  OLLAMA_PROJECT_PROVIDER_LABEL,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  hashOllamaProjectRuntimeIdentity,
  ollamaProjectCommandExecutor,
} from '../agents/providers/ollama/OllamaProjectToolRuntime';
import {
  CODEX_PROJECT_RUNTIME_ACTOR_LABEL,
  CODEX_PROJECT_RUNTIME_IDENTITY_LABEL,
  codexProjectEgressCommandExecutor,
  hashCodexProjectRuntimeLabelIdentity,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL,
  NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL,
  NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL,
  hashNativeCliProjectRuntimeLabelIdentity,
  nativeCliProjectEgressCommandExecutor,
  type NativeCliProjectRuntimeProvider,
} from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import {
  hasNativeCliProjectManagedStateForIdentity,
  removeNativeCliProjectManagedStateForIdentity,
} from '../agents/providers/native/projectSandbox/NativeCliProjectManagedState';
import {
  OPENCLAW_PROJECT_ACTOR_LABEL,
  OPENCLAW_PROJECT_AGENT_LABEL,
  OPENCLAW_PROJECT_IDENTITY_LABEL,
  deriveOpenClawProjectAgentId,
  deriveOpenClawProjectSessionKey,
  hashOpenClawProjectLabelIdentity,
} from './openclawProjectSandbox';
import {
  abortProjectNativeRun,
  clearProjectNativeRun,
  getProjectNativeRunSnapshot,
} from './projectNativeRunBroker';
import { getProjectChatProviderAdapter } from './projectChatProviderRegistry';
import {
  PROJECT_RUNTIME_CLEANUP_PROVIDERS,
  type ProjectRuntimeCleanupAdapter,
  type ProjectRuntimeCleanupProvider,
  type ProjectRuntimeCleanupScope,
  type ProjectRuntimeCleanupTurn,
  type ProjectRuntimeResource,
} from './projectRuntimeCleanup';
import type { ProjectEgressCommandExecutor } from './projectEgressPlane';
import { deleteSession, gatewayRpcCall } from '../utils/openclawGatewayRpc';

interface RpcResult {
  ok: boolean;
  data?: any;
  error?: any;
}

interface DockerInspect {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> | null };
  State?: { Running?: boolean };
  Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>;
}

export interface ProjectRuntimeCleanupAdapterDependencies {
  executor: ProjectEgressCommandExecutor;
  rpc(method: string, params: Record<string, any>, timeoutMs?: number): Promise<RpcResult>;
  deleteOpenClawSession(sessionKey: string): Promise<{ ok: boolean; error?: string }>;
}

export interface AgentZeroProjectRuntimeCleanupAdapterDependencies {
  discover(
    projectIdentityId: string,
    options: { knownActorIds: readonly string[] },
  ): Promise<readonly AgentZeroProjectRuntimeResource[]>;
  teardown(
    projectIdentityId: string,
    options: { knownActorIds: readonly string[] },
  ): Promise<unknown>;
  listSessions(scope: ProjectRuntimeCleanupScope): NativeSessionData[];
  abortSession(sessionId: string, runId: string): Promise<boolean>;
  deleteSession(sessionId: string): void;
  hardAbort(context: Extract<NonNullable<NativeSessionData['executionContext']>, { scope: 'PROJECT_SANDBOX' }>): boolean;
  convergeInMemoryState(input: AttestedProjectRuntimeCleanup): Promise<void>;
}

export interface NativeCliProjectRuntimeCleanupAdapterDependencies {
  executor: ProjectEgressCommandExecutor;
  listSessions(
    provider: NativeCliProjectRuntimeProvider,
    scope: ProjectRuntimeCleanupScope,
  ): NativeSessionData[];
  abortSession(
    provider: NativeCliProjectRuntimeProvider,
    sessionId: string,
    expectedRunId?: string,
  ): Promise<boolean>;
  terminateSession(provider: NativeCliProjectRuntimeProvider, sessionId: string): Promise<void>;
  deleteSession(provider: NativeCliProjectRuntimeProvider, sessionId: string): void;
  hasManagedState(input: {
    provider: NativeCliProjectRuntimeProvider;
    userId: string;
    projectId: string;
    projectRoot: string;
  }): boolean;
  removeManagedState(input: {
    provider: NativeCliProjectRuntimeProvider;
    userId: string;
    projectId: string;
    projectRoot: string;
  }): void;
}

export interface OllamaProjectRuntimeCleanupAdapterDependencies {
  executor: ProjectEgressCommandExecutor;
  listSessions(scope: ProjectRuntimeCleanupScope): NativeSessionData[];
  abortSession(sessionId: string, expectedRunId?: string): Promise<boolean>;
  terminateSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): void;
  convergeInMemoryState(input: AttestedProjectRuntimeCleanup): Promise<void>;
}

const defaultDependencies: ProjectRuntimeCleanupAdapterDependencies = {
  executor: codexProjectEgressCommandExecutor,
  rpc: gatewayRpcCall,
  deleteOpenClawSession: deleteSession,
};

const OPENCLAW_SESSION_DELETE_MAX_ATTEMPTS = 3;
const OPENCLAW_SESSION_DELETE_RETRY_BASE_MS = 25;

function openClawSessionDeleteChanged(error: unknown): boolean {
  return /session .+ changed before deletion\. retry\./i.test(String(error || ''));
}

async function deleteOpenClawProjectSession(
  dependencies: ProjectRuntimeCleanupAdapterDependencies,
  sessionKey: string,
): Promise<void> {
  for (let attempt = 1; attempt <= OPENCLAW_SESSION_DELETE_MAX_ATTEMPTS; attempt += 1) {
    const deleted = await dependencies.deleteOpenClawSession(sessionKey);
    if (deleted.ok || /not found/i.test(String(deleted.error || ''))) return;
    if (
      !openClawSessionDeleteChanged(deleted.error)
      || attempt === OPENCLAW_SESSION_DELETE_MAX_ATTEMPTS
    ) {
      throw new Error('OpenClaw Project session deletion failed');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, OPENCLAW_SESSION_DELETE_RETRY_BASE_MS * attempt);
    });
  }
}

const defaultAgentZeroDependencies: AgentZeroProjectRuntimeCleanupAdapterDependencies = {
  discover: discoverAgentZeroProjectRuntimeResources,
  teardown: teardownAgentZeroProjectRuntimeResources,
  listSessions: (scope) => nativeSessionsForScope('AGENT_ZERO', scope),
  abortSession: async (sessionId, runId) => (
    await getProjectChatProviderAdapter('AGENT_ZERO').abortActiveRun?.(sessionId, runId)
  ) || false,
  deleteSession: (sessionId) => deleteNativeSession('AGENT_ZERO', sessionId),
  hardAbort: (context) => hardAbortAgentZeroProjectRuntime(context),
  convergeInMemoryState: async (input) => {
    const provider = getProjectChatProviderAdapter('AGENT_ZERO');
    if (!provider.convergeAttestedProjectCleanup) {
      throw new Error('Agent Zero Project provider lacks cleanup-state convergence');
    }
    await provider.convergeAttestedProjectCleanup(input);
  },
};

const defaultNativeCliProjectDependencies: NativeCliProjectRuntimeCleanupAdapterDependencies = {
  executor: nativeCliProjectEgressCommandExecutor,
  listSessions: (provider, scope) => nativeSessionsForScope(provider, scope),
  abortSession: async (provider, sessionId, expectedRunId) => (
    await AgentRegistry.get(provider).abortActiveRun?.(sessionId, expectedRunId)
  ) || false,
  terminateSession: async (provider, sessionId) => AgentRegistry.get(provider).terminateSession(sessionId),
  deleteSession: (provider, sessionId) => deleteNativeSession(provider, sessionId),
  hasManagedState: hasNativeCliProjectManagedStateForIdentity,
  removeManagedState: removeNativeCliProjectManagedStateForIdentity,
};

const defaultOllamaProjectDependencies: OllamaProjectRuntimeCleanupAdapterDependencies = {
  executor: ollamaProjectCommandExecutor,
  listSessions: (scope) => nativeSessionsForScope('OLLAMA', scope),
  abortSession: async (sessionId, expectedRunId) => (
    await getProjectChatProviderAdapter('OLLAMA').abortActiveRun?.(sessionId, expectedRunId)
  ) || false,
  terminateSession: async (sessionId) => {
    await getProjectChatProviderAdapter('OLLAMA').terminateSession(sessionId);
  },
  deleteSession: (sessionId) => deleteNativeSession('OLLAMA', sessionId),
  convergeInMemoryState: async (input) => {
    const provider = getProjectChatProviderAdapter('OLLAMA');
    if (!provider.convergeAttestedProjectCleanup) {
      throw new Error('Ollama Project provider lacks cleanup-state convergence');
    }
    await provider.convergeAttestedProjectCleanup(input);
  },
};

function cleanupSessionIds(
  scope: ProjectRuntimeCleanupScope,
  provider: 'AGENT_ZERO' | 'OLLAMA',
  resources: readonly ProjectRuntimeResource[],
  actorUserId: string,
): string[] {
  const resourcePrefix = provider === 'AGENT_ZERO' ? 'agent-zero-session:' : 'native-session:';
  const sessionIds = new Set(
    resources
      .filter((resource) => (
        resource.actorUserId === actorUserId
        && resource.id.startsWith(resourcePrefix)
      ))
      .map((resource) => resource.id.slice(resourcePrefix.length)),
  );
  for (const binding of scope.bindings) {
    if (binding.userId !== actorUserId || !providerMatches(binding.provider, provider)) continue;
    for (const value of [binding.sessionKey, binding.externalSessionId]) {
      const sessionId = String(value || '').trim();
      if (sessionId) sessionIds.add(sessionId);
    }
  }
  for (const evidence of scope.cleanupSessionEvidence || []) {
    if (evidence.provider !== provider || evidence.actorUserId !== actorUserId) continue;
    const sessionId = String(evidence.sessionId || '').trim();
    if (sessionId) sessionIds.add(sessionId);
  }
  return Array.from(sessionIds).sort();
}

function cleanupAttestation(
  scope: ProjectRuntimeCleanupScope,
  actorUserId: string,
  sessionIds: readonly string[],
): AttestedProjectRuntimeCleanup {
  return Object.freeze({
    userId: actorUserId,
    projectId: scope.projectIdentity.id,
    canonicalRoot: scope.projectIdentity.canonicalRoot,
    rootDevice: scope.projectIdentity.rootDevice,
    rootInode: scope.projectIdentity.rootInode,
    rootBirthtimeNs: scope.projectIdentity.rootBirthtimeNs,
    sessionIds: Object.freeze([...sessionIds]),
  });
}

function cleanupActorIds(
  scope: ProjectRuntimeCleanupScope,
  resources: readonly ProjectRuntimeResource[],
): readonly string[] {
  const actors = new Set(scope.knownActorIds);
  for (const resource of resources) {
    if (resource.actorUserId) actors.add(resource.actorUserId);
  }
  return Object.freeze(Array.from(actors).sort());
}

function stableEvidence(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function providerMatches(value: string, provider: ProjectRuntimeCleanupProvider): boolean {
  const normalized = String(value || '').trim().toUpperCase();
  return (normalized === 'GROK' ? 'GROK_BUILD' : normalized) === provider;
}

function exactNativeProvider(provider: ProjectRuntimeCleanupProvider): AgentProviderName | null {
  if (provider === 'GROK_BUILD') return 'GROK';
  if (provider === 'CLAUDE_CODE' || provider === 'CODEX' || provider === 'GEMINI' || provider === 'OLLAMA') {
    return provider;
  }
  return null;
}

function nativeSessionsForScope(
  provider: AgentProviderName,
  scope: ProjectRuntimeCleanupScope,
): NativeSessionData[] {
  return listNativeProjectSessions(provider, {
    projectIdentityId: scope.projectIdentity.id,
    canonicalRoot: scope.projectIdentity.canonicalRoot,
    rootDevice: scope.projectIdentity.rootDevice,
    rootInode: scope.projectIdentity.rootInode,
    rootBirthtimeNs: scope.projectIdentity.rootBirthtimeNs,
  });
}

function nativeSessionResource(
  provider: ProjectRuntimeCleanupProvider,
  session: NativeSessionData,
): ProjectRuntimeResource {
  return Object.freeze({
    id: `native-session:${session.sessionId}`,
    kind: 'NATIVE_SESSION',
    projectIdentityId: session.executionContext?.scope === 'PROJECT_SANDBOX'
      ? session.executionContext.projectId
      : '',
    actorUserId: session.userId,
    provider,
  });
}

function parseDockerInspect(stdout: string): DockerInspect | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Project runtime Docker inspection returned invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Project runtime Docker inspection returned an invalid shape');
  if (parsed.length === 0) return null;
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    throw new Error('Project runtime Docker inspection was ambiguous');
  }
  return parsed[0] as DockerInspect;
}

async function inspectContainer(
  executor: ProjectEgressCommandExecutor,
  id: string,
): Promise<DockerInspect | null> {
  const result = await executor.run('docker', ['container', 'inspect', id], { allowExitCodes: [0, 1] });
  if (result.exitCode === 1) return null;
  return parseDockerInspect(result.stdout);
}

async function listContainersByLabel(
  executor: ProjectEgressCommandExecutor,
  label: string,
  value: string,
  additionalLabels: Readonly<Record<string, string>> = {},
): Promise<DockerInspect[]> {
  const args = [
    'container', 'ls', '--all', '--no-trunc',
    '--filter', `label=${label}=${value}`,
  ];
  for (const [additionalLabel, additionalValue] of Object.entries(additionalLabels)) {
    args.push('--filter', `label=${additionalLabel}=${additionalValue}`);
  }
  args.push('--format', '{{.ID}}');
  const result = await executor.run('docker', args);
  const ids = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) {
    throw new Error('Project runtime Docker discovery returned an invalid container identity');
  }
  const containers: DockerInspect[] = [];
  for (const id of ids) {
    const inspect = await inspectContainer(executor, id);
    if (!inspect || String(inspect.Id || '').toLowerCase() !== id.toLowerCase()) {
      throw new Error('Project runtime container changed during discovery');
    }
    containers.push(inspect);
  }
  return containers;
}

function assertProjectMountBoundary(inspect: DockerInspect, scope: ProjectRuntimeCleanupScope): void {
  const projectRoot = scope.projectIdentity.canonicalRoot;
  const writable = (inspect.Mounts || []).filter((mount) => mount.RW === true);
  if (writable.length !== 1 || writable[0].Source !== projectRoot) {
    throw new Error('Project runtime writable mount did not match the immutable project root');
  }
}

function actorForLabel(
  scope: ProjectRuntimeCleanupScope,
  labelValue: string,
  hash: (value: string) => string,
): string | null {
  const matches = scope.knownActorIds.filter((actorId) => hash(actorId) === labelValue);
  if (matches.length > 1) throw new Error('Project runtime actor label was ambiguous');
  return matches[0] || null;
}

async function removeAttestedContainer(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  projectLabel: string;
  projectLabelValue: string;
  scope: ProjectRuntimeCleanupScope;
}): Promise<void> {
  const inspect = await inspectContainer(input.executor, input.containerId);
  if (!inspect) return;
  if (
    String(inspect.Id || '').toLowerCase() !== input.containerId.toLowerCase()
    || inspect.Config?.Labels?.[input.projectLabel] !== input.projectLabelValue
  ) {
    throw new Error('Project runtime container identity changed before deletion');
  }
  assertProjectMountBoundary(inspect, input.scope);
  await input.executor.run('docker', ['container', 'stop', '--time', '3', input.containerId], { allowExitCodes: [0, 1] });
  await input.executor.run('docker', ['container', 'rm', '--force', input.containerId], { allowExitCodes: [0, 1] });
  if (await inspectContainer(input.executor, input.containerId)) {
    throw new Error('Project runtime container remained after deletion');
  }
}

function containerIdFromResource(resource: ProjectRuntimeResource): string {
  const match = resource.id.match(/^runtime-container:([a-f0-9]{64})$/i);
  if (!match) throw new Error('Project runtime cleanup resource has an invalid container ID');
  return match[1].toLowerCase();
}

async function listOpenClawResources(
  scope: ProjectRuntimeCleanupScope,
  dependencies: ProjectRuntimeCleanupAdapterDependencies,
): Promise<ProjectRuntimeResource[]> {
  const projectLabelValue = hashOpenClawProjectLabelIdentity(scope.projectIdentity.id);
  const containers = await listContainersByLabel(
    dependencies.executor,
    OPENCLAW_PROJECT_IDENTITY_LABEL,
    projectLabelValue,
  );
  const resources: ProjectRuntimeResource[] = [];
  for (const inspect of containers) {
    const labels = inspect.Config?.Labels || {};
    const containerId = String(inspect.Id || '').toLowerCase();
    const agentId = String(labels[OPENCLAW_PROJECT_AGENT_LABEL] || '');
    const sessionKey = String(labels['openclaw.sessionKey'] || '');
    if (
      labels[OPENCLAW_PROJECT_IDENTITY_LABEL] !== projectLabelValue
      || !/^p4oc-[a-f0-9]{40}$/.test(agentId)
      || sessionKey !== `agent:${agentId}:portal-project`
    ) {
      throw new Error('OpenClaw Project container labels did not match a server-owned runtime identity');
    }
    assertProjectMountBoundary(inspect, scope);
    resources.push(Object.freeze({
      id: `runtime-container:${containerId}`,
      kind: 'OPENCLAW_CONTAINER',
      projectIdentityId: scope.projectIdentity.id,
      actorUserId: actorForLabel(scope, String(labels[OPENCLAW_PROJECT_ACTOR_LABEL] || ''), hashOpenClawProjectLabelIdentity),
      provider: 'OPENCLAW',
    }));
  }

  const configResult = await dependencies.rpc('config.get', {}, 15_000);
  if (!configResult.ok) throw new Error('OpenClaw configuration could not be inspected for Project cleanup');
  const config = configResult.data?.config || configResult.data?.parsed;
  if (!config || typeof config !== 'object') throw new Error('OpenClaw configuration inspection returned an invalid shape');
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const actorUserId of scope.knownActorIds) {
    const agentId = deriveOpenClawProjectAgentId({ userId: actorUserId, projectId: scope.projectIdentity.id });
    const sessionKey = deriveOpenClawProjectSessionKey({ userId: actorUserId, projectId: scope.projectIdentity.id });
    const matchingAgents = agents.filter((entry: any) => entry && entry.id === agentId);
    if (matchingAgents.length > 1) throw new Error('OpenClaw Project agent identity was duplicated');
    if (matchingAgents.length === 1) {
      resources.push(Object.freeze({
        id: `openclaw-agent:${agentId}`,
        kind: 'OPENCLAW_AGENT',
        projectIdentityId: scope.projectIdentity.id,
        actorUserId,
        provider: 'OPENCLAW',
      }));
    }
    const sessionsResult = await dependencies.rpc('sessions.list', { agentId }, 15_000);
    if (!sessionsResult.ok || !Array.isArray(sessionsResult.data?.sessions)) {
      throw new Error('OpenClaw Project sessions could not be inspected for cleanup');
    }
    if (sessionsResult.data.sessions.some((entry: any) => entry?.key === sessionKey)) {
      resources.push(Object.freeze({
        id: `openclaw-session:${sessionKey}`,
        kind: 'OPENCLAW_SESSION',
        projectIdentityId: scope.projectIdentity.id,
        actorUserId,
        provider: 'OPENCLAW',
      }));
    }
  }
  return resources;
}

export function createOpenClawProjectRuntimeCleanupAdapter(
  overrides: Partial<ProjectRuntimeCleanupAdapterDependencies> = {},
): ProjectRuntimeCleanupAdapter {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    provider: 'OPENCLAW',
    enumerate: (scope) => listOpenClawResources(scope, dependencies),
    async quiesceTurn(scope, turn) {
      const sessionKey = deriveOpenClawProjectSessionKey({
        userId: turn.actorUserId,
        projectId: scope.projectIdentity.id,
      });
      if (turn.providerSessionId && turn.providerSessionId !== sessionKey) {
        throw new Error('OpenClaw Project turn session identity drifted before cleanup');
      }
      const aborted = await dependencies.rpc('chat.abort', { sessionKey }, 15_000);
      if (!aborted.ok) throw new Error('OpenClaw Project turn could not be authoritatively aborted');
      clearProjectNativeRun({ userId: turn.actorUserId, projectId: scope.projectIdentity.id, provider: 'OPENCLAW' });
      return {
        quiesced: true,
        evidence: `openclaw-${stableEvidence({ turnId: turn.id, sessionKey, aborted: aborted.data?.aborted !== false })}`,
      };
    },
    async cleanup(scope, resources) {
      for (const resource of resources.filter((entry) => entry.kind === 'OPENCLAW_SESSION')) {
        const sessionKey = resource.id.slice('openclaw-session:'.length);
        const aborted = await dependencies.rpc('chat.abort', { sessionKey }, 15_000);
        if (!aborted.ok) throw new Error('OpenClaw Project session abort failed during cleanup');
        await deleteOpenClawProjectSession(dependencies, sessionKey);
      }
      for (const resource of resources.filter((entry) => entry.kind === 'OPENCLAW_AGENT')) {
        const agentId = resource.id.slice('openclaw-agent:'.length);
        if (!/^p4oc-[a-f0-9]{40}$/.test(agentId)) throw new Error('Refusing to delete an unsafe OpenClaw agent identity');
        const deleted = await dependencies.rpc('agents.delete', { agentId, deleteFiles: true }, 20_000);
        if (!deleted.ok && !/not found/i.test(String(deleted.error || ''))) {
          throw new Error('OpenClaw Project agent deletion failed');
        }
      }
      const projectLabelValue = hashOpenClawProjectLabelIdentity(scope.projectIdentity.id);
      for (const resource of resources.filter((entry) => entry.kind === 'OPENCLAW_CONTAINER')) {
        await removeAttestedContainer({
          executor: dependencies.executor,
          containerId: containerIdFromResource(resource),
          projectLabel: OPENCLAW_PROJECT_IDENTITY_LABEL,
          projectLabelValue,
          scope,
        });
      }
      for (const actorUserId of scope.knownActorIds) {
        clearProjectNativeRun({ userId: actorUserId, projectId: scope.projectIdentity.id, provider: 'OPENCLAW' });
      }
    },
    verifyClean: (scope) => listOpenClawResources(scope, dependencies),
  };
}

async function listCodexResources(
  scope: ProjectRuntimeCleanupScope,
  dependencies: ProjectRuntimeCleanupAdapterDependencies,
): Promise<ProjectRuntimeResource[]> {
  const resources: ProjectRuntimeResource[] = nativeSessionsForScope('CODEX', scope)
    .map((session) => nativeSessionResource('CODEX', session));
  const projectLabelValue = hashCodexProjectRuntimeLabelIdentity(scope.projectIdentity.id);
  const containers = await listContainersByLabel(
    dependencies.executor,
    CODEX_PROJECT_RUNTIME_IDENTITY_LABEL,
    projectLabelValue,
  );
  for (const inspect of containers) {
    const labels = inspect.Config?.Labels || {};
    assertProjectMountBoundary(inspect, scope);
    resources.push(Object.freeze({
      id: `runtime-container:${String(inspect.Id || '').toLowerCase()}`,
      kind: 'NATIVE_RUNTIME_CONTAINER',
      projectIdentityId: scope.projectIdentity.id,
      actorUserId: actorForLabel(scope, String(labels[CODEX_PROJECT_RUNTIME_ACTOR_LABEL] || ''), hashCodexProjectRuntimeLabelIdentity),
      provider: 'CODEX',
    }));
  }
  for (const actorUserId of scope.knownActorIds) {
    const snapshot = getProjectNativeRunSnapshot({
      userId: actorUserId,
      projectId: scope.projectIdentity.id,
      provider: 'CODEX',
    });
    if (snapshot) {
      resources.push(Object.freeze({
        id: `native-run-broker:${stableEvidence({ actorUserId, projectId: scope.projectIdentity.id })}`,
        kind: 'NATIVE_RUN_BROKER',
        projectIdentityId: scope.projectIdentity.id,
        actorUserId,
        provider: 'CODEX',
      }));
    }
  }
  return resources;
}

export function createCodexProjectRuntimeCleanupAdapter(
  overrides: Partial<ProjectRuntimeCleanupAdapterDependencies> = {},
): ProjectRuntimeCleanupAdapter {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    provider: 'CODEX',
    enumerate: (scope) => listCodexResources(scope, dependencies),
    async quiesceTurn(scope, turn) {
      await abortProjectNativeRun({
        userId: turn.actorUserId,
        projectId: scope.projectIdentity.id,
        provider: 'CODEX',
      });
      const projectLabelValue = hashCodexProjectRuntimeLabelIdentity(scope.projectIdentity.id);
      const containers = await listContainersByLabel(
        dependencies.executor,
        CODEX_PROJECT_RUNTIME_IDENTITY_LABEL,
        projectLabelValue,
      );
      for (const inspect of containers) {
        assertProjectMountBoundary(inspect, scope);
        await dependencies.executor.run('docker', ['container', 'stop', '--time', '3', String(inspect.Id)], { allowExitCodes: [0, 1] });
        const stopped = await inspectContainer(dependencies.executor, String(inspect.Id));
        if (stopped?.State?.Running) throw new Error('Codex Project runtime remained active after abort');
      }
      return {
        quiesced: true,
        evidence: `codex-${stableEvidence({ turnId: turn.id, containers: containers.map((entry) => entry.Id) })}`,
      };
    },
    async cleanup(scope, resources) {
      for (const resource of resources.filter((entry) => entry.kind === 'NATIVE_SESSION')) {
        const sessionId = resource.id.slice('native-session:'.length);
        await AgentRegistry.get('CODEX').abortActiveRun?.(sessionId);
        await AgentRegistry.get('CODEX').terminateSession(sessionId);
        deleteNativeSession('CODEX', sessionId);
      }
      for (const actorUserId of scope.knownActorIds) {
        clearProjectNativeRun({ userId: actorUserId, projectId: scope.projectIdentity.id, provider: 'CODEX' });
      }
      const projectLabelValue = hashCodexProjectRuntimeLabelIdentity(scope.projectIdentity.id);
      for (const resource of resources.filter((entry) => entry.kind === 'NATIVE_RUNTIME_CONTAINER')) {
        await removeAttestedContainer({
          executor: dependencies.executor,
          containerId: containerIdFromResource(resource),
          projectLabel: CODEX_PROJECT_RUNTIME_IDENTITY_LABEL,
          projectLabelValue,
          scope,
        });
      }
    },
    verifyClean: (scope) => listCodexResources(scope, dependencies),
  };
}

async function listNativeCliProjectResources(
  provider: NativeCliProjectRuntimeProvider,
  scope: ProjectRuntimeCleanupScope,
  dependencies: NativeCliProjectRuntimeCleanupAdapterDependencies,
): Promise<ProjectRuntimeResource[]> {
  const resources: ProjectRuntimeResource[] = dependencies.listSessions(provider, scope)
    .map((session) => nativeSessionResource(provider, session));
  const projectLabelValue = hashNativeCliProjectRuntimeLabelIdentity(scope.projectIdentity.id);
  const containers = await listContainersByLabel(
    dependencies.executor,
    NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL,
    projectLabelValue,
    { [NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]: provider },
  );
  for (const inspect of containers) {
    const labels = inspect.Config?.Labels || {};
    if (
      labels[NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL] !== projectLabelValue
      || labels[NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL] !== provider
    ) {
      throw new Error(`${provider} Project container labels did not match its runtime identity`);
    }
    const actorUserId = actorForLabel(
      scope,
      String(labels[NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL] || ''),
      hashNativeCliProjectRuntimeLabelIdentity,
    );
    if (!actorUserId) {
      throw new Error(`${provider} Project container actor could not be bound to a known Project actor`);
    }
    assertProjectMountBoundary(inspect, scope);
    resources.push(Object.freeze({
      id: `runtime-container:${String(inspect.Id || '').toLowerCase()}`,
      kind: 'NATIVE_RUNTIME_CONTAINER',
      projectIdentityId: scope.projectIdentity.id,
      actorUserId,
      provider,
    }));
  }
  for (const actorUserId of scope.knownActorIds) {
    const stateIdentity = {
      provider,
      userId: actorUserId,
      projectId: scope.projectIdentity.id,
      projectRoot: scope.projectIdentity.canonicalRoot,
    } as const;
    if (dependencies.hasManagedState(stateIdentity)) {
      resources.push(Object.freeze({
        id: `native-credential:${stableEvidence(stateIdentity)}`,
        kind: 'NATIVE_CREDENTIAL',
        projectIdentityId: scope.projectIdentity.id,
        actorUserId,
        provider,
      }));
    }
  }
  return resources;
}

export function createNativeCliProjectRuntimeCleanupAdapter(
  provider: NativeCliProjectRuntimeProvider,
  overrides: Partial<NativeCliProjectRuntimeCleanupAdapterDependencies> = {},
): ProjectRuntimeCleanupAdapter {
  const dependencies = { ...defaultNativeCliProjectDependencies, ...overrides };
  return {
    provider,
    enumerate: (scope) => listNativeCliProjectResources(provider, scope, dependencies),
    async quiesceTurn(scope, turn) {
      if (turn.provider !== provider || !turn.providerSessionId) {
        throw new Error(`${provider} Project turn lacks an authoritative provider session identity`);
      }
      const matchingSessions = dependencies.listSessions(provider, scope).filter((session) => (
        session.sessionId === turn.providerSessionId
        && session.userId === turn.actorUserId
        && session.executionContext?.scope === 'PROJECT_SANDBOX'
        && session.executionContext.projectId === scope.projectIdentity.id
      ));
      if (matchingSessions.length !== 1) {
        throw new Error(`${provider} Project turn session could not be bound to the immutable actor and project`);
      }
      const providerAborted = await dependencies.abortSession(provider, turn.providerSessionId, turn.id);
      if (!providerAborted) {
        throw new Error(
          `${provider} Project turn could not be authoritatively aborted for the expected durable run.`,
        );
      }
      return {
        quiesced: true,
        evidence: `${provider.toLowerCase()}-${stableEvidence({
          turnId: turn.id,
          providerSessionId: turn.providerSessionId,
          providerAborted,
        })}`,
      };
    },
    async cleanup(scope, resources) {
      const currentSessions = dependencies.listSessions(provider, scope);
      for (const resource of resources.filter((entry) => entry.kind === 'NATIVE_SESSION')) {
        const sessionId = resource.id.slice('native-session:'.length);
        const matching = currentSessions.filter((session) => (
          session.sessionId === sessionId
          && session.userId === resource.actorUserId
          && session.executionContext?.scope === 'PROJECT_SANDBOX'
          && session.executionContext.projectId === scope.projectIdentity.id
        ));
        if (matching.length !== 1) {
          throw new Error(`${provider} Project session changed before runtime cleanup`);
        }
        await dependencies.abortSession(provider, sessionId);
        await dependencies.terminateSession(provider, sessionId);
        dependencies.deleteSession(provider, sessionId);
      }
      const projectLabelValue = hashNativeCliProjectRuntimeLabelIdentity(scope.projectIdentity.id);
      for (const resource of resources.filter((entry) => entry.kind === 'NATIVE_RUNTIME_CONTAINER')) {
        await removeAttestedContainer({
          executor: dependencies.executor,
          containerId: containerIdFromResource(resource),
          projectLabel: NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL,
          projectLabelValue,
          scope,
        });
      }
      for (const actorUserId of scope.knownActorIds) {
        dependencies.removeManagedState({
          provider,
          userId: actorUserId,
          projectId: scope.projectIdentity.id,
          projectRoot: scope.projectIdentity.canonicalRoot,
        });
      }
    },
    verifyClean: (scope) => listNativeCliProjectResources(provider, scope, dependencies),
  };
}

function agentZeroSessionResource(session: NativeSessionData): ProjectRuntimeResource {
  if (!session.executionContext || session.executionContext.scope !== 'PROJECT_SANDBOX') {
    throw new Error('Agent Zero Project session lost its sandbox execution context');
  }
  return Object.freeze({
    id: `agent-zero-session:${session.sessionId}`,
    kind: 'AGENT_ZERO_SESSION',
    projectIdentityId: session.executionContext.projectId,
    actorUserId: session.userId,
    provider: 'AGENT_ZERO',
  });
}

function agentZeroManagedResource(value: AgentZeroProjectRuntimeResource): ProjectRuntimeResource {
  const kind = (() => {
    switch (value.kind) {
      case 'CONTAINER': return 'AGENT_ZERO_CONTAINER' as const;
      case 'NETWORK_MEMBERSHIP': return 'AGENT_ZERO_NETWORK' as const;
      case 'DATA_VOLUME': return 'AGENT_ZERO_VOLUME' as const;
      case 'FIREWALL_CHAIN': return 'AGENT_ZERO_FIREWALL' as const;
      case 'CREDENTIAL_FILE':
      case 'QUALIFICATION_FILE':
      case 'STATE_DIRECTORY':
      case 'MODEL_BRIDGE_ENV_FILE':
      case 'MODEL_BRIDGE_CREDENTIAL':
        return 'AGENT_ZERO_CREDENTIAL' as const;
      default: {
        const exhaustive: never = value.kind;
        throw new Error(`Unsupported Agent Zero cleanup resource kind: ${exhaustive}`);
      }
    }
  })();
  return Object.freeze({
    id: `agent-zero-runtime:${stableEvidence({
      kind: value.kind,
      name: value.name,
      snapshot: value.snapshotFingerprint,
    })}`,
    kind,
    projectIdentityId: value.projectIdentityId,
    actorUserId: value.actorUserId,
    provider: 'AGENT_ZERO',
  });
}

async function listAgentZeroResources(
  scope: ProjectRuntimeCleanupScope,
  dependencies: AgentZeroProjectRuntimeCleanupAdapterDependencies,
): Promise<ProjectRuntimeResource[]> {
  const sessionRows = dependencies.listSessions(scope);
  const sessions = sessionRows.map(agentZeroSessionResource);
  const knownActorIds = Object.freeze(Array.from(new Set([
    ...scope.knownActorIds,
    ...sessionRows.map((session) => session.userId),
  ])).sort());
  const managed = await dependencies.discover(scope.projectIdentity.id, {
    knownActorIds,
  });
  return [...sessions, ...managed.map(agentZeroManagedResource)];
}

export function createAgentZeroProjectRuntimeCleanupAdapter(
  overrides: Partial<AgentZeroProjectRuntimeCleanupAdapterDependencies> = {},
): ProjectRuntimeCleanupAdapter {
  const dependencies = { ...defaultAgentZeroDependencies, ...overrides };
  return {
    provider: 'AGENT_ZERO',
    enumerate: (scope) => listAgentZeroResources(scope, dependencies),
    async quiesceTurn(scope, turn) {
      if (!turn.providerSessionId) {
        throw new Error('Agent Zero Project turn lacks an authoritative provider session identity');
      }
      const matches = dependencies.listSessions(scope).filter((session) => (
        session.sessionId === turn.providerSessionId
        && session.userId === turn.actorUserId
        && session.executionContext?.scope === 'PROJECT_SANDBOX'
        && session.executionContext.projectId === scope.projectIdentity.id
      ));
      if (matches.length !== 1 || matches[0].executionContext?.scope !== 'PROJECT_SANDBOX') {
        throw new Error('Agent Zero Project turn session could not be bound to the immutable actor and project');
      }
      const activeRunId = String(matches[0].metadata?.agentZeroActiveRunId || '').trim();
      if (!activeRunId || activeRunId !== turn.id) {
        throw new Error(
          'Agent Zero Project turn run identity changed before cleanup; a newer runtime was left untouched',
        );
      }
      const providerAbort = await dependencies.abortSession(turn.providerSessionId, turn.id);
      if (!providerAbort && !dependencies.hardAbort(matches[0].executionContext)) {
        throw new Error('Agent Zero Project turn could not be authoritatively aborted and re-attested');
      }
      return {
        quiesced: true,
        evidence: `agent-zero-${stableEvidence({
          turnId: turn.id,
          sessionId: turn.providerSessionId,
          projectIdentityId: scope.projectIdentity.id,
          actorUserId: turn.actorUserId,
        })}`,
      };
    },
    async cleanup(scope, resources) {
      const sessions = dependencies.listSessions(scope);
      const actorUserIds = cleanupActorIds(scope, resources);
      for (const resource of resources.filter((entry) => entry.kind === 'AGENT_ZERO_SESSION')) {
        const sessionId = resource.id.slice('agent-zero-session:'.length);
        const matching = sessions.filter((session) => (
          session.sessionId === sessionId
          && session.userId === resource.actorUserId
          && session.executionContext?.scope === 'PROJECT_SANDBOX'
          && session.executionContext.projectId === scope.projectIdentity.id
        ));
        if (matching.length !== 1) {
          throw new Error('Agent Zero Project session changed before runtime cleanup');
        }
        // Deleting a project removes the exact attested Agent Zero container and
        // data volume below. Do not reopen a session through OAuth here: a hard
        // abort intentionally invalidates the prior start-bound qualification,
        // and revoked OAuth must not make an otherwise-contained project
        // impossible to delete.
        dependencies.deleteSession(sessionId);
      }
      await dependencies.teardown(scope.projectIdentity.id, {
        knownActorIds: actorUserIds,
      });
      const remaining = await listAgentZeroResources(scope, dependencies);
      if (remaining.length !== 0) {
        throw new Error(
          'Agent Zero Project runtime remained after teardown; provider state stays quarantined',
        );
      }
      for (const actorUserId of actorUserIds) {
        await dependencies.convergeInMemoryState(cleanupAttestation(
          scope,
          actorUserId,
          cleanupSessionIds(scope, 'AGENT_ZERO', resources, actorUserId),
        ));
      }
    },
    verifyClean: (scope) => listAgentZeroResources(scope, dependencies),
  };
}

async function listOllamaProjectResources(
  scope: ProjectRuntimeCleanupScope,
  dependencies: OllamaProjectRuntimeCleanupAdapterDependencies,
): Promise<ProjectRuntimeResource[]> {
  const sessions = dependencies.listSessions(scope);
  const discoveryScope: ProjectRuntimeCleanupScope = Object.freeze({
    ...scope,
    knownActorIds: Object.freeze(Array.from(new Set([
      ...scope.knownActorIds,
      ...sessions.map((session) => session.userId),
    ])).sort()),
  });
  const resources: ProjectRuntimeResource[] = sessions
    .map((session) => nativeSessionResource('OLLAMA', session));
  const projectLabelValue = hashOllamaProjectRuntimeIdentity(scope.projectIdentity.id);
  const containers = await listContainersByLabel(
    dependencies.executor,
    OLLAMA_PROJECT_IDENTITY_LABEL,
    projectLabelValue,
    { [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA' },
  );
  for (const inspect of containers) {
    const labels = inspect.Config?.Labels || {};
    if (
      labels[OLLAMA_PROJECT_IDENTITY_LABEL] !== projectLabelValue
      || labels[OLLAMA_PROJECT_PROVIDER_LABEL] !== 'OLLAMA'
      || labels[OLLAMA_PROJECT_POLICY_LABEL] !== OLLAMA_PROJECT_RUNTIME_POLICY_VERSION
    ) {
      throw new Error('Ollama Project container labels did not match its runtime identity');
    }
    const actorUserId = actorForLabel(
      discoveryScope,
      String(labels[OLLAMA_PROJECT_ACTOR_LABEL] || ''),
      hashOllamaProjectRuntimeIdentity,
    );
    if (!actorUserId) {
      throw new Error('Ollama Project container actor could not be bound to a known Project actor');
    }
    assertProjectMountBoundary(inspect, scope);
    resources.push(Object.freeze({
      id: `runtime-container:${String(inspect.Id || '').toLowerCase()}`,
      kind: 'NATIVE_RUNTIME_CONTAINER',
      projectIdentityId: scope.projectIdentity.id,
      actorUserId,
      provider: 'OLLAMA',
    }));
  }
  return resources;
}

export function createOllamaProjectRuntimeCleanupAdapter(
  overrides: Partial<OllamaProjectRuntimeCleanupAdapterDependencies> = {},
): ProjectRuntimeCleanupAdapter {
  const dependencies = { ...defaultOllamaProjectDependencies, ...overrides };
  return {
    provider: 'OLLAMA',
    enumerate: (scope) => listOllamaProjectResources(scope, dependencies),
    async quiesceTurn(scope, turn) {
      if (turn.provider !== 'OLLAMA' || !turn.providerSessionId) {
        throw new Error('Ollama Project turn lacks an authoritative provider session identity');
      }
      const matchingSessions = dependencies.listSessions(scope).filter((session) => (
        session.sessionId === turn.providerSessionId
        && session.userId === turn.actorUserId
        && session.executionContext?.scope === 'PROJECT_SANDBOX'
        && session.executionContext.projectId === scope.projectIdentity.id
      ));
      if (matchingSessions.length !== 1) {
        throw new Error('Ollama Project turn session could not be bound to the immutable actor and project');
      }
      // The broker/provider run id is the durable ProjectChatTurn id, not the
      // user-message requestId. Binding it here prevents a stale deletion
      // snapshot from aborting a newer turn that reused the provider session.
      const providerAborted = await dependencies.abortSession(turn.providerSessionId, turn.id);
      if (!providerAborted) {
        throw new Error(
          'Ollama Project turn could not be authoritatively aborted for the expected durable run.',
        );
      }
      const projectLabelValue = hashOllamaProjectRuntimeIdentity(scope.projectIdentity.id);
      const containers = await listContainersByLabel(
        dependencies.executor,
        OLLAMA_PROJECT_IDENTITY_LABEL,
        projectLabelValue,
        { [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA' },
      );
      for (const inspect of containers) {
        const labels = inspect.Config?.Labels || {};
        if (
          labels[OLLAMA_PROJECT_PROVIDER_LABEL] !== 'OLLAMA'
          || labels[OLLAMA_PROJECT_POLICY_LABEL] !== OLLAMA_PROJECT_RUNTIME_POLICY_VERSION
        ) {
          throw new Error('Ollama Project abort encountered an untrusted runtime');
        }
        assertProjectMountBoundary(inspect, scope);
        const stopped = await inspectContainer(dependencies.executor, String(inspect.Id));
        if (stopped?.State?.Running) {
          // Do not stop this object from the cleanup lane. A running container
          // after the run-bound provider proof can only be an unproven race or
          // replacement, and killing it could terminate a newer turn.
          throw new Error('Ollama Project runtime appeared after its run-bound abort proof');
        }
      }
      return {
        quiesced: true,
        evidence: `ollama-${stableEvidence({
          turnId: turn.id,
          providerSessionId: turn.providerSessionId,
          providerAborted,
          containers: containers.map((entry) => entry.Id),
        })}`,
      };
    },
    async cleanup(scope, resources) {
      const currentSessions = dependencies.listSessions(scope);
      const actorUserIds = cleanupActorIds(scope, resources);
      for (const resource of resources.filter((entry) => entry.kind === 'NATIVE_SESSION')) {
        const sessionId = resource.id.slice('native-session:'.length);
        const matching = currentSessions.filter((session) => (
          session.sessionId === sessionId
          && session.userId === resource.actorUserId
          && session.executionContext?.scope === 'PROJECT_SANDBOX'
          && session.executionContext.projectId === scope.projectIdentity.id
        ));
        if (matching.length !== 1) {
          throw new Error('Ollama Project session changed before runtime cleanup');
        }
        // Active turns are quiesced before cleanup. From this point the exact
        // immutable-label container removal below is the authoritative stop
        // path; reopening the provider session would make cleanup depend on a
        // now-drifted model/runtime configuration after a backend restart.
        dependencies.deleteSession(sessionId);
      }
      const projectLabelValue = hashOllamaProjectRuntimeIdentity(scope.projectIdentity.id);
      for (const resource of resources.filter((entry) => entry.kind === 'NATIVE_RUNTIME_CONTAINER')) {
        await removeAttestedContainer({
          executor: dependencies.executor,
          containerId: containerIdFromResource(resource),
          projectLabel: OLLAMA_PROJECT_IDENTITY_LABEL,
          projectLabelValue,
          scope,
        });
      }
      const remaining = await listOllamaProjectResources(scope, dependencies);
      if (remaining.length !== 0) {
        throw new Error(
          'Ollama Project runtime remained after teardown; provider state stays quarantined',
        );
      }
      for (const actorUserId of actorUserIds) {
        await dependencies.convergeInMemoryState(cleanupAttestation(
          scope,
          actorUserId,
          cleanupSessionIds(scope, 'OLLAMA', resources, actorUserId),
        ));
      }
    },
    verifyClean: (scope) => listOllamaProjectResources(scope, dependencies),
  };
}

/** Providers that have never passed the Project Sandbox gate may prove only
 * absence. Any legacy binding, turn, or exact native Project session blocks
 * deletion for manual containment rather than guessing that an orphan process
 * is harmless. */
export function createUnavailableProjectRuntimeAbsenceAdapter(
  provider: Exclude<ProjectRuntimeCleanupProvider, 'OPENCLAW' | 'CODEX'>,
): ProjectRuntimeCleanupAdapter {
  const scan = async (scope: ProjectRuntimeCleanupScope): Promise<readonly ProjectRuntimeResource[]> => {
    const hasDurableState = scope.bindings.some((entry) => providerMatches(entry.provider, provider))
      || scope.sessions.some((entry) => providerMatches(entry.activeProvider, provider))
      || scope.activeTurns.some((entry) => entry.provider === provider);
    const nativeProvider = exactNativeProvider(provider);
    const sessions = nativeProvider ? nativeSessionsForScope(nativeProvider, scope) : [];
    if (hasDurableState || sessions.length > 0) {
      throw new Error(`${provider} has unqualified Project runtime state; automatic deletion is disabled`);
    }
    return Object.freeze([]);
  };
  return {
    provider,
    enumerate: scan,
    async quiesceTurn(_scope: ProjectRuntimeCleanupScope, _turn: ProjectRuntimeCleanupTurn) {
      throw new Error(`${provider} has no qualified Project turn abort path`);
    },
    async cleanup(_scope, resources) {
      if (resources.length > 0) throw new Error(`${provider} Project resources cannot be safely deleted`);
    },
    verifyClean: scan,
  };
}

export function createDefaultProjectRuntimeCleanupAdapters(): Readonly<Record<
  ProjectRuntimeCleanupProvider,
  ProjectRuntimeCleanupAdapter
>> {
  return Object.freeze({
    OPENCLAW: createOpenClawProjectRuntimeCleanupAdapter(),
    CLAUDE_CODE: createNativeCliProjectRuntimeCleanupAdapter('CLAUDE_CODE'),
    CODEX: createCodexProjectRuntimeCleanupAdapter(),
    AGENT_ZERO: createAgentZeroProjectRuntimeCleanupAdapter(),
    GEMINI: createNativeCliProjectRuntimeCleanupAdapter('GEMINI'),
    OLLAMA: createOllamaProjectRuntimeCleanupAdapter(),
    GROK_BUILD: createUnavailableProjectRuntimeAbsenceAdapter('GROK_BUILD'),
  } satisfies Record<ProjectRuntimeCleanupProvider, ProjectRuntimeCleanupAdapter>);
}

export const __projectRuntimeCleanupAdaptersTest = {
  PROJECT_RUNTIME_CLEANUP_PROVIDERS,
  parseDockerInspect,
};
