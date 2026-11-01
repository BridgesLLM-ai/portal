// These pure presentation checks never open a database or read host configuration.
jest.mock('../config/env', () => ({ config: { nodeEnv: 'test', openclawApiUrl: 'http://localhost:18789' } }));
jest.mock('../config/database', () => ({ prisma: {} }));
import { __gatewayTasksTest, mapOpenClawLedgerTask, mapOpenClawTaskSession } from '../routes/gateway';

describe('Task conversation identity', () => {
  test('keeps the exact cron run conversation separate from its collapsed display id', () => {
    const key = 'agent:worker:cron:nightly:run:run-42';
    const row = mapOpenClawTaskSession({ key, status: 'done', origin: { from: 'agent:main:main' } });
    expect(row.id).toBe('agent:worker:cron:nightly');
    expect(row.sessionKey).toBe(key);
    expect(row.parentSession).toBe('agent:main:main');
  });
  test('does not invent a child conversation from a ledger UUID or owner key', () => {
    const row = mapOpenClawLedgerTask({ id: 'task-uuid', status: 'done', ownerKey: 'agent:main:main' });
    expect(row?.parentSession).toBe('agent:main:main');
    expect(row).not.toHaveProperty('sessionKey');
  });
});

describe('Task feed source', () => {
  test('derives tasks from session rows without calling a tasks.list method no OpenClaw registers', async () => {
    const rpc = jest.fn(async (method: string) => (method === 'sessions.list'
      ? { ok: true, data: { sessions: [{ key: 'agent:main:subagent:abc', kind: 'subagent', status: 'done', updatedAt: 5 }] } }
      : { ok: false, error: `unknown method ${method}` }));
    const owner = { userId: 'owner', email: 'owner@example.test', role: 'OWNER' };
    const snapshot = await __gatewayTasksTest.fetchTasksSnapshot(owner, rpc as any, async () => {});
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['sessions.list']);
    expect(snapshot).toMatchObject({ ok: true, source: 'sessions.list' });
    expect(snapshot).not.toHaveProperty('warning');
    expect(snapshot.tasks.map((task: any) => task.sessionKey)).toEqual(['agent:main:subagent:abc']);
  });
});
