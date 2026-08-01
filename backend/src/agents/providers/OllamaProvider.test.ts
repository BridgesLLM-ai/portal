import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentAbortError, type SenderIdentity } from '../AgentProvider.interface';
import {
  NATIVE_OLLAMA_STREAM_COMPLETE,
} from '../../services/nativeOllamaTransport';

const previousSessionsDir = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-host-provider-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';
const mockRequestConfiguredOllamaJson = jest.fn();
const mockStreamResolvedOllama = jest.fn();

jest.mock('../../services/ollamaBackendAuthority', () => {
  const authority = {
    kind: 'LOCAL',
    source: 'local-policy',
    endpoint: 'http://127.0.0.1:11434',
    generation: null,
    version: null,
    bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
    selectedModel: null,
    selectedModelDigest: null,
  };
  return {
    resolveOllamaBackendAuthority: jest.fn(async () => ({
      authority,
      bindingView: { purposeId: 'PRIMARY', authority: null, candidate: null },
    })),
    requestResolvedOllamaJson: jest.fn(async (_resolved, input) => ({
      authority,
      value: await mockRequestConfiguredOllamaJson(input),
    })),
    streamResolvedOllama: jest.fn(async (resolved, input, onChunk) => {
      await mockStreamResolvedOllama(input, onChunk, resolved);
      return Object.freeze({
        authority: resolved.authority,
        statusCode: 200,
        headers: Object.freeze({
          'content-type': 'application/x-ndjson',
        }),
        responseBytes: 0,
        streaming: true as const,
      });
    }),
  };
});

const { OllamaProvider } = require('./OllamaProvider') as typeof import('./OllamaProvider');
const sessionStore = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
const { createHostOperatorExecutionContext } = require('../executionScope') as typeof import('../executionScope');
const authorityService = require('../../services/ollamaBackendAuthority') as {
  resolveOllamaBackendAuthority: jest.Mock;
};

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function streamLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

const sender = (requestId: string): SenderIdentity => ({
  label: 'owner@example.com',
  userId: 'owner-1',
  role: 'OWNER',
  requestId,
});

