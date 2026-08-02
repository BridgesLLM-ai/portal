import type { ProjectEgressCommandExecutor, ProjectEgressCommandResult } from './projectEgressPlane';
import type { ProjectRuntimeCleanupScope } from './projectRuntimeCleanup';
import {
  OPENCLAW_PROJECT_ACTOR_LABEL,
  OPENCLAW_PROJECT_AGENT_LABEL,
  OPENCLAW_PROJECT_IDENTITY_LABEL,
  deriveOpenClawProjectAgentId,
  deriveOpenClawProjectSessionKey,
  hashOpenClawProjectLabelIdentity,
} from './openclawProjectSandbox';
import {
  CODEX_PROJECT_RUNTIME_ACTOR_LABEL,
  CODEX_PROJECT_RUNTIME_IDENTITY_LABEL,
  hashCodexProjectRuntimeLabelIdentity,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL,
  NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL,
  NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL,
  hashNativeCliProjectRuntimeLabelIdentity,
} from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import {
  OLLAMA_PROJECT_ACTOR_LABEL,
  OLLAMA_PROJECT_IDENTITY_LABEL,
  OLLAMA_PROJECT_POLICY_LABEL,
  OLLAMA_PROJECT_PROVIDER_LABEL,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  hashOllamaProjectRuntimeIdentity,
} from '../agents/providers/ollama/OllamaProjectToolRuntime';
import {
  createAgentZeroProjectRuntimeCleanupAdapter,
  createCodexProjectRuntimeCleanupAdapter,
  createNativeCliProjectRuntimeCleanupAdapter,
  createOllamaProjectRuntimeCleanupAdapter,
  createOpenClawProjectRuntimeCleanupAdapter,
  createUnavailableProjectRuntimeAbsenceAdapter,
} from './projectRuntimeCleanupAdapters';
import type { NativeSessionData } from '../agents/providers/NativeSessionStore';
import type { AgentZeroProjectRuntimeResource } from '../agents/providers/agentZero/AgentZeroProjectCleanup';
import type { AttestedProjectRuntimeCleanup } from '../agents/AgentProvider.interface';

const ACTOR = 'actor-1';
const PROJECT_ID = 'immutable-project-uuid';
const PROJECT_ROOT = '/srv/projects/demo';
const CONTAINER_ID = 'a'.repeat(64);

