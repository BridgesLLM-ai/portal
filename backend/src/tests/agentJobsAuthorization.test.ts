import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const findManyMock = jest.fn();
const findUniqueMock = jest.fn();
const startAgentJobMock = jest.fn();
const readTranscriptMock = jest.fn();
const writeToAgentJobMock = jest.fn();
const killAgentJobMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    agentJob: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
    },
  },
}));

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

jest.mock('../services/agentJobs', () => ({
  startAgentJob: startAgentJobMock,
  readTranscript: readTranscriptMock,
  writeToAgentJob: writeToAgentJobMock,
  killAgentJob: killAgentJobMock,
}));

import agentJobsRouter from '../routes/agent-jobs';

async function request(
  server: http.Server,
  method: string,
  route: string,
  role: string,
  body?: unknown,
  accountStatus = 'ACTIVE',
) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path: route,
      headers: {
        'x-test-role': role,
        'x-test-status': accountStatus,
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

describe('Agent Job host-operator authorization', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    findUniqueMock.mockResolvedValue({ id: 'job-1', userId: 'user-1' });
    startAgentJobMock.mockResolvedValue({ id: 'job-1', status: 'running' });
    readTranscriptMock.mockResolvedValue([]);
    writeToAgentJobMock.mockResolvedValue(undefined);
    killAgentJobMock.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.use('/agent-jobs', agentJobsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.each([
    ['GET', '/agent-jobs', undefined],
    ['GET', '/agent-jobs/job-1', undefined],
    ['GET', '/agent-jobs/job-1/status', undefined],
    ['GET', '/agent-jobs/job-1/transcript', undefined],
    ['POST', '/agent-jobs', { toolId: 'shell', command: 'id' }],
    ['POST', '/agent-jobs/job-1/input', { input: 'continue' }],
    ['POST', '/agent-jobs/job-1/kill', undefined],
  ])('rejects ordinary users before job access: %s %s', async (method, route, body) => {
    const response = await request(server, method, route, 'USER', body);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Admin access required' });
  });

  test.each(['OWNER', 'SUB_ADMIN'])('retains intentional %s host-job access', async (role) => {
    const response = await request(server, 'POST', '/agent-jobs', role, {
      toolId: 'shell',
      command: 'id',
    });

    expect(response.status).toBe(201);
    expect(startAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      toolId: 'shell',
      command: 'id',
    }));
  });

  test.each([
    ['GET', '/agent-jobs', undefined],
    ['POST', '/agent-jobs/job-1/kill', undefined],
  ])('rejects a pending host operator before job access: %s %s', async (method, route, body) => {
    const response = await request(server, method, route, 'OWNER', body, 'PENDING');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Account pending approval' });
  });

  test('preserves service limit status codes for oversized host-job requests', async () => {
    startAgentJobMock.mockRejectedValue(Object.assign(new Error('command exceeds the job size limit'), {
      statusCode: 413,
    }));

    const response = await request(server, 'POST', '/agent-jobs', 'OWNER', {
      toolId: 'shell',
      command: 'oversized',
    });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'command exceeds the job size limit' });
  });

  test('serves only a bounded transcript tail to host operators', async () => {
    readTranscriptMock.mockResolvedValue([
      { type: 'output', stream: 'stdout', text: 'complete', timestamp: '2026-07-19T12:00:00.000Z' },
    ]);

    const response = await request(server, 'GET', '/agent-jobs/job-1/transcript?entries=25', 'OWNER');

    expect(response.status).toBe(200);
    expect(readTranscriptMock).toHaveBeenCalledWith('job-1', {
      maxEntries: 25,
      maxReadBytes: 512 * 1024,
    });
    expect(response.body).toEqual({
      jobId: 'job-1',
      transcript: [expect.objectContaining({ text: 'complete' })],
    });
  });

  test.each(['0', '501', '1.5', 'invalid'])(
    'rejects an invalid transcript entry bound: %s',
    async (entries) => {
      const response = await request(server, 'GET', `/agent-jobs/job-1/transcript?entries=${entries}`, 'OWNER');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'entries must be an integer from 1 to 500' });
      expect(readTranscriptMock).not.toHaveBeenCalled();
    },
  );
});
