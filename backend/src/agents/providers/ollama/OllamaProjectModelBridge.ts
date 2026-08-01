import crypto from 'crypto';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { TextDecoder } from 'node:util';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../executionScope';
import {
  requestResolvedOllama,
  resolveOllamaBackendAuthority,
  streamResolvedOllama,
  type ResolvedOllamaBackendAuthority,
} from '../../../services/ollamaBackendAuthority';
import {
  NATIVE_OLLAMA_STREAM_COMPLETE,
} from '../../../services/nativeOllamaTransport';
import type { OllamaProjectBackendIdentity } from '../../../services/ollamaProjectModel';
import {
  canonicalizeLocalOllamaEndpoint,
  resolveLocalOllamaEndpoint,
} from '../../../utils/localOllamaEndpoint';

export const OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION = 'ollama-project-model-bridge-v1';
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_RECORDS = 100_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43,256}$/;
const MODEL_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const MODEL_DIGEST_RE = /^(?:sha256:)?([a-f0-9]{64})$/iu;

export interface OllamaProjectToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaProjectChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

export interface OllamaProjectChatRequest {
  model: string;
  messages: OllamaProjectChatMessage[];
  tools?: OllamaProjectToolDefinition[];
  stream: boolean;
  think?: boolean;
  options?: { temperature?: number; num_ctx?: number };
}

export interface OllamaProjectBridgeScope {
  actorUserId: string;
  projectIdentityId: string;
  sessionId: string;
  model: string;
  modelDigest: `sha256:${string}`;
  backendKind: 'LOCAL' | 'TAILNET';
  backendFingerprint: string;
  backendGeneration: number | null;
}

export interface OllamaProjectModelBridgeClient {
  readonly baseUrl: string;
  readonly scopeFingerprint: string;
  readonly backendKind: 'LOCAL' | 'TAILNET';
  readonly backendFingerprint: string;
  readonly backendGeneration: number | null;
  listModels(signal?: AbortSignal): Promise<any>;
  showModel(signal?: AbortSignal): Promise<any>;
  chat(request: OllamaProjectChatRequest, signal?: AbortSignal): Promise<Response>;
}

export interface OllamaProjectModelBridgeHandle {
  readonly client: OllamaProjectModelBridgeClient;
  readonly baseUrl: string;
  readonly scopeFingerprint: string;
  readonly credentialHash: string;
  proveBoundary(): Promise<OllamaProjectModelBridgeBoundaryProof>;
  close(): Promise<void>;
}

export interface OllamaProjectModelBridgeBoundaryProof {
  unauthenticatedStatus: 401;
  scopeMismatchStatus: 403;
  disallowedRouteStatus: 404;
  evidenceSha256: string;
}

export interface OllamaProjectModelBridgeOptions {
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  resolveAuthority?: typeof resolveOllamaBackendAuthority;
  requestResolved?: typeof requestResolvedOllama;
  streamResolved?: typeof streamResolvedOllama;
  tokenFactory?: () => string;
  requestTimeoutMs?: number;
}

export class OllamaProjectModelBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OllamaProjectModelBridgeError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OllamaProjectModelBridgeError(code, message);
}

class OllamaProjectTerminalDetector {
  private readonly decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  private readonly pendingParts: Buffer[] = [];
  private pendingBytes = 0;
  private records = 0;
  private terminal = false;

