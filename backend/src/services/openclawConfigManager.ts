import fs from 'fs';
import path from 'path';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import {
  getNativeCliAuthStatus,
  getNativeProviderLinkedToOpenClawProvider,
  type NativeCliAuthState,
} from '../agents/nativeCliAuth';
import { AI_PROVIDERS } from '../config/aiProviders';
import { normalizePortalModelId, repairClaudeSubscriptionConfig } from '../utils/openclawCli';

const HOME_DIR = process.env.HOME || '/root';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME_DIR, '.openclaw');
export const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');
export const MODELS_JSON_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'models.json');
export const CODEX_EXTERNAL_CLI_PROFILE_ID = 'openai:codex-cli';
export const CODEX_CLI_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');
export const OPENCLAW_CODEX_HOME_AUTH_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'codex-home', 'auth.json');

export interface AuthProfile {
  type: 'api_key' | 'token' | 'oauth';
  provider: string;
  key?: string;
  token?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  managedBy?: string;
}

interface AuthProfilesFile {
  version: number;
  profiles: Record<string, AuthProfile>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, { lastUsed?: number; errorCount?: number; cooldownUntil?: number }>;
}

export interface ProviderStatus {
  id: string;
  status: 'configured' | 'unconfigured' | 'error' | 'expired' | 'cooldown';
  authType: string | null;
  profileId: string | null;
  currentModel: string | null;
  isDefault: boolean;
  error: string | null;
  cooldownUntil: number | null;
  lastUsed: number | null;
  expiresAt: number | null;
  warning: string | null;
  nativeProvider: AgentProviderName | null;
  nativeCliAuthStatus: NativeCliAuthState | null;
  nativeCliAuthMessage: string | null;
  nativeCliLoginCommand: string | null;
  requiresSeparateNativeLogin: boolean;
}

