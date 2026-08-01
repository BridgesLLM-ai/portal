import {
  AGENT_ZERO_OAUTH_PROVIDER_IDS,
  getDefaultAgentZeroOAuthClient,
  type AgentZeroOAuthClient,
  type AgentZeroOAuthModelCatalog,
  type AgentZeroOAuthProviderId,
} from './AgentZeroOAuthControl';

export interface AgentZeroSelectableOAuthModel {
  id: string;
  providerId: AgentZeroOAuthProviderId;
  model: string;
  displayName: string;
  providerDisplayName: string;
  description: string;
}

export class AgentZeroOAuthModelCatalogError extends Error {
  readonly code: 'CATALOG_UNAVAILABLE' | 'NO_CONNECTED_MODELS' | 'MODEL_NOT_AVAILABLE' | 'MODEL_PROTOCOL_INCOMPATIBLE';

  constructor(
    code: AgentZeroOAuthModelCatalogError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'AgentZeroOAuthModelCatalogError';
    this.code = code;
  }
}

export const AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE =
  'This model is unavailable in Agent Zero host Agent Chat because it has not passed the exact response-protocol qualification for this runtime. Choose the qualified Agent Zero host-chat model; native-provider availability is unchanged, and Project Chat still requires its own live qualification.';

// Fail closed: this registry contains only exact provider/model pairs that have
// completed the live disposable response-protocol proof for the pinned host
// Agent Chat runtime. It is deliberately not a Project Chat or tool-execution
// qualification; those trust zones require their own live evidence.
const QUALIFIED_AGENT_ZERO_HOST_CHAT_MODELS = new Set([
  'codex_oauth/gpt-5.6-terra',
]);

// Project Chat may offer only reviewed candidates to its separate live
// qualification flow. Presence here never marks a model Project-qualified.
const AGENT_ZERO_PROJECT_QUALIFICATION_CANDIDATES = new Set([
  'codex_oauth/gpt-5.6-terra',
]);

function modelCompatibilityKey(providerId: unknown, model: unknown): string {
  return `${String(providerId || '').trim()}/${String(model || '').trim()}`;
}

export function isAgentZeroOAuthHostChatModelQualified(
  providerId: unknown,
  model: unknown,
): boolean {
  return QUALIFIED_AGENT_ZERO_HOST_CHAT_MODELS.has(modelCompatibilityKey(providerId, model));
}

export function filterAgentZeroOAuthModelsForHostChat<T extends { id: string }>(
  providerId: unknown,
  models: readonly T[],
): T[] {
  return models.filter((model) => isAgentZeroOAuthHostChatModelQualified(providerId, model.id));
}

export function isAgentZeroOAuthProjectQualificationCandidate(
  providerId: unknown,
  model: unknown,
): boolean {
  return AGENT_ZERO_PROJECT_QUALIFICATION_CANDIDATES.has(modelCompatibilityKey(providerId, model));
}

export function filterAgentZeroOAuthModelsForProjectQualification<T extends { id: string }>(
  providerId: unknown,
  models: readonly T[],
): T[] {
  return models.filter((model) => (
    isAgentZeroOAuthProjectQualificationCandidate(providerId, model.id)
  ));
}

export function filterAgentZeroOAuthModelCatalogForHostChat(
  catalog: AgentZeroOAuthModelCatalog,
): AgentZeroOAuthModelCatalog {
  return {
    ...catalog,
    providers: Array.isArray(catalog.providers)
      ? catalog.providers.map((provider) => ({
          ...provider,
          models: filterAgentZeroOAuthModelsForHostChat(provider.providerId, provider.models || []),
        }))
      : [],
  };
}

const DEFAULT_CATALOG_CACHE_TTL_MS = 5_000;
const DEFAULT_CATALOG_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_CATALOG_RETRY_COOLDOWN_MS = 10_000;
let defaultCatalogGeneration = 0;
let defaultCatalogCache: {
  client: AgentZeroOAuthClient;
  at: number;
  models: AgentZeroSelectableOAuthModel[];
} | null = null;
interface DefaultCatalogAttempt {
  client: AgentZeroOAuthClient;
  promise: Promise<AgentZeroSelectableOAuthModel[]>;
  underlying: Promise<AgentZeroSelectableOAuthModel[]>;
  controller: AbortController;
  generation: number;
}

let defaultCatalogInflight: DefaultCatalogAttempt | null = null;
let defaultCatalogCooldownUntil = 0;

export function invalidateAgentZeroOAuthModelCatalogCache(): void {
  defaultCatalogGeneration += 1;
  defaultCatalogCache = null;
  defaultCatalogCooldownUntil = 0;
  defaultCatalogInflight?.controller.abort();
}

function parseSelection(value: unknown): { providerId: string; model: string } | null {
  const text = String(value || '').trim();
  const separator = text.indexOf('/');
  if (separator <= 0 || separator === text.length - 1) return null;
  return {
    providerId: text.slice(0, separator).trim().toLowerCase(),
    model: text.slice(separator + 1).trim(),
  };
}

