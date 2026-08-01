import http from 'http';
import express, { NextFunction, Request, Response } from 'express';
import {
  AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION,
  AgentZeroOAuthError,
} from '../agents/providers/agentZero/AgentZeroOAuthControl';

const oauthClient = {
  status: jest.fn(),
  startLogin: jest.fn(),
  pollLogin: jest.fn(),
  completeManualCallback: jest.fn(),
  models: jest.fn(),
  modelCatalog: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('../agents/providers/agentZero/AgentZeroOAuthControl', () => {
  const actual = jest.requireActual('../agents/providers/agentZero/AgentZeroOAuthControl');
  return {
    ...actual,
    getDefaultAgentZeroOAuthClient: () => oauthClient,
  };
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: String(req.headers['x-test-user'] || 'user-1'),
      email: 'test@example.com',
      role: String(req.headers['x-test-role'] || 'USER'),
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

import agentRuntimeRouter, {
  __resetAgentZeroOAuthLifecycleLeasesForTests,
  __resetAgentZeroOAuthLifecycleMemoryForTests,
} from '../routes/agent-runtime';

type TestResponse = { status: number; body: any; headers: http.IncomingHttpHeaders };

async function request(
  server: http.Server,
  input: {
    path: string;
    method?: 'GET' | 'POST';
    role?: string;
    userId?: string;
    body?: Record<string, unknown>;
  },
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = input.body ? JSON.stringify(input.body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: input.method || 'GET',
      path: input.path,
      headers: {
        'x-test-role': input.role || 'OWNER',
        'x-test-user': input.userId || 'oauth-owner',
        ...(encoded ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
        } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = undefined;
        if (text) {
          try { body = JSON.parse(text); } catch { body = text; }
        }
        resolve({
          status: res.statusCode || 0,
          body,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

function oauthStatus(connectedProvider?: string) {
  return {
    available: true,
    routesInstalled: true,
    connectedCount: connectedProvider ? 1 : 0,
    availableCount: connectedProvider ? 3 : 4,
    providers: [
      {
        providerId: connectedProvider || 'codex_oauth',
        displayName: 'Codex/ChatGPT',
        shortName: 'Codex',
        authFlow: 'device_code',
        connected: Boolean(connectedProvider),
        connectionState: connectedProvider ? 'connected' : 'disconnected',
        accountLabel: connectedProvider ? 'owner@example.com' : '',
        warning: '',
        note: '',
        supportsManualCallback: false,
        supportsEnterpriseDomain: false,
        supportsOAuthClientConfig: false,
        supportsQuotaProject: false,
        defaultModel: 'gpt-5.5',
        defaultModels: ['gpt-5.5'],
        usageWindows: [],
      },
    ],
    checkedAt: '2026-07-20T00:00:00.000Z',
  };
}

describe('Agent Zero owner-only OAuth routes', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    __resetAgentZeroOAuthLifecycleLeasesForTests();
    oauthClient.status.mockResolvedValue(oauthStatus());
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.use('/agent-runtime', agentRuntimeRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.each(['USER', 'VIEWER', 'SUB_ADMIN'])('rejects %s before touching Agent Zero OAuth', async (role) => {
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/status',
      role,
      userId: `denied-${role}`,
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Owner access required' });
    expect(oauthClient.status).not.toHaveBeenCalled();
  });

  test('enforces Owner authorization on every OAuth operation and exposes no generic proxy route', async () => {
    const operations: Array<{ path: string; method?: 'GET' | 'POST'; body?: Record<string, unknown> }> = [
      { path: '/agent-runtime/agent-zero/oauth/codex_oauth/start', method: 'POST', body: {} },
      { path: '/agent-runtime/agent-zero/oauth/codex_oauth/poll', method: 'POST', body: { attemptId: 'attempt' } },
      { path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/manual-callback', method: 'POST', body: { callback: 'code=value' } },
      { path: '/agent-runtime/agent-zero/oauth/models' },
      { path: '/agent-runtime/agent-zero/oauth/codex_oauth/models' },
      {
        path: '/agent-runtime/agent-zero/oauth/codex_oauth/disconnect',
        method: 'POST',
        body: { confirmation: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION },
      },
    ];
    for (const [index, operation] of operations.entries()) {
      const response = await request(server, {
        ...operation,
        role: 'SUB_ADMIN',
        userId: `all-routes-subadmin-${index}`,
      });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Owner access required' });
    }
    expect(oauthClient.startLogin).not.toHaveBeenCalled();
    expect(oauthClient.pollLogin).not.toHaveBeenCalled();
    expect(oauthClient.completeManualCallback).not.toHaveBeenCalled();
    expect(oauthClient.models).not.toHaveBeenCalled();
    expect(oauthClient.modelCatalog).not.toHaveBeenCalled();
    expect(oauthClient.disconnect).not.toHaveBeenCalled();

    const arbitrary = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/proxy',
      method: 'POST',
      userId: 'no-proxy-owner',
      body: { path: '/api/plugins/_oauth/status' },
    });
    expect(arbitrary.status).toBe(404);
  });

  test('returns only sanitized status plus the owner confirmation contract', async () => {
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/status',
      userId: 'status-owner',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      routesInstalled: true,
      actions: {
        disconnect: {
          ownerOnly: true,
          confirmationPhrase: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION,
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/access_token|refresh_token|cookie/i);
  });

  test('starts fixed provider flows and passes only the typed setup fields', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'gemini_api_oauth',
      flow: 'browser_pkce',
      authUrl: 'https://accounts.google.com/oauth?state=gemini-owned-state',
    });
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/gemini_api_oauth/start',
      method: 'POST',
      userId: 'start-owner',
      body: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        quotaProjectId: 'quota-project',
        arbitraryPath: '/api/plugins/malicious',
      },
    });

    expect(response.status).toBe(200);
    expect(oauthClient.startLogin).toHaveBeenCalledWith({
      providerId: 'gemini_api_oauth',
      enterpriseDomain: undefined,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      quotaProjectId: 'quota-project',
    });
    expect(JSON.stringify(response.body)).not.toContain('client-secret');
  });

  test('joins exact concurrent starts and rejects a conflicting owner before a second upstream write', async () => {
    let release!: (value: any) => void;
    oauthClient.startLogin.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const first = request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'joined-start-owner',
      body: {},
    });
    const second = request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'joined-start-owner',
      body: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    const conflict = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'conflicting-start-owner',
      body: {},
    });
    expect(conflict.status).toBe(409);
    expect(oauthClient.startLogin).toHaveBeenCalledTimes(1);

    release({ ok: true, providerId: 'codex_oauth', flow: 'device_code', attemptId: 'joined-attempt' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200, body: expect.objectContaining({ attemptId: 'joined-attempt' }) }),
      expect.objectContaining({ status: 200, body: expect.objectContaining({ attemptId: 'joined-attempt' }) }),
    ]);
  });

  test('retains Agent Zero admission across backend memory loss and never restarts the upstream flow', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'restart-attempt',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const first = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'restart-owner',
      body: {},
    });
    expect(first.status).toBe(200);

    __resetAgentZeroOAuthLifecycleMemoryForTests();
    const retry = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'restart-owner',
      body: {},
    });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({
      code: 'PROVIDER_CREDENTIAL_LIFECYCLE_RECOVERY_REQUIRED',
    });
    expect(oauthClient.startLogin).toHaveBeenCalledTimes(1);
  });

  test('polls device authorization and re-reads status only after completion', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'attempt-1',
    });
    const started = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'poll-owner',
      body: {},
    });
    expect(started.status).toBe(200);
    oauthClient.status.mockClear();
    oauthClient.pollLogin
      .mockResolvedValueOnce({
        ok: true,
        providerId: 'codex_oauth',
        completed: false,
        expired: false,
        interval: 8,
      })
      .mockResolvedValueOnce({
        ok: true,
        providerId: 'codex_oauth',
        completed: true,
        expired: false,
        interval: 8,
        accountLabel: 'owner@example.com',
      });
    oauthClient.status.mockResolvedValue(oauthStatus('codex_oauth'));

    const pending = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/poll',
      method: 'POST',
      userId: 'poll-owner',
      body: { attemptId: 'attempt-1' },
    });
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBeUndefined();
    expect(oauthClient.status).not.toHaveBeenCalled();

    const completed = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/poll',
      method: 'POST',
      userId: 'poll-owner',
      body: { attemptId: 'attempt-1' },
    });
    expect(completed.status).toBe(200);
    expect(completed.body.status.connectedCount).toBe(1);
    expect(oauthClient.status).toHaveBeenCalledTimes(1);
  });

  test('completes a bounded manual callback and refreshes connected status', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      authUrl: 'https://accounts.x.ai/oauth?state=one-use',
    });
    const started = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/start',
      method: 'POST',
      userId: 'callback-owner',
      body: {},
    });
    expect(started.status).toBe(200);
    oauthClient.completeManualCallback.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      completed: true,
      expired: false,
      accountLabel: 'xAI Grok',
    });
    oauthClient.status.mockResolvedValue({
      ...oauthStatus('xai_grok_oauth'),
    });
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/manual-callback',
      method: 'POST',
      userId: 'callback-owner',
      body: { callback: 'http://127.0.0.1:56121/callback?code=one-use&state=one-use' },
    });

    expect(response.status).toBe(200);
    expect(oauthClient.completeManualCallback).toHaveBeenCalledWith({
      providerId: 'xai_grok_oauth',
      callback: 'http://127.0.0.1:56121/callback?code=one-use&state=one-use',
    });
    expect(JSON.stringify(response.body)).not.toContain('one-use');
  });

  test('rejects missing or wrong browser state before calling Agent Zero', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      authUrl: 'https://accounts.x.ai/oauth?state=exact-owned-state',
    });
    const started = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/start',
      method: 'POST',
      userId: 'state-owner',
      body: {},
    });
    expect(started.status).toBe(200);

    for (const callback of [
      'code=bare-code',
      'http://127.0.0.1/callback?code=code&state=wrong-state',
    ]) {
      const response = await request(server, {
        path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/manual-callback',
        method: 'POST',
        userId: 'state-owner',
        body: { callback },
      });
      expect(response.status).toBe(409);
    }
    expect(oauthClient.completeManualCallback).not.toHaveBeenCalled();
  });

  test('single-flights an exact manual callback and rejects callback drift', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      authUrl: 'https://accounts.x.ai/oauth?state=joined',
    });
    await request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/start',
      method: 'POST',
      userId: 'joined-callback-owner',
      body: {},
    });
    let release!: (value: any) => void;
    oauthClient.completeManualCallback.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    oauthClient.status.mockResolvedValue(oauthStatus('xai_grok_oauth'));
    const body = { callback: 'http://127.0.0.1:56121/callback?code=joined&state=joined' };
    const first = request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/manual-callback',
      method: 'POST',
      userId: 'joined-callback-owner',
      body,
    });
    const second = request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/manual-callback',
      method: 'POST',
      userId: 'joined-callback-owner',
      body,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const conflict = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/xai_grok_oauth/manual-callback',
      method: 'POST',
      userId: 'joined-callback-owner',
      body: { callback: 'http://127.0.0.1:56121/callback?code=other&state=other' },
    });
    expect(conflict.status).toBe(409);
    expect(oauthClient.completeManualCallback).toHaveBeenCalledTimes(1);
    release({ ok: true, providerId: 'xai_grok_oauth', completed: true, expired: false });
    const responses = await Promise.all([first, second]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  test('loads a provider model catalog without proxying a caller path', async () => {
    oauthClient.models.mockResolvedValue({
      providerId: 'codex_oauth',
      models: [{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' }],
    });
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/models',
      userId: 'models-owner',
    });
    expect(response.status).toBe(200);
    expect(oauthClient.models).toHaveBeenCalledWith('codex_oauth');
    expect(response.body.models).toHaveLength(1);
  });

  test('advertises only the exact Agent Zero host-chat qualified model', async () => {
    oauthClient.models.mockResolvedValue({
      providerId: 'codex_oauth',
      models: [
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '' },
        { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' },
        { id: 'codex-auto-review', displayName: 'Codex Auto Review', description: '' },
      ],
    });
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/models',
      userId: 'compatible-models-owner',
    });

    expect(response.status).toBe(200);
    expect(response.body.models.map((model: any) => model.id)).toEqual(['gpt-5.6-terra']);
  });

  test('returns one authoritative catalog across all four OAuth providers', async () => {
    oauthClient.modelCatalog.mockResolvedValue({
      available: true,
      providers: [
        {
          providerId: 'codex_oauth',
          displayName: 'Codex/ChatGPT',
          accountLabel: 'owner@example.com',
          connectionState: 'connected',
          models: [
            { id: 'gpt-5.5', displayName: 'GPT-5.5', description: '' },
            { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' },
            { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '' },
          ],
        },
        {
          providerId: 'github_copilot_oauth',
          displayName: 'GitHub Copilot',
          accountLabel: '',
          connectionState: 'disconnected',
          models: [],
        },
        {
          providerId: 'gemini_api_oauth',
          displayName: 'Google Cloud Gemini',
          accountLabel: '',
          connectionState: 'expired',
          models: [],
        },
        {
          providerId: 'xai_grok_oauth',
          displayName: 'xAI Grok',
          accountLabel: '',
          connectionState: 'revoked',
          models: [],
        },
      ],
      checkedAt: '2026-07-20T00:00:00.000Z',
    });
    const response = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/models',
      userId: 'catalog-owner',
    });
    expect(response.status).toBe(200);
    expect(response.body.providers).toHaveLength(4);
    expect(response.body.providers[0].models[0].id).toBe('gpt-5.6-terra');
    expect(response.body.providers[0].models).toHaveLength(1);
    expect(oauthClient.modelCatalog).toHaveBeenCalledTimes(1);
  });

  test('requires typed confirmation and verifies the account is gone after disconnect', async () => {
    const rejected = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/disconnect',
      method: 'POST',
      userId: 'disconnect-owner',
      body: { confirmation: 'disconnect' },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.confirmationPhrase).toBe(AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION);
    expect(oauthClient.disconnect).not.toHaveBeenCalled();

    oauthClient.disconnect.mockResolvedValue({ providerId: 'codex_oauth', disconnected: false });
    oauthClient.status.mockResolvedValue(oauthStatus());
    const disconnected = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/disconnect',
      method: 'POST',
      userId: 'disconnect-owner',
      body: { confirmation: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION },
    });
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toMatchObject({
      ok: true,
      providerId: 'codex_oauth',
      disconnected: false,
      alreadyDisconnected: true,
    });

    oauthClient.disconnect.mockResolvedValue({ providerId: 'codex_oauth', disconnected: true });
    oauthClient.status.mockResolvedValue(oauthStatus('codex_oauth'));
    const unverified = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/disconnect',
      method: 'POST',
      userId: 'disconnect-owner-2',
      body: { confirmation: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION },
    });
    expect(unverified.status).toBe(409);
    expect(unverified.body.code).toBe('AGENT_ZERO_OAUTH_UPSTREAM_REJECTED');
  });

  test('durably rejects disconnect after start admission before touching upstream removal', async () => {
    let releaseStart!: (value: any) => void;
    oauthClient.startLogin.mockImplementationOnce(() => new Promise((resolve) => { releaseStart = resolve; }));
    oauthClient.status.mockResolvedValue(oauthStatus());
    const starting = request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'start-first-owner',
      body: {},
    });
    while (oauthClient.startLogin.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const blockedRemoval = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/disconnect',
      method: 'POST',
      userId: 'disconnect-second-owner',
      body: { confirmation: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION },
    });
    expect(blockedRemoval.status).toBe(409);
    expect(blockedRemoval.body.code).toBe('PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT');
    expect(oauthClient.disconnect).not.toHaveBeenCalled();

    releaseStart({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'start-first-attempt',
    });
    await expect(starting).resolves.toMatchObject({ status: 200 });
  });

  test('durably rejects start after disconnect admission before touching upstream login', async () => {
    let releaseDisconnect!: (value: any) => void;
    oauthClient.disconnect.mockImplementationOnce(() => new Promise((resolve) => { releaseDisconnect = resolve; }));
    oauthClient.status.mockResolvedValue(oauthStatus());
    const disconnecting = request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/disconnect',
      method: 'POST',
      userId: 'disconnect-first-owner',
      body: { confirmation: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION },
    });
    while (oauthClient.disconnect.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const blockedStart = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
      method: 'POST',
      userId: 'start-second-owner',
      body: {},
    });
    expect(blockedStart.status).toBe(409);
    expect(blockedStart.body.code).toBe('PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT');
    expect(oauthClient.startLogin).not.toHaveBeenCalled();

    releaseDisconnect({ providerId: 'codex_oauth', disconnected: true });
    await expect(disconnecting).resolves.toMatchObject({ status: 200 });
  });

  test('maps sanitized client failures without leaking internal exceptions', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    oauthClient.status.mockRejectedValueOnce(new AgentZeroOAuthError(
      'Agent Zero OAuth request timed out.',
      'UNAVAILABLE',
    ));
    const unavailable = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/status',
      userId: 'errors-owner-1',
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      error: 'Agent Zero OAuth request timed out.',
      code: 'AGENT_ZERO_OAUTH_UNAVAILABLE',
    });

    oauthClient.status.mockRejectedValueOnce(new AgentZeroOAuthError(
      'Codex/ChatGPT OAuth is expired. Reconnect the account before selecting a model.',
      'AUTHENTICATION',
    ));
    const expired = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/status',
      userId: 'errors-owner-auth',
    });
    // This is upstream account state, not Portal-session authentication; 401
    // would make the frontend refresh/logout interceptor misclassify it.
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('AGENT_ZERO_OAUTH_AUTHENTICATION');

    oauthClient.status.mockRejectedValueOnce(new Error('cookie=server-secret'));
    const internal = await request(server, {
      path: '/agent-runtime/agent-zero/oauth/status',
      userId: 'errors-owner-2',
    });
    expect(internal.status).toBe(500);
    expect(JSON.stringify(internal.body)).not.toContain('server-secret');
    expect(consoleSpy).toHaveBeenCalledWith('[agent-zero-oauth] Unexpected OAuth control failure.');
    consoleSpy.mockRestore();
  });

  test('rate limits repeated OAuth mutations per Owner', async () => {
    oauthClient.startLogin.mockResolvedValue({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'attempt',
    });
    const responses: TestResponse[] = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await request(server, {
        path: '/agent-runtime/agent-zero/oauth/codex_oauth/start',
        method: 'POST',
        userId: 'rate-limit-owner',
        body: {},
      }));
    }
    expect(responses.slice(0, 10).every((response) => response.status === 200)).toBe(true);
    expect(responses[10].status).toBe(429);
    expect(oauthClient.startLogin).toHaveBeenCalledTimes(1);
  });
});
