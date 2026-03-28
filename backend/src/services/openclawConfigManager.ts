import fs from 'fs';
import path from 'path';
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
    let effectiveProfileId: string | null = null;
    let effectiveAuthType: string | null = null;

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
    };
  });
}
