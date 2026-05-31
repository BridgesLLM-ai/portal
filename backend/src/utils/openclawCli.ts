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

const GOOGLE_MODEL_MAP: Record<string, string> = {
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-flash': 'gemini-3-flash-preview',
  'gemini-3.1-flash-preview': 'gemini-3-flash-preview',
  'google/gemini-3-flash': 'google/gemini-3-flash-preview',
  'google/gemini-3.1-pro': 'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash': 'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-preview': 'google/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3-flash': 'google-gemini-cli/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-pro': 'google-gemini-cli/gemini-3.1-pro-preview',
  'google-gemini-cli/gemini-3.1-flash': 'google-gemini-cli/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-flash-preview': 'google-gemini-cli/gemini-3-flash-preview',
};

const OPENAI_CODEX_MODEL_MAP: Record<string, string> = {
  'gpt-5.4-codex': 'gpt-5.4',
  'openai-codex/gpt-5.4-codex': 'openai-codex/gpt-5.4',
  'openai/gpt-5.4-codex': 'openai-codex/gpt-5.4',
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
  // BridgesLLM Portal currently runs OpenClaw CLI helpers from the root-owned
  // appliance service. OpenClaw 2026.5.9+ intentionally refuses those commands
  // unless the operator opts in, so portal-managed CLI calls must carry the
  // explicit root escape hatch while HOME/OPENCLAW_HOME stay anchored to /root.
  env.OPENCLAW_ALLOW_ROOT = env.OPENCLAW_ALLOW_ROOT || '1';
  delete env.OPENCLAW_API_URL;
  delete env.OPENCLAW_GATEWAY_URL;
  delete env.OPENCLAW_GATEWAY_TOKEN;
  delete env.OPENCLAW_GATEWAY_AUTH_TOKEN;
  return env;
}

export function normalizePortalModelId(rawModel: string | null | undefined): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  const lower = model.toLowerCase();
  const mapped = CLAUDE_MODEL_MAP[lower] || GOOGLE_MODEL_MAP[lower] || OPENAI_CODEX_MODEL_MAP[lower] || model;
  if (mapped.startsWith('claude-cli/')) {
    return `anthropic/${mapped.slice('claude-cli/'.length)}`;
  }
  return mapped;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function getPortalModelCatalogAliases(rawModel: string | null | undefined): string[] {
  const normalized = normalizePortalModelId(rawModel);
  if (!normalized) return [];

  const aliases = [normalized];
  const addProviderAlias = (from: string, to: string) => {
    if (normalized.startsWith(`${from}/`)) {
      aliases.push(`${to}/${normalized.slice(from.length + 1)}`);
    }
  };

  addProviderAlias('openai-codex', 'openai');
  addProviderAlias('openai', 'openai-codex');
  addProviderAlias('google-gemini-cli', 'google');
  addProviderAlias('google', 'google-gemini-cli');
  addProviderAlias('claude-cli', 'anthropic');
  addProviderAlias('anthropic', 'claude-cli');

  if (!normalized.includes('/')) {
    if (/^(gpt-|o\d|codex)/i.test(normalized)) {
      aliases.push(`openai/${normalized}`, `openai-codex/${normalized}`);
    }
    if (normalized.startsWith('gemini-')) {
      aliases.push(`google/${normalized}`, `google-gemini-cli/${normalized}`);
    }
  }

  return uniqueStrings(aliases.map((alias) => normalizePortalModelId(alias)));
}

export function resolvePortalModelFromCatalog(rawModel: string | null | undefined, availableModels: string[]): string {
  const aliases = getPortalModelCatalogAliases(rawModel);
  if (!aliases.length) return '';

  const catalog = uniqueStrings(availableModels.map((model) => normalizePortalModelId(model)));
  if (!catalog.length) return aliases[0];

  for (const alias of aliases) {
    if (catalog.includes(alias)) return alias;
  }

  const normalized = normalizePortalModelId(rawModel);
  if (normalized && !normalized.includes('/')) {
    const suffix = `/${normalized}`;
    const suffixMatch = catalog.find((model) => model.endsWith(suffix));
    if (suffixMatch) return suffixMatch;
  }

  return '';
}

