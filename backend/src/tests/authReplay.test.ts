import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';

const systemSettingFindUnique = jest.fn();
const sessionFindUnique = jest.fn();
const sessionUpdateMany = jest.fn();
const sessionDeleteMany = jest.fn();
const sessionFindMany = jest.fn();
const sessionCreate = jest.fn();
const resetFindUnique = jest.fn();
const resetUpdateMany = jest.fn();
const userFindUnique = jest.fn();
const userUpdate = jest.fn();
const userUpdateMany = jest.fn();
const resetChallengeDeleteMany = jest.fn();
const resetEmailCodeDeleteMany = jest.fn();
const challengeFindUnique = jest.fn();
const challengeUpdateMany = jest.fn();
const challengeDeleteMany = jest.fn();
const emailCodeFindFirst = jest.fn();
const emailCodeUpdateMany = jest.fn();
const activityCreate = jest.fn();
const projectAuthorizationTransitionFindFirst = jest.fn();
const transaction = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findUnique: systemSettingFindUnique },
    session: {
      findUnique: sessionFindUnique,
      updateMany: sessionUpdateMany,
      deleteMany: sessionDeleteMany,
      findMany: sessionFindMany,
      create: sessionCreate,
    },
    passwordResetToken: {
      findUnique: resetFindUnique,
      updateMany: resetUpdateMany,
    },
    user: { findUnique: userFindUnique, update: userUpdate, updateMany: userUpdateMany },
    twoFactorChallenge: {
      findUnique: challengeFindUnique,
      updateMany: challengeUpdateMany,
      deleteMany: challengeDeleteMany,
    },
    emailVerificationCode: {
      findFirst: emailCodeFindFirst,
      updateMany: emailCodeUpdateMany,
    },
    activityLog: { create: activityCreate },
    $transaction: transaction,
  },
}));

jest.mock('../config/env', () => ({
  config: {
    nodeEnv: 'test',
    jwtSecret: 'test-access-secret-with-sufficient-entropy',
    jwtRefreshSecret: 'test-refresh-secret-with-sufficient-entropy',
    jwtExpiration: '15m',
    jwtRefreshExpiration: '7d',
  },
}));

jest.mock('../utils/password', () => ({
  hashPassword: jest.fn(async (value: string) => `bcrypt:${value}`),
  comparePassword: jest.fn(async (value: string, hash: string) => hash === `bcrypt:${value}`),
  validatePasswordStrength: jest.fn(() => ({ valid: true, errors: [] })),
}));

jest.mock('../services/email', () => ({ sendNewUserAlert: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  sendWelcomeEmail: jest.fn(),
  sendPasswordChangedEmail: jest.fn(async () => undefined),
  sendPasswordResetEmail: jest.fn(),
  sendLoginAlertEmail: jest.fn(async () => undefined),
  sendTwoFactorEnabledEmail: jest.fn(),
  sendTwoFactorDisabledEmail: jest.fn(),
  sendTwoFactorCodeEmail: jest.fn(),
}));
jest.mock('../services/userMailService', () => ({ provisionUserMailbox: jest.fn() }));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'totp-secret'),
  generateURI: jest.fn(() => 'otpauth://test'),
  verify: jest.fn(async () => ({ valid: false })),
  NobleCryptoPlugin: class NobleCryptoPlugin {},
  ScureBase32Plugin: class ScureBase32Plugin {},
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn(async () => 'data:image/png;base64,test') }));
jest.mock('../utils/auth-tracking', () => ({
  extractIP: jest.fn(() => '127.0.0.1'),
  extractTrackingMetadata: jest.fn(() => ({
    ip: '127.0.0.1',
    rawUserAgent: 'jest',
    geo: { summary: 'test' },
    device: { summary: 'test' },
  })),
  formatLoginMessage: jest.fn(() => 'login'),
  formatHoneypotMessage: jest.fn(() => 'honeypot'),
  recordFailedAttempt: jest.fn(() => ({ blocked: false })),
  clearFailedAttempts: jest.fn(),
  isRateLimited: jest.fn(() => false),
  blockedIPs: new Set<string>(),
}));

import authRouter from '../routes/auth';
import { errorHandler } from '../middleware/errorHandler';
import { digestAuthToken } from '../utils/authSecrets';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../utils/jwt';
import { subscribeToSessionRevocations } from '../services/sessionRevocationBus';

