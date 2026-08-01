import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../services/projectEgressPolicy';
import * as localOllamaTransport from '../../../services/localOllamaTransport';
import {
  NATIVE_OLLAMA_STREAM_COMPLETE,
} from '../../../services/nativeOllamaTransport';
import {
  OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
  openOllamaProjectModelBridge,
} from './OllamaProjectModelBridge';

jest.mock('../../../services/ollamaBackendAuthority', () => ({
  resolveOllamaBackendAuthority: jest.fn(async () => {
    throw new Error('Test must inject an exact authority resolver');
  }),
  requestResolvedOllama: jest.fn(async () => {
    throw new Error('Test must inject an exact buffered authority request');
  }),
  streamResolvedOllama: jest.fn(async () => {
    throw new Error('Test must inject an exact streaming authority request');
  }),
}));

const LOCAL_BACKEND = Object.freeze({
  backendKind: 'LOCAL' as const,
  backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
  backendGeneration: null,
});
const TAILNET_BACKEND = Object.freeze({
  backendKind: 'TAILNET' as const,
  backendFingerprint: 'ollama-backend:tailnet-gpu-7',
  backendGeneration: 7,
});
const MODEL_DIGEST = `sha256:${'d'.repeat(64)}`;

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

function contextFixture(): { root: string; context: ProjectSandboxExecutionContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-project-bridge-'));
  const stat = fs.lstatSync(root, { bigint: true });
  return {
    root,
    context: Object.freeze({
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: 'actor-bridge',
      projectId: 'project-bridge',
      workspaceOwnerId: 'owner-bridge',
      projectName: 'bridge-test',
      canonicalRoot: fs.realpathSync(root),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
      runtimePolicyVersion: 'portal-ollama-project-sandbox-v1',
      egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
      runtimeImageDigest: 'sha256:' + 'a'.repeat(64),
      policyFingerprint: 'b'.repeat(64),
    }),
  };
}

