import { EventEmitter } from 'events';
import gatewayRouter, { __gatewayExecutionScopeTest } from '../routes/gateway';
import { AgentRegistry } from '../agents';
import { __persistentGatewayWsTest } from '../agents/providers/PersistentGatewayWs';
import { streamEventBus, type StreamEvent } from '../services/StreamEventBus';
import * as openclawGatewayRpc from '../utils/openclawGatewayRpc';
import * as openClawHostRunJournal from '../services/openClawHostRunJournal';
import * as agentZeroOAuthModels from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';
import {
  AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
} from '../agents/providers/agentZero/AgentZeroDiagnostics';
import { prisma } from '../config/database';

function sendRouteHandler(): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/send');
  if (!layer) throw new Error('gateway /send route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function gatewayRouteHandler(path: string): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === path);
  if (!layer) throw new Error(`gateway ${path} route not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createOwnershipDatabase(
  initialClaims: Array<{ id: string; userId: string; externalId: string }> = [],
) {
  const claims = new Map(initialClaims.map((claim) => [claim.externalId, { ...claim }]));
  const projectDelegate = () => ({ findFirst: jest.fn(async () => null) });
  const agentSession = {
    findFirst: jest.fn(async (args: any) => (
      claims.get(String(args?.where?.externalId || '')) || null
    )),
    create: jest.fn(async (args: any) => {
      const externalId = String(args?.data?.externalId || '');
      if (claims.has(externalId)) {
        throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
      }
      const row = {
        id: `claim-${claims.size + 1}`,
        userId: String(args?.data?.userId || ''),
        externalId,
      };
      claims.set(externalId, row);
      return row;
    }),
    update: jest.fn(async (args: any) => (
      Array.from(claims.values()).find((claim) => claim.id === args?.where?.id) || null
    )),
  };
  return {
    database: {
      agentSession,
      projectChatProviderBinding: projectDelegate(),
      projectChatSession: projectDelegate(),
      projectChatMessage: projectDelegate(),
      projectChatTurn: projectDelegate(),
      legacyOpenClawProjectImport: projectDelegate(),
      legacyOpenClawProjectQuarantine: projectDelegate(),
    } as any,
    claims,
    agentSession,
  };
}

describe('Agent Chat execution boundary', () => {
  test('names only Portal-owned sessions from their first prompt', () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const key = `agent:main:portal-${userId}-new-1785680000000`;
    expect(__gatewayExecutionScopeTest.isPortalAgentChatSessionKeyForUser(key, { userId })).toBe(true);
    expect(__gatewayExecutionScopeTest.isPortalAgentChatSessionKeyForUser(
      'agent:main:new-1785680000000',
      { userId },
    )).toBe(false);
    expect(__gatewayExecutionScopeTest.buildPortalAgentChatLabel(
      key,
      '  Fix   the session naming regression  ',
    )).toMatch(/^Portal · Fix the session naming regression · [0-9a-f]{6}$/);
    expect(__gatewayExecutionScopeTest.buildPortalAgentChatLabel(key)).toMatch(
      /^New Portal chat · main · [0-9a-f]{6}$/,
    );
  });
  beforeEach(() => {
    const claims = new Map<string, { id: string; userId: string; externalId: string }>();
    const agentSessionDelegate = prisma.agentSession as any;
    jest.spyOn(agentSessionDelegate, 'findFirst').mockImplementation(async (args: any) => {
      const externalId = String(args?.where?.externalId || '');
      return claims.get(externalId) as any || null;
    });
    jest.spyOn(agentSessionDelegate, 'create').mockImplementation(async (args: any) => {
      const externalId = String(args?.data?.externalId || '');
      if (claims.has(externalId)) {
        throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
      }
      const row = {
        id: `claim-${claims.size + 1}`,
        userId: String(args?.data?.userId || ''),
        externalId,
      };
      claims.set(externalId, row);
      return row as any;
    });
    jest.spyOn(agentSessionDelegate, 'update').mockImplementation(async (args: any) => {
      return Array.from(claims.values()).find((row) => row.id === args?.where?.id) as any;
    });
    for (const delegate of [
      prisma.projectChatProviderBinding,
      prisma.projectChatSession,
      prisma.projectChatMessage,
      prisma.projectChatTurn,
      prisma.legacyOpenClawProjectImport,
      prisma.legacyOpenClawProjectQuarantine,
    ] as any[]) {
      jest.spyOn(delegate, 'findFirst').mockResolvedValue(null);
    }
  });

  afterEach(() => {
    streamEventBus.clearStream('native-bus-session');
    streamEventBus.clearStream('native-reconnect-session');
    streamEventBus.clearStream('route-bus-session');
    streamEventBus.clearStream('grok-route-bus-session');
    streamEventBus.clearStream('route-sse-session');
    streamEventBus.clearStream('route-rest-session');
    streamEventBus.clearStream('concurrent-route-session');
    streamEventBus.clearStream('abort-route-session');
    streamEventBus.clearStream('openclaw-reconnect-preliminary');
    streamEventBus.clearStream('resume-subscribe-race');
    streamEventBus.clearStream('stale-snapshot-attach');
    streamEventBus.clearStream('openclaw-abort-race');
    streamEventBus.clearStream('terminal-global-fanout-done');
    streamEventBus.clearStream('terminal-global-fanout-error');
    jest.restoreAllMocks();
  });

  test('preserves alias-looking Ollama tags while OpenClaw keeps canonical ids', () => {
    expect(__gatewayExecutionScopeTest.normalizeRequestedModel('OLLAMA', 'gpt-5.5')).toBe('gpt-5.5');
    expect(__gatewayExecutionScopeTest.normalizeRequestedModel('OLLAMA', 'codex/gpt-5.5'))
      .toBe('codex/gpt-5.5');
    expect(__gatewayExecutionScopeTest.normalizeRequestedModel('OPENCLAW', 'codex/gpt-5.5'))
      .toBe('openai/gpt-5.5');
  });

  test.each([
    'projectChatProviderBinding',
    'projectChatSession',
    'projectChatMessage',
    'projectChatTurn',
    'legacyOpenClawProjectImport',
    'legacyOpenClawProjectQuarantine',
  ])('rejects %s-backed current and legacy Project keys from Agent activity titles', async (matchedSource) => {
    const database = Object.fromEntries([
      'agentSession',
      'projectChatProviderBinding',
      'projectChatSession',
      'projectChatMessage',
      'projectChatTurn',
      'legacyOpenClawProjectImport',
      'legacyOpenClawProjectQuarantine',
    ].map((source) => [
      source,
      {
        findFirst: jest.fn(async () => (
          source === 'agentSession' || source === matchedSource ? { id: `${source}-1` } : null
        )),
      },
    ])) as any;

    await expect(
      __gatewayExecutionScopeTest.isProjectChatActivitySession('legacy-or-current-project-key', database),
    ).resolves.toBe(true);
    __gatewayExecutionScopeTest.clearAgentActivityScopePending();
    await expect(
      __gatewayExecutionScopeTest.isAgentChatActivitySession(
        'legacy-or-current-project-key',
        'owner-1',
        database,
      ),
    ).resolves.toBe(false);
  });

  test('allows only freshly attested Agent keys and fails closed when Project lookup is unavailable', async () => {
    const ordinaryDatabase = Object.fromEntries([
      'agentSession',
      'projectChatProviderBinding',
      'projectChatSession',
      'projectChatMessage',
      'projectChatTurn',
      'legacyOpenClawProjectImport',
      'legacyOpenClawProjectQuarantine',
    ].map((source) => [
      source,
      { findFirst: jest.fn(async () => source === 'agentSession' ? { id: 'agent-session-1' } : null) },
    ])) as any;
    await expect(
      __gatewayExecutionScopeTest.isAgentChatActivitySession(
        'agent:main:ordinary',
        'owner-1',
        ordinaryDatabase,
      ),
    ).resolves.toBe(true);

    __gatewayExecutionScopeTest.clearAgentActivityScopePending();
    const unavailableDatabase = {
      ...ordinaryDatabase,
      projectChatProviderBinding: {
        findFirst: jest.fn(async () => {
          throw new Error('database unavailable');
        }),
      },
    } as any;
    await expect(
      __gatewayExecutionScopeTest.isAgentChatActivitySession(
        'agent:main:unknown',
        'owner-1',
        unavailableDatabase,
      ),
    ).resolves.toBe(false);
    await expect(
      __gatewayExecutionScopeTest.isAgentChatActivitySession(
        'agent:main:unowned',
        '',
        ordinaryDatabase,
      ),
    ).resolves.toBe(false);
  });

  test('server-denies current-actor and foreign config-only 3.x Project aliases', async () => {
    const actorUserId = '12345678-aaaa-bbbb-cccc-123456789abc';
    const sessionId = `portal-${actorUserId}-legacy-slug`;
    const foreignUserId = '87654321-bbbb-cccc-dddd-abcdefabcdef';
    const foreignSessionId = `portal-${foreignUserId}-foreign-project`;

    expect(__gatewayExecutionScopeTest.isActorDerivedLegacyProjectSessionKey(
      `agent:portal-12345678-legacy-slug:${sessionId}`,
      actorUserId,
    )).toBe(true);
    expect(__gatewayExecutionScopeTest.isActorDerivedLegacyProjectSessionKey(
      `agent:portal:${sessionId}`,
      actorUserId,
    )).toBe(true);
    expect(__gatewayExecutionScopeTest.isActorDerivedLegacyProjectSessionKey(
      `agent:portal-87654321-foreign-project:${foreignSessionId}`,
      actorUserId,
    )).toBe(true);
    expect(__gatewayExecutionScopeTest.isActorDerivedLegacyProjectSessionKey(
      `agent:portal:${foreignSessionId}`,
      actorUserId,
    )).toBe(true);
    expect(__gatewayExecutionScopeTest.isActorDerivedLegacyProjectSessionKey(
      'agent:portal-87654321-foreign-project:main',
      actorUserId,
    )).toBe(true);
    expect(__gatewayExecutionScopeTest.isActorDerivedLegacyProjectSessionKey(
      'agent:main:ordinary',
      actorUserId,
    )).toBe(false);
  });

  test('registers only non-Project sessions reached through an authenticated Agent surface', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const delegates = Object.fromEntries([
      'projectChatProviderBinding',
      'projectChatSession',
      'projectChatMessage',
      'projectChatTurn',
      'legacyOpenClawProjectImport',
      'legacyOpenClawProjectQuarantine',
    ].map((source) => [
      source,
      { findFirst: jest.fn(async () => null) },
    ]));
    const database = {
      ...delegates,
      agentSession: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'agent-session-1' })),
        update: jest.fn(async () => ({ id: 'agent-session-1' })),
      },
    } as any;

    await __gatewayExecutionScopeTest.attestAgentChatActivitySession(
      `agent:main:portal-${ownerId}-ordinary`,
      ownerId,
      database,
    );
    expect(database.agentSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: ownerId,
        provider: 'OPENCLAW',
        externalId: `agent:main:portal-${ownerId}-ordinary`,
        status: 'active',
      }),
    });

    database.agentSession.create.mockClear();
    const legacySessionId = 'portal-owner-1-project';
    await __gatewayExecutionScopeTest.attestAgentChatActivitySession(
      `agent:portal:${legacySessionId}`,
      'owner-1',
      database,
    );
    expect(database.agentSession.create).not.toHaveBeenCalled();

    await __gatewayExecutionScopeTest.attestAgentChatActivitySession(
      'agent:portal-87654321-foreign-project:main',
      '12345678-aaaa-bbbb-cccc-123456789abc',
      database,
    );
    expect(database.agentSession.create).not.toHaveBeenCalled();
  });

  test('ownership transfer preserves the former Owner main transcript and maps the new Owner to an actor key', async () => {
    const formerOwnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { database } = createOwnershipDatabase([{
      id: 'canonical-main-claim',
      userId: formerOwnerId,
      externalId: 'agent:main:main',
    }]);

    await expect(__gatewayExecutionScopeTest.resolveOpenClawSessionKey(
      'agent:main:main',
      { userId: formerOwnerId, role: 'SUB_ADMIN' } as any,
      database,
    )).resolves.toBe('agent:main:main');
    await expect(__gatewayExecutionScopeTest.resolveOpenClawSessionKey(
      'agent:main:main',
      { userId: newOwnerId, role: 'OWNER' } as any,
      database,
    )).resolves.toBe(`agent:main:portal-${newOwnerId}`);
    await expect(__gatewayExecutionScopeTest.assertGatewaySessionAccess(
      'agent:main:main',
      { userId: newOwnerId, role: 'OWNER' } as any,
      { providerName: 'OPENCLAW', database },
    )).rejects.toThrow('Admin access required');
  });

  test('SUB_ADMIN cannot adopt an arbitrary unbound OpenClaw agent key', async () => {
    const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const { database } = createOwnershipDatabase();
    await expect(__gatewayExecutionScopeTest.assertGatewaySessionAccess(
      'agent:research:preexisting-private-transcript',
      { userId: actorId, role: 'SUB_ADMIN' } as any,
      { providerName: 'OPENCLAW', database },
    )).rejects.toThrow('Admin access required');
  });

  test('a fully-qualified actor session key cannot cross Portal users', async () => {
    const firstActorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const secondActorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { database } = createOwnershipDatabase();
    const firstActorSession = `agent:main:portal-${firstActorId}-private`;

    await expect(__gatewayExecutionScopeTest.assertGatewaySessionAccess(
      firstActorSession,
      { userId: secondActorId, role: 'OWNER' } as any,
      { providerName: 'OPENCLAW', database },
    )).rejects.toThrow('Admin access required');
    expect(database.agentSession.create).not.toHaveBeenCalled();
  });

  test('concurrent same-user claims converge while a competing user fails closed', async () => {
    const actorId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const competingActorId = '99999999-9999-4999-8999-999999999999';
    const sessionKey = `agent:parity:portal-${actorId}-new-123`;
    const { database, claims } = createOwnershipDatabase();

    await expect(Promise.all([
      __gatewayExecutionScopeTest.claimOpenClawAgentSession(sessionKey, actorId, database),
      __gatewayExecutionScopeTest.claimOpenClawAgentSession(sessionKey, actorId, database),
    ])).resolves.toEqual([undefined, undefined]);
    expect(claims.get(sessionKey)?.userId).toBe(actorId);
    expect(claims.size).toBe(1);

    await expect(__gatewayExecutionScopeTest.claimOpenClawAgentSession(
      sessionKey,
      competingActorId,
      database,
    )).rejects.toThrow('Admin access required');
  });

  test('read-only session authorization requires an existing owner and never touches the claim', async () => {
    const actorId = 'abababab-abab-4bab-8bab-abababababab';
    const ownedKey = `agent:main:portal-${actorId}-owned`;
    const unclaimedKey = `agent:main:portal-${actorId}-unclaimed`;
    const { database, agentSession } = createOwnershipDatabase([{
      id: 'owned-claim',
      userId: actorId,
      externalId: ownedKey,
    }]);

    await expect(__gatewayExecutionScopeTest.assertExistingGatewaySessionAccess(
      ownedKey,
      { userId: actorId, role: 'OWNER' } as any,
      { database },
    )).resolves.toBeUndefined();
    await expect(__gatewayExecutionScopeTest.assertExistingGatewaySessionAccess(
      unclaimedKey,
      { userId: actorId, role: 'OWNER' } as any,
      { database },
    )).rejects.toThrow('Admin access required');
    expect(agentSession.update).not.toHaveBeenCalled();
    expect(agentSession.create).not.toHaveBeenCalled();
  });

  test('routes Grok callbacks through the gateway stream bus', () => {
    // GrokProvider owns its ACP lifecycle but does not use the shared native
    // provider streaming wrapper. Treating it as provider-owned would replace
    // its text/thinking/tool callbacks with no-ops and expose only the final.
    expect(__gatewayExecutionScopeTest.providerPublishesHostStream('GROK')).toBe(false);
    expect(__gatewayExecutionScopeTest.providerUsesHostStreamBus('GROK')).toBe(true);
  });

  test('never changes the selected harness because a model id resembles another provider namespace', () => {
    expect(__gatewayExecutionScopeTest.routeProviderForRequestedModel(
      'OPENCLAW',
      'google-antigravity/gemini-3-pro',
    )).toBe('OPENCLAW');
    expect(__gatewayExecutionScopeTest.routeProviderForRequestedModel(
      'OPENCLAW',
      'google-gemini-cli/gemini-3-pro',
    )).toBe('OPENCLAW');
    expect(__gatewayExecutionScopeTest.routeProviderForRequestedModel(
      'GEMINI',
      'google-antigravity/gemini-3-pro',
    )).toBe('GEMINI');
  });

  test('normalizes Default/reset aliases without treating ordinary model ids as resets', () => {
    expect(__gatewayExecutionScopeTest.isProviderModelResetAlias(' default ')).toBe(true);
    expect(__gatewayExecutionScopeTest.isProviderModelResetAlias('RESET')).toBe(true);
    expect(__gatewayExecutionScopeTest.isProviderModelResetAlias('provider/default')).toBe(false);
  });

  test('keeps Agent Zero actionable errors intact when a transport classifies them again', () => {
    expect(__gatewayExecutionScopeTest.humanizeProviderError(
      'AGENT_ZERO',
      `Agent Zero run failed: ${AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE}`,
    )).toBe(AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE);
  });

  test('keeps the Agent Zero model protocol qualification message intact', () => {
    expect(__gatewayExecutionScopeTest.humanizeProviderError(
      'AGENT_ZERO',
      agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
    )).toBe(agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE);
    expect(__gatewayExecutionScopeTest.humanizeProviderError(
      'AGENT_ZERO',
      `Agent Zero run failed: ${agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE}`,
    )).toBe(agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE);
  });

  test('REST rejects ordinary users before provider lookup or session creation', async () => {
    const getProvider = jest.spyOn(AgentRegistry, 'get');
    const req = {
      body: { message: 'run host command', provider: 'CODEX', session: 'new-test' },
      query: {},
      headers: {},
      user: { userId: 'user-1', email: 'user@example.com', role: 'USER' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await sendRouteHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Admin access required' }));
    expect(getProvider).not.toHaveBeenCalled();
  });

  test.each([
    ['/session-model', { body: { provider: '../../tmp/escape', session: 'native-session', model: 'model-id' }, query: {} }],
    ['/history', { body: {}, query: { provider: '../../tmp/escape', session: 'native-session' } }],
  ])('%s rejects traversal-shaped provider names before provider or session access', async (path, request) => {
    const getProvider = jest.spyOn(AgentRegistry, 'get');
    const req = {
      ...request,
      headers: {},
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await gatewayRouteHandler(path)(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/unknown provider/i),
    }));
    expect(getProvider).not.toHaveBeenCalled();
  });

  test.each(['default', 'reset'])('Agent Zero rejects the %s model alias before session access', async (model) => {
    const getProvider = jest.spyOn(AgentRegistry, 'get');
    const req = {
      body: { provider: 'AGENT_ZERO', session: 'native-session', model },
      query: {},
      headers: {},
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await gatewayRouteHandler('/session-model')(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/requires an exact model from a connected OAuth provider/i),
      code: 'AGENT_ZERO_MODEL_REQUIRED',
    });
    expect(getProvider).not.toHaveBeenCalled();
  });

  test('WebSocket rejects ordinary users before provider lookup or session creation', async () => {
    const getProvider = jest.spyOn(AgentRegistry, 'get');
    const send = jest.fn();
    const ws = { readyState: 1, send } as any;

    await __gatewayExecutionScopeTest.handleWsSend(
      ws,
      { type: 'send', message: 'run host command', provider: 'CLAUDE_CODE', session: 'new-test' },
      { userId: 'user-1', email: 'user@example.com', role: 'USER' } as any,
    );

    expect(getProvider).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    const payloads = send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'error', content: 'Admin access required' }));
  });

  test.each(['OWNER', 'SUB_ADMIN'])('%s receives a server-owned HOST_OPERATOR context', (role) => {
    const context = __gatewayExecutionScopeTest.requireHostOperatorExecutionContext({
      userId: `${role.toLowerCase()}-1`,
      email: `${role.toLowerCase()}@example.com`,
      role,
    } as any);

    expect(context).toEqual({
      scope: 'HOST_OPERATOR',
      source: 'PORTAL_SERVER',
      userId: `${role.toLowerCase()}-1`,
    });
  });

  test('SSE takeover is scoped to the exact browser token and cannot evict another tab', () => {
    const firstTabCleanup = jest.fn();
    const secondTabCleanup = jest.fn();
    const unregisterFirst = __gatewayExecutionScopeTest.registerSseDelivery(
      'owner-1',
      'agent:main:main',
      'tab-a-000000000000',
      firstTabCleanup,
    );
    const unregisterSecond = __gatewayExecutionScopeTest.registerSseDelivery(
      'owner-1',
      'agent:main:main',
      'tab-b-000000000000',
      secondTabCleanup,
    );

    expect(__gatewayExecutionScopeTest.takeOverSseDelivery(
      'owner-1',
      'agent:main:main',
      'tab-a-000000000000',
    )).toBe(true);
    expect(firstTabCleanup).toHaveBeenCalledTimes(1);
    expect(secondTabCleanup).not.toHaveBeenCalled();
    expect(__gatewayExecutionScopeTest.takeOverSseDelivery(
      'owner-1',
      'agent:main:main',
      'tab-a-000000000000',
    )).toBe(false);

    unregisterFirst();
    unregisterSecond();
  });

  test('WebSocket abort replies correlate requestId and keep state when cancellation is unconfirmed', async () => {
    const provider = {
      providerName: 'OLLAMA',
      displayName: 'Ollama',
      abortActiveRun: jest.fn().mockResolvedValue(false),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    streamEventBus.startStream('abort-route-session', 'run-active');
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsAbort(socket as any, {
      provider: 'OLLAMA',
      session: 'abort-route-session',
      runId: 'run-active',
      requestId: 'abort-request-1',
    });

    const payload = JSON.parse(String(socket.send.mock.calls[0][0]));
    expect(payload).toMatchObject({
      type: 'abort_result',
      ok: false,
      sessionKey: 'abort-route-session',
      runId: 'run-active',
      requestId: 'abort-request-1',
    });
    expect(streamEventBus.getStreamStatus('abort-route-session')).toMatchObject({
      active: true,
      runId: 'run-active',
    });
  });

  test('ordinary users retain access to their exact Project Chat sandbox binding', async () => {
    const user = {
      userId: 'abcdefgh-1234-5678-9012-abcdefghijkl',
      email: 'user@example.com',
      role: 'USER',
      sandboxEnabled: true,
    } as any;
    const projectSession = 'agent:portal-abcdefgh-project:portal-abcdefgh-1234-5678-9012-abcdefghijkl-project';

    await expect(__gatewayExecutionScopeTest.assertGatewaySessionAccess(
      projectSession,
      user,
      { providerName: 'OPENCLAW' },
    )).resolves.toBeUndefined();
    await expect(__gatewayExecutionScopeTest.assertGatewaySessionAccess(
      'agent:main:main',
      user,
      { providerName: 'OPENCLAW' },
    )).rejects.toThrow('Admin access required');
  });

  test('direct chat queues pre-ack finals and settles only the acknowledged run', () => {
    const sessionKey = 'direct-pre-ack-final';
    const reservationRunId = 'direct-reservation';
    const acknowledgedRunId = 'direct-acknowledged';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
      )).toBe(true);

      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'direct-stale-competitor',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Stale competing final.' }],
        },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: acknowledgedRunId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Acknowledged fast final.' }],
        },
      });

      expect(events).toEqual([]);
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: reservationRunId,
      }));

      expect(__gatewayExecutionScopeTest.acknowledgeDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
        acknowledgedRunId,
      )).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: acknowledgedRunId }),
        expect.objectContaining({
          type: 'text',
          content: 'Acknowledged fast final.',
          runId: acknowledgedRunId,
        }),
        expect.objectContaining({
          type: 'done',
          content: 'Acknowledged fast final.',
          runId: acknowledgedRunId,
        }),
      ]));
      expect(events.some((event) => event.content === 'Stale competing final.')).toBe(false);
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: false,
        runId: acknowledgedRunId,
      }));
    } finally {
      unsubscribe();
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, reservationRunId);
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('direct chat reservation expires server-side when its acknowledgement never arrives', () => {
    jest.useFakeTimers();
    const sessionKey = 'direct-ack-timeout';
    const reservationRunId = 'direct-timeout-reservation';
    const onExpire = jest.fn();

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
      )).toBe(true);
      __gatewayExecutionScopeTest.scheduleDirectGatewayChatRunTimeout(
        sessionKey,
        reservationRunId,
        onExpire,
      );

      expect(streamEventBus.getStreamStatus(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: reservationRunId,
      }));
      jest.advanceTimersByTime(__gatewayExecutionScopeTest.directGatewayChatSendTimeoutMs - 1);
      expect(onExpire).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);

      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
      expect(streamEventBus.getTrackedStream(sessionKey)).toBeNull();
    } finally {
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, reservationRunId);
      __persistentGatewayWsTest.resetSession(sessionKey);
      jest.useRealTimers();
    }
  });

  test('host-native CLI output reaches the browser only through StreamEventBus', async () => {
    const provider = {
      providerName: 'CODEX',
      displayName: 'Codex',
      startSession: jest.fn().mockResolvedValue('native-bus-session'),
      sendMessage: jest.fn(async (
        sessionId: string,
        _message: string,
        onChunk?: (chunk: string) => void,
        onStatus?: (event: { type: string; content?: string }) => void,
        _onExecApproval?: unknown,
        sender?: { requestId?: string },
      ) => {
        // A legacy callback copy must be ignored by the gateway when the
        // provider owns the StreamEventBus transport.
        onStatus?.({ type: 'status', content: 'callback status copy' });
        onChunk?.('callback text copy');
        const runId = String(sender?.requestId || 'missing-run-id');
        streamEventBus.startStream(sessionId, runId, { provenance: 'via Codex CLI' });
        streamEventBus.publish(sessionId, { type: 'status', content: 'bus status', runId });
        streamEventBus.publish(sessionId, { type: 'text', content: 'bus text', runId });
        streamEventBus.publish(sessionId, { type: 'done', content: 'bus text', runId });
        streamEventBus.softClearStream(sessionId);
        return { fullText: 'bus text', metadata: { provider: 'codex' } };
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      { type: 'send', message: 'hello', provider: 'CODEX', session: 'new-test' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads.filter((payload) => payload.type === 'text')).toEqual([
      expect.objectContaining({ content: 'bus text', runId: expect.any(String) }),
    ]);
    expect(payloads.filter((payload) => payload.type === 'status' && payload.content === 'bus status')).toHaveLength(1);
    expect(payloads.filter((payload) => payload.type === 'done')).toHaveLength(1);
    expect(payloads).not.toContainEqual(expect.objectContaining({ content: 'callback text copy' }));
    expect(payloads).not.toContainEqual(expect.objectContaining({ content: 'callback status copy' }));
    expect(provider.sendMessage.mock.calls[0][5]).toMatchObject({
      requestId: payloads.find((payload) => payload.type === 'text')?.runId,
    });
  });

  test('host-native CLI SSE does not republish callback copies into the bus', async () => {
    const provider = {
      providerName: 'CODEX',
      displayName: 'Codex',
      startSession: jest.fn().mockResolvedValue('native-bus-session'),
      sendMessage: jest.fn(async (
        sessionId: string,
        _message: string,
        onChunk?: (chunk: string) => void,
        onStatus?: (event: { type: string; content?: string }) => void,
        _onExecApproval?: unknown,
        sender?: { requestId?: string },
      ) => {
        onStatus?.({ type: 'status', content: 'callback status copy' });
        onChunk?.('callback text copy');
        const runId = String(sender?.requestId || 'missing-run-id');
        streamEventBus.startStream(sessionId, runId, { provenance: 'via Codex CLI' });
        streamEventBus.publish(sessionId, { type: 'text', content: 'bus SSE text', runId });
        streamEventBus.publish(sessionId, { type: 'done', content: 'bus SSE text', runId });
        streamEventBus.softClearStream(sessionId);
        return { fullText: 'bus SSE text', metadata: { provider: 'codex' } };
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const req = Object.assign(new EventEmitter(), {
      body: { message: 'hello', provider: 'CODEX', session: 'new-test' },
      query: { stream: '1' },
      headers: { accept: 'text/event-stream' },
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    });
    const res = {
      socket: { setNoDelay: jest.fn() },
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await sendRouteHandler()(req as any, res as any);

    const payloads = res.write.mock.calls
      .map(([raw]) => String(raw))
      .flatMap((raw) => raw.split('\n'))
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(payloads.filter((payload) => payload.type === 'text')).toEqual([
      expect.objectContaining({ content: 'bus SSE text', runId: expect.any(String) }),
    ]);
    expect(payloads.filter((payload) => payload.type === 'done')).toHaveLength(1);
    expect(payloads).not.toContainEqual(expect.objectContaining({ content: 'callback text copy' }));
    expect(payloads).not.toContainEqual(expect.objectContaining({ content: 'callback status copy' }));
    expect(provider.sendMessage.mock.calls[0][5]).toMatchObject({
      requestId: payloads.find((payload) => payload.type === 'text')?.runId,
    });
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('route-owned Ollama WebSocket callbacks are mirrored once through the reconnect bus', async () => {
    const provider = {
      providerName: 'OLLAMA',
      displayName: 'Ollama',
      startSession: jest.fn().mockResolvedValue('route-bus-session'),
      sendMessage: jest.fn(async (
        _sessionId: string,
        _message: string,
        onChunk?: (chunk: string) => void,
        onStatus?: (event: { type: string; content?: string; [key: string]: unknown }) => void,
        _onExecApproval?: unknown,
        sender?: { requestId?: string },
      ) => {
        onStatus?.({ type: 'status', content: 'password=provider-secret' });
        onChunk?.('route text');
        return {
          fullText: 'route text',
          metadata: { model: 'qwen-test', password: 'metadata-secret', requestId: sender?.requestId },
        };
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      { type: 'send', message: 'hello', provider: 'OLLAMA', session: 'new-test' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    const textEvents = payloads.filter((payload) => payload.type === 'text');
    const doneEvents = payloads.filter((payload) => payload.type === 'done');
    expect(textEvents).toEqual([
      expect.objectContaining({ content: 'route text', sessionKey: 'route-bus-session' }),
    ]);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({
      content: 'route text',
      sessionKey: 'route-bus-session',
      metadata: { model: 'qwen-test', password: '[redacted]' },
    });
    expect(doneEvents[0].runId).toEqual(expect.any(String));
    expect(provider.sendMessage.mock.calls[0][5]).toMatchObject({ requestId: doneEvents[0].runId });
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'status',
      content: 'password=[redacted]',
    }));
  });

  test('Grok WebSocket forwards thinking, tool lifecycle, text, and terminal exactly once', async () => {
    const provider = {
      providerName: 'GROK',
      displayName: 'Grok Build',
      startSession: jest.fn().mockResolvedValue('grok-route-bus-session'),
      sendMessage: jest.fn(async (
        _sessionId: string,
        _message: string,
        onChunk?: (chunk: string) => void,
        onStatus?: (event: { type: string; content?: string; [key: string]: unknown }) => void,
      ) => {
        onStatus?.({ type: 'thinking', content: 'I will inspect the working directory.' });
        onStatus?.({
          type: 'tool_start',
          content: 'Running pwd',
          toolName: 'shell',
          toolCallId: 'grok-tool-1',
          toolArgs: { command: 'pwd' },
        });
        onChunk?.('The exact output is ');
        onStatus?.({
          type: 'tool_end',
          content: '/root/workspace',
          toolName: 'shell',
          toolCallId: 'grok-tool-1',
          toolResult: '/root/workspace',
          status: 'completed',
        });
        onChunk?.('`/root/workspace`.');
        return { fullText: 'The exact output is `/root/workspace`.', metadata: { model: 'grok-code' } };
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      { type: 'send', message: 'run pwd', provider: 'GROK', session: 'new-test' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads.filter((payload) => payload.type === 'thinking')).toEqual([
      expect.objectContaining({ content: 'I will inspect the working directory.' }),
    ]);
    expect(payloads.filter((payload) => payload.type === 'tool_start')).toEqual([
      expect.objectContaining({ toolName: 'shell', toolCallId: 'grok-tool-1' }),
    ]);
    expect(payloads.filter((payload) => payload.type === 'tool_end')).toEqual([
      expect.objectContaining({ toolName: 'shell', toolResult: '/root/workspace' }),
    ]);
    expect(payloads.filter((payload) => payload.type === 'text').map((payload) => payload.content))
      .toEqual(['The exact output is ', '`/root/workspace`.']);
    expect(payloads.filter((payload) => payload.type === 'done')).toEqual([
      expect.objectContaining({
        content: 'The exact output is `/root/workspace`.',
        sessionKey: 'grok-route-bus-session',
        runId: expect.any(String),
      }),
    ]);
  });

  test('tracks direct delivery per browser socket rather than per session observer', () => {
    const sessionId = 'native-reconnect-session';
    streamEventBus.startStream(sessionId, 'run-native-reconnect');
    const firstSocket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    firstSocket.readyState = 1;
    firstSocket.send = jest.fn();
    const secondSocket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    secondSocket.readyState = 1;
    secondSocket.send = jest.fn();

    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: firstSocket as any,
      sessionKey: sessionId,
      providerName: 'GROK',
      streamInfo: __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId),
    })).toBe(true);
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(firstSocket as any, sessionId)).toBe(true);
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(secondSocket as any, sessionId)).toBe(false);

    firstSocket.emit('close');
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(firstSocket as any, sessionId)).toBe(false);
  });

  test.each(['done', 'error'] as const)(
    'keeps native %s delivery registered until global fan-out completes',
    async (terminalType) => {
      const sessionId = `terminal-global-fanout-${terminalType}`;
      const runId = `run-terminal-global-fanout-${terminalType}`;
      streamEventBus.startStream(sessionId, runId);
      const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
      socket.readyState = 1;
      socket.send = jest.fn();
      const globalSubscriptionStates: boolean[] = [];
      const unsubGlobal = streamEventBus.subscribeGlobal((observedSession, event) => {
        if (observedSession !== sessionId || event.type !== terminalType) return;
        const hasDirectSubscription = __gatewayExecutionScopeTest.wsHasSessionStreamSubscription(
          socket as any,
          sessionId,
        );
        globalSubscriptionStates.push(hasDirectSubscription);
        if (!hasDirectSubscription) socket.send(JSON.stringify({ ...event, sessionKey: sessionId }));
      });

      try {
        expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
          ws: socket as any,
          sessionKey: sessionId,
          providerName: 'GEMINI',
          streamInfo: __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId),
          keepSubscriptionAfterDone: false,
        })).toBe(true);

        streamEventBus.publish(sessionId, { type: terminalType, content: 'one terminal', runId });

        const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
        expect(payloads.filter((payload) => payload.type === terminalType)).toHaveLength(1);
        expect(globalSubscriptionStates).toEqual([true]);
        expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId)).toBe(true);

        await Promise.resolve();
        expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId)).toBe(false);
      } finally {
        unsubGlobal();
        socket.emit('close');
      }
    },
  );

  test('route-owned Agent Zero SSE callbacks are mirrored once and sanitize terminal metadata', async () => {
    jest.spyOn(agentZeroOAuthModels, 'validateAgentZeroOAuthModelSelection').mockResolvedValue({
      id: 'codex_oauth/gpt-5.6-terra',
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      providerDisplayName: 'OpenAI Codex OAuth',
      description: '',
    });
    const provider = {
      providerName: 'AGENT_ZERO',
      displayName: 'Agent Zero',
      startSession: jest.fn().mockResolvedValue('route-sse-session'),
      sendMessage: jest.fn(async (
        _sessionId: string,
        _message: string,
        onChunk?: (chunk: string) => void,
        onStatus?: (event: { type: string; content?: string; [key: string]: unknown }) => void,
      ) => {
        onStatus?.({ type: 'warning', content: 'bearerToken=provider-secret' });
        onChunk?.('agent zero text');
        return {
          fullText: 'agent zero text',
          metadata: { model: 'oauth/model', bearerToken: 'metadata-secret' },
        };
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const req = Object.assign(new EventEmitter(), {
      body: {
        message: 'hello',
        provider: 'AGENT_ZERO',
        session: 'new-test',
        model: 'codex_oauth/gpt-5.6-terra',
      },
      query: { stream: '1' },
      headers: { accept: 'text/event-stream' },
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    });
    const res = {
      socket: { setNoDelay: jest.fn() },
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await sendRouteHandler()(req as any, res as any);

    const payloads = res.write.mock.calls
      .map(([raw]) => String(raw))
      .flatMap((raw) => raw.split('\n'))
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(payloads.filter((payload) => payload.type === 'text')).toEqual([
      expect.objectContaining({ content: 'agent zero text' }),
    ]);
    expect(payloads.filter((payload) => payload.type === 'done')).toEqual([
      expect.objectContaining({
        content: 'agent zero text',
        metadata: { model: 'oauth/model', bearerToken: '[redacted]' },
      }),
    ]);
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'status',
      content: 'bearerToken=[redacted]',
      providerEventType: 'warning',
    }));
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test.each(['REST', 'SSE'])('%s preserves Agent Zero OAuth fallback guidance at the browser boundary', async (mode) => {
    jest.spyOn(agentZeroOAuthModels, 'validateAgentZeroOAuthModelSelection').mockResolvedValue({
      id: 'codex_oauth/gpt-5.6-terra',
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      providerDisplayName: 'OpenAI Codex OAuth',
      description: '',
    });
    const sessionId = mode === 'SSE' ? 'route-sse-session' : 'route-rest-session';
    jest.spyOn(AgentRegistry, 'get').mockReturnValue({
      providerName: 'AGENT_ZERO',
      displayName: 'Agent Zero',
      startSession: jest.fn().mockResolvedValue(sessionId),
      sendMessage: jest.fn(async () => {
        throw new Error(`Agent Zero run failed: ${AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE}`);
      }),
    } as any);

    const req = Object.assign(new EventEmitter(), {
      body: {
        message: 'hello',
        provider: 'AGENT_ZERO',
        session: 'new-test',
        model: 'codex_oauth/gpt-5.6-terra',
      },
      query: mode === 'SSE' ? { stream: '1' } : {},
      headers: mode === 'SSE' ? { accept: 'text/event-stream' } : {},
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    });
    const res = {
      socket: { setNoDelay: jest.fn() },
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await sendRouteHandler()(req as any, res as any);

    if (mode === 'REST') {
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
      }));
      return;
    }
    const payloads = res.write.mock.calls
      .map(([raw]) => String(raw))
      .flatMap((raw) => raw.split('\n'))
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'error',
      content: AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
    }));
  });

  test('HTTP /gateway/send preserves MODEL_PROTOCOL_INCOMPATIBLE for a stale direct selection', async () => {
    const provider = {
      providerName: 'AGENT_ZERO',
      displayName: 'Agent Zero',
      startSession: jest.fn(),
      sendMessage: jest.fn(),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    const req = Object.assign(new EventEmitter(), {
      body: {
        message: 'hello',
        provider: 'AGENT_ZERO',
        session: 'new-stale-model',
        model: 'codex_oauth/unknown-stale-model',
      },
      query: {},
      headers: {},
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await sendRouteHandler()(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
      detail: agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
      code: 'MODEL_PROTOCOL_INCOMPATIBLE',
    });
    expect(provider.startSession).not.toHaveBeenCalled();
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });

  test('WebSocket send preserves MODEL_PROTOCOL_INCOMPATIBLE for a stale direct selection', async () => {
    const provider = {
      providerName: 'AGENT_ZERO',
      displayName: 'Agent Zero',
      startSession: jest.fn(),
      sendMessage: jest.fn(),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      {
        type: 'send',
        message: 'hello',
        provider: 'AGENT_ZERO',
        session: 'new-stale-model',
        model: 'codex_oauth/unknown-stale-model',
      },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual({
      type: 'error',
      content: agentZeroOAuthModels.AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
      code: 'MODEL_PROTOCOL_INCOMPATIBLE',
    });
    expect(provider.startSession).not.toHaveBeenCalled();
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });

  test('same-session WebSocket sends reserve one logical turn before provider I/O', async () => {
    let releaseFirst!: () => void;
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const provider = {
      providerName: 'OLLAMA',
      displayName: 'Ollama',
      startSession: jest.fn().mockResolvedValue('concurrent-route-session'),
      sendMessage: jest.fn(async (
        _sessionId: string,
        _message: string,
        onChunk?: (chunk: string) => void,
      ) => {
        signalStarted();
        await firstPending;
        onChunk?.('only first turn');
        return { fullText: 'only first turn', metadata: { model: 'qwen-test' } };
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const firstSocket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    firstSocket.readyState = 1;
    firstSocket.send = jest.fn();
    const secondSocket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    secondSocket.readyState = 1;
    secondSocket.send = jest.fn();
    const owner = { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any;

    const firstSend = __gatewayExecutionScopeTest.handleWsSend(
      firstSocket as any,
      { type: 'send', message: 'first', provider: 'OLLAMA', session: 'new-test' },
      owner,
    );
    await firstStarted;
    await __gatewayExecutionScopeTest.handleWsSend(
      secondSocket as any,
      { type: 'send', message: 'second', provider: 'OLLAMA', session: 'concurrent-route-session' },
      owner,
    );

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(streamEventBus.getStreamStatus('concurrent-route-session')).toMatchObject({ active: true });
    const secondPayloads = secondSocket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(secondPayloads).toContainEqual(expect.objectContaining({
      type: 'error',
      content: 'This chat already has an active turn.',
    }));

    releaseFirst();
    await firstSend;
    const firstPayloads = firstSocket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(firstPayloads.filter((payload) => payload.type === 'text')).toHaveLength(1);
    expect(firstPayloads.filter((payload) => payload.type === 'done')).toHaveLength(1);
  });

  test('route-owned provider rejections publish one sanitized terminal error', async () => {
    jest.spyOn(agentZeroOAuthModels, 'validateAgentZeroOAuthModelSelection').mockResolvedValue({
      id: 'codex_oauth/gpt-5.6-terra',
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      providerDisplayName: 'OpenAI Codex OAuth',
      description: '',
    });
    const provider = {
      providerName: 'AGENT_ZERO',
      displayName: 'Agent Zero',
      startSession: jest.fn().mockResolvedValue('route-sse-session'),
      sendMessage: jest.fn(async () => {
        throw new Error(
          'litellm.AuthenticationError: OpenrouterException - No user or org id found in auth cookie; '
          + 'password=raw-secret Authorization: Bearer raw-bearer',
        );
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      {
        type: 'send',
        message: 'hello',
        provider: 'AGENT_ZERO',
        session: 'new-test',
        model: 'codex_oauth/gpt-5.6-terra',
      },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    const errors = payloads.filter((payload) => payload.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      terminal: true,
      runId: expect.any(String),
      content: AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
    });
    expect(JSON.stringify(errors)).not.toContain('raw-secret');
    expect(JSON.stringify(errors)).not.toContain('raw-bearer');
    expect(JSON.stringify(errors)).toContain('Agent Zero fell back to an OpenRouter default');
    expect(JSON.stringify(errors)).not.toContain('password=');
  });

  test('host-native CLI reconnect resumes the exact bus snapshot and live run', async () => {
    const sessionId = 'native-reconnect-session';
    streamEventBus.startStream(sessionId, 'run-native-reconnect', { provenance: 'via Codex CLI' });
    streamEventBus.updateStreamPhase(sessionId, { phase: 'streaming', runId: 'run-native-reconnect' });
    streamEventBus.publish(sessionId, { type: 'text', content: 'partial ', runId: 'run-native-reconnect' });
    streamEventBus.updateStreamPhase(sessionId, { phase: 'tool', toolName: 'read', runId: 'run-native-reconnect' });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsReconnect(
      socket as any,
      { session: sessionId, provider: 'CODEX' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    streamEventBus.publish(sessionId, { type: 'text', content: 'continued', runId: 'run-native-reconnect' });
    streamEventBus.publish(sessionId, { type: 'done', content: 'partial continued', runId: 'run-native-reconnect' });
    streamEventBus.softClearStream(sessionId);

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_resume',
      sessionKey: sessionId,
      runId: 'run-native-reconnect',
      content: 'partial ',
    }));
    expect(payloads.filter((payload) => payload.type === 'text' && payload.content === 'continued')).toHaveLength(1);
    expect(payloads.filter((payload) => payload.type === 'done')).toHaveLength(1);
  });

  test('OpenClaw reconnect suppresses preliminary errors without losing recovered completion', () => {
    const sessionId = 'openclaw-reconnect-preliminary';
    const runId = 'run-openclaw-preliminary';
    streamEventBus.startStream(sessionId, runId, { provenance: 'via OpenClaw' });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    const snapshot = __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId);
    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: socket as any,
      sessionKey: sessionId,
      providerName: 'OPENCLAW',
      streamInfo: snapshot,
      sendResume: true,
      keepSubscriptionAfterDone: true,
    })).toBe(true);

    streamEventBus.publish(sessionId, {
      type: 'error',
      content: 'preliminary transport warning',
      terminal: false,
      runId,
    });
    streamEventBus.publish(sessionId, { type: 'text', content: 'Recovered answer', runId });
    streamEventBus.publish(sessionId, { type: 'done', content: 'Recovered answer', runId });

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads.filter((payload) => payload.type === 'error')).toHaveLength(0);
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'text', content: 'Recovered answer', runId }));
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'done', content: 'Recovered answer', runId }));
    socket.emit('close');
  });

  test('stream attachment subscribes before stream_resume can trigger terminal delivery', () => {
    const sessionId = 'resume-subscribe-race';
    const runId = 'run-resume-race';
    streamEventBus.startStream(sessionId, runId);
    const snapshot = __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId);

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn((raw: string) => {
      const payload = JSON.parse(String(raw));
      if (payload.type === 'stream_resume') {
        streamEventBus.publish(sessionId, { type: 'text', content: 'arrived during resume', runId });
        streamEventBus.publish(sessionId, { type: 'done', content: 'arrived during resume', runId });
      }
    });

    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: socket as any,
      sessionKey: sessionId,
      providerName: 'CODEX',
      streamInfo: snapshot,
      sendResume: true,
      keepSubscriptionAfterDone: false,
    })).toBe(true);

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads.map((payload) => payload.type)).toEqual(['stream_resume', 'text', 'done']);
    socket.emit('close');
  });

  test('stream attachment revalidates a stale snapshot to the replacement run', () => {
    const sessionId = 'stale-snapshot-attach';
    streamEventBus.startStream(sessionId, 'run-old');
    const staleSnapshot = __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId);
    streamEventBus.clearStream(sessionId, 'run-old');
    streamEventBus.startStream(sessionId, 'run-new');
    streamEventBus.publish(sessionId, { type: 'text', content: 'new partial', runId: 'run-new' });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: socket as any,
      sessionKey: sessionId,
      providerName: 'CODEX',
      streamInfo: staleSnapshot,
      sendResume: true,
      keepSubscriptionAfterDone: false,
    })).toBe(true);

    const resume = socket.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .find((payload) => payload.type === 'stream_resume');
    expect(resume).toMatchObject({ runId: 'run-new', content: 'new partial' });
    socket.emit('close');
  });

  test('a delayed OpenClaw abort cannot clear a replacement run or its subscription', async () => {
    const actorUserId = '22222222-2222-4222-8222-222222222222';
    const sessionId = `agent:main:portal-${actorUserId}-abort-race`;
    let resolveAbort!: (value: any) => void;
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockReturnValue(new Promise((resolve) => {
      resolveAbort = resolve;
    }) as any);

    streamEventBus.startStream(sessionId, 'run-old');
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    __gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: socket as any,
      sessionKey: sessionId,
      providerName: 'OPENCLAW',
      streamInfo: __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId),
      keepSubscriptionAfterDone: true,
    });

    const abortPromise = __gatewayExecutionScopeTest.handleWsAbort(socket as any, {
      provider: 'OPENCLAW',
      session: sessionId,
      runId: 'run-old',
      requestId: 'abort-race-request',
    }, { userId: actorUserId, email: 'owner@example.com', role: 'OWNER' } as any);
    await Promise.resolve();

    streamEventBus.clearStream(sessionId, 'run-old');
    streamEventBus.startStream(sessionId, 'run-new');
    streamEventBus.publish(sessionId, { type: 'run_resumed', content: '', runId: 'run-new' });
    resolveAbort({ ok: true, data: { aborted: true } });
    await abortPromise;
    streamEventBus.publish(sessionId, { type: 'text', content: 'replacement survived', runId: 'run-new' });

    expect(streamEventBus.getTrackedStream(sessionId)).toMatchObject({ active: true, runId: 'run-new' });
    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'abort_result',
      ok: true,
      requestId: 'abort-race-request',
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'text',
      content: 'replacement survived',
      runId: 'run-new',
    }));
    socket.emit('close');
  });

  test('active OpenClaw hydration removes terminal projections but other snapshots are unchanged', () => {
    const activeSnapshot = {
      active: true,
      runId: 'run-safe-hydration',
      turnEvents: [
        { type: 'assistant_delta', runId: 'run-safe-hydration', text: 'partial', terminal: false },
        { type: 'turn_error', runId: 'run-safe-hydration', text: 'preliminary', terminal: true },
        { type: 'assistant_status', runId: 'run-old', text: 'stale' },
      ],
    } as any;
    expect(__gatewayExecutionScopeTest.browserSafeActiveStreamSnapshot('OPENCLAW', activeSnapshot).turnEvents)
      .toEqual([expect.objectContaining({ type: 'assistant_delta', runId: 'run-safe-hydration' })]);
    expect(__gatewayExecutionScopeTest.browserSafeActiveStreamSnapshot('CODEX', activeSnapshot)).toBe(activeSnapshot);
    const terminalSnapshot = { ...activeSnapshot, active: false };
    expect(__gatewayExecutionScopeTest.browserSafeActiveStreamSnapshot('OPENCLAW', terminalSnapshot)).toBe(terminalSnapshot);
  });

  test('non-streaming OpenClaw recovery is enabled by a preliminary error without a model override', () => {
    expect(__gatewayExecutionScopeTest.shouldAttemptOpenClawReplyRecovery(
      'OPENCLAW',
      'preliminary gateway error',
      undefined,
    )).toBe(true);
    expect(__gatewayExecutionScopeTest.shouldAttemptOpenClawReplyRecovery(
      'OPENCLAW',
      null,
      undefined,
    )).toBe(false);
    expect(__gatewayExecutionScopeTest.shouldAttemptOpenClawReplyRecovery(
      'CODEX',
      'provider failure',
      'openai/gpt-5.6-sol',
    )).toBe(false);
  });

  test('keeps every direct-gateway mutation behind the Portal authorization broker', () => {
    const actor = { role: 'OWNER' } as any;
    for (const method of [
      'chat.send',
      'sessions.steer',
      'chat.abort',
      'chat.inject',
      'sessions.subscribe',
    ]) {
      expect(__gatewayExecutionScopeTest.isDirectGatewayMethodAllowed(method, actor)).toBe(false);
    }
    for (const method of [
      'connect',
      'chat.history',
      'sessions.messages.subscribe',
    ]) {
      expect(__gatewayExecutionScopeTest.isDirectGatewayMethodAllowed(method, actor)).toBe(true);
    }
    expect(__gatewayExecutionScopeTest.getDirectProxyScopes()).toEqual(['operator.read']);
  });

  test('direct gateway request schemas reject parser differentials and extra parameters', () => {
    const allowed = __gatewayExecutionScopeTest.isDirectGatewayRequestShapeAllowed;
    expect(allowed({
      type: 'req',
      id: 1,
      method: 'connect',
      params: { nonce: 'n'.repeat(32), scopes: ['operator.admin'] },
    })).toBe(true);
    expect(allowed({
      type: 'req',
      id: 2,
      method: 'connect',
      params: {},
    })).toBe(false);
    expect(allowed({
      type: 'req',
      id: 3,
      method: 'chat.history',
      params: { sessionKey: 'agent:main:portal-owner', limit: 200 },
    })).toBe(true);
    expect(allowed({
      type: 'req',
      id: 4,
      method: 'chat.history',
      params: { sessionKey: 'agent:main:portal-owner', limit: 501 },
    })).toBe(false);
    expect(allowed({
      type: 'req',
      id: 5,
      method: 'chat.history',
      params: { sessionKey: 'agent:main:portal-owner', mutate: true },
    })).toBe(false);
    expect(allowed({
      type: 'req',
      id: 6,
      method: 'sessions.messages.subscribe',
      params: { key: 'agent:main:portal-owner' },
    })).toBe(true);
    expect(allowed({
      type: 'req',
      id: 7,
      method: 'sessions.messages.subscribe',
      params: { key: 'agent:main:portal-owner', global: true },
    })).toBe(false);
    expect(allowed([])).toBe(false);
  });

  test('the actual signed connect frame discards browser-requested admin scopes', () => {
    const actor = {
      userId: 'abababab-abab-4bab-8bab-abababababab',
      email: 'owner@example.test',
      role: 'OWNER',
    } as any;
    const buildDevice = jest.fn(() => ({ signed: true }) as any);
    const frame = __gatewayExecutionScopeTest.buildDirectProxyConnectFrame({
      type: 'req',
      id: 41,
      method: 'connect',
      params: {
        nonce: 'c'.repeat(32),
        scopes: ['operator.admin', 'operator.approvals', 'operator.write'],
      },
    }, actor, {
      getToken: () => 'test-gateway-token',
      getKeys: () => ({ publicKey: 'test' }) as any,
      buildDevice,
    }) as any;

    expect(frame).toMatchObject({
      type: 'req',
      id: '41',
      method: 'connect',
      params: {
        auth: { token: 'test-gateway-token' },
        role: 'operator',
        scopes: ['operator.read'],
      },
    });
    expect(buildDevice).toHaveBeenCalledWith(expect.objectContaining({
      role: 'operator',
      scopes: ['operator.read'],
      token: 'test-gateway-token',
      nonce: 'c'.repeat(32),
    }));
    expect(JSON.stringify(frame)).not.toContain('operator.admin');
    expect(JSON.stringify(frame)).not.toContain('operator.approvals');
    expect(JSON.stringify(frame)).not.toContain('operator.write');
  });

  test('direct gateway events default-deny unknown, global, and nested approval payloads', async () => {
    const actorId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const ownedKey = `agent:main:portal-${actorId}-owned`;
    const actor = { userId: actorId, role: 'OWNER' } as any;
    const { database, agentSession } = createOwnershipDatabase([{
      id: 'owned-event-claim',
      userId: actorId,
      externalId: ownedKey,
    }]);

    await expect(__gatewayExecutionScopeTest.isDirectGatewayEventAllowed({
      type: 'event',
      event: 'session.message',
      payload: { sessionKey: ownedKey, message: { role: 'assistant' } },
    }, actor, database)).resolves.toBe(true);
    await expect(__gatewayExecutionScopeTest.isDirectGatewayEventAllowed({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { request: { sessionKey: ownedKey, command: 'private command' } },
    }, actor, database)).resolves.toBe(false);
    await expect(__gatewayExecutionScopeTest.isDirectGatewayEventAllowed({
      type: 'event',
      event: 'plugin.private',
      payload: {},
    }, actor, database)).resolves.toBe(false);
    await expect(__gatewayExecutionScopeTest.isDirectGatewayEventAllowed({
      type: 'event',
      event: 'sessions.changed',
      payload: {},
    }, actor, database)).resolves.toBe(false);
    expect(agentSession.update).not.toHaveBeenCalled();
    expect(agentSession.create).not.toHaveBeenCalled();
  });

  test('allows only a bounded connect challenge without treating it as session data', async () => {
    const actor = { userId: 'owner-1', role: 'OWNER' } as any;
    const { database } = createOwnershipDatabase();
    await expect(__gatewayExecutionScopeTest.isDirectGatewayEventAllowed({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'a'.repeat(32) },
    }, actor, database)).resolves.toBe(true);
    await expect(__gatewayExecutionScopeTest.isDirectGatewayEventAllowed({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'short' },
    }, actor, database)).resolves.toBe(false);
  });

  test('journals an OpenClaw host send before dispatch and settles only after the ACK callback', async () => {
    const begin = jest.spyOn(openClawHostRunJournal, 'beginOpenClawHostRun')
      .mockImplementation(async (handle) => handle);
    const markDispatch = jest.spyOn(
      openClawHostRunJournal,
      'markOpenClawHostRunDispatchAccepted',
    ).mockResolvedValue();
    const markVisible = jest.spyOn(
      openClawHostRunJournal,
      'markOpenClawHostRunVisibleSettled',
    ).mockResolvedValue();
    const quarantine = jest.spyOn(openClawHostRunJournal, 'quarantineOpenClawHostRun')
      .mockResolvedValue();
    const sendMessage = jest.fn(async (...args: any[]) => {
      await args[5].onProviderDispatchAccepted('upstream-exact-1');
      return { fullText: 'complete' };
    });
    const provider = {
      providerName: 'OPENCLAW',
      displayName: 'OpenClaw',
      sendMessage,
    } as any;

    await expect(__gatewayExecutionScopeTest.sendHostOperatorProviderMessage({
      provider,
      sessionId: 'agent:main:portal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      message: 'hello',
      sender: {
        label: 'owner@example.com',
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        authorizationVersion: 9,
        requestId: 'route-request-1',
      },
    })).resolves.toEqual({ fullText: 'complete' });

    const handle = {
      id: 'route-request-1',
      actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      actorAuthorizationVersion: 9,
      provider: 'OPENCLAW',
      executionScope: 'HOST_OPERATOR',
      sessionKey: 'agent:main:portal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    expect(begin).toHaveBeenCalledWith(handle);
    expect(markDispatch).toHaveBeenCalledWith(handle, 'upstream-exact-1');
    expect(markVisible).toHaveBeenCalledWith(handle, 'completed');
    expect(quarantine).not.toHaveBeenCalled();
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
    expect(markDispatch.mock.invocationCallOrder[0]).toBeLessThan(markVisible.mock.invocationCallOrder[0]);
  });

  test('quarantines an ambiguous OpenClaw send before surfacing its error', async () => {
    jest.spyOn(openClawHostRunJournal, 'beginOpenClawHostRun')
      .mockImplementation(async (handle) => handle);
    jest.spyOn(openClawHostRunJournal, 'markOpenClawHostRunDispatchAccepted')
      .mockResolvedValue();
    const markVisible = jest.spyOn(
      openClawHostRunJournal,
      'markOpenClawHostRunVisibleSettled',
    ).mockResolvedValue();
    const quarantine = jest.spyOn(openClawHostRunJournal, 'quarantineOpenClawHostRun')
      .mockResolvedValue();
    const providerError = new Error('provider outcome ambiguous');
    const sendMessage = jest.fn(async (...args: any[]) => {
      await args[5].onProviderDispatchAccepted('upstream-exact-2');
      throw providerError;
    });

    await expect(__gatewayExecutionScopeTest.sendHostOperatorProviderMessage({
      provider: {
        providerName: 'OPENCLAW',
        displayName: 'OpenClaw',
        sendMessage,
      } as any,
      sessionId: 'agent:main:portal-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      message: 'hello',
      sender: {
        label: 'owner@example.com',
        userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        authorizationVersion: 3,
        requestId: 'route-request-2',
      },
    })).rejects.toBe(providerError);

    expect(markVisible).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'route-request-2' }),
      providerError,
    );
    expect(sendMessage.mock.invocationCallOrder[0])
      .toBeLessThan(quarantine.mock.invocationCallOrder[0]);
  });

  test('retains the mutation lease when OpenClaw ambiguity cannot be durably quarantined', async () => {
    jest.spyOn(openClawHostRunJournal, 'beginOpenClawHostRun')
      .mockImplementation(async (handle) => handle);
    jest.spyOn(openClawHostRunJournal, 'quarantineOpenClawHostRun')
      .mockRejectedValue(new Error('database unavailable'));
    const retainLease = jest.fn();

    await expect(__gatewayExecutionScopeTest.sendHostOperatorProviderMessage({
      provider: {
        providerName: 'OPENCLAW',
        displayName: 'OpenClaw',
        sendMessage: jest.fn(async () => {
          throw new Error('transport closed');
        }),
      } as any,
      sessionId: 'agent:main:portal-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      message: 'hello',
      sender: {
        label: 'owner@example.com',
        userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        authorizationVersion: 6,
        requestId: 'route-request-3',
      },
      onQuarantinePersistenceFailure: retainLease,
    })).rejects.toThrow('could not be durably quarantined');

    expect(retainLease).toHaveBeenCalledTimes(1);
  });
});

describe('host-created OpenClaw sessions stay reachable', () => {
  const OWNER = '11111111-2222-4333-8444-555555555555';
  const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  test('an owned `new-<ts>` session opens itself, not an empty Portal-scoped room', async () => {
    const { database } = createOwnershipDatabase([{
      id: 'host-chat-claim',
      userId: OWNER,
      externalId: 'agent:main:new-1780000000000',
    }]);

    await expect(__gatewayExecutionScopeTest.resolveOpenClawSessionKey(
      'agent:main:new-1780000000000',
      { userId: OWNER, role: 'OWNER' } as any,
      database,
    )).resolves.toBe('agent:main:new-1780000000000');
  });

  test('an unclaimed `new-<ts>` alias still resolves into the caller namespace', async () => {
    const { database } = createOwnershipDatabase();

    await expect(__gatewayExecutionScopeTest.resolveOpenClawSessionKey(
      'agent:main:new-1780000000000',
      { userId: OWNER, role: 'OWNER' } as any,
      database,
    )).resolves.toBe(`agent:main:portal-${OWNER}-new-1780000000000`);
  });

  test('another user\'s claim never redirects this caller onto their transcript', async () => {
    const { database } = createOwnershipDatabase([{
      id: 'foreign-chat-claim',
      userId: OTHER,
      externalId: 'agent:main:new-1780000000000',
    }]);

    await expect(__gatewayExecutionScopeTest.resolveOpenClawSessionKey(
      'agent:main:new-1780000000000',
      { userId: OWNER, role: 'OWNER' } as any,
      database,
    )).resolves.toBe(`agent:main:portal-${OWNER}-new-1780000000000`);
  });

  test('the bare `new-<ts>` form follows the same rule', async () => {
    const { database } = createOwnershipDatabase([{
      id: 'host-chat-claim',
      userId: OWNER,
      externalId: 'agent:main:new-1780000000000',
    }]);

    await expect(__gatewayExecutionScopeTest.resolveOpenClawSessionKey(
      'new-1780000000000',
      { userId: OWNER, role: 'OWNER' } as any,
      database,
    )).resolves.toBe('agent:main:new-1780000000000');
  });

  test('the Owner may claim an unscoped host session; a sub-admin may not', async () => {
    const owned = createOwnershipDatabase();
    await __gatewayExecutionScopeTest.claimOpenClawAgentSession(
      'agent:main:dashboard:0b3a4512-f580-4f3e-a573-f9363e26f5a5',
      OWNER,
      owned.database,
      'OWNER',
    );
    expect(owned.agentSession.create).toHaveBeenCalledTimes(1);

    const refused = createOwnershipDatabase();
    await expect(__gatewayExecutionScopeTest.claimOpenClawAgentSession(
      'agent:main:dashboard:0b3a4512-f580-4f3e-a573-f9363e26f5a5',
      OTHER,
      refused.database,
      'SUB_ADMIN',
    )).rejects.toThrow('Admin access required');
    expect(refused.agentSession.create).not.toHaveBeenCalled();
  });

  test('not even the Owner may claim a session scoped to another Portal user', async () => {
    const { database, agentSession } = createOwnershipDatabase();

    await expect(__gatewayExecutionScopeTest.claimOpenClawAgentSession(
      `agent:main:portal-${OTHER}-new-1785561330794`,
      OWNER,
      database,
      'OWNER',
    )).rejects.toThrow('Admin access required');
    expect(agentSession.create).not.toHaveBeenCalled();
  });
});
