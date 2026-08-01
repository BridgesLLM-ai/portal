import net from 'net';
import { TextDecoder } from 'util';
import {
  OLLAMA_TAILNET_GCM_TAG_BYTES,
  OLLAMA_TAILNET_HELPER_PORT,
  OLLAMA_TAILNET_PATH_POLICY,
  OLLAMA_TAILNET_PROTOCOL_VERSION,
  OllamaTailnetProtocol,
  type EncryptedOllamaTailnetResponse,
  type OllamaTailnetBindingInput,
  type OllamaTailnetMethod,
  type OllamaTailnetPath,
  type SignedOllamaTailnetChallenge,
} from './ollamaTailnetProtocol';

export const OLLAMA_TAILNET_MAX_ENVELOPE_BYTES = 16 * 1024;
export const OLLAMA_TAILNET_DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;
export const OLLAMA_TAILNET_MAX_NON_PULL_TRANSPORT_TIMEOUT_MS = 10 * 60_000;
export const OLLAMA_TAILNET_MAX_TRANSPORT_TIMEOUT_MS = 2 * 60 * 60_000;

const ENVELOPE_HEADER_BYTES = 4;
const MESSAGE_HEADER_BYTES = 8;
const MAX_WIRE_BODY_BYTES = Math.max(
  ...Object.values(OLLAMA_TAILNET_PATH_POLICY).map((policy) => (
    Math.max(policy.maxRequestBytes, policy.maxResponseBytes)
  )),
) + OLLAMA_TAILNET_GCM_TAG_BYTES;

const CHALLENGE_KEYS = Object.freeze([
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'hmac',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'stableNodeId',
  'tailnetName',
  'timestampMs',
] as const);

const RESPONSE_KEYS = Object.freeze([
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'requestMethod',
  'requestNonce',
  'requestPath',
  'requestTimestampMs',
  'requestWireBodySha256',
  'signature',
  'stableNodeId',
  'status',
  'tailnetName',
  'timestampMs',
  'wireBodySha256',
] as const);

export type OllamaTailnetTransportErrorCode =
  | 'REQUEST_INVALID'
  | 'TIMEOUT_INVALID'
  | 'ABORTED'
  | 'CONNECT_FAILED'
  | 'SOCKET_FAILED'
  | 'TIMED_OUT'
  | 'FRAME_MALFORMED'
  | 'FRAME_TOO_LARGE'
  | 'UNEXPECTED_EOF'
  | 'EXTRA_BYTES'
  | 'WRITE_FAILED';

const ERROR_MESSAGES: Readonly<Record<OllamaTailnetTransportErrorCode, string>> = Object.freeze({
  REQUEST_INVALID: 'The Tailnet Ollama transport request is invalid.',
  TIMEOUT_INVALID: 'The Tailnet Ollama transport timeout is invalid.',
  ABORTED: 'The Tailnet Ollama transport request was aborted.',
  CONNECT_FAILED: 'The Tailnet Ollama helper connection could not be established.',
  SOCKET_FAILED: 'The Tailnet Ollama helper connection failed.',
  TIMED_OUT: 'The Tailnet Ollama helper connection timed out.',
  FRAME_MALFORMED: 'The Tailnet Ollama helper sent a malformed frame.',
  FRAME_TOO_LARGE: 'The Tailnet Ollama helper frame exceeded its fixed limit.',
  UNEXPECTED_EOF: 'The Tailnet Ollama helper connection ended mid-frame.',
  EXTRA_BYTES: 'The Tailnet Ollama helper sent bytes outside the authenticated frame.',
  WRITE_FAILED: 'The Tailnet Ollama request frame could not be sent.',
});

export class OllamaTailnetTransportError extends Error {
  readonly code: OllamaTailnetTransportErrorCode;

  constructor(code: OllamaTailnetTransportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OllamaTailnetTransportError';
    this.code = code;
  }

  toJSON(): Readonly<{
    name: 'OllamaTailnetTransportError';
    code: OllamaTailnetTransportErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: 'OllamaTailnetTransportError' as const,
      code: this.code,
      message: this.message,
    });
  }
}

export interface OllamaTailnetConnectOptions {
  readonly host: string;
  readonly port: typeof OLLAMA_TAILNET_HELPER_PORT;
  readonly family: 4 | 6;
  readonly autoSelectFamily: false;
}

