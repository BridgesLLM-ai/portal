jest.mock('./providerAvailability', () => ({
  getProviderAvailability: jest.fn(),
  getProviderCatalogAvailabilityAsync: jest.fn(),
  getProviderCapabilities: jest.fn(),
}));

import {
  getProviderCatalogAvailabilityAsync,
  getProviderCapabilities,
} from './providerAvailability';
import { AgentRegistry } from './AgentRegistry';
import type { AgentProviderName } from './AgentProvider.interface';
import {
  __resetNativeReadinessForTests,
  recordNativeProviderAuthFailure,
} from './nativeProviderReadiness';

const mockedGetProviderCatalogAvailabilityAsync = jest.mocked(
  getProviderCatalogAvailabilityAsync,
);
const mockedGetProviderCapabilities = jest.mocked(getProviderCapabilities);

function availability(name: AgentProviderName) {
  return {
    name,
    installed: true,
    implemented: true,
    usable: true,
    native: name !== 'OPENCLAW' && name !== 'AGENT_ZERO',
    capabilities: {
      implemented: true,
      requiresGateway: name === 'OPENCLAW',
      adapterFamily: name === 'OPENCLAW' ? 'openclaw-gateway' as const : 'native-cli' as const,
      adapterKey: name.toLowerCase(),
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session' as const,
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic' as const,
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up' as const,
      supportedExecutionScopes: ['HOST_OPERATOR'] as const,
    },
  };
}

function needsLogin(name: AgentProviderName) {
  return {
    ...availability(name),
    usable: false,
    reason: `${name} authentication was rejected. Reconnect it in AI Settings and retry.`,
    nativeAuthStatus: 'needs_login' as const,
    nativeAuthMessage: `${name} authentication was rejected. Reconnect it in AI Settings and retry.`,
    requiresSeparateNativeLogin: true,
  };
}

