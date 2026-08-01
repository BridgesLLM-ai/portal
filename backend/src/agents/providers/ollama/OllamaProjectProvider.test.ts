import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../services/projectEgressPolicy';

const mockSessions = new Map<string, any>();
let mockSessionCounter = 0;

jest.mock('../NativeSessionStore', () => ({
  createNativeSession: (provider: string, userId: string, config: any) => {
    const now = '2026-07-20T12:00:00.000Z';
    const session = {
      sessionId: 'ollama-project-session-' + (++mockSessionCounter),
      provider,
      userId,
      createdAt: now,
      lastActivityAt: now,
      cwd: config.executionContext.canonicalRoot,
      model: config.model,
      executionContext: config.executionContext,
      metadata: { ...(config.metadata || {}) },
      messages: [],
    };
    mockSessions.set(session.sessionId, session);
    return session;
  },
  loadNativeSession: (_provider: string, sessionId: string) => mockSessions.get(sessionId) || null,
  appendNativeMessage: (session: any, message: any) => {
    session.messages.push(message);
    session.lastActivityAt = message.timestamp;
    return session;
  },
  updateNativeSessionMetadata: (_provider: string, sessionId: string, metadata: any) => {
    const session = mockSessions.get(sessionId);
    if (!session) return null;
    session.metadata = { ...(session.metadata || {}), ...metadata };
    return session;
  },
  readAllNativeSessionHistory: (_provider: string, sessionId: string) => [...(mockSessions.get(sessionId)?.messages || [])],
  listNativeSessions: (_provider: string, userId: string) => [...mockSessions.values()]
    .filter((session) => session.userId === userId)
    .map((session) => ({
      sessionId: session.sessionId,
      status: 'active',
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    })),
  clearNativeSessionHistory: (session: any) => { session.messages = []; return session; },
  deleteNativeSession: (_provider: string, sessionId: string) => { mockSessions.delete(sessionId); },
}));

import { AgentAbortError } from '../../AgentProvider.interface';
import {
  OllamaProjectProvider,
  proveOllamaProjectModel,
  readOllamaProjectChatStream,
} from './OllamaProjectProvider';
import {
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  OllamaProjectRuntimeTerminationError,
} from './OllamaProjectToolRuntime';
import type { OllamaProjectModelBridgeClient, OllamaProjectModelBridgeHandle } from './OllamaProjectModelBridge';
import { qualifyOllamaProjectFoundation } from './OllamaProjectQualification';
import { withOllamaAuthorityMutationFence } from '../../../services/ollamaAuthorityBarrier';