export type OllamaTailnetConnect = (
  options: OllamaTailnetConnectOptions,
) => net.Socket;

export interface OllamaTailnetTransportDependencies {
  readonly connect?: OllamaTailnetConnect;
  readonly now?: () => number;
}

export interface OllamaTailnetTransportOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly dependencies?: OllamaTailnetTransportDependencies;
}

export interface OllamaTailnetTransportResponse {
  readonly protocolVersion: typeof OLLAMA_TAILNET_PROTOCOL_VERSION;
  readonly status: number;
  readonly body: Buffer;
  /**
   * This foundation authenticates one complete, route-capped response. It is
   * intentionally not a streaming transport.
   */
  readonly streaming: false;
}

interface PendingRead {
  readonly byteLength: number;
  readonly resolve: (value: Buffer) => void;
  readonly reject: (error: Error) => void;
}

interface PendingEnd {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function transportError(code: OllamaTailnetTransportErrorCode): OllamaTailnetTransportError {
  return new OllamaTailnetTransportError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseStrictEnvelope<T>(
  bytes: Buffer,
  expectedKeys: readonly string[],
): T {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw transportError('FRAME_MALFORMED');
  }
  if (!isPlainRecord(parsed)) throw transportError('FRAME_MALFORMED');
  const actualKeys = Object.keys(parsed).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw transportError('FRAME_MALFORMED');
  }
  return parsed as T;
}

function encodeEnvelope(envelope: object): Buffer {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  } catch {
    throw transportError('FRAME_MALFORMED');
  }
  if (bytes.byteLength < 2) throw transportError('FRAME_MALFORMED');
  if (bytes.byteLength > OLLAMA_TAILNET_MAX_ENVELOPE_BYTES) {
    throw transportError('FRAME_TOO_LARGE');
  }
  return bytes;
}

function encodeMessageFrame(envelope: object, body: Uint8Array): Buffer {
  if (!(body instanceof Uint8Array) || body.byteLength > MAX_WIRE_BODY_BYTES) {
    throw transportError('REQUEST_INVALID');
  }
  const envelopeBytes = encodeEnvelope(envelope);
  const header = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES);
  header.writeUInt32BE(envelopeBytes.byteLength, 0);
  header.writeUInt32BE(body.byteLength, 4);
  return Buffer.concat([header, envelopeBytes, Buffer.from(body)]);
}

function encodeEnvelopeFrame(envelope: object): Buffer {
  const envelopeBytes = encodeEnvelope(envelope);
  const header = Buffer.allocUnsafe(ENVELOPE_HEADER_BYTES);
  header.writeUInt32BE(envelopeBytes.byteLength, 0);
  return Buffer.concat([header, envelopeBytes]);
}

function safeTimeout(
  value: unknown,
  requestPath: OllamaTailnetPath,
): number {
  const timeoutMs = value ?? OLLAMA_TAILNET_DEFAULT_TRANSPORT_TIMEOUT_MS;
  const maxTimeoutMs = requestPath === '/api/pull'
    ? OLLAMA_TAILNET_MAX_TRANSPORT_TIMEOUT_MS
    : OLLAMA_TAILNET_MAX_NON_PULL_TRANSPORT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || (timeoutMs as number) < 1
    || (timeoutMs as number) > maxTimeoutMs
  ) {
    throw transportError('TIMEOUT_INVALID');
  }
  return timeoutMs as number;
}

function defaultConnect(options: OllamaTailnetConnectOptions): net.Socket {
  return net.createConnection({
    host: options.host,
    port: options.port,
    family: options.family,
    autoSelectFamily: options.autoSelectFamily,
    // The validated host is already an IP literal. If a future refactor ever
    // reaches DNS resolution, fail instead of quietly widening the boundary.
    lookup: (_hostname, _lookupOptions, callback) => {
      const error = Object.assign(new Error('DNS resolution is disabled.'), {
        code: 'DNS_DISABLED',
      });
      callback(error, '', 0);
    },
  });
}

