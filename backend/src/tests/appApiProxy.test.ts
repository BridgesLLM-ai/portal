import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  appApiProxyTimeoutMs,
  createAppApiAbortContext,
  rewriteAppProxyLocation,
  serializeAppApiRequestBody,
  streamAppApiResponse,
} from '../utils/appApiProxy';

describe('app API proxy transport', () => {
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

  test('streams with backpressure and does not forward upstream cookies', async () => {
    const output = new PassThrough() as any;
    const headers = new Map<string, string>();
    output.status = jest.fn(() => output);
    output.setHeader = jest.fn((key: string, value: string) => headers.set(key.toLowerCase(), value));
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

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
