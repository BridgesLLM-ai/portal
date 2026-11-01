// With no provider connected, OpenClaw's live catalog reports
// every model unavailable. The Agent Chat picker then lists nothing this server
// cannot run (and reports the hidden models), instead of the declared catalog
// whose every entry answered 502 when picked. With no answer at all, the
// declared fallback is unchanged.
const listGatewayModels = jest.fn();
const readOpenClawConfig = jest.fn(() => ({}));

jest.mock('../utils/openclawGatewayRpc', () => ({ listGatewayModels }));
jest.mock('../services/openclawConfigManager', () => ({ readOpenClawConfig }));
jest.mock('../services/openclawSetupReadiness', () => ({ getOpenClawSetupReadiness: jest.fn(async () => null) }));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  // `openclaw models list --json` is never run here: the CLI fallback answers nothing.
  execFile: jest.fn((...args: any[]) => { args[args.length - 1](new Error('no CLI in this test')); }),
}));

type ProviderModels = typeof import('../agents/providerModels');

function freshProviderModels(): ProviderModels {
  let loaded: ProviderModels | undefined;
  jest.isolateModules(() => { loaded = require('../agents/providerModels'); });
  return loaded!;
}

describe('OpenClaw picker catalog when no provider is connected', () => {
  beforeEach(() => {
    listGatewayModels.mockReset();
    readOpenClawConfig.mockReset();
    readOpenClawConfig.mockReturnValue({});
  });

  test('every model unavailable: nothing is offered and the hidden models are reported', async () => {
    listGatewayModels.mockResolvedValue({ ok: true, models: [
      { key: 'openai/gpt-6.1-sol', provider: 'openai', available: false },
      { key: 'google/gemini-3-flash-preview', provider: 'google', available: false },
    ] });
    const catalog = freshProviderModels();
    expect(await catalog.listProviderModels('OPENCLAW')).toEqual([]);
    expect(catalog.readLastOpenClawUnavailableModelIds()).toEqual(['google/gemini-3-flash-preview', 'openai/gpt-6.1-sol']);
  });

  test('enabled models whose provider is not connected are not offered either', async () => {
    readOpenClawConfig.mockReturnValue({ agents: { defaults: { models: { 'openai/gpt-6.1-sol': {} } } } });
    listGatewayModels.mockResolvedValue({ ok: true, models: [{ key: 'openai/gpt-6.1-sol', provider: 'openai', available: false }] });
    expect(await freshProviderModels().listProviderModels('OPENCLAW')).toEqual([]);
  });

  test('a connected provider\'s models are offered as before', async () => {
    listGatewayModels.mockResolvedValue({ ok: true, models: [
      { key: 'anthropic/claude-fable-5', provider: 'anthropic', available: true },
      { key: 'openai/gpt-6.1-sol', provider: 'openai', available: false },
    ] });
    expect((await freshProviderModels().listProviderModels('OPENCLAW')).map((model) => model.id)).toEqual(['anthropic/claude-fable-5']);
  });

  test('no answer from OpenClaw keeps the declared fallback', async () => {
    listGatewayModels.mockResolvedValue({ ok: false, models: [] });
    expect((await freshProviderModels().listProviderModels('OPENCLAW')).length).toBeGreaterThan(0);
  });
});
