import { matchesProviderModel, mergeDiscoveredProviderModelsIntoConfig, normalizeModelPayload } from '../routes/ai-setup';

describe('ai-setup model normalization', () => {
  test('does not prefix providerHint onto already-prefixed string model ids', () => {
    expect(normalizeModelPayload(['openai-codex/gpt-5.4'], 'google-gemini-cli')).toEqual([
      {
        id: 'openai-codex/gpt-5.4',
        name: 'openai-codex/gpt-5.4',
        provider: 'openai-codex',
      },
    ]);
  });

  test('does not incorrectly force another provider onto providerless gateway payload rows', () => {
    expect(normalizeModelPayload([{ name: 'gpt-5.5' }], 'google-gemini-cli')).toEqual([
      {
        id: 'gpt-5.5',
        name: 'gpt-5.5',
        provider: undefined,
        raw: { name: 'gpt-5.5' },
      },
    ]);
  });

  test('keeps explicit provider ids on object payloads when filtering by another provider', () => {
    expect(normalizeModelPayload([{ id: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }], 'google-gemini-cli')).toEqual([
      {
        id: 'openrouter/deepseek/deepseek-v3.2',
        name: 'DeepSeek V3.2',
        provider: 'openrouter',
        raw: { id: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' },
      },
    ]);
  });

  test('still prefixes providerHint for bare runtime ids', () => {
    expect(normalizeModelPayload(['gemini-2.5-pro'], 'google-gemini-cli')).toEqual([
      {
        id: 'google-gemini-cli/gemini-2.5-pro',
        name: 'google-gemini-cli/gemini-2.5-pro',
        provider: 'google-gemini-cli',
      },
    ]);
  });

  test('rewrites same-family OpenAI rows into the Codex namespace when filtering for Codex OAuth', () => {
    expect(normalizeModelPayload([{ id: 'openai/gpt-5.5', provider: 'openai', name: 'GPT-5.5' }], 'openai-codex')).toEqual([
      {
        id: 'openai-codex/gpt-5.5',
        name: 'GPT-5.5',
        provider: 'openai-codex',
        raw: { id: 'openai/gpt-5.5', provider: 'openai', name: 'GPT-5.5' },
      },
    ]);
  });

  test('rewrites same-family Gemini rows into the Gemini CLI namespace when filtering for Gemini OAuth', () => {
    expect(normalizeModelPayload([{ id: 'google/gemini-2.5-flash', provider: 'google', name: 'Gemini 2.5 Flash' }], 'google-gemini-cli')).toEqual([
      {
        id: 'google-gemini-cli/gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        provider: 'google-gemini-cli',
        raw: { id: 'google/gemini-2.5-flash', provider: 'google', name: 'Gemini 2.5 Flash' },
      },
    ]);
  });

  test('register merge persists discovered provider models into allowlist and fallbacks', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-5.5',
            fallbacks: ['openai/gpt-5.4'],
          },
          models: {
            'openai-codex/gpt-5.5': {},
          },
        },
      },
    }, 'openai-codex', [
      'openai-codex/gpt-5.5',
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.4-mini',
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.addedAllowlist).toEqual(['openai-codex/gpt-5.4', 'openai-codex/gpt-5.4-mini']);
    expect(merged.addedFallbacks).toEqual(['openai-codex/gpt-5.4-mini']);
    expect(merged.config.agents.defaults.model.fallbacks).toEqual([
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.4-mini',
    ]);
  });

  test('register merge preserves Gemini CLI provider namespace before persisting models', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({}, 'google-gemini-cli', [
      'google-gemini-cli/gemini-3.1-flash',
      'google-gemini-cli/gemini-3.1-pro-preview',
    ]);

    expect(merged.config.agents.defaults.models).toMatchObject({
      'google-gemini-cli/gemini-3-flash-preview': {},
      'google-gemini-cli/gemini-3.1-pro-preview': {},
    });
    expect(merged.config.agents.defaults.model.fallbacks).toEqual([
      'google-gemini-cli/gemini-3-flash-preview',
      'google-gemini-cli/gemini-3.1-pro-preview',
    ]);
  });

  test('provider filter accepts google runtime alias models from the gateway catalog', () => {
    expect(matchesProviderModel('google-gemini-cli', 'google/gemini-3.1-pro-preview')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'google-gemini-cli/gemini-3.1-pro-preview')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'openai/gpt-5.4')).toBe(false);
    expect(matchesProviderModel('google-gemini-cli', 'google-gemini-cli/openai/gpt-5.4')).toBe(false);
  });

  test('provider filter accepts OpenAI runtime alias models from the gateway catalog', () => {
    expect(matchesProviderModel('openai-codex', 'openai/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'openai-codex/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'google/gemini-3.1-pro-preview')).toBe(false);
    expect(matchesProviderModel('openai-codex', 'openai-codex/google/gemini-3.1-pro-preview')).toBe(false);
  });
});
