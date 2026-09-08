import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const execMock = jest.fn();
const mockReconcileAgentZeroRuntime = jest.fn();
const mockGetNativeHostCliStatus = jest.fn();

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

jest.mock('../agents/providers/agentZero/AgentZeroSetupControl', () => ({
  ...jest.requireActual('../agents/providers/agentZero/AgentZeroSetupControl'),
  reconcileAgentZeroRuntime: mockReconcileAgentZeroRuntime,
}));

jest.mock('../services/nativeHostCliStatus', () => ({
  ...jest.requireActual('../services/nativeHostCliStatus'),
  getNativeHostCliStatus: mockGetNativeHostCliStatus,
}));

import agentRuntimeRouter from '../routes/agent-runtime';
import { TOOL_ADAPTERS } from '../config/toolAdapters';
import { NATIVE_HOST_CLI_EXECUTION_CONTRACT } from '../services/nativeHostCliStatus';

async function request(
  server: http.Server,
  role: string,
  options: { method?: 'GET' | 'POST'; path?: string; body?: string } = {},
) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const body = options.body ?? '';
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/agent-runtime/status',
      headers: {
        'x-test-role': role,
        ...(options.method === 'POST' ? {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
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
    req.end(body);
  });
}

describe('Agent runtime host-inventory authorization', () => {
  let server: http.Server;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    execMock.mockImplementation((_command, _options, callback) => callback(null, '1.2.3\n', ''));
    mockGetNativeHostCliStatus.mockImplementation(async (toolId: 'codex' | 'claude-code') => ({
      toolId,
      executablePath: toolId === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude',
      state: 'verified',
      installed: true,
      executionEligible: true,
      checkedAt: new Date().toISOString(),
      observedVersion: toolId === 'codex' ? '0.145.0' : '2.1.220',
      fingerprint: 'a'.repeat(64),
      reasonCode: null,
    }));
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as any);
    const app = express();
    app.use(express.json());
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

  test('advertises only admitted Codex and Claude host execution under the native admission contract', async () => {
    const response = await request(server, 'OWNER');
    expect(response.status).toBe(200);
    for (const id of ['codex', 'claude-code']) {
      expect(response.body.adapters).toContainEqual(expect.objectContaining({
        id,
        available: true,
        state: 'verified',
        executionContract: NATIVE_HOST_CLI_EXECUTION_CONTRACT,
      }));
    }
  });

  test('does not advertise typed OpenClaw launch or lifecycle presets', () => {
    const openClaw = TOOL_ADAPTERS.find((entry) => entry.id === 'openclaw');
    expect(openClaw?.detect).toEqual({ command: 'openclaw --version' });
    expect(openClaw?.commands).toEqual([]);
    expect(openClaw?.description).toBe(
      'Portal-owned orchestration runtime. Agent Chat uses the durable Gateway run journal; Owner updates it only with the exact compatibility bundle under Admin > Maintenance.',
    );
  });

  test('keeps the late Agent Zero reconcile route fixed unavailable without touching host lifecycle', async () => {
    const response = await request(server, 'OWNER', {
      method: 'POST',
      path: '/agent-runtime/agent-zero/runtime/reconcile',
      body: JSON.stringify({ confirmation: 'SET UP AGENT ZERO' }),
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE',
      retryable: false,
    });
    expect(mockReconcileAgentZeroRuntime).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
