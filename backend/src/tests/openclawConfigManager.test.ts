import {
  getProviderAuthAliases,
  getStaleProviderProfileIds,
  hasAnthropicClaudeCliReferences,
  isClaudeCliModelId,
  mergeProviderRuntimeCatalog,
} from '../services/openclawConfigManager';

describe('openclawConfigManager Claude CLI helpers', () => {
  test('detects claude-cli model ids', () => {
    expect(isClaudeCliModelId('claude-cli/claude-sonnet-4-6')).toBe(true);
    expect(isClaudeCliModelId('anthropic/claude-sonnet-4-6')).toBe(false);
    expect(isClaudeCliModelId(null)).toBe(false);
  });

  test('detects anthropic Claude CLI references from primary model', () => {
    expect(hasAnthropicClaudeCliReferences({
      agents: { defaults: { model: { primary: 'claude-cli/claude-sonnet-4-6' } } },
    })).toBe(true);
  });

  test('detects anthropic Claude CLI references from fallbacks and model registry', () => {
    expect(hasAnthropicClaudeCliReferences({
      agents: {
        defaults: {
          model: { fallbacks: ['openai/gpt-4.1', 'claude-cli/claude-haiku-4-5'] },
          models: {
            'claude-cli/claude-sonnet-4-6': { enabled: true },
          },
        },
      },
    })).toBe(true);
  });

  test('does not report Claude CLI references when none exist', () => {
    expect(hasAnthropicClaudeCliReferences({
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4.1', fallbacks: ['anthropic/claude-sonnet-4-6'] },
          models: {
            'anthropic/claude-sonnet-4-6': { enabled: true },
          },
        },
      },
    })).toBe(false);
  });
});

describe('openclawConfigManager auth profile cleanup helpers', () => {
  test('marks stale same-provider Codex profiles without touching OpenAI API-key profiles', () => {
    const stale = getStaleProviderProfileIds({
      'openai-codex:default': { provider: 'openai-codex' },
      'openai-codex:user@example.com': { provider: 'openai-codex' },
      'openai:default': { provider: 'openai' },
      'google-gemini-cli:default': { provider: 'google-gemini-cli' },
    }, 'openai-codex', 'openai-codex:user@example.com');

    expect(stale).toEqual(['openai-codex:default']);
  });

  test('treats Claude CLI imports as Anthropic profiles for replacement cleanup', () => {
    const stale = getStaleProviderProfileIds({
      'anthropic:manual': { provider: 'anthropic' },
      'anthropic:claude-cli': { provider: 'claude-cli' },
      'openai-codex:default': { provider: 'openai-codex' },
    }, 'anthropic', 'anthropic:claude-cli');

    expect(stale).toEqual(['anthropic:manual']);
  });

  test('uses the same Anthropic cleanup aliases when called from the Claude CLI provider side', () => {
    expect(Array.from(getProviderAuthAliases('claude-cli')).sort()).toEqual(['anthropic', 'claude-cli']);
  });
});

describe('openclawConfigManager runtime model catalog helpers', () => {
  test('registers Antigravity models without converting the runtime provider into an HTTP API provider', () => {
    const merged = mergeProviderRuntimeCatalog('google-antigravity', {}, [
      'google-antigravity/gemini-3.5-flash',
      'google-antigravity/gemini-3.1-pro-high',
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.addedModels).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro-high',
    ]);
    expect(merged.nextProviderConfig).toEqual({
      models: [
        { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' },
        { id: 'gemini-3.1-pro-high', name: 'gemini-3.1-pro-high' },
      ],
    });
  });

  test('keeps API provider endpoint config while adding runtime catalog models', () => {
    const merged = mergeProviderRuntimeCatalog('google', { models: ['google/gemini-3.1-flash-lite'] }, [
      'google/gemini-3.1-pro-preview',
    ]);

    expect(merged.nextProviderConfig).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      api: 'google-generative-ai',
      auth: 'api-key',
      models: [
        { id: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite' },
        { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview' },
      ],
    });
  });

  test('ignores unknown providers instead of creating invalid catalog entries', () => {
    const existing = { models: [{ id: 'custom-model', name: 'Custom Model' }] };
    const merged = mergeProviderRuntimeCatalog('unknown-provider', existing, ['unknown-provider/new-model']);

    expect(merged.changed).toBe(false);
    expect(merged.addedModels).toEqual([]);
    expect(merged.nextProviderConfig).toBe(existing);
  });
});