  push(chunk: Buffer): boolean {
    if (!Buffer.isBuffer(chunk)) {
      fail('STREAM_PROTOCOL', 'Ollama Project chat returned an invalid stream chunk');
    }
    if (chunk.byteLength === 0) return this.terminal;
    if (this.terminal) {
      fail('STREAM_PROTOCOL', 'Ollama Project chat returned data after its terminal record');
    }

    let offset = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.append(chunk.subarray(offset, index));
      this.consumeLine();
      offset = index + 1;
      if (this.terminal && offset < chunk.byteLength) {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned data after its terminal record');
      }
    }
    if (offset < chunk.byteLength) {
      if (this.terminal) {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned data after its terminal record');
      }
      this.append(chunk.subarray(offset));
    }
    return this.terminal;
  }

  finish(): void {
    if (this.pendingBytes > 0) this.consumeLine();
    if (!this.terminal) {
      fail('STREAM_PROTOCOL', 'Ollama Project chat ended before its terminal done record');
    }
  }

  private append(segment: Buffer): void {
    if (segment.byteLength === 0) return;
    const nextBytes = this.pendingBytes + segment.byteLength;
    if (nextBytes > MAX_STREAM_LINE_BYTES + 1) {
      fail('STREAM_PROTOCOL', 'Ollama Project stream frame exceeded the safety limit');
    }
    if (
      nextBytes === MAX_STREAM_LINE_BYTES + 1
      && segment[segment.byteLength - 1] !== 0x0d
    ) {
      fail('STREAM_PROTOCOL', 'Ollama Project stream frame exceeded the safety limit');
    }
    this.pendingParts.push(Buffer.from(segment));
    this.pendingBytes = nextBytes;
  }

  private consumeLine(): void {
    const parts = this.pendingParts.splice(0);
    const line = Buffer.concat(parts, this.pendingBytes);
    this.pendingBytes = 0;
    for (const part of parts) part.fill(0);
    try {
      let content = line;
      if (content.byteLength > 0 && content[content.byteLength - 1] === 0x0d) {
        content = content.subarray(0, content.byteLength - 1);
      }
      // Preserve compatibility with harmless blank separators while still
      // rejecting any bytes after the terminal record in push().
      if (content.byteLength === 0) return;
      if (content.byteLength > MAX_STREAM_LINE_BYTES) {
        fail('STREAM_PROTOCOL', 'Ollama Project stream frame exceeded the safety limit');
      }
      if (this.records >= MAX_STREAM_RECORDS) {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned too many stream records');
      }
      this.records += 1;

      let decoded: string;
      try {
        decoded = this.decoder.decode(content);
      } catch {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned invalid UTF-8');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded) as unknown;
      } catch {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned invalid NDJSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned an invalid NDJSON record');
      }
      const record = parsed as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, 'error')) {
        if (typeof record.error !== 'string' || !record.error.trim()) {
          fail('STREAM_PROTOCOL', 'Ollama Project chat returned an invalid error record');
        }
        fail(
          'STREAM_PROTOCOL',
          `Ollama Project model error: ${record.error.slice(0, 2_048)}`,
        );
      }
      if (record.done !== undefined && typeof record.done !== 'boolean') {
        fail('STREAM_PROTOCOL', 'Ollama Project chat returned an invalid done flag');
      }
      if (record.done === true) this.terminal = true;
    } finally {
      line.fill(0);
    }
  }
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireModel(value: unknown): string {
  const model = String(value || '').trim();
  if (!MODEL_RE.test(model)) fail('MODEL_IDENTITY', 'Ollama Project model identity is invalid');
  return model;
}

function requireModelDigest(value: unknown): `sha256:${string}` {
  const match = String(value || '').trim().match(MODEL_DIGEST_RE);
  if (!match) {
    fail('MODEL_IDENTITY', 'Ollama Project model digest is invalid');
  }
  return `sha256:${match[1].toLowerCase()}`;
}

function requireLoopbackUpstream(raw: string): string {
  try {
    return canonicalizeLocalOllamaEndpoint(raw);
  } catch {
    fail('UPSTREAM_SCOPE', 'Ollama Project bridge may target only an uncredentialed loopback Ollama root');
  }
}

function requireRequestTimeout(value: unknown): number {
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 100
    || value > REQUEST_TIMEOUT_MS
  ) {
    fail('BRIDGE_TIMEOUT', 'Ollama Project bridge timeout is invalid');
  }
  return value;
}

