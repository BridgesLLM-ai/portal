import type { Request, Response } from 'express';

const DEFAULT_PROXY_MULTIPART_LIMIT_BYTES = 64 * 1024 * 1024;
const MIN_PROXY_MULTIPART_LIMIT_BYTES = 1024 * 1024;
const MAX_PROXY_MULTIPART_LIMIT_BYTES = 500 * 1024 * 1024;

function configuredLimitBytes(): number {
  const configured = Number(process.env.HOSTED_PROXY_MAX_BODY_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_PROXY_MULTIPART_LIMIT_BYTES;
  }
  return Math.max(
    MIN_PROXY_MULTIPART_LIMIT_BYTES,
    Math.min(MAX_PROXY_MULTIPART_LIMIT_BYTES, Math.floor(configured)),
  );
}

function rejectTooLarge(res: Response, limitBytes: number): void {
  if (res.headersSent) return;
  res.status(413).json({
    error: 'Upload too large',
    maxBytes: limitBytes,
  });
}

/**
 * Capture a multipart request only after the caller has authenticated or
 * validated its share token. Memory is strictly bounded, including for
 * chunked requests that omit Content-Length.
 *
 * Returns false when a 413 response has already been sent.
 */
export async function captureBoundedMultipartBody(
  req: Request & { rawBody?: Buffer },
  res: Response,
): Promise<boolean> {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) return true;

  const limitBytes = configuredLimitBytes();
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    rejectTooLarge(res, limitBytes);
    return false;
  }

  if (req.readableEnded) {
    req.rawBody = Buffer.alloc(0);
    return true;
  }

  return new Promise<boolean>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > limitBytes) {
        cleanup();
        chunks.length = 0;
        rejectTooLarge(res, limitBytes);
        // Drain the remaining request without retaining it in memory.
        req.resume();
        finish(false);
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      req.rawBody = Buffer.concat(chunks, totalBytes);
      finish(true);
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAborted = () => onError(new Error('Multipart upload aborted by client'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}
