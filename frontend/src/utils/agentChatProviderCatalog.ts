import client from '../api/client';

export type AgentChatProviderAvailabilityState = 'checking' | 'ready' | 'stale' | 'error';

export interface AgentChatProviderCatalogEntry {
  name: string;
  displayName: string;
  installed?: boolean | null;
  implemented?: boolean;
  usable?: boolean;
  command?: string;
  version?: string;
  native?: boolean;
  reason?: string;
  nativeAuthStatus?: 'not_applicable' | 'authenticated' | 'needs_login' | 'unknown';
  nativeAuthMessage?: string;
  nativeAuthLoginCommand?: string;
  availabilityState?: AgentChatProviderAvailabilityState;
  checking?: boolean;
  stale?: boolean;
  checkedAt?: string;
  lastKnownUsable?: boolean;
  capabilities?: {
    implemented?: boolean;
    requiresGateway?: boolean;
    adapterFamily?: string;
    adapterKey?: string;
    supportsHistory?: boolean;
    supportsModelSelection?: boolean;
    modelSelectionMode?: string;
    supportsCustomModelInput?: boolean;
    canEnumerateModels?: boolean;
    supportsSessionList?: boolean;
    supportsExecApproval?: boolean;
    modelCatalogKind?: string;
    supportsInTurnSteering?: boolean;
    supportsQueuedFollowUps?: boolean;
    followUpMode?: string;
  };
}

interface CachedProviderCatalog {
  providers: AgentChatProviderCatalogEntry[];
  fetchedAt: number;
  trusted: boolean;
}

export type AgentChatProviderAvailabilityStatus =
  | 'checking'
  | 'ready'
  | 'stale'
  | 'error'
  | 'unusable';

export interface AgentChatProviderAvailabilityAssessment {
  status: AgentChatProviderAvailabilityStatus;
  canSend: boolean;
  message: string | null;
  retryable: boolean;
}

export interface AgentChatProviderCatalogSnapshotMetadata {
  source: 'cache' | 'network';
  fresh: boolean;
  fetchedAt: number;
}

export interface AgentChatProviderCatalogLoadOptions {
  force?: boolean;
  signal?: AbortSignal;
  onSnapshot?: (
    providers: AgentChatProviderCatalogEntry[],
    metadata: AgentChatProviderCatalogSnapshotMetadata,
  ) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface AgentChatSelectedProviderRevalidationState {
  provider: string;
  generation: number;
  requestVersion: number;
  pending: boolean;
  loadError: string | null;
}

export type AgentChatSelectedProviderRevalidationAction =
  | {
      type: 'begin';
      provider: string;
      generation: number;
      requestVersion: number;
    }
  | {
      type: 'snapshot';
      provider: string;
      generation: number;
      providers: AgentChatProviderCatalogEntry[];
      metadata: AgentChatProviderCatalogSnapshotMetadata;
    }
  | {
      type: 'failure';
      provider: string;
      generation: number;
      error: string;
    };

export class AgentChatProviderCatalogLoadError extends Error {
  readonly code: 'TIMEOUT' | 'REQUEST_FAILED';
  readonly cause?: unknown;

  constructor(
    code: 'TIMEOUT' | 'REQUEST_FAILED',
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AgentChatProviderCatalogLoadError';
    this.code = code;
    this.cause = options.cause;
  }
}

interface ProviderCatalogFlight {
  controller: AbortController;
  consumers: Set<symbol>;
  snapshotListeners: Map<
    symbol,
    (
      providers: AgentChatProviderCatalogEntry[],
      metadata: AgentChatProviderCatalogSnapshotMetadata,
    ) => void
  >;
  promise: Promise<AgentChatProviderCatalogEntry[]>;
  settled: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
}

const PROVIDER_CATALOG_CACHE_TTL_MS = 5_000;
const PROVIDER_CATALOG_SETTLE_TIMEOUT_MS = 45_000;
const PROVIDER_CATALOG_POLL_INTERVAL_MS = 750;
const PROVIDER_CATALOG_REQUEST_TIMEOUT_MS = 5_000;
let cachedCatalog: CachedProviderCatalog | null = null;
let activeCatalogFlight: ProviderCatalogFlight | null = null;

function providerCatalogKey(provider: unknown): string {
  return String(provider || '').trim().toUpperCase();
}

function findProviderCatalogEntry(
  providers: AgentChatProviderCatalogEntry[],
  provider: unknown,
): AgentChatProviderCatalogEntry | undefined {
  const key = providerCatalogKey(provider);
  if (!key) return undefined;
  return providers.find((entry) => providerCatalogKey(entry?.name) === key);
}

function cachedSnapshotMetadata(
  cache: CachedProviderCatalog,
  now = Date.now(),
): AgentChatProviderCatalogSnapshotMetadata {
  return {
    source: 'cache',
    fresh: cache.trusted && now - cache.fetchedAt < PROVIDER_CATALOG_CACHE_TTL_MS,
    fetchedAt: cache.fetchedAt,
  };
}

function validateCatalog(value: unknown): AgentChatProviderCatalogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Provider catalog response did not include a providers array');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Provider catalog included an invalid provider row');
    }
    const candidate = entry as Partial<AgentChatProviderCatalogEntry>;
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
      throw new Error('Provider catalog included a provider without a name');
    }
    if (typeof candidate.displayName !== 'string' || !candidate.displayName.trim()) {
      throw new Error(`Provider catalog included ${candidate.name} without a display name`);
    }
    return candidate as AgentChatProviderCatalogEntry;
  });
}

function normalizePositiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function createAbortError(): Error {
  const error = new Error('Provider catalog request was cancelled');
  error.name = 'AbortError';
  return error;
}

export function isAgentChatProviderCatalogAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

export function isAgentChatProviderCatalogEntryChecking(
  entry: AgentChatProviderCatalogEntry,
): boolean {
  return entry.checking === true || entry.availabilityState === 'checking';
}

export function isAgentChatProviderCatalogSettled(
  providers: AgentChatProviderCatalogEntry[],
): boolean {
  return providers.every((entry) => !isAgentChatProviderCatalogEntryChecking(entry));
}

function publishSnapshot(
  flight: ProviderCatalogFlight,
  providers: AgentChatProviderCatalogEntry[],
  metadata: AgentChatProviderCatalogSnapshotMetadata,
): void {
  for (const listener of flight.snapshotListeners.values()) {
    try {
      listener(providers, metadata);
    } catch {
      // A consumer render callback must never poison the shared polling loop.
    }
  }
}

function markCachedCatalogUntrusted(): void {
  if (cachedCatalog) cachedCatalog = { ...cachedCatalog, trusted: false };
}

function waitForNextPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    function handleAbort() {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener('abort', handleAbort);
      reject(createAbortError());
    }
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

async function runCatalogFlight(
  flight: ProviderCatalogFlight,
): Promise<AgentChatProviderCatalogEntry[]> {
  const startedAt = Date.now();

  while (true) {
    if (flight.controller.signal.aborted) throw createAbortError();
    const elapsedBeforeRequest = Date.now() - startedAt;
    if (elapsedBeforeRequest >= flight.timeoutMs) {
      markCachedCatalogUntrusted();
      throw new AgentChatProviderCatalogLoadError(
        'TIMEOUT',
        'Provider availability checks did not settle before the deadline.',
      );
    }

    try {
      const remainingMs = Math.max(1, flight.timeoutMs - elapsedBeforeRequest);
      const { data } = await client.get('/gateway/providers', {
        signal: flight.controller.signal,
        timeout: Math.max(1, Math.min(flight.requestTimeoutMs, remainingMs)),
        _silent: true,
      } as any);
      const providers = validateCatalog(data?.providers);
      cachedCatalog = {
        providers,
        fetchedAt: Date.now(),
        trusted: true,
      };
      publishSnapshot(flight, providers, {
        source: 'network',
        fresh: true,
        fetchedAt: cachedCatalog.fetchedAt,
      });
      if (isAgentChatProviderCatalogSettled(providers)) return providers;
    } catch (error) {
      if (flight.controller.signal.aborted || isAgentChatProviderCatalogAbortError(error)) {
        throw createAbortError();
      }
      if (error instanceof AgentChatProviderCatalogLoadError) throw error;
      markCachedCatalogUntrusted();
      throw new AgentChatProviderCatalogLoadError(
        'REQUEST_FAILED',
        'Provider availability could not be loaded.',
        { cause: error },
      );
    }

    const remainingMs = flight.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      markCachedCatalogUntrusted();
      throw new AgentChatProviderCatalogLoadError(
        'TIMEOUT',
        'Provider availability checks did not settle before the deadline.',
      );
    }
    await waitForNextPoll(
      flight.controller.signal,
      Math.max(0, Math.min(flight.pollIntervalMs, remainingMs)),
    );
  }
}

