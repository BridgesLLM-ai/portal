export {};

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
const { OpenClawProvider } = require('./OpenClawProvider') as typeof import('./OpenClawProvider');

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Shape mirrors what the gateway `sessions.list` RPC returns. Every row carries
 * kind:'direct' on purpose — the live gateway reports that for cron lanes too,
 * which is why the lane has to be derived from the key namespace instead.
 */
const hostSessions = [
  { key: 'agent:main:dashboard:aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', kind: 'direct' },
  { key: 'agent:main:new-1781111111111', kind: 'direct' },
  { key: `agent:main:portal-${OWNER}-new-1781111111111`, kind: 'direct' },
  { key: `agent:main:portal-${OTHER}-new-1700000000000`, kind: 'direct' },
  { key: 'agent:main:cron:cccccccc-2222-4333-8444-dddddddddddd', kind: 'direct' },
  { key: 'agent:main:subagent:eeeeeeee-3333-4444-8555-ffffffffffff', kind: 'direct' },
  { key: 'agent:main:group:ops-room', kind: 'direct' },
  { key: 'agent:main:new-1784294600000', kind: 'direct', chatType: 'group' },
];

function listReturns(sessions: unknown[]) {
  gatewayRpc.gatewayRpcCall.mockResolvedValue({ ok: true, data: { sessions } });
}

describe('OpenClawProvider host-session visibility', () => {
  beforeEach(() => {
    gatewayRpc.gatewayRpcCall.mockReset();
    mockAgentSessionFindMany.mockReset();
  });

  test('host owner sees unclaimed direct sessions created outside the Portal', async () => {
    mockAgentSessionFindMany.mockResolvedValue([]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions.map((s) => s.sessionId)).toEqual([
      'agent:main:dashboard:aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
      'agent:main:new-1781111111111',
      `agent:main:portal-${OWNER}-new-1781111111111`,
    ]);
  });

  test('a session scoped to another Portal user is never visible to the host owner', async () => {
    mockAgentSessionFindMany.mockResolvedValue([]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions.some((s) => s.sessionId.includes(OTHER))).toBe(false);
  });

  test('automation lanes stay out of the chat list', async () => {
    mockAgentSessionFindMany.mockResolvedValue([]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions.some((s) => s.sessionId.includes(':cron:'))).toBe(false);
    expect(sessions.some((s) => s.sessionId.includes(':subagent:'))).toBe(false);
  });

  test('group and channel lanes stay out of the direct chat list', async () => {
    mockAgentSessionFindMany.mockResolvedValue([]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions.some((s) => s.sessionId === 'agent:main:group:ops-room')).toBe(false);
    expect(sessions.some((s) => s.sessionId === 'agent:main:new-1784294600000')).toBe(false);
  });

  test('without host inclusion the claim set is still the only source', async () => {
    mockAgentSessionFindMany.mockResolvedValue([
      { externalId: `agent:main:portal-${OWNER}-new-1781111111111` },
    ]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER);

    expect(sessions.map((s) => s.sessionId)).toEqual([
      `agent:main:portal-${OWNER}-new-1781111111111`,
    ]);
  });

  test('a non-owner with no claims sees nothing even on a busy host', async () => {
    mockAgentSessionFindMany.mockResolvedValue([]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OTHER);

    expect(sessions).toEqual([]);
    expect(gatewayRpc.gatewayRpcCall).not.toHaveBeenCalled();
  });

  test('claimed sessions on other agents survive alongside host sweeps', async () => {
    mockAgentSessionFindMany.mockResolvedValue([
      { externalId: 'agent:max_revenue:new-1782222222222' },
    ]);
    gatewayRpc.gatewayRpcCall.mockImplementation(async (_method: string, params: any) => ({
      ok: true,
      data: {
        sessions: params.agentId === 'main'
          ? [{ key: 'agent:main:dashboard:abc', kind: 'direct' }]
          : [{ key: 'agent:max_revenue:new-1782222222222', kind: 'direct' }],
      },
    }));

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions.map((s) => s.sessionId).sort()).toEqual([
      'agent:main:dashboard:abc',
      'agent:max_revenue:new-1782222222222',
    ]);
  });

  test('an explicitly claimed automation lane is still honoured', async () => {
    mockAgentSessionFindMany.mockResolvedValue([
      { externalId: 'agent:main:cron:cccccccc-2222-4333-8444-dddddddddddd' },
    ]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions.some((s) => s.sessionId.includes(':cron:'))).toBe(true);
  });

  test('a key claimed and also returned by the host sweep is listed once', async () => {
    mockAgentSessionFindMany.mockResolvedValue([
      { externalId: 'agent:main:dashboard:abc' },
    ]);
    listReturns([
      { key: 'agent:main:dashboard:abc', kind: 'direct' },
      { key: 'agent:main:dashboard:abc', kind: 'direct' },
    ]);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });

    expect(sessions).toHaveLength(1);
  });

  test('a malformed agent id is not forwarded to the gateway', async () => {
    mockAgentSessionFindMany.mockResolvedValue([]);
    listReturns(hostSessions);

    const sessions = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['../../etc/passwd'],
    });

    expect(sessions).toEqual([]);
    expect(gatewayRpc.gatewayRpcCall).not.toHaveBeenCalled();
  });
});

