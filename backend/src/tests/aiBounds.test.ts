import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const systemSettingFindUnique = jest.fn();
const mockRequestConfiguredOllamaJson = jest.fn();
const mockAuthState: {
  role: 'USER' | 'OWNER';
  approved: boolean;
  authorityKind: 'LOCAL' | 'TAILNET';
  selectedModel: string | null;
  generation: number | null;
} = {
  role: 'USER',
  approved: true,
  authorityKind: 'LOCAL',
  selectedModel: null,
  generation: null,
};

jest.mock('../config/database', () => ({
  prisma: { systemSetting: { findUnique: systemSettingFindUnique } },
}));

jest.mock('../config/env', () => ({
  config: { ollamaApiUrl: 'http://127.0.0.1:11434', ollamaModel: 'qwen3.5:4b' },
}));

jest.mock('../services/ollamaBackendAuthority', () => {
  class OllamaBackendAuthorityError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode = 503,
    ) {
      super(`authority:${code}`);
      this.name = 'OllamaBackendAuthorityError';
    }
  }
  const authority = {
    get kind() { return mockAuthState.authorityKind; },
    source: 'local-policy',
    endpoint: 'http://127.0.0.1:11434',
    get generation() { return mockAuthState.generation; },
    version: null,
    bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
    get selectedModel() { return mockAuthState.selectedModel; },
    selectedModelDigest: null,
  };
  return {
    OllamaBackendAuthorityError,
    resolveOllamaBackendAuthority: jest.fn(async () => ({
      authority,
      bindingView: { purposeId: 'PRIMARY', authority: null, candidate: null },
    })),
    requestResolvedOllamaJson: jest.fn(async (_resolved, input) => ({
      authority,
      value: await mockRequestConfiguredOllamaJson(input),
    })),
    requestConfiguredOllamaJson: jest.fn(async (input) => ({
      authority,
      value: await mockRequestConfiguredOllamaJson(input),
    })),
  };
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      email: 'test@example.com',
      role: mockAuthState.role,
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

jest.mock('../middleware/requireApproved', () => ({
  requireApproved: (_req: Request, res: Response, next: NextFunction) => {
    if (!mockAuthState.approved) {
      res.status(403).json({ error: 'Account approval required' });
      return;
    }
    next();
  },
}));