class BoundedSocketReader {
  readonly #socket: net.Socket;
  readonly #chunks: Buffer[] = [];
  #bufferedBytes = 0;
  #maxBufferedBytes: number;
  #ended = false;
  #failed: Error | null = null;
  #pendingRead: PendingRead | null = null;
  #pendingEnd: PendingEnd | null = null;

  constructor(socket: net.Socket, maxBufferedBytes: number) {
    this.#socket = socket;
    this.#maxBufferedBytes = maxBufferedBytes;
    socket.on('data', this.#onData);
    socket.on('end', this.#onEnd);
    socket.on('error', this.#onError);
    socket.on('close', this.#onClose);
  }

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  get ended(): boolean {
    return this.#ended;
  }

  setMaxBufferedBytes(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      this.fail(transportError('FRAME_MALFORMED'));
      return;
    }
    this.#maxBufferedBytes = value;
    if (this.#bufferedBytes > value) {
      this.fail(transportError('FRAME_TOO_LARGE'));
    }
  }

  readExact(byteLength: number): Promise<Buffer> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return Promise.reject(transportError('FRAME_MALFORMED'));
    }
    if (this.#pendingRead || this.#pendingEnd) {
      return Promise.reject(transportError('SOCKET_FAILED'));
    }
    if (this.#failed) return Promise.reject(this.#failed);
    if (this.#bufferedBytes >= byteLength) {
      return Promise.resolve(this.#consume(byteLength));
    }
    if (this.#ended) return Promise.reject(transportError('UNEXPECTED_EOF'));
    return new Promise<Buffer>((resolve, reject) => {
      this.#pendingRead = { byteLength, resolve, reject };
    });
  }

  expectCleanEnd(): Promise<void> {
    if (this.#pendingRead || this.#pendingEnd) {
      return Promise.reject(transportError('SOCKET_FAILED'));
    }
    if (this.#failed) return Promise.reject(this.#failed);
    if (this.#bufferedBytes > 0) {
      return Promise.reject(transportError('EXTRA_BYTES'));
    }
    if (this.#ended) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#pendingEnd = { resolve, reject };
    });
  }

  fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = error;
    const pendingRead = this.#pendingRead;
    const pendingEnd = this.#pendingEnd;
    this.#pendingRead = null;
    this.#pendingEnd = null;
    pendingRead?.reject(error);
    pendingEnd?.reject(error);
    if (!this.#socket.destroyed) this.#socket.destroy();
  }

  dispose(): void {
    this.#socket.off('data', this.#onData);
    this.#socket.off('end', this.#onEnd);
    this.#socket.off('error', this.#onError);
    this.#socket.off('close', this.#onClose);
    for (const chunk of this.#chunks) chunk.fill(0);
    this.#chunks.length = 0;
    this.#bufferedBytes = 0;
  }

  readonly #onData = (chunk: Buffer): void => {
    if (this.#failed) {
      chunk.fill(0);
      return;
    }
    if (this.#pendingEnd) {
      chunk.fill(0);
      this.fail(transportError('EXTRA_BYTES'));
      return;
    }
    if (!(chunk instanceof Buffer) || chunk.byteLength < 1) {
      this.fail(transportError('SOCKET_FAILED'));
      return;
    }
    if (this.#bufferedBytes + chunk.byteLength > this.#maxBufferedBytes) {
      chunk.fill(0);
      this.fail(transportError('FRAME_TOO_LARGE'));
      return;
    }
    this.#chunks.push(chunk);
    this.#bufferedBytes += chunk.byteLength;
    this.#settleRead();
  };

  readonly #onEnd = (): void => {
    this.#ended = true;
    if (this.#pendingRead) {
      this.fail(transportError('UNEXPECTED_EOF'));
      return;
    }
    if (this.#pendingEnd) {
      const pending = this.#pendingEnd;
      this.#pendingEnd = null;
      pending.resolve();
    }
  };

  readonly #onError = (): void => {
    this.fail(transportError('SOCKET_FAILED'));
  };

  readonly #onClose = (): void => {
    if (!this.#ended && !this.#failed) {
      this.fail(transportError('SOCKET_FAILED'));
    }
  };

  #settleRead(): void {
    const pending = this.#pendingRead;
    if (!pending || this.#bufferedBytes < pending.byteLength) return;
    this.#pendingRead = null;
    pending.resolve(this.#consume(pending.byteLength));
  }

  #consume(byteLength: number): Buffer {
    if (byteLength === 0) return Buffer.alloc(0);
    const output = Buffer.allocUnsafe(byteLength);
    let outputOffset = 0;
    while (outputOffset < byteLength) {
      const chunk = this.#chunks[0];
      const remaining = byteLength - outputOffset;
      if (chunk.byteLength <= remaining) {
        chunk.copy(output, outputOffset);
        outputOffset += chunk.byteLength;
        chunk.fill(0);
        this.#chunks.shift();
      } else {
        chunk.copy(output, outputOffset, 0, remaining);
        chunk.fill(0, 0, remaining);
        this.#chunks[0] = chunk.subarray(remaining);
        outputOffset += remaining;
      }
    }
    this.#bufferedBytes -= byteLength;
    return output;
  }
}

async function waitForConnect(socket: net.Socket): Promise<void> {
  if (socket.readyState === 'open') return;
  if (socket.destroyed) throw transportError('CONNECT_FAILED');
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(transportError('CONNECT_FAILED'));
    };
    const onClose = (): void => {
      cleanup();
      reject(transportError('CONNECT_FAILED'));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function writeAndEnd(socket: net.Socket, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (): void => finish(transportError('WRITE_FAILED'));
    const onClose = (): void => finish(transportError('WRITE_FAILED'));
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.end(frame, () => finish());
  });
}

