import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { isDeepStrictEqual } from 'util';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import {
  getNativeCliAuthStatus,
  getNativeCliAuthStatusAsync,
  getNativeProviderLinkedToOpenClawProvider,
  type NativeCliAuthStatus,
  type NativeCliAuthState,
} from '../agents/nativeCliAuth';
import { AI_PROVIDERS } from '../config/aiProviders';
import { buildOpenClawCliEnv, extractJsonFromCliOutput, normalizePortalModelId, repairClaudeSubscriptionConfig } from '../utils/openclawCli';
import {
  createAmazonBedrockReadiness,
  getAmazonBedrockReadiness,
  type ProviderReadiness,
} from './amazonBedrockReadiness';

const HOME_DIR = process.env.HOME || '/root';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME_DIR, '.openclaw');
export const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');
export const MODELS_JSON_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'models.json');
export const CODEX_EXTERNAL_CLI_PROFILE_ID = 'openai:codex-cli';
export const CODEX_CLI_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');
export const OPENCLAW_CODEX_HOME_AUTH_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'codex-home', 'auth.json');
export const OPENCLAW_CODEX_PLUGIN_VERSION = process.env.PORTAL_OPENCLAW_CODEX_PLUGIN_VERSION || '2026.7.1-1';
const LEGACY_OPENCLAW_HOME = path.join(HOME_DIR, '.clawdbot');
const LEGACY_PLUGIN_INSTALLS_PATH = path.join(OPENCLAW_HOME, 'plugins', 'installs.json');
const LEGACY_GLOBAL_CODEX_PLUGIN_DIR = path.join(OPENCLAW_HOME, 'npm', 'node_modules', '@openclaw', 'codex');
const OPENCLAW_SQLITE_PATH = path.join(OPENCLAW_HOME, 'state', 'openclaw.sqlite');
const OPENCLAW_AUTH_STORE_MANAGER = 'openclaw-auth-store';
const OPENCLAW_AUTH_STORE_CACHE_MS = 30_000;
let openClawAuthStoreProfilesCache: { expiresAt: number; profiles: Record<string, AuthProfile> } | null = null;
let openClawAuthStoreProfilesCacheGeneration = 0;
const openClawAuthStoreProfilesRefreshes: Partial<Record<'strict' | 'lenient', {
  generation: number;
  promise: Promise<Record<string, AuthProfile>>;
}>> = {};

export function invalidateOpenClawAuthStoreProfilesCache(): void {
  openClawAuthStoreProfilesCache = null;
  openClawAuthStoreProfilesCacheGeneration += 1;
}

export interface AuthProfile {
  type: 'api_key' | 'token' | 'oauth' | 'unknown';
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

export interface OpenClawUpgradeStatePreparationResult {
  readyForGatewayStart: boolean;
  legacyStateAction: 'absent' | 'not-needed' | 'already-linked' | 'quarantined' | 'failed';
  legacyStateBackupPath: string | null;
  legacyPluginIndexAction: 'absent' | 'not-needed' | 'pruned' | 'quarantined-redundant' | 'quarantined-invalid' | 'failed';
  legacyPluginIndexBackupPath: string | null;
  removedPluginRecordIds: string[];
  retainedPluginRecordIds: string[];
  warnings: string[];
}

export interface OpenClawUpgradeStateRestoreResult {
  restored: boolean;
  legacyStateRestored: boolean;
  legacyPluginIndexRestored: boolean;
  warnings: string[];
}

export interface ProviderStatus {
  id: string;
  status: 'configured' | 'unconfigured' | 'error' | 'expired' | 'cooldown' | 'manual';
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
  readiness: ProviderReadiness | null;
}

interface ProviderStatusOptions {
  authStoreProfiles?: Record<string, AuthProfile>;
  authStoreError?: string | null;
  nativeAuthStatuses?: Partial<Record<AgentProviderName, NativeCliAuthStatus>>;
  providerReadiness?: Partial<Record<string, ProviderReadiness>>;
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

function resolvedPathsMatch(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBlockedObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validFileSignature(value: unknown): boolean {
  return isPlainRecord(value)
    && typeof value.size === 'number'
    && typeof value.mtimeMs === 'number'
    && (value.ctimeMs === undefined || typeof value.ctimeMs === 'number');
}

function validPersistedPlugin(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.startup)) return false;
  const startup = value.startup;
  if (
    typeof value.pluginId !== 'string'
    || typeof value.manifestPath !== 'string'
    || typeof value.manifestHash !== 'string'
    || typeof value.rootDir !== 'string'
    || typeof value.origin !== 'string'
    || typeof value.enabled !== 'boolean'
    || !strings(value.compat)
    || typeof startup.sidecar !== 'boolean'
    || typeof startup.memory !== 'boolean'
    || typeof startup.deferConfiguredChannelFullLoadUntilAfterListen !== 'boolean'
    || !strings(startup.agentHarnesses)
    || (startup.configPaths !== undefined && !strings(startup.configPaths))
  ) return false;

  for (const key of ['packageName', 'packageVersion', 'installRecordHash', 'format', 'bundleFormat', 'source', 'setupSource']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.installRecord !== undefined && !isPlainRecord(value.installRecord)) return false;
  if (value.enabledByDefault !== undefined && typeof value.enabledByDefault !== 'boolean') return false;
  if (value.enabledByDefaultOnPlatforms !== undefined && !strings(value.enabledByDefaultOnPlatforms)) return false;
  if (value.syntheticAuthRefs !== undefined && !strings(value.syntheticAuthRefs)) return false;
  if (value.manifestFile !== undefined && !validFileSignature(value.manifestFile)) return false;
  if (value.packageJson !== undefined) {
    if (!isPlainRecord(value.packageJson) || typeof value.packageJson.path !== 'string' || typeof value.packageJson.hash !== 'string') return false;
    if (value.packageJson.fileSignature !== undefined && !validFileSignature(value.packageJson.fileSignature)) return false;
  }
  if (value.contributions !== undefined) {
    if (!isPlainRecord(value.contributions)) return false;
    for (const key of [
      'channels', 'channelConfigs', 'providers', 'modelCatalogProviders', 'modelSupportPrefixes',
      'modelSupportPatterns', 'autoEnableProviderIds', 'commandAliases',
    ]) {
      if (!strings(value.contributions[key])) return false;
    }
    if (!isPlainRecord(value.contributions.contracts)) return false;
    if (!Object.values(value.contributions.contracts).every(strings)) return false;
  }
  return true;
}

function collectLegacyPluginInstallRecords(index: any): Record<string, any> | null {
  if (!isPlainRecord(index)) return null;

  // Match OpenClaw's precedence exactly: installRecords, then records, then
  // embedded plugin.installRecord entries. A malformed earlier container does
  // not silently fall through to a later one.
  let candidate: unknown = index.installRecords ?? index.records;
  if (candidate === undefined || candidate === null) {
    if (!Array.isArray(index.plugins)) return null;
    const embedded: Record<string, any> = Object.create(null);
    for (const plugin of index.plugins) {
      if (!isPlainRecord(plugin)) continue;
      const pluginId = typeof plugin.pluginId === 'string' ? plugin.pluginId.trim() : '';
      if (!pluginId || isBlockedObjectKey(pluginId) || !isPlainRecord(plugin.installRecord)) continue;
      embedded[pluginId] = plugin.installRecord;
    }
    if (Object.keys(embedded).length === 0) return null;
    candidate = embedded;
  }
  if (!isPlainRecord(candidate)) return null;

  const records: Record<string, any> = Object.create(null);
  for (const [pluginId, record] of Object.entries(candidate)) {
    if (!pluginId.trim() || isBlockedObjectKey(pluginId)) continue;
    if (!isPlainRecord(record)) return null;
    records[pluginId] = record;
  }
  return records;
}

function parseExactNpmIdentity(spec: unknown): { name: string; version: string } | null {
  const value = typeof spec === 'string' ? spec.trim() : '';
  if (!value) return null;
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return null;
  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!name || !/^\d{4}\.\d+\.\d+(?:[-+].*)?$/.test(version)) return null;
  return { name, version };
}

