import type { ProviderModelDescriptor } from '../agents/providerModels';
import {
  AntigravityProjectModelSelectionError,
  resolveAntigravityProjectModelFromCatalog,
} from './antigravityProjectModel';

const catalog: ProviderModelDescriptor[] = [{
  id: 'gemini-3.1-pro-high',
  alias: null,
  provider: 'gemini',
  displayName: 'Gemini 3.1 Pro High',
  source: 'declared',
}];

describe('Antigravity Project model selection', () => {
  it('normalizes legacy Portal identities through the Project runtime normalizer', () => {
    expect(resolveAntigravityProjectModelFromCatalog({
      catalog,
      candidates: [],
      explicitModel: 'google/gemini-3.1-pro-preview',
    })).toBe('gemini-3.1-pro-high');
  });

  it('rejects model identities outside the exposed catalog', () => {
    expect(() => resolveAntigravityProjectModelFromCatalog({
      catalog,
      candidates: [],
      explicitModel: 'gemini-invented-99',
    })).toThrow(AntigravityProjectModelSelectionError);
  });
});
