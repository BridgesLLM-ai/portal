import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import {
  HERMES_ACP_PROFILE,
  HERMES_ACP_VERSION,
  OPENCODE_ACP_PROFILE,
  OPENCODE_ACP_VERSION,
} from '../agents/providers/native/acp/AcpHarnessProfiles';
import { AcpStdioBroker } from '../agents/providers/native/acp/AcpStdioBroker';

const HERMES_SESSION_ID = 'hermes-session-123';
const OPENCODE_SESSION_ID = 'opencode-session-456';

interface FakeAcpProcess {
  child: ChildProcessWithoutNullStreams;
  received: Array<Record<string, any>>;
  send(payload: unknown): void;
}

function fakeAcpProcess(
  onMessage: (message: Record<string, any>, process: FakeAcpProcess) => void,
): FakeAcpProcess {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received: Array<Record<string, any>> = [];
  let input = '';
  const runtime: FakeAcpProcess = {
    child: emitter,
    received,
    send: (payload) => stdout.write(`${JSON.stringify(payload)}\n`),
  };
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: jest.fn((signal?: NodeJS.Signals | number) => {
      Object.assign(emitter, { exitCode: 0, killed: true });
      queueMicrotask(() => emitter.emit('close', 0, signal || null));
      return true;
    }),
  });
  stdin.on('data', (chunk) => {
    input += chunk.toString('utf8');
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        received.push(message);
        queueMicrotask(() => onMessage(message, runtime));
      }
      newline = input.indexOf('\n');
    }
  });
  return runtime;
}

function spawnRecorder(runtime: FakeAcpProcess) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }> = [];
  const spawnImpl = jest.fn((command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options });
    return runtime.child;
  });
  return { spawnImpl: spawnImpl as any, calls };
}

function hermesModels(currentModelId: string) {
  return {
    models: {
      currentModelId,
      availableModels: [
        { modelId: 'provider/model-a', name: 'Model A' },
        { modelId: 'provider/model-b', name: 'Model B', description: 'Current upstream model' },
      ],
    },
  };
}

function openCodeModels(currentValue: string) {
  return {
    configOptions: [{
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'vendor/model-a', name: 'Model A' },
        { value: 'vendor/model-b', name: 'Model B' },
      ],
    }],
  };
}

function hermesCapabilities() {
  return {
    loadSession: true,
    sessionCapabilities: { list: {}, resume: {}, fork: {} },
  };
}

function openCodeCapabilities() {
  return {
    loadSession: true,
    sessionCapabilities: { close: {}, list: {}, resume: {}, fork: {} },
  };
}

const HERMES_AUTH_METHODS = [
  { id: 'openrouter', name: 'OpenRouter runtime credentials' },
  { id: 'hermes-setup', name: 'Configure Hermes provider', type: 'terminal' },
];

const OPENCODE_AUTH_METHODS = [
  { id: 'opencode-login', name: 'Login with opencode' },
];

