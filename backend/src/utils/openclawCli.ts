import fs from 'fs';
import path from 'path';

const HOME_DIR = process.env.HOME || '/root';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME_DIR, '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');

const CLAUDE_MODEL_MAP: Record<string, string> = {
  'anthropic/sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
  'anthropic/opus-4.6': 'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4-6': 'anthropic/claude-opus-4-6',
  'anthropic/haiku-4.5': 'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'claude-cli/sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/opus-4.6': 'anthropic/claude-opus-4-6',
  'claude-cli/claude-opus-4.6': 'anthropic/claude-opus-4-6',
  'claude-cli/claude-opus-4-6': 'anthropic/claude-opus-4-6',
  'claude-cli/haiku-4.5': 'anthropic/claude-haiku-4-5',
  'claude-cli/claude-haiku-4.5': 'anthropic/claude-haiku-4-5',
  'claude-cli/claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
};

function readJson<T>(targetPath: string, fallback: T): T {
  try {
    if (!fs.existsSync(targetPath)) return fallback;
    return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2), 'utf8');
}

export function buildOpenClawCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCLAW_API_URL;
  delete env.OPENCLAW_GATEWAY_URL;
  delete env.OPENCLAW_GATEWAY_TOKEN;
  delete env.OPENCLAW_GATEWAY_AUTH_TOKEN;
  return env;
}

export function normalizePortalModelId(rawModel: string | null | undefined): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  const mapped = CLAUDE_MODEL_MAP[model.toLowerCase()] || model;
  if (mapped.startsWith('claude-cli/')) {
    return `anthropic/${mapped.slice('claude-cli/'.length)}`;
  }
  return mapped;
}

export function canonicalizeProviderModelId(providerId: string | null | undefined, rawModel: string | null | undefined): string {
  const provider = String(providerId || '').trim();
  let model = String(rawModel || '').trim();
  if (!model) return '';

  if (model.startsWith('models/')) {
    model = model.slice('models/'.length);
  }

  const normalized = normalizePortalModelId(model);
  if (!provider) return normalized;
  if (!normalized) return '';
  if (normalized.startsWith(`${provider}/`)) return normalized;

  if (provider === 'openrouter') {
    return normalized.startsWith('openrouter/') ? normalized : `openrouter/${normalized}`;
  }

  if (provider === 'google' || provider === 'google-gemini-cli') {
    if (normalized.startsWith('google/') || normalized.startsWith('google-gemini-cli/')) {
      return normalized;
    }
    if (normalized.startsWith('gemini-')) return `${provider}/${normalized}`;
  }

  if (!normalized.includes('/')) {
    return `${provider}/${normalized}`;
  }

  return `${provider}/${normalized}`;
}

export function extractJsonFromCliOutput(rawOutput: string): string {
  const raw = String(rawOutput || '');
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Keep scanning.
  }

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning until we find a valid JSON suffix.
    }
  }

  return trimmed;
}

export function normalizePortalModelList(models: string[] | null | undefined): string[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of models) {
    const next = normalizePortalModelId(model);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

export function repairClaudeSubscriptionConfig(preferredModel?: string | null): { changed: boolean; defaultModel: string | null } {
  const config = readJson<any>(CONFIG_PATH, {});
  const authProfiles = readJson<any>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
  let changed = false;

  const currentDefault = normalizePortalModelId(config?.agents?.defaults?.model?.primary || '');
  const desiredDefault = normalizePortalModelId(preferredModel || currentDefault);
  if (desiredDefault && config?.agents?.defaults?.model?.primary !== desiredDefault) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = config.agents.defaults.model || {};
    config.agents.defaults.model.primary = desiredDefault;
    changed = true;
  }

  const existingModels = config?.agents?.defaults?.models || {};
  const repairedModels: Record<string, any> = {};
  for (const [modelId, meta] of Object.entries<any>(existingModels)) {
    const normalizedModelId = normalizePortalModelId(modelId);
    if (!normalizedModelId) continue;
    repairedModels[normalizedModelId] = {
      ...(repairedModels[normalizedModelId] || {}),
      ...(meta && typeof meta === 'object' ? meta : {}),
    };
    if (normalizedModelId !== modelId) changed = true;
  }
  if (desiredDefault && !repairedModels[desiredDefault]) {
    repairedModels[desiredDefault] = {};
    changed = true;
  }
  if (JSON.stringify(existingModels) !== JSON.stringify(repairedModels)) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.models = repairedModels;
    changed = true;
  }

  const fallbacks = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
    ? config.agents.defaults.model.fallbacks
    : [];
  const repairedFallbacks = normalizePortalModelList(fallbacks);
  if (JSON.stringify(fallbacks) !== JSON.stringify(repairedFallbacks)) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = config.agents.defaults.model || {};
    config.agents.defaults.model.fallbacks = repairedFallbacks;
    changed = true;
  }

  if (config?.auth?.profiles?.['anthropic:claude-cli']) {
    delete config.auth.profiles['anthropic:claude-cli'];
    changed = true;
  }
  const anthropicOrder = Array.isArray(config?.auth?.order?.anthropic) ? config.auth.order.anthropic : null;
  if (anthropicOrder && anthropicOrder.includes('anthropic:claude-cli')) {
    config.auth.order.anthropic = anthropicOrder.filter((profileId: string) => profileId !== 'anthropic:claude-cli');
    changed = true;
  }

  let authProfilesChanged = false;
  if (authProfiles?.profiles?.['anthropic:claude-cli']) {
    delete authProfiles.profiles['anthropic:claude-cli'];
    authProfilesChanged = true;
  }
  if (authProfiles?.lastGood?.anthropic && authProfiles.lastGood.anthropic === 'anthropic:claude-cli') {
    delete authProfiles.lastGood.anthropic;
    authProfilesChanged = true;
  }
  if (authProfiles?.usageStats?.['anthropic:claude-cli']) {
    delete authProfiles.usageStats['anthropic:claude-cli'];
    authProfilesChanged = true;
  }

  if (changed) writeJson(CONFIG_PATH, config);
  if (authProfilesChanged) writeJson(AUTH_PROFILES_PATH, authProfiles);
  return { changed: changed || authProfilesChanged, defaultModel: desiredDefault || null };
}
