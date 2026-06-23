import {
  canonicalizeProviderModelId,
  extractJsonFromCliOutput,
  modelForOpenClawSessionPatch,
  normalizeOpenClawConfigModelId,
  resolvePortalModelFromCatalog,
  usesClaudeCliAuthProfile,
} from '../utils/openclawCli';

describe('openclawCli helpers', () => {
  test('canonicalizeProviderModelId prefixes provider-specific runtime ids', () => {
    expect(canonicalizeProviderModelId('google', 'models/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-pro-preview')).toBe('google-gemini-cli/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3-flash')).toBe('google-antigravity/gemini-3.5-flash');
    expect(canonicalizeProviderModelId('openrouter', 'anthropic/claude-sonnet-4-6')).toBe('openrouter/anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('anthropic', 'claude-cli/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.5')).toBe('codex/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai-codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'google/gemini-2.5-pro')).toBe('google-gemini-cli/gemini-2.5-pro');
    expect(canonicalizeProviderModelId('google-antigravity', 'google-gemini-cli/gemini-3-flash')).toBe('google-antigravity/gemini-3.5-flash');
  });

  test('canonicalizeProviderModelId repairs provider-owned alias subtleties', () => {
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash')).toBe('google-gemini-cli/gemini-3-flash-preview');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash-lite-preview')).toBe('google-gemini-cli/gemini-3.1-flash-lite');
    expect(canonicalizeProviderModelId('google', 'google-gemini-cli/gemini-3.1-flash-lite-preview')).toBe('google/gemini-3.1-flash-lite');
    expect(canonicalizeProviderModelId('google', 'gemini-3.1-pro')).toBe('google/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3.1-pro-preview')).toBe('google-antigravity/gemini-3.1-pro-high');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3-pro-preview')).toBe('google-antigravity/gemini-3.1-pro-high');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.4-codex')).toBe('codex/gpt-5.5');
  });

  test('normalizeOpenClawConfigModelId repairs OpenClaw doctor provider drift conservatively', () => {
    expect(normalizeOpenClawConfigModelId('google/gemini-3-flash-preview')).toBe('google-antigravity/gemini-3-flash-preview');
    expect(normalizeOpenClawConfigModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(normalizeOpenClawConfigModelId('openai/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(normalizeOpenClawConfigModelId('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });

  test('usesClaudeCliAuthProfile detects OpenClaw 2026.6 config auth metadata', () => {
    expect(usesClaudeCliAuthProfile({
      auth: {
        profiles: {
          'anthropic:claude-cli': { provider: 'anthropic', mode: 'oauth' },
        },
        order: {
          anthropic: ['anthropic:claude-cli'],
        },
      },
    })).toBe(true);
    expect(usesClaudeCliAuthProfile({ auth: { profiles: { 'anthropic:api': { provider: 'anthropic', mode: 'api_key' } } } })).toBe(false);
  });

  test('resolvePortalModelFromCatalog chooses live catalog aliases and rejects unavailable full ids', () => {
    const catalog = ['openai/gpt-5.5', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4-6'];
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', catalog)).toBe('codex/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['openai/gpt-5.5', 'openai-codex/gpt-5.5'])).toBe('codex/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['codex/gpt-5.5', 'openai/gpt-5.5'])).toBe('codex/gpt-5.5');
    expect(resolvePortalModelFromCatalog('gpt-5.4', catalog)).toBe('codex/gpt-5.5');
    expect(resolvePortalModelFromCatalog('google-gemini-cli/gemini-2.5-flash', catalog)).toBe('');
  });

  test('modelForOpenClawSessionPatch maps OpenAI-family Codex aliases to current runtime ids', () => {
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.4-mini' },
      'openai/gpt-5.4-mini',
    )).toBe('codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { modelProvider: 'openai-codex', model: 'gpt-5.5' },
      'openai-codex/gpt-5.5',
    )).toBe('codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai-codex', model: 'gpt-5.5' },
      'gpt-5.5',
    )).toBe('codex/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('codex/gpt-5.5');
  });

  test('modelForOpenClawSessionPatch keeps Claude CLI runtime sessions on allowed Anthropic catalog ids', () => {
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'claude-cli' }, modelProvider: 'anthropic', model: 'claude-sonnet-4-6' },
      'anthropic/claude-sonnet-4-6',
    )).toBe('anthropic/claude-sonnet-4-6');
    expect(modelForOpenClawSessionPatch(
      { agentRuntimeOverride: 'claude-cli', modelProvider: 'anthropic', model: 'claude-haiku-4-5' },
      'claude-cli/claude-haiku-4-5',
    )).toBe('anthropic/claude-haiku-4-5');
  });

  test('extractJsonFromCliOutput strips non-JSON prefix noise', () => {
    const raw = '[agents/model-providers] refreshed\n[{"id":"gemini-2.5-pro"}]\n';
    const extracted = extractJsonFromCliOutput(raw);
    expect(JSON.parse(extracted)).toEqual([{ id: 'gemini-2.5-pro' }]);
  });
});
