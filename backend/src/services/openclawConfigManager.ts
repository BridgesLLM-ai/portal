import fs from 'fs';
import path from 'path';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import {
  getNativeCliAuthStatus,
  getNativeProviderLinkedToOpenClawProvider,
  type NativeCliAuthState,
} from '../agents/nativeCliAuth';
import { AI_PROVIDERS } from '../config/aiProviders';

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw');
export const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');

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
  return safeReadJson(CONFIG_PATH, {});
}

export function readAuthProfiles(): AuthProfilesFile {
  return safeReadJson<AuthProfilesFile>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
}

export function getDefaultModel(): string | null {
  const config = readOpenClawConfig();
  return config?.agents?.defaults?.model?.primary || null;
}

export function getFallbackModels(): string[] {
  const config = readOpenClawConfig();
  const fallbacks = config?.agents?.defaults?.model?.fallbacks;
  return Array.isArray(fallbacks) ? fallbacks.filter((item: unknown): item is string => typeof item === 'string') : [];
}

const MODELS_JSON_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'models.json');

/**
 * Provider API endpoint configurations used by OpenClaw gateway.
 * When a user saves an API key, we write provider config to models.json
 * so the gateway can actually reach the provider's API.
 */
const PROVIDER_API_CONFIG: Record<string, { baseUrl: string; api: string }> = {
  'anthropic': { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
  'openrouter': { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-compatible' },
  'deepseek': { baseUrl: 'https://api.deepseek.com', api: 'openai-compatible' },
  'mistral': { baseUrl: 'https://api.mistral.ai/v1', api: 'openai-compatible' },
  'groq': { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-compatible' },
  'together': { baseUrl: 'https://api.together.xyz/v1', api: 'openai-compatible' },
  'xai': { baseUrl: 'https://api.x.ai/v1', api: 'openai-compatible' },
};

/**
 * Save an API key directly to both auth-profiles.json and models.json.
 * This bypasses the 'openclaw onboard' CLI which doesn't reliably persist
 * API keys for non-OAuth providers.
 */
export function saveProviderApiKey(provider: string, apiKey: string): { profileId: string } {
  // 1. Write to auth-profiles.json
  const authData = readAuthProfiles();
  const profileId = `${provider}:manual`;
  authData.profiles[profileId] = {
    type: 'token',
    provider,
    token: apiKey,
  };
  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(authData, null, 2), 'utf8');

  // 2. Write to openclaw.json auth.profiles
  const config = readOpenClawConfig();
  if (!config.auth) config.auth = {};
  if (!config.auth.profiles) config.auth.profiles = {};
  config.auth.profiles[profileId] = { provider, mode: 'token' };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

  // 3. Write to models.json (provider API config) if we know this provider
  const apiConfig = PROVIDER_API_CONFIG[provider];
  if (apiConfig) {
    const modelsData = safeReadJson<any>(MODELS_JSON_PATH, { providers: {} });
    if (!modelsData.providers) modelsData.providers = {};
    if (!modelsData.providers[provider]) {
      modelsData.providers[provider] = { ...apiConfig, apiKey, models: [] };
    } else {
      modelsData.providers[provider].apiKey = apiKey;
      modelsData.providers[provider].baseUrl = apiConfig.baseUrl;
      modelsData.providers[provider].api = apiConfig.api;
    }
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(modelsData, null, 2), 'utf8');
  }

  return { profileId };
}

export function getProviderStatuses(): ProviderStatus[] {
  const config = readOpenClawConfig();
  const authProfiles = readAuthProfiles();
  const configProfiles = config?.auth?.profiles ?? {};
  const storedProfiles = authProfiles?.profiles ?? {};
  const usageStats = authProfiles?.usageStats ?? {};
  const defaultModel = getDefaultModel();
  const now = Date.now();

  return AI_PROVIDERS.map((provider) => {
    const matchingConfigProfileId = Object.keys(configProfiles).find((profileId) => configProfiles[profileId]?.provider === provider.id) || null;
    const matchingStoredProfileId = Object.keys(storedProfiles).find((profileId) => storedProfiles[profileId]?.provider === provider.id) || null;
    const profileId = matchingConfigProfileId && matchingStoredProfileId && matchingConfigProfileId === matchingStoredProfileId
      ? matchingConfigProfileId
      : (matchingStoredProfileId || matchingConfigProfileId);

    const storedProfile = profileId ? storedProfiles[profileId] : undefined;
    const usage = profileId ? usageStats[profileId] : undefined;
    const expiresAt = storedProfile?.expires ?? null;
    const cooldownUntil = usage?.cooldownUntil ?? null;
    const lastUsed = usage?.lastUsed ?? null;
    const errorCount = usage?.errorCount ?? 0;
    const currentModel = defaultModel && defaultModel.startsWith(`${provider.id}/`) ? defaultModel : null;
    const hasConfigProfile = Boolean(matchingConfigProfileId);
    const hasStoredProfile = Boolean(matchingStoredProfileId);
    const isConfigured = Boolean(profileId && hasConfigProfile && hasStoredProfile);

    let status: ProviderStatus['status'] = 'unconfigured';
    let error: string | null = null;
    let warning: string | null = null;
    let effectiveProfileId: string | null = null;
    let effectiveAuthType: string | null = null;
    const nativeProvider = getNativeProviderLinkedToOpenClawProvider(provider.id);
    const nativeAuth = nativeProvider ? getNativeCliAuthStatus(nativeProvider) : null;

    if (isConfigured) {
      status = 'configured';
      effectiveProfileId = profileId;
      effectiveAuthType = storedProfile?.type || configProfiles[matchingConfigProfileId || '']?.mode || null;
      if (expiresAt && expiresAt <= now) {
        status = 'expired';
        error = 'Stored OAuth credentials expired.';
      } else if (cooldownUntil && cooldownUntil > now) {
        status = 'cooldown';
        error = 'Provider profile is cooling down after recent errors.';
      } else if (errorCount > 0) {
        status = 'error';
        error = `Provider has recorded ${errorCount} recent error${errorCount === 1 ? '' : 's'}.`;
      }

      if (nativeAuth?.status === 'needs_login') {
        warning = `${nativeAuth.message} OpenClaw can use this provider, but the portal's native ${nativeProvider} adapter still needs its own server-side auth.`;
      }
    } else if (hasConfigProfile || hasStoredProfile) {
      status = 'error';
      error = hasConfigProfile && !hasStoredProfile
        ? 'Provider configuration exists in openclaw.json but credentials are missing from auth-profiles.json.'
        : 'Stored credentials exist in auth-profiles.json but provider config is missing from openclaw.json.';
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


/**
 * Return environment variables that inject portal-configured API keys
 * for native CLI providers. This allows native CLIs to use portal-managed
 * credentials as a fallback when their own auth is not set up.
 *
 * Only injects keys that are NOT already in process.env to avoid overriding
 * explicit server-level configuration.
 */
export function getPortalApiKeysForEnv(providerName: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const modelsData = safeReadJson<any>(MODELS_JSON_PATH, { providers: {} });
    const providers = modelsData?.providers || {};

    // Map: native provider name -> { env var name, portal provider id }
    const mapping: Record<string, Array<{ envVar: string; portalProvider: string }>> = {
      CLAUDE_CODE: [{ envVar: 'ANTHROPIC_API_KEY', portalProvider: 'anthropic' }],
      CODEX: [{ envVar: 'OPENAI_API_KEY', portalProvider: 'openai-codex' }],
      GEMINI: [
        { envVar: 'GEMINI_API_KEY', portalProvider: 'google-gemini-cli' },
        { envVar: 'GOOGLE_API_KEY', portalProvider: 'google' },
      ],
    };

    const entries = mapping[providerName] || [];
    for (const { envVar, portalProvider } of entries) {
      // Don't override existing env vars
      if (process.env[envVar]) continue;
      const key = providers[portalProvider]?.apiKey;
      if (typeof key === 'string' && key.trim() && key !== 'None') {
        env[envVar] = key.trim();
      }
    }
  } catch {
    // Fail silently — if config can't be read, native CLIs use their own auth
  }
  return env;
}
