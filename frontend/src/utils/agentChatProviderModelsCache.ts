export interface AgentChatProviderModelCacheEntry {
  models: string[];
  capabilities?: {
    supportsModelSelection?: boolean;
    modelSelectionMode?: string;
    supportsCustomModelInput?: boolean;
    canEnumerateModels?: boolean;
    modelCatalogKind?: string;
  };
}

interface StoredEntry extends AgentChatProviderModelCacheEntry {
  cachedAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const AGENT_ZERO_TTL_MS = 5_000;
const cache = new Map<string, StoredEntry>();

export interface AgentChatProviderModelRequestGate {
  begin(provider: unknown): number;
  isCurrent(provider: unknown, generation: number): boolean;
}

function providerKey(provider: unknown): string {
  return String(provider || '').trim().toUpperCase();
}

function ttlForProvider(provider: string): number {
  return provider === 'AGENT_ZERO' ? AGENT_ZERO_TTL_MS : DEFAULT_TTL_MS;
}

/**
 * Keep async catalog responses ordered per provider. A forced refresh can
 * otherwise finish before an older request and then be silently overwritten
 * by the stale response.
 */
export function createAgentChatProviderModelRequestGate(): AgentChatProviderModelRequestGate {
  const generations = new Map<string, number>();
  return {
    begin(provider: unknown): number {
      const key = providerKey(provider);
      if (!key) return 0;
      const generation = (generations.get(key) || 0) + 1;
      generations.set(key, generation);
      return generation;
    },
    isCurrent(provider: unknown, generation: number): boolean {
      const key = providerKey(provider);
      return Boolean(key) && generation > 0 && generations.get(key) === generation;
    },
  };
}

export function getAgentChatProviderModelsCache(
  provider: unknown,
  now = Date.now(),
): AgentChatProviderModelCacheEntry | null {
  const key = providerKey(provider);
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.cachedAt >= ttlForProvider(key)) {
    cache.delete(key);
    return null;
  }
  return {
    models: [...entry.models],
    ...(entry.capabilities ? { capabilities: { ...entry.capabilities } } : {}),
  };
}

export function setAgentChatProviderModelsCache(
  provider: unknown,
  entry: AgentChatProviderModelCacheEntry,
  now = Date.now(),
): void {
  const key = providerKey(provider);
  if (!key) return;
  cache.set(key, {
    models: [...entry.models],
    ...(entry.capabilities ? { capabilities: { ...entry.capabilities } } : {}),
    cachedAt: now,
  });
}

export function invalidateAgentChatProviderModelsCache(provider?: unknown): void {
  const key = providerKey(provider);
  if (key) cache.delete(key);
  else cache.clear();
}
