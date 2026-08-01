import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';

const findFirstMock = jest.fn();
const updateManyMock = jest.fn();
const updateMock = jest.fn();
const getAppTargetMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    appShareLink: {
      findFirst: findFirstMock,
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
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method: 'GET',
      headers: {
        ...headers,
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
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('uses the server-attested internal app target when no explicit loopback override exists', async () => {
    delete process.env.APP_API_TARGET_APP_123;
    const response = await request(server, `/${token}/api/auth/login`);
    expect(response.status).toBe(200);
    expect((global.fetch as jest.Mock).mock.calls[0][0])
      .toBe('http://172.30.0.4:5002/api/auth/login');
  });
});
