// These pure presentation checks never open a database or read host configuration.
jest.mock('../config/env', () => ({ config: { nodeEnv: 'test', openclawApiUrl: 'http://localhost:18789' } }));
jest.mock('../config/database', () => ({ prisma: {} }));
import { mapOpenClawLedgerTask, mapOpenClawTaskSession } from '../routes/gateway';

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