/**
 * The list was previously mapped to sessionId/status/model only. Agent Chat
 * therefore rendered every real conversation as `Session 0b3a4512`, and sorted
 * a list in which every row claimed to have been touched at list time.
 */
describe('OpenClawProvider session presentation', () => {
  beforeEach(() => {
    gatewayRpc.gatewayRpcCall.mockReset();
    mockAgentSessionFindMany.mockReset();
    mockAgentSessionFindMany.mockResolvedValue([]);
  });

  async function listOne(session: Record<string, unknown>) {
    listReturns([session]);
    const [result] = await new OpenClawProvider().listSessions(OWNER, {
      includeHostSessions: true,
      hostAgentIds: ['main'],
    });
    return result;
  }

  test('carries the title OpenClaw derived, stripped of markdown emphasis', async () => {
    const session = await listOne({
      key: 'agent:main:dashboard:aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
      derivedTitle: '**4.0 Updater Bug Investigation**',
    });

    expect(session.title).toBe('4.0 Updater Bug Investigation');
  });

  test('an operator-set displayName wins over the derived title', async () => {
    const session = await listOne({
      key: 'agent:main:new-1781111111111',
      displayName: 'Release war room',
      derivedTitle: '**Something generated**',
    });

    expect(session.title).toBe('Release war room');
  });

  test('a session with no title of its own reports none, rather than an empty one', async () => {
    const session = await listOne({ key: 'agent:main:new-1781111111111' });

    expect(session.title).toBeUndefined();
  });

  test('an overlong title is clamped so it cannot break the picker layout', async () => {
    const session = await listOne({
      key: 'agent:main:new-1781111111111',
      derivedTitle: 'x'.repeat(400),
    });

    expect(session.title!.length).toBe(120);
    expect(session.title!.endsWith('…')).toBe(true);
  });

  test('gateway epoch-millisecond activity becomes a sortable ISO timestamp', async () => {
    const session = await listOne({
      key: 'agent:main:new-1781111111111',
      updatedAt: 1785646745692,
    });

    expect(session.lastActivityAt).toBe('2026-08-02T04:59:05.692Z');
    expect(session.createdAt).toBe('2026-08-02T04:59:05.692Z');
  });

  test('a session the gateway reports no activity for still yields a valid timestamp', async () => {
    const before = Date.now();
    const session = await listOne({ key: 'agent:main:new-1781111111111' });

    expect(Date.parse(session.lastActivityAt)).toBeGreaterThanOrEqual(before);
  });
});
