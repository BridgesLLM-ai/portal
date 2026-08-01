import type { ProviderModelDescriptor } from '../agents/providerModels';
import {
  CodexProjectModelSelectionError,
  codexCliModelId,
  resolveAllowedCodexProjectModel,
  resolveCodexProjectModelFromCatalog,
} from './codexProjectModel';

const catalog: ProviderModelDescriptor[] = [
  {
    id: 'openai/gpt-5.6-sol',
    alias: 'sol',
    provider: 'codex',
    displayName: 'GPT-5.6 Sol',
    source: 'declared',
  },
  {
    id: 'openai/gpt-5.5',
    alias: null,
    provider: 'codex',
    displayName: 'GPT-5.5',
    source: 'declared',
  },
];

describe('Codex Project model selection', () => {
  test('accepts only exact catalog IDs or their declared aliases', () => {
    expect(resolveCodexProjectModelFromCatalog({
      catalog,
      candidates: [],
      explicitModel: 'sol',
    })).toBe('openai/gpt-5.6-sol');

    expect(() => resolveCodexProjectModelFromCatalog({
      catalog,
      candidates: ['openai/gpt-5.6-sol'],
      explicitModel: 'openai/not-entitled',
    })).toThrow(CodexProjectModelSelectionError);
  });

  test('uses a still-allowed prior binding before the catalog default', () => {
    expect(resolveCodexProjectModelFromCatalog({
      catalog,
      candidates: ['openai/deprecated', 'openai/gpt-5.5'],
    })).toBe('openai/gpt-5.5');
  });

  test('fails closed when no catalog is available', async () => {
    const listModels = jest.fn(async () => []);
    await expect(resolveAllowedCodexProjectModel([], null, listModels))
      .rejects.toThrow(/did not expose an allowed Project model catalog/i);
    expect(listModels).toHaveBeenCalledWith('CODEX');
  });

  test('converts only the Portal provider prefix for the confined CLI invocation', () => {
    expect(codexCliModelId('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(codexCliModelId('codex/gpt-5.5')).toBe('gpt-5.5');
    expect(codexCliModelId('custom-model')).toBe('custom-model');
    expect(codexCliModelId('')).toBeUndefined();
  });
});
