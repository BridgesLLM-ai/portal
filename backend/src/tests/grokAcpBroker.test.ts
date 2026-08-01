import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import { AgentAbortError } from '../agents/AgentProvider.interface';
import {
  GROK_ACP_AGENT_VERSION,
  GROK_ACP_PROTOCOL_VERSION,
  GrokAcpBroker,
} from '../agents/providers/native/grok/GrokAcpBroker';

const SESSION_ID = '019f7815-aa9a-7af3-ab4a-86f6fef099b0';

interface FakeAcpProcess {
  child: ChildProcessWithoutNullStreams;
  received: Array<Record<string, any>>;
  send(payload: unknown): void;
  sendRaw(text: string): void;
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
  const process: FakeAcpProcess = {
    child: emitter,
    received,
    send: (payload) => stdout.write(`${JSON.stringify(payload)}\n`),
    sendRaw: (text) => stdout.write(text),
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
        queueMicrotask(() => onMessage(message, process));
      }
      newline = input.indexOf('\n');
    }
  });
  return process;
}

function initializeResult(id: number, overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      _meta: { agentVersion: GROK_ACP_AGENT_VERSION },
      ...overrides,
    },
  };
}

function createSpawn(process: FakeAcpProcess) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }> = [];
  const spawnImpl = jest.fn((command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options });
    return process.child;
  });
  return { spawnImpl: spawnImpl as any, calls };
}

