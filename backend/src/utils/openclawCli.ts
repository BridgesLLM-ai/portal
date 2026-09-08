import fs from 'fs';
import path from 'path';
import {
  readOpenClawAgentConfigContract,
  type OpenClawAgentConfigFamily,
} from '../services/openclawAgentConfigContract';

const HOME_DIR = process.env.HOME || '/root';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME_DIR, '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json');

const CLAUDE_MODEL_MAP: Record<string, string> = {
  'anthropic/sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
  'anthropic/opus-5': 'anthropic/claude-opus-5',
  'anthropic/claude-opus-5': 'anthropic/claude-opus-5',
  'anthropic/opus-4.8': 'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4.8': 'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4-8': 'anthropic/claude-opus-4-8',
  'anthropic/opus-4.6': 'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4-6': 'anthropic/claude-opus-4-6',
  'anthropic/haiku-4.5': 'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'anthropic/fable-5.1': 'anthropic/claude-fable-5-1',
  'anthropic/fable-5-1': 'anthropic/claude-fable-5-1',
  'anthropic/claude-fable-5.1': 'anthropic/claude-fable-5-1',
  'anthropic/claude-fable-5-1': 'anthropic/claude-fable-5-1',
  'anthropic/fable-5': 'anthropic/claude-fable-5',
  'anthropic/claude-fable-5': 'anthropic/claude-fable-5',
  'claude-cli/sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
  'claude-cli/opus-5': 'anthropic/claude-opus-5',
  'claude-cli/claude-opus-5': 'anthropic/claude-opus-5',
  'claude-cli/opus-4.8': 'anthropic/claude-opus-4-8',
  'claude-cli/claude-opus-4.8': 'anthropic/claude-opus-4-8',
  'claude-cli/claude-opus-4-8': 'anthropic/claude-opus-4-8',
  'claude-cli/opus-4.6': 'anthropic/claude-opus-4-6',
  'claude-cli/claude-opus-4.6': 'anthropic/claude-opus-4-6',
  'claude-cli/claude-opus-4-6': 'anthropic/claude-opus-4-6',
  'claude-cli/haiku-4.5': 'anthropic/claude-haiku-4-5',
  'claude-cli/claude-haiku-4.5': 'anthropic/claude-haiku-4-5',
  'claude-cli/claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'claude-cli/fable-5.1': 'anthropic/claude-fable-5-1',
  'claude-cli/fable-5-1': 'anthropic/claude-fable-5-1',
  'claude-cli/claude-fable-5.1': 'anthropic/claude-fable-5-1',
  'claude-cli/claude-fable-5-1': 'anthropic/claude-fable-5-1',
  'claude-cli/fable-5': 'anthropic/claude-fable-5',
  'claude-cli/claude-fable-5': 'anthropic/claude-fable-5',
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
  // google-gemini-cli/* is a legacy runtime-encoded model namespace.
  // OpenClaw 2026.7.1 persists canonical google/* refs and records the CLI
  // choice separately as agentRuntime.id="google-gemini-cli".
  'google-gemini-cli/gemini-3-flash': 'google/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-pro': 'google/gemini-3.1-pro-preview',
  'google-gemini-cli/gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',
  'google-gemini-cli/gemini-3.1-flash': 'google/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-flash-preview': 'google/gemini-3-flash-preview',
  'google-gemini-cli/gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',
  'google-gemini-cli/gemini-3.1-flash-lite-preview': 'google/gemini-3.1-flash-lite',
  'google-gemini-cli/gemini-3-flash-lite': 'google/gemini-3.1-flash-lite',
  'google-antigravity/gemini-3.5-flash-preview': 'google-antigravity/gemini-3.5-flash',
  'google-antigravity/gemini-3.1-pro-preview': 'google-antigravity/gemini-3.1-pro-high',
  'google-antigravity/gemini-3-pro-preview': 'google-antigravity/gemini-3.1-pro-high',
  'google-antigravity/gemini-3.1-flash-lite': 'google-antigravity/gemini-3.5-flash',
  'google-antigravity/gemini-3.1-flash-lite-preview': 'google-antigravity/gemini-3.5-flash',
};

