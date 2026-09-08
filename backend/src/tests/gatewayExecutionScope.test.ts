import { EventEmitter } from 'events';
import * as unqualifiedNativeBinaryLane from '../config/unqualifiedNativeBinaryLane';
import gatewayRouter, { __gatewayExecutionScopeTest } from '../routes/gateway';
import { AgentRegistry } from '../agents';
import { __persistentGatewayWsTest } from '../agents/providers/PersistentGatewayWs';
import { streamEventBus, type StreamEvent } from '../services/StreamEventBus';
import * as openclawGatewayRpc from '../utils/openclawGatewayRpc';
import * as openClawHostRunJournal from '../services/openClawHostRunJournal';
import * as openClawExecutionAdmission from '../services/openClawExecutionAdmission';
import * as hostAgentRunJournal from '../services/hostAgentRunJournal';
import * as nativeSessionStore from '../agents/providers/NativeSessionStore';
import * as agentZeroOAuthModels from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';
import {
  publishSessionRevoked,
  sessionRevocationSubscriberCount,
} from '../services/sessionRevocationBus';
import {
  AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
} from '../agents/providers/agentZero/AgentZeroDiagnostics';
import { prisma } from '../config/database';
import {
  buildPortalOpenClawIdempotencyKey,
  portalClientMessageIdFromIdempotencyKey,
} from '../agents/providers/PortalMessageIdentity';
import { requestNativeCliApproval } from '../agents/nativeCliApprovals';

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

function mockDurableAccessIdentity(input: {
  userId: string;
  sessionId: string;
  email?: string;
  role?: string;
  authorizationVersion?: number;
}) {
  const email = input.email || 'owner@example.com';
  const role = input.role || 'OWNER';
  const authorizationVersion = input.authorizationVersion ?? 1;
  const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const payload = {
    userId: input.userId,
    sessionId: input.sessionId,
    email,
    role,
    accountStatus: 'ACTIVE',
    sandboxEnabled: true,
    authorizationVersion,
    exp: Math.floor((Date.now() + 30 * 60 * 1000) / 1000),
  };
  const userDelegate = prisma.user as any;
  const findUnique = jest.spyOn(userDelegate, 'findUnique').mockImplementation(async (args: any) => {
    if (args?.where?.id !== input.userId) return null;
    const selectedSessionId = args?.select?.sessions?.where?.id;
    return {
      id: input.userId,
      email,
      role,
      accountStatus: 'ACTIVE',
      isActive: true,
      sandboxEnabled: true,
      authorizationVersion,
      sessions: selectedSessionId === input.sessionId
        ? [{ id: input.sessionId, expiresAt: sessionExpiresAt }]
        : [],
    } as any;
  });

  return {
    payload,
    expectDurableLookup: () => {
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: input.userId },
        select: expect.objectContaining({
          authorizationVersion: true,
          sessions: {
            where: {
              id: input.sessionId,
              expiresAt: { gt: expect.any(Date) },
            },
            select: { id: true, expiresAt: true },
            take: 1,
          },
        }),
      }));
    },
  };
}