async function writeWithoutEnd(socket: net.Socket, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (): void => finish(transportError('WRITE_FAILED'));
    const onClose = (): void => finish(transportError('WRITE_FAILED'));
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(frame, (error) => {
      if (error) finish(transportError('WRITE_FAILED'));
      else finish();
    });
  });
}

async function readChallenge(reader: BoundedSocketReader): Promise<SignedOllamaTailnetChallenge> {
  const header = await reader.readExact(ENVELOPE_HEADER_BYTES);
  const envelopeLength = header.readUInt32BE(0);
  if (envelopeLength < 2) throw transportError('FRAME_MALFORMED');
  if (envelopeLength > OLLAMA_TAILNET_MAX_ENVELOPE_BYTES) {
    throw transportError('FRAME_TOO_LARGE');
  }
  const envelope = await reader.readExact(envelopeLength);
  if (reader.bufferedBytes > 0) throw transportError('EXTRA_BYTES');
  if (reader.ended) throw transportError('UNEXPECTED_EOF');
  return parseStrictEnvelope<SignedOllamaTailnetChallenge>(envelope, CHALLENGE_KEYS);
}

async function readResponse(
  reader: BoundedSocketReader,
  maxBodyBytes: number,
): Promise<Readonly<{
  envelope: EncryptedOllamaTailnetResponse;
  body: Buffer;
}>> {
  reader.setMaxBufferedBytes(
    MESSAGE_HEADER_BYTES + OLLAMA_TAILNET_MAX_ENVELOPE_BYTES + maxBodyBytes,
  );
  const header = await reader.readExact(MESSAGE_HEADER_BYTES);
  const envelopeLength = header.readUInt32BE(0);
  const bodyLength = header.readUInt32BE(4);
  if (envelopeLength < 2) throw transportError('FRAME_MALFORMED');
  if (envelopeLength > OLLAMA_TAILNET_MAX_ENVELOPE_BYTES || bodyLength > maxBodyBytes) {
    throw transportError('FRAME_TOO_LARGE');
  }
  const envelopeBytes = await reader.readExact(envelopeLength);
  const body = await reader.readExact(bodyLength);
  const envelope = parseStrictEnvelope<EncryptedOllamaTailnetResponse>(
    envelopeBytes,
    RESPONSE_KEYS,
  );
  await reader.expectCleanEnd();
  return Object.freeze({ envelope, body });
}

/**
 * Performs exactly one authenticated, whole-response request over one raw TCP
 * connection. The validated Tailnet IP literal and fixed helper port are used
 * directly; there is no DNS, HTTP redirect, retry, or fallback path.
 */