function createCatalogFlight(options: AgentChatProviderCatalogLoadOptions): ProviderCatalogFlight {
  const flight: ProviderCatalogFlight = {
    controller: new AbortController(),
    consumers: new Set<symbol>(),
    snapshotListeners: new Map<
      symbol,
      (
        providers: AgentChatProviderCatalogEntry[],
        metadata: AgentChatProviderCatalogSnapshotMetadata,
      ) => void
    >(),
    promise: Promise.resolve([] as AgentChatProviderCatalogEntry[]),
    settled: false,
    timeoutMs: normalizePositiveDuration(options.timeoutMs, PROVIDER_CATALOG_SETTLE_TIMEOUT_MS),
    pollIntervalMs: normalizePositiveDuration(options.pollIntervalMs, PROVIDER_CATALOG_POLL_INTERVAL_MS),
    requestTimeoutMs: normalizePositiveDuration(options.requestTimeoutMs, PROVIDER_CATALOG_REQUEST_TIMEOUT_MS),
  };
  flight.promise = runCatalogFlight(flight)
    .finally(() => {
      flight.settled = true;
      flight.snapshotListeners.clear();
      if (activeCatalogFlight === flight) activeCatalogFlight = null;
    });
  // The last consumer may cancel before Axios observes the abort. Keep that
  // expected rejection handled while each active consumer receives its own copy.
  void flight.promise.catch(() => undefined);
  activeCatalogFlight = flight;
  return flight;
}