function normalizeScope(
  context: ProjectSandboxExecutionContext,
  sessionId: string,
  model: string,
  modelDigest: string,
  backend: OllamaProjectBackendIdentity,
): OllamaProjectBridgeScope {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  const normalizedSession = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalizedSession)) {
    fail('SESSION_IDENTITY', 'Ollama Project bridge session identity is invalid');
  }
  const backendKind = backend?.backendKind;
  const backendFingerprint = String(backend?.backendFingerprint || '').trim();
  const backendGeneration = backend?.backendGeneration;
  if (
    (backendKind !== 'LOCAL' && backendKind !== 'TAILNET')
    || !/^[^\u0000-\u001f\u007f]{1,256}$/.test(backendFingerprint)
    || (backendKind === 'LOCAL' && backendGeneration !== null)
    || (
      backendKind === 'TAILNET'
      && (
        !Number.isSafeInteger(backendGeneration)
        || Number(backendGeneration) < 1
      )
    )
  ) {
    fail('BACKEND_IDENTITY', 'Ollama Project bridge backend identity is invalid');
  }
  return Object.freeze({
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    sessionId: normalizedSession,
    model: requireModel(model),
    modelDigest: requireModelDigest(modelDigest),
    backendKind,
    backendFingerprint,
    backendGeneration: backendGeneration as number | null,
  });
}

function assertAuthorityMatches(
  scope: OllamaProjectBridgeScope,
  resolved: ResolvedOllamaBackendAuthority,
): void {
  if (
    resolved.authority.kind !== scope.backendKind
    || resolved.authority.bindingFingerprint !== scope.backendFingerprint
    || resolved.authority.generation !== scope.backendGeneration
    || (
      scope.backendKind === 'TAILNET'
      && (
        resolved.authority.selectedModel !== scope.model
        || resolved.authority.selectedModelDigest !== scope.modelDigest
      )
    )
  ) {
    fail(
      'BACKEND_CHANGED',
      'Ollama Project backend identity changed; qualify the model again',
    );
  }
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const suppliedToken = String(header || '').match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] || '';
  const supplied = Buffer.from(suppliedToken, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_REQUEST_BYTES) fail('REQUEST_SIZE', 'Ollama Project bridge request exceeded the safety limit');
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    fail('REQUEST_JSON', 'Ollama Project bridge request body is invalid');
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function cleanChatMessages(value: unknown): OllamaProjectChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    fail('CHAT_MESSAGES', 'Ollama Project chat messages are invalid');
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('CHAT_MESSAGES', 'Ollama Project chat message is invalid');
    const entry = raw as Record<string, any>;
    if (!['system', 'user', 'assistant', 'tool'].includes(entry.role)) {
      fail('CHAT_MESSAGES', 'Ollama Project chat role is invalid');
    }
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
      fail('CHAT_MESSAGES', 'Ollama Project chat message exceeded the safety limit');
    }
    const message: OllamaProjectChatMessage = { role: entry.role, content };
    if (typeof entry.thinking === 'string') message.thinking = entry.thinking.slice(0, 1024 * 1024);
    if (typeof entry.tool_name === 'string') message.tool_name = entry.tool_name.slice(0, 128);
    if (entry.tool_calls !== undefined) {
      if (!Array.isArray(entry.tool_calls) || entry.tool_calls.length > 16) {
        fail('CHAT_TOOL_CALLS', 'Ollama Project assistant tool calls are invalid');
      }
      message.tool_calls = entry.tool_calls.map((call: any) => {
        const name = String(call?.function?.name || '').trim();
        const args = call?.function?.arguments;
        if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
          fail('CHAT_TOOL_CALLS', 'Ollama Project assistant tool call is invalid');
        }
        return {
          ...(typeof call?.id === 'string' ? { id: call.id.slice(0, 128) } : {}),
          function: { name, arguments: args as Record<string, unknown> },
        };
      });
    }
    return message;
  });
}

