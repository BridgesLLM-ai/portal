const transactionMock = jest.fn();
const releaseDeleteManyMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    $transaction: transactionMock,
    appShareRequestLease: {
      deleteMany: releaseDeleteManyMock,
    },
  },
}));

import {
  __shareConcurrentUseTest,
  claimShareConcurrentUse,
  releaseShareConcurrentUse,
  renewShareConcurrentUse,
  startShareConcurrentUseHeartbeat,
} from '../services/shareConcurrentUse';

const now = Date.parse('2026-08-20T18:00:00.000Z');
const visitorA = 'a'.repeat(64);
const visitorB = 'b'.repeat(64);
const visitorC = 'c'.repeat(64);

function lockedShare(limit: number | null) {
  return {
    id: 'link-1',
    isActive: true,
    expiresAt: null,
    maxConcurrentVisitors: limit,
    userId: 'owner-1',
    appIsActive: true,
    appUserId: 'owner-1',
  };
}

function sqlText(value: any): string {
  return Array.isArray(value?.strings) ? value.strings.join('?') : String(value);
}

function oneTransaction(input: {
  limit: number | null;
  duplicate?: { shareLinkId: string; visitorIdHash: string; leaseExpiresAt: Date } | null;
  aggregate?: { activeVisitors: number; visitorRequests: number; nextExpiry: Date | null };
  createError?: any;
  cleanupError?: any;
}) {
  const tx = {
    $queryRaw: jest.fn()
      .mockResolvedValueOnce([lockedShare(input.limit)])
      .mockResolvedValueOnce([input.aggregate || {
        activeVisitors: 0,
        visitorRequests: 0,
        nextExpiry: null,
      }]),
    appShareRequestLease: {
      deleteMany: input.cleanupError
        ? jest.fn().mockRejectedValue(input.cleanupError)
        : jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(input.duplicate || null),
      create: input.createError
        ? jest.fn().mockRejectedValue(input.createError)
        : jest.fn().mockResolvedValue({}),
    },
  };
  transactionMock.mockImplementationOnce(async (callback: any, options: any) => callback(tx, options));
  return tx;
}