describe('shared ACP stdio broker', () => {
  test('attests Hermes authentication and lifecycle without creating a readiness session', async () => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });

    await expect(broker.attest()).resolves.toEqual({
      agentName: 'hermes-agent',
      agentVersion: HERMES_ACP_VERSION,
      protocolVersion: 1,
      authenticationMethodId: 'openrouter',
    });
    expect(runtime.received.map((entry) => entry.method)).toEqual(['initialize', 'authenticate']);
    await broker.dispose();
  });

  test('attests Hermes, isolates env, verifies dynamic session model readback, and streams native events', async () => {
    let selected = 'provider/model-a';
    let promptId: number | null = null;
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/new') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: HERMES_SESSION_ID, ...hermesModels(selected) },
        });
      } else if (message.method === 'session/set_model') {
        selected = message.params.modelId;
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/load') {
        process.send({ jsonrpc: '2.0', id: message.id, result: hermesModels(selected) });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        process.send({
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: HERMES_SESSION_ID,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reasoning.' } },
          },
        });
        process.send({
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: HERMES_SESSION_ID,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Inspect', kind: 'read', rawInput: { path: '/workspace/a' } },
          },
        });
        process.send({
          jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission',
          params: {
            sessionId: HERMES_SESSION_ID,
            toolCall: { toolCallId: 'tool-1', title: 'Inspect', kind: 'read', rawInput: { path: '/workspace/a' } },
            options: [
              { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      } else if (message.id === 'permission-1') {
        process.send({
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: HERMES_SESSION_ID,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hermes answer.' } },
          },
        });
        process.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    });
    const spawn = spawnRecorder(runtime);
    const statuses: Array<Record<string, any>> = [];
    const environment = {
      PATH: '/usr/bin',
      HOME: '/private/hermes/home',
      HERMES_HOME: '/private/hermes',
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      HERMES_ACP_SKIP_CONFIGURED_MCP: '1',
      NO_COLOR: '1',
    };
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment,
      model: 'provider/model-b',
      onStatus: (event) => statuses.push(event),
      onPermission: async () => 'allow-once',
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    const result = await broker.prompt('Work.');

    expect(spawn.calls[0]).toMatchObject({
      command: 'hermes',
      args: ['acp'],
      options: {
        cwd: '/workspace',
        detached: true,
        env: environment,
      },
    });
    expect(spawn.calls[0].options.env).not.toHaveProperty('JWT_SECRET');
    expect(result).toMatchObject({
      nativeSessionId: HERMES_SESSION_ID,
      initialModelId: 'provider/model-a',
      modelState: { currentModelId: 'provider/model-b' },
      agentName: 'hermes-agent',
      agentVersion: HERMES_ACP_VERSION,
      fullText: 'Hermes answer.',
      stopReason: 'end_turn',
    });
    expect(runtime.received.map((entry) => entry.method).filter(Boolean)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/set_model',
      'session/load',
      'session/prompt',
    ]);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', content: 'Reasoning.', provider: 'hermes' }),
      expect.objectContaining({ type: 'tool_start', toolCallId: 'tool-1', provider: 'hermes' }),
    ]));
    expect(runtime.received).toContainEqual(expect.objectContaining({
      id: 'permission-1',
      result: { outcome: { outcome: 'selected', optionId: 'once' } },
    }));
    await broker.dispose();
  });

  test('uses OpenCode pure/loopback launch, configOptions model control, persisted load, and session close', async () => {
    let selected = 'vendor/model-a';
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'OpenCode', version: OPENCODE_ACP_VERSION },
            agentCapabilities: openCodeCapabilities(),
            authMethods: OPENCODE_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/load') {
        process.send({ jsonrpc: '2.0', id: message.id, result: openCodeModels(selected) });
      } else if (message.method === 'session/set_config_option') {
        selected = message.params.value;
        process.send({ jsonrpc: '2.0', id: message.id, result: openCodeModels(selected) });
      } else if (message.method === 'session/prompt') {
        process.send({
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: OPENCODE_SESSION_ID,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OpenCode answer.' } },
          },
        });
        process.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      } else if (message.method === 'session/close') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE,
      cwd: '/workspace/project',
      environment: {
        PATH: '/usr/bin',
        HOME: '/private/opencode/home',
        XDG_DATA_HOME: '/private/opencode/data',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      nativeSessionId: OPENCODE_SESSION_ID,
      model: 'vendor/model-b',
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    const result = await broker.prompt('Continue.');
    await broker.closeSession();

    expect(spawn.calls[0]).toMatchObject({
      command: 'opencode',
      args: [
        'acp', '--pure', '--cwd', '/workspace/project',
        '--hostname', '127.0.0.1', '--port', '0', '--no-mdns',
      ],
      options: { detached: true },
    });
    expect(result).toMatchObject({
      nativeSessionId: OPENCODE_SESSION_ID,
      initialModelId: 'vendor/model-a',
      modelState: { currentModelId: 'vendor/model-b' },
      agentName: 'OpenCode',
      agentVersion: OPENCODE_ACP_VERSION,
      fullText: 'OpenCode answer.',
    });
    expect(runtime.received).toContainEqual(expect.objectContaining({
      method: 'session/set_config_option',
      params: {
        sessionId: OPENCODE_SESSION_ID,
        configId: 'model',
        value: 'vendor/model-b',
      },
    }));
    expect(runtime.received).toContainEqual(expect.objectContaining({
      method: 'session/close',
      params: { sessionId: OPENCODE_SESSION_ID },
    }));
    await broker.dispose();
  });

  test('fails closed when no permission callback owns an agent request', async () => {
    let promptId: number | null = null;
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/new') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: HERMES_SESSION_ID, ...hermesModels('provider/model-a') },
        });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        process.send({
          jsonrpc: '2.0', id: 'permission-denied', method: 'session/request_permission',
          params: {
            sessionId: HERMES_SESSION_ID,
            toolCall: { toolCallId: 'tool-1', title: 'Write', kind: 'edit' },
            options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
          },
        });
      } else if (message.id === 'permission-denied') {
        process.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    await expect(broker.prompt('Attempt write.')).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(runtime.received).toContainEqual(expect.objectContaining({
      id: 'permission-denied',
      result: { outcome: { outcome: 'cancelled' } },
    }));
    await broker.dispose();
  });

  test.each([
    ['wrong name', { name: 'impostor', version: HERMES_ACP_VERSION }],
    ['wrong version', { name: 'hermes-agent', version: '0.20.3' }],
  ])('rejects Hermes attestation with %s', async (_label, agentInfo) => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo,
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });
    await expect(broker.start()).rejects.toThrow(/agent mismatch/i);
    await broker.dispose();
  });

  test('rejects Hermes when only terminal setup is advertised instead of authenticated runtime credentials', async () => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method !== 'initialize') return;
      process.send({
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
          agentCapabilities: hermesCapabilities(),
          authMethods: [{ id: 'hermes-setup', name: 'Configure Hermes provider', type: 'terminal' }],
        },
      });
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });

    await expect(broker.start()).rejects.toThrow(/authenticated runtime method/i);
    expect(runtime.received).not.toContainEqual(expect.objectContaining({ method: 'session/new' }));
    await broker.dispose();
  });

  test('rejects OpenCode when the exact-pinned ACP omits a required lifecycle capability', async () => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method !== 'initialize') return;
      process.send({
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'OpenCode', version: OPENCODE_ACP_VERSION },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {}, fork: {} },
          },
          authMethods: OPENCODE_AUTH_METHODS,
        },
      });
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });

    await expect(broker.start()).rejects.toThrow(/sessionCapabilities\.close/i);
    expect(runtime.received).not.toContainEqual(expect.objectContaining({ method: 'authenticate' }));
    await broker.dispose();
  });

  test('keeps abort non-throwing when ACP stdin disappears mid-prompt', async () => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/new') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: HERMES_SESSION_ID, ...hermesModels('provider/model-a') },
        });
      }
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    await broker.start();
    const prompt = broker.prompt('Keep running.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.child.stdin.destroy();

    expect(() => broker.abort()).not.toThrow();
    await expect(prompt).rejects.toMatchObject({ name: 'AgentAbortError' });
    await broker.dispose();
  });

  test('turns an ACP stdin broken pipe into a bounded prompt failure', async () => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/new') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: HERMES_SESSION_ID, ...hermesModels('provider/model-a') },
        });
      }
    });
    const spawn = spawnRecorder(runtime);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    await broker.start();
    const prompt = broker.prompt('Keep running.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.child.stdin.emit('error', new Error('broken pipe'));

    await expect(prompt).rejects.toThrow(/ACP stdin error: broken pipe/i);
    await broker.dispose();
  });

  test('terminates the detached ACP process group instead of only the direct child', async () => {
    const runtime = fakeAcpProcess((message, process) => {
      if (message.method === 'initialize') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hermes-agent', version: HERMES_ACP_VERSION },
            agentCapabilities: hermesCapabilities(),
            authMethods: HERMES_AUTH_METHODS,
          },
        });
      } else if (message.method === 'authenticate') {
        process.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/new') {
        process.send({
          jsonrpc: '2.0', id: message.id,
          result: { sessionId: HERMES_SESSION_ID, ...hermesModels('provider/model-a') },
        });
      }
    });
    Object.assign(runtime.child, { pid: 424_242 });
    const spawn = spawnRecorder(runtime);
    const processKill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const broker = new AcpStdioBroker({
      profile: HERMES_ACP_PROFILE,
      cwd: '/workspace',
      environment: { PATH: '/usr/bin' },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });
    try {
      await broker.start();
      const disposing = broker.dispose();
      expect(processKill).toHaveBeenCalledWith(-424_242, 'SIGTERM');
      runtime.child.emit('close', 0, 'SIGTERM');
      await disposing;
      expect(runtime.child.kill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });
});
