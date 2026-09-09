jest.mock('./providerAvailability', () => ({
  getProviderAvailability: jest.fn(),
  getProviderAvailabilityAsync: jest.fn(),
  getProviderCatalogAvailabilityAsync: jest.fn(),
  getProviderCapabilities: jest.fn(),
}));

import {
  getProviderAvailability,
  getProviderAvailabilityAsync,
  getProviderCatalogAvailabilityAsync,
  getProviderCapabilities,
} from './providerAvailability';
import { AgentRegistry } from './AgentRegistry';
import type { AgentProviderName } from './AgentProvider.interface';
import { GeminiProvider } from './providers/GeminiProvider';
import {
  __resetNativeReadinessForTests,
  recordNativeProviderAuthFailure,
} from './nativeProviderReadiness';

const mockedGetProviderCatalogAvailabilityAsync = jest.mocked(
  getProviderCatalogAvailabilityAsync,
);
const mockedGetProviderAvailability = jest.mocked(getProviderAvailability);
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
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelSelection: true,
      supportsModelReadback: true,
      modelSelectionMode: 'session' as const,
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic' as const,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'protocol' as const,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up' as const,
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
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
    mockedGetProviderAvailability.mockReset();
    jest.mocked(getProviderAvailabilityAsync).mockReset();
    mockedGetProviderCapabilities.mockImplementation((name) => availability(name).capabilities);
  });

  afterEach(() => {
    AgentRegistry.__resetProviderCatalogForTests();
    __resetNativeReadinessForTests();
    jest.useRealTimers();
  });

  test('publishes executable Hermes/OpenCode metadata while keeping DeepSeek disabled', () => {
    const harnesses = AgentRegistry.listHarnesses();
    expect(harnesses.map((harness) => harness.id)).toEqual([
      'OPENCLAW',
      'CLAUDE_CODE',
      'CODEX',
      'GROK',
      'AGENT_ZERO',
      'GEMINI',
      'OLLAMA',
      'HERMES',
      'OPENCODE',
      'DEEPSEEK_HARNESS',
    ]);
    expect(AgentRegistry.getHarnessMetadata('HERMES')).toMatchObject({
      implemented: true,
      selectable: true,
      compatibilityProviderId: 'HERMES',
    });
    expect(AgentRegistry.getHarnessMetadata('OPENCODE')).toMatchObject({
      implemented: true,
      selectable: true,
      compatibilityProviderId: 'OPENCODE',
    });
    expect(AgentRegistry.getHarnessMetadata('DEEPSEEK_HARNESS')).toMatchObject({
      implemented: false,
      selectable: false,
      releaseStage: 'developer-preview',
      compatibilityProviderId: null,
    });
  });

  test('instantiates concrete Hermes and OpenCode providers from the explicit registry', () => {
    mockedGetProviderAvailability.mockImplementation((name) => availability(name));
    expect(AgentRegistry.getProvider('HERMES')).toMatchObject({
      providerName: 'HERMES',
      displayName: 'Hermes',
    });
    expect(AgentRegistry.getProvider('OPENCODE')).toMatchObject({
      providerName: 'OPENCODE',
      displayName: 'OpenCode',
    });
  });

  test.each(['CODEX', 'CLAUDE_CODE'] as const)('%s requests refresh an expired catalog before resolving the adapter', async (name) => {
    mockedGetProviderAvailability.mockImplementation(() => ({
      ...availability(name), installed: false, usable: false,
      reason: 'Native host CLI admission has not been checked asynchronously.',
    }));
    jest.mocked(getProviderAvailabilityAsync).mockResolvedValue(availability(name));
    await expect(AgentRegistry.getAsync(name)).resolves.toMatchObject({ providerName: name });
    expect(getProviderAvailabilityAsync).toHaveBeenCalledWith(name);
    expect(mockedGetProviderAvailability).not.toHaveBeenCalled();
    jest.mocked(getProviderAvailabilityAsync).mockResolvedValue({
      ...availability(name), installed: false, usable: false, reason: 'Native runtime absent',
    });
    await expect(AgentRegistry.getAsync(name)).rejects.toThrow('Native runtime absent');
  });

  test('keeps host readiness fail-closed while Project Sandbox and cleanup use narrow explicit lanes', () => {
    mockedGetProviderAvailability.mockImplementation((name) => ({
      ...availability(name),
      installed: false,
      usable: false,
      reason: `${name} is not installed`,
    }));

    expect(() => AgentRegistry.getProvider('CODEX')).toThrow(/not installed/i);
    mockedGetProviderAvailability.mockClear();
    expect(AgentRegistry.getSharedProjectSandboxProvider('CODEX')).toMatchObject({
      providerName: 'CODEX',
    });
    expect(mockedGetProviderAvailability).not.toHaveBeenCalled();

    const cleanup = AgentRegistry.getProviderCleanupController('CODEX');
    expect(Object.isFrozen(cleanup)).toBe(true);
    expect(cleanup).toMatchObject({ providerName: 'CODEX' });
    expect(typeof cleanup.abortActiveRun).toBe('function');
    expect((cleanup as any).startSession).toBeUndefined();
    expect((cleanup as any).sendMessage).toBeUndefined();
    expect((cleanup as any).getHistory).toBeUndefined();

    for (const provider of ['AGENT_ZERO', 'OLLAMA', 'GROK', 'HERMES', 'OPENCODE'] as const) {
      expect(() => AgentRegistry.getSharedProjectSandboxProvider(provider as any))
        .toThrow(/no shared Project Sandbox adapter/i);
    }
  });

  test('keeps detection-only Antigravity cleanup callable without exposing positive authority', async () => {
    mockedGetProviderAvailability.mockImplementation((name) => ({
      ...availability(name),
      installed: false,
      implemented: false,
      usable: false,
    }));
    const abort = jest.spyOn(GeminiProvider.prototype, 'abortActiveRun')
      .mockResolvedValue(true);
    const terminate = jest.spyOn(GeminiProvider.prototype, 'terminateSession')
      .mockResolvedValue(undefined);
    try {
      expect(() => AgentRegistry.getProvider('GEMINI')).toThrow(/not implemented yet/i);
      const cleanup = AgentRegistry.getProviderCleanupController('GEMINI');

      expect(Object.isFrozen(cleanup)).toBe(true);
      expect(cleanup.providerName).toBe('GEMINI');
      expect((cleanup as any).startSession).toBeUndefined();
      expect((cleanup as any).sendMessage).toBeUndefined();
      expect((cleanup as any).getHistory).toBeUndefined();
      await expect(cleanup.abortActiveRun?.('legacy-antigravity-session', 'legacy-run'))
        .resolves.toBe(true);
      await expect(cleanup.terminateSession('legacy-antigravity-session'))
        .resolves.toBeUndefined();
      expect(abort).toHaveBeenCalledWith('legacy-antigravity-session', 'legacy-run');
      expect(terminate).toHaveBeenCalledWith('legacy-antigravity-session');
    } finally {
      abort.mockRestore();
      terminate.mockRestore();
    }
  });

  test('combines registered readiness with the non-selectable DeepSeek preview row', async () => {
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => availability(name));

    const harnesses = await AgentRegistry.listHarnessesAsync();

    expect(harnesses).toHaveLength(10);
    expect(harnesses.find((harness) => harness.harnessId === 'CODEX')).toMatchObject({
      name: 'CODEX',
      compatibilityProviderId: 'CODEX',
      transport: 'native-cli',
      provenanceLabel: 'via Codex CLI',
      hostStreamOwnership: 'provider',
      availabilityState: 'ready',
      installed: true,
      implemented: true,
      selectable: true,
      usable: true,
      capabilities: expect.objectContaining({
        supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'],
      }),
    });
    expect(harnesses.find((harness) => harness.harnessId === 'HERMES')).toMatchObject({
      name: 'HERMES',
      compatibilityProviderId: 'HERMES',
      transport: 'acp-stdio',
      provenanceLabel: 'via Hermes',
      hostStreamOwnership: 'route',
      releaseStage: 'stable',
      availabilityState: 'ready',
      installed: true,
      implemented: true,
      selectable: true,
      usable: true,
      capabilities: expect.objectContaining({
        supportedExecutionScopes: ['HOST_OPERATOR'],
      }),
    });
    expect(harnesses.find((harness) => harness.harnessId === 'OPENCODE')).toMatchObject({
      compatibilityProviderId: 'OPENCODE',
      transport: 'acp-stdio',
      releaseStage: 'stable',
      availabilityState: 'ready',
      installed: true,
      implemented: true,
      selectable: true,
      usable: true,
      capabilities: expect.objectContaining({
        supportedExecutionScopes: ['HOST_OPERATOR'],
      }),
    });
    expect(harnesses.find((harness) => harness.harnessId === 'DEEPSEEK_HARNESS')).toMatchObject({
      name: 'DEEPSEEK_HARNESS',
      compatibilityProviderId: null,
      transport: 'json-rpc-stdio',
      releaseStage: 'developer-preview',
      selectable: false,
      usable: false,
      capabilities: expect.objectContaining({
        supportsSessionResume: false,
        cancellationMode: 'process-kill',
      }),
    });
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
      'HERMES',
      'OPENCODE',
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

    expect(mockedGetProviderCatalogAvailabilityAsync).toHaveBeenCalledTimes(9);
    resolveCodex(availability('CODEX'));
    await jest.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ]);
    expect(mockedGetProviderCatalogAvailabilityAsync).toHaveBeenCalledTimes(9);
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

  test.each([true, false])('keeps bounded OpenClaw checks alive without admitting a hung probe: resolves=%s', async (resolves) => {
    jest.useFakeTimers();
    mockedGetProviderCatalogAvailabilityAsync.mockImplementation(async (name) => {
      if (name !== 'OPENCLAW') return availability(name);
      return new Promise<ReturnType<typeof availability>>((resolve) => {
        if (resolves) setTimeout(() => resolve(availability(name)), 64_000);
      });
    });
    const cold = AgentRegistry.listProvidersAsync();
    await jest.advanceTimersByTimeAsync(250);
    await expect(cold).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'OPENCLAW', availabilityState: 'checking', usable: false }),
      expect.objectContaining({ name: 'CODEX', availabilityState: 'ready', usable: true }),
    ]));
    await jest.advanceTimersByTimeAsync(34_750);
    const ongoing = AgentRegistry.listProvidersAsync();
    await jest.advanceTimersByTimeAsync(250);
    await expect(ongoing).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'OPENCLAW', availabilityState: 'checking', usable: false }),
    ]));
    await jest.advanceTimersByTimeAsync(39_750);
    await expect(AgentRegistry.listProvidersAsync()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'OPENCLAW', availabilityState: resolves ? 'ready' : 'error', usable: resolves }),
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
