import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { Request, Response } from 'express';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;

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

export async function streamAppApiResponse(
  upstream: globalThis.Response,
  res: Response,
  options: { locationBasePath?: string } = {},
): Promise<void> {
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (RESPONSE_HEADER_ALLOWLIST.has(key.toLowerCase())) res.setHeader(key, value);
  });
  const upstreamLocation = upstream.headers.get('location');
  if (upstreamLocation && options.locationBasePath) {
    const rewritten = rewriteAppProxyLocation(upstreamLocation, options.locationBasePath);
    if (rewritten) res.setHeader('Location', rewritten);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  // Node fetch exposes a WHATWG stream. Pipe it without materializing the
  // entire response, preserving backpressure for large downloads and streams.
  await pipeline(Readable.fromWeb(upstream.body as any), res);
}

export const __appApiProxyTest = {
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  RESPONSE_HEADER_ALLOWLIST,
};
