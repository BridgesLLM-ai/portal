import http from 'http';
import express from 'express';

const systemSettingFindUnique = jest.fn();
const userFindUnique = jest.fn();
const userFindFirst = jest.fn();
const userUpdate = jest.fn();
const userUpdateMany = jest.fn();
const activityLogCreate = jest.fn();
const sessionCreate = jest.fn();
const sessionDeleteMany = jest.fn();
const sessionFindMany = jest.fn();
const sessionFindUnique = jest.fn();
const sessionUpdateMany = jest.fn();
const challengeCreate = jest.fn();
const challengeFindUnique = jest.fn();
const challengeUpdateMany = jest.fn();
const challengeDeleteMany = jest.fn();
const emailCodeCreate = jest.fn();
const emailCodeFindFirst = jest.fn();
const emailCodeUpdateMany = jest.fn();
const emailCodeDeleteMany = jest.fn();
const passwordResetCreate = jest.fn();
const passwordResetUpdateMany = jest.fn();
const transaction = jest.fn();

const comparePassword = jest.fn();
const hashPassword = jest.fn();
const otpVerify = jest.fn();
const sendTwoFactorCodeEmail = jest.fn();
const sendTwoFactorEnabledEmail = jest.fn();
const sendTwoFactorDisabledEmail = jest.fn();
const generateAccessToken = jest.fn();
const generateRefreshToken = jest.fn();
const verifyRefreshToken = jest.fn();
const recoverEmailTwoFactor = jest.fn();
const assertNoProjectAuthorizationTransitionActive = jest.fn();

const transactionClient = {
  user: {
    findFirst: userFindFirst,
    update: userUpdate,
    updateMany: userUpdateMany,
  },
  session: {
    create: sessionCreate,
    deleteMany: sessionDeleteMany,
    findUnique: sessionFindUnique,
    updateMany: sessionUpdateMany,
  },
  twoFactorChallenge: {
    create: challengeCreate,
    updateMany: challengeUpdateMany,
    deleteMany: challengeDeleteMany,
  },
  emailVerificationCode: {
    create: emailCodeCreate,
    updateMany: emailCodeUpdateMany,
    deleteMany: emailCodeDeleteMany,
  },
  passwordResetToken: {
    create: passwordResetCreate,
    updateMany: passwordResetUpdateMany,
  },
  activityLog: { create: activityLogCreate },
};

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findUnique: systemSettingFindUnique },
    user: {
      findFirst: userFindFirst,
      findUnique: userFindUnique,
      update: userUpdate,
      updateMany: userUpdateMany,
    },
    activityLog: { create: activityLogCreate },
    session: {
      create: sessionCreate,
      deleteMany: sessionDeleteMany,
      findMany: sessionFindMany,
      findUnique: sessionFindUnique,
      updateMany: sessionUpdateMany,
    },
    twoFactorChallenge: {
      create: challengeCreate,
      findUnique: challengeFindUnique,
      updateMany: challengeUpdateMany,
      deleteMany: challengeDeleteMany,
    },
    emailVerificationCode: {
      create: emailCodeCreate,
      findFirst: emailCodeFindFirst,
      updateMany: emailCodeUpdateMany,
      deleteMany: emailCodeDeleteMany,
    },
    passwordResetToken: {
      create: passwordResetCreate,
      updateMany: passwordResetUpdateMany,
    },
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

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.user = {
      userId: 'user-1',
      email: 'owner@example.test',
      role: 'ADMIN',
      accountStatus: 'ACTIVE',
      sandboxEnabled: true,
      authorizationVersion: 7,
    };
    next();
  },
}));

jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock('../utils/password', () => ({
  hashPassword,
  comparePassword,
  validatePasswordStrength: jest.fn(() => ({ valid: true, errors: [] })),
}));

jest.mock('../utils/jwt', () => ({
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken: jest.fn(),
  verifyRefreshToken,
}));

jest.mock('../services/email', () => ({ sendNewUserAlert: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  sendWelcomeEmail: jest.fn(),
  sendPasswordChangedEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendLoginAlertEmail: jest.fn(),
  sendTwoFactorEnabledEmail,
  sendTwoFactorDisabledEmail,
  sendTwoFactorCodeEmail,
}));
jest.mock('../services/userMailService', () => ({ provisionUserMailbox: jest.fn() }));
jest.mock('../services/projectAuthorizationTransition', () => ({
  projectAuthorizationTransitionCoordinator: { recoverEmailTwoFactor },
  assertNoProjectAuthorizationTransitionActive,
}));

jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'totp-secret'),
  generateURI: jest.fn(() => 'otpauth://totp-secret'),
  verify: otpVerify,
  NobleCryptoPlugin: class NobleCryptoPlugin {},
  ScureBase32Plugin: class ScureBase32Plugin {},
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn(async () => 'data:image/png;base64,test') }));

