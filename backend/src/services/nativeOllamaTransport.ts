import * as http from 'node:http';
import * as net from 'node:net';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_STANDARD_TIMEOUT_MS = 10 * 60_000;
const MAX_PULL_TIMEOUT_MS = 2 * 60 * 60_000;

export const NATIVE_OLLAMA_TRANSPORT_POLICY = Object.freeze({
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
    // Pull responses contain NDJSON progress, not model bytes. Keep a hard
    // ceiling without confusing a multi-gigabyte model with response memory.
    maxResponseBytes: 64 * 1024 * 1024,
  }),
} as const);

export type NativeOllamaTransportPath = keyof typeof NATIVE_OLLAMA_TRANSPORT_POLICY;
export type NativeOllamaTransportMethod =
  typeof NATIVE_OLLAMA_TRANSPORT_POLICY[NativeOllamaTransportPath]['method'];

export type NativeOllamaTransportErrorCode =
  | 'REQUEST_INVALID'
  | 'REQUEST_TOO_LARGE'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'CONNECTION_FAILED'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_TOO_LARGE'
  | 'HTTP_STATUS';

export class NativeOllamaTransportError extends Error {
  constructor(
    public readonly code: NativeOllamaTransportErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'NativeOllamaTransportError';
  }
}

/** Tailscale Serve listener on the Remote GPU. */
const REMOTE_SERVE_PORT = 11435;
/** What Ollama believes it is serving behind that tunnel. */
const REMOTE_LOOPBACK_ORIGIN = '127.0.0.1:11434';

export interface NativeOllamaEndpoint {
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 11434 | 11435;
}

export interface NativeOllamaTransportRequest {
  readonly endpoint: NativeOllamaEndpoint;
  readonly path: NativeOllamaTransportPath;
  readonly method: NativeOllamaTransportMethod;
  readonly body?: Buffer | Uint8Array | string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface NativeOllamaTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<http.IncomingHttpHeaders>;
  readonly body: Buffer;
}

export interface NativeOllamaStreamResponse {
  readonly statusCode: number;
  readonly headers: Readonly<http.IncomingHttpHeaders>;
  readonly responseBytes: number;
}

/**
 * A stream consumer returns this only after it has parsed a protocol-defined
 * terminal record. The transport then closes this exact request/response pair
 * and resolves successfully without aborting the caller's signal.
 */
export const NATIVE_OLLAMA_STREAM_COMPLETE = Symbol(
  'NATIVE_OLLAMA_STREAM_COMPLETE',
);

export type NativeOllamaStreamConsumerResult =
  | void
  | typeof NATIVE_OLLAMA_STREAM_COMPLETE;

export interface NativeOllamaTransportDependencies {
  readonly request?: typeof http.request;
  readonly connect?: (options: net.NetConnectOpts) => net.Socket;
}

function invalidRequest(message: string): never {
  throw new NativeOllamaTransportError('REQUEST_INVALID', message);
}

function requestPolicy(path: unknown) {
  if (
    typeof path !== 'string'
    || !Object.prototype.hasOwnProperty.call(NATIVE_OLLAMA_TRANSPORT_POLICY, path)
  ) {
    return invalidRequest('Unsupported Ollama API path');
  }
  return NATIVE_OLLAMA_TRANSPORT_POLICY[path as NativeOllamaTransportPath];
}

function normalizedEndpoint(value: NativeOllamaEndpoint): NativeOllamaEndpoint {
  if (
    !value
    || typeof value.address !== 'string'
    || (value.family !== 4 && value.family !== 6)
    || net.isIP(value.address) !== value.family
    || value.address.includes('%')
    || (value.port !== 11434 && value.port !== 11435)
  ) {
    return invalidRequest('Invalid literal Ollama endpoint');
  }
  return Object.freeze({
    address: value.address,
    family: value.family,
    port: value.port,
  });
}

function requestTimeout(value: unknown, path: NativeOllamaTransportPath): number {
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
    return invalidRequest('Invalid Ollama request timeout');
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
    return invalidRequest('Invalid Ollama response limit');
  }
  return Math.min(value, policyLimit);
}

function requestBody(value: NativeOllamaTransportRequest['body']): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return invalidRequest('Invalid Ollama request body');
}

