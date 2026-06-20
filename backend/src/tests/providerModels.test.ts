import { curateOpenClawModelDescriptors, type ProviderModelDescriptor } from '../agents/providerModels';

function model(id: string): ProviderModelDescriptor {
  return {
    id,
    alias: null,
    provider: id.split('/')[0] || 'other',
    displayName: id,
    source: 'dynamic',
  };
}

describe('provider model catalog curation', () => {
  test('OpenClaw visible catalog filters stale and unsupported registered models', () => {
    const curated = curateOpenClawModelDescriptors([
      model('google-gemini-cli/gemini-3.1-pro-preview'),
      model('google/gemini-2.5-pro'),
      model('google-antigravity/gemini-3.1-pro-high'),
      model('openai/gpt-5.5'),
      model('openai-codex/gpt-5.4'),
      model('codex/gpt-5.5'),
      model('codex/gpt-5.4-mini'),
      model('anthropic/claude-opus-4-8'),
      model('anthropic/claude-sonnet-4-6'),
      model('anthropic/claude-haiku-4-5'),
      model('openrouter/deepseek/deepseek-v3.2'),
    ]).map((entry) => entry.id);

    expect(curated).toEqual([
      'codex/gpt-5.5',
      'codex/gpt-5.4',
      'codex/gpt-5.4-mini',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-haiku-4-5',
    ]);
  });
});
