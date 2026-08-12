const userFindUnique = jest.fn();

jest.mock('../config/database', () => ({
  prisma: { user: { findUnique: userFindUnique } },
}));

import {
  authorizeAccessTokenPayload,
  commitUnderDurableAccessAuthorization,
  establishLongLivedAccessAuthorization,
  type LongLivedAccessAuthorizationDependencies,
} from './accessTokenAuthorization';
import {
  publishAllSessionsRevoked,
  publishSessionRevoked,
  sessionRevocationSubscriberCount,
} from './sessionRevocationBus';
import type { JwtPayload } from '../utils/jwt';

const USER_ID = 'durable-user';
const NOW = new Date('2026-08-11T12:00:00.000Z');

function payload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    userId: USER_ID,
    sessionId: 'session-a',
    email: 'owner@example.test',
    role: 'OWNER',
    accountStatus: 'ACTIVE',
    authorizationVersion: 7,
    ...overrides,
  };
}

function authorizedUser(sessionId = 'session-a', expiresAt = new Date(NOW.getTime() + 60_000)) {
  return {
    id: USER_ID,
    email: 'owner@example.test',
    role: 'OWNER',
    accountStatus: 'ACTIVE',
    isActive: true,
    sandboxEnabled: true,
    authorizationVersion: 7,
    sessions: [{ id: sessionId, expiresAt }],
  };
}

function quietSubscriptions(): Pick<
  LongLivedAccessAuthorizationDependencies,
  'subscribeAuthorization' | 'subscribeGlobalFence'
> {
  return {
    subscribeAuthorization: jest.fn(() => jest.fn()),
    subscribeGlobalFence: jest.fn(() => jest.fn()),
  };
}

