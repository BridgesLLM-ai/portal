import { execFileSync } from 'child_process';
import fs from 'fs';
import { isDeepStrictEqual } from 'util';
import { CONFIG_PATH } from './openclawConfigManager';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';

export interface OpenClawPluginPolicySnapshot {
  allowPresent: boolean;
  allow: unknown;
  entryPresent: boolean;
  entryEnabledPresent: boolean;
  entryEnabled: unknown;
}

export interface OpenClawPluginLease {
  pluginId: string;
  providerId: string;
  changed: boolean;
  before: OpenClawPluginPolicySnapshot;
  applied: OpenClawPluginPolicySnapshot;
}

export interface OpenClawPluginState {
  discovered: boolean;
  enabled: boolean;
  status: string | null;
  providerIds: string[];
}

interface OpenClawConfigSetOperation {
  path: string;
  value: unknown;
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function readConfig(): any {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('OpenClaw configuration root must be an object.');
  }
  return config;
}

export function captureOpenClawPluginPolicy(config: any, pluginId: string): OpenClawPluginPolicySnapshot {
  const plugins = config?.plugins;
  const entries = plugins?.entries;
  return {
    allowPresent: hasOwn(plugins, 'allow'),
    allow: cloneValue(plugins?.allow),
    entryPresent: hasOwn(entries, pluginId),
    entryEnabledPresent: hasOwn(entries?.[pluginId], 'enabled'),
    entryEnabled: cloneValue(entries?.[pluginId]?.enabled),
  };
}

export function buildOpenClawPluginPolicy(
  config: any,
  pluginId: string,
): { allow: unknown; entryEnabled: true } {
  if (config?.plugins?.enabled === false) {
    throw new Error('OpenClaw plugins are disabled globally. Enable plugins before configuring this provider.');
  }
  const deny = config?.plugins?.deny;
  if (Array.isArray(deny) && deny.includes(pluginId)) {
    throw new Error(`The OpenClaw ${pluginId} plugin is explicitly denied. Remove it from plugins.deny before configuring this provider.`);
  }

  const currentAllow = config?.plugins?.allow;
  if (currentAllow !== undefined && !Array.isArray(currentAllow)) {
    throw new Error('OpenClaw plugins.allow must be an array before Portal can safely update it.');
  }
  const allow = Array.isArray(currentAllow) && currentAllow.length > 0 && !currentAllow.includes(pluginId)
    ? [...currentAllow, pluginId]
    : currentAllow;

  const currentEntry = config?.plugins?.entries?.[pluginId];
  if (currentEntry !== undefined && (!currentEntry || typeof currentEntry !== 'object' || Array.isArray(currentEntry))) {
    throw new Error(`OpenClaw plugins.entries.${pluginId} must be an object before Portal can safely enable it.`);
  }
  return { allow: cloneValue(allow), entryEnabled: true };
}

export function parseOpenClawPluginState(
  payload: unknown,
  pluginId: string,
): OpenClawPluginState {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload as any;
  const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
  const plugin = plugins.find((entry: any) => String(entry?.id || '') === pluginId);
  if (!plugin) {
    return { discovered: false, enabled: false, status: null, providerIds: [] };
  }
  return {
    discovered: true,
    enabled: plugin.enabled === true && plugin.status !== 'disabled',
    status: typeof plugin.status === 'string' ? plugin.status : null,
    providerIds: Array.isArray(plugin.providerIds)
      ? plugin.providerIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
      : [],
  };
}

function runOpenClawPluginCommand(args: string[], timeoutMs = 20_000): string {
  const raw = execFileSync('openclaw', args, {
    encoding: 'utf8',
    env: buildOpenClawCliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 16,
  });
  return args.includes('--json') ? extractJsonFromCliOutput(raw) : raw;
}

function applyConfigSetOperations(operations: OpenClawConfigSetOperation[]): void {
  if (operations.length === 0) return;
  runOpenClawPluginCommand(['config', 'set', '--batch-json', JSON.stringify(operations)]);
}

function restoreConfigPath(path: string, present: boolean, value: unknown): void {
  if (present) {
    applyConfigSetOperations([{ path, value: cloneValue(value) }]);
  } else {
    runOpenClawPluginCommand(['config', 'unset', path]);
  }
}

export function readOpenClawPluginState(pluginId: string): OpenClawPluginState {
  const normalizedPluginId = String(pluginId || '').trim();
  if (!normalizedPluginId) throw new Error('OpenClaw plugin id is required.');
  return parseOpenClawPluginState(
    runOpenClawPluginCommand(['plugins', 'list', '--json']),
    normalizedPluginId,
  );
}