describe('Ollama Project authenticated loopback model bridge', () => {
  test('exposes only scoped tags/show/chat and never a generic upstream path', async () => {
    const fixture = contextFixture();
    const token = 't'.repeat(43);
    const upstreamMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b', digest: 'c'.repeat(64) }] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/show')) {
        expect(JSON.parse(String(init?.body))).toEqual({ model: 'qwen3:8b', verbose: false });
        return new Response(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/chat')) {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe('qwen3:8b');
        expect(body.tools[0].function.name).toBe('project_read');
        return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      throw new Error('unexpected upstream path: ' + url);
    });
    const upstream = upstreamMock as typeof fetch;

    const bridge = await openOllamaProjectModelBridge({
      context: fixture.context,
      sessionId: 'ollama-session-1',
      model: 'qwen3:8b',
      modelDigest: MODEL_DIGEST,
      backend: LOCAL_BACKEND,
      allowedToolNames: ['project_read'],
      options: {
        upstreamBaseUrl: 'http://127.0.0.1:11434',
        fetchImpl: upstream,
        tokenFactory: () => token,
      },
    });
    try {
      expect(OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION).toBe('ollama-project-model-bridge-v1');
      await expect(bridge.client.listModels()).resolves.toEqual(expect.objectContaining({ models: expect.any(Array) }));
      await expect(bridge.client.showModel()).resolves.toEqual(expect.objectContaining({ capabilities: expect.arrayContaining(['tools']) }));
      const chat = await bridge.client.chat({
        model: 'qwen3:8b',
        stream: true,
        think: true,
        messages: [{ role: 'user', content: 'read the file' }],
        tools: [{
          type: 'function',
          function: { name: 'project_read', description: 'read', parameters: { type: 'object' } },
        }],
      });
      expect(await chat.text()).toContain('"content":"ok"');
      expect(upstreamMock.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);

      const unauthenticated = await fetch(bridge.baseUrl + '/v1/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(unauthenticated.status).toBe(401);

      const wrongScope = await fetch(bridge.baseUrl + '/v1/tags', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-BridgesLLM-Project-Scope': 'wrong-scope',
        },
        body: '{}',
      });
      expect(wrongScope.status).toBe(403);

      const forbiddenPath = await fetch(bridge.baseUrl + '/api/pull', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-BridgesLLM-Project-Scope': bridge.scopeFingerprint,
        },
        body: JSON.stringify({ model: 'another-model' }),
      });
      expect(forbiddenPath.status).toBe(404);

      const wrongModel = await fetch(bridge.baseUrl + '/v1/chat', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-BridgesLLM-Project-Scope': bridge.scopeFingerprint,
        },
        body: JSON.stringify({ model: 'other:latest', stream: true, messages: [{ role: 'user', content: 'x' }] }),
      });
      expect(wrongModel.status).toBe(400);
      expect(upstream).toHaveBeenCalledTimes(3);
    } finally {
      await bridge.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects public, credentialed, or path-bearing upstream URLs', async () => {
    const fixture = contextFixture();
    try {
      for (const upstreamBaseUrl of [
        'https://ollama.example.com',
        'http://10.0.0.2:11434',
        'http://100.64.0.20:11434',
        'http://[::ffff:127.0.0.1]:11434',
        'http://127.0.0.1:11435',
        'http://user:pass@127.0.0.1:11434',
        'http://127.0.0.1:11434/api',
      ]) {
        await expect(openOllamaProjectModelBridge({
          context: fixture.context,
          sessionId: 'ollama-session-1',
          model: 'qwen3:8b',
          modelDigest: MODEL_DIGEST,
          backend: LOCAL_BACKEND,
          allowedToolNames: ['project_read'],
          options: { upstreamBaseUrl },
        })).rejects.toMatchObject({ code: 'UPSTREAM_SCOPE' });
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('uses direct local sockets for both bridge hops and never falls back to global fetch', async () => {
    const fixture = contextFixture();
    const globalFetch = global.fetch;
    const forbiddenFetch = jest.fn(async () => {
      throw new Error('global fetch must not carry Project model traffic');
    }) as unknown as typeof fetch;
    global.fetch = forbiddenFetch;
    const directRequest = jest.spyOn(localOllamaTransport, 'requestLocalOllama')
      .mockImplementation(async (request) => {
        const payload = request.path === '/api/tags'
          ? { models: [{ name: 'qwen3:8b', digest: 'd'.repeat(64) }] }
          : request.path === '/api/show'
            ? { capabilities: ['tools'] }
            : { message: { role: 'assistant', content: 'direct' }, done: true };
        return Object.freeze({
          statusCode: 200,
          headers: Object.freeze({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify(payload), 'utf8'),
        });
      });
    let bridge: Awaited<ReturnType<typeof openOllamaProjectModelBridge>> | undefined;
    try {
      bridge = await openOllamaProjectModelBridge({
        context: fixture.context,
        sessionId: 'ollama-session-direct',
        model: 'qwen3:8b',
        modelDigest: MODEL_DIGEST,
        backend: LOCAL_BACKEND,
        allowedToolNames: ['project_read'],
        options: {
          resolveAuthority: async () => ({
            authority: {
              kind: 'LOCAL' as const,
              source: 'local-policy' as const,
              endpoint: 'http://127.0.0.1:11434' as const,
              generation: null,
              version: null,
              bindingFingerprint: LOCAL_BACKEND.backendFingerprint as 'local-ollama-v1:127.0.0.1:11434',
              selectedModel: null,
              selectedModelDigest: null,
            },
            bindingView: {
              purposeId: 'PRIMARY' as const,
              authority: null,
              candidate: null,
            },
          }),
          requestResolved: async (resolved, request) => Object.freeze({
            ...(await localOllamaTransport.requestLocalOllama(
              request as Parameters<
                typeof localOllamaTransport.requestLocalOllama
              >[0],
            )),
            authority: resolved.authority,
            streaming: false as const,
          }),
        },
      });
      await expect(bridge.client.listModels()).resolves.toEqual(expect.objectContaining({
        models: expect.any(Array),
      }));
      await expect(bridge.client.showModel()).resolves.toEqual({
        capabilities: ['tools'],
      });
      await expect(bridge.client.chat({
        model: 'qwen3:8b',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }).then((response) => response.json())).resolves.toEqual(expect.objectContaining({
        done: true,
      }));
      await expect(bridge.proveBoundary()).resolves.toEqual(expect.objectContaining({
        unauthenticatedStatus: 401,
        scopeMismatchStatus: 403,
        disallowedRouteStatus: 404,
      }));
      expect(directRequest.mock.calls.map(([request]) => request.path)).toEqual([
        '/api/tags',
        '/api/show',
        '/api/chat',
      ]);
      expect(forbiddenFetch).not.toHaveBeenCalled();
    } finally {
      await bridge?.close();
      directRequest.mockRestore();
      global.fetch = globalFetch;
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('relays authority NDJSON before upstream EOF and keeps the callback open through completion', async () => {
    const fixture = contextFixture();
    const resolved = Object.freeze({
      authority: Object.freeze({
        kind: 'LOCAL' as const,
        source: 'local-policy' as const,
        endpoint: 'http://127.0.0.1:11434' as const,
        generation: null,
        version: null,
        bindingFingerprint: LOCAL_BACKEND.backendFingerprint as
          'local-ollama-v1:127.0.0.1:11434',
        selectedModel: null,
        selectedModelDigest: null,
      }),
      bindingView: Object.freeze({
        purposeId: 'PRIMARY' as const,
        authority: null,
        candidate: null,
      }),
    });
    const releaseTail = deferred();
    let streamReturned = false;
    const resolveAuthority = jest.fn(async () => resolved);
    const requestResolved = jest.fn();
    const streamResolved = jest.fn(async (
      supplied: typeof resolved,
      request: { path: string; body?: string; signal?: AbortSignal },
      onChunk: (chunk: Buffer) => void | Promise<void>,
    ) => {
      expect(supplied).toBe(resolved);
      expect(request.path).toBe('/api/chat');
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(request.body))).toMatchObject({
        model: 'qwen3:8b',
        stream: true,
      });
      await onChunk(Buffer.from(
        '{"message":{"role":"assistant","content":"first"},"done":false}\n',
      ));
      await releaseTail.promise;
      await onChunk(Buffer.from(
        '{"message":{"role":"assistant","content":" token"},"done":false}\n'
        + '{"message":{"role":"assistant","content":""},"done":true}\n',
      ));
      streamReturned = true;
      return Object.freeze({
        authority: resolved.authority,
        statusCode: 200,
        headers: Object.freeze({
          'content-type': 'application/x-ndjson',
        }),
        responseBytes: 0,
        streaming: true as const,
      });
    });
    let bridge: Awaited<ReturnType<typeof openOllamaProjectModelBridge>> | undefined;
    try {
      bridge = await openOllamaProjectModelBridge({
        context: fixture.context,
        sessionId: 'ollama-session-native-stream',
        model: 'qwen3:8b',
        modelDigest: MODEL_DIGEST,
        backend: LOCAL_BACKEND,
        allowedToolNames: ['project_read'],
        options: {
          resolveAuthority: resolveAuthority as any,
          requestResolved: requestResolved as any,
          streamResolved: streamResolved as any,
        },
      });

      const response = await bridge.client.chat({
        model: 'qwen3:8b',
        stream: true,
        messages: [{ role: 'user', content: 'stream the response' }],
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value!).toString('utf8')).toContain('"content":"first"');
      expect(streamReturned).toBe(false);
      expect(requestResolved).not.toHaveBeenCalled();

      releaseTail.resolve();
      let remainder = '';
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        remainder += Buffer.from(next.value).toString('utf8');
      }
      expect(remainder).toContain('"content":" token"');
      expect(remainder).toContain('"done":true');
      expect(streamReturned).toBe(true);
      expect(streamResolved).toHaveBeenCalledTimes(1);
      expect(resolveAuthority).toHaveBeenCalledTimes(2);
    } finally {
      releaseTail.resolve();
      await bridge?.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('ends the Project bridge on a valid terminal record when authority HTTP EOF is withheld', async () => {
    const fixture = contextFixture();
    const resolved = Object.freeze({
      authority: Object.freeze({
        kind: 'LOCAL' as const,
        source: 'local-policy' as const,
        endpoint: 'http://127.0.0.1:11434' as const,
        generation: null,
        version: null,
        bindingFingerprint: LOCAL_BACKEND.backendFingerprint as
          'local-ollama-v1:127.0.0.1:11434',
        selectedModel: null,
        selectedModelDigest: null,
      }),
      bindingView: Object.freeze({
        purposeId: 'PRIMARY' as const,
        authority: null,
        candidate: null,
      }),
    });
    const withheldEof = deferred();
    const exactUpstreamClosure = deferred();
    let requestSignal!: AbortSignal;
    let exactUpstreamClosed = false;
    const terminal = Buffer.from(
      '{"message":{"role":"assistant","content":"complete"},"done":true,"eval_count":3}\n',
      'utf8',
    );
    const streamResolved = jest.fn(async (
      _supplied: typeof resolved,
      request: { signal?: AbortSignal },
      onChunk: (chunk: Buffer) => unknown | Promise<unknown>,
    ) => {
      requestSignal = request.signal!;
      const control = await onChunk(terminal);
      if (control !== NATIVE_OLLAMA_STREAM_COMPLETE) {
        await withheldEof.promise;
      }
      exactUpstreamClosed = true;
      exactUpstreamClosure.resolve();
      return Object.freeze({
        authority: resolved.authority,
        statusCode: 200,
        headers: Object.freeze({
          'content-type': 'application/x-ndjson',
        }),
        responseBytes: terminal.byteLength,
        streaming: true as const,
      });
    });
    let bridge: Awaited<ReturnType<typeof openOllamaProjectModelBridge>> | undefined;
    try {
      bridge = await openOllamaProjectModelBridge({
        context: fixture.context,
        sessionId: 'ollama-session-terminal-withheld-eof',
        model: 'qwen3:8b',
        modelDigest: MODEL_DIGEST,
        backend: LOCAL_BACKEND,
        allowedToolNames: ['project_read'],
        options: {
          resolveAuthority: async () => resolved,
          requestResolved: jest.fn() as any,
          streamResolved: streamResolved as any,
        },
      });

      const response = await bridge.client.chat({
        model: 'qwen3:8b',
        stream: true,
        messages: [{ role: 'user', content: 'finish at done' }],
      });
      const reader = response.body!.getReader();
      const completed = await reader.read();
      expect(completed.done).toBe(false);
      expect(Buffer.from(completed.value!).toString('utf8'))
        .toBe(terminal.toString('utf8'));
      // Project Provider intentionally cancels its exact loopback response as
      // soon as it sees done:true. That must not turn into a user abort.
      await reader.cancel();
      await exactUpstreamClosure.promise;
      expect(exactUpstreamClosed).toBe(true);
      expect(requestSignal.aborted).toBe(false);
      expect(streamResolved).toHaveBeenCalledTimes(1);
    } finally {
      withheldEof.resolve();
      await bridge?.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('propagates downstream cancellation to the in-flight authority stream', async () => {
    const fixture = contextFixture();
    const resolved = Object.freeze({
      authority: Object.freeze({
        kind: 'LOCAL' as const,
        source: 'local-policy' as const,
        endpoint: 'http://127.0.0.1:11434' as const,
        generation: null,
        version: null,
        bindingFingerprint: LOCAL_BACKEND.backendFingerprint as
          'local-ollama-v1:127.0.0.1:11434',
        selectedModel: null,
        selectedModelDigest: null,
      }),
      bindingView: Object.freeze({
        purposeId: 'PRIMARY' as const,
        authority: null,
        candidate: null,
      }),
    });
    const upstreamAborted = deferred();
    const streamResolved = jest.fn(async (
      _supplied: typeof resolved,
      request: { signal?: AbortSignal },
      onChunk: (chunk: Buffer) => void | Promise<void>,
    ) => {
      await onChunk(Buffer.from(
        '{"message":{"role":"assistant","content":"partial"},"done":false}\n',
      ));
      await new Promise<void>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => {
          upstreamAborted.resolve();
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      });
      throw new Error('unreachable');
    });
    const controller = new AbortController();
    let bridge: Awaited<ReturnType<typeof openOllamaProjectModelBridge>> | undefined;
    try {
      bridge = await openOllamaProjectModelBridge({
        context: fixture.context,
        sessionId: 'ollama-session-native-abort',
        model: 'qwen3:8b',
        modelDigest: MODEL_DIGEST,
        backend: LOCAL_BACKEND,
        allowedToolNames: ['project_read'],
        options: {
          resolveAuthority: async () => resolved,
          requestResolved: jest.fn() as any,
          streamResolved: streamResolved as any,
        },
      });
      const response = await bridge.client.chat({
        model: 'qwen3:8b',
        stream: true,
        messages: [{ role: 'user', content: 'cancel this response' }],
      }, controller.signal);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value!).toString('utf8')).toContain('partial');

      controller.abort();
      await upstreamAborted.promise;
      await expect(reader.read()).rejects.toMatchObject({
        code: 'BRIDGE_ABORTED',
      });
      expect(streamResolved).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await bridge?.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('routes Tailnet model inference only through the pinned centralized authority', async () => {
    const fixture = contextFixture();
    const resolved = Object.freeze({
      authority: Object.freeze({
        kind: 'TAILNET' as const,
        source: 'tailnet-binding' as const,
        endpoint: null,
        generation: TAILNET_BACKEND.backendGeneration,
        version: 11,
        bindingFingerprint: TAILNET_BACKEND.backendFingerprint,
        selectedModel: 'qwen3:8b',
        selectedModelDigest: 'sha256:' + 'd'.repeat(64),
      }),
      bindingView: Object.freeze({
        purposeId: 'PRIMARY' as const,
        authority: {} as any,
        candidate: null,
      }),
    });
    const resolveAuthority = jest.fn(async () => resolved);
    const requestResolved = jest.fn(async (
      supplied: typeof resolved,
      request: {
        path: string;
        body?: string;
        expectedModelDigest?: string;
      },
    ) => {
      expect(supplied).toBe(resolved);
      if (request.path === '/api/chat') {
        expect(request.expectedModelDigest).toBe(MODEL_DIGEST);
        expect(JSON.parse(String(request.body))).toEqual(expect.objectContaining({
          model: resolved.authority.selectedModel,
          stream: false,
        }));
      }
      const payload = request.path === '/api/tags'
        ? { models: [{ name: resolved.authority.selectedModel, digest: 'd'.repeat(64) }] }
        : request.path === '/api/show'
          ? { capabilities: ['completion', 'tools'] }
          : { message: { role: 'assistant', content: 'remote-gpu' }, done: true };
      return Object.freeze({
        authority: resolved.authority,
        statusCode: 200,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: Buffer.from(JSON.stringify(payload), 'utf8'),
        streaming: false as const,
      });
    });
    const localRequest = jest.spyOn(localOllamaTransport, 'requestLocalOllama');
    let bridge: Awaited<ReturnType<typeof openOllamaProjectModelBridge>> | undefined;
    try {
      bridge = await openOllamaProjectModelBridge({
        context: fixture.context,
        sessionId: 'ollama-session-tailnet-gpu',
        model: resolved.authority.selectedModel,
        modelDigest: MODEL_DIGEST,
        backend: TAILNET_BACKEND,
        allowedToolNames: ['project_read'],
        options: {
          resolveAuthority: resolveAuthority as any,
          requestResolved: requestResolved as any,
        },
      });
      await expect(bridge.client.listModels()).resolves.toEqual(expect.objectContaining({
        models: expect.any(Array),
      }));
      await expect(bridge.client.showModel()).resolves.toEqual({
        capabilities: ['completion', 'tools'],
      });
      await expect(bridge.client.chat({
        model: resolved.authority.selectedModel,
        stream: false,
        messages: [{ role: 'user', content: 'use the paired GPU' }],
      }).then((response) => response.json())).resolves.toEqual(expect.objectContaining({
        done: true,
        message: expect.objectContaining({ content: 'remote-gpu' }),
      }));
      expect(requestResolved.mock.calls.map(([, request]) => request.path))
        .toEqual(['/api/tags', '/api/show', '/api/chat']);
      expect(resolveAuthority).toHaveBeenCalledTimes(4);
      resolveAuthority.mockResolvedValueOnce({
        ...resolved,
        authority: {
          ...resolved.authority,
          selectedModelDigest: `sha256:${'e'.repeat(64)}`,
        },
      });
      await expect(bridge.client.showModel())
        .rejects.toThrow(/backend identity changed/i);
      expect(requestResolved).toHaveBeenCalledTimes(3);
      expect(localRequest).not.toHaveBeenCalled();
    } finally {
      await bridge?.close();
      localRequest.mockRestore();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects authority drift before forwarding another scoped request', async () => {
    const fixture = contextFixture();
    const localResolved = {
      authority: {
        kind: 'LOCAL' as const,
        source: 'local-policy' as const,
        endpoint: 'http://127.0.0.1:11434' as const,
        generation: null,
        version: null,
        bindingFingerprint: LOCAL_BACKEND.backendFingerprint as 'local-ollama-v1:127.0.0.1:11434',
        selectedModel: null,
        selectedModelDigest: null,
      },
      bindingView: {
        purposeId: 'PRIMARY' as const,
        authority: null,
        candidate: null,
      },
    };
    const remoteResolved = {
      authority: {
        kind: 'TAILNET' as const,
        source: 'tailnet-binding' as const,
        endpoint: null,
        generation: 2,
        version: 1,
        bindingFingerprint: 'ollama-backend:changed',
        selectedModel: 'qwen3:8b',
        selectedModelDigest: 'sha256:' + 'd'.repeat(64),
      },
      bindingView: {
        purposeId: 'PRIMARY' as const,
        authority: {} as any,
        candidate: null,
      },
    };
    const resolveAuthority = jest.fn()
      .mockResolvedValueOnce(localResolved)
      .mockResolvedValueOnce(localResolved)
      .mockResolvedValueOnce(remoteResolved);
    const requestResolved = jest.fn(async () => ({
      authority: localResolved.authority,
      statusCode: 200,
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: Buffer.from(JSON.stringify({ models: [] }), 'utf8'),
      streaming: false as const,
    }));
    let bridge: Awaited<ReturnType<typeof openOllamaProjectModelBridge>> | undefined;
    try {
      bridge = await openOllamaProjectModelBridge({
        context: fixture.context,
        sessionId: 'ollama-session-authority-drift',
        model: 'qwen3:8b',
        modelDigest: MODEL_DIGEST,
        backend: LOCAL_BACKEND,
        allowedToolNames: ['project_read'],
        options: {
          resolveAuthority: resolveAuthority as any,
          requestResolved: requestResolved as any,
        },
      });
      await expect(bridge.client.listModels()).resolves.toEqual({ models: [] });
      await expect(bridge.client.showModel()).rejects.toThrow(/backend identity changed/i);
      expect(requestResolved).toHaveBeenCalledTimes(1);
    } finally {
      await bridge?.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