function cleanTools(value: unknown, allowedToolNames: ReadonlySet<string>): OllamaProjectToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > allowedToolNames.size) {
    fail('CHAT_TOOLS', 'Ollama Project tool declarations are invalid');
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const entry = raw as any;
    const name = String(entry?.function?.name || '').trim();
    if (
      entry?.type !== 'function'
      || !allowedToolNames.has(name)
      || seen.has(name)
      || typeof entry?.function?.description !== 'string'
      || !entry?.function?.parameters
      || typeof entry.function.parameters !== 'object'
      || Array.isArray(entry.function.parameters)
    ) {
      fail('CHAT_TOOLS', 'Ollama Project tool declaration is outside the allowed contract');
    }
    seen.add(name);
    return {
      type: 'function' as const,
      function: {
        name,
        description: entry.function.description.slice(0, 2048),
        parameters: entry.function.parameters as Record<string, unknown>,
      },
    };
  });
}

function cleanChatRequest(
  value: Record<string, any>,
  scope: OllamaProjectBridgeScope,
  allowedToolNames: ReadonlySet<string>,
): OllamaProjectChatRequest {
  if (requireModel(value.model) !== scope.model) {
    fail('MODEL_SCOPE', 'Ollama Project bridge request model does not match its session scope');
  }
  if (typeof value.stream !== 'boolean') fail('CHAT_STREAM', 'Ollama Project stream flag is required');
  const request: OllamaProjectChatRequest = {
    model: scope.model,
    messages: cleanChatMessages(value.messages),
    tools: cleanTools(value.tools, allowedToolNames),
    stream: value.stream,
    think: value.think === true,
  };
  if (value.options !== undefined) {
    if (!value.options || typeof value.options !== 'object' || Array.isArray(value.options)) {
      fail('CHAT_OPTIONS', 'Ollama Project model options are invalid');
    }
    const options: { temperature?: number; num_ctx?: number } = {};
    if (value.options.temperature !== undefined) {
      const temperature = Number(value.options.temperature);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        fail('CHAT_OPTIONS', 'Ollama Project temperature is invalid');
      }
      options.temperature = temperature;
    }
    if (value.options.num_ctx !== undefined) {
      const numCtx = Number(value.options.num_ctx);
      if (!Number.isSafeInteger(numCtx) || numCtx < 1024 || numCtx > 131_072) {
        fail('CHAT_OPTIONS', 'Ollama Project context size is invalid');
      }
      options.num_ctx = numCtx;
    }
    request.options = options;
  }
  return request;
}

async function relayResponse(
  upstream: Response,
  res: ServerResponse,
  controller: AbortController,
  shouldStream = false,
  onProtocolComplete?: () => void,
): Promise<void> {
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  const terminalDetector = shouldStream
    ? new OllamaProjectTerminalDetector()
    : null;
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new OllamaProjectModelBridgeError('RESPONSE_SIZE', 'Ollama Project bridge response exceeded the safety limit');
      }
      const copy = Buffer.from(value);
      const terminal = terminalDetector?.push(copy) === true;
      if (terminal) onProtocolComplete?.();
      if (!res.write(copy)) await new Promise<void>((resolve) => res.once('drain', resolve));
      if (terminal) {
        // Cancel only this fetch response. A protocol terminal record is not a
        // caller abort, so leave the bridge request controller untouched.
        await reader.cancel().catch(() => undefined);
        res.end();
        return;
      }
    }
    terminalDetector?.finish();
    res.end();
  } finally {
    reader.releaseLock();
  }
}

