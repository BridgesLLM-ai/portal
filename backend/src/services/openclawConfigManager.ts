import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import {
  getNativeCliAuthStatus,
  getNativeProviderLinkedToOpenClawProvider,
  type NativeCliAuthState,
} from '../agents/nativeCliAuth';
import { AI_PROVIDERS } from '../config/aiProviders';
import { buildOpenClawCliEnv, extractJsonFromCliOutput, normalizePortalModelId, repairClaudeSubscriptionConfig } from '../utils/openclawCli';

const HOME_DIR = process.env.HOME || '/root';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME_DIR, '.openclaw');
export const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');
export const MODELS_JSON_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'models.json');
export const CODEX_EXTERNAL_CLI_PROFILE_ID = 'openai:codex-cli';
export const CODEX_CLI_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');
export const OPENCLAW_CODEX_HOME_AUTH_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'codex-home', 'auth.json');
export const OPENCLAW_CODEX_PLUGIN_VERSION = process.env.PORTAL_OPENCLAW_CODEX_PLUGIN_VERSION || '2026.7.1';
const LEGACY_PLUGIN_INSTALLS_PATH = path.join(OPENCLAW_HOME, 'plugins', 'installs.json');
const LEGACY_GLOBAL_CODEX_PLUGIN_DIR = path.join(OPENCLAW_HOME, 'npm', 'node_modules', '@openclaw', 'codex');
const OPENCLAW_SQLITE_PATH = path.join(OPENCLAW_HOME, 'state', 'openclaw.sqlite');
const OPENCLAW_AUTH_STORE_MANAGER = 'openclaw-auth-store';
const OPENCLAW_AUTH_STORE_CACHE_MS = 30_000;
let openClawAuthStoreProfilesCache: { expiresAt: number; profiles: Record<string, AuthProfile> } | null = null;

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

interface CodexPluginStateRepairResult {
  expectedVersion: string;
  removedLegacyInstallRecord: boolean;
  removedLegacyPluginEntries: number;
  quarantinedGlobalPluginDir: string | null;
  globalPluginVersion: string | null;
  sqliteRemoved: boolean;
  sqliteBackupPath: string | null;
  warnings: string[];
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
  const serializable: AuthProfilesFile = {
    ...authProfiles,
    profiles: Object.fromEntries(
      Object.entries(authProfiles.profiles || {}).filter(([, profile]) => profile?.managedBy !== OPENCLAW_AUTH_STORE_MANAGER),
    ),
  };
  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(serializable, null, 2), 'utf8');
}

