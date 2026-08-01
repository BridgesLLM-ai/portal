import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const gatewayRpcCallMock = jest.fn();

jest.mock('../utils/openclawGatewayRpc', () => ({
  gatewayRpcCall: gatewayRpcCallMock,
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'owner-1',
      email: 'owner@example.com',
      role: String(req.headers['x-test-role'] || 'OWNER'),
      accountStatus: String(req.headers['x-test-status'] || 'ACTIVE'),
    };
    next();
  },
}));

import automationsRouter from '../routes/automations';

async function request(server: http.Server, input: {
  method: string;
  path: string;
  role?: string;
  status?: string;
  body?: unknown;
}) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = input.body === undefined ? null : Buffer.from(JSON.stringify(input.body));

  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: input.method,
      path: input.path,
      headers: {
        'x-test-role': input.role || 'OWNER',
        'x-test-status': input.status || 'ACTIVE',
        ...(encoded ? {
          'content-type': 'application/json',
          'content-length': String(encoded.length),
        } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

describe('Automations gateway contract', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'cron.list') {
        return {
          ok: true,
          data: {
            jobs: [{
              id: 'cron-1',
              name: 'Agent job',
              sessionTarget: 'isolated',
              payload: { kind: 'agentTurn', message: 'Existing task' },
            }],
            hasMore: false,
          },
        };
      }
      return { ok: true, data: { id: 'cron-1' } };
    });
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/automations', automationsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.each([
    { role: 'USER', status: 'ACTIVE' },
    { role: 'VIEWER', status: 'ACTIVE' },
    { role: 'OWNER', status: 'DISABLED' },
  ])('rejects non-operator or inactive accounts before gateway access', async ({ role, status }) => {
    const response = await request(server, { method: 'GET', path: '/automations/status', role, status });
    expect(response.status).toBe(403);
    expect(gatewayRpcCallMock).not.toHaveBeenCalled();
  });

  it('rejects malformed and excessively frequent schedules before gateway access', async () => {
    const malformedTime = await request(server, {
      method: 'POST',
      path: '/automations',
      body: { name: 'Bad daily', message: 'test', scheduleType: 'daily', time: '99:99', tz: 'UTC' },
    });
    expect(malformedTime.status).toBe(400);

    const rapid = await request(server, {
      method: 'POST',
      path: '/automations',
      body: { name: 'Too rapid', message: 'test', scheduleType: 'interval', interval: '1ms', tz: 'UTC' },
    });
    expect(rapid.status).toBe(400);
    expect(gatewayRpcCallMock).not.toHaveBeenCalled();
  });

  it('creates one isolated no-delivery agent job without replaying a failed mutation', async () => {
    const created = await request(server, {
      method: 'POST',
      path: '/automations',
      body: {
        name: 'Daily report',
        message: 'Prepare the report',
        scheduleType: 'daily',
        time: '09:30',
        tz: 'America/New_York',
        agent: 'main',
        model: 'openai/gpt-5.5',
        thinking: 'high',
      },
    });
    expect(created.status).toBe(200);
    expect(gatewayRpcCallMock).toHaveBeenCalledTimes(1);
    expect(gatewayRpcCallMock).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      name: 'Daily report',
      agentId: 'main',
      sessionTarget: 'isolated',
      wakeMode: 'now',
      schedule: { kind: 'cron', expr: '30 9 * * *', tz: 'America/New_York' },
      delivery: { mode: 'none' },
      payload: {
        kind: 'agentTurn',
        message: 'Prepare the report',
        model: 'openai/gpt-5.5',
        thinking: 'high',
      },
    }), 45000);

    gatewayRpcCallMock.mockClear().mockResolvedValue({ ok: false, error: 'Gateway RPC timeout' });
    const uncertain = await request(server, {
      method: 'POST',
      path: '/automations',
      body: { name: 'No duplicate', message: 'test', scheduleType: 'hourly', tz: 'UTC' },
    });
    expect(uncertain.status).toBe(503);
    expect(gatewayRpcCallMock).toHaveBeenCalledTimes(1);
  });

  it('uses explicit nulls to clear saved model and thinking overrides', async () => {
    const response = await request(server, {
      method: 'PUT',
      path: '/automations/cron-1',
      body: { model: null, thinking: null },
    });
    expect(response.status).toBe(200);
    expect(gatewayRpcCallMock).toHaveBeenNthCalledWith(2, 'cron.update', {
      id: 'cron-1',
      patch: {
        payload: { kind: 'agentTurn', model: null, thinking: null },
        delivery: { mode: 'none' },
      },
    }, 45000);
  });

  it('refuses to rewrite non-agent OpenClaw cron payloads', async () => {
    gatewayRpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'cron.list') {
        return {
          ok: true,
          data: {
            jobs: [{
              id: 'command-job',
              name: 'OpenClaw command',
              sessionTarget: 'isolated',
              payload: { kind: 'command' },
            }],
            hasMore: false,
          },
        };
      }
      return { ok: true, data: {} };
    });

    const response = await request(server, {
      method: 'PUT',
      path: '/automations/command-job',
      body: { message: 'Convert me' },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/managed in OpenClaw/i);
    expect(gatewayRpcCallMock).toHaveBeenCalledTimes(1);
    expect(gatewayRpcCallMock).toHaveBeenCalledWith(
      'cron.list',
      { includeDisabled: true, limit: 200, offset: 0 },
      30000,
    );
  });

  it.each([
    { method: 'POST', path: '/automations/command-job/toggle', body: { enabled: false } },
    { method: 'POST', path: '/automations/command-job/run' },
    { method: 'DELETE', path: '/automations/command-job' },
  ])('refuses lifecycle mutations for non-agent OpenClaw jobs', async ({ method, path, body }) => {
    gatewayRpcCallMock.mockImplementation(async (rpcMethod: string) => {
      if (rpcMethod === 'cron.list') {
        return {
          ok: true,
          data: {
            jobs: [{
              id: 'command-job',
              name: 'OpenClaw command',
              sessionTarget: 'isolated',
              payload: { kind: 'command' },
            }],
            hasMore: false,
          },
        };
      }
      return { ok: true, data: {} };
    });

    const response = await request(server, { method, path, body });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/managed in OpenClaw/i);
    expect(gatewayRpcCallMock).toHaveBeenCalledTimes(1);
    expect(gatewayRpcCallMock).toHaveBeenCalledWith('cron.list', expect.anything(), 30000);
  });
});
