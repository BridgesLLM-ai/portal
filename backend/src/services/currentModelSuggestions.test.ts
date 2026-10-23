import { ProviderActivationService } from './providerActivation';

test('suggests only ready exact account routes after sign-in without changing defaults or probing a model', async () => {
  const config = { agents: { defaults: { model: { primary: 'other/keep' }, models: {} } } };
  const rpc = jest.fn(async (method: string) => {
    if (method === 'config.get') return { ok: true, data: { config, hash: 'fixture', valid: true } };
    if (method === 'openclaw.setup.detect') return { ok: true, data: { candidates: [] } };
    if (method === 'models.list') return { ok: true, data: { models: [
      { id: 'gpt-6-astra', provider: 'openai', available: false, agentRuntime: { id: 'codex' } },
      { id: 'gpt-6.1-sol', provider: 'openai', available: true, agentRuntime: { id: 'codex' } },
      { id: 'gpt-6-luna', provider: 'openai', agentRuntime: { id: 'codex' } },
      { id: 'claude-haiku-5-5', provider: 'anthropic', available: true, agentRuntime: { id: 'claude-cli' } },
    ] } };
    throw new Error('Unexpected mutation/probe: ' + method);
  });
  const service = new ProviderActivationService(rpc as any, async () => {}, async () => []);
  const catalog = await service.discover('openai-codex', true);
  expect(catalog.suggestions).toEqual([{ id: 'openai/gpt-6.1-sol', reason: 'Coding and everyday work' }]);
  expect(catalog.models).toHaveLength(3);
  expect(config.agents.defaults.model.primary).toBe('other/keep');
  expect(rpc.mock.calls.map(([method]) => method).sort()).toEqual(['config.get', 'models.list', 'openclaw.setup.detect']);
  expect((await service.discover('anthropic')).suggestions).toEqual([{ id: 'anthropic/claude-haiku-5-5', reason: 'Fast, lower-cost Claude work' }]);
});

test('current Claude suggestions include Sonnet and Opus 5.5 only when the native catalog reports them ready', async () => {
  const { suggestReadyModels } = await import('./currentModelSuggestions');
  expect(suggestReadyModels([
    { id: 'anthropic/claude-sonnet-4-6', ready: true },
    { id: 'anthropic/claude-opus-5-5', ready: true },
    { id: 'anthropic/claude-sonnet-5-5', ready: true },
    { id: 'anthropic/claude-haiku-5-5', ready: false },
  ])).toEqual([
    { id: 'anthropic/claude-sonnet-5-5', reason: 'Balanced Claude work' },
    { id: 'anthropic/claude-opus-5-5', reason: 'Complex coding and reasoning' },
  ]);
});

test('a legacy local CLI login fallback does not manufacture account-specific suggestions', async () => {
  const rpc = jest.fn(async (method: string) => {
    if (method === 'config.get') return { ok: true, data: { config: {}, hash: 'fixture', valid: true } };
    if (method === 'openclaw.setup.detect') return { ok: true, data: { candidates: [{ kind: 'codex-cli' }] } };
    if (method === 'models.list') return { ok: true, data: { models: [
      { id: 'gpt-6.1-sol', provider: 'openai', available: false },
    ] } };
    throw new Error('Unexpected mutation/probe: ' + method);
  });
  const service = new ProviderActivationService(rpc as any, async () => {}, async () => [
    { runtime: 'codex', loginPresent: true, models: ['openai/gpt-6.1-sol'] },
  ]);
  const result = await service.discover('openai-codex', true);
  expect(result.suggestions).toEqual([]);
  expect(rpc.mock.calls.map(([method]) => method).sort()).toEqual(['config.get', 'models.list', 'openclaw.setup.detect']);
});
