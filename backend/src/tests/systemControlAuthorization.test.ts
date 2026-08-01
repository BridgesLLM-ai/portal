import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const unloadAllOllamaModelsMock = jest.fn();
const restartLocalOllamaServiceMock = jest.fn();
const getLocalOllamaRestartCapabilityMock = jest.fn();
const getOllamaRuntimeStatusMock = jest.fn();
const activityCreateMock = jest.fn();

jest.mock('../services/ollamaSystemControl', () => {
  class OllamaSystemControlError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly statusCode = 502,
    ) {
      super(message);
    }
  }
  return {
    OllamaSystemControlError,
    unloadAllOllamaModels: unloadAllOllamaModelsMock,
    restartLocalOllamaService: restartLocalOllamaServiceMock,
    getLocalOllamaRestartCapability: getLocalOllamaRestartCapabilityMock,
    getOllamaRuntimeStatus: getOllamaRuntimeStatusMock,
  };
});

jest.mock('../config/database', () => ({
  prisma: { activityLog: { create: activityCreateMock } },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'operator-1',
      email: 'operator@example.com',
      role: String(req.headers['x-test-role'] || 'USER'),
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

import systemControlRouter from '../routes/system-control';
import {
  OLLAMA_AUTHORITY_BUSY_MESSAGE,
  withOllamaAuthorityRunLease,
} from '../services/ollamaAuthorityBarrier';

async function request(
  server: http.Server,
  role: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
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

describe('Ollama system-control authorization', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    activityCreateMock.mockResolvedValue(undefined);
    unloadAllOllamaModelsMock.mockResolvedValue({ unloadedModels: ['llama3.2:3b'], alreadyIdle: false });
    restartLocalOllamaServiceMock.mockResolvedValue({ active: true, version: '0.11.7' });
    getLocalOllamaRestartCapabilityMock.mockResolvedValue({
      available: true,
      code: null,
      message: null,
      statusCode: null,
    });
    getOllamaRuntimeStatusMock.mockResolvedValue({
      available: true,
      backend: 'cpu-local',
      version: '0.11.7',
      models: [],
      runningModels: ['llama3.2:3b'],
      isGpu: false,
      authority: {
        kind: 'LOCAL',
        generation: null,
        version: null,
        bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
        displayName: null,
        selectedModel: null,
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/system-control', systemControlRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('keeps Ollama inventory and authority status Owner-only', async () => {
    for (const route of [
      '/system-control/ollama/status',
      '/system-control/ollama/model-status?model=llama3.2%3A3b',
      '/system-control/ollama/proxy-status',
    ]) {
      const user = await request(server, 'USER', 'GET', route);
      expect(user.status).toBe(403);

      const admin = await request(server, 'SUB_ADMIN', 'GET', route);
      expect(admin.status).toBe(403);
    }
    expect(getOllamaRuntimeStatusMock).not.toHaveBeenCalled();

    const owner = await request(server, 'OWNER', 'GET', '/system-control/ollama/proxy-status');
    expect(owner.status).toBe(200);
    expect(owner.body.controls).toMatchObject({
      unload: { allowed: true, confirmationPhrase: 'UNLOAD OLLAMA MODELS' },
      restart: { allowed: true, confirmationPhrase: 'RESTART OLLAMA' },
    });
  });

  test('rejects non-owners and missing typed confirmation before any host mutation', async () => {
    const admin = await request(server, 'SUB_ADMIN', 'POST', '/system-control/ollama/restart', {
      confirmation: 'RESTART OLLAMA',
    });
    expect(admin.status).toBe(403);

    const unconfirmed = await request(server, 'OWNER', 'POST', '/system-control/ollama/kill', {});
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.confirmationPhrase).toBe('UNLOAD OLLAMA MODELS');

    const wrongCase = await request(server, 'OWNER', 'POST', '/system-control/ollama/restart', {
      confirmation: 'restart ollama',
    });
    expect(wrongCase.status).toBe(400);
    expect(wrongCase.body.confirmationPhrase).toBe('RESTART OLLAMA');
    expect(unloadAllOllamaModelsMock).not.toHaveBeenCalled();
    expect(restartLocalOllamaServiceMock).not.toHaveBeenCalled();
  });

  test('executes confirmed owner controls and returns verified outcomes', async () => {
    const unloaded = await request(server, 'OWNER', 'POST', '/system-control/ollama/kill', {
      confirmation: 'UNLOAD OLLAMA MODELS',
    });
    expect(unloaded.status).toBe(200);
    expect(unloaded.body).toMatchObject({
      success: true,
      unloadedModels: ['llama3.2:3b'],
      alreadyIdle: false,
      verified: true,
    });

    const restarted = await request(server, 'OWNER', 'POST', '/system-control/ollama/restart', {
      confirmation: 'RESTART OLLAMA',
    });
    expect(restarted.status).toBe(200);
    expect(restarted.body).toMatchObject({
      success: true,
      active: true,
      version: '0.11.7',
      verified: true,
    });
    expect(activityCreateMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      label: 'unload',
      route: '/system-control/ollama/kill',
      confirmation: 'UNLOAD OLLAMA MODELS',
      destructiveMock: unloadAllOllamaModelsMock,
    },
    {
      label: 'restart',
      route: '/system-control/ollama/restart',
      confirmation: 'RESTART OLLAMA',
      destructiveMock: restartLocalOllamaServiceMock,
    },
  ])(
    'rejects owner $label while an Ollama authority run lease is active',
    async ({ route, confirmation, destructiveMock }) => {
      let releaseRun!: () => void;
      const activeRun = withOllamaAuthorityRunLease(() => new Promise<void>((resolve) => {
        releaseRun = resolve;
      }));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const response = await request(server, 'OWNER', 'POST', route, { confirmation });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          success: false,
          error: OLLAMA_AUTHORITY_BUSY_MESSAGE,
          code: 'OLLAMA_AUTHORITY_BUSY',
        });
        expect(destructiveMock).not.toHaveBeenCalled();
        expect(unloadAllOllamaModelsMock).not.toHaveBeenCalled();
        expect(restartLocalOllamaServiceMock).not.toHaveBeenCalled();
      } finally {
        releaseRun();
        await activeRun;
        consoleErrorSpy.mockRestore();
      }
    },
  );

  test('keeps control actions single-flight across duplicate requests', async () => {
    let releaseUnload!: (value: { unloadedModels: string[]; alreadyIdle: boolean }) => void;
    unloadAllOllamaModelsMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseUnload = resolve;
    }));

    const first = request(server, 'OWNER', 'POST', '/system-control/ollama/kill', {
      confirmation: 'UNLOAD OLLAMA MODELS',
    });
    while (unloadAllOllamaModelsMock.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const duplicate = await request(server, 'OWNER', 'POST', '/system-control/ollama/restart', {
      confirmation: 'RESTART OLLAMA',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      success: false,
      code: 'OLLAMA_REJECTED',
    });
    expect(restartLocalOllamaServiceMock).not.toHaveBeenCalled();

    releaseUnload({ unloadedModels: ['llama3.2:3b'], alreadyIdle: false });
    expect((await first).status).toBe(200);
  });

  test('keeps restart available when the proxy is offline', async () => {
    getOllamaRuntimeStatusMock.mockResolvedValueOnce({
      available: false,
      backend: 'offline',
      version: null,
      models: [],
      runningModels: [],
      isGpu: false,
      authority: null,
    });
    const owner = await request(server, 'OWNER', 'GET', '/system-control/ollama/proxy-status');
    expect(owner.body).toMatchObject({
      available: false,
      controls: {
        unload: { available: false },
        restart: { allowed: true, available: true },
      },
    });
  });

  test('reports exact remote authority metadata, keeps unload available, and disables host restart', async () => {
    getOllamaRuntimeStatusMock.mockResolvedValueOnce({
      available: true,
      backend: 'tailnet',
      version: '0.32.0',
      models: [
        { name: 'qwen3.5:9b', size: '9B', family: 'qwen3' },
        { name: 'llama3.2:3b', size: '3B', family: 'llama' },
      ],
      runningModels: ['qwen3.5:9b', 'llama3.2:3b'],
      isGpu: true,
      authority: {
        kind: 'TAILNET',
        generation: 7,
        version: 3,
        bindingFingerprint: 'native-binding-7',
        displayName: null,
        selectedModel: 'qwen3.5:9b',
      },
    });
    getLocalOllamaRestartCapabilityMock.mockResolvedValue({
      available: false,
      code: 'OLLAMA_REJECTED',
      message: 'Local restart controls the Portal host, not the Windows Ollama service.',
      statusCode: 409,
    });

    const owner = await request(server, 'OWNER', 'GET', '/system-control/ollama/proxy-status');

    expect(owner.status).toBe(200);
    expect(Object.keys(owner.body.authority).sort()).toEqual([
      'bindingFingerprint',
      'displayName',
      'generation',
      'kind',
      'selectedModel',
      'version',
    ]);
    expect(owner.body).toMatchObject({
      models: [
        { name: 'qwen3.5:9b' },
        { name: 'llama3.2:3b' },
      ],
      runningModels: ['qwen3.5:9b', 'llama3.2:3b'],
      controls: {
        unload: { allowed: true, available: true },
        restart: { allowed: true, available: false },
      },
    });
  });

  test('rejects a confirmed manual host restart when native authority reserves Ollama', async () => {
    getLocalOllamaRestartCapabilityMock.mockResolvedValue({
      available: false,
      code: 'OLLAMA_REJECTED',
      message: 'Local restart controls the Portal host, not the Windows Ollama service.',
      statusCode: 409,
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(server, 'OWNER', 'POST', '/system-control/ollama/restart', {
        confirmation: 'RESTART OLLAMA',
      });

      expect(response).toEqual({
        status: 409,
        body: {
          success: false,
          error: 'Local restart controls the Portal host, not the Windows Ollama service.',
          code: 'OLLAMA_REJECTED',
        },
      });
      expect(restartLocalOllamaServiceMock).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test('fails a confirmed manual restart closed when native authority cannot be verified', async () => {
    getLocalOllamaRestartCapabilityMock.mockResolvedValue({
      available: false,
      code: 'OLLAMA_UNAVAILABLE',
      message: 'Portal could not verify native authority.',
      statusCode: 503,
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(server, 'OWNER', 'POST', '/system-control/ollama/restart', {
        confirmation: 'RESTART OLLAMA',
      });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        success: false,
        code: 'OLLAMA_UNAVAILABLE',
      });
      expect(restartLocalOllamaServiceMock).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
