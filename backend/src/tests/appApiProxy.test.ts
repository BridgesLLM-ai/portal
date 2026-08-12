import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  __appApiProxyTest,
  appApiBackendUnconfiguredResponse,
  appApiProxyTimeoutMs,
  appApiUpstreamFailureResponse,
  createAppApiAbortContext,
  rewriteAppProxyLocation,
  serializeAppApiRequestBody,
  streamAppApiResponse,
} from '../utils/appApiProxy';

describe('app API proxy transport', () => {
  function responseOutput() {
    const output = new PassThrough() as any;
    const headers = new Map<string, string>();
    const chunks: Buffer[] = [];
    output.status = jest.fn(() => output);
    output.setHeader = jest.fn((key: string, value: string) => headers.set(key.toLowerCase(), value));
    output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    return { output, headers, chunks };
  }

  test('clamps upstream timeouts to a bounded range', () => {
    expect(appApiProxyTimeoutMs({})).toBe(60_000);
    expect(appApiProxyTimeoutMs({ APP_API_PROXY_TIMEOUT_MS: '1' })).toBe(5_000);
    expect(appApiProxyTimeoutMs({ APP_API_PROXY_TIMEOUT_MS: '999999' })).toBe(120_000);
  });

  test('aborts a stalled upstream instead of waiting indefinitely', () => {
    jest.useFakeTimers();
    try {
      const req = new EventEmitter() as any;
      const res = new EventEmitter() as any;
      res.writableEnded = false;
      const context = createAppApiAbortContext(req, res, 5_000);
      expect(context.signal.aborted).toBe(false);
      jest.advanceTimersByTime(5_001);
      expect(context.signal.aborted).toBe(true);
      expect(context.didTimeout()).toBe(true);
      context.cleanup();
    } finally {
      jest.useRealTimers();
    }
  });

  test('preserves JSON, form, text, and multipart body semantics', () => {
    expect(serializeAppApiRequestBody('application/json', { a: 1 })).toBe('{"a":1}');
    expect(serializeAppApiRequestBody('application/x-www-form-urlencoded', { a: 'one two', b: ['1', '2'] }))
      .toBe('a=one+two&b=1&b=2');
    expect(serializeAppApiRequestBody('text/plain', 'hello')).toBe('hello');
    expect(serializeAppApiRequestBody('multipart/form-data; boundary=x', {}, Buffer.from('raw')))
      .toEqual(Buffer.from('raw'));
  });

  test('rewrites only relative upstream redirects into the app scope', () => {
    expect(rewriteAppProxyLocation('/login?next=%2F', '/hosted/user-app')).toBe('/hosted/user-app/login?next=%2F');
    expect(rewriteAppProxyLocation('../login', '/share/token')).toBe('/share/token/login');
    expect(rewriteAppProxyLocation('https://attacker.example/', '/share/token')).toBeUndefined();
    expect(rewriteAppProxyLocation('//attacker.example/', '/share/token')).toBeUndefined();
  });

  test('returns stable machine-readable configuration and upstream failures', () => {
    expect(appApiBackendUnconfiguredResponse()).toEqual(expect.objectContaining({
      code: 'APP_API_BACKEND_UNCONFIGURED',
      retryable: false,
    }));
    expect(appApiUpstreamFailureResponse(true)).toEqual({
      status: 504,
      body: expect.objectContaining({ code: 'APP_API_UPSTREAM_TIMEOUT', retryable: true }),
    });
    expect(appApiUpstreamFailureResponse(false)).toEqual({
      status: 502,
      body: expect.objectContaining({ code: 'APP_API_UPSTREAM_UNAVAILABLE', retryable: true }),
    });
  });

  test('buffers chunked small JSON through completion before preserving upstream auth status', async () => {
    const { output, headers, chunks } = responseOutput();
    let controller: any;
    const upstream = new Response(new ReadableStream({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(Buffer.from('{"authenticated":'));
      },
    }), {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': 'accessToken=attacker; Path=/',
      },
    });

    const response = streamAppApiResponse(upstream, output);
    await Promise.resolve();
    expect(output.status).not.toHaveBeenCalled();
    controller.enqueue(Buffer.from('false}'));
    controller.close();
    await response;

    expect(output.status).toHaveBeenCalledWith(401);
    expect(Buffer.concat(chunks).toString()).toBe('{"authenticated":false}');
    expect(headers.has('set-cookie')).toBe(false);
  });

  test.each([
    ['a chunked upstream error', (controller: any) => controller.error(new Error('socket reset'))],
    ['a cleanly closed invalid document', (controller: any) => controller.close()],
  ])('rejects %s before committing JSON response metadata', async (_label, terminate) => {
    const { output } = responseOutput();
    let controller: any;
    const upstream = new Response(new ReadableStream({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(Buffer.from('{"ok":'));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/problem+json' },
    });

    const response = streamAppApiResponse(upstream, output);
    await Promise.resolve();
    terminate(controller);

    await expect(response).rejects.toThrow();
    expect(output.status).not.toHaveBeenCalled();
    output.destroy();
  });

  test('keeps bounded JSON validation intact across many tiny chunks', async () => {
    const { output, chunks } = responseOutput();
    const payload = JSON.stringify({ value: 'x'.repeat(300) });
    const upstream = new Response(new ReadableStream({
      start(controller) {
        for (const byte of Buffer.from(payload)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await streamAppApiResponse(upstream, output);

    expect(Buffer.concat(chunks).toString()).toBe(payload);
  });

  test('validates JSON beyond the former one-megabyte streaming threshold before preserving status', async () => {
    const { output, chunks } = responseOutput();
    const payload = JSON.stringify({
      value: 'x'.repeat((1024 * 1024) + 16),
    });
    const upstream = new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await streamAppApiResponse(upstream, output);

    expect(output.status).toHaveBeenCalledWith(200);
    expect(Buffer.concat(chunks).toString()).toBe(payload);
  });

  test('rejects chunked JSON truncated beyond the former streaming threshold before committing status', async () => {
    const { output } = responseOutput();
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`{"value":"${'x'.repeat((1024 * 1024) + 16)}`));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect(streamAppApiResponse(upstream, output)).rejects.toThrow(/incomplete or invalid/);
    expect(output.status).not.toHaveBeenCalled();
    output.destroy();
  });

  test('rejects JSON beyond the validation cap before committing status', async () => {
    const { output } = responseOutput();
    const payload = JSON.stringify({
      value: 'x'.repeat(__appApiProxyTest.MAX_VALIDATED_JSON_RESPONSE_BYTES + 1),
    });
    const upstream = new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    let error: unknown;
    try {
      await streamAppApiResponse(upstream, output);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(output.status).not.toHaveBeenCalled();
    expect(appApiUpstreamFailureResponse(false, error)).toEqual({
      status: 502,
      body: expect.objectContaining({
        code: 'APP_API_UPSTREAM_RESPONSE_TOO_LARGE',
        maxBytes: __appApiProxyTest.MAX_VALIDATED_JSON_RESPONSE_BYTES,
        retryable: false,
      }),
    });
    output.destroy();
  });

  test('streams with backpressure and does not forward upstream cookies', async () => {
    const { output, headers, chunks } = responseOutput();

    const upstream = new Response('streamed body', {
      status: 201,
      headers: {
        'content-type': 'text/plain',
        'set-cookie': 'accessToken=attacker; Path=/',
        'x-internal-secret': 'do-not-forward',
      },
    });
    await streamAppApiResponse(upstream, output);

    expect(output.status).toHaveBeenCalledWith(201);
    expect(Buffer.concat(chunks).toString()).toBe('streamed body');
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.has('set-cookie')).toBe(false);
    expect(headers.has('x-internal-secret')).toBe(false);
  });
});