function streamResponseHeaders(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': contentType.slice(0, 256),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

async function relayStreamChunk(
  res: ServerResponse,
  chunk: Buffer,
  controller: AbortController,
): Promise<void> {
  if (controller.signal.aborted || res.destroyed || res.writableEnded) {
    fail('BRIDGE_ABORTED', 'Ollama Project bridge request was aborted');
  }
  const copy = Buffer.from(chunk);
  if (res.write(copy)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      controller.signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new OllamaProjectModelBridgeError(
        'BRIDGE_ABORTED',
        'Ollama Project bridge request was aborted',
      ));
    };
    const onAbort = () => {
      cleanup();
      reject(new OllamaProjectModelBridgeError(
        'BRIDGE_ABORTED',
        'Ollama Project bridge request was aborted',
      ));
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted || res.destroyed) onAbort();
  });
}

async function requestDirectLoopbackBridge(input: {
  port: number;
  route: string;
  headers?: Readonly<Record<string, string>>;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Response> {
  if (
    !Number.isSafeInteger(input.port)
    || input.port < 1
    || input.port > 65_535
    || !/^\/v1\/(?:tags|show|chat|pull)$/.test(input.route)
  ) {
    fail('BRIDGE_REQUEST', 'Ollama Project bridge request is invalid');
  }
  let encoded: Buffer;
  try {
    encoded = Buffer.from(JSON.stringify(input.body), 'utf8');
  } catch {
    fail('BRIDGE_REQUEST', 'Ollama Project bridge request is invalid');
  }
  if (encoded.byteLength > MAX_REQUEST_BYTES) {
    encoded.fill(0);
    fail('REQUEST_SIZE', 'Ollama Project bridge request exceeded the safety limit');
  }
  if (input.signal?.aborted) {
    encoded.fill(0);
    fail('BRIDGE_ABORTED', 'Ollama Project bridge request was aborted');
  }

  const directAgent = new http.Agent({
    keepAlive: false,
    maxSockets: 1,
    maxFreeSockets: 0,
  });
  directAgent.createConnection = () => net.createConnection({
    host: '127.0.0.1',
    port: input.port,
    family: 4,
  });

  return new Promise<Response>((resolve, reject) => {
    let terminal = false;
    let responseResolved = false;
    let request: http.ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let responseBytes = 0;
    let deadline: NodeJS.Timeout | null = null;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;

    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      pull() {
        response?.resume();
      },
      cancel() {
        if (terminal) return;
        terminal = true;
        cleanup();
        response?.destroy();
        request?.destroy();
      },
    });

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
      input.signal?.removeEventListener('abort', onAbort);
      encoded.fill(0);
      directAgent.destroy();
    };
    const failRequest = (code: string, message: string) => {
      if (terminal) return;
      terminal = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      const error = new OllamaProjectModelBridgeError(code, message);
      if (responseResolved) streamController.error(error);
      else reject(error);
    };
    const onAbort = () => {
      failRequest('BRIDGE_ABORTED', 'Ollama Project bridge request was aborted');
    };
    deadline = setTimeout(() => {
      failRequest('BRIDGE_TIMEOUT', 'Ollama Project bridge request timed out');
    }, input.timeoutMs);
    deadline.unref?.();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      request = http.request({
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: input.port,
        family: 4,
        method: 'POST',
        path: input.route,
        agent: directAgent,
        headers: {
          accept: 'application/json, application/x-ndjson',
          connection: 'close',
          'content-length': String(encoded.byteLength),
          'content-type': 'application/json',
          ...input.headers,
        },
      }, (incoming) => {
        if (terminal) {
          incoming.destroy();
          return;
        }
        response = incoming;
        const status = incoming.statusCode;
        if (
          typeof status !== 'number'
          || !Number.isSafeInteger(status)
          || status < 100
          || status > 599
        ) {
          failRequest('BRIDGE_RESPONSE', 'Ollama Project bridge returned an invalid response');
          return;
        }
        const rawLength = incoming.headers['content-length'];
        if (
          Array.isArray(rawLength)
          || (rawLength !== undefined && !/^(0|[1-9][0-9]*)$/.test(rawLength))
          || (typeof rawLength === 'string' && Number(rawLength) > MAX_RESPONSE_BYTES)
        ) {
          failRequest('RESPONSE_SIZE', 'Ollama Project bridge response exceeded the safety limit');
          return;
        }
        const contentType = typeof incoming.headers['content-type'] === 'string'
          ? incoming.headers['content-type'].slice(0, 256)
          : 'application/json; charset=utf-8';
        responseResolved = true;
        resolve(new Response(responseStream, {
          status,
          headers: { 'Content-Type': contentType },
        }));
        incoming.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (terminal) return;
          const copy = Buffer.isBuffer(chunk)
            ? Buffer.from(chunk)
            : Buffer.from(chunk as Uint8Array | string);
          responseBytes += copy.byteLength;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            copy.fill(0);
            failRequest('RESPONSE_SIZE', 'Ollama Project bridge response exceeded the safety limit');
            return;
          }
          try {
            streamController.enqueue(copy);
            if (
              streamController.desiredSize !== null
              && streamController.desiredSize <= 0
            ) {
              incoming.pause();
            }
          } catch {
            copy.fill(0);
            failRequest(
              'BRIDGE_CONNECTION',
              'Ollama Project bridge response failed',
            );
          }
        });
        incoming.once('aborted', () => {
          failRequest('BRIDGE_CONNECTION', 'Ollama Project bridge response ended unexpectedly');
        });
        incoming.once('error', () => {
          failRequest('BRIDGE_CONNECTION', 'Ollama Project bridge response failed');
        });
        incoming.once('end', () => {
          if (terminal) return;
          terminal = true;
          cleanup();
          streamController.close();
        });
      });
      request.once('error', () => {
        failRequest('BRIDGE_CONNECTION', 'Ollama Project bridge connection failed');
      });
      request.end(encoded);
    } catch {
      failRequest('BRIDGE_CONNECTION', 'Ollama Project bridge connection failed');
    }
  });
}

