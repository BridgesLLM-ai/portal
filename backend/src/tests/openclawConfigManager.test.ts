import {
  getProviderAuthAliases,
  getStaleProviderProfileIds,
  hasAnthropicClaudeCliReferences,
  isClaudeCliModelId,
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
