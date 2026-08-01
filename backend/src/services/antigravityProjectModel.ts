import { listProviderModels, type ProviderModelDescriptor } from '../agents/providerModels';
import { normalizeAntigravityProjectModel } from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';

export class AntigravityProjectModelSelectionError extends Error {
  readonly code = 'ANTIGRAVITY_PROJECT_MODEL_UNAVAILABLE';

  constructor(message = 'The requested Antigravity model is not available for Project Chat.') {
    super(message);
    this.name = 'AntigravityProjectModelSelectionError';
  }
}

function normalizedModel(value: string | null | undefined): string {
  return normalizeAntigravityProjectModel(value) || '';
}

export function resolveAntigravityProjectModelFromCatalog(input: {
  catalog: readonly ProviderModelDescriptor[];
  candidates: Array<string | null | undefined>;
  explicitModel?: string | null;
}): string {
  const accepted = new Map<string, string>();
  for (const entry of input.catalog) {
    const canonical = normalizedModel(entry.id);
    if (!canonical) continue;
    accepted.set(canonical, canonical);
    const alias = normalizedModel(entry.alias);
    if (alias) accepted.set(alias, canonical);
  }

  const explicit = normalizedModel(input.explicitModel);
  if (explicit) {
    const selected = accepted.get(explicit);
    if (!selected) throw new AntigravityProjectModelSelectionError();
    return selected;
  }

  for (const candidate of input.candidates) {
    const normalized = normalizedModel(candidate);
    const selected = normalized ? accepted.get(normalized) : null;
    if (selected) return selected;
  }

  const fallback = input.catalog.map((entry) => normalizedModel(entry.id)).find(Boolean);
  if (!fallback) {
    throw new AntigravityProjectModelSelectionError(
      'Antigravity did not expose an allowed Project model catalog.',
    );
  }
  return fallback;
}

export async function resolveAllowedAntigravityProjectModel(
  candidates: Array<string | null | undefined>,
  explicitModel?: string | null,
  listModels: typeof listProviderModels = listProviderModels,
): Promise<string> {
  const catalog = await listModels('GEMINI');
  return resolveAntigravityProjectModelFromCatalog({ catalog, candidates, explicitModel });
}