function scope(overrides: Partial<ProjectRuntimeCleanupScope> = {}): ProjectRuntimeCleanupScope {
  return {
    authenticatedActorId: ACTOR,
    workspaceOwnerId: 'owner-1',
    projectIdentity: {
      id: PROJECT_ID,
      workspaceOwnerId: 'owner-1',
      projectName: 'demo',
      canonicalRoot: PROJECT_ROOT,
      rootDevice: '8',
      rootInode: '404',
      rootBirthtimeNs: '1000000000',
      generation: 1,
      lifecycleStatus: 'DELETING',
      deletionStartedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    knownActorIds: [ACTOR],
    bindings: [],
    sessions: [],
    activeTurns: [],
    ...overrides,
  };
}

class FakeDocker implements ProjectEgressCommandExecutor {
  container: Record<string, any> | null;
  calls: string[][] = [];

  constructor(container: Record<string, any> | null) {
    this.container = container;
  }

  async run(_command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> {
    this.calls.push([...args]);
    if (args[0] === 'container' && args[1] === 'ls') {
      return { stdout: this.container ? `${CONTAINER_ID}\n` : '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return this.container
        ? { stdout: JSON.stringify([this.container]), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'not found', exitCode: 1 };
    }
    if (args[0] === 'container' && args[1] === 'stop') {
      if (this.container) this.container.State.Running = false;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      this.container = null;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected Docker call: ${args.join(' ')}`);
  }
}

function container(labels: Record<string, string>): Record<string, any> {
  return {
    Id: CONTAINER_ID,
    Name: '/project-runtime',
    Config: { Labels: labels },
    State: { Running: true },
    Mounts: [{ Source: PROJECT_ROOT, Destination: '/workspace/project', RW: true }],
  };
}

function nativeProjectSession(provider: 'CLAUDE_CODE' | 'GEMINI'): NativeSessionData {
  return {
    sessionId: `${provider.toLowerCase()}-session-1`,
    provider,
    userId: ACTOR,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cwd: PROJECT_ROOT,
    messages: [],
    executionContext: {
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: ACTOR,
      projectId: PROJECT_ID,
      workspaceOwnerId: 'owner-1',
      projectName: 'demo',
      canonicalRoot: PROJECT_ROOT,
      rootDevice: '8',
      rootInode: '404',
      rootBirthtimeNs: '1000000000',
      runtimePolicyVersion: `portal-${provider.toLowerCase()}-project-v1`,
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'d'.repeat(64)}`,
      policyFingerprint: 'e'.repeat(64),
    },
    metadata: { projectRuntime: `${provider.toLowerCase()}-project-v1` },
  };
}

function ollamaProjectSession(
  actorUserId = ACTOR,
  sessionId = 'ollama-session-1',
): NativeSessionData {
  return {
    sessionId,
    provider: 'OLLAMA',
    userId: actorUserId,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cwd: PROJECT_ROOT,
    messages: [],
    executionContext: {
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: actorUserId,
      projectId: PROJECT_ID,
      workspaceOwnerId: 'owner-1',
      projectName: 'demo',
      canonicalRoot: PROJECT_ROOT,
      rootDevice: '8',
      rootInode: '404',
      rootBirthtimeNs: '1000000000',
      runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'d'.repeat(64)}`,
      policyFingerprint: 'e'.repeat(64),
    },
    metadata: { projectRuntime: 'ollama-project-coding-agent-v1' },
  };
}

describe('concrete Project runtime cleanup adapters', () => {
  test('OpenClaw enumerates and removes only the immutable actor/project resources', async () => {
    const agentId = deriveOpenClawProjectAgentId({ userId: ACTOR, projectId: PROJECT_ID });
    const sessionKey = deriveOpenClawProjectSessionKey({ userId: ACTOR, projectId: PROJECT_ID });
    const docker = new FakeDocker(container({
      [OPENCLAW_PROJECT_IDENTITY_LABEL]: hashOpenClawProjectLabelIdentity(PROJECT_ID),
      [OPENCLAW_PROJECT_ACTOR_LABEL]: hashOpenClawProjectLabelIdentity(ACTOR),
      [OPENCLAW_PROJECT_AGENT_LABEL]: agentId,
      'openclaw.sessionKey': sessionKey,
    }));
    let agentPresent = true;
    let sessionPresent = true;
    const rpc = jest.fn(async (method: string) => {
      if (method === 'config.get') {
        return { ok: true, data: { config: { agents: { list: agentPresent ? [{ id: agentId }] : [] } } } };
      }
      if (method === 'sessions.list') {
        return { ok: true, data: { sessions: sessionPresent ? [{ key: sessionKey }] : [] } };
      }
      if (method === 'chat.abort') return { ok: true, data: { aborted: false } };
      if (method === 'agents.delete') {
        agentPresent = false;
        return { ok: true, data: { deleted: true } };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const adapter = createOpenClawProjectRuntimeCleanupAdapter({
      executor: docker,
      rpc,
      deleteOpenClawSession: async () => {
        sessionPresent = false;
        return { ok: true };
      },
    });

    const resources = await adapter.enumerate(scope());
    expect(resources.map((resource) => resource.kind).sort()).toEqual([
      'OPENCLAW_AGENT',
      'OPENCLAW_CONTAINER',
      'OPENCLAW_SESSION',
    ]);
    await adapter.cleanup(scope(), resources);
    await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
    expect(docker.container).toBeNull();
  });

  test('OpenClaw discovers owner-qualified config residue without a binding during SUB_ADMIN cleanup', async () => {
    const ownerId = 'owner-1';
    const subAdminId = 'sub-admin-1';
    const agentId = deriveOpenClawProjectAgentId({ userId: ownerId, projectId: PROJECT_ID });
    const sessionKey = deriveOpenClawProjectSessionKey({ userId: ownerId, projectId: PROJECT_ID });
    const rpc = jest.fn(async (method: string) => {
      if (method === 'config.get') {
        return { ok: true, data: { config: { agents: { list: [{ id: agentId }] } } } };
      }
      if (method === 'sessions.list') {
        return { ok: true, data: { sessions: [{ key: sessionKey }] } };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const adapter = createOpenClawProjectRuntimeCleanupAdapter({
      executor: new FakeDocker(null),
      rpc,
    });
    const deletionScope = scope({
      authenticatedActorId: subAdminId,
      knownActorIds: [ownerId, subAdminId],
      bindings: [],
      sessions: [],
    });

    await expect(adapter.enumerate(deletionScope)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'OPENCLAW_AGENT',
        actorUserId: ownerId,
        id: `openclaw-agent:${agentId}`,
      }),
      expect.objectContaining({
        kind: 'OPENCLAW_SESSION',
        actorUserId: ownerId,
        id: `openclaw-session:${sessionKey}`,
      }),
    ]));
  });

  test('OpenClaw safely stages deletion when a sandboxed Project agent owns most of the config file', async () => {
    const agentId = deriveOpenClawProjectAgentId({ userId: ACTOR, projectId: PROJECT_ID });
    const projectAgent = {
      id: agentId,
      workspace: '/root/.openclaw/project-agents/test',
      model: { fallbacks: [] },
      models: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        `provider-${index}/*`,
        { agentRuntime: { id: 'openclaw' } },
      ])),
      tools: {
        allow: Array.from({ length: 20 }, (_, index) => `allowed-tool-${index}`),
        deny: Array.from({ length: 35 }, (_, index) => `denied-tool-${index}`),
      },
      sandbox: {
        mode: 'all',
        browser: { enabled: false, allowHostControl: false, autoStart: false, binds: [] },
        docker: {
          image: `sha256:${'a'.repeat(64)}`,
          containerPrefix: 'p4oc-test-',
          workdir: '/workspace/project',
          readOnlyRoot: true,
          tmpfs: Array.from({ length: 12 }, (_, index) => `/tmp-${index}:rw,noexec,size=1048576`),
          env: Object.fromEntries(Array.from({ length: 18 }, (_, index) => [
            `SAFE_ENV_${index}`,
            `value-${index}-${'x'.repeat(18)}`,
          ])),
          ulimits: { nofile: { soft: 1024, hard: 1024 }, nproc: { soft: 256, hard: 256 } },
          binds: Array.from({ length: 8 }, (_, index) => `/safe/source-${index}:/safe/target-${index}:ro`),
          network: 'project-internal',
          user: '1000:1000',
          capDrop: ['ALL'],
        },
      },
    };
    let config: Record<string, any> = {
      meta: { lastTouchedVersion: '2026.7.1-2' },
      gateway: { mode: 'local' },
      agents: { list: [projectAgent] },
    };
    let hashSequence = 1;
    const rpc = jest.fn(async (method: string, params: Record<string, any> = {}) => {
      if (method === 'config.get') {
        return { ok: true, data: { config: structuredClone(config), hash: `hash-${hashSequence}` } };
      }
      if (method === 'config.patch') {
        config = {
          ...config,
          agents: { ...config.agents, list: JSON.parse(params.raw).agents.list },
        };
        hashSequence += 1;
        return { ok: true, data: { hash: `hash-${hashSequence}` } };
      }
      if (method === 'agents.delete') {
        config = {
          ...config,
          agents: { ...config.agents, list: config.agents.list.filter((entry: any) => entry.id !== params.agentId) },
        };
        return { ok: true, data: { deleted: true } };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const adapter = createOpenClawProjectRuntimeCleanupAdapter({
      executor: new FakeDocker(null),
      rpc,
    });

    await adapter.cleanup(scope(), [{
      id: `openclaw-agent:${agentId}`,
      kind: 'OPENCLAW_AGENT',
      projectIdentityId: PROJECT_ID,
      actorUserId: ACTOR,
      provider: 'OPENCLAW',
    }]);

    expect(config.agents.list).toEqual([]);
    expect(rpc.mock.calls.filter(([method]) => method === 'config.patch').length).toBeGreaterThan(1);
    expect(rpc).toHaveBeenCalledWith('agents.delete', { agentId, deleteFiles: true }, 20_000);
  });

  test('OpenClaw retries the gateway session lifecycle CAS before failing cleanup', async () => {
    const sessionKey = deriveOpenClawProjectSessionKey({ userId: ACTOR, projectId: PROJECT_ID });
    let sessionPresent = true;
    const deleteOpenClawSession = jest.fn();
    const rpc = jest.fn(async (method: string) => {
      if (method === 'config.get') {
        return { ok: true, data: { config: { agents: { list: [] } } } };
      }
      if (method === 'sessions.list') {
        return { ok: true, data: { sessions: sessionPresent ? [{ key: sessionKey }] : [] } };
      }
      if (method === 'chat.abort') return { ok: true, data: { aborted: false } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    deleteOpenClawSession.mockImplementationOnce(async () => ({
      ok: false,
      error: `Session ${sessionKey} changed before deletion. Retry.`,
    }));
    deleteOpenClawSession.mockImplementationOnce(async () => {
      sessionPresent = false;
      return { ok: true };
    });
    const adapter = createOpenClawProjectRuntimeCleanupAdapter({
      executor: new FakeDocker(null),
      rpc,
      deleteOpenClawSession,
    });

    const resources = await adapter.enumerate(scope());
    await adapter.cleanup(scope(), resources);

    expect(deleteOpenClawSession).toHaveBeenCalledTimes(2);
    await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
  });

  test('OpenClaw bounds repeated session lifecycle CAS conflicts', async () => {
    const sessionKey = deriveOpenClawProjectSessionKey({ userId: ACTOR, projectId: PROJECT_ID });
    const deleteOpenClawSession = jest.fn(async () => ({
      ok: false,
      error: `Session ${sessionKey} changed before deletion. Retry.`,
    }));
    const rpc = jest.fn(async (method: string) => {
      if (method === 'config.get') {
        return { ok: true, data: { config: { agents: { list: [] } } } };
      }
      if (method === 'sessions.list') {
        return { ok: true, data: { sessions: [{ key: sessionKey }] } };
      }
      if (method === 'chat.abort') return { ok: true, data: { aborted: false } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    const adapter = createOpenClawProjectRuntimeCleanupAdapter({
      executor: new FakeDocker(null),
      rpc,
      deleteOpenClawSession,
    });

    const resources = await adapter.enumerate(scope());
    await expect(adapter.cleanup(scope(), resources)).rejects.toThrow(
      'OpenClaw Project session deletion failed',
    );
    expect(deleteOpenClawSession).toHaveBeenCalledTimes(3);
  });

  test('Codex container cleanup requires the immutable project label and exact writable root', async () => {
    const docker = new FakeDocker(container({
      [CODEX_PROJECT_RUNTIME_IDENTITY_LABEL]: hashCodexProjectRuntimeLabelIdentity(PROJECT_ID),
      [CODEX_PROJECT_RUNTIME_ACTOR_LABEL]: hashCodexProjectRuntimeLabelIdentity(ACTOR),
    }));
    const adapter = createCodexProjectRuntimeCleanupAdapter({ executor: docker });
    const resources = await adapter.enumerate(scope());
    expect(resources).toEqual([expect.objectContaining({
      kind: 'NATIVE_RUNTIME_CONTAINER',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
    })]);
    await adapter.cleanup(scope(), resources);
    await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
  });

  test.each(['CLAUDE_CODE', 'GEMINI'] as const)(
    '%s cleanup removes the exact native session, confined container, and managed credentials',
    async (provider) => {
      const docker = new FakeDocker(container({
        [NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(PROJECT_ID),
        [NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(ACTOR),
        [NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]: provider,
      }));
      const session = nativeProjectSession(provider);
      let sessionPresent = true;
      let managedStatePresent = true;
      const abortSession = jest.fn(async () => true);
      const terminateSession = jest.fn(async () => { sessionPresent = false; });
      const deleteSession = jest.fn(() => { sessionPresent = false; });
      const removeManagedState = jest.fn(() => { managedStatePresent = false; });
      const adapter = createNativeCliProjectRuntimeCleanupAdapter(provider, {
        executor: docker,
        listSessions: () => (sessionPresent ? [session] : []),
        abortSession,
        terminateSession,
        deleteSession,
        hasManagedState: () => managedStatePresent,
        removeManagedState,
      });

      const resources = await adapter.enumerate(scope());
      expect(docker.calls.some((args) => args.includes(
        `label=${NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL}=${provider}`,
      ))).toBe(true);
      expect(resources.map((resource) => resource.kind).sort()).toEqual([
        'NATIVE_CREDENTIAL',
        'NATIVE_RUNTIME_CONTAINER',
        'NATIVE_SESSION',
      ]);
      await adapter.cleanup(scope(), resources);
      expect(abortSession).toHaveBeenCalledWith(provider, session.sessionId);
      expect(terminateSession).toHaveBeenCalledWith(provider, session.sessionId);
      expect(deleteSession).toHaveBeenCalledWith(provider, session.sessionId);
      expect(removeManagedState).toHaveBeenCalledWith({
        provider,
        userId: ACTOR,
        projectId: PROJECT_ID,
        projectRoot: PROJECT_ROOT,
      });
      await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
    },
  );

  test('native CLI Project abort binds the durable run without broadly stopping its persistent container', async () => {
    const provider = 'CLAUDE_CODE' as const;
    const docker = new FakeDocker(container({
      [NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(PROJECT_ID),
      [NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(ACTOR),
      [NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]: provider,
    }));
    const session = nativeProjectSession(provider);
    const abortSession = jest.fn(async () => true);
    const adapter = createNativeCliProjectRuntimeCleanupAdapter(provider, {
      executor: docker,
      listSessions: () => [session],
      abortSession,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
      hasManagedState: () => false,
      removeManagedState: () => undefined,
    });

    await expect(adapter.quiesceTurn(scope(), {
      id: 'turn-native-1',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider,
      runtime: 'claude-code-project-v1',
      requestId: 'user-turn-native-1',
      status: 'RUNNING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).resolves.toEqual(expect.objectContaining({ quiesced: true }));
    expect(abortSession).toHaveBeenCalledWith(provider, session.sessionId, 'turn-native-1');
    expect(docker.container?.State.Running).toBe(true);
    expect(docker.calls.some((args) => args[0] === 'container' && args[1] === 'stop')).toBe(false);
  });

  test('native CLI Project cleanup rejects a stale durable run instead of killing a replacement', async () => {
    const provider = 'CLAUDE_CODE' as const;
    const docker = new FakeDocker(container({
      [NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(PROJECT_ID),
      [NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(ACTOR),
      [NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]: provider,
    }));
    const session = nativeProjectSession(provider);
    const abortSession = jest.fn(async () => false);
    const adapter = createNativeCliProjectRuntimeCleanupAdapter(provider, {
      executor: docker,
      listSessions: () => [session],
      abortSession,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
      hasManagedState: () => false,
      removeManagedState: () => undefined,
    });

    await expect(adapter.quiesceTurn(scope(), {
      id: 'stale-native-run',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider,
      runtime: 'claude-code-project-v1',
      requestId: 'user-turn-native-1',
      status: 'RUNNING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).rejects.toThrow(/expected durable run/i);
    expect(abortSession).toHaveBeenCalledWith(provider, session.sessionId, 'stale-native-run');
    expect(docker.container?.State.Running).toBe(true);
    expect(docker.calls.some((args) => args[0] === 'container' && args[1] === 'stop')).toBe(false);
  });

  test('native CLI cleanup rejects a container labeled for a different provider', async () => {
    const docker = new FakeDocker(container({
      [NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(PROJECT_ID),
      [NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(ACTOR),
      [NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]: 'GEMINI',
    }));
    const adapter = createNativeCliProjectRuntimeCleanupAdapter('CLAUDE_CODE', {
      executor: docker,
      listSessions: () => [],
      abortSession: async () => false,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
      hasManagedState: () => false,
      removeManagedState: () => undefined,
    });
    await expect(adapter.enumerate(scope())).rejects.toThrow(/another provider|runtime identity/);
  });

  test('Agent Zero maps managed resources and proves final absence through its teardown API', async () => {
    let present = true;
    const managed: AgentZeroProjectRuntimeResource = {
      kind: 'CONTAINER',
      name: 'bridgesllm-a0-project-test',
      projectIdentityId: PROJECT_ID,
      actorUserId: ACTOR,
      projectKey: 'b'.repeat(64),
      dockerId: CONTAINER_ID,
      networkName: 'bridgesllm-project-egress-test',
      firewallStatements: [],
      snapshotFingerprint: 'c'.repeat(64),
    };
    const teardown = jest.fn(async () => { present = false; });
    const adapter = createAgentZeroProjectRuntimeCleanupAdapter({
      discover: async () => (present ? [managed] : []),
      teardown,
      listSessions: () => [],
      abortSession: async () => false,
      deleteSession: () => undefined,
      hardAbort: () => true,
    });
    const resources = await adapter.enumerate(scope());
    expect(resources).toEqual([expect.objectContaining({
      kind: 'AGENT_ZERO_CONTAINER',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'AGENT_ZERO',
    })]);
    await adapter.cleanup(scope(), resources);
    expect(teardown).toHaveBeenCalledWith(PROJECT_ID, { knownActorIds: [ACTOR] });
    await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
  });

  test('Agent Zero project deletion removes the exact local session without reopening OAuth-qualified runtime state', async () => {
    const executionContext = {
      scope: 'PROJECT_SANDBOX' as const,
      source: 'PORTAL_SERVER' as const,
      userId: ACTOR,
      projectId: PROJECT_ID,
      workspaceOwnerId: 'owner-1',
      projectName: 'demo',
      canonicalRoot: PROJECT_ROOT,
      rootDevice: '8',
      rootInode: '404',
      rootBirthtimeNs: '1000000000',
      runtimePolicyVersion: 'agent-zero-project-sandbox-v1',
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'d'.repeat(64)}`,
      policyFingerprint: 'e'.repeat(64),
    };
    const session: NativeSessionData = {
      sessionId: 'agent-zero-session-delete',
      provider: 'AGENT_ZERO',
      userId: ACTOR,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: PROJECT_ROOT,
      messages: [],
      executionContext,
      metadata: { projectRuntime: 'agent-zero-project-v1' },
    };
    let sessions = [session];
    const deleteSession = jest.fn(() => { sessions = []; });
    const teardown = jest.fn(async () => undefined);
    const convergeInMemoryState = jest.fn(async (_input: AttestedProjectRuntimeCleanup) => undefined);
    const adapter = createAgentZeroProjectRuntimeCleanupAdapter({
      discover: async () => [],
      teardown,
      listSessions: () => sessions,
      abortSession: async () => false,
      deleteSession,
      hardAbort: () => true,
      convergeInMemoryState,
    });

    const resources = await adapter.enumerate(scope());
    await adapter.cleanup(scope(), resources);

    expect(deleteSession).toHaveBeenCalledWith(session.sessionId);
    expect(teardown).toHaveBeenCalledWith(PROJECT_ID, { knownActorIds: [ACTOR] });
    expect(convergeInMemoryState).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      projectId: PROJECT_ID,
      canonicalRoot: PROJECT_ROOT,
      sessionIds: [session.sessionId],
    }));
    await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
  });

  test('Agent Zero converges every attested resource actor even without a durable DB actor row', async () => {
    const otherActor = 'actor-2';
    const makeSession = (actorUserId: string, sessionId: string): NativeSessionData => ({
      sessionId,
      provider: 'AGENT_ZERO',
      userId: actorUserId,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: PROJECT_ROOT,
      messages: [],
      executionContext: {
        scope: 'PROJECT_SANDBOX',
        source: 'PORTAL_SERVER',
        userId: actorUserId,
        projectId: PROJECT_ID,
        workspaceOwnerId: 'owner-1',
        projectName: 'demo',
        canonicalRoot: PROJECT_ROOT,
        rootDevice: '8',
        rootInode: '404',
        rootBirthtimeNs: '1000000000',
        runtimePolicyVersion: 'agent-zero-project-sandbox-v1',
        egressPolicyVersion: 'portal-project-egress-v1',
        runtimeImageDigest: `sha256:${'d'.repeat(64)}`,
        policyFingerprint: 'e'.repeat(64),
      },
      metadata: { projectRuntime: 'agent-zero-project-v1' },
    });
    let sessions = [
      makeSession(ACTOR, 'agent-zero-actor-1'),
      makeSession(otherActor, 'agent-zero-actor-2'),
    ];
    const convergeInMemoryState = jest.fn(async (_input: AttestedProjectRuntimeCleanup) => undefined);
    const teardown = jest.fn(async () => undefined);
    const discover = jest.fn(async () => []);
    const adapter = createAgentZeroProjectRuntimeCleanupAdapter({
      discover,
      teardown,
      listSessions: () => sessions,
      abortSession: async () => false,
      deleteSession: (sessionId) => { sessions = sessions.filter((entry) => entry.sessionId !== sessionId); },
      hardAbort: () => true,
      convergeInMemoryState,
    });
    const cleanupScope = scope({ knownActorIds: [ACTOR] });
    const resources = await adapter.enumerate(cleanupScope);
    expect(discover).toHaveBeenCalledWith(PROJECT_ID, {
      knownActorIds: [ACTOR, otherActor],
    });
    await adapter.cleanup(cleanupScope, resources);
    expect(teardown).toHaveBeenCalledWith(PROJECT_ID, {
      knownActorIds: [ACTOR, otherActor],
    });
    expect(convergeInMemoryState.mock.calls.map(([attestation]) => ({
      userId: attestation.userId,
      sessionIds: attestation.sessionIds,
    }))).toEqual([
      { userId: ACTOR, sessionIds: ['agent-zero-actor-1'] },
      { userId: otherActor, sessionIds: ['agent-zero-actor-2'] },
    ]);
  });

  test('Agent Zero keeps provider reservations quarantined until teardown absence is re-attested', async () => {
    const managed: AgentZeroProjectRuntimeResource = {
      kind: 'CONTAINER',
      name: 'bridgesllm-a0-project-partial-cleanup',
      projectIdentityId: PROJECT_ID,
      actorUserId: ACTOR,
      projectKey: 'b'.repeat(64),
      dockerId: CONTAINER_ID,
      networkName: 'bridgesllm-project-egress-test',
      firewallStatements: [],
      snapshotFingerprint: 'c'.repeat(64),
    };
    const convergeInMemoryState = jest.fn(async () => undefined);
    const adapter = createAgentZeroProjectRuntimeCleanupAdapter({
      // Simulate a teardown command that returned successfully while its exact
      // immutable-label container remained. The provider singleton must retain
      // its quarantine/reservation until this fresh absence scan is clean.
      discover: async () => [managed],
      teardown: async () => undefined,
      listSessions: () => [],
      abortSession: async () => false,
      deleteSession: () => undefined,
      hardAbort: () => true,
      convergeInMemoryState,
    });

    const resources = await adapter.enumerate(scope());
    await expect(adapter.cleanup(scope(), resources)).rejects.toThrow(
      /remained after teardown.*quarantined/i,
    );
    expect(convergeInMemoryState).not.toHaveBeenCalled();
  });

  test('Agent Zero retry converges a journaled actor and session after artifacts disappeared', async () => {
    const otherActor = 'actor-2';
    const convergeInMemoryState = jest.fn(async (_input: AttestedProjectRuntimeCleanup) => undefined);
    const teardown = jest.fn(async () => undefined);
    const adapter = createAgentZeroProjectRuntimeCleanupAdapter({
      discover: async () => [],
      teardown,
      listSessions: () => [],
      abortSession: async () => false,
      deleteSession: () => undefined,
      hardAbort: () => true,
      convergeInMemoryState,
    });
    await adapter.cleanup(scope({
      knownActorIds: [ACTOR, otherActor],
      cleanupSessionEvidence: [{
        provider: 'AGENT_ZERO',
        actorUserId: otherActor,
        sessionId: 'journaled-agent-zero-session',
      }],
    }), []);
    expect(teardown).toHaveBeenCalledWith(PROJECT_ID, {
      knownActorIds: [ACTOR, otherActor],
    });
    expect(convergeInMemoryState).toHaveBeenCalledWith(expect.objectContaining({
      userId: otherActor,
      sessionIds: ['journaled-agent-zero-session'],
    }));
  });

  test('Agent Zero active-turn cleanup requires an exact session and hard-abort attestation', async () => {
    const executionContext = {
      scope: 'PROJECT_SANDBOX' as const,
      source: 'PORTAL_SERVER' as const,
      userId: ACTOR,
      projectId: PROJECT_ID,
      workspaceOwnerId: 'owner-1',
      projectName: 'demo',
      canonicalRoot: PROJECT_ROOT,
      rootDevice: '8',
      rootInode: '404',
      rootBirthtimeNs: '1000000000',
      runtimePolicyVersion: 'agent-zero-project-sandbox-v1',
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'d'.repeat(64)}`,
      policyFingerprint: 'e'.repeat(64),
    };
    const session: NativeSessionData = {
      sessionId: 'agent-zero-session-1',
      provider: 'AGENT_ZERO',
      userId: ACTOR,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: PROJECT_ROOT,
      messages: [],
      executionContext,
      metadata: {
        projectRuntime: 'agent-zero-project-v1',
        agentZeroActiveRunId: 'turn-1',
      },
    };
    const hardAbort = jest.fn(() => true);
    const abortSession = jest.fn(async () => false);
    const adapter = createAgentZeroProjectRuntimeCleanupAdapter({
      discover: async () => [],
      teardown: async () => undefined,
      listSessions: () => [session],
      abortSession,
      deleteSession: () => undefined,
      hardAbort,
    });
    await expect(adapter.quiesceTurn(scope(), {
      id: 'turn-1',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'AGENT_ZERO',
      runtime: 'agent-zero-project-v1',
      requestId: 'user-turn-1',
      status: 'RUNNING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).resolves.toEqual(expect.objectContaining({ quiesced: true }));
    expect(abortSession).toHaveBeenCalledWith(session.sessionId, 'turn-1');
    expect(hardAbort).toHaveBeenCalledWith(executionContext);

    abortSession.mockResolvedValue(true);
    hardAbort.mockClear();
    session.metadata!.agentZeroActiveRunId = 'turn-provider-abort';
    await expect(adapter.quiesceTurn(scope(), {
      id: 'turn-provider-abort',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'AGENT_ZERO',
      runtime: 'agent-zero-project-v1',
      requestId: 'user-turn-provider-abort',
      status: 'RUNNING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).resolves.toEqual(expect.objectContaining({ quiesced: true }));
    expect(abortSession).toHaveBeenLastCalledWith(session.sessionId, 'turn-provider-abort');
    expect(hardAbort).not.toHaveBeenCalled();

    abortSession.mockResolvedValue(false);
    hardAbort.mockReturnValue(false);
    session.metadata!.agentZeroActiveRunId = 'turn-2';
    await expect(adapter.quiesceTurn(scope(), {
      id: 'turn-2',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'AGENT_ZERO',
      runtime: 'agent-zero-project-v1',
      requestId: 'user-turn-2',
      status: 'ABORTING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).rejects.toThrow(/could not be authoritatively aborted/);

    session.metadata!.agentZeroActiveRunId = 'newer-turn';
    abortSession.mockClear();
    hardAbort.mockClear();
    await expect(adapter.quiesceTurn(scope(), {
      id: 'stale-cleanup-turn',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'AGENT_ZERO',
      runtime: 'agent-zero-project-v1',
      requestId: 'user-message-id-is-not-run-id',
      status: 'ABORTING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).rejects.toThrow(/run identity changed|newer runtime/i);
    expect(abortSession).not.toHaveBeenCalled();
    expect(hardAbort).not.toHaveBeenCalled();
  });

  test('Ollama cleanup removes the exact confined session and attested runtime container', async () => {
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(ACTOR),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    }));
    const session = ollamaProjectSession();
    let sessionPresent = true;
    const abortSession = jest.fn(async () => true);
    const terminateSession = jest.fn(async () => { sessionPresent = false; });
    const deleteSession = jest.fn(() => { sessionPresent = false; });
    const convergeInMemoryState = jest.fn(async () => undefined);
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => (sessionPresent ? [session] : []),
      abortSession,
      terminateSession,
      deleteSession,
      convergeInMemoryState,
    });

    const resources = await adapter.enumerate(scope());
    expect(docker.calls.some((args) => args.includes(
      `label=${OLLAMA_PROJECT_PROVIDER_LABEL}=OLLAMA`,
    ))).toBe(true);
    expect(resources.map((resource) => resource.kind).sort()).toEqual([
      'NATIVE_RUNTIME_CONTAINER',
      'NATIVE_SESSION',
    ]);
    await adapter.cleanup(scope(), resources);
    expect(abortSession).not.toHaveBeenCalled();
    expect(terminateSession).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith(session.sessionId);
    expect(convergeInMemoryState).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      projectId: PROJECT_ID,
      canonicalRoot: PROJECT_ROOT,
      sessionIds: [session.sessionId],
    }));
    await expect(adapter.verifyClean(scope())).resolves.toEqual([]);
  });

  test('Ollama converges every attested resource actor even without a durable DB actor row', async () => {
    const otherActor = 'actor-2';
    let sessions = [
      ollamaProjectSession(ACTOR, 'ollama-actor-1'),
      ollamaProjectSession(otherActor, 'ollama-actor-2'),
    ];
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(otherActor),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    }));
    const convergeInMemoryState = jest.fn(async (_input: AttestedProjectRuntimeCleanup) => undefined);
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => sessions,
      abortSession: async () => false,
      terminateSession: async () => undefined,
      deleteSession: (sessionId) => { sessions = sessions.filter((entry) => entry.sessionId !== sessionId); },
      convergeInMemoryState,
    });
    const cleanupScope = scope({ knownActorIds: [ACTOR] });
    const resources = await adapter.enumerate(cleanupScope);
    await adapter.cleanup(cleanupScope, resources);
    expect(docker.container).toBeNull();
    expect(convergeInMemoryState.mock.calls.map(([attestation]) => ({
      userId: attestation.userId,
      sessionIds: attestation.sessionIds,
    }))).toEqual([
      { userId: ACTOR, sessionIds: ['ollama-actor-1'] },
      { userId: otherActor, sessionIds: ['ollama-actor-2'] },
    ]);
  });

  test('Ollama keeps provider reservations quarantined until exact cleanup absence is re-attested', async () => {
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(ACTOR),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    }));
    const session = ollamaProjectSession();
    const convergeInMemoryState = jest.fn(async () => undefined);
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => [session],
      abortSession: async () => true,
      terminateSession: async () => undefined,
      // Simulate an unconfirmed/partial local artifact deletion. A fresh scan
      // must block releasing the provider's in-memory reservation.
      deleteSession: () => undefined,
      convergeInMemoryState,
    });

    const resources = await adapter.enumerate(scope());
    await expect(adapter.cleanup(scope(), resources)).rejects.toThrow(
      /remained after teardown.*quarantined/i,
    );
    expect(convergeInMemoryState).not.toHaveBeenCalled();
  });

  test('Ollama retry converges a journaled actor and session after artifacts disappeared', async () => {
    const otherActor = 'actor-2';
    const convergeInMemoryState = jest.fn(async (_input: AttestedProjectRuntimeCleanup) => undefined);
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: new FakeDocker(null),
      listSessions: () => [],
      abortSession: async () => false,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
      convergeInMemoryState,
    });
    await adapter.cleanup(scope({
      knownActorIds: [ACTOR, otherActor],
      cleanupSessionEvidence: [{
        provider: 'OLLAMA',
        actorUserId: otherActor,
        sessionId: 'journaled-ollama-session',
      }],
    }), []);
    expect(convergeInMemoryState).toHaveBeenCalledWith(expect.objectContaining({
      userId: otherActor,
      sessionIds: ['journaled-ollama-session'],
    }));
  });

  test('Ollama active-turn cleanup binds the exact session and proves its runtime stopped', async () => {
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(ACTOR),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    }));
    const session = ollamaProjectSession();
    const abortSession = jest.fn(async () => {
      docker.container = null;
      return true;
    });
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => [session],
      abortSession,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
    });

    await expect(adapter.quiesceTurn(scope(), {
      id: 'turn-ollama-1',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'OLLAMA',
      runtime: 'ollama-project-coding-agent-v1',
      requestId: 'user-turn-ollama-1',
      status: 'RUNNING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).resolves.toEqual(expect.objectContaining({ quiesced: true }));
    expect(abortSession).toHaveBeenCalledWith(session.sessionId, 'turn-ollama-1');
    expect(docker.container).toBeNull();
  });

  test('Ollama stale-turn cleanup cannot abort or stop a replacement run', async () => {
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(ACTOR),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    }));
    const session = ollamaProjectSession();
    const abortSession = jest.fn(async () => false);
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => [session],
      abortSession,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
    });

    await expect(adapter.quiesceTurn(scope(), {
      id: 'stale-ollama-run',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'OLLAMA',
      runtime: 'ollama-project-coding-agent-v1',
      requestId: 'user-message-id-is-not-the-run-id',
      status: 'ABORTING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).rejects.toThrow(/expected durable run/i);
    expect(abortSession).toHaveBeenCalledWith(session.sessionId, 'stale-ollama-run');
    expect(docker.container?.State.Running).toBe(true);
    expect(docker.calls.some((args) => args[0] === 'container' && args[1] === 'stop')).toBe(false);
  });

  test('Ollama quiesce rejects a runtime recreated after provider abort proof', async () => {
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(ACTOR),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    }));
    const session = ollamaProjectSession();
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => [session],
      abortSession: async () => true,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
    });

    await expect(adapter.quiesceTurn(scope(), {
      id: 'turn-ollama-raced-ensure',
      stateId: 'state-1',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      provider: 'OLLAMA',
      runtime: 'ollama-project-coding-agent-v1',
      requestId: 'user-turn-ollama-raced-ensure',
      status: 'ABORTING',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerSessionId: session.sessionId,
    })).rejects.toThrow(/appeared after its run-bound abort proof/i);
    expect(docker.container?.State.Running).toBe(true);
    expect(docker.calls.some((args) => args[0] === 'container' && args[1] === 'stop')).toBe(false);
  });

  test('Ollama cleanup rejects a container outside its exact policy identity', async () => {
    const docker = new FakeDocker(container({
      [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(PROJECT_ID),
      [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(ACTOR),
      [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
      [OLLAMA_PROJECT_POLICY_LABEL]: 'stale-ollama-policy',
    }));
    const adapter = createOllamaProjectRuntimeCleanupAdapter({
      executor: docker,
      listSessions: () => [],
      abortSession: async () => false,
      terminateSession: async () => undefined,
      deleteSession: () => undefined,
    });
    await expect(adapter.enumerate(scope())).rejects.toThrow(/runtime identity/);
  });

  test('runtime deletion rejects a container whose writable bind points at a sibling project', async () => {
    const unsafe = container({
      [CODEX_PROJECT_RUNTIME_IDENTITY_LABEL]: hashCodexProjectRuntimeLabelIdentity(PROJECT_ID),
      [CODEX_PROJECT_RUNTIME_ACTOR_LABEL]: hashCodexProjectRuntimeLabelIdentity(ACTOR),
    });
    unsafe.Mounts[0].Source = '/srv/projects/sibling';
    const adapter = createCodexProjectRuntimeCleanupAdapter({ executor: new FakeDocker(unsafe) });
    await expect(adapter.enumerate(scope())).rejects.toThrow(/writable mount/);
  });

  test('unqualified providers prove absence and reject durable residue', async () => {
    const adapter = createUnavailableProjectRuntimeAbsenceAdapter('GROK_BUILD');
    await expect(adapter.enumerate(scope())).resolves.toEqual([]);
    await expect(adapter.enumerate(scope({
      bindings: [{
        id: 'binding-1',
        userId: ACTOR,
        projectId: PROJECT_ID,
        provider: 'GROK_BUILD',
        runtime: 'grok-build',
        sessionKey: null,
        externalSessionId: null,
        status: 'active',
      }],
    }))).rejects.toThrow(/unqualified Project runtime state/);
  });
});