export async function openOllamaProjectModelBridge(input: {
  context: ProjectSandboxExecutionContext;
  sessionId: string;
  model: string;
  modelDigest: string;
  backend: OllamaProjectBackendIdentity;
  allowedToolNames: readonly string[];
  options?: OllamaProjectModelBridgeOptions;
}): Promise<OllamaProjectModelBridgeHandle> {
  const scope = normalizeScope(
    input.context,
    input.sessionId,
    input.model,
    input.modelDigest,
    input.backend,
  );
  const scopeFingerprint = stableHash({ policy: OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION, ...scope });
  const token = input.options?.tokenFactory?.() || crypto.randomBytes(32).toString('base64url');
  if (!TOKEN_RE.test(token)) fail('BRIDGE_TOKEN', 'Ollama Project bridge credential is invalid');
  const credentialHash = stableHash(token);
  const fetchImpl = input.options?.fetchImpl;
  if (fetchImpl && scope.backendKind !== 'LOCAL') {
    fail('UPSTREAM_SCOPE', 'Injected Ollama Project transports are permitted only for fixed local test scope');
  }
  const configuredTestUpstream = input.options?.upstreamBaseUrl
    ? requireLoopbackUpstream(input.options.upstreamBaseUrl)
    : null;
  const upstreamBaseUrl = fetchImpl
    ? (configuredTestUpstream || resolveLocalOllamaEndpoint())
    : null;
  const resolveAuthority = input.options?.resolveAuthority ?? resolveOllamaBackendAuthority;
  const requestResolved = input.options?.requestResolved ?? requestResolvedOllama;
  const streamResolved = input.options?.streamResolved ?? streamResolvedOllama;
  if (!fetchImpl) {
    assertAuthorityMatches(scope, await resolveAuthority());
  }
  const requestTimeoutMs = requireRequestTimeout(input.options?.requestTimeoutMs);
  const allowedToolNames = new Set(input.allowedToolNames);
  if (
    allowedToolNames.size !== input.allowedToolNames.length
    || [...allowedToolNames].some((name) => !/^[a-z][a-z0-9_]{1,63}$/.test(name))
  ) {
    fail('BRIDGE_TOOLS', 'Ollama Project bridge tool allowlist is invalid');
  }
  const controllers = new Set<AbortController>();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST' || !req.url || req.url.includes('?')) {
        writeJson(res, 404, { error: 'Not found' });
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        writeJson(res, 401, { error: 'Bridge authentication required' });
        return;
      }
      if (req.headers['x-bridgesllm-project-scope'] !== scopeFingerprint) {
        writeJson(res, 403, { error: 'Bridge scope mismatch' });
        return;
      }

      const body = await readJsonBody(req);
      let upstreamPath: '/api/tags' | '/api/show' | '/api/chat';
      let method: 'GET' | 'POST';
      let upstreamBody: string | undefined;
      let shouldStream = false;
      if (req.url === '/v1/tags') {
        upstreamPath = '/api/tags';
        method = 'GET';
      } else if (req.url === '/v1/show') {
        if (requireModel(body.model) !== scope.model) fail('MODEL_SCOPE', 'Ollama Project model scope mismatch');
        upstreamPath = '/api/show';
        method = 'POST';
        upstreamBody = JSON.stringify({ model: scope.model, verbose: false });
      } else if (req.url === '/v1/chat') {
        upstreamPath = '/api/chat';
        method = 'POST';
        const chatRequest = cleanChatRequest(body, scope, allowedToolNames);
        upstreamBody = JSON.stringify(chatRequest);
        shouldStream = chatRequest.stream;
      } else {
        writeJson(res, 404, { error: 'Not found' });
        return;
      }

      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let protocolComplete = false;
      const abortOnClose = () => {
        if (!res.writableEnded && !protocolComplete) controller.abort();
      };
      res.once('close', abortOnClose);
      try {
        if (fetchImpl) {
          const upstream = await fetchImpl(upstreamBaseUrl! + upstreamPath, {
            method,
            redirect: 'manual',
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body: upstreamBody,
            signal: controller.signal,
          });
          await relayResponse(
            upstream,
            res,
            controller,
            shouldStream,
            () => { protocolComplete = true; },
          );
        } else {
          const resolved = await resolveAuthority();
          assertAuthorityMatches(scope, resolved);
          const authorityRequest = {
            path: upstreamPath,
            method,
            ...(upstreamBody === undefined ? {} : { body: upstreamBody }),
            ...(upstreamPath === '/api/chat'
              ? { expectedModelDigest: scope.modelDigest }
              : {}),
            timeoutMs: requestTimeoutMs,
            maxResponseBytes: MAX_RESPONSE_BYTES,
            signal: controller.signal,
          };
          if (shouldStream) {
            let streamedBytes = 0;
            const terminalDetector = new OllamaProjectTerminalDetector();
            const upstream = await streamResolved(
              resolved,
              authorityRequest,
              async (chunk) => {
                streamedBytes += chunk.byteLength;
                if (streamedBytes > MAX_RESPONSE_BYTES) {
                  controller.abort();
                  fail(
                    'RESPONSE_SIZE',
                    'Ollama Project bridge response exceeded the safety limit',
                  );
                }
                const terminal = terminalDetector.push(chunk);
                if (terminal) protocolComplete = true;
                streamResponseHeaders(
                  res,
                  200,
                  'application/x-ndjson; charset=utf-8',
                );
                await relayStreamChunk(res, chunk, controller);
                return terminal
                  ? NATIVE_OLLAMA_STREAM_COMPLETE
                  : undefined;
              },
            );
            if (controller.signal.aborted) {
              fail('BRIDGE_ABORTED', 'Ollama Project bridge request was aborted');
            }
            terminalDetector.finish();
            const contentType = typeof upstream.headers['content-type'] === 'string'
              ? upstream.headers['content-type']
              : 'application/x-ndjson; charset=utf-8';
            streamResponseHeaders(res, upstream.statusCode, contentType);
            res.end();
          } else {
            const upstream = await requestResolved(resolved, authorityRequest);
            const contentType = typeof upstream.headers['content-type'] === 'string'
              ? upstream.headers['content-type'].slice(0, 256)
              : 'application/json; charset=utf-8';
            res.writeHead(upstream.statusCode, {
              'Content-Type': contentType,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            const zeroBody = () => upstream.body.fill(0);
            res.once('finish', zeroBody);
            res.once('close', zeroBody);
            res.end(upstream.body);
          }
        }
      } finally {
        clearTimeout(timer);
        res.off('close', abortOnClose);
        controllers.delete(controller);
      }
    } catch (error: any) {
      if (!res.headersSent) {
        const status = error instanceof OllamaProjectModelBridgeError ? 400 : 502;
        writeJson(res, status, { error: error?.message || 'Ollama Project bridge failed' });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = 'http://127.0.0.1:' + address.port;
  let closePromise: Promise<void> | null = null;

  const request = async (route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> => {
    const response = await requestDirectLoopbackBridge({
      port: address.port,
      route,
      headers: {
        'Authorization': 'Bearer ' + token,
        'X-BridgesLLM-Project-Scope': scopeFingerprint,
      },
      body,
      timeoutMs: requestTimeoutMs,
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2048);
      throw new OllamaProjectModelBridgeError('BRIDGE_RESPONSE', 'Ollama Project bridge returned ' + response.status + (detail ? ': ' + detail : ''));
    }
    return response;
  };

  const client: OllamaProjectModelBridgeClient = Object.freeze({
    baseUrl,
    scopeFingerprint,
    backendKind: scope.backendKind,
    backendFingerprint: scope.backendFingerprint,
    backendGeneration: scope.backendGeneration,
    async listModels(signal?: AbortSignal) {
      return (await request('/v1/tags', {}, signal)).json();
    },
    async showModel(signal?: AbortSignal) {
      return (await request('/v1/show', { model: scope.model }, signal)).json();
    },
    chat(chatRequest: OllamaProjectChatRequest, signal?: AbortSignal) {
      return request('/v1/chat', chatRequest as unknown as Record<string, unknown>, signal);
    },
  });

  return Object.freeze({
    client,
    baseUrl,
    scopeFingerprint,
    credentialHash,
    async proveBoundary(): Promise<OllamaProjectModelBridgeBoundaryProof> {
      const probe = async (route: string, headers: Record<string, string>) => requestDirectLoopbackBridge({
        port: address.port,
        route,
        headers,
        body: {},
        timeoutMs: Math.min(requestTimeoutMs, 5_000),
      });
      const [unauthenticated, scopeMismatch, disallowedRoute] = await Promise.all([
        probe('/v1/tags', {}),
        probe('/v1/tags', {
          'Authorization': 'Bearer ' + token,
          'X-BridgesLLM-Project-Scope': stableHash({ scopeFingerprint, mismatch: true }),
        }),
        probe('/v1/pull', {
          'Authorization': 'Bearer ' + token,
          'X-BridgesLLM-Project-Scope': scopeFingerprint,
        }),
      ]);
      if (unauthenticated.status !== 401 || scopeMismatch.status !== 403 || disallowedRoute.status !== 404) {
        fail('BRIDGE_BOUNDARY', 'Ollama Project bridge authentication or route boundary was not enforced');
      }
      const evidence = {
        policy: OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
        scopeFingerprint,
        credentialHash,
        unauthenticatedStatus: 401 as const,
        scopeMismatchStatus: 403 as const,
        disallowedRouteStatus: 404 as const,
      };
      return Object.freeze({
        unauthenticatedStatus: evidence.unauthenticatedStatus,
        scopeMismatchStatus: evidence.scopeMismatchStatus,
        disallowedRouteStatus: evidence.disallowedRouteStatus,
        evidenceSha256: stableHash(evidence),
      });
    },
    async close() {
      if (closePromise) return closePromise;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      closePromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      return closePromise;
    },
  });
}
