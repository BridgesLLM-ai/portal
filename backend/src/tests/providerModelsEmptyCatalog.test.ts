// With no provider connected, OpenClaw 2026.10.6 answers the
// catalog with an EMPTY list (gateway models.list `{models: [], refreshFailed:
// true}`, `openclaw models list --json` count 0) instead of models marked
// unavailable, and the picker served the declared catalog. A successful empty
// answer now means "no runnable models": nothing is offered and the existing
// "N models hidden" note names the models from OpenClaw's full catalog
// (`models list --all --json`, all available:false there), else the models this
// server configures. No answer at all keeps the declared fallback.
export {};

const listGatewayModels = jest.fn();
const readOpenClawConfig = jest.fn(() => ({}));
const cli = { list: null as unknown, all: null as unknown, calls: [] as string[] };

jest.mock('../utils/openclawGatewayRpc', () => ({ listGatewayModels }));
jest.mock('../services/openclawConfigManager', () => ({ readOpenClawConfig }));
jest.mock('../services/openclawSetupReadiness', () => ({ getOpenClawSetupReadiness: jest.fn(async () => null) }));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn((...args: any[]) => {
    const callback = args[args.length - 1];
    const all = JSON.stringify(args.slice(0, -1)).includes('--all');
    cli.calls.push(all ? 'list --all' : 'list');
    const answer = all ? cli.all : cli.list;
    if (answer === null) callback(new Error('no answer'));
    else callback(null, typeof answer === 'string' ? answer : JSON.stringify(answer));
  }),
}));

type ProviderModels = typeof import('../agents/providerModels');

function freshProviderModels(): ProviderModels {
  let loaded: ProviderModels | undefined;
  jest.isolateModules(() => { loaded = require('../agents/providerModels'); });
  return loaded!;
}

const FULL_CATALOG = { count: 2, models: [
  { key: 'openai/gpt-6.1-sol', provider: 'openai', available: false },
  { key: 'google/gemini-3-flash-preview', provider: 'google', available: false },
] };

describe('OpenClaw picker when OpenClaw answers with an empty catalog', () => {
  beforeEach(() => {
    listGatewayModels.mockReset();
    readOpenClawConfig.mockReset();
    readOpenClawConfig.mockReturnValue({});
    cli.list = null;
    cli.all = null;
    cli.calls.length = 0;
  });

  test('empty gateway and CLI lists: nothing offered, the full catalog names the hidden models', async () => {
    listGatewayModels.mockResolvedValue({ ok: true, models: [] });
    cli.list = { count: 0, models: [] };
    cli.all = FULL_CATALOG;
    const catalog = freshProviderModels();
    expect(await catalog.listProviderModels('OPENCLAW')).toEqual([]);
    expect(catalog.readLastOpenClawUnavailableModelIds()).toEqual(['google/gemini-3-flash-preview', 'openai/gpt-6.1-sol']);
    expect(cli.calls).toEqual(['list', 'list --all']);
  });

  test('an empty gateway list alone is an answer, also when the CLI does not answer', async () => {
    listGatewayModels.mockResolvedValue({ ok: true, models: [] });
    cli.all = FULL_CATALOG;
    const catalog = freshProviderModels();
    expect(await catalog.listProviderModels('OPENCLAW')).toEqual([]);
    expect(catalog.readLastOpenClawUnavailableModelIds()).toHaveLength(2);
  });

  test('an empty CLI list is an answer when the gateway does not answer', async () => {
    listGatewayModels.mockResolvedValue({ ok: false, models: [] });
    cli.list = { count: 0, models: [] };
    cli.all = FULL_CATALOG;
    expect(await freshProviderModels().listProviderModels('OPENCLAW')).toEqual([]);
  });

  test('without the full catalog the note names the models this server configures', async () => {
    readOpenClawConfig.mockReturnValue({ agents: { defaults: {
      models: { 'openai/gpt-6.1-sol': {} },
      model: { primary: 'anthropic/claude-fable-5', fallbacks: [] },
    } } });
    listGatewayModels.mockResolvedValue({ ok: true, models: [] });
    cli.list = { count: 0, models: [] };
    const catalog = freshProviderModels();
    expect(await catalog.listProviderModels('OPENCLAW')).toEqual([]);
    expect(catalog.readLastOpenClawUnavailableModelIds()).toEqual(['anthropic/claude-fable-5', 'openai/gpt-6.1-sol']);
  });

  test('an earlier answer\'s hidden models are not reported again for an empty one', async () => {
    const catalog = freshProviderModels();
    catalog.parseOpenClawModelsListPayload({ models: [{ key: 'xai/grok-5', provider: 'xai', available: false }] });
    listGatewayModels.mockResolvedValue({ ok: true, models: [] });
    cli.list = { count: 0, models: [] };
    expect(await catalog.listProviderModels('OPENCLAW')).toEqual([]);
    expect(catalog.readLastOpenClawUnavailableModelIds()).toEqual([]);
  });

  test('a runnable model in the CLI list is still offered after an empty gateway list', async () => {
    listGatewayModels.mockResolvedValue({ ok: true, models: [] });
    cli.list = { count: 1, models: [{ key: 'anthropic/claude-fable-5', provider: 'anthropic', available: true }] };
    expect((await freshProviderModels().listProviderModels('OPENCLAW')).map((model) => model.id)).toEqual(['anthropic/claude-fable-5']);
    expect(cli.calls).toEqual(['list']);
  });

  test('no answer at all keeps the declared fallback and never asks for the full catalog', async () => {
    listGatewayModels.mockResolvedValue({ ok: false, models: [] });
    cli.list = 'not json';
    expect((await freshProviderModels().listProviderModels('OPENCLAW')).length).toBeGreaterThan(0);
    expect(cli.calls).toEqual(['list']);
  });
});
