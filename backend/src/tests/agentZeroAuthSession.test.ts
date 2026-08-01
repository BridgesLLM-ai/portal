import type { Stats } from 'fs';
import {
  AgentZeroAuthSessionManager,
  readProtectedAgentZeroCredentials,
} from '../agents/providers/agentZero/AgentZeroAuthSession';
import { AgentZeroConnectorClient } from '../agents/providers/agentZero/AgentZeroConnectorClient';

const AUTH_FILE = '/etc/bridgesllm/agent-zero.env';
const AUTH_CONTENT = 'AUTH_LOGIN=portal-owner\nAUTH_PASSWORD=correct-horse-battery-staple\n';

function protectedAuthStats(mode = 0o100600): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode,
  } as Stats;
}

function capabilities(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'a0-connector.v1',
    version: '0.1.0',
    agent_zero_version: 'v2.5',
    auth: ['session'],
    auth_required: true,
    transports: ['http', 'websocket'],
    websocket_namespace: '/ws',
    websocket_handlers: ['plugins/_a0_connector/ws_connector'],
    features: ['chat_create', 'chats_list'],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function loginResponse(cookie: string, location = '/'): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Set-Cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax`,
    },
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

function manager(fetchImpl: typeof fetch): AgentZeroAuthSessionManager {
  return new AgentZeroAuthSessionManager({
    authFilePath: AUTH_FILE,
    fetchImpl,
    readAuthFile: () => AUTH_CONTENT,
    statAuthFile: () => protectedAuthStats(),
    verifyTtlMs: 0,
    protocolTtlMs: 60_000,
  });
}

describe('Agent Zero protected server-side session authentication', () => {
  test('logs in through the official browser session and exposes only sanitized readiness', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities()),
      loginResponse('session=server-side-secret'),
      jsonResponse({ contexts: [] }),
    );
    const auth = manager(fetchMock);

    await expect(auth.probe(true)).resolves.toMatchObject({
      state: 'authenticated',
      authenticated: true,
      reason: expect.stringMatching(/protected session authentication is ready/i),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, loginInit] = fetchMock.mock.calls[1];
    expect(loginInit).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(String(loginInit?.body)).toBe(
      'username=portal-owner&password=correct-horse-battery-staple',
    );
    const [, verifyInit] = fetchMock.mock.calls[2];
    expect((verifyInit?.headers as Record<string, string>).Cookie).toBe('session=server-side-secret');

    const serialized = JSON.stringify(auth.snapshot());
    expect(serialized).not.toMatch(/server-side-secret|correct-horse-battery-staple|portal-owner/);
  });

  test('classifies rejected credentials without exposing secrets', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities()),
      new Response(null, { status: 302, headers: { Location: '/login' } }),
    );
    const auth = manager(fetchMock);

    await expect(auth.probe(true)).resolves.toMatchObject({
      state: 'needs_login',
      authenticated: false,
      reason: expect.stringMatching(/rejected/i),
    });
    expect(JSON.stringify(auth.snapshot())).not.toMatch(/correct-horse-battery-staple|portal-owner/);
  });

  test('renews an expired session once and retries the protected connector operation', async () => {
    const fetchMock = sequentialFetch(
      jsonResponse(capabilities()),
      jsonResponse(capabilities()),
      loginResponse('session=first-session'),
      jsonResponse({ contexts: [] }),
      jsonResponse({ error: 'expired' }, 401),
      loginResponse('session=renewed-session'),
      jsonResponse({ contexts: [] }),
      jsonResponse({ context_id: 'CtxRenewed' }),
    );
    const auth = manager(fetchMock);
    const client = new AgentZeroConnectorClient({
      fetchImpl: fetchMock,
      sessionProvider: auth,
    });

    await expect(client.call('chat_create', {})).resolves.toEqual({ context_id: 'CtxRenewed' });
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect((fetchMock.mock.calls[4][1]?.headers as Record<string, string>).Cookie)
      .toBe('session=first-session');
    expect((fetchMock.mock.calls[7][1]?.headers as Record<string, string>).Cookie)
      .toBe('session=renewed-session');
    expect(auth.snapshot()).toMatchObject({ state: 'authenticated', authenticated: true });
  });

  test('fails closed on protocol drift and unsafe login redirects', async () => {
    const malformed = manager(sequentialFetch(
      jsonResponse(capabilities({ websocket_handlers: [] })),
    ));
    await expect(malformed.probe(true)).resolves.toMatchObject({ state: 'error', authenticated: false });

    const unsafeRedirect = manager(sequentialFetch(
      jsonResponse(capabilities()),
      loginResponse('session=must-not-be-used', 'https://attacker.example/login-complete'),
    ));
    await expect(unsafeRedirect.probe(true)).resolves.toMatchObject({
      state: 'error',
      authenticated: false,
      reason: expect.stringMatching(/cross-origin/i),
    });
    expect(JSON.stringify(unsafeRedirect.snapshot())).not.toContain('must-not-be-used');
  });

  test('aborts a response body that hangs after headers and permits a fresh readiness attempt', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new Error('aborted hanging response body'));
            }, { once: true });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
      .mockResolvedValueOnce(jsonResponse(capabilities()))
      .mockResolvedValueOnce(loginResponse('session=recovered-session'))
      .mockResolvedValueOnce(jsonResponse({ contexts: [] })) as jest.MockedFunction<typeof fetch>;
    const auth = new AgentZeroAuthSessionManager({
      authFilePath: AUTH_FILE,
      fetchImpl: fetchMock,
      readAuthFile: () => AUTH_CONTENT,
      statAuthFile: () => protectedAuthStats(),
      requestTimeoutMs: 250,
      verifyTtlMs: 0,
      protocolTtlMs: 60_000,
    });

    try {
      const first = auth.probe(true);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(250);

      await expect(first).resolves.toMatchObject({
        state: 'error',
        authenticated: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await expect(auth.probe(true)).resolves.toMatchObject({
        state: 'authenticated',
        authenticated: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  test('forced recovery aborts the owned generation before starting a distinct request', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = jest.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted stale request')), {
            once: true,
          });
        });
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return jsonResponse(capabilities());
      })
      .mockResolvedValueOnce(loginResponse('session=fresh-generation'))
      .mockResolvedValueOnce(jsonResponse({ contexts: [] })) as jest.MockedFunction<typeof fetch>;
    const auth = new AgentZeroAuthSessionManager({
      authFilePath: AUTH_FILE,
      fetchImpl: fetchMock,
      readAuthFile: () => AUTH_CONTENT,
      statAuthFile: () => protectedAuthStats(),
      requestTimeoutMs: 120_000,
      verifyTtlMs: 60_000,
      protocolTtlMs: 60_000,
    });

    const stale = auth.probe();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const recoveredA = auth.getSessionCookie(true);
    const recoveredB = auth.getSessionCookie(true);
    await expect(Promise.all([recoveredA, recoveredB])).resolves.toEqual([
      'session=fresh-generation',
      'session=fresh-generation',
    ]);
    await stale;

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(auth.snapshot()).toMatchObject({
      state: 'authenticated',
      authenticated: true,
      reason: expect.stringMatching(/ready/i),
    });
    await expect(auth.getSessionCookie()).resolves.toBe('session=fresh-generation');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('does not accumulate a fresh attempt when an aborted transport refuses to settle', async () => {
    jest.useFakeTimers();
    const fetchMock = (jest.fn(() => new Promise<Response>(() => undefined)) as unknown) as jest.MockedFunction<typeof fetch>;
    const auth = new AgentZeroAuthSessionManager({
      authFilePath: AUTH_FILE,
      fetchImpl: fetchMock,
      readAuthFile: () => AUTH_CONTENT,
      statAuthFile: () => protectedAuthStats(),
      requestTimeoutMs: 120_000,
      verifyTtlMs: 60_000,
      protocolTtlMs: 60_000,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    try {
      const first = auth.getSessionCookie(false, firstController.signal);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      firstController.abort();
      await expect(first).rejects.toMatchObject({ state: 'error' });

      const recovery = auth.getSessionCookie(true, secondController.signal);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      secondController.abort();
      await expect(recovery).rejects.toMatchObject({ state: 'error' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('requires a root-owned private, non-symlink credential file', () => {
    expect(readProtectedAgentZeroCredentials(
      AUTH_FILE,
      () => AUTH_CONTENT,
      () => protectedAuthStats(),
    )).toEqual({
      username: 'portal-owner',
      password: 'correct-horse-battery-staple',
    });

    expect(() => readProtectedAgentZeroCredentials(
      AUTH_FILE,
      () => AUTH_CONTENT,
      () => protectedAuthStats(0o100640),
    )).toThrow(/not configured correctly/i);
    expect(() => readProtectedAgentZeroCredentials(
      AUTH_FILE,
      () => 'AUTH_LOGIN=portal-owner\nAUTH_PASSWORD=one\nAUTH_PASSWORD=two\n',
      () => protectedAuthStats(),
    )).toThrow(/not configured correctly/i);
    expect(() => readProtectedAgentZeroCredentials(
      AUTH_FILE,
      () => 'AUTH_LOGIN=portal-owner\nAUTH_PASSWORD=secret\nDISABLE_AUTH=true\n',
      () => protectedAuthStats(),
    )).toThrow(/not configured correctly/i);
    expect(() => readProtectedAgentZeroCredentials(
      AUTH_FILE,
      () => "AUTH_LOGIN='portal-owner\nAUTH_PASSWORD=secret\n",
      () => protectedAuthStats(),
    )).toThrow(/not configured correctly/i);
  });
});
