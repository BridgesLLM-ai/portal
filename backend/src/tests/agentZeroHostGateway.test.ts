import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import type { Stats } from 'fs';
import {
  AGENT_ZERO_HOST_GATEWAY_ARCHIVE_SHA256,
  AGENT_ZERO_HOST_GATEWAY_BINARY,
  AGENT_ZERO_HOST_GATEWAY_BUILD_CONSTRAINTS_SHA256,
  AGENT_ZERO_HOST_GATEWAY_CLI_COMMIT,
  AGENT_ZERO_HOST_GATEWAY_CLI_TAG,
  AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
  AGENT_ZERO_HOST_GATEWAY_ID,
  AGENT_ZERO_HOST_GATEWAY_HOME,
  AGENT_ZERO_HOST_GATEWAY_PROVENANCE,
  AGENT_ZERO_HOST_GATEWAY_RUNTIME_CONSTRAINTS_SHA256,
  AGENT_ZERO_HOST_GATEWAY_URL,
  AgentZeroHostGatewayManager,
  writeAgentZeroHostGatewaySession,
} from '../agents/providers/agentZero/AgentZeroHostGateway';
import type { AgentZeroRuntimeStatus } from '../agents/providers/agentZero/AgentZeroRuntime';
import { AgentZeroConnectorClient } from '../agents/providers/agentZero/AgentZeroConnectorClient';

const AUTH_FILE = '/etc/bridgesllm/agent-zero.env';
const USERNAME = 'portal-owner';
const PASSWORD = 'correct-horse-battery-staple';

function rootFileStats(executable = false): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: executable ? 0o100700 : 0o100600,
  } as Stats;
}

function rootDirectoryStats(): Stats {
  return {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o40755,
  } as Stats;
}

function privateRootDirectoryStats(): Stats {
  return {
    ...rootDirectoryStats(),
    mode: 0o40700,
  } as Stats;
}

function runtimeReady(overrides: Partial<AgentZeroRuntimeStatus> = {}): AgentZeroRuntimeStatus {
  return {
    installed: true,
    running: true,
    ready: true,
    version: '2.5',
    expectedVersion: '2.5',
    pinnedImage: true,
    loopbackOnly: true,
    persistentData: true,
    protectedAuth: true,
    restartPolicy: true,
    protocolCompatible: true,
    reason: 'ready',
    ...overrides,
  };
}

function provenance(overrides: Record<string, string> = {}): string {
  return Object.entries({
    A0_CLI_VERSION: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
    A0_CLI_TAG: AGENT_ZERO_HOST_GATEWAY_CLI_TAG,
    A0_CLI_COMMIT: AGENT_ZERO_HOST_GATEWAY_CLI_COMMIT,
    A0_CLI_ARCHIVE_SHA256: AGENT_ZERO_HOST_GATEWAY_ARCHIVE_SHA256,
    A0_CLI_RUNTIME_CONSTRAINTS_SHA256: AGENT_ZERO_HOST_GATEWAY_RUNTIME_CONSTRAINTS_SHA256,
    A0_CLI_BUILD_CONSTRAINTS_SHA256: AGENT_ZERO_HOST_GATEWAY_BUILD_CONSTRAINTS_SHA256,
    ...overrides,
  }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function gatewayMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'launcher',
    id: AGENT_ZERO_HOST_GATEWAY_ID,
    host_label: 'BridgesLLM Portal host',
    state: 'connected',
    master_enabled: true,
    scopes: {
      files: true,
      file_write: true,
      code_execution: true,
      browser: false,
      computer_use: false,
    },
    status: {},
    ...overrides,
  };
}

function remoteStatus(gateway = gatewayMetadata()): Record<string, unknown> {
  return {
    state: 'connected',
    connected: true,
    multiple_hosts: false,
    gateway,
    gateways: [gateway],
  };
}

function remoteRegistrationPending(
  state: 'stopped' | 'disconnected' | 'not_connected' | 'idle' = 'disconnected',
): Record<string, unknown> {
  return {
    state,
    connected: false,
    multiple_hosts: false,
    gateway: null,
    gateways: [],
  };
}

interface FakeProcessResult {
  child: ChildProcessWithoutNullStreams;
  stdinPayload: () => string;
  exit: (code?: number) => void;
}

