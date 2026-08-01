export class ResponseTooLargeError extends Error {
  constructor(message = 'Upstream response is too large') {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

export async function readBoundedResponseBody(
  response: globalThis.Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive safe integer');
  }

  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedJson<T = unknown>(
  response: globalThis.Response,
  maxBytes: number,
): Promise<T> {
  const body = await readBoundedResponseBody(response, maxBytes);
  if (body.length === 0) return {} as T;
  return JSON.parse(body.toString('utf8')) as T;
}