const MODEL = 'qwen3:8b';
const DIGEST_HEX = 'd'.repeat(64);
const DIGEST = `sha256:${DIGEST_HEX}`;
const LOCAL_BACKEND = Object.freeze({
  backendKind: 'LOCAL' as const,
  backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
  backendGeneration: null,
});
const MODEL_SELECTION = Object.freeze({
  model: MODEL,
  digest: DIGEST as `sha256:${string}`,
  capabilities: Object.freeze(['completion', 'thinking', 'tools']),
  ...LOCAL_BACKEND,
});
const SESSION_METADATA = Object.freeze({
  ollamaModelDigest: DIGEST,
  ollamaBackendKind: LOCAL_BACKEND.backendKind,
  ollamaBackendFingerprint: LOCAL_BACKEND.backendFingerprint,
  ollamaBackendGeneration: LOCAL_BACKEND.backendGeneration,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeContext(): { root: string; context: ProjectSandboxExecutionContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-project-provider-'));
  const stat = fs.lstatSync(root, { bigint: true });
  return {
    root,
    context: Object.freeze({
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: 'actor-provider',
      projectId: 'project-provider',
      workspaceOwnerId: 'owner-provider',
      projectName: 'provider-test',
      canonicalRoot: fs.realpathSync(root),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
      runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
      egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
      runtimeImageDigest: 'sha256:' + 'a'.repeat(64),
      policyFingerprint: 'b'.repeat(64),
    }),
  };
}

function ndjson(...rows: any[]): Response {
  return new Response(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function clientWith(chat: jest.Mock): OllamaProjectModelBridgeClient {
  return {
    baseUrl: 'http://127.0.0.1:45000',
    scopeFingerprint: 'f'.repeat(64),
    ...LOCAL_BACKEND,
    listModels: jest.fn(async () => ({ models: [{ name: MODEL, digest: DIGEST_HEX }] })),
    showModel: jest.fn(async () => ({ capabilities: ['completion', 'thinking', 'tools'] })),
    chat,
  };
}

function bridgeWith(client: OllamaProjectModelBridgeClient): OllamaProjectModelBridgeHandle {
  return {
    client,
    baseUrl: client.baseUrl,
    scopeFingerprint: client.scopeFingerprint,
    credentialHash: 'e'.repeat(64),
    proveBoundary: jest.fn(async () => ({
      unauthenticatedStatus: 401 as const,
      scopeMismatchStatus: 403 as const,
      disallowedRouteStatus: 404 as const,
      evidenceSha256: 'a'.repeat(64),
    })),
    close: jest.fn(async () => undefined),
  };
}

describe('Ollama Project coding provider', () => {
  beforeEach(() => {
    mockSessions.clear();
    mockSessionCounter = 0;
  });

  test('parses official streaming thinking/content/tool_calls and rejects malformed NDJSON', async () => {
    const response = ndjson(
      { message: { role: 'assistant', thinking: 'checking ' }, done: false },
      { message: { role: 'assistant', content: 'working', tool_calls: [{ id: 'call-1', function: { name: 'project_read', arguments: { path: 'README.md' } } }] }, done: false },
      { message: { role: 'assistant', content: ' now' }, done: true, done_reason: 'stop', eval_count: 12 },
    );
    const thinking: string[] = [];
    const content: string[] = [];
    await expect(readOllamaProjectChatStream(response, {
      onThinking: (chunk) => thinking.push(chunk),
      onContent: (chunk) => content.push(chunk),
    })).resolves.toEqual(expect.objectContaining({
      thinking: 'checking ',
      content: 'working now',
      toolCalls: [{ id: 'call-1', function: { name: 'project_read', arguments: { path: 'README.md' } } }],
      doneReason: 'stop',
      metrics: { eval_count: 12 },
    }));
    expect(thinking).toEqual(['checking ']);
    expect(content).toEqual(['working', ' now']);
    await expect(readOllamaProjectChatStream(new Response('{bad json}\n'))).rejects.toThrow('invalid NDJSON');
  });

  test('accepts terminal done as protocol completion, cancels withheld EOF, and preserves stream failures', async () => {
    let exactResponseCancelled = false;
    const terminal = JSON.stringify({
      message: { role: 'assistant', content: 'terminal answer' },
      done: true,
      done_reason: 'stop',
      eval_count: 9,
    }) + '\n';
    const withheldEof = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(terminal, 'utf8'));
        // Deliberately never close. The terminal record is the native protocol
        // completion boundary.
      },
      cancel() {
        exactResponseCancelled = true;
      },
    }), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });

    await expect(readOllamaProjectChatStream(withheldEof)).resolves.toEqual(
      expect.objectContaining({
        content: 'terminal answer',
        doneReason: 'stop',
        metrics: { eval_count: 9 },
      }),
    );
    expect(exactResponseCancelled).toBe(true);

    await expect(readOllamaProjectChatStream(new Response(
      `${JSON.stringify({
        message: { role: 'assistant', content: 'partial' },
        done: false,
      })}\n`,
    ))).rejects.toThrow(/terminal done record/i);
    await expect(readOllamaProjectChatStream(new Response(
      terminal + JSON.stringify({
        message: { role: 'assistant', content: 'late' },
        done: false,
      }) + '\n',
    ))).rejects.toThrow(/data after its terminal record/i);
    await expect(readOllamaProjectChatStream(new Response(
      Buffer.concat([
        Buffer.from(terminal, 'utf8'),
        Buffer.from([0xf0]),
      ]),
    ))).rejects.toThrow(/invalid UTF-8/i);
  });

  test.each([
    {
      name: 'a missing done flag',
      payload: JSON.stringify({
        message: { role: 'assistant', content: 'missing done' },
      }) + '\n',
      error: /without a valid done flag/i,
    },
    {
      name: 'a malformed error record',
      payload: JSON.stringify({
        error: { message: 'not a native Ollama error' },
        done: true,
      }) + '\n',
      error: /invalid error record/i,
    },
    {
      name: 'a control-only error record',
      payload: JSON.stringify({
        error: '\u0000\t',
      }) + '\n',
      error: /invalid error record/i,
    },
    {
      name: 'a missing message record',
      payload: JSON.stringify({
        done: true,
      }) + '\n',
      error: /invalid message record/i,
    },
    {
      name: 'a missing assistant message role',
      payload: JSON.stringify({
        message: { content: 'missing role' },
        done: true,
      }) + '\n',
      error: /invalid message role/i,
    },
    {
      name: 'a non-assistant message role',
      payload: JSON.stringify({
        message: { role: 'user', content: 'wrong role' },
        done: true,
      }) + '\n',
      error: /invalid message role/i,
    },
    {
      name: 'a control-bearing done reason',
      payload: JSON.stringify({
        message: { role: 'assistant', content: 'bad reason' },
        done: true,
        done_reason: '\u0000stop',
      }) + '\n',
      error: /invalid done reason/i,
    },
    {
      name: 'an oversized done reason',
      payload: JSON.stringify({
        message: { role: 'assistant', content: 'bad reason' },
        done: true,
        done_reason: 'r'.repeat(129),
      }) + '\n',
      error: /invalid done reason/i,
    },
    {
      name: 'a nonnumeric final metric',
      payload: JSON.stringify({
        message: { role: 'assistant', content: 'bad metric' },
        done: true,
        eval_count: 'nine',
      }) + '\n',
      error: /invalid final metrics/i,
    },
    {
      name: 'a fractional final metric',
      payload: JSON.stringify({
        message: { role: 'assistant', content: 'bad metric' },
        done: true,
        eval_count: 1.5,
      }) + '\n',
      error: /invalid final metrics/i,
    },
    {
      name: 'an unsafe-integer final metric',
      payload: JSON.stringify({
        message: { role: 'assistant', content: 'bad metric' },
        done: true,
        eval_count: Number.MAX_SAFE_INTEGER + 1,
      }) + '\n',
      error: /invalid final metrics/i,
    },
    {
      name: 'a negative-zero final metric',
      payload: '{"message":{"role":"assistant","content":"bad metric"},"done":true,"eval_count":-0}\n',
      error: /invalid final metrics/i,
    },
    {
      name: 'a malformed tool-call list',
      payload: JSON.stringify({
        message: { role: 'assistant', tool_calls: {} },
        done: true,
      }) + '\n',
      error: /invalid tool-call list/i,
    },
    {
      name: 'a tool call with array arguments',
      payload: JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [{
            function: {
              name: 'project_read',
              arguments: ['README.md'],
            },
          }],
        },
        done: true,
      }) + '\n',
      error: /invalid tool call/i,
    },
    {
      name: 'a tool call with a non-string identity',
      payload: JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 42,
            function: {
              name: 'project_read',
              arguments: { path: 'README.md' },
            },
          }],
        },
        done: true,
      }) + '\n',
      error: /invalid tool call/i,
    },
    {
      name: 'an unsafe tool argument',
      payload: '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"project_read","arguments":{"line_count":1e309}}}]},"done":true}\n',
      error: /unsafe tool arguments/i,
    },
    {
      name: 'a negative-zero tool argument',
      payload: '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"project_read","arguments":{"line_count":-0}}}]},"done":true}\n',
      error: /unsafe tool arguments/i,
    },
    {
      name: 'a tool argument tree above the node budget',
      payload: JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [{
            function: {
              name: 'project_read',
              arguments: { nodes: Array(16_384).fill(null) },
            },
          }],
        },
        done: true,
      }) + '\n',
      error: /arguments exceeded the safety limit/i,
    },
    {
      name: 'a tool argument payload above the byte budget',
      payload: JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [{
            function: {
              name: 'project_write',
              arguments: {
                path: 'large.txt',
                content: 'x'.repeat(2 * 1024 * 1024),
              },
            },
          }],
        },
        done: true,
      }) + '\n',
      error: /safety limit/i,
    },
    {
      name: 'a control-bearing tool identity',
      payload: JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'tool\u0000identity',
            function: {
              name: 'project_read',
              arguments: { path: 'README.md' },
            },
          }],
        },
        done: true,
      }) + '\n',
      error: /invalid tool call/i,
    },
  ])('rejects $name as a malformed Project stream', async ({
    payload,
    error,
  }) => {
    await expect(
      readOllamaProjectChatStream(new Response(payload)),
    ).rejects.toThrow(error);
  });

  test('does not emit terminal content before its metrics pass validation', async () => {
    const content: string[] = [];
    await expect(readOllamaProjectChatStream(new Response(
      JSON.stringify({
        message: { role: 'assistant', content: 'must stay provisional' },
        done: true,
        eval_count: -1,
      }) + '\n',
    ), {
      onContent: (chunk) => content.push(chunk),
    })).rejects.toThrow(/invalid final metrics/i);
    expect(content).toEqual([]);
  });

  test('counts repeated tool-call IDs across Project stream records', async () => {
    const payload = Array.from({ length: 25 }, () => JSON.stringify({
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'duplicate-project-tool-id',
          function: {
            name: 'project_read',
            arguments: { path: 'README.md' },
          },
        }],
      },
      done: false,
    }) + '\n').join('');

    await expect(
      readOllamaProjectChatStream(new Response(payload)),
    ).rejects.toThrow(/too many tool calls/i);
  });

  test('requires exact installed identity, advertised tools, and a real nonce tool call', async () => {
    const chat = jest.fn(async (_request: any) => ndjson({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce: 'proof-nonce' } } }],
      },
      done: true,
    }));
    await expect(proveOllamaProjectModel({
      client: clientWith(chat),
      model: MODEL,
      nonceFactory: () => 'proof-nonce',
    })).resolves.toEqual({
      model: MODEL,
      digest: DIGEST,
      capabilities: ['completion', 'thinking', 'tools'],
      ...LOCAL_BACKEND,
      toolProbe: true,
    });
    const noToolClient = clientWith(chat);
    noToolClient.showModel = jest.fn(async () => ({ capabilities: ['completion'] }));
    await expect(proveOllamaProjectModel({ client: noToolClient, model: MODEL }))
      .rejects.toThrow('does not advertise native tool calling');
  });

  test('qualification binds runtime, authenticated bridge, exact model digest, and tool proof evidence', async () => {
    const fixture = makeContext();
    const runtime = {
      qualify: jest.fn(async () => ({
        containerId: 'c'.repeat(64),
        containerName: 'p4ol-test',
        runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest,
        startedAt: '2026-07-20T12:00:00Z',
        accessProof: {
          runtimeUid: 1000,
          runtimeGid: 1000,
          projectRwWriteReadUnlink: true,
          evidenceSha256: '9'.repeat(64),
        },
      })),
    } as any;
    const client = clientWith(jest.fn(async () => ndjson({
      message: { role: 'assistant', tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce: 'qualification-nonce' } } }] },
      done: true,
    })));
    const bridge = bridgeWith(client);
    try {
      await expect(qualifyOllamaProjectFoundation({
        context: fixture.context,
        modelSelection: MODEL_SELECTION,
        options: {
          runtime,
          bridgeFactory: async () => bridge,
          nonceFactory: () => 'qualification-nonce',
          now: () => Date.parse('2026-07-20T12:00:00.000Z'),
        },
      })).resolves.toEqual(expect.objectContaining({
        schema: 'bridgesllm.ollama-project-qualification.v1',
        containerNetwork: 'none',
        exactProjectRwBind: true,
        nonRootReadOnlyCapDrop: true,
        modelBridgeLoopbackOnly: true,
        modelBridgeAuthenticated: true,
        model: MODEL,
        modelDigest: DIGEST,
        modelToolProbe: true,
        qualifiedAt: '2026-07-20T12:00:00.000Z',
      }));
      expect(bridge.close).toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('runs a bounded correlated tool loop and resumes native transcript context', async () => {
    const fixture = makeContext();
    const runtime = {
      ensure: jest.fn(async () => ({
        containerId: 'c'.repeat(64),
        containerName: 'p4ol-test',
        runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest,
        startedAt: '2026-07-20T12:00:00Z',
      })),
      runTool: jest.fn(async () => ({ ok: true, output: '1: project source\n' })),
      abort: jest.fn(async () => true),
      terminate: jest.fn(async () => true),
    } as any;
    const qualificationChat = jest.fn(async (_request: any) => ndjson({
      message: { role: 'assistant', content: '', tool_calls: [{ id: 'probe', function: { name: 'portal_capability_probe', arguments: { nonce: 'fixed-proof' } } }] },
      done: true,
    }));
    const firstTurnChat = jest.fn<Promise<Response>, [any]>()
      .mockResolvedValueOnce(ndjson(
        { message: { role: 'assistant', thinking: 'Inspecting the source.' }, done: false },
        { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-read-1', function: { name: 'project_read', arguments: { path: 'main.ts' } } }] }, done: true },
      ))
      .mockResolvedValueOnce(ndjson({ message: { role: 'assistant', content: 'Implemented and tested.' }, done: true, eval_count: 4 }));
    const secondTurnChat = jest.fn(async (_request: any) => ndjson({ message: { role: 'assistant', content: 'The prior change is still in context.' }, done: true }));
    const allBridges = [
      bridgeWith(clientWith(qualificationChat)),
      bridgeWith(clientWith(firstTurnChat)),
      bridgeWith(clientWith(secondTurnChat)),
    ];
    const bridges = [...allBridges];
    const bridgeFactory = jest.fn(async () => {
      const bridge = bridges.shift();
      if (!bridge) throw new Error('unexpected bridge request');
      return bridge;
    });
    const provider = new OllamaProjectProvider({
      runtime,
      bridgeFactory,
      idFactory: (() => { let id = 0; return () => 'message-' + (++id); })(),
    });
    // Keep qualification deterministic while still proving a genuine tool call.
    qualificationChat.mockImplementation(async (request: any) => {
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0] || 'fixed-proof';
      return ndjson({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'probe', function: { name: 'portal_capability_probe', arguments: { nonce } } }] }, done: true });
    });

    try {
      const sessionId = await provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      });
      await expect(provider.sendMessage(
        sessionId,
        'unauthorized turn',
        undefined,
        undefined,
        undefined,
        { label: 'Other', userId: 'other-actor' },
      )).rejects.toThrow('does not belong');
      const chunks: string[] = [];
      const statuses: any[] = [];
      await expect(provider.sendMessage(
        sessionId,
        'Inspect main.ts and fix it.',
        (chunk) => chunks.push(chunk),
        (event) => statuses.push(event),
        undefined,
        { label: 'Owner', userId: fixture.context.userId },
      )).resolves.toEqual(expect.objectContaining({
        fullText: 'Implemented and tested.',
        metadata: expect.objectContaining({
          executionScope: 'PROJECT_SANDBOX',
          toolCalls: 1,
          supportsAbort: true,
          modelDigest: DIGEST,
        }),
      }));
      expect(chunks).toEqual(['Implemented and tested.']);
      expect(runtime.runTool).toHaveBeenCalledWith(
        fixture.context,
        'project_read',
        { path: 'main.ts' },
        expect.any(AbortSignal),
      );
      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'thinking', content: 'Inspecting the source.' }),
        expect.objectContaining({ type: 'tool_start', toolCallId: 'call-read-1', toolName: 'project_read' }),
        expect.objectContaining({ type: 'tool_update', toolCallId: 'call-read-1' }),
        expect.objectContaining({ type: 'tool_end', toolCallId: 'call-read-1', status: 'done' }),
      ]));
      const secondRequest = firstTurnChat.mock.calls[1][0];
      expect(secondRequest.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'tool', tool_name: 'project_read' }),
      ]));

      await provider.sendMessage(sessionId, 'What did you change?');
      const resumedRequest = secondTurnChat.mock.calls[0][0];
      expect(resumedRequest.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Inspect main.ts and fix it.' }),
        expect.objectContaining({ role: 'assistant', content: 'Implemented and tested.' }),
        expect.objectContaining({ role: 'user', content: 'What did you change?' }),
      ]));
      await expect(provider.getHistory(sessionId)).resolves.toHaveLength(4);
      expect(bridgeFactory).toHaveBeenCalledTimes(3);
      expect(bridges).toHaveLength(0);
      for (const bridge of allBridges) expect(bridge.close).toHaveBeenCalledTimes(1);
      await provider.resetSession(sessionId);
      await expect(provider.getHistory(sessionId)).resolves.toEqual([]);
      expect(runtime.terminate).toHaveBeenCalledWith(fixture.context);
      await provider.terminateSession(sessionId);
      await expect(provider.getHistory(sessionId)).rejects.toThrow('not found');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('abort closes the scoped bridge, kills the confined runtime, and rejects with AgentAbortError', async () => {
    const fixture = makeContext();
    const runtime = {
      ensure: jest.fn(async () => ({
        containerId: 'c'.repeat(64), containerName: 'p4ol-test', runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest, startedAt: '2026-07-20T12:00:00Z',
      })),
      runTool: jest.fn(),
      abort: jest.fn(async () => true),
      terminate: jest.fn(async () => true),
    } as any;
    const qualificationClient = clientWith(jest.fn(async (request: any) => {
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0];
      return ndjson({ message: { role: 'assistant', tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce } } }] }, done: true });
    }));
    let pendingStarted!: () => void;
    const started = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const pendingClient = clientWith(jest.fn((_request: any, signal?: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      pendingStarted();
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const pendingBridge = bridgeWith(pendingClient);
    const bridges = [bridgeWith(qualificationClient), pendingBridge];
    const provider = new OllamaProjectProvider({
      runtime,
      bridgeFactory: async () => bridges.shift()!,
    });
    try {
      const sessionId = await provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      });
      const turn = provider.sendMessage(
        sessionId,
        'Run a long test.',
        undefined,
        undefined,
        undefined,
        { label: 'Owner', userId: fixture.context.userId, requestId: 'ollama-turn-1' },
      );
      await started;
      await expect(provider.abortActiveRun(sessionId, 'stale-ollama-turn')).resolves.toBe(false);
      expect(runtime.abort).not.toHaveBeenCalled();
      await expect(provider.abortActiveRun(sessionId, 'ollama-turn-1')).resolves.toBe(true);
      await expect(turn).rejects.toBeInstanceOf(AgentAbortError);
      expect(runtime.abort).toHaveBeenCalledWith(fixture.context);
      expect(pendingBridge.close).toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('holds one authority lease across session proof and the complete model/tool turn through bridge close', async () => {
    const fixture = makeContext();
    const runtime = {
      ensure: jest.fn(async () => ({
        containerId: 'c'.repeat(64), containerName: 'p4ol-test', runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest, startedAt: '2026-07-20T12:00:00Z',
      })),
      runTool: jest.fn(),
      abort: jest.fn(async () => true),
      terminate: jest.fn(async () => true),
    } as any;
    const qualificationStarted = deferred<void>();
    const releaseQualification = deferred<void>();
    const qualificationClient = clientWith(jest.fn(async (request: any) => {
      qualificationStarted.resolve();
      await releaseQualification.promise;
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0];
      return ndjson({
        message: {
          role: 'assistant',
          tool_calls: [{
            function: {
              name: 'portal_capability_probe',
              arguments: { nonce },
            },
          }],
        },
        done: true,
      });
    }));
    const turnStarted = deferred<void>();
    const releaseTurn = deferred<void>();
    const turnClient = clientWith(jest.fn(async () => {
      turnStarted.resolve();
      await releaseTurn.promise;
      return ndjson({
        message: { role: 'assistant', content: 'Authority stayed pinned.' },
        done: true,
      });
    }));
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const turnBridge = bridgeWith(turnClient);
    turnBridge.close = jest.fn(async () => {
      closeStarted.resolve();
      await releaseClose.promise;
    });
    const bridges = [bridgeWith(qualificationClient), turnBridge];
    const provider = new OllamaProjectProvider({
      runtime,
      bridgeFactory: async () => bridges.shift()!,
    });
    const mutate = jest.fn(async () => 'mutated');
    let start: Promise<string> | null = null;
    let turn: Promise<any> | null = null;
    try {
      start = provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      });
      await qualificationStarted.promise;
      await expect(withOllamaAuthorityMutationFence(mutate)).rejects.toMatchObject({
        code: 'OLLAMA_AUTHORITY_BUSY',
        statusCode: 409,
      });
      expect(mutate).not.toHaveBeenCalled();

      releaseQualification.resolve();
      const sessionId = await start;
      turn = provider.sendMessage(
        sessionId,
        'Keep this backend identity for the complete turn.',
        undefined,
        undefined,
        undefined,
        { label: 'Owner', userId: fixture.context.userId, requestId: 'authority-lease-turn' },
      );
      await turnStarted.promise;
      await expect(withOllamaAuthorityMutationFence(mutate)).rejects.toMatchObject({
        code: 'OLLAMA_AUTHORITY_BUSY',
        statusCode: 409,
      });

      releaseTurn.resolve();
      await closeStarted.promise;
      await expect(withOllamaAuthorityMutationFence(mutate)).rejects.toMatchObject({
        code: 'OLLAMA_AUTHORITY_BUSY',
        statusCode: 409,
      });
      releaseClose.resolve();
      await expect(turn).resolves.toMatchObject({ fullText: 'Authority stayed pinned.' });
      await expect(withOllamaAuthorityMutationFence(mutate)).resolves.toBe('mutated');
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally {
      releaseQualification.resolve();
      releaseTurn.resolve();
      releaseClose.resolve();
      await start?.catch(() => undefined);
      await turn?.catch(() => undefined);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('abort cannot settle before a delayed initial ensure is removed and never opens a cancelled bridge', async () => {
    const fixture = makeContext();
    const runtimeHandle = {
      containerId: 'c'.repeat(64), containerName: 'p4ol-test', runtimeFingerprint: 'f'.repeat(64),
      runtimeImage: fixture.context.runtimeImageDigest, startedAt: '2026-07-20T12:00:00Z',
    };
    let releaseSendEnsure!: () => void;
    const sendEnsureGate = new Promise<void>((resolve) => { releaseSendEnsure = resolve; });
    let announceSendEnsure!: () => void;
    const sendEnsureStarted = new Promise<void>((resolve) => { announceSendEnsure = resolve; });
    let ensureCalls = 0;
    const runtime = {
      ensure: jest.fn(async () => {
        ensureCalls += 1;
        if (ensureCalls === 1) return runtimeHandle;
        announceSendEnsure();
        await sendEnsureGate;
        return runtimeHandle;
      }),
      runTool: jest.fn(),
      abort: jest.fn(async () => {
        // The real runtime lifecycle lock holds abort behind the in-flight
        // ensure, then removes and re-inspects that late-created container.
        await sendEnsureGate;
        return true;
      }),
      terminate: jest.fn(async () => true),
    } as any;
    const qualificationClient = clientWith(jest.fn(async (request: any) => {
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0];
      return ndjson({ message: { role: 'assistant', tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce } } }] }, done: true });
    }));
    const bridgeFactory = jest.fn(async () => bridgeWith(qualificationClient));
    const provider = new OllamaProjectProvider({ runtime, bridgeFactory });
    try {
      const sessionId = await provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      });
      const turn = provider.sendMessage(
        sessionId,
        'Cancel during runtime admission.',
        undefined,
        undefined,
        undefined,
        { label: 'Owner', userId: fixture.context.userId, requestId: 'ensure-race-turn' },
      );
      await sendEnsureStarted;
      let abortSettled = false;
      const aborting = provider.abortActiveRun(sessionId, 'ensure-race-turn').then((result) => {
        abortSettled = true;
        return result;
      });
      await Promise.resolve();
      expect(abortSettled).toBe(false);

      releaseSendEnsure();
      await expect(aborting).resolves.toBe(true);
      await expect(turn).rejects.toBeInstanceOf(AgentAbortError);
      expect(runtime.abort).toHaveBeenCalledWith(fixture.context);
      // Qualification owns the only bridge. The cancelled send never opens a
      // second model bridge after its delayed ensure returns.
      expect(bridgeFactory).toHaveBeenCalledTimes(1);
    } finally {
      releaseSendEnsure();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('quarantines a cancelled project until repeated abort proves the exact runtime stopped', async () => {
    const fixture = makeContext();
    const runtime = {
      ensure: jest.fn(async () => ({
        containerId: 'c'.repeat(64), containerName: 'p4ol-test', runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest, startedAt: '2026-07-20T12:00:00Z',
      })),
      runTool: jest.fn(),
      abort: jest.fn()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('docker stop failed'))
        .mockResolvedValueOnce(true),
      terminate: jest.fn(async () => true),
    } as any;
    const qualificationClient = clientWith(jest.fn(async (request: any) => {
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0];
      return ndjson({ message: { role: 'assistant', tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce } } }] }, done: true });
    }));
    let pendingStarted!: () => void;
    const started = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const pendingClient = clientWith(jest.fn((_request: any, signal?: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      pendingStarted();
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const resumedClient = clientWith(jest.fn(async () => ndjson({
      message: { role: 'assistant', content: 'Recovered after verified termination.' },
      done: true,
    })));
    const bridges = [
      bridgeWith(qualificationClient),
      bridgeWith(pendingClient),
      bridgeWith(resumedClient),
    ];
    const provider = new OllamaProjectProvider({
      runtime,
      bridgeFactory: async () => bridges.shift()!,
    });
    try {
      const sessionId = await provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      });
      const turn = provider.sendMessage(
        sessionId,
        'Run a long test.',
        undefined,
        undefined,
        undefined,
        { label: 'Owner', userId: fixture.context.userId, requestId: 'quarantine-turn-1' },
      );
      await started;
      await expect(provider.abortActiveRun(sessionId, 'stale-turn')).resolves.toBe(false);
      expect(runtime.abort).not.toHaveBeenCalled();
      await expect(provider.abortActiveRun(sessionId, 'quarantine-turn-1')).resolves.toBe(false);
      await expect(turn).rejects.toBeInstanceOf(AgentAbortError);
      await expect(provider.sendMessage(sessionId, 'Must stay blocked.'))
        .rejects.toThrow(/quarantined|active turn/i);
      await expect(provider.abortActiveRun(sessionId, 'quarantine-turn-1')).resolves.toBe(false);
      await expect(provider.sendMessage(sessionId, 'Still blocked.'))
        .rejects.toThrow(/quarantined|active turn/i);
      await expect(provider.abortActiveRun(sessionId, 'quarantine-turn-1')).resolves.toBe(true);
      await expect(provider.sendMessage(
        sessionId,
        'Continue after recovery.',
        undefined,
        undefined,
        undefined,
        { label: 'Owner', userId: fixture.context.userId, requestId: 'quarantine-turn-2' },
      )).resolves.toMatchObject({ fullText: 'Recovered after verified termination.' });
      expect(runtime.abort).toHaveBeenCalledTimes(3);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('keeps the project quarantined when a tool stop cannot prove runtime termination', async () => {
    const fixture = makeContext();
    const runtime = {
      ensure: jest.fn(async () => ({
        containerId: 'c'.repeat(64), containerName: 'p4ol-test', runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest, startedAt: '2026-07-20T12:00:00Z',
      })),
      runTool: jest.fn(async () => { throw new OllamaProjectRuntimeTerminationError(); }),
      abort: jest.fn(async () => false),
      terminate: jest.fn(async () => true),
    } as any;
    const qualificationClient = clientWith(jest.fn(async (request: any) => {
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0];
      return ndjson({ message: { role: 'assistant', tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce } } }] }, done: true });
    }));
    const toolClient = clientWith(jest.fn(async () => ndjson({
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'tool-unconfirmed-stop', function: { name: 'project_read', arguments: { path: 'README.md' } } }],
      },
      done: true,
    })));
    const bridges = [bridgeWith(qualificationClient), bridgeWith(toolClient)];
    const provider = new OllamaProjectProvider({
      runtime,
      bridgeFactory: async () => bridges.shift()!,
    });
    try {
      const sessionId = await provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      });
      await expect(provider.sendMessage(
        sessionId,
        'Read the project.',
        undefined,
        undefined,
        undefined,
        { label: 'Owner', userId: fixture.context.userId, requestId: 'tool-stop-turn' },
      )).rejects.toBeInstanceOf(OllamaProjectRuntimeTerminationError);
      expect(mockSessions.get(sessionId)?.metadata).toMatchObject({
        ollamaRuntimeQuarantined: true,
        ollamaQuarantineReason: 'TOOL_RUNTIME_TERMINATION_UNCONFIRMED',
      });
      await expect(provider.sendMessage(sessionId, 'Must remain blocked.'))
        .rejects.toThrow(/quarantined|active turn/i);
      await expect(provider.abortActiveRun(sessionId, 'tool-stop-turn')).resolves.toBe(false);
      mockSessions.delete(sessionId);
      bridges.push(bridgeWith(qualificationClient));
      await provider.convergeAttestedProjectCleanup({
        userId: fixture.context.userId,
        projectId: fixture.context.projectId,
        canonicalRoot: fixture.context.canonicalRoot,
        rootDevice: fixture.context.rootDevice,
        rootInode: fixture.context.rootInode,
        rootBirthtimeNs: fixture.context.rootBirthtimeNs,
        sessionIds: [sessionId],
      });
      await expect(provider.startSession(fixture.context.userId, {
        executionContext: fixture.context,
        model: MODEL,
        metadata: SESSION_METADATA,
      })).resolves.toMatch(/ollama-project-session-/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('quarantines a failed session proof until exact cleanup can be re-proved', async () => {
    const fixture = makeContext();
    const runtime = {
      ensure: jest.fn(async () => ({
        containerId: 'c'.repeat(64), containerName: 'p4ol-test', runtimeFingerprint: 'f'.repeat(64),
        runtimeImage: fixture.context.runtimeImageDigest, startedAt: '2026-07-20T12:00:00Z',
      })),
      runTool: jest.fn(),
      abort: jest.fn(async () => true),
      terminate: jest.fn(async () => false),
    } as any;
    const unqualifiedClient = clientWith(jest.fn());
    unqualifiedClient.showModel = jest.fn(async () => ({ capabilities: ['completion'] }));
    const qualifiedClient = clientWith(jest.fn(async (request: any) => {
      const nonce = request.messages[1].content.match(/[a-f0-9]{32}/)?.[0];
      return ndjson({ message: { role: 'assistant', tool_calls: [{ function: { name: 'portal_capability_probe', arguments: { nonce } } }] }, done: true });
    }));
    const bridges = [bridgeWith(unqualifiedClient), bridgeWith(qualifiedClient)];
    const provider = new OllamaProjectProvider({
      runtime,
      bridgeFactory: async () => bridges.shift()!,
    });
    const config = {
      executionContext: fixture.context,
      model: MODEL,
      metadata: SESSION_METADATA,
    };
    try {
      await expect(provider.startSession(fixture.context.userId, config))
        .rejects.toThrow(/project is quarantined/i);
      expect(runtime.terminate).toHaveBeenCalledTimes(1);
      expect([...mockSessions.values()]).toHaveLength(1);
      expect([...mockSessions.values()][0].metadata).toMatchObject({
        ollamaRuntimeQuarantined: true,
        ollamaQuarantineReason: 'SESSION_MODEL_PROOF_CLEANUP_UNCONFIRMED',
      });
      await expect(provider.startSession(fixture.context.userId, config))
        .rejects.toThrow(/remains quarantined/i);
      expect(runtime.terminate).toHaveBeenCalledTimes(2);
      expect([...mockSessions.values()]).toHaveLength(1);

      runtime.terminate.mockResolvedValue(true);
      await expect(provider.startSession(fixture.context.userId, config)).resolves.toMatch(/ollama-project-session-/);
      expect(runtime.terminate).toHaveBeenCalledTimes(3);
      expect([...mockSessions.values()]).toHaveLength(1);
      expect([...mockSessions.values()][0].metadata.ollamaRuntimeQuarantined).not.toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
