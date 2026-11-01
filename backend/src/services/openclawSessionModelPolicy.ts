import { readOpenClawConfig } from './openclawConfigManager';
import { normalizePortalModelId } from '../utils/openclawCli';

// A chat session's model changes only among the models this server allows, for
// every role. The Portal checks this itself before sessions.patch: OpenClaw
// 2026.10.6 accepted an operator patch to a model outside the Portal's enabled
// models. Each restriction applies only when it names at least one model; with
// none configured, OpenClaw alone decides (unchanged behavior).
//
// - `agents.defaults.models`: the models an admin enabled in Model Providers
//   (the map the model picker reads). The configured primary model and its
//   fallbacks count as enabled too.
// - OpenClaw's explicit `modelPolicy.allow`: the session agent's own policy
//   (`agents.entries.<id>`, or a legacy `agents.list[]` entry) replaces
//   `agents.defaults.modelPolicy.allow`; `[]` allows any model. Entries are
//   exact refs or trailing `provider/*` / `provider/namespace/*` prefixes.
// A malformed restriction refuses every model (fail closed).

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addModelId(target: Set<string>, raw: unknown): void {
  const id = typeof raw === 'string' ? normalizePortalModelId(raw) : '';
  if (id) target.add(id);
}

/** The enabled-model set, or null when no model is enabled (no restriction). */
function enabledModels(config: any): Set<string> | null {
  const defaults = isRecord(config?.agents?.defaults) ? config.agents.defaults : null;
  if (!defaults || defaults.models === undefined || defaults.models === null) return null;
  if (!isRecord(defaults.models)) return new Set();
  const keys = Object.keys(defaults.models);
  if (keys.length === 0) return null;
  const enabled = new Set<string>();
  for (const key of keys) addModelId(enabled, key);
  const model = defaults.model;
  if (typeof model === 'string') addModelId(enabled, model);
  if (isRecord(model)) {
    addModelId(enabled, model.primary);
    if (Array.isArray(model.fallbacks)) for (const fallback of model.fallbacks) addModelId(enabled, fallback);
  }
  return enabled;
}

function agentEntry(config: any, agentId: string | null): Record<string, any> | null {
  if (!agentId) return null;
  const agents = config?.agents;
  if (isRecord(agents?.entries) && isRecord(agents.entries[agentId])) return agents.entries[agentId];
  if (Array.isArray(agents?.list)) {
    const entry = agents.list.find((item: unknown) => isRecord(item) && item.id === agentId);
    if (isRecord(entry)) return entry;
  }
  return null;
}

/** The explicit allowlist in force for the agent, or null when none is configured. */
function explicitAllowlist(config: any, agentId: string | null): unknown[] | null {
  const entry = agentEntry(config, agentId);
  const own = isRecord(entry?.modelPolicy) && 'allow' in entry!.modelPolicy ? entry!.modelPolicy.allow : undefined;
  const allow = own !== undefined ? own : (isRecord(config?.agents?.defaults?.modelPolicy)
    ? config.agents.defaults.modelPolicy.allow : undefined);
  if (allow === undefined || allow === null) return null;
  return Array.isArray(allow) ? allow : ['\u0000malformed'];
}

function allowlistAdmits(allow: unknown[], model: string): boolean {
  return allow.some((raw) => {
    if (typeof raw !== 'string') return false;
    const entry = raw.trim();
    if (entry.endsWith('/*')) {
      const prefix = entry.slice(0, -1);
      return prefix.length > 1 && model.startsWith(prefix);
    }
    return normalizePortalModelId(entry) === model;
  });
}

/**
 * True when this server's OpenClaw configuration lets a session of `agentId`
 * (null when the key names none) switch to `model`. Clearing an override is
 * not a switch and is always allowed by the caller.
 */
export function openClawSessionModelAllowed(agentId: string | null, model: string, config: any = readOpenClawConfig()): boolean {
  const wanted = normalizePortalModelId(model);
  if (!wanted) return false;
  const enabled = enabledModels(config);
  if (enabled && !enabled.has(wanted)) return false;
  const allow = explicitAllowlist(config, agentId);
  if (allow && allow.length > 0 && !allowlistAdmits(allow, wanted)) return false;
  return true;
}