function attachCatalogConsumer(
  flight: ProviderCatalogFlight,
  options: AgentChatProviderCatalogLoadOptions,
): Promise<AgentChatProviderCatalogEntry[]> {
  const consumerId = Symbol('provider-catalog-consumer');
  flight.consumers.add(consumerId);
  if (options.onSnapshot) {
    flight.snapshotListeners.set(consumerId, options.onSnapshot);
    if (cachedCatalog?.trusted && !options.force) {
      try {
        options.onSnapshot(
          cachedCatalog.providers,
          cachedSnapshotMetadata(cachedCatalog),
        );
      } catch {
        // Match the shared publish boundary: render callbacks are isolated.
      }
    }
  }

  return new Promise<AgentChatProviderCatalogEntry[]>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener('abort', handleAbort);
      flight.consumers.delete(consumerId);
      flight.snapshotListeners.delete(consumerId);
      callback();
      if (!flight.settled && flight.consumers.size === 0) {
        if (activeCatalogFlight === flight) activeCatalogFlight = null;
        flight.controller.abort();
      }
    };
    const handleAbort = () => finish(() => reject(createAbortError()));

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    flight.promise.then(
      (providers) => finish(() => resolve(providers)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * AgentSelector and ChatInterface share this bounded polling boundary. Every
 * consumer receives intermediate snapshots, but only one HTTP request/poll
 * timer exists at a time. When the final consumer unmounts, the current request
 * and pending timer are cancelled.
 */
export function loadAgentChatProviderCatalog(
  options: AgentChatProviderCatalogLoadOptions = {},
): Promise<AgentChatProviderCatalogEntry[]> {
  if (options.signal?.aborted) return Promise.reject(createAbortError());
  const now = Date.now();
  if (!options.force
    && cachedCatalog
    && cachedCatalog.trusted
    && isAgentChatProviderCatalogSettled(cachedCatalog.providers)
    && now - cachedCatalog.fetchedAt < PROVIDER_CATALOG_CACHE_TTL_MS) {
    options.onSnapshot?.(
      cachedCatalog.providers,
      cachedSnapshotMetadata(cachedCatalog, now),
    );
    return Promise.resolve(cachedCatalog.providers);
  }
  const flight = activeCatalogFlight && !activeCatalogFlight.controller.signal.aborted
    ? activeCatalogFlight
    : createCatalogFlight(options);
  return attachCatalogConsumer(flight, options);
}

export function getCachedAgentChatProviderCatalog(): AgentChatProviderCatalogEntry[] | null {
  return cachedCatalog?.providers || null;
}

export function invalidateAgentChatProviderCatalog(): void {
  cachedCatalog = null;
}

export function formatAgentChatProviderCatalogLoadError(error: unknown): string {
  if (error instanceof AgentChatProviderCatalogLoadError && error.code === 'TIMEOUT') {
    return 'Provider availability checks timed out. Retry to check again.';
  }
  return 'Provider availability could not be loaded. Retry to check again.';
}

export function assessAgentChatProviderAvailability(
  providerName: string,
  entry: AgentChatProviderCatalogEntry | undefined,
  options: { loading?: boolean; loadError?: string | null } = {},
): AgentChatProviderAvailabilityAssessment {
  if (providerName === 'OPENCLAW') {
    return { status: 'ready', canSend: true, message: null, retryable: false };
  }

  const displayName = entry?.displayName || providerName;
  if (options.loadError) {
    return {
      status: 'error',
      canSend: false,
      message: `${displayName} availability could not be verified. ${options.loadError}`,
      retryable: true,
    };
  }
  if (options.loading) {
    return {
      status: 'checking',
      canSend: false,
      message: `Checking ${displayName} availability before sending…`,
      retryable: false,
    };
  }
  if (!entry) {
    return {
      status: 'error',
      canSend: false,
      message: `${displayName} availability is unknown. Retry the provider check before sending.`,
      retryable: true,
    };
  }

  const detail = entry.nativeAuthMessage || entry.reason;
  if (isAgentChatProviderCatalogEntryChecking(entry)) {
    return {
      status: 'checking',
      canSend: false,
      message: detail || `${displayName} availability is still being checked. Sending is paused until it finishes.`,
      retryable: false,
    };
  }
  if (entry.stale === true || entry.availabilityState === 'stale') {
    return {
      status: 'stale',
      canSend: false,
      message: detail || `${displayName} availability is stale. Retry the provider check before sending.`,
      retryable: true,
    };
  }
  if (entry.availabilityState === 'error') {
    return {
      status: 'error',
      canSend: false,
      message: detail || `${displayName} availability could not be checked. Retry before sending.`,
      retryable: true,
    };
  }
  if (entry.installed === null) {
    return {
      status: 'error',
      canSend: false,
      message: detail || `${displayName} availability could not be checked. Retry before sending.`,
      retryable: true,
    };
  }
  if (entry.implemented === false) {
    return {
      status: 'unusable',
      canSend: false,
      message: detail || `${displayName} is not implemented for Agent Chat.`,
      retryable: true,
    };
  }
  if (entry.installed === false) {
    return {
      status: 'unusable',
      canSend: false,
      message: detail || `${displayName} is not installed. Configure it in AI Providers before sending.`,
      retryable: true,
    };
  }
  if (entry.nativeAuthStatus === 'needs_login') {
    return {
      status: 'unusable',
      canSend: false,
      message: detail || `${displayName} needs its separate native sign-in before Agent Chat can send.`,
      retryable: true,
    };
  }
  if (entry.usable !== true) {
    return {
      status: 'unusable',
      canSend: false,
      message: detail || `${displayName} is not currently usable. Retry after fixing its provider setup.`,
      retryable: true,
    };
  }
  return { status: 'ready', canSend: true, message: null, retryable: false };
}

/**
 * Keep selected-provider send admission tied to the exact revalidation that
 * ChatInterface started. Cached rows may still render while pending, but only
 * a fresh, settled row for that provider can release the generation.
 */
export function reduceAgentChatSelectedProviderRevalidation(
  state: AgentChatSelectedProviderRevalidationState | null,
  action: AgentChatSelectedProviderRevalidationAction,
): AgentChatSelectedProviderRevalidationState | null {
  const provider = providerCatalogKey(action.provider);
  if (action.type === 'begin') {
    return {
      provider,
      generation: action.generation,
      requestVersion: action.requestVersion,
      pending: provider !== 'OPENCLAW',
      loadError: null,
    };
  }

  if (!state
    || state.provider !== provider
    || state.generation !== action.generation) {
    return state;
  }

  if (action.type === 'snapshot') {
    if (!action.metadata.fresh) return state;
    const selectedEntry = findProviderCatalogEntry(action.providers, provider);
    if (!selectedEntry || isAgentChatProviderCatalogEntryChecking(selectedEntry)) {
      return {
        ...state,
        pending: true,
        loadError: null,
      };
    }
    return {
      ...state,
      pending: false,
      loadError: null,
    };
  }

  if (!state.pending) return state;
  return {
    ...state,
    pending: false,
    loadError: action.error,
  };
}

export function isAgentChatSelectedProviderRevalidationPending(
  provider: unknown,
  state: AgentChatSelectedProviderRevalidationState | null,
  requestVersion: number,
): boolean {
  const key = providerCatalogKey(provider);
  if (key === 'OPENCLAW') return false;
  return !key
    || !state
    || state.provider !== key
    || state.requestVersion !== requestVersion
    || state.pending;
}

export function __resetAgentChatProviderCatalogForTests(): void {
  activeCatalogFlight?.controller.abort();
  cachedCatalog = null;
  activeCatalogFlight = null;
}