function safeReadJson<T>(targetPath: string, fallback: T): T {
  try {
    if (!fs.existsSync(targetPath)) return fallback;
    const raw = fs.readFileSync(targetPath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeAuthProfile(profile: any): AuthProfile | null {
  const provider = typeof profile?.provider === 'string' ? profile.provider.trim() : '';
  if (!provider) return null;
  const type = typeof profile?.type === 'string'
    ? profile.type
    : (typeof profile?.mode === 'string' ? profile.mode : 'oauth');
  return {
    ...profile,
    provider,
    type,
  } as AuthProfile;
}

function normalizeAuthProfiles(rawProfiles: any): Record<string, AuthProfile> {
  if (!rawProfiles || typeof rawProfiles !== 'object') return {};
  const profiles: Record<string, AuthProfile> = {};
  for (const [profileId, rawProfile] of Object.entries(rawProfiles)) {
    const normalized = normalizeAuthProfile(rawProfile);
    if (normalized) profiles[profileId] = normalized;
  }
  return profiles;
}

function writeAuthProfilesFile(authProfiles: AuthProfilesFile) {
  fs.mkdirSync(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(authProfiles, null, 2), 'utf8');
}

export function readOpenClawConfig(): any {
  repairClaudeSubscriptionConfig();
  return safeReadJson(CONFIG_PATH, {});
}

export function readAuthProfiles(): AuthProfilesFile {
  const stored = safeReadJson<AuthProfilesFile>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
  const config = safeReadJson<any>(CONFIG_PATH, {});
  const configProfiles = normalizeAuthProfiles(config?.auth?.profiles);
  const storedProfiles = normalizeAuthProfiles(stored.profiles);

  return {
    ...stored,
    version: stored.version || 2,
    profiles: {
      ...configProfiles,
      ...storedProfiles,
    },
  };
}

export function getProviderAuthAliases(provider: string): Set<string> {
  const normalized = String(provider || '').trim();
  if (normalized === 'anthropic' || normalized === 'claude-cli') {
    return new Set(['anthropic', 'claude-cli']);
  }
  if (normalized === 'google-antigravity' || normalized === 'google-gemini-cli') {
    return new Set(['google-antigravity', 'google-gemini-cli']);
  }
  return new Set([normalized]);
}

export function getStaleProviderProfileIds(
  profiles: Record<string, Pick<AuthProfile, 'provider'> | undefined>,
  provider: string,
  preferredProfileId: string,
): string[] {
  const aliases = getProviderAuthAliases(provider);
  return Object.keys(profiles || {}).filter((profileId) => {
    if (profileId === preferredProfileId) return false;
    const profileProvider = profiles?.[profileId]?.provider;
    return typeof profileProvider === 'string' && aliases.has(profileProvider);
  });
}

export function cleanupStaleProviderAuthProfiles(
  provider: string,
  preferredProfileId: string,
  mode?: 'api_key' | 'token' | 'oauth',
): { removedProfileIds: string[] } {
  const aliases = getProviderAuthAliases(provider);
  const authProfiles = readAuthProfiles();
  if (!authProfiles.profiles) authProfiles.profiles = {};

  const preferredProfile = authProfiles.profiles[preferredProfileId];
  const removedProfileIds = getStaleProviderProfileIds(authProfiles.profiles, provider, preferredProfileId);

  for (const profileId of removedProfileIds) {
    delete authProfiles.profiles[profileId];
    if (authProfiles.usageStats) delete authProfiles.usageStats[profileId];
  }

  if (authProfiles.lastGood) {
    for (const [lastGoodKey, lastGoodProfileId] of Object.entries(authProfiles.lastGood)) {
      if (aliases.has(lastGoodKey) || removedProfileIds.includes(lastGoodProfileId)) {
        delete authProfiles.lastGood[lastGoodKey];
      }
    }
  }

  if (preferredProfile && preferredProfile.provider !== provider && aliases.has(preferredProfile.provider)) {
    authProfiles.profiles[preferredProfileId] = {
      ...preferredProfile,
      provider,
    };
  }

  writeAuthProfilesFile(authProfiles);

  const config = readOpenClawConfig();
  if (!config.auth) config.auth = {};
  if (!config.auth.profiles) config.auth.profiles = {};
  if (!config.auth.order) config.auth.order = {};

  for (const [profileId, profile] of Object.entries<any>(config.auth.profiles || {})) {
    if (profileId !== preferredProfileId && aliases.has(profile?.provider)) {
      delete config.auth.profiles[profileId];
    }
  }

  const existingProfile = config.auth.profiles[preferredProfileId] || {};
  config.auth.profiles[preferredProfileId] = {
    ...existingProfile,
    provider,
    mode: mode || preferredProfile?.type || existingProfile.mode || 'oauth',
  };

  for (const alias of aliases) {
    delete config.auth.order[alias];
  }
  config.auth.order[provider] = [preferredProfileId];

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return { removedProfileIds };
}

export function getDefaultModel(): string | null {
  const config = readOpenClawConfig();
  return normalizePortalModelId(config?.agents?.defaults?.model?.primary || '') || null;
}

export function isClaudeCliModelId(model: unknown): model is string {
  return typeof model === 'string' && model.startsWith('claude-cli/');
}

export function hasAnthropicClaudeCliReferences(config: any): boolean {
  const primary = config?.agents?.defaults?.model?.primary;
  if (isClaudeCliModelId(primary)) return true;

  const fallbacks = config?.agents?.defaults?.model?.fallbacks;
  if (Array.isArray(fallbacks) && fallbacks.some((model) => isClaudeCliModelId(model))) {
    return true;
  }

  const modelsRegistry = config?.agents?.defaults?.models;
  if (modelsRegistry && typeof modelsRegistry === 'object' && !Array.isArray(modelsRegistry)) {
    return Object.keys(modelsRegistry).some((modelId) => isClaudeCliModelId(modelId));
  }

  return false;
}

export function getFallbackModels(): string[] {
  const config = readOpenClawConfig();
  const fallbacks = config?.agents?.defaults?.model?.fallbacks;
  return Array.isArray(fallbacks)
    ? fallbacks
      .filter((item: unknown): item is string => typeof item === 'string')
      .map((model) => normalizePortalModelId(model))
      .filter(Boolean)
    : [];
}

/**
 * Provider API endpoint configurations used by OpenClaw gateway.
 * When a user saves an API key, we write provider config to models.json
 * so the gateway can actually reach the provider's API.
 */
type ProviderRuntimeCatalogConfig = { baseUrl?: string; api?: string; auth?: string };

const PROVIDER_API_CONFIG: Record<string, { baseUrl: string; api: string; auth?: string }> = {
  'anthropic': { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
  'openai': { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
  'google': { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', auth: 'api-key' },
  'openrouter': { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  'deepseek': { baseUrl: 'https://api.deepseek.com', api: 'openai-completions' },
  'mistral': { baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  'groq': { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  'together': { baseUrl: 'https://api.together.xyz/v1', api: 'openai-completions' },
  'xai': { baseUrl: 'https://api.x.ai/v1', api: 'openai-responses' },
};

const PROVIDER_RUNTIME_CATALOG_CONFIG: Record<string, ProviderRuntimeCatalogConfig> = {
  // OpenClaw's Google CLI OAuth backends are local/runtime-managed. They still need
  // a model catalog entry, but API/baseUrl fields would make it a custom HTTP provider.
  'google-gemini-cli': {},
  'google-antigravity': {},
};

const PROVIDERS_REQUIRING_RUNTIME_MODEL_CATALOG = new Set(['google-gemini-cli', 'google-antigravity']);

function getProviderRuntimeCatalogConfig(provider: string): ProviderRuntimeCatalogConfig | null {
  return PROVIDER_API_CONFIG[provider] || PROVIDER_RUNTIME_CATALOG_CONFIG[provider] || null;
}

function getProviderMeta(provider: string) {
  return AI_PROVIDERS.find((entry) => entry.id === provider) || null;
}

function isApiKeyProvider(provider: string): boolean {
  return Boolean(getProviderMeta(provider)?.authTypes.includes('api_key'));
}

function writeProviderSecret(options: {
  provider: string;
  profileId: string;
  authType: 'api_key' | 'token';
  secret: string;
}) {
  const { provider, profileId, authType, secret } = options;

  const authData = readAuthProfiles();
  authData.profiles[profileId] = authType === 'api_key'
    ? { type: 'api_key', provider, key: secret }
    : { type: 'token', provider, token: secret };
  writeAuthProfilesFile(authData);

  cleanupStaleProviderAuthProfiles(provider, profileId, authType);

  const apiConfig = PROVIDER_API_CONFIG[provider];
  if (apiConfig) {
    const modelsData = safeReadJson<any>(MODELS_JSON_PATH, { providers: {} });
    if (!modelsData.providers) modelsData.providers = {};
    const existingProviderConfig = modelsData.providers[provider] || {};
    const nextProviderConfig: Record<string, any> = {
      ...existingProviderConfig,
      ...apiConfig,
      models: Array.isArray(existingProviderConfig.models) ? existingProviderConfig.models : [],
    };
    if (authType === 'api_key' || authType === 'token') nextProviderConfig.apiKey = secret;
    if (apiConfig.auth) nextProviderConfig.auth = apiConfig.auth;
    modelsData.providers[provider] = nextProviderConfig;
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(modelsData, null, 2), 'utf8');
  }
}

/**
 * Save an API key directly to auth-profiles.json, openclaw.json, and models.json.
 * This bypasses the 'openclaw onboard' CLI which doesn't reliably persist
 * API keys for non-OAuth providers.
 */
export function saveProviderApiKey(provider: string, apiKey: string): { profileId: string } {
  const authType = isApiKeyProvider(provider) ? 'api_key' : 'token';
  const profileId = `${provider}:default`;
  writeProviderSecret({ provider, profileId, authType, secret: apiKey });
  return { profileId };
}

export function saveProviderToken(provider: string, token: string): { profileId: string } {
  const profileId = `${provider}:default`;
  writeProviderSecret({ provider, profileId, authType: 'token', secret: token });
  return { profileId };
}

function uniqueOrder(profileIds: string[]): string[] {
  return Array.from(new Set(profileIds.map((profileId) => String(profileId || '').trim()).filter(Boolean)));
}

export function syncCodexCliAuthToOpenClawCodexHome(): boolean {
  if (!fs.existsSync(CODEX_CLI_AUTH_PATH)) return false;
  const parsed = safeReadJson<any>(CODEX_CLI_AUTH_PATH, null);
  const hasUsableCredential = Boolean(
    parsed?.tokens?.access_token
      || parsed?.tokens?.refresh_token
      || (typeof parsed?.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim())
      || (parsed?.OPENAI_API_KEY && typeof parsed.OPENAI_API_KEY === 'object' && Object.keys(parsed.OPENAI_API_KEY).length > 0),
  );
  if (!hasUsableCredential) return false;

  fs.mkdirSync(path.dirname(OPENCLAW_CODEX_HOME_AUTH_PATH), { recursive: true });
  fs.copyFileSync(CODEX_CLI_AUTH_PATH, OPENCLAW_CODEX_HOME_AUTH_PATH);
  try {
    fs.chmodSync(OPENCLAW_CODEX_HOME_AUTH_PATH, 0o600);
  } catch {
    // Best effort only; the copy itself is the important part.
  }
  return true;
}

/**
 * OpenClaw 2026.6 runs Codex app-server auth through the canonical OpenAI
 * auth namespace, while the Portal still presents this as "OpenAI Codex".
 * Keep the Portal-facing provider separate, but pin OpenClaw to a dedicated
 * external-CLI bootstrap profile so Codex OAuth never overwrites OpenAI API keys.
 */
export function pinCodexExternalCliAuthProfile(profileId = CODEX_EXTERNAL_CLI_PROFILE_ID): { profileId: string; syncedCodexHomeAuth: boolean } {
  const syncedCodexHomeAuth = syncCodexCliAuthToOpenClawCodexHome();

  const authData = readAuthProfiles();
  authData.version = authData.version || 2;
  authData.profiles[profileId] = {
    ...(authData.profiles[profileId] || {}),
    type: 'oauth',
    provider: 'openai',
  };
  writeAuthProfilesFile(authData);

  const config = readOpenClawConfig();
  if (!config.auth) config.auth = {};
  if (!config.auth.profiles) config.auth.profiles = {};
  if (!config.auth.order) config.auth.order = {};

  config.auth.profiles[profileId] = {
    ...(config.auth.profiles[profileId] || {}),
    provider: 'openai',
    mode: 'oauth',
  };
  const currentOpenAiOrder = Array.isArray(config.auth.order.openai) ? config.auth.order.openai : [];
  config.auth.order.openai = uniqueOrder([
    profileId,
    ...currentOpenAiOrder.filter((candidate: unknown) => !String(candidate || '').startsWith('openai-codex:')),
  ]);
  delete config.auth.order['openai-codex'];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

  return { profileId, syncedCodexHomeAuth };
}

function normalizeProviderRuntimeModelId(provider: string, modelId: string): string | null {
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const prefix = `${provider}/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export function mergeProviderRuntimeCatalog(provider: string, existingProviderConfig: Record<string, any>, modelIds: string[]) {
  const runtimeConfig = getProviderRuntimeCatalogConfig(provider);
  if (!runtimeConfig) {
    return {
      changed: false,
      addedModels: [] as string[],
      nextProviderConfig: existingProviderConfig,
    };
  }
  const existingModels = Array.isArray(existingProviderConfig.models) ? existingProviderConfig.models : [];
  const seen = new Set<string>();
  const nextModels: Array<Record<string, any>> = [];

  for (const entry of existingModels) {
    const rawId = typeof entry === 'string' ? entry : String(entry?.id || '').trim();
    const id = normalizeProviderRuntimeModelId(provider, rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nextModels.push(typeof entry === 'string' ? { id, name: id } : { ...entry, id, name: entry.name || id });
  }

  const addedModels: string[] = [];
  for (const modelId of modelIds) {
    const id = normalizeProviderRuntimeModelId(provider, modelId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    addedModels.push(id);
    nextModels.push({ id, name: id });
  }

  const nextProviderConfig: Record<string, any> = {
    ...existingProviderConfig,
    ...runtimeConfig,
    models: nextModels,
  };

  const changed = JSON.stringify({
    baseUrl: existingProviderConfig.baseUrl,
    api: existingProviderConfig.api,
    auth: existingProviderConfig.auth,
    models: existingModels.map((entry: any) => typeof entry === 'string' ? { id: entry, name: entry } : { id: entry?.id, name: entry?.name, api: entry?.api }),
  }) !== JSON.stringify({
    baseUrl: nextProviderConfig.baseUrl,
    api: nextProviderConfig.api,
    auth: nextProviderConfig.auth,
    models: nextProviderConfig.models.map((entry: any) => ({ id: entry.id, name: entry.name, api: entry.api })),
  });

  return { changed, addedModels, nextProviderConfig };
}

export function registerProviderRuntimeModels(provider: string, modelIds: string[]): { changed: boolean; addedModels: string[] } {
  const runtimeConfig = getProviderRuntimeCatalogConfig(provider);
  if (!runtimeConfig) return { changed: false, addedModels: [] };

  const modelsData = safeReadJson<any>(MODELS_JSON_PATH, { providers: {} });
  if (!modelsData.providers) modelsData.providers = {};

  const modelsMerge = mergeProviderRuntimeCatalog(provider, modelsData.providers[provider] || {}, modelIds);
  if (modelsMerge.changed) {
    modelsData.providers[provider] = modelsMerge.nextProviderConfig;
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(modelsData, null, 2), 'utf8');
  }

  const config = readOpenClawConfig();
  if (!config.models || typeof config.models !== 'object') config.models = {};
  if (!config.models.providers || typeof config.models.providers !== 'object') config.models.providers = {};
  const configMerge = mergeProviderRuntimeCatalog(provider, config.models.providers[provider] || {}, modelIds);
  if (configMerge.changed) {
    config.models.providers[provider] = configMerge.nextProviderConfig;
    config.meta = { ...(config.meta && typeof config.meta === 'object' ? config.meta : {}), lastTouchedAt: new Date().toISOString() };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  }

  return {
    changed: modelsMerge.changed || configMerge.changed,
    addedModels: Array.from(new Set([...modelsMerge.addedModels, ...configMerge.addedModels])),
  };
}

function providerCatalogContainsModel(provider: string, providerConfig: any, modelId: string | null): boolean {
  if (!modelId || !providerConfig || typeof providerConfig !== 'object') return false;
  const target = normalizeProviderRuntimeModelId(provider, modelId);
  if (!target) return false;
  const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
  return models.some((entry: any) => {
    const rawId = typeof entry === 'string' ? entry : String(entry?.id || '').trim();
    return normalizeProviderRuntimeModelId(provider, rawId) === target;
  });
}

export function pinProviderAuthProfile(provider: string, profileId: string, mode?: 'api_key' | 'token' | 'oauth') {
  cleanupStaleProviderAuthProfiles(provider, profileId, mode);
}

export function getProviderStatuses(): ProviderStatus[] {
  const config = readOpenClawConfig();
  const authProfiles = readAuthProfiles();
  const modelsData = safeReadJson<any>(MODELS_JSON_PATH, { providers: {} });
  const configProfiles = config?.auth?.profiles ?? {};
  const storedProfiles = authProfiles?.profiles ?? {};
  const usageStats = authProfiles?.usageStats ?? {};
  const authOrder = config?.auth?.order ?? {};
  const defaultModel = getDefaultModel();
  const now = Date.now();

  return AI_PROVIDERS.map((provider) => {
    const providerAliases = provider.id === 'openai-codex'
      ? new Set(['openai-codex', 'codex', 'codex-cli', 'openai'])
      : getProviderAuthAliases(provider.id);
    const authOrderKeys = provider.id === 'openai-codex' ? ['openai', 'openai-codex'] : [provider.id];
    const profileMatchesProvider = (profileId: string, rawProfile: any): boolean => {
      const profileProvider = String(rawProfile?.provider || '').trim();
      const profileType = String(rawProfile?.type || rawProfile?.mode || '').trim();
      if (!providerAliases.has(profileProvider)) return false;
      if (provider.id === 'openai') return profileType === 'api_key';
      if (provider.id === 'openai-codex') {
        return profileType === 'oauth'
          || profileType === 'token'
          || profileId === CODEX_EXTERNAL_CLI_PROFILE_ID
          || profileId.startsWith('openai-codex:')
          || profileId.includes('codex');
      }
      return true;
    };
    const orderedProfileIds = uniqueOrder(authOrderKeys.flatMap((key) => Array.isArray(authOrder?.[key]) ? authOrder[key] : []));
    const findMatchingProfileId = (profiles: Record<string, any>) => (
      orderedProfileIds.find((profileId) => profileMatchesProvider(profileId, profiles[profileId]))
      || Object.keys(profiles).find((profileId) => profileMatchesProvider(profileId, profiles[profileId]))
      || null
    );
    const matchingConfigProfileId = findMatchingProfileId(configProfiles);
    const matchingStoredProfileId = findMatchingProfileId(storedProfiles);
    const hasRuntimeProviderConfig = Boolean(modelsData?.providers?.[provider.id]);
    const profileId = matchingConfigProfileId && matchingStoredProfileId && matchingConfigProfileId === matchingStoredProfileId
      ? matchingConfigProfileId
      : (matchingStoredProfileId || matchingConfigProfileId);

    const storedProfile = profileId ? storedProfiles[profileId] : undefined;
    const usage = profileId ? usageStats[profileId] : undefined;
    const expiresAt = storedProfile?.expires ?? null;
    const cooldownUntil = usage?.cooldownUntil ?? null;
    const lastUsed = usage?.lastUsed ?? null;
    const errorCount = usage?.errorCount ?? 0;
    const hasConfigProfile = Boolean(matchingConfigProfileId);
    const hasStoredProfile = Boolean(matchingStoredProfileId);
    const hasAnyProviderConfig = hasConfigProfile || (provider.authTypes.includes('api_key') && hasRuntimeProviderConfig);
    const regularProfileConfigured = Boolean(profileId && hasAnyProviderConfig && hasStoredProfile);
    const providerOrder = authOrderKeys.map((key) => authOrder?.[key]).find((value) => Array.isArray(value));
    const excludedByAuthOrder = Array.isArray(providerOrder) && providerOrder.length === 0;
    const currentModel = provider.id === 'anthropic'
      ? (defaultModel && defaultModel.startsWith('anthropic/') ? defaultModel : null)
      : provider.id === 'openai-codex'
        ? (defaultModel && (defaultModel.startsWith('codex/') || defaultModel.startsWith('openai-codex/') || defaultModel.startsWith('openai/')) ? defaultModel : null)
        : provider.id === 'google-antigravity'
          ? (defaultModel && (defaultModel.startsWith('google-antigravity/') || defaultModel.startsWith('google-gemini-cli/')) ? defaultModel : null)
          : (defaultModel && defaultModel.startsWith(`${provider.id}/`) ? defaultModel : null);

    let status: ProviderStatus['status'] = 'unconfigured';
    let error: string | null = null;
    let warning: string | null = null;
    let effectiveProfileId: string | null = null;
    let effectiveAuthType: string | null = null;
    const nativeProvider = getNativeProviderLinkedToOpenClawProvider(provider.id);
    const nativeAuth = nativeProvider ? getNativeCliAuthStatus(nativeProvider) : null;

    if (provider.primaryAuthType === 'native_cli') {
      if (nativeAuth?.status === 'authenticated') {
        status = 'configured';
        effectiveAuthType = 'cli';
      } else if (nativeAuth?.status === 'needs_login') {
        status = 'unconfigured';
      } else if (nativeAuth?.status === 'unknown') {
        status = 'error';
        error = nativeAuth.message;
      }
    } else if (regularProfileConfigured) {
      status = 'configured';
      effectiveProfileId = profileId;
      effectiveAuthType = storedProfile?.type || configProfiles[matchingConfigProfileId || '']?.mode || null;
      if (excludedByAuthOrder) {
        status = 'error';
        error = 'Provider is excluded by auth.order (empty provider order), so no credentials are eligible.';
      } else if (expiresAt && expiresAt <= now && !storedProfile?.refresh) {
        status = 'expired';
        error = 'Stored OAuth credentials expired.';
      } else if (expiresAt && expiresAt <= now && storedProfile?.refresh) {
        warning = 'Stored access token is expired, but a refresh token is present. The provider can usually refresh on next use.';
      } else if (cooldownUntil && cooldownUntil > now) {
        status = 'cooldown';
        error = 'Provider profile is cooling down after recent errors.';
      } else if (errorCount > 0) {
        status = 'error';
        error = `Provider has recorded ${errorCount} recent error${errorCount === 1 ? '' : 's'}.`;
      }

      if (provider.id !== 'anthropic' && nativeAuth?.status && !['authenticated', 'not_applicable'].includes(nativeAuth.status)) {
        warning = `${nativeAuth.message} OpenClaw can use this provider, but the portal's native ${nativeProvider} adapter still needs its own server-side auth.`;
      }

      if (
        status === 'configured'
        && PROVIDERS_REQUIRING_RUNTIME_MODEL_CATALOG.has(provider.id)
        && currentModel
        && currentModel.startsWith(`${provider.id}/`)
        && !providerCatalogContainsModel(provider.id, modelsData?.providers?.[provider.id], currentModel)
        && !providerCatalogContainsModel(provider.id, config?.models?.providers?.[provider.id], currentModel)
      ) {
        status = 'error';
        error = `OpenClaw model catalog is missing ${currentModel}. Re-run provider model registration before using Agent Chat.`;
      }
    } else if (hasAnyProviderConfig || hasStoredProfile) {
      status = 'error';
      error = hasAnyProviderConfig && !hasStoredProfile
        ? 'Provider configuration exists but credentials are missing from auth-profiles.json.'
        : 'Stored credentials exist in auth-profiles.json but provider config is missing.';
    }

    return {
      id: provider.id,
      status,
      authType: effectiveAuthType,
      profileId: effectiveProfileId,
      currentModel,
      isDefault: Boolean(currentModel),
      error,
      cooldownUntil,
      lastUsed,
      expiresAt,
      warning,
      nativeProvider,
      nativeCliAuthStatus: nativeAuth?.status || null,
      nativeCliAuthMessage: nativeAuth?.message || null,
      nativeCliLoginCommand: nativeAuth?.loginCommand || null,
      requiresSeparateNativeLogin: Boolean(nativeAuth?.requiresSeparateLogin),
    };
  });
}
