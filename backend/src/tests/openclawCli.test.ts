import { canonicalizeProviderModelId, extractJsonFromCliOutput } from '../utils/openclawCli';

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

  test('extractJsonFromCliOutput strips non-JSON prefix noise', () => {
    const raw = '[agents/model-providers] refreshed\n[{"id":"gemini-2.5-pro"}]\n';
    const extracted = extractJsonFromCliOutput(raw);
    expect(JSON.parse(extracted)).toEqual([{ id: 'gemini-2.5-pro' }]);
  });
});
