import fs from 'node:fs';
import path from 'node:path';

const streamNativeOllama = jest.fn();
const resolveOllamaBackendAuthority = jest.fn();
const streamResolvedOllama = jest.fn();

jest.mock('../services/nativeOllamaTransport', () => {
  const actual = jest.requireActual('../services/nativeOllamaTransport');
  return {
    ...actual,
    streamNativeOllama,
  };
});

jest.mock('../services/ollamaBackendAuthority', () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  const actual = jest.requireActual('../services/ollamaBackendAuthority');
  return {
    ...actual,
    resolveOllamaBackendAuthority,
    streamResolvedOllama,
  };
});

import {
  OLLAMA_PULL_TIMEOUT_MS,
  ollamaPullManager,
  type OllamaPullSnapshot,
} from '../services/ollamaPullManager';
import {
  requestSetupLocalOllamaPull,
  setupLocalOllamaPullManager,
} from '../services/setupLocalOllamaPullManager';
import type {
  OllamaBackendAuthorityStreamResponse,
  ResolvedOllamaBackendAuthority,
  TailnetOllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';

const TAILNET_AUTHORITY: TailnetOllamaBackendAuthority = Object.freeze({
  kind: 'TAILNET',
  source: 'tailnet-binding',
  endpoint: null,
  generation: 7,
  version: 11,
  bindingFingerprint: `native-ollama-binding:v1:sha256:${'a'.repeat(64)}`,
  selectedModel: 'qwen3.5:4b',
  selectedModelDigest: `sha256:${'b'.repeat(64)}`,
});

function tailnetResolved(): ResolvedOllamaBackendAuthority {
  return {
    authority: TAILNET_AUTHORITY,
    bindingView: {
      purposeId: 'PRIMARY',
      authority: null,
      candidate: null,
    },
  };
}

function tailnetStreamResponse(): OllamaBackendAuthorityStreamResponse {
  return {
    authority: TAILNET_AUTHORITY,
    statusCode: 200,
    headers: Object.freeze({}),
    responseBytes: 21,
    streaming: true,
  };
}

function waitForCompletion(
  start: (onDone: (job: OllamaPullSnapshot) => void) => OllamaPullSnapshot,
): Promise<OllamaPullSnapshot> {
  return new Promise((resolve, reject) => {
    try {
      start(resolve);
    } catch (error) {
      reject(error);
    }
  });
}

describe('pre-owner setup Ollama pull policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupLocalOllamaPullManager.cancelAll();
    ollamaPullManager.cancelAll();
  });

  afterEach(() => {
    setupLocalOllamaPullManager.cancelAll();
    ollamaPullManager.cancelAll();
  });

  test('setup streams exactly once through literal loopback and never configured authority', async () => {
    let observedRequest: Record<string, unknown> | undefined;
    streamNativeOllama.mockImplementation(async (
      input: Record<string, unknown>,
      onChunk: (chunk: Buffer) => Promise<void> | void,
    ) => {
      observedRequest = {
        ...input,
        body: Buffer.from(input.body as Buffer),
      };
      await onChunk(Buffer.from('{"status":"success"}\n'));
      return {
        statusCode: 200,
        headers: Object.freeze({}),
        responseBytes: 21,
      };
    });

    const completed = await waitForCompletion((onDone) => (
      setupLocalOllamaPullManager.start('qwen3.5:4b', { onDone })
    ));

    expect(completed).toMatchObject({
      state: 'succeeded',
      authority: {
        kind: 'LOCAL',
        generation: null,
        version: null,
        fingerprint: 'local-ollama-v1:127.0.0.1:11434',
      },
    });
    expect(streamNativeOllama).toHaveBeenCalledTimes(1);
    expect(observedRequest).toMatchObject({
      endpoint: { address: '127.0.0.1', family: 4, port: 11434 },
      path: '/api/pull',
      method: 'POST',
      timeoutMs: OLLAMA_PULL_TIMEOUT_MS,
      maxResponseBytes: 64 * 1024 * 1024,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse((observedRequest?.body as Buffer).toString('utf8'))).toEqual({
      model: 'qwen3.5:4b',
      stream: true,
    });
    expect(resolveOllamaBackendAuthority).not.toHaveBeenCalled();
    expect(streamResolvedOllama).not.toHaveBeenCalled();
  });

  test('the authenticated Settings lane remains configured-authority aware', async () => {
    const resolved = tailnetResolved();
    resolveOllamaBackendAuthority.mockResolvedValue(resolved);
    streamResolvedOllama.mockImplementation(async (
      supplied: ResolvedOllamaBackendAuthority,
      request: Record<string, unknown>,
      onChunk: (chunk: Buffer) => Promise<void> | void,
    ) => {
      expect(supplied).toBe(resolved);
      expect(request).toMatchObject({
        path: '/api/pull',
        method: 'POST',
        json: { model: 'qwen3.5:4b', stream: true },
      });
      await onChunk(Buffer.from('{"status":"success"}\n'));
      return tailnetStreamResponse();
    });

    const completed = await waitForCompletion((onDone) => (
      ollamaPullManager.start('qwen3.5:4b', { onDone })
    ));

    expect(completed).toMatchObject({
      state: 'succeeded',
      authority: {
        kind: 'TAILNET',
        generation: 7,
        version: 11,
        fingerprint: TAILNET_AUTHORITY.bindingFingerprint,
      },
    });
    expect(streamNativeOllama).not.toHaveBeenCalled();
  });

  test('the exported setup request remains a dedicated local stream function', () => {
    expect(requestSetupLocalOllamaPull).toEqual(expect.any(Function));
    expect(requestSetupLocalOllamaPull).not.toBe(streamResolvedOllama);
  });

  test('route and shutdown wiring keep setup and Settings jobs separate', () => {
    const sourceRoot = path.resolve(__dirname, '..');
    const setupRoute = fs.readFileSync(
      path.join(sourceRoot, 'routes/setup-v3.ts'),
      'utf8',
    );
    const settingsRoute = fs.readFileSync(
      path.join(sourceRoot, 'routes/ollama.ts'),
      'utf8',
    );
    const server = fs.readFileSync(path.join(sourceRoot, 'server.ts'), 'utf8');

    expect(setupRoute).toContain('setupLocalOllamaPullManager.start(model');
    expect(setupRoute).toContain('setupLocalOllamaPullManager.cancel(job.id)');
    expect(setupRoute).not.toContain('ollamaPullManager.start(model');
    expect(settingsRoute).toMatch(
      /ollamaPullManager\.startBound\(\s*modelName,\s*expectedAuthority,\s*operationId,/u,
    );
    expect(server).toContain('ollamaPullManager.cancelAll()');
    expect(server).toContain('setupLocalOllamaPullManager.cancelAll()');
  });
});