describe('transport-neutral durable access authorization', () => {
  afterEach(() => {
    jest.clearAllMocks();
    expect(sessionRevocationSubscriberCount()).toBe(0);
  });

  test('loads account, authorization generation, and exact live Session in one query', async () => {
    const expiresAt = new Date(NOW.getTime() + 60_000);
    userFindUnique.mockResolvedValue(authorizedUser('session-a', expiresAt));

    const result = await authorizeAccessTokenPayload(payload({ exp: 1_786_448_000, iat: 1_786_447_000 }), {
      now: NOW,
    });

    expect(userFindUnique).toHaveBeenCalledTimes(1);
    expect(userFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: USER_ID },
      select: expect.objectContaining({
        authorizationVersion: true,
        sessions: {
          where: { id: 'session-a', expiresAt: { gt: NOW } },
          select: { id: true, expiresAt: true },
          take: 1,
        },
      }),
    }));
    expect(result).toEqual({
      ok: true,
      identity: expect.objectContaining({
        userId: USER_ID,
        sessionId: 'session-a',
        sessionExpiresAt: expiresAt,
        authorizationVersion: 7,
        exp: 1_786_448_000,
        iat: 1_786_447_000,
      }),
    });
  });

  test('fails closed for a missing exact Session or stale authorization generation', async () => {
    userFindUnique.mockResolvedValue({ ...authorizedUser(), sessions: [] });
    await expect(authorizeAccessTokenPayload(payload(), { now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'session_revoked',
    });

    userFindUnique.mockResolvedValue(authorizedUser());
    await expect(authorizeAccessTokenPayload(payload({ authorizationVersion: 6 }), { now: NOW }))
      .resolves.toEqual({ ok: false, reason: 'authorization_changed' });
  });

  test('preserves legacy access-token compatibility without inventing a Session identity', async () => {
    const legacyUser = authorizedUser();
    delete (legacyUser as any).sessions;
    userFindUnique.mockResolvedValue(legacyUser);

    const result = await authorizeAccessTokenPayload(payload({ sessionId: undefined }), { now: NOW });

    expect(result).toEqual({
      ok: true,
      identity: expect.not.objectContaining({ sessionId: expect.anything() }),
    });
    expect((userFindUnique.mock.calls[0][0] as any).select.sessions).toBeUndefined();
  });

  test('subscribe-before-query closes the exact commit race and releases a synchronous subscription', async () => {
    const unsubscribeSession = jest.fn();
    const database = { user: { findUnique: jest.fn() } };
    const result = await establishLongLivedAccessAuthorization({
      payload: payload(),
      authorize: () => true,
      onRevoke: jest.fn(),
      dependencies: {
        database,
        ...quietSubscriptions(),
        subscribeSession: jest.fn((_userId, sessionId, listener) => {
          listener({
            type: 'session_revoked',
            userId: USER_ID,
            sessionId,
            reason: 'logout',
          });
          return unsubscribeSession;
        }),
      },
    });

    expect(result).toEqual({ ok: false, reason: 'session_revoked' });
    expect(database.user.findUnique).not.toHaveBeenCalled();
    expect(unsubscribeSession).toHaveBeenCalledTimes(1);
  });

  test('exact logout closes its modern Session and every legacy authority, but not a modern sibling', async () => {
    const database = {
      user: {
        findUnique: jest.fn(async (args: any) => {
          const sessionId = args.select.sessions?.where.id;
          const user = authorizedUser(sessionId || 'session-a');
          if (!sessionId) delete (user as any).sessions;
          return user;
        }),
      },
    };
    const revokedA = jest.fn();
    const revokedB = jest.fn();
    const revokedLegacy = jest.fn();
    const dependencies = { database, ...quietSubscriptions(), now: () => NOW };

    const authorityA = await establishLongLivedAccessAuthorization({
      payload: payload({ sessionId: 'session-a' }), authorize: () => true, onRevoke: revokedA, dependencies,
    });
    const authorityB = await establishLongLivedAccessAuthorization({
      payload: payload({ sessionId: 'session-b' }), authorize: () => true, onRevoke: revokedB, dependencies,
    });
    const legacyAuthority = await establishLongLivedAccessAuthorization({
      payload: payload({ sessionId: undefined }), authorize: () => true, onRevoke: revokedLegacy, dependencies,
    });
    expect(authorityA.ok && authorityB.ok && legacyAuthority.ok).toBe(true);

    publishSessionRevoked({ userId: USER_ID, sessionId: 'session-a', reason: 'logout' });

    expect(revokedA).toHaveBeenCalledWith('session_revoked');
    expect(revokedLegacy).toHaveBeenCalledWith('session_revoked');
    expect(revokedB).not.toHaveBeenCalled();
    if (authorityB.ok) authorityB.dispose();
  });

  test('user-wide credential recovery closes every modern sibling', async () => {
    const database = {
      user: {
        findUnique: jest.fn(async (args: any) => authorizedUser(args.select.sessions.where.id)),
      },
    };
    const revokedA = jest.fn();
    const revokedB = jest.fn();
    const dependencies = { database, ...quietSubscriptions(), now: () => NOW };
    await establishLongLivedAccessAuthorization({
      payload: payload({ sessionId: 'session-a' }), authorize: () => true, onRevoke: revokedA, dependencies,
    });
    await establishLongLivedAccessAuthorization({
      payload: payload({ sessionId: 'session-b' }), authorize: () => true, onRevoke: revokedB, dependencies,
    });

    publishAllSessionsRevoked({ userId: USER_ID, reason: 'credential_recovery' });

    expect(revokedA).toHaveBeenCalledWith('session_revoked');
    expect(revokedB).toHaveBeenCalledWith('session_revoked');
  });

  test('retires authority at the earlier JWT expiry and clears the timer on cleanup', async () => {
    let clock = NOW;
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const clearTimer = jest.fn();
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const sessionExpiresAt = new Date(NOW.getTime() + 60_000);
    const database = { user: { findUnique: jest.fn(async () => authorizedUser('session-a', sessionExpiresAt)) } };
    const onRevoke = jest.fn();
    const authority = await establishLongLivedAccessAuthorization({
      payload: payload({ exp: Math.floor((NOW.getTime() + 10_000) / 1000) }),
      authorize: () => true,
      onRevoke,
      dependencies: {
        database,
        ...quietSubscriptions(),
        subscribeSession: jest.fn(() => jest.fn()),
        now: () => clock,
        setTimer: (callback, delay) => {
          callbacks.push(callback);
          delays.push(delay);
          return timer;
        },
        clearTimer,
      },
    });

    expect(authority.ok).toBe(true);
    expect(delays).toEqual([10_000]);
    clock = new Date(NOW.getTime() + 10_000);
    callbacks[0]();
    expect(onRevoke).toHaveBeenCalledWith('session_expired');
    expect(clearTimer).not.toHaveBeenCalled();
  });

  test('chunks a one-year durable expiry below Node timer overflow', async () => {
    let clock = NOW;
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const expiry = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    const onRevoke = jest.fn();
    const authority = await establishLongLivedAccessAuthorization({
      payload: payload({ exp: undefined }),
      authorize: () => true,
      onRevoke,
      dependencies: {
        database: { user: { findUnique: jest.fn(async () => authorizedUser('session-a', expiry)) } },
        ...quietSubscriptions(),
        subscribeSession: jest.fn(() => jest.fn()),
        now: () => clock,
        setTimer: (callback, delay) => {
          callbacks.push(callback);
          delays.push(delay);
          return { unref: jest.fn() } as unknown as NodeJS.Timeout;
        },
        clearTimer: jest.fn(),
      },
    });
    expect(authority.ok).toBe(true);
    expect(delays[0]).toBe(2_147_483_647);

    clock = new Date(NOW.getTime() + 2_147_483_647);
    callbacks.shift()!();
    expect(delays[1]).toBeLessThanOrEqual(2_147_483_647);
    expect(onRevoke).not.toHaveBeenCalled();

    clock = expiry;
    callbacks.pop()!();
    expect(onRevoke).toHaveBeenCalledWith('session_expired');
  });

  test('locks User then exact Session before the synchronous external commit', async () => {
    const queryRaw = jest.fn()
      .mockResolvedValueOnce([{
        id: USER_ID,
        email: 'owner@example.test',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: 7,
        databaseNow: NOW,
      }])
      .mockResolvedValueOnce([{
        id: 'session-a',
        expiresAt: new Date(NOW.getTime() + 60_000),
      }]);
    const transaction = jest.fn(async (operation: (tx: any) => Promise<unknown>) => (
      operation({ $queryRaw: queryRaw })
    ));
    const commit = jest.fn(() => 'committed');

    const result = await commitUnderDurableAccessAuthorization({
      payload: payload({ exp: Math.floor((NOW.getTime() + 30_000) / 1000) }),
      authorize: () => true,
      commit,
      database: { $transaction: transaction } as any,
    });

    expect(result).toEqual({ ok: true, value: 'committed' });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const statements = queryRaw.mock.calls.map(([statement]) => statement.strings.join(' '));
    expect(statements[0]).toContain('FROM "User"');
    expect(statements[0]).toContain('FOR SHARE');
    expect(statements[1]).toContain('FROM "Session"');
    expect(statements[1]).toContain('FOR SHARE');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.invocationCallOrder[0]).toBeGreaterThan(queryRaw.mock.invocationCallOrder[1]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  });

  test('refuses the external commit when the locked exact Session is already gone', async () => {
    const queryRaw = jest.fn()
      .mockResolvedValueOnce([{
        id: USER_ID,
        email: 'owner@example.test',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: 7,
        databaseNow: NOW,
      }])
      .mockResolvedValueOnce([]);
    const transaction = jest.fn(async (operation: (tx: any) => Promise<unknown>) => (
      operation({ $queryRaw: queryRaw })
    ));
    const commit = jest.fn();

    await expect(commitUnderDurableAccessAuthorization({
      payload: payload(),
      authorize: () => true,
      commit,
      database: { $transaction: transaction } as any,
    })).resolves.toEqual({ ok: false, reason: 'session_revoked' });
    expect(commit).not.toHaveBeenCalled();
  });

  test('legacy finalization locks every Session deterministically after the User row', async () => {
    const queryRaw = jest.fn()
      .mockResolvedValueOnce([{
        id: USER_ID,
        email: 'owner@example.test',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: 7,
        databaseNow: NOW,
      }])
      .mockResolvedValueOnce([
        { id: 'session-a', expiresAt: new Date(NOW.getTime() + 60_000) },
        { id: 'session-b', expiresAt: new Date(NOW.getTime() + 60_000) },
      ]);
    const transaction = jest.fn(async (operation: (tx: any) => Promise<unknown>) => (
      operation({ $queryRaw: queryRaw })
    ));
    const commit = jest.fn();

    await expect(commitUnderDurableAccessAuthorization({
      payload: payload({ sessionId: undefined }),
      authorize: () => true,
      commit,
      database: { $transaction: transaction } as any,
    })).resolves.toEqual({ ok: true, value: undefined });
    const legacySessionLock = queryRaw.mock.calls[1][0].strings.join(' ');
    expect(legacySessionLock).toContain('WHERE "userId"');
    expect(legacySessionLock).toContain('ORDER BY "id"');
    expect(legacySessionLock).toContain('FOR SHARE');
  });
});
