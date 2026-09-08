import type { AgentProviderName } from '../../../AgentProvider.interface';
import type { ProviderModelDescriptor } from '../../../providerModels';
import { buildAcpHarnessEnvironment } from './AcpHarnessEnvironment';
import { HERMES_ACP_PROFILE, OPENCODE_ACP_PROFILE } from './AcpHarnessProfiles';
import { AcpStdioBroker, type AcpModelState, type AcpStdioBrokerOptions } from './AcpStdioBroker';
import { readPersistedNativeAcpModelCatalog } from '../../NativeSessionStore';

type AcpCatalogProvider = Extract<AgentProviderName, 'HERMES' | 'OPENCODE'>;

const catalogs = new Map<AcpCatalogProvider, ProviderModelDescriptor[]>();

export function recordAcpModelCatalog(
  provider: AcpCatalogProvider,
  state: AcpModelState,
): void {
  const providerTag = provider.toLowerCase();
  const deduped = new Map<string, ProviderModelDescriptor>();
  for (const model of state.availableModels) {
    if (!deduped.has(model.id)) {
      deduped.set(model.id, {
        id: model.id,
        alias: null,
        provider: providerTag,
        displayName: model.name || model.id,
        source: 'dynamic',
      });
    }
  }
  catalogs.set(provider, [...deduped.values()]);
}

export function readAcpModelCatalog(
  provider: AcpCatalogProvider,
): ProviderModelDescriptor[] {
  const cached = catalogs.get(provider);
  if (cached) return cached.map((model) => ({ ...model }));
  const providerTag = provider.toLowerCase();
  const restored = readPersistedNativeAcpModelCatalog(provider).map((model) => ({
    id: model.id,
    alias: null,
    provider: providerTag,
    displayName: model.name || model.id,
    source: 'dynamic' as const,
  }));
  catalogs.set(provider, restored);
  return restored.map((model) => ({ ...model }));
}

export function invalidateAcpModelCatalog(provider: AcpCatalogProvider): void {
  catalogs.delete(provider);
}

/**
 * Ask the authenticated harness for its account-specific model catalog. ACP
 * exposes that catalog on session/new rather than initialize, so discovery
 * creates a non-prompting bootstrap session. OpenCode supports closing it;
 * Hermes currently does not advertise session/close and the local session is
 * therefore left to Hermes' own lifecycle policy.
 */
export async function refreshAcpModelCatalogFromRuntime(
  provider: AcpCatalogProvider,
  dependencies: {
    brokerFactory?: (options: AcpStdioBrokerOptions) => AcpStdioBroker;
    environmentBuilder?: typeof buildAcpHarnessEnvironment;
  } = {},
): Promise<ProviderModelDescriptor[]> {
  const profile = provider === 'HERMES' ? HERMES_ACP_PROFILE : OPENCODE_ACP_PROFILE;
  const environment = (dependencies.environmentBuilder || buildAcpHarnessEnvironment)(provider);
  const broker = (dependencies.brokerFactory || ((options) => new AcpStdioBroker(options)))({
    profile,
    cwd: String(environment.HOME || process.cwd()),
    environment,
    controlTimeoutMs: 15_000,
    closeGraceMs: 1_000,
  });
  try {
    const established = await broker.start();
    recordAcpModelCatalog(provider, established.modelState);
    if (profile.supportsSessionClose) await broker.closeSession();
    return readAcpModelCatalog(provider);
  } finally {
    try { await broker.dispose(); } catch {}
  }
}

export function __resetAcpModelCatalogForTests(): void {
  catalogs.clear();
}