// OpenClaw 2026.9.1 uses `openai/*` as the canonical model namespace.
// `codex/*` and `openai-codex/*` are retired refs; Codex execution intent is
// represented separately by model-scoped agentRuntime.id="codex" metadata.
const OPENAI_CODEX_MODEL_MAP: Record<string, string> = {
  // Astra is an exact, entitlement-sensitive model id. Do not map generic
  // `gpt-6` to it: account rollout and surface availability remain external.
  'gpt-6-astra': 'openai/gpt-6-astra',
  'openai/gpt-6-astra': 'openai/gpt-6-astra',
  'codex/gpt-6-astra': 'openai/gpt-6-astra',
  'openai-codex/gpt-6-astra': 'openai/gpt-6-astra',
  // Bare GPT-5.6 resolves to Sol, matching OpenClaw's fresh-setup default.
  'gpt-5.6': 'openai/gpt-5.6-sol',
  'openai/gpt-5.6': 'openai/gpt-5.6-sol',
  'codex/gpt-5.6': 'openai/gpt-5.6-sol',
  'openai-codex/gpt-5.6': 'openai/gpt-5.6-sol',
  // GPT-5.5 is OpenClaw's explicit compatibility choice for workspaces that
  // do not have GPT-5.6 access. Canonicalize legacy prefixes without silently
  // changing the selected model or its entitlement requirements.
  'gpt-5.5': 'openai/gpt-5.5',
  'openai/gpt-5.5': 'openai/gpt-5.5',
  'codex/gpt-5.5': 'openai/gpt-5.5',
  'openai-codex/gpt-5.5': 'openai/gpt-5.5',
  // Provider aliases may be repaired, but an explicit model selection is
  // entitlement-sensitive and must never be upgraded behind the user's back.
  // OpenClaw still exposes GPT-5.4, GPT-5.4 Mini/Pro, and GPT-5.5 Pro; its
  // legacy gpt-5.4-codex row canonicalizes to the exact GPT-5.4 model.
  'gpt-5.4-codex': 'openai/gpt-5.4',
  'openai-codex/gpt-5.5-pro': 'openai/gpt-5.5-pro',
  'openai-codex/gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'openai-codex/gpt-5.4-codex': 'openai/gpt-5.4',
  'openai-codex/gpt-5.4': 'openai/gpt-5.4',
  'openai-codex/gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'openai-codex/gpt-5.2-codex': 'openai/gpt-5.2',
  'codex/gpt-5.5-pro': 'openai/gpt-5.5-pro',
  'codex/gpt-5.4': 'openai/gpt-5.4',
  'codex/gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'codex/gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'openai/gpt-5.4': 'openai/gpt-5.4',
  'openai/gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'openai/gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'openai/gpt-5.4-codex': 'openai/gpt-5.4',
  'codex/gpt-5.2-codex': 'openai/gpt-5.2',
  'codex/gpt-5.4-codex': 'openai/gpt-5.4',
};

const CURRENT_CODEX_RUNTIME_MODELS = new Set([
  'gpt-6-astra',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-pro',
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
    return `openai/${mapped.slice('openai-codex/'.length)}`;
  }
  if (mapped.startsWith('codex/')) {
    return `openai/${mapped.slice('codex/'.length)}`;
  }
  if (mapped.startsWith('google-gemini-cli/')) {
    return `google/${mapped.slice('google-gemini-cli/'.length)}`;
  }
  return mapped;
}

