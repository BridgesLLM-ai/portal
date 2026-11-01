import { EventEmitter } from 'events';
import { createAgentWorkRouter } from './agentWork';
import { observeOpenClawHello, clearOpenClawHello } from '../services/openClawCompatibility';
import { resolveSessionOwnershipRoot } from '../services/openClawSessionWork';
import { goalControlSchema, goalControlTimeError } from '../services/openClawGoalControl';
import { isOpenClawExecutionCapableGatewayCall } from '../services/openClawExecutionCapableMethods';

// Persistence/native transport are edges. Exercise real router, schemas, role gates and projection.
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, res: any, next: any) => req.user ? next() : res.status(401).json({}) }));
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));
const KEY = 'agent:main:portal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'agent:main:subagent:synthetic';
const OTHER = 'agent:main:portal-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'OWNER', accountStatus: 'ACTIVE' };
const identity = { goalId: 'goal-1', operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', issuedAtMs: Date.now() };
const row = { key: KEY, sessionId: 'physical-1', agentId: 'main', goal: { id: 'goal-1', status: 'paused' } };
function harness() {
  const authorize = jest.fn(async (key: string) => { if (![KEY, CHILD].includes(key)) throw Error('foreign'); });
  const rpc = jest.fn(async (method: string, args: any): Promise<any> => {
    if (method === 'sessions.describe') return { ok: true, data: { session: args.key === KEY ? row : null } };
    if (method === 'sessions.list') return { ok: true, data: { sessions: [row,
      { key: CHILD, spawnedBy: KEY }, { key: OTHER, spawnedBy: KEY }, { key: 'agent:main:cron:synthetic' }] } };
    if (method === 'progressCard.get') return { ok: true, data: { card: { title: 'Synthetic work' } } };
    throw Error('Unexpected RPC');
  });
  const mutate = jest.fn(async (): Promise<any> => ({ ok: true, data: { accepted: true } }));
  const router = createAgentWorkRouter({ authorize, rpc, mutate });
  async function request(path: string, method = 'GET', user: any = actor, body: any = {}) {
    const req: any = { url: path, originalUrl: path, method, user, body, headers: {} };
    const res: any = new EventEmitter(); res.statusCode = 200; res.headers = {};
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.set = (name: string, value: string) => { res.headers[name] = value; return res; };
    await new Promise<void>((resolve, reject) => {
      res.json = (data: any) => { res.body = data; res.emit('finish'); resolve(); return res; };
      (router as any).handle(req, res, (error: any) => error ? reject(error) : reject(Error('unhandled route')));
    });
    return res;
  }
  return { request, authorize, rpc, mutate };
}
beforeEach(() => observeOpenClawHello({ server: { version: '2026.9.9' }, features: { methods: [
  'sessions.goal.update', 'sessions.goal.clear', 'progressCard.get', 'progressCard.refresh', 'chat.send',
] } }));
afterEach(() => clearOpenClawHello());

test.each(['USER', 'VIEWER', 'ADMIN', 'MEMBER'])('negative role %s cannot read or mutate agent work', async role => {
  const h = harness();
  expect((await h.request(`/sessions/${KEY}/work`, 'GET', { ...actor, role })).statusCode).toBe(403);
  expect((await h.request(`/sessions/${KEY}/goal`, 'POST', { ...actor, role }, { ...identity, action: 'resume' })).statusCode).toBe(403);
  expect(h.authorize).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
});
test('foreign session is indistinguishable from missing, with no native read or write', async () => {
  const h = harness(); expect((await h.request(`/sessions/${OTHER}/work`)).statusCode).toBe(404);
  expect((await h.request(`/sessions/${OTHER}/goal`, 'POST', actor, { ...identity, action: 'resume' })).statusCode).toBe(404);
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
});
test('work response filters foreign children, exposes advertised caps and reattests before delivery', async () => {
  const h = harness(); const res = await h.request(`/sessions/${KEY}/work`);
  expect(res.statusCode).toBe(200); expect(res.body.children.map((r: any) => r.key)).toEqual([CHILD]);
  expect(res.body.caps).toEqual({ goals: true, progress: true }); expect(res.headers['Cache-Control']).toBe('private, no-store');
  expect(h.authorize.mock.calls.filter(([key]) => key === KEY)).toHaveLength(3);
});
test('closed goal body cannot replace actor/session/generation; valid mutation pins native identity', async () => {
  const h = harness();
  expect((await h.request(`/sessions/${KEY}/goal`, 'POST', actor, { ...identity, action: 'resume', sessionKey: OTHER })).statusCode).toBe(400);
  const res = await h.request(`/sessions/${KEY}/goal`, 'POST', actor, { ...identity, action: 'resume' });
  expect(res.statusCode).toBe(200);
  expect(h.mutate).toHaveBeenCalledWith(KEY, actor, 'sessions.goal.update', { ...identity, action: 'resume', sessionKey: KEY, sessionId: 'physical-1', agentId: 'main' });
  expect(res.body.goal).toEqual(row.goal);
});
test('unsupported runtime and expired operations do not dispatch', async () => {
  const h = harness(); clearOpenClawHello();
  expect((await h.request(`/sessions/${KEY}/goal`, 'POST', actor, { ...identity, action: 'resume' })).body.code).toBe('GOAL_UNSUPPORTED');
  expect((await h.request(`/sessions/${KEY}/goal`, 'POST', actor, { ...identity, action: 'resume', issuedAtMs: Date.now() - 25 * 3600000 })).body.code).toBe('GOAL_EXPIRED');
  expect(h.mutate).not.toHaveBeenCalled();
});
test('goal start and progress refresh dispatch only through the actor/session broker', async () => {
  const h = harness(); const idempotencyKey = identity.operationId;
  expect((await h.request(`/sessions/${KEY}/goal/start`, 'POST', actor, { objective: 'Synthetic objective', idempotencyKey, issuedAtMs: identity.issuedAtMs })).statusCode).toBe(200);
  expect(h.mutate.mock.calls[0]).toEqual([KEY, actor, 'chat.send', { sessionKey: KEY, message: 'Synthetic objective', idempotencyKey, intent: { kind: 'session-goal-start', version: 1, issuedAtMs: identity.issuedAtMs } }]);
  await h.request(`/sessions/${KEY}/progress/refresh`, 'POST', actor, { idempotencyKey });
  expect(h.mutate.mock.calls[1]).toEqual([KEY, actor, 'progressCard.refresh', { sessionKey: KEY, agentId: 'main', idempotencyKey }]);
});
test('lineage never uses labels and terminates cycles/depth; native parents alone confer root ownership', async () => {
  const hasOwner = async (key: string) => key === KEY;
  expect(await resolveSessionOwnershipRoot(CHILD, { hasOwner, describe: async () => ({ spawnedBy: KEY }) })).toEqual({ root: KEY, inherited: true });
  expect(await resolveSessionOwnershipRoot(CHILD, { hasOwner, describe: async () => ({ label: KEY, origin: { from: KEY } }) })).toEqual({ root: CHILD, inherited: false });
  expect(await resolveSessionOwnershipRoot(CHILD, { hasOwner, describe: async () => ({ spawnedBy: CHILD }) })).toBeNull();
});
test('non-executing goal edits remain cleanup; resume and progress refresh remain fenced', () => {
  for (const action of ['edit', 'pause', 'block', 'complete']) expect(isOpenClawExecutionCapableGatewayCall('sessions.goal.update', { action })).toBe(false);
  expect(isOpenClawExecutionCapableGatewayCall('sessions.goal.update', { action: 'resume' })).toBe(true);
  expect(isOpenClawExecutionCapableGatewayCall('progressCard.refresh', {})).toBe(true);
  expect(goalControlSchema.safeParse({ ...identity, action: 'edit', objective: ' ' }).success).toBe(false);
  expect(goalControlTimeError(Date.now() + 10 * 60000)).toBe('GOAL_INVALID');
});
describe('a chat the gateway has not stored yet (fresh main session, first turn in flight)', () => {
  const MAIN = 'agent:main:main';
  const STORED = 'agent:main:telegram:direct:synthetic';
  function unstartedHarness(options: { generic?: (key: string) => Promise<void>; described?: Record<string, any> } = {}) {
    const order: string[] = [];
    const authorize = jest.fn(async (key: string) => { order.push(`authorize:${key}`); if (key !== KEY) throw Error('lineage'); });
    const authorizeUnstarted = jest.fn(async (key: string) => {
      order.push(`generic:${key}`);
      if (options.generic) await options.generic(key); else if (key === OTHER) throw Error('foreign');
    });
    const rpc = jest.fn(async (method: string, args: any): Promise<any> => {
      order.push(`${method}:${args?.key ?? args?.sessionKey ?? ''}`);
      if (method === 'sessions.describe') return { ok: true, data: { session: options.described?.[args.key] ?? null } };
      if (method === 'sessions.list') return { ok: true, data: { sessions: [] } };
      throw Error('Unexpected RPC');
    });
    const router = createAgentWorkRouter({ authorize, authorizeUnstarted, rpc, mutate: jest.fn() });
    async function get(key: string, user: any = actor) {
      const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/sessions/:key/work');
      const res: any = { statusCode: 200, headers: {} };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.set = (name: string, value: string) => { res.headers[name] = value; return res; };
      res.json = (data: any) => { res.body = data; return res; };
      await layer.route.stack.at(-1).handle({ params: { key }, user }, res);
      return res;
    }
    return { get, authorize, authorizeUnstarted, rpc, order };
  }

  test('an unstored main session answers 200 "not started" after the generic check, never a 404', async () => {
    const h = unstartedHarness();
    const res = await h.get(MAIN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ v: 1, sessionKey: MAIN, started: false, session: null, goal: null, progress: null, children: [],
      caps: { goals: true, progress: true } });
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(h.order).toEqual([`authorize:${MAIN}`, `generic:${MAIN}`, `sessions.describe:${MAIN}`]);
  });

  test('an authorized chat whose first turn has not landed answers "not started" too', async () => {
    const h = unstartedHarness();
    const res = await h.get(KEY);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sessionKey: KEY, started: false, session: null });
    expect(h.authorizeUnstarted).not.toHaveBeenCalled();
  });

  test('a foreign key is refused by the generic check before any native read', async () => {
    const h = unstartedHarness();
    const res = await h.get(OTHER);
    expect(res.statusCode).toBe(404); expect(res.body).toEqual({ v: 1, code: 'SESSION_NOT_FOUND' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  test('a stored chat that lineage refuses stays a plain 404', async () => {
    const h = unstartedHarness({ described: { [STORED]: { key: STORED, spawnedBy: OTHER } } });
    const res = await h.get(STORED);
    expect(res.statusCode).toBe(404); expect(res.body.started).toBeUndefined();
  });

  test.each(['agent:main:subagent:synthetic-missing', 'agent:main:cron:synthetic-missing'])('non-direct lane %s never falls back', async key => {
    const h = unstartedHarness();
    expect((await h.get(key)).statusCode).toBe(404);
    expect(h.authorizeUnstarted).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });

  test('an unreadable gateway keeps the plain 404', async () => {
    const h = unstartedHarness();
    h.rpc.mockImplementation(async () => { throw Error('gateway down'); });
    expect((await h.get(MAIN)).statusCode).toBe(404);
  });

  test('an authorized but missing sub-agent is "not found", not "not started"', async () => {
    const h = unstartedHarness();
    h.authorize.mockImplementation(async () => undefined);
    expect((await h.get('agent:main:subagent:synthetic-missing')).statusCode).toBe(404);
    expect((await h.get(MAIN)).body).toMatchObject({ started: false });
  });

  test('without the generic dependency the route keeps its previous 404', async () => {
    const authorize = jest.fn(async () => { throw Error('lineage'); });
    const rpc = jest.fn();
    const router = createAgentWorkRouter({ authorize, rpc: rpc as any, mutate: jest.fn() });
    const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/sessions/:key/work');
    const res: any = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (data: any) => { res.body = data; return res; };
    await layer.route.stack.at(-1).handle({ params: { key: MAIN }, user: actor }, res);
    expect(res.statusCode).toBe(404); expect(rpc).not.toHaveBeenCalled();
  });
});
