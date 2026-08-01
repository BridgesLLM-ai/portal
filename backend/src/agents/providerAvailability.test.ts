jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: jest.fn(actual.execFileSync) };
});

import { execFileSync } from 'child_process';
import * as nativeProviderReadiness from './nativeProviderReadiness';
import * as agentZeroAuthSession from './providers/agentZero/AgentZeroAuthSession';
import * as agentZeroModelCatalog from './providers/agentZero/AgentZeroOAuthModelCatalog';
import * as agentZeroRuntime from './providers/agentZero/AgentZeroRuntime';
import {
  __resetProviderAvailabilityForTests,
  cliVersionMatchesExact,
  getProviderAvailability,
  getProviderAvailabilityAsync,
  getProviderCatalogAvailabilityAsync,
  nativeAuthBlocksProviderUsage,
} from './providerAvailability';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';

describe('providerAvailability', () => {
  const mockedExecFileSync = jest.mocked(execFileSync);

  test('OpenClaw exposes live in-turn steering semantics', () => {
    const provider = getProviderAvailability('OPENCLAW');
    expect(provider.capabilities.adapterFamily).toBe('openclaw-gateway');
    expect(provider.capabilities.adapterKey).toBe('openclaw');
    expect(provider.capabilities.supportsInTurnSteering).toBe(true);
    expect(provider.capabilities.supportsQueuedFollowUps).toBe(false);
    expect(provider.capabilities.followUpMode).toBe('interrupt_and_send');
    expect(provider.capabilities.supportedExecutionScopes).toEqual(['HOST_OPERATOR']);
  });

  test.each([
    ['CLAUDE_CODE', ['HOST_OPERATOR', 'PROJECT_SANDBOX']],
    ['CODEX', ['HOST_OPERATOR', 'PROJECT_SANDBOX']],
    ['GROK', ['HOST_OPERATOR']],
    ['GEMINI', ['HOST_OPERATOR', 'PROJECT_SANDBOX']],
  ] as const)('%s exposes queued native-cli follow-up semantics', (name, executionScopes) => {
    const provider = getProviderAvailability(name);
    expect(provider.capabilities.adapterFamily).toBe('native-cli');
    expect(provider.capabilities.supportsInTurnSteering).toBe(false);
    expect(provider.capabilities.supportsQueuedFollowUps).toBe(true);
    expect(provider.capabilities.followUpMode).toBe('queued_follow_up');
    expect(provider.capabilities.supportedExecutionScopes).toEqual(executionScopes);
  });

  test('Codex exposes the centralized subscription model catalog', () => {
    const provider = getProviderAvailability('CODEX');
    expect(provider.capabilities).toMatchObject({
      canEnumerateModels: true,
      modelCatalogKind: 'declared',
      modelSelectionMode: 'session',
    });
  });

  test('Claude Code exposes the authoritative declared model catalog', () => {
    const provider = getProviderAvailability('CLAUDE_CODE');
    expect(provider.capabilities).toMatchObject({
      supportsModelSelection: true,
      supportsCustomModelInput: false,
      canEnumerateModels: true,
      modelCatalogKind: 'declared',
      modelSelectionMode: 'session',
    });
  });

  test('every declared provider exposes adapter + follow-up metadata', () => {
    for (const name of ['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'GROK', 'AGENT_ZERO', 'GEMINI', 'OLLAMA'] as const) {
      const provider = getProviderAvailability(name);
      expect(provider.capabilities.adapterFamily).toBeTruthy();
      expect(provider.capabilities.adapterKey).toBeTruthy();
      expect(provider.capabilities.followUpMode).toBeTruthy();
      expect(typeof provider.capabilities.supportsInTurnSteering).toBe('boolean');
      expect(typeof provider.capabilities.supportsQueuedFollowUps).toBe('boolean');
      expect(Array.isArray(provider.capabilities.supportedExecutionScopes)).toBe(true);
    }
  });

  test('Ollama version discovery cannot inherit a hostile remote endpoint', () => {
    const actualExecFileSync = jest.requireActual<typeof import('child_process')>('child_process').execFileSync;
    const priorHost = process.env.OLLAMA_HOST;
    const priorApiUrl = process.env.OLLAMA_API_URL;
    process.env.OLLAMA_HOST = 'http://100.64.0.20:11434';
    process.env.OLLAMA_API_URL = 'http://169.254.169.254:11434';

    mockedExecFileSync.mockImplementation(((command: string, args: string[], options?: {
      env?: NodeJS.ProcessEnv;
    }) => {
      if (command === 'bash' && args[1]?.includes('command -v ollama')) return '/usr/local/bin/ollama';
      if (command === 'ollama' && args[0] === '--version') {
        expect(options?.env?.OLLAMA_HOST).toBe('http://127.0.0.1:11434');
        expect(options?.env?.OLLAMA_API_URL).toBeUndefined();
        return 'ollama version 0.11.0';
      }
      return '';
    }) as any);

    try {
      __resetProviderAvailabilityForTests();
      expect(getProviderAvailability('OLLAMA')).toMatchObject({
        installed: true,
        usable: true,
        command: 'ollama',
      });
    } finally {
      if (priorHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = priorHost;
      if (priorApiUrl === undefined) delete process.env.OLLAMA_API_URL;
      else process.env.OLLAMA_API_URL = priorApiUrl;
      mockedExecFileSync.mockImplementation(actualExecFileSync as any);
      __resetProviderAvailabilityForTests();
    }
  });

  test('Agent Zero stays unusable until the managed runtime and protected auth verify', () => {
    const provider = getProviderAvailability('AGENT_ZERO');
    expect(provider.native).toBe(false);
    expect(provider.implemented).toBe(true);
    // In this environment no managed runtime is converged, so the live gate
    // must fail closed even though the adapter is implemented.
    expect(provider.usable).toBe(false);
    expect(provider.capabilities).toMatchObject({
      adapterFamily: 'agent-zero-connector',
      adapterKey: 'agent-zero-v2.5-connector',
      supportedExecutionScopes: ['HOST_OPERATOR'],
    });
    expect(provider.reason).toMatch(/stays disabled until the managed runtime is ready/);
  });

  test('Agent Zero first async catalog request awaits protected auth readiness', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'unchecked',
      authenticated: false,
      reason: 'Agent Zero authentication has not been checked yet.',
    });
    let resolveRefresh!: (value: agentZeroAuthSession.AgentZeroAuthReadiness) => void;
    const refreshSpy = jest.spyOn(agentZeroAuthSession, 'refreshAgentZeroAuthReadiness').mockReturnValue(
      new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels').mockResolvedValue([{
      id: 'codex_oauth/gpt-qualified',
      providerId: 'codex_oauth',
      model: 'gpt-qualified',
      displayName: 'Qualified model',
      providerDisplayName: 'Codex',
      description: '',
    }]);

    try {
      const pending = getProviderAvailabilityAsync('AGENT_ZERO');
      await Promise.resolve();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(modelsSpy).not.toHaveBeenCalled();

      resolveRefresh({
        state: 'authenticated',
        authenticated: true,
        checkedAt: new Date().toISOString(),
        reason: 'Agent Zero protected session authentication is ready.',
      });

      await expect(pending).resolves.toMatchObject({
        name: 'AGENT_ZERO',
        usable: true,
        nativeAuthStatus: 'authenticated',
      });
      expect(modelsSpy).toHaveBeenCalledTimes(1);
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      refreshSpy.mockRestore();
      modelsSpy.mockRestore();
    }
  });

  test('aggregate Agent Zero availability does not enumerate models', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntimeAsync').mockResolvedValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'authenticated',
      authenticated: true,
      checkedAt: new Date().toISOString(),
      reason: 'Agent Zero protected session authentication is ready.',
    });
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels');

    try {
      await expect(getProviderCatalogAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: true,
        nativeAuthStatus: 'authenticated',
      });
      expect(modelsSpy).not.toHaveBeenCalled();
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      modelsSpy.mockRestore();
    }
  });

  test('Agent Zero auth readiness recovers through one shared fresh attempt after a body-hung timeout', async () => {
    jest.useFakeTimers();
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'unchecked',
      authenticated: false,
      reason: 'Agent Zero authentication has not been checked yet.',
    });
    const refreshSignals: AbortSignal[] = [];
    const refreshSpy = jest.spyOn(agentZeroAuthSession, 'refreshAgentZeroAuthReadiness')
      .mockImplementationOnce((_force, signal) => new Promise((_resolve, reject) => {
        if (!signal) return;
        refreshSignals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted readiness')), { once: true });
      }))
      .mockResolvedValueOnce({
        state: 'authenticated',
        authenticated: true,
        checkedAt: new Date().toISOString(),
        reason: 'Agent Zero protected session authentication is ready.',
      });
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels')
      .mockResolvedValue([{
        id: 'codex_oauth/gpt-qualified',
        providerId: 'codex_oauth',
        model: 'gpt-qualified',
        displayName: 'Qualified model',
        providerDisplayName: 'Codex',
        description: '',
      }]);

    try {
      const pending = getProviderAvailabilityAsync('AGENT_ZERO');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(20_000);

      await expect(pending).resolves.toMatchObject({
        usable: false,
        nativeAuthStatus: 'unknown',
        nativeAuthMessage: expect.stringMatching(/within the provider catalog readiness window/),
      });
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(modelsSpy).not.toHaveBeenCalled();

      await expect(getProviderAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: false,
        nativeAuthMessage: expect.stringMatching(/cooling down after an interrupted readiness check/),
      });
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(10_000);
      const recoveryA = getProviderAvailabilityAsync('AGENT_ZERO');
      const recoveryB = getProviderAvailabilityAsync('AGENT_ZERO');
      await expect(Promise.all([recoveryA, recoveryB])).resolves.toEqual([
        expect.objectContaining({ usable: true, nativeAuthStatus: 'authenticated' }),
        expect.objectContaining({ usable: true, nativeAuthStatus: 'authenticated' }),
      ]);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
      expect(refreshSpy.mock.calls[1]?.[0]).toBe(true);
      expect(refreshSpy.mock.calls[1]?.[1]).not.toBe(refreshSignals[0]);
      expect(modelsSpy).toHaveBeenCalledTimes(2);
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      refreshSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetProviderAvailabilityForTests();
      jest.useRealTimers();
    }
  });

  test('Agent Zero model catalog surfaces a bounded failure and recovers on retry', async () => {
    jest.useFakeTimers();
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'authenticated',
      authenticated: true,
      checkedAt: new Date().toISOString(),
      reason: 'Agent Zero protected session authentication is ready.',
    });
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new agentZeroModelCatalog.AgentZeroOAuthModelCatalogError(
          'CATALOG_UNAVAILABLE',
          'Agent Zero could not verify its selectable OAuth models within the provider catalog readiness window.',
        )), 20_000);
      }))
      .mockResolvedValueOnce([{
        id: 'codex_oauth/gpt-qualified',
        providerId: 'codex_oauth',
        model: 'gpt-qualified',
        displayName: 'Qualified model',
        providerDisplayName: 'Codex',
        description: '',
      }]);

    try {
      const first = getProviderAvailabilityAsync('AGENT_ZERO');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(20_000);

      await expect(first).resolves.toMatchObject({
        usable: false,
        reason: expect.stringMatching(/within the provider catalog readiness window/),
      });
      await expect(getProviderAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: true,
      });
      expect(modelsSpy).toHaveBeenCalledTimes(2);
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetProviderAvailabilityForTests();
      jest.useRealTimers();
    }
  });

  test('Agent Zero retries a stale transient authentication error and recovers the catalog', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'error',
      authenticated: false,
      checkedAt: new Date(Date.now() - 10_001).toISOString(),
      reason: 'Agent Zero authentication request failed.',
    });
    const refreshSpy = jest.spyOn(agentZeroAuthSession, 'refreshAgentZeroAuthReadiness').mockResolvedValue({
      state: 'authenticated',
      authenticated: true,
      checkedAt: new Date().toISOString(),
      reason: 'Agent Zero protected session authentication is ready.',
    });
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels').mockResolvedValue([{
      id: 'codex_oauth/gpt-qualified',
      providerId: 'codex_oauth',
      model: 'gpt-qualified',
      displayName: 'Qualified model',
      providerDisplayName: 'Codex',
      description: '',
    }]);

    try {
      __resetProviderAvailabilityForTests();
      await expect(getProviderAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: true,
        nativeAuthStatus: 'authenticated',
      });
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(modelsSpy).toHaveBeenCalledTimes(1);
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      refreshSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetProviderAvailabilityForTests();
    }
  });

  test('Agent Zero keeps a fresh transient authentication error fail-closed without retry storms', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'error',
      authenticated: false,
      checkedAt: new Date().toISOString(),
      reason: 'Agent Zero authentication request failed.',
    });
    const refreshSpy = jest.spyOn(agentZeroAuthSession, 'refreshAgentZeroAuthReadiness');
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels');

    try {
      __resetProviderAvailabilityForTests();
      await expect(getProviderAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: false,
        nativeAuthStatus: 'unknown',
        nativeAuthMessage: 'Agent Zero authentication request failed.',
      });
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(modelsSpy).not.toHaveBeenCalled();
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      refreshSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetProviderAvailabilityForTests();
    }
  });

  test('Agent Zero never auto-retries durable login-required readiness', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'needs_login',
      authenticated: false,
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      reason: 'Agent Zero rejected the protected server-side credentials.',
    });
    const refreshSpy = jest.spyOn(agentZeroAuthSession, 'refreshAgentZeroAuthReadiness');

    try {
      __resetProviderAvailabilityForTests();
      await expect(getProviderAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: false,
        nativeAuthStatus: 'needs_login',
      });
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      refreshSpy.mockRestore();
      __resetProviderAvailabilityForTests();
    }
  });

  test('Agent Zero shares one recovery attempt across concurrent stale-error catalogs', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'error',
      authenticated: false,
      checkedAt: new Date(Date.now() - 10_001).toISOString(),
      reason: 'Agent Zero authentication request failed.',
    });
    let resolveRefresh!: (value: agentZeroAuthSession.AgentZeroAuthReadiness) => void;
    const refreshSpy = jest.spyOn(agentZeroAuthSession, 'refreshAgentZeroAuthReadiness').mockReturnValue(
      new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels').mockResolvedValue([{
      id: 'codex_oauth/gpt-qualified',
      providerId: 'codex_oauth',
      model: 'gpt-qualified',
      displayName: 'Qualified model',
      providerDisplayName: 'Codex',
      description: '',
    }]);

    try {
      __resetProviderAvailabilityForTests();
      const first = getProviderAvailabilityAsync('AGENT_ZERO');
      const second = getProviderAvailabilityAsync('AGENT_ZERO');
      await Promise.resolve();
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      resolveRefresh({
        state: 'authenticated',
        authenticated: true,
        checkedAt: new Date().toISOString(),
        reason: 'Agent Zero protected session authentication is ready.',
      });

      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ usable: true }),
        expect.objectContaining({ usable: true }),
      ]);
      expect(modelsSpy).toHaveBeenCalledTimes(2);
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      refreshSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetProviderAvailabilityForTests();
    }
  });

  test('Agent Zero availability preserves an all-quarantined catalog explanation', async () => {
    const runtimeSpy = jest.spyOn(agentZeroRuntime, 'probeAgentZeroRuntime').mockReturnValue({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
      reason: 'Managed Agent Zero v2.5 runtime is protocol-ready.',
    });
    const snapshotSpy = jest.spyOn(agentZeroAuthSession, 'getAgentZeroAuthReadinessSnapshot').mockReturnValue({
      state: 'authenticated',
      authenticated: true,
      checkedAt: new Date().toISOString(),
      reason: 'Agent Zero protected session authentication is ready.',
    });
    const modelsSpy = jest.spyOn(agentZeroModelCatalog, 'loadSelectableAgentZeroOAuthModels')
      .mockRejectedValue(new agentZeroModelCatalog.AgentZeroOAuthModelCatalogError(
        'MODEL_PROTOCOL_INCOMPATIBLE',
        agentZeroModelCatalog.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
      ));

    try {
      await expect(getProviderAvailabilityAsync('AGENT_ZERO')).resolves.toMatchObject({
        usable: false,
        reason: agentZeroModelCatalog.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
      });
    } finally {
      runtimeSpy.mockRestore();
      snapshotSpy.mockRestore();
      modelsSpy.mockRestore();
      __resetProviderAvailabilityForTests();
    }
  });

  test('Grok Build exposes only the privileged Agent Chat contract', () => {
    const provider = getProviderAvailability('GROK');
    expect(provider.capabilities).toMatchObject({
      adapterKey: 'grok-build',
      modelCatalogKind: 'dynamic',
      supportsExecApproval: true,
      supportedExecutionScopes: ['HOST_OPERATOR'],
    });
  });

  test('Grok Build fails closed when native authentication is ambiguous', () => {
    expect(nativeAuthBlocksProviderUsage('GROK', {
      provider: 'GROK',
      status: 'unknown',
      message: 'ambiguous auth',
      requiresSeparateLogin: true,
    })).toBe(true);
    expect(nativeAuthBlocksProviderUsage('GROK', {
      provider: 'GROK',
      status: 'authenticated',
      message: 'verified auth shape',
      requiresSeparateLogin: true,
    })).toBe(false);
  });

  test('Google Antigravity fails closed when its live authentication probe is ambiguous', () => {
    expect(nativeAuthBlocksProviderUsage('GEMINI', {
      provider: 'GEMINI',
      status: 'unknown',
      message: 'the bounded models probe timed out',
      requiresSeparateLogin: true,
    })).toBe(true);
    expect(nativeAuthBlocksProviderUsage('GEMINI', {
      provider: 'GEMINI',
      status: 'authenticated',
      message: 'live models probe succeeded',
      requiresSeparateLogin: true,
    })).toBe(false);
  });

  test('Google Antigravity async availability follows exact turn-admission readiness', async () => {
    const actualExecFileSync = jest.requireActual<typeof import('child_process')>('child_process').execFileSync;
    mockedExecFileSync.mockImplementation(((command: string, args: string[]) => {
      if (command === 'bash' && args[1]?.includes('command -v agy')) return '/usr/local/bin/agy';
      if (command === 'agy' && args[0] === '--version') return PORTAL_TOOL_VERSIONS.antigravity;
      return '';
    }) as any);
    const readinessSpy = jest.spyOn(nativeProviderReadiness, 'getNativeProviderReadiness');
    const baseReadiness = {
      provider: 'GEMINI' as const,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      credentialFingerprint: 'credential-test',
      runtimeFingerprint: 'runtime-test',
    };

    try {
      __resetProviderAvailabilityForTests();
      readinessSpy.mockResolvedValueOnce({
        ...baseReadiness,
        state: 'live_verified',
        usable: true,
        message: 'Antigravity live authentication verified.',
      });
      await expect(getProviderAvailabilityAsync('GEMINI')).resolves.toMatchObject({
        installed: true,
        usable: true,
        nativeAuthStatus: 'authenticated',
        nativeAuthMessage: 'Antigravity live authentication verified.',
      });

      readinessSpy.mockResolvedValueOnce({
        ...baseReadiness,
        state: 'needs_login',
        usable: false,
        message: 'Antigravity authentication was rejected.',
      });
      await expect(getProviderAvailabilityAsync('GEMINI')).resolves.toMatchObject({
        installed: true,
        usable: false,
        nativeAuthStatus: 'needs_login',
        nativeAuthMessage: 'Antigravity authentication was rejected.',
      });
      expect(readinessSpy).toHaveBeenCalledTimes(2);
    } finally {
      readinessSpy.mockRestore();
      mockedExecFileSync.mockImplementation(actualExecFileSync as any);
      __resetProviderAvailabilityForTests();
    }
  });

  test.each([
    ['CLAUDE_CODE', 'claude', 'Claude Code local login is present; upstream revocation is checked on the next turn.'],
    ['CODEX', 'codex', 'Codex local login is present; upstream revocation is checked on the next turn.'],
    ['GROK', 'grok', 'Grok Build local login is present; upstream revocation is checked on the next turn.'],
  ] as const)('%s async availability consumes native readiness instead of raw credential shape', async (
    provider,
    command,
    readinessMessage,
  ) => {
    const actualExecFileSync = jest.requireActual<typeof import('child_process')>('child_process').execFileSync;
    mockedExecFileSync.mockImplementation(((invokedCommand: string, args: string[]) => {
      if (invokedCommand === 'bash' && args[1]?.includes(`command -v ${command}`)) return `/usr/local/bin/${command}`;
      if (invokedCommand === command && args.includes('--version')) {
        if (provider === 'GROK') return `grok ${PORTAL_TOOL_VERSIONS.grokBuild}`;
        if (provider === 'CLAUDE_CODE') return `claude ${PORTAL_TOOL_VERSIONS.claudeCode}`;
        return `codex ${PORTAL_TOOL_VERSIONS.codexCli}`;
      }
      return '';
    }) as any);
    const readinessSpy = jest.spyOn(nativeProviderReadiness, 'getNativeProviderReadiness')
      .mockResolvedValue({
        provider,
        state: 'login_present',
        usable: true,
        message: readinessMessage,
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialFingerprint: `${provider}-credential`,
        runtimeFingerprint: `${provider}-runtime`,
      });

    try {
      await expect(getProviderAvailabilityAsync(provider)).resolves.toMatchObject({
        name: provider,
        installed: true,
        usable: true,
        nativeAuthStatus: 'authenticated',
        nativeAuthMessage: readinessMessage,
        reason: expect.stringContaining(readinessMessage),
      });
      expect(readinessSpy).toHaveBeenCalledWith(provider);

      readinessSpy.mockResolvedValueOnce({
        provider,
        state: 'needs_login',
        usable: false,
        message: `${provider} authentication was rejected.`,
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialFingerprint: `${provider}-credential`,
        runtimeFingerprint: `${provider}-runtime`,
      });
      await expect(getProviderAvailabilityAsync(provider)).resolves.toMatchObject({
        name: provider,
        usable: false,
        nativeAuthStatus: 'needs_login',
        nativeAuthMessage: expect.stringContaining('authentication was rejected'),
      });
    } finally {
      readinessSpy.mockRestore();
      mockedExecFileSync.mockImplementation(actualExecFileSync as any);
      __resetProviderAvailabilityForTests();
    }
  });

  test('exact provider pins reject prerelease, build, and numeric-suffix drift', () => {
    expect(cliVersionMatchesExact('grok 0.2.103 (89c3d36fb6)', '0.2.103')).toBe(true);
    expect(cliVersionMatchesExact('grok 0.2.103-beta.1', '0.2.103')).toBe(false);
    expect(cliVersionMatchesExact('grok 0.2.103+local', '0.2.103')).toBe(false);
    expect(cliVersionMatchesExact('grok 0.2.1031', '0.2.103')).toBe(false);
  });

  test('soft-pinned CLI drift stays usable but is truthfully reported', async () => {
    const actualExecFileSync = jest.requireActual<typeof import('child_process')>('child_process').execFileSync;
    mockedExecFileSync.mockImplementation(((invokedCommand: string, args: string[]) => {
      if (invokedCommand === 'bash' && args[1]?.includes('command -v claude')) return '/usr/local/bin/claude';
      if (invokedCommand === 'claude' && args.includes('--version')) return 'claude 9.9.9 (self-updated)';
      return '';
    }) as any);
    const readinessSpy = jest.spyOn(nativeProviderReadiness, 'getNativeProviderReadiness')
      .mockResolvedValue({
        provider: 'CLAUDE_CODE',
        state: 'login_present',
        usable: true,
        message: 'Claude Code local login is present; upstream revocation is checked on the next turn.',
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialFingerprint: 'claude-credential',
        runtimeFingerprint: 'claude-runtime',
      });

    try {
      await expect(getProviderAvailabilityAsync('CLAUDE_CODE')).resolves.toMatchObject({
        name: 'CLAUDE_CODE',
        installed: true,
        usable: true,
        versionDrift: {
          tested: PORTAL_TOOL_VERSIONS.claudeCode,
          installed: '9.9.9',
        },
        reason: expect.stringContaining(
          `Installed claude 9.9.9 has drifted from the Portal-tested ${PORTAL_TOOL_VERSIONS.claudeCode}`,
        ),
      });
    } finally {
      readinessSpy.mockRestore();
      mockedExecFileSync.mockImplementation(actualExecFileSync as any);
      __resetProviderAvailabilityForTests();
    }
  });

  test('matching soft pins report no drift', async () => {
    const actualExecFileSync = jest.requireActual<typeof import('child_process')>('child_process').execFileSync;
    mockedExecFileSync.mockImplementation(((invokedCommand: string, args: string[]) => {
      if (invokedCommand === 'bash' && args[1]?.includes('command -v codex')) return '/usr/local/bin/codex';
      if (invokedCommand === 'codex' && args.includes('--version')) return `codex ${PORTAL_TOOL_VERSIONS.codexCli}`;
      return '';
    }) as any);
    const readinessSpy = jest.spyOn(nativeProviderReadiness, 'getNativeProviderReadiness')
      .mockResolvedValue({
        provider: 'CODEX',
        state: 'login_present',
        usable: true,
        message: 'Codex local login is present; upstream revocation is checked on the next turn.',
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialFingerprint: 'codex-credential',
        runtimeFingerprint: 'codex-runtime',
      });

    try {
      const availability = await getProviderAvailabilityAsync('CODEX');
      expect(availability.usable).toBe(true);
      expect(availability.versionDrift).toBeUndefined();
      expect(availability.reason).not.toContain('drifted');
    } finally {
      readinessSpy.mockRestore();
      mockedExecFileSync.mockImplementation(actualExecFileSync as any);
      __resetProviderAvailabilityForTests();
    }
  });
});