function assertProviderPluginReady(state: OpenClawPluginState, pluginId: string, providerId: string): void {
  if (!state.discovered) throw new Error(`The bundled OpenClaw ${pluginId} plugin is not installed.`);
  if (!state.enabled) throw new Error(`The bundled OpenClaw ${pluginId} plugin did not enable.`);
  if (!state.providerIds.includes(providerId)) {
    throw new Error(`The OpenClaw ${pluginId} plugin enabled without registering provider ${providerId}.`);
  }
}

export function ensureOpenClawProviderPluginEnabled(
  pluginId: string,
  providerId: string,
): OpenClawPluginLease {
  const normalizedPluginId = String(pluginId || '').trim();
  const normalizedProviderId = String(providerId || '').trim();
  if (!normalizedPluginId || !normalizedProviderId) {
    throw new Error('OpenClaw plugin and provider ids are required.');
  }

  const configBefore = readConfig();
  const before = captureOpenClawPluginPolicy(configBefore, normalizedPluginId);
  const desired = buildOpenClawPluginPolicy(configBefore, normalizedPluginId);
  const operations: OpenClawConfigSetOperation[] = [];

  if (!isDeepStrictEqual(before.allow, desired.allow)) {
    operations.push({ path: 'plugins.allow', value: desired.allow });
  }
  if (!isDeepStrictEqual(before.entryEnabled, desired.entryEnabled)) {
    operations.push({ path: `plugins.entries.${normalizedPluginId}.enabled`, value: true });
  }

  applyConfigSetOperations(operations);
  const appliedConfig = readConfig();
  const applied = captureOpenClawPluginPolicy(appliedConfig, normalizedPluginId);
  const lease: OpenClawPluginLease = {
    pluginId: normalizedPluginId,
    providerId: normalizedProviderId,
    changed: operations.length > 0,
    before,
    applied,
  };

  try {
    assertProviderPluginReady(
      readOpenClawPluginState(normalizedPluginId),
      normalizedPluginId,
      normalizedProviderId,
    );
  } catch (error) {
    try {
      rollbackOpenClawProviderPluginLease(lease);
    } catch {
      // Preserve the verification failure; the caller will surface it and avoid auth.
    }
    throw error;
  }

  return lease;
}

export function rollbackOpenClawProviderPluginLease(lease: OpenClawPluginLease | null | undefined): void {
  if (!lease?.changed) return;
  const currentConfig = readConfig();
  const current = captureOpenClawPluginPolicy(currentConfig, lease.pluginId);

  // Restore a path only when it still equals the exact value Portal applied.
  // If an operator changed it during setup, fail closed instead of clobbering
  // that concurrent policy decision.
  if (!isDeepStrictEqual(current.allow, lease.applied.allow)
    || current.allowPresent !== lease.applied.allowPresent
    || !isDeepStrictEqual(current.entryEnabled, lease.applied.entryEnabled)
    || current.entryEnabledPresent !== lease.applied.entryEnabledPresent) {
    throw new Error(`OpenClaw plugin ${lease.pluginId} policy changed during setup; Portal did not overwrite the newer policy.`);
  }

  const entryEnabledChanged = lease.before.entryEnabledPresent !== lease.applied.entryEnabledPresent
    || !isDeepStrictEqual(lease.before.entryEnabled, lease.applied.entryEnabled);
  const allowChanged = lease.before.allowPresent !== lease.applied.allowPresent
    || !isDeepStrictEqual(lease.before.allow, lease.applied.allow);

  if (entryEnabledChanged) restoreConfigPath(
    `plugins.entries.${lease.pluginId}.enabled`,
    lease.before.entryEnabledPresent,
    lease.before.entryEnabled,
  );
  if (entryEnabledChanged && !lease.before.entryPresent) {
    const afterEnabledRestore = readConfig()?.plugins?.entries?.[lease.pluginId];
    if (afterEnabledRestore && typeof afterEnabledRestore === 'object' && !Array.isArray(afterEnabledRestore)
      && Object.keys(afterEnabledRestore).length === 0) {
      runOpenClawPluginCommand(['config', 'unset', `plugins.entries.${lease.pluginId}`]);
    }
  }
  if (allowChanged) restoreConfigPath('plugins.allow', lease.before.allowPresent, lease.before.allow);

  const restored = captureOpenClawPluginPolicy(readConfig(), lease.pluginId);
  if (!isDeepStrictEqual(restored, lease.before)) {
    throw new Error(`OpenClaw plugin ${lease.pluginId} policy did not return to its pre-setup state.`);
  }
}
