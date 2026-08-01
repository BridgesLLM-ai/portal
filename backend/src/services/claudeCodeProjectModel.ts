import { listProviderModels, type ProviderModelDescriptor } from '../agents/providerModels';
import { normalizePortalModelId } from '../utils/openclawCli';

export class ClaudeCodeProjectModelSelectionError extends Error {
  readonly code = 'CLAUDE_CODE_PROJECT_MODEL_UNAVAILABLE';

  constructor(message = 'The requested Claude Code model is not available for Project Chat.') {
    super(message);
    this.name = 'ClaudeCodeProjectModelSelectionError';
  }
}

export function claudeCodeCliModelId(model: string | null | undefined): string | undefined {
  const normalized = normalizePortalModelId(String(model || ''));
  if (!normalized) return undefined;
  if (normalized.startsWith('anthropic/')) return normalized.slice('anthropic/'.length);
  if (normalized.startsWith('claude-cli/')) return normalized.slice('claude-cli/'.length);
  return normalized;
}

export function resolveClaudeCodeProjectModelFromCatalog(input: {
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
    if (!selected) throw new ClaudeCodeProjectModelSelectionError();
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
    throw new ClaudeCodeProjectModelSelectionError(
      'Claude Code did not expose an allowed Project model catalog.',
    );
  }
  return fallback;
}

export async function resolveAllowedClaudeCodeProjectModel(
  candidates: Array<string | null | undefined>,
  explicitModel?: string | null,
  listModels: typeof listProviderModels = listProviderModels,
): Promise<string> {
  const catalog = await listModels('CLAUDE_CODE');
  return resolveClaudeCodeProjectModelFromCatalog({ catalog, candidates, explicitModel });
}
