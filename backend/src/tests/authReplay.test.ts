import http from 'http';
import express from 'express';

const systemSettingFindUnique = jest.fn();
const sessionFindUnique = jest.fn();
const sessionUpdateMany = jest.fn();
const sessionDeleteMany = jest.fn();
const sessionFindMany = jest.fn();
const sessionCreate = jest.fn();
const resetFindUnique = jest.fn();
const resetUpdateMany = jest.fn();
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
    user: { update: userUpdate, updateMany: userUpdateMany },
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
import { generateRefreshToken } from '../utils/jwt';

type TestResponse = { status: number; body: any };

async function request(server: http.Server, path: string, body: unknown): Promise<TestResponse> {
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
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.write(encoded);
    req.end();
  });
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

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(sessionUpdateMany).toHaveBeenCalledTimes(3);
    expect(currentHash).not.toBe(initialHash);
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
