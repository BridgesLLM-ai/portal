import * as http from 'node:http';
import * as net from 'node:net';

export const LOCAL_OLLAMA_TRANSPORT_HOST = '127.0.0.1' as const;
export const LOCAL_OLLAMA_TRANSPORT_PORT = 11434 as const;

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_STANDARD_TIMEOUT_MS = 10 * 60_000;
const MAX_PULL_TIMEOUT_MS = 2 * 60 * 60_000;

export const LOCAL_OLLAMA_TRANSPORT_POLICY = Object.freeze({
  '/api/version': Object.freeze({
    method: 'GET',
    maxRequestBytes: 0,
    maxResponseBytes: 64 * 1024,
  }),
  '/api/tags': Object.freeze({
    method: 'GET',
    maxRequestBytes: 0,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/ps': Object.freeze({
    method: 'GET',
    maxRequestBytes: 0,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/show': Object.freeze({
    method: 'POST',
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/chat': Object.freeze({
    method: 'POST',
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 64 * 1024 * 1024,
  }),
  '/api/generate': Object.freeze({
    method: 'POST',
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 64 * 1024 * 1024,
  }),
  '/api/pull': Object.freeze({
    method: 'POST',
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
} as const);

export type LocalOllamaTransportPath = keyof typeof LOCAL_OLLAMA_TRANSPORT_POLICY;
export type LocalOllamaTransportMethod =
  typeof LOCAL_OLLAMA_TRANSPORT_POLICY[LocalOllamaTransportPath]['method'];

export type LocalOllamaTransportErrorCode =
  | 'REQUEST_INVALID'
  | 'REQUEST_TOO_LARGE'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'CONNECTION_FAILED'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_TOO_LARGE'
  | 'HTTP_STATUS';

export class LocalOllamaTransportError extends Error {
  constructor(
    public readonly code: LocalOllamaTransportErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LocalOllamaTransportError';
  }
}

export interface LocalOllamaTransportRequest {
  readonly path: LocalOllamaTransportPath;
  readonly method: LocalOllamaTransportMethod;
  readonly body?: Buffer | Uint8Array | string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface LocalOllamaTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<http.IncomingHttpHeaders>;
  readonly body: Buffer;
}

export interface LocalOllamaTransportDependencies {
  readonly request?: typeof http.request;
  readonly connect?: (options: net.NetConnectOpts) => net.Socket;
}

function invalidRequest(message: string): never {
  throw new LocalOllamaTransportError('REQUEST_INVALID', message);
}

function requestPolicy(
  path: unknown,
): typeof LOCAL_OLLAMA_TRANSPORT_POLICY[LocalOllamaTransportPath] {
  if (
    typeof path !== 'string'
    || !Object.prototype.hasOwnProperty.call(LOCAL_OLLAMA_TRANSPORT_POLICY, path)
  ) {
    return invalidRequest('Unsupported local Ollama API path');
  }
  return LOCAL_OLLAMA_TRANSPORT_POLICY[path as LocalOllamaTransportPath];
}

function requestTimeout(
  value: unknown,
  path: LocalOllamaTransportPath,
): number {
  const timeout = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  const maxTimeout = path === '/api/pull'
    ? MAX_PULL_TIMEOUT_MS
    : MAX_STANDARD_TIMEOUT_MS;
  if (
    typeof timeout !== 'number'
    || !Number.isSafeInteger(timeout)
    || timeout < MIN_TIMEOUT_MS
    || timeout > maxTimeout
  ) {
    return invalidRequest('Invalid local Ollama request timeout');
  }
  return timeout;
}

function responseLimit(value: unknown, policyLimit: number): number {
  if (value === undefined) return policyLimit;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    return invalidRequest('Invalid local Ollama response limit');
  }
  // The caller's value is its own memory budget; the path policy stays the
  // hard ceiling. Clamping (not rejecting) a larger budget matters: two
  // deterministic outages ("Ollama Off" status collapse and wedged Project
  // Ollama preparation) came from blanket caller budgets tripping smaller
  // per-path caps as REQUEST_INVALID, with zero security benefit over min().
  return Math.min(value, policyLimit);
}

function requestBody(value: LocalOllamaTransportRequest['body']): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return invalidRequest('Invalid local Ollama request body');
}

