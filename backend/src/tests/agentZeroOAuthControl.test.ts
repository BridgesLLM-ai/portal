import {
  AgentZeroOAuthClient,
  AgentZeroOAuthError,
  type AgentZeroOAuthProviderId,
} from '../agents/providers/agentZero/AgentZeroOAuthControl';
import type { AgentZeroSessionProvider } from '../agents/providers/agentZero/AgentZeroAuthSession';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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

function sessionProvider(cookie = 'session=protected'): AgentZeroSessionProvider & {
  getSessionCookie: jest.Mock<Promise<string>, [boolean?]>;
  invalidateSession: jest.Mock<void, []>;
} {
  return {
    getSessionCookie: jest.fn(async () => cookie),
    invalidateSession: jest.fn(),
  };
}

function csrfResponse(token = 'csrf-safe', cookie = 'csrf_cookie=csrf-safe'): Response {
  return jsonResponse(
    { csrf_token: token },
    200,
    { 'Set-Cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax` },
  );
}

function providerStatus(
  providerId: AgentZeroOAuthProviderId,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const browser = ['gemini_api_oauth', 'xai_grok_oauth'].includes(providerId);
  return {
    provider_id: providerId,
    display_name: providerId,
    short_name: providerId,
    auth_flow: browser ? 'browser_pkce' : 'device_code',
    connected: false,
    supports_manual_callback: browser,
    default_models: [],
    ...overrides,
  };
}

describe('Agent Zero official OAuth control', () => {
  test('uses only the protected CSRF flow and returns a bounded sanitized provider catalog', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        routes_installed: true,
        providers: [
          providerStatus('codex_oauth', {
            connected: true,
            account_label: 'owner@example.com',
            access_token: 'must-never-leave-agent-zero',
            usage_windows: [{
              key: 'week',
              title: 'Week',
              label: 'Resets soon',
              remaining_percent: 84.5,
              reset_at: 123,
            }],
          }),
          providerStatus('github_copilot_oauth'),
          providerStatus('gemini_api_oauth'),
          providerStatus('xai_grok_oauth'),
          providerStatus('unknown_provider' as AgentZeroOAuthProviderId),
        ],
      }),
    );
    const sessions = sessionProvider();
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessions, now: () => 0 });

    const result = await client.status();

    expect(result).toMatchObject({
      available: true,
      routesInstalled: true,
      connectedCount: 1,
      availableCount: 3,
      checkedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(result.providers.map((provider) => provider.providerId)).toEqual([
      'codex_oauth',
      'github_copilot_oauth',
      'gemini_api_oauth',
      'xai_grok_oauth',
    ]);
    expect(JSON.stringify(result)).not.toContain('must-never-leave-agent-zero');
    expect(result.providers[0].usageWindows[0].remainingPercent).toBe(84.5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:50001/api/csrf_token');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:50001/api/plugins/_oauth/status');
    const headers = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Cookie: 'session=protected; csrf_cookie=csrf-safe',
      Origin: 'http://127.0.0.1:50001',
      'X-CSRF-Token': 'csrf-safe',
    });
  });

  test('starts device login without returning upstream secrets or accepting arbitrary providers', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'codex_oauth',
        flow: 'device_code',
        attempt_id: 'attempt-safe',
        verification_url: 'https://auth.openai.com/codex/device',
        user_code: 'ABCD-EFGH',
        interval: 5,
        expires_at: 12345,
        access_token: 'must-not-return',
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    await expect(client.startLogin({ providerId: 'codex_oauth' })).resolves.toEqual({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'attempt-safe',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      authUrl: '',
      redirectUri: '',
      interval: 5,
      expiresAt: 12_345_000,
      message: '',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toEqual({ provider_id: 'codex_oauth' });

    const callsBeforeRejection = fetchMock.mock.calls.length;
    await expect(client.startLogin({ providerId: 'arbitrary_plugin' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRejection);
  });

  test('passes Google client configuration once but never includes it in the response', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'gemini_api_oauth',
        flow: 'browser_pkce',
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=safe-state',
        redirect_uri: 'http://127.0.0.1:50001/oauth/gemini-api/callback',
        expires_at: 12345,
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    const result = await client.startLogin({
      providerId: 'gemini_api_oauth',
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      quotaProjectId: 'quota-project',
    });

    expect(result.flow).toBe('browser_pkce');
    expect(JSON.stringify(result)).not.toContain('google-client-secret');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      provider_id: 'gemini_api_oauth',
      client_id: 'google-client-id',
      client_secret: 'google-client-secret',
      quota_project_id: 'quota-project',
    });
  });

  test('redacts a Google client secret even if the upstream error echoes it without a label', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: false,
        provider_id: 'gemini_api_oauth',
        error: 'OAuth rejected exact-secret-value during setup.',
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    let safeError: AgentZeroOAuthError | null = null;
    try {
      await client.startLogin({
        providerId: 'gemini_api_oauth',
        clientId: 'client-id',
        clientSecret: 'exact-secret-value',
      });
    } catch (error) {
      safeError = error as AgentZeroOAuthError;
    }
    expect(safeError?.message).toContain('[redacted]');
    expect(safeError?.message).not.toContain('exact-secret-value');
  });

  test('honors device poll interval updates and rejects polling browser providers locally', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'github_copilot_oauth',
        completed: false,
        interval: 12,
        expires_at: 999,
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    await expect(client.pollLogin({
      providerId: 'github_copilot_oauth',
      attemptId: 'attempt-1',
    })).resolves.toMatchObject({ completed: false, interval: 12, expiresAt: 999_000 });

    await expect(client.pollLogin({
      providerId: 'xai_grok_oauth',
      attemptId: 'attempt-2',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('preserves an authoritative expired device result even when upstream ok is false', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: false,
        provider_id: 'codex_oauth',
        completed: false,
        expired: true,
        expires_at: 12345,
        error: 'expired',
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });
    await expect(client.pollLogin({
      providerId: 'codex_oauth',
      attemptId: 'attempt-expired',
    })).resolves.toMatchObject({
      providerId: 'codex_oauth',
      completed: false,
      expired: true,
      expiresAt: 12_345_000,
    });
  });

  test('allows manual callbacks only for the two browser providers and bounds callback input', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'xai_grok_oauth',
        completed: true,
        account_label: 'xAI Grok',
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    await expect(client.completeManualCallback({
      providerId: 'xai_grok_oauth',
      callback: 'http://127.0.0.1:56121/callback?code=short&state=safe',
    })).resolves.toMatchObject({ completed: true, accountLabel: 'xAI Grok' });
    await expect(client.completeManualCallback({
      providerId: 'codex_oauth',
      callback: 'code=must-not-send',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.completeManualCallback({
      providerId: 'gemini_api_oauth',
      callback: 'x'.repeat(8193),
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('treats an already-disconnected account as an idempotent success', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'codex_oauth',
        disconnected: false,
        removed_auth_files: ['/secret/path/must-not-return'],
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    await expect(client.disconnect('codex_oauth')).resolves.toEqual({
      providerId: 'codex_oauth',
      disconnected: false,
    });
  });

  test('sanitizes and caps the connected-provider model catalog', async () => {
    const metadata = Array.from({ length: 205 }, (_value, index) => ({
      slug: `model-${index}`,
      display_name: `Model ${index}`,
      description: `Description ${index}`,
      access_token: `secret-${index}`,
    }));
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        routes_installed: true,
        providers: [
          providerStatus('codex_oauth', { connected: true }),
          providerStatus('github_copilot_oauth'),
          providerStatus('gemini_api_oauth'),
          providerStatus('xai_grok_oauth'),
        ],
      }),
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'codex_oauth',
        model_metadata: metadata,
        models: Array.from({ length: 205 }, (_value, index) => `fallback-${index}`),
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    const result = await client.models('codex_oauth');
    expect(result.providerId).toBe('codex_oauth');
    expect(result.models).toHaveLength(200);
    expect(result.models[0]).toEqual({
      id: 'model-0',
      displayName: 'Model 0',
      description: 'Description 0',
    });
    expect(JSON.stringify(result)).not.toContain('secret-');
  });

  test.each([
    ['expired', 'expired'],
    ['revoked', 'revoked'],
  ])('rejects %s OAuth before requesting a model catalog', async (connectionState, expected) => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        routes_installed: true,
        providers: [
          providerStatus('codex_oauth', {
            connected: false,
            connection_state: connectionState,
            warning: `OAuth ${connectionState}`,
          }),
          providerStatus('github_copilot_oauth'),
          providerStatus('gemini_api_oauth'),
          providerStatus('xai_grok_oauth'),
        ],
      }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessionProvider() });

    await expect(client.models('codex_oauth')).rejects.toMatchObject({
      code: 'AUTHENTICATION',
      message: expect.stringMatching(new RegExp(expected, 'i')),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('enumerates models only from currently connected accounts in the authoritative catalog', async () => {
    const fetchMock = sequentialFetch(
      csrfResponse(),
      jsonResponse({
        ok: true,
        routes_installed: true,
        providers: [
          providerStatus('codex_oauth', { connected: true, display_name: 'Codex/ChatGPT' }),
          providerStatus('github_copilot_oauth'),
          providerStatus('gemini_api_oauth', { connected: true, display_name: 'Google Cloud Gemini' }),
          providerStatus('xai_grok_oauth', { connection_state: 'revoked', warning: 'OAuth revoked' }),
        ],
      }),
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'codex_oauth',
        models: ['gpt-5.5-codex'],
      }),
      csrfResponse(),
      jsonResponse({
        ok: true,
        provider_id: 'gemini_api_oauth',
        models: ['gemini-2.5-pro'],
      }),
    );
    const client = new AgentZeroOAuthClient({
      fetchImpl: fetchMock,
      sessionProvider: sessionProvider(),
      now: () => 123,
    });

    await expect(client.modelCatalog()).resolves.toEqual({
      available: true,
      providers: [
        {
          providerId: 'codex_oauth',
          displayName: 'Codex/ChatGPT',
          accountLabel: '',
          connectionState: 'connected',
          models: [{ id: 'gpt-5.5-codex', displayName: 'gpt-5.5-codex', description: '' }],
        },
        {
          providerId: 'github_copilot_oauth',
          displayName: 'github_copilot_oauth',
          accountLabel: '',
          connectionState: 'disconnected',
          models: [],
        },
        {
          providerId: 'gemini_api_oauth',
          displayName: 'Google Cloud Gemini',
          accountLabel: '',
          connectionState: 'connected',
          models: [{ id: 'gemini-2.5-pro', displayName: 'gemini-2.5-pro', description: '' }],
        },
        {
          providerId: 'xai_grok_oauth',
          displayName: 'xai_grok_oauth',
          accountLabel: '',
          connectionState: 'revoked',
          models: [],
        },
      ],
      checkedAt: '1970-01-01T00:00:00.123Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test('refreshes a rejected protected session once and never follows login redirects', async () => {
    const sessions = sessionProvider();
    sessions.getSessionCookie
      .mockResolvedValueOnce('session=expired')
      .mockResolvedValueOnce('session=renewed');
    const fetchMock = sequentialFetch(
      new Response(null, { status: 302, headers: { Location: '/login' } }),
      csrfResponse('new-csrf'),
      jsonResponse({ ok: true, routes_installed: true, providers: [] }),
    );
    const client = new AgentZeroOAuthClient({ fetchImpl: fetchMock, sessionProvider: sessions });

    await expect(client.status()).resolves.toMatchObject({ available: false });
    expect(sessions.invalidateSession).toHaveBeenCalledTimes(1);
    expect(sessions.getSessionCookie).toHaveBeenNthCalledWith(1, false, expect.any(AbortSignal));
    expect(sessions.getSessionCookie).toHaveBeenNthCalledWith(2, true, expect.any(AbortSignal));
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  test('fails closed on oversized, malformed, redirected, and secret-bearing upstream errors', async () => {
    const oversized = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({ ok: true }, 200, { 'Content-Length': String(3 * 1024 * 1024) }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(oversized.status()).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });

    const malformed = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(malformed.status()).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });

    const redirected = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        new Response(null, { status: 302, headers: { Location: 'https://attacker.example/capture' } }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(redirected.status()).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });

    const secretError = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({
          ok: false,
          error: 'access_token=super-secret Bearer another-secret code=oauth-code',
        }),
      ),
      sessionProvider: sessionProvider(),
    });
    let safeError: AgentZeroOAuthError | null = null;
    try {
      await secretError.status();
    } catch (error) {
      safeError = error as AgentZeroOAuthError;
    }
    expect(safeError).toBeInstanceOf(AgentZeroOAuthError);
    expect(safeError?.message).toContain('[redacted]');
    expect(safeError?.message).not.toMatch(/super-secret|another-secret|oauth-code/);
  });

  test('requires explicit upstream success and official provider authorization destinations', async () => {
    const missingSuccess = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({ routes_installed: true, providers: [] }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(missingSuccess.status()).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });

    const maliciousDestination = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({
          ok: true,
          provider_id: 'codex_oauth',
          flow: 'device_code',
          attempt_id: 'attempt-safe',
          verification_url: 'https://attacker.example/codex/device',
          user_code: 'ABCD-EFGH',
        }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(maliciousDestination.startLogin({ providerId: 'codex_oauth' }))
      .rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });

    const enterpriseDestination = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({
          ok: true,
          provider_id: 'github_copilot_oauth',
          flow: 'device_code',
          attempt_id: 'attempt-enterprise',
          verification_url: 'https://github.example.com/login/device',
          user_code: 'ENTERPRISE',
        }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(enterpriseDestination.startLogin({
      providerId: 'github_copilot_oauth',
      enterpriseDomain: 'https://github.example.com',
    })).resolves.toMatchObject({ verificationUrl: 'https://github.example.com/login/device' });
  });

  test('normalizes the seconds expiry Agent Zero reports into milliseconds', async () => {
    // Agent Zero reports expires_at as fractional Unix *seconds*. Everything
    // downstream compares it against Date.now() in milliseconds, so leaving it
    // raw made a live ten-minute window read as long expired, and the panel
    // announced "the browser authorization window expired" within seconds.
    const client = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({
          ok: true,
          provider_id: 'xai_grok_oauth',
          flow: 'browser_pkce',
          auth_url: 'https://auth.x.ai/oauth2/authorize?state=safe-state',
          redirect_uri: 'http://127.0.0.1:56121/callback',
          expires_at: 1785528408.574209,
        }),
      ),
      sessionProvider: sessionProvider(),
    });
    const result = await client.startLogin({ providerId: 'xai_grok_oauth' });
    expect(result.expiresAt).toBe(1785528408574);
    // Already-millisecond values must pass through untouched.
    expect(result.expiresAt).toBeGreaterThan(1_000_000_000_000);
  });

  test('accepts the xAI authorization endpoint that discovery actually serves', async () => {
    // xAI publishes endpoints via OIDC discovery, which currently serves
    // /oauth2/authorize. Pinning /oauth/authorize rejects the discovered
    // endpoint as outside the official provider boundary.
    const client = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({
          ok: true,
          provider_id: 'xai_grok_oauth',
          flow: 'browser_pkce',
          auth_url: 'https://auth.x.ai/oauth2/authorize?state=safe-state',
          redirect_uri: 'http://127.0.0.1:56121/callback',
          expires_at: 12345,
        }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(client.startLogin({ providerId: 'xai_grok_oauth' }))
      .resolves.toMatchObject({ flow: 'browser_pkce' });
  });

  test('accepts an xAI device verification URL on another x.ai host', async () => {
    // The same guard runs against the device verification URI, which is a
    // different path again, so the check cannot be pinned to one path.
    const client = new AgentZeroOAuthClient({
      fetchImpl: sequentialFetch(
        csrfResponse(),
        jsonResponse({
          ok: true,
          provider_id: 'xai_grok_oauth',
          flow: 'device_code',
          attempt_id: 'attempt-xai',
          verification_url: 'https://accounts.x.ai/oauth2/device',
          user_code: 'WXYZ-1234',
        }),
      ),
      sessionProvider: sessionProvider(),
    });
    await expect(client.startLogin({ providerId: 'xai_grok_oauth' }))
      .resolves.toMatchObject({ userCode: 'WXYZ-1234' });
  });

  test('still rejects xAI lookalike hosts and plaintext transport', async () => {
    for (const authUrl of [
      'https://x.ai.attacker.example/oauth2/authorize',
      'https://notx.ai/oauth2/authorize',
      'https://xai.com/oauth2/authorize',
      'http://auth.x.ai/oauth2/authorize',
    ]) {
      const hostile = new AgentZeroOAuthClient({
        fetchImpl: sequentialFetch(
          csrfResponse(),
          jsonResponse({
            ok: true,
            provider_id: 'xai_grok_oauth',
            flow: 'browser_pkce',
            auth_url: authUrl,
            redirect_uri: 'http://127.0.0.1:56121/callback',
            expires_at: 12345,
          }),
        ),
        sessionProvider: sessionProvider(),
      });
      await expect(hostile.startLogin({ providerId: 'xai_grok_oauth' }))
        .rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });
    }
  });

  test('rejects remote and credential-bearing Agent Zero origins by default', () => {
    expect(() => new AgentZeroOAuthClient({
      baseUrl: 'http://attacker.example:50001',
      fetchImpl: jest.fn() as unknown as typeof fetch,
      sessionProvider: sessionProvider(),
    })).toThrow(/loopback/i);
    expect(() => new AgentZeroOAuthClient({
      baseUrl: 'http://user:password@127.0.0.1:50001',
      fetchImpl: jest.fn() as unknown as typeof fetch,
      sessionProvider: sessionProvider(),
    })).toThrow(/credentials/i);
  });
});