describe('durable public-share concurrent-use admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps legacy null-policy links unlimited while cleaning abandoned rows', async () => {
    const tx = oneTransaction({ limit: null });

    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
    }, now)).resolves.toEqual({ status: 'unlimited' });

    expect(tx.appShareRequestLease.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { shareLinkId: 'link-1', leaseExpiresAt: { lte: new Date(now) } },
    });
    expect(tx.appShareRequestLease.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { shareLinkId: 'link-1' },
    });
    expect(tx.appShareRequestLease.create).not.toHaveBeenCalled();
  });

  test('locks the exact share and app rows, reclaims expiry, then stores only digests', async () => {
    const tx = oneTransaction({ limit: 3 });

    const claim = await claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
    }, now);

    expect(claim).toEqual(expect.objectContaining({ status: 'acquired' }));
    if (claim.status !== 'acquired') throw new Error('expected acquired claim');
    expect(claim.leaseExpiresAt.getTime() - now).toBe(__shareConcurrentUseTest.LEASE_TTL_MS);
    expect(sqlText(tx.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE OF share_link');
    expect(sqlText(tx.$queryRaw.mock.calls[0][0])).not.toContain('FOR UPDATE OF share_link, app');
    expect(tx.appShareRequestLease.create).toHaveBeenCalledWith({
      data: {
        leaseTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        shareLinkId: 'link-1',
        visitorIdHash: visitorA,
        leaseExpiresAt: new Date(now + __shareConcurrentUseTest.LEASE_TTL_MS),
        createdAt: new Date(now),
      },
    });
    const persisted = tx.appShareRequestLease.create.mock.calls[0][0].data;
    expect(persisted).not.toHaveProperty('leaseToken');
    expect(JSON.stringify(persisted)).not.toContain(claim.leaseToken);
    expect(transactionMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      isolationLevel: 'ReadCommitted',
      maxWait: 5_000,
      timeout: 10_000,
    }));
  });

  test('returns a verified retry window when distinct visitor capacity is full', async () => {
    const nextExpiry = new Date(now + 12_250);
    const tx = oneTransaction({
      limit: 1,
      aggregate: { activeVisitors: 1, visitorRequests: 0, nextExpiry },
    });

    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorB,
    }, now)).resolves.toEqual({ status: 'limited', retryAfterSeconds: 13 });
    expect(tx.appShareRequestLease.create).not.toHaveBeenCalled();
  });

  test('allows parallel requests from one signed visitor without consuming another visitor slot', async () => {
    const tx = oneTransaction({
      limit: 1,
      aggregate: {
        activeVisitors: 1,
        visitorRequests: 1,
        nextExpiry: new Date(now + 30_000),
      },
    });

    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
    }, now)).resolves.toEqual(expect.objectContaining({ status: 'acquired' }));
    expect(tx.appShareRequestLease.create).toHaveBeenCalledTimes(1);
  });

  test('makes an ambiguous acquire retry idempotent with the same lease token', async () => {
    const leaseToken = 'A'.repeat(43);
    const existingExpiry = new Date(now + 90_000);
    const tx = oneTransaction({
      limit: 1,
      duplicate: {
        shareLinkId: 'link-1',
        visitorIdHash: visitorA,
        leaseExpiresAt: existingExpiry,
      },
    });

    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
      leaseToken,
    }, now)).resolves.toEqual({
      status: 'acquired',
      leaseToken,
      leaseExpiresAt: existingExpiry,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.appShareRequestLease.create).not.toHaveBeenCalled();
  });

  test('bounds one visitor to 32 simultaneous request rows', async () => {
    const tx = oneTransaction({
      limit: 100,
      aggregate: {
        activeVisitors: 1,
        visitorRequests: __shareConcurrentUseTest.MAX_REQUESTS_PER_VISITOR,
        nextExpiry: new Date(now + 1_000),
      },
    });
    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
    }, now)).resolves.toEqual({ status: 'limited', retryAfterSeconds: 1 });
    expect(tx.appShareRequestLease.create).not.toHaveBeenCalled();
  });

  test('serializes racing distinct visitors at the configured capacity', async () => {
    type Row = { visitorIdHash: string; leaseExpiresAt: Date };
    const rows = new Map<string, Row>();
    let tail: Promise<unknown> = Promise.resolve();

    transactionMock.mockImplementation((callback: any) => {
      const tx = {
        $queryRaw: jest.fn(async (query: any) => {
          const text = sqlText(query);
          if (text.includes('FROM "AppShareLink"')) return [lockedShare(2)];
          const visitorIdHash = query.values.find((value: unknown) => (
            typeof value === 'string' && /^[a-c]{64}$/.test(value)
          ));
          const live = [...rows.values()].filter((row) => row.leaseExpiresAt.getTime() > now);
          return [{
            activeVisitors: new Set(live.map((row) => row.visitorIdHash)).size,
            visitorRequests: live.filter((row) => row.visitorIdHash === visitorIdHash).length,
            nextExpiry: live.length
              ? new Date(Math.min(...live.map((row) => row.leaseExpiresAt.getTime())))
              : null,
          }];
        }),
        appShareRequestLease: {
          deleteMany: jest.fn(async ({ where }: any) => {
            let deleted = 0;
            for (const [key, row] of rows) {
              if (row.leaseExpiresAt.getTime() <= where.leaseExpiresAt.lte.getTime()) {
                rows.delete(key);
                deleted += 1;
              }
            }
            return { count: deleted };
          }),
          findUnique: jest.fn(async ({ where }: any) => {
            const row = rows.get(where.leaseTokenHash);
            return row ? { shareLinkId: 'link-1', ...row } : null;
          }),
          create: jest.fn(async ({ data }: any) => {
            if (rows.has(data.leaseTokenHash)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
            rows.set(data.leaseTokenHash, {
              visitorIdHash: data.visitorIdHash,
              leaseExpiresAt: data.leaseExpiresAt,
            });
            return data;
          }),
        },
      };
      const result = tail.then(() => callback(tx));
      tail = result.then(() => undefined, () => undefined);
      return result;
    });

    const claims = await Promise.all([visitorA, visitorB, visitorC].map((visitorIdHash) => (
      claimShareConcurrentUse({ shareLinkId: 'link-1', visitorIdHash }, now)
    )));
    expect(claims.filter((claim) => claim.status === 'acquired')).toHaveLength(2);
    expect(claims.filter((claim) => claim.status === 'limited')).toHaveLength(1);
    expect(new Set([...rows.values()].map((row) => row.visitorIdHash))).toEqual(new Set([visitorA, visitorB]));
  });

  test('reclaims a crashed request after bounded expiry before admitting a replacement', async () => {
    const expired = new Date(now - 1);
    const tx = oneTransaction({
      limit: 1,
      aggregate: { activeVisitors: 0, visitorRequests: 0, nextExpiry: null },
    });
    tx.appShareRequestLease.deleteMany.mockResolvedValueOnce({ count: 1 });

    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorB,
    }, now)).resolves.toEqual(expect.objectContaining({ status: 'acquired' }));
    expect(tx.appShareRequestLease.deleteMany).toHaveBeenCalledWith({
      where: { shareLinkId: 'link-1', leaseExpiresAt: { lte: new Date(now) } },
    });
    expect(expired.getTime()).toBeLessThan(now);
  });

  test.each([
    { isActive: false },
    { appIsActive: false },
    { appUserId: 'someone-else' },
    { expiresAt: new Date(now) },
    { maxConcurrentVisitors: 0 },
  ])('fails closed for unavailable or malformed authority %#', async (override) => {
    const tx = oneTransaction({ limit: 1 });
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ ...lockedShare(1), ...override }]);
    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
    }, now)).resolves.toEqual({ status: 'unavailable', reason: 'config_drift' });
    expect(tx.appShareRequestLease.create).not.toHaveBeenCalled();
  });

  test('fails closed on cleanup, contention, and general store errors', async () => {
    oneTransaction({ limit: 1, cleanupError: new Error('database unavailable') });
    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1', visitorIdHash: visitorA,
    }, now)).resolves.toEqual({ status: 'unavailable', reason: 'store_error' });

    oneTransaction({ limit: 1, createError: Object.assign(new Error('race'), { code: 'P2002' }) });
    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1', visitorIdHash: visitorA,
    }, now)).resolves.toEqual({ status: 'unavailable', reason: 'contention' });
  });

  test('atomically releases only the exact link, visitor, and token and is idempotent', async () => {
    releaseDeleteManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const input = {
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
      leaseToken: 'Z'.repeat(43),
    };
    await expect(releaseShareConcurrentUse(input)).resolves.toEqual({ status: 'released' });
    await expect(releaseShareConcurrentUse(input)).resolves.toEqual({ status: 'already_released' });
    expect(releaseDeleteManyMock.mock.calls[0][0]).toEqual({
      where: {
        leaseTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        shareLinkId: 'link-1',
        visitorIdHash: visitorA,
      },
    });
  });

  test('renews only the exact live lease under the share policy lock', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([lockedShare(2)]),
      appShareRequestLease: { updateMany, deleteMany },
    };
    transactionMock.mockImplementationOnce(async (callback: any) => callback(tx));
    const leaseToken = 'R'.repeat(43);

    await expect(renewShareConcurrentUse({
      shareLinkId: 'link-1',
      visitorIdHash: visitorA,
      leaseToken,
    }, now)).resolves.toEqual({
      status: 'renewed',
      leaseExpiresAt: new Date(now + __shareConcurrentUseTest.LEASE_TTL_MS),
    });

    expect(sqlText(tx.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE OF share_link');
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        leaseTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        shareLinkId: 'link-1',
        visitorIdHash: visitorA,
        leaseExpiresAt: { gt: new Date(now) },
      },
      data: {
        createdAt: new Date(now),
        leaseExpiresAt: new Date(now + __shareConcurrentUseTest.LEASE_TTL_MS),
      },
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  test('stops carrying a lease when policy becomes unlimited and fails closed when authority is inactive', async () => {
    const unlimitedDelete = jest.fn().mockResolvedValue({ count: 1 });
    transactionMock.mockImplementationOnce(async (callback: any) => callback({
      $queryRaw: jest.fn().mockResolvedValue([lockedShare(null)]),
      appShareRequestLease: { updateMany: jest.fn(), deleteMany: unlimitedDelete },
    }));
    const input = { shareLinkId: 'link-1', visitorIdHash: visitorA, leaseToken: 'S'.repeat(43) };
    await expect(renewShareConcurrentUse(input, now)).resolves.toEqual({ status: 'unlimited' });
    expect(unlimitedDelete).toHaveBeenCalledTimes(1);

    const inactiveDelete = jest.fn().mockResolvedValue({ count: 1 });
    transactionMock.mockImplementationOnce(async (callback: any) => callback({
      $queryRaw: jest.fn().mockResolvedValue([{ ...lockedShare(1), isActive: false }]),
      appShareRequestLease: { updateMany: jest.fn(), deleteMany: inactiveDelete },
    }));
    await expect(renewShareConcurrentUse(input, now)).resolves.toEqual({
      status: 'lost',
      reason: 'inactive_share',
    });
    expect(inactiveDelete).toHaveBeenCalledTimes(1);
  });

  test('reports a missing or unverifiable renewal instead of extending authority optimistically', async () => {
    transactionMock.mockImplementationOnce(async (callback: any) => callback({
      $queryRaw: jest.fn().mockResolvedValue([lockedShare(1)]),
      appShareRequestLease: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn(),
      },
    }));
    const input = { shareLinkId: 'link-1', visitorIdHash: visitorA, leaseToken: 'T'.repeat(43) };
    await expect(renewShareConcurrentUse(input, now)).resolves.toEqual({
      status: 'lost',
      reason: 'missing_lease',
    });

    transactionMock.mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }));
    await expect(renewShareConcurrentUse(input, now)).resolves.toEqual({
      status: 'unavailable',
      reason: 'contention',
    });
  });

  test('serializes heartbeats and invokes the fail-closed callback exactly once', async () => {
    let resolveRenewal!: (value: any) => void;
    const renew = jest.fn().mockImplementation(() => new Promise((resolve) => { resolveRenewal = resolve; }));
    const lost = jest.fn();
    const heartbeat = startShareConcurrentUseHeartbeat({
      shareLinkId: 'link-1', visitorIdHash: visitorA, leaseToken: 'U'.repeat(43),
    }, lost, { intervalMs: 60_000, renew });

    const first = heartbeat.renewNow();
    const overlapping = heartbeat.renewNow();
    expect(renew).toHaveBeenCalledTimes(1);
    resolveRenewal({ status: 'unavailable', reason: 'store_error' });
    await Promise.all([first, overlapping]);
    expect(lost).toHaveBeenCalledTimes(1);
    await heartbeat.renewNow();
    expect(renew).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  test('rejects malformed identities without touching the database and bounds release failure', async () => {
    await expect(claimShareConcurrentUse({
      shareLinkId: 'link-1', visitorIdHash: 'not-a-hash',
    }, now)).resolves.toEqual({ status: 'unavailable', reason: 'config_drift' });
    expect(transactionMock).not.toHaveBeenCalled();

    releaseDeleteManyMock.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(releaseShareConcurrentUse({
      shareLinkId: 'link-1', visitorIdHash: visitorA, leaseToken: 'Q'.repeat(43),
    })).resolves.toEqual({ status: 'unavailable', reason: 'store_error' });
  });
});
