import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentChatProviderCatalogLoadError,
  __resetAgentChatProviderCatalogForTests,
  assessAgentChatProviderAvailability,
  getCachedAgentChatProviderCatalog,
  isAgentChatSelectedProviderRevalidationPending,
  loadAgentChatProviderCatalog,
  reduceAgentChatSelectedProviderRevalidation,
  type AgentChatProviderCatalogEntry,
  type AgentChatProviderCatalogSnapshotMetadata,
  type AgentChatSelectedProviderRevalidationState,
} from './agentChatProviderCatalog';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../api/client', () => ({
  default: { get: mocks.get },
}));

describe('Agent Chat provider catalog cache', () => {
  beforeEach(() => {
    __resetAgentChatProviderCatalogForTests();
    mocks.get.mockReset();
  });

  afterEach(() => {
    __resetAgentChatProviderCatalogForTests();
    vi.useRealTimers();
  });

  function provider(
    name: string,
    availabilityState: AgentChatProviderCatalogEntry['availabilityState'],
    overrides: Partial<AgentChatProviderCatalogEntry> = {},
  ): AgentChatProviderCatalogEntry {
    return {
      harnessId: name,
      name,
      displayName: name === 'OPENCLAW' ? 'OpenClaw' : 'Codex',
      installed: availabilityState === 'checking' ? null : true,
      implemented: true,
      usable: availabilityState === 'ready',
      native: name !== 'OPENCLAW',
      availabilityState,
      checking: availabilityState === 'checking',
      stale: availabilityState === 'stale',
      ...overrides,
    };
  }

  it('prefers the harness catalog and normalizes its additive runtime metadata', async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        harnesses: [{
          id: 'DEEPSEEK_HARNESS',
          displayName: 'DeepSeek Harness',
          transport: 'json-rpc-stdio',
          releaseStage: 'developer-preview',
          selectable: false,
          compatibilityProviderId: null,
          implemented: false,
          auth: {
            owner: 'model-provider-account',
            requiresSeparateLogin: true,
            modelProviderIds: ['deepseek'],
          },
          models: {
            catalogOwner: 'none',
            catalogKind: 'none',
            selectionMode: 'none',
            canEnumerate: false,
            supportsCustomInput: false,
          },
          capabilities: {
            supportsCancellation: true,
            cancellationMode: 'process-kill',
          },
        }],
      },
    });

    await expect(loadAgentChatProviderCatalog()).resolves.toEqual([
      expect.objectContaining({
        harnessId: 'DEEPSEEK_HARNESS',
        name: 'DEEPSEEK_HARNESS',
        displayName: 'DeepSeek Harness',
        transport: 'json-rpc-stdio',
        releaseStage: 'developer-preview',
        selectable: false,
        auth: expect.objectContaining({ owner: 'model-provider-account' }),
        models: expect.objectContaining({ selectionMode: 'none' }),
        capabilities: expect.objectContaining({ cancellationMode: 'process-kill' }),
      }),
    ]);
    expect(mocks.get).toHaveBeenCalledWith(
      '/gateway/harnesses',
      expect.objectContaining({ _silent: true }),
    );
  });

  it('accepts the providers compatibility envelope from the harness endpoint', async () => {
    mocks.get.mockResolvedValueOnce({
      data: { providers: [provider('CODEX', 'ready')] },
    });

    await expect(loadAgentChatProviderCatalog()).resolves.toEqual([
      provider('CODEX', 'ready'),
    ]);
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual(['/gateway/harnesses']);
  });

  it('falls back to the legacy providers endpoint only when harnesses is missing', async () => {
    mocks.get
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ data: { providers: [provider('CODEX', 'ready')] } });

    await expect(loadAgentChatProviderCatalog()).resolves.toEqual([
      provider('CODEX', 'ready'),
    ]);
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual([
      '/gateway/harnesses',
      '/gateway/providers',
    ]);
  });

  it('does not mask a failing harness endpoint with the legacy provider authority', async () => {
    mocks.get.mockRejectedValueOnce({ response: { status: 503 } });

    await expect(loadAgentChatProviderCatalog()).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
    });
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual(['/gateway/harnesses']);
  });

  it('polls a cold checking catalog until it becomes ready', async () => {
    vi.useFakeTimers();
    const snapshots: AgentChatProviderCatalogEntry[][] = [];
    mocks.get
      .mockResolvedValueOnce({
        data: { providers: [provider('CODEX', 'checking')] },
      })
      .mockResolvedValueOnce({
        data: { providers: [provider('CODEX', 'ready')] },
      });

    const request = loadAgentChatProviderCatalog({
      timeoutMs: 1_000,
      pollIntervalMs: 25,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(request).resolves.toEqual([provider('CODEX', 'ready')]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(snapshots.map((snapshot) => snapshot[0].availabilityState)).toEqual([
      'checking',
      'ready',
    ]);
  });

  it('publishes mixed fast and slow rows without waiting to expose the ready row', async () => {
    vi.useFakeTimers();
    const snapshots: AgentChatProviderCatalogEntry[][] = [];
    mocks.get
      .mockResolvedValueOnce({
        data: {
          providers: [
            provider('OPENCLAW', 'ready'),
            provider('CODEX', 'checking'),
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          providers: [
            provider('OPENCLAW', 'ready'),
            provider('CODEX', 'ready'),
          ],
        },
      });

    const request = loadAgentChatProviderCatalog({
      timeoutMs: 1_000,
      pollIntervalMs: 20,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    await vi.waitFor(() => {
      expect(snapshots[0]).toEqual([
        provider('OPENCLAW', 'ready'),
        provider('CODEX', 'checking'),
      ]);
    });
    expect(assessAgentChatProviderAvailability('OPENCLAW', snapshots[0][0]).canSend).toBe(true);
    expect(assessAgentChatProviderAvailability('CODEX', snapshots[0][1]).canSend).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    await expect(request).resolves.toHaveLength(2);
  });

  it('shares one polling flight across Agent Chat consumers', async () => {
    vi.useFakeTimers();
    let resolveRequest!: (value: { data: { providers: AgentChatProviderCatalogEntry[] } }) => void;
    mocks.get
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRequest = resolve;
      }))
      .mockResolvedValueOnce({
        data: { providers: [provider('CODEX', 'ready')] },
      });

    const selectorSnapshots: AgentChatProviderCatalogEntry[][] = [];
    const chatSnapshots: AgentChatProviderCatalogEntry[][] = [];
    const selectorRequest = loadAgentChatProviderCatalog({
      timeoutMs: 1_000,
      pollIntervalMs: 25,
      onSnapshot: (snapshot) => selectorSnapshots.push(snapshot),
    });
    const chatInterfaceRequest = loadAgentChatProviderCatalog({
      timeoutMs: 1_000,
      pollIntervalMs: 25,
      onSnapshot: (snapshot) => chatSnapshots.push(snapshot),
    });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    resolveRequest({ data: { providers: [provider('CODEX', 'checking')] } });
    await vi.advanceTimersByTimeAsync(25);
    await expect(Promise.all([selectorRequest, chatInterfaceRequest])).resolves.toEqual([
      [provider('CODEX', 'ready')],
      [provider('CODEX', 'ready')],
    ]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(selectorSnapshots).toEqual(chatSnapshots);
    await expect(loadAgentChatProviderCatalog()).resolves.toEqual([provider('CODEX', 'ready')]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('cancels one consumer without aborting the polling flight still owned by another', async () => {
    let resolveRequest!: (value: { data: { providers: AgentChatProviderCatalogEntry[] } }) => void;
    let requestSignal: AbortSignal | undefined;
    mocks.get.mockImplementationOnce((_url: string, config?: { signal?: AbortSignal }) => {
      requestSignal = config?.signal;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = loadAgentChatProviderCatalog({ signal: firstController.signal });
    const second = loadAgentChatProviderCatalog({ signal: secondController.signal });
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(false);
    resolveRequest({ data: { providers: [provider('CODEX', 'ready')] } });
    await expect(second).resolves.toEqual([provider('CODEX', 'ready')]);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good snapshot when a forced refresh fails', async () => {
    mocks.get
      .mockResolvedValueOnce({ data: { providers: [provider('OPENCLAW', 'ready')] } })
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce({ data: { providers: [provider('OPENCLAW', 'ready')] } });

    await loadAgentChatProviderCatalog();
    await expect(loadAgentChatProviderCatalog({ force: true })).rejects.toMatchObject(
      { code: 'REQUEST_FAILED' },
    );

    expect(getCachedAgentChatProviderCatalog()).toEqual([provider('OPENCLAW', 'ready')]);
    await expect(loadAgentChatProviderCatalog()).resolves.toEqual([provider('OPENCLAW', 'ready')]);
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });

  it('does not replay a cached ready row as fresh evidence during an explicit retry', async () => {
    mocks.get.mockResolvedValueOnce({
      data: { providers: [provider('CODEX', 'ready')] },
    });
    await loadAgentChatProviderCatalog();
    let resolveRefresh!: (value: { data: { providers: AgentChatProviderCatalogEntry[] } }) => void;
    mocks.get.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const snapshots: AgentChatProviderCatalogEntry[][] = [];

    const refresh = loadAgentChatProviderCatalog({
      force: true,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    expect(snapshots).toEqual([]);
    resolveRefresh({ data: { providers: [provider('CODEX', 'ready')] } });
    await expect(refresh).resolves.toEqual([provider('CODEX', 'ready')]);
    expect(snapshots).toEqual([[provider('CODEX', 'ready')]]);
  });

  it('marks an aged cached replay as display-only until a fresh network snapshot arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T12:00:00.000Z'));
    mocks.get.mockResolvedValueOnce({
      data: { providers: [provider('CODEX', 'ready')] },
    });
    await loadAgentChatProviderCatalog();

    await vi.advanceTimersByTimeAsync(5_000);
    let resolveRefresh!: (value: { data: { providers: AgentChatProviderCatalogEntry[] } }) => void;
    mocks.get.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const snapshots: Array<{
      providers: AgentChatProviderCatalogEntry[];
      metadata: AgentChatProviderCatalogSnapshotMetadata;
    }> = [];

    const refresh = loadAgentChatProviderCatalog({
      onSnapshot: (providers, metadata) => snapshots.push({ providers, metadata }),
    });

    expect(snapshots).toEqual([{
      providers: [provider('CODEX', 'ready')],
      metadata: expect.objectContaining({
        source: 'cache',
        fresh: false,
      }),
    }]);

    resolveRefresh({ data: { providers: [provider('CODEX', 'ready')] } });
    await expect(refresh).resolves.toEqual([provider('CODEX', 'ready')]);
    expect(snapshots[1]).toEqual({
      providers: [provider('CODEX', 'ready')],
      metadata: expect.objectContaining({
        source: 'network',
        fresh: true,
      }),
    });
  });

  it('keeps send admission closed across ready, switch-away, cache age, and switch-back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T12:00:00.000Z'));
    const readyRow = provider('CODEX', 'ready');
    let state: AgentChatSelectedProviderRevalidationState | null = null;
    const availability = (requestVersion: number) => assessAgentChatProviderAvailability(
      'CODEX',
      readyRow,
      {
        loading: isAgentChatSelectedProviderRevalidationPending(
          'CODEX',
          state,
          requestVersion,
        ),
        loadError: state?.provider === 'CODEX' ? state.loadError : null,
      },
    );

    mocks.get.mockResolvedValueOnce({
      data: { providers: [readyRow] },
    });
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'begin',
      provider: 'CODEX',
      generation: 1,
      requestVersion: 0,
    });
    await loadAgentChatProviderCatalog({
      onSnapshot: (providers, metadata) => {
        state = reduceAgentChatSelectedProviderRevalidation(state, {
          type: 'snapshot',
          provider: 'CODEX',
          generation: 1,
          providers,
          metadata,
        });
      },
    });
    expect(availability(0).canSend).toBe(true);

    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'begin',
      provider: 'OPENCLAW',
      generation: 2,
      requestVersion: 0,
    });
    expect(isAgentChatSelectedProviderRevalidationPending('OPENCLAW', state, 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    let resolveRevalidation!: (value: {
      data: { providers: AgentChatProviderCatalogEntry[] };
    }) => void;
    mocks.get.mockReturnValueOnce(new Promise((resolve) => {
      resolveRevalidation = resolve;
    }));
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'begin',
      provider: 'CODEX',
      generation: 3,
      requestVersion: 0,
    });
    const revalidation = loadAgentChatProviderCatalog({
      onSnapshot: (providers, metadata) => {
        state = reduceAgentChatSelectedProviderRevalidation(state, {
          type: 'snapshot',
          provider: 'CODEX',
          generation: 3,
          providers,
          metadata,
        });
      },
    });

    expect(availability(0)).toEqual(expect.objectContaining({
      status: 'checking',
      canSend: false,
    }));

    resolveRevalidation({ data: { providers: [readyRow] } });
    await revalidation;
    expect(availability(0).canSend).toBe(true);
  });

  it('keeps retry and abort races scoped to the exact selected-provider generation', () => {
    const codexReady = provider('CODEX', 'ready');
    const claudeReady = provider('CLAUDE_CODE', 'ready', { displayName: 'Claude Code' });
    let state: AgentChatSelectedProviderRevalidationState | null =
      reduceAgentChatSelectedProviderRevalidation(null, {
        type: 'begin',
        provider: 'CODEX',
        generation: 1,
        requestVersion: 0,
      });
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'snapshot',
      provider: 'CODEX',
      generation: 1,
      providers: [codexReady],
      metadata: { source: 'network', fresh: true, fetchedAt: 1_000 },
    });

    // A Retry click closes admission immediately, before its effect begins.
    expect(isAgentChatSelectedProviderRevalidationPending('CODEX', state, 1)).toBe(true);
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'begin',
      provider: 'CODEX',
      generation: 2,
      requestVersion: 1,
    });
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'begin',
      provider: 'CLAUDE_CODE',
      generation: 3,
      requestVersion: 1,
    });

    const afterSwitch = state;
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'snapshot',
      provider: 'CODEX',
      generation: 2,
      providers: [codexReady],
      metadata: { source: 'network', fresh: true, fetchedAt: 2_000 },
    });
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'failure',
      provider: 'CODEX',
      generation: 2,
      error: 'late aborted request failure',
    });
    expect(state).toBe(afterSwitch);
    expect(isAgentChatSelectedProviderRevalidationPending('CLAUDE_CODE', state, 1)).toBe(true);

    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'snapshot',
      provider: 'CLAUDE_CODE',
      generation: 3,
      providers: [claudeReady],
      metadata: { source: 'network', fresh: true, fetchedAt: 2_100 },
    });
    expect(isAgentChatSelectedProviderRevalidationPending('CLAUDE_CODE', state, 1)).toBe(false);
  });

  it('does not let an unrelated background catalog flight block an already-current provider', async () => {
    const codexReady = provider('CODEX', 'ready');
    let state: AgentChatSelectedProviderRevalidationState | null =
      reduceAgentChatSelectedProviderRevalidation(null, {
        type: 'begin',
        provider: 'CODEX',
        generation: 1,
        requestVersion: 0,
      });
    state = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'snapshot',
      provider: 'CODEX',
      generation: 1,
      providers: [codexReady],
      metadata: { source: 'network', fresh: true, fetchedAt: 1_000 },
    });
    const backgroundController = new AbortController();
    mocks.get.mockReturnValueOnce(new Promise(() => undefined));
    const backgroundFlight = loadAgentChatProviderCatalog({
      force: true,
      signal: backgroundController.signal,
    });

    expect(assessAgentChatProviderAvailability('CODEX', codexReady, {
      loading: isAgentChatSelectedProviderRevalidationPending('CODEX', state, 0),
    }).canSend).toBe(true);

    backgroundController.abort();
    await expect(backgroundFlight).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out a catalog that never settles without creating an unbounded request loop', async () => {
    vi.useFakeTimers();
    mocks.get.mockResolvedValue({
      data: { providers: [provider('CODEX', 'checking')] },
    });

    const request = loadAgentChatProviderCatalog({
      timeoutMs: 30,
      pollIntervalMs: 10,
      requestTimeoutMs: 10,
    });
    const rejection = expect(request).rejects.toEqual(expect.objectContaining({
      name: 'AgentChatProviderCatalogLoadError',
      code: 'TIMEOUT',
    }));
    await vi.advanceTimersByTimeAsync(40);
    await rejection;

    expect(mocks.get.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.get.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it.each([
    [
      'stale',
      provider('CODEX', 'stale', {
        usable: false,
        lastKnownUsable: true,
        reason: 'Provider availability could not be refreshed.',
      }),
    ],
    [
      'error',
      provider('CODEX', 'error', {
        installed: null,
        usable: false,
        reason: 'Provider availability could not be checked.',
      }),
    ],
    [
      'unusable',
      provider('CODEX', 'ready', {
        installed: false,
        usable: false,
        reason: 'Codex is not installed.',
      }),
    ],
  ])('fails closed for a settled %s provider row', (status, row) => {
    const assessment = assessAgentChatProviderAvailability('CODEX', row);
    expect(assessment.status).toBe(status);
    expect(assessment.canSend).toBe(false);
    expect(assessment.message).toBeTruthy();
    expect(assessment.retryable).toBe(true);
  });

  it('fails closed when the OpenClaw catalog row is missing instead of assuming gateway readiness', () => {
    expect(assessAgentChatProviderAvailability('OPENCLAW', undefined)).toEqual({
      status: 'error',
      canSend: false,
      message: 'OPENCLAW availability is unknown. Retry the provider check before sending.',
      retryable: true,
    });
  });

  it('keeps OpenClaw revalidation pending until a fresh host-availability row settles', () => {
    const state = reduceAgentChatSelectedProviderRevalidation(null, {
      type: 'begin',
      provider: 'OPENCLAW',
      generation: 7,
      requestVersion: 3,
    });
    expect(state?.pending).toBe(true);
    expect(isAgentChatSelectedProviderRevalidationPending('OPENCLAW', state, 3)).toBe(true);

    const settled = reduceAgentChatSelectedProviderRevalidation(state, {
      type: 'snapshot',
      provider: 'OPENCLAW',
      generation: 7,
      providers: [provider('OPENCLAW', 'ready', {
        usable: false,
        reason: 'OPENCLAW_RUNTIME_UNAVAILABLE: OpenClaw host Agent Chat is unavailable.',
      })],
      metadata: { source: 'network', fresh: true, fetchedAt: Date.now() },
    });
    expect(settled?.pending).toBe(false);
    expect(isAgentChatSelectedProviderRevalidationPending('OPENCLAW', settled, 3)).toBe(false);
    expect(assessAgentChatProviderAvailability(
      'OPENCLAW',
      provider('OPENCLAW', 'ready', {
        usable: false,
        reason: 'OPENCLAW_RUNTIME_UNAVAILABLE: OpenClaw host Agent Chat is unavailable.',
      }),
    )).toMatchObject({ status: 'unusable', canSend: false });
  });

  it('keeps Send blocked with the separate-login explanation after a native auth rejection', () => {
    const assessment = assessAgentChatProviderAvailability(
      'CLAUDE_CODE',
      provider('CLAUDE_CODE', 'ready', {
        usable: false,
        native: true,
        nativeAuthStatus: 'needs_login',
        nativeAuthMessage: 'Claude Code authentication was rejected. Reconnect it in AI Settings and retry.',
      }),
    );

    expect(assessment).toEqual({
      status: 'unusable',
      canSend: false,
      message: 'Claude Code authentication was rejected. Reconnect it in AI Settings and retry.',
      retryable: true,
    });
  });

  it('treats a catalog-visible preview harness as informative but non-retryable', () => {
    const assessment = assessAgentChatProviderAvailability(
      'DEEPSEEK_HARNESS',
      provider('DEEPSEEK_HARNESS', 'ready', {
        displayName: 'DeepSeek Harness',
        installed: null,
        implemented: false,
        selectable: false,
        usable: false,
        releaseStage: 'developer-preview',
        unavailableReason: 'Developer Preview: persistent Agent Chat parity is not available.',
      }),
    );

    expect(assessment).toEqual({
      status: 'unusable',
      canSend: false,
      message: 'Developer Preview: persistent Agent Chat parity is not available.',
      retryable: false,
    });
  });

  it('keeps model enumeration outside the provider-readiness decision', () => {
    const assessment = assessAgentChatProviderAvailability(
      'CODEX',
      provider('CODEX', 'ready', {
        capabilities: {
          supportsModelSelection: true,
          canEnumerateModels: false,
          modelCatalogKind: 'none',
        },
      }),
    );

    expect(assessment).toEqual({
      status: 'ready',
      canSend: true,
      message: null,
      retryable: false,
    });
  });

  it('reports a typed timeout rather than treating checking as final', () => {
    const error = new AgentChatProviderCatalogLoadError('TIMEOUT', 'timed out');
    expect(error.code).toBe('TIMEOUT');
    expect(error.name).toBe('AgentChatProviderCatalogLoadError');
  });
});
