import { parseOpenClawModelsListPayload } from '../agents/providerModels';

describe('provider model catalog curation', () => {
  test('OpenClaw live catalog parser keeps all available models and skips unavailable rows', () => {
    const models = parseOpenClawModelsListPayload({
      models: [
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', available: true },
        { key: 'google-gemini-cli/gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview', available: true, missing: false },
        { key: 'google/gemini-2.5-pro', name: 'gemini-2.5-pro', available: true, missing: false },
        { key: 'google-antigravity/gemini-3.1-pro-high', name: 'gemini-3.1-pro-high', available: true, missing: false },
        { key: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', available: true, missing: false },
        { key: 'anthropic/claude-old', name: 'Claude Old', available: false, missing: false },
        { key: 'google-gemini-cli/retired-model', name: 'Retired', available: true, missing: true },
      ],
    }).map((entry) => entry.id);

    expect(models).toEqual([
      'anthropic/claude-haiku-4-5',
      'google-gemini-cli/gemini-3.1-pro-preview',
      'google/gemini-2.5-pro',
      'google-antigravity/gemini-3.1-pro-high',
      'openrouter/deepseek/deepseek-v3.2',
    ]);
  });
});
