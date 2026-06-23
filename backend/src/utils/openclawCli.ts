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
  'anthropic/opus-4.8': 'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4.8': 'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4-8': 'anthropic/claude-opus-4-8',
  'anthropic/opus-4.6': 'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4-6': 'anthropic/claude-opus-4-6',
  'anthropic/haiku-4.5': 'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'claude-cli/sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/opus-4.8': 'anthropic/claude-opus-4-8',
  'claude-cli/claude-opus-4.8': 'anthropic/claude-opus-4-8',
  'claude-cli/claude-opus-4-8': 'anthropic/claude-opus-4-8',
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
  'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
  'gemini-3-flash-lite': 'gemini-3.1-flash-lite',
  'google/gemini-3-flash': 'google/gemini-3-flash-preview',
  'google/gemini-3.1-pro': 'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash': 'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-preview': 'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite-preview': 'google/gemini-3.1-flash-lite',
  'google/gemini-3-flash-lite': 'google/gemini-3.1-flash-lite',
  'google-gemini-cli/gemini-3-flash': 'google-gemini-cli/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-pro': 'google-gemini-cli/gemini-3.1-pro-preview',
  'google-gemini-cli/gemini-3.1-flash': 'google-gemini-cli/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-flash-preview': 'google-gemini-cli/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-flash-lite-preview': 'google-gemini-cli/gemini-3.1-flash-lite',
  'google-gemini-cli/gemini-3-flash-lite': 'google-gemini-cli/gemini-3.1-flash-lite',
  'google-antigravity/gemini-3.5-flash-preview': 'google-antigravity/gemini-3.5-flash',
  'google-antigravity/gemini-3.1-pro-preview': 'google-antigravity/gemini-3.1-pro-high',
  'google-antigravity/gemini-3-pro-preview': 'google-antigravity/gemini-3.1-pro-high',
  'google-antigravity/gemini-3.1-flash-lite': 'google-antigravity/gemini-3.5-flash',
  'google-antigravity/gemini-3.1-flash-lite-preview': 'google-antigravity/gemini-3.5-flash',
};

const OPENAI_CODEX_MODEL_MAP: Record<string, string> = {
  'gpt-5.4-codex': 'codex/gpt-5.5',
  'openai-codex/gpt-5.5-pro': 'codex/gpt-5.5',
  'openai-codex/gpt-5.4-pro': 'codex/gpt-5.5',
  'openai-codex/gpt-5.4-codex': 'codex/gpt-5.5',
  'openai-codex/gpt-5.4': 'codex/gpt-5.5',
  'openai-codex/gpt-5.4-mini': 'codex/gpt-5.5',
  'openai-codex/gpt-5.2-codex': 'codex/gpt-5.2',
  'codex/gpt-5.5-pro': 'codex/gpt-5.5',
  'codex/gpt-5.4': 'codex/gpt-5.5',
  'codex/gpt-5.4-mini': 'codex/gpt-5.5',
  'codex/gpt-5.4-pro': 'codex/gpt-5.5',
  'openai/gpt-5.4': 'codex/gpt-5.5',
  'openai/gpt-5.4-mini': 'codex/gpt-5.5',
  'openai/gpt-5.4-pro': 'codex/gpt-5.5',
  'openai/gpt-5.4-codex': 'codex/gpt-5.5',
  'codex/gpt-5.2-codex': 'codex/gpt-5.2',
  'codex/gpt-5.4-codex': 'codex/gpt-5.5',
};

const CURRENT_CODEX_RUNTIME_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.2',
]);

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
  if (mapped.startsWith('openai-codex/')) {
    return `codex/${mapped.slice('openai-codex/'.length)}`;
  }
  return mapped;
}

