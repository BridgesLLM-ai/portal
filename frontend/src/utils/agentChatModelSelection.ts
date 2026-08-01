import { canonicalizePortalModelId } from './modelId';

export function normalizeAgentChatProvider(rawProvider: unknown): string {
  return String(rawProvider || '').trim().toUpperCase();
}

export function isAgentZeroDefaultModelAlias(rawProvider: unknown, rawModel: unknown): boolean {
  return normalizeAgentChatProvider(rawProvider) === 'AGENT_ZERO'
    && /^(?:default|reset)$/i.test(String(rawModel || '').trim());
}

/**
 * Convert a catalog or user-entered model id into the exact shape expected by
 * the selected Agent Chat provider. OpenClaw uses qualified ids, while native
 * CLIs deliberately receive their own bare model names.
 */
export function normalizeAgentChatModelId(rawProvider: unknown, rawModel: unknown): string {
  const provider = normalizeAgentChatProvider(rawProvider);
  const model = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (!model) return '';

  if (provider === 'OPENCLAW') {
    return canonicalizePortalModelId(model);
  }

  // Ollama tags are opaque runtime identifiers. A local user may quite
  // legitimately name a tag `gpt-5.5` or `codex/gpt-5.5`; applying Portal's
  // OpenClaw alias rules would silently target a different, nonexistent tag.
  if (provider === 'OLLAMA') return model;

  if (provider === 'GEMINI') {
    const normalized = canonicalizePortalModelId(model).replace(/^models\//, '');
    for (const prefix of ['google-antigravity/', 'google-gemini-cli/', 'google/']) {
      if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
    }
    return normalized;
  }

  const lower = model.toLowerCase();
  const stripFirstSegment = () => model.split('/').slice(1).join('/') || model;
  if (provider === 'CLAUDE_CODE' && (lower.startsWith('anthropic/') || lower.startsWith('claude/'))) {
    return stripFirstSegment();
  }
  if (provider === 'CODEX' && (lower.startsWith('codex/') || lower.startsWith('openai-codex/') || lower.startsWith('openai/'))) {
    return stripFirstSegment();
  }
  if (provider === 'GROK' && (lower.startsWith('xai/') || lower.startsWith('grok/'))) {
    return stripFirstSegment();
  }

  // Agent Zero selections can be provider-scoped (for example
  // codex_oauth/gpt-5.5). Do not reinterpret that first segment as an
  // OpenClaw provider alias.
  return model;
}

export function normalizeAgentChatModelCatalog(
  provider: unknown,
  modelIds: unknown[],
): string[] {
  return Array.from(new Set(
    modelIds
      .map((modelId) => normalizeAgentChatModelId(provider, modelId))
      .filter(Boolean),
  ));
}

/**
 * Agent Zero is intentionally fail-closed: it must use one of the models
 * returned by its connected OAuth-account catalog. Keep a still-valid user
 * choice, otherwise choose the catalog's deterministic first entry.
 */
export function resolveAgentZeroCatalogModel(
  selectedModel: unknown,
  catalogModels: unknown[],
): string {
  const catalog = normalizeAgentChatModelCatalog('AGENT_ZERO', catalogModels);
  const selected = normalizeAgentChatModelId('AGENT_ZERO', selectedModel);
  if (selected && catalog.includes(selected)) return selected;
  return catalog[0] || '';
}