function createSession(): string {
  return sessionStore.createNativeSession('OLLAMA', 'owner-1', {
    executionContext: createHostOperatorExecutionContext('owner-1'),
    model: 'qwen3.5:4b',
  }).sessionId;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('Ollama host Agent Chat lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestConfiguredOllamaJson.mockReset();
    mockStreamResolvedOllama.mockReset();
  });

  afterEach(() => {
    for (const summary of sessionStore.listNativeSessions('OLLAMA', 'owner-1')) {
      sessionStore.deleteNativeSession('OLLAMA', summary.sessionId);
    }
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (previousSessionsDir === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionsDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  test('refuses to create a remote Agent Chat session until a model is selected', async () => {
    authorityService.resolveOllamaBackendAuthority.mockResolvedValueOnce({
      authority: {
        kind: 'TAILNET',
        source: 'native-binding',
        bindingId: 'binding-empty',
        stableNodeId: 'node-empty',
        nodePublicKey: 'nodekey:empty',
        observedAddress: '100.64.0.80',
        port: 11435,
        generation: 4,
        version: 1,
        bindingFingerprint: 'native-empty',
        selectedModel: null,
        selectedModelDigest: null,
      },
      bindingView: { purposeId: 'PRIMARY', authority: null, candidate: null },
    });

    await expect(new OllamaProvider().startSession('owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
    })).rejects.toThrow(/no model is selected/i);
    expect(sessionStore.listNativeSessions('OLLAMA', 'owner-1')).toEqual([]);
  });

  test('rejects launch-time model drift and invalidates a remote session when its digest changes', async () => {
    const firstDigest = `sha256:${'a'.repeat(64)}`;
    const remoteResolved = (digest: string) => ({
      authority: {
        kind: 'TAILNET',
        source: 'tailnet-binding',
        endpoint: null,
        generation: 8,
        version: 3,
        bindingFingerprint: 'native-tailnet-peer-8',
        selectedModel: 'qwen3.5:4b',
        selectedModelDigest: digest,
      },
      bindingView: {
        purposeId: 'PRIMARY',
        authority: { generation: 8, version: 3 },
        candidate: null,
      },
    });
    authorityService.resolveOllamaBackendAuthority.mockResolvedValue(
      remoteResolved(firstDigest),
    );
    const provider = new OllamaProvider();

    await expect(provider.startSession('owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
      model: 'other:latest',
    })).rejects.toThrow(/not the active Remote GPU model/i);

    const sessionId = await provider.startSession('owner-1', {
      executionContext: createHostOperatorExecutionContext('owner-1'),
      model: 'qwen3.5:4b',
    });
    expect(sessionStore.loadNativeSession('OLLAMA', sessionId)?.metadata)
      .toMatchObject({
        ollamaBackendFingerprint: 'native-tailnet-peer-8',
        ollamaBackendGeneration: 8,
        ollamaBackendModelDigest: firstDigest,
      });
    mockStreamResolvedOllama.mockImplementationOnce(async (_input, onChunk) => {
      await onChunk(streamLine({
        message: { role: 'assistant', content: 'pinned' },
        done: true,
      }));
    });
    await expect(provider.sendMessage(
      sessionId,
      'use the pinned digest',
      undefined,
      undefined,
      undefined,
      sender('digest-pinned'),
    )).resolves.toMatchObject({ fullText: 'pinned' });
    expect(mockStreamResolvedOllama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedModelDigest: firstDigest,
        json: expect.objectContaining({ model: 'qwen3.5:4b' }),
      }),
      expect.any(Function),
      expect.any(Object),
    );

    authorityService.resolveOllamaBackendAuthority.mockResolvedValue(
      remoteResolved(`sha256:${'b'.repeat(64)}`),
    );
    await expect(provider.sendMessage(
      sessionId,
      'must not cross a retag',
      undefined,
      undefined,
      undefined,
      sender('digest-drift'),
    )).rejects.toThrow(/backend changed after this session was created/i);
    expect(mockStreamResolvedOllama).toHaveBeenCalledTimes(1);
  });

  test('streams split UTF-8 chat deltas and preserves tool calls, final metrics, and history', async () => {
    const sessionId = createSession();
    mockStreamResolvedOllama.mockImplementation(async (_input, onChunk) => {
      const payload = Buffer.concat([
        streamLine({
          message: {
            role: 'assistant',
            content: 'Hello ',
            tool_calls: [{
              id: 'call-1',
              function: {
                name: 'inspect',
                arguments: { path: 'README.md' },
              },
            }],
          },
          done: false,
        }),
        streamLine({
          message: { role: 'assistant', content: '🌍' },
          done: false,
        }),
        streamLine({
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          total_duration: 120,
          prompt_eval_count: 5,
          eval_count: 2,
        }),
      ]);
      for (let index = 0; index < payload.byteLength; index += 1) {
        await onChunk(payload.subarray(index, index + 1));
      }
    });
    const chunks: string[] = [];

    const result = await new OllamaProvider().sendMessage(
      sessionId,
      'Say hello',
      (chunk) => chunks.push(chunk),
      undefined,
      undefined,
      sender('completed-run'),
    );

    expect(result).toMatchObject({
      fullText: 'Hello 🌍',
      metadata: {
        doneReason: 'stop',
        metrics: {
          total_duration: 120,
          prompt_eval_count: 5,
          eval_count: 2,
        },
        toolCalls: [{
          id: 'call-1',
          function: {
            name: 'inspect',
            arguments: { path: 'README.md' },
          },
        }],
      },
    });
    expect(chunks).toEqual(['Hello ', '🌍']);
    expect(mockStreamResolvedOllama).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/chat',
      method: 'POST',
      json: expect.objectContaining({
        model: 'qwen3.5:4b',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
        ]),
        stream: true,
        think: false,
      }),
      timeoutMs: 10 * 60_000,
      maxResponseBytes: 64 * 1024 * 1024,
      signal: expect.any(AbortSignal),
    }), expect.any(Function), expect.any(Object));
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId).map((entry) => ({
      role: entry.role,
      content: entry.content,
    }))).toEqual([
      { role: 'user', content: 'Say hello' },
      { role: 'assistant', content: 'Hello 🌍' },
    ]);
  });

  test('counts repeated tool-call IDs across records instead of treating overwrites as free', async () => {
    const sessionId = createSession();
    mockStreamResolvedOllama.mockImplementation(async (_input, onChunk) => {
      for (let index = 0; index < 65; index += 1) {
        await onChunk(streamLine({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'duplicate-tool-id',
              function: {
                name: 'inspect',
                arguments: { path: 'README.md' },
              },
            }],
          },
          done: false,
        }));
      }
    });

    await expect(new OllamaProvider().sendMessage(
      sessionId,
      'Do not let duplicate IDs bypass the stream bound.',
      undefined,
      undefined,
      undefined,
      sender('duplicate-tool-bound'),
    )).rejects.toThrow(/too many tool calls/i);
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId))
      .toEqual([]);
  });

  test('emits the first token before the authority stream reaches EOF', async () => {
    const sessionId = createSession();
    const firstToken = deferred();
    const releaseTail = deferred();
    let authorityStreamReturned = false;
    mockStreamResolvedOllama.mockImplementation(async (_input, onChunk) => {
      await onChunk(streamLine({
        message: { role: 'assistant', content: 'first' },
        done: false,
      }));
      await releaseTail.promise;
      await onChunk(streamLine({
        message: { role: 'assistant', content: ' token' },
        done: false,
      }));
      await onChunk(streamLine({
        message: { role: 'assistant', content: '' },
        done: true,
      }));
      authorityStreamReturned = true;
    });
    const chunks: string[] = [];
    let sendSettled = false;

    const send = new OllamaProvider().sendMessage(
      sessionId,
      'stream now',
      (chunk) => {
        chunks.push(chunk);
        if (chunks.length === 1) firstToken.resolve();
      },
      undefined,
      undefined,
      sender('first-token-run'),
    ).finally(() => {
      sendSettled = true;
    });

    await firstToken.promise;
    expect(chunks).toEqual(['first']);
    expect(authorityStreamReturned).toBe(false);
    expect(sendSettled).toBe(false);
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId)).toEqual([]);

    releaseTail.resolve();
    await expect(send).resolves.toMatchObject({ fullText: 'first token' });
    expect(chunks).toEqual(['first', ' token']);
    expect(authorityStreamReturned).toBe(true);
  });

  test('commits a valid terminal answer when HTTP EOF is withheld without reporting user abort', async () => {
    const sessionId = createSession();
    const withheldEof = deferred();
    let requestSignal!: AbortSignal;
    let exactUpstreamClosed = false;
    mockStreamResolvedOllama.mockImplementation(async (input, onChunk) => {
      requestSignal = input.signal as AbortSignal;
      const control = await onChunk(streamLine({
        message: { role: 'assistant', content: 'finished without EOF' },
        done: true,
        done_reason: 'stop',
        eval_count: 7,
      }));
      if (control !== NATIVE_OLLAMA_STREAM_COMPLETE) {
        await withheldEof.promise;
      }
      exactUpstreamClosed = true;
    });
    const provider = new OllamaProvider();

    try {
      await expect(provider.sendMessage(
        sessionId,
        'finish on the terminal record',
        undefined,
        undefined,
        undefined,
        sender('terminal-withheld-eof'),
      )).resolves.toMatchObject({
        fullText: 'finished without EOF',
        metadata: {
          doneReason: 'stop',
          metrics: { eval_count: 7 },
        },
      });
      expect(exactUpstreamClosed).toBe(true);
      expect(requestSignal.aborted).toBe(false);
      await expect(provider.abortActiveRun(
        sessionId,
        'terminal-withheld-eof',
      )).resolves.toBe(false);
      expect(sessionStore.readAllNativeSessionHistory(
        'OLLAMA',
        sessionId,
      ).map((entry) => entry.content)).toEqual([
        'finish on the terminal record',
        'finished without EOF',
      ]);
    } finally {
      withheldEof.resolve();
    }
  });

  test('lets protocol completion win over a cancellation that arrives after done:true', async () => {
    const sessionId = createSession();
    const terminalSeen = deferred();
    const releaseTransport = deferred();
    let requestSignal!: AbortSignal;
    mockStreamResolvedOllama.mockImplementation(async (input, onChunk) => {
      requestSignal = input.signal as AbortSignal;
      const control = await onChunk(streamLine({
        message: { role: 'assistant', content: 'already complete' },
        done: true,
      }));
      expect(control).toBe(NATIVE_OLLAMA_STREAM_COMPLETE);
      terminalSeen.resolve();
      await releaseTransport.promise;
    });
    const provider = new OllamaProvider();
    const send = provider.sendMessage(
      sessionId,
      'complete before cancellation',
      undefined,
      undefined,
      undefined,
      sender('terminal-before-abort'),
    );

    await terminalSeen.promise;
    const aborting = provider.abortActiveRun(
      sessionId,
      'terminal-before-abort',
    );
    expect(requestSignal.aborted).toBe(true);
    releaseTransport.resolve();

    await expect(send).resolves.toMatchObject({
      fullText: 'already complete',
    });
    await expect(aborting).resolves.toBe(false);
    expect(sessionStore.readAllNativeSessionHistory(
      'OLLAMA',
      sessionId,
    ).map((entry) => entry.content)).toEqual([
      'complete before cancellation',
      'already complete',
    ]);
  });

  test.each([
    {
      name: 'malformed NDJSON after a content delta',
      emit: async (onChunk: (chunk: Buffer) => Promise<void>) => {
        await onChunk(streamLine({
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }));
        await onChunk(Buffer.from('{"message":}\n'));
      },
      error: /invalid NDJSON/i,
    },
    {
      name: 'EOF before a terminal done record',
      emit: async (onChunk: (chunk: Buffer) => Promise<void>) => {
        await onChunk(streamLine({
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }));
      },
      error: /terminal done record/i,
    },
    {
      name: 'an Ollama error record',
      emit: async (onChunk: (chunk: Buffer) => Promise<void>) => {
        await onChunk(streamLine({
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }));
        await onChunk(streamLine({ error: 'generation failed' }));
      },
      error: /model error: generation failed/i,
    },
  ])('rejects $name without appending any part of the failed turn', async ({
    emit,
    error,
  }) => {
    const sessionId = createSession();
    const chunks: string[] = [];
    mockStreamResolvedOllama.mockImplementation(
      async (_input, onChunk) => emit(onChunk),
    );

    await expect(new OllamaProvider().sendMessage(
      sessionId,
      'do not retain partial output',
      (chunk) => chunks.push(chunk),
      undefined,
      undefined,
      sender(`failure-${sessionId}`),
    )).rejects.toThrow(error);

    expect(chunks).toEqual(['partial']);
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId)).toEqual([]);
  });

  test('rejects a stream frame above the bounded line limit', async () => {
    const sessionId = createSession();
    mockStreamResolvedOllama.mockImplementation(async (_input, onChunk) => {
      await onChunk(Buffer.alloc(2 * 1024 * 1024 + 2, 0x78));
    });

    await expect(new OllamaProvider().sendMessage(
      sessionId,
      'bounded response',
      undefined,
      undefined,
      undefined,
      sender('oversized-frame'),
    )).rejects.toThrow(/frame exceeded the safety limit/i);
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId)).toEqual([]);
  });

  test('reserves the logical run synchronously before dispatch and rejects an overlapping send', async () => {
    const sessionId = createSession();
    const provider = new OllamaProvider();
    let signal!: AbortSignal;
    mockStreamResolvedOllama.mockImplementation(async (input) => new Promise((_resolve, reject) => {
      signal = input.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));

    const first = provider.sendMessage(
      sessionId, 'first', undefined, undefined, undefined, sender('first-run'),
    ).catch((error) => error);
    const overlapping = provider.sendMessage(
      sessionId, 'second', undefined, undefined, undefined, sender('second-run'),
    );

    await expect(overlapping).rejects.toThrow(/already has an active turn/i);
    expect(mockStreamResolvedOllama).toHaveBeenCalledTimes(1);
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId)).toEqual([]);
    await expect(provider.abortActiveRun(sessionId, 'first-run')).resolves.toBe(true);
    expect(signal.aborted).toBe(true);
    expect(await first).toBeInstanceOf(AgentAbortError);
  });

  test('protects a newer runId and coalesces repeated transport aborts through settlement', async () => {
    const sessionId = createSession();
    const provider = new OllamaProvider();
    let signal!: AbortSignal;
    const partialChunks: string[] = [];
    mockStreamResolvedOllama.mockImplementation(async (input, onChunk) => {
      signal = input.signal as AbortSignal;
      await onChunk(streamLine({
        message: { role: 'assistant', content: 'partial' },
        done: false,
      }));
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      });
    });
    const send = provider.sendMessage(
      sessionId,
      'stream this',
      (chunk) => partialChunks.push(chunk),
      undefined,
      undefined,
      sender('current-run'),
    ).catch((error) => error);
    await waitFor(() => Boolean(signal), 'Ollama transport dispatch');

    await expect(provider.abortActiveRun(sessionId, 'stale-run')).resolves.toBe(false);
    const firstAbort = provider.abortActiveRun(sessionId, 'current-run');
    const repeatedAbort = provider.abortActiveRun(sessionId, 'current-run');

    await expect(firstAbort).resolves.toBe(true);
    await expect(repeatedAbort).resolves.toBe(true);
    expect(signal.aborted).toBe(true);
    expect(await send).toBeInstanceOf(AgentAbortError);
    expect(partialChunks).toEqual(['partial']);
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId)).toEqual([]);
    await expect(provider.abortActiveRun(sessionId, 'current-run')).resolves.toBe(false);
  });

  test('terminateSession aborts and settles the exact run before deleting durable session state', async () => {
    const sessionId = createSession();
    const provider = new OllamaProvider();
    let signal!: AbortSignal;
    mockStreamResolvedOllama.mockImplementation(async (input) => new Promise((_resolve, reject) => {
      signal = input.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const send = provider.sendMessage(
      sessionId, 'long response', undefined, undefined, undefined, sender('terminate-run'),
    ).catch((error) => error);
    await waitFor(() => Boolean(signal), 'Ollama transport dispatch');

    await expect(provider.terminateSession(sessionId)).resolves.toBeUndefined();

    expect(signal.aborted).toBe(true);
    expect(await send).toBeInstanceOf(AgentAbortError);
    expect(sessionStore.loadNativeSession('OLLAMA', sessionId)).toBeNull();
  });

  test('rejects invalid run identities before fetch or history mutation', async () => {
    const sessionId = createSession();
    const provider = new OllamaProvider();

    await expect(provider.sendMessage(
      sessionId, 'never sent', undefined, undefined, undefined, sender('bad\nrun'),
    )).rejects.toThrow(/run identity/i);

    expect(mockStreamResolvedOllama).not.toHaveBeenCalled();
    expect(sessionStore.readAllNativeSessionHistory('OLLAMA', sessionId)).toEqual([]);
  });

  test('ignores remote environment URLs and refuses upstream redirects', async () => {
    const priorHost = process.env.OLLAMA_HOST;
    const priorApiUrl = process.env.OLLAMA_API_URL;
    process.env.OLLAMA_HOST = 'http://100.64.0.20:11434';
    process.env.OLLAMA_API_URL = 'http://169.254.169.254:11434';
    try {
      const sessionId = createSession();
      mockStreamResolvedOllama.mockRejectedValue(Object.assign(
        new Error('Local Ollama returned a non-success status'),
        { code: 'HTTP_STATUS', statusCode: 308 },
      ));

      await expect(new OllamaProvider().sendMessage(
        sessionId,
        'do not redirect',
        undefined,
        undefined,
        undefined,
        sender('redirect-run'),
      )).rejects.toThrow(/non-success status/i);

      expect(mockStreamResolvedOllama).toHaveBeenCalledTimes(1);
    } finally {
      if (priorHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = priorHost;
      if (priorApiUrl === undefined) delete process.env.OLLAMA_API_URL;
      else process.env.OLLAMA_API_URL = priorApiUrl;
    }
  });

  test('binds a session to one backend fingerprint and rejects a later generation', async () => {
    const sessionId = createSession();
    const provider = new OllamaProvider();
    mockStreamResolvedOllama.mockImplementationOnce(async (_input, onChunk) => {
      await onChunk(streamLine({
        message: { role: 'assistant', content: 'first reply' },
        done: false,
      }));
      await onChunk(streamLine({
        message: { role: 'assistant', content: '' },
        done: true,
      }));
    });

    await expect(provider.sendMessage(
      sessionId,
      'first',
      undefined,
      undefined,
      undefined,
      sender('generation-one'),
    )).resolves.toMatchObject({ fullText: 'first reply' });

    authorityService.resolveOllamaBackendAuthority.mockResolvedValueOnce({
      authority: {
        kind: 'TAILNET',
        source: 'tailnet-binding',
        endpoint: null,
        generation: 2,
        version: 1,
        bindingFingerprint: 'tailnet-generation-two',
        selectedModel: 'qwen3.5:4b',
        selectedModelDigest: `sha256:${'a'.repeat(64)}`,
      },
      bindingView: {
        purposeId: 'PRIMARY',
        authority: { generation: 2, version: 1 },
        candidate: null,
      },
    });

    await expect(provider.sendMessage(
      sessionId,
      'must not cross backend generations',
      undefined,
      undefined,
      undefined,
      sender('generation-two'),
    )).rejects.toThrow(/backend changed after this session was created/i);
    expect(mockStreamResolvedOllama).toHaveBeenCalledTimes(1);
  });
});