type TestResponse = { status: number; body: any; headers: http.IncomingHttpHeaders };

async function request(
  server: http.Server,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': String(encoded.length),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode || 0,
          body: text ? JSON.parse(text) : undefined,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.write(encoded);
    req.end();
  });
}

async function getRequest(
  server: http.Server,
  path: string,
  cookie?: string,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'GET',
      path,
      headers: cookie ? { cookie } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode || 0,
          body: text ? JSON.parse(text) : undefined,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function responseCookie(response: TestResponse, name: string): string | undefined {
  const prefix = `${name}=`;
  const serialized = (response.headers['set-cookie'] || [])
    .find((value) => value.startsWith(prefix));
  return serialized?.slice(prefix.length).split(';', 1)[0];
}

class SharedBrowserCookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(initial: Record<string, string>) {
    for (const [name, value] of Object.entries(initial)) this.cookies.set(name, value);
  }

  requestHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  apply(response: TestResponse): void {
    for (const setCookie of response.headers['set-cookie'] || []) {
      const pair = setCookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(setCookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

function twoCallerBarrier() {
  let calls = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    calls += 1;
    if (calls === 2) release();
    await ready;
  };
}

describe('auth one-time proof replay guards', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    systemSettingFindUnique.mockResolvedValue(null);
    activityCreate.mockResolvedValue({});
    projectAuthorizationTransitionFindFirst.mockResolvedValue(null);
    sessionFindMany.mockResolvedValue([]);
    sessionDeleteMany.mockResolvedValue({ count: 0 });
    userFindUnique.mockResolvedValue(null);
    challengeDeleteMany.mockResolvedValue({ count: 0 });
    sessionCreate.mockResolvedValue({ id: 'session-new' });
    userUpdate.mockResolvedValue({});
    userUpdateMany.mockResolvedValue({ count: 1 });
    emailCodeUpdateMany.mockResolvedValue({ count: 1 });
    transaction.mockImplementation(async (callback) => callback({
      projectAuthorizationTransition: {
        findFirst: projectAuthorizationTransitionFindFirst,
      },
      session: {
        findUnique: sessionFindUnique,
        updateMany: sessionUpdateMany,
        deleteMany: sessionDeleteMany,
      },
    }));

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('atomically rotates a refresh token so a racing replay cannot create a second access token', async () => {
    const refreshToken = generateRefreshToken({ userId: 'user-1' });
    const initialHash = digestAuthToken('refresh', refreshToken);
    const barrier = twoCallerBarrier();
    sessionFindUnique.mockImplementation(async () => {
      await barrier();
      return {
        id: 'session-1',
        userId: 'user-1',
        refreshTokenHash: initialHash,
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
          accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: true,
        },
      };
    });

    let currentHash = initialHash;
    sessionUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.refreshTokenHash !== currentHash) return { count: 0 };
      currentHash = data.refreshTokenHash;
      return { count: 1 };
    });

    const responses = await Promise.all([
      request(server, '/auth/refresh', { refreshToken }),
      request(server, '/auth/refresh', { refreshToken }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(sessionUpdateMany).toHaveBeenCalledTimes(3);
    expect(currentHash).not.toBe(initialHash);
    const success = responses.find((response) => response.status === 200)!;
    expect(verifyAccessToken(success.body.accessToken)?.sessionId).toBe('session-1');
    expect(verifyRefreshToken(responseCookie(success, 'refreshToken')!)?.sessionId)
      .toBe('session-1');
  });

  test('idempotent stable-session logout publishes exact revocation even when the row is already gone', async () => {
    const sessionId = 'already-deleted-session';
    const accessToken = generateAccessToken({
      userId: 'user-1',
      sessionId,
      email: 'user@example.com',
      role: 'USER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 3,
    });
    const events: any[] = [];
    const unsubscribe = subscribeToSessionRevocations('user-1', sessionId, (event) => events.push(event));
    sessionDeleteMany.mockResolvedValue({ count: 0 });

    try {
      const response = await request(server, '/auth/logout', {}, `accessToken=${accessToken}`);
      expect(response.status).toBe(200);
      expect(sessionDeleteMany).toHaveBeenCalledWith({
        where: { id: sessionId, userId: 'user-1' },
      });
      expect(events).toEqual([{
        type: 'session_revoked',
        userId: 'user-1',
        sessionId,
        reason: 'logout',
      }]);
    } finally {
      unsubscribe();
    }
  });

  test('legacy access logout revokes its user even with a cross-identity refresh cookie', async () => {
    const legacyAccess = generateAccessToken({
      userId: 'legacy-user',
      email: 'legacy@example.com',
      role: 'USER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 4,
    });
    const foreignRefresh = generateRefreshToken({
      userId: 'foreign-user',
      sessionId: 'foreign-session',
    });
    const updateAuthorizationVersion = jest.fn(async () => ({ authorizationVersion: 5 }));
    transaction.mockImplementation(async (callback) => callback({
      projectAuthorizationTransition: {
        findFirst: projectAuthorizationTransitionFindFirst,
      },
      session: { deleteMany: sessionDeleteMany },
      user: { update: updateAuthorizationVersion },
    }));
    const events: any[] = [];
    const unsubscribe = subscribeToSessionRevocations('legacy-user', null, (event) => events.push(event));

    try {
      const response = await request(
        server,
        '/auth/logout',
        {},
        `accessToken=${legacyAccess}; refreshToken=${foreignRefresh}`,
      );
      expect(response.status).toBe(200);
      expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: 'legacy-user' } });
      expect(updateAuthorizationVersion).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'legacy-user' },
        data: { authorizationVersion: { increment: 1 } },
      }));
      expect(events).toEqual([{
        type: 'session_revoked',
        userId: 'legacy-user',
        sessionId: null,
        reason: 'logout',
      }]);
    } finally {
      unsubscribe();
    }
  });

  test('keeps a shared browser cookie jar authenticated when the losing tab responds last', async () => {
    const refreshToken = generateRefreshToken({ userId: 'user-1' });
    const initialHash = digestAuthToken('refresh', refreshToken);
    const jar = new SharedBrowserCookieJar({
      accessToken: 'old-access-token',
      refreshToken,
    });
    // Browser networking snapshots both requests before either response can
    // mutate the shared cookie jar, exactly as two independently loaded tabs do.
    const tabACookies = jar.requestHeader();
    const tabBCookies = jar.requestHeader();
    const barrier = twoCallerBarrier();
    sessionFindUnique.mockImplementation(async () => {
      await barrier();
      return {
        id: 'session-1',
        userId: 'user-1',
        refreshTokenHash: initialHash,
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
          accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: true,
        },
      };
    });

    let successfulResponseApplied!: () => void;
    const winnerApplied = new Promise<void>((resolve) => { successfulResponseApplied = resolve; });
    let currentHash = initialHash;
    sessionUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.refreshTokenHash !== currentHash) {
        // Make the replay response deterministic: it reaches the browser only
        // after the successful rotation cookies have already been applied.
        await winnerApplied;
        return { count: 0 };
      }
      currentHash = data.refreshTokenHash;
      return { count: 1 };
    });

    const applyResponse = async (cookie: string) => {
      const response = await request(server, '/auth/refresh', {}, cookie);
      jar.apply(response);
      if (response.status === 200) successfulResponseApplied();
      return response;
    };
    const responses = await Promise.all([
      applyResponse(tabACookies),
      applyResponse(tabBCookies),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.filter((response) => response.body?.accessToken)).toHaveLength(1);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict?.body).toEqual(expect.objectContaining({
      code: 'AUTH_REFRESH_ROTATION_CONFLICT',
      retryable: true,
    }));
    expect(conflict?.headers['set-cookie']).toBeUndefined();
    expect(jar.get('refreshToken')).toBeDefined();
    expect(jar.get('refreshToken')).not.toBe(refreshToken);
    expect(jar.get('accessToken')).toBeDefined();
  });

  test('keeps winner cookies when the conflict response reaches the browser first', async () => {
    const refreshToken = generateRefreshToken({ userId: 'user-1' });
    const initialHash = digestAuthToken('refresh', refreshToken);
    const jar = new SharedBrowserCookieJar({ accessToken: 'old-access-token', refreshToken });
    const tabACookies = jar.requestHeader();
    const tabBCookies = jar.requestHeader();
    const barrier = twoCallerBarrier();
    sessionFindUnique.mockImplementation(async () => {
      await barrier();
      return {
        id: 'session-1', userId: 'user-1', refreshTokenHash: initialHash,
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
          accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: true,
        },
      };
    });
    let currentHash = initialHash;
    sessionUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.refreshTokenHash !== currentHash) return { count: 0 };
      currentHash = data.refreshTokenHash;
      return { count: 1 };
    });
    let conflictResponseApplied!: () => void;
    const conflictApplied = new Promise<void>((resolve) => { conflictResponseApplied = resolve; });
    systemSettingFindUnique.mockImplementation(async () => {
      await conflictApplied;
      return null;
    });

    const appliedStatuses: number[] = [];
    const applyResponse = async (cookie: string) => {
      const response = await request(server, '/auth/refresh', {}, cookie);
      jar.apply(response);
      appliedStatuses.push(response.status);
      if (response.status === 409) conflictResponseApplied();
      return response;
    };
    const responses = await Promise.all([
      applyResponse(tabACookies),
      applyResponse(tabBCookies),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(appliedStatuses).toEqual([409, 200]);
    expect(jar.get('refreshToken')).toBeDefined();
    expect(jar.get('refreshToken')).not.toBe(refreshToken);
    expect(jar.get('accessToken')).toBeDefined();
  });

  test('does not clear winner cookies when a stale request looks up after commit', async () => {
    const refreshToken = generateRefreshToken({ userId: 'user-1', sessionId: 'session-1' });
    const initialHash = digestAuthToken('refresh', refreshToken);
    const jar = new SharedBrowserCookieJar({ accessToken: 'old-access-token', refreshToken });
    const tabACookies = jar.requestHeader();
    const tabBCookies = jar.requestHeader();
    let secondLookupEntered!: () => void;
    const secondLookup = new Promise<void>((resolve) => { secondLookupEntered = resolve; });
    let winnerResponseApplied!: () => void;
    const winnerApplied = new Promise<void>((resolve) => { winnerResponseApplied = resolve; });
    let lookupCount = 0;
    sessionFindUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'session-1') {
        return {
          id: 'session-1',
          userId: 'user-1',
          expiresAt: new Date(Date.now() + 60_000),
        };
      }
      lookupCount += 1;
      if (lookupCount === 1) {
        await secondLookup;
        return {
          id: 'session-1', userId: 'user-1', refreshTokenHash: initialHash,
          expiresAt: new Date(Date.now() + 60_000),
          user: {
            id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
            accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: true,
          },
        };
      }
      secondLookupEntered();
      await winnerApplied;
      return null;
    });
    sessionUpdateMany.mockResolvedValue({ count: 1 });

    const appliedStatuses: number[] = [];
    const applyResponse = async (cookie: string) => {
      const response = await request(server, '/auth/refresh', {}, cookie);
      jar.apply(response);
      appliedStatuses.push(response.status);
      if (response.status === 200) winnerResponseApplied();
      return response;
    };
    const responses = await Promise.all([
      applyResponse(tabACookies),
      applyResponse(tabBCookies),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(appliedStatuses).toEqual([200, 409]);
    const stale = responses.find((response) => response.status === 409);
    expect(stale?.body?.code).toBe('AUTH_REFRESH_ROTATION_CONFLICT');
    expect(stale?.headers['set-cookie']).toBeUndefined();
    expect(jar.get('refreshToken')).toBeDefined();
    expect(jar.get('refreshToken')).not.toBe(refreshToken);
  });

  test('clears matching browser cookies when the stable durable session was revoked', async () => {
    const refreshToken = generateRefreshToken({
      userId: 'user-1',
      sessionId: 'session-revoked',
    });
    sessionFindUnique.mockResolvedValue(null);

    const response = await request(
      server,
      '/auth/refresh',
      {},
      `accessToken=old-access-token; refreshToken=${refreshToken}`,
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: 'AUTH_REFRESH_SESSION_GONE',
    }));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^accessToken=;/),
      expect.stringMatching(/^refreshToken=;/),
    ]));
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });

  test('does not erase an unrelated browser jar for a body-carried revoked token', async () => {
    const refreshToken = generateRefreshToken({
      userId: 'user-1',
      sessionId: 'session-revoked',
    });
    sessionFindUnique.mockResolvedValue(null);

    const response = await request(server, '/auth/refresh', { refreshToken });

    expect(response.status).toBe(401);
    expect(response.body?.code).toBe('AUTH_REFRESH_SESSION_GONE');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('returns a terminal missing-token response without deletion cookies', async () => {
    const response = await request(server, '/auth/refresh', {});

    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });

  test('returns a terminal invalid-token response without deletion cookies', async () => {
    const response = await request(server, '/auth/refresh', { refreshToken: 'not-a-valid-jwt' });

    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });

  test('expires the durable session without sending a stale cookie deletion', async () => {
    const refreshToken = generateRefreshToken({ userId: 'user-1' });
    const refreshTokenHash = digestAuthToken('refresh', refreshToken);
    sessionFindUnique.mockResolvedValue({
      id: 'session-expired',
      userId: 'user-1',
      refreshTokenHash,
      expiresAt: new Date(Date.now() - 60_000),
      user: {
        id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
        accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: true,
      },
    });

    const response = await request(server, '/auth/refresh', { refreshToken });

    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { id: 'session-expired', refreshTokenHash },
    });
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });

  test('blocks an inaccessible account without sending a stale cookie deletion', async () => {
    const refreshToken = generateRefreshToken({ userId: 'user-1' });
    const refreshTokenHash = digestAuthToken('refresh', refreshToken);
    sessionFindUnique.mockResolvedValue({
      id: 'session-blocked',
      userId: 'user-1',
      refreshTokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
        accountStatus: 'SUSPENDED', isActive: true, sandboxEnabled: true,
      },
    });

    const response = await request(server, '/auth/refresh', { refreshToken });

    expect(response.status).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { id: 'session-blocked', refreshTokenHash },
    });
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });

  test('consumes a reset token in the same transaction as password/session mutation', async () => {
    const rawToken = 'single-use-reset-token';
    const tokenHash = digestAuthToken('password-reset', rawToken);
    const barrier = twoCallerBarrier();
    resetFindUnique.mockImplementation(async () => {
      await barrier();
      return {
        id: 'reset-1', userId: 'user-1', token: tokenHash,
        usedAt: null, expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: 'user-1',
          email: 'user@example.com',
          username: 'user',
          firstName: null,
          lastName: null,
          passwordHash: 'bcrypt:OldPassword123!',
          role: 'USER',
          accountStatus: 'ACTIVE',
          isActive: true,
          sandboxEnabled: true,
          authorizationVersion: 3,
        },
      };
    });

    let available = true;
    resetUpdateMany.mockImplementation(async ({ where }) => {
      if (!where.id) return { count: 0 };
      if (!available) return { count: 0 };
      available = false;
      return { count: 1 };
    });
    transaction.mockImplementation(async (callback) => callback({
      projectAuthorizationTransition: {
        findFirst: projectAuthorizationTransitionFindFirst,
      },
      passwordResetToken: { updateMany: resetUpdateMany },
      user: { updateMany: userUpdateMany },
      session: { deleteMany: sessionDeleteMany },
      twoFactorChallenge: { deleteMany: resetChallengeDeleteMany },
      emailVerificationCode: { deleteMany: resetEmailCodeDeleteMany },
    }));

    const responses = await Promise.all([
      request(server, '/auth/reset-password', { token: rawToken, newPassword: 'NewPassword123!' }),
      request(server, '/auth/reset-password', { token: rawToken, newPassword: 'NewPassword123!' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    expect(sessionDeleteMany).toHaveBeenCalledTimes(1);
    expect(resetChallengeDeleteMany).toHaveBeenCalledTimes(1);
    expect(resetEmailCodeDeleteMany).toHaveBeenCalledTimes(1);
  });

  test('cannot restore old browser cookies after a password reset deletes their session', async () => {
    const sessionId = 'session-before-password-reset';
    const accessToken = generateAccessToken({
      userId: 'user-1',
      sessionId,
      email: 'user@example.com',
      role: 'USER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 3,
    });
    const refreshToken = generateRefreshToken({ userId: 'user-1', sessionId });
    const oldBrowserCookies = `accessToken=${accessToken}; refreshToken=${refreshToken}`;
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      username: 'user',
      firstName: null,
      lastName: null,
      passwordHash: 'bcrypt:OldPassword123!',
      role: 'USER',
      accountStatus: 'ACTIVE',
      isActive: true,
      sandboxEnabled: true,
      authorizationVersion: 3,
      avatarPath: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    let sessionAlive = true;
    userFindUnique.mockImplementation(async ({ select }) => ({
      ...user,
      ...(select?.sessions
        ? { sessions: sessionAlive ? [{
          id: sessionId,
          expiresAt: new Date(Date.now() + 60_000),
        }] : [] }
        : {}),
    }));

    const beforeReset = await getRequest(server, '/auth/me', oldBrowserCookies);
    expect(beforeReset.status).toBe(200);

    const rawToken = 'reset-from-another-browser';
    resetFindUnique.mockResolvedValue({
      id: 'reset-other-browser',
      userId: user.id,
      token: digestAuthToken('password-reset', rawToken),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user,
    });
    resetUpdateMany.mockResolvedValue({ count: 1 });
    sessionDeleteMany.mockImplementation(async ({ where }) => {
      if (where.userId === user.id) sessionAlive = false;
      return { count: 1 };
    });
    transaction.mockImplementation(async (callback) => callback({
      projectAuthorizationTransition: {
        findFirst: projectAuthorizationTransitionFindFirst,
      },
      passwordResetToken: { updateMany: resetUpdateMany },
      user: { updateMany: userUpdateMany },
      session: { deleteMany: sessionDeleteMany },
      twoFactorChallenge: { deleteMany: resetChallengeDeleteMany },
      emailVerificationCode: { deleteMany: resetEmailCodeDeleteMany },
    }));

    const reset = await request(server, '/auth/reset-password', {
      token: rawToken,
      newPassword: 'NewPassword123!',
    });
    expect(reset.status).toBe(200);
    expect(sessionAlive).toBe(false);

    // A different browser still has both old httpOnly cookies. Reload must not
    // turn the valid access JWT back into an authenticated Portal session.
    const afterReset = await getRequest(server, '/auth/me', oldBrowserCookies);
    expect(afterReset.status).toBe(401);
    expect(afterReset.body).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    expect(afterReset.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(afterReset.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^accessToken=;/),
      expect.stringMatching(/^refreshToken=;/),
    ]));
  });

  test('fails closed on reload when a pre-session-claim browser row was deleted', async () => {
    const accessToken = generateAccessToken({
      userId: 'user-1',
      email: 'user@example.com',
      role: 'USER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 3,
    });
    const refreshToken = generateRefreshToken({ userId: 'user-1' });
    userFindUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      username: 'user',
      firstName: null,
      lastName: null,
      role: 'USER',
      accountStatus: 'ACTIVE',
      isActive: true,
      sandboxEnabled: true,
      authorizationVersion: 3,
      avatarPath: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: null,
    });
    sessionFindUnique.mockResolvedValue(null);

    const response = await getRequest(
      server,
      '/auth/me',
      `accessToken=${accessToken}; refreshToken=${refreshToken}`,
    );

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^accessToken=;/),
      expect.stringMatching(/^refreshToken=;/),
    ]));
  });

  test('consumes the 2FA challenge and email proof once when validation races', async () => {
    const pendingToken = 'opaque-pending-token';
    const challengeHash = digestAuthToken('2fa-challenge', pendingToken);
    const barrier = twoCallerBarrier();
    const user = {
      id: 'user-1', email: 'user@example.com', username: 'user', role: 'USER',
      accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: true,
      twoFactorEnabled: true, twoFactorMethod: 'email', twoFactorSecret: null,
      twoFactorBackupCodes: null, twoFactorLastUsedStep: null,
    };
    challengeFindUnique.mockImplementation(async () => {
      await barrier();
      return {
        id: 'challenge-1', userId: user.id, tokenHash: challengeHash,
        expiresAt: new Date(Date.now() + 60_000), consumedAt: null, user,
      };
    });
    emailCodeFindFirst.mockResolvedValue({
      id: 'code-1', userId: user.id, purpose: 'login:challenge-1',
      code: 'bcrypt:123456', usedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });

    let challengeAvailable = true;
    challengeUpdateMany.mockImplementation(async () => {
      if (!challengeAvailable) return { count: 0 };
      challengeAvailable = false;
      return { count: 1 };
    });
    transaction.mockImplementation(async (callback) => callback({
      projectAuthorizationTransition: { findFirst: projectAuthorizationTransitionFindFirst },
      twoFactorChallenge: { updateMany: challengeUpdateMany },
      emailVerificationCode: { updateMany: emailCodeUpdateMany },
      user: { updateMany: userUpdateMany },
      session: { create: sessionCreate },
    }));

    const responses = await Promise.all([
      request(server, '/auth/2fa/validate', { pendingToken, token: '123456' }),
      request(server, '/auth/2fa/validate', { pendingToken, token: '123456' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(emailCodeUpdateMany).toHaveBeenCalledTimes(1);
  });
});
