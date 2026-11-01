import { EventEmitter } from 'events';

// Persistence and the native transport are counted edges. The real route, role
// gates, session-access guard and lineage walk run unchanged.
const mockClaims: Array<{ externalId: string; userId: string }> = [];
const mockCounts = { db: 0, describe: 0 };
function mockClaimMatches(claim: { externalId: string; userId: string }, where: any): boolean {
  if (typeof where?.externalId === 'string' && claim.externalId !== where.externalId) return false;
  if (where?.userId?.not !== undefined && claim.userId === where.userId.not) return false;
  if (Array.isArray(where?.OR) && !where.OR.some((clause: any) => (
    String(clause?.externalId?.equals || '').toLowerCase() === claim.externalId.toLowerCase()
  ))) return false;
  return true;
}
jest.mock('../config/env', () => ({ config: { nodeEnv: 'test', openclawApiUrl: 'http://localhost:18789' } }));
jest.mock('../config/database', () => {
  const absent = { findFirst: async () => { mockCounts.db += 1; return null; } };
  const agentSession = {
    findFirst: async ({ where }: any) => {
      mockCounts.db += 1;
      const claim = mockClaims.find((candidate) => mockClaimMatches(candidate, where));
      return claim ? { id: claim.externalId, userId: claim.userId } : null;
    },
  };
  return { prisma: new Proxy({}, { get: (_target, model) => (model === 'agentSession' ? agentSession : absent) }) };
});
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  authenticateToken: (req: any, res: any, next: any) => (req.user ? next() : res.status(401).json({})),
}));
jest.mock('../utils/openclawGatewayRpc', () => ({
  ...jest.requireActual('../utils/openclawGatewayRpc'),
  gatewayRpcCall: jest.fn(),
}));

import router, { assertExistingGatewaySessionAccess, mapOpenClawTaskSession } from '../routes/gateway';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { invalidateSessionWorkRows } from '../services/openClawSessionWork';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const userA = { userId: A, email: 'a@example.test', role: 'SUB_ADMIN', accountStatus: 'ACTIVE' };
const userB = { userId: B, email: 'b@example.test', role: 'SUB_ADMIN', accountStatus: 'ACTIVE' };
const owner = { userId: OWNER, email: 'owner@example.test', role: 'OWNER', accountStatus: 'ACTIVE' };
const CHAT_A = `agent:main:portal-${A}`;

const run = (job: string, id: string, fields: Record<string, unknown>) => ({ key: `agent:main:cron:${job}:run:${id}`, ...fields });
const ROWS: any[] = [
  { key: 'agent:main:main', kind: 'direct' },
  { key: CHAT_A, kind: 'direct' },
  // A sub-agent lineage: six children of A's chat, each with one grandchild.
  ...Array.from({ length: 6 }, (_, i) => [
    { key: `agent:main:subagent:a-${i}`, kind: 'subagent', spawnedBy: CHAT_A, status: 'done', updatedAt: 900 + i },
    { key: `agent:main:subagent:a-${i}-g`, spawnedBy: `agent:main:subagent:a-${i}`, status: 'done', updatedAt: 800 + i },
  ]).flat(),
  // Two long-retained unclaimed host cron jobs, listed oldest first.
  ...Array.from({ length: 15 }, (_, i) => run('nightly', `n${i}`, { status: 'done', endedAt: 1000 + i })),
  ...Array.from({ length: 15 }, (_, i) => run('hourly', `h${i}`, i === 7
    ? { status: 'running', startedAt: 1500 }
    : { status: 'done', endedAt: 1100 + i })),
  // The newest "weekly" run is B's claim: the Owner gets the next one.
  run('weekly', 'w0', { status: 'done', endedAt: 700 }),
  run('weekly', 'w1', { status: 'done', endedAt: 710 }),
  run('weekly', 'w-b', { status: 'done', endedAt: 720 }),
  // Equal display times keep the list position of each job's first visible row.
  run('x', 'old', { status: 'done', endedAt: 100 }),
  run('y', 'only', { status: 'done', endedAt: 200 }),
  run('x', 'new', { status: 'done', endedAt: 200 }),
  run('z', 'b-claim', { status: 'done', endedAt: 50 }),
  run('w', 'only', { status: 'done', endedAt: 300 }),
  run('z', 'new', { status: 'done', endedAt: 300 }),
  // A time that is not a number keeps the exact listed fold.
  run('odd', 'b-claim', { status: 'done', endedAt: 5 }),
  run('odd', 'text', { status: 'done', updatedAt: 'not a time' }),
  run('odd', 'late', { status: 'done', endedAt: 7 }),
];
const B_CLAIMS = ['weekly:run:w-b', 'z:run:b-claim', 'odd:run:b-claim'].map((id) => ({ externalId: `agent:main:cron:${id}`, userId: B }));

const rpc = gatewayRpcCall as jest.MockedFunction<typeof gatewayRpcCall>;

async function tasksAs(user: any) {
  const req: any = { url: '/tasks', originalUrl: '/api/gateway/tasks', method: 'GET', user, headers: {}, query: {} };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.set = (name: string, value: string) => { res.headers[name] = value; return res; };
  await new Promise<void>((resolve, reject) => {
    res.json = (body: any) => { res.body = body; resolve(); return res; };
    (router as any).handle(req, res, (error: any) => reject(error || new Error('unhandled route')));
  });
  return res;
}

