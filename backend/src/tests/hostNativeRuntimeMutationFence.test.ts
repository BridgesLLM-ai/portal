import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

const execMock = jest.fn();
const execFileMock = jest.fn();
const execSyncMock = jest.fn();
const spawnMock = jest.fn();
const startAgentJobMock = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: execMock,
  execFile: execFileMock,
  execSync: execSyncMock,
  spawn: spawnMock,
}));

jest.mock('../services/agentJobs', () => ({
  AgentJobRequestError: class AgentJobRequestError extends Error {},
  startAgentJob: startAgentJobMock,
}));

jest.mock('../services/nativeHostCliStatus', () => ({
  getNativeHostCliStatus: jest.fn(async (toolId: string) => ({
    toolId,
    executablePath: toolId === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude',
    state: 'absent',
    installed: false,
    executionEligible: false,
    observedVersion: null,
    checkedAt: '2026-08-22T12:00:00.000Z',
    fingerprint: null,
    reasonCode: 'ABSENT',
  })),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    const role = String(req.headers['x-test-role'] || '');
    if (!role) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }
    req.user = {
      userId: 'user-1',
      email: 'test@example.com',
      role,
      accountStatus: 'ACTIVE',
      authorizationVersion: 1,
    };
    next();
  },
}));

jest.mock('../middleware/requireSetupComplete', () => ({
  requireSetupComplete: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import agentToolsRouter, {
  mountHostNativeRuntimeMutationFence,
} from '../routes/agent-tools';

type TestResponse = Readonly<{
  status: number;
  body: any;
  text: string;
  headers: http.IncomingHttpHeaders;
}>;

async function rawRequest(server: http.Server, options: {
  route: string;
  method?: 'GET' | 'POST';
  role?: string;
  setupPending?: boolean;
  setupToken?: boolean;
  body?: string | Buffer;
  contentType?: string;
}): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body ?? '');
  const headers: Record<string, string> = {};
  if (options.method !== 'GET') {
    headers['content-type'] = options.contentType ?? 'application/json';
    headers['content-length'] = String(encoded.length);
  }
  if (options.role) headers['x-test-role'] = options.role;
  if (options.setupPending) headers['x-test-setup-pending'] = '1';
  if (options.setupToken) headers['x-test-setup-token'] = '1';

  return new Promise<TestResponse>((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: options.method ?? 'POST',
      path: options.route,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any;
        try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
        resolve({ status: response.statusCode || 0, body, text, headers: response.headers });
      });
    });
    request.on('error', reject);
    request.end(options.method === 'GET' ? undefined : encoded);
  });
}

const unavailableContract = {
  code: 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE',
  error: 'Per-tool native host runtime changes are unavailable. Portal-qualified tools are updated only as one compatibility bundle.',
  retryable: false,
  remediation: 'Owner: use Admin > Maintenance > Update Compatible AI Tools for the exact OpenClaw, Codex, Claude Code, and ClawHub bundle. Do not update individual tools independently.',
};

