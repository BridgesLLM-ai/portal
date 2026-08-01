import { PassThrough } from 'node:stream';
import type { Request, Response } from 'express';
import { captureBoundedMultipartBody } from '../utils/proxyMultipartBody';

function mockResponse() {
  const state: { status?: number; body?: unknown } = {};
  const response = {
    headersSent: false,
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { response, state };
}

function mockRequest(headers: Record<string, string> = {}) {
  const stream = new PassThrough() as PassThrough & Request & { rawBody?: Buffer };
  Object.assign(stream, { headers });
  return stream;
}

describe('captureBoundedMultipartBody', () => {
  const originalLimit = process.env.HOSTED_PROXY_MAX_BODY_BYTES;

  afterEach(() => {
    if (originalLimit === undefined) delete process.env.HOSTED_PROXY_MAX_BODY_BYTES;
    else process.env.HOSTED_PROXY_MAX_BODY_BYTES = originalLimit;
  });

  it('does not consume non-multipart requests', async () => {
    const req = mockRequest({ 'content-type': 'application/json' });
    const { response } = mockResponse();

    await expect(captureBoundedMultipartBody(req, response)).resolves.toBe(true);
    expect(req.rawBody).toBeUndefined();
  });

  it('rejects an oversized declared body before attaching a buffer', async () => {
    process.env.HOSTED_PROXY_MAX_BODY_BYTES = String(1024 * 1024);
    const req = mockRequest({
      'content-type': 'multipart/form-data; boundary=test',
      'content-length': String(1024 * 1024 + 1),
    });
    const { response, state } = mockResponse();

    await expect(captureBoundedMultipartBody(req, response)).resolves.toBe(false);
    expect(state.status).toBe(413);
    expect(req.rawBody).toBeUndefined();
  });

  it('captures an allowed multipart request', async () => {
    process.env.HOSTED_PROXY_MAX_BODY_BYTES = String(1024 * 1024);
    const req = mockRequest({ 'content-type': 'multipart/form-data; boundary=test' });
    const { response } = mockResponse();
    const result = captureBoundedMultipartBody(req, response);

    req.end(Buffer.from('small multipart body'));

    await expect(result).resolves.toBe(true);
    expect(req.rawBody?.toString('utf8')).toBe('small multipart body');
  });

  it('rejects chunked data once the configured limit is exceeded', async () => {
    process.env.HOSTED_PROXY_MAX_BODY_BYTES = String(1024 * 1024);
    const req = mockRequest({ 'content-type': 'multipart/form-data; boundary=test' });
    const { response, state } = mockResponse();
    const result = captureBoundedMultipartBody(req, response);

    req.write(Buffer.alloc(1024 * 1024));
    req.end(Buffer.from('overflow'));

    await expect(result).resolves.toBe(false);
    expect(state.status).toBe(413);
    expect(req.rawBody).toBeUndefined();
  });
});