describe('Agent Chat execution boundary', () => {
  test('searches every persisted native harness namespace when proving session ownership', () => {
    expect(__gatewayExecutionScopeTest.nativeAgentSessionProviders).toEqual([
      'CLAUDE_CODE',
      'CODEX',
      'GEMINI',
      'GROK',
      'AGENT_ZERO',
      'OLLAMA',
      'HERMES',
      'OPENCODE',
    ]);
  });

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
    // Route tests supply providers through the registry seam, not the host's
    // installed CLI inventory. getAsync is the current HTTP admission entry.
    jest.spyOn(AgentRegistry, 'getAsync').mockImplementation(async (name) => AgentRegistry.get(name));
    jest.spyOn(prisma.projectWorkCard, 'updateMany').mockResolvedValue({ count: 0 });
    jest.spyOn(openClawHostRunJournal, 'markOpenClawHostRunDispatchAccepted').mockResolvedValue();
    const readyAdmission = {
      state: 'ready',
      ready: true,
      reason: 'ready for route testing',
      checkedAt: '2026-08-22T21:00:00.000Z',
      evidence: {
        authorizationFence: 'absent',
        maintenanceMarker: 'absent',
        hostMutationJournal: 'absent',
      },
      readinessBlockers: [],
    } as const;
    jest.spyOn(openClawExecutionAdmission, 'assertOpenClawExecutionAdmitted')
      .mockResolvedValue(readyAdmission);
    jest.spyOn(openClawExecutionAdmission, 'assertCachedOpenClawExecutionAdmitted')
      .mockReturnValue(readyAdmission);
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
    streamEventBus.clearStream('host-http-history');
    streamEventBus.clearStream('host-ws-history');
    streamEventBus.clearStream('project-native-reconnect');
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
    streamEventBus.clearStream('native-reconnect-completed');
    jest.restoreAllMocks();
  });

  test('native conversation creation persists an owner-scoped parent without model dispatch and rejects a non-operator', async () => {
    const provider = { providerName: 'CODEX', displayName: 'Codex',
      startSession: jest.fn().mockResolvedValue('codex-project-parent'), sendMessage: jest.fn() };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    const handler = gatewayRouteHandler('/session-create');
    const req = { body: { provider: 'CODEX', session: 'main', model: 'chosen-model' }, user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler(req, res);
    expect(provider.startSession).toHaveBeenCalledWith('owner-1', expect.objectContaining({ model: 'chosen-model',
      executionContext: expect.objectContaining({ scope: 'HOST_OPERATOR', userId: 'owner-1' }) }));
    expect(res.json).toHaveBeenCalledWith({ ok: true, key: 'codex-project-parent' });
    expect(provider.sendMessage).not.toHaveBeenCalled();
    provider.startSession.mockClear();
    await handler({ ...req, user: { ...req.user, role: 'USER' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(provider.startSession).not.toHaveBeenCalled();
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

  test('read-only authorization accepts actor-namespaced Portal keys without touching the claim', async () => {
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
    )).resolves.toBeUndefined();
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

  test('accepts the additive harness request field while preserving provider fallback', () => {
    expect(__gatewayExecutionScopeTest.harnessOrProviderInput({ harness: 'CODEX' })).toBe('CODEX');
    expect(__gatewayExecutionScopeTest.harnessOrProviderInput({ provider: 'CLAUDE_CODE' })).toBe('CLAUDE_CODE');
    expect(__gatewayExecutionScopeTest.harnessOrProviderInput({
      harness: 'GROK',
      provider: 'OPENCLAW',
    })).toBe('GROK');
    expect(__gatewayExecutionScopeTest.harnessOrProviderInput(null)).toBeUndefined();
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

  test('directs managed auth failures to Project credentials without suggesting host CLI login', () => {
    const claude = __gatewayExecutionScopeTest.humanizeProviderError('CLAUDE_CODE', 'Please run /login');
    expect(claude).toMatch(/process-free sign-in/i);
    expect(claude).toMatch(/Interactive host Claude login remains unavailable/i);
    expect(claude).toMatch(/supervised Agent Chat can use an existing attested host credential/i);
    expect(claude).not.toMatch(/Run \/login/i);

    const codex = __gatewayExecutionScopeTest.humanizeProviderError(
      'CODEX',
      'failed to connect to websocket: HTTP error: 500 Internal Server Error, url: wss://api.openai.com/v1/responses',
    );
    expect(codex).toMatch(/Project credential and network policy/i);
    expect(codex).toMatch(/supervised host Agent Chat is a separate execution boundary/i);
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

  test('HTTP managed approval allow resolves only the active native provider continuation', async () => {
    let approval: any;
    const decisionPromise = requestNativeCliApproval({
      providerName: 'CODEX',
      sessionId: 'managed-approval-http',
      command: 'read-only fixture',
      onRequest: (value) => { approval = value; },
    });
    const handler = gatewayRouteHandler('/exec-approval/resolve');

    const positiveRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler({ body: { approvalId: approval.id, decision: 'allow-once' } }, positiveRes);
    expect(positiveRes.status).not.toHaveBeenCalled();
    expect(positiveRes.json).toHaveBeenCalledWith({ ok: true, approvalId: approval.id, decision: 'allow-once' });
    await expect(decisionPromise).resolves.toBe('allow-once');
  });

  test('WebSocket managed approval allow resolves only the active native provider continuation', async () => {
    let approval: any;
    const decisionPromise = requestNativeCliApproval({
      providerName: 'CLAUDE_CODE',
      sessionId: 'managed-approval-ws',
      command: 'read-only fixture',
      onRequest: (value) => { approval = value; },
    });
    const ws = { readyState: 1, send: jest.fn() } as any;
    const user = { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any;

    await __gatewayExecutionScopeTest.handleWsExecApproval(ws, {
      approvalId: approval.id,
      decision: 'allow-always',
    }, user);
    expect(JSON.parse(String(ws.send.mock.calls[0][0]))).toMatchObject({
      type: 'approval_result',
      ok: true,
      approvalId: approval.id,
      decision: 'allow-always',
    });
    await expect(decisionPromise).resolves.toBe('allow-always');
  });

  test('HTTP managed approval denial remains available without starting a new provider attempt', async () => {
    let approval: any;
    const decisionPromise = requestNativeCliApproval({
      providerName: 'CODEX',
      sessionId: 'managed-denial-http',
      command: 'read-only fixture',
      onRequest: (value) => { approval = value; },
    });
    const handler = gatewayRouteHandler('/exec-approval/resolve');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await handler({ body: { approvalId: approval.id, decision: 'deny' } }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, approvalId: approval.id, decision: 'deny' });
    await expect(decisionPromise).resolves.toBe('deny');
  });

  test('WebSocket managed approval denial remains available without starting a new provider attempt', async () => {
    let approval: any;
    const decisionPromise = requestNativeCliApproval({
      providerName: 'CLAUDE_CODE',
      sessionId: 'managed-denial-ws',
      command: 'read-only fixture',
      onRequest: (value) => { approval = value; },
    });
    const ws = { readyState: 1, send: jest.fn() } as any;
    const user = { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any;

    await __gatewayExecutionScopeTest.handleWsExecApproval(ws, {
      approvalId: approval.id,
      decision: 'deny',
    }, user);

    expect(JSON.parse(String(ws.send.mock.calls[0][0]))).toMatchObject({
      type: 'approval_result',
      ok: true,
      approvalId: approval.id,
      decision: 'deny',
    });
    await expect(decisionPromise).resolves.toBe('deny');
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
      providerName: 'HERMES',
      displayName: 'Hermes',
      abortActiveRun: jest.fn().mockResolvedValue(false),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    streamEventBus.startStream('abort-route-session', 'run-active');
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsAbort(socket as any, {
      harness: 'OLLAMA',
      session: 'abort-route-session',
      runId: 'run-active',
      requestId: 'abort-request-1',
    });

    const payload = JSON.parse(String(socket.send.mock.calls[0][0]));
    expect(payload).toMatchObject({
      type: 'abort_result',
      ok: false,
      sessionKey: 'abort-route-session',
      harness: 'OLLAMA',
      provider: 'OLLAMA',
      runId: 'run-active',
      requestId: 'abort-request-1',
    });
    expect(streamEventBus.getStreamStatus('abort-route-session')).toMatchObject({
      active: true,
      runId: 'run-active',
    });
  });

  test('OpenClaw abort confirmation requires a strict non-empty run list containing the requested run', () => {
    const confirm = __gatewayExecutionScopeTest.confirmedOpenClawAbortRunIds;
    expect(confirm({ aborted: true, runIds: ['run-active'] }, 'run-active'))
      .toEqual(['run-active']);
    for (const response of [
      undefined,
      {},
      { aborted: true },
      { aborted: 'true', runIds: ['run-active'] },
      { aborted: true, runIds: [] },
      { aborted: true, runIds: ['run-other'] },
      { aborted: true, runIds: ['run-active', 'run-active'] },
      { aborted: true, runIds: [' run-active '] },
      { aborted: true, runIds: [true] },
    ]) {
      expect(confirm(response, 'run-active')).toBeNull();
    }
  });

  test('an unconfirmed OpenClaw WebSocket abort keeps the active stream and subscription', async () => {
    const actorUserId = '33333333-3333-4333-8333-333333333333';
    const sessionId = `agent:main:portal-${actorUserId}-abort-unconfirmed`;
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockResolvedValue({
      ok: true,
      data: { aborted: true },
    } as any);
    streamEventBus.startStream(sessionId, 'run-active');
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

    await __gatewayExecutionScopeTest.handleWsAbort(socket as any, {
      provider: 'OPENCLAW',
      session: sessionId,
      runId: 'run-active',
      requestId: 'abort-unconfirmed-request',
    }, { userId: actorUserId, email: 'owner@example.com', role: 'OWNER' } as any);

    expect(streamEventBus.getTrackedStream(sessionId)).toMatchObject({
      active: true,
      runId: 'run-active',
    });
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId))
      .toBe(true);
    const payload = socket.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)))
      .find((item) => item.type === 'abort_result');
    expect(payload).toMatchObject({
      ok: false,
      runIds: [],
      requestId: 'abort-unconfirmed-request',
    });
    socket.emit('close');
    streamEventBus.clearStream(sessionId, 'run-active');
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

  test('direct proxy settles its synthetic reservation before forwarding chat.send success', async () => {
    const sessionKey = 'direct-proxy-response-ack';
    const reservationRunId = 'direct-response-reservation';
    const upstreamRunId = 'direct-response-upstream';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
      )).toBe(true);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: upstreamRunId,
        stream: 'thinking',
        data: { text: 'Buffered before the direct acknowledgement.' },
      });

      const response = await __gatewayExecutionScopeTest.settleDirectGatewayChatSendResponse(
        {
          method: 'chat.send',
          sessionKey,
          reservationRunId,
          clientMessageId: 'msg-direct-ack',
        },
        { type: 'res', ok: true, payload: { runId: upstreamRunId } },
      );

      expect(response).toMatchObject({ ok: true, payload: { runId: upstreamRunId } });
      expect(streamEventBus.getTrackedStream(sessionKey)).toMatchObject({
        active: true,
        runId: upstreamRunId,
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: upstreamRunId }),
        expect.objectContaining({
          type: 'thinking',
          content: 'Buffered before the direct acknowledgement.',
          runId: upstreamRunId,
        }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('direct proxy parks a success response without a run ID until the exact user mirror adopts it', async () => {
    const sessionKey = 'direct-proxy-response-missing-run';
    const reservationRunId = 'direct-response-missing-run-reservation';
    const upstreamRunId = 'direct-response-missing-run-recovered';
    const idempotencyKey = 'portal-direct-response-request:client:msg-direct-missing-run';

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
      )).toBe(true);

      const response = await __gatewayExecutionScopeTest.settleDirectGatewayChatSendResponse(
        {
          method: 'chat.send',
          sessionKey,
          reservationRunId,
          clientMessageId: 'msg-direct-missing-run',
          idempotencyKey,
        },
        { type: 'res', ok: true, payload: { status: 'accepted' } },
      );

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'CHAT_SEND_UNCONFIRMED',
          sessionKey,
          clientMessageId: 'msg-direct-missing-run',
        },
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: reservationRunId,
      }));

      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        activeRunIds: [upstreamRunId],
        message: {
          role: 'user',
          content: 'Recover the accepted response without an ACK run ID.',
          idempotencyKey: `${idempotencyKey}:user`,
        },
      });
      await expect(__persistentGatewayWsTest.finalizeAmbiguousRunDispatch(
        sessionKey,
        upstreamRunId,
      )).resolves.toBe(true);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: upstreamRunId,
        state: 'final',
        message: { role: 'assistant', content: 'Recovered missing-run response.' },
      });
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        'direct-after-missing-run',
      )).toBe(true);
    } finally {
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, 'direct-after-missing-run');
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('direct proxy reconciles an upstream TURN_ACTIVE response and returns exact browser identity', async () => {
    const sessionKey = 'agent:main:portal-owner-1-direct-turn-active';
    const reservationRunId = 'direct-turn-active-reservation';
    const upstreamRunId = 'direct-turn-active-upstream';
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockResolvedValue({
      ok: true,
      data: {
        sessions: [{ key: sessionKey, hasActiveRun: true, activeRunIds: [upstreamRunId] }],
      },
    } as any);

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
      )).toBe(true);

      const response = await __gatewayExecutionScopeTest.settleDirectGatewayChatSendResponse(
        {
          method: 'chat.send',
          sessionKey,
          reservationRunId,
          clientMessageId: 'msg-direct-conflict',
        },
        {
          type: 'res',
          ok: false,
          error: { code: 'TURN_ACTIVE', message: 'A different run is already active.' },
        },
      );

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'TURN_ACTIVE',
          sessionKey,
          clientMessageId: 'msg-direct-conflict',
          activeStream: { active: true, runId: upstreamRunId },
        },
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toMatchObject({
        active: true,
        runId: upstreamRunId,
      });
    } finally {
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('normalizes Portal direct idempotency keys back to their optimistic message id', () => {
    expect(__gatewayExecutionScopeTest.normalizeDirectGatewayClientMessageId(
      'portal-msg-1786150000000-7:user',
    )).toBe('msg-1786150000000-7');
    expect(__gatewayExecutionScopeTest.normalizeDirectGatewayClientMessageId(
      'msg-legacy-direct-1',
    )).toBe('msg-legacy-direct-1');
    expect(__gatewayExecutionScopeTest.normalizeDirectGatewayClientMessageId('portal-')).toBeUndefined();
  });

  test('keeps server entropy when two sessions reuse the same optimistic browser message id', () => {
    const first = buildPortalOpenClawIdempotencyKey(
      'server-request-a',
      'msg-1786150000000-1',
    );
    const second = buildPortalOpenClawIdempotencyKey(
      'server-request-b',
      'msg-1786150000000-1',
    );

    expect(first).not.toBe(second);
    expect(first).toBe('portal-server-request-a:client:msg-1786150000000-1');
    expect(second).toBe('portal-server-request-b:client:msg-1786150000000-1');
    expect(portalClientMessageIdFromIdempotencyKey(`${first}:user`))
      .toBe('msg-1786150000000-1');
    expect(portalClientMessageIdFromIdempotencyKey(`${second}:user`))
      .toBe('msg-1786150000000-1');
  });

  test('direct pre-ack timeout parks, adopts the correlated run, and releases the next send', async () => {
    jest.useFakeTimers();
    const sessionKey = 'direct-ack-timeout';
    const reservationRunId = 'direct-timeout-reservation';
    const upstreamRunId = 'direct-timeout-recovered-run';
    const idempotencyKey = 'portal-msg-direct-timeout';
    const onExpire = jest.fn();
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        reservationRunId,
      )).toBe(true);
      __gatewayExecutionScopeTest.scheduleDirectGatewayChatRunTimeout(
        sessionKey,
        reservationRunId,
        idempotencyKey,
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
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: reservationRunId,
      }));

      // OpenClaw accepted before the ACK was lost. Its durable/live user mirror
      // binds the replacement run to this exact idempotency key; only then may
      // the buffered lane be adopted.
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        activeRunIds: [upstreamRunId],
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Recover this direct send.' }],
          idempotencyKey: `${idempotencyKey}:user`,
        },
      });
      await expect(__persistentGatewayWsTest.finalizeAmbiguousRunDispatch(
        sessionKey,
        upstreamRunId,
      )).resolves.toBe(true);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: upstreamRunId,
        stream: 'thinking',
        data: { text: 'Recovered reasoning', delta: 'Recovered reasoning' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: upstreamRunId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered final.' }] },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: upstreamRunId }),
        expect.objectContaining({ type: 'thinking', content: 'Recovered reasoning', runId: upstreamRunId }),
        expect.objectContaining({ type: 'done', content: 'Recovered final.', runId: upstreamRunId }),
      ]));
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        'direct-next-run',
      )).toBe(true);
    } finally {
      unsubscribe();
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, 'direct-next-run');
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, reservationRunId);
      __persistentGatewayWsTest.resetSession(sessionKey);
      jest.useRealTimers();
    }
  });

  test('upstream-only OpenClaw conflicts rebuild an empty local lane from one exact live run', async () => {
    const sessionKey = 'agent:main:portal-owner-1-upstream-conflict';
    const routeRunId = 'portal-route-reservation';
    const upstreamRunId = 'openclaw-live-run';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      // Mirror the upstream rejection path: the pending Portal reservation is
      // failed and StreamEventBus is empty before conflict recovery begins.
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        routeRunId,
      )).toBe(true);
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, routeRunId);
      expect(streamEventBus.getTrackedStream(sessionKey)).toBeNull();

      const rpc = jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockImplementation(async (
        method: string,
        params: Record<string, any>,
      ) => {
        expect(method).toBe('sessions.list');
        expect(params).toEqual({ agentId: 'main', search: sessionKey, limit: 50 });
        return {
          ok: true,
          data: {
            sessions: [
              { key: 'agent:main:other', hasActiveRun: true, activeRunIds: ['wrong-run'] },
              { key: sessionKey, hasActiveRun: true, activeRunIds: [upstreamRunId] },
            ],
          },
        };
      });

      const snapshot = await __gatewayExecutionScopeTest.reconcileOpenClawActiveTurnConflict(sessionKey);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(snapshot).toMatchObject({
        active: true,
        phase: 'thinking',
        runId: upstreamRunId,
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toMatchObject({
        active: true,
        runId: upstreamRunId,
      });

      // The repair must clear PersistentGatewayWs's failed-reservation fence,
      // not merely paint an active StreamEventBus snapshot for the browser.
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: upstreamRunId,
        stream: 'thinking',
        data: { text: 'Recovered live reasoning', delta: 'Recovered live reasoning' },
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: upstreamRunId }),
        expect.objectContaining({
          type: 'thinking',
          content: 'Recovered live reasoning',
          runId: upstreamRunId,
        }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('an exact inactive OpenClaw conflict row settles the local recovery fence', async () => {
    const sessionKey = 'agent:main:portal-owner-1-settled-conflict';
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockResolvedValue({
      ok: true,
      data: {
        sessions: [{ key: sessionKey, hasActiveRun: false, activeRunIds: [] }],
      },
    } as any);

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        'stale-local-conflict-run',
      )).toBe(true);
      const snapshot = await __gatewayExecutionScopeTest.reconcileOpenClawActiveTurnConflict(sessionKey);
      expect(snapshot).toEqual({ active: false, inactiveReason: 'terminal', safeToClear: true });
      expect(streamEventBus.getTrackedStream(sessionKey)).toBeNull();
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        'next-run-after-exact-inactive',
      )).toBe(true);
    } finally {
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, 'next-run-after-exact-inactive');
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('serializes per-session global delivery even when the first authorization check is delayed or rejects', async () => {
    const chains = new Map<string, Promise<void>>();
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = __gatewayExecutionScopeTest.enqueueOrderedSessionDelivery(
      chains,
      'ordered-session',
      async () => {
        await firstGate;
        delivered.push('reasoning-seq-1');
      },
    );
    const second = __gatewayExecutionScopeTest.enqueueOrderedSessionDelivery(
      chains,
      'ordered-session',
      async () => { delivered.push('tool-seq-2'); },
    );

    await Promise.resolve();
    expect(delivered).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(delivered).toEqual(['reasoning-seq-1', 'tool-seq-2']);

    await expect(__gatewayExecutionScopeTest.enqueueOrderedSessionDelivery(
      chains,
      'ordered-session',
      async () => { throw new Error('authorization generation changed'); },
    )).rejects.toThrow('authorization generation changed');
    await __gatewayExecutionScopeTest.enqueueOrderedSessionDelivery(
      chains,
      'ordered-session',
      async () => { delivered.push('final-after-rejected-delivery'); },
    );
    expect(delivered).toEqual([
      'reasoning-seq-1',
      'tool-seq-2',
      'final-after-rejected-delivery',
    ]);
  });

  test('a stale active conflict probe cannot replace a newer local reservation', async () => {
    const sessionKey = 'agent:main:portal-owner-1-conflict-active-race';
    let resolveProbe!: (value: any) => void;
    const probeResult = new Promise<any>((resolve) => { resolveProbe = resolve; });
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockReturnValue(probeResult);

    try {
      const recovery = __gatewayExecutionScopeTest.reconcileOpenClawActiveTurnConflict(sessionKey);
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        'newer-local-run',
      )).toBe(true);
      resolveProbe({
        ok: true,
        data: {
          sessions: [{ key: sessionKey, hasActiveRun: true, activeRunIds: ['stale-upstream-run'] }],
        },
      });

      await expect(recovery).resolves.toEqual({
        active: false,
        inactiveReason: 'unknown',
        safeToClear: false,
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'newer-local-run',
      }));
    } finally {
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, 'newer-local-run');
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('a stale inactive conflict probe cannot clear a newer local reservation', async () => {
    const sessionKey = 'agent:main:portal-owner-1-conflict-inactive-race';
    let resolveProbe!: (value: any) => void;
    const probeResult = new Promise<any>((resolve) => { resolveProbe = resolve; });
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockReturnValue(probeResult);

    try {
      const recovery = __gatewayExecutionScopeTest.reconcileOpenClawActiveTurnConflict(sessionKey);
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        'newer-local-run',
      )).toBe(true);
      resolveProbe({
        ok: true,
        data: {
          sessions: [{ key: sessionKey, hasActiveRun: false, activeRunIds: [] }],
        },
      });

      await expect(recovery).resolves.toEqual({
        active: false,
        inactiveReason: 'unknown',
        safeToClear: false,
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'newer-local-run',
      }));
    } finally {
      __gatewayExecutionScopeTest.failDirectGatewayChatRun(sessionKey, 'newer-local-run');
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('a stale exact active conflict row cannot resurrect a tombstoned run', async () => {
    const sessionKey = 'agent:main:portal-owner-1-tombstoned-conflict';
    const completedRunId = 'openclaw-completed-run';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockResolvedValue({
      ok: true,
      data: {
        sessions: [{ key: sessionKey, hasActiveRun: true, activeRunIds: [completedRunId] }],
      },
    } as any);

    try {
      expect(__gatewayExecutionScopeTest.reserveDirectGatewayChatRun(
        sessionKey,
        completedRunId,
      )).toBe(true);
      expect(__gatewayExecutionScopeTest.acknowledgeDirectGatewayChatRun(
        sessionKey,
        completedRunId,
        completedRunId,
      )).toBe(true);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: completedRunId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Completed before stale conflict probe.' }],
        },
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: false,
        runId: completedRunId,
      }));
      events.length = 0;

      const snapshot = await __gatewayExecutionScopeTest.reconcileOpenClawActiveTurnConflict(sessionKey);
      expect(snapshot).toEqual({ active: false, inactiveReason: 'unknown', safeToClear: false });
      expect(events.some((event) => event.type === 'run_resumed')).toBe(false);
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: false,
        runId: completedRunId,
      }));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('WebSocket conflict recovery attaches the browser and retires its replaced keepalive', async () => {
    const userId = '44444444-4444-4444-8444-444444444444';
    const sessionKey = `agent:main:portal-${userId}-upstream-conflict`;
    const upstreamRunId = 'openclaw-upstream-only-run';
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    jest.spyOn(openClawHostRunJournal, 'beginOpenClawHostRun')
      .mockImplementation(async (handle) => handle);
    jest.spyOn(openClawHostRunJournal, 'quarantineOpenClawHostRun').mockResolvedValue();
    // Label hydration precedes the conflict probe. Mock its public boundary
    // explicitly: getSessionInfo() otherwise uses its module-local RPC binding,
    // which bypasses the gatewayRpcCall spy below and dials the real gateway.
    const getSessionInfoSpy = jest.spyOn(openclawGatewayRpc, 'getSessionInfo').mockResolvedValue({
      ok: true,
      data: { displayName: 'Existing chat' },
    });
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          ok: true,
          data: {
            sessions: [{ key: sessionKey, hasActiveRun: true, activeRunIds: [upstreamRunId] }],
          },
        };
      }
      return { ok: false, error: `Unexpected RPC ${method}` };
    });
    const provider = {
      providerName: 'OPENCLAW',
      displayName: 'OpenClaw',
      sendMessage: jest.fn(async (...args: any[]) => {
        const sender = args[5] as { requestId?: string };
        __gatewayExecutionScopeTest.failDirectGatewayChatRun(
          sessionKey,
          String(sender.requestId || ''),
        );
        throw new Error(`chat.send failed: A different run is already active for ${sessionKey}`);
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    try {
      await __gatewayExecutionScopeTest.handleWsSend(
        socket as any,
        {
          type: 'send',
          message: 'queue this after the active turn',
          provider: 'OPENCLAW',
          session: sessionKey,
          clientMessageId: 'client-message-conflict-1',
        },
        { userId, email: 'owner@example.com', role: 'OWNER' } as any,
      );

      expect(getSessionInfoSpy).toHaveBeenCalledWith(sessionKey);
      const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'active_turn_conflict',
        sessionKey,
        clientMessageId: 'client-message-conflict-1',
      }));
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'stream_resume',
        sessionKey,
        runId: upstreamRunId,
      }));
      expect(payloads.some((payload) => payload.type === 'error')).toBe(false);

      const keepaliveHandles = setIntervalSpy.mock.calls.flatMap((args, index) => (
        args[1] === 10_000 ? [setIntervalSpy.mock.results[index]?.value] : []
      ));
      expect(keepaliveHandles).toHaveLength(2);
      expect(clearIntervalSpy).toHaveBeenCalledWith(keepaliveHandles[1]);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: upstreamRunId,
        stream: 'thinking',
        data: { text: 'Visible after attach', delta: 'Visible after attach' },
      });
      const afterLiveEvent = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
      expect(afterLiveEvent).toContainEqual(expect.objectContaining({
        type: 'thinking',
        content: 'Visible after attach',
        runId: upstreamRunId,
      }));
    } finally {
      socket.emit('close');
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('SSE conflict recovery keeps the attempted message correlated and reattaches the live run', async () => {
    const userId = '45454545-4545-4545-8545-454545454545';
    const sessionKey = `agent:main:portal-${userId}-upstream-sse-conflict`;
    const upstreamRunId = 'openclaw-upstream-sse-run';
    const access = mockDurableAccessIdentity({
      userId,
      sessionId: 'durable-sse-conflict-session',
    });
    jest.spyOn(openClawHostRunJournal, 'beginOpenClawHostRun')
      .mockImplementation(async (handle) => handle);
    jest.spyOn(openClawHostRunJournal, 'quarantineOpenClawHostRun').mockResolvedValue();
    jest.spyOn(openclawGatewayRpc, 'gatewayRpcCall').mockImplementation(async (method: string) => {
      if (method === 'sessions.describe') {
        return { ok: true, data: { session: { key: sessionKey, displayName: 'Existing SSE chat' } } };
      }
      if (method === 'sessions.list') {
        return {
          ok: true,
          data: {
            sessions: [{ key: sessionKey, hasActiveRun: true, activeRunIds: [upstreamRunId] }],
          },
        };
      }
      return { ok: false, error: `Unexpected RPC ${method}` };
    });
    const provider = {
      providerName: 'OPENCLAW',
      displayName: 'OpenClaw',
      sendMessage: jest.fn(async (...args: any[]) => {
        const sender = args[5] as { requestId?: string };
        __gatewayExecutionScopeTest.failDirectGatewayChatRun(
          sessionKey,
          String(sender.requestId || ''),
        );
        throw new Error(`chat.send failed: A different run is already active for ${sessionKey}`);
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    const req = Object.assign(new EventEmitter(), {
      body: {
        message: 'queue this SSE attempt',
        provider: 'OPENCLAW',
        session: sessionKey,
        streamClientId: 'browser_stream_client_1234',
        clientMessageId: 'client-message-sse-conflict-1',
      },
      query: { stream: '1' },
      headers: { accept: 'text/event-stream' },
      user: access.payload,
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

    try {
      await sendRouteHandler()(req as any, res as any);
      const payloads = res.write.mock.calls
        .map(([raw]) => String(raw))
        .flatMap((raw) => raw.split('\n'))
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice('data: '.length)));
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'active_turn_conflict',
        sessionKey,
        clientMessageId: 'client-message-sse-conflict-1',
      }));
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'stream_resume',
        sessionKey,
        runId: upstreamRunId,
      }));
      expect(payloads.some((payload) => payload.type === 'error')).toBe(false);
      expect(res.end).not.toHaveBeenCalled();

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: upstreamRunId,
        stream: 'thinking',
        data: { text: 'Visible on the SSE recovery lane', delta: 'Visible on the SSE recovery lane' },
      });
      const afterLiveEvent = res.write.mock.calls
        .map(([raw]) => String(raw))
        .flatMap((raw) => raw.split('\n'))
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice('data: '.length)));
      expect(afterLiveEvent).toContainEqual(expect.objectContaining({
        type: 'thinking',
        content: 'Visible on the SSE recovery lane',
        runId: upstreamRunId,
      }));
      access.expectDurableLookup();
    } finally {
      req.emit('close');
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  test('rejects unqualified Antigravity WebSocket sends before provider lookup or session creation', async () => {
    jest.spyOn(unqualifiedNativeBinaryLane, 'isUnqualifiedNativeBinaryProvider').mockReturnValue(true);
    const getProvider = jest.spyOn(AgentRegistry, 'get');

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      { type: 'send', message: 'hello', harness: 'GEMINI', session: 'new-test' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(getProvider).not.toHaveBeenCalled();
    expect(payloads).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'NATIVE_BINARY_RUNTIME_UNQUALIFIED',
        retryable: false,
        content: expect.stringContaining('supported on Linux x86-64'),
      }),
    ]);
  });

  test('rejects unqualified Antigravity REST sends before provider lookup or session creation', async () => {
    jest.spyOn(unqualifiedNativeBinaryLane, 'isUnqualifiedNativeBinaryProvider').mockReturnValue(true);
    const access = mockDurableAccessIdentity({
      userId: 'owner-1',
      sessionId: 'durable-codex-sse-session',
    });
    const getProvider = jest.spyOn(AgentRegistry, 'get');

    const req = Object.assign(new EventEmitter(), {
      body: { message: 'hello', harness: 'GEMINI', session: 'new-test' },
      query: { stream: '1' },
      headers: { accept: 'text/event-stream' },
      user: access.payload,
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

    expect(getProvider).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'NATIVE_BINARY_RUNTIME_UNQUALIFIED',
      retryable: false,
      error: expect.stringContaining('supported on Linux x86-64'),
    }));
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('exact durable-session revocation retires an active Agent Chat SSE', async () => {
    const userId = 'owner-revoked-sse';
    const sessionId = 'revoked-route-sse-session';
    const access = mockDurableAccessIdentity({
      userId,
      sessionId: 'durable-revoked-sse-session',
    });
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve; });
    let settleProvider!: () => void;
    const providerSettled = new Promise<{ fullText: string; metadata: Record<string, never> }>(
      (resolve) => {
        settleProvider = () => resolve({ fullText: 'late result', metadata: {} });
      },
    );
    const provider = {
      // Revocation is transport/provider-neutral. Use a currently qualified
      // runtime so this test does not depend on the separate native-binary
      // qualification gate for Antigravity/Grok.
      providerName: 'OLLAMA',
      displayName: 'Ollama',
      startSession: jest.fn().mockResolvedValue(sessionId),
      abortActiveRun: jest.fn().mockResolvedValue(true),
      sendMessage: jest.fn(async () => {
        signalProviderStarted();
        return providerSettled;
      }),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    const req = Object.assign(new EventEmitter(), {
      body: { message: 'keep running', provider: 'HERMES', session: 'new-test' },
      query: { stream: '1' },
      headers: { accept: 'text/event-stream' },
      user: access.payload,
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

    const route = sendRouteHandler()(req as any, res as any);
    await providerStarted;
    expect(sessionRevocationSubscriberCount(userId)).toBe(1);

    publishSessionRevoked({
      userId,
      sessionId: 'durable-revoked-sse-session',
      reason: 'logout',
    });

    expect(provider.abortActiveRun).toHaveBeenCalledWith(sessionId, expect.any(String));
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(sessionRevocationSubscriberCount(userId)).toBe(0);

    settleProvider();
    await route;
    const payloads = res.write.mock.calls
      .map(([raw]) => String(raw))
      .flatMap((raw) => raw.split('\n'))
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(payloads.some((payload) => payload.type === 'done')).toBe(false);
    access.expectDurableLookup();
    streamEventBus.clearStream(sessionId);
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

  test('rejects unqualified Grok WebSocket sends before provider lookup or callbacks', async () => {
    jest.spyOn(unqualifiedNativeBinaryLane, 'isUnqualifiedNativeBinaryProvider').mockReturnValue(true);
    const getProvider = jest.spyOn(AgentRegistry, 'get');

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      { type: 'send', message: 'run pwd', provider: 'GROK', session: 'new-test' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(getProvider).not.toHaveBeenCalled();
    expect(payloads).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'NATIVE_BINARY_RUNTIME_UNQUALIFIED',
        retryable: false,
        content: expect.stringContaining('supported on Linux x86-64'),
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
    expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-ws']).toBe(1);

    // Reattaching the same browser/socket must replace its prior direct
    // delivery subscription rather than accumulating another listener.
    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: firstSocket as any,
      sessionKey: sessionId,
      providerName: 'GROK',
      streamInfo: __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId),
    })).toBe(true);
    expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-ws']).toBe(1);

    // A second browser tab is legitimate fan-out and should be counted as a
    // distinct browser consumer, not diagnosed as an internal subscriber leak.
    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: secondSocket as any,
      sessionKey: sessionId,
      providerName: 'GROK',
      streamInfo: __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId),
    })).toBe(true);
    expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-ws']).toBe(2);

    firstSocket.emit('close');
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(firstSocket as any, sessionId)).toBe(false);
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(secondSocket as any, sessionId)).toBe(true);
    expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-ws']).toBe(1);

    secondSocket.emit('close');
    expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-ws']).toBe(0);
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

  test('captures global stream delivery ownership at publication time', () => {
    // Attaching after publication cannot suppress the only global copy.
    const publishedWithoutDirectOwner = __gatewayExecutionScopeTest.shouldSendGlobalStreamCopy(
      false,
      { type: 'thinking' } as any,
    );
    expect(publishedWithoutDirectOwner).toBe(true);

    // Detaching after publication cannot create a duplicate terminal copy.
    const publishedWithDirectOwner = __gatewayExecutionScopeTest.shouldSendGlobalStreamCopy(
      true,
      { type: 'done' } as any,
    );
    expect(publishedWithDirectOwner).toBe(false);

    // Maintenance uses the direct lane too; the global subscription is only a
    // fallback for sockets that do not own this session.
    expect(__gatewayExecutionScopeTest.shouldSendGlobalStreamCopy(
      true,
      { type: 'compaction_start', maintenanceKind: 'maintenance' } as any,
    )).toBe(false);
  });

  test('requires explicit active truth before adopting a sessions.list run identity', () => {
    const sessionKey = 'agent:main:strict-conflict-attestation';
    expect(__gatewayExecutionScopeTest.parseExactOpenClawConflictRun({
      sessions: [{ key: sessionKey, activeRunIds: ['run-without-active-flag'] }],
    }, sessionKey)).toEqual({ state: 'unknown' });
    expect(__gatewayExecutionScopeTest.parseExactOpenClawConflictRun({
      sessions: [{ key: sessionKey, hasActiveRun: false, activeRunIds: ['contradictory-run'] }],
    }, sessionKey)).toEqual({ state: 'unknown' });
    expect(__gatewayExecutionScopeTest.parseExactOpenClawConflictRun({
      sessions: [{ key: sessionKey, hasActiveRun: true, activeRunIds: ['exact-run'] }],
    }, sessionKey)).toEqual({ state: 'active', runId: 'exact-run' });
  });

  test('route-owned Agent Zero SSE callbacks are mirrored once and sanitize terminal metadata', async () => {
    const access = mockDurableAccessIdentity({
      userId: 'owner-1',
      sessionId: 'durable-agent-zero-sse-session',
    });
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
      user: access.payload,
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
    access.expectDurableLookup();
  });

  test.each(['REST', 'SSE'])('%s preserves Agent Zero OAuth fallback guidance at the browser boundary', async (mode) => {
    const access = mode === 'SSE'
      ? mockDurableAccessIdentity({
          userId: 'owner-1',
          sessionId: 'durable-agent-zero-fallback-sse-session',
        })
      : null;
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
      user: access?.payload || { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
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
    access?.expectDurableLookup();
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
      type: 'active_turn_conflict',
      content: expect.stringContaining('reconnecting'),
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

  test('native WebSocket active-turn conflict refuses a replacement after durable scope proof', async () => {
    const sessionId = 'native-bus-session';
    const provider = {
      providerName: 'CODEX',
      displayName: 'Codex',
      startSession: jest.fn().mockResolvedValue(sessionId),
      sendMessage: jest.fn(),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    streamEventBus.startStream(sessionId, 'run-conflict-original', { provenance: 'via Codex CLI' });
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockImplementation(async () => {
        streamEventBus.clearStream(sessionId, 'run-conflict-original');
        streamEventBus.startStream(sessionId, 'run-conflict-replacement', { provenance: 'via Codex CLI' });
        return {} as any;
      });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsSend(
      socket as any,
      { type: 'send', message: 'queue this', provider: 'CODEX', session: 'new-test' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 } as any,
    );

    streamEventBus.publish(sessionId, {
      type: 'text',
      content: 'replacement must remain detached',
      runId: 'run-conflict-replacement',
    });
    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'active_turn_conflict',
      sessionKey: sessionId,
    }));
    expect(payloads).toContainEqual({
      type: 'stream_status',
      sessionKey: sessionId,
      active: false,
      inactiveReason: 'unknown',
      safeToClear: false,
    });
    expect(payloads).not.toContainEqual(expect.objectContaining({ type: 'stream_resume' }));
    expect(payloads).not.toContainEqual(expect.objectContaining({ content: 'replacement must remain detached' }));
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId)).toBe(false);
    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect(attachable).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider: 'CODEX',
      sessionId,
      runId: 'run-conflict-original',
    });
  });

  test('native SSE active-turn conflict refuses a replacement after durable scope proof', async () => {
    const sessionId = 'route-sse-session';
    const access = mockDurableAccessIdentity({
      userId: 'owner-1',
      sessionId: 'durable-native-sse-conflict-session',
      authorizationVersion: 7,
    });
    const provider = {
      providerName: 'CLAUDE_CODE',
      displayName: 'Claude Code',
      startSession: jest.fn().mockResolvedValue(sessionId),
      sendMessage: jest.fn(),
      abortActiveRun: jest.fn(),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);
    streamEventBus.startStream(sessionId, 'run-sse-original', { provenance: 'via Claude Code CLI' });
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockImplementation(async () => {
        streamEventBus.clearStream(sessionId, 'run-sse-original');
        streamEventBus.startStream(sessionId, 'run-sse-replacement', { provenance: 'via Claude Code CLI' });
        return {} as any;
      });
    const req = Object.assign(new EventEmitter(), {
      body: {
        message: 'queue this SSE turn',
        provider: 'CLAUDE_CODE',
        session: 'new-test',
      },
      query: { stream: '1' },
      headers: { accept: 'text/event-stream' },
      user: access.payload,
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

    try {
      await sendRouteHandler()(req as any, res as any);
      streamEventBus.publish(sessionId, {
        type: 'text',
        content: 'replacement must remain off SSE',
        runId: 'run-sse-replacement',
      });
      const payloads = res.write.mock.calls
        .map(([raw]) => String(raw))
        .flatMap((raw) => raw.split('\n'))
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice('data: '.length)));
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'active_turn_conflict',
        sessionKey: sessionId,
      }));
      expect(payloads).toContainEqual({
        type: 'stream_status',
        sessionKey: sessionId,
        active: false,
        inactiveReason: 'unknown',
        safeToClear: false,
      });
      expect(payloads).not.toContainEqual(expect.objectContaining({ type: 'stream_resume' }));
      expect(payloads).not.toContainEqual(expect.objectContaining({ content: 'replacement must remain off SSE' }));
      expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-sse'] || 0).toBe(0);
      expect(res.end).not.toHaveBeenCalled();
      expect(provider.sendMessage).not.toHaveBeenCalled();
      expect(attachable).toHaveBeenCalledWith({
        actorUserId: 'owner-1',
        actorAuthorizationVersion: 7,
        provider: 'CLAUDE_CODE',
        sessionId,
        runId: 'run-sse-original',
      });
      access.expectDurableLookup();
    } finally {
      req.emit('close');
    }
  });

  test('host-native CLI reconnect resumes the exact bus snapshot and live run', async () => {
    jest.spyOn(nativeSessionStore, 'loadNativeSession').mockReturnValue({
      executionContext: { scope: 'HOST_OPERATOR' },
    } as any);
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockResolvedValue({} as any);
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
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 } as any,
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
    expect(attachable).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider: 'CODEX',
      sessionId,
      runId: 'run-native-reconnect',
    });
  });

  test('host-native CLI reconnect refuses a replacement run after attesting the original scope', async () => {
    jest.spyOn(nativeSessionStore, 'loadNativeSession').mockReturnValue({
      executionContext: { scope: 'HOST_OPERATOR' },
    } as any);
    const sessionId = 'native-reconnect-session';
    streamEventBus.startStream(sessionId, 'run-native-original', { provenance: 'via Claude Code CLI' });
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockImplementation(async () => {
        streamEventBus.clearStream(sessionId, 'run-native-original');
        streamEventBus.startStream(sessionId, 'run-native-replacement', {
          provenance: 'via Claude Code CLI',
        });
        return {} as any;
      });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsReconnect(
      socket as any,
      { session: sessionId, provider: 'CLAUDE_CODE' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 } as any,
    );

    streamEventBus.publish(sessionId, {
      type: 'text',
      content: 'replacement must not be forwarded',
      runId: 'run-native-replacement',
    });
    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toEqual([
      {
        type: 'error',
        content: 'Reconnect failed: active host run changed during attachment',
      },
    ]);
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId)).toBe(false);
    expect(streamEventBus.getTrackedStream(sessionId)).toMatchObject({
      active: true,
      runId: 'run-native-replacement',
    });
    expect(attachable).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider: 'CLAUDE_CODE',
      sessionId,
      runId: 'run-native-original',
    });
  });

  test('host-native CLI reconnect cannot revive a stream without its exact active scope', async () => {
    jest.spyOn(nativeSessionStore, 'loadNativeSession').mockReturnValue({
      executionContext: { scope: 'HOST_OPERATOR' },
    } as any);
    jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockRejectedValue(new Error('Host run scope is unavailable'));
    const sessionId = 'native-reconnect-session';
    streamEventBus.startStream(sessionId, 'run-native-reconnect', { provenance: 'via Codex CLI' });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsReconnect(
      socket as any,
      { session: sessionId, provider: 'CODEX' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toEqual([
      expect.objectContaining({
        type: 'error',
        content: expect.stringContaining('Host run scope is unavailable'),
      }),
    ]);
    expect(payloads).not.toContainEqual(expect.objectContaining({ type: 'stream_resume' }));
  });

  test.each([
    ['CODEX', 'codex-history-attach'],
    ['CLAUDE_CODE', 'claude-history-attach'],
  ] as const)('%s HTTP/WS history and conflict attachments require the exact active scope', async (
    provider,
    sessionId,
  ) => {
    const runId = `run-${sessionId}`;
    const snapshot = { active: true, runId, phase: 'streaming' as const };
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error('host scope was not attested'));

    await expect(
      __gatewayExecutionScopeTest.attestHostAgentRunBrowserStreamSnapshot(
        provider,
        sessionId,
        snapshot,
        'HOST_OPERATOR',
        { userId: 'owner-1', authorizationVersion: 7 },
      ),
    ).resolves.toBe(snapshot);
    await expect(
      __gatewayExecutionScopeTest.attestHostAgentRunBrowserStreamSnapshot(
        provider,
        sessionId,
        snapshot,
        'HOST_OPERATOR',
        { userId: 'owner-1', authorizationVersion: 7 },
      ),
    ).resolves.toEqual({
      active: false,
      inactiveReason: 'unknown',
      safeToClear: false,
    });

    const expected = {
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider,
      sessionId,
      runId,
    };
    expect(attachable).toHaveBeenNthCalledWith(1, expected);
    expect(attachable).toHaveBeenNthCalledWith(2, expected);
  });

  test('host stream projection rejects missing or stale actor generations before attachment', async () => {
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable');
    const snapshot = { active: true, runId: 'run-owner-bound', phase: 'streaming' as const };

    await expect(__gatewayExecutionScopeTest.attestHostAgentRunBrowserStreamSnapshot(
      'CODEX',
      'owner-bound-session',
      snapshot,
      'HOST_OPERATOR',
      undefined,
    )).resolves.toEqual({
      active: false,
      inactiveReason: 'unknown',
      safeToClear: false,
    });
    await expect(__gatewayExecutionScopeTest.attestHostAgentRunBrowserStreamSnapshot(
      'CODEX',
      'owner-bound-session',
      snapshot,
      'HOST_OPERATOR',
      { userId: 'owner-1', authorizationVersion: 0 },
    )).resolves.toEqual({
      active: false,
      inactiveReason: 'unknown',
      safeToClear: false,
    });
    expect(attachable).not.toHaveBeenCalled();
  });

  test('HTTP native history keeps messages readable but refuses live Codex continuity without its scope', async () => {
    const sessionId = 'host-http-history';
    const runId = 'run-host-http-history';
    jest.spyOn(nativeSessionStore, 'loadNativeSessionMetadata').mockReturnValue({
      userId: 'owner-1',
      sessionId,
      executionContext: { scope: 'HOST_OPERATOR' },
    } as any);
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockRejectedValue(new Error('host scope was not attested'));
    streamEventBus.startStream(sessionId, runId, { provenance: 'via Codex CLI' });

    const handler = gatewayRouteHandler('/history');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler({
      query: { provider: 'CODEX', session: sessionId },
      user: { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 },
    }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      activeStream: {
        active: false,
        inactiveReason: 'unknown',
        safeToClear: false,
      },
    }));
    expect(attachable).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider: 'CODEX',
      sessionId,
      runId,
    });
  });

  test('WebSocket native history never subscribes to a live Claude stream without its scope', async () => {
    const sessionId = 'host-ws-history';
    const runId = 'run-host-ws-history';
    jest.spyOn(nativeSessionStore, 'loadNativeSessionMetadata').mockReturnValue({
      userId: 'owner-1',
      sessionId,
      executionContext: { scope: 'HOST_OPERATOR' },
    } as any);
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockRejectedValue(new Error('host scope was not attested'));
    streamEventBus.startStream(sessionId, runId, { provenance: 'via Claude Code CLI' });
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsHistory(
      socket as any,
      { type: 'history', provider: 'CLAUDE_CODE', session: sessionId, requestId: 'history-request' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'history',
      sessionId,
      requestId: 'history-request',
      activeStream: {
        active: false,
        inactiveReason: 'unknown',
        safeToClear: false,
      },
    }));
    expect(payloads).not.toContainEqual(expect.objectContaining({ type: 'stream_resume' }));
    expect(attachable).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider: 'CLAUDE_CODE',
      sessionId,
      runId,
    });
  });

  test('WebSocket native history refuses a replacement after attesting the original scope', async () => {
    const sessionId = 'host-ws-history';
    jest.spyOn(nativeSessionStore, 'loadNativeSessionMetadata').mockReturnValue({
      userId: 'owner-1',
      sessionId,
      executionContext: { scope: 'HOST_OPERATOR' },
    } as any);
    streamEventBus.startStream(sessionId, 'run-history-original', { provenance: 'via Codex CLI' });
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable')
      .mockImplementation(async () => {
        streamEventBus.clearStream(sessionId, 'run-history-original');
        streamEventBus.startStream(sessionId, 'run-history-replacement', { provenance: 'via Codex CLI' });
        return {} as any;
      });
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    await __gatewayExecutionScopeTest.handleWsHistory(
      socket as any,
      { type: 'history', provider: 'CODEX', session: sessionId, requestId: 'history-replacement' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER', authorizationVersion: 7 } as any,
    );

    streamEventBus.publish(sessionId, {
      type: 'text',
      content: 'replacement history event must remain detached',
      runId: 'run-history-replacement',
    });
    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'history',
      sessionId,
      requestId: 'history-replacement',
      activeStream: expect.objectContaining({ active: true, runId: 'run-history-original' }),
    }));
    expect(payloads).toContainEqual({
      type: 'stream_status',
      sessionKey: sessionId,
      active: false,
      inactiveReason: 'unknown',
      safeToClear: false,
    });
    expect(payloads).not.toContainEqual(expect.objectContaining({ type: 'stream_resume' }));
    expect(payloads).not.toContainEqual(expect.objectContaining({
      content: 'replacement history event must remain detached',
    }));
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId)).toBe(false);
    expect(attachable).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      actorAuthorizationVersion: 7,
      provider: 'CODEX',
      sessionId,
      runId: 'run-history-original',
    });
  });

  test('Project Sandbox reconnect projection never acquires host-run attachment authority', async () => {
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable');
    const snapshot = { active: true, runId: 'project-codex-run', phase: 'streaming' as const };

    await expect(
      __gatewayExecutionScopeTest.attestHostAgentRunBrowserStreamSnapshot(
        'CODEX',
        'project-codex-session',
        snapshot,
        'PROJECT_SANDBOX',
        undefined,
      ),
    ).resolves.toBe(snapshot);
    expect(attachable).not.toHaveBeenCalled();
  });

  test('Project Sandbox WebSocket reconnect remains on its independent stream authority', async () => {
    jest.spyOn(nativeSessionStore, 'loadNativeSession').mockReturnValue({
      executionContext: { scope: 'PROJECT_SANDBOX' },
    } as any);
    const attachable = jest.spyOn(hostAgentRunJournal, 'assertHostAgentRunAttachable');
    const sessionId = 'project-native-reconnect';
    streamEventBus.startStream(sessionId, 'project-native-run', { provenance: 'via Project Codex' });

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsReconnect(
      socket as any,
      { session: sessionId, provider: 'CODEX' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    expect(socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toContainEqual(
      expect.objectContaining({
        type: 'stream_resume',
        sessionKey: sessionId,
        runId: 'project-native-run',
      }),
    );
    expect(attachable).not.toHaveBeenCalled();
  });

  test('host-native CLI reconnect reports a completed run as safe to clear', async () => {
    const sessionId = 'native-reconnect-completed';
    const runId = 'run-native-reconnect-completed';
    streamEventBus.startStream(sessionId, runId, { provenance: 'via Codex CLI' });
    streamEventBus.publish(sessionId, { type: 'text', content: 'Completed while disconnected', runId });
    streamEventBus.publish(sessionId, { type: 'done', content: 'Completed while disconnected', runId });
    streamEventBus.softClearStream(sessionId, runId);

    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();
    await __gatewayExecutionScopeTest.handleWsReconnect(
      socket as any,
      { session: sessionId, provider: 'CODEX' },
      { userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' } as any,
    );

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).toEqual([
      expect.objectContaining({
        type: 'stream_status',
        sessionKey: sessionId,
        active: false,
        inactiveReason: 'terminal',
        safeToClear: true,
      }),
    ]);
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

  test('OpenClaw stream attachment revalidates a stale snapshot to the replacement run', () => {
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
      providerName: 'OPENCLAW',
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

  test('native stream attachment implicitly rejects a replacement instead of adopting it', () => {
    const sessionId = 'stale-snapshot-attach';
    streamEventBus.startStream(sessionId, 'run-old');
    const staleSnapshot = __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId);
    streamEventBus.clearStream(sessionId, 'run-old');
    streamEventBus.startStream(sessionId, 'run-new');

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
    })).toBe(false);

    expect(socket.send).not.toHaveBeenCalled();
    expect(__gatewayExecutionScopeTest.wsHasSessionStreamSubscription(socket as any, sessionId)).toBe(false);
    expect(streamEventBus.getTrackedStream(sessionId)).toMatchObject({ active: true, runId: 'run-new' });
  });

  test('native WebSocket attachment rejects untagged session events after exact-run validation', () => {
    const sessionId = 'native-ws-untagged-event';
    const runId = 'run-native-ws';
    streamEventBus.startStream(sessionId, runId, { provenance: 'via Codex CLI' });
    const snapshot = __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId);
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: jest.Mock };
    socket.readyState = 1;
    socket.send = jest.fn();

    expect(__gatewayExecutionScopeTest.attachBrowserWsToSessionStream({
      ws: socket as any,
      sessionKey: sessionId,
      providerName: 'CODEX',
      streamInfo: snapshot,
      keepSubscriptionAfterDone: false,
    })).toBe(true);

    streamEventBus.publish(sessionId, {
      type: 'status',
      content: 'untagged maintenance must stay detached',
      maintenanceKind: 'maintenance',
    });
    streamEventBus.publish(sessionId, { type: 'text', content: 'tagged event', runId });

    const payloads = socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(payloads).not.toContainEqual(expect.objectContaining({
      content: 'untagged maintenance must stay detached',
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'text',
      content: 'tagged event',
      runId,
    }));
    socket.emit('close');
  });

  test('native SSE attachment resumes and forwards the same revalidated run', () => {
    const sessionId = 'route-sse-session';
    const runId = 'run-native-sse';
    streamEventBus.startStream(sessionId, runId, { provenance: 'via Claude Code CLI' });
    streamEventBus.publish(sessionId, { type: 'text', content: 'partial SSE', runId });
    const snapshot = __gatewayExecutionScopeTest.getProviderOwnedBusStreamSnapshot(sessionId);
    const write = jest.fn();
    const finish = jest.fn();

    const cleanup = __gatewayExecutionScopeTest.attachSseToSessionStream({
      sessionKey: sessionId,
      providerName: 'CLAUDE_CODE',
      streamInfo: snapshot,
      user: { userId: 'owner-1', role: 'OWNER' } as any,
      write,
      finish,
    });
    expect(cleanup).toEqual(expect.any(Function));

    streamEventBus.publish(sessionId, {
      type: 'status',
      content: 'untagged SSE maintenance must stay detached',
      maintenanceKind: 'maintenance',
    });
    streamEventBus.publish(sessionId, { type: 'text', content: 'continued SSE', runId });
    const payloads = write.mock.calls
      .map(([raw]) => String(raw))
      .filter((raw) => raw.startsWith('data: {'))
      .map((raw) => JSON.parse(raw.slice('data: '.length)));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_resume',
      sessionKey: sessionId,
      runId,
      content: 'partial SSE',
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'text',
      content: 'continued SSE',
      runId,
    }));
    expect(payloads).not.toContainEqual(expect.objectContaining({
      content: 'untagged SSE maintenance must stay detached',
    }));
    expect(finish).not.toHaveBeenCalled();

    cleanup?.();
    expect(streamEventBus.getSubscriberDiagnostics(sessionId).roles['browser-sse'] || 0).toBe(0);
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
    resolveAbort({ ok: true, data: { aborted: true, runIds: ['run-old'] } });
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

  test('final host dispatch seam rechecks cached admission before journal and provider I/O', async () => {
    const providerName = 'OPENCLAW';
    const displayName = 'OpenClaw';
    const begin = jest.spyOn(openClawHostRunJournal, 'beginOpenClawHostRun')
      .mockImplementation(async (handle) => handle);
    const accepted = jest.spyOn(openClawHostRunJournal, 'markOpenClawHostRunDispatchAccepted')
      .mockResolvedValue();
    const settled = jest.spyOn(openClawHostRunJournal, 'markOpenClawHostRunVisibleSettled')
      .mockResolvedValue();
    const startSession = jest.fn();
    const sendMessage = jest.fn(async (...args: any[]) => {
      const sender = args[5] as { onProviderDispatchAccepted(id: string): Promise<void> };
      await sender.onProviderDispatchAccepted('upstream-run-1');
      return { fullText: 'OpenClaw result', metadata: {} };
    });
    const provider = {
      providerName,
      displayName,
      startSession,
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
      })).resolves.toEqual({ fullText: 'OpenClaw result', metadata: {} });

    expect(openClawExecutionAdmission.assertCachedOpenClawExecutionAdmitted).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(expect.anything(), 'upstream-run-1');
    expect(settled).toHaveBeenCalledWith(expect.anything(), 'completed');
    expect(startSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['CODEX', 'Codex'],
    ['CLAUDE_CODE', 'Claude Code'],
  ] as const)('final host dispatch delegates %s to its provider-owned lease boundary', async (providerName, displayName) => {
    const sendMessage = jest.fn().mockResolvedValue({ fullText: `${displayName} result` });
    const provider = {
      providerName,
      displayName,
      sendMessage,
    } as any;

    await expect(__gatewayExecutionScopeTest.sendHostOperatorProviderMessage({
      provider,
      sessionId: 'native-managed-session',
      message: 'hello',
      sender: {
        label: 'owner@example.com',
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        authorizationVersion: 9,
        requestId: 'route-request-1',
      },
    })).resolves.toEqual({ fullText: `${displayName} result` });

    expect(sendMessage).toHaveBeenCalledWith(
      'native-managed-session',
      'hello',
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ requestId: 'route-request-1' }),
    );
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

  test('the Owner can read listed host transcripts without claiming them; other users remain isolated', async () => {
    const key = 'agent:main:dashboard:0b3a4512-f580-4f3e-a573-f9363e26f5a5';
    const { database, agentSession } = createOwnershipDatabase();
    await expect(__gatewayExecutionScopeTest.assertExistingGatewaySessionAccess(
      key, { userId: OWNER, role: 'OWNER' } as any, { database },
    )).resolves.toBeUndefined();
    await expect(__gatewayExecutionScopeTest.assertExistingGatewaySessionAccess(
      key, { userId: OTHER, role: 'SUB_ADMIN' } as any, { database },
    )).rejects.toThrow('Admin access required');
    await expect(__gatewayExecutionScopeTest.assertExistingGatewaySessionAccess(
      `agent:main:portal-${OTHER}-private`, { userId: OWNER, role: 'OWNER' } as any, { database },
    )).rejects.toThrow('Admin access required');
    const claimed = createOwnershipDatabase([{ id: 'other-claim', userId: OTHER, externalId: key }]);
    await expect(__gatewayExecutionScopeTest.assertExistingGatewaySessionAccess(
      key, { userId: OWNER, role: 'OWNER' } as any, { database: claimed.database },
    )).rejects.toThrow('Admin access required');
    expect(agentSession.create).not.toHaveBeenCalled();
    expect(agentSession.update).not.toHaveBeenCalled();
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
