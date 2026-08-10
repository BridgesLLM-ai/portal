import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const appFindFirstMock = jest.fn();
const appDeleteMock = jest.fn();
const shareCountMock = jest.fn();
const shareCreateMock = jest.fn();
const shareFindFirstMock = jest.fn();
const shareFindManyMock = jest.fn();
const shareUpdateMock = jest.fn();
const shareDeleteManyMock = jest.fn();
const activityCreateMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    app: {
      findFirst: appFindFirstMock,
      findMany: jest.fn(),
      delete: appDeleteMock,
    },
    appShareLink: {
      count: shareCountMock,
      create: shareCreateMock,
      findFirst: shareFindFirstMock,
      findMany: shareFindManyMock,
      update: shareUpdateMock,
      updateMany: jest.fn(),
      deleteMany: shareDeleteManyMock,
    },
    activityLog: { create: activityCreateMock },
  },
}));

jest.mock('../config/env', () => ({ config: { jwtSecret: 'test-secret' } }));
jest.mock('../services/app-process.service', () => ({ getAppTarget: jest.fn() }));
jest.mock('../services/virusScan', () => ({ scanFile: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      email: 'user@example.test',
      role: String(req.headers['x-test-role'] || 'USER'),
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

import appsRouter from '../routes/apps';

async function request(server: http.Server, method: string, path: string, body?: unknown, role = 'USER') {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        'x-test-role': role,
        ...(encoded ? { 'content-type': 'application/json', 'content-length': String(encoded.length) } : {}),
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
    if (encoded) req.write(encoded);
    req.end();
  });
}

describe('packaged app share lifecycle', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.ORIGIN_MODE = '';
    process.env.CORS_ORIGIN = 'https://portal.example.com';
    process.env.APP_CONTENT_ORIGIN = 'https://apps.example.net';
    appFindFirstMock.mockResolvedValue({ id: 'app-1', userId: 'user-1' });
    shareCountMock.mockResolvedValue(0);
    activityCreateMock.mockResolvedValue({ id: 'activity-1' });
    shareCreateMock.mockResolvedValue({
      id: 'link-1', appId: 'app-1', userId: 'user-1', token: 'shareToken0123456789A',
      isActive: true, isPublic: true, passwordHash: 'must-not-leak', expiresAt: null,
      maxUses: 25, currentUses: 0, createdAt: new Date(),
    });
    shareDeleteManyMock.mockResolvedValue({ count: 1 });

    const app = express();
    app.use(express.json());
    app.use('/apps', appsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.ORIGIN_MODE;
    delete process.env.CORS_ORIGIN;
    delete process.env.APP_CONTENT_ORIGIN;
    delete process.env.APP_API_TARGET_APP_EXTERNAL_DELETE;
    delete process.env.APP_API_TARGET_APP_INVALID_DELETE;
  });

  test('creates bounded options, redacts hashes, and rejects viewer mutations', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const created = await request(server, 'POST', '/apps/app-1/share', {
      expiresAt,
      maxUses: 25,
      rateLimitMaxRequests: 50,
      rateLimitWindowSeconds: 300,
    });
    expect(created.status).toBe(201);
    expect(created.body.shareLink.passwordHash).toBeUndefined();
    expect(shareCreateMock).toHaveBeenCalledWith({ data: expect.objectContaining({
      appId: 'app-1',
      userId: 'user-1',
      expiresAt: new Date(expiresAt),
      maxUses: 25,
      rateLimitMaxRequests: 50,
      rateLimitWindowSeconds: 300,
      isPublic: true,
      passwordHash: null,
    }) });

    expect((await request(server, 'POST', '/apps/app-1/share', {}, 'VIEWER')).status).toBe(403);
  });

  test('constructs only coherent credential states when creating links', async () => {
    const publicWithPassword = await request(server, 'POST', '/apps/app-1/share', {
      isPublic: true,
      password: 'correct horse battery staple',
    });
    expect(publicWithPassword.status).toBe(400);
    expect(publicWithPassword.body.code).toBe('SHARE_PASSWORD_REQUIRES_PRIVATE_LINK');
    expect(shareCreateMock).not.toHaveBeenCalled();

    const privateWithoutPassword = await request(server, 'POST', '/apps/app-1/share', { isPublic: false });
    expect(privateWithoutPassword.status).toBe(400);
    expect(shareCreateMock).not.toHaveBeenCalled();

    const privateLink = await request(server, 'POST', '/apps/app-1/share', {
      isPublic: false,
      password: 'correct horse battery staple',
    });
    expect(privateLink.status).toBe(201);
    expect(shareCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        isPublic: false,
        passwordHash: expect.stringMatching(/^\$2[aby]\$/),
      }),
    });
  });

  test('fails closed when reactivating expired or exhausted links', async () => {
    shareFindFirstMock.mockResolvedValue({
      id: 'link-1', appId: 'app-1', userId: 'user-1', isActive: false,
      isPublic: true, passwordHash: null,
      expiresAt: new Date(Date.now() - 1_000), maxUses: null, currentUses: 0,
    });
    expect((await request(server, 'PATCH', '/apps/app-1/share/link-1', { isActive: true })).status).toBe(409);
    expect(shareUpdateMock).not.toHaveBeenCalled();

    shareFindFirstMock.mockResolvedValue({
      id: 'link-1', appId: 'app-1', userId: 'user-1', isActive: false,
      isPublic: true, passwordHash: null,
      expiresAt: null, maxUses: 1, currentUses: 1,
    });
    expect((await request(server, 'PATCH', '/apps/app-1/share/link-1', { isActive: true })).status).toBe(409);
    expect(shareUpdateMock).not.toHaveBeenCalled();
  });

  test.each([
    ['public with hash', { isPublic: true, passwordHash: 'bcrypt-hash' }],
    ['private with null hash', { isPublic: false, passwordHash: null }],
    ['private with empty hash', { isPublic: false, passwordHash: '' }],
  ])('refuses to update a link with credential drift: %s', async (_label, credentialState) => {
    shareFindFirstMock.mockResolvedValue({
      id: 'link-1', appId: 'app-1', userId: 'user-1', isActive: true,
      expiresAt: null, maxUses: null, currentUses: 0,
      ...credentialState,
    });

    const response = await request(server, 'PATCH', '/apps/app-1/share/link-1', { isActive: false });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHARE_CREDENTIAL_STATE_INVALID');
    expect(shareUpdateMock).not.toHaveBeenCalled();
  });

  test('permanently deletes only the link scoped to the owning app and user', async () => {
    const response = await request(server, 'DELETE', '/apps/app-1/share/link-1');
    expect(response.status).toBe(200);
    expect(shareDeleteManyMock).toHaveBeenCalledWith({
      where: { id: 'link-1', appId: 'app-1', userId: 'user-1' },
    });
  });

  test('refuses direct deletion of externally managed and invalidly bound Apps before mutation', async () => {
    process.env.APP_API_TARGET_APP_EXTERNAL_DELETE = 'http://127.0.0.1:5999';
    appFindFirstMock.mockResolvedValueOnce({
      id: 'app-external-delete',
      userId: 'user-1',
      projectIdentityId: 'project-external-delete',
      deployType: 'fullstack',
      zipPath: '/must-not-touch/external',
    });

    const external = await request(server, 'DELETE', '/apps/app-external-delete');

    expect(external.status).toBe(409);
    expect(external.body).toMatchObject({
      code: 'PROJECT_RUNTIME_EXTERNALLY_MANAGED',
      runtimeManagement: 'external-loopback',
      action: 'delete-app',
      supportedActions: [],
      retryable: false,
    });

    process.env.APP_API_TARGET_APP_INVALID_DELETE = '   ';
    appFindFirstMock.mockResolvedValueOnce({
      id: 'app-invalid-delete',
      userId: 'user-1',
      projectIdentityId: 'project-invalid-delete',
      deployType: 'fullstack',
      zipPath: '/must-not-touch/invalid',
    });

    const invalid = await request(server, 'DELETE', '/apps/app-invalid-delete');

    expect(invalid.status).toBe(503);
    expect(invalid.body).toMatchObject({
      code: 'PROJECT_RUNTIME_BINDING_INVALID',
      runtimeManagement: 'external-loopback',
      bindingStatus: 'invalid',
      action: 'delete-app',
      supportedActions: [],
      retryable: false,
    });
    expect(appDeleteMock).not.toHaveBeenCalled();
    expect(activityCreateMock).not.toHaveBeenCalled();
  });

  test('requires every Project-associated App to be removed through Projects even when its directory is absent', async () => {
    appFindFirstMock.mockResolvedValueOnce({
      id: 'app-project-delete',
      userId: 'user-1',
      projectIdentityId: 'project-delete',
      deployType: 'static',
      zipPath: '/already-absent/project-deploy',
    });

    const response = await request(server, 'DELETE', '/apps/app-project-delete');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'PROJECT_APP_MANAGED_BY_PROJECT',
      recoveryAction: 'OPEN_PROJECT_DEPLOYMENT',
      retryable: false,
    });
    expect(appDeleteMock).not.toHaveBeenCalled();
    expect(activityCreateMock).not.toHaveBeenCalled();
  });

  test('rejects Tailnet share creation before reading or mutating app state', async () => {
    process.env.ORIGIN_MODE = 'tailnet';
    process.env.APP_CONTENT_ORIGIN = '';

    const response = await request(server, 'POST', '/apps/app-1/share', {});

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'PORTAL_FEATURE_UNAVAILABLE',
      feature: 'appHosting',
      retryable: false,
    });
    expect(appFindFirstMock).not.toHaveBeenCalled();
    expect(shareCountMock).not.toHaveBeenCalled();
    expect(shareCreateMock).not.toHaveBeenCalled();
  });

  test('blocks Tailnet share reactivation while preserving disable and delete cleanup', async () => {
    process.env.ORIGIN_MODE = 'tailnet';
    process.env.APP_CONTENT_ORIGIN = '';

    const blocked = await request(server, 'PATCH', '/apps/app-1/share/link-1', { isActive: true });
    expect(blocked.status).toBe(409);
    expect(shareFindFirstMock).not.toHaveBeenCalled();
    expect(shareUpdateMock).not.toHaveBeenCalled();

    shareFindFirstMock.mockResolvedValue({
      id: 'link-1',
      appId: 'app-1',
      userId: 'user-1',
      isActive: true,
      isPublic: true,
      passwordHash: null,
      expiresAt: null,
      maxUses: null,
      currentUses: 0,
    });
    shareUpdateMock.mockResolvedValue({
      id: 'link-1',
      appId: 'app-1',
      userId: 'user-1',
      isActive: false,
      passwordHash: null,
    });
    const disabled = await request(server, 'PATCH', '/apps/app-1/share/link-1', { isActive: false });
    expect(disabled.status).toBe(200);
    expect(shareUpdateMock).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { isActive: false },
    });

    shareDeleteManyMock.mockClear();
    const deleted = await request(server, 'DELETE', '/apps/app-1/share/link-1');
    expect(deleted.status).toBe(200);
    expect(shareDeleteManyMock).toHaveBeenCalledTimes(1);
  });
});