function parseVersionParts(version: string): number[] {
  return String(version || '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function isOlderVersion(version: string | undefined, expectedVersion: string): boolean {
  const actualParts = parseVersionParts(version || '');
  const expectedParts = parseVersionParts(expectedVersion);
  if (actualParts.length === 0 || expectedParts.length === 0) return true;
  const length = Math.max(actualParts.length, expectedParts.length);
  for (let i = 0; i < length; i += 1) {
    const actual = actualParts[i] || 0;
    const expected = expectedParts[i] || 0;
    if (actual < expected) return true;
    if (actual > expected) return false;
  }
  return false;
}

function isLegacyGlobalCodexSource(source: unknown): boolean {
  const normalized = String(source || '').replace(/\\/g, '/');
  const openClawHome = OPENCLAW_HOME.replace(/\\/g, '/');
  return normalized.includes(`${openClawHome}/npm/node_modules/@openclaw/codex`)
    || normalized.includes('~/.openclaw/npm/node_modules/@openclaw/codex');
}

function shouldRemoveCodexInstallEntry(entry: any, expectedVersion: string): boolean {
  if (!entry || entry.pluginId !== 'codex') return false;
  return isOlderVersion(entry.packageVersion, expectedVersion) || isLegacyGlobalCodexSource(entry.source);
}

function timestampForBackup(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function uniqueBackupPath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  for (let index = 1; index < 100; index += 1) {
    const candidate = `${basePath}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${basePath}-${process.pid}`;
}

function sqlite3Available(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function repairCodexSqlitePluginIndex(expectedVersion: string, warnings: string[]): { removed: boolean; backupPath: string | null } {
  if (!fs.existsSync(OPENCLAW_SQLITE_PATH) || !sqlite3Available()) {
    return { removed: false, backupPath: null };
  }

  let rows = '';
  try {
    rows = execFileSync('sqlite3', [
      '-separator',
      '\t',
      OPENCLAW_SQLITE_PATH,
      `select coalesce(json_extract(value,'$.source'),''),
              coalesce(json_extract(value,'$.packageVersion'),'')
         from installed_plugin_index, json_each(plugins_json)
        where index_key='installed-plugin-index'
          and json_extract(value,'$.pluginId')='codex';`,
    ], { encoding: 'utf8' });
  } catch (error) {
    warnings.push(`Could not inspect OpenClaw SQLite plugin registry: ${error instanceof Error ? error.message : String(error)}`);
    return { removed: false, backupPath: null };
  }

  const staleRegistryEntry = rows
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      const [source, version] = line.split('\t');
      return isLegacyGlobalCodexSource(source) || isOlderVersion(version, expectedVersion);
    });

  if (!staleRegistryEntry) return { removed: false, backupPath: null };

  const backupPath = uniqueBackupPath(`${OPENCLAW_SQLITE_PATH}.bak-codex-plugin-${timestampForBackup()}`);
  try {
    execFileSync('sqlite3', [OPENCLAW_SQLITE_PATH, `.backup '${backupPath.replace(/'/g, "''")}'`], { stdio: 'ignore' });
    execFileSync('sqlite3', [
      OPENCLAW_SQLITE_PATH,
      `update installed_plugin_index
          set install_records_json = json_remove(install_records_json, '$.codex'),
              plugins_json = coalesce((
                select json_group_array(json(j.value))
                  from json_each(installed_plugin_index.plugins_json) as j
                 where json_extract(j.value,'$.pluginId') != 'codex'
              ), '[]'),
              refresh_reason = 'portal-remove-stale-codex-plugin',
              updated_at_ms = cast(strftime('%s','now') as integer) * 1000
        where index_key = 'installed-plugin-index';`,
    ], { stdio: 'ignore' });
    return { removed: true, backupPath };
  } catch (error) {
    warnings.push(`Could not repair OpenClaw SQLite plugin registry: ${error instanceof Error ? error.message : String(error)}`);
    return { removed: false, backupPath };
  }
}

export function repairOpenClawCodexPluginInstallState(expectedVersion = OPENCLAW_CODEX_PLUGIN_VERSION): CodexPluginStateRepairResult {
  const warnings: string[] = [];
  let removedLegacyInstallRecord = false;
  let removedLegacyPluginEntries = 0;
  let quarantinedGlobalPluginDir: string | null = null;
  let globalPluginVersion: string | null = null;

  const installs = safeReadJson<any>(LEGACY_PLUGIN_INSTALLS_PATH, null);
  if (installs && typeof installs === 'object') {
    if (installs.installRecords?.codex && shouldRemoveCodexInstallEntry({
      ...(installs.installRecords?.codex || {}),
      pluginId: 'codex',
    }, expectedVersion)) {
      delete installs.installRecords.codex;
      removedLegacyInstallRecord = true;
    }

    if (Array.isArray(installs.plugins)) {
      const nextPlugins = installs.plugins.filter((entry: any) => {
        const remove = shouldRemoveCodexInstallEntry(entry, expectedVersion);
        if (remove) removedLegacyPluginEntries += 1;
        return !remove;
      });
      installs.plugins = nextPlugins;
    }

    if (removedLegacyInstallRecord || removedLegacyPluginEntries > 0) {
      fs.mkdirSync(path.dirname(LEGACY_PLUGIN_INSTALLS_PATH), { recursive: true });
      fs.writeFileSync(LEGACY_PLUGIN_INSTALLS_PATH, JSON.stringify(installs, null, 2), 'utf8');
    }
  }

  if (fs.existsSync(LEGACY_GLOBAL_CODEX_PLUGIN_DIR)) {
    const pkg = safeReadJson<any>(path.join(LEGACY_GLOBAL_CODEX_PLUGIN_DIR, 'package.json'), {});
    globalPluginVersion = typeof pkg.version === 'string' ? pkg.version : null;
    if (isOlderVersion(globalPluginVersion || '', expectedVersion)) {
      const backupDir = path.join(
        OPENCLAW_HOME,
        'plugin-backups',
        `openclaw-codex-${globalPluginVersion || 'unknown'}-${timestampForBackup()}`,
      );
      const targetDir = uniqueBackupPath(backupDir);
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(LEGACY_GLOBAL_CODEX_PLUGIN_DIR, targetDir);
      quarantinedGlobalPluginDir = targetDir;
    }
  }

  const sqliteRepair = repairCodexSqlitePluginIndex(expectedVersion, warnings);

  return {
    expectedVersion,
    removedLegacyInstallRecord,
    removedLegacyPluginEntries,
    quarantinedGlobalPluginDir,
    globalPluginVersion,
    sqliteRemoved: sqliteRepair.removed,
    sqliteBackupPath: sqliteRepair.backupPath,
    warnings,
  };
}

export function readOpenClawConfig(): any {
  repairClaudeSubscriptionConfig();
  return safeReadJson(CONFIG_PATH, {});
}

function normalizeAuthStoreType(rawType: unknown): AuthProfile['type'] {
  const type = String(rawType || '').trim();
  if (type === 'api_key' || type === 'token' || type === 'oauth') return type;
  return 'oauth';
}

function parseAuthStoreExpires(rawExpires: unknown): number | undefined {
  if (typeof rawExpires === 'number' && Number.isFinite(rawExpires)) {
    return rawExpires < 10_000_000_000 ? rawExpires * 1000 : rawExpires;
  }
  if (typeof rawExpires === 'string' && rawExpires.trim()) {
    const parsed = Date.parse(rawExpires);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeOpenClawAuthStoreProfile(profileId: string, rawProfile: any): AuthProfile | null {
  const id = String(profileId || rawProfile?.id || rawProfile?.profileId || '').trim();
  if (!id) return null;
  const provider = String(rawProfile?.provider || id.split(':')[0] || '').trim();
  if (!provider) return null;

  const profile: AuthProfile = {
    type: normalizeAuthStoreType(rawProfile?.type || rawProfile?.mode || rawProfile?.authType),
    provider,
    managedBy: OPENCLAW_AUTH_STORE_MANAGER,
  };

  const expires = parseAuthStoreExpires(rawProfile?.expiresAt ?? rawProfile?.expires ?? rawProfile?.expiry);
  if (typeof expires === 'number') profile.expires = expires;
  if (typeof rawProfile?.email === 'string' && rawProfile.email.trim()) profile.email = rawProfile.email.trim();
  if (typeof rawProfile?.accountId === 'string' && rawProfile.accountId.trim()) profile.accountId = rawProfile.accountId.trim();

  return profile;
}

function readOpenClawAuthStoreProfiles(): Record<string, AuthProfile> {
  if (!process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE && process.env.NODE_ENV === 'test') {
    return {};
  }

  const now = Date.now();
  if (openClawAuthStoreProfilesCache && openClawAuthStoreProfilesCache.expiresAt > now) {
    return openClawAuthStoreProfilesCache.profiles;
  }

  try {
    const raw = execFileSync('openclaw', ['models', 'auth', 'list', '--json'], {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const parsed = JSON.parse(extractJsonFromCliOutput(raw));
    const profiles: Record<string, AuthProfile> = {};
    const entries: Array<[string, any]> = Array.isArray(parsed)
      ? parsed.map((entry: any) => [String(entry?.id || entry?.profileId || ''), entry])
      : Array.isArray(parsed?.profiles)
        ? parsed.profiles.map((entry: any) => [String(entry?.id || entry?.profileId || ''), entry])
        : (parsed?.profiles && typeof parsed.profiles === 'object')
          ? Object.entries(parsed.profiles)
          : [];

    for (const [profileId, rawProfile] of entries) {
      const id = String(profileId || rawProfile?.id || rawProfile?.profileId || '').trim();
      const normalized = normalizeOpenClawAuthStoreProfile(id, rawProfile);
      if (normalized && id) profiles[id] = normalized;
    }

    openClawAuthStoreProfilesCache = { expiresAt: now + OPENCLAW_AUTH_STORE_CACHE_MS, profiles };
    return profiles;
  } catch {
    if (openClawAuthStoreProfilesCache) return openClawAuthStoreProfilesCache.profiles;
    return {};
  }
}

export function readAuthProfiles(): AuthProfilesFile {
  const stored = safeReadJson<AuthProfilesFile>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
  const config = safeReadJson<any>(CONFIG_PATH, {});
  const configProfiles = normalizeAuthProfiles(config?.auth?.profiles);
  const storedProfiles = normalizeAuthProfiles(stored.profiles);
  const authStoreProfiles = readOpenClawAuthStoreProfiles();

  return {
    ...stored,
    version: stored.version || 2,
    profiles: {
      ...configProfiles,
      ...storedProfiles,
      ...authStoreProfiles,
    },
  };
}

export function getProviderAuthAliases(provider: string): Set<string> {
  const normalized = String(provider || '').trim();
  if (normalized === 'anthropic' || normalized === 'claude-cli') {
    return new Set(['anthropic', 'claude-cli']);
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

  // OpenClaw only resolves a profile credential when the config declaration's
  // provider matches the provider recorded on the stored credential. Claude CLI
  // oauth credentials are recorded with provider "claude-cli", so declaring the
  // profile as "anthropic" makes runtime resolution fail with "No credentials
  // found" even while a valid token exists. Follow the credential's own provider
  // whenever it is a known alias of the requested provider family.
  const declaredProvider = preferredProfile?.provider && aliases.has(preferredProfile.provider)
    ? preferredProfile.provider
    : provider;

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
    provider: declaredProvider,
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
const RUNTIME_ONLY_MODEL_PROVIDERS = new Set(Object.keys(PROVIDER_RUNTIME_CATALOG_CONFIG));

function getProviderRuntimeCatalogConfig(provider: string): ProviderRuntimeCatalogConfig | null {
  return PROVIDER_API_CONFIG[provider] || PROVIDER_RUNTIME_CATALOG_CONFIG[provider] || null;
}

function getProviderMeta(provider: string) {
  return AI_PROVIDERS.find((entry) => entry.id === provider) || null;
}

function isApiKeyProvider(provider: string): boolean {
  return Boolean(getProviderMeta(provider)?.authTypes.includes('api_key'));
}

function googleGeminiCliProfileHasUsableCredential(profile: any): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const type = String(profile.type || profile.mode || 'oauth').trim();
  if ((type === 'api_key' || type === 'token') && typeof profile.key === 'string' && profile.key.trim()) {
    return true;
  }
  if (type === 'oauth') {
    return typeof profile.access === 'string'
      && profile.access.trim().length > 0
      && typeof profile.refresh === 'string'
      && profile.refresh.trim().length > 0
      && typeof profile.expires === 'number'
      && Number.isFinite(profile.expires);
  }
  return false;
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

function isLegacyCodexProfile(profileId: string, rawProfile: any, keepProfileId: string): boolean {
  if (profileId === keepProfileId) return false;
  const provider = String(rawProfile?.provider || '').trim();
  const type = String(rawProfile?.type || rawProfile?.mode || '').trim();
  if (provider === 'openai' && type === 'api_key') return false;
  return provider === 'openai-codex'
    || provider === 'codex'
    || provider === 'codex-cli'
    || profileId.startsWith('openai-codex:')
    || profileId.startsWith('codex:')
    || profileId.includes(':codex')
    || profileId.includes('codex-cli');
}

function removeLegacyCodexProfiles(profiles: Record<string, any> | undefined, keepProfileId: string): string[] {
  if (!profiles || typeof profiles !== 'object') return [];
  const removed: string[] = [];
  for (const [profileId, rawProfile] of Object.entries(profiles)) {
    if (!isLegacyCodexProfile(profileId, rawProfile, keepProfileId)) continue;
    delete profiles[profileId];
    removed.push(profileId);
  }
  return removed;
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
  const removedStoredProfiles = removeLegacyCodexProfiles(authData.profiles, profileId);
  if (authData.usageStats) {
    for (const removedProfileId of removedStoredProfiles) delete authData.usageStats[removedProfileId];
  }
  if (authData.lastGood) {
    for (const [provider, lastGoodProfileId] of Object.entries(authData.lastGood)) {
      if (provider === 'openai-codex' || provider === 'codex' || removedStoredProfiles.includes(lastGoodProfileId)) {
        delete authData.lastGood[provider];
      }
    }
  }
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
  removeLegacyCodexProfiles(config.auth.profiles, profileId);

  config.auth.profiles[profileId] = {
    ...(config.auth.profiles[profileId] || {}),
    provider: 'openai',
    mode: 'oauth',
  };
  const currentOpenAiOrder = Array.isArray(config.auth.order.openai) ? config.auth.order.openai : [];
  config.auth.order.openai = uniqueOrder([
    profileId,
    ...currentOpenAiOrder.filter((candidate: unknown) => {
      const candidateId = String(candidate || '');
      return !isLegacyCodexProfile(candidateId, config.auth.profiles?.[candidateId], profileId);
    }),
  ]);
  delete config.auth.order.codex;
  delete config.auth.order['codex-cli'];
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

export function removeInvalidRuntimeOnlyModelProviderConfigs(config: any): { config: any; removedProviders: string[] } {
  const nextConfig = config && typeof config === 'object'
    ? JSON.parse(JSON.stringify(config))
    : {};
  const providers = nextConfig?.models?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return { config: nextConfig, removedProviders: [] };
  }

  const removedProviders: string[] = [];
  for (const provider of RUNTIME_ONLY_MODEL_PROVIDERS) {
    const providerConfig = providers[provider];
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) continue;
    const baseUrl = typeof providerConfig.baseUrl === 'string' ? providerConfig.baseUrl.trim() : '';
    const api = typeof providerConfig.api === 'string' ? providerConfig.api.trim() : '';
    if (baseUrl || api) continue;
    delete providers[provider];
    removedProviders.push(provider);
  }

  return { config: nextConfig, removedProviders };
}

export function cleanupInvalidRuntimeOnlyModelProvidersFromOpenClawConfig(): string[] {
  const current = readOpenClawConfig();
  const cleanup = removeInvalidRuntimeOnlyModelProviderConfigs(current);
  if (cleanup.removedProviders.length > 0) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleanup.config, null, 2), 'utf8');
  }
  return cleanup.removedProviders;
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
  if (RUNTIME_ONLY_MODEL_PROVIDERS.has(provider) && !runtimeConfig.baseUrl) {
    const cleanup = removeInvalidRuntimeOnlyModelProviderConfigs(config);
    if (cleanup.removedProviders.length > 0) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleanup.config, null, 2), 'utf8');
    }
    return {
      changed: modelsMerge.changed || cleanup.removedProviders.length > 0,
      addedModels: modelsMerge.addedModels,
    };
  }

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
    const isOpenClawAuthStoreProfile = storedProfile?.managedBy === OPENCLAW_AUTH_STORE_MANAGER;
    const usage = profileId ? usageStats[profileId] : undefined;
    const expiresAt = storedProfile?.expires ?? null;
    const cooldownUntil = usage?.cooldownUntil ?? null;
    const lastUsed = usage?.lastUsed ?? null;
    const errorCount = usage?.errorCount ?? 0;
    const hasConfigProfile = Boolean(matchingConfigProfileId);
    const hasOrderedProfile = Boolean(profileId && orderedProfileIds.includes(profileId));
    const hasStoredProfile = Boolean(matchingStoredProfileId);
    const hasAnyProviderConfig = hasConfigProfile || hasOrderedProfile || (provider.authTypes.includes('api_key') && hasRuntimeProviderConfig);
    const regularProfileConfigured = Boolean(profileId && hasAnyProviderConfig && hasStoredProfile);
    const providerOrder = authOrderKeys.map((key) => authOrder?.[key]).find((value) => Array.isArray(value));
    const excludedByAuthOrder = Array.isArray(providerOrder) && providerOrder.length === 0;
    const currentModel = provider.id === 'anthropic'
      ? (defaultModel && defaultModel.startsWith('anthropic/') ? defaultModel : null)
      : provider.id === 'openai-codex'
        ? (defaultModel && (defaultModel.startsWith('codex/') || defaultModel.startsWith('openai-codex/') || defaultModel.startsWith('openai/')) ? defaultModel : null)
        : provider.id === 'google-antigravity'
          ? (defaultModel && defaultModel.startsWith('google-antigravity/') ? defaultModel : null)
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
      } else if (provider.id === 'google-gemini-cli' && !isOpenClawAuthStoreProfile && !googleGeminiCliProfileHasUsableCredential(storedProfile)) {
        status = 'error';
        error = 'Google Gemini CLI profile exists, but it does not contain reusable credential material. Re-run sign-in or configure GEMINI_API_KEY/Application Default Credentials.';
      } else if (expiresAt && expiresAt <= now && !storedProfile?.refresh && !isOpenClawAuthStoreProfile) {
        status = 'expired';
        error = 'Stored OAuth credentials expired.';
      } else if (expiresAt && expiresAt <= now && (storedProfile?.refresh || isOpenClawAuthStoreProfile)) {
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

      if (status === 'configured' && provider.id === 'google-gemini-cli') {
        warning = warning || 'Gemini CLI OAuth is configured, but headless runtime auth can still fail. Run a smoke test before making it the default provider.';
      }
    } else if (hasAnyProviderConfig || hasStoredProfile) {
      status = 'error';
      error = hasAnyProviderConfig && !hasStoredProfile
        ? 'Provider configuration exists but credentials are missing from the OpenClaw auth store.'
        : 'Stored credentials exist in the OpenClaw auth store but provider config is missing.';
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
