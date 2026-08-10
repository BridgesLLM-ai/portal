const updateManyMock = jest.fn();
const findUniqueMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    appShareLink: {
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
    },
  },
}));

import { claimShareRateLimit, type ShareRateLimitPolicy } from '../services/shareRateLimit';

describe('durable share-link request rate admission', () => {
  const now = Date.parse('2026-08-08T12:00:00.000Z');
  const policy = (overrides: Partial<ShareRateLimitPolicy> = {}): ShareRateLimitPolicy => ({
    id: 'link-1',
    isActive: true,
    expiresAt: null,
    rateLimitMaxRequests: 3,
    rateLimitWindowSeconds: 60,
    rateLimitRequestCount: 0,
    rateLimitWindowStartedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps legacy null/null links unlimited without touching the database', async () => {
    await expect(claimShareRateLimit(policy({
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: null,
    }), now)).resolves.toEqual({ status: 'allowed' });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test.each([
    { rateLimitWindowSeconds: null },
    { rateLimitWindowSeconds: 61 },
    { rateLimitMaxRequests: 0 },
    { isActive: false },
    { expiresAt: new Date(now) },
  ])('fails closed for invalid policy or availability snapshot %#', async (overrides) => {
    await expect(claimShareRateLimit(policy(overrides), now))
      .resolves.toEqual({ status: 'unavailable', reason: 'config_drift' });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('starts an absent first window with one conditional reset query', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(claimShareRateLimit(policy(), now)).resolves.toEqual({ status: 'allowed' });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'link-1',
        isActive: true,
        expiresAt: null,
        rateLimitMaxRequests: 3,
        rateLimitWindowSeconds: 60,
        rateLimitWindowStartedAt: null,
        rateLimitRequestCount: 0,
      },
      data: {
        rateLimitWindowStartedAt: new Date(now),
        rateLimitRequestCount: 1,
      },
    });
  });

  test('resets an expired window with one conditional reset query', async () => {
    const startedAt = new Date(now - 60_001);
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(claimShareRateLimit(policy({
      rateLimitRequestCount: 3,
      rateLimitWindowStartedAt: startedAt,
    }), now)).resolves.toEqual({ status: 'allowed' });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateManyMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        rateLimitWindowStartedAt: startedAt,
        rateLimitRequestCount: 3,
      }),
      data: {
        rateLimitWindowStartedAt: new Date(now),
        rateLimitRequestCount: 1,
      },
    }));
  });

  test('increments a live below-cap window with one conditional write and no hidden cap', async () => {
    const startedAt = new Date(now - 10_000);
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(claimShareRateLimit(policy({
      rateLimitMaxRequests: 1_000_000,
      rateLimitRequestCount: 999_999,
      rateLimitWindowStartedAt: startedAt,
    }), now)).resolves.toEqual({ status: 'allowed' });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledWith({
      where: expect.objectContaining({
        rateLimitWindowStartedAt: startedAt,
        rateLimitRequestCount: { gte: 0, lt: 1_000_000 },
      }),
      data: { rateLimitRequestCount: { increment: 1 } },
    });
  });

  test('returns verified 429 from an exhausted live snapshot with zero additional DB calls', async () => {
    await expect(claimShareRateLimit(policy({
      rateLimitRequestCount: 3,
      rateLimitWindowStartedAt: new Date(now - 12_250),
    }), now)).resolves.toEqual({
      status: 'limited',
      retryAfterSeconds: 48,
    });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test.each([
    { rateLimitRequestCount: 1, rateLimitWindowStartedAt: null },
    { rateLimitRequestCount: -1, rateLimitWindowStartedAt: null },
    { rateLimitRequestCount: 0, rateLimitWindowStartedAt: new Date(now - 1) },
    { rateLimitRequestCount: 4, rateLimitWindowStartedAt: new Date(now - 1) },
    { rateLimitRequestCount: 0, rateLimitWindowStartedAt: new Date(now + 1) },
    { rateLimitRequestCount: 0, rateLimitWindowStartedAt: new Date(Number.NaN) },
  ])('fails closed without DB amplification for malformed or future state %#', async (overrides) => {
    await expect(claimShareRateLimit(policy(overrides), now))
      .resolves.toEqual({ status: 'unavailable', reason: 'config_drift' });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('uses one bounded re-read and fallback increment after a snapshot race', async () => {
    const startedAt = new Date(now - 10_000);
    updateManyMock
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    findUniqueMock.mockResolvedValueOnce({
      isActive: true,
      expiresAt: null,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: 2,
      rateLimitWindowStartedAt: startedAt,
    });

    await expect(claimShareRateLimit(policy({
      rateLimitRequestCount: 1,
      rateLimitWindowStartedAt: startedAt,
    }), now)).resolves.toEqual({ status: 'allowed' });
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        rateLimitWindowStartedAt: startedAt,
        rateLimitRequestCount: { gte: 0, lt: 3 },
      }),
      data: { rateLimitRequestCount: { increment: 1 } },
    }));
  });

  test('returns verified 429 when a failed write re-reads a concurrently exhausted row', async () => {
    const startedAt = new Date(now - 10_000);
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    findUniqueMock.mockResolvedValueOnce({
      isActive: true,
      expiresAt: null,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: 3,
      rateLimitWindowStartedAt: startedAt,
    });

    await expect(claimShareRateLimit(policy({
      rateLimitRequestCount: 2,
      rateLimitWindowStartedAt: startedAt,
    }), now)).resolves.toEqual({ status: 'limited', retryAfterSeconds: 50 });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  test('fails closed instead of emitting 429 when policy or expiry changes during admission', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    findUniqueMock.mockResolvedValueOnce({
      isActive: true,
      expiresAt: null,
      rateLimitMaxRequests: 4,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: 4,
      rateLimitWindowStartedAt: new Date(now - 10_000),
    });

    await expect(claimShareRateLimit(policy(), now)).resolves.toEqual({
      status: 'unavailable',
      reason: 'config_drift',
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  test('serializes concurrent active-window claims at the configured cap', async () => {
    const startedAt = new Date(now - 10_000);
    let count = 1;
    updateManyMock.mockImplementation(async (args: any) => {
      if (args.data.rateLimitRequestCount?.increment === 1
        && args.where.rateLimitWindowStartedAt.getTime() === startedAt.getTime()
        && count < args.where.rateLimitRequestCount.lt) {
        count += 1;
        return { count: 1 };
      }
      return { count: 0 };
    });
    findUniqueMock.mockImplementation(async () => ({
      isActive: true,
      expiresAt: null,
      rateLimitMaxRequests: 4,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: count,
      rateLimitWindowStartedAt: startedAt,
    }));

    const snapshot = policy({
      rateLimitMaxRequests: 4,
      rateLimitRequestCount: 1,
      rateLimitWindowStartedAt: startedAt,
    });
    const claims = await Promise.all(Array.from({ length: 4 }, () => claimShareRateLimit(snapshot, now)));
    expect(claims.filter((claim) => claim.status === 'allowed')).toHaveLength(3);
    expect(claims.filter((claim) => claim.status === 'limited')).toHaveLength(1);
    expect(count).toBe(4);
    expect(updateManyMock).toHaveBeenCalledTimes(4);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  test('bounds recovery when a conditional fallback also loses a race', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValueOnce({
      isActive: true,
      expiresAt: null,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: 1,
      rateLimitWindowStartedAt: new Date(now - 10_000),
    });

    await expect(claimShareRateLimit(policy(), now)).resolves.toEqual({
      status: 'unavailable',
      reason: 'contention',
    });
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  test('fails closed when the database claim cannot be verified', async () => {
    updateManyMock.mockRejectedValue(new Error('database unavailable'));
    await expect(claimShareRateLimit(policy(), now)).resolves.toEqual({
      status: 'unavailable',
      reason: 'store_error',
    });
  });
});
