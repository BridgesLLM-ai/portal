import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHostOperatorExecutionContext, createProjectSandboxExecutionContext } from '../agents/executionScope';
import {
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_RUNTIME,
  type AgentZeroProjectRuntimeHandle,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import type { AgentZeroProjectModelSelection } from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';

const PROJECT_IMAGE_ID = `sha256:${'d'.repeat(64)}`;

let root: string;
let sessionsRoot: string;
let projectRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zero-project-provider-'));
  sessionsRoot = path.join(root, 'sessions');
  projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsRoot;
  jest.resetModules();
});

afterEach(() => {
  delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
  fs.rmSync(root, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function context() {
  const rootStat = fs.statSync(projectRoot, { bigint: true });
  return createProjectSandboxExecutionContext({
    userId: 'owner',
    projectId: 'project-a',
    workspaceOwnerId: 'owner',
    projectName: 'project-a',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
    rootBirthtimeNs: rootStat.birthtimeNs.toString(),
    runtimePolicyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: PROJECT_IMAGE_ID,
    policyFingerprint: 'f'.repeat(64),
  });
}

function fakeRuntime(
  client: Record<string, jest.Mock>,
  modelSelection = { providerId: 'codex_oauth' as const, model: 'gpt-5.2-codex' },
): AgentZeroProjectRuntimeHandle {
  return {
    ready: true,
    selectable: true,
    reason: 'qualified',
    descriptor: {
      key: 'a'.repeat(64),
      actorUserId: 'owner',
      projectIdentityId: 'project-a',
      stateRoot: path.join(root, 'state'),
      stateDir: path.join(root, 'state', 'runtime'),
      identityFile: path.join(root, 'state', 'runtime', 'identity.json'),
      authFile: path.join(root, 'state', 'runtime', 'agent-zero.env'),
      modelBridgeEnvFile: path.join(root, 'state', 'runtime', 'model-bridge.env'),
      qualificationFile: path.join(root, 'state', 'runtime', 'qualification.json'),
      containerName: 'bridgesllm-a0p-test',
      dataVolume: 'bridgesllm-a0p-test-usr',
      canonicalProjectRoot: fs.realpathSync(projectRoot),
    },
    imageRef: PROJECT_IMAGE_ID,
    containerId: 'b'.repeat(64),
    containerStartedAt: '2026-07-19T00:00:00.000000000Z',
    baseUrl: 'http://127.0.0.1:49152',
    hostPort: 49152,
    egressPolicyFingerprint: 'e'.repeat(64),
    runtimeFingerprint: 'r'.repeat(64),
    internalNetworkName: 'bridgesllm-p4e-a0p-test-internal',
    bridgeGatewayIpv4: '172.31.0.1',
    modelBridgeBaseUrl: 'http://172.31.0.1:18991/oauth/codex/v1',
    modelBridgeCredentialHash: 'c'.repeat(64),
    modelBridgeCredentialGeneration: '22222222-2222-4222-8222-222222222222',
    modelSelection,
    modelPresetName: 'BridgesLLM Project OAuth aaaaaaaaaaaaaaaa',
    dataVolumeMountpoint: '/var/lib/docker/volumes/bridgesllm-a0p-test-usr/_data',
    structuralIsolation: true,
    volumeProvenance: true,
    egressPlaneReady: true,
    firewallReady: true,
    connectorReady: true,
    authenticated: true,
    hostGatewayDisconnected: true,
    qualificationCurrent: true,
    client: client as any,
    auth: {} as any,
  };
}

function client() {
  return {
    getCapabilities: jest.fn(async () => ({
      features: [
        'chat_create',
        'chat_delete',
        'message_send',
        'chat_reset',
        'launcher_gateway',
        'model_presets',
        'model_switcher',
      ],
    })),
    call: jest.fn(async (feature: string, payload: Record<string, any> = {}) => {
      if (feature === 'chat_create') return { context_id: 'A0ProjectContext1' };
      if (feature === 'model_switcher') {
        return {
          ok: true,
          allowed: true,
          effective_preset: payload.preset_name,
          main_model: { provider: 'codex_oauth', name: 'gpt-5.2-codex' },
          utility_model: { provider: 'codex_oauth', name: 'gpt-5.2-codex' },
        };
      }
      return { ok: true };
    }),
    streamMessage: jest.fn(async (request: any) => {
      request.onTransportStatus?.('connected');
      request.onEvent?.({
        contextId: request.contextId,
        sequence: 1,
        event: 'assistant_delta',
        timestamp: new Date().toISOString(),
        data: { text: 'hello' },
      });
      request.onEvent?.({
        contextId: request.contextId,
        sequence: 2,
        event: 'tool_start',
        timestamp: new Date().toISOString(),
        data: { heading: 'Project file edit' },
      });
      return {
        contextId: request.contextId,
        status: 'completed',
        response: { response: 'hello world' },
        lastSequence: 2,
        reconnects: 1,
        eventsProcessed: 2,
      };
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function startProvider(overrides: {
  streamMessage?: jest.Mock;
  hardAbort?: jest.Mock;
  abortSettlementTimeoutMs?: number;
} = {}) {
  const connector = client();
  if (overrides.streamMessage) connector.streamMessage = overrides.streamMessage;
  const runtime = fakeRuntime(connector);
  const runtimeResolver = jest.fn(async () => runtime);
  const hardAbort = overrides.hardAbort || jest.fn(() => true);
  const { AgentZeroProjectProvider } = require('../agents/providers/agentZero/AgentZeroProjectProvider') as typeof import('../agents/providers/agentZero/AgentZeroProjectProvider');
  const provider = new AgentZeroProjectProvider({
    runtimeResolver,
    hardAbort,
    abortSettlementTimeoutMs: overrides.abortSettlementTimeoutMs,
  });
  const sessionId = await provider.startSession('owner', {
    executionContext: context(),
    model: 'gpt-5.2-codex',
    metadata: { title: 'Project A', agentZeroOAuthProviderId: 'codex_oauth' },
  });
  return { provider, connector, runtimeResolver, hardAbort, sessionId };
}

describe('Agent Zero Project Sandbox provider', () => {
  test('creates only the logical project inside a separately-qualified runtime', async () => {
    const { connector, runtimeResolver, sessionId } = await startProvider();
    expect(sessionId).not.toBe('A0ProjectContext1');
    expect(runtimeResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'PROJECT_SANDBOX',
        projectId: 'project-a',
        canonicalRoot: fs.realpathSync(projectRoot),
      }),
      { providerId: 'codex_oauth', model: 'gpt-5.2-codex' },
    );
    expect(connector.call).toHaveBeenCalledWith('chat_create', { project_name: 'portal' });
    expect(connector.call).toHaveBeenCalledWith('model_switcher', {
      action: 'set_preset',
      context_id: 'A0ProjectContext1',
      preset_name: 'BridgesLLM Project OAuth aaaaaaaaaaaaaaaa',
    });

    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)).toMatchObject({
      userId: 'owner',
      cwd: '/a0/usr/projects/portal',
      executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-a' },
      metadata: {
        projectRuntime: AGENT_ZERO_PROJECT_RUNTIME,
        projectRuntimeKey: 'a'.repeat(64),
        agentZeroOAuthProviderId: 'codex_oauth',
        agentZeroModel: 'gpt-5.2-codex',
        agentZeroRemoteContextId: 'A0ProjectContext1',
      },
    });
  });

  test('keeps the Portal transcript identity stable while rebinding an exact OAuth model', async () => {
    const connector = client();
    let selected: AgentZeroProjectModelSelection = {
      providerId: 'codex_oauth',
      model: 'gpt-5.2-codex',
    };
    connector.call.mockImplementation(async (feature: string, payload: Record<string, any> = {}) => {
      if (feature === 'chat_create') return { context_id: 'A0StableRemoteContext' };
      if (feature === 'model_switcher') {
        return {
          ok: true,
          allowed: true,
          effective_preset: payload.preset_name,
          main_model: { provider: selected.providerId, name: selected.model },
          utility_model: { provider: selected.providerId, name: selected.model },
        };
      }
      return { ok: true };
    });
    const runtimeResolver = jest.fn(async (_context, selection) => {
      selected = selection;
      return fakeRuntime(connector, selection);
    });
    const { AgentZeroProjectProvider } = require('../agents/providers/agentZero/AgentZeroProjectProvider') as typeof import('../agents/providers/agentZero/AgentZeroProjectProvider');
    const provider = new AgentZeroProjectProvider({ runtimeResolver });
    const sessionId = await provider.startSession('owner', {
      executionContext: context(),
      model: 'gpt-5.2-codex',
      metadata: { agentZeroOAuthProviderId: 'codex_oauth' },
    });
    const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const before = store.loadNativeSession('AGENT_ZERO', sessionId)!;
    store.appendNativeMessage(before, {
      id: 'stable-history-message',
      role: 'user',
      content: 'keep this transcript',
      timestamp: '2026-07-20T12:00:00.000Z',
    });

    await provider.rebindSessionModel(sessionId, {
      providerId: 'gemini_api_oauth',
      model: 'gemini-3.1-pro',
    });

    expect(store.loadNativeSession('AGENT_ZERO', sessionId)).toMatchObject({
      sessionId,
      model: 'gemini-3.1-pro',
      metadata: {
        agentZeroRemoteContextId: 'A0StableRemoteContext',
        agentZeroOAuthProviderId: 'gemini_api_oauth',
        agentZeroModel: 'gemini-3.1-pro',
      },
    });
    expect(store.readAllNativeSessionHistory('AGENT_ZERO', sessionId)).toEqual([
      expect.objectContaining({ id: 'stable-history-message', content: 'keep this transcript' }),
    ]);
    expect(connector.call).toHaveBeenLastCalledWith('model_switcher', expect.objectContaining({
      context_id: 'A0StableRemoteContext',
      action: 'set_preset',
    }));
  });

  test('streams with replay/reconnect metadata and re-proves the isolated runtime every turn', async () => {
    const { provider, connector, runtimeResolver, sessionId } = await startProvider();
    const chunks: string[] = [];
    const events: any[] = [];
    await expect(provider.sendMessage(
      sessionId,
      'edit only this project',
      (chunk) => chunks.push(chunk),
      (event) => events.push(event),
      undefined,
      { label: 'owner@example.com', userId: 'owner', role: 'OWNER' },
    )).resolves.toMatchObject({
      fullText: 'hello world',
      metadata: {
        executionScope: 'PROJECT_SANDBOX',
        projectRuntime: AGENT_ZERO_PROJECT_RUNTIME,
        supportsAbort: true,
        reconnects: 1,
        lastSequence: 2,
      },
    });
    expect(runtimeResolver).toHaveBeenCalledTimes(2);
    expect(connector.streamMessage).toHaveBeenCalledWith(expect.objectContaining({
      contextId: 'A0ProjectContext1',
      fromSequence: 0,
    }));
    expect(chunks.join('')).toBe('hello world');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', content: 'Agent Zero Project Sandbox connected.' }),
      expect.objectContaining({
        type: 'tool_start',
        toolName: 'Project file edit',
        toolCallId: `a0:${sessionId}:2`,
      }),
      expect.objectContaining({
        type: 'tool_end',
        toolName: 'Project file edit',
        toolCallId: `a0:${sessionId}:2`,
        completed: true,
      }),
    ]));
  });

  test('hard-aborts only the bound project runtime and reports AgentAbortError', async () => {
    const streamMessage = jest.fn((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('connector stream cancelled')), { once: true });
    })) as jest.Mock;
    const hardAbort = jest.fn(() => true);
    const { provider, sessionId } = await startProvider({ streamMessage, hardAbort });
    const pending = provider.sendMessage(sessionId, 'long project turn');
    while (!streamMessage.mock.calls.length) await Promise.resolve();
    await expect(provider.abortActiveRun(sessionId)).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AgentAbortError' });
    expect(hardAbort).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'PROJECT_SANDBOX',
      projectId: 'project-a',
    }));
  });

  test('reserves one session and actor/project turn before runtime resolution awaits', async () => {
    const connector = client();
    let nextContext = 0;
    connector.call.mockImplementation(async (feature: string, payload: Record<string, any> = {}) => {
      if (feature === 'chat_create') return { context_id: `A0ProjectContext${++nextContext}` };
      if (feature === 'model_switcher') {
        return {
          ok: true,
          allowed: true,
          effective_preset: payload.preset_name,
          main_model: { provider: 'codex_oauth', name: 'gpt-5.2-codex' },
          utility_model: { provider: 'codex_oauth', name: 'gpt-5.2-codex' },
        };
      }
      return { ok: true };
    });
    const runtime = fakeRuntime(connector);
    const runtimeGate = deferred<AgentZeroProjectRuntimeHandle>();
    const runtimeResolver = jest.fn()
      .mockResolvedValueOnce(runtime)
      .mockResolvedValueOnce(runtime)
      .mockImplementation(() => runtimeGate.promise);
    const { AgentZeroProjectProvider } = require('../agents/providers/agentZero/AgentZeroProjectProvider') as typeof import('../agents/providers/agentZero/AgentZeroProjectProvider');
    const provider = new AgentZeroProjectProvider({ runtimeResolver });
    const config = {
      executionContext: context(),
      model: 'gpt-5.2-codex',
      metadata: { agentZeroOAuthProviderId: 'codex_oauth' },
    };
    const firstSession = await provider.startSession('owner', config);
    const secondSession = await provider.startSession('owner', config);

    const firstTurn = provider.sendMessage(
      firstSession,
      'hold the project lock',
      undefined,
      undefined,
      undefined,
      { label: 'Owner', userId: 'owner', requestId: 'a0-project-turn-1' },
    );
    await expect(provider.sendMessage(firstSession, 'duplicate session turn'))
      .rejects.toThrow(/active Project Sandbox turn/i);
    await expect(provider.sendMessage(secondSession, 'cross-session project turn'))
      .rejects.toThrow(/project already has an active/i);
    expect(runtimeResolver).toHaveBeenCalledTimes(3);
    runtimeGate.reject(new Error('test gate released'));
    await expect(firstTurn).rejects.toThrow(/test gate released/i);
  });

  test('reserves project session creation before its runtime resolver awaits', async () => {
    const connector = client();
    const gate = deferred<AgentZeroProjectRuntimeHandle>();
    const runtimeResolver = jest.fn(() => gate.promise);
    const { AgentZeroProjectProvider } = require('../agents/providers/agentZero/AgentZeroProjectProvider') as typeof import('../agents/providers/agentZero/AgentZeroProjectProvider');
    const provider = new AgentZeroProjectProvider({ runtimeResolver });
    const config = {
      executionContext: context(),
      model: 'gpt-5.2-codex',
      metadata: { agentZeroOAuthProviderId: 'codex_oauth' },
    };
    const first = provider.startSession('owner', config);
    await expect(provider.startSession('owner', config))
      .rejects.toThrow(/active Agent Zero Sandbox operation/i);
    expect(runtimeResolver).toHaveBeenCalledTimes(1);
    gate.resolve(fakeRuntime(connector));
    await expect(first).resolves.not.toBe('A0ProjectContext1');
  });

  test('guards abort by run id and deduplicates repeated abort requests', async () => {
    const streamMessage = jest.fn((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('connector stream cancelled')), { once: true });
    })) as jest.Mock;
    const hardAbortGate = deferred<boolean>();
    const hardAbort = jest.fn(() => hardAbortGate.promise);
    const { provider, sessionId } = await startProvider({ streamMessage, hardAbort });
    const pending = provider.sendMessage(
      sessionId,
      'long project turn',
      undefined,
      undefined,
      undefined,
      { label: 'Owner', userId: 'owner', requestId: 'current-a0-run' },
    );
    while (!streamMessage.mock.calls.length) await Promise.resolve();
    await expect(provider.abortActiveRun(sessionId, 'stale-a0-run')).resolves.toBe(false);
    expect(hardAbort).not.toHaveBeenCalled();
    const firstAbort = provider.abortActiveRun(sessionId, 'current-a0-run');
    const repeatedAbort = provider.abortActiveRun(sessionId, 'current-a0-run');
    await Promise.resolve();
    expect(hardAbort).toHaveBeenCalledTimes(1);
    hardAbortGate.resolve(true);
    await expect(firstAbort).resolves.toBe(true);
    await expect(repeatedAbort).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AgentAbortError' });
  });

  test('keeps a failed hard abort quarantined and blocks replacement sends', async () => {
    const streamMessage = jest.fn((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('connector stream cancelled')), { once: true });
    })) as jest.Mock;
    const hardAbort = jest.fn(() => false);
    const { provider, sessionId } = await startProvider({ streamMessage, hardAbort });
    const pending = provider.sendMessage(
      sessionId,
      'long project turn',
      undefined,
      undefined,
      undefined,
      { label: 'Owner', userId: 'owner', requestId: 'failed-a0-abort' },
    );
    while (!streamMessage.mock.calls.length) await Promise.resolve();
    await expect(provider.abortActiveRun(sessionId, 'failed-a0-abort')).resolves.toBe(false);
    await expect(pending).rejects.toMatchObject({ name: 'AgentAbortError' });
    await expect(provider.sendMessage(sessionId, 'must remain blocked'))
      .rejects.toThrow(/quarantined/i);
    await expect(provider.abortActiveRun(sessionId, 'failed-a0-abort')).resolves.toBe(false);
    expect(hardAbort).toHaveBeenCalledTimes(1);

    const { deleteNativeSession, loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.metadata).toMatchObject({
      agentZeroRuntimeQuarantined: true,
      agentZeroQuarantineReason: 'ACTIVE_RUN_ABORT_PENDING',
      agentZeroQuarantinedRunId: 'failed-a0-abort',
    });
    const cleanupContext = context();
    deleteNativeSession('AGENT_ZERO', sessionId);
    await provider.convergeAttestedProjectCleanup({
      userId: cleanupContext.userId,
      projectId: cleanupContext.projectId,
      canonicalRoot: cleanupContext.canonicalRoot,
      rootDevice: cleanupContext.rootDevice,
      rootInode: cleanupContext.rootInode,
      rootBirthtimeNs: cleanupContext.rootBirthtimeNs,
      sessionIds: [sessionId],
    });
    await expect(provider.startSession('owner', {
      executionContext: cleanupContext,
      model: 'gpt-5.2-codex',
      metadata: { title: 'Recovered Project A', agentZeroOAuthProviderId: 'codex_oauth' },
    })).resolves.toMatch(/^agent_zero-owner-/);
  });

  test('quarantines a hard-stopped run whose stream does not settle by the deadline', async () => {
    const streamGate = deferred<any>();
    const streamMessage = jest.fn(() => streamGate.promise) as jest.Mock;
    const hardAbort = jest.fn(() => true);
    const { provider, sessionId } = await startProvider({
      streamMessage,
      hardAbort,
      abortSettlementTimeoutMs: 20,
    });
    const pending = provider.sendMessage(
      sessionId,
      'connector ignores cancellation',
      undefined,
      undefined,
      undefined,
      { label: 'Owner', userId: 'owner', requestId: 'unsettled-a0-run' },
    );
    while (!streamMessage.mock.calls.length) await Promise.resolve();
    await expect(provider.abortActiveRun(sessionId, 'unsettled-a0-run')).resolves.toBe(false);
    await expect(provider.sendMessage(sessionId, 'replacement must stay blocked'))
      .rejects.toThrow(/quarantined/i);
    await expect(provider.abortActiveRun(sessionId, 'unsettled-a0-run')).resolves.toBe(false);
    expect(hardAbort).toHaveBeenCalledTimes(1);
    streamGate.reject(new Error('late connector settlement'));
    await expect(pending).rejects.toMatchObject({ name: 'AgentAbortError' });
  });

  test('keeps a failed start quarantined when remote context deletion is not proved', async () => {
    const connector = client();
    connector.call.mockImplementation(async (feature: string, payload: Record<string, any> = {}) => {
      if (feature === 'chat_create') return { context_id: 'A0UncertainContext' };
      if (feature === 'model_switcher') throw new Error(`preset ${payload.preset_name} failed`);
      if (feature === 'chat_delete') throw new Error('remote delete failed');
      return { ok: true };
    });
    const runtimeResolver = jest.fn(async () => fakeRuntime(connector));
    const { AgentZeroProjectProvider } = require('../agents/providers/agentZero/AgentZeroProjectProvider') as typeof import('../agents/providers/agentZero/AgentZeroProjectProvider');
    const provider = new AgentZeroProjectProvider({ runtimeResolver });
    const config = {
      executionContext: context(),
      model: 'gpt-5.2-codex',
      metadata: { agentZeroOAuthProviderId: 'codex_oauth' },
    };
    await expect(provider.startSession('owner', config)).rejects.toThrow(/project is quarantined/i);
    await expect(provider.startSession('owner', config)).rejects.toThrow(/quarantined Agent Zero runtime/i);
    expect(runtimeResolver).toHaveBeenCalledTimes(1);
    const { listNativeSessions, loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const quarantined = listNativeSessions('AGENT_ZERO', 'owner')
      .map((summary) => loadNativeSession('AGENT_ZERO', summary.sessionId))
      .filter(Boolean);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.metadata).toMatchObject({
      agentZeroRuntimeQuarantined: true,
      agentZeroQuarantineReason: 'SESSION_START_REMOTE_DELETE_UNCONFIRMED',
      agentZeroRemoteContextId: 'A0UncertainContext',
    });
  });

  test('rejects HOST_OPERATOR sessions and cross-user sends', async () => {
    const connector = client();
    const { AgentZeroProjectProvider } = require('../agents/providers/agentZero/AgentZeroProjectProvider') as typeof import('../agents/providers/agentZero/AgentZeroProjectProvider');
    const provider = new AgentZeroProjectProvider({ runtimeResolver: async () => fakeRuntime(connector) });
    await expect(provider.startSession('owner', {
      executionContext: createHostOperatorExecutionContext('owner'),
    })).rejects.toThrow(/expected PROJECT_SANDBOX/i);

    const { sessionId } = await startProvider();
    const isolated = new AgentZeroProjectProvider({ runtimeResolver: async () => fakeRuntime(connector) });
    await expect(isolated.sendMessage(
      sessionId,
      'read files',
      undefined,
      undefined,
      undefined,
      { label: 'intruder', userId: 'other' },
    )).rejects.toThrow(/does not belong/i);
  });
});
