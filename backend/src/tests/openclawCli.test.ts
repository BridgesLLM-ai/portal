import { canonicalizeProviderModelId, extractJsonFromCliOutput, modelForOpenClawSessionPatch, resolvePortalModelFromCatalog } from '../utils/openclawCli';

describe('openclawCli helpers', () => {
  test('canonicalizeProviderModelId prefixes provider-specific runtime ids', () => {
    expect(canonicalizeProviderModelId('google', 'models/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-pro-preview')).toBe('google-gemini-cli/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('openrouter', 'anthropic/claude-sonnet-4-6')).toBe('openrouter/anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('anthropic', 'claude-cli/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.5')).toBe('openai-codex/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai/gpt-5.5')).toBe('openai-codex/gpt-5.5');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'google/gemini-2.5-pro')).toBe('google-gemini-cli/gemini-2.5-pro');
  });

  test('canonicalizeProviderModelId repairs provider-owned alias subtleties', () => {
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash')).toBe('google-gemini-cli/gemini-3-flash-preview');
    expect(canonicalizeProviderModelId('google', 'gemini-3.1-pro')).toBe('google/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.4-codex')).toBe('openai-codex/gpt-5.4');
  });

  test('resolvePortalModelFromCatalog chooses live catalog aliases and rejects unavailable full ids', () => {
    const catalog = ['openai/gpt-5.5', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4-6'];
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', catalog)).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['openai/gpt-5.5', 'openai-codex/gpt-5.5'])).toBe('openai-codex/gpt-5.5');
    expect(resolvePortalModelFromCatalog('gpt-5.4', catalog)).toBe('openai/gpt-5.4');
    expect(resolvePortalModelFromCatalog('google-gemini-cli/gemini-2.5-flash', catalog)).toBe('');
  });

  test('modelForOpenClawSessionPatch keeps Codex runtime sessions in the Codex model family', () => {
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('openai-codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { modelProvider: 'openai-codex', model: 'gpt-5.5' },
      'openai-codex/gpt-5.5',
    )).toBe('openai-codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai-codex', model: 'gpt-5.5' },
      'gpt-5.5',
    )).toBe('openai-codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('openai/gpt-5.5');
  });

  test('extractJsonFromCliOutput strips non-JSON prefix noise', () => {
    const raw = '[agents/model-providers] refreshed\n[{"id":"gemini-2.5-pro"}]\n';
    const extracted = extractJsonFromCliOutput(raw);
    expect(JSON.parse(extracted)).toEqual([{ id: 'gemini-2.5-pro' }]);
  });
});
