export function normalizeModelId(rawModel: unknown): string {
  if (typeof rawModel === 'string') {
    return rawModel.trim();
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
    return `${provider}/${directModel}`;
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
