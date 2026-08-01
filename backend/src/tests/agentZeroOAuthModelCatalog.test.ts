import type { Stats } from 'fs';
import {
  __setDefaultAgentZeroOAuthClientForTests,
  AgentZeroOAuthClient,
  getDefaultAgentZeroOAuthClient,
  type AgentZeroOAuthModelCatalog,
  type AgentZeroOAuthStatus,
} from '../agents/providers/agentZero/AgentZeroOAuthControl';
import { AgentZeroAuthSessionManager } from '../agents/providers/agentZero/AgentZeroAuthSession';
import {
  __resetAgentZeroOAuthModelCatalogForTests,
  AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
  AgentZeroOAuthModelCatalogError,
  filterAgentZeroOAuthModelsForProjectQualification,
  invalidateAgentZeroOAuthModelCatalogCache,
  isAgentZeroOAuthHostChatModelQualified,
  isAgentZeroOAuthProjectQualificationCandidate,
  loadSelectableAgentZeroOAuthModels,
  selectableAgentZeroOAuthModels,
  validateAgentZeroOAuthModelSelection,
} from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';

function providerStatus(
  providerId: 'codex_oauth' | 'github_copilot_oauth',
  connected = true,
) {
  return {
    providerId,
    displayName: providerId === 'codex_oauth' ? 'OpenAI Codex OAuth' : 'GitHub Copilot OAuth',
    shortName: providerId,
    authFlow: 'device_code' as const,
    connected,
    connectionState: connected ? 'connected' as const : 'disconnected' as const,
    reconnectRequired: !connected,
    accountLabel: '',
    warning: '',
    note: '',
    supportsManualCallback: false,
    supportsEnterpriseDomain: false,
    supportsOAuthClientConfig: false,
    supportsQuotaProject: false,
    defaultModel: '',
    defaultModels: [],
    usageWindows: [],
  };
}

function status(): AgentZeroOAuthStatus {
  return {
    available: true,
    routesInstalled: true,
    connectedCount: 2,
    availableCount: 2,
    providers: [providerStatus('codex_oauth'), providerStatus('github_copilot_oauth')],
    checkedAt: '2026-07-20T20:00:00.000Z',
  };
}

function protectedAuthStats(): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100600,
  } as Stats;
}

function connectorCapabilities(): Record<string, unknown> {
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
  };
}

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

function oauthStatusResponse(): Response {
  const provider = (
    providerId: string,
    authFlow: 'device_code' | 'browser_pkce',
    connected: boolean,
  ) => ({
    provider_id: providerId,
    display_name: providerId,
    short_name: providerId,
    auth_flow: authFlow,
    connected,
    connection_state: connected ? 'connected' : 'disconnected',
  });
  return jsonResponse({
    ok: true,
    routes_installed: true,
    providers: [
      provider('codex_oauth', 'device_code', true),
      provider('github_copilot_oauth', 'device_code', false),
      provider('gemini_api_oauth', 'browser_pkce', false),
      provider('xai_grok_oauth', 'browser_pkce', false),
    ],
  });
}