function resolvedNpmIdentity(record: any): { name: string; version: string } | null {
  const resolvedName = typeof record?.resolvedName === 'string' ? record.resolvedName.trim() : '';
  const resolvedVersion = typeof record?.resolvedVersion === 'string' ? record.resolvedVersion.trim() : '';
  if (resolvedName && resolvedVersion) return { name: resolvedName, version: resolvedVersion };
  return parseExactNpmIdentity(record?.resolvedSpec) || parseExactNpmIdentity(record?.spec);
}

function packageOnDiskMatches(record: any, identity: { name: string; version: string }): boolean {
  const installPath = typeof record?.installPath === 'string' ? record.installPath.trim() : '';
  if (!installPath) return false;
  const pkg = safeReadJson<any>(path.join(installPath, 'package.json'), null);
  return pkg?.name === identity.name && pkg?.version === identity.version;
}

function legacyPluginRecordIsCoveredByCurrent(current: any, legacy: any): boolean {
  const currentSource = typeof current?.source === 'string' ? current.source.trim() : '';
  const legacySource = typeof legacy?.source === 'string' ? legacy.source.trim() : '';
  if (!currentSource || currentSource !== legacySource || currentSource !== 'npm') return false;

  const currentIdentity = resolvedNpmIdentity(current);
  const legacyIdentity = resolvedNpmIdentity(legacy);
  if (!currentIdentity || !legacyIdentity) return false;
  if (currentIdentity.name !== legacyIdentity.name || currentIdentity.version !== legacyIdentity.version) return false;

  const legacyInstallPath = typeof legacy?.installPath === 'string' ? legacy.installPath.trim() : '';
  const currentInstallPath = typeof current?.installPath === 'string' ? current.installPath.trim() : '';
  if (legacyInstallPath && currentInstallPath && !resolvedPathsMatch(legacyInstallPath, currentInstallPath)) return false;

  if (!packageOnDiskMatches(current, currentIdentity)) return false;

  const retiredMetadata = new Set(['integrity', 'shasum', 'resolvedAt', 'installedAt', 'version']);
  for (const key of Object.keys(legacy).sort()) {
    if (isBlockedObjectKey(key)) return false;
    if (isDeepStrictEqual(current[key], legacy[key])) continue;
    if (key === 'spec') {
      const legacySpec = typeof legacy.spec === 'string' ? legacy.spec.trim() : '';
      const currentSpec = typeof current.spec === 'string' ? current.spec.trim() : '';
      if (legacySpec === legacyIdentity.name && currentSpec === `${currentIdentity.name}@${currentIdentity.version}`) continue;
      return false;
    }
    if (retiredMetadata.has(key) && current[key] === undefined) {
      if (key === 'version' && legacy[key] === legacyIdentity.version) continue;
      if ((key === 'resolvedAt' || key === 'installedAt') && typeof legacy[key] === 'string') continue;
      if (key === 'integrity' && typeof legacy[key] === 'string' && legacy[key].startsWith('sha')) continue;
      if (key === 'shasum' && typeof legacy[key] === 'string' && /^[a-f0-9]{40,128}$/i.test(legacy[key])) continue;
    }
    return false;
  }
  return true;
}

function pruneLegacyPluginInstallRecords(index: any, coveredRecordIds: Set<string>): string[] {
  const removed = new Set<string>();
  const topLevelKey = index.installRecords !== undefined && index.installRecords !== null
    ? 'installRecords'
    : (index.records !== undefined && index.records !== null ? 'records' : null);
  if (topLevelKey && isPlainRecord(index[topLevelKey])) {
    for (const pluginId of Object.keys(index[topLevelKey])) {
      if (!coveredRecordIds.has(pluginId)) continue;
      delete index[topLevelKey][pluginId];
      removed.add(pluginId);
    }
    return Array.from(removed).sort();
  }

  if (Array.isArray(index.plugins)) {
    for (const plugin of index.plugins) {
      if (!isPlainRecord(plugin)) continue;
      const pluginId = typeof plugin.pluginId === 'string' ? plugin.pluginId.trim() : '';
      if (!pluginId || !coveredRecordIds.has(pluginId) || !isPlainRecord(plugin.installRecord)) continue;
      delete plugin.installRecord;
      removed.add(pluginId);
    }
  }
  return Array.from(removed).sort();
}

