import http from 'http';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const skillsWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-skills-route-test-'));
process.env.OPENCLAW_WORKSPACE = skillsWorkspace;

const startAgentJobMock = jest.fn();
const execFileMock = jest.fn();
const execMock = jest.fn();
const spawnMock = jest.fn();
const spawnSyncMock = jest.fn();
const attestNativeHostCliMock = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: execFileMock,
  exec: execMock,
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

jest.mock('../services/agentJobs', () => ({
  startAgentJob: startAgentJobMock,
}));

jest.mock('../services/nativeHostCliAdmission', () => ({
  ...jest.requireActual('../services/nativeHostCliAdmission'),
  attestNativeHostCli: attestNativeHostCliMock,
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers['x-test-role']) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }
    req.user = {
      userId: 'user-1',
      email: 'test@example.com',
      role: String(req.headers['x-test-role'] || 'USER'),
      accountStatus: String(req.headers['x-test-status'] || 'ACTIVE'),
    };
    next();
  },
}));

jest.mock('../middleware/requireSetupComplete', () => ({
  requireSetupComplete: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import skillsRouter, {
  CLAWHUB_MARKETPLACE_UNAVAILABLE,
  mountHostExtensionMutationFence,
} from '../routes/skills';
import {
  NativeHostCliAdmissionError,
  type NativeHostCliAdmissionErrorCode,
} from '../services/nativeHostCliAdmission';

const admittedClawHub = Object.freeze({
  toolId: 'clawhub',
  executablePath: '/usr/bin/clawhub',
  packageName: 'clawhub',
  version: '0.23.3',
  fingerprint: 'a'.repeat(64),
  checkedAt: '2026-08-27T12:00:00.000Z',
});

type TestResponse = {
  status: number;
  body: any;
  text: string;
  headers: http.IncomingHttpHeaders;
};

async function rawRequest(server: http.Server, options: {
  role?: string;
  route: string;
  body?: string | Buffer;
  contentType?: string;
}): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body ?? '');
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
    'content-length': String(encoded.length),
  };
  if (options.role) headers['x-test-role'] = options.role;

  return new Promise<TestResponse>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: options.route,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode || 0, body, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

async function request(server: http.Server, role: string, route: string, body: unknown) {
  return rawRequest(server, {
    role,
    route,
    body: JSON.stringify(body),
    contentType: 'application/json',
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
    attestNativeHostCliMock.mockResolvedValue(admittedClawHub);
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
    mountHostExtensionMutationFence(app);
    app.use(express.json({ limit: '1kb' }));
    app.use('/api/skills', skillsRouter);
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

  test.each(['OWNER', 'SUB_ADMIN'])('serves the packaged portable guide to %s without calling any harness', async (role) => {
    const response = await getRequest(server, role, '/api/skills/portal-guide');
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('bridgesllm-portal');
    expect(response.body.content).toBe(fs.readFileSync(path.resolve(__dirname, '../../../skills/bridgesllm-portal/SKILL.md'), 'utf8'));
    expect(response.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  test.each(['USER', 'VIEWER'])('does not expose the host operating guide to %s', async (role) => {
    const response = await getRequest(server, role, '/api/skills/portal-guide');
    expect(response.status).toBe(403);
    expect(response.body.content).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test.each(['USER', 'VIEWER'])('rejects %s before a host mutation starts', async (role) => {
    const response = await request(server, role, '/api/skills/install', {
      name: 'weather',
      confirmation: 'INSTALL SKILL weather',
    });
    expect(response.status).toBe(403);
    expect(startAgentJobMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('authenticates and authorizes before reading malformed caller bytes', async () => {
    const privateMalformedBody = '{"private-extension-detail":';
    const unauthenticated = await rawRequest(server, {
      route: '/api/skills/plugins/install',
      body: privateMalformedBody,
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/json');
    expect(unauthenticated.body).toEqual({ error: 'Access token required' });
    expect(unauthenticated.text).not.toContain('private-extension-detail');

    const unauthorized = await rawRequest(server, {
      role: 'USER',
      route: '/api/skills/plugins/install',
      body: privateMalformedBody,
    });
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.headers['content-type']).toContain('application/json');
    expect(unauthorized.text).not.toContain('private-extension-detail');

    expect(startAgentJobMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('contains no generic AgentJob or shell mutation implementation', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/skills.ts'), 'utf8');
    expect(source).not.toMatch(/startAgentJob|AgentJobRequestError|\/bin\/bash|shellQuote|bridgesllm-agent-mutation\.lock/);
    expect(source).toContain("router.post('/install', sendHostExtensionMutationUnavailable)");
    expect(source).toContain("router.post('/uninstall', sendHostExtensionMutationUnavailable)");
    expect(source).toContain("router.post('/plugins/install', sendHostExtensionMutationUnavailable)");
  });

  it('mounts the exact mutation fence before the production body parser and read-only router', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');
    const fence = source.indexOf('mountHostExtensionMutationFence(app);');
    const parser = source.indexOf("app.use(express.json({ limit: '10mb' }));");
    const routerMount = source.indexOf("app.use('/api/skills', skillsRoutes);");

    expect(source.match(/app\.use\(express\.json\(/g)).toHaveLength(1);
    expect(source.indexOf('app.use(cookieParser());')).toBeLessThan(fence);
    expect(source.indexOf('rejectCookieAuthenticatedCrossOriginMutation(req)')).toBeLessThan(fence);
    expect(source.indexOf('isAppContentRequest(req)')).toBeLessThan(fence);
    expect(source.indexOf('mountGlobalApiRateLimit(app);')).toBeLessThan(fence);
    expect(source.indexOf('if (blockedIPs.has(ip))')).toBeLessThan(fence);
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThan(parser);
    expect(parser).toBeLessThan(routerMount);
  });

  it('labels only lock-tracked workspace skills as ClawHub-managed', async () => {
    const response = await getRequest(server, 'OWNER', '/api/skills?refresh=1');
    expect(response.status).toBe(200);
    expect(response.body.skills).toEqual([
      expect.objectContaining({ name: 'weather', source: 'managed', managed: true }),
      expect.objectContaining({ name: 'bridgesllm-portal', source: 'openclaw-workspace' }),
    ]);
  });

  it.each([
    ['/api/skills/install', {
      name: 'weather',
      confirmation: 'INSTALL SKILL weather',
    }],
    ['/api/skills/uninstall', {
      name: 'weather',
      confirmation: 'UNINSTALL SKILL weather',
    }],
    ['/api/skills/plugins/install', {
      spec: 'npm:package; touch /tmp/not-executed',
      confirmation: 'INSTALL PLUGIN npm:package; touch /tmp/not-executed',
    }],
  ])('returns the stable fail-closed contract for %s without starting any process', async (route, body) => {
    const response = await request(server, 'OWNER', route, body);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'HOST_EXTENSION_MUTATION_UNAVAILABLE',
      error: 'Portal-managed skill and OpenClaw plugin changes are unavailable until the transactional extension manager ships.',
      retryable: false,
      remediation: 'Use read-only extension status in Portal. Extension changes remain unavailable until provenance-bound, crash-recoverable transactions ship.',
    });
    expect(JSON.stringify(response.body).length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(response.body)).not.toContain('/tmp/not-executed');
    expect(startAgentJobMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{"private-extension-detail":', 'application/json'],
    ['an oversized JSON body', JSON.stringify({ spec: 'private-extension-detail-'.repeat(200) }), 'application/json'],
    ['plain text', 'private-extension-detail', 'text/plain'],
    ['URL-encoded input', 'spec=private-extension-detail', 'application/x-www-form-urlencoded'],
  ])('returns the same bounded unavailable contract for %s without parsing or echoing it', async (_label, body, contentType) => {
    const response = await rawRequest(server, {
      role: 'SUB_ADMIN',
      route: '/api/skills/plugins/install',
      body,
      contentType,
    });
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      code: 'HOST_EXTENSION_MUTATION_UNAVAILABLE',
      retryable: false,
    });
    expect(response.text.length).toBeLessThanOrEqual(512);
    expect(response.text).not.toContain('private-extension-detail');
    expect(startAgentJobMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('keeps read-only plugin status and marketplace inspection available', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(null, JSON.stringify({
      plugins: [{ id: 'acpx', version: '2026.7.1-2' }],
    }), ''));
    const plugins = await getRequest(server, 'OWNER', '/api/skills/plugins?refresh=1');
    expect(plugins.status).toBe(200);
    expect(plugins.body.plugins).toEqual([{ id: 'acpx', version: '2026.7.1-2' }]);
    expect(execFileMock).toHaveBeenLastCalledWith(
      'openclaw',
      ['plugins', 'list', '--json'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function),
    );

    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(null, JSON.stringify({
      slug: 'weather',
      summary: 'Read-only marketplace detail',
    }), ''));
    const inspected = await getRequest(server, 'OWNER', '/api/skills/inspect/weather');
    expect(inspected.status).toBe(200);
    expect(inspected.body).toEqual({ slug: 'weather', summary: 'Read-only marketplace detail' });
    expect(attestNativeHostCliMock).toHaveBeenCalledWith('clawhub', '/usr/bin/clawhub');
    expect(execFileMock).toHaveBeenLastCalledWith(
      '/usr/bin/clawhub',
      ['inspect', 'weather', '--json'],
      expect.objectContaining({
        encoding: 'utf-8',
        shell: false,
        env: expect.objectContaining({ PATH: '/usr/bin:/bin' }),
      }),
      expect.any(Function),
    );
  });

  it.each<[
    label: string,
    code: NativeHostCliAdmissionErrorCode,
    reason: string,
    route: string,
    includesResults: boolean,
  ]>([
    [
      'status-only',
      'STATUS_ONLY_VERSION',
      'ClawHub 0.23.1 is recognized for status only and cannot be executed by Portal.',
      '/api/skills/search?q=weather',
      true,
    ],
    [
      'absent',
      'ABSENT',
      'ClawHub is not installed.',
      '/api/skills/explore',
      true,
    ],
    [
      'drifted',
      'DRIFT_DETECTED',
      'ClawHub package tree does not match the signed catalog.',
      '/api/skills/inspect/weather',
      false,
    ],
    [
      'unsupported',
      'UNSUPPORTED_VERSION',
      'ClawHub 0.24.0 is not an admitted version.',
      '/api/skills/search?q=weather',
      true,
    ],
  ])('maps a %s ClawHub admission failure to the explicit unavailable contract', async (
    _label,
    code,
    reason,
    route,
    includesResults,
  ) => {
    attestNativeHostCliMock.mockRejectedValueOnce(new NativeHostCliAdmissionError(
      code,
      reason,
      code === 'ABSENT' ? null : '0.23.1',
    ));

    const response = await getRequest(server, 'OWNER', route);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: CLAWHUB_MARKETPLACE_UNAVAILABLE.code,
      state: 'unavailable',
      available: false,
      retryable: false,
      reason,
      reasonCode: code,
      remediation: CLAWHUB_MARKETPLACE_UNAVAILABLE.remediation,
      ...(includesResults ? { results: [] } : {}),
    });
    expect(attestNativeHostCliMock).toHaveBeenCalledWith('clawhub', '/usr/bin/clawhub');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does not swallow an admission failure in the explore search fallback', async () => {
    const drift = new NativeHostCliAdmissionError(
      'DRIFT_DETECTED',
      'ClawHub changed after the initial explore attempt.',
      '0.23.3',
    );
    attestNativeHostCliMock
      .mockResolvedValueOnce(admittedClawHub)
      .mockRejectedValue(drift);
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(
      Object.assign(new Error('ClawHub login required'), { code: 1 }),
      '',
      'ClawHub login required',
    ));

    const response = await getRequest(server, 'OWNER', '/api/skills/explore');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      state: 'unavailable',
      reasonCode: 'DRIFT_DETECTED',
      results: [],
    });
    expect(attestNativeHostCliMock.mock.calls.length).toBeGreaterThan(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/clawhub',
      ['explore', '--json', '--limit', '25', '--sort', 'trending'],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });

  it('does not degrade an enrichment admission failure into a partial search result', async () => {
    attestNativeHostCliMock
      .mockResolvedValueOnce(admittedClawHub)
      .mockRejectedValueOnce(new NativeHostCliAdmissionError(
        'RACE_DETECTED',
        'ClawHub changed before marketplace enrichment.',
        '0.23.3',
      ));
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(
      null,
      'weather  Friendly weather skill  (0.99)\n',
      '',
    ));

    const response = await getRequest(server, 'OWNER', '/api/skills/search?q=weather');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      state: 'unavailable',
      reasonCode: 'RACE_DETECTED',
      results: [],
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('maps post-attestation executable disappearance to the same unavailable contract', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(
      Object.assign(new Error('spawn /usr/bin/clawhub ENOENT'), { code: 'ENOENT' }),
      '',
      '',
    ));

    const response = await getRequest(server, 'OWNER', '/api/skills/search?q=weather');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      state: 'unavailable',
      reason: 'The admitted ClawHub executable changed before Portal could run it.',
      reasonCode: 'RACE_DETECTED',
      results: [],
    });
    expect(attestNativeHostCliMock).toHaveBeenCalledWith('clawhub', '/usr/bin/clawhub');
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/clawhub',
      ['search', 'weather', '--limit', '20'],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });
});
