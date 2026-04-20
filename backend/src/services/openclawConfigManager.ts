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

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw');
export const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');
export const MODELS_JSON_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'models.json');

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

export function readOpenClawConfig(): any {
  repairClaudeSubscriptionConfig();
  return safeReadJson(CONFIG_PATH, {});
}

export function readAuthProfiles(): AuthProfilesFile {
  return safeReadJson<AuthProfilesFile>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
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
  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(authData, null, 2), 'utf8');

  const config = readOpenClawConfig();
  if (!config.auth) config.auth = {};
  if (!config.auth.profiles) config.auth.profiles = {};
  config.auth.profiles[profileId] = { provider, mode: authType };
  if (!config.auth.order) config.auth.order = {};
  config.auth.order[provider] = [profileId];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

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
    const matchingConfigProfileId = Object.keys(configProfiles).find((profileId) => configProfiles[profileId]?.provider === provider.id) || null;
    const matchingStoredProfileId = Object.keys(storedProfiles).find((profileId) => storedProfiles[profileId]?.provider === provider.id) || null;
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
    const providerOrder = authOrder?.[provider.id];
    const excludedByAuthOrder = Array.isArray(providerOrder) && providerOrder.length === 0;
    const currentModel = provider.id === 'anthropic'
      ? (defaultModel && defaultModel.startsWith('anthropic/') ? defaultModel : null)
      : (defaultModel && defaultModel.startsWith(`${provider.id}/`) ? defaultModel : null);

    let status: ProviderStatus['status'] = 'unconfigured';
    let error: string | null = null;
    let warning: string | null = null;
    let effectiveProfileId: string | null = null;
    let effectiveAuthType: string | null = null;
    const nativeProvider = getNativeProviderLinkedToOpenClawProvider(provider.id);
    const nativeAuth = nativeProvider ? getNativeCliAuthStatus(nativeProvider) : null;

    if (regularProfileConfigured) {
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

      if (provider.id !== 'anthropic' && nativeAuth?.status === 'needs_login') {
        warning = `${nativeAuth.message} OpenClaw can use this provider, but the portal's native ${nativeProvider} adapter still needs its own server-side auth.`;
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
