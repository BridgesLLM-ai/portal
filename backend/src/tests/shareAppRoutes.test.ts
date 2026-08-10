import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import { issueShareGrant, shareGrantCookieName, shareGrantTtlMs } from '../utils/shareAccessSecurity';

const findFirstMock = jest.fn();
const findUniqueMock = jest.fn();
const updateManyMock = jest.fn();
const updateMock = jest.fn();
const getAppTargetMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    appShareLink: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
      update: updateMock,
    },
  },
}));
jest.mock('../config/env', () => ({ config: { jwtSecret: 'test-share-secret' } }));
jest.mock('../services/app-process.service', () => ({ getAppTarget: getAppTargetMock }));
jest.mock('../services/virusScan', () => ({ scanFile: jest.fn() }));

import { shareRouter } from '../routes/apps';

type TestResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

async function request(
  server: http.Server,
  path: string,
  cookie?: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: unknown,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: {
        ...headers,
        ...(encodedBody ? {
          'content-type': 'application/json',
          'content-length': String(encodedBody.length),
        } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (encodedBody) req.write(encodedBody);
    req.end();
  });
}

describe('share app routes', () => {
  const token = 'shareToken0123456789A';
  const appId = 'app-123';
  const originalFetch = global.fetch;
  const originalTarget = process.env.APP_API_TARGET_APP_123;
  const originalSecret = process.env.APP_API_SECRET_APP_123;
  let server: http.Server;

  const makeLink = () => ({
    id: 'link-1',
    token,
    userId: 'user-1',
    isActive: true,
    isPublic: true,
    passwordHash: null,
    expiresAt: null,
    maxUses: 1,
    currentUses: 0,
    rateLimitMaxRequests: null,
    rateLimitWindowSeconds: null,
    rateLimitRequestCount: 0,
    rateLimitWindowStartedAt: null,
    app: {
      id: appId,
      userId: 'user-1',
      name: 'project',
      isActive: true,
      port: 5002,
      zipPath: '/var/www/bridgesllm-apps/user-1-project',
    },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.APP_API_TARGET_APP_123 = 'http://127.0.0.1:5010';
    process.env.APP_API_SECRET_APP_123 = 'app-bound-secret';
    findFirstMock.mockResolvedValue(makeLink());
    updateManyMock.mockResolvedValue({ count: 1 });
    getAppTargetMock.mockReturnValue('http://172.30.0.4:5002');
    global.fetch = jest.fn(async () => new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'set-cookie': 'accessToken=attacker; Path=/',
      },
    })) as any;

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/', shareRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    if (originalTarget === undefined) delete process.env.APP_API_TARGET_APP_123;
    else process.env.APP_API_TARGET_APP_123 = originalTarget;
    if (originalSecret === undefined) delete process.env.APP_API_SECRET_APP_123;
    else process.env.APP_API_SECRET_APP_123 = originalSecret;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('binds target and secret to the App row and atomically counts one browser visit', async () => {
    const first = await request(
      server,
      `/${token}/api/attacker-selected/login?next=%2Fhome`,
      undefined,
      {
        authorization: 'Bearer application-token',
        'x-portal-app-id': 'client-override',
        'x-portal-app-secret': 'client-override',
      },
    );
    expect(first.status).toBe(200);
    expect(first.body).toBe('ok');
    expect(updateManyMock).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'link-1', isActive: true, currentUses: { lt: 1 } }),
      data: { currentUses: { increment: 1 } },
    });
    expect(updateManyMock.mock.calls[0][0].where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    expect(fetchCall[0]).toBe('http://127.0.0.1:5010/api/attacker-selected/login?next=%2Fhome');
    expect(fetchCall[1].headers).toEqual(expect.objectContaining({
      authorization: 'Bearer application-token',
      'x-portal-app-id': appId,
      'x-portal-app-secret': 'app-bound-secret',
    }));
    expect(String(first.headers['set-cookie'])).not.toContain('accessToken=attacker');

    const visitCookie = (first.headers['set-cookie'] || [])[0].split(';', 1)[0];
    const second = await request(server, `/${token}/api/attacker-selected/login`, visitCookie);
    expect(second.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  test('fails closed when the share row and App owner are inconsistent', async () => {
    const mismatched = makeLink();
    mismatched.app.userId = 'other-user';
    findFirstMock.mockResolvedValueOnce(mismatched);
    const response = await request(server, `/${token}/api/auth/login`);
    expect(response.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['public link with a retained hash', { isPublic: true, passwordHash: 'bcrypt-hash' }, `/${token}/api/session`],
    ['public link with an empty hash', { isPublic: true, passwordHash: '' }, `/${token}`],
    ['private link with a null hash', { isPublic: false, passwordHash: null }, `/${token}/progress`],
    ['private link with an empty hash', { isPublic: false, passwordHash: '' }, `/${token}/app.js`],
  ])('fails closed centrally for credential drift: %s', async (_label, credentialState, requestPath) => {
    findFirstMock.mockResolvedValueOnce({ ...makeLink(), ...credentialState });

    const response = await request(server, requestPath);

    expect(response.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('uses the server-attested internal app target when no explicit loopback override exists', async () => {
    delete process.env.APP_API_TARGET_APP_123;
    const response = await request(server, `/${token}/api/auth/login`);
    expect(response.status).toBe(200);
    expect((global.fetch as jest.Mock).mock.calls[0][0])
      .toBe('http://172.30.0.4:5002/api/auth/login');
  });

  test('claims the dynamic request window before consuming a visitor slot', async () => {
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 5,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
    });
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const response = await request(server, `/${token}/api/session`);

    expect(response.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(updateManyMock.mock.calls[0][0].data).toEqual({
      rateLimitWindowStartedAt: expect.any(Date),
      rateLimitRequestCount: 1,
    });
    expect(updateManyMock.mock.calls[1][0].data).toEqual({ currentUses: { increment: 1 } });
  });

  test.each([
    ['API proxy', `/${token}/api/session`, 'GET'],
    ['progress read', `/${token}/progress`, 'GET'],
    ['progress write', `/${token}/progress`, 'PUT'],
  ])('returns durable 429 before visitor or downstream work on %s', async (_label, requestPath, method) => {
    const windowStartedAt = new Date(Date.now() - 10_000);
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 5,
      rateLimitMaxRequests: 1,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: 1,
      rateLimitWindowStartedAt: windowStartedAt,
    });

    const response = await request(server, requestPath, undefined, {}, method);

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      code: 'SHARE_RATE_LIMITED',
      retryAfterSeconds: expect.any(Number),
    }));
    expect(updateManyMock.mock.calls.some(([args]) => args.data?.currentUses)).toBe(false);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fails closed before visitor admission when persisted rate policy drifts', async () => {
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 5,
      rateLimitMaxRequests: 1,
      rateLimitWindowSeconds: 60,
    });
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      isActive: true,
      expiresAt: null,
      rateLimitMaxRequests: 2,
      rateLimitWindowSeconds: 60,
      rateLimitRequestCount: 2,
      rateLimitWindowStartedAt: new Date(),
    });

    const response = await request(server, `/${token}/progress`);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      code: 'SHARE_RATE_LIMIT_UNAVAILABLE',
      retryable: true,
    }));
    expect(updateManyMock.mock.calls.some(([args]) => args.data?.currentUses)).toBe(false);
  });

  test('does not charge rate budget when a new browser is already out of visitor slots', async () => {
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 1,
      currentUses: 1,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
    });

    const response = await request(server, `/${token}/progress`);

    expect(response.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('lets an existing signed visitor use rate budget after the visitor cap is reached', async () => {
    const issuedAt = Date.now();
    const grant = issueShareGrant({
      kind: 'visit',
      token,
      linkId: 'link-1',
      expiresAt: issuedAt + shareGrantTtlMs('visit'),
    }, 'test-share-secret', issuedAt);
    const visitCookie = `${shareGrantCookieName('visit', token)}=${grant}`;
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 1,
      currentUses: 1,
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
    });
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await request(server, `/${token}/progress`, visitCookie);

    expect(response.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).toEqual({
      rateLimitWindowStartedAt: expect.any(Date),
      rateLimitRequestCount: 1,
    });
  });

  test('rejects malformed, unavailable, and password-locked links before rate admission', async () => {
    const malformed = await request(server, '/short/progress');
    expect(malformed.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();

    findFirstMock.mockResolvedValueOnce(null);
    const unavailable = await request(server, `/${token}/progress`);
    expect(unavailable.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();

    findFirstMock.mockResolvedValueOnce({
      ...makeLink(),
      isPublic: false,
      passwordHash: 'bcrypt-password-hash',
      rateLimitMaxRequests: 3,
      rateLimitWindowSeconds: 60,
    });
    const passwordLocked = await request(server, `/${token}/progress`);
    expect(passwordLocked.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  test('does not charge the request window for static navigation', async () => {
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 5,
      rateLimitMaxRequests: 1,
      rateLimitWindowSeconds: 60,
    });
    updateManyMock.mockResolvedValue({ count: 1 });

    await request(server, `/${token}`);

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentUses: { increment: 1 } },
    }));
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('does not charge the request window for password authentication', async () => {
    const password = 'correct horse battery staple';
    findFirstMock.mockResolvedValue({
      ...makeLink(),
      maxUses: 5,
      isPublic: false,
      passwordHash: await bcrypt.hash(password, 4),
      rateLimitMaxRequests: 1,
      rateLimitWindowSeconds: 60,
    });
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await request(server, `/${token}/auth`, undefined, {}, 'POST', { password });

    expect(response.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentUses: { increment: 1 } },
    }));
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