function readPersistedPluginInstallRecords(): { available: boolean; records: Record<string, any>; warning?: string } {
  if (!fs.existsSync(OPENCLAW_SQLITE_PATH)) return { available: false, records: {} };

  let database: any = null;
  try {
    // OpenClaw 2026.7 uses Node's built-in SQLite store. Using the same runtime
    // keeps this repair available on customer boxes without sqlite3(1).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(OPENCLAW_SQLITE_PATH, { readOnly: true });
    const row = database.prepare(`
      select version, warning, host_contract_version, compat_registry_version,
             migration_version, policy_hash, generated_at_ms, refresh_reason,
             install_records_json, plugins_json, diagnostics_json
        from installed_plugin_index
       where index_key='installed-plugin-index'
    `).get();
    if (!row) return { available: false, records: {} };
    const installRecords = JSON.parse(row.install_records_json);
    const plugins = JSON.parse(row.plugins_json);
    const diagnostics = JSON.parse(row.diagnostics_json);
    const validDiagnostics = Array.isArray(diagnostics) && diagnostics.every((entry) => (
      isPlainRecord(entry)
      && (entry.level === 'warn' || entry.level === 'error')
      && typeof entry.message === 'string'
      && (entry.pluginId === undefined || typeof entry.pluginId === 'string')
      && (entry.source === undefined || typeof entry.source === 'string')
    ));
    const rowIsValid = Number(row.version) === 1
      && typeof row.host_contract_version === 'string' && row.host_contract_version.length > 0
      && typeof row.compat_registry_version === 'string' && row.compat_registry_version.length > 0
      && Number(row.migration_version) === 1
      && typeof row.policy_hash === 'string' && row.policy_hash.length > 0
      && Number.isFinite(Number(row.generated_at_ms))
      && (row.warning === null || typeof row.warning === 'string')
      && (row.refresh_reason === null || typeof row.refresh_reason === 'string')
      && isPlainRecord(installRecords)
      && Array.isArray(plugins) && plugins.every(validPersistedPlugin)
      && validDiagnostics;
    if (!rowIsValid) {
      return { available: false, records: {}, warning: 'OpenClaw SQLite plugin registry failed structural validation.' };
    }
    const safeRecords: Record<string, any> = Object.create(null);
    for (const [pluginId, record] of Object.entries(installRecords)) {
      if (isBlockedObjectKey(pluginId)) continue;
      if (!isPlainRecord(record)) {
        return { available: false, records: {}, warning: 'OpenClaw SQLite plugin registry contains an invalid install record.' };
      }
      safeRecords[pluginId] = record;
    }
    return { available: true, records: safeRecords };
  } catch (error) {
    // A missing table means this state has not adopted the SQLite registry yet;
    // normal OpenClaw migration should retain and import the JSON source.
    if (error instanceof Error && /no such table: installed_plugin_index/i.test(error.message)) {
      return { available: false, records: {} };
    }
    return {
      available: false,
      records: {},
      warning: `Could not inspect the OpenClaw SQLite plugin registry: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Read-only handle cleanup is best effort.
    }
  }
}

/**
 * Prepare long-lived OpenClaw installs for the strict 2026.7 startup migration
 * checkpoint. Preserve every legacy artifact while removing only warning
 * sources proven to be superseded by the authoritative current state.
 */
export function prepareOpenClawUpgradeState(): OpenClawUpgradeStatePreparationResult {
  const result: OpenClawUpgradeStatePreparationResult = {
    readyForGatewayStart: true,
    legacyStateAction: 'absent',
    legacyStateBackupPath: null,
    legacyPluginIndexAction: 'absent',
    legacyPluginIndexBackupPath: null,
    removedPluginRecordIds: [],
    retainedPluginRecordIds: [],
    warnings: [],
  };

  if (fs.existsSync(LEGACY_OPENCLAW_HOME)) {
    const legacyIsSymlink = fs.lstatSync(LEGACY_OPENCLAW_HOME).isSymbolicLink();
    if (!fs.existsSync(OPENCLAW_HOME)) {
      result.legacyStateAction = 'not-needed';
    } else if (resolvedPathsMatch(LEGACY_OPENCLAW_HOME, OPENCLAW_HOME)) {
      result.legacyStateAction = 'already-linked';
    } else if (legacyIsSymlink) {
      result.readyForGatewayStart = false;
      result.legacyStateAction = 'failed';
      result.warnings.push('Legacy .clawdbot is a symlink to a different path; it was left untouched for manual review.');
    } else if (process.env.PORTAL_OPENCLAW_STANDARD_STATE_CONFIRMED !== '1') {
      result.readyForGatewayStart = false;
      result.legacyStateAction = 'failed';
      result.warnings.push('Legacy .clawdbot state exists, but the active gateway state directory could not be proven to be the standard .openclaw path.');
    } else {
      const backupPath = uniqueBackupPath(`${LEGACY_OPENCLAW_HOME}.portal-backup-${timestampForBackup()}`);
      try {
        fs.renameSync(LEGACY_OPENCLAW_HOME, backupPath);
        result.legacyStateAction = 'quarantined';
        result.legacyStateBackupPath = backupPath;
      } catch (error) {
        result.readyForGatewayStart = false;
        result.legacyStateAction = 'failed';
        result.warnings.push(`Could not preserve the legacy OpenClaw state path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (!fs.existsSync(LEGACY_PLUGIN_INSTALLS_PATH)) return result;

  if (fs.lstatSync(LEGACY_PLUGIN_INSTALLS_PATH).isSymbolicLink()) {
    result.readyForGatewayStart = false;
    result.legacyPluginIndexAction = 'failed';
    result.warnings.push('Legacy OpenClaw plugin metadata is a symlink and was left untouched for manual review.');
    return result;
  }

  let legacyIndex: any;
  try {
    legacyIndex = JSON.parse(fs.readFileSync(LEGACY_PLUGIN_INSTALLS_PATH, 'utf8'));
    if (!legacyIndex || typeof legacyIndex !== 'object' || Array.isArray(legacyIndex)) {
      throw new Error('root value is not an object');
    }
  } catch (error) {
    // Invalid metadata may be the only record of an installed plugin. Do not
    // hide it merely to satisfy the stricter startup guard; abort the upgrade
    // and leave the old runtime/state exactly as found.
    result.readyForGatewayStart = false;
    result.legacyPluginIndexAction = 'failed';
    result.warnings.push(`Legacy OpenClaw plugin metadata is invalid and was left untouched: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  const legacyRecords = collectLegacyPluginInstallRecords(legacyIndex);
  if (!legacyRecords) {
    result.readyForGatewayStart = false;
    result.legacyPluginIndexAction = 'failed';
    result.warnings.push('Legacy OpenClaw plugin metadata has an unsupported structure and was left untouched.');
    return result;
  }
  const legacyRecordIds = Object.keys(legacyRecords).sort();
  const current = readPersistedPluginInstallRecords();
  if (current.warning) {
    result.readyForGatewayStart = false;
    result.legacyPluginIndexAction = 'failed';
    result.warnings.push(current.warning);
    result.retainedPluginRecordIds = legacyRecordIds;
    return result;
  }
  if (!current.available) {
    result.legacyPluginIndexAction = 'not-needed';
    result.retainedPluginRecordIds = legacyRecordIds;
    return result;
  }

  const overlappingIds = legacyRecordIds.filter((pluginId) => (
    Object.prototype.hasOwnProperty.call(current.records, pluginId)
  ));
  const coveredIds = new Set(overlappingIds.filter((pluginId) => (
    Object.prototype.hasOwnProperty.call(current.records, pluginId)
    && legacyPluginRecordIsCoveredByCurrent(current.records[pluginId], legacyRecords[pluginId])
  )));
  const unresolvedIds = overlappingIds.filter((pluginId) => !coveredIds.has(pluginId));
  if (unresolvedIds.length > 0) {
    result.readyForGatewayStart = false;
    result.legacyPluginIndexAction = 'failed';
    result.retainedPluginRecordIds = legacyRecordIds;
    result.warnings.push(`Legacy plugin metadata could not be proven redundant for: ${unresolvedIds.join(', ')}`);
    return result;
  }

  const removed = pruneLegacyPluginInstallRecords(legacyIndex, coveredIds);
  const retainedRecords = collectLegacyPluginInstallRecords(legacyIndex);
  const retained = retainedRecords ? Object.keys(retainedRecords).sort() : [];
  result.removedPluginRecordIds = removed;
  result.retainedPluginRecordIds = retained;
  if (removed.length === 0) {
    result.legacyPluginIndexAction = 'not-needed';
    return result;
  }

  const backupPath = uniqueBackupPath(`${LEGACY_PLUGIN_INSTALLS_PATH}.portal-backup-${timestampForBackup()}`);
  try {
    if (retained.length === 0) {
      fs.renameSync(LEGACY_PLUGIN_INSTALLS_PATH, backupPath);
      result.legacyPluginIndexAction = 'quarantined-redundant';
    } else {
      const sourceMode = fs.statSync(LEGACY_PLUGIN_INSTALLS_PATH).mode & 0o777;
      fs.copyFileSync(LEGACY_PLUGIN_INSTALLS_PATH, backupPath);
      fs.chmodSync(backupPath, sourceMode);
      const temporaryPath = uniqueBackupPath(`${LEGACY_PLUGIN_INSTALLS_PATH}.portal-write-${process.pid}`);
      try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(legacyIndex, null, 2)}\n`, { mode: sourceMode });
        fs.renameSync(temporaryPath, LEGACY_PLUGIN_INSTALLS_PATH);
      } finally {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      }
      result.legacyPluginIndexAction = 'pruned';
    }
    result.legacyPluginIndexBackupPath = backupPath;
  } catch (error) {
    result.readyForGatewayStart = false;
    result.legacyPluginIndexAction = 'failed';
    result.warnings.push(`Could not reconcile the legacy OpenClaw plugin index: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/** Restore artifacts moved or pruned by prepareOpenClawUpgradeState(). */
export function restoreOpenClawUpgradeState(
  preparation: OpenClawUpgradeStatePreparationResult,
): OpenClawUpgradeStateRestoreResult {
  const result: OpenClawUpgradeStateRestoreResult = {
    restored: true,
    legacyStateRestored: false,
    legacyPluginIndexRestored: false,
    warnings: [],
  };

  if (preparation.legacyStateAction === 'quarantined' && preparation.legacyStateBackupPath) {
    const backupPath = preparation.legacyStateBackupPath;
    const expectedPrefix = `${LEGACY_OPENCLAW_HOME}.portal-backup-`;
    if (!backupPath.startsWith(expectedPrefix)) {
      result.restored = false;
      result.warnings.push('Refused to restore a legacy-state backup from an unexpected path.');
    } else if (!fs.existsSync(backupPath)) {
      result.restored = false;
      result.warnings.push(`Legacy-state backup is missing: ${backupPath}`);
    } else if (fs.existsSync(LEGACY_OPENCLAW_HOME)) {
      result.restored = false;
      result.warnings.push(`Could not restore ${LEGACY_OPENCLAW_HOME} because the path now exists.`);
    } else {
      try {
        fs.renameSync(backupPath, LEGACY_OPENCLAW_HOME);
        result.legacyStateRestored = true;
      } catch (error) {
        result.restored = false;
        result.warnings.push(`Could not restore the legacy OpenClaw state path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (
    (preparation.legacyPluginIndexAction === 'pruned'
      || preparation.legacyPluginIndexAction === 'quarantined-redundant')
    && preparation.legacyPluginIndexBackupPath
  ) {
    const backupPath = preparation.legacyPluginIndexBackupPath;
    const expectedPrefix = `${LEGACY_PLUGIN_INSTALLS_PATH}.portal-backup-`;
    if (!backupPath.startsWith(expectedPrefix)) {
      result.restored = false;
      result.warnings.push('Refused to restore a legacy plugin-index backup from an unexpected path.');
    } else if (!fs.existsSync(backupPath)) {
      result.restored = false;
      result.warnings.push(`Legacy plugin-index backup is missing: ${backupPath}`);
    } else {
      try {
        fs.mkdirSync(path.dirname(LEGACY_PLUGIN_INSTALLS_PATH), { recursive: true });
        const sourceMode = fs.statSync(backupPath).mode & 0o777;
        const temporaryPath = uniqueBackupPath(`${LEGACY_PLUGIN_INSTALLS_PATH}.portal-restore-${process.pid}`);
        fs.copyFileSync(backupPath, temporaryPath);
        fs.chmodSync(temporaryPath, sourceMode);
        let diagnosticPath: string | null = null;
        if (fs.existsSync(LEGACY_PLUGIN_INSTALLS_PATH)) {
          diagnosticPath = uniqueBackupPath(`${LEGACY_PLUGIN_INSTALLS_PATH}.failed-upgrade-${timestampForBackup()}`);
          fs.renameSync(LEGACY_PLUGIN_INSTALLS_PATH, diagnosticPath);
        }
        try {
          fs.renameSync(temporaryPath, LEGACY_PLUGIN_INSTALLS_PATH);
        } catch (error) {
          if (diagnosticPath && fs.existsSync(diagnosticPath) && !fs.existsSync(LEGACY_PLUGIN_INSTALLS_PATH)) {
            fs.renameSync(diagnosticPath, LEGACY_PLUGIN_INSTALLS_PATH);
          }
          throw error;
        } finally {
          if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        }
        result.legacyPluginIndexRestored = true;
      } catch (error) {
        result.restored = false;
        result.warnings.push(`Could not restore the legacy OpenClaw plugin index: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return result;
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
  // Never promote a new, missing, or malformed OpenClaw credential type to
  // OAuth. Destructive callers may only admit an explicitly attested OAuth
  // profile; preserving "unknown" lets those callers fail closed.
  return 'unknown';
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
  const provider = String(rawProfile?.provider || id.split(':')[0] || '').trim().toLowerCase();
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

export function parseOpenClawAuthStoreProfiles(raw: string): Record<string, AuthProfile> {
  const parsed = JSON.parse(extractJsonFromCliOutput(raw));
  const profiles: Record<string, AuthProfile> = {};
  let entries: Array<[string, unknown]>;
  const arrayEntries = (rows: unknown[]): Array<[string, unknown]> => rows.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`OpenClaw auth-store profile ${index} is not an object`);
    }
    const rawId = entry.id ?? entry.profileId;
    if (typeof rawId !== 'string' || !rawId.trim()) {
      throw new Error(`OpenClaw auth-store profile ${index} has no valid id`);
    }
    return [rawId.trim(), entry];
  });

  if (Array.isArray(parsed)) {
    entries = arrayEntries(parsed);
  } else {
    if (!isPlainRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'profiles')) {
      throw new Error('OpenClaw auth-store inventory has an unsupported root shape');
    }
    if (Array.isArray(parsed.profiles)) {
      entries = arrayEntries(parsed.profiles);
    } else if (isPlainRecord(parsed.profiles)) {
      entries = Object.entries(parsed.profiles);
    } else {
      throw new Error('OpenClaw auth-store inventory profiles is not an array or object');
    }
  }

  for (const [profileId, rawProfile] of entries) {
    if (!isPlainRecord(rawProfile)) {
      throw new Error(`OpenClaw auth-store profile ${profileId || '<unknown>'} is not an object`);
    }
    const id = profileId.trim();
    if (!id || isBlockedObjectKey(id)) {
      throw new Error('OpenClaw auth-store profile has an invalid id');
    }
    for (const field of ['id', 'profileId'] as const) {
      if (!Object.prototype.hasOwnProperty.call(rawProfile, field)) continue;
      if (typeof rawProfile[field] !== 'string' || rawProfile[field].trim() !== id) {
        throw new Error(`OpenClaw auth-store profile ${id} has a conflicting ${field}`);
      }
    }
    if (typeof rawProfile.provider !== 'string' || !rawProfile.provider.trim()) {
      throw new Error(`OpenClaw auth-store profile ${id} has no valid provider`);
    }
    const credentialTypes = (['type', 'mode', 'authType'] as const)
      .filter((field) => Object.prototype.hasOwnProperty.call(rawProfile, field))
      .map((field) => rawProfile[field]);
    if (credentialTypes.some((credentialType) => (
      typeof credentialType !== 'string' || !credentialType.trim()
    ))) {
      throw new Error(`OpenClaw auth-store profile ${id} has a malformed credential type`);
    }
    if (new Set(credentialTypes.map((credentialType) => credentialType.trim())).size > 1) {
      throw new Error(`OpenClaw auth-store profile ${id} has conflicting credential types`);
    }
    if (Object.prototype.hasOwnProperty.call(profiles, id)) {
      throw new Error(`OpenClaw auth-store profile id ${id} is duplicated`);
    }
    const normalized = normalizeOpenClawAuthStoreProfile(id, rawProfile);
    if (!normalized) throw new Error(`OpenClaw auth-store profile ${id} could not be normalized`);
    profiles[id] = normalized;
  }

  return profiles;
}

function buildOpenClawAuthListArgs(provider?: string): string[] {
  const normalizedProvider = String(provider || '').trim();
  const args = ['models', 'auth', '--agent', 'main', 'list'];
  if (normalizedProvider) args.push('--provider', normalizedProvider);
  args.push('--json');
  return args;
}

export function readOpenClawAuthStoreProfiles(
  provider?: string,
  options?: { strict?: boolean },
): Record<string, AuthProfile> {
  if (!process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE && process.env.NODE_ENV === 'test') {
    return {};
  }

  const now = Date.now();
  const normalizedProvider = String(provider || '').trim();
  if (!options?.strict && !normalizedProvider && openClawAuthStoreProfilesCache && openClawAuthStoreProfilesCache.expiresAt > now) {
    return openClawAuthStoreProfilesCache.profiles;
  }

  try {
    const raw = execFileSync('openclaw', buildOpenClawAuthListArgs(normalizedProvider), {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const profiles = parseOpenClawAuthStoreProfiles(raw);

    if (!normalizedProvider) {
      openClawAuthStoreProfilesCache = { expiresAt: now + OPENCLAW_AUTH_STORE_CACHE_MS, profiles };
    }
    return profiles;
  } catch {
    if (options?.strict) {
      throw new Error(`OpenClaw could not verify ${normalizedProvider || 'the'} saved authentication profiles.`);
    }
    if (!normalizedProvider && openClawAuthStoreProfilesCache) return openClawAuthStoreProfilesCache.profiles;
    return {};
  }
}

export async function readOpenClawAuthStoreProfilesAsync(
  provider?: string,
  options?: { strict?: boolean },
): Promise<Record<string, AuthProfile>> {
  if (!process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE && process.env.NODE_ENV === 'test') {
    return {};
  }

  const normalizedProvider = String(provider || '').trim();
  const now = Date.now();
  if (!options?.strict && !normalizedProvider && openClawAuthStoreProfilesCache && openClawAuthStoreProfilesCache.expiresAt > now) {
    return openClawAuthStoreProfilesCache.profiles;
  }

  const generation = openClawAuthStoreProfilesCacheGeneration;
  const refreshKind = options?.strict ? 'strict' : 'lenient';
  const existingRefresh = openClawAuthStoreProfilesRefreshes[refreshKind];
  if (
    !normalizedProvider
    && existingRefresh
    && existingRefresh.generation === generation
  ) {
    return existingRefresh.promise;
  }

  const execute = new Promise<Record<string, AuthProfile>>((resolve, reject) => {
    execFile('openclaw', buildOpenClawAuthListArgs(normalizedProvider), {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parseOpenClawAuthStoreProfiles(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  }).then((profiles) => {
    if (!normalizedProvider && openClawAuthStoreProfilesCacheGeneration === generation) {
      openClawAuthStoreProfilesCache = {
        expiresAt: Date.now() + OPENCLAW_AUTH_STORE_CACHE_MS,
        profiles,
      };
    }
    return profiles;
  }).catch(() => {
    if (options?.strict) {
      throw new Error(`OpenClaw could not verify ${normalizedProvider || 'the'} saved authentication profiles.`);
    }
    if (!normalizedProvider && openClawAuthStoreProfilesCache) {
      return openClawAuthStoreProfilesCache.profiles;
    }
    return {};
  });

  if (!normalizedProvider) {
    openClawAuthStoreProfilesRefreshes[refreshKind] = { generation, promise: execute };
    const clearRefresh = () => {
      if (openClawAuthStoreProfilesRefreshes[refreshKind]?.promise === execute) {
        delete openClawAuthStoreProfilesRefreshes[refreshKind];
      }
    };
    void execute.then(clearRefresh, clearRefresh);
  }

  return execute;
}

function readAuthProfilesWithAuthStore(authStoreProfiles: Record<string, AuthProfile>): AuthProfilesFile {
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
      ...authStoreProfiles,
    },
  };
}

export function readAuthProfiles(): AuthProfilesFile {
  return readAuthProfilesWithAuthStore(readOpenClawAuthStoreProfiles());
}

/**
 * Read the merged authentication inventory only when OpenClaw's authoritative
 * store can be attested. Destructive/cancellation paths must use this variant:
 * the ordinary reader intentionally tolerates a temporarily unavailable CLI,
 * which is useful for status pages but is not proof that a credential is
 * absent.
 */
export function readAuthProfilesStrict(): AuthProfilesFile {
  return readAuthProfilesWithAuthStore(readOpenClawAuthStoreProfiles(undefined, { strict: true }));
}

/**
 * Async counterpart to readAuthProfilesStrict for request/background paths.
 * Destructive lifecycle convergence must not run OpenClaw's bounded CLI probe
 * through execFileSync because a control-plane outage would stall Express's
 * event loop for the full command timeout.
 */
export async function readAuthProfilesStrictAsync(): Promise<AuthProfilesFile> {
  return readAuthProfilesWithAuthStore(
    await readOpenClawAuthStoreProfilesAsync(undefined, { strict: true }),
  );
}

export function getProviderAuthAliases(provider: string): Set<string> {
  const normalized = String(provider || '').trim();
  if (normalized === 'anthropic' || normalized === 'claude-cli') {
    return new Set(['anthropic', 'claude-cli']);
  }
  return new Set([normalized]);
}

export function getStaleProviderProfileIds(
  profiles: Record<string, (Pick<AuthProfile, 'provider'> & Partial<Pick<AuthProfile, 'type'>>) | undefined>,
  provider: string,
  preferredProfileId: string,
  preferredMode?: 'api_key' | 'token' | 'oauth',
): string[] {
  const aliases = getProviderAuthAliases(provider);
  return Object.keys(profiles || {}).filter((profileId) => {
    if (profileId === preferredProfileId) return false;
    const profile = profiles?.[profileId];
    const profileProvider = profile?.provider;
    if (typeof profileProvider !== 'string' || !aliases.has(profileProvider)) return false;
    // xAI supports two materially different transports under the same provider:
    // subscription OAuth and public API-key billing. Replacing one must not
    // destroy the other credential path.
    if (provider === 'xai' && preferredMode && profile?.type && profile.type !== preferredMode) return false;
    return true;
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
  const removedProfileIds = getStaleProviderProfileIds(authProfiles.profiles, provider, preferredProfileId, mode);

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
    const preserveAlternateXaiMode = provider === 'xai'
      && mode
      && String(profile?.mode || profile?.type || '').trim()
      && String(profile?.mode || profile?.type || '').trim() !== mode;
    if (profileId !== preferredProfileId && aliases.has(profile?.provider) && !preserveAlternateXaiMode) {
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
  if (provider !== 'xai') {
    config.auth.order[provider] = [preferredProfileId];
  }

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
};

const PROVIDER_RUNTIME_CATALOG_CONFIG: Record<string, ProviderRuntimeCatalogConfig> = {
  // OpenClaw's Google CLI OAuth backends are local/runtime-managed. They still need
  // a model catalog entry, but API/baseUrl fields would make it a custom HTTP provider.
  'google-gemini-cli': {},
  'google-antigravity': {},
};

const PROVIDERS_REQUIRING_RUNTIME_MODEL_CATALOG = new Set(['google-gemini-cli']);
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
  if (provider === 'xai') {
    return saveProviderApiKeyToOpenClawAuthStore(provider, apiKey);
  }
  const authType = isApiKeyProvider(provider) ? 'api_key' : 'token';
  const profileId = `${provider}:default`;
  writeProviderSecret({ provider, profileId, authType, secret: apiKey });
  return { profileId };
}

export type ProviderApiKeyCommitState = 'committed' | 'absent' | 'indeterminate';

/**
 * Carries the only safe conclusion Portal can make after OpenClaw's credential
 * control plane throws.  In particular, the presence of a fixed profile id is
 * not proof that a rotated key was written when that profile existed before
 * the attempt.
 */
export class ProviderApiKeySaveError extends Error {
  readonly credentialState: ProviderApiKeyCommitState;
  readonly profileId: string;

  constructor(message: string, credentialState: ProviderApiKeyCommitState, profileId: string) {
    super(message);
    this.name = 'ProviderApiKeySaveError';
    this.credentialState = credentialState;
    this.profileId = profileId;
  }
}

/**
 * Bundled providers use OpenClaw's locked, per-agent SQLite auth store. Keep
 * credentials off argv/process listings by piping the value to the supported
 * CLI, then prove that the committed profile is visible through the same
 * control plane the gateway reads.
 */
export function saveProviderApiKeyToOpenClawAuthStore(
  provider: string,
  apiKey: string,
  profileId = `${provider}:portal-api-key`,
): { profileId: string } {
  const normalizedProvider = String(provider || '').trim();
  const normalizedProfileId = String(profileId || '').trim();
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedProvider || !normalizedProfileId || !normalizedKey) {
    throw new Error('Provider, profile id, and API key are required.');
  }

  let profileExistedBefore = false;
  try {
    invalidateOpenClawAuthStoreProfilesCache();
    const existing = readOpenClawAuthStoreProfiles(normalizedProvider, { strict: true })[normalizedProfileId];
    profileExistedBefore = existing?.provider === normalizedProvider && existing.type === 'api_key';
  } catch (error: any) {
    throw new ProviderApiKeySaveError(
      `OpenClaw credential preflight failed before the ${normalizedProvider} API key was changed: ${error?.message || 'auth store unavailable'}`,
      'indeterminate',
      normalizedProfileId,
    );
  }

  try {
    execFileSync('openclaw', [
      'models',
      'auth',
      '--agent',
      'main',
      'paste-api-key',
      '--provider',
      normalizedProvider,
      '--profile-id',
      normalizedProfileId,
    ], {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      input: `${normalizedKey}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error: any) {
    const stderr = typeof error?.stderr === 'string'
      ? error.stderr
      : error?.stderr?.toString?.('utf8') || '';
    const safeMessage = stderr
      .split(normalizedKey).join('[REDACTED]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    let credentialState: ProviderApiKeyCommitState = profileExistedBefore ? 'indeterminate' : 'absent';
    if (!profileExistedBefore) {
      try {
        invalidateOpenClawAuthStoreProfilesCache();
        const afterFailure = readOpenClawAuthStoreProfiles(normalizedProvider, { strict: true })[normalizedProfileId];
        if (afterFailure?.provider === normalizedProvider && afterFailure.type === 'api_key') {
          credentialState = 'committed';
        }
      } catch {
        credentialState = 'indeterminate';
      }
    }
    throw new ProviderApiKeySaveError(
      safeMessage || `OpenClaw failed to save the ${normalizedProvider} API key.`,
      credentialState,
      normalizedProfileId,
    );
  }

  let stored: any;
  try {
    invalidateOpenClawAuthStoreProfilesCache();
    stored = readOpenClawAuthStoreProfiles(normalizedProvider, { strict: true })[normalizedProfileId];
  } catch (error: any) {
    throw new ProviderApiKeySaveError(
      `OpenClaw accepted the ${normalizedProvider} API key, but Portal could not verify the saved profile: ${error?.message || 'auth store unavailable'}`,
      'indeterminate',
      normalizedProfileId,
    );
  }
  if (!stored || stored.provider !== normalizedProvider || stored.type !== 'api_key') {
    throw new ProviderApiKeySaveError(
      `OpenClaw did not confirm the ${normalizedProvider} API-key profile after saving it.`,
      'indeterminate',
      normalizedProfileId,
    );
  }

  try {
    clearProviderAuthOrder(normalizedProvider);
  } catch (error: any) {
    throw new ProviderApiKeySaveError(
      `The ${normalizedProvider} API key was saved, but authentication routing cleanup failed: ${error?.message || 'unknown error'}`,
      'committed',
      normalizedProfileId,
    );
  }

  return { profileId: normalizedProfileId };
}

/**
 * Remove explicit auth ordering from both OpenClaw's locked auth store and the
 * JSON compatibility layer. An explicit order is an allowlist, so keeping only
 * the latest xAI profile would silently disable the alternate OAuth/API-key
 * credential path.
 */
export function clearProviderAuthOrder(provider: string): void {
  const normalizedProvider = String(provider || '').trim();
  if (!normalizedProvider) throw new Error('Provider is required to clear authentication order.');

  try {
    const orderOutput = execFileSync('openclaw', [
      'models',
      'auth',
      '--agent',
      'main',
      'order',
      'get',
      '--provider',
      normalizedProvider,
      '--json',
    ], {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const currentOrder = JSON.parse(extractJsonFromCliOutput(orderOutput))?.order;
    // OpenClaw 2026.7.1 treats clearing an absent order as an error instead of
    // an idempotent no-op. Only issue the mutation when an override exists.
    if (Array.isArray(currentOrder) && currentOrder.length > 0) {
      execFileSync('openclaw', [
        'models',
        'auth',
        '--agent',
        'main',
        'order',
        'clear',
        '--provider',
        normalizedProvider,
      ], {
        encoding: 'utf8',
        env: buildOpenClawCliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    }
  } catch {
    throw new Error(`OpenClaw could not clear the ${normalizedProvider} authentication order.`);
  }

  const readConfigOrderStrict = (): Record<string, unknown> => {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      throw new Error('OpenClaw configuration is unreadable; authentication order was not changed.');
    }
    const order = config?.auth?.order;
    if (order === undefined) return {};
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error('OpenClaw authentication order is malformed; it was not changed.');
    }
    return order;
  };
  if (!(normalizedProvider in readConfigOrderStrict())) return;

  // Use OpenClaw's base-hash-checked config writer. A direct read/rename here
  // can overwrite an unrelated gateway or CLI update that lands in between.
  const configPath = `auth.order[${JSON.stringify(normalizedProvider)}]`;
  try {
    execFileSync('openclaw', ['config', 'unset', configPath], {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    if (!(normalizedProvider in readConfigOrderStrict())) return;
    throw new Error(`OpenClaw could not clear the ${normalizedProvider} configuration auth order without overwriting a concurrent change.`);
  }
  if (normalizedProvider in readConfigOrderStrict()) {
    throw new Error(`OpenClaw did not confirm removal of the ${normalizedProvider} configuration auth order.`);
  }
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
  if (provider === 'google-gemini-cli' && raw.startsWith('google/')) {
    return raw.slice('google/'.length);
  }
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

export function registerProviderRuntimeModels(
  provider: string,
  modelIds: string[],
  options?: { preserveProviderTransport?: boolean },
): { changed: boolean; addedModels: string[] } {
  // Subscription-backed provider plugins can select a different endpoint from
  // their API-key transport. Their runtime catalog is plugin-owned and must not
  // be rewritten with Portal's public API defaults after OAuth completes.
  if (options?.preserveProviderTransport) return { changed: false, addedModels: [] };

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

export function getProviderStatuses(options: ProviderStatusOptions = {}): ProviderStatus[] {
  const config = readOpenClawConfig();
  const hasInjectedAuthStore = Object.prototype.hasOwnProperty.call(options, 'authStoreProfiles');
  let authStoreProfiles: Record<string, AuthProfile> = options.authStoreProfiles || {};
  let xaiAuthStoreError: string | null = options.authStoreError || null;
  if (!hasInjectedAuthStore) {
    try {
      authStoreProfiles = readOpenClawAuthStoreProfiles(undefined, { strict: true });
    } catch (error: any) {
      authStoreProfiles = {};
      xaiAuthStoreError = error?.message || 'OpenClaw xAI auth store is unavailable.';
    }
  }
  const authProfiles = readAuthProfilesWithAuthStore(authStoreProfiles);
  const modelsData = safeReadJson<any>(MODELS_JSON_PATH, { providers: {} });
  const configProfiles = config?.auth?.profiles ?? {};
  const storedProfiles = { ...(authProfiles?.profiles ?? {}) };
  // xAI credentials are authoritative only in OpenClaw's locked store. Remove
  // legacy/config shadows, then merge a strict provider-scoped read so a
  // control-plane outage cannot masquerade as a clean disconnect.
  for (const [profileId, profile] of Object.entries<any>(storedProfiles)) {
    if (profile?.provider === 'xai') delete storedProfiles[profileId];
  }
  for (const [profileId, profile] of Object.entries(authStoreProfiles)) {
    if (profile?.provider === 'xai') storedProfiles[profileId] = profile;
  }
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
    // xAI's bundled plugin owns a model/provider catalog even after every
    // credential is disconnected. Catalog presence is not authentication
    // evidence and must not turn a clean disconnect into a false error state.
    const runtimeConfigIsCredentialEvidence = provider.id !== 'xai'
      && provider.authTypes.includes('api_key')
      && hasRuntimeProviderConfig;
    // OpenClaw 2026.7 keeps authorization profiles in its own auth store
    // (~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite) and no longer
    // mirrors them into openclaw.json's auth.profiles/auth.order. A profile the
    // auth store owns IS this provider's configuration, so requiring a
    // config-file entry reported every successful sign-in as
    // "credentials exist but provider config is missing" — a working provider
    // shown as broken, which reads to the operator as credentials not saving.
    const hasAnyProviderConfig = hasConfigProfile
      || hasOrderedProfile
      || isOpenClawAuthStoreProfile
      || runtimeConfigIsCredentialEvidence;
    const regularProfileConfigured = Boolean(profileId && hasAnyProviderConfig && hasStoredProfile);
    const providerOrder = authOrderKeys.map((key) => authOrder?.[key]).find((value) => Array.isArray(value));
    const excludedByAuthOrder = Array.isArray(providerOrder) && providerOrder.length === 0;
    const configuredModelEntries = config?.agents?.defaults?.models;
    const defaultModelEntry = defaultModel && configuredModelEntries && typeof configuredModelEntries === 'object'
      ? (configuredModelEntries[defaultModel]
        || Object.entries<any>(configuredModelEntries).find(([modelId]) => normalizePortalModelId(modelId) === defaultModel)?.[1])
      : null;
    const defaultModelRuntimeId = String(defaultModelEntry?.agentRuntime?.id || '').trim();
    const currentModel = provider.id === 'anthropic'
      ? (defaultModel && defaultModel.startsWith('anthropic/') ? defaultModel : null)
      : provider.id === 'openai-codex'
        ? (defaultModel && (defaultModel.startsWith('codex/') || defaultModel.startsWith('openai-codex/') || defaultModel.startsWith('openai/')) ? defaultModel : null)
        : provider.id === 'google-antigravity'
          // Native Antigravity selections belong to Agent Chat's GEMINI
          // harness and must never be represented as the OpenClaw default.
          ? null
          : provider.id === 'google-gemini-cli'
            ? (defaultModel && defaultModel.startsWith('google/') && defaultModelRuntimeId === 'google-gemini-cli' ? defaultModel : null)
            : provider.id === 'google'
              ? (defaultModel && defaultModel.startsWith('google/') && defaultModelRuntimeId !== 'google-gemini-cli' ? defaultModel : null)
              : (defaultModel && defaultModel.startsWith(`${provider.id}/`) ? defaultModel : null);

    let status: ProviderStatus['status'] = 'unconfigured';
    let error: string | null = null;
    let warning: string | null = null;
    let effectiveProfileId: string | null = null;
    let effectiveAuthType: string | null = null;
    const nativeProvider = getNativeProviderLinkedToOpenClawProvider(provider.id);
    const nativeAuth = nativeProvider
      ? (options.nativeAuthStatuses?.[nativeProvider] || getNativeCliAuthStatus(nativeProvider))
      : null;
    const readiness = options.providerReadiness?.[provider.id] || null;

    if (provider.primaryAuthType === 'aws_sdk') {
      effectiveAuthType = 'aws_sdk';
      if (readiness?.state === 'ready') {
        status = 'configured';
      } else if (readiness?.state === 'missing_plugin' || readiness?.state === 'plugin_unavailable') {
        status = 'error';
        error = readiness.message;
      } else if (readiness?.state === 'probe_error') {
        status = 'error';
        error = readiness.message;
      } else {
        status = 'manual';
        warning = readiness?.message
          || 'AWS credentials are owned by the OpenClaw gateway host, not Portal. Readiness has not been checked yet.';
      }
    } else if (provider.primaryAuthType === 'native_cli') {
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
        && (currentModel.startsWith(`${provider.id}/`) || provider.id === 'google-gemini-cli')
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

    if (provider.id === 'xai' && xaiAuthStoreError) {
      status = 'error';
      effectiveProfileId = null;
      effectiveAuthType = null;
      error = `Portal could not verify saved xAI credentials through OpenClaw's locked auth store. Retry status or Disconnect xAI after the control plane recovers. ${xaiAuthStoreError}`;
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
      readiness,
    };
  });
}

export async function getProviderStatusesAsync(options: {
  forceProviderReadiness?: boolean;
} = {}): Promise<ProviderStatus[]> {
  const nativeProviders = Array.from(new Set(
    AI_PROVIDERS
      .map((provider) => getNativeProviderLinkedToOpenClawProvider(provider.id))
      .filter((provider): provider is AgentProviderName => Boolean(provider)),
  ));
  const nativeAuthEntriesPromise = Promise.all(nativeProviders.map(async (provider) => (
    [provider, await getNativeCliAuthStatusAsync(provider)] as const
  )));
  const bedrockReadinessPromise = getAmazonBedrockReadiness({
    force: options.forceProviderReadiness,
  }).catch(() => createAmazonBedrockReadiness(
    'probe_error',
    Date.now(),
    'Portal could not complete the read-only Bedrock readiness check. No configuration was changed; use Check again.',
  ));

  try {
    const [authStoreProfiles, nativeAuthEntries, bedrockReadiness] = await Promise.all([
      readOpenClawAuthStoreProfilesAsync(undefined, { strict: true }),
      nativeAuthEntriesPromise,
      bedrockReadinessPromise,
    ]);
    return getProviderStatuses({
      authStoreProfiles,
      authStoreError: null,
      nativeAuthStatuses: Object.fromEntries(nativeAuthEntries),
      providerReadiness: { 'amazon-bedrock': bedrockReadiness },
    });
  } catch (error: any) {
    const [nativeAuthEntries, bedrockReadiness] = await Promise.all([
      nativeAuthEntriesPromise.catch(() => [] as Array<readonly [AgentProviderName, NativeCliAuthStatus]>),
      bedrockReadinessPromise,
    ]);
    return getProviderStatuses({
      authStoreProfiles: {},
      authStoreError: error?.message || 'OpenClaw xAI auth store is unavailable.',
      nativeAuthStatuses: Object.fromEntries(nativeAuthEntries),
      providerReadiness: { 'amazon-bedrock': bedrockReadiness },
    });
  }
}
