import { normalizeModelPayload } from '../routes/ai-setup';

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
});
