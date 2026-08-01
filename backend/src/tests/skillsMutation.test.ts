import http from 'http';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const skillsWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-skills-route-test-'));
process.env.OPENCLAW_WORKSPACE = skillsWorkspace;

const startAgentJobMock = jest.fn();
const execFileMock = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: execFileMock,
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

  return {
    AgentJobRequestError,
    startAgentJob: startAgentJobMock,
  };
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      email: 'test@example.com',
      role: String(req.headers['x-test-role'] || 'USER'),
      accountStatus: String(req.headers['x-test-status'] || 'ACTIVE'),
    };
    next();
  },
}));

import { AgentJobRequestError } from '../services/agentJobs';
import skillsRouter from '../routes/skills';

async function request(server: http.Server, role: string, route: string, body: unknown) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = Buffer.from(JSON.stringify(body));

  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: route,
      headers: {
        'x-test-role': role,
        'content-type': 'application/json',
        'content-length': String(encoded.length),
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
    req.write(encoded);
    req.end();
  });
}

async function getRequest(server: http.Server, role: string, route: string) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'GET',
      path: route,
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

describe('Skills and plugins host mutation boundary', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    execFileMock.mockImplementation((_command, _args, _options, callback) => callback(null, JSON.stringify({
      skills: [
        { name: 'weather', source: 'openclaw-workspace', eligible: true, disabled: false },
        { name: 'bridgesllm-portal', source: 'openclaw-workspace', eligible: true, disabled: false },
      ],
    }), ''));
    fs.rmSync(path.join(skillsWorkspace, '.clawhub'), { recursive: true, force: true });
    fs.mkdirSync(path.join(skillsWorkspace, '.clawhub'), { recursive: true });
    fs.writeFileSync(path.join(skillsWorkspace, '.clawhub', 'lock.json'), JSON.stringify({
      skills: { weather: { version: '1.0.0' } },
    }));
    startAgentJobMock.mockResolvedValue({ id: 'extension-job-1' });
    const app = express();
    app.use(express.json());
    app.use('/skills', skillsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(() => {
    fs.rmSync(skillsWorkspace, { recursive: true, force: true });
    delete process.env.OPENCLAW_WORKSPACE;
  });

  test.each(['USER', 'VIEWER'])('rejects %s before a host mutation starts', async (role) => {
    const response = await request(server, role, '/skills/install', {
      name: 'weather',
      confirmation: 'INSTALL SKILL weather',
    });
    expect(response.status).toBe(403);
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it('labels only lock-tracked workspace skills as ClawHub-managed', async () => {
    const response = await getRequest(server, 'OWNER', '/skills?refresh=1');
    expect(response.status).toBe(200);
    expect(response.body.skills).toEqual([
      expect.objectContaining({ name: 'weather', source: 'managed', managed: true }),
      expect.objectContaining({ name: 'bridgesllm-portal', source: 'openclaw-workspace' }),
    ]);
  });

  it('requires exact typed confirmation and starts a serialized durable skill job', async () => {
    const rejected = await request(server, 'OWNER', '/skills/install', { name: 'weather' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.confirmationPhrase).toBe('INSTALL SKILL weather');
    expect(startAgentJobMock).not.toHaveBeenCalled();

    const accepted = await request(server, 'OWNER', '/skills/install', {
      name: 'weather',
      confirmation: 'INSTALL SKILL weather',
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ jobId: 'extension-job-1', room: 'job:extension-job-1' });
    expect(startAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      toolId: '_skill:install:weather',
      title: 'Install skill weather',
      cwd: skillsWorkspace,
      command: expect.stringContaining("'flock' '--nonblock' '/run/bridgesllm-agent-mutation.lock' '--' 'timeout' '--foreground' '--kill-after=30s' '15m'"),
    }));
    expect(startAgentJobMock.mock.calls[0][0].command).toContain('clawhub');
    expect(startAgentJobMock.mock.calls[0][0].command).toContain('--no-input');
    expect(startAgentJobMock.mock.calls[0][0].command).toContain("--workdir");
    expect(startAgentJobMock.mock.calls[0][0].command).toContain(skillsWorkspace);
  });

  it('removes only ClawHub-tracked skills and uses non-interactive workspace-scoped uninstall', async () => {
    const protectedResponse = await request(server, 'OWNER', '/skills/uninstall', {
      name: 'bridgesllm-portal',
      confirmation: 'UNINSTALL SKILL bridgesllm-portal',
    });
    expect(protectedResponse.status).toBe(409);
    expect(startAgentJobMock).not.toHaveBeenCalled();

    const accepted = await request(server, 'OWNER', '/skills/uninstall', {
      name: 'weather',
      confirmation: 'UNINSTALL SKILL weather',
    });
    expect(accepted.status).toBe(202);
    expect(startAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: skillsWorkspace }));
    const command = startAgentJobMock.mock.calls[0][0].command;
    expect(command).toContain("'uninstall'");
    expect(command).toContain("'--yes'");
    expect(command).toContain("'weather'");
  });

  it('quotes plugin specifications as one argument and maps bounded-job errors', async () => {
    const spec = 'npm:package; touch /tmp/not-executed';
    const accepted = await request(server, 'SUB_ADMIN', '/skills/plugins/install', {
      spec,
      confirmation: `INSTALL PLUGIN ${spec}`,
    });
    expect(accepted.status).toBe(202);
    expect(startAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: '_plugin:install',
      command: expect.stringContaining("'npm:package; touch /tmp/not-executed'"),
    }));

    startAgentJobMock.mockRejectedValueOnce(
      new AgentJobRequestError('command exceeds the job size limit', 413, 'COMMAND_TOO_LARGE'),
    );
    const bounded = await request(server, 'OWNER', '/skills/plugins/install', {
      spec: 'npm:another-package',
      confirmation: 'INSTALL PLUGIN npm:another-package',
    });
    expect(bounded.status).toBe(413);
    expect(bounded.body.error).toBe('command exceeds the job size limit');
  });

  it('rejects a plugin option prefix before starting OpenClaw', async () => {
    const response = await request(server, 'OWNER', '/skills/plugins/install', {
      spec: '--force',
      confirmation: 'INSTALL PLUGIN --force',
    });
    expect(response.status).toBe(400);
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });
});
