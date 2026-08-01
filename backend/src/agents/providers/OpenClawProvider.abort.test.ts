const mockAgentSessionFindMany = jest.fn();

jest.mock('../../config/database', () => ({
  prisma: {
    agentSession: {
      findMany: mockAgentSessionFindMany,
    },
  },
}));

jest.mock('../../utils/openclawGatewayRpc', () => ({
  gatewayRpcCall: jest.fn(),
  patchSessionModel: jest.fn(),
  deleteSession: jest.fn(),
}));

jest.mock('./PersistentGatewayWs', () => ({
  sendChatMessage: jest.fn(),
  isConnected: jest.fn(() => true),
}));

const gatewayRpc = require('../../utils/openclawGatewayRpc') as {
  gatewayRpcCall: jest.Mock;
};
const persistentGateway = require('./PersistentGatewayWs') as {
  sendChatMessage: jest.Mock;
};
const { streamEventBus } = require('../../services/StreamEventBus') as typeof import('../../services/StreamEventBus');
const {
  OpenClawProvider,
  __openClawProviderTest,
} = require('./OpenClawProvider') as typeof import('./OpenClawProvider');

describe('OpenClawProvider run-bound abort settlement', () => {
  beforeEach(() => {
    gatewayRpc.gatewayRpcCall.mockReset();
    mockAgentSessionFindMany.mockReset();
    persistentGateway.sendChatMessage.mockReset();
  });

  test('maps the Portal reservation to the exact upstream run and waits for terminal proof', async () => {
    gatewayRpc.gatewayRpcCall
      .mockResolvedValueOnce({
        ok: true,
        data: { ok: true, aborted: true, runIds: ['portal-route-run-1'] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          runId: 'portal-route-run-1',
          status: 'timeout',
          stopReason: 'rpc',
          endedAt: 1_775_000_000_000,
        },
      });

    const provider = new OpenClawProvider();
    await expect(
      provider.abortActiveRun('agent:main:portal-owner', 'route-run-1'),
    ).resolves.toBe(true);

    expect(gatewayRpc.gatewayRpcCall).toHaveBeenNthCalledWith(
      1,
      'chat.abort',
      {
        sessionKey: 'agent:main:portal-owner',
        runId: 'portal-route-run-1',
      },
      15_000,
    );
    expect(gatewayRpc.gatewayRpcCall).toHaveBeenNthCalledWith(
      2,
      'agent.wait',
      { runId: 'portal-route-run-1', timeoutMs: 15_000 },
      20_000,
    );
  });

  test('accepts an already-completed exact run only when agent.wait proves its terminal snapshot', async () => {
    gatewayRpc.gatewayRpcCall
      .mockResolvedValueOnce({
        ok: true,
        data: { ok: true, aborted: false, runIds: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          runId: 'portal-route-run-2',
          status: 'ok',
          endedAt: '2026-07-29T15:00:00.000Z',
        },
      });

    const provider = new OpenClawProvider();
    await expect(
      provider.abortActiveRun('agent:main:portal-owner', 'route-run-2'),
    ).resolves.toBe(true);
  });

  test('fails closed when agent.wait only reports its own bounded timeout', async () => {
    gatewayRpc.gatewayRpcCall
      .mockResolvedValueOnce({
        ok: true,
        data: { ok: true, aborted: true, runIds: ['portal-route-run-3'] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          runId: 'portal-route-run-3',
          status: 'timeout',
          timeoutPhase: 'gateway_draining',
        },
      });

    const provider = new OpenClawProvider();
    await expect(
      provider.abortActiveRun('agent:main:portal-owner', 'route-run-3'),
    ).resolves.toBe(false);
  });

  test('session-wide abort requires terminal proof for every returned run', async () => {
    gatewayRpc.gatewayRpcCall
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: true,
          aborted: true,
          runIds: ['upstream-a', 'upstream-b'],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { runId: 'upstream-a', status: 'error', endedAt: 100 },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { runId: 'upstream-b', status: 'timeout', timeoutPhase: 'queue' },
      });

    const provider = new OpenClawProvider();
    await expect(
      provider.abortActiveRun('agent:main:portal-owner'),
    ).resolves.toBe(false);
  });

  test('does not double-prefix an upstream run identity', () => {
    expect(__openClawProviderTest.upstreamRunIdForPortalRun('portal-existing')).toBe(
      'portal-existing',
    );
  });

  test('lists only exact durable claims across main and sub-agent registries', async () => {
    const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const canonicalMain = 'agent:main:main';
    const parity = `agent:parity:portal-${actorId}-review`;
    mockAgentSessionFindMany.mockResolvedValue([
      { externalId: canonicalMain },
      { externalId: parity },
    ]);
    gatewayRpc.gatewayRpcCall.mockImplementation(async (_method: string, input: any) => ({
      ok: true,
      data: {
        sessions: input.agentId === 'main'
          ? [
              { key: canonicalMain, model: 'openai/gpt-5.6-sol' },
              { key: 'agent:main:foreign', model: 'anthropic/claude' },
            ]
          : [
              { key: parity, model: 'openai/gpt-5.6-sol' },
              { key: `agent:parity:portal-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-secret` },
            ],
      },
    }));

    const provider = new OpenClawProvider();
    await expect(provider.listSessions(actorId)).resolves.toEqual([
      expect.objectContaining({ sessionId: canonicalMain }),
      expect.objectContaining({ sessionId: parity }),
    ]);
    expect(mockAgentSessionFindMany).toHaveBeenCalledWith({
      where: { userId: actorId, provider: 'OPENCLAW' },
      select: { externalId: true },
    });
  });

  test('new sessions include the full actor UUID for every agent id', async () => {
    const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const provider = new OpenClawProvider();
    await expect(provider.startSession(actorId, {
      executionContext: {
        scope: 'HOST_OPERATOR',
        source: 'PORTAL_SERVER',
        userId: actorId,
      },
      metadata: {
        agentId: 'parity',
        sessionSlug: 'new-123',
      },
    })).resolves.toBe(`agent:parity:portal-${actorId}-new-123`);
  });

  test('rejects actor-prefix control/colon injection and prefix collisions', async () => {
    const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const provider = new OpenClawProvider();
    const executionContext = {
      scope: 'HOST_OPERATOR' as const,
      source: 'PORTAL_SERVER' as const,
      userId: actorId,
    };

    await expect(provider.startSession(actorId, {
      executionContext,
      metadata: {
        agentId: 'main',
        sessionSlug: `portal-${actorId}:foreign\nsession`,
      },
    })).rejects.toThrow('Invalid OpenClaw session slug');
    await expect(provider.startSession(actorId, {
      executionContext,
      metadata: {
        agentId: 'main',
        sessionSlug: `portal-${actorId}collision`,
      },
    })).rejects.toThrow('Invalid OpenClaw session slug');
    await expect(provider.startSession(actorId, {
      executionContext,
      metadata: {
        agentId: 'main',
        sessionSlug: `portal-${actorId}-review:unsafe\nsuffix`,
      },
    })).resolves.toBe(`agent:main:portal-${actorId}-review-unsafe-suffix`);
  });

  test('does not expose terminal settlement before the durable dispatch callback commits', async () => {
    const sessionId = 'agent:main:portal-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    let releaseDispatch!: () => void;
    const dispatchCommitted = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const onProviderDispatchAccepted = jest.fn(async () => dispatchCommitted);
    persistentGateway.sendChatMessage.mockImplementation(async (...args: any[]) => {
      await args[4]?.('upstream-run-1');
      return { runId: 'upstream-run-1' };
    });

    const provider = new OpenClawProvider();
    let visibleSettled = false;
    const send = provider.sendMessage(
      sessionId,
      'hello',
      undefined,
      undefined,
      undefined,
      {
        label: 'owner@example.com',
        userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        authorizationVersion: 4,
        requestId: 'route-run-1',
        onProviderDispatchAccepted,
      },
    ).finally(() => {
      visibleSettled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onProviderDispatchAccepted).toHaveBeenCalledWith('upstream-run-1');
    streamEventBus.publish(sessionId, {
      type: 'done',
      content: 'complete',
      aggregateContent: 'complete',
      runId: 'upstream-run-1',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(visibleSettled).toBe(false);

    releaseDispatch();
    await expect(send).resolves.toMatchObject({ fullText: 'complete' });
    streamEventBus.clearStream(sessionId);
  });

  test('fails the visible send when durable dispatch acceptance fails', async () => {
    const sessionId = 'agent:main:portal-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    persistentGateway.sendChatMessage.mockImplementation(async (...args: any[]) => {
      await args[4]?.('upstream-run-2');
      return { runId: 'upstream-run-2' };
    });
    const provider = new OpenClawProvider();

    await expect(provider.sendMessage(
      sessionId,
      'hello',
      undefined,
      undefined,
      undefined,
      {
        label: 'owner@example.com',
        userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        authorizationVersion: 5,
        requestId: 'route-run-2',
        onProviderDispatchAccepted: async () => {
          throw new Error('dispatch journal unavailable');
        },
      },
    )).rejects.toThrow('dispatch journal unavailable');
    streamEventBus.clearStream(sessionId);
  });
});
