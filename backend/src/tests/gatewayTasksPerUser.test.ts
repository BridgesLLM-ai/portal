import { EventEmitter } from 'events';

// Persistence and the native transport are edges. The real route, role gates,
// session-access guard and lineage walk run unchanged.
const mockClaims: Array<{ externalId: string; userId: string }> = [];
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
  const absent = { findFirst: async () => null, findMany: async () => [], findUnique: async () => null };
  const agentSession = {
    findFirst: async ({ where }: any) => {
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

import router from '../routes/gateway';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { invalidateSessionWorkRows } from '../services/openClawSessionWork';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const userA = { userId: A, email: 'a@example.test', role: 'SUB_ADMIN', accountStatus: 'ACTIVE' };
const userB = { userId: B, email: 'b@example.test', role: 'SUB_ADMIN', accountStatus: 'ACTIVE' };
const owner = { userId: OWNER, email: 'owner@example.test', role: 'OWNER', accountStatus: 'ACTIVE' };

const CHAT_A = `agent:main:portal-${A}`;
const CHAT_B = `agent:main:portal-${B}`;
const CHAT_OWNER = `agent:main:portal-${OWNER}`;
/** A host conversation A claimed (an AgentSession row), not a Portal-scoped key. */
const CLAIMED_BY_A = 'agent:main:dashboard-a';

const ROWS = [
  { key: 'agent:main:main', kind: 'direct' },
  { key: CHAT_A, kind: 'direct' },
  // A 10.x direct chat records its parent but is not a task row (F1).
  { key: `${CHAT_A}-side`, kind: 'direct', parentSessionKey: CHAT_A, updatedAt: 10 },
  { key: 'agent:main:subagent:a-child', kind: 'subagent', spawnedBy: CHAT_A, status: 'running', updatedAt: 9 },
  { key: 'agent:main:subagent:a-grandchild', spawnedBy: 'agent:main:subagent:a-child', status: 'done', updatedAt: 8 },
  { key: 'agent:main:subagent:a-claimed-child', spawnedBy: CLAIMED_BY_A, status: 'done', updatedAt: 7 },
  { key: 'agent:main:subagent:b-child', kind: 'subagent', spawnedBy: CHAT_B, status: 'done', updatedAt: 6 },
  { key: 'agent:main:subagent:owner-child', kind: 'subagent', spawnedBy: CHAT_OWNER, status: 'done', updatedAt: 5 },
  { key: 'agent:main:subagent:host-child', kind: 'subagent', spawnedBy: 'agent:main:main', status: 'done', updatedAt: 4 },
  { key: 'agent:main:cron:nightly:run:r1', status: 'done', updatedAt: 3 },
];
const A_ROWS = ['agent:main:subagent:a-child', 'agent:main:subagent:a-grandchild', 'agent:main:subagent:a-claimed-child'];
const B_ROWS = ['agent:main:subagent:b-child'];
// The Owner's existing explicit view of unclaimed host sessions is kept; other users' rows are not.
const OWNER_ROWS = ['agent:main:subagent:owner-child', 'agent:main:subagent:host-child', 'agent:main:cron:nightly:run:r1'];

const rpc = gatewayRpcCall as jest.MockedFunction<typeof gatewayRpcCall>;
let undescribable = new Set<string>();

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

const keysOf = (res: any) => res.body.tasks.map((task: any) => task.sessionKey);

beforeEach(() => {
  invalidateSessionWorkRows();
  undescribable = new Set();
  mockClaims.splice(0, mockClaims.length, { externalId: CLAIMED_BY_A, userId: A });
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === 'sessions.list') return { ok: true, data: { sessions: ROWS } };
    if (method === 'sessions.describe') {
      if (undescribable.has(params.key)) return { ok: false, error: 'temporarily unavailable' };
      return { ok: true, data: { session: ROWS.find((row) => row.key === params.key) || null } };
    }
    return { ok: false, error: `unexpected ${method}` };
  });
});

describe('per-user Tasks feed', () => {
  test('two sub-admins and the Owner each see only their own and lineage rows', async () => {
    const forA = await tasksAs(userA);
    const forB = await tasksAs(userB);
    const forOwner = await tasksAs(owner);

    expect(forA.body).toMatchObject({ ok: true, source: 'sessions.list' });
    expect(keysOf(forA)).toEqual(A_ROWS);
    expect(keysOf(forB)).toEqual(B_ROWS);
    expect(keysOf(forOwner)).toEqual(OWNER_ROWS);
  });

  test('one user\'s projection is never served to another, back to back or concurrently', async () => {
    const [concurrentA, concurrentB] = await Promise.all([tasksAs(userA), tasksAs(userB)]);
    expect(keysOf(concurrentA)).toEqual(A_ROWS);
    expect(keysOf(concurrentB)).toEqual(B_ROWS);

    expect(keysOf(await tasksAs(userA))).toEqual(A_ROWS);
    const nextB = await tasksAs(userB);
    expect(keysOf(nextB)).toEqual(B_ROWS);
    expect(nextB.headers['Cache-Control']).toBe('private, no-store');
  });

  test('a user who loses access to a session stops seeing its rows on the next request', async () => {
    expect(keysOf(await tasksAs(userA))).toContain('agent:main:subagent:a-claimed-child');

    mockClaims.splice(0, mockClaims.length, { externalId: CLAIMED_BY_A, userId: B });

    expect(keysOf(await tasksAs(userA))).toEqual(['agent:main:subagent:a-child', 'agent:main:subagent:a-grandchild']);
    expect(keysOf(await tasksAs(userB))).toEqual(['agent:main:subagent:a-claimed-child', 'agent:main:subagent:b-child']);
  });

  test('a row whose lineage cannot be verified right now is hidden, not shown', async () => {
    undescribable = new Set(['agent:main:subagent:a-child']);

    const forA = await tasksAs(userA);

    expect(forA.body.ok).toBe(true);
    expect(keysOf(forA)).toEqual(['agent:main:subagent:a-claimed-child']);
  });

  test.each(['USER', 'VIEWER'])('role %s still cannot read the feed', async (role) => {
    const res = await tasksAs({ ...userA, role });

    expect(res.statusCode).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
