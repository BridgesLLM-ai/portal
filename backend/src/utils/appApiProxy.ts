import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { TextDecoder } from 'util';
import type { Request, Response } from 'express';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_VALIDATED_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const INITIAL_JSON_BUFFER_BYTES = 64 * 1024;

export const APP_API_BACKEND_UNCONFIGURED_CODE = 'APP_API_BACKEND_UNCONFIGURED';
export const APP_API_REQUEST_PATH_INVALID_CODE = 'APP_API_REQUEST_PATH_INVALID';
export const APP_API_UPSTREAM_TIMEOUT_CODE = 'APP_API_UPSTREAM_TIMEOUT';
export const APP_API_UPSTREAM_UNAVAILABLE_CODE = 'APP_API_UPSTREAM_UNAVAILABLE';
export const APP_API_UPSTREAM_RESPONSE_TOO_LARGE_CODE = 'APP_API_UPSTREAM_RESPONSE_TOO_LARGE';

class AppApiUpstreamResponseTooLargeError extends Error {
  readonly maxBytes = MAX_VALIDATED_JSON_RESPONSE_BYTES;

  constructor() {
    super(`App API JSON response exceeded ${MAX_VALIDATED_JSON_RESPONSE_BYTES} bytes`);
    this.name = 'AppApiUpstreamResponseTooLargeError';
  }
}

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'retry-after',
  'vary',
]);

export function appApiProxyTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.APP_API_PROXY_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(configured)));
}

export function serializeAppApiRequestBody(
  contentType: string,
  body: unknown,
  rawBody?: Buffer,
): string | Buffer {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('multipart/form-data')) return rawBody || Buffer.alloc(0);
  if (normalized.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          if (item === undefined || item === null) continue;
          params.append(key, typeof item === 'string' ? item : String(item));
        }
      }
    }
    return params.toString();
  }
  if (normalized.startsWith('text/') && typeof body === 'string') return body;
  if (typeof body === 'string') return body;
  return JSON.stringify(body ?? {});
}

export function createAppApiAbortContext(
  req: Pick<Request, 'once' | 'off'>,
  res: Pick<Response, 'once' | 'off' | 'writableEnded'>,
  timeoutMs = appApiProxyTimeoutMs(),
): { signal: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const abortForTimeout = () => {
    timedOut = true;
    controller.abort(new Error('App API upstream timed out'));
  };
  const abortForDisconnect = () => controller.abort(new Error('App API client disconnected'));
  const abortForClose = () => {
    if (!res.writableEnded) abortForDisconnect();
  };
  const timer = setTimeout(abortForTimeout, timeoutMs);

  req.once('aborted', abortForDisconnect);
  res.once('close', abortForClose);

  const cleanup = () => {
    clearTimeout(timer);
    req.off('aborted', abortForDisconnect);
    res.off('close', abortForClose);
  };

  return { signal: controller.signal, didTimeout: () => timedOut, cleanup };
}

