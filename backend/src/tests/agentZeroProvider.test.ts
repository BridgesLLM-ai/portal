import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AgentSessionConfig } from '../agents/AgentProvider.interface';
import type {
  AgentZeroSocketFactory,
  AgentZeroSocketLike,
} from '../agents/providers/agentZero/AgentZeroConnectorStream';
import type {
  AgentZeroHostGatewayController,
  AgentZeroHostGatewayStatus,
} from '../agents/providers/agentZero/AgentZeroHostGateway';
import type { AgentZeroSelectableOAuthModel } from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';

const mockGetProviderAvailability = jest.fn(() => ({
  capabilities: { supportedExecutionScopes: ['HOST_OPERATOR'] },
}));

jest.mock('../agents/providerAvailability', () => ({
  getProviderAvailability: () => mockGetProviderAvailability(),
}));

const previousSessionDirectory = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
const sessionDirectory = mkdtempSync(path.join(tmpdir(), 'agent-zero-provider-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionDirectory;

const {
  AgentZeroProvider,
  agentZeroResponseText,
} = require('../agents/providers/AgentZeroProvider') as typeof import('../agents/providers/AgentZeroProvider');
const {
  AgentZeroConnectorClient,
} = require('../agents/providers/agentZero/AgentZeroConnectorClient') as typeof import('../agents/providers/agentZero/AgentZeroConnectorClient');

const SESSION_COOKIE = 'session=server-side-secret-cookie';

const HOST_GATEWAY_READY_STATUS: AgentZeroHostGatewayStatus = {
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
};

const hostGateway: AgentZeroHostGatewayController = {
  ensureReady: jest.fn(async (): Promise<AgentZeroHostGatewayStatus> => HOST_GATEWAY_READY_STATUS),
  snapshot: jest.fn(),
  stop: jest.fn(async () => undefined),
};

function hostConfig(userId: string, extra: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    executionContext: {
      scope: 'HOST_OPERATOR',
      source: 'PORTAL_SERVER',
      userId,
    },
    ...extra,
  };
}

function oauthModelSelection(id: string): AgentZeroSelectableOAuthModel {
  const separator = id.indexOf('/');
  const providerId = id.slice(0, separator) as AgentZeroSelectableOAuthModel['providerId'];
  const model = id.slice(separator + 1);
  return {
    id,
    providerId,
    model,
    displayName: model,
    providerDisplayName: providerId,
    description: '',
  };
}

function capabilities(features: string[], authRequired = true): Record<string, unknown> {
  return {
    protocol: 'a0-connector.v1',
    version: '0.1.0',
    agent_zero_version: '2.5',
    auth: ['session'],
    auth_required: authRequired,
    transports: ['http', 'websocket'],
    websocket_namespace: '/ws',
    websocket_handlers: ['plugins/_a0_connector/ws_connector'],
    features,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function sequentialFetch(...responses: Array<Response | (() => Response)>): jest.MockedFunction<typeof fetch> {
  const queue = [...responses];
  return jest.fn(async (
    _input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1],
  ) => {
    const next = queue.shift();
    if (!next) throw new Error('Unexpected fetch call');
    return typeof next === 'function' ? next() : next;
  }) as unknown as jest.MockedFunction<typeof fetch>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function callDetails(fetchMock: jest.MockedFunction<typeof fetch>, index: number) {
  const [input, init] = fetchMock.mock.calls[index];
  return {
    url: String(input),
    headers: (init?.headers || {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
  };
}

class ProviderStreamSocket implements AgentZeroSocketLike {
  connected = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(
    private readonly contextId: string,
    private readonly response: string,
    private readonly precursorEvents: Array<{
      event: string;
      heading?: string;
      text?: string;
      meta?: Record<string, unknown>;
    }> = [],
    private readonly emitAssistantEvent = true,
    private readonly completionStatus = 'completed',
    private readonly completionError?: unknown,
  ) {}

  on(event: string, listener: (...args: any[]) => void): AgentZeroSocketLike {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener?: (...args: any[]) => void): AgentZeroSocketLike {
    if (listener) this.listeners.get(event)?.delete(listener);
    else this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: any[]): AgentZeroSocketLike {
    const payload = (args[0] || {}) as Record<string, unknown>;
    const acknowledge = args[1] as (value: unknown) => void;
    const ok = (data: Record<string, unknown>) => acknowledge({
      correlationId: 'provider-stream-test',
      results: [{
        handlerId: 'plugins._a0_connector.api.ws_connector.WsConnector',
        ok: true,
        data,
      }],
    });
    if (event === 'connector_hello') {
      ok({
        protocol: 'a0-connector.v1',
        agent_zero_version: '2.5',
        features: ['connector_subscribe_context', 'connector_send_message'],
      });
    } else if (event === 'connector_subscribe_context') {
      ok({ context_id: this.contextId, subscribed: true, last_sequence: Number(payload.from || 0) });
    } else if (event === 'connector_send_message') {
      ok({
        context_id: this.contextId,
        status: 'accepted',
        client_message_id: payload.client_message_id,
      });
      queueMicrotask(() => {
        let sequence = 5;
        for (const precursor of this.precursorEvents) {
          this.serverEmit('connector_context_event', {
            context_id: this.contextId,
            sequence,
            event: precursor.event,
            timestamp: '2026-07-18T11:00:04Z',
            data: {
              ...(precursor.heading ? { heading: precursor.heading } : {}),
              ...(precursor.text ? { text: precursor.text } : {}),
              ...(precursor.meta ? { meta: precursor.meta } : {}),
            },
          });
          sequence += 1;
        }
        if (this.emitAssistantEvent) {
          this.serverEmit('connector_context_event', {
            context_id: this.contextId,
            sequence,
            event: 'assistant_message',
            timestamp: '2026-07-18T11:00:05Z',
            data: { text: this.response },
          });
        }
        this.serverEmit('connector_context_complete', {
          context_id: this.contextId,
          status: this.completionStatus,
          response: this.response,
          ...(this.completionError !== undefined ? { error: this.completionError } : {}),
        });
      });
    } else {
      throw new Error(`Unexpected Socket.IO event: ${event}`);
    }
    return this;
  }

  connect(): AgentZeroSocketLike {
    queueMicrotask(() => {
      this.connected = true;
      this.serverEmit('connect');
    });
    return this;
  }

  disconnect(): AgentZeroSocketLike {
    this.connected = false;
    return this;
  }

  removeAllListeners(): AgentZeroSocketLike {
    this.listeners.clear();
    return this;
  }

  private serverEmit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
  }
}

function providerStreamFactory(
  contextId: string,
  response: string,
  precursorEvents: ConstructorParameters<typeof ProviderStreamSocket>[2] = [],
  emitAssistantEvent = true,
  completionStatus = 'completed',
  completionError?: unknown,
): AgentZeroSocketFactory {
  let created = false;
  return () => {
    if (created) throw new Error('Unexpected Agent Zero stream reconnect');
    created = true;
    return new ProviderStreamSocket(
      contextId,
      response,
      precursorEvents,
      emitAssistantEvent,
      completionStatus,
      completionError,
    );
  };
}

afterAll(() => {
  if (previousSessionDirectory === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
  else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionDirectory;
  rmSync(sessionDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  mockGetProviderAvailability.mockReset();
  mockGetProviderAvailability.mockReturnValue({
    capabilities: { supportedExecutionScopes: ['HOST_OPERATOR'] },
  });
  jest.mocked(hostGateway.ensureReady).mockClear();
});

describe('AgentZeroConnectorClient', () => {
  test('discovers the pinned HTTP protocol without sending the protected cookie', async () => {
    const fetchMock = sequentialFetch(jsonResponse(capabilities(['chat_create'])));
    const client = new AgentZeroConnectorClient({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock });

    await expect(client.getCapabilities()).resolves.toMatchObject({
      protocol: 'a0-connector.v1',
      agentZeroVersion: '2.5',
      authRequired: true,
      features: ['chat_create'],
    });

    const discovery = callDetails(fetchMock, 0);
    expect(discovery.url).toBe('http://127.0.0.1:50001/api/plugins/_a0_connector/v1/capabilities');
    expect(discovery.headers.Cookie).toBeUndefined();
  });

  test('rejects non-loopback and unauthenticated connector deployments before protected use', async () => {
    expect(() => new AgentZeroConnectorClient({
      baseUrl: 'http://agent-zero.example.com',
      sessionCookie: SESSION_COOKIE,
      fetchImpl: jest.fn() as any,
    })).toThrow(/loopback/i);
    expect(() => new AgentZeroConnectorClient({
      baseUrl: 'http://agent-zero.example.com',
      allowRemote: true,
      sessionCookie: SESSION_COOKIE,
      fetchImpl: jest.fn() as any,
    })).toThrow(/HTTPS/i);

    const fetchMock = sequentialFetch(jsonResponse(capabilities(['chat_create'], false)));
    const client = new AgentZeroConnectorClient({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock });
    await expect(client.call('chat_create', {})).rejects.toThrow(/must require session authentication/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('requires a server-side cookie and enforces the response-size ceiling', async () => {
    const missingCookieFetch = sequentialFetch(jsonResponse(capabilities(['chat_create'])));
    const missingCookieClient = new AgentZeroConnectorClient({
      sessionCookie: '',
      fetchImpl: missingCookieFetch,
    });
    await expect(missingCookieClient.call('chat_create', {})).rejects.toThrow(/protected server-side session authentication is unavailable/i);
    expect(missingCookieFetch).toHaveBeenCalledTimes(1);

    const oversizedFetch = sequentialFetch(
      jsonResponse(capabilities(['chat_create'])),
      jsonResponse({ context_id: 'CtxLarge', padding: 'x'.repeat(2_000) }),
    );
    const boundedClient = new AgentZeroConnectorClient({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: oversizedFetch,
      maxResponseBytes: 1_024,
    });
    await expect(boundedClient.call('chat_create', {})).rejects.toThrow(/larger than the configured limit/i);
  });

  test('redacts authentication material from connector errors', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(['chat_create'])),
      jsonResponse({
        error: `bad cookie=${SESSION_COOKIE} token=remote-secret`,
      }, 400),
    );
    const client = new AgentZeroConnectorClient({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock });

    let failure: Error | null = null;
    try {
      await client.call('chat_create', {});
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toMatch(/HTTP 400/);
    expect(failure?.message).not.toMatch(/server-side-secret-cookie|remote-secret/);
  });
});

describe('AgentZeroProvider response normalization', () => {
  test('never turns an arbitrary diagnostic object into assistant JSON text', () => {
    expect(agentZeroResponseText({
      error: {
        message: 'AuthenticationError: raw provider failure',
        cookie: 'session=private-cookie',
      },
      diagnostic: { traceback: 'internal stack' },
    })).toBe('');
    expect(agentZeroResponseText({
      status: 'failed',
      message: 'litellm.AuthenticationError: raw JSON diagnostic',
    })).toBe('');
    expect(agentZeroResponseText({
      response: { content: 'Human-readable completion' },
    })).toBe('Human-readable completion');
    expect(agentZeroResponseText(JSON.stringify({
      response: { content: 'Human-readable serialized completion' },
    }))).toBe('Human-readable serialized completion');
    expect(agentZeroResponseText(JSON.stringify({
      response: {
        error: {
          message: 'OpenrouterException - No user or org id found in auth cookie',
          code: 401,
          cookie: 'session=private-cookie',
        },
      },
    }))).toBe('');
    expect(agentZeroResponseText({
      response: {
        content: {
          text: {
            error: {
              message: 'litellm.ModelError: nested provider failure',
              access_token: 'nested-wrapper-secret',
            },
          },
        },
      },
    })).toBe('');
    expect(agentZeroResponseText(
      'litellm.AuthenticationError: OpenrouterException - {"error":{"code":401}}',
    )).toBe('');
    expect(agentZeroResponseText('{"answer":42}')).toBe(fencedJson({ answer: 42 }));
    expect(agentZeroResponseText('[1,2,3]')).toBe(fencedJson([1, 2, 3]));
    expect(agentZeroResponseText('litellm.RateLimitError: quota exceeded')).toBe('');
    expect(agentZeroResponseText('litellm.ModelError: selected model failed')).toBe('');
    expect(agentZeroResponseText(
      'Here is why litellm.AuthenticationError: can appear, and how to troubleshoot it safely.',
    )).toBe('Here is why litellm.AuthenticationError: can appear, and how to troubleshoot it safely.');
    expect(agentZeroResponseText(JSON.stringify({
      answer: 'The OpenrouterException message means the provider rejected its fallback credential.',
    }))).toBe(fencedJson({
      answer: 'The OpenrouterException message means the provider rejected its fallback credential.',
    }));

    const markdown = '# Result\n\n- first\n- second\n\n```ts\nconst ok = true;\n```';
    expect(agentZeroResponseText(markdown)).toBe(markdown);
    expect(agentZeroResponseText({
      response: [{ content: { text: '**Nested markdown**' } }],
    })).toBe('**Nested markdown**');
    expect(agentZeroResponseText({
      type: 'tool_result',
      toolName: 'shell',
      toolResult: { stdout: 'must stay in the tool card' },
    })).toBe('');
    expect(agentZeroResponseText({
      role: 'toolresult',
      content: 'must also stay in the tool card',
    })).toBe('');
    expect(agentZeroResponseText([
      { type: 'tool_call', tool_call: { name: 'shell', arguments: { command: 'pwd' } } },
      { response: { content: 'Visible answer only.' } },
    ])).toBe('Visible answer only.');

    const malformed = '{"answer":"partial","access_token":"malformed-secret","authorization":"Bearer malformed-bearer"';
    const malformedResult = agentZeroResponseText(malformed);
    expect(malformedResult).toContain('[redacted]');
    expect(malformedResult).not.toMatch(/malformed-secret|malformed-bearer/);

    const oversized = `{"access_token":"oversized-secret","padding":"${'x'.repeat(1024 * 1024 + 128)}`;
    const oversizedResult = agentZeroResponseText(oversized);
    expect(oversizedResult.length).toBeLessThanOrEqual(1024 * 1024);
    expect(oversizedResult).toContain('[redacted]');
    expect(oversizedResult).not.toContain('oversized-secret');
  });
});

describe('AgentZeroProvider HTTP adapter', () => {
  test('keeps the production execution-scope gate fail-closed', async () => {
    mockGetProviderAvailability.mockReturnValue({
      capabilities: { supportedExecutionScopes: [] },
    });
    const fetchMock = sequentialFetch(jsonResponse(capabilities(['chat_create'])));
    const provider = new AgentZeroProvider({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock, hostGateway });

    await expect(provider.startSession('user-gated', hostConfig('user-gated')))
      .rejects.toThrow(/does not support HOST_OPERATOR/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('maps create/get/list/reset/delete and pause/resume/nudge without exposing other contexts', async () => {
    const features = [
      'chat_create', 'chat_get', 'chats_list', 'chat_reset', 'chat_delete', 'pause', 'nudge',
    ];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxLife1', created_at: '2026-07-18T10:00:00Z', agent_profile: 'default' }),
      jsonResponse({
        context_id: 'CtxLife1',
        name: 'Operator work',
        created_at: '2026-07-18T10:00:00Z',
        last_message: '2026-07-18T10:05:00Z',
        running: false,
        agent_profile: 'default',
      }),
      jsonResponse({ context_id: 'CtxLife1', running: false }),
      jsonResponse({ context_id: 'CtxLife1', status: 'reset' }),
      jsonResponse({ ok: true, context_id: 'CtxLife1', status: 'paused', paused: true }),
      jsonResponse({ ok: true, context_id: 'CtxLife1', status: 'running', paused: false }),
      jsonResponse({ ok: true, context_id: 'CtxLife1', status: 'nudged', message: 'Process reset, agent nudged.' }),
      jsonResponse({ context_id: 'CtxLife1', running: false }),
      jsonResponse({ context_id: 'CtxLife1', status: 'deleted' }),
    );
    const provider = new AgentZeroProvider({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock, hostGateway });

    const sessionId = await provider.startSession('user-life', hostConfig('user-life', {
      metadata: { agentProfile: 'default', title: 'Portal operator' },
    }));
    expect(sessionId).not.toBe('CtxLife1');
    await expect(provider.getSession(sessionId)).resolves.toMatchObject({
      sessionId,
      title: 'Operator work',
      status: 'active',
      metadata: {
        supportsAbort: false,
        agentProfile: 'default',
      },
    });
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.metadata).toMatchObject({
      agentZeroRemoteContextId: 'CtxLife1',
    });
    await expect(provider.listSessions('user-life')).resolves.toEqual([
      expect.objectContaining({
        sessionId,
        title: 'Portal operator',
        status: 'active',
        metadata: expect.objectContaining({ protocol: 'portal-native-history.v1' }),
      }),
    ]);
    await expect(provider.resetSession(sessionId)).resolves.toBeUndefined();
    await expect(provider.pauseSession(sessionId)).resolves.toMatchObject({ ok: true, status: 'paused' });
    await expect(provider.resumeSession(sessionId)).resolves.toMatchObject({ ok: true, status: 'running' });
    await expect(provider.nudgeSession(sessionId)).resolves.toMatchObject({ ok: true, status: 'nudged' });
    await expect(provider.abortActiveRun(sessionId)).resolves.toBe(false);
    await expect(provider.terminateSession(sessionId)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(callDetails(fetchMock, 0).headers.Cookie).toBeUndefined();
    for (let index = 1; index < fetchMock.mock.calls.length; index += 1) {
      expect(callDetails(fetchMock, index).headers.Cookie).toBe(SESSION_COOKIE);
    }
  });

  test('lists Portal-owned Agent Zero sessions without consulting a failed connector', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(['chat_create', 'chats_list'])),
      jsonResponse({ context_id: 'CtxLocalList' }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
    });
    const sessionId = await provider.startSession(
      'user-local-list',
      hostConfig('user-local-list', { metadata: { title: 'Local transcript' } }),
    );

    await expect(provider.listSessions('user-local-list')).resolves.toEqual([
      expect.objectContaining({
        sessionId,
        title: 'Local transcript',
        status: 'active',
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('reads a populated Portal sidecar without consulting unavailable remote history', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(['chat_create', 'chat_get', 'log_tail'])),
      jsonResponse({ context_id: 'CtxLocalHistory' }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
    });
    const sessionId = await provider.startSession('user-local-history', hostConfig('user-local-history'));
    const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const local = store.loadNativeSession('AGENT_ZERO', sessionId)!;
    store.appendNativeMessage(local, {
      id: 'local-user',
      role: 'user',
      content: 'Saved locally',
      timestamp: '2026-07-22T10:00:00.000Z',
    });
    store.appendNativeMessage(local, {
      id: 'local-assistant',
      role: 'assistant',
      content: 'Local markdown\n\n- survives\n- connector outage',
      timestamp: '2026-07-22T10:00:01.000Z',
    });

    await expect(provider.getHistoryPage(sessionId, 20)).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: 'local-user', content: 'Saved locally' }),
        expect.objectContaining({ id: 'local-assistant', content: expect.stringContaining('- connector outage') }),
      ],
      hasMoreBefore: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('uses authenticated streaming and maps bounded log snapshots with update deduplication', async () => {
    const features = ['chat_create', 'message_send', 'chat_get', 'log_tail'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxSend1' }),
      jsonResponse({ context_id: 'CtxSend1', running: false }),
      jsonResponse({ context_id: 'CtxSend1', last_sequence: 4 }),
      jsonResponse({
        context_id: 'CtxSend1',
        events: [
          { sequence: 1, event: 'user_message', timestamp: '2026-07-18T11:00:00Z', data: { text: 'Question' } },
          { sequence: 2, event: 'assistant_message', timestamp: '2026-07-18T11:00:01Z', data: { text: 'Draft' } },
        ],
        last_sequence: 4,
        has_more: true,
      }),
      jsonResponse({
        context_id: 'CtxSend1',
        events: [
          { sequence: 2, event: 'assistant_message', timestamp: '2026-07-18T11:00:02Z', data: { text: 'Revised answer' } },
          { sequence: 3, event: 'warning', timestamp: '2026-07-18T11:00:03Z', data: { text: 'Check result' } },
          { sequence: 4, event: 'status', timestamp: '2026-07-18T11:00:04Z', data: { text: 'internal status' } },
        ],
        last_sequence: 4,
        has_more: false,
      }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory('CtxSend1', 'Final answer.'),
      streamCompletionGraceMs: 0,
    });
    const onChunk = jest.fn();
    const onStatus = jest.fn();

    const sessionId = await provider.startSession('user-send', hostConfig('user-send'));
    await expect(provider.sendMessage(
      sessionId,
      'Question',
      onChunk,
      onStatus,
      undefined,
      { userId: 'user-send', label: 'owner@example.com', role: 'OWNER' },
    )).resolves.toMatchObject({
      fullText: 'Final answer.',
      metadata: { streaming: true, replay: true, supportsAbort: false },
    });
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith('Final answer.');
    expect(onStatus).toHaveBeenLastCalledWith({ type: 'status', content: '' });

    await expect(provider.getHistory(sessionId)).resolves.toEqual([
      expect.objectContaining({ role: 'user', content: 'Question' }),
      expect.objectContaining({ role: 'assistant', content: 'Final answer.' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await provider.abortActiveRun(sessionId))).not.toContain(SESSION_COOKIE);

    await expect(provider.sendMessage(
      sessionId,
      'Not yours',
      undefined,
      undefined,
      undefined,
      { userId: 'different-user', label: 'other@example.com' },
    )).rejects.toThrow(/does not belong/);
  });

  test('reserves the exact logical run before readiness I/O so concurrent sends cannot overlap', async () => {
    const features = ['chat_create', 'message_send', 'chat_get'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxConcurrent' }),
      jsonResponse({ context_id: 'CtxConcurrent', running: false }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory('CtxConcurrent', 'Only one answer.'),
      streamCompletionGraceMs: 0,
    });
    const sessionId = await provider.startSession(
      'user-concurrent',
      hostConfig('user-concurrent'),
    );
    const readiness = deferred<AgentZeroHostGatewayStatus>();
    jest.mocked(hostGateway.ensureReady).mockImplementationOnce(() => readiness.promise);

    const first = provider.sendMessage(
      sessionId,
      'First message',
      undefined,
      undefined,
      undefined,
      { userId: 'user-concurrent', label: 'owner@example.com', requestId: 'run-one' },
    );
    const overlapping = provider.sendMessage(
      sessionId,
      'Overlapping message',
      undefined,
      undefined,
      undefined,
      { userId: 'user-concurrent', label: 'owner@example.com', requestId: 'run-two' },
    );

    await expect(overlapping).rejects.toThrow(/already has an active run/i);
    expect(hostGateway.ensureReady).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    readiness.resolve(HOST_GATEWAY_READY_STATUS);
    await expect(first).resolves.toMatchObject({
      fullText: 'Only one answer.',
      metadata: {
        contextId: sessionId,
        supportsAbort: false,
      },
    });
    expect(sessionId).not.toBe('CtxConcurrent');
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const persisted = loadNativeSession('AGENT_ZERO', sessionId);
    expect(persisted?.metadata?.agentZeroRemoteContextId).toBe('CtxConcurrent');
    expect(persisted?.messages.filter((entry) => entry.role === 'user')).toHaveLength(1);
    expect(persisted?.messages.some((entry) => entry.content === 'Overlapping message')).toBe(false);
  });

  test('treats context error events as sanitized nonterminal status and recovers to stream completion', async () => {
    const features = ['chat_create', 'message_send', 'chat_get'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxRecover' }),
      jsonResponse({ context_id: 'CtxRecover', running: false }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory('CtxRecover', 'Recovered answer.', [{
        event: 'error',
        heading: 'Retrying after password=heading-secret',
        text: 'token=provider-secret temporary failure',
        meta: {
          password: 'metadata-secret',
          detail: 'Bearer nested-secret',
        },
      }]),
      streamCompletionGraceMs: 0,
    });
    const onChunk = jest.fn();
    const onStatus = jest.fn();
    const sessionId = await provider.startSession('user-recover', hostConfig('user-recover'));

    await expect(provider.sendMessage(
      sessionId,
      'Recover from the provider event',
      onChunk,
      onStatus,
      undefined,
      { userId: 'user-recover', label: 'owner@example.com', requestId: 'run-recover' },
    )).resolves.toMatchObject({
      fullText: 'Recovered answer.',
      metadata: { contextId: sessionId, supportsAbort: false },
    });

    const providerErrorStatus = onStatus.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.providerEvent === 'error');
    expect(providerErrorStatus).toMatchObject({
      type: 'status',
      severity: 'error',
      terminal: false,
      providerEvent: 'error',
    });
    expect(onStatus.mock.calls.some(([event]) => event?.type === 'error')).toBe(false);
    expect(onChunk).toHaveBeenCalledWith('Recovered answer.');
    const serializedStatuses = JSON.stringify(onStatus.mock.calls);
    expect(serializedStatuses).not.toMatch(/heading-secret|provider-secret|metadata-secret|nested-secret/);
    expect(serializedStatuses).toContain('Agent Zero could not complete the request');
    expect(serializedStatuses).not.toMatch(/password=|token=|Bearer|metadata/);
  });

  test('sanitizes provider failures emitted as utility messages instead of rendering raw exception walls', async () => {
    const features = ['chat_create', 'message_send', 'chat_get'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxUtilityFailure' }),
      jsonResponse({ context_id: 'CtxUtilityFailure', running: false }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory('CtxUtilityFailure', 'Recovered answer.', [{
        event: 'util_message',
        heading: 'Critical error occurred, retrying',
        text: 'litellm.exceptions.APIError: OpenAIException - {"error":{"code":"access_denied","message":"Codex proxy access denied"}}',
        meta: { authorization: 'Bearer private-token', traceback: '/a0/usr/private' },
      }]),
      streamCompletionGraceMs: 0,
    });
    const onStatus = jest.fn();
    const sessionId = await provider.startSession('user-utility-failure', hostConfig('user-utility-failure'));

    await expect(provider.sendMessage(
      sessionId,
      'Recover from utility failure',
      undefined,
      onStatus,
      undefined,
      { userId: 'user-utility-failure', label: 'owner@example.com', requestId: 'run-utility-failure' },
    )).resolves.toMatchObject({ fullText: 'Recovered answer.' });

    const serializedStatuses = JSON.stringify(onStatus.mock.calls);
    expect(serializedStatuses).toContain('Agent Zero could not authenticate the selected model provider');
    expect(serializedStatuses).not.toMatch(/litellm|OpenAIException|access_denied|private-token|traceback|\/a0\/usr/i);
  });

  test('rejects a serialized provider failure without emitting or persisting diagnostic JSON', async () => {
    const rawFailure = JSON.stringify({
      error: {
        message: 'litellm.AuthenticationError: OpenrouterException - No user or org id found in auth cookie',
        code: 401,
        cookie: 'session=private-cookie',
        authorization: 'Bearer private-token',
      },
    });
    const features = ['chat_create', 'message_send', 'chat_get', 'log_tail'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxSerializedFailure' }),
      jsonResponse({ context_id: 'CtxSerializedFailure', running: false }),
      jsonResponse({ context_id: 'CtxSerializedFailure', last_sequence: 1 }),
      jsonResponse({
        context_id: 'CtxSerializedFailure',
        events: [{
          sequence: 1,
          event: 'assistant_message',
          timestamp: '2026-07-20T23:30:00Z',
          data: { text: rawFailure },
        }],
        last_sequence: 1,
        has_more: false,
      }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory('CtxSerializedFailure', rawFailure),
      streamCompletionGraceMs: 0,
    });
    const onChunk = jest.fn();
    const onStatus = jest.fn();
    const sessionId = await provider.startSession(
      'user-serialized-failure',
      hostConfig('user-serialized-failure'),
    );

    await expect(provider.sendMessage(
      sessionId,
      'Trigger provider failure',
      onChunk,
      onStatus,
      undefined,
      { userId: 'user-serialized-failure', label: 'owner@example.com' },
    )).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringMatching(/fell back to an OpenRouter default that is not connected/i),
    });
    expect(onChunk).not.toHaveBeenCalled();
    expect(JSON.stringify(onStatus.mock.calls)).not.toMatch(
      /private-cookie|private-token|AuthenticationError|OpenrouterException|\{"error"/i,
    );

    await expect(provider.getHistory(sessionId)).resolves.toEqual([
      expect.objectContaining({ role: 'user', content: 'Trigger provider failure' }),
    ]);
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const persisted = loadNativeSession('AGENT_ZERO', sessionId);
    expect(persisted?.messages.filter((entry) => entry.role === 'assistant')).toEqual([]);
    expect(JSON.stringify(persisted)).not.toMatch(
      /private-cookie|private-token|AuthenticationError|OpenrouterException|\{"error"/i,
    );
  });

  test('rejects a provider failure supplied only by the terminal completion payload', async () => {
    const rawFailure = JSON.stringify({
      error: {
        message: 'litellm.AuthenticationError: OpenrouterException - No user or org id found in auth cookie',
        code: 401,
        cookie: 'session=terminal-private-cookie',
      },
    });
    const features = ['chat_create', 'message_send', 'chat_get', 'log_tail'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxTerminalFailure' }),
      jsonResponse({ context_id: 'CtxTerminalFailure', running: false }),
      jsonResponse({ context_id: 'CtxTerminalFailure', last_sequence: 0 }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory('CtxTerminalFailure', rawFailure, [], false),
      streamCompletionGraceMs: 0,
    });
    const onChunk = jest.fn();
    const onStatus = jest.fn();
    const sessionId = await provider.startSession(
      'user-terminal-failure',
      hostConfig('user-terminal-failure'),
    );

    await expect(provider.sendMessage(
      sessionId,
      'Trigger terminal provider failure',
      onChunk,
      onStatus,
      undefined,
      { userId: 'user-terminal-failure', label: 'owner@example.com' },
    )).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringMatching(/fell back to an OpenRouter default that is not connected/i),
    });
    expect(onChunk).not.toHaveBeenCalled();
    expect(JSON.stringify(onStatus.mock.calls)).not.toMatch(
      /terminal-private-cookie|AuthenticationError|OpenrouterException|\{"error"/i,
    );

    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const persisted = loadNativeSession('AGENT_ZERO', sessionId);
    expect(persisted?.messages.filter((entry) => entry.role === 'assistant')).toEqual([]);
  });

  test.each([
    ['failed', undefined],
    ['failure', undefined],
    ['rejected', undefined],
    ['completed', { message: 'litellm.ModelError: selected OAuth model failed', token: 'completion-secret' }],
  ])('rejects terminal status %s (including completion-only errors) before persistence', async (
    completionStatus,
    completionError,
  ) => {
    const suffix = completionStatus === 'completed' ? 'CompletedError' : completionStatus;
    const contextId = `CtxTerminal${suffix}`;
    const features = ['chat_create', 'message_send', 'chat_get', 'log_tail'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: contextId }),
      jsonResponse({ context_id: contextId, running: false }),
      jsonResponse({ context_id: contextId, last_sequence: 0 }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      socketFactory: providerStreamFactory(
        contextId,
        '',
        [],
        false,
        completionStatus,
        completionError,
      ),
      streamCompletionGraceMs: 0,
    });
    const sessionId = await provider.startSession(
      `user-terminal-${suffix}`,
      hostConfig(`user-terminal-${suffix}`),
    );

    await expect(provider.sendMessage(
      sessionId,
      'Trigger terminal failure',
      undefined,
      undefined,
      undefined,
      { userId: `user-terminal-${suffix}`, label: 'owner@example.com' },
    )).rejects.toBeInstanceOf(Error);

    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    const persisted = loadNativeSession('AGENT_ZERO', sessionId);
    expect(persisted?.messages.filter((entry) => entry.role === 'assistant')).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain('completion-secret');
  });

  test('preserves legitimate JSON-only assistant responses, including ordinary error fields', () => {
    expect(agentZeroResponseText(JSON.stringify({
      ok: false,
      error: 'The submitted example is missing a required field.',
      code: 'VALIDATION_RESULT',
    }))).toBe(fencedJson({
      ok: false,
      error: 'The submitted example is missing a required field.',
      code: 'VALIDATION_RESULT',
    }));
    expect(agentZeroResponseText({
      rows: [{ id: 1, status: 'failed' }],
      summary: 'This is the requested test report.',
      apiKey: 'must-not-render',
    })).toBe(fencedJson({
      rows: [{ id: 1, status: 'failed' }],
      summary: 'This is the requested test report.',
      apiKey: '[redacted]',
    }));
    expect(agentZeroResponseText(JSON.stringify({
      answer: 'safe content',
      access_token: 'access-secret',
      bearerToken: 'bearer-secret',
      id_token: 'id-secret',
      private_key: 'private-secret',
      credentialBundle: 'credential-secret',
      event: { meta: { token: 'nested-secret', note: 'keep me' } },
    }))).toBe(fencedJson({
      answer: 'safe content',
      access_token: '[redacted]',
      bearerToken: '[redacted]',
      id_token: '[redacted]',
      private_key: '[redacted]',
      credentialBundle: '[redacted]',
      event: { meta: { token: '[redacted]', note: 'keep me' } },
    }));
    expect(agentZeroResponseText(JSON.stringify([{
      answer: 'safe array content',
      authorization: 'Bearer array-secret',
    }]))).toBe(fencedJson([{
      answer: 'safe array content',
      authorization: '[redacted]',
    }]));
    expect(agentZeroResponseText(42)).toBe('42');
    expect(agentZeroResponseText(false)).toBe('false');
  });

  test('imports legacy connector history once, then pages the authoritative local sidecar', async () => {
    const features = ['chat_create', 'chat_get', 'log_tail'];
    const events = [
      { sequence: 1, event: 'user_message', timestamp: '2026-07-18T11:00:00Z', data: { text: 'Oldest question' } },
      { sequence: 2, event: 'status', timestamp: '2026-07-18T11:00:01Z', data: { text: 'internal' } },
      { sequence: 3, event: 'assistant_message', timestamp: '2026-07-18T11:00:02Z', data: { text: 'Middle answer' } },
      { sequence: 4, event: 'code_output', timestamp: '2026-07-18T11:00:03Z', data: { text: 'tool output' } },
      { sequence: 5, event: 'warning', timestamp: '2026-07-18T11:00:04Z', data: { text: 'Check result' } },
      { sequence: 6, event: 'assistant_message', timestamp: '2026-07-18T11:00:05Z', data: { text: 'Latest answer' } },
    ];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxPaged' }),
      jsonResponse({ context_id: 'CtxPaged', last_sequence: 6 }),
      jsonResponse({ context_id: 'CtxPaged', events, last_sequence: 6, has_more: false }),
    );
    const provider = new AgentZeroProvider({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock, hostGateway });
    const sessionId = await provider.startSession('user-paged', hostConfig('user-paged'));

    const latest = await provider.getHistoryPage(sessionId, 2);
    expect(latest).toMatchObject({ hasMoreBefore: true, beforeSequence: expect.any(Number) });
    expect(latest.messages.map((message) => message.content)).toEqual(['Check result', 'Latest answer']);

    const older = await provider.getHistoryPage(sessionId, 2, latest.beforeSequence!);
    expect(older).toMatchObject({ hasMoreBefore: false, beforeSequence: null });
    expect(older.messages.map((message) => message.content)).toEqual(['Oldest question', 'Middle answer']);
    expect(callDetails(fetchMock, 3).body).toMatchObject({ context_id: 'CtxPaged', after: 0, limit: 250 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('leaves a failed legacy import retryable and commits only the later successful snapshot', async () => {
    const features = ['chat_create', 'chat_get', 'log_tail'];
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxImportRetry' }),
      jsonResponse({ error: 'temporarily unavailable' }, 503),
      jsonResponse({ context_id: 'CtxImportRetry', last_sequence: 1 }),
      jsonResponse({
        context_id: 'CtxImportRetry',
        events: [{
          sequence: 1,
          event: 'assistant_message',
          timestamp: '2026-07-22T20:00:00Z',
          data: { text: 'Recovered legacy answer' },
        }],
        last_sequence: 1,
        has_more: false,
      }),
    );
    const provider = new AgentZeroProvider({ sessionCookie: SESSION_COOKIE, fetchImpl: fetchMock, hostGateway });
    const sessionId = await provider.startSession('user-import-retry', hostConfig('user-import-retry'));

    await expect(provider.getHistoryPage(sessionId, 20)).rejects.toThrow();
    const recovered = await provider.getHistoryPage(sessionId, 20);

    expect(recovered.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Recovered legacy answer' }),
    ]);
    expect(recovered.hasMoreBefore).toBe(false);
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.metadata).toMatchObject({
      agentZeroLegacyHistoryImportedMessages: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('applies a catalog-validated OAuth model and returns only sanitized dynamic model metadata', async () => {
    const features = ['chat_create', 'chat_delete', 'model_switcher'];
    const modelState = {
      ok: true,
      allowed: true,
      configured_preset: 'Default',
      effective_preset: 'Power',
      presets: [
        {
          name: 'Power',
          chat: { provider: 'openrouter', name: 'openai/gpt-5', api_key: 'preset-secret' },
          utility: { provider: 'openrouter', name: 'openai/gpt-5-mini' },
        },
      ],
      chat_providers: [
        { value: 'codex_oauth', label: 'OpenAI Codex OAuth', has_api_key: true, api_key: 'provider-secret' },
      ],
      main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex', label: 'codex_oauth/gpt-5.3-codex', has_api_key: true },
    };
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxModel' }),
      jsonResponse(modelState),
      jsonResponse(modelState),
      jsonResponse(modelState),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      validateModelSelection: async (model) => oauthModelSelection(model),
    });

    const sessionId = await provider.startSession(
      'user-model',
      hostConfig('user-model', { model: 'codex_oauth/gpt-5.3-codex' }),
    );
    expect(callDetails(fetchMock, 3).body).toEqual({
      action: 'set_override',
      context_id: 'CtxModel',
      main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' },
    });

    const metadata = await provider.getModelMetadata(sessionId);
    expect(metadata).toMatchObject({
      available: true,
      allowed: true,
      effectivePreset: 'Power',
      presets: [{ name: 'Power', chat: { provider: 'openrouter', name: 'openai/gpt-5' } }],
      providers: [{ value: 'codex_oauth', hasApiKey: true }],
    });
    expect(JSON.stringify(metadata)).not.toMatch(/preset-secret|provider-secret|api_key/i);
  });

  test('requires an exact OAuth model before chat_create when model switching is available', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(['chat_create', 'chat_delete', 'model_switcher'])),
    );
    const validateModelSelection = jest.fn(async (model: string) => oauthModelSelection(model));
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      validateModelSelection,
    });

    await expect(provider.startSession(
      'user-model-required',
      hostConfig('user-model-required'),
    )).rejects.toThrow(/choose a model from a connected agent zero oauth provider/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(validateModelSelection).not.toHaveBeenCalled();
  });

  test('deletes both local and remote context state when initial model application fails', async () => {
    const state = {
      allowed: true,
      override: null,
      chat_providers: [
        { value: 'codex_oauth', label: 'OpenAI Codex OAuth', has_api_key: true },
      ],
    };
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(['chat_create', 'chat_delete', 'model_switcher'])),
      jsonResponse({ context_id: 'CtxInitialModelFailure' }),
      jsonResponse(state),
      jsonResponse({ ...state, main_model: { provider: 'codex_oauth', name: 'wrong-model' } }),
      jsonResponse({ ...state, override: null }),
      jsonResponse({ context_id: 'CtxInitialModelFailure', status: 'deleted' }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      validateModelSelection: async (model) => oauthModelSelection(model),
    });

    await expect(provider.startSession(
      'user-initial-model-failure',
      hostConfig('user-initial-model-failure', { model: 'codex_oauth/gpt-5.3-codex' }),
    )).rejects.toThrow(/did not confirm/i);
    const { listNativeSessions } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(listNativeSessions('AGENT_ZERO', 'user-initial-model-failure')).toEqual([]);
    expect(callDetails(fetchMock, 5).body).toEqual({ context_id: 'CtxInitialModelFailure' });
  });

  test('changes and resets a live model remotely before updating the durable session', async () => {
    const features = ['chat_create', 'chat_delete', 'chat_get', 'model_switcher'];
    const initialState = {
      allowed: true,
      override: null,
      chat_providers: [
        { value: 'codex_oauth', label: 'OpenAI Codex OAuth', has_api_key: true },
        { value: 'github_copilot_oauth', label: 'GitHub Copilot OAuth', has_api_key: true },
      ],
    };
    const codexApplied = {
      ...initialState,
      override: { main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' } },
      main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' },
    };
    const copilotApplied = {
      ...initialState,
      override: { main_model: { provider: 'github_copilot_oauth', name: 'gpt-5-mini' } },
      main_model: { provider: 'github_copilot_oauth', name: 'gpt-5-mini' },
    };
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxLiveModel' }),
      jsonResponse(initialState),
      jsonResponse(codexApplied),
      jsonResponse({ context_id: 'CtxLiveModel', running: false, last_sequence: 0 }),
      jsonResponse(codexApplied),
      jsonResponse(copilotApplied),
      jsonResponse({ context_id: 'CtxLiveModel', running: false, last_sequence: 0 }),
      jsonResponse(copilotApplied),
      jsonResponse({ ...initialState, override: null, main_model: { provider: 'codex_oauth', name: 'default' } }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      validateModelSelection: async (model) => oauthModelSelection(model),
    });

    const sessionId = await provider.startSession(
      'user-live-model',
      hostConfig('user-live-model', { model: 'codex_oauth/gpt-5.3-codex' }),
    );
    await expect(provider.setSessionModel(
      sessionId,
      'github_copilot_oauth/gpt-5-mini',
    )).resolves.toMatchObject({ model: 'github_copilot_oauth/gpt-5-mini' });
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.model).toBe('github_copilot_oauth/gpt-5-mini');
    expect(callDetails(fetchMock, 6).body).toMatchObject({
      action: 'set_override',
      main_model: { provider: 'github_copilot_oauth', name: 'gpt-5-mini' },
    });

    await expect(provider.setSessionModel(sessionId, null)).resolves.toMatchObject({ model: null });
    expect(callDetails(fetchMock, 9).body).toMatchObject({ action: 'clear', context_id: 'CtxLiveModel' });
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.model).toBeUndefined();
  });

  test('restores the prior remote model and leaves the durable model unchanged when verification fails', async () => {
    const features = ['chat_create', 'chat_delete', 'chat_get', 'model_switcher'];
    const initialState = {
      allowed: true,
      override: null,
      chat_providers: [
        { value: 'codex_oauth', label: 'OpenAI Codex OAuth', has_api_key: true },
        { value: 'github_copilot_oauth', label: 'GitHub Copilot OAuth', has_api_key: true },
      ],
    };
    const codexApplied = {
      ...initialState,
      override: { main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' } },
      main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' },
    };
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxRollbackModel' }),
      jsonResponse(initialState),
      jsonResponse(codexApplied),
      jsonResponse({ context_id: 'CtxRollbackModel', running: false, last_sequence: 0 }),
      jsonResponse(codexApplied),
      jsonResponse({ ...codexApplied, main_model: { provider: 'github_copilot_oauth', name: 'wrong-model' } }),
      jsonResponse(codexApplied),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      validateModelSelection: async (model) => oauthModelSelection(model),
    });
    const sessionId = await provider.startSession(
      'user-rollback-model',
      hostConfig('user-rollback-model', { model: 'codex_oauth/gpt-5.3-codex' }),
    );

    await expect(provider.setSessionModel(
      sessionId,
      'github_copilot_oauth/gpt-5-mini',
    )).rejects.toThrow(/did not confirm/i);
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.model).toBe('codex_oauth/gpt-5.3-codex');
    expect(callDetails(fetchMock, 7).body).toMatchObject({
      action: 'set_override',
      main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' },
    });
  });

  test('fails closed when a failed change also returns the wrong rollback state', async () => {
    const features = ['chat_create', 'chat_delete', 'chat_get', 'model_switcher'];
    const initialState = {
      allowed: true,
      override: null,
      chat_providers: [
        { value: 'codex_oauth', label: 'OpenAI Codex OAuth', has_api_key: true },
        { value: 'github_copilot_oauth', label: 'GitHub Copilot OAuth', has_api_key: true },
      ],
    };
    const codexApplied = {
      ...initialState,
      override: { main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' } },
      main_model: { provider: 'codex_oauth', name: 'gpt-5.3-codex' },
    };
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities(features)),
      jsonResponse({ context_id: 'CtxRollbackUnproven' }),
      jsonResponse(initialState),
      jsonResponse(codexApplied),
      jsonResponse({ context_id: 'CtxRollbackUnproven', running: false, last_sequence: 0 }),
      jsonResponse(codexApplied),
      jsonResponse({ ...codexApplied, main_model: { provider: 'github_copilot_oauth', name: 'wrong-model' } }),
      jsonResponse({ ...codexApplied, main_model: { provider: 'codex_oauth', name: 'also-wrong' } }),
    );
    const provider = new AgentZeroProvider({
      sessionCookie: SESSION_COOKIE,
      fetchImpl: fetchMock,
      hostGateway,
      validateModelSelection: async (model) => oauthModelSelection(model),
    });
    const sessionId = await provider.startSession(
      'user-rollback-unproven',
      hostConfig('user-rollback-unproven', { model: 'codex_oauth/gpt-5.3-codex' }),
    );

    await expect(provider.setSessionModel(
      sessionId,
      'github_copilot_oauth/gpt-5-mini',
    )).rejects.toThrow(/could not prove or restore one consistent per-chat model/i);
    const { loadNativeSession } = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
    expect(loadNativeSession('AGENT_ZERO', sessionId)?.model).toBe('codex_oauth/gpt-5.3-codex');
  });
});
