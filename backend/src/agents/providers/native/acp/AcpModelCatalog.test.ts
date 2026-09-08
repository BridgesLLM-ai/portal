import { listProviderModels } from '../../../providerModels';
import {
  __resetAcpModelCatalogForTests,
  invalidateAcpModelCatalog,
  readAcpModelCatalog,
  recordAcpModelCatalog,
  refreshAcpModelCatalogFromRuntime,
} from './AcpModelCatalog';

describe('ACP model catalog', () => {
  afterEach(() => __resetAcpModelCatalogForTests());

  test('publishes only models attested by the selected harness session', async () => {
    recordAcpModelCatalog('HERMES', {
      currentModelId: 'provider/model-b',
      availableModels: [
        { id: 'provider/model-a', name: 'Model A' },
        { id: 'provider/model-b', name: 'Model B' },
        { id: 'provider/model-a', name: 'Duplicate' },
      ],
    });
    recordAcpModelCatalog('OPENCODE', { currentModelId: null, availableModels: [] });

    expect(readAcpModelCatalog('HERMES')).toEqual([
      {
        id: 'provider/model-a',
        alias: null,
        provider: 'hermes',
        displayName: 'Model A',
        source: 'dynamic',
      },
      {
        id: 'provider/model-b',
        alias: null,
        provider: 'hermes',
        displayName: 'Model B',
        source: 'dynamic',
      },
    ]);
    await expect(listProviderModels('HERMES')).resolves.toEqual(readAcpModelCatalog('HERMES'));
    await expect(listProviderModels('OPENCODE')).resolves.toEqual([]);
  });

  test.each([
    { provider: 'HERMES' as const, closesBootstrapSession: false },
    { provider: 'OPENCODE' as const, closesBootstrapSession: true },
  ])('refreshes $provider models from its authenticated ACP session and disposes the broker', async ({
    provider,
    closesBootstrapSession,
  }) => {
    recordAcpModelCatalog(provider, {
      currentModelId: null,
      availableModels: [{ id: 'stale/model', name: 'Stale model' }],
    });
    invalidateAcpModelCatalog(provider);

    const start = jest.fn(async () => ({
      sessionId: `${provider.toLowerCase()}-catalog-session`,
      modelState: {
        currentModelId: 'live/model-b',
        availableModels: [
          { id: 'live/model-a', name: 'Live Model A' },
          { id: 'live/model-b', name: 'Live Model B' },
        ],
      },
    }));
    const closeSession = jest.fn(async () => undefined);
    const dispose = jest.fn(async () => undefined);
    const brokerFactory = jest.fn(() => ({ start, closeSession, dispose }) as any);

    await expect(refreshAcpModelCatalogFromRuntime(provider, {
      brokerFactory,
      environmentBuilder: () => ({ HOME: `/tmp/test-${provider.toLowerCase()}-home` }),
    })).resolves.toEqual([
      {
        id: 'live/model-a',
        alias: null,
        provider: provider.toLowerCase(),
        displayName: 'Live Model A',
        source: 'dynamic',
      },
      {
        id: 'live/model-b',
        alias: null,
        provider: provider.toLowerCase(),
        displayName: 'Live Model B',
        source: 'dynamic',
      },
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(closesBootstrapSession ? 1 : 0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(brokerFactory).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ id: provider }),
      environment: expect.objectContaining({ HOME: expect.any(String) }),
    }));
  });

  test('always disposes a failed model-discovery broker without publishing a fake catalog', async () => {
    const dispose = jest.fn(async () => undefined);
    const failure = new Error('session/new rejected');
    await expect(refreshAcpModelCatalogFromRuntime('OPENCODE', {
      environmentBuilder: () => ({ HOME: '/tmp/test-opencode-home' }),
      brokerFactory: () => ({
        start: jest.fn(async () => { throw failure; }),
        closeSession: jest.fn(),
        dispose,
      }) as any,
    })).rejects.toThrow(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(readAcpModelCatalog('OPENCODE')).toEqual([]);
  });
});
