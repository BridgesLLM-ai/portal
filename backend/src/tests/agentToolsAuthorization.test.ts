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
        commands: [],
        status: {
          installed: true,
          state: 'verified',
          installAvailable: false,
          installUnavailableCode: 'CLI_ALREADY_PRESENT',
        },
      });
    }
  });

  it('rejects request-controlled commands and missing confirmation before starting an installer', async () => {
    const invalid = await request(server, 'OWNER', '/agent-tools/claude-code/install', {
      confirmation: 'INSTALL CLAUDE-CODE', command: 'npm install -g anything',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_INSTALL_REQUEST');
    const rejected = await request(server, 'OWNER', '/agent-tools/claude-code/install', { confirmation: 'wrong' });
    expect(rejected.status).toBe(400);
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it('does not overwrite a CLI that is already present', async () => {
    const response = await request(server, 'OWNER', '/agent-tools/claude-code/install', { confirmation: 'INSTALL CLAUDE-CODE' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CLI_ALREADY_PRESENT');
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude-code'])('installs missing %s through a fixed, retained job', async (toolId) => {
    getNativeHostCliStatusMock.mockResolvedValue({ installed: false, state: 'absent' });
    const response = await request(server, 'SUB_ADMIN', `/agent-tools/${toolId}/install`, { confirmation: `INSTALL ${toolId.toUpperCase()}` });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ jobId: 'install-job-1', room: 'job:install-job-1' });
    expect(startAgentJobMock).toHaveBeenCalledTimes(1);
    expect(startAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: `_install:${toolId}`,
      command: `/usr/bin/timeout --foreground --kill-after=30s 30m /usr/bin/python3 -I -B /opt/bridgesllm/portal/installer/install-missing-cli.py ${toolId}`,
    }));
  });

  it('distinguishes unknown CLI state from absence', async () => {
    getNativeHostCliStatusMock.mockResolvedValue({ installed: null, state: 'indeterminate' });
    const response = await request(server, 'OWNER', '/agent-tools/codex/install', { confirmation: 'INSTALL CODEX' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CLI_STATUS_UNAVAILABLE');
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it('offers installation for missing CLIs without hiding existing sign-ins', async () => {
    getNativeHostCliStatusMock.mockResolvedValue({ installed: false, state: 'absent' });
    const response = await request(server, 'OWNER', '/agent-tools?refresh=1');
    expect(response.status).toBe(200);
    expect(response.body.tools.find((tool: any) => tool.id === 'claude-code').status.installAvailable).toBe(true);
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
