import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const userFindUnique = jest.fn();
const userFindFirst = jest.fn();
const userCreate = jest.fn();
const userUpdate = jest.fn();
const userUpdateMany = jest.fn();
const registrationRequestFindUnique = jest.fn();
const registrationRequestUpdateMany = jest.fn();
const systemSettingFindUnique = jest.fn();
const passwordResetTokenCreate = jest.fn();
const passwordResetTokenDelete = jest.fn();
const passwordResetTokenDeleteMany = jest.fn();
const passwordResetTokenFindUnique = jest.fn();
const passwordResetTokenUpdateMany = jest.fn();
const sessionDeleteMany = jest.fn();
const twoFactorChallengeDeleteMany = jest.fn();
const emailVerificationCodeDeleteMany = jest.fn();
const activityLogCreate = jest.fn();
const projectAuthorizationTransitionFindFirst = jest.fn();
const transaction = jest.fn();

const hashPassword = jest.fn();
const sendPasswordResetEmail = jest.fn();
const sendPasswordChangedEmail = jest.fn();
const provisionUserMailbox = jest.fn();
const extractTrackingMetadata = jest.fn();
const publishAuthorizationChanged = jest.fn();

const transactionClient = {
  registrationRequest: {
    findUnique: registrationRequestFindUnique,
    updateMany: registrationRequestUpdateMany,
  },
  user: {
    findFirst: userFindFirst,
    findUnique: userFindUnique,
    create: userCreate,
    update: userUpdate,
    updateMany: userUpdateMany,
  },
  passwordResetToken: {
    create: passwordResetTokenCreate,
    updateMany: passwordResetTokenUpdateMany,
  },
  session: {
    deleteMany: sessionDeleteMany,
  },
  twoFactorChallenge: {
    deleteMany: twoFactorChallengeDeleteMany,
  },
  emailVerificationCode: {
    deleteMany: emailVerificationCodeDeleteMany,
  },
  projectAuthorizationTransition: {
    findFirst: projectAuthorizationTransitionFindFirst,
  },
};

jest.mock('../config/database', () => ({
  prisma: {
    user: {
      findFirst: userFindFirst,
      findUnique: userFindUnique,
      create: userCreate,
      update: userUpdate,
      updateMany: userUpdateMany,
    },
    registrationRequest: {
      findUnique: registrationRequestFindUnique,
      updateMany: registrationRequestUpdateMany,
    },
    systemSetting: {
      findUnique: systemSettingFindUnique,
    },
    passwordResetToken: {
      create: passwordResetTokenCreate,
      delete: passwordResetTokenDelete,
      deleteMany: passwordResetTokenDeleteMany,
      findUnique: passwordResetTokenFindUnique,
      updateMany: passwordResetTokenUpdateMany,
    },
    session: {
      deleteMany: sessionDeleteMany,
    },
    twoFactorChallenge: {
      deleteMany: twoFactorChallengeDeleteMany,
    },
    emailVerificationCode: {
      deleteMany: emailVerificationCodeDeleteMany,
    },
    activityLog: {
      create: activityLogCreate,
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

jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'owner-user',
      email: 'owner@example.test',
      role: 'OWNER',
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

jest.mock('../middleware/requireAdmin', () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireOwner: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../utils/password', () => ({
  hashPassword,
  comparePassword: jest.fn(),
  validatePasswordStrength: jest.fn(() => ({ valid: true, errors: [] })),
}));

jest.mock('../utils/jwt', () => ({
  generateAccessToken: jest.fn(),
  generateRefreshToken: jest.fn(),
  verifyAccessToken: jest.fn(),
  verifyRefreshToken: jest.fn(),
}));

jest.mock('../services/email', () => ({
  sendNewUserAlert: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  sendWelcomeEmail: jest.fn(),
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendLoginAlertEmail: jest.fn(),
  sendTwoFactorEnabledEmail: jest.fn(),
  sendTwoFactorDisabledEmail: jest.fn(),
  sendTwoFactorCodeEmail: jest.fn(),
}));

jest.mock('../services/userMailService', () => ({
  provisionUserMailbox,
  deleteUserMailbox: jest.fn(),
  deleteUserMailboxByUserId: jest.fn(),
  getProvisionedMailboxes: jest.fn(),
}));

jest.mock('../services/mailService', () => ({
  sendEmail: jest.fn(),
}));

jest.mock('../services/mailboxReconciliation', () => ({
  enqueueMailboxReconciliation: jest.fn(),
  drainMailboxReconciliation: jest.fn(),
}));

jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/portal-test-avatars',
  BRANDING_DIR: '/tmp/portal-test-branding',
  createImageUpload: jest.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
  parseCropParams: jest.fn(),
  processImageToTarget: jest.fn(),
  cleanupBasenameVariants: jest.fn(),
  cleanupBasenamePrefixVariants: jest.fn(),
  cleanupFile: jest.fn(),
}));