describe('Grok Build ACP stdio broker', () => {
  test('pins ACP launch, streams native events, brokers permission, and completes a persisted turn', async () => {
    let promptRequestId: number | null = null;
    const process = fakeAcpProcess((message, runtime) => {
      if (message.method === 'initialize') {
        runtime.send(initializeResult(message.id));
      } else if (message.method === 'session/new') {
        runtime.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: SESSION_ID } });
      } else if (message.method === 'session/prompt') {
        promptRequestId = message.id;
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, _meta: { eventId: 'text-1' }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed ' } } },
        });
        // Duplicate replay notification must not duplicate visible text.
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, _meta: { eventId: 'text-1' }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed ' } } },
        });
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking the service.' } } },
        });
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Restart service', kind: 'execute', status: 'pending', rawInput: { command: 'systemctl restart openclaw' } } },
        });
        runtime.send({
          jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission',
          params: {
            sessionId: SESSION_ID,
            toolCall: { toolCallId: 'tool-1', title: 'Restart service', kind: 'execute', rawInput: { command: 'systemctl restart openclaw' } },
            options: [
              { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      } else if (message.id === 'permission-1') {
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Restart service', kind: 'execute', status: 'completed', rawOutput: 'ok' } },
        });
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the service.' } } },
        });
        runtime.send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } } });
      }
    });
    const spawn = createSpawn(process);
    const chunks: string[] = [];
    const statuses: Array<Record<string, any>> = [];
    const permissions: Array<Record<string, any>> = [];
    const broker = new GrokAcpBroker({
      cwd: '/root/.openclaw/workspace-main',
      model: 'xai/grok-build',
      onChunk: (chunk) => chunks.push(chunk),
      onStatus: (status) => statuses.push(status),
      onPermission: async (request) => {
        permissions.push(request);
        return 'allow-always';
      },
      spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    const result = await broker.prompt('Repair OpenClaw.');

    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]).toMatchObject({
      command: 'grok',
      args: ['--no-auto-update', 'agent', '--model', 'grok-build', 'stdio'],
    });
    expect(spawn.calls[0].options).toMatchObject({
      cwd: '/root/.openclaw/workspace-main',
      env: expect.objectContaining({ GROK_DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' }),
    });
    expect(result).toMatchObject({
      fullText: 'Fixed the service.',
      nativeSessionId: SESSION_ID,
      stopReason: 'end_turn',
      agentVersion: GROK_ACP_AGENT_VERSION,
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    // Grok emits a *numeric* ACP protocol version. The first audit
    // projection compared it as a string and falsely reported it absent.
    expect(typeof result.protocolVersion).toBe('number');
    expect(typeof result.agentVersion).toBe('string');
    expect(result.agentVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(chunks).toEqual(['Fixed ', 'the service.']);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', content: 'Checking the service.' }),
      expect.objectContaining({ type: 'tool_start', toolName: 'shell', toolCallId: 'tool-1' }),
      expect.objectContaining({ type: 'tool_end', toolName: 'shell', toolResult: 'ok' }),
    ]));
    expect(permissions[0]).toMatchObject({ toolCallId: 'tool-1', kind: 'execute' });
    expect(process.received).toContainEqual(expect.objectContaining({
      jsonrpc: '2.0',
      id: 'permission-1',
      result: { outcome: { outcome: 'selected', optionId: 'always' } },
    }));
    broker.close();
  });

  test('reconnects between turns with session/load and suppresses load replay', async () => {
    const chunks: string[] = [];
    const process = fakeAcpProcess((message, runtime) => {
      if (message.method === 'initialize') runtime.send(initializeResult(message.id));
      if (message.method === 'session/load') {
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replay' } } },
        });
        runtime.send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
      if (message.method === 'session/prompt') {
        runtime.send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new answer' } } },
        });
        runtime.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    });
    const spawn = createSpawn(process);
    const broker = new GrokAcpBroker({
      cwd: '/workspace', nativeSessionId: SESSION_ID,
      onChunk: (chunk) => chunks.push(chunk),
      onPermission: async () => 'deny', spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000, promptTimeoutMs: 2_000,
    });

    const result = await broker.prompt('Continue.');

    expect(result.fullText).toBe('new answer');
    expect(chunks).toEqual(['new answer']);
    expect(process.received.map((entry) => entry.method).filter(Boolean)).toEqual([
      'initialize', 'session/load', 'session/prompt',
    ]);
    broker.close();
  });

  test.each([
    ['wrong protocol', { protocolVersion: 2 }, /protocol mismatch/],
    ['wrong version', { _meta: { agentVersion: '0.2.104' } }, /agent mismatch/],
    ['missing session loading', { agentCapabilities: { loadSession: false } }, /persisted-session loading/],
  ])('fails closed on %s', async (_label, overrides, errorPattern) => {
    const process = fakeAcpProcess((message, runtime) => {
      if (message.method === 'initialize') runtime.send(initializeResult(message.id, overrides));
    });
    const spawn = createSpawn(process);
    const broker = new GrokAcpBroker({
      cwd: '/workspace', onPermission: async () => 'deny', spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });
    await expect(broker.start()).rejects.toThrow(errorPattern);
    broker.close();
  });

  test('rejects a corrupted stored session id instead of silently starting a new session', () => {
    expect(() => new GrokAcpBroker({
      cwd: '/workspace',
      nativeSessionId: '--resume=attacker',
      onPermission: async () => 'deny',
    })).toThrow(/stored Grok ACP session id is invalid/i);
  });

  test('fails closed on malformed stdout and does not retry a prompt', async () => {
    const process = fakeAcpProcess((message, runtime) => {
      if (message.method === 'initialize') runtime.sendRaw('not-json\n');
    });
    const spawn = createSpawn(process);
    const broker = new GrokAcpBroker({
      cwd: '/workspace', onPermission: async () => 'deny', spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000,
    });
    await expect(broker.start()).rejects.toThrow(/invalid JSON-RPC/);
    expect(spawn.calls).toHaveLength(1);
    broker.close();
  });

  test('sends the official cancellation notification and surfaces AgentAbortError', async () => {
    let promptRequestId: number | null = null;
    const process = fakeAcpProcess((message, runtime) => {
      if (message.method === 'initialize') runtime.send(initializeResult(message.id));
      if (message.method === 'session/new') runtime.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: SESSION_ID } });
      if (message.method === 'session/prompt') promptRequestId = message.id;
      if (message.method === 'session/cancel') {
        runtime.send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'cancelled' } });
      }
    });
    const spawn = createSpawn(process);
    const broker = new GrokAcpBroker({
      cwd: '/workspace', onPermission: async () => 'deny', spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000, promptTimeoutMs: 2_000, cancelGraceMs: 500,
    });
    const turn = broker.prompt('Long task.');
    await new Promise((resolve) => setImmediate(resolve));

    expect(broker.abort()).toBe(true);
    await expect(turn).rejects.toBeInstanceOf(AgentAbortError);
    expect(process.received).toContainEqual({
      jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID },
    });
    broker.close();
  });

  test('fails a mid-turn process loss without replaying the side-effecting prompt', async () => {
    const process = fakeAcpProcess((message, runtime) => {
      if (message.method === 'initialize') runtime.send(initializeResult(message.id));
      if (message.method === 'session/new') runtime.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: SESSION_ID } });
      if (message.method === 'session/prompt') runtime.child.emit('close', 1, null);
    });
    const spawn = createSpawn(process);
    const broker = new GrokAcpBroker({
      cwd: '/workspace', onPermission: async () => 'deny', spawnImpl: spawn.spawnImpl,
      controlTimeoutMs: 2_000, promptTimeoutMs: 2_000,
    });

    await expect(broker.prompt('Change the server.')).rejects.toThrow(/exited before the request completed/);
    expect(spawn.calls).toHaveLength(1);
    expect(process.received.filter((entry) => entry.method === 'session/prompt')).toHaveLength(1);
    broker.close();
  });
});