export function rewriteAppProxyLocation(location: string, appBasePath: string): string | undefined {
  if (!location || location.length > 2048 || /[\r\n\\]/.test(location) || location.startsWith('//')) return undefined;
  try {
    const parsed = new URL(location, 'https://app-upstream.invalid/');
    if (parsed.origin !== 'https://app-upstream.invalid') return undefined;
    const base = `/${appBasePath.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
    return `${base}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

export function appApiBackendUnconfiguredResponse() {
  return {
    code: APP_API_BACKEND_UNCONFIGURED_CODE,
    error: 'This App API backend is not configured.',
    detail: 'Ask the Portal operator to configure the App-specific API target, then try again.',
    retryable: false,
  };
}

export function appApiRequestPathInvalidResponse() {
  return {
    code: APP_API_REQUEST_PATH_INVALID_CODE,
    error: 'The App API request path is invalid.',
    retryable: false,
  };
}

export function appApiUpstreamFailureResponse(timedOut: boolean, error?: unknown) {
  if (error instanceof AppApiUpstreamResponseTooLargeError) {
    return {
      status: 502,
      body: {
        code: APP_API_UPSTREAM_RESPONSE_TOO_LARGE_CODE,
        error: 'The shared App API backend returned a JSON response that is too large to verify safely.',
        maxBytes: error.maxBytes,
        retryable: false,
      },
    };
  }
  return timedOut
    ? {
      status: 504,
      body: {
        code: APP_API_UPSTREAM_TIMEOUT_CODE,
        error: 'The shared App API backend timed out.',
        retryable: true,
      },
    }
    : {
      status: 502,
      body: {
        code: APP_API_UPSTREAM_UNAVAILABLE_CODE,
        error: 'The shared App API backend is unavailable.',
        retryable: true,
      },
    };
}

class BoundedJsonBuffer {
  private storage = Buffer.allocUnsafe(INITIAL_JSON_BUFFER_BYTES);
  private length = 0;

  append(chunk: Buffer): void {
    const required = this.length + chunk.length;
    if (required > MAX_VALIDATED_JSON_RESPONSE_BYTES) {
      throw new AppApiUpstreamResponseTooLargeError();
    }
    if (required > this.storage.length) {
      let capacity = this.storage.length;
      while (capacity < required) {
        capacity = Math.min(MAX_VALIDATED_JSON_RESPONSE_BYTES, capacity * 2);
      }
      const expanded = Buffer.allocUnsafe(capacity);
      this.storage.copy(expanded, 0, 0, this.length);
      this.storage = expanded;
    }
    chunk.copy(this.storage, this.length);
    this.length = required;
  }

  bytes(): Buffer {
    return this.storage.subarray(0, this.length);
  }

  byteLength(): number {
    return this.length;
  }
}

function responseIsJson(upstream: globalThis.Response): boolean {
  const mediaType = String(upstream.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function declaredIdentityContentLength(upstream: globalThis.Response): number | undefined {
  // Node fetch exposes decompressed response bytes while a compressed
  // Content-Length describes the wire representation. Do not compare those
  // different lengths, but still buffer and validate small decoded JSON.
  const contentEncoding = String(upstream.headers.get('content-encoding') || '').trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') return undefined;

  const rawLength = String(upstream.headers.get('content-length') || '').trim();
  if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) return undefined;
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) return undefined;
  return length;
}

function assertCompleteJsonBody(body: Buffer): void {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    JSON.parse(text);
  } catch {
    throw new Error('App API JSON response was incomplete or invalid');
  }
}

function applyAppApiResponseMetadata(
  upstream: globalThis.Response,
  res: Response,
  options: { locationBasePath?: string },
): void {
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (RESPONSE_HEADER_ALLOWLIST.has(key.toLowerCase())) res.setHeader(key, value);
  });
  const upstreamLocation = upstream.headers.get('location');
  if (upstreamLocation && options.locationBasePath) {
    const rewritten = rewriteAppProxyLocation(upstreamLocation, options.locationBasePath);
    if (rewritten) res.setHeader('Location', rewritten);
  }
}

async function bufferAndValidateJson(
  upstream: globalThis.Response,
  res: Response,
  options: { locationBasePath?: string },
): Promise<void> {
  const body = upstream.body!;
  const reader = body.getReader();
  const declaredLength = declaredIdentityContentLength(upstream);
  if (declaredLength !== undefined && declaredLength > MAX_VALIDATED_JSON_RESPONSE_BYTES) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw new AppApiUpstreamResponseTooLargeError();
  }
  const buffered = new BoundedJsonBuffer();
  let readerOwned = true;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        readerOwned = false;
        const completeBody = buffered.bytes();
        if (declaredLength !== undefined && buffered.byteLength() !== declaredLength) {
          throw new Error(
            `App API JSON response length mismatch (${buffered.byteLength()}/${declaredLength} bytes)`,
          );
        }
        assertCompleteJsonBody(completeBody);
        applyAppApiResponseMetadata(upstream, res, options);
        res.end(completeBody);
        return;
      }

      const chunk = Buffer.from(value);
      if (chunk.length === 0) continue;
      buffered.append(chunk);
    }
  } catch (error) {
    if (readerOwned) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (readerOwned) reader.releaseLock();
  }
}

export async function streamAppApiResponse(
  upstream: globalThis.Response,
  res: Response,
  options: { locationBasePath?: string } = {},
): Promise<void> {
  if (!upstream.body) {
    applyAppApiResponseMetadata(upstream, res, options);
    res.end();
    return;
  }

  // Login/session APIs overwhelmingly return small JSON. Buffer every JSON
  // media type (including chunked responses) up to the strict cap and require
  // a complete valid document before committing status. JSON is never switched
  // to a commit-first streaming path: a reset, premature close, truncated
  // document, or oversized response therefore becomes a truthful Portal 502
  // instead of a misleading 2xx/401 with unusable JSON.
  if (responseIsJson(upstream)) {
    await bufferAndValidateJson(upstream, res, options);
    return;
  }

  // Node fetch exposes a WHATWG stream. Pipe it without materializing the
  // entire response, preserving backpressure for large downloads and streams.
  applyAppApiResponseMetadata(upstream, res, options);
  await pipeline(Readable.fromWeb(upstream.body as any), res);
}

export const __appApiProxyTest = {
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_VALIDATED_JSON_RESPONSE_BYTES,
  RESPONSE_HEADER_ALLOWLIST,
};
