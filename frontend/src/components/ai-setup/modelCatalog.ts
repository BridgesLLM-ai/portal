import type { SelectableModel } from './ModelSelector';
import { canonicalizePortalModelId } from '../../utils/modelId';

export function getModelFamilyKey(modelId: string | null | undefined): string {
  const normalized = canonicalizePortalModelId(modelId || '');
  if (!normalized) return '';
  if (normalized.startsWith('google-gemini-cli/')) {
    return `google/${normalized.slice('google-gemini-cli/'.length)}`;
  }
  if (normalized.startsWith('openai-codex/')) {
    return `openai/${normalized.slice('openai-codex/'.length)}`;
  }
  return normalized;
}

export function mergeModelCatalog(discovered: SelectableModel[], presets: SelectableModel[]): SelectableModel[] {
  const presetByFamily = new Map(presets.map((model) => [getModelFamilyKey(model.id), model]));
  const seenFamilies = new Set<string>();
  const merged: SelectableModel[] = [];

  for (const model of discovered) {
    const family = getModelFamilyKey(model.id);
    if (!family || seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    const preset = presetByFamily.get(family);
    merged.push({
      ...preset,
      ...model,
      id: model.id,
      name: model.name || preset?.name || model.id,
      description: model.description || preset?.description || model.id,
      tier: preset?.tier || model.tier,
    });
  }

  for (const preset of presets) {
    const family = getModelFamilyKey(preset.id);
    if (!family || seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    merged.push(preset);
  }

  return merged;
}

export function pickPreferredModel(models: SelectableModel[]): string | null {
  return models.find((model) => model.tier === 'balanced')?.id || models[0]?.id || null;
}
