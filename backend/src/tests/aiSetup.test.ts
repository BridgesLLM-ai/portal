import { classifyProviderRuntimeFailure, getProviderDefaultModelPayload, matchesProviderModel, mergeDiscoveredProviderModelsIntoConfig, normalizeModelPayload } from '../routes/ai-setup';

describe('ai-setup model normalization', () => {
  test('does not prefix providerHint onto already-prefixed string model ids', () => {
    expect(normalizeModelPayload(['openai-codex/gpt-5.4'], 'google-gemini-cli')).toEqual([
      {
        id: 'codex/gpt-5.5',
        name: 'codex/gpt-5.5',
        provider: 'codex',
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

  test('rewrites same-family OpenAI rows into the current Codex namespace when filtering for Codex OAuth', () => {
    expect(normalizeModelPayload([{ id: 'openai/gpt-5.5', provider: 'openai', name: 'GPT-5.5' }], 'openai-codex')).toEqual([
      {
        id: 'codex/gpt-5.5',
        name: 'GPT-5.5',
        provider: 'openai-codex',
        raw: { id: 'openai/gpt-5.5', provider: 'openai', name: 'GPT-5.5' },
      },
    ]);
  });

  test('rewrites same-family Gemini rows into the Antigravity namespace when filtering for Antigravity', () => {
    expect(normalizeModelPayload([{ id: 'google/gemini-3-flash', provider: 'google', name: 'Gemini 3 Flash' }], 'google-antigravity')).toEqual([
      {
        id: 'google-antigravity/gemini-3.5-flash',
        name: 'Gemini 3 Flash',
        provider: 'google-antigravity',
        raw: { id: 'google/gemini-3-flash', provider: 'google', name: 'Gemini 3 Flash' },
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
      'codex/gpt-5.5',
      'openai/gpt-5.4',
      'openai/gpt-5.4-mini',
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.addedAllowlist).toEqual([]);
    expect(merged.addedFallbacks).toEqual([]);
    expect(merged.config.agents.defaults.model.fallbacks).toEqual([]);
    expect(merged.config.agents.defaults.models['codex/gpt-5.5']).toEqual({ agentRuntime: { id: 'codex' } });
  });

  test('register merge repairs Codex model-scoped runtime metadata', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'openai-codex/gpt-5.5', fallbacks: [] },
          models: {
            'openai/gpt-5.5': { agentRuntime: { id: 'codex' } },
            'openai-codex/gpt-5.5': { agentRuntime: { id: 'pi' } },
          },
        },
      },
    }, 'openai-codex', ['codex/gpt-5.5']);

    expect(merged.changed).toBe(true);
    expect(merged.addedAllowlist).toEqual([]);
    expect(merged.addedFallbacks).toEqual([]);
    expect(merged.config.agents.defaults.models['openai/gpt-5.5']).toEqual({});
    expect(merged.config.agents.defaults.models['codex/gpt-5.5']).toEqual({ agentRuntime: { id: 'codex' } });
  });

  test('register merge preserves Antigravity provider namespace before persisting models', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({}, 'google-antigravity', [
      'google-antigravity/gemini-3.5-flash',
      'google-antigravity/gemini-3.1-pro-high',
    ]);

    expect(merged.config.agents.defaults.models).toMatchObject({
      'google-antigravity/gemini-3.5-flash': {},
      'google-antigravity/gemini-3.1-pro-high': {},
    });
    expect(merged.config.agents.defaults.model.fallbacks).toEqual([
      'google-antigravity/gemini-3.5-flash',
      'google-antigravity/gemini-3.1-pro-high',
    ]);
  });

  test('register merge removes stale Claude CLI runtime metadata from Anthropic models', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-haiku-4-5', fallbacks: [] },
          models: {
            'anthropic/claude-haiku-4-5': { agentRuntime: { id: 'claude-cli' } },
          },
        },
      },
    }, 'anthropic', ['anthropic/claude-haiku-4-5'], { version: 2, profiles: {} });

    expect(merged.changed).toBe(true);
    expect(merged.config.agents.defaults.models['anthropic/claude-haiku-4-5']).toEqual({});
  });

  test('provider filter accepts google runtime alias models from the gateway catalog', () => {
    expect(matchesProviderModel('google-antigravity', 'google/gemini-3-flash')).toBe(true);
    expect(matchesProviderModel('google-antigravity', 'google-gemini-cli/gemini-3-flash')).toBe(true);
    expect(matchesProviderModel('google-antigravity', 'google-antigravity/gemini-3.5-flash')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'google/gemini-3.1-pro-preview')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'google-gemini-cli/gemini-3.1-pro-preview')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'openai/gpt-5.4')).toBe(false);
    expect(matchesProviderModel('google-gemini-cli', 'google-gemini-cli/openai/gpt-5.4')).toBe(false);
  });

  test('provider filter accepts OpenAI runtime alias models from the gateway catalog', () => {
    expect(matchesProviderModel('openai-codex', 'openai/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'openai-codex/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'codex/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'google/gemini-3.1-pro-preview')).toBe(false);
    expect(matchesProviderModel('openai-codex', 'openai-codex/google/gemini-3.1-pro-preview')).toBe(false);
  });

  test('setup model fallback exposes provider defaults without requiring OpenClaw model discovery', () => {
    expect(getProviderDefaultModelPayload('openai-codex').map((model) => model.id)).toContain('codex/gpt-5.5');
    expect(getProviderDefaultModelPayload('anthropic').map((model) => model.id)).toContain('anthropic/claude-fable-5');
    expect(getProviderDefaultModelPayload('google-antigravity').map((model) => model.id)).toContain('google-antigravity/gemini-3.1-pro-high');
    expect(getProviderDefaultModelPayload(null)).toEqual([]);
  });

  test('register merge pins Fable 5 to the Claude CLI runtime when Claude OAuth is available', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'codex/gpt-5.5', fallbacks: [] },
          models: {},
        },
      },
    }, 'anthropic', ['anthropic/claude-fable-5'], {
      version: 2,
      profiles: {
        'anthropic:claude-cli': { provider: 'anthropic', type: 'oauth' },
      },
    });

    expect(merged.changed).toBe(true);
    expect(merged.config.agents.defaults.models['anthropic/claude-fable-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    expect(merged.config.agents.defaults.model.fallbacks).toEqual(['anthropic/claude-fable-5']);
  });

  test('Gemini CLI smoke failures get user-actionable messages', () => {
    expect(classifyProviderRuntimeFailure('FatalAuthenticationError: Manual authorization is required but the current session is non-interactive.')).toContain('server-side auth is not usable headlessly');
    expect(classifyProviderRuntimeFailure('IneligibleTierError: UNSUPPORTED_CLIENT')).toContain('Google rejected this Gemini CLI account/client');
  });
});