jest.mock('../utils/auth-tracking', () => ({
  extractTrackingMetadata,
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

jest.mock('../services/authorizationChangeBus', () => ({
  publishAuthorizationChanged,
}));

jest.mock('../services/workspaceAuthorizationBarrier', () => ({
  withWorkspaceAuthorizationFence: jest.fn(
    async (_userId: string, operation: () => unknown) => operation(),
  ),
  withGlobalWorkspaceAuthorizationFence: jest.fn(
    async (operation: () => unknown) => operation(),
  ),
}));

jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'totp-secret'),
  generateURI: jest.fn(() => 'otpauth://totp-secret'),
  verify: jest.fn(),
  NobleCryptoPlugin: class NobleCryptoPlugin {},
  ScureBase32Plugin: class ScureBase32Plugin {},
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(async () => 'data:image/png;base64,test'),
}));

import authRouter from '../routes/auth';
import adminRouter from '../routes/admin';
import { errorHandler } from '../middleware/errorHandler';

type TestResponse = {
  status: number;
  body: any;
};

async function request(
  server: http.Server,
  requestPath: string,
  body?: unknown,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: requestPath,
      headers: body === undefined
        ? {}
        : {
            'content-type': 'application/json',
            'content-length': String(encoded.length),
          },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 0,
          body: text ? JSON.parse(text) : {},
        });
      });
    });
    req.on('error', reject);
    if (encoded.length) req.write(encoded);
    req.end();
  });
}

function setDomainMode(): void {
  process.env.ORIGIN_MODE = 'domain';
  delete process.env.INSTALL_PROFILE;
  process.env.CORS_ORIGIN = 'https://portal.example.test';
}

function setTailnetMode(): void {
  process.env.ORIGIN_MODE = 'tailnet';
  delete process.env.INSTALL_PROFILE;
  process.env.CORS_ORIGIN = 'https://portal.example-tailnet.ts.net';
}

function setLocalMode(): void {
  delete process.env.ORIGIN_MODE;
  process.env.INSTALL_PROFILE = 'local';
  process.env.CORS_ORIGIN = 'http://127.0.0.1';
}

const pendingRegistration = {
  id: 'registration-request-1',
  email: 'new-user@example.test',
  name: 'Example User',
  passwordHash: 'stored-registration-password-hash',
  status: 'PENDING',
};

