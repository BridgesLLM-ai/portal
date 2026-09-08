import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const execMock = jest.fn();
const startAgentJobMock = jest.fn();
const getNativeHostCliStatusMock = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: execMock,
}));

jest.mock('../services/agentJobs', () => {
  class AgentJobRequestError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
      public readonly code: string,
    ) {
      super(message);
    }
  }
  return { AgentJobRequestError, startAgentJob: startAgentJobMock };
});

jest.mock('../services/nativeHostCliStatus', () => ({
  ...jest.requireActual('../services/nativeHostCliStatus'),
  getNativeHostCliStatus: getNativeHostCliStatusMock,
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

import agentToolsRouter from '../routes/agent-tools';
import { AgentJobRequestError } from '../services/agentJobs';

async function request(server: http.Server, role: string, route = '/agent-tools', body?: unknown) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');

  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: body === undefined ? 'GET' : 'POST',
      path: route,
      headers: {
        'x-test-role': role,
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

describe('Agent Tools host-inventory authorization', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    execMock.mockImplementation((_command, _options, callback) => callback(null, '1.2.3\n', ''));
    startAgentJobMock.mockResolvedValue({ id: 'install-job-1' });
    getNativeHostCliStatusMock.mockImplementation(async (toolId: string) => ({
      toolId,
      executablePath: toolId === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude',
      state: 'verified',
      installed: true,
      executionEligible: true,
      checkedAt: '2026-08-21T12:00:00.000Z',
      observedVersion: toolId === 'codex' ? '0.153.2' : '2.1.260',
      fingerprint: 'a'.repeat(64),
      reasonCode: null,
    }));

    const app = express();
    app.use(express.json());
    app.use('/agent-tools', agentToolsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.each(['USER', 'VIEWER'])('rejects %s before host tool discovery runs', async (role) => {
    const response = await request(server, role);
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Admin access required|Account is not permitted/);
    expect(execMock).not.toHaveBeenCalled();
  });

  test.each(['OWNER', 'SUB_ADMIN'])('retains intentional %s host tool discovery', async (role) => {
    const response = await request(server, role);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.tools)).toBe(true);
    for (const toolId of ['codex', 'claude-code']) {
      const tool = response.body.tools.find((entry: any) => entry.id === toolId);
      expect(tool).toMatchObject({
        install: [],
        commands: [],
        status: {
          installed: true,
          state: 'verified',
          installAvailable: false,
          installUnavailableCode: 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE',
        },
      });
    }
  });

  it('fails admitted host package mutations closed before parsing request-controlled commands', async () => {
    const invalid = await request(server, 'OWNER', '/agent-tools/claude-code/install', {
      confirmation: 'INSTALL CLAUDE-CODE',
      command: 'npm install -g anything',
    });
    expect(invalid.status).toBe(503);
    expect(invalid.body.code).toBe('HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE');

    const rejected = await request(server, 'OWNER', '/agent-tools/claude-code/install', {
      confirmation: 'wrong',
    });
    expect(rejected.status).toBe(503);
    expect(rejected.body.code).toBe('HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE');
    expect(startAgentJobMock).not.toHaveBeenCalled();

    const unavailable = await request(server, 'OWNER', '/agent-tools/claude-code/install', {
      confirmation: 'INSTALL CLAUDE-CODE',
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({
      code: 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE',
      retryable: false,
    });
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it('fails native-runtime installation closed without creating an AgentJob', async () => {
    const response = await request(server, 'OWNER', '/agent-tools/grok-build/install', {
      confirmation: 'INSTALL GROK-BUILD',
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE',
      retryable: false,
    });
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it('retains the bounded AgentJob lane only for the unrelated FFmpeg adapter', async () => {
    const response = await request(server, 'OWNER', '/agent-tools/ffmpeg/install', {
      confirmation: 'INSTALL FFMPEG',
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ jobId: 'install-job-1', room: 'job:install-job-1' });
    expect(startAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      toolId: '_install:ffmpeg',
      title: 'Install Media Processing (FFmpeg)',
      command: expect.stringContaining("'timeout' '--foreground' '--kill-after=30s' '30m'"),
    }));
  });

  it('preserves bounded-job admission errors instead of returning an unhandled rejection', async () => {
    startAgentJobMock.mockRejectedValueOnce(
      new AgentJobRequestError('another tool installation is already running', 409, 'JOB_BUSY'),
    );
    const response = await request(server, 'OWNER', '/agent-tools/ffmpeg/install', {
      confirmation: 'INSTALL FFMPEG',
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'another tool installation is already running' });
  });
});