export function normalizeOpenClawConfigModelId(rawModel: string | null | undefined): string {
  const normalized = normalizePortalModelId(rawModel);
  if (!normalized) return '';

  if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
    return `google/${normalized}`;
  }

  if (!normalized.includes('/') && CURRENT_CODEX_RUNTIME_MODELS.has(normalized)) {
    return `openai/${normalized}`;
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

function collectConfiguredMaintenanceModelCandidates(config: any): string[] {
  const candidates: string[] = [];
  const modelDefaults = config?.agents?.defaults?.model;
  const primary = normalizeOpenClawConfigModelId(modelDefaults?.primary || '');
  if (primary) candidates.push(primary);
  if (Array.isArray(modelDefaults?.fallbacks)) {
    candidates.push(...modelDefaults.fallbacks.map((model: unknown) => normalizeOpenClawConfigModelId(String(model || ''))));
  }
  const modelsRegistry = config?.agents?.defaults?.models;
  if (modelsRegistry && typeof modelsRegistry === 'object' && !Array.isArray(modelsRegistry)) {
    candidates.push(...Object.keys(modelsRegistry).map((model) => normalizeOpenClawConfigModelId(model)));
  }
  return uniqueStrings(candidates.filter(Boolean));
}

function isLegacyCodexModelRef(rawModel: string | null | undefined): boolean {
  const normalized = String(rawModel || '').trim().toLowerCase();
  return normalized.startsWith('codex/') || normalized.startsWith('openai-codex/');
}

function authProfileSelectsCodexRuntime(profileId: string, profile: any): boolean {
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  const provider = String(profile?.provider || '').trim().toLowerCase();
  const mode = String(profile?.mode || profile?.type || '').trim().toLowerCase();
  if (normalizedProfileId.includes('codex')) return true;
  if (provider === 'codex' || provider === 'codex-cli' || provider === 'openai-codex') return true;
  // OpenClaw 2026.9.1 migrates Codex CLI credentials to the canonical
  // openai:default OAuth profile. API-key profiles must not imply Codex.
  return provider === 'openai' && mode === 'oauth';
}

function authProfileBelongsToOpenAI(profileId: string, profile: any): boolean {
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  const provider = String(profile?.provider || '').trim().toLowerCase();
  return normalizedProfileId.startsWith('openai:')
    || normalizedProfileId.startsWith('openai-codex:')
    || normalizedProfileId.startsWith('codex:')
    || ['openai', 'openai-codex', 'codex', 'codex-cli'].includes(provider);
}

function collectAuthProfiles(config: any, authProfiles?: any): Record<string, any> {
  const configProfiles = config?.auth?.profiles && typeof config.auth.profiles === 'object'
    ? config.auth.profiles
    : {};
  const storedProfiles = authProfiles?.profiles && typeof authProfiles.profiles === 'object'
    ? authProfiles.profiles
    : {};
  return { ...configProfiles, ...storedProfiles };
}

function hasCodexAuthProfile(config: any, authProfiles?: any): boolean {
  const profiles = collectAuthProfiles(config, authProfiles);
  const configuredOpenAiOrder = config?.auth?.order?.openai;
  if (Array.isArray(configuredOpenAiOrder)) {
    return configuredOpenAiOrder.some((profileId: unknown) => {
      const id = String(profileId || '').trim();
      return Boolean(id) && authProfileSelectsCodexRuntime(id, profiles[id]);
    });
  }
  return Object.entries<any>(profiles).some(([profileId, profile]) => authProfileSelectsCodexRuntime(profileId, profile));
}

function authSelectionUnambiguouslyUsesCodex(config: any, authProfiles?: any): boolean {
  const profiles = collectAuthProfiles(config, authProfiles);
  const configuredOpenAiOrder = config?.auth?.order?.openai;
  if (Array.isArray(configuredOpenAiOrder)) {
    const openAiOrder = configuredOpenAiOrder
      .map((profileId: unknown) => String(profileId || '').trim())
      .filter(Boolean);
    if (openAiOrder.length === 0) return false;
    return openAiOrder.every((profileId: string) => authProfileSelectsCodexRuntime(profileId, profiles[profileId]));
  }

  const openAiProfiles = Object.entries<any>(profiles)
    .filter(([profileId, profile]) => authProfileBelongsToOpenAI(profileId, profile));
  return openAiProfiles.length > 0
    && openAiProfiles.every(([profileId, profile]) => authProfileSelectsCodexRuntime(profileId, profile));
}

function ensureCodexModelRuntimePolicy(
  entry: any,
  family: OpenClawAgentConfigFamily,
): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const currentRuntimeId = String(entry.agentRuntime?.id || '').trim().toLowerCase();
  if (family === '2026.7.1') {
    if (currentRuntimeId === 'codex' || currentRuntimeId === 'codex-cli') {
      delete entry.agentRuntime;
      return true;
    }
    return false;
  }
  // Match OpenClaw's route migration: explicit non-default policy wins.
  if (currentRuntimeId && !['auto', 'default', 'codex', 'codex-cli'].includes(currentRuntimeId)) {
    return false;
  }
  if (currentRuntimeId === 'codex') return false;
  entry.agentRuntime = {
    ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}),
    id: 'codex',
  };
  return true;
}

