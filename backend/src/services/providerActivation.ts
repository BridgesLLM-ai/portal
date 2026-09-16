import { isDeepStrictEqual } from 'util';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { assertOpenClawGatewayAuthorizationFenceReleased } from './openClawGatewayAuthorizationFence';
import { getNativeProviderReadiness } from '../agents/nativeProviderReadiness';
import { AI_PROVIDER_MAP } from '../config/aiProviders';
import { getOpenClawApiUrl } from '../config/openclaw';

type Rpc = typeof gatewayRpcCall;
type RecordValue = Record<string, any>;
const record = (value: any): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const modelPattern = /^[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;
const blocked = new Set(['__proto__', 'prototype', 'constructor']);

export class ProviderActivationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}
export function canonicalNativeModelRef(value: string): string {
  return value.replace(/^(?:openai-codex|codex)\//, 'openai/')
    .replace(/^google-gemini-cli\//, 'google/').replace(/^claude-cli\//, 'anthropic/');
}
export function providerModelPrefix(provider: string): string {
  return ({ 'openai-codex': 'openai', codex: 'openai', 'google-gemini-cli': 'google' } as Record<string, string>)[provider] || provider;
}
function safeModel(value: string): string {
  const model = canonicalNativeModelRef(value);
  if (!modelPattern.test(model) || model.split('/').some(part => blocked.has(part))) {
    throw new ProviderActivationError('INVALID_MODEL', 'Select an exact model from the native catalog.', 400);
  }
  return model;
}

export interface ProviderModel {
  id: string;
  name: string;
  provider: string;
  runtime: string;
  ready: boolean;
  readiness: 'ready' | 'unavailable' | 'unknown';
  registered: boolean;
}
type CliCatalog = { runtime: string; models: string[]; loginPresent: boolean };
// Only a local gateway can share Portal's admitted CLI/credential store. A
// remote gateway must report its own ready routes through models.list.
export async function discoverLocalSubscriptionCatalogs(refresh: boolean): Promise<CliCatalog[]> {
  let host: string;
  try { host = new URL(getOpenClawApiUrl()).hostname; } catch { return []; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return [];
  return Promise.all((['CLAUDE_CODE', 'CODEX'] as const).map(async provider => {
    const runtime = provider === 'CLAUDE_CODE' ? 'claude-cli' : 'codex';
    try {
      const status = await getNativeProviderReadiness(provider, { force: refresh, executionScope: 'HOST_OPERATOR' });
      const catalog = AI_PROVIDER_MAP.get(provider === 'CLAUDE_CODE' ? 'anthropic' : 'openai-codex')?.defaultModels || [];
      return { runtime, loginPresent: status.usable && ['login_present', 'live_verified'].includes(status.state),
        models: catalog.map(model => canonicalNativeModelRef(model.id)) };
    } catch { return { runtime, loginPresent: false, models: [] }; }
  }));
}
export class ProviderActivationService {
  constructor(private readonly rpc: Rpc = gatewayRpcCall,
    private readonly fence = assertOpenClawGatewayAuthorizationFenceReleased,
    private readonly cliCatalogs = discoverLocalSubscriptionCatalogs) {}

  private async config() {
    const result = await this.rpc('config.get', {}, 15_000);
    const config = result.data?.config ?? result.data?.parsed;
    if (!result.ok || !record(config) || result.data?.valid === false || typeof result.data?.hash !== 'string') {
      throw new ProviderActivationError('NATIVE_CONFIG_UNAVAILABLE', 'OpenClaw configuration could not be verified. Refresh after the gateway reconnects.', 503);
    }
    return { config, hash: result.data.hash as string };
  }

  async discover(provider?: string, refresh = false): Promise<{ models: ProviderModel[]; source: string }> {
    const [snapshot, result, detected, cliCatalogs] = await Promise.all([
      this.config(),
      this.rpc('models.list', { view: 'all', ...(refresh ? { refresh: true } : {}) }, 30_000),
      this.rpc('openclaw.setup.detect', {}, 30_000),
      this.cliCatalogs(refresh),
    ]);
    if (!result.ok || !Array.isArray(result.data?.models)) {
      throw new ProviderActivationError('NATIVE_MODEL_CATALOG_UNAVAILABLE', 'The native model catalog is unavailable. Retry after the gateway reconnects.', 503);
    }
    const configured = snapshot.config.agents?.defaults?.models || {};
    const subscriptionRuntime = provider === 'openai-codex' ? 'codex'
      : provider === 'google-gemini-cli' ? 'google-gemini-cli' : null;
    const candidates: any[] = detected.ok && Array.isArray(detected.data?.candidates) ? detected.data.candidates : [];
    const models = new Map<string, ProviderModel>();
    for (const entry of result.data.models) {
      if (!record(entry) || typeof entry.id !== 'string' || typeof entry.provider !== 'string') continue;
      const id = canonicalNativeModelRef(entry.id.startsWith(entry.provider + '/') ? entry.id : entry.provider + '/' + entry.id);
      if (!modelPattern.test(id) || (provider && !id.startsWith(providerModelPrefix(provider) + '/'))) continue;
      const existingRuntime = configured[id]?.agentRuntime?.id;
      const nativeRuntime = typeof entry.agentRuntime?.id === 'string' ? entry.agentRuntime.id : null;
      // A registered model's explicit declaration is authoritative for the route it
      // already has; the host runtime is only assumed when nothing names another.
      const declaredRuntime = typeof existingRuntime === 'string' && !['auto', 'default'].includes(existingRuntime) ? existingRuntime : null;
      let runtime = nativeRuntime || declaredRuntime || 'openclaw';
      let available = entry.available;
      // Native CLI detector rows attest installation, NOT login. Combine that
      // observation with the existing admitted host-login check and the exact
      // supported CLI catalog. Never infer readiness from a provider prefix or
      // an invented detector.credentials flag. Discovery itself changes nothing.
      const fallback = cliCatalogs.find(cli => cli.loginPresent && cli.models.includes(id)
        && candidates.some(item => item.kind === (cli.runtime === 'codex' ? 'codex-cli' : 'claude-cli'))
        && (subscriptionRuntime ? cli.runtime === subscriptionRuntime
          : (!provider || provider === 'anthropic') && cli.runtime === 'claude-cli'));
      // The 2026.9.3 harness policy "auto" omits agentRuntime from models.list rows
      // and reports a ready Claude/Codex CLI route as available:true. Registering
      // such a row with the built-in `openclaw` runtime declares a credential-less
      // API route for the model; the gateway then fails every models.list with
      // "Prepared synthetic auth is missing for anthropic" until an unrelated
      // config change (reproduced on an isolated 2026.9.3 gateway; see
      // audit full-completion-20260915/MODEL-DEFAULT-FAILURE-DIAGNOSIS-7549.md).
      // The admitted local login is the evidence for the route, so pin the CLI
      // runtime whenever neither the native row nor the existing declaration
      // names a different explicit runtime, regardless of native availability.
      if (fallback
        && (!existingRuntime || ['auto', 'default'].includes(existingRuntime))
        && (!nativeRuntime || ['auto', 'default', 'openclaw'].includes(nativeRuntime))) {
        runtime = fallback.runtime;
        available = true;
      }
      if (subscriptionRuntime && runtime !== subscriptionRuntime) available = false;
      models.set(id, {
        id, name: typeof entry.name === 'string' ? entry.name : id, provider: id.split('/')[0],
        runtime, ready: available === true,
        readiness: available === true ? 'ready' : available === false ? 'unavailable' : 'unknown',
        registered: Object.prototype.hasOwnProperty.call(configured, id),
      });
    }
    return { models: [...models.values()], source: 'native' };
  }

  async probe(provider: string) {
    await this.fence();
    const result = await this.rpc('models.probe', { provider: provider === 'openai-codex' ? 'openai' : provider, timeoutMs: 15_000 }, 20_000);
    if (!result.ok) throw new ProviderActivationError('NATIVE_PROVIDER_PROBE_UNAVAILABLE', 'The native provider could not run the requested credential probe.', 409);
    return { ok: result.data?.status === 'ok', provider, status: result.data?.status || 'unknown', source: 'native' };
  }

  async apply(input: { provider?: string; models?: string[]; primary?: string; fallbacks?: string[]; profileId?: string }) {
    await this.fence();
    const refs = [...new Set([...(input.models || []), ...(input.primary ? [input.primary] : []), ...(input.fallbacks || [])].map(safeModel))];
    if (input.provider && refs.some(id => !id.startsWith(providerModelPrefix(input.provider!) + '/'))) {
      throw new ProviderActivationError('MODEL_PROVIDER_MISMATCH', 'Selected models must belong to the selected provider.', 400);
    }
    const catalog = await this.discover(input.provider, true);
    const selected = refs.map(id => {
      const model = catalog.models.find(item => item.id === id);
      if (!model?.ready) throw new ProviderActivationError('MODEL_NOT_READY', 'The selected model does not have a ready native credential/runtime route.');
      return model;
    });
    const before = await this.config();
    const defaults = before.config.agents?.defaults || {};
    const registry = defaults.models || {};
    const models: RecordValue = {};
    for (const model of selected) {
      const existing = registry[model.id];
      if (existing !== undefined && !record(existing)) {
        throw new ProviderActivationError('MODEL_CONFIG_CONFLICT', 'The existing model entry cannot be safely extended.');
      }
      const runtime = existing?.agentRuntime?.id;
      if (runtime && !['auto', 'default', model.runtime].includes(runtime)) {
        throw new ProviderActivationError('MODEL_RUNTIME_CONFLICT', 'The model already has a different explicit runtime. Its existing route was preserved.');
      }
      // Only add absent declarations/runtime fields. Keep aliases, params, auth,
      // per-model policy, other providers, and agent-specific overrides unchanged.
      if (!existing) models[model.id] = { agentRuntime: { id: model.runtime } };
      else if (!runtime || runtime === 'auto' || runtime === 'default') models[model.id] = { agentRuntime: { id: model.runtime } };
    }
    if (input.profileId) {
      const auth = await this.rpc('models.authStatus', { refresh: true }, 20_000);
      const providers = auth.ok && Array.isArray(auth.data?.providers) ? auth.data.providers : [];
      const profile = providers.find((item: any) => item.profiles?.some((entry: any) => entry.profileId === input.profileId
        && ['ok', 'static', 'expiring'].includes(entry.status)));
      if (!profile || !input.primary || providerModelPrefix(profile.provider) !== safeModel(input.primary).split('/')[0]) {
        throw new ProviderActivationError('AUTH_PROFILE_MISMATCH', 'Select a configured auth profile for this model.');
      }
      // Native profile selection is a suffix on the primary reference, not an
      // invented auth property on a strict model declaration.

    }
    const patchDefaults: RecordValue = {};
    if (Object.keys(models).length) patchDefaults.models = models;
    const currentModel = defaults.model;
    const modelPatch: RecordValue = {};
    if (input.primary) modelPatch.primary = safeModel(input.primary) + (input.profileId ? '@' + input.profileId : '');
    if (input.fallbacks) modelPatch.fallbacks = input.fallbacks.map(safeModel);
    if (Object.keys(modelPatch).length) {
      // A native string primary is a supported schema union, not an empty object.
      patchDefaults.model = typeof currentModel === 'string'
        ? { primary: currentModel, ...modelPatch } : modelPatch;
    }
    const expected: RecordValue = { ...defaults, ...patchDefaults,
      ...(patchDefaults.models ? { models: { ...registry } } : {}),
      ...(patchDefaults.model ? { model: { ...(record(currentModel) ? currentModel : {}), ...patchDefaults.model } } : {}),
    };
    if (patchDefaults.models) {
      for (const [id, entry] of Object.entries(models)) {
        expected.models[id] = { ...registry[id], ...entry,
          ...(entry.agentRuntime ? { agentRuntime: { ...registry[id]?.agentRuntime, ...entry.agentRuntime } } : {}) };
      }
    }
    if (isDeepStrictEqual(defaults, expected)) return { success: true, changed: false, model: input.primary || null, verified: true };
    const patch = { agents: { defaults: patchDefaults } };
    const result = await this.rpc('config.patch', {
      raw: JSON.stringify(patch), baseHash: before.hash,
      ...(input.fallbacks ? { replacePaths: ['agents.defaults.model.fallbacks'] } : {}),
    }, 20_000);
    // A dispatch timeout is not proof of failure. Read back once, never replay.
    let after;
    try { after = await this.config(); } catch {
      throw new ProviderActivationError('MODEL_ACTIVATION_PENDING', 'The gateway disconnected during model activation. Refresh model status before retrying.', 202);
    }
    if (!isDeepStrictEqual(after.config.agents?.defaults, expected)) {
      throw new ProviderActivationError(result.ok ? 'MODEL_ACTIVATION_UNVERIFIED' : 'MODEL_CONFIG_CONFLICT',
        'The requested model configuration was not verified. Existing configuration was not overwritten by a retry.', 409);
    }
    // Verify the rest of the native config was not replaced by our small patch.
    const withoutDefaults = (config: RecordValue) => ({ ...config, meta: undefined, agents: { ...config.agents, defaults: undefined } });
    if (!isDeepStrictEqual(withoutDefaults(before.config), withoutDefaults(after.config))) {
      throw new ProviderActivationError('MODEL_CONFIG_CHANGED', 'Another configuration change was observed. Refresh before further changes.');
    }
    return { success: true, changed: true, model: input.primary || null, verified: true, reconciled: !result.ok };
  }
}