function translateProviderOwnedAlias(provider: string, normalized: string): string {
  if (!provider || !normalized) return normalized;

  if (provider === 'google-gemini-cli') {
    if (normalized.startsWith('google/')) {
      return `google-gemini-cli/${normalized.slice('google/'.length)}`;
    }
    if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
      return `google-gemini-cli/${normalized}`;
    }
  }

  if (provider === 'google') {
    if (normalized.startsWith('google-gemini-cli/')) {
      return `google/${normalized.slice('google-gemini-cli/'.length)}`;
    }
    if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
      return `google/${normalized}`;
    }
  }

  if (provider === 'openai-codex') {
    if (normalized.startsWith('openai/')) {
      return `openai-codex/${normalized.slice('openai/'.length)}`;
    }
    if (!normalized.includes('/') && /^(gpt-|o\d|codex)/i.test(normalized)) {
      return `openai-codex/${normalized}`;
    }
  }

  if (provider === 'openai') {
    if (normalized.startsWith('openai-codex/')) {
      return `openai/${normalized.slice('openai-codex/'.length)}`;
    }
    if (!normalized.includes('/') && /^(gpt-|o\d|codex)/i.test(normalized)) {
      return `openai/${normalized}`;
    }
  }

  return normalized;
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

  const translated = translateProviderOwnedAlias(provider, normalized);
  if (translated.startsWith(`${provider}/`)) return translated;

  if (provider === 'openrouter') {
    return translated.startsWith('openrouter/') ? translated : `openrouter/${translated}`;
  }

  if (provider === 'google' || provider === 'google-gemini-cli') {
    if (translated.startsWith('google/') || translated.startsWith('google-gemini-cli/')) {
      return normalizePortalModelId(translated);
    }
    if (translated.startsWith('gemini-')) return normalizePortalModelId(`${provider}/${translated}`);
  }

  if (provider === 'openai-codex' || provider === 'openai') {
    if (translated.startsWith('openai/') || translated.startsWith('openai-codex/')) {
      return normalizePortalModelId(translated);
    }
    if (!translated.includes('/')) return normalizePortalModelId(`${provider}/${translated}`);
  }

  if (!translated.includes('/')) {
    return `${provider}/${translated}`;
  }

  return `${provider}/${translated}`;
}

export function getOpenClawRuntimeHint(sessionInfo: any): string {
  return [
    sessionInfo?.agentRuntime?.id,
    sessionInfo?.agentRuntime?.label,
    sessionInfo?.runtime,
    sessionInfo?.runtimeLabel,
    sessionInfo?.modelProvider,
    sessionInfo?.currentModel?.provider,
    sessionInfo?.provider,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).join(' ');
}

export function modelForOpenClawSessionPatch(sessionInfo: any, portalModel: string): string {
  const normalized = normalizePortalModelId(portalModel);
  if (!normalized) return '';

  // OpenClaw 2026.5 keeps Codex-owned OpenAI models in the openai-codex provider
  // family. Sending openai/gpt-* to a Codex-runtime session creates a split-brain
  // state: modelProvider=openai with agentRuntime=codex, which the harness rejects.
  const runtimeHint = getOpenClawRuntimeHint(sessionInfo);
  const codexRuntime = /\bcodex\b/.test(runtimeHint) || normalized.startsWith('openai-codex/');
  if (codexRuntime) {
    if (normalized.startsWith('openai-codex/')) return normalized;
    if (normalized.startsWith('openai/')) return `openai-codex/${normalized.slice('openai/'.length)}`;
    if (normalized.startsWith('codex/')) return `openai-codex/${normalized.slice('codex/'.length)}`;
    if (/^(gpt-|o\d|codex)/i.test(normalized)) return `openai-codex/${normalized}`;
  }

  return normalized;
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

  if (changed) writeJson(CONFIG_PATH, config);
  return { changed, defaultModel: desiredDefault || null };
}
