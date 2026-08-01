import type { AgentProvider, AgentProviderName } from './AgentProvider.interface';
import { OpenClawProvider } from './providers/OpenClawProvider';
import { ClaudeCodeProvider } from './providers/ClaudeCodeProvider';
import { CodexProvider } from './providers/CodexProvider';
import { GrokProvider } from './providers/GrokProvider';
import { AgentZeroProvider } from './providers/AgentZeroProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import { OllamaProvider } from './providers/OllamaProvider';
import {
  getProviderAvailability,
  getProviderCatalogAvailabilityAsync,
  getProviderCapabilities,
  type ProviderAvailability,
  type ProviderCapabilitySummary,
} from './providerAvailability';
import { subscribeNativeProviderReadinessInvalidation } from './nativeProviderReadiness';

export interface RegisteredProviderInfo {
  name: AgentProviderName;
  displayName: string;
  installed: boolean;
  implemented: boolean;
  usable: boolean;
  command?: string;
  version?: string;
  native: boolean;
  reason?: string;
  nativeAuthStatus?: string;
  nativeAuthMessage?: string;
  nativeAuthLoginCommand?: string;
  requiresSeparateNativeLogin?: boolean;
  capabilities: ProviderCapabilitySummary;
}

export type ProviderCatalogAvailabilityState = 'checking' | 'ready' | 'stale' | 'error';

export interface CatalogProviderInfo extends Omit<RegisteredProviderInfo, 'installed'> {
  /** Null means installation has not been checked yet; it never means missing. */
  installed: boolean | null;
  /** Only `ready` rows may advertise `usable: true`. */
  availabilityState: ProviderCatalogAvailabilityState;
  checking: boolean;
  stale: boolean;
  checkedAt?: string;
  /** Preserves truthful last-known state while stale rows remain fail-closed. */
  lastKnownUsable?: boolean;
}

const providerConstructors: Record<AgentProviderName, new () => AgentProvider> = {
  OPENCLAW: OpenClawProvider,
  CLAUDE_CODE: ClaudeCodeProvider,
  CODEX: CodexProvider,
  GROK: GrokProvider,
  AGENT_ZERO: AgentZeroProvider,
  GEMINI: GeminiProvider,
  OLLAMA: OllamaProvider,
};

const providerDisplayNames: Record<AgentProviderName, string> = {
  OPENCLAW: 'OpenClaw',
  CLAUDE_CODE: 'Claude Code',
  CODEX: 'Codex',
  GROK: 'Grok Build',
  AGENT_ZERO: 'Agent Zero',
  GEMINI: 'Google Antigravity',
  OLLAMA: 'Ollama',
};

const PROVIDER_CATALOG_TTL_MS = 60_000;
const PROVIDER_CATALOG_FAILURE_RETRY_MS = 10_000;
const PROVIDER_CATALOG_RESPONSE_BUDGET_MS = 250;
const PROVIDER_CATALOG_PROBE_DEADLINE_MS = 35_000;

interface ProviderCatalogCacheEntry {
  availability?: ProviderAvailability;
  checkedAt?: number;
  failedAt?: number;
}

const providerCatalogCache = new Map<AgentProviderName, ProviderCatalogCacheEntry>();
const providerCatalogProbes = new Map<AgentProviderName, Promise<void>>();
const providerCatalogProviderEpochs = new Map<AgentProviderName, number>();
let providerCatalogEpoch = 0;

function invalidateProviderCatalogEntry(name: AgentProviderName): void {
  providerCatalogProviderEpochs.set(name, (providerCatalogProviderEpochs.get(name) || 0) + 1);
  providerCatalogCache.delete(name);
  providerCatalogProbes.delete(name);
}

subscribeNativeProviderReadinessInvalidation(invalidateProviderCatalogEntry);

function registeredProviderInfo(
  name: AgentProviderName,
  availability: ProviderAvailability,
): RegisteredProviderInfo {
  return {
    name,
    displayName: providerDisplayNames[name],
    installed: availability.installed,
    implemented: availability.implemented,
    usable: availability.usable,
    command: availability.command,
    version: availability.version,
    native: availability.native,
    reason: availability.reason,
    nativeAuthStatus: availability.nativeAuthStatus,
    nativeAuthMessage: availability.nativeAuthMessage,
    nativeAuthLoginCommand: availability.nativeAuthLoginCommand,
    requiresSeparateNativeLogin: availability.requiresSeparateNativeLogin,
    capabilities: availability.capabilities,
  };
}

function providerIsNative(name: AgentProviderName): boolean {
  return name !== 'OPENCLAW' && name !== 'AGENT_ZERO';
}