function ensureAstraSubscriptionTransport(config: any): boolean {
  const entry = config?.agents?.defaults?.models?.['openai/gpt-6-astra'];
  if (entry?.agentRuntime?.id !== 'codex') return false;
  // OpenClaw 9.1 predates Astra's ChatGPT route mapping. Scope this override to
  // Astra; ordinary OpenAI API-key models and credentials stay untouched.
  config.models ||= {};
  config.models.providers ||= {};
  const provider = config.models.providers.openai ||= { baseUrl: 'https://api.openai.com/v1', models: [] };
  provider.models = Array.isArray(provider.models) ? provider.models : [];
  let model = provider.models.find((row: any) => row?.id === 'gpt-6-astra');
  if (model?.api === 'openai-chatgpt-responses') return false;
  if (!model) {
    model = { id: 'gpt-6-astra', name: 'GPT-6 Astra' };
    provider.models.push(model);
  }
  model.api = 'openai-chatgpt-responses';
  return true;
}

function resolveSafeMaintenanceModel(config: any): string | null {
  const compactionModel = normalizeOpenClawConfigModelId(config?.agents?.defaults?.compaction?.model || '');
  if (compactionModel) return compactionModel;

  const candidates = collectConfiguredMaintenanceModelCandidates(config);
  const codexCandidate = candidates.find((model) => model.startsWith('openai/') || model.startsWith('codex/'));
  if (codexCandidate) return codexCandidate;
  if (hasCodexAuthProfile(config)) return 'openai/gpt-5.6-luna';

  return candidates.find((model) => !model.startsWith('anthropic/') && !model.startsWith('claude-cli/')) || null;
}

