const mockTransaction = jest.fn();
const mockTaskUpdateMany = jest.fn();
const mockTaskUpdate = jest.fn();
const mockTaskUpsert = jest.fn();
const mockTaskFindUnique = jest.fn();
const mockTaskGroupBy = jest.fn();
const mockTaskFindFirst = jest.fn();
const mockMailboxFindUnique = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    $transaction: mockTransaction,
    mailboxReconciliationTask: {
      updateMany: mockTaskUpdateMany,
      update: mockTaskUpdate,
      upsert: mockTaskUpsert,
      findUnique: mockTaskFindUnique,
      groupBy: mockTaskGroupBy,
      findFirst: mockTaskFindFirst,
    },
    mailboxAccount: {
      findUnique: mockMailboxFindUnique,
    },
  },
}));

import { encryptSecret } from '../utils/authSecrets';
import {
  __mailboxReconciliationTest,
  drainMailboxReconciliation,
  enqueueMailboxReconciliation,
  getMailboxReconciliationReadiness,
  initializeMailboxReconciliationRuntime,
  reconcileMailboxUsernameNow,
} from '../services/mailboxReconciliation';

type ClaimedTaskOptions = {
  attempts?: number;
  generation?: number;
  username?: string;
};

function arrangeClaimedTask(options: ClaimedTaskOptions = {}): void {
  const username = options.username || 'alice';
  const attempts = options.attempts || 1;
  const generation = options.generation || 3;
  const now = new Date();

  mockQueryRaw.mockResolvedValue([{ username }]);
  mockTaskUpdate.mockImplementation(async ({ data }: { data: { leaseId: string; leaseExpiresAt: Date } }) => ({
    username,
    generation,
    status: 'PROCESSING',
    attempts,
    nextAttemptAt: now,
    leaseId: data.leaseId,
    leaseExpiresAt: data.leaseExpiresAt,
    lastErrorCode: null,
    lastErrorAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
}

describe('mailbox reconciliation durable state machine', () => {
  const originalFetch = global.fetch;
  const originalEncryptionKey = process.env.PORTAL_ENCRYPTION_KEY;
  const originalOriginMode = process.env.ORIGIN_MODE;
  const originalInstallProfile = process.env.INSTALL_PROFILE;
  const originalAdminPass = process.env.STALWART_ADMIN_PASS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PORTAL_ENCRYPTION_KEY = 'mailbox-reconciliation-runtime-test-key';
    delete process.env.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = 'server';
    process.env.STALWART_ADMIN_PASS = 'admin-password';
    __mailboxReconciliationTest.invalidateReadinessCache();
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mockQueryRaw,
      mailboxReconciliationTask: {
        updateMany: mockTaskUpdateMany,
        update: mockTaskUpdate,
      },
    }));
    mockTaskUpdateMany.mockResolvedValue({ count: 1 });
    mockTaskUpsert.mockResolvedValue({ username: 'alice' });
    mockTaskFindUnique.mockResolvedValue(null);
    mockTaskGroupBy.mockResolvedValue([]);
    mockTaskFindFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __mailboxReconciliationTest.invalidateReadinessCache();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) delete process.env.PORTAL_ENCRYPTION_KEY;
    else process.env.PORTAL_ENCRYPTION_KEY = originalEncryptionKey;
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    if (originalInstallProfile === undefined) delete process.env.INSTALL_PROFILE;
    else process.env.INSTALL_PROFILE = originalInstallProfile;
    if (originalAdminPass === undefined) delete process.env.STALWART_ADMIN_PASS;
    else process.env.STALWART_ADMIN_PASS = originalAdminPass;
  });

  test.each([
    { ORIGIN_MODE: 'tailnet', INSTALL_PROFILE: 'server' },
    { ORIGIN_MODE: '', INSTALL_PROFILE: 'local' },
  ])('parks reconciliation without database, timer, secret, or network work ($ORIGIN_MODE/$INSTALL_PROFILE)', async (environment) => {
    process.env.ORIGIN_MODE = environment.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = environment.INSTALL_PROFILE;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(reconcileMailboxUsernameNow('alice')).resolves.toEqual({
      username: 'alice',
      action: null,
      state: 'not_due',
      ready: false,
      attempts: 0,
      errorCode: 'portal_feature_unavailable',
    });
    await expect(drainMailboxReconciliation({
      maxTasks: 5,
      timeBudgetMs: 1_000,
    })).resolves.toEqual([]);
    await expect(initializeMailboxReconciliationRuntime()).resolves.toBeUndefined();
    await expect(getMailboxReconciliationReadiness()).resolves.toEqual({
      ready: true,
      state: 'unconfigured',
      pending: 0,
      processing: 0,
      blocked: 0,
      oldestUnresolvedAt: null,
      lastRunAt: null,
    });

    expect(__mailboxReconciliationTest.hasRuntimeInterval()).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockTaskFindUnique).not.toHaveBeenCalled();
    expect(mockTaskGroupBy).not.toHaveBeenCalled();
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
    expect(mockMailboxFindUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

  });

  test('persists a canonical task and resets all retry state when re-enqueued', async () => {
    await enqueueMailboxReconciliation(' Alice ');

    expect(mockTaskUpsert).toHaveBeenCalledWith({
      where: { username: 'alice' },
      create: {
        username: 'alice',
        generation: 1,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: expect.any(Date),
      },
      update: {
        generation: { increment: 1 },
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: expect.any(Date),
        lastErrorCode: null,
        lastErrorAt: null,
        completedAt: null,
      },
    });
  });

  test('persists a bounded retry after an ambiguous Stalwart network failure', async () => {
    arrangeClaimedTask({ attempts: 1 });
    mockMailboxFindUnique.mockResolvedValue({
      mailPassword: encryptSecret('mailbox-password'),
    });
    global.fetch = jest.fn().mockRejectedValue(new Error('upstream-secret-must-not-escape')) as unknown as typeof fetch;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedAt = Date.now();

    const outcome = await reconcileMailboxUsernameNow('alice');

    expect(outcome).toEqual({
      username: 'alice',
      action: 'PROVISION',
      state: 'retry_scheduled',
      ready: false,
      attempts: 1,
      errorCode: 'stalwart_network_error',
    });
    const persistedFailure = mockTaskUpdateMany.mock.calls.at(-1)?.[0];
    expect(persistedFailure).toEqual(expect.objectContaining({
      where: expect.objectContaining({ username: 'alice', generation: 3 }),
      data: expect.objectContaining({
        status: 'PENDING',
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: 'stalwart_network_error',
        completedAt: null,
      }),
    }));
    expect(persistedFailure.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(startedAt + 5_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=stalwart_network_error'));
    expect(String(warn.mock.calls)).not.toContain('upstream-secret');
  });

  test('persists a blocked task for a permanent stored-secret failure', async () => {
    arrangeClaimedTask({ attempts: 1 });
    mockMailboxFindUnique.mockResolvedValue({ mailPassword: 'portal-secret:v1:malformed' });
    global.fetch = jest.fn() as unknown as typeof fetch;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const outcome = await reconcileMailboxUsernameNow('alice');

    expect(outcome).toEqual({
      username: 'alice',
      action: 'PROVISION',
      state: 'blocked',
      ready: false,
      attempts: 1,
      errorCode: 'stored_secret_unavailable',
    });
    expect(mockTaskUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ username: 'alice', generation: 3 }),
      data: expect.objectContaining({
        status: 'BLOCKED',
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: 'stored_secret_unavailable',
        completedAt: null,
      }),
    }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blocked username=alice'));
  });
});
