import {
  getProviderAuthAliases,
  getStaleProviderProfileIds,
  hasAnthropicClaudeCliReferences,
  isClaudeCliModelId,
  mergeProviderRuntimeCatalog,
  removeInvalidRuntimeOnlyModelProviderConfigs,
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

  test('keeps Gemini CLI and Antigravity auth profiles separate', () => {
    expect(Array.from(getProviderAuthAliases('google-gemini-cli'))).toEqual(['google-gemini-cli']);
    expect(Array.from(getProviderAuthAliases('google-antigravity'))).toEqual(['google-antigravity']);

    const stale = getStaleProviderProfileIds({
      'google-gemini-cli:default': { provider: 'google-gemini-cli' },
      'google-antigravity:default': { provider: 'google-antigravity' },
    }, 'google-gemini-cli', 'google-gemini-cli:default');

    expect(stale).toEqual([]);
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

  test('removes runtime-only providers that would make OpenClaw config.patch invalid', () => {
    const cleanup = removeInvalidRuntimeOnlyModelProviderConfigs({
      models: {
        providers: {
          anthropic: { baseUrl: 'https://api.anthropic.com', models: [] },
          'google-gemini-cli': {
            models: [{ id: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' }],
          },
          'google-antigravity': {
            models: [{ id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' }],
          },
        },
      },
    });

    expect(cleanup.removedProviders).toEqual(['google-gemini-cli', 'google-antigravity']);
    expect(cleanup.config.models.providers).toEqual({
      anthropic: { baseUrl: 'https://api.anthropic.com', models: [] },
    });
  });

  test('keeps explicit runtime-provider HTTP configs intact', () => {
    const cleanup = removeInvalidRuntimeOnlyModelProviderConfigs({
      models: {
        providers: {
          'google-gemini-cli': {
            baseUrl: 'https://example.invalid/v1',
            api: 'google-generative-ai',
            models: [],
          },
        },
      },
    });

    expect(cleanup.removedProviders).toEqual([]);
    expect(cleanup.config.models.providers['google-gemini-cli'].baseUrl).toBe('https://example.invalid/v1');
  });
});
