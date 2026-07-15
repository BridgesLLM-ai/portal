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
  'anthropic/fable-5': 'anthropic/claude-fable-5',
  'anthropic/claude-fable-5': 'anthropic/claude-fable-5',
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

// OpenClaw 2026.7.1 makes openai/* the canonical Codex-runtime route;
// codex/* and openai-codex/* are legacy refs that normalize forward.
const OPENAI_CODEX_MODEL_MAP: Record<string, string> = {
  'gpt-5.6': 'openai/gpt-5.6-sol',
  'openai/gpt-5.6': 'openai/gpt-5.6-sol',
  'codex/gpt-5.6': 'openai/gpt-5.6-sol',
  'openai-codex/gpt-5.6': 'openai/gpt-5.6-sol',
  'gpt-5.4-codex': 'openai/gpt-5.5',
  'openai-codex/gpt-5.5-pro': 'openai/gpt-5.5',
  'openai-codex/gpt-5.4': 'openai/gpt-5.5',
  'openai-codex/gpt-5.4-mini': 'openai/gpt-5.5',
  'openai-codex/gpt-5.4-pro': 'openai/gpt-5.5',
  'openai-codex/gpt-5.4-codex': 'openai/gpt-5.5',
  'openai-codex/gpt-5.2-codex': 'openai/gpt-5.2',
  'codex/gpt-5.5-pro': 'openai/gpt-5.5',
  'codex/gpt-5.4': 'openai/gpt-5.5',
  'codex/gpt-5.4-mini': 'openai/gpt-5.5',
  'codex/gpt-5.4-pro': 'openai/gpt-5.5',
  'openai/gpt-5.4': 'openai/gpt-5.5',
  'openai/gpt-5.4-mini': 'openai/gpt-5.5',
  'openai/gpt-5.4-pro': 'openai/gpt-5.5',
  'openai/gpt-5.4-codex': 'openai/gpt-5.5',
  'codex/gpt-5.2-codex': 'openai/gpt-5.2',
  'codex/gpt-5.4-codex': 'openai/gpt-5.5',
};

function titleCase(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

export function canonicalizePortalModelId(rawModel: unknown): string {
  if (typeof rawModel !== 'string') return '';
  const model = rawModel.trim();
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
  return mapped;
}

function uniqueModelIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => canonicalizePortalModelId(value)).filter(Boolean)));
}

export function getPortalModelCatalogAliases(rawModel: unknown): string[] {
  const normalized = canonicalizePortalModelId(rawModel);
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

  return uniqueModelIds(aliases);
}

export function resolvePortalModelFromCatalog(rawModel: unknown, availableModels: string[]): string {
  const aliases = getPortalModelCatalogAliases(rawModel);
  if (!aliases.length) return '';

  const catalog = uniqueModelIds(availableModels);
  if (!catalog.length) return aliases[0];

  for (const alias of aliases) {
    if (catalog.includes(alias)) return alias;
  }

  const normalized = canonicalizePortalModelId(rawModel);
  if (normalized && !normalized.includes('/')) {
    const suffix = `/${normalized}`;
    const suffixMatch = catalog.find((model) => model.endsWith(suffix));
    if (suffixMatch) return suffixMatch;
  }

  return '';
}

export function normalizeModelId(rawModel: unknown): string {
  if (typeof rawModel === 'string') {
    return canonicalizePortalModelId(rawModel);
  }

  if (!rawModel) return '';

  if (Array.isArray(rawModel)) {
    for (const entry of rawModel) {
      const normalized = normalizeModelId(entry);
      if (normalized) return normalized;
    }
    return '';
  }

  if (typeof rawModel !== 'object') return '';

  const record = rawModel as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const directModel = normalizeModelId(record.model);
  if (provider && directModel && !directModel.includes('/')) {
    return canonicalizePortalModelId(`${provider}/${directModel}`);
  }

  const candidates = [
    record.primary,
    record.currentModel,
    record.defaultModel,
    record.id,
    record.name,
    record.fallbacks,
    directModel,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeModelId(candidate);
    if (normalized) return normalized;
  }

  return '';
}

export function getShortModelLabel(rawModel: unknown, fallback = ''): string {
  const modelId = normalizeModelId(rawModel);
  if (!modelId) return fallback;
  return modelId.includes('/') ? modelId.split('/').slice(-1)[0] : modelId;
}

export function getModelDisplayName(rawModel: unknown, fallback = 'Default model'): string {
  const modelId = normalizeModelId(rawModel);
  if (!modelId) return fallback;
  const parts = modelId.split('/');
  const slug = parts.length >= 2 ? parts.slice(1).join('/') : parts[0];
  return slug
    .replace(/^claude-/, '')
    .replace(/(^|[-_/])(opus|sonnet|haiku|fable)(?=$|[-_/])/gi, (_, prefix, word) => `${prefix}${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .replace(/(^|[-_/])(gpt|gemini|llama|kimi|qwen|grok|deepseek)(?=$|[-_/])/gi, (_, prefix, word) => `${prefix}${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .replace(/[-_/]+/g, ' ')
    .replace(/\b(\d) (\d)\b/g, '$1.$2')
    .replace(/\b4 6\b/g, '4.6')
    .replace(/\b4 5\b/g, '4.5')
    .replace(/\b3 7\b/g, '3.7')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getModelProviderLabel(rawModel: unknown): string {
  const modelId = normalizeModelId(rawModel);
  const provider = modelId.split('/')[0] || '';
  switch (provider) {
    case 'anthropic': return 'Anthropic';
    case 'claude-cli': return 'Claude CLI';
    case 'openai': return 'OpenAI';
    case 'openai-codex': return 'Codex';
    case 'codex': return 'Codex';
    case 'google': return 'Google';
    case 'google-gemini-cli': return 'Gemini CLI';
    case 'google-antigravity': return 'Antigravity';
    case 'openrouter': return 'OpenRouter';
    case 'ollama': return 'Ollama';
    default: return provider ? titleCase(provider) : 'Model';
  }
}

export function getModelRuntimeLabel(rawModel: unknown): string | null {
  const modelId = normalizeModelId(rawModel);
  const provider = modelId.split('/')[0] || '';
  switch (provider) {
    case 'anthropic': return 'API/OAuth';
    case 'claude-cli': return 'CLI';
    case 'openai': return 'Codex';
    case 'openai-codex': return 'CLI OAuth';
    case 'codex': return 'CLI OAuth';
    case 'google-gemini-cli': return 'CLI OAuth';
    case 'google-antigravity': return 'CLI OAuth';
    case 'ollama': return 'Local';
    case 'openrouter': return 'Router';
    default: return null;
  }
}

export function getModelIdBadge(rawModel: unknown): string {
  return normalizeModelId(rawModel);
}
