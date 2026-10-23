import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-native-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(tempRoot, 'sessions');

jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, res: any, next: any) => req.user ? next() : res.status(401).json({}) }));
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { createAgentWorkRouter } = require('./agentWork') as typeof import('./agentWork');
const work = require('../services/nativeSessionWork') as typeof import('../services/nativeSessionWork');
const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
/* eslint-enable @typescript-eslint/no-var-requires */

const actor = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'OWNER', accountStatus: 'ACTIVE' };

function harness() {
  const authorize = jest.fn(async () => { throw Error('OpenClaw authorization must not be consulted for native sessions'); });
  const rpc = jest.fn(async () => { throw Error('Unexpected RPC'); });
  const mutate = jest.fn(async () => { throw Error('Unexpected mutation'); });
  const router = createAgentWorkRouter({ authorize, rpc: rpc as any, mutate: mutate as any });
  async function request(url: string, method = 'GET', user: any = actor, body: any = {}) {
    const req: any = { url, originalUrl: url, method, user, body, headers: {} };
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

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('native sessions get Portal-managed work without touching OpenClaw', async () => {
  const sent: string[] = [];
  work.registerNativeGoalDispatcher(async (input) => { sent.push(input.message); return 'started'; });
  work.registerNativeRunProbe(() => false);
  const session = store.createNativeSession('CLAUDE_CODE', actor.userId, {
    executionContext: { scope: 'HOST_OPERATOR', source: 'PORTAL_SERVER', userId: actor.userId },
    metadata: { cwd: tempRoot },
  });
  const h = harness();
  const view = await h.request(`/sessions/${session.sessionId}/work`);
  expect(view.statusCode).toBe(200);
  expect(view.body).toMatchObject({ v: 1, sessionKey: session.sessionId, caps: { goals: true, progress: false }, goal: null });

  const started = await h.request(`/sessions/${session.sessionId}/goal/start`, 'POST', actor, {
    objective: 'Write the summary', idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', issuedAtMs: Date.now(),
  });
  expect(started.statusCode).toBe(200);
  expect(started.body.goal).toMatchObject({ status: 'active', objective: 'Write the summary' });
  expect(sent).toHaveLength(1);

  const paused = await h.request(`/sessions/${session.sessionId}/goal`, 'POST', actor, {
    goalId: started.body.goal.id, operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', issuedAtMs: Date.now(), action: 'pause',
  });
  expect(paused.statusCode).toBe(200);
  expect(paused.body.goal).toMatchObject({ status: 'paused' });
  expect((await h.request(`/sessions/${session.sessionId}/progress/refresh`, 'POST', actor, { idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).statusCode).toBe(409);

  // Someone else's native id falls through to OpenClaw authorization, which refuses.
  const stranger = await h.request(`/sessions/${session.sessionId}/work`, 'GET', { ...actor, userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  expect(stranger.statusCode).toBe(404);
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.mutate).not.toHaveBeenCalled();
  work.__resetNativeSessionWorkForTests();
});

test.each(['USER', 'VIEWER', 'MEMBER'])('role %s cannot read native work', async (role) => {
  const h = harness();
  expect((await h.request('/sessions/claude_code-x/work', 'GET', { ...actor, role })).statusCode).toBe(403);
});
