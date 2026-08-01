const resolveOllamaBackendAuthority = jest.fn();
const streamResolvedOllama = jest.fn();

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
  OllamaPullBusyError,
  OllamaPullManager,
  localOllamaCliEnvironment,
  type OllamaPullSnapshot,
  type OllamaPullStreamRequest,
} from '../services/ollamaPullManager';
import type {
  LocalOllamaBackendAuthority,
  OllamaBackendAuthorityStreamResponse,
  ResolvedOllamaBackendAuthority,
  TailnetOllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';

const LOCAL_AUTHORITY: LocalOllamaBackendAuthority = Object.freeze({
  kind: 'LOCAL',
  source: 'local-policy',
  endpoint: 'http://127.0.0.1:11434',
  generation: null,
  version: null,
  bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
  selectedModel: null,
  selectedModelDigest: null,
});
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TAILNET_AUTHORITY: TailnetOllamaBackendAuthority = Object.freeze({
  kind: 'TAILNET',
  source: 'tailnet-binding',
  endpoint: null,
  generation: 7,
  version: 11,
  bindingFingerprint: 'native-ollama-v1:peer-7',
  selectedModel: 'qwen3.5:4b',
  selectedModelDigest: DIGEST,
});

function streamResponse(): OllamaBackendAuthorityStreamResponse {
  return {
    authority: LOCAL_AUTHORITY,
    statusCode: 200,
    headers: Object.freeze({}),
    responseBytes: 0,
    streaming: true,
  };
}

function localResolved(): ResolvedOllamaBackendAuthority {
  return {
    authority: LOCAL_AUTHORITY,
    bindingView: {
      purposeId: 'PRIMARY',
      authority: null,
      candidate: null,
    },
  };
}

function tailnetResolved(): ResolvedOllamaBackendAuthority {
  return {
    authority: TAILNET_AUTHORITY,
    bindingView: {
      purposeId: 'PRIMARY',
      authority: {} as any,
      candidate: null,
    },
  };
}

function successfulRequest(
  chunks: readonly Buffer[],
): OllamaPullStreamRequest {
  return async (_model, _signal, onChunk, onAuthority) => {
    onAuthority(LOCAL_AUTHORITY);
    for (const chunk of chunks) await onChunk(chunk);
    return streamResponse();
  };
}

function waitForDone(
  manager: OllamaPullManager,
  model = 'qwen3.5:4b',
): Promise<OllamaPullSnapshot> {
  return new Promise((resolve, reject) => {
    try {
      manager.start(model, { onDone: resolve });
    } catch (error) {
      reject(error);
    }
  });
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('Ollama pull manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retains real layer progress and clears it for status-only terminal phases', async () => {
    const payload = Buffer.from([
      '{"status":"pulling manifest"}',
      `{"status":"pulling ${DIGEST}","digest":"${DIGEST}","total":100,"completed":25}`,
      `{"status":"pulling ${DIGEST}","digest":"${DIGEST}","total":100,"completed":100}`,
      '{"status":"verifying sha256 digest"}',
      '{"status":"writing manifest"}',
      '{"status":"success"}',
      '',
    ].join('\n'));
    const chunks = [...payload].map((byte) => Buffer.from([byte]));
    const progress: OllamaPullSnapshot[] = [];
    const manager = new OllamaPullManager(successfulRequest(chunks));
    const completed = await new Promise<OllamaPullSnapshot>((resolve) => {
      manager.start('qwen3.5:4b', {
        onProgress: (snapshot) => progress.push(snapshot),
        onDone: resolve,
      });
    });

    expect(progress.some((snapshot) => snapshot.percent === 25)).toBe(true);
    expect(progress.some((snapshot) => snapshot.percent === 100)).toBe(true);
    for (const status of ['verifying sha256 digest', 'writing manifest']) {
      expect(progress.find((snapshot) => snapshot.status === status))
        .toMatchObject({
          digest: null,
          totalBytes: null,
          completedBytes: null,
          percent: null,
          speedBytesPerSecond: null,
          etaSeconds: null,
        });
    }
    expect(completed).toMatchObject({
      state: 'succeeded',
      phase: 'complete',
      status: 'success',
      digest: null,
      totalBytes: null,
      completedBytes: null,
      percent: null,
      etaSeconds: null,
      canCancel: false,
      error: null,
      authority: {
        kind: 'LOCAL',
        generation: null,
        fingerprint: LOCAL_AUTHORITY.bindingFingerprint,
      },
    });
    expect(completed.eventSeq).toBe(6);
  });

  test('shows genuine indeterminate progress when Ollama has not reported total bytes', async () => {
    const manager = new OllamaPullManager(successfulRequest([
      Buffer.from('{"status":"pulling manifest"}\n'),
      Buffer.from('{"status":"success"}\n'),
    ]));
    const completed = await waitForDone(manager);

    expect(completed).toMatchObject({
      state: 'succeeded',
      totalBytes: null,
      completedBytes: null,
      percent: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
    });
  });

  test('allows one authority-bound pull and blocks duplicates while it is settling', async () => {
    let settle!: () => void;
    const request: OllamaPullStreamRequest = (
      _model,
      _signal,
      onChunk,
      onAuthority,
    ) => new Promise((resolve) => {
      onAuthority(LOCAL_AUTHORITY);
      settle = () => {
        void Promise.resolve(onChunk(Buffer.from('{"status":"success"}\n'))).then(() => {
          resolve(streamResponse());
        });
      };
    });
    const manager = new OllamaPullManager(request);
    const started = manager.start('qwen3.5:4b');

    expect(started.state).toBe('running');
    expect(() => manager.start('qwen3.5:4b')).toThrow(OllamaPullBusyError);
    expect(() => manager.start('qwen3.5:9b')).toThrow(OllamaPullBusyError);
    settle();
    await settleAsyncWork();
    expect(manager.get(started.id)?.state).toBe('succeeded');
  });

  test('admits a Settings pull only against the exact current authority snapshot', async () => {
    const resolved = tailnetResolved();
    resolveOllamaBackendAuthority.mockResolvedValue(resolved);
    streamResolvedOllama.mockImplementation(async (
      supplied,
      _request,
      consumer,
    ) => {
      expect(supplied).toBe(resolved);
      await consumer(Buffer.from('{"status":"success"}\n'));
      return {
        authority: TAILNET_AUTHORITY,
        statusCode: 200,
        headers: Object.freeze({}),
        responseBytes: 21,
        streaming: true as const,
      };
    });
    const manager = new OllamaPullManager();

    await expect(manager.startBound('qwen3.5:4b', {
      kind: 'TAILNET',
      generation: 7,
      version: 10,
      fingerprint: TAILNET_AUTHORITY.bindingFingerprint,
    }, OPERATION_ID)).rejects.toMatchObject({
      code: 'BINDING_CHANGED',
      statusCode: 409,
    });
    expect(streamResolvedOllama).not.toHaveBeenCalled();

    const started = await manager.startBound('qwen3.5:4b', {
      kind: 'TAILNET',
      generation: 7,
      version: 11,
      fingerprint: TAILNET_AUTHORITY.bindingFingerprint,
    }, OPERATION_ID);
    expect(started.operationId).toBe(OPERATION_ID);
    expect(started.authority).toEqual({
      kind: 'TAILNET',
      generation: 7,
      version: 11,
      fingerprint: TAILNET_AUTHORITY.bindingFingerprint,
    });
    await settleAsyncWork();
    expect(manager.get(started.id)?.state).toBe('succeeded');
  });

  test('rejects invalid or reused client operation IDs without creating another pull', async () => {
    resolveOllamaBackendAuthority.mockResolvedValue(tailnetResolved());
    streamResolvedOllama.mockImplementation(async (
      _resolved,
      _request,
      consumer,
    ) => {
      await consumer(Buffer.from('{"status":"success"}\n'));
      return {
        authority: TAILNET_AUTHORITY,
        statusCode: 200,
        headers: Object.freeze({}),
        responseBytes: 21,
        streaming: true as const,
      };
    });
    const manager = new OllamaPullManager();
    const expected = {
      kind: 'TAILNET' as const,
      generation: 7,
      version: 11,
      fingerprint: TAILNET_AUTHORITY.bindingFingerprint,
    };

    await expect(manager.startBound(
      'qwen3.5:4b',
      expected,
      'not-a-uuid',
    )).rejects.toThrow('Invalid Ollama pull operation ID');

    const first = await manager.startBound(
      'qwen3.5:4b',
      expected,
      OPERATION_ID,
    );
    await settleAsyncWork();
    expect(first.operationId).toBe(OPERATION_ID);
    await expect(manager.startBound(
      'qwen3.5:4b',
      expected,
      OPERATION_ID,
    )).rejects.toThrow('This Ollama pull operation was already accepted');
    expect(streamResolvedOllama).toHaveBeenCalledTimes(1);
  });

  test('latches terminal success and closes a stream that withholds EOF', async () => {
    const progress: OllamaPullSnapshot[] = [];
    const request: OllamaPullStreamRequest = async (
      _model,
      signal,
      onChunk,
      onAuthority,
    ) => {
      onAuthority(LOCAL_AUTHORITY);
      await onChunk(Buffer.from('{"status":"success"}\n'));
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('exact pull socket closed')),
          { once: true },
        );
        if (signal.aborted) reject(new Error('exact pull socket closed'));
      });
      throw new Error('unreachable');
    };
    const manager = new OllamaPullManager(request);
    const started = manager.start('qwen3.5:4b', {
      onProgress: (snapshot) => progress.push(snapshot),
    });
    await settleAsyncWork();
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: 'running',
        status: 'success',
        canCancel: false,
      }),
    ]));
    expect(manager.get(started.id)).toMatchObject({
      state: 'succeeded',
      status: 'success',
      canCancel: false,
    });
    expect(manager.cancel(started.id)).toMatchObject({
      state: 'succeeded',
      status: 'success',
      canCancel: false,
    });
    expect(manager.get(started.id)?.error).toBeNull();
  });

  test('cancellation remains cancelling until the exact stream settles', async () => {
    const admittedSignals: AbortSignal[] = [];
    const request: OllamaPullStreamRequest = (
      _model,
      signal,
      _onChunk,
      onAuthority,
    ) => {
      admittedSignals.push(signal);
      onAuthority(LOCAL_AUTHORITY);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => setImmediate(() => reject(new Error('socket closed'))),
          { once: true },
        );
      });
    };
    const manager = new OllamaPullManager(request);
    const started = manager.start('qwen3.5:4b');

    expect(manager.cancel(started.id)).toMatchObject({
      state: 'cancelling',
      status: 'Cancelling download…',
      canCancel: false,
    });
    expect(admittedSignals).toHaveLength(1);
    expect(admittedSignals[0].aborted).toBe(true);
    expect(manager.get(started.id)?.state).toBe('cancelling');

    await settleAsyncWork();
    expect(manager.get(started.id)).toMatchObject({
      state: 'cancelled',
      status: 'Download cancelled',
      error: null,
    });
  });

  test('the two-hour deadline aborts, waits for settlement, then records timed_out', async () => {
    jest.useFakeTimers();
    const request: OllamaPullStreamRequest = (
      _model,
      signal,
      _onChunk,
      onAuthority,
    ) => {
      onAuthority(LOCAL_AUTHORITY);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('socket closed')),
          { once: true },
        );
      });
    };
    const manager = new OllamaPullManager(request);
    const started = manager.start('qwen3.5:4b');
    try {
      jest.advanceTimersByTime(OLLAMA_PULL_TIMEOUT_MS);
      expect(manager.get(started.id)?.state).toBe('cancelling');
      await Promise.resolve();
      await Promise.resolve();
      expect(manager.get(started.id)).toMatchObject({
        state: 'timed_out',
        status: 'Download timed out',
        error: 'Ollama pull exceeded the two-hour limit',
      });
    } finally {
      manager.cancelAll();
      jest.useRealTimers();
    }
  });

  test.each([
    {
      name: 'remote error',
      chunks: [Buffer.from('{"error":"model does not exist"}\n')],
      message: 'Ollama pull failed: model does not exist',
    },
    {
      name: 'truncated stream',
      chunks: [Buffer.from('{"status":"pulling manifest"}\n')],
      message: 'Ollama pull ended before a terminal success record',
    },
    {
      name: 'malformed frame',
      chunks: [Buffer.from('{"status":}\n')],
      message: 'Ollama returned malformed pull progress JSON',
    },
  ])('retains a bounded terminal failure for $name', async ({ chunks, message }) => {
    const manager = new OllamaPullManager(successfulRequest(chunks));
    const completed = await waitForDone(manager);
    expect(completed).toMatchObject({
      state: 'failed',
      status: 'Download failed',
      error: message,
      canCancel: false,
    });
  });

  test('default lane streams one native pull through the pre-resolved authority', async () => {
    const resolved = localResolved();
    resolveOllamaBackendAuthority.mockResolvedValue(resolved);
    streamResolvedOllama.mockImplementation(async (
      supplied,
      request,
      consumer,
    ) => {
      expect(supplied).toBe(resolved);
      expect(request).toMatchObject({
        path: '/api/pull',
        method: 'POST',
        json: { model: 'qwen3.5:4b', stream: true },
        timeoutMs: OLLAMA_PULL_TIMEOUT_MS,
        maxResponseBytes: 64 * 1024 * 1024,
        signal: expect.any(AbortSignal),
      });
      await consumer(Buffer.from('{"status":"success"}\n'));
      return streamResponse();
    });
    const manager = new OllamaPullManager();
    const completed = await waitForDone(manager);

    expect(completed.state).toBe('succeeded');
    expect(resolveOllamaBackendAuthority).toHaveBeenCalledTimes(1);
    expect(streamResolvedOllama).toHaveBeenCalledTimes(1);
  });

  test('rejects unsafe model input before starting work', () => {
    const request = jest.fn();
    const manager = new OllamaPullManager(request);
    expect(() => manager.start('qwen3:8b; reboot')).toThrow(
      'Invalid Ollama model name',
    );
    expect(request).not.toHaveBeenCalled();
  });

  test('diagnostic CLI execution remains fixed-local and proxy-free', () => {
    const priorHost = process.env.OLLAMA_HOST;
    const priorApiUrl = process.env.OLLAMA_API_URL;
    process.env.OLLAMA_HOST = 'http://100.64.0.20:11434';
    process.env.OLLAMA_API_URL = 'http://169.254.169.254:11434';
    try {
      expect(localOllamaCliEnvironment()).toEqual({
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: process.env.HOME || '/root',
        LANG: 'C',
        LC_ALL: 'C',
        OLLAMA_HOST: 'http://127.0.0.1:11434',
      });
    } finally {
      if (priorHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = priorHost;
      if (priorApiUrl === undefined) delete process.env.OLLAMA_API_URL;
      else process.env.OLLAMA_API_URL = priorApiUrl;
    }
  });
});