function fakeGatewayProcess(localGateway = gatewayMetadata()): FakeProcessResult {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let written = '';

  Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: jest.fn((signal?: NodeJS.Signals | number) => {
      Object.assign(emitter, { exitCode: 0, killed: true });
      emitter.emit('exit', 0, signal || null);
      return true;
    }),
  });
  stdin.on('data', (chunk) => {
    written += chunk.toString('utf8');
    if (written.includes('"action":"shutdown"')) {
      queueMicrotask(() => {
        if (emitter.exitCode === null) {
          Object.assign(emitter, { exitCode: 0 });
          emitter.emit('exit', 0, null);
        }
      });
    }
  });
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({
      type: 'status',
      host: AGENT_ZERO_HOST_GATEWAY_URL,
      workspace: '/',
      gateway: localGateway,
    })}\n`);
  });
  return {
    child: emitter,
    stdinPayload: () => written,
    exit: (code = 1) => {
      if (emitter.exitCode !== null) return;
      Object.assign(emitter, { exitCode: code });
      emitter.emit('exit', code, null);
    },
  };
}

function createManager(options: {
  remote?: Record<string, unknown>;
  local?: Record<string, unknown>;
  provenanceText?: string;
  runtime?: AgentZeroRuntimeStatus;
  startTimeoutMs?: number;
  getSessionCookie?: () => Promise<string>;
  execFileImpl?: (command: string, args: string[], timeoutMs?: number) => string;
} = {}) {
  const process = fakeGatewayProcess(options.local || gatewayMetadata());
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: SpawnOptionsWithoutStdio;
  }> = [];
  const connectorCall = jest.fn(async (
    _feature?: string,
    _payload?: Record<string, unknown>,
    _timeoutMs?: number,
  ) => options.remote || remoteStatus());
  const getCapabilities = jest.fn(async () => ({
    protocol: 'a0-connector.v1' as const,
    connectorVersion: '0.1.0' as const,
    agentZeroVersion: '2.5' as const,
    auth: ['session'] as ['session'],
    authRequired: true,
    transports: ['http', 'websocket'],
    websocketNamespace: '/ws' as const,
    websocketHandlers: ['plugins/_a0_connector/ws_connector'],
    features: ['launcher_gateway', 'launcher_gateway_file_write'],
  }));
  const connectorClient = {
    getCapabilities,
    call: async <T = Record<string, unknown>>(
      feature: string,
      payload: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<T> => connectorCall(feature, payload, timeoutMs) as Promise<T>,
  };
  const persistSession = jest.fn();
  const spawnImpl = jest.fn((
    command: string,
    args: readonly string[],
    spawnOptions: SpawnOptionsWithoutStdio,
  ) => {
    spawnCalls.push({ command, args, options: spawnOptions });
    return process.child;
  });
  const readFile = jest.fn((path: string) => {
    if (path === AGENT_ZERO_HOST_GATEWAY_PROVENANCE) return options.provenanceText || provenance();
    if (path === AUTH_FILE) return `AUTH_LOGIN=${USERNAME}\nAUTH_PASSWORD=${PASSWORD}\n`;
    throw new Error(`Unexpected file: ${path}`);
  });
  const manager = new AgentZeroHostGatewayManager({
    client: connectorClient,
    sessionProvider: {
      getSessionCookie: options.getSessionCookie || (async () => 'session=server-side-cookie'),
      invalidateSession: () => undefined,
    },
    persistSession,
    runtimeProbe: () => options.runtime || runtimeReady(),
    spawnImpl: spawnImpl as any,
    execFileImpl: options.execFileImpl || (() => '2.5'),
    readFile,
    statFile: (path) => (
      [AGENT_ZERO_HOST_GATEWAY_BINARY, AGENT_ZERO_HOST_GATEWAY_PROVENANCE, AUTH_FILE].includes(path)
        ? rootFileStats(path === AGENT_ZERO_HOST_GATEWAY_BINARY)
        : path === AGENT_ZERO_HOST_GATEWAY_HOME
          ? privateRootDirectoryStats()
          : rootDirectoryStats()
    ),
    startTimeoutMs: options.startTimeoutMs || 2_000,
    remoteStatusTimeoutMs: 2_000,
  });
  return {
    manager,
    process,
    spawnCalls,
    spawnImpl,
    connectorCall,
    getCapabilities,
    persistSession,
    readFile,
  };
}

describe('Agent Zero v2.5 HOST_OPERATOR gateway', () => {
  test('persists only a root-private browser session and never gateway login credentials', () => {
    const homePath = '/managed/agent-zero-gateway';
    const sessionDirectory = `${homePath}/.agent-zero`;
    const sessionFile = `${sessionDirectory}/session_cookies.json`;
    const files = new Map<string, string>();
    let sessionDirectoryExists = false;
    const statFile = (target: string): Stats => {
      if (target === sessionDirectory && !sessionDirectoryExists) throw new Error('not found');
      if (target === sessionFile && !files.has(target)) throw new Error('not found');
      if (files.has(target)) return rootFileStats();
      if (target === homePath || target === sessionDirectory) return privateRootDirectoryStats();
      return rootDirectoryStats();
    };

    writeAgentZeroHostGatewaySession('session=connector-cookie; csrf=connector-csrf', {
      homePath,
      statFile,
      mkdir: (target, options) => {
        expect(target).toBe(sessionDirectory);
        expect(options).toEqual({ mode: 0o700 });
        sessionDirectoryExists = true;
      },
      writeFile: (target, data, options) => {
        expect(target).toMatch(/\.session_cookies\.portal-/);
        expect(options).toEqual({ encoding: 'utf8', mode: 0o600, flag: 'wx' });
        files.set(target, data);
      },
      rename: (source, destination) => {
        const data = files.get(source);
        if (!data) throw new Error('missing source');
        files.delete(source);
        files.set(destination, data);
      },
      chmod: jest.fn(),
      unlink: (target) => { files.delete(target); },
    });

    const saved = files.get(sessionFile) || '';
    expect(JSON.parse(saved)).toEqual({
      version: 1,
      hosts: {
        'http://127.0.0.1:50001': [
          expect.objectContaining({ name: 'session', value: 'connector-cookie', domain: '127.0.0.1' }),
          expect.objectContaining({ name: 'csrf', value: 'connector-csrf', domain: '127.0.0.1' }),
        ],
      },
    });
    expect(saved).not.toMatch(new RegExp(`${USERNAME}|${PASSWORD}|AUTH_LOGIN|AUTH_PASSWORD`));
  });

  test('maps the official launcher_gateway feature to its protected status endpoint', async () => {
    const responses = [
      new Response(JSON.stringify({
        protocol: 'a0-connector.v1',
        version: '0.1.0',
        agent_zero_version: '2.5',
        auth: ['session'],
        auth_required: true,
        transports: ['http', 'websocket'],
        websocket_namespace: '/ws',
        websocket_handlers: ['plugins/_a0_connector/ws_connector'],
        features: ['launcher_gateway', 'launcher_gateway_file_write'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      new Response(JSON.stringify(remoteStatus()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    const fetchImpl = jest.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return response;
    }) as unknown as typeof fetch;
    const client = new AgentZeroConnectorClient({
      sessionCookie: 'session=protected',
      fetchImpl,
    });

    await expect(client.call('launcher_gateway_status', {})).resolves.toMatchObject({
      connected: true,
      gateway: { id: AGENT_ZERO_HOST_GATEWAY_ID },
    });
    expect(String(jest.mocked(fetchImpl).mock.calls[1][0])).toMatch(/launcher_gateway_status$/);
  });

  test('starts only the exact authenticated official A0 gateway and proves remote host scopes', async () => {
    const { manager, process, spawnCalls, connectorCall, persistSession } = createManager();

    await expect(manager.ensureReady()).resolves.toMatchObject({
      state: 'ready',
      ready: true,
      cliVersion: '2.5',
      gatewayId: AGENT_ZERO_HOST_GATEWAY_ID,
      capabilities: {
        scope: 'HOST_OPERATOR',
        fileRead: true,
        fileWrite: true,
        codeExecution: true,
        browser: false,
        computerUse: false,
      },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(AGENT_ZERO_HOST_GATEWAY_BINARY);
    expect(spawnCalls[0].args).toEqual([
      'gateway',
      '--host', 'http://127.0.0.1:50001',
      '--workspace', '/',
      '--gateway-id', 'bridgesllm-portal-host',
      '--host-label', 'BridgesLLM Portal host',
      '--master',
      '--scopes', 'file_read,file_write,code_execution',
    ]);
    expect(spawnCalls[0].options).toMatchObject({ cwd: '/', shell: false });
    expect(spawnCalls[0].options.env).not.toHaveProperty('A0_USERNAME');
    expect(spawnCalls[0].options.env).not.toHaveProperty('A0_PASSWORD');
    expect(persistSession).toHaveBeenCalledWith('session=server-side-cookie');
    expect(JSON.stringify(spawnCalls[0].args)).not.toMatch(new RegExp(`${USERNAME}|${PASSWORD}`));
    expect(JSON.stringify(manager.snapshot())).not.toMatch(new RegExp(`${USERNAME}|${PASSWORD}`));
    expect(connectorCall).toHaveBeenCalledWith(
      'launcher_gateway_status',
      {},
      expect.any(Number),
    );
    expect(connectorCall.mock.calls[0][2]).toBeGreaterThan(0);
    expect(connectorCall.mock.calls[0][2]).toBeLessThanOrEqual(2_000);

    await manager.stop();
    const controls = process.stdinPayload().trim().split('\n').map((line) => JSON.parse(line));
    expect(controls.map((entry) => entry.action)).toEqual([
      'set_master', 'replace_scopes', 'shutdown',
    ]);
    expect(controls[1].scopes).toEqual({
      files: false,
      file_write: false,
      code_execution: false,
      browser: false,
      computer_use: false,
    });
  });

  test('waits for the exact local gateway to finish delayed remote registration', async () => {
    const { manager, connectorCall } = createManager();
    connectorCall
      .mockResolvedValueOnce(remoteRegistrationPending('disconnected'))
      .mockResolvedValueOnce(remoteRegistrationPending('idle'))
      .mockResolvedValueOnce(remoteStatus());

    await expect(manager.ensureReady()).resolves.toMatchObject({
      state: 'ready',
      running: true,
      ready: true,
      gatewayId: AGENT_ZERO_HOST_GATEWAY_ID,
    });
    expect(connectorCall).toHaveBeenCalledTimes(3);
    expect(connectorCall.mock.calls.every(([feature]) => feature === 'launcher_gateway_status')).toBe(true);

    await manager.stop();
  });

  test('fails immediately when a pending-looking status contains gateway state', async () => {
    const pendingWithGateway = createManager({
      remote: {
        ...remoteRegistrationPending(),
        gateway: gatewayMetadata(),
      },
    });

    await expect(pendingWithGateway.manager.ensureReady()).rejects.toThrow(
      /did not report one connected Portal host gateway/,
    );
    expect(pendingWithGateway.connectorCall).toHaveBeenCalledTimes(1);
    expect(pendingWithGateway.process.stdinPayload()).toContain('"action":"shutdown"');
  });

  test('stops polling immediately if the exact gateway child exits before registration', async () => {
    const pending = createManager({ remote: remoteRegistrationPending() });
    const readiness = pending.manager.ensureReady();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pending.connectorCall).toHaveBeenCalledTimes(1);
    pending.process.exit(23);

    await expect(readiness).rejects.toThrow(/exited before remote readiness completed/);
    expect(pending.connectorCall).toHaveBeenCalledTimes(1);
    expect(pending.manager.snapshot()).toMatchObject({ state: 'error', ready: false });
  });

  test('bounds a permanently clean unregistered state and fails closed', async () => {
    const neverRegisters = createManager({
      remote: remoteRegistrationPending(),
      startTimeoutMs: 500,
    });

    await expect(neverRegisters.manager.ensureReady()).rejects.toThrow(
      /did not complete remote registration in time/,
    );
    expect(neverRegisters.connectorCall.mock.calls.length).toBeGreaterThan(1);
    expect(neverRegisters.process.stdinPayload()).toContain('"action":"shutdown"');
  });

  test('hard-bounds a capability RPC that never settles', async () => {
    const stalled = createManager({ startTimeoutMs: 500 });
    stalled.getCapabilities.mockImplementationOnce(() => new Promise(() => undefined));
    const startedAt = Date.now();

    await expect(stalled.manager.ensureReady()).rejects.toThrow(
      /did not complete remote registration in time/,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(stalled.connectorCall).not.toHaveBeenCalled();
    expect(stalled.process.stdinPayload()).toContain('"action":"shutdown"');
    expect(stalled.manager.snapshot()).toMatchObject({ state: 'error', ready: false });
  });

  test('hard-bounds protected-session acquisition before process creation', async () => {
    const stalled = createManager({
      startTimeoutMs: 500,
      getSessionCookie: () => new Promise(() => undefined),
    });
    const startedAt = Date.now();

    await expect(stalled.manager.ensureReady()).rejects.toThrow(
      /did not obtain its protected session within the readiness deadline/,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(stalled.spawnImpl).not.toHaveBeenCalled();
    expect(stalled.persistSession).not.toHaveBeenCalled();
    expect(stalled.manager.snapshot()).toMatchObject({ state: 'error', ready: false });
  });

  test('passes the remaining overall deadline into executable verification', async () => {
    let executableTimeoutMs: number | undefined;
    const bounded = createManager({
      startTimeoutMs: 500,
      execFileImpl: (_command, _args, timeoutMs) => {
        executableTimeoutMs = timeoutMs;
        return '2.5';
      },
    });

    await expect(bounded.manager.ensureReady()).resolves.toMatchObject({ ready: true });
    expect(executableTimeoutMs).toBeGreaterThan(0);
    expect(executableTimeoutMs).toBeLessThanOrEqual(500);
    await bounded.manager.stop();
  });

  test('uses the same hard deadline when a remote status RPC never settles', async () => {
    const stalled = createManager({ startTimeoutMs: 500 });
    stalled.connectorCall.mockImplementationOnce(() => new Promise(() => undefined));
    const startedAt = Date.now();

    await expect(stalled.manager.ensureReady()).rejects.toThrow(
      /did not complete remote registration in time/,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(stalled.getCapabilities).toHaveBeenCalledTimes(1);
    expect(stalled.connectorCall).toHaveBeenCalledTimes(1);
    expect(stalled.process.stdinPayload()).toContain('"action":"shutdown"');
  });

  test('does not reset the hard deadline after slow capability discovery', async () => {
    jest.useFakeTimers();
    const stalled = createManager({ startTimeoutMs: 500 });
    stalled.getCapabilities.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        protocol: 'a0-connector.v1',
        connectorVersion: '0.1.0',
        agentZeroVersion: '2.5',
        auth: ['session'],
        authRequired: true,
        transports: ['http', 'websocket'],
        websocketNamespace: '/ws',
        websocketHandlers: ['plugins/_a0_connector/ws_connector'],
        features: ['launcher_gateway', 'launcher_gateway_file_write'],
      }), 400);
    }));
    stalled.connectorCall.mockImplementationOnce(() => new Promise(() => undefined));

    try {
      const readiness = stalled.manager.ensureReady();
      const rejected = expect(readiness).rejects.toThrow(
        /did not complete remote registration in time/,
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(stalled.getCapabilities).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(400);
      expect(stalled.connectorCall).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(100);
      await rejected;
      expect(stalled.process.stdinPayload()).toContain('"action":"shutdown"');
    } finally {
      jest.useRealTimers();
    }
  });

  test.each(['capability', 'status'] as const)(
    'still fails immediately on child exit while the %s RPC never settles',
    async (stage) => {
      const stalled = createManager({ startTimeoutMs: 2_000 });
      if (stage === 'capability') {
        stalled.getCapabilities.mockImplementationOnce(() => new Promise(() => undefined));
      } else {
        stalled.connectorCall.mockImplementationOnce(() => new Promise(() => undefined));
      }
      const readiness = stalled.manager.ensureReady();

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const reachedStage = stage === 'capability'
          ? stalled.getCapabilities.mock.calls.length > 0
          : stalled.connectorCall.mock.calls.length > 0;
        if (reachedStage) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      stalled.process.exit(27);

      await expect(readiness).rejects.toThrow(/exited before remote readiness completed/);
      expect(stalled.manager.snapshot()).toMatchObject({ state: 'error', ready: false });
    },
  );

  test('surfaces a sanitized remote-registration stage on authentication failure without retrying', async () => {
    const rejected = createManager();
    rejected.connectorCall.mockRejectedValueOnce(
      new Error('Agent Zero rejected authentication; password=super-secret'),
    );

    await expect(rejected.manager.ensureReady()).rejects.toThrow(
      /remote registration status check failed: Agent Zero rejected authentication; password=\[redacted\]/,
    );
    expect(rejected.connectorCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rejected.manager.snapshot())).not.toContain('super-secret');
  });

  test('fails before process creation on runtime, provenance, version, or file-protection drift', async () => {
    const runtimeFailure = createManager({ runtime: runtimeReady({ ready: false, reason: 'bad runtime' }) });
    await expect(runtimeFailure.manager.ensureReady()).rejects.toThrow(/bad runtime/);
    expect(runtimeFailure.spawnImpl).not.toHaveBeenCalled();

    const provenanceFailure = createManager({
      provenanceText: provenance({ A0_CLI_COMMIT: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    });
    await expect(provenanceFailure.manager.ensureReady()).rejects.toThrow(/outside the tested v2.5 pin/);
    expect(provenanceFailure.spawnImpl).not.toHaveBeenCalled();
  });

  test('terminates the bridge if Agent Zero reports missing write/exec scope or multiple hosts', async () => {
    const driftedGateway = gatewayMetadata({
      scopes: {
        files: true,
        file_write: false,
        code_execution: false,
        browser: false,
        computer_use: false,
      },
    });
    const drifted = createManager({ remote: remoteStatus(driftedGateway) });
    await expect(drifted.manager.ensureReady()).rejects.toThrow(/read\/write\/exec capability contract/);
    expect(drifted.manager.snapshot()).toMatchObject({ state: 'error', ready: false });
    expect(drifted.process.stdinPayload()).toContain('"action":"shutdown"');

    const ambiguous = createManager({
      remote: {
        state: 'multiple_hosts',
        connected: false,
        multiple_hosts: true,
        gateway: null,
        gateways: [gatewayMetadata(), gatewayMetadata({ id: 'other-host' })],
      },
    });
    await expect(ambiguous.manager.ensureReady()).rejects.toThrow(/ambiguous host-gateway topology/);
    expect(ambiguous.manager.snapshot()).toMatchObject({ state: 'error', ready: false });

    const inconsistentList = createManager({
      remote: {
        ...remoteStatus(),
        gateways: [gatewayMetadata({ id: 'other-host' })],
      },
    });
    await expect(inconsistentList.manager.ensureReady()).rejects.toThrow(/read\/write\/exec capability contract/);
    expect(inconsistentList.connectorCall).toHaveBeenCalledTimes(1);
  });

  test('rejects host identity drift and any unreviewed scope expansion', async () => {
    const wrongLabel = createManager({
      remote: remoteStatus(gatewayMetadata({ host_label: 'Unattested host' })),
    });
    await expect(wrongLabel.manager.ensureReady()).rejects.toThrow(
      /read\/write\/exec capability contract/,
    );
    expect(wrongLabel.connectorCall).toHaveBeenCalledTimes(1);

    const expandedScopes = createManager({
      remote: remoteStatus(gatewayMetadata({
        scopes: {
          files: true,
          file_write: true,
          code_execution: true,
          browser: false,
          computer_use: false,
          network_admin: true,
        },
      })),
    });
    await expect(expandedScopes.manager.ensureReady()).rejects.toThrow(
      /read\/write\/exec capability contract/,
    );
    expect(expandedScopes.connectorCall).toHaveBeenCalledTimes(1);
  });

  test.each(['connecting', 'disconnected', 'needs_action', 'paused'])(
    'rejects a non-ready nested gateway state: %s',
    async (state) => {
      const nonReady = gatewayMetadata({ state });
      const manager = createManager({ remote: remoteStatus(nonReady) });

      await expect(manager.manager.ensureReady()).rejects.toThrow(/readiness state disagreed/);
      expect(manager.connectorCall).toHaveBeenCalledTimes(1);
      expect(manager.manager.snapshot()).toMatchObject({ state: 'error', ready: false });
    },
  );

  test('rejects disagreement between the top, primary, and listed gateway states', async () => {
    const manager = createManager({
      remote: {
        ...remoteStatus(),
        gateway: gatewayMetadata({ state: 'connected' }),
        gateways: [gatewayMetadata({ state: 'paused' })],
      },
    });

    await expect(manager.manager.ensureReady()).rejects.toThrow(/readiness state disagreed/);
    expect(manager.connectorCall).toHaveBeenCalledTimes(1);
  });

  test.each(['connecting', 'disconnected', 'needs_action', 'paused'])(
    'rejects a non-ready top-level remote state: %s',
    async (state) => {
      const gateway = gatewayMetadata({ state });
      const manager = createManager({
        remote: {
          state,
          connected: true,
          multiple_hosts: false,
          gateway,
          gateways: [gateway],
        },
      });

      await expect(manager.manager.ensureReady()).rejects.toThrow(
        /did not report one connected Portal host gateway/,
      );
      expect(manager.connectorCall).toHaveBeenCalledTimes(1);
    },
  );

  test('re-proves remote capability state before every subsequent turn', async () => {
    const { manager, connectorCall } = createManager();
    await manager.ensureReady();
    await manager.ensureReady();
    expect(connectorCall).toHaveBeenCalledTimes(2);
    await manager.stop();
  });
});
