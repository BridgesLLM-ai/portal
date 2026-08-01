import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const activityFindManyMock = jest.fn();
const activityCountMock = jest.fn();
const activityFindFirstMock = jest.fn();
const activityUpdateMock = jest.fn();
const activityDeleteManyMock = jest.fn();
const sessionFindFirstMock = jest.fn();
const ingestAlertMock = jest.fn();
const logErrorMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    activityLog: {
      findMany: activityFindManyMock,
      count: activityCountMock,
      findFirst: activityFindFirstMock,
      findUnique: jest.fn(),
      update: activityUpdateMock,
      updateMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: activityDeleteManyMock,
    },
    session: { findFirst: sessionFindFirstMock },
  },
}));

jest.mock('../config/env', () => ({
  config: { nodeEnv: 'test' },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    const role = String(req.headers['x-test-role'] || 'USER');
    req.user = {
      userId: String(req.headers['x-test-user'] || 'user-1'),
      email: 'test@example.com',
      role,
      accountStatus: 'ACTIVE',
      sandboxEnabled: req.headers['x-test-sandbox'] === 'true',
    };
    next();
  },
}));

jest.mock('../utils/logWatcher', () => ({
  ingestAlert: ingestAlertMock,
}));

jest.mock('../utils/errorLogger', () => ({ logError: logErrorMock }));
jest.mock('../utils/auth-tracking', () => ({ blockedIPs: new Set<string>() }));

import activityRouter from '../routes/activity';
import alertsRouter from '../routes/alerts';

type TestResponse = { status: number; body: any };

async function request(
  server: http.Server,
  method: string,
  path: string,
  role = 'USER',
  body?: unknown,
  sandboxEnabled = false,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        'x-test-role': role,
        'x-test-sandbox': String(sandboxEnabled),
        ...(encoded ? {
          'content-type': 'application/json',
          'content-length': String(encoded.length),
        } : {}),
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

describe('activity and alert authorization boundaries', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    activityFindManyMock.mockResolvedValue([]);
    activityCountMock.mockResolvedValue(0);
    activityFindFirstMock.mockResolvedValue(null);
    activityDeleteManyMock.mockResolvedValue({ count: 0 });
    sessionFindFirstMock.mockResolvedValue(null);
    ingestAlertMock.mockResolvedValue({ id: 'alert-1' });
    logErrorMock.mockResolvedValue('error-log-1');

    const app = express();
    app.use(express.json());
    app.use('/activity', activityRouter);
    app.use('/alerts', alertsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('keeps ordinary-user activity scope when category and search filters are present', async () => {
    const response = await request(server, 'GET', '/activity?category=errors&search=secret');
    expect(response.status).toBe(200);

    const where = activityFindManyMock.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ userId: 'user-1' });
    expect(where.AND).toContainEqual({
      OR: [
        { action: { endsWith: '_ERROR' } },
        { severity: { in: ['ERROR', 'CRITICAL'] } },
      ],
    });
    const searchFilter = where.AND.find((entry: any) => entry.OR?.some((part: any) => part.translatedMessage));
    expect(searchFilter.OR).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ipAddress: expect.anything() }),
    ]));
  });

  test('rejects ordinary users before system activity is queried', async () => {
    const response = await request(server, 'GET', '/activity?kind=system_alert');
    expect(response.status).toBe(403);
    expect(activityFindManyMock).not.toHaveBeenCalled();
  });

  test('allows elevated global activity search including IP data', async () => {
    const response = await request(server, 'GET', '/activity?search=203.0.113.4', 'SUB_ADMIN');
    expect(response.status).toBe(200);
    const where = activityFindManyMock.mock.calls[0][0].where;
    expect(where.AND).not.toContainEqual({ userId: 'user-1' });
    expect(where.AND[0].OR).toContainEqual({
      ipAddress: { contains: '203.0.113.4', mode: 'insensitive' },
    });
  });

  test('keeps a sandboxed elevated delegate inside its own activity metadata boundary', async () => {
    const response = await request(
      server,
      'GET',
      '/activity?search=foreign-project',
      'SUB_ADMIN',
      undefined,
      true,
    );
    expect(response.status).toBe(200);
    const where = activityFindManyMock.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ userId: 'user-1' });
    const searchFilter = where.AND.find((entry: any) => (
      entry.OR?.some((part: any) => part.translatedMessage)
    ));
    expect(searchFilter.OR).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ipAddress: expect.anything() }),
    ]));

    expect((await request(
      server,
      'GET',
      '/activity?kind=system_alert',
      'SUB_ADMIN',
      undefined,
      true,
    )).status).toBe(403);
  });

  test('keeps unblock and archive operations behind their intended roles', async () => {
    expect((await request(server, 'POST', '/activity/unblock-ip', 'USER', { ip: '203.0.113.4' })).status).toBe(403);
    expect((await request(server, 'POST', '/activity/archive', 'SUB_ADMIN')).status).toBe(403);
    expect((await request(server, 'POST', '/activity/archive', 'OWNER')).status).toBe(200);
    expect(activityDeleteManyMock).toHaveBeenCalledTimes(1);
  });

  test('accepts bounded frontend reports without entering the reporter failure path', async () => {
    const response = await request(server, 'POST', '/activity/report-error', 'USER', {
      message: 'Project panel failed to render',
      componentName: 'ProjectChatPanel',
      context: 'initial history load',
      severity: 'ERROR',
    });

    expect(response).toEqual({ status: 200, body: { logged: true } });
    expect(logErrorMock).toHaveBeenCalledWith('Project panel failed to render', expect.objectContaining({
      userId: 'user-1',
      action: 'FRONTEND_ERROR',
      resource: 'frontend',
      componentName: 'ProjectChatPanel',
      context: 'initial history load',
      severity: 'ERROR',
    }));
  });

  test('makes every alerts route elevated-only and scopes dismissal to SYSTEM_ALERT rows', async () => {
    expect((await request(server, 'GET', '/alerts', 'USER')).status).toBe(403);
    expect(activityFindManyMock).not.toHaveBeenCalled();

    expect((await request(server, 'GET', '/alerts', 'OWNER')).status).toBe(200);
    expect(activityFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { action: 'SYSTEM_ALERT' },
    }));

    expect((await request(server, 'POST', '/alerts/not-an-alert/dismiss', 'OWNER')).status).toBe(404);
    expect(activityFindFirstMock).toHaveBeenCalledWith({
      where: { id: 'not-an-alert', action: 'SYSTEM_ALERT' },
      select: { id: true, metadata: true },
    });
    expect(activityUpdateMock).not.toHaveBeenCalled();
  });
});