export function ensureMemoryFlushMaintenanceModel(config: any): { changed: boolean; model: string | null } {
  const defaults = config?.agents?.defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return { changed: false, model: null };
  }

  const maintenanceModel = resolveSafeMaintenanceModel(config);
  let changed = false;
  let compaction = defaults.compaction;
  if (!compaction || typeof compaction !== 'object' || Array.isArray(compaction)) {
    if (!maintenanceModel) return { changed: false, model: null };
    compaction = { model: maintenanceModel };
    defaults.compaction = compaction;
    changed = true;
  }

  const normalizedCompactionModel = normalizeOpenClawConfigModelId(compaction.model || '');
  if (!normalizedCompactionModel && maintenanceModel) {
    compaction.model = maintenanceModel;
    changed = true;
  } else if (normalizedCompactionModel && compaction.model !== normalizedCompactionModel) {
    // Migrate legacy refs (codex/* → openai/*) in place during repair.
    compaction.model = normalizedCompactionModel;
    changed = true;
  }

  let memoryFlush = compaction.memoryFlush;
  if (!memoryFlush || typeof memoryFlush !== 'object' || Array.isArray(memoryFlush)) {
    if (!maintenanceModel) return { changed, model: normalizeOpenClawConfigModelId(compaction.model || '') || null };
    memoryFlush = {};
    compaction.memoryFlush = memoryFlush;
    changed = true;
  }

  if (memoryFlush.enabled === false) {
    return { changed, model: normalizeOpenClawConfigModelId(memoryFlush.model || compaction.model || '') || null };
  }

  const existingModel = normalizeOpenClawConfigModelId(memoryFlush.model || '');
  if (existingModel) {
    if (existingModel !== memoryFlush.model) {
      memoryFlush.model = existingModel;
      return { changed: true, model: existingModel };
    }
    return { changed, model: existingModel };
  }

  const compactionModel = normalizeOpenClawConfigModelId(compaction.model || '') || maintenanceModel;
  if (!compactionModel) return { changed, model: null };

  memoryFlush.model = compactionModel;
  return { changed: true, model: compactionModel };
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
  addProviderAlias('google', 'google-gemini-cli');
  addProviderAlias('claude-cli', 'anthropic');
  addProviderAlias('anthropic', 'claude-cli');

  if (!normalized.includes('/')) {
    if (/^(gpt-|o\d|codex)/i.test(normalized)) {
      aliases.push(`openai/${normalized}`, `openai-codex/${normalized}`, `codex/${normalized}`);
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

  if (provider === 'google-gemini-cli') {
    if (normalized.startsWith('google/')) return normalized;
    if (normalized.startsWith('google-gemini-cli/')) {
      return `google/${normalized.slice('google-gemini-cli/'.length)}`;
    }
    if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
      return `google/${normalized}`;
    }
  }

  if (provider === 'google-antigravity') {
    if (normalized.startsWith('google/')) {
      const modelName = normalized.slice('google/'.length);
      return `${provider}/${antigravityModelName(modelName)}`;
    }
    if (normalized.startsWith('google-antigravity/') || normalized.startsWith('google-gemini-cli/')) {
      const modelName = normalized.replace(/^google-(?:antigravity|gemini-cli)\//, '');
      return `${provider}/${antigravityModelName(modelName)}`;
    }
    if (!normalized.includes('/') && normalized.startsWith('gemini-')) {
      return `${provider}/${antigravityModelName(normalized)}`;
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

  if (provider === 'openai-codex' || provider === 'codex' || provider === 'openai') {
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

  if (modelName === 'gpt-5.4-codex') return 'openai/gpt-5.4';
  if (CURRENT_CODEX_RUNTIME_MODELS.has(modelName)) return `openai/${modelName}`;
  return normalized;
}

export function modelForOpenClawSessionPatch(sessionInfo: any, portalModel: string): string {
  const normalizedPortalModel = normalizePortalModelId(portalModel);
  const runtimeHint = getOpenClawRuntimeHint(sessionInfo);
  const codexRuntime = /\bcodex\b/.test(runtimeHint) || isLegacyCodexModelRef(portalModel);
  const normalized = codexRuntime
    ? modelForCurrentCodexRuntime(normalizedPortalModel)
    : normalizedPortalModel;
  if (!normalized) return '';

  // Model namespace and runtime are separate in OpenClaw 2026.9.1. Legacy
  // Codex refs still become openai/*, but an ordinary OpenAI API session does
  // not become a Codex session merely because its model has that prefix.
  if (codexRuntime) {
    if (normalized.startsWith('openai/')) return normalized;
    if (normalized.startsWith('codex/')) return `openai/${normalized.slice('codex/'.length)}`;
    if (normalized.startsWith('openai-codex/')) return `openai/${normalized.slice('openai-codex/'.length)}`;
    if (/^(gpt-|o\d|codex)/i.test(normalized)) return `openai/${normalized}`;
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

// Recommended model declarations for already-authenticated providers. OpenClaw
// 2026.9.1 rejects sessions.patch for models missing from the
// agents.defaults.models allowlist, so installs that authenticated before a
// release must have new recommended models seeded during update repair.
// Claude Sonnet 5 is deliberately NOT recommended or seeded: on the claude-cli
// route OpenClaw 2026.7.1 gives mandatory-thinking Claude 5 models an off-only
// thinking profile, and session thinking patches validate against the DEFAULT
// model — a sonnet-5 default rejects every thinking change portal-wide, and
// sonnet-5 claude-cli turns currently return empty output.
const RECOMMENDED_CLAUDE_SUBSCRIPTION_MODELS = [
  'anthropic/claude-fable-5',
  'anthropic/claude-opus-5',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5',
];

const CLAUDE_CLI_UNUSABLE_DEFAULT_RE = /^anthropic\/claude-(sonnet|mythos)-5$/;

const RECOMMENDED_CODEX_SUBSCRIPTION_MODELS = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
];

// Astra is hidden by Codex model/list until the exact model is declared. Keep
// it separate from the cross-version recommendations so retained 7.1 hosts do
// not advertise a model their runtime cannot serve. This is declaration-only:
// account entitlement is established by an authenticated turn, never by the
// model/list row, and Astra is never inserted into primary or fallbacks.
const QUALIFIED_CODEX_2026_9_1_MODELS = [
  'openai/gpt-6-astra',
];

/**
 * Declare a model in agents.defaults.models so OpenClaw allows selecting it.
 * Declaration-only self-heal: it never touches the primary/fallback chain.
 */
export function ensureOpenClawModelDeclaration(rawModel: string): { changed: boolean; model: string } {
  const normalized = normalizeOpenClawConfigModelId(rawModel);
  if (!normalized || !normalized.includes('/')) return { changed: false, model: normalized };

  const config = readJson<any>(CONFIG_PATH, {});
  if (normalized === 'anthropic/claude-fable-5-1'
    && readOpenClawAgentConfigContract(config).family !== '2026.9.1') {
    return { changed: false, model: normalized };
  }
  const authProfiles = readJson<any>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
  const routesThroughCodex = normalized.startsWith('openai/')
    && (isLegacyCodexModelRef(rawModel) || authSelectionUnambiguouslyUsesCodex(config, authProfiles));
  const codexFamily = routesThroughCodex
    ? readOpenClawAgentConfigContract(config).family
    : null;
  if (normalized === 'openai/gpt-6-astra'
    && (!routesThroughCodex || codexFamily !== '2026.9.1')) {
    return { changed: false, model: normalized };
  }
  config.agents = config.agents && typeof config.agents === 'object' ? config.agents : {};
  config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === 'object' ? config.agents.defaults : {};
  const defaults = config.agents.defaults;
  defaults.models = defaults.models && typeof defaults.models === 'object' && !Array.isArray(defaults.models) ? defaults.models : {};

  let changed = false;
  let entry = defaults.models[normalized];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    entry = {};
    defaults.models[normalized] = entry;
    changed = true;
  }
  if (normalized.startsWith('anthropic/') && usesClaudeCliAuthProfile(config, authProfiles)) {
    if (String(entry.agentRuntime?.id || '').trim() !== 'claude-cli') {
      entry.agentRuntime = { ...(entry.agentRuntime && typeof entry.agentRuntime === 'object' ? entry.agentRuntime : {}), id: 'claude-cli' };
      changed = true;
    }
  }
  if (routesThroughCodex && codexFamily) {
    if (ensureCodexModelRuntimePolicy(entry, codexFamily)) changed = true;
  }

  if (routesThroughCodex && codexFamily === '2026.9.1' && normalized === 'openai/gpt-6-astra') {
    if (ensureAstraSubscriptionTransport(config)) changed = true;
  }
  if (changed) writeJson(CONFIG_PATH, config);
  return { changed, model: normalized };
}

export function repairClaudeSubscriptionConfig(preferredModel?: string | null): { changed: boolean; defaultModel: string | null } {
  const config = readJson<any>(CONFIG_PATH, {});
  const authProfiles = readJson<any>(AUTH_PROFILES_PATH, { version: 2, profiles: {} });
  let changed = false;
  const useClaudeCliRuntime = usesClaudeCliAuthProfile(config, authProfiles);
  const hasCodexSubscriptionProfile = hasCodexAuthProfile(config, authProfiles);
  const inferCodexRuntimeFromProfile = authSelectionUnambiguouslyUsesCodex(config, authProfiles);

  const rawCurrentDefault = String(config?.agents?.defaults?.model?.primary || '');
  const rawDesiredDefault = String(preferredModel || rawCurrentDefault);
  const existingModels = config?.agents?.defaults?.models || {};
  const requiresCodexContract = hasCodexSubscriptionProfile
    || isLegacyCodexModelRef(rawCurrentDefault)
    || isLegacyCodexModelRef(rawDesiredDefault)
    || Object.entries<any>(existingModels).some(([modelId, meta]) => (
      isLegacyCodexModelRef(modelId)
      || ['codex', 'codex-cli'].includes(String(meta?.agentRuntime?.id || '').trim().toLowerCase())
    ));
  const codexFamily = requiresCodexContract
    ? readOpenClawAgentConfigContract(config).family
    : (() => {
      if (!useClaudeCliRuntime) return undefined;
      try { return readOpenClawAgentConfigContract(config).family; }
      catch { return undefined; } // Unknown legacy layouts never seed 9.1-only models.
    })();
  const currentDefault = normalizeOpenClawConfigModelId(rawCurrentDefault);
  let desiredDefault = normalizeOpenClawConfigModelId(rawDesiredDefault || currentDefault);
  // A sonnet-5/mythos-5 default on the claude-cli runtime breaks every session:
  // thinking patches validate against the default model's off-only profile and
  // the CLI returns empty turns. Demote to Fable 5, which is proven working.
  if (useClaudeCliRuntime && CLAUDE_CLI_UNUSABLE_DEFAULT_RE.test(desiredDefault)) {
    desiredDefault = 'anthropic/claude-fable-5';
  }
  if (desiredDefault && config?.agents?.defaults?.model?.primary !== desiredDefault) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = config.agents.defaults.model || {};
    config.agents.defaults.model.primary = desiredDefault;
    changed = true;
  }

  const repairedModels: Record<string, any> = {};
  for (const [modelId, meta] of Object.entries<any>(existingModels)) {
    const normalizedModelId = normalizeOpenClawConfigModelId(modelId);
    if (!normalizedModelId) continue;
    // Drop declarations for models the claude-cli runtime cannot serve: their
    // off-only thinking profiles and empty turns only create broken choices.
    if (useClaudeCliRuntime && CLAUDE_CLI_UNUSABLE_DEFAULT_RE.test(normalizedModelId)) {
      changed = true;
      continue;
    }
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
    const originalRuntimeId = String(meta?.agentRuntime?.id || '').trim().toLowerCase();
    if (normalizedModelId.startsWith('openai/')
      && (inferCodexRuntimeFromProfile
        || isLegacyCodexModelRef(modelId)
        || originalRuntimeId === 'codex'
        || originalRuntimeId === 'codex-cli')
      && codexFamily
      && ensureCodexModelRuntimePolicy(repairedModels[normalizedModelId], codexFamily)) {
      changed = true;
    }
    if (normalizedModelId !== modelId) changed = true;
  }
  if (desiredDefault && !repairedModels[desiredDefault]) {
    repairedModels[desiredDefault] = {};
    if (useClaudeCliRuntime && desiredDefault.startsWith('anthropic/')) {
      repairedModels[desiredDefault].agentRuntime = { id: 'claude-cli' };
    } else if (desiredDefault.startsWith('openai/')
      && (inferCodexRuntimeFromProfile || isLegacyCodexModelRef(rawDesiredDefault))
      && codexFamily === '2026.9.1') {
      repairedModels[desiredDefault].agentRuntime = { id: 'codex' };
    }
    changed = true;
  } else if (desiredDefault?.startsWith('openai/')
    && (inferCodexRuntimeFromProfile || isLegacyCodexModelRef(rawDesiredDefault))
    && codexFamily
    && ensureCodexModelRuntimePolicy(repairedModels[desiredDefault], codexFamily)) {
    changed = true;
  }

  // Seed recommended model declarations for providers that already have auth,
  // so updates surface newly supported models (Fable 5, GPT-5.6) without
  // requiring the user to redo provider setup. Declarations only allow
  // selection; they never change the primary/fallback chain.
  if (useClaudeCliRuntime) {
    const claudeModels = codexFamily === '2026.9.1'
      ? ['anthropic/claude-fable-5-1', ...RECOMMENDED_CLAUDE_SUBSCRIPTION_MODELS]
      : RECOMMENDED_CLAUDE_SUBSCRIPTION_MODELS;
    for (const modelId of claudeModels) {
      if (!repairedModels[modelId]) {
        repairedModels[modelId] = { agentRuntime: { id: 'claude-cli' } };
        changed = true;
      }
    }
  }
  if (hasCodexSubscriptionProfile) {
    const subscriptionModels = codexFamily === '2026.9.1' && inferCodexRuntimeFromProfile
      ? [...QUALIFIED_CODEX_2026_9_1_MODELS, ...RECOMMENDED_CODEX_SUBSCRIPTION_MODELS]
      : RECOMMENDED_CODEX_SUBSCRIPTION_MODELS;
    for (const modelId of subscriptionModels) {
      if (!repairedModels[modelId]) {
        repairedModels[modelId] = inferCodexRuntimeFromProfile && codexFamily === '2026.9.1'
          ? { agentRuntime: { id: 'codex' } }
          : {};
        changed = true;
      } else if (inferCodexRuntimeFromProfile
        && codexFamily
        && ensureCodexModelRuntimePolicy(repairedModels[modelId], codexFamily)) {
        changed = true;
      }
    }
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
  const repairedFallbacks = uniqueStrings(fallbacks.map((model) => normalizeOpenClawConfigModelId(model)))
    .filter((model) => !(useClaudeCliRuntime && CLAUDE_CLI_UNUSABLE_DEFAULT_RE.test(model)));
  if (JSON.stringify(fallbacks) !== JSON.stringify(repairedFallbacks)) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = config.agents.defaults.model || {};
    config.agents.defaults.model.fallbacks = repairedFallbacks;
    changed = true;
  }

  if (codexFamily === '2026.9.1' && ensureAstraSubscriptionTransport(config)) changed = true;

  const memoryFlushRepair = ensureMemoryFlushMaintenanceModel(config);
  if (memoryFlushRepair.changed) changed = true;

  // Claude CLI oauth credentials are stored by OpenClaw with provider
  // "claude-cli". The runtime refuses to resolve a profile whose config
  // declaration names a different provider, so a declaration of "anthropic"
  // for a claude-cli profile fails with "No credentials found" despite a
  // valid token. Align existing declarations during install/update repair.
  if (useClaudeCliRuntime && config?.auth?.profiles && typeof config.auth.profiles === 'object') {
    for (const [profileId, profile] of Object.entries<any>(config.auth.profiles)) {
      if (!profileId.includes('claude-cli')) continue;
      if (!profile || typeof profile !== 'object') continue;
      if (String(profile.provider || '').trim() !== 'claude-cli') {
        profile.provider = 'claude-cli';
        changed = true;
      }
    }
  }

  if (changed) writeJson(CONFIG_PATH, config);
  return { changed, defaultModel: desiredDefault || null };
}