function catalogInfo(
  name: AgentProviderName,
  now: number,
): CatalogProviderInfo {
  const cached = providerCatalogCache.get(name);
  const pending = providerCatalogProbes.has(name);
  const checkedAt = cached?.checkedAt;
  const isFresh = Boolean(
    cached?.availability
    && checkedAt
    && now - checkedAt < PROVIDER_CATALOG_TTL_MS,
  );

  if (cached?.availability && isFresh) {
    return {
      ...registeredProviderInfo(name, cached.availability),
      availabilityState: 'ready',
      checking: false,
      stale: false,
      checkedAt: new Date(checkedAt!).toISOString(),
    };
  }

  if (cached?.availability) {
    const lastKnown = registeredProviderInfo(name, cached.availability);
    return {
      ...lastKnown,
      // Refreshing or failed stale evidence is useful context, but it must not
      // silently authorize a new selection.
      usable: false,
      availabilityState: 'stale',
      checking: pending,
      stale: true,
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : undefined,
      lastKnownUsable: lastKnown.usable,
      reason: pending
        ? `Rechecking provider availability. Last known state: ${lastKnown.reason || (lastKnown.usable ? 'usable' : 'unavailable')}`
        : `Provider availability could not be refreshed. Last known state: ${lastKnown.reason || (lastKnown.usable ? 'usable' : 'unavailable')}`,
    };
  }

  const capabilities = getProviderCapabilities(name);
  if (!capabilities) {
    throw new Error(`Missing provider capability definition for ${name}`);
  }
  const failedAt = cached?.failedAt;
  return {
    name,
    displayName: providerDisplayNames[name],
    installed: null,
    implemented: capabilities.implemented,
    usable: false,
    native: providerIsNative(name),
    reason: pending
      ? 'Checking provider availability.'
      : 'Provider availability could not be checked. Retry shortly.',
    capabilities,
    availabilityState: pending ? 'checking' : 'error',
    checking: pending,
    stale: false,
    checkedAt: failedAt ? new Date(failedAt).toISOString() : undefined,
  };
}

function providerCatalogNeedsRefresh(name: AgentProviderName, now: number): boolean {
  if (providerCatalogProbes.has(name)) return false;
  const cached = providerCatalogCache.get(name);
  if (cached?.failedAt && now - cached.failedAt < PROVIDER_CATALOG_FAILURE_RETRY_MS) {
    return false;
  }
  if (cached?.availability && cached.checkedAt) {
    return now - cached.checkedAt >= PROVIDER_CATALOG_TTL_MS;
  }
  return !cached?.failedAt || now - cached.failedAt >= PROVIDER_CATALOG_FAILURE_RETRY_MS;
}

async function probeProviderCatalogWithDeadline(
  name: AgentProviderName,
): Promise<ProviderAvailability> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      getProviderCatalogAvailabilityAsync(name),
      new Promise<ProviderAvailability>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Provider catalog probe timed out for ${name}`));
        }, PROVIDER_CATALOG_PROBE_DEADLINE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function startProviderCatalogProbe(name: AgentProviderName): Promise<void> {
  const existing = providerCatalogProbes.get(name);
  if (existing) return existing;
  const epoch = providerCatalogEpoch;
  const providerEpoch = providerCatalogProviderEpochs.get(name) || 0;
  const pending = Promise.resolve()
    .then(() => probeProviderCatalogWithDeadline(name))
    .then((availability) => {
      if (epoch !== providerCatalogEpoch
        || providerEpoch !== (providerCatalogProviderEpochs.get(name) || 0)) return;
      providerCatalogCache.set(name, {
        availability,
        checkedAt: Date.now(),
      });
    })
    .catch(() => {
      if (epoch !== providerCatalogEpoch
        || providerEpoch !== (providerCatalogProviderEpochs.get(name) || 0)) return;
      const previous = providerCatalogCache.get(name);
      providerCatalogCache.set(name, {
        ...previous,
        failedAt: Date.now(),
      });
    })
    .finally(() => {
      if (providerCatalogProbes.get(name) === pending) {
        providerCatalogProbes.delete(name);
      }
    });
  providerCatalogProbes.set(name, pending);
  return pending;
}

async function waitForCatalogBudget(probes: Promise<void>[]): Promise<void> {
  if (probes.length === 0) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(probes),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PROVIDER_CATALOG_RESPONSE_BUDGET_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class AgentRegistry {
  private static providers = new Map<AgentProviderName, AgentProvider>();
  private static defaultProvider: AgentProviderName = 'OPENCLAW';

  static getProvider(name: AgentProviderName): AgentProvider {
    const availability = getProviderAvailability(name);
    if (!availability.implemented) {
      throw new Error(`${providerDisplayNames[name]} is not implemented yet`);
    }
    if (!availability.installed) {
      throw new Error(`${providerDisplayNames[name]} is not installed on this machine`);
    }

    if (!this.providers.has(name)) {
      const ProviderCtor = providerConstructors[name];
      this.providers.set(name, new ProviderCtor());
    }
    return this.providers.get(name)!;
  }

  static get(name: AgentProviderName): AgentProvider {
    return this.getProvider(name);
  }

  static getDefault(): AgentProvider {
    const preferred = getProviderAvailability(this.defaultProvider);
    if (preferred.usable) return this.getProvider(this.defaultProvider);

    const fallback = this.listProviders().find((provider) => provider.usable);
    if (!fallback) {
      throw new Error('No usable agent providers are available');
    }
    return this.getProvider(fallback.name);
  }

  static setDefault(name: AgentProviderName): void {
    this.defaultProvider = name;
  }

  static listProviders(): RegisteredProviderInfo[] {
    return (Object.keys(providerConstructors) as AgentProviderName[]).map((name) => {
      const availability = getProviderAvailability(name);
      return registeredProviderInfo(name, availability);
    });
  }

  static async listProvidersAsync(): Promise<CatalogProviderInfo[]> {
    const names = Object.keys(providerConstructors) as AgentProviderName[];
    const now = Date.now();
    const probes = names
      .map((name) => {
        if (providerCatalogNeedsRefresh(name, now)) startProviderCatalogProbe(name);
        return providerCatalogProbes.get(name);
      })
      .filter((probe): probe is Promise<void> => Boolean(probe));
    await waitForCatalogBudget(probes);
    const snapshotAt = Date.now();
    return names.map((name) => catalogInfo(name, snapshotAt));
  }

  static __resetProviderCatalogForTests(): void {
    providerCatalogEpoch += 1;
    providerCatalogProviderEpochs.clear();
    providerCatalogCache.clear();
    providerCatalogProbes.clear();
  }
}