jest.mock('../utils/auth-tracking', () => ({
  extractTrackingMetadata: jest.fn(() => ({
    ip: '127.0.0.1',
    rawUserAgent: 'jest-runtime-test',
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

jest.mock('../utils/errorLogger', () => ({
  logRequestError: jest.fn(async () => undefined),
}));

import authRouter from '../routes/auth';
import { AppError, errorHandler } from '../middleware/errorHandler';

type TestResponse = {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
};

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
};

async function request(
  server: http.Server,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const method = options.method || 'POST';
  const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        ...(body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': String(encoded.length),
        }),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: unknown = text;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            // Keep non-JSON bodies visible in an assertion failure.
          }
        }
        resolve({
          status: res.statusCode || 0,
          body: parsed,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    if (encoded.length) req.write(encoded);
    req.end();
  });
}

const baseUser = {
  id: 'user-1',
  email: 'owner@example.test',
  username: 'owner',
  passwordHash: 'bcrypt:opaque-current-password-hash',
  role: 'ADMIN',
  accountStatus: 'ACTIVE',
  isActive: true,
  sandboxEnabled: true,
  authorizationVersion: 7,
  twoFactorEnabled: true,
  twoFactorMethod: 'email',
  twoFactorSecret: null,
  twoFactorBackupCodes: null,
  twoFactorLastUsedStep: null,
};

const pendingToken = 'A'.repeat(43);

function setDomainMode(): void {
  process.env.ORIGIN_MODE = 'domain';
  delete process.env.INSTALL_PROFILE;
  process.env.CORS_ORIGIN = 'https://portal.example.test';
}

function setTailnetMode(origin = 'http://127.0.0.1'): void {
  process.env.ORIGIN_MODE = 'tailnet';
  delete process.env.INSTALL_PROFILE;
  process.env.CORS_ORIGIN = origin;
}

function setLocalMode(origin = 'http://127.0.0.1'): void {
  delete process.env.ORIGIN_MODE;
  process.env.INSTALL_PROFILE = 'local';
  process.env.CORS_ORIGIN = origin;
}

function configurePending(user: Record<string, any> = baseUser) {
  const pending = {
    id: 'challenge-1',
    userId: user.id,
    tokenHash: 'stored-challenge-digest',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    user,
  };
  challengeFindUnique.mockResolvedValue(pending);
  return pending;
}

function activeAuthorizationTransitionError(): Error & { code: string } {
  return Object.assign(new Error('authorization transition active'), {
    code: 'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE',
  });
}

function expectNoTwoFactorMutation(): void {
  expect(userUpdate).not.toHaveBeenCalled();
  expect(userUpdateMany).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(challengeCreate).not.toHaveBeenCalled();
  expect(challengeUpdateMany).not.toHaveBeenCalled();
  expect(emailCodeCreate).not.toHaveBeenCalled();
  expect(emailCodeUpdateMany).not.toHaveBeenCalled();
  expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
}

describe('private-origin Email Code 2FA runtime contract', () => {
  let server: http.Server;
  let consoleError: jest.SpyInstance;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setDomainMode();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    systemSettingFindUnique.mockResolvedValue(null);
    activityLogCreate.mockResolvedValue({});
    userFindFirst.mockResolvedValue({ id: 'user-1' });
    userUpdate.mockResolvedValue({});
    userUpdateMany.mockResolvedValue({ count: 1 });
    sessionCreate.mockResolvedValue({ id: 'session-new' });
    sessionDeleteMany.mockResolvedValue({ count: 0 });
    sessionFindMany.mockResolvedValue([]);
    sessionFindUnique.mockResolvedValue(null);
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    challengeCreate.mockResolvedValue({ id: 'challenge-1' });
    challengeUpdateMany.mockResolvedValue({ count: 1 });
    challengeDeleteMany.mockResolvedValue({ count: 0 });
    emailCodeCreate.mockResolvedValue({
      id: 'email-code-new',
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
    });
    emailCodeFindFirst.mockResolvedValue(null);
    emailCodeUpdateMany.mockResolvedValue({ count: 1 });
    emailCodeDeleteMany.mockResolvedValue({ count: 0 });
    passwordResetCreate.mockResolvedValue({ id: 'password-reset-new' });
    passwordResetUpdateMany.mockResolvedValue({ count: 0 });
    comparePassword.mockImplementation(async (value: string, hash: string) => (
      hash === baseUser.passwordHash
        ? value === 'CurrentPassword123!'
        : hash === `bcrypt:${value}`
    ));
    hashPassword.mockImplementation(async (value: string) => `bcrypt:${value}`);
    otpVerify.mockResolvedValue({ valid: false });
    sendTwoFactorCodeEmail.mockResolvedValue(undefined);
    sendTwoFactorEnabledEmail.mockResolvedValue(undefined);
    sendTwoFactorDisabledEmail.mockResolvedValue(undefined);
    generateAccessToken.mockReturnValue('access-token');
    generateRefreshToken.mockReturnValue('refresh-token');
    verifyRefreshToken.mockReturnValue(null);
    transaction.mockImplementation(async (callback: (tx: typeof transactionClient) => unknown) => (
      callback(transactionClient)
    ));
    recoverEmailTwoFactor.mockResolvedValue({
      user: { id: 'user-1', authorizationVersion: 8 },
      existing: { id: 'user-1', authorizationVersion: 7 },
      authorizationReasons: ['credential_recovery'],
    });
    assertNoProjectAuthorizationTransitionActive.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete process.env.ORIGIN_MODE;
    delete process.env.INSTALL_PROFILE;
    delete process.env.CORS_ORIGIN;
  });

  describe('refresh-token authorization admission', () => {
    const existingRefreshToken = 'existing-refresh-token';

    test.each(['PREPARED', 'COMMITTED'])(
      'returns a retryable conflict without clearing or rotating the cookie during %s',
      async (_phase) => {
        verifyRefreshToken.mockReturnValue({ userId: 'user-1' });
        assertNoProjectAuthorizationTransitionActive.mockRejectedValueOnce(
          activeAuthorizationTransitionError(),
        );

        const response = await request(server, '/auth/refresh', {
          refreshToken: existingRefreshToken,
        });

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          code: 'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE',
          retryable: true,
        });
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(sessionFindUnique).not.toHaveBeenCalled();
        expect(sessionUpdateMany).not.toHaveBeenCalled();
        expect(generateAccessToken).not.toHaveBeenCalled();
        expect(generateRefreshToken).not.toHaveBeenCalled();
      },
    );

    test('returns a retryable conflict without clearing or minting on Serializable commit conflict', async () => {
      verifyRefreshToken.mockReturnValue({ userId: 'user-1' });
      transaction.mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), {
        code: 'P2034',
      }));

      const response = await request(server, '/auth/refresh', {
        refreshToken: existingRefreshToken,
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'AUTHORIZATION_ARTIFACT_ADMISSION_CONFLICT',
        retryable: true,
      });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(sessionFindUnique).not.toHaveBeenCalled();
      expect(sessionUpdateMany).not.toHaveBeenCalled();
      expect(generateAccessToken).not.toHaveBeenCalled();
      expect(generateRefreshToken).not.toHaveBeenCalled();
    });

    test('preserves invalid-token cookie clearing without opening admission', async () => {
      verifyRefreshToken.mockReturnValue(null);

      const response = await request(server, '/auth/refresh', {
        refreshToken: existingRefreshToken,
      });

      expect(response.status).toBe(401);
      expect(transaction).not.toHaveBeenCalled();
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^accessToken=;/),
        expect.stringMatching(/^refreshToken=;/),
      ]));
      expect(generateAccessToken).not.toHaveBeenCalled();
      expect(generateRefreshToken).not.toHaveBeenCalled();
    });

    test('rotates from the current admitted user snapshot after the transition is COMPLETE', async () => {
      verifyRefreshToken.mockReturnValue({ userId: 'user-1' });
      const postTransitionUser = {
        ...baseUser,
        role: 'SUB_ADMIN',
        sandboxEnabled: false,
        authorizationVersion: 8,
      };
      sessionFindUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        user: postTransitionUser,
      });
      generateRefreshToken.mockReturnValue('rotated-refresh-token');
      generateAccessToken.mockReturnValue('rotated-access-token');

      const response = await request(server, '/auth/refresh', {
        refreshToken: existingRefreshToken,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ accessToken: 'rotated-access-token' });
      expect(assertNoProjectAuthorizationTransitionActive).toHaveBeenCalledWith(
        transactionClient,
      );
      expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          expiresAt: { gt: expect.any(Date) },
        }),
      }));
      expect(generateRefreshToken).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        role: 'SUB_ADMIN',
        accountStatus: 'ACTIVE',
        authorizationVersion: 8,
      }));
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^accessToken=rotated-access-token/),
        expect.stringMatching(/^refreshToken=rotated-refresh-token/),
      ]));
    });

    test('commits expired-session deletion before preserving the existing cookie-clear response', async () => {
      verifyRefreshToken.mockReturnValue({ userId: 'user-1' });
      sessionFindUnique.mockResolvedValue({
        id: 'session-expired',
        userId: 'user-1',
        expiresAt: new Date(Date.now() - 60_000),
        user: baseUser,
      });
      sessionDeleteMany.mockResolvedValueOnce({ count: 1 });

      const response = await request(server, '/auth/refresh', {
        refreshToken: existingRefreshToken,
      });

      expect(response.status).toBe(401);
      expect(sessionDeleteMany).toHaveBeenCalledWith({
        where: {
          id: 'session-expired',
          refreshTokenHash: expect.any(String),
        },
      });
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^accessToken=;/),
        expect.stringMatching(/^refreshToken=;/),
      ]));
      expect(generateAccessToken).not.toHaveBeenCalled();
      expect(generateRefreshToken).not.toHaveBeenCalled();
    });

    test('commits blocked-session deletion before preserving the existing forbidden response', async () => {
      verifyRefreshToken.mockReturnValue({ userId: 'user-1' });
      sessionFindUnique.mockResolvedValue({
        id: 'session-blocked',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          ...baseUser,
          accountStatus: 'PENDING',
          isActive: false,
        },
      });
      sessionDeleteMany.mockResolvedValueOnce({ count: 1 });

      const response = await request(server, '/auth/refresh', {
        refreshToken: existingRefreshToken,
      });

      expect(response.status).toBe(403);
      expect(sessionDeleteMany).toHaveBeenCalledWith({
        where: {
          id: 'session-blocked',
          refreshTokenHash: expect.any(String),
        },
      });
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^accessToken=;/),
        expect.stringMatching(/^refreshToken=;/),
      ]));
      expect(generateAccessToken).not.toHaveBeenCalled();
      expect(generateRefreshToken).not.toHaveBeenCalled();
    });

    test('commits the admitted replay-race outcome before clearing the stale cookie', async () => {
      verifyRefreshToken.mockReturnValue({ userId: 'user-1' });
      sessionFindUnique.mockResolvedValue({
        id: 'session-raced',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        user: baseUser,
      });
      sessionUpdateMany.mockResolvedValueOnce({ count: 0 });

      const response = await request(server, '/auth/refresh', {
        refreshToken: existingRefreshToken,
      });

      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^accessToken=;/),
        expect.stringMatching(/^refreshToken=;/),
      ]));
      expect(generateRefreshToken).not.toHaveBeenCalled();
      expect(generateAccessToken).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['tailnet', setTailnetMode],
    ['local', setLocalMode],
  ])('%s mode rejects every email-only setup/resend route before database or delivery work', async (
    _mode,
    configureMode,
  ) => {
    configureMode();
    const cases: Array<[string, unknown]> = [
      ['/auth/2fa/setup', { method: 'email' }],
      ['/auth/2fa/verify-setup', { method: 'email', token: '123456' }],
      ['/auth/2fa/send-email', { pendingToken }],
      ['/auth/2fa/send-email-authenticated', {}],
    ];

    for (const [path, body] of cases) {
      jest.clearAllMocks();
      const response = await request(server, path, body);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'PORTAL_FEATURE_UNAVAILABLE',
        feature: 'mail',
        retryable: false,
      });
      expect(userFindUnique).not.toHaveBeenCalled();
      expect(challengeFindUnique).not.toHaveBeenCalled();
      expect(emailCodeDeleteMany).not.toHaveBeenCalled();
      expectNoTwoFactorMutation();
    }
  });

  test('private mode preserves Authenticator App setup', async () => {
    setTailnetMode();
    userFindUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: false,
      twoFactorMethod: null,
      twoFactorBackupCodes: null,
    });

    const response = await request(server, '/auth/2fa/setup', { method: 'totp' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      method: 'totp',
      secret: 'totp-secret',
      qrCodeDataUrl: 'data:image/png;base64,test',
    });
    expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'user-1' }),
      data: expect.objectContaining({ twoFactorLastUsedStep: null }),
    }));
    expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
  });

  test('domain mode preserves Email Code setup and delivery', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: false,
      twoFactorMethod: null,
      twoFactorBackupCodes: null,
    });

    const response = await request(server, '/auth/2fa/setup', { method: 'email' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      method: 'email',
      message: expect.stringMatching(/sent/i),
    });
    expect(emailCodeCreate).toHaveBeenCalledTimes(1);
    expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
  });

  describe('login delivery truth', () => {
    function configureLoginUser(overrides: Record<string, unknown> = {}) {
      const user = { ...baseUser, ...overrides };
      userFindUnique.mockResolvedValue(user);
      return user;
    }

    test('reports sent only after delivery and retains a pending challenge', async () => {
      setDomainMode();
      configureLoginUser();

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({
        requiresTwoFactor: true,
        method: 'email',
        pendingToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        emailDelivery: {
          state: 'sent',
          message: expect.stringMatching(/sent/i),
        },
      });
      expect(challengeCreate).toHaveBeenCalledTimes(1);
      expect(challengeUpdateMany).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
    });

    test('reports unavailable without creating a code or discarding the pending challenge', async () => {
      setTailnetMode();
      configureLoginUser({ twoFactorBackupCodes: null });

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        requiresTwoFactor: true,
        emailDelivery: {
          state: 'unavailable',
          recoveryAvailable: true,
        },
      });
      expect(challengeCreate).toHaveBeenCalledTimes(1);
      expect(emailCodeCreate).not.toHaveBeenCalled();
      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('reports a sanitized delivery failure and deletes only the newly undelivered proof', async () => {
      setDomainMode();
      configureLoginUser();
      sendTwoFactorCodeEmail.mockRejectedValue(new Error('smtp://secret-host:2525 credential=private'));

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        requiresTwoFactor: true,
        emailDelivery: {
          state: 'failed',
          message: expect.stringMatching(/could not be delivered/i),
        },
      });
      expect(JSON.stringify(response.body)).not.toContain('secret-host');
      expect(challengeCreate).toHaveBeenCalledTimes(1);
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(emailCodeDeleteMany).toHaveBeenCalledTimes(2);
      expect(emailCodeDeleteMany).toHaveBeenNthCalledWith(1, {
        where: {
          userId: 'user-1',
          purpose: 'login:challenge-1',
          OR: [
            { createdAt: { lt: expect.any(Date) } },
            { usedAt: { not: null } },
          ],
        },
      });
      expect(emailCodeDeleteMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'email-code-new' },
      });
    });
  });

  describe('authorization-transition artifact admission', () => {
    test('ordinary login creates its session only after Serializable admission', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(200);
      expect(assertNoProjectAuthorizationTransitionActive).toHaveBeenCalledWith(transactionClient);
      expect(userUpdateMany).toHaveBeenCalledTimes(1);
      expect(sessionCreate).toHaveBeenCalledTimes(1);
      expect(assertNoProjectAuthorizationTransitionActive.mock.invocationCallOrder[0])
        .toBeLessThan(sessionCreate.mock.invocationCallOrder[0]);
      expect(transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    test('an active transition blocks ordinary login before session creation', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });
      assertNoProjectAuthorizationTransitionActive.mockRejectedValue(
        activeAuthorizationTransitionError(),
      );

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE',
        retryable: true,
      });
      expect(JSON.stringify(response.body)).not.toContain('access-token');
      expect(JSON.stringify(response.body)).not.toContain('refresh-token');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(userUpdateMany).not.toHaveBeenCalled();
    });

    test('a Serializable conflict after bearer preparation leaks no token or cookie', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });
      transaction.mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), {
        code: 'P2034',
      }));

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'AUTHORIZATION_ARTIFACT_ADMISSION_CONFLICT',
        retryable: true,
      });
      expect(generateAccessToken).toHaveBeenCalledTimes(1);
      expect(generateRefreshToken).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(response.body)).not.toContain('access-token');
      expect(JSON.stringify(response.body)).not.toContain('refresh-token');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(userUpdateMany).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('a stale ordinary-login snapshot loses its CAS without leaking prepared bearers', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        authorizationVersion: 8,
        twoFactorEnabled: false,
        twoFactorMethod: null,
      });
      userUpdateMany.mockResolvedValueOnce({ count: 0 });

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/state changed/i);
      expect(generateAccessToken).toHaveBeenCalledTimes(1);
      expect(generateRefreshToken).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(response.body)).not.toContain('access-token');
      expect(JSON.stringify(response.body)).not.toContain('refresh-token');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: 'user-1',
          authorizationVersion: 8,
        }),
      }));
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('an active transition blocks pending-challenge creation', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue(baseUser);
      assertNoProjectAuthorizationTransitionActive.mockRejectedValue(
        activeAuthorizationTransitionError(),
      );

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE',
        retryable: true,
      });
      expect(response.body).not.toHaveProperty('pendingToken');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(challengeCreate).not.toHaveBeenCalled();
      expect(emailCodeCreate).not.toHaveBeenCalled();
      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('a stale credential snapshot cannot create or disclose a pending challenge', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue(baseUser);
      userFindFirst.mockResolvedValueOnce(null);

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/credential state changed/i);
      expect(response.body).not.toHaveProperty('pendingToken');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(challengeCreate).not.toHaveBeenCalled();
      expect(emailCodeCreate).not.toHaveBeenCalled();
      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('a transition beginning after challenge admission blocks email-code issuance', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue(baseUser);
      assertNoProjectAuthorizationTransitionActive
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(activeAuthorizationTransitionError());

      const response = await request(server, '/auth/login', {
        email: baseUser.email,
        password: 'CurrentPassword123!',
      });

      expect(response.status).toBe(409);
      expect(challengeCreate).toHaveBeenCalledTimes(1);
      expect(emailCodeCreate).not.toHaveBeenCalled();
      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenNthCalledWith(
        1,
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
      expect(transaction).toHaveBeenNthCalledWith(
        2,
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    test('an active transition blocks explicit email-code issuance', async () => {
      setDomainMode();
      configurePending();
      assertNoProjectAuthorizationTransitionActive.mockRejectedValue(
        activeAuthorizationTransitionError(),
      );

      const response = await request(server, '/auth/2fa/send-email', { pendingToken });

      expect(response.status).toBe(409);
      expect(emailCodeCreate).not.toHaveBeenCalled();
      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
    });

    test('an active transition blocks 2FA completion before proof consumption or session creation', async () => {
      setTailnetMode();
      const storedBackupCodes = JSON.stringify(['bcrypt:BACKUP01']);
      configurePending({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });
      assertNoProjectAuthorizationTransitionActive.mockRejectedValue(
        activeAuthorizationTransitionError(),
      );

      const response = await request(server, '/auth/2fa/validate', {
        pendingToken,
        token: 'BACKUP01',
      });

      expect(response.status).toBe(409);
      expect(challengeUpdateMany).not.toHaveBeenCalled();
      expect(emailCodeUpdateMany).not.toHaveBeenCalled();
      expect(userUpdateMany).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('a stale authenticated generation cannot disclose a generated TOTP setup secret', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        authorizationVersion: 8,
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorBackupCodes: null,
      });
      userUpdateMany.mockResolvedValueOnce({ count: 0 });

      const response = await request(server, '/auth/2fa/setup', { method: 'totp' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/state changed/i);
      expect(response.body).not.toHaveProperty('secret');
      expect(response.body).not.toHaveProperty('qrCodeDataUrl');
      expect(JSON.stringify(response.body)).not.toContain('totp-secret');
      expect(JSON.stringify(response.body)).not.toContain('otpauth://');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: 'user-1',
          authorizationVersion: 7,
        }),
      }));
    });

    test('a Serializable conflict after backup-code generation discloses no code or cookie', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorMethod: 'totp',
        twoFactorSecret: 'totp-secret',
        twoFactorLastUsedStep: 10,
      });
      otpVerify.mockResolvedValue({ valid: true, timeStep: 11 });
      transaction.mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), {
        code: 'P2034',
      }));

      const response = await request(
        server,
        '/auth/2fa/regenerate-backup-codes',
        { token: '123456' },
      );

      const generatedCodes = hashPassword.mock.calls.map(([code]) => String(code));
      expect(generatedCodes.length).toBeGreaterThan(0);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'AUTHORIZATION_ARTIFACT_ADMISSION_CONFLICT',
        retryable: true,
      });
      expect(response.body).not.toHaveProperty('backupCodes');
      for (const code of generatedCodes) {
        expect(JSON.stringify(response.body)).not.toContain(code);
      }
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(userUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('private-mode backup-code disable', () => {
    const storedBackupCodes = JSON.stringify(['bcrypt:ABCD1234']);

    test('accepts a valid backup code and CASes the exact stored backup-code blob', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });

      const response = await request(server, '/auth/2fa/disable', { token: 'ABCD1234' });

      expect(response.status).toBe(200);
      expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: 'user-1',
          twoFactorEnabled: true,
          twoFactorMethod: 'email',
          twoFactorBackupCodes: storedBackupCodes,
        }),
        data: expect.objectContaining({
          twoFactorEnabled: false,
          twoFactorBackupCodes: null,
        }),
      }));
      expect(emailCodeFindFirst).not.toHaveBeenCalled();
      expect(challengeDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });

    test('rejects a wrong backup code without opening a transaction', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });

      const response = await request(server, '/auth/2fa/disable', { token: 'WRONG123' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/invalid backup code/i);
      expect(transaction).not.toHaveBeenCalled();
      expect(userUpdateMany).not.toHaveBeenCalled();
    });

    test('losing the exact-state CAS returns 409 and performs no cleanup', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });
      userUpdateMany.mockResolvedValue({ count: 0 });

      const response = await request(server, '/auth/2fa/disable', { token: 'ABCD1234' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/state changed/i);
      expect(emailCodeDeleteMany).not.toHaveBeenCalled();
      expect(challengeDeleteMany).not.toHaveBeenCalled();
    });

    test('two concurrent disables with the same backup code produce one cleanup commit', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });
      let stateAvailable = true;
      userUpdateMany.mockImplementation(async () => {
        if (!stateAvailable) return { count: 0 };
        stateAvailable = false;
        return { count: 1 };
      });

      const responses = await Promise.all([
        request(server, '/auth/2fa/disable', { token: 'ABCD1234' }),
        request(server, '/auth/2fa/disable', { token: 'ABCD1234' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(emailCodeDeleteMany).toHaveBeenCalledTimes(1);
      expect(challengeDeleteMany).toHaveBeenCalledTimes(1);
      expect(activityLogCreate).toHaveBeenCalledTimes(1);
    });

    test('domain Email Code disable still consumes a reauthentication proof', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });
      emailCodeFindFirst.mockResolvedValue({
        id: 'reauth-code',
        code: 'bcrypt:123456',
        userId: 'user-1',
        purpose: 'reauth',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const response = await request(server, '/auth/2fa/disable', { token: '123456' });

      expect(response.status).toBe(200);
      expect(emailCodeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'reauth-code', purpose: 'reauth' }),
      }));
      expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ twoFactorBackupCodes: storedBackupCodes }),
      }));
    });

    test('private mode leaves TOTP disable on the TOTP proof path', async () => {
      setTailnetMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorMethod: 'totp',
        twoFactorSecret: 'totp-secret',
        twoFactorLastUsedStep: 10,
      });
      otpVerify.mockResolvedValue({ valid: true, timeStep: 11 });

      const response = await request(server, '/auth/2fa/disable', { token: '123456' });

      expect(response.status).toBe(200);
      expect(otpVerify).toHaveBeenCalledTimes(1);
      expect(emailCodeFindFirst).not.toHaveBeenCalled();
      expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { twoFactorLastUsedStep: null },
            { twoFactorLastUsedStep: { lt: 11 } },
          ],
        }),
      }));
    });

    test('email-method backup regeneration gives Authenticator App guidance without mutation', async () => {
      setDomainMode();
      userFindUnique.mockResolvedValue({
        ...baseUser,
        twoFactorBackupCodes: storedBackupCodes,
      });

      const response = await request(
        server,
        '/auth/2fa/regenerate-backup-codes',
        { token: '123456' },
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Authenticator App/i);
      expect(otpVerify).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(userUpdate).not.toHaveBeenCalled();
      expect(userUpdateMany).not.toHaveBeenCalled();
    });
  });

  test('unavailable-mail login still atomically consumes a backup code', async () => {
    setTailnetMode();
    const storedBackupCodes = JSON.stringify([
      'bcrypt:BACKUP01',
      'bcrypt:OTHER002',
    ]);
    const pending = configurePending({
      ...baseUser,
      twoFactorBackupCodes: storedBackupCodes,
    });

    const response = await request(server, '/auth/2fa/validate', {
      pendingToken,
      token: 'BACKUP01',
    });

    expect(response.status).toBe(200);
    expect(challengeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: pending.id,
        tokenHash: pending.tokenHash,
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date) },
    });
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'user-1',
        twoFactorEnabled: true,
        twoFactorMethod: 'email',
        twoFactorBackupCodes: storedBackupCodes,
      }),
      data: expect.objectContaining({
        twoFactorBackupCodes: JSON.stringify(['bcrypt:OTHER002']),
        lastLoginAt: expect.any(Date),
      }),
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(emailCodeUpdateMany).not.toHaveBeenCalled();
  });

  describe('last-resort Email Code recovery', () => {
    const recoveryBody = {
      pendingToken,
      currentPassword: 'CurrentPassword123!',
      confirmation: 'DISABLE EMAIL 2FA',
    };

    function localOriginHeaders() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server is not listening');
      const origin = `http://localhost:${address.port}`;
      setLocalMode(origin);
      return { host: `localhost:${address.port}` };
    }

    function tailnetOriginHeaders() {
      const origin = 'https://portal.example-tailnet.ts.net';
      setTailnetMode(origin);
      return {
        host: 'portal.example-tailnet.ts.net',
        'x-forwarded-proto': 'https',
      };
    }

    test('rejects domain mode, non-POST calls, and stale public hosts before challenge lookup', async () => {
      setDomainMode();
      const domain = await request(server, '/auth/2fa/recover-email', recoveryBody);
      expect(domain.status).toBe(409);
      expect(domain.body).toMatchObject({
        code: 'EMAIL_2FA_RECOVERY_NOT_AVAILABLE',
        retryable: false,
      });
      expect(challengeFindUnique).not.toHaveBeenCalled();

      jest.clearAllMocks();
      const headers = localOriginHeaders();
      const wrongMethod = await request(
        server,
        '/auth/2fa/recover-email',
        undefined,
        { method: 'GET', headers },
      );
      expect(wrongMethod.status).toBe(404);
      expect(challengeFindUnique).not.toHaveBeenCalled();

      jest.clearAllMocks();
      setTailnetMode('https://portal.example-tailnet.ts.net');
      const stalePublicHost = await request(server, '/auth/2fa/recover-email', recoveryBody, {
        headers: {
          host: 'old-public.example.test',
          'x-forwarded-proto': 'https',
        },
      });
      expect(stalePublicHost.status).toBe(403);
      expect(challengeFindUnique).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    test.each([
      [{ ...recoveryBody, confirmation: 'disable email 2fa' }, 'wrong confirmation'],
      [{ ...recoveryBody, extra: true }, 'extra field'],
      [{ ...recoveryBody, pendingToken: 'short' }, 'malformed pending token'],
    ])('strictly rejects %s before challenge or transaction work (%s)', async (body, _label) => {
      const headers = localOriginHeaders();

      const response = await request(server, '/auth/2fa/recover-email', body, { headers });

      expect(response.status).toBe(400);
      expect(challengeFindUnique).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    test('does not disclose backup eligibility until the second password succeeds', async () => {
      const headers = localOriginHeaders();
      configurePending({
        ...baseUser,
        twoFactorBackupCodes: JSON.stringify(['bcrypt:BACKUP01']),
      });

      const wrongPassword = await request(server, '/auth/2fa/recover-email', {
        ...recoveryBody,
        currentPassword: 'wrong-password',
      }, { headers });
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.body.error).toMatch(/recovery is unavailable/i);
      expect(wrongPassword.body.error).not.toMatch(/backup/i);
      expect(transaction).not.toHaveBeenCalled();

      const correctPassword = await request(
        server,
        '/auth/2fa/recover-email',
        recoveryBody,
        { headers },
      );
      expect(correctPassword.status).toBe(409);
      expect(correctPassword.body.error).toMatch(/backup code is still available/i);
      expect(transaction).not.toHaveBeenCalled();
    });

    test.each([
      ['totp method', { twoFactorMethod: 'totp', twoFactorBackupCodes: null }],
      ['disabled 2FA', { twoFactorEnabled: false, twoFactorBackupCodes: null }],
      ['inactive account', { isActive: false, twoFactorBackupCodes: null }],
    ])('rejects ineligible account state: %s', async (_label, overrides) => {
      const headers = localOriginHeaders();
      configurePending({ ...baseUser, ...overrides });

      const response = await request(server, '/auth/2fa/recover-email', recoveryBody, { headers });

      expect(response.status).toBe(401);
      expect(comparePassword).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    test.each([
      '',
      '{malformed',
      JSON.stringify({ code: 'bcrypt:BACKUP01' }),
      JSON.stringify(['bcrypt:BACKUP01', 7]),
      JSON.stringify(['bcrypt:BACKUP01']),
    ])('fails closed for non-eligible stored backup state %j', async (storedBackupState) => {
      const headers = localOriginHeaders();
      configurePending({
        ...baseUser,
        twoFactorBackupCodes: storedBackupState,
      });

      const response = await request(server, '/auth/2fa/recover-email', recoveryBody, { headers });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/backup code is still available/i);
      expect(transaction).not.toHaveBeenCalled();
    });

    test('delegates revocation to the durable authorization transition before clearing cookies', async () => {
      const headers = localOriginHeaders();
      const pending = configurePending({
        ...baseUser,
        twoFactorBackupCodes: JSON.stringify([]),
      });

      const response = await request(server, '/auth/2fa/recover-email', recoveryBody, { headers });

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({
        success: true,
        code: 'EMAIL_2FA_RECOVERED',
        requiresFreshLogin: true,
      });
      expect(recoverEmailTwoFactor).toHaveBeenCalledWith({
        targetUserId: 'user-1',
        challengeId: pending.id,
        challengeTokenHash: pending.tokenHash,
        expectedPasswordHash: baseUser.passwordHash,
        expectedBackupCodes: JSON.stringify([]),
        ipAddress: '127.0.0.1',
        userAgent: null,
      });
      expect(transaction).not.toHaveBeenCalled();
      const auditPayload = JSON.stringify(recoverEmailTwoFactor.mock.calls.at(-1)?.[0]);
      expect(auditPayload).not.toContain(recoveryBody.currentPassword);
      expect(auditPayload).not.toContain(recoveryBody.pendingToken);
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toEqual(expect.arrayContaining([
        expect.stringMatching(/^accessToken=;/),
        expect.stringMatching(/^refreshToken=;/),
      ]));
      expect(generateAccessToken).not.toHaveBeenCalled();
      expect(generateRefreshToken).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('does not clear cookies when the durable transition fails', async () => {
      const headers = localOriginHeaders();
      configurePending({
        ...baseUser,
        twoFactorBackupCodes: JSON.stringify([]),
      });
      recoverEmailTwoFactor.mockRejectedValueOnce(new Error('audit unavailable'));

      const response = await request(server, '/auth/2fa/recover-email', recoveryBody, { headers });

      expect(response.status).toBe(500);
      expect(recoverEmailTwoFactor).toHaveBeenCalledTimes(1);
      expect(transaction).not.toHaveBeenCalled();
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(generateAccessToken).not.toHaveBeenCalled();
      expect(generateRefreshToken).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    test('two racing recoveries rely on the durable singleton for one winner', async () => {
      const headers = tailnetOriginHeaders();
      configurePending({ ...baseUser, twoFactorBackupCodes: null });
      let transitionAvailable = true;
      recoverEmailTwoFactor.mockImplementation(async () => {
        if (!transitionAvailable) {
          throw new AppError(409, 'Recovery state changed. Please sign in again.');
        }
        transitionAvailable = false;
        return {
          user: { id: 'user-1', authorizationVersion: 8 },
          existing: { id: 'user-1', authorizationVersion: 7 },
          authorizationReasons: ['credential_recovery'],
        };
      });

      const responses = await Promise.all([
        request(server, '/auth/2fa/recover-email', recoveryBody, { headers }),
        request(server, '/auth/2fa/recover-email', recoveryBody, { headers }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(recoverEmailTwoFactor).toHaveBeenCalledTimes(2);
      expect(transaction).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });
  });
});