describe('Agent Zero OAuth model catalog', () => {
  test('publishes only exact connected official OAuth provider/model identifiers', () => {
    const catalog: AgentZeroOAuthModelCatalog = {
      available: true,
      providers: [
        {
          providerId: 'codex_oauth',
          displayName: 'OpenAI Codex OAuth',
          accountLabel: '',
          connectionState: 'connected',
          models: [
            { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: '' },
            { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' },
            { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '' },
            { id: 'codex-auto-review', displayName: 'Codex Auto Review', description: '' },
          ],
        },
        {
          providerId: 'github_copilot_oauth',
          displayName: 'GitHub Copilot OAuth',
          accountLabel: '',
          connectionState: 'expired',
          models: [{ id: 'stale-model', displayName: 'Stale', description: '' }],
        },
      ],
      checkedAt: '2026-07-20T20:00:00.000Z',
    };

    expect(selectableAgentZeroOAuthModels(catalog)).toEqual([
      expect.objectContaining({
        id: 'codex_oauth/gpt-5.6-terra',
        providerId: 'codex_oauth',
        model: 'gpt-5.6-terra',
      }),
    ]);
  });

  test('publishes only the exact model qualified for host Agent Chat', async () => {
    const client = {
      status: jest.fn(async () => status()),
      models: jest.fn(async (providerId: any) => ({
        providerId,
        models: providerId === 'codex_oauth'
          ? [
              { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '' },
              { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' },
              { id: 'codex-auto-review', displayName: 'Codex Auto Review', description: '' },
            ]
          : [],
      })),
    };

    await expect(loadSelectableAgentZeroOAuthModels(client)).resolves.toEqual([
      expect.objectContaining({ id: 'codex_oauth/gpt-5.6-terra' }),
    ]);
    await expect(validateAgentZeroOAuthModelSelection(
      'codex_oauth/gpt-5.6-sol',
      client,
    )).rejects.toMatchObject({
      code: 'MODEL_PROTOCOL_INCOMPATIBLE',
      message: AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
    });
    await expect(validateAgentZeroOAuthModelSelection(
      'codex_oauth/codex-auto-review',
      client,
    )).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_INCOMPATIBLE' });
    await expect(validateAgentZeroOAuthModelSelection(
      'codex_oauth/unreviewed-future-model',
      client,
    )).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_INCOMPATIBLE' });
    expect(isAgentZeroOAuthHostChatModelQualified('codex_oauth', 'gpt-5.6-terra')).toBe(true);
    expect(isAgentZeroOAuthHostChatModelQualified('codex_oauth', 'GPT-5.6-TERRA')).toBe(false);
  });

  test('reports a structured incompatibility when every returned model is unqualified', async () => {
    const client = {
      status: jest.fn(async () => status()),
      models: jest.fn(async (providerId: any) => ({
        providerId,
        models: providerId === 'codex_oauth'
          ? [
              { id: 'gpt-5.3-codex', displayName: 'Unreviewed', description: '' },
              { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '' },
              { id: 'codex-auto-review', displayName: 'Codex Auto Review', description: '' },
            ]
          : [],
      })),
    };

    await expect(loadSelectableAgentZeroOAuthModels(client)).rejects.toMatchObject({
      code: 'MODEL_PROTOCOL_INCOMPATIBLE',
      message: AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
    });
  });

  test('hard-bounds and aborts a model catalog status RPC that never settles', async () => {
    jest.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const client = {
      status: jest.fn((signal?: AbortSignal) => new Promise((_resolve, reject) => {
        observedSignal = signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted catalog')), { once: true });
      })),
      models: jest.fn(),
    };

    try {
      const pending = loadSelectableAgentZeroOAuthModels(client as any);
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'CATALOG_UNAVAILABLE',
        message: expect.stringMatching(/within the readiness window/),
      });
      await jest.advanceTimersByTimeAsync(20_000);

      await rejected;
      expect(observedSignal?.aborted).toBe(true);
      expect(client.status).toHaveBeenCalledTimes(1);
      expect(client.models).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('recovers the default catalog through one shared fresh attempt after a body-hung timeout', async () => {
    jest.useFakeTimers();
    __resetAgentZeroOAuthModelCatalogForTests();
    const client = getDefaultAgentZeroOAuthClient();
    const recoveredStatus = {
      ...status(),
      connectedCount: 1,
      providers: [providerStatus('codex_oauth'), providerStatus('github_copilot_oauth', false)],
    };
    const signals: AbortSignal[] = [];
    const statusSpy = jest.spyOn(client, 'status')
      .mockImplementationOnce((signal?: AbortSignal) => new Promise((_resolve, reject) => {
        if (!signal) return;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted catalog')), { once: true });
      }))
      .mockResolvedValueOnce(recoveredStatus);
    const modelsSpy = jest.spyOn(client, 'models').mockResolvedValue({
      providerId: 'codex_oauth',
      models: [{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' }],
    });

    try {
      const first = loadSelectableAgentZeroOAuthModels();
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
      await jest.advanceTimersByTimeAsync(20_000);
      await firstRejected;
      await Promise.resolve();

      await expect(loadSelectableAgentZeroOAuthModels()).rejects.toMatchObject({
        code: 'CATALOG_UNAVAILABLE',
      });
      expect(statusSpy).toHaveBeenCalledTimes(1);
      expect(modelsSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(10_000);
      const recoveryA = loadSelectableAgentZeroOAuthModels();
      const recoveryB = loadSelectableAgentZeroOAuthModels();
      await expect(Promise.all([recoveryA, recoveryB])).resolves.toEqual([
        [expect.objectContaining({ id: 'codex_oauth/gpt-5.6-terra' })],
        [expect.objectContaining({ id: 'codex_oauth/gpt-5.6-terra' })],
      ]);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(statusSpy.mock.calls[1]?.[0]).not.toBe(signals[0]);
      expect(modelsSpy).toHaveBeenCalledTimes(1);
    } finally {
      statusSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetAgentZeroOAuthModelCatalogForTests();
      jest.useRealTimers();
    }
  });

  test('aborts a hung real OAuth response body and recovers through a distinct client generation', async () => {
    jest.useFakeTimers();
    __resetAgentZeroOAuthModelCatalogForTests();
    const observedStatusSignals: AbortSignal[] = [];
    let cancelledBodies = 0;
    const responses: Array<(init?: RequestInit) => Response> = [
      () => jsonResponse(connectorCapabilities()),
      () => new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': 'session=protected-session; Path=/; HttpOnly; SameSite=Lax',
        },
      }),
      () => jsonResponse({ contexts: [] }),
      () => jsonResponse({ csrf_token: 'csrf-one' }),
      (init) => {
        if (init?.signal) observedStatusSignals.push(init.signal);
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            cancelledBodies += 1;
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      () => jsonResponse({ csrf_token: 'csrf-two' }),
      (init) => {
        if (init?.signal) observedStatusSignals.push(init.signal);
        return oauthStatusResponse();
      },
      () => jsonResponse({ csrf_token: 'csrf-three' }),
      () => jsonResponse({
        ok: true,
        provider_id: 'codex_oauth',
        models: ['gpt-5.6-terra'],
        model_metadata: [{
          slug: 'gpt-5.6-terra',
          display_name: 'Recovered Terra',
          description: 'Qualified model',
        }],
      }),
    ];
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected Agent Zero request');
      return next(init);
    }) as unknown as jest.MockedFunction<typeof fetch>;
    const auth = new AgentZeroAuthSessionManager({
      authFilePath: '/etc/bridgesllm/agent-zero.env',
      fetchImpl: fetchMock,
      readAuthFile: () => 'AUTH_LOGIN=portal-owner\nAUTH_PASSWORD=protected-password\n',
      statAuthFile: protectedAuthStats,
      requestTimeoutMs: 120_000,
      verifyTtlMs: 60_000,
      protocolTtlMs: 60_000,
    });
    const client = new AgentZeroOAuthClient({
      sessionProvider: auth,
      fetchImpl: fetchMock,
      requestTimeoutMs: 120_000,
    });
    await expect(auth.probe(true)).resolves.toMatchObject({
      state: 'authenticated',
      authenticated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    __setDefaultAgentZeroOAuthClientForTests(client);

    try {
      const first = loadSelectableAgentZeroOAuthModels();
      const firstRejected = expect(first).rejects.toMatchObject({
        code: 'CATALOG_UNAVAILABLE',
      });
      for (let turn = 0; turn < 8; turn += 1) await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(5);

      await jest.advanceTimersByTimeAsync(20_000);
      await firstRejected;
      await Promise.resolve();
      expect(observedStatusSignals[0]?.aborted).toBe(true);
      expect(cancelledBodies).toBe(1);

      await jest.advanceTimersByTimeAsync(10_000);
      const recoveredA = loadSelectableAgentZeroOAuthModels();
      const recoveredB = loadSelectableAgentZeroOAuthModels();
      await expect(Promise.all([recoveredA, recoveredB])).resolves.toEqual([
        [expect.objectContaining({ displayName: 'Recovered Terra' })],
        [expect.objectContaining({ displayName: 'Recovered Terra' })],
      ]);
      expect(observedStatusSignals).toHaveLength(2);
      expect(observedStatusSignals[1]).not.toBe(observedStatusSignals[0]);
      expect(observedStatusSignals[1]?.aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(9);

      await expect(loadSelectableAgentZeroOAuthModels()).resolves.toEqual([
        expect.objectContaining({ displayName: 'Recovered Terra' }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(9);
      expect(responses).toHaveLength(0);
    } finally {
      __resetAgentZeroOAuthModelCatalogForTests();
      __setDefaultAgentZeroOAuthClientForTests(null);
      jest.useRealTimers();
    }
  });

  test('rejects an aborted pre-invalidation result before caching a fresh generation', async () => {
    __resetAgentZeroOAuthModelCatalogForTests();
    const client = getDefaultAgentZeroOAuthClient();
    const connectedStatus = {
      ...status(),
      connectedCount: 1,
      providers: [providerStatus('codex_oauth'), providerStatus('github_copilot_oauth', false)],
    };
    const statusSpy = jest.spyOn(client, 'status')
      .mockImplementationOnce((signal?: AbortSignal) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve(connectedStatus), { once: true });
      }))
      .mockResolvedValueOnce(connectedStatus);
    const modelsSpy = jest.spyOn(client, 'models')
      .mockResolvedValueOnce({
        providerId: 'codex_oauth',
        models: [{ id: 'gpt-5.6-terra', displayName: 'Stale Terra', description: '' }],
      })
      .mockResolvedValueOnce({
        providerId: 'codex_oauth',
        models: [{ id: 'gpt-5.6-terra', displayName: 'Fresh Terra', description: '' }],
      });

    try {
      const stale = loadSelectableAgentZeroOAuthModels();
      const staleJoiner = loadSelectableAgentZeroOAuthModels();
      await Promise.resolve();
      expect(statusSpy).toHaveBeenCalledTimes(1);

      invalidateAgentZeroOAuthModelCatalogCache();
      await expect(stale).rejects.toMatchObject({
        code: 'CATALOG_UNAVAILABLE',
        message: expect.stringMatching(/account state changed/i),
      });
      await expect(staleJoiner).rejects.toMatchObject({
        code: 'CATALOG_UNAVAILABLE',
        message: expect.stringMatching(/account state changed/i),
      });

      const freshA = loadSelectableAgentZeroOAuthModels();
      const freshB = loadSelectableAgentZeroOAuthModels();
      await expect(Promise.all([freshA, freshB])).resolves.toEqual([
        [expect.objectContaining({ displayName: 'Fresh Terra' })],
        [expect.objectContaining({ displayName: 'Fresh Terra' })],
      ]);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(modelsSpy).toHaveBeenCalledTimes(2);

      await expect(loadSelectableAgentZeroOAuthModels()).resolves.toEqual([
        expect.objectContaining({ displayName: 'Fresh Terra' }),
      ]);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(modelsSpy).toHaveBeenCalledTimes(2);
    } finally {
      statusSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetAgentZeroOAuthModelCatalogForTests();
    }
  });

  test('repeated timed-out recoveries remain single-flight and use distinct aborted signals', async () => {
    jest.useFakeTimers();
    __resetAgentZeroOAuthModelCatalogForTests();
    const client = getDefaultAgentZeroOAuthClient();
    const recoveredStatus = {
      ...status(),
      connectedCount: 1,
      providers: [providerStatus('codex_oauth'), providerStatus('github_copilot_oauth', false)],
    };
    const signals: AbortSignal[] = [];
    let active = 0;
    let maximumActive = 0;
    const statusSpy = jest.spyOn(client, 'status').mockImplementation((signal?: AbortSignal) => (
      new Promise((_resolve, reject) => {
        if (!signal) return;
        signals.push(signal);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        signal.addEventListener('abort', () => {
          active -= 1;
          reject(new Error('aborted catalog'));
        }, { once: true });
      })
    ));
    const modelsSpy = jest.spyOn(client, 'models').mockResolvedValue({
      providerId: 'codex_oauth',
      models: [{ id: 'gpt-5.6-terra', displayName: 'Recovered Terra', description: '' }],
    });

    try {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const attempt = loadSelectableAgentZeroOAuthModels();
        const rejected = expect(attempt).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
        await jest.advanceTimersByTimeAsync(20_000);
        await rejected;
        await Promise.resolve();
        expect(active).toBe(0);
        await jest.advanceTimersByTimeAsync(10_000);
      }

      statusSpy.mockResolvedValueOnce(recoveredStatus);
      await expect(Promise.all([
        loadSelectableAgentZeroOAuthModels(),
        loadSelectableAgentZeroOAuthModels(),
      ])).resolves.toEqual([
        [expect.objectContaining({ displayName: 'Recovered Terra' })],
        [expect.objectContaining({ displayName: 'Recovered Terra' })],
      ]);
      expect(maximumActive).toBe(1);
      expect(new Set(signals).size).toBe(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(statusSpy).toHaveBeenCalledTimes(4);
      expect(modelsSpy).toHaveBeenCalledTimes(1);
    } finally {
      statusSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetAgentZeroOAuthModelCatalogForTests();
      jest.useRealTimers();
    }
  });

  test('keeps Project Chat candidates separate from Project live qualification', () => {
    const candidates = filterAgentZeroOAuthModelsForProjectQualification('codex_oauth', [
      { id: 'gpt-5.6-terra' },
      { id: 'gpt-5.6-sol' },
      { id: 'codex-auto-review' },
      { id: 'future-model' },
    ]);

    expect(candidates).toEqual([{ id: 'gpt-5.6-terra' }]);
    expect(isAgentZeroOAuthProjectQualificationCandidate('codex_oauth', 'gpt-5.6-terra')).toBe(true);
    expect(isAgentZeroOAuthProjectQualificationCandidate('github_copilot_oauth', 'gpt-5.6-terra'))
      .toBe(false);
  });

  test('isolates one stale provider without hiding a healthy connected catalog', async () => {
    const client = {
      status: jest.fn(async () => status()),
      models: jest.fn(async (providerId: any) => {
        if (providerId === 'github_copilot_oauth') throw new Error('stale access token=private');
        return {
          providerId,
          models: [{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' }],
        };
      }),
    };

    await expect(loadSelectableAgentZeroOAuthModels(client)).resolves.toEqual([
      expect.objectContaining({ id: 'codex_oauth/gpt-5.6-terra' }),
    ]);
    await expect(validateAgentZeroOAuthModelSelection(
      'codex_oauth/gpt-5.6-terra',
      client,
    )).resolves.toMatchObject({ id: 'codex_oauth/gpt-5.6-terra' });
  });

  test('distinguishes unavailable connected catalogs from an authoritative empty catalog', async () => {
    const unavailableClient = {
      status: jest.fn(async () => status()),
      models: jest.fn(async () => { throw new Error('provider failed'); }),
    };
    await expect(loadSelectableAgentZeroOAuthModels(unavailableClient)).rejects.toMatchObject({
      name: 'AgentZeroOAuthModelCatalogError',
      code: 'CATALOG_UNAVAILABLE',
      message: expect.stringMatching(/could not load a complete official model catalog/i),
    } satisfies Partial<AgentZeroOAuthModelCatalogError>);

    const emptyClient = {
      status: jest.fn(async () => status()),
      models: jest.fn(async (providerId: any) => ({ providerId, models: [] })),
    };
    await expect(loadSelectableAgentZeroOAuthModels(emptyClient)).rejects.toMatchObject({
      code: 'NO_CONNECTED_MODELS',
      message: expect.stringMatching(/No connected Agent Zero OAuth account currently exposes/i),
    } satisfies Partial<AgentZeroOAuthModelCatalogError>);
  });

  test('fails closed when the selection is not exact', async () => {
    const healthyClient = {
      status: jest.fn(async () => status()),
      models: jest.fn(async (providerId: any) => ({
        providerId,
        models: providerId === 'codex_oauth'
          ? [{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' }]
          : [],
      })),
    };
    await expect(validateAgentZeroOAuthModelSelection('Power', healthyClient)).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    });
    await expect(validateAgentZeroOAuthModelSelection(
      'codex_oauth/not-in-catalog',
      healthyClient,
    )).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_INCOMPATIBLE' });
    await expect(validateAgentZeroOAuthModelSelection(
      'openrouter/openai/gpt-5',
      healthyClient,
    )).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
  });
});