jest.mock('../middleware/pathSandbox', () => ({
  aiPathSandbox: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../utils/workspaceScope', () => ({ getWorkspaceOwnerId: jest.fn(async () => 'user-1') }));
jest.mock('../services/containedPath', () => ({ resolveContainedPath: jest.fn() }));
jest.mock('../routes/files', () => ({ resolveFilePath: jest.fn() }));

import aiRouter from '../routes/ai';
import { resolveFilePath } from '../routes/files';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import {
  withWorkspaceAuthorizationFence,
  workspaceAuthorizationBarrierSnapshot,
} from '../services/workspaceAuthorizationBarrier';
import { OllamaBackendAuthorityError } from '../services/ollamaBackendAuthority';

type TestResponse = { status: number; body: any };

async function request(server: http.Server, path: string, body: unknown): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json', 'content-length': String(encoded.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

async function get(server: http.Server, path: string): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'GET',
      path,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
}

describe('AI request and upstream response bounds', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAuthState.role = 'USER';
    mockAuthState.approved = true;
    mockAuthState.authorityKind = 'LOCAL';
    mockAuthState.selectedModel = null;
    mockAuthState.generation = null;
    systemSettingFindUnique.mockResolvedValue(null);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/ai', aiRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('rejects oversized chat input before contacting Ollama', async () => {
    const response = await request(server, '/ai/chat', { message: 'x'.repeat(32_769) });
    expect(response.status).toBe(400);
    expect(mockRequestConfiguredOllamaJson).not.toHaveBeenCalled();
  });

  test('redacts Ollama inventory and authority details for non-owners', async () => {
    mockRequestConfiguredOllamaJson.mockResolvedValueOnce({
      models: [
        { name: 'qwen3.5:4b' },
        { name: 'private-model:latest' },
      ],
    });
    const member = await get(server, '/ai/ollama-status');
    expect(member).toEqual({
      status: 200,
      body: {
        available: true,
        models: ['qwen3.5:4b'],
        defaultModel: 'qwen3.5:4b',
      },
    });

    mockAuthState.role = 'OWNER';
    mockRequestConfiguredOllamaJson.mockResolvedValueOnce({
      models: [
        { name: 'qwen3.5:4b' },
        { name: 'private-model:latest' },
      ],
    });

    const owner = await get(server, '/ai/ollama-status');
    expect(owner).toEqual({
      status: 200,
      body: {
        available: true,
        models: ['qwen3.5:4b', 'private-model:latest'],
        defaultModel: 'qwen3.5:4b',
        backend: 'local',
        generation: null,
      },
    });
  });

  test('rejects unapproved Ollama status reads before contacting the backend', async () => {
    mockAuthState.approved = false;

    expect(await get(server, '/ai/ollama-status')).toEqual({
      status: 403,
      body: { error: 'Account approval required' },
    });
    expect(mockRequestConfiguredOllamaJson).not.toHaveBeenCalled();
  });

  test('advertises only the exact active Tailnet model used by inference', async () => {
    mockAuthState.role = 'OWNER';
    mockAuthState.authorityKind = 'TAILNET';
    mockAuthState.selectedModel = 'qwen3.5:4b';
    mockAuthState.generation = 7;
    mockRequestConfiguredOllamaJson.mockResolvedValueOnce({
      models: [
        { name: 'qwen3.5:4b' },
        { name: 'different-installed-model:latest' },
      ],
    });

    expect(await get(server, '/ai/ollama-status')).toEqual({
      status: 200,
      body: {
        available: true,
        models: ['qwen3.5:4b'],
        defaultModel: 'qwen3.5:4b',
        backend: 'tailnet',
        generation: 7,
      },
    });
  });

  test('maps upstream timeout and oversized responses to bounded errors', async () => {
    mockRequestConfiguredOllamaJson.mockRejectedValueOnce(
      new OllamaBackendAuthorityError('TIMED_OUT', 504),
    );
    expect(await request(server, '/ai/chat', { message: 'hello' })).toMatchObject({ status: 504 });

    mockRequestConfiguredOllamaJson.mockRejectedValueOnce(
      new OllamaBackendAuthorityError(
        'RESPONSE_TOO_LARGE',
        502,
      ),
    );
    expect(await request(server, '/ai/chat', { message: 'hello' })).toMatchObject({ status: 502 });
  });

  test('returns a valid bounded Ollama response', async () => {
    mockRequestConfiguredOllamaJson.mockResolvedValueOnce({ response: 'bounded reply' });
    const response = await request(server, '/ai/chat', { message: 'hello', context: 'small context' });
    expect(response).toEqual({
      status: 200,
      body: { response: 'bounded reply', model: 'qwen3.5:4b' },
    });
    expect(mockRequestConfiguredOllamaJson).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/generate',
      method: 'POST',
      timeoutMs: 120_000,
      maxResponseBytes: 2 * 1024 * 1024,
      json: expect.objectContaining({ prompt: expect.stringContaining('hello') }),
    }));
  });

  test('does not follow an Ollama redirect carrying user content', async () => {
    mockRequestConfiguredOllamaJson.mockRejectedValueOnce(
      new OllamaBackendAuthorityError(
        'HTTP_STATUS',
        502,
      ),
    );

    const response = await request(server, '/ai/chat', { message: 'private prompt' });

    expect(response).toMatchObject({
      status: 200,
      body: { model: 'unavailable' },
    });
    expect(mockRequestConfiguredOllamaJson).toHaveBeenCalledTimes(1);
  });

  test('aborts a delayed owner-scoped analysis response before an authorization change commits', async () => {
    let resolveOllama!: (response: unknown) => void;
    mockRequestConfiguredOllamaJson.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOllama = resolve;
    }));
    (resolveFilePath as jest.Mock).mockReturnValue(__filename);

    const pendingResult = request(server, '/ai/analyze', { filePath: 'aiBounds.test.ts' })
      .then(
        (response) => ({ response, error: null }),
        (error: Error) => ({ response: null, error }),
      );

    await waitFor(() => (
      mockRequestConfiguredOllamaJson.mock.calls.length === 1
      && workspaceAuthorizationBarrierSnapshot('user-1').reads === 1
    ));

    const commit = jest.fn(async () => 'committed');
    await expect(withWorkspaceAuthorizationFence('user-1', commit)).resolves.toBe('committed');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(workspaceAuthorizationBarrierSnapshot('user-1').reads).toBe(0);

    resolveOllama({ response: 'must not reach the old client' });
    const outcome = await pendingResult;
    expect(outcome.response).toBeNull();
    expect(outcome.error).toBeTruthy();
  });

  test('admits owner-scoped file-content reads to the same authorization barrier', async () => {
    let resolveOwner!: (ownerId: string) => void;
    (getWorkspaceOwnerId as jest.Mock).mockImplementationOnce(() => (
      new Promise<string>((resolve) => { resolveOwner = resolve; })
    ));
    (resolveFilePath as jest.Mock).mockReturnValue(__filename);

    const pendingResult = get(server, '/ai/file-content?path=aiBounds.test.ts')
      .then(
        (response) => ({ response, error: null }),
        (error: Error) => ({ response: null, error }),
      );

    await waitFor(() => workspaceAuthorizationBarrierSnapshot('user-1').reads === 1);
    await expect(withWorkspaceAuthorizationFence('user-1', async () => 'committed'))
      .resolves.toBe('committed');

    resolveOwner('user-1');
    const outcome = await pendingResult;
    expect(outcome.response).toBeNull();
    expect(outcome.error).toBeTruthy();
  });
});
