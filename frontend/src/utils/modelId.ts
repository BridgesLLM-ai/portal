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
  const mapped = CLAUDE_MODEL_MAP[model.toLowerCase()] || model;
  if (mapped.startsWith('claude-cli/')) {
    return `anthropic/${mapped.slice('claude-cli/'.length)}`;
  }
  return mapped;
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
    .replace(/(^|[-_/])(opus|sonnet|haiku)(?=$|[-_/])/gi, (_, prefix, word) => `${prefix}${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
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
    case 'google': return 'Google';
    case 'google-gemini-cli': return 'Gemini CLI';
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
    case 'openai-codex': return 'CLI OAuth';
    case 'google-gemini-cli': return 'CLI OAuth';
    case 'ollama': return 'Local';
    case 'openrouter': return 'Router';
    default: return null;
  }
}

export function getModelIdBadge(rawModel: unknown): string {
  return normalizeModelId(rawModel);
}