describe('AgentRegistry fail-soft provider catalog', () => {
  beforeEach(() => {
    AgentRegistry.__resetProviderCatalogForTests();
    __resetNativeReadinessForTests();
    mockedGetProviderCatalogAvailabilityAsync.mockReset();
    mockedGetProviderCapabilities.mockImplementation((name) => availability(name).capabilities);
  });

  afterEach(() => {
    AgentRegistry.__resetProviderCatalogForTests();
    __resetNativeReadinessForTests();
    jest.useRealTimers();
  });

  test('returns fast rows while one probe hangs and another fails', async () => {
    jest.useFakeTimers();
    let resolveGemini!: (value: ReturnType<typeof availability>) => void;
    const gemini = new Promise<ReturnType<typeof availability>>((resolve) => {
      resolveGemini = resolve;
    });
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => {
      if (name === 'GEMINI') return gemini;
      if (name === 'GROK') throw new Error('provider probe failed');
      return availability(name);
    });

    const pending = AgentRegistry.listProvidersAsync();
    await jest.advanceTimersByTimeAsync(250);
    const providers = await pending;

    expect(providers.map((provider) => provider.name)).toEqual([
      'OPENCLAW',
      'CLAUDE_CODE',
      'CODEX',
      'GROK',
      'AGENT_ZERO',
      'GEMINI',
      'OLLAMA',
    ]);
    expect(providers.find((provider) => provider.name === 'CODEX')).toMatchObject({
      availabilityState: 'ready',
      checking: false,
      usable: true,
      checkedAt: expect.any(String),
    });
    expect(providers.find((provider) => provider.name === 'GROK')).toMatchObject({
      availabilityState: 'error',
      checking: false,
      installed: null,
      usable: false,
    });
    expect(providers.find((provider) => provider.name === 'GEMINI')).toMatchObject({
      availabilityState: 'checking',
      checking: true,
      installed: null,
      usable: false,
    });

    resolveGemini(availability('GEMINI'));
    await Promise.resolve();
    await Promise.resolve();
    const refreshed = await AgentRegistry.listProvidersAsync();
    expect(refreshed.find((provider) => provider.name === 'GEMINI')).toMatchObject({
      availabilityState: 'ready',
      checking: false,
      usable: true,
    });
  });

  test('singleflights concurrent cold catalogs per provider', async () => {
    jest.useFakeTimers();
    let resolveCodex!: (value: ReturnType<typeof availability>) => void;
    const codex = new Promise<ReturnType<typeof availability>>((resolve) => {
      resolveCodex = resolve;
    });
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => (
      name === 'CODEX' ? codex : availability(name)
    ));

    const first = AgentRegistry.listProvidersAsync();
    const second = AgentRegistry.listProvidersAsync();
    await Promise.resolve();

    expect(mockedGetProviderCatalogAvailabilityAsync).toHaveBeenCalledTimes(7);
    resolveCodex(availability('CODEX'));
    await jest.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ]);
    expect(mockedGetProviderCatalogAvailabilityAsync).toHaveBeenCalledTimes(7);
  });

  test('converts a permanently hung background probe into a fail-closed row', async () => {
    jest.useFakeTimers();
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => (
      name === 'GEMINI'
        ? new Promise<ReturnType<typeof availability>>(() => undefined)
        : availability(name)
    ));

    const cold = AgentRegistry.listProvidersAsync();
    await jest.advanceTimersByTimeAsync(250);
    await expect(cold).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'GEMINI',
        availabilityState: 'checking',
        usable: false,
      }),
    ]));

    await jest.advanceTimersByTimeAsync(34_750);
    await expect(AgentRegistry.listProvidersAsync()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'GEMINI',
        availabilityState: 'error',
        checking: false,
        usable: false,
      }),
      expect.objectContaining({
        name: 'CODEX',
        availabilityState: 'ready',
        usable: true,
      }),
    ]));
  });

  test('invalidates a warm ready row immediately after an exact native auth rejection', async () => {
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => availability(name));
    await expect(AgentRegistry.listProvidersAsync()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'CLAUDE_CODE',
        availabilityState: 'ready',
        usable: true,
      }),
    ]));

    recordNativeProviderAuthFailure(
      'CLAUDE_CODE',
      'Claude Code provider error: authentication_failed',
      {
        credentialFingerprint: 'claude-admitted-generation',
        runtimeFingerprint: 'claude-runtime-generation',
      },
    );
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => (
      name === 'CLAUDE_CODE' ? needsLogin(name) : availability(name)
    ));

    await expect(AgentRegistry.listProvidersAsync()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'CLAUDE_CODE',
        availabilityState: 'ready',
        checking: false,
        usable: false,
        nativeAuthStatus: 'needs_login',
        nativeAuthMessage: expect.stringMatching(/authentication was rejected/i),
      }),
    ]));
  });

  test('does not let an older in-flight ready probe overwrite a native auth rejection', async () => {
    jest.useFakeTimers();
    let resolveFirstClaude!: (value: ReturnType<typeof availability>) => void;
    const firstClaude = new Promise<ReturnType<typeof availability>>((resolve) => {
      resolveFirstClaude = resolve;
    });
    let rejected = false;
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => {
      if (name !== 'CLAUDE_CODE') return availability(name);
      return rejected ? needsLogin(name) : firstClaude;
    });

    const cold = AgentRegistry.listProvidersAsync();
    await jest.advanceTimersByTimeAsync(250);
    await expect(cold).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'CLAUDE_CODE',
        availabilityState: 'checking',
        usable: false,
      }),
    ]));

    rejected = true;
    recordNativeProviderAuthFailure(
      'CLAUDE_CODE',
      'OAuth session expired and could not be refreshed.',
      {
        credentialFingerprint: 'claude-admitted-generation',
        runtimeFingerprint: 'claude-runtime-generation',
      },
    );
    await expect(AgentRegistry.listProvidersAsync()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'CLAUDE_CODE',
        availabilityState: 'ready',
        usable: false,
        nativeAuthStatus: 'needs_login',
      }),
    ]));

    resolveFirstClaude(availability('CLAUDE_CODE'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(AgentRegistry.listProvidersAsync()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'CLAUDE_CODE',
        availabilityState: 'ready',
        usable: false,
        nativeAuthStatus: 'needs_login',
      }),
    ]));
  });
});