export function normalizeOpenClawConfigModelId(rawModel: string | null | undefined): string {
  const normalized = normalizePortalModelId(rawModel);
  if (!normalized) return '';

  if (normalized.startsWith('google/')) {
    const modelName = normalized.slice('google/'.length);
    if (modelName.startsWith('gemini-3')) {
      return `google-antigravity/${modelName}`;
    }
  }

  if (normalized.startsWith('openai/')) {
    const modelName = normalized.slice('openai/'.length);
    if (CURRENT_CODEX_RUNTIME_MODELS.has(modelName)) {
      return `codex/${modelName}`;
    }
  }

  if (!normalized.includes('/') && normalized.startsWith('gemini-3')) {
    return `google-antigravity/${normalized}`;
  }

  if (!normalized.includes('/') && CURRENT_CODEX_RUNTIME_MODELS.has(normalized)) {
    return `codex/${normalized}`;
  }

  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function usesClaudeCliAuthProfile(config: any, authProfiles?: any): boolean {
  const configProfiles = config?.auth?.profiles && typeof config.auth.profiles === 'object'
    ? config.auth.profiles
    : {};
  const storedProfiles = authProfiles?.profiles && typeof authProfiles.profiles === 'object'
    ? authProfiles.profiles
    : {};
  const profiles = { ...configProfiles, ...storedProfiles };
  const anthropicOrder = Array.isArray(config?.auth?.order?.anthropic) ? config.auth.order.anthropic : [];

  if (anthropicOrder.some((profileId: unknown) => String(profileId || '').includes('claude-cli'))) {
    return true;
  }

  return Object.entries<any>(profiles).some(([profileId, profile]) => {
    const provider = String(profile?.provider || '').trim();
    const mode = String(profile?.mode || profile?.type || '').trim();
    return profileId.includes('claude-cli') || provider === 'claude-cli' || (provider === 'anthropic' && mode === 'claude-cli');
  });
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

  addProviderAlias('openai-codex', 'codex');
  addProviderAlias('openai-codex', 'openai');
  addProviderAlias('codex', 'openai-codex');
  addProviderAlias('codex', 'openai');
  addProviderAlias('openai', 'openai-codex');
  addProviderAlias('openai', 'codex');
  addProviderAlias('google-gemini-cli', 'google');
  addProviderAlias('google-gemini-cli', 'google-antigravity');
  addProviderAlias('google', 'google-gemini-cli');
  addProviderAlias('google', 'google-antigravity');
  addProviderAlias('google-antigravity', 'google');
  addProviderAlias('google-antigravity', 'google-gemini-cli');
  addProviderAlias('claude-cli', 'anthropic');
  addProviderAlias('anthropic', 'claude-cli');

  if (!normalized.includes('/')) {
    if (/^(gpt-|o\d|codex)/i.test(normalized)) {
      aliases.push(`openai/${normalized}`, `openai-codex/${normalized}`, `codex/${normalized}`);
    }
    if (normalized.startsWith('gemini-')) {
      aliases.push(`google/${normalized}`, `google-gemini-cli/${normalized}`, `google-antigravity/${normalized}`);
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
  const antigravityModelName = (modelName: string) => {
    switch (modelName) {
      case 'gemini-3-flash-preview':
        return 'gemini-3.5-flash';
      case 'gemini-3.1-pro-preview':
        return 'gemini-3.1-pro-high';
      case 'gemini-3-pro-preview':
        return 'gemini-3.1-pro-high';
      case 'gemini-3.1-flash-lite':
      case 'gemini-3.1-flash-lite-preview':
        return 'gemini-3.5-flash';
      default:
        return modelName;
    }
  };

  if (provider === 'google-gemini-cli' || provider === 'google-antigravity') {
    if (normalized.startsWith('google/')) {
      const modelName = normalized.slice('google/'.length);
      return `${provider}/${provider === 'google-antigravity' ? antigravityModelName(modelName) : modelName}`;
    }
    if (normalized.startsWith('google-antigravity/') || normalized.startsWith('google-gemini-cli/')) {
      const modelName = normalized.replace(/^google-(?:antigravity|gemini-cli)\//, '');
      return `${provider}/${provider === 'google-antigravity' ? antigravityModelName(modelName) : modelName}`;
    }
    if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
      return `${provider}/${provider === 'google-antigravity' ? antigravityModelName(normalized) : normalized}`;
    }
  }

  if (provider === 'google') {
    if (normalized.startsWith('google-gemini-cli/') || normalized.startsWith('google-antigravity/')) {
      return `google/${normalized.replace(/^google-(?:gemini-cli|antigravity)\//, '')}`;
    }
    if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
      return `google/${normalized}`;
    }
  }

  if (provider === 'openai-codex' || provider === 'codex') {
    if (normalized.startsWith('codex/')) {
      return normalized;
    }
    if (normalized.startsWith('openai/')) {
      return `codex/${normalized.slice('openai/'.length)}`;
    }
    if (normalized.startsWith('openai-codex/')) {
      return `codex/${normalized.slice('openai-codex/'.length)}`;
    }
    if (!normalized.includes('/') && /^(gpt-|o\d|codex)/i.test(normalized)) {
      return `codex/${normalized}`;
    }
  }

  if (provider === 'openai') {
    if (normalized.startsWith('codex/')) {
      return `openai/${normalized.slice('codex/'.length)}`;
    }
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

  if (provider === 'google' || provider === 'google-gemini-cli' || provider === 'google-antigravity') {
    if (translated.startsWith('google/') || translated.startsWith('google-gemini-cli/') || translated.startsWith('google-antigravity/')) {
      return normalizePortalModelId(translated);
    }
    if (translated.startsWith('gemini-')) return normalizePortalModelId(`${provider}/${translated}`);
  }

  if (provider === 'openai-codex' || provider === 'codex') {
    if (translated.startsWith('codex/') || translated.startsWith('openai/') || translated.startsWith('openai-codex/')) {
      return normalizePortalModelId(translated);
    }
    if (!translated.includes('/')) return normalizePortalModelId(`${provider}/${translated}`);
  }

  if (provider === 'openai') {
    if (translated.startsWith('openai/') || translated.startsWith('openai-codex/') || translated.startsWith('codex/')) {
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
    sessionInfo?.agentRuntimeOverride,
    sessionInfo?.agentHarnessId,
    sessionInfo?.runtime,
    sessionInfo?.runtimeLabel,
    sessionInfo?.modelProvider,
    sessionInfo?.currentModel?.provider,
    sessionInfo?.provider,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).join(' ');
}

function modelForCurrentCodexRuntime(normalized: string): string {
  if (!normalized) return '';
  const provider = normalized.includes('/') ? normalized.split('/')[0] : '';
  const modelName = normalized.includes('/') ? normalized.slice(provider.length + 1) : normalized;
  const openAiFamily = provider === 'openai' || provider === 'openai-codex' || provider === 'codex' || !provider;
  if (!openAiFamily) return normalized;

  if (modelName === 'gpt-5.5' || modelName === 'gpt-5.5-pro') return 'codex/gpt-5.5';
  if (/^gpt-5\.4(?:-|$)/.test(modelName)) return 'codex/gpt-5.5';
  if (CURRENT_CODEX_RUNTIME_MODELS.has(modelName)) return `codex/${modelName}`;
  return normalized;
}

export function modelForOpenClawSessionPatch(sessionInfo: any, portalModel: string): string {
  const normalized = modelForCurrentCodexRuntime(normalizePortalModelId(portalModel));
  if (!normalized) return '';

  // OpenClaw 2026.6 exposes the Codex app-server runtime as the codex provider.
  // Older Portal settings may still say openai-codex/*, so keep those readable
  // but send current codex/* ids back to OpenClaw.
  const runtimeHint = getOpenClawRuntimeHint(sessionInfo);
  const codexRuntime = /\bcodex\b/.test(runtimeHint) || normalized.startsWith('codex/');
  if (codexRuntime) {
    if (normalized.startsWith('codex/')) return normalized;
    if (normalized.startsWith('openai-codex/')) return `codex/${normalized.slice('openai-codex/'.length)}`;
    if (/^(gpt-|o\d|codex)/i.test(normalized)) return `codex/${normalized}`;
  }

  const claudeCliRuntime = /\bclaude-cli\b/.test(runtimeHint) || usesClaudeCliAuthProfile(readJson<any>(CONFIG_PATH, {}), readJson<any>(AUTH_PROFILES_PATH, { version: 2, profiles: {} }));
  if (claudeCliRuntime && normalized.startsWith('anthropic/')) {
    // OpenClaw catalogs Claude subscription models as anthropic/* with
    // agentRuntime.id="claude-cli"; sessions.patch must use the catalog id.
    return normalized;
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
  const useClaudeCliRuntime = usesClaudeCliAuthProfile(config, authProfiles);

  const currentDefault = normalizeOpenClawConfigModelId(config?.agents?.defaults?.model?.primary || '');
  const desiredDefault = normalizeOpenClawConfigModelId(preferredModel || currentDefault);
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
    const normalizedModelId = normalizeOpenClawConfigModelId(modelId);
    if (!normalizedModelId) continue;
    repairedModels[normalizedModelId] = {
      ...(repairedModels[normalizedModelId] || {}),
      ...(meta && typeof meta === 'object' ? meta : {}),
    };
    if (useClaudeCliRuntime && normalizedModelId.startsWith('anthropic/')) {
      const entry = repairedModels[normalizedModelId];
      if (String(entry.agentRuntime?.id || '').trim() !== 'claude-cli') {
        entry.agentRuntime = {
          ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}),
          id: 'claude-cli',
        };
        changed = true;
      }
    }
    if (normalizedModelId !== modelId) changed = true;
  }
  if (desiredDefault && !repairedModels[desiredDefault]) {
    repairedModels[desiredDefault] = useClaudeCliRuntime && desiredDefault.startsWith('anthropic/')
      ? { agentRuntime: { id: 'claude-cli' } }
      : {};
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
  const repairedFallbacks = uniqueStrings(fallbacks.map((model) => normalizeOpenClawConfigModelId(model)));
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