describe('native host-runtime mutation fence', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    execMock.mockImplementation((_command, _options, callback) => callback(null, 'tool 1.2.3\n', ''));
    const app = express();
    mountHostNativeRuntimeMutationFence(app, {
      requireSetupComplete: (_req, _res, next) => next(),
      requireSetupPending: (req, res, next) => {
        if (req.headers['x-test-setup-pending'] === '1') next();
        else res.status(403).json({ error: 'Setup already completed' });
      },
      requireSetupToken: (req, res, next) => {
        if (req.headers['x-test-setup-token'] === '1') next();
        else res.status(403).json({ error: 'Invalid or missing setup session' });
      },
    });
    app.use(express.json({ limit: '1kb' }));
    app.use(express.urlencoded({ limit: '1kb', extended: true }));
    app.use('/api/agent-tools', agentToolsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['/api/admin/install-coding-tool', { role: 'OWNER' }],
    ['/api/setup/install-coding-tool', { setupPending: true, setupToken: true }],
    ['/api/agent-runtime/agent-zero/runtime/reconcile', { role: 'OWNER' }],
    ['/api/agent-tools/agent-zero/install', { role: 'OWNER' }],
    ['/api/agent-tools/claude-code/install', { role: 'OWNER' }],
    ['/api/agent-tools/codex/install', { role: 'SUB_ADMIN' }],
    ['/api/agent-tools/gemini/install', { role: 'SUB_ADMIN' }],
    ['/api/agent-tools/grok-build/install', { role: 'OWNER' }],
    ['/api/agent-tools/hermes/install', { role: 'SUB_ADMIN' }],
    ['/api/agent-tools/opencode/install', { role: 'OWNER' }],
  ])('returns one bounded unavailable contract for %s', async (route, authority) => {
    const response = await rawRequest(server, {
      route,
      ...authority,
      body: JSON.stringify({ package: 'private-caller-field', confirmation: 'anything' }),
    });
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailableContract);
    expect(response.text.length).toBeLessThanOrEqual(512);
    expect(response.text).not.toContain('private-caller-field');
    expect(startAgentJobMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{"private-native-field":', 'application/json'],
    ['oversized JSON', JSON.stringify({ spec: 'private-native-field-'.repeat(200) }), 'application/json'],
    ['plain text', 'private-native-field', 'text/plain'],
    ['URL encoded', 'spec=private-native-field', 'application/x-www-form-urlencoded'],
  ])('does not parse or echo authorized %s', async (_label, body, contentType) => {
    const response = await rawRequest(server, {
      route: '/api/agent-tools/gemini/install',
      role: 'OWNER',
      body,
      contentType,
    });
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual(unavailableContract);
    expect(response.text).not.toContain('private-native-field');
  });

  it.each([
    ['malformed JSON', '{"private-agent-zero-field":'],
    ['oversized JSON', JSON.stringify({ spec: 'private-agent-zero-field-'.repeat(200) })],
  ])('fences Agent Zero reconcile before parsing authorized %s', async (_label, body) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const response = await rawRequest(server, {
        route: '/api/agent-runtime/agent-zero/runtime/reconcile',
        role: 'OWNER',
        body,
      });
      expect(response.status).toBe(503);
      expect(response.body).toEqual(unavailableContract);
      expect(response.text).not.toContain('private-agent-zero-field');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(startAgentJobMock).not.toHaveBeenCalled();
      expect(execMock).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('runs setup/auth/role policy before the fixed response and caller bytes', async () => {
    const malformed = '{"private-native-field":';
    const unauthenticated = await rawRequest(server, {
      route: '/api/admin/install-coding-tool',
      body: malformed,
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.text).not.toContain('private-native-field');

    const nonOwner = await rawRequest(server, {
      route: '/api/admin/install-coding-tool',
      role: 'SUB_ADMIN',
      body: malformed,
    });
    expect(nonOwner.status).toBe(403);
    expect(nonOwner.text).not.toContain('private-native-field');

    const ordinaryUser = await rawRequest(server, {
      route: '/api/agent-tools/grok-build/install',
      role: 'USER',
      body: malformed,
    });
    expect(ordinaryUser.status).toBe(403);
    expect(ordinaryUser.text).not.toContain('private-native-field');

    const agentZeroUnauthenticated = await rawRequest(server, {
      route: '/api/agent-runtime/agent-zero/runtime/reconcile',
      body: malformed,
    });
    expect(agentZeroUnauthenticated.status).toBe(401);
    expect(agentZeroUnauthenticated.text).not.toContain('private-native-field');

    const agentZeroNonOwner = await rawRequest(server, {
      route: '/api/agent-runtime/agent-zero/runtime/reconcile',
      role: 'SUB_ADMIN',
      body: malformed,
    });
    expect(agentZeroNonOwner.status).toBe(403);
    expect(agentZeroNonOwner.text).not.toContain('private-native-field');

    const missingSetupToken = await rawRequest(server, {
      route: '/api/setup/install-coding-tool',
      setupPending: true,
      body: malformed,
    });
    expect(missingSetupToken.status).toBe(403);
    expect(missingSetupToken.text).not.toContain('private-native-field');
  });

  it('keeps native detection read-only while an unrelated FFmpeg recipe remains separately available', async () => {
    const response = await rawRequest(server, {
      route: '/api/agent-tools?refresh=1',
      method: 'GET',
      role: 'OWNER',
    });
    expect(response.status).toBe(200);
    const byId = new Map(response.body.tools.map((tool: any) => [tool.id, tool]));
    expect(byId.get('gemini')).toMatchObject({ install: [], status: { installAvailable: false } });
    expect(byId.get('grok-build')).toMatchObject({ install: [], status: { installAvailable: false } });
    expect(byId.get('ffmpeg')).toMatchObject({ status: { installAvailable: true } });
    expect(startAgentJobMock).not.toHaveBeenCalled();
  });

  it('mounts after security policy and before parsers, with no raw native acquisition command left', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');
    const fence = serverSource.indexOf('mountHostNativeRuntimeMutationFence(app, {');
    const parser = serverSource.indexOf("app.use(express.json({ limit: '10mb' }));");
    expect(serverSource.indexOf('rejectCookieAuthenticatedCrossOriginMutation(req)')).toBeLessThan(fence);
    expect(serverSource.indexOf('isAppContentRequest(req)')).toBeLessThan(fence);
    expect(serverSource.indexOf('mountGlobalApiRateLimit(app);')).toBeLessThan(fence);
    expect(serverSource.indexOf('if (blockedIPs.has(ip))')).toBeLessThan(fence);
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThan(parser);

    const productionSources = [
      '../config/toolAdapters.ts',
      '../routes/admin.ts',
      '../routes/setup-v3.ts',
      '../routes/agent-runtime.ts',
      '../utils/serverSetup.ts',
    ].map((relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8')).join('\n');
    expect(productionSources).not.toMatch(/(?:grok-build|antigravity)-runtime\.sh converge/);
    expect(productionSources).not.toContain('installCodingTool(');
    expect(productionSources).not.toContain('reconcileAgentZeroRuntime(');

    const frontendRoot = path.join(__dirname, '../../../frontend/src');
    const setupPage = fs.readFileSync(path.join(frontendRoot, 'pages/SetupWizardPage.tsx'), 'utf8');
    const settingsPage = fs.readFileSync(path.join(frontendRoot, 'pages/SettingsPage.tsx'), 'utf8');
    const toolsPage = fs.readFileSync(path.join(frontendRoot, 'pages/ToolsPage.tsx'), 'utf8');
    const chat = fs.readFileSync(path.join(frontendRoot, 'components/chat/ChatInterface.tsx'), 'utf8');
    const agentZeroPanel = fs.readFileSync(path.join(frontendRoot, 'components/settings/AgentZeroSetupPanel.tsx'), 'utf8');
    const agentRuntimeApi = fs.readFileSync(path.join(frontendRoot, 'api/agentRuntime.ts'), 'utf8');
    expect(setupPage).not.toContain("'/setup/install-coding-tool'");
    expect(settingsPage).not.toContain("'/admin/install-coding-tool'");
    expect(agentZeroPanel).not.toContain('reconcileAgentZeroRuntime');
    expect(agentRuntimeApi).not.toContain('/agent-runtime/agent-zero/runtime/reconcile');
    expect(toolsPage.indexOf('NATIVE_RUNTIME_MUTATION_UNAVAILABLE_TOOL_IDS.has(tool.id)'))
      .toBeLessThan(toolsPage.indexOf('agentToolsAPI.install(tool.id, confirmation'));
    expect(chat.indexOf('PORTAL_NATIVE_RUNTIME_MAINTENANCE_ONLY_TOOL_IDS.has(tool.id)'))
      .toBeLessThan(chat.indexOf('agentToolsAPI.install(toolId, confirmation)'));
    for (const toolId of ['agent-zero', 'antigravity', 'gemini', 'grok-build', 'hermes', 'opencode']) {
      expect(toolsPage).toContain(`'${toolId}'`);
      expect(chat).toContain(`'${toolId}'`);
    }
  });
});