function declaredContentLength(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers['content-length'];
  if (raw === undefined) return null;
  if (
    Array.isArray(raw)
    || typeof raw !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(raw)
  ) {
    throw new NativeOllamaTransportError(
      'RESPONSE_INVALID',
      'Ollama returned an invalid content length',
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new NativeOllamaTransportError(
      'RESPONSE_INVALID',
      'Ollama returned an invalid content length',
    );
  }
  return parsed;
}

function normalizedInput(
  input: NativeOllamaTransportRequest,
): {
  endpoint: NativeOllamaEndpoint;
  timeoutMs: number;
  maxResponseBytes: number;
  body: Buffer;
} {
  const policy = requestPolicy(input.path);
  if (input.method !== policy.method) {
    return invalidRequest('Unsupported method for Ollama API path');
  }
  const endpoint = normalizedEndpoint(input.endpoint);
  const timeoutMs = requestTimeout(input.timeoutMs, input.path);
  const maxResponseBytes = responseLimit(
    input.maxResponseBytes,
    policy.maxResponseBytes,
  );
  const body = requestBody(input.body);
  if (policy.maxRequestBytes === 0 && body.byteLength !== 0) {
    body.fill(0);
    return invalidRequest('This Ollama request must not include a body');
  }
  if (body.byteLength > policy.maxRequestBytes) {
    body.fill(0);
    throw new NativeOllamaTransportError(
      'REQUEST_TOO_LARGE',
      'Ollama request body exceeded its bounded limit',
    );
  }
  if (input.signal?.aborted) {
    body.fill(0);
    throw new NativeOllamaTransportError('ABORTED', 'Ollama request was aborted');
  }
  return { endpoint, timeoutMs, maxResponseBytes, body };
}

function directAgent(
  endpoint: NativeOllamaEndpoint,
  dependencies: NativeOllamaTransportDependencies,
): http.Agent {
  const connectImpl = dependencies.connect
    ?? ((options: net.NetConnectOpts) => net.createConnection(options));
  const agent = new http.Agent({
    keepAlive: false,
    maxSockets: 1,
    maxFreeSockets: 0,
  });
  agent.createConnection = () => connectImpl({
    host: endpoint.address,
    port: endpoint.port,
    family: endpoint.family,
  });
  return agent;
}

/**
 * Streams one native Ollama response from an exact literal socket.
 *
 * No URL, DNS, redirect, environment proxy, retry, or fallback is accepted.
 * The caller controls the attested literal address and receives bounded chunks
 * with backpressure. This works identically for loopback and Tailscale Serve.
 */
export async function streamNativeOllama(
  input: NativeOllamaTransportRequest,
  onChunk: (
    chunk: Buffer,
  ) => NativeOllamaStreamConsumerResult
    | Promise<NativeOllamaStreamConsumerResult>,
  dependencies: NativeOllamaTransportDependencies = {},
): Promise<NativeOllamaStreamResponse> {
  if (typeof onChunk !== 'function') {
    return invalidRequest('Invalid Ollama response consumer');
  }
  const normalized = normalizedInput(input);
  const agent = directAgent(normalized.endpoint, dependencies);
  const requestImpl = dependencies.request ?? http.request;

  return new Promise<NativeOllamaStreamResponse>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;

    const cleanup = () => {
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', onAbort);
      normalized.body.fill(0);
      agent.destroy();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(error);
    };
    const onAbort = () => {
      fail(new NativeOllamaTransportError('ABORTED', 'Ollama request was aborted'));
    };
    const deadline = setTimeout(() => {
      fail(new NativeOllamaTransportError('TIMEOUT', 'Ollama request timed out'));
    }, normalized.timeoutMs);
    deadline.unref?.();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    // AbortSignal does not replay an abort that races with listener
    // registration. Recheck after registration before opening the socket.
    if (input.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      request = requestImpl({
        protocol: 'http:',
        hostname: normalized.endpoint.address,
        port: normalized.endpoint.port,
        family: normalized.endpoint.family,
        method: input.method,
        path: input.path,
        agent,
        headers: {
          accept: 'application/json, application/x-ndjson',
          connection: 'close',
          // Ollama refuses any Host it does not recognise with a bare 403.
          // Through Tailscale Serve it would otherwise see the tailnet address
          // and port (for example 100.x.y.z:11435) and reject every request,
          // which read as "the GPU denied us" when the GPU was fine. Serve
          // forwards to loopback on the remote machine, so present the origin
          // Ollama is actually listening on.
          ...(normalized.endpoint.port === REMOTE_SERVE_PORT
            ? { host: REMOTE_LOOPBACK_ORIGIN }
            : {}),
          'content-length': String(normalized.body.byteLength),
          ...(normalized.body.byteLength > 0
            ? { 'content-type': 'application/json' }
            : {}),
        },
      }, (incoming) => {
        if (settled) {
          incoming.destroy();
          return;
        }
        response = incoming;
        void (async () => {
          const statusCode = incoming.statusCode;
          if (
            typeof statusCode !== 'number'
            || !Number.isInteger(statusCode)
            || statusCode < 100
            || statusCode > 599
          ) {
            fail(new NativeOllamaTransportError(
              'RESPONSE_INVALID',
              'Ollama returned an invalid status',
            ));
            return;
          }

          // Redirects and every other non-success status are terminal. Do not
          // follow them and do not let an unbounded error body hold the socket.
          if (statusCode < 200 || statusCode >= 300) {
            fail(new NativeOllamaTransportError(
              'HTTP_STATUS',
              'Ollama returned a non-success status',
              statusCode,
            ));
            return;
          }

          let declaredLength: number | null;
          try {
            declaredLength = declaredContentLength(incoming.headers);
          } catch (error) {
            fail(error as NativeOllamaTransportError);
            return;
          }
          if (
            declaredLength !== null
            && declaredLength > normalized.maxResponseBytes
          ) {
            fail(new NativeOllamaTransportError(
              'RESPONSE_TOO_LARGE',
              'Ollama response exceeded its bounded limit',
            ));
            return;
          }

          let responseBytes = 0;
          try {
            for await (const raw of incoming) {
              if (settled) return;
              const chunk = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw);
              responseBytes += chunk.byteLength;
              if (responseBytes > normalized.maxResponseBytes) {
                chunk.fill(0);
                fail(new NativeOllamaTransportError(
                  'RESPONSE_TOO_LARGE',
                  'Ollama response exceeded its bounded limit',
                ));
                return;
              }
              try {
                const consumed = onChunk(chunk);
                // Preserve synchronous protocol completion. Wrapping a symbol
                // result in an unconditional await would create an abort race
                // after done:true but before this exact socket is closed.
                const control = consumed instanceof Promise
                  ? await consumed
                  : consumed;
                if (control === NATIVE_OLLAMA_STREAM_COMPLETE) {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  // A protocol terminal record is successful completion, not
                  // caller cancellation or a peer failure. Close only this
                  // exact upstream exchange so a withheld HTTP EOF cannot hold
                  // the authority lease.
                  incoming.destroy();
                  request?.destroy();
                  resolve(Object.freeze({
                    statusCode,
                    headers: Object.freeze({ ...incoming.headers }),
                    responseBytes,
                  }));
                  return;
                }
              } catch (error) {
                // Parser/consumer failures are caller-domain validation
                // errors, not evidence that the peer or socket failed.
                fail(error);
                return;
              } finally {
                chunk.fill(0);
              }
            }
          } catch {
            if (settled) return;
            if (input.signal?.aborted) {
              fail(new NativeOllamaTransportError('ABORTED', 'Ollama request was aborted'));
              return;
            }
            fail(new NativeOllamaTransportError(
              'CONNECTION_FAILED',
              'Ollama response stream failed',
            ));
            return;
          }

          if (settled) return;
          settled = true;
          cleanup();
          resolve(Object.freeze({
            statusCode,
            headers: Object.freeze({ ...incoming.headers }),
            responseBytes,
          }));
        })();
      });
      request.once('error', () => {
        if (input.signal?.aborted) {
          fail(new NativeOllamaTransportError('ABORTED', 'Ollama request was aborted'));
          return;
        }
        fail(new NativeOllamaTransportError(
          'CONNECTION_FAILED',
          'Ollama connection failed',
        ));
      });
      request.end(normalized.body);
    } catch {
      fail(new NativeOllamaTransportError(
        'CONNECTION_FAILED',
        'Ollama connection failed',
      ));
    }
  });
}

export async function requestNativeOllama(
  input: NativeOllamaTransportRequest,
  dependencies: NativeOllamaTransportDependencies = {},
): Promise<NativeOllamaTransportResponse> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    const response = await streamNativeOllama(input, (chunk) => {
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      totalBytes += copy.byteLength;
    }, dependencies);
    return Object.freeze({
      statusCode: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks, totalBytes),
    });
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