export function selectableAgentZeroOAuthModels(
  catalog: AgentZeroOAuthModelCatalog,
): AgentZeroSelectableOAuthModel[] {
  if (catalog.available !== true || !Array.isArray(catalog.providers)) return [];
  const models: AgentZeroSelectableOAuthModel[] = [];
  const seen = new Set<string>();
  for (const provider of catalog.providers) {
    if (provider.connectionState !== 'connected') continue;
    for (const model of provider.models || []) {
      const modelId = String(model.id || '').trim();
      if (!modelId) continue;
      if (!isAgentZeroOAuthHostChatModelQualified(provider.providerId, modelId)) continue;
      const id = `${provider.providerId}/${modelId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        providerId: provider.providerId,
        model: modelId,
        displayName: String(model.displayName || modelId).trim() || modelId,
        providerDisplayName: String(provider.displayName || provider.providerId).trim() || provider.providerId,
        description: String(model.description || '').trim(),
      });
    }
  }
  return models;
}

function catalogUnavailable(message: string): AgentZeroOAuthModelCatalogError {
  return new AgentZeroOAuthModelCatalogError('CATALOG_UNAVAILABLE', message);
}

function waitForCatalogWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(catalogUnavailable(
    'Agent Zero OAuth model-catalog verification was interrupted before it completed.',
  ));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(catalogUnavailable(
      'Agent Zero OAuth model-catalog verification was interrupted before it completed.',
    ));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function boundAgentZeroOAuthModelCatalogResolution(
  underlying: Promise<AgentZeroSelectableOAuthModel[]>,
  controller: AbortController,
  onTimeout: () => void = () => undefined,
): Promise<AgentZeroSelectableOAuthModel[]> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      controller.abort();
      reject(new AgentZeroOAuthModelCatalogError(
        'CATALOG_UNAVAILABLE',
        'Agent Zero could not verify its official OAuth model catalog within the readiness window.',
      ));
    }, DEFAULT_CATALOG_READINESS_TIMEOUT_MS);
    timeout.unref?.();
  });
  return Promise.race([underlying, timedOut]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export async function loadSelectableAgentZeroOAuthModels(
  client: Pick<AgentZeroOAuthClient, 'status' | 'models'> = getDefaultAgentZeroOAuthClient(),
  signal?: AbortSignal,
): Promise<AgentZeroSelectableOAuthModel[]> {
  if (signal?.aborted) {
    throw catalogUnavailable(
      'Agent Zero OAuth model-catalog verification was interrupted before it completed.',
    );
  }
  const defaultClient = getDefaultAgentZeroOAuthClient();
  const cacheable = client === defaultClient;
  if (cacheable
    && defaultCatalogCache?.client === defaultClient
    && Date.now() - defaultCatalogCache.at < DEFAULT_CATALOG_CACHE_TTL_MS) {
    return [...defaultCatalogCache.models];
  }
  const existing = cacheable && defaultCatalogInflight?.client === defaultClient
    ? defaultCatalogInflight
    : null;
  if (existing) {
    return waitForCatalogWithSignal(existing.promise, signal).then((models) => [...models]);
  }
  if (cacheable && Date.now() < defaultCatalogCooldownUntil) {
    throw catalogUnavailable(
      'Agent Zero is cooling down after an interrupted OAuth model-catalog request. Retry after the bounded recovery window.',
    );
  }

  const generation = defaultCatalogGeneration;
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal, controller);
  const underlying = resolveSelectableAgentZeroOAuthModels(client, controller.signal);
  const bounded = boundAgentZeroOAuthModelCatalogResolution(underlying, controller, () => {
    if (cacheable) defaultCatalogCooldownUntil = Date.now() + DEFAULT_CATALOG_RETRY_COOLDOWN_MS;
  });
  const promise = bounded.then((models) => {
    if (cacheable && generation !== defaultCatalogGeneration) {
      throw new AgentZeroOAuthModelCatalogError(
        'CATALOG_UNAVAILABLE',
        'Agent Zero OAuth account state changed while its model catalog was being verified. Retry with the current account state.',
      );
    }
    return [...models];
  });
  if (cacheable) {
    const inflight: DefaultCatalogAttempt = {
      client: defaultClient,
      promise,
      underlying,
      controller,
      generation,
    };
    defaultCatalogInflight = inflight;
    const clearInflight = () => {
      if (defaultCatalogInflight === inflight) defaultCatalogInflight = null;
      unlink();
    };
    void underlying.then((models) => {
      if (defaultCatalogInflight === inflight
        && generation === defaultCatalogGeneration
        && !controller.signal.aborted) {
        defaultCatalogCache = { client: defaultClient, at: Date.now(), models: [...models] };
      }
      clearInflight();
    }, clearInflight);
  } else {
    void promise.finally(unlink).catch(() => undefined);
  }
  return waitForCatalogWithSignal(promise, signal).then((models) => [...models]);
}

export function __resetAgentZeroOAuthModelCatalogForTests(): void {
  defaultCatalogGeneration += 1;
  defaultCatalogCache = null;
  defaultCatalogInflight?.controller.abort();
  defaultCatalogInflight = null;
  defaultCatalogCooldownUntil = 0;
}

async function resolveSelectableAgentZeroOAuthModels(
  client: Pick<AgentZeroOAuthClient, 'status' | 'models'>,
  signal?: AbortSignal,
): Promise<AgentZeroSelectableOAuthModel[]> {
  let status: Awaited<ReturnType<AgentZeroOAuthClient['status']>>;
  try {
    status = await client.status(signal);
  } catch {
    throw new AgentZeroOAuthModelCatalogError(
      'CATALOG_UNAVAILABLE',
      'Agent Zero could not verify its official OAuth model catalog. Retry, or reconnect Agent Zero OAuth in AI Settings.',
    );
  }
  if (!status.available) {
    throw new AgentZeroOAuthModelCatalogError(
      'CATALOG_UNAVAILABLE',
      'Agent Zero did not advertise its complete official OAuth provider catalog.',
    );
  }
  const connected = status.providers.filter((provider) => (
    provider.connected && provider.connectionState === 'connected'
  ));
  const resolved = await Promise.all(connected.map(async (provider) => {
    try {
      const catalog = await client.models(provider.providerId, status, signal);
      const rawModels = Array.isArray(catalog.models) ? catalog.models : [];
      const incompatibleCount = rawModels.filter((model) => {
        const modelId = String(model?.id || '').trim();
        return Boolean(modelId)
          && !isAgentZeroOAuthHostChatModelQualified(provider.providerId, modelId);
      }).length;
      return {
        catalogUnavailable: false,
        incompatibleCount,
        models: filterAgentZeroOAuthModelsForHostChat(provider.providerId, rawModels).map((model) => ({
          id: `${provider.providerId}/${model.id}`,
          providerId: provider.providerId,
          model: model.id,
          displayName: model.displayName,
          providerDisplayName: provider.displayName,
          description: model.description,
        } satisfies AgentZeroSelectableOAuthModel)),
      };
    } catch {
      // One stale connected account must not hide another provider whose exact
      // authenticated catalog is healthy. If no authoritative catalog survives,
      // report availability failure rather than falsely telling an already-
      // connected owner to connect another account.
      return {
        catalogUnavailable: true,
        incompatibleCount: 0,
        models: [] as AgentZeroSelectableOAuthModel[],
      };
    }
  }));
  const models = Array.from(new Map(
    resolved.flatMap((entry) => entry.models).map((model) => [model.id, model] as const),
  ).values());
  if (!models.length) {
    if (resolved.some((entry) => entry.incompatibleCount > 0)) {
      throw new AgentZeroOAuthModelCatalogError(
        'MODEL_PROTOCOL_INCOMPATIBLE',
        AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
      );
    }
    if (resolved.some((entry) => entry.catalogUnavailable)) {
      throw new AgentZeroOAuthModelCatalogError(
        'CATALOG_UNAVAILABLE',
        'Agent Zero could not load a complete official model catalog from any connected OAuth account. Retry, or reconnect the affected Agent Zero provider in AI Settings.',
      );
    }
    throw new AgentZeroOAuthModelCatalogError(
      'NO_CONNECTED_MODELS',
      'No connected Agent Zero OAuth account currently exposes a selectable qualified model. Refresh the model list or reconnect the provider in AI Settings before starting a chat.',
    );
  }
  return models;
}

export async function validateAgentZeroOAuthModelSelection(
  value: unknown,
  client: Pick<AgentZeroOAuthClient, 'status' | 'models'> = getDefaultAgentZeroOAuthClient(),
): Promise<AgentZeroSelectableOAuthModel> {
  const parsed = parseSelection(value);
  if (!parsed || !AGENT_ZERO_OAUTH_PROVIDER_IDS.includes(parsed.providerId as AgentZeroOAuthProviderId)) {
    throw new AgentZeroOAuthModelCatalogError(
      'MODEL_NOT_AVAILABLE',
      'Choose a model from a connected Agent Zero OAuth provider before starting the chat.',
    );
  }
  if (!isAgentZeroOAuthHostChatModelQualified(parsed.providerId, parsed.model)) {
    throw new AgentZeroOAuthModelCatalogError(
      'MODEL_PROTOCOL_INCOMPATIBLE',
      AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
    );
  }
  const models = await loadSelectableAgentZeroOAuthModels(client);
  const selected = models.find((model) => (
    model.providerId === parsed.providerId && model.model === parsed.model
  ));
  if (!selected) {
    throw new AgentZeroOAuthModelCatalogError(
      'MODEL_NOT_AVAILABLE',
      'The selected Agent Zero OAuth model is not available to the connected account. Refresh the model list or reconnect that provider.',
    );
  }
  return selected;
}