describe('password recovery and registration approval delivery truth', () => {
  let server: http.Server;
  let consoleError: jest.SpyInstance;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use('/admin', adminRouter);
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

    extractTrackingMetadata.mockReturnValue({
      ip: '127.0.0.1',
      rawUserAgent: 'jest-runtime-test',
      geo: { summary: 'test' },
      device: { summary: 'test' },
    });
    hashPassword.mockImplementation(async (value: string) => `hash:${value}`);
    activityLogCreate.mockResolvedValue({});
    systemSettingFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    userFindFirst.mockResolvedValue({ id: 'recovery-user' });
    userCreate.mockResolvedValue({
      id: 'approved-user-1',
      username: 'exampleuser',
      email: pendingRegistration.email,
    });
    userUpdate.mockResolvedValue({});
    userUpdateMany.mockResolvedValue({ count: 1 });
    registrationRequestFindUnique.mockResolvedValue(pendingRegistration);
    registrationRequestUpdateMany.mockResolvedValue({ count: 1 });
    passwordResetTokenCreate.mockResolvedValue({ id: 'reset-token-new' });
    passwordResetTokenDelete.mockResolvedValue({ id: 'reset-token-new' });
    passwordResetTokenDeleteMany.mockResolvedValue({ count: 0 });
    passwordResetTokenUpdateMany.mockResolvedValue({ count: 1 });
    sessionDeleteMany.mockResolvedValue({ count: 1 });
    twoFactorChallengeDeleteMany.mockResolvedValue({ count: 1 });
    emailVerificationCodeDeleteMany.mockResolvedValue({ count: 1 });
    projectAuthorizationTransitionFindFirst.mockResolvedValue(null);
    sendPasswordResetEmail.mockResolvedValue(undefined);
    sendPasswordChangedEmail.mockResolvedValue(undefined);
    provisionUserMailbox.mockResolvedValue(undefined);
    transaction.mockImplementation(
      async (operation: (tx: typeof transactionClient) => unknown) => operation(transactionClient),
    );
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete process.env.ORIGIN_MODE;
    delete process.env.INSTALL_PROFILE;
    delete process.env.CORS_ORIGIN;
  });

  test.each([
    ['tailnet', setTailnetMode],
    ['local', setLocalMode],
  ])('%s forgot-password returns generic success before identity or token work', async (
    _mode,
    configureMode,
  ) => {
    configureMode();

    const response = await request(server, '/auth/forgot-password', {
      email: 'not-an-email',
    });

    expect(response).toEqual({
      status: 200,
      body: {
        message: 'If an account exists with that email, you will receive a password reset link.',
      },
    });
    expect(extractTrackingMetadata).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(passwordResetTokenDelete).not.toHaveBeenCalled();
    expect(passwordResetTokenDeleteMany).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  test('domain forgot-password preserves delivery and retires only older links after success', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      id: 'recovery-user',
      email: 'recovery@example.test',
    });

    const response = await request(server, '/auth/forgot-password', {
      email: 'recovery@example.test',
    });

    expect(response.status).toBe(200);
    expect(passwordResetTokenCreate).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(passwordResetTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'recovery-user',
        usedAt: null,
        id: { not: 'reset-token-new' },
      },
    });
    expect(passwordResetTokenDelete).not.toHaveBeenCalled();
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  test('forgot-password preserves enumeration semantics while a transition blocks token creation', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      id: 'recovery-user',
      email: 'recovery@example.test',
    });
    projectAuthorizationTransitionFindFirst.mockResolvedValue({
      id: 'credential-recovery-transition',
    });

    const response = await request(server, '/auth/forgot-password', {
      email: 'recovery@example.test',
    });

    expect(response).toEqual({
      status: 200,
      body: {
        message: 'If an account exists with that email, you will receive a password reset link.',
      },
    });
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
  });

  test('forgot-password also preserves enumeration semantics when SSI aborts the artifact writer', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      id: 'recovery-user',
      email: 'recovery@example.test',
    });
    transaction.mockRejectedValue(Object.assign(new Error('transaction write conflict'), {
      code: 'P2034',
    }));

    const response = await request(server, '/auth/forgot-password', {
      email: 'recovery@example.test',
    });

    expect(response).toEqual({
      status: 200,
      body: {
        message: 'If an account exists with that email, you will receive a password reset link.',
      },
    });
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  test('domain forgot-password removes only a newly undelivered token', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      id: 'recovery-user',
      email: 'recovery@example.test',
    });
    sendPasswordResetEmail.mockRejectedValue(new Error('mail delivery failed'));

    const response = await request(server, '/auth/forgot-password', {
      email: 'recovery@example.test',
    });

    expect(response.status).toBe(200);
    expect(passwordResetTokenDelete).toHaveBeenCalledWith({
      where: { id: 'reset-token-new' },
    });
    expect(passwordResetTokenDeleteMany).not.toHaveBeenCalled();
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  test('domain forgot-password keeps the delivered token valid when old-token cleanup fails', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      id: 'recovery-user',
      email: 'recovery@example.test',
    });
    passwordResetTokenDeleteMany.mockRejectedValue(new Error('cleanup unavailable'));

    const response = await request(server, '/auth/forgot-password', {
      email: 'recovery@example.test',
    });

    expect(response.status).toBe(200);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(passwordResetTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'recovery-user',
        usedAt: null,
        id: { not: 'reset-token-new' },
      },
    });
    expect(passwordResetTokenDelete).not.toHaveBeenCalled();
    expect(activityLogCreate).toHaveBeenCalledTimes(1);
  });

  test('an already-issued reset token remains usable in private mode', async () => {
    setTailnetMode();
    passwordResetTokenFindUnique.mockResolvedValue({
      id: 'existing-reset-token',
      userId: 'recovery-user',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'recovery-user',
        email: 'recovery@example.test',
        username: 'recovery-user',
        firstName: null,
        lastName: null,
        passwordHash: 'stored-password-hash',
        role: 'USER',
        accountStatus: 'ACTIVE',
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: 4,
      },
    });

    const response = await request(server, '/auth/reset-password', {
      token: 'already-issued-token',
      newPassword: 'NewPassword123!',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true });
    expect(passwordResetTokenFindUnique).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(passwordResetTokenUpdateMany).toHaveBeenCalledTimes(2);
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'recovery-user',
        passwordHash: 'stored-password-hash',
        authorizationVersion: 4,
      }),
      data: {
        passwordHash: 'hash:NewPassword123!',
        authorizationVersion: { increment: 1 },
      },
    });
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: 'recovery-user' } });
    expect(twoFactorChallengeDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'recovery-user' },
    });
    expect(emailVerificationCodeDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'recovery-user' },
    });
  });

  test.each([
    ['tailnet', setTailnetMode, /private Tailnet mode/i],
    ['local', setLocalMode, /local mode/i],
  ])('%s approval creates no reset token and requires manual notification', async (
    _mode,
    configureMode,
    reasonPattern,
  ) => {
    configureMode();

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      notification: {
        state: 'manual_required',
        delivered: false,
        manualNotificationRequired: true,
        reason: expect.stringMatching(reasonPattern),
      },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(provisionUserMailbox).not.toHaveBeenCalled();
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(passwordResetTokenDelete).not.toHaveBeenCalled();
    expect(passwordResetTokenDeleteMany).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(systemSettingFindUnique).toHaveBeenCalledTimes(1);
    expect(systemSettingFindUnique).toHaveBeenCalledWith({
      where: { key: 'security.sandboxDefaultEnabled' },
    });
  });

  test.each([
    ['tailnet', setTailnetMode],
    ['local', setLocalMode],
  ])('%s rejects a legacy passwordless request before approval mutation', async (
    _mode,
    configureMode,
  ) => {
    configureMode();
    registrationRequestFindUnique.mockResolvedValue({
      ...pendingRegistration,
      passwordHash: null,
    });

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'This registration request does not contain a sign-in password. Deny it and ask the applicant to submit a new request before approving it in private mode.',
        code: 'REGISTRATION_PRIVATE_PASSWORD_REQUIRED',
        retryable: false,
        action: 'deny_and_resubmit',
      },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(registrationRequestUpdateMany).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
    expect(systemSettingFindUnique).not.toHaveBeenCalled();
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('private approval rechecks the password invariant inside its transaction', async () => {
    setTailnetMode();
    registrationRequestFindUnique
      .mockResolvedValueOnce(pendingRegistration)
      .mockResolvedValueOnce({
        ...pendingRegistration,
        passwordHash: null,
      });

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'REGISTRATION_PRIVATE_PASSWORD_REQUIRED',
      retryable: false,
      action: 'deny_and_resubmit',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(registrationRequestUpdateMany).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('domain approval reports delivery and retires older links only after success', async () => {
    setDomainMode();

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      notification: {
        state: 'sent',
        delivered: true,
        manualNotificationRequired: false,
        reason: null,
      },
    });
    expect(provisionUserMailbox).toHaveBeenCalledWith(
      'exampleuser',
      'approved-user-1',
      { makePrimary: true },
    );
    expect(passwordResetTokenCreate).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(passwordResetTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'approved-user-1',
        usedAt: null,
        id: { not: 'reset-token-new' },
      },
    });
    expect(passwordResetTokenDelete).not.toHaveBeenCalled();
  });

  test('a transition starting after approval blocks the notification bearer without undoing approval', async () => {
    setDomainMode();
    projectAuthorizationTransitionFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'credential-recovery-transition' });

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      notification: {
        state: 'failed',
        delivered: false,
        manualNotificationRequired: true,
        reason: 'The approval email could not be prepared. Notify the user directly.',
      },
    });
    expect(registrationRequestUpdateMany).toHaveBeenCalledTimes(1);
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
  });

  test('reactivating an existing pending user retires every dormant credential before issuing one new link', async () => {
    setDomainMode();
    userFindUnique.mockResolvedValue({
      id: 'existing-pending-user',
      username: 'existinguser',
      email: pendingRegistration.email,
      role: 'USER',
      accountStatus: 'PENDING',
      isActive: false,
      authorizationVersion: 7,
    });
    userUpdate.mockResolvedValue({
      id: 'existing-pending-user',
      username: 'existinguser',
      email: pendingRegistration.email,
      role: 'USER',
      accountStatus: 'ACTIVE',
      isActive: true,
      authorizationVersion: 8,
    });

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(userCreate).not.toHaveBeenCalled();
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'existing-pending-user' },
      data: expect.objectContaining({
        accountStatus: 'ACTIVE',
        isActive: true,
        authorizationVersion: { increment: 1 },
      }),
    });
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'existing-pending-user' },
    });
    expect(twoFactorChallengeDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'existing-pending-user' },
    });
    expect(emailVerificationCodeDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'existing-pending-user' },
    });
    expect(passwordResetTokenUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'existing-pending-user', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(publishAuthorizationChanged).toHaveBeenCalledWith({
      type: 'authorization_changed',
      userId: 'existing-pending-user',
      authorizationVersion: 8,
      reasons: ['account_status', 'active_status'],
    });
    expect(passwordResetTokenCreate).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  test('domain approval respects a disabled notification without creating a bearer', async () => {
    setDomainMode();
    systemSettingFindUnique.mockImplementation(async ({ where }: any) => (
      where.key === 'notifications.userApproved' ? { value: 'false' } : null
    ));

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      notification: {
        state: 'disabled',
        delivered: false,
        manualNotificationRequired: false,
        reason: null,
      },
    });
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(passwordResetTokenDelete).not.toHaveBeenCalled();
    expect(passwordResetTokenDeleteMany).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('domain delivery failure deletes only the newly undelivered approval token', async () => {
    setDomainMode();
    sendPasswordResetEmail.mockRejectedValue(
      new Error('smtp://private.example.test credential=do-not-return'),
    );

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      notification: {
        state: 'failed',
        delivered: false,
        manualNotificationRequired: true,
        reason: 'The approval email could not be delivered. Notify the user directly.',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('do-not-return');
    expect(passwordResetTokenDelete).toHaveBeenCalledTimes(1);
    expect(passwordResetTokenDelete).toHaveBeenCalledWith({
      where: { id: 'reset-token-new' },
    });
    expect(passwordResetTokenDeleteMany).not.toHaveBeenCalled();
  });

  test('approval stays successful but reports unverified cleanup after its commit', async () => {
    setDomainMode();
    sendPasswordResetEmail.mockRejectedValue(new Error('delivery unavailable'));
    passwordResetTokenDelete.mockRejectedValue(new Error('database unavailable'));

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      notification: {
        state: 'failed',
        delivered: false,
        manualNotificationRequired: true,
        reason: 'The approval email could not be delivered, and reset-link cleanup could not be verified. Notify the user directly and review server logs.',
      },
    });
    expect(passwordResetTokenDelete).toHaveBeenCalledWith({
      where: { id: 'reset-token-new' },
    });
    expect(passwordResetTokenDeleteMany).not.toHaveBeenCalled();
  });

  test('notification-setting failure happens before the approval transaction', async () => {
    setDomainMode();
    systemSettingFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.key === 'notifications.userApproved') {
        throw new Error('settings database unavailable');
      }
      return null;
    });

    const response = await request(
      server,
      '/admin/registration-requests/registration-request-1/approve',
    );

    expect(response.status).toBe(500);
    expect(transaction).not.toHaveBeenCalled();
    expect(registrationRequestUpdateMany).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
    expect(passwordResetTokenCreate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
