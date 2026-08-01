import { listProviderModels, type ProviderModelDescriptor } from '../agents/providerModels';
import { normalizePortalModelId } from '../utils/openclawCli';

export class CodexProjectModelSelectionError extends Error {
  readonly code = 'CODEX_PROJECT_MODEL_UNAVAILABLE';

  constructor(message = 'The requested Codex model is not available for Project Chat.') {
    super(message);
    this.name = 'CodexProjectModelSelectionError';
  }
}

export function codexCliModelId(model: string | null | undefined): string | undefined {
  const normalized = normalizePortalModelId(String(model || ''));
  if (!normalized) return undefined;
  if (normalized.startsWith('openai/')) return normalized.slice('openai/'.length);
  if (normalized.startsWith('codex/')) return normalized.slice('codex/'.length);
  return normalized;
}

export function resolveCodexProjectModelFromCatalog(input: {
  catalog: readonly ProviderModelDescriptor[];
  candidates: Array<string | null | undefined>;
  explicitModel?: string | null;
}): string {
  const accepted = new Map<string, string>();
  for (const entry of input.catalog) {
    const canonical = normalizePortalModelId(entry.id);
    if (!canonical) continue;
    accepted.set(canonical, canonical);
    const alias = normalizePortalModelId(entry.alias || '');
    if (alias) accepted.set(alias, canonical);
  }

  const explicit = normalizePortalModelId(input.explicitModel || '');
  if (explicit) {
    const selected = accepted.get(explicit);
    if (!selected) throw new CodexProjectModelSelectionError();
    return selected;
  }

  for (const candidate of input.candidates) {
    const normalized = normalizePortalModelId(candidate || '');
    const selected = normalized ? accepted.get(normalized) : null;
    if (selected) return selected;
  }

  const fallback = input.catalog
    .map((entry) => normalizePortalModelId(entry.id))
    .find(Boolean);
  if (!fallback) {
    throw new CodexProjectModelSelectionError('Codex did not expose an allowed Project model catalog.');
  }
  return fallback;
}

export async function resolveAllowedCodexProjectModel(
  candidates: Array<string | null | undefined>,
  explicitModel?: string | null,
  listModels: typeof listProviderModels = listProviderModels,
): Promise<string> {
  const catalog = await listModels('CODEX');
  return resolveCodexProjectModelFromCatalog({ catalog, candidates, explicitModel });
}
