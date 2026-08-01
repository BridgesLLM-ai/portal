const resolveOllamaBackendAuthority = jest.fn();
const requestResolvedOllamaJson = jest.fn();

jest.mock('../services/ollamaBackendAuthority', () => ({
  resolveOllamaBackendAuthority,
  requestResolvedOllamaJson,
}));

import {
  filterOpenClawSessionModelCatalog,
  GROK_BUILD_MODEL_ARGS,
  listProviderModels,
  mapAgentZeroOAuthModels,
  openClawCatalogCacheTtlMs,
  parseGrokModelsOutput,
  parseOpenClawModelsListPayload,
  reconcileOpenClawCatalogCache,
  type OpenClawModelCatalogCacheEntry,
} from '../agents/providerModels';
import { getProviderCapabilities } from '../agents/providerAvailability';

describe('provider model catalog curation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Agent Zero advertises an exact dynamic catalog without custom model input', () => {
    expect(getProviderCapabilities('AGENT_ZERO')).toMatchObject({
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: false,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
    });
  });

  test('OpenClaw live catalog parser keeps all available models and skips unavailable rows', () => {
    const models = parseOpenClawModelsListPayload({
      models: [
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', available: true },
        { key: 'google-gemini-cli/gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview', available: true, missing: false },
        { key: 'google/gemini-2.5-pro', name: 'gemini-2.5-pro', available: true, missing: false },
        { key: 'google-antigravity/gemini-3.1-pro-high', name: 'gemini-3.1-pro-high', available: true, missing: false },
        { key: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', available: true, missing: false },
        { key: 'anthropic/claude-fable-5', name: 'Claude Fable 5', available: true, missing: false },
        { key: 'anthropic/claude-old', name: 'Claude Old', available: false, missing: false },
        { key: 'google-gemini-cli/retired-model', name: 'Retired', available: true, missing: true },
      ],
    }).map((entry) => entry.id);

    expect(models).toEqual([
      'anthropic/claude-haiku-4-5',
      'google/gemini-3.1-pro-preview',
      'google/gemini-2.5-pro',
      'google-antigravity/gemini-3.1-pro-high',
      'openrouter/deepseek/deepseek-v3.2',
      'anthropic/claude-fable-5',
    ]);
  });

  test('OpenClaw Agent Chat catalog hides models that sessions.patch cannot select', () => {
    const models = parseOpenClawModelsListPayload({
      models: [
        { key: 'codex/gpt-5.5', name: 'GPT-5.5', available: true },
        { key: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', available: true },
        { key: 'openai/gpt-5.5', name: 'GPT-5.5 OpenAI', available: true },
        { key: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', available: true },
        { key: 'anthropic/claude-fable-5', name: 'Claude Fable 5', available: true },
        { key: 'google-gemini-cli/gemini-3-flash-preview', name: 'Gemini 3 Flash', available: true },
        { key: 'xai/grok-4.3', name: 'Grok 4.3', available: true },
      ],
    });

    expect(filterOpenClawSessionModelCatalog(models).map((entry) => entry.id)).toEqual([
      'openai/gpt-5.5',
      'openai/gpt-5.4-mini',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-fable-5',
      'google/gemini-3-flash-preview',
      'xai/grok-4.3',
    ]);
  });

  test('Grok Build model parser accepts only the native CLI catalog grammar', () => {
    expect(GROK_BUILD_MODEL_ARGS).toEqual(['--no-auto-update', 'models']);
    expect(parseGrokModelsOutput([
      'Default model: grok-build',
      'Available models:',
      '* grok-build (default)',
      '- grok-4.5',
      '- grok-4.5',
      '- ../../not-a-model',
      'arbitrary prose',
    ].join('\n'))).toEqual([
      expect.objectContaining({ id: 'grok-build', provider: 'grok', source: 'dynamic' }),
      expect.objectContaining({ id: 'grok-4.5', provider: 'grok', source: 'dynamic' }),
    ]);
  });

  test('Agent Zero model rows retain exact OAuth provider/model identifiers', () => {
    expect(mapAgentZeroOAuthModels([{
      id: 'codex_oauth/gpt-5.3-codex',
      providerId: 'codex_oauth',
      model: 'gpt-5.3-codex',
      displayName: 'GPT-5.3 Codex',
      providerDisplayName: 'OpenAI Codex OAuth',
      description: '',
    }])).toEqual([{
      id: 'codex_oauth/gpt-5.3-codex',
      alias: null,
      provider: 'codex_oauth',
      displayName: 'OpenAI Codex OAuth — GPT-5.3 Codex',
      source: 'dynamic',
    }]);
  });

  test('Codex Project Chat uses the centralized subscription catalog and preserves GPT-5.5', async () => {
    const models = await listProviderModels('CODEX');

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openai/gpt-5.6-sol', displayName: 'GPT-5.6 Sol', provider: 'codex' }),
      expect.objectContaining({ id: 'openai/gpt-5.6-terra', provider: 'codex' }),
      expect.objectContaining({ id: 'openai/gpt-5.6-luna', provider: 'codex' }),
      expect.objectContaining({ id: 'openai/gpt-5.5', displayName: 'GPT-5.5', provider: 'codex' }),
    ]));
    expect(models.every((model) => model.source === 'declared')).toBe(true);
  });

  test('Claude Code Project Chat exposes only the authoritative Anthropic catalog', async () => {
    const models = await listProviderModels('CLAUDE_CODE');

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'anthropic/claude-fable-5',
        displayName: 'Claude Fable 5',
        provider: 'claude-code',
      }),
      expect.objectContaining({ id: 'anthropic/claude-sonnet-4-6', provider: 'claude-code' }),
    ]));
    expect(models.every((model) => model.source === 'declared')).toBe(true);
  });

  test('Ollama catalog uses one resolved authority snapshot', async () => {
    const authority = {
      kind: 'LOCAL',
      source: 'local-policy',
      endpoint: 'http://127.0.0.1:11434',
      generation: null,
      version: null,
      bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      selectedModel: null,
      selectedModelDigest: null,
    };
    const resolved = {
      authority,
      bindingView: { purposeId: 'PRIMARY', authority: null, candidate: null },
    };
    resolveOllamaBackendAuthority.mockResolvedValue(resolved);
    requestResolvedOllamaJson.mockResolvedValue({
      authority,
      value: { models: [{ name: 'qwen3.5:4b' }] },
    });

    await expect(listProviderModels('OLLAMA')).resolves.toEqual([
      expect.objectContaining({ id: 'qwen3.5:4b', provider: 'ollama', source: 'dynamic' }),
    ]);
    expect(requestResolvedOllamaJson).toHaveBeenCalledWith(
      resolved,
      {
        path: '/api/tags',
        method: 'GET',
        timeoutMs: 5_000,
        maxResponseBytes: 2 * 1024 * 1024,
      },
    );
  });

  test('Tailnet Agent Chat catalog exposes only the exact active remote model', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const authority = {
      kind: 'TAILNET',
      source: 'tailnet-binding',
      endpoint: null,
      generation: 3,
      version: 2,
      bindingFingerprint: 'binding-fingerprint',
      selectedModel: 'qwen3.5:4b',
      selectedModelDigest: digest,
    };
    resolveOllamaBackendAuthority.mockResolvedValue({
      authority,
      bindingView: { purposeId: 'PRIMARY', authority: {}, candidate: null },
    });
    requestResolvedOllamaJson.mockResolvedValue({
      authority,
      value: {
        models: [
          { name: 'other:latest', digest: 'b'.repeat(64) },
          { name: 'qwen3.5:4b', digest: 'a'.repeat(64) },
          { name: 'other:latest', digest: 'b'.repeat(64) },
          { name: '../invalid model' },
        ],
      },
    });

    await expect(listProviderModels('OLLAMA')).resolves.toEqual([
      expect.objectContaining({ id: 'qwen3.5:4b' }),
    ]);
  });

  test('a healthy zero-model Tailnet catalog stays empty without a local or declared fallback', async () => {
    const authority = {
      kind: 'TAILNET',
      source: 'tailnet-binding',
      endpoint: null,
      generation: 4,
      version: 1,
      bindingFingerprint: 'empty-binding-fingerprint',
      selectedModel: null,
      selectedModelDigest: null,
    };
    const resolved = {
      authority,
      bindingView: { purposeId: 'PRIMARY', authority: {}, candidate: null },
    };
    resolveOllamaBackendAuthority.mockResolvedValue(resolved);
    requestResolvedOllamaJson.mockResolvedValue({
      authority,
      value: { models: [] },
    });

    await expect(listProviderModels('OLLAMA')).resolves.toEqual([]);
    expect(resolveOllamaBackendAuthority).toHaveBeenCalledTimes(1);
    expect(requestResolvedOllamaJson).toHaveBeenCalledWith(
      resolved,
      expect.objectContaining({ path: '/api/tags', method: 'GET' }),
    );
  });

  test('a degraded OpenClaw catalog refresh never overwrites the last live catalog', () => {
    const liveModel = {
      id: 'openai/gpt-5.6-sol',
      alias: null,
      provider: 'openai',
      displayName: 'gpt-5.6-sol',
      source: 'dynamic' as const,
    };
    const fallbackModel = { ...liveModel, id: 'anthropic/claude-fable-5', displayName: 'claude-fable-5' };

    const live = reconcileOpenClawCatalogCache(null, { at: 1_000, models: [liveModel], live: true });
    expect(live).toMatchObject({ models: [liveModel], liveData: true, lastRefreshLive: true });

    // CLI/gateway flake: the previous live catalog is preserved, and the
    // entry retries on the shorter degraded cadence instead of the full TTL.
    const preserved = reconcileOpenClawCatalogCache(live, { at: 2_000, models: [fallbackModel], live: false });
    expect(preserved).toMatchObject({ at: 2_000, models: [liveModel], liveData: true, lastRefreshLive: false });
    expect(openClawCatalogCacheTtlMs(preserved)).toBeLessThan(openClawCatalogCacheTtlMs(live));

    // Recovery replaces the preserved data with the fresh live catalog.
    const recovered = reconcileOpenClawCatalogCache(preserved, { at: 3_000, models: [fallbackModel], live: true });
    expect(recovered).toMatchObject({ models: [fallbackModel], liveData: true, lastRefreshLive: true });

    // A host that has never had live discovery keeps its degraded catalog.
    const coldDegraded: OpenClawModelCatalogCacheEntry = reconcileOpenClawCatalogCache(
      null,
      { at: 4_000, models: [fallbackModel], live: false },
    );
    expect(coldDegraded).toMatchObject({ models: [fallbackModel], liveData: false, lastRefreshLive: false });
  });
});