/** The previous feed, transcribed: the full guard on every task row in list order, then the collapse. */
async function previousTasks(user: any) {
  const isTask = (row: any) => row.kind === 'subagent' || row.kind === 'cron' || /:(subagent|cron):/.test(row.key);
  const authorized: any[] = [];
  for (const row of ROWS.filter(isTask)) {
    try { await assertExistingGatewaySessionAccess(row.key, user as any); authorized.push(row); } catch { /* hidden */ }
  }
  const collapsed = new Map<string, any>();
  for (const session of authorized) {
    const collapseKey = session.key.match(/^(agent:[^:]+:cron:[^:]+):run:[^:]+$/)?.[1] || session.key;
    const existing = collapsed.get(collapseKey);
    if (!existing) { collapsed.set(collapseKey, session); continue; }
    const running = (row: any) => !row.endedAt && !['done', 'error'].includes(String(row.status || '').toLowerCase());
    const time = (row: any) => Number(row.endedAt || row.updatedAt || row.startedAt || 0);
    if ((!running(existing) && running(session)) || (running(existing) === running(session) && time(session) >= time(existing))) {
      collapsed.set(collapseKey, session);
    }
  }
  const byId = new Map<string, any>();
  for (const task of Array.from(collapsed.values()).map(mapOpenClawTaskSession)) byId.set(task.id, task);
  return Array.from(byId.values()).sort((a: any, b: any) => (
    Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)));
}

async function measure<T>(work: () => Promise<T>): Promise<{ result: T; db: number; describe: number }> {
  invalidateSessionWorkRows();
  mockCounts.db = 0;
  mockCounts.describe = 0;
  const result = await work();
  return { result, db: mockCounts.db, describe: mockCounts.describe };
}

const keysOf = (tasks: any[]) => tasks.map((task: any) => task.sessionKey);
const OWNER_KEYS = [
  'agent:main:cron:hourly:run:h7',
  'agent:main:cron:nightly:run:n14',
  'agent:main:cron:weekly:run:w1',
  'agent:main:cron:w:run:only',
  'agent:main:cron:z:run:new',
  'agent:main:cron:x:run:new',
  'agent:main:cron:y:run:only',
  'agent:main:cron:odd:run:text',
];

beforeEach(() => {
  invalidateSessionWorkRows();
  mockClaims.splice(0, mockClaims.length, ...B_CLAIMS);
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === 'sessions.list') return { ok: true, data: { sessions: ROWS } };
    if (method === 'sessions.describe') {
      mockCounts.describe += 1;
      return { ok: true, data: { session: ROWS.find((row) => row.key === params.key) || null } };
    }
    return { ok: false, error: `unexpected ${method}` };
  });
});

describe('Tasks feed authorization cost', () => {
  const A_KEYS = [
    ...Array.from({ length: 6 }, (_, i) => `agent:main:subagent:a-${5 - i}`),
    ...Array.from({ length: 6 }, (_, i) => `agent:main:subagent:a-${5 - i}-g`),
  ];
  const B_KEYS = ['agent:main:cron:weekly:run:w-b', 'agent:main:cron:z:run:b-claim', 'agent:main:cron:odd:run:b-claim'];
  // Lookups per poll (database reads, native describes): the previous feed vs now.
  test.each([
    ['the Owner', owner, OWNER_KEYS, { before: { db: 630, describe: 18 }, after: { db: 230, describe: 12 } }],
    ['a sub-admin with a sub-agent lineage', userA, A_KEYS, { before: { db: 630, describe: 18 }, after: { db: 438, describe: 12 } }],
    ['a sub-admin with claimed cron runs', userB, B_KEYS, { before: { db: 630, describe: 18 }, after: { db: 438, describe: 12 } }],
  ])('%s gets the identical payload for fewer lookups', async (_label, user, expectedKeys, expectedCounts) => {
    const before = await measure(() => previousTasks(user));
    const after = await measure(() => tasksAs(user));

    expect(after.result.body.ok).toBe(true);
    expect(after.result.body.tasks).toEqual(before.result);
    expect(keysOf(after.result.body.tasks)).toEqual(expectedKeys);
    expect({
      before: { db: before.db, describe: before.describe },
      after: { db: after.db, describe: after.describe },
    }).toEqual(expectedCounts);
  });

  test('each request reads claims afresh: a claim made between two users\' polls is honoured', async () => {
    const hostChild = 'agent:main:subagent:host-child';
    ROWS.push({ key: hostChild, kind: 'subagent', spawnedBy: 'agent:main:main', status: 'done', updatedAt: 5000 });
    try {
      expect(keysOf((await tasksAs(owner)).body.tasks)).toContain(hostChild);
      expect(keysOf((await tasksAs(userB)).body.tasks)).not.toContain(hostChild);

      mockClaims.push({ externalId: hostChild, userId: B });

      expect(keysOf((await tasksAs(userB)).body.tasks)).toContain(hostChild);
      expect(keysOf((await tasksAs(owner)).body.tasks)).not.toContain(hostChild);
    } finally {
      ROWS.pop();
    }
  });
});
