import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const execMock = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: execMock,
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      email: 'test@example.com',
      role: String(req.headers['x-test-role'] || 'USER'),
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

import agentRuntimeRouter from '../routes/agent-runtime';
import { TOOL_ADAPTERS } from '../config/toolAdapters';

async function request(server: http.Server, role: string) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'GET',
      path: '/agent-runtime/status',
      headers: { 'x-test-role': role },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Agent runtime host-inventory authorization', () => {
  let server: http.Server;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    execMock.mockImplementation((_command, _options, callback) => callback(null, '1.2.3\n', ''));
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as any);
    const app = express();
    app.use('/agent-runtime', agentRuntimeRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fetchSpy.mockRestore();
  });

  test.each(['USER', 'VIEWER'])('rejects %s before probing host runtimes', async (role) => {
    const response = await request(server, role);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Admin access required' });
    expect(execMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(['OWNER', 'SUB_ADMIN'])('retains intentional %s host-runtime diagnostics', async (role) => {
    const response = await request(server, role);
    expect(response.status).toBe(200);
    expect(response.body.gateway).toEqual({ connected: true, message: 'Gateway reachable' });
    expect(Array.isArray(response.body.adapters)).toBe(true);
    expect(execMock).toHaveBeenCalled();
  });

  test('allows only Agent Zero the longer bounded runtime detection window', async () => {
    const response = await request(server, 'OWNER');
    expect(response.status).toBe(200);

    for (const adapter of TOOL_ADAPTERS.filter((entry) => entry.detect?.command)) {
      const call = execMock.mock.calls.find(([command]) => command === adapter.detect?.command);
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        timeout: adapter.id === 'agent-zero' ? 20_000 : 2_500,
        shell: '/bin/bash',
      });
    }
  });

  test('routes gateway control presets through the Portal-owned system unit', () => {
    const openClaw = TOOL_ADAPTERS.find((entry) => entry.id === 'openclaw');
    const gatewayCommands = openClaw?.commands.filter((entry) => (
      entry.label === 'Gateway Status' || entry.label === 'Start Gateway'
    )) || [];

    expect(gatewayCommands).toHaveLength(2);
    expect(gatewayCommands.every((entry) => (
      entry.command.startsWith('/usr/bin/systemctl ')
      && entry.command.endsWith(' openclaw-gateway.service')
      && !entry.command.includes('openclaw gateway')
    ))).toBe(true);
  });
});