function contentLength(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers['content-length'];
  if (raw === undefined) return null;
  if (
    Array.isArray(raw)
    || typeof raw !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(raw)
  ) {
    throw new LocalOllamaTransportError(
      'RESPONSE_INVALID',
      'Local Ollama returned an invalid content length',
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new LocalOllamaTransportError(
      'RESPONSE_INVALID',
      'Local Ollama returned an invalid content length',
    );
  }
  return parsed;
}

/**
 * Performs one bounded Ollama request on an explicit literal loopback socket.
 *
 * There is deliberately no URL input, DNS lookup, redirect handling, proxy
 * agent, retry, or fallback. A failed non-idempotent request is returned as a
 * failure and is never redispatched.
 */
export async function requestLocalOllama(
  input: LocalOllamaTransportRequest,
  dependencies: LocalOllamaTransportDependencies = {},
): Promise<LocalOllamaTransportResponse> {
  const policy = requestPolicy(input.path);
  if (input.method !== policy.method) {
    return invalidRequest('Unsupported method for local Ollama API path');
  }
  const timeoutMs = requestTimeout(input.timeoutMs, input.path);
  const maxResponseBytes = responseLimit(
    input.maxResponseBytes,
    policy.maxResponseBytes,
  );
  const body = requestBody(input.body);
  if (policy.maxRequestBytes === 0 && body.byteLength !== 0) {
    body.fill(0);
    return invalidRequest('This local Ollama request must not include a body');
  }
  if (body.byteLength > policy.maxRequestBytes) {
    body.fill(0);
    throw new LocalOllamaTransportError(
      'REQUEST_TOO_LARGE',
      'Local Ollama request body exceeded its bounded limit',
    );
  }
  if (input.signal?.aborted) {
    body.fill(0);
    throw new LocalOllamaTransportError('ABORTED', 'Local Ollama request was aborted');
  }

  const requestImpl = dependencies.request ?? http.request;
  const connectImpl = dependencies.connect
    ?? ((options: net.NetConnectOpts) => net.createConnection(options));
  const directAgent = new http.Agent({
    keepAlive: false,
    maxSockets: 1,
    maxFreeSockets: 0,
  });
  directAgent.createConnection = () => connectImpl({
    host: LOCAL_OLLAMA_TRANSPORT_HOST,
    port: LOCAL_OLLAMA_TRANSPORT_PORT,
    family: 4,
  });

  return new Promise<LocalOllamaTransportResponse>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    let responseBytes = 0;

    const cleanup = () => {
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', onAbort);
      body.fill(0);
      directAgent.destroy();
    };
    const fail = (error: LocalOllamaTransportError) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      for (const chunk of chunks) chunk.fill(0);
      reject(error);
    };
    const onAbort = () => {
      fail(new LocalOllamaTransportError('ABORTED', 'Local Ollama request was aborted'));
    };
    const deadline = setTimeout(() => {
      fail(new LocalOllamaTransportError('TIMEOUT', 'Local Ollama request timed out'));
    }, timeoutMs);
    deadline.unref?.();
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      request = requestImpl({
        protocol: 'http:',
        hostname: LOCAL_OLLAMA_TRANSPORT_HOST,
        port: LOCAL_OLLAMA_TRANSPORT_PORT,
        family: 4,
        method: input.method,
        path: input.path,
        agent: directAgent,
        headers: {
          accept: 'application/json',
          connection: 'close',
          'content-length': String(body.byteLength),
          ...(body.byteLength > 0 ? { 'content-type': 'application/json' } : {}),
        },
      }, (incoming) => {
        response = incoming;
        const statusCode = incoming.statusCode;
        if (
          typeof statusCode !== 'number'
          || !Number.isInteger(statusCode)
          || statusCode < 100
          || statusCode > 599
        ) {
          fail(new LocalOllamaTransportError(
            'RESPONSE_INVALID',
            'Local Ollama returned an invalid status',
          ));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          fail(new LocalOllamaTransportError(
            'HTTP_STATUS',
            'Local Ollama returned a non-success status',
            statusCode,
          ));
          return;
        }
        let declaredLength: number | null;
        try {
          declaredLength = contentLength(incoming.headers);
        } catch (error) {
          fail(error as LocalOllamaTransportError);
          return;
        }
        if (
          declaredLength !== null
          && declaredLength > maxResponseBytes
        ) {
          fail(new LocalOllamaTransportError(
            'RESPONSE_TOO_LARGE',
            'Local Ollama response exceeded its bounded limit',
          ));
          return;
        }
        incoming.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (settled) return;
          const copy = Buffer.isBuffer(chunk)
            ? Buffer.from(chunk)
            : Buffer.from(chunk as Uint8Array | string);
          responseBytes += copy.byteLength;
          if (responseBytes > maxResponseBytes) {
            copy.fill(0);
            fail(new LocalOllamaTransportError(
              'RESPONSE_TOO_LARGE',
              'Local Ollama response exceeded its bounded limit',
            ));
            return;
          }
          chunks.push(copy);
        });
        incoming.once('aborted', () => {
          fail(new LocalOllamaTransportError(
            'CONNECTION_FAILED',
            'Local Ollama response ended unexpectedly',
          ));
        });
        incoming.once('error', () => {
          fail(new LocalOllamaTransportError(
            'CONNECTION_FAILED',
            'Local Ollama response failed',
          ));
        });
        incoming.once('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const responseBody = Buffer.concat(chunks, responseBytes);
          for (const chunk of chunks) chunk.fill(0);
          resolve(Object.freeze({
            statusCode,
            headers: Object.freeze({ ...incoming.headers }),
            body: responseBody,
          }));
        });
      });
      request.once('error', () => {
        fail(new LocalOllamaTransportError(
          'CONNECTION_FAILED',
          'Local Ollama connection failed',
        ));
      });
      request.end(body);
    } catch {
      fail(new LocalOllamaTransportError(
        'CONNECTION_FAILED',
        'Local Ollama connection failed',
      ));
    }
  });
}

export async function requestLocalOllamaJson<T>(
  input: Omit<LocalOllamaTransportRequest, 'body'> & {
    readonly json?: unknown;
  },
  dependencies: LocalOllamaTransportDependencies = {},
): Promise<T> {
  let encoded: Buffer | undefined;
  try {
    if (input.json !== undefined) {
      encoded = Buffer.from(JSON.stringify(input.json), 'utf8');
    }
  } catch {
    throw new LocalOllamaTransportError(
      'REQUEST_INVALID',
      'Local Ollama request JSON could not be encoded',
    );
  }
  try {
    const response = await requestLocalOllama({
      path: input.path,
      method: input.method,
      ...(encoded ? { body: encoded } : {}),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      signal: input.signal,
    }, dependencies);
    try {
      return JSON.parse(response.body.toString('utf8')) as T;
    } catch {
      throw new LocalOllamaTransportError(
        'RESPONSE_INVALID',
        'Local Ollama returned invalid JSON',
      );
    } finally {
      response.body.fill(0);
    }
  } finally {
    encoded?.fill(0);
  }
}