export async function requestOllamaOverTailnet(
  bindingInput: OllamaTailnetBindingInput,
  request: Readonly<{
    method: string;
    path: string;
    body: Uint8Array;
  }>,
  options: OllamaTailnetTransportOptions = {},
): Promise<OllamaTailnetTransportResponse> {
  if (
    !request
    || typeof request !== 'object'
    || !(request.body instanceof Uint8Array)
  ) {
    throw transportError('REQUEST_INVALID');
  }
  const policy = Object.prototype.hasOwnProperty.call(
    OLLAMA_TAILNET_PATH_POLICY,
    request.path,
  )
    ? OLLAMA_TAILNET_PATH_POLICY[request.path as OllamaTailnetPath]
    : null;
  if (
    !policy
    || request.method !== policy.method
    || request.body.byteLength > policy.maxRequestBytes
  ) {
    throw transportError('REQUEST_INVALID');
  }
  const requestPath = request.path as OllamaTailnetPath;
  const timeoutMs = safeTimeout(options.timeoutMs, requestPath);
  if (options.signal?.aborted) throw transportError('ABORTED');

  const protocol = new OllamaTailnetProtocol(bindingInput, {
    role: 'portal',
    ...(options.dependencies?.now ? { now: options.dependencies.now } : {}),
  });

  let socket: net.Socket;
  try {
    socket = (options.dependencies?.connect ?? defaultConnect)({
      host: protocol.binding.address,
      port: OLLAMA_TAILNET_HELPER_PORT,
      family: protocol.binding.addressFamily,
      autoSelectFamily: false,
    });
  } catch {
    protocol.dispose();
    throw transportError('CONNECT_FAILED');
  }
  if (!(socket instanceof net.Socket)) {
    protocol.dispose();
    throw transportError('CONNECT_FAILED');
  }

  socket.setNoDelay(true);
  const reader = new BoundedSocketReader(
    socket,
    ENVELOPE_HEADER_BYTES + OLLAMA_TAILNET_MAX_ENVELOPE_BYTES,
  );
  let terminalError: OllamaTailnetTransportError | null = null;
  const timeout = setTimeout(() => {
    terminalError ??= transportError('TIMED_OUT');
    reader.fail(terminalError);
  }, timeoutMs);
  timeout.unref?.();
  const onAbort = (): void => {
    terminalError ??= transportError('ABORTED');
    reader.fail(terminalError);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  let helloFrame: Buffer | null = null;
  let requestFrame: Buffer | null = null;
  let requestWireBody: Buffer | null = null;
  try {
    await waitForConnect(socket);
    const hello = protocol.createHello();
    helloFrame = encodeEnvelopeFrame(hello);
    await writeWithoutEnd(socket, helloFrame);
    helloFrame.fill(0);
    helloFrame = null;
    const challenge = await readChallenge(reader);
    protocol.verifyChallenge(hello, challenge);
    reader.setMaxBufferedBytes(
      MESSAGE_HEADER_BYTES
        + OLLAMA_TAILNET_MAX_ENVELOPE_BYTES
        + policy.maxResponseBytes
        + OLLAMA_TAILNET_GCM_TAG_BYTES,
    );
    const encryptedRequest = protocol.createRequest({
      method: request.method as OllamaTailnetMethod,
      path: request.path,
      body: request.body,
    });
    requestWireBody = encryptedRequest.wireBody;
    requestFrame = encodeMessageFrame(encryptedRequest.envelope, requestWireBody);
    await writeAndEnd(socket, requestFrame);
    requestFrame.fill(0);
    requestFrame = null;
    requestWireBody.fill(0);
    requestWireBody = null;
    const response = await readResponse(
      reader,
      policy.maxResponseBytes + OLLAMA_TAILNET_GCM_TAG_BYTES,
    );
    let body: Buffer;
    try {
      body = protocol.verifyResponse({
        request: encryptedRequest.envelope,
        response: response.envelope,
        wireBody: response.body,
      });
    } finally {
      response.body.fill(0);
    }
    return Object.freeze({
      protocolVersion: OLLAMA_TAILNET_PROTOCOL_VERSION,
      status: response.envelope.status,
      body,
      streaming: false as const,
    });
  } catch (error) {
    if (terminalError) throw terminalError;
    throw error;
  } finally {
    helloFrame?.fill(0);
    requestFrame?.fill(0);
    requestWireBody?.fill(0);
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    reader.dispose();
    protocol.dispose();
    if (!socket.destroyed) socket.destroy();
  }
}
