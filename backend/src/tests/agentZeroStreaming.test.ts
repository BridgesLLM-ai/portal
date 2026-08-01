import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AgentSessionConfig } from '../agents/AgentProvider.interface';
import type {
  AgentZeroSocketFactory,
  AgentZeroSocketFactoryOptions,
  AgentZeroSocketLike,
} from '../agents/providers/agentZero/AgentZeroConnectorStream';
import type {
  AgentZeroHostGatewayController,
  AgentZeroHostGatewayStatus,
} from '../agents/providers/agentZero/AgentZeroHostGateway';

const mockGetProviderAvailability = jest.fn(() => ({
  capabilities: { supportedExecutionScopes: ['HOST_OPERATOR'] },
}));

jest.mock('../agents/providerAvailability', () => ({
  getProviderAvailability: () => mockGetProviderAvailability(),
}));

const mockSocketIoClient = jest.fn();
jest.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => mockSocketIoClient(...args),
}));

const previousSessionDirectory = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
const sessionDirectory = mkdtempSync(path.join(tmpdir(), 'agent-zero-streaming-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionDirectory;

const {
  AgentZeroProvider,
} = require('../agents/providers/AgentZeroProvider') as typeof import('../agents/providers/AgentZeroProvider');
const {
  AgentZeroConnectorClient,
} = require('../agents/providers/agentZero/AgentZeroConnectorClient') as typeof import('../agents/providers/agentZero/AgentZeroConnectorClient');

const SESSION_COOKIE = 'session=server-side-stream-cookie';

const hostGateway: AgentZeroHostGatewayController = {
  ensureReady: jest.fn(async (): Promise<AgentZeroHostGatewayStatus> => ({
    state: 'ready',
    installed: true,
    running: true,
    ready: true,
    cliVersion: '2.5',
    expectedCliVersion: '2.5',
    gatewayId: 'bridgesllm-portal-host',
    capabilities: {
      scope: 'HOST_OPERATOR',
      fileRead: true,
      fileWrite: true,
      codeExecution: true,
      browser: false,
      computerUse: false,
    },
    reason: 'fixture gateway ready',
  })),
  snapshot: jest.fn(),
  stop: jest.fn(async () => undefined),
};

type Ack = (value: unknown) => void;
type SocketScript = (
  socket: FakeAgentZeroSocket,
  event: string,
  payload: Record<string, unknown>,
  ack: Ack,
) => void;

class FakeAgentZeroSocket implements AgentZeroSocketLike {
  connected = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(
    private readonly script: SocketScript,
    private readonly connectionError?: Error,
  ) {}

  on(event: string, listener: (...args: any[]) => void): AgentZeroSocketLike {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener?: (...args: any[]) => void): AgentZeroSocketLike {
    if (!listener) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): AgentZeroSocketLike {
    this.script(this, event, (args[0] || {}) as Record<string, unknown>, args[1] as Ack);
    return this;
  }

  connect(): AgentZeroSocketLike {
    void Promise.resolve().then(() => {
      if (this.connectionError) this.serverEmit('connect_error', this.connectionError);
      else {
        this.connected = true;
        this.serverEmit('connect');
      }
    });
    return this;
  }

  disconnect(): AgentZeroSocketLike {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.serverEmit('disconnect', 'io client disconnect');
    return this;
  }

  removeAllListeners(): AgentZeroSocketLike {
    this.listeners.clear();
    return this;
  }

  serverEmit(event: string, ...args: unknown[]): void {
    if (event === 'disconnect') this.connected = false;
    for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
  }
}

function capabilities(features: string[] = ['chat_create', 'chat_get', 'message_send']): Record<string, unknown> {
  return {
    protocol: 'a0-connector.v1',
    version: '0.1.0',
    agent_zero_version: '2.5',
    auth: ['session'],
    auth_required: true,
    transports: ['http', 'websocket'],
    websocket_namespace: '/ws',
    websocket_handlers: ['plugins/_a0_connector/ws_connector'],
    features,
  };
}

function ackOk(data: Record<string, unknown>): Record<string, unknown> {
  return {
    correlationId: 'test-correlation',
    results: [{
      handlerId: 'plugins._a0_connector.api.ws_connector.WsConnector',
      ok: true,
      data,
    }],
  };
}

function defaultSocketScript(
  onSend?: (socket: FakeAgentZeroSocket, payload: Record<string, unknown>) => void,
  onSubscribe?: (socket: FakeAgentZeroSocket, payload: Record<string, unknown>) => number,
): SocketScript {
  return (socket, event, payload, ack) => {
    if (event === 'connector_hello') {
      ack(ackOk({
        protocol: 'a0-connector.v1',
        agent_zero_version: '2.5',
        features: ['connector_subscribe_context', 'connector_send_message'],
      }));
      return;
    }
    if (event === 'connector_subscribe_context') {
      const cursor = onSubscribe?.(socket, payload) ?? Number(payload.from || 0);
      ack(ackOk({ context_id: payload.context_id, subscribed: true, last_sequence: cursor }));
      return;
    }
    if (event === 'connector_send_message') {
      ack(ackOk({
        context_id: payload.context_id,
        status: 'accepted',
        client_message_id: payload.client_message_id,
      }));
      void Promise.resolve().then(() => onSend?.(socket, payload));
      return;
    }
    throw new Error(`Unexpected Socket.IO event: ${event}`);
  };
}

function factoryFor(...sockets: FakeAgentZeroSocket[]): AgentZeroSocketFactory {
  const queue = [...sockets];
  return () => {
    const socket = queue.shift();
    if (!socket) throw new Error('Unexpected socket creation');
    return socket;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sequentialFetch(...responses: Response[]): jest.MockedFunction<typeof fetch> {
  const queue = [...responses];
  return jest.fn(async () => {
    const response = queue.shift();
    if (!response) throw new Error('Unexpected fetch call');
    return response;
  }) as unknown as jest.MockedFunction<typeof fetch>;
}

function hostConfig(userId: string): AgentSessionConfig {
  return {
    executionContext: {
      scope: 'HOST_OPERATOR',
      source: 'PORTAL_SERVER',
      userId,
    },
  };
}

function event(
  contextId: string,
  sequence: number,
  eventName: string,
  text: string,
  heading = '',
): Record<string, unknown> {
  return {
    context_id: contextId,
    sequence,
    event: eventName,
    timestamp: '2026-07-18T16:00:00.000Z',
    data: { text, heading },
  };
}

afterAll(() => {
  if (previousSessionDirectory === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
  else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionDirectory;
  rmSync(sessionDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  mockSocketIoClient.mockReset();
  mockGetProviderAvailability.mockReset();
  mockGetProviderAvailability.mockReturnValue({
    capabilities: { supportedExecutionScopes: ['HOST_OPERATOR'] },
  });
  jest.mocked(hostGateway.ensureReady).mockClear();
});

describe('Agent Zero v2.5 authenticated streaming', () => {
  test('connects the JavaScript Socket.IO client to the official /ws namespace', async () => {
    const contextId = 'CtxOfficialNamespace';
    const socket = new FakeAgentZeroSocket(defaultSocketScript((activeSocket) => {
      activeSocket.serverEmit('connector_context_complete', {
        context_id: contextId,
        status: 'completed',
        response: 'namespace verified',
      });
    }));
    mockSocketIoClient.mockReturnValue(socket);
    const client = new AgentZeroConnectorClient({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      streamCompletionGraceMs: 0,
    });

    await expect(client.streamMessage({
      contextId,
      message: 'Use the official namespace',
      fromSequence: 0,
    })).resolves.toMatchObject({ response: 'namespace verified' });
    expect(mockSocketIoClient).toHaveBeenCalledWith(
      'http://127.0.0.1:50001/ws',
      expect.objectContaining({
        path: '/socket.io',
        auth: { handlers: ['plugins/_a0_connector/ws_connector'] },
        transports: ['websocket'],
      }),
    );
  });

  test('maps ordered text, thought, tool, code, and status events without claiming abort', async () => {
    const contextId = 'CtxStreamOrdered';
    const socket = new FakeAgentZeroSocket(defaultSocketScript((activeSocket) => {
      const events = [
        event(contextId, 2, 'util_message', 'Checking the system.'),
        event(contextId, 3, 'tool_start', 'Starting.', 'filesystem'),
        event(contextId, 4, 'tool_output', 'Reading files.', 'filesystem'),
        event(contextId, 5, 'tool_end', 'Complete.', 'filesystem'),
        event(contextId, 6, 'code_start', 'Running command.', 'terminal'),
        event(contextId, 7, 'code_output', 'Command output.', 'terminal'),
        event(contextId, 8, 'assistant_delta', 'Hel'),
        event(contextId, 9, 'assistant_delta', 'lo'),
        event(contextId, 10, 'assistant_message', 'Hello'),
        event(contextId, 11, 'status', 'Finished.'),
      ];
      for (const item of events) activeSocket.serverEmit('connector_context_event', item);
      activeSocket.serverEmit('connector_context_complete', {
        context_id: contextId,
        status: 'completed',
        response: 'Hello',
      });
    }));
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities()),
      jsonResponse({ context_id: contextId }),
      jsonResponse({ context_id: contextId, running: false, last_sequence: 1 }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: factoryFor(socket),
      streamCompletionGraceMs: 0,
    });
    const chunks: string[] = [];
    const statuses: Array<{ type: string; content?: string }> = [];

    const portalSessionId = await provider.startSession('stream-owner', hostConfig('stream-owner'));
    const result = await provider.sendMessage(
      portalSessionId,
      'Say hello',
      (chunk) => chunks.push(chunk),
      (status) => statuses.push(status),
      undefined,
      { userId: 'stream-owner', label: 'owner@example.com', role: 'OWNER' },
    );

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(statuses.map((status) => status.type)).toEqual(expect.arrayContaining([
      'thinking', 'tool_start', 'tool_update', 'tool_end', 'status',
    ]));
    expect(statuses.filter((status) => [
      'thinking', 'tool_start', 'tool_update', 'tool_end', 'tool_start', 'tool_update', 'status',
    ].includes(status.type)).map((status) => status.content)).toEqual(expect.arrayContaining([
      'Checking the system.',
      'filesystem\n\nStarting.',
      'filesystem\n\nReading files.',
      'filesystem\n\nComplete.',
      'terminal\n\nRunning command.',
      'terminal\n\nCommand output.',
      'Finished.',
    ]));
    expect(result).toMatchObject({
      fullText: 'Hello',
      metadata: {
        streaming: true,
        replay: true,
        supportsAbort: false,
        reconnects: 0,
        eventsProcessed: 10,
        lastSequence: 11,
      },
    });
    await expect(provider.abortActiveRun(portalSessionId)).resolves.toBe(false);
  });

  test('reconnects from the durable cursor, replays missed events, and suppresses exact duplicates', async () => {
    const contextId = 'CtxReplay';
    const seen: number[] = [];
    const firstSocket = new FakeAgentZeroSocket(defaultSocketScript((socket) => {
      socket.serverEmit('connector_context_event', event(contextId, 11, 'assistant_delta', 'A'));
      socket.serverEmit('disconnect', 'transport close');
    }));
    const secondSocket = new FakeAgentZeroSocket(defaultSocketScript(undefined, (socket, payload) => {
      expect(payload.from).toBe(11);
      socket.serverEmit('connector_context_snapshot', {
        context_id: contextId,
        events: [
          event(contextId, 11, 'assistant_delta', 'A'),
          event(contextId, 11, 'assistant_delta', 'A revised'),
          event(contextId, 11, 'assistant_delta', 'A'),
          event(contextId, 12, 'assistant_delta', 'B'),
        ],
        last_sequence: 12,
      });
      queueMicrotask(() => socket.serverEmit('connector_context_complete', {
        context_id: contextId,
        status: 'completed',
        response: 'AB',
      }));
      return 12;
    }));
    const client = new AgentZeroConnectorClient({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      socketFactory: factoryFor(firstSocket, secondSocket),
      streamReconnectDelayMs: 0,
      streamCompletionGraceMs: 0,
    });

    const result = await client.streamMessage({
      contextId,
      message: 'Continue',
      fromSequence: 10,
      onEvent: (item) => seen.push(item.sequence),
    });

    expect(seen).toEqual([11, 11, 12]);
    expect(result).toMatchObject({
      contextId,
      lastSequence: 12,
      reconnects: 1,
      eventsProcessed: 3,
      response: 'AB',
    });
  });

  test('renews an expired WebSocket authentication session once', async () => {
    const contextId = 'CtxAuthRenew';
    const calls: boolean[] = [];
    const invalidations = jest.fn();
    const expired = new FakeAgentZeroSocket(defaultSocketScript(), new Error('not authorized'));
    const renewed = new FakeAgentZeroSocket(defaultSocketScript((socket) => {
      socket.serverEmit('connector_context_complete', {
        context_id: contextId,
        status: 'completed',
        response: 'renewed',
      });
    }));
    const optionsSeen: AgentZeroSocketFactoryOptions[] = [];
    const socketFactory: AgentZeroSocketFactory = (_baseUrl, options) => {
      optionsSeen.push(options);
      return optionsSeen.length === 1 ? expired : renewed;
    };
    const client = new AgentZeroConnectorClient({
      sessionProvider: {
        getSessionCookie: async (force = false) => {
          calls.push(force);
          return force ? 'session=renewed' : 'session=expired';
        },
        invalidateSession: invalidations,
      },
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      socketFactory,
      streamCompletionGraceMs: 0,
    });

    await expect(client.streamMessage({
      contextId,
      message: 'Authenticate',
      fromSequence: 0,
    })).resolves.toMatchObject({ response: 'renewed' });
    expect(calls).toEqual([false, true]);
    expect(invalidations).toHaveBeenCalledTimes(1);
    expect(optionsSeen.map((options) => options.cookie)).toEqual(['session=expired', 'session=renewed']);
    expect(optionsSeen[1]).toMatchObject({
      path: '/socket.io',
      namespace: '/ws',
      handler: 'plugins/_a0_connector/ws_connector',
    });
  });

  test('fails closed after bounded reconnect attempts and never resends an ambiguous message', async () => {
    const contextId = 'CtxDisconnect';
    let sendCalls = 0;
    const first = new FakeAgentZeroSocket(defaultSocketScript((socket) => {
      sendCalls += 1;
      socket.serverEmit('disconnect', 'transport close');
    }));
    const failedOne = new FakeAgentZeroSocket(defaultSocketScript(), new Error('offline'));
    const failedTwo = new FakeAgentZeroSocket(defaultSocketScript(), new Error('still offline'));
    const failedThree = new FakeAgentZeroSocket(defaultSocketScript(), new Error('offline again'));
    const client = new AgentZeroConnectorClient({
      sessionProvider: {
        getSessionCookie: async () => SESSION_COOKIE,
        invalidateSession: jest.fn(),
      },
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      socketFactory: factoryFor(first, failedOne, failedTwo, failedThree),
      streamReconnectAttempts: 2,
      streamReconnectDelayMs: 0,
      streamCompletionGraceMs: 0,
    });

    await expect(client.streamMessage({
      contextId,
      message: 'Do not duplicate',
      fromSequence: 0,
    })).rejects.toThrow(/could not reconnect/i);
    expect(sendCalls).toBe(1);
  });

  test('rejects oversized stream payloads before forwarding them', async () => {
    const contextId = 'CtxBounded';
    const onEvent = jest.fn();
    const socket = new FakeAgentZeroSocket(defaultSocketScript((activeSocket) => {
      activeSocket.serverEmit('connector_context_event', event(
        contextId,
        1,
        'tool_output',
        'x'.repeat(70 * 1024),
      ));
    }));
    const client = new AgentZeroConnectorClient({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      socketFactory: factoryFor(socket),
      maxStreamBytes: 64 * 1024,
      streamCompletionGraceMs: 0,
    });

    await expect(client.streamMessage({
      contextId,
      message: 'Bound this',
      fromSequence: 0,
      onEvent,
    })).rejects.toThrow(/byte limit/i);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('rejects an oversized terminal response before returning it to Portal', async () => {
    const contextId = 'CtxBoundedCompletion';
    const socket = new FakeAgentZeroSocket(defaultSocketScript((activeSocket) => {
      activeSocket.serverEmit('connector_context_complete', {
        context_id: contextId,
        status: 'completed',
        response: 'x'.repeat(70 * 1024),
      });
    }));
    const client = new AgentZeroConnectorClient({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      socketFactory: factoryFor(socket),
      maxStreamBytes: 64 * 1024,
      streamCompletionGraceMs: 0,
    });

    await expect(client.streamMessage({
      contextId,
      message: 'Bound the result',
      fromSequence: 0,
    })).rejects.toThrow(/byte limit/i);
  });

  test('cancels the local stream immediately after an authoritative Project abort', async () => {
    const contextId = 'CtxPortalAbort';
    let markMessageAccepted!: () => void;
    const messageAccepted = new Promise<void>((resolve) => { markMessageAccepted = resolve; });
    const socket = new FakeAgentZeroSocket(defaultSocketScript(() => markMessageAccepted()));
    const client = new AgentZeroConnectorClient({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
      socketFactory: factoryFor(socket),
      streamCompletionGraceMs: 0,
    });
    const controller = new AbortController();
    const pending = client.streamMessage({
      contextId,
      message: 'Stop this run',
      fromSequence: 0,
      signal: controller.signal,
    });
    await messageAccepted;

    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled by Portal/i);
    expect(socket.connected).toBe(false);
  });

  test('keeps a three-hour run alive under the explicit twelve-hour safety ceiling', async () => {
    jest.useFakeTimers();
    try {
      const contextId = 'CtxLongRun';
      let markMessageAccepted!: () => void;
      const messageAccepted = new Promise<void>((resolve) => {
        markMessageAccepted = resolve;
      });
      const socket = new FakeAgentZeroSocket(defaultSocketScript(() => markMessageAccepted()));
      const client = new AgentZeroConnectorClient({
        sessionCookie: SESSION_COOKIE,
        fetchImpl: sequentialFetch(jsonResponse(capabilities(['message_send']))),
        socketFactory: factoryFor(socket),
        streamTimeoutMs: 12 * 60 * 60_000,
        streamCompletionGraceMs: 0,
      });
      const resultPromise = client.streamMessage({
        contextId,
        message: 'Long operation',
        fromSequence: 0,
      });
      await jest.advanceTimersByTimeAsync(0);
      await messageAccepted;

      await jest.advanceTimersByTimeAsync(3 * 60 * 60_000);
      socket.serverEmit('connector_context_event', event(contextId, 1, 'status', 'Still working.'));
      socket.serverEmit('connector_context_complete', {
        context_id: contextId,
        status: 'completed',
        response: 'Finished after three hours.',
      });
      await expect(resultPromise).resolves.toMatchObject({
        response: 'Finished after three hours.',
        eventsProcessed: 1,
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
