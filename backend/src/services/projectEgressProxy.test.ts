import http from 'http';
import net from 'net';
import { PassThrough } from 'stream';
import {
  buildPinnedProjectEgressRequestOptions,
  createProjectEgressProxyServer,
  isAuthorizedProjectEgressRequest,
  sanitizeProjectEgressRequestHeaders,
  validateProjectEgressTlsClientHello,
  validateProjectEgressProxyToken,
} from './projectEgressProxy';
import type { ResolvedProjectEgressTarget } from './projectEgressPolicy';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789_-';
const AUTH = `Bearer ${TOKEN}`;
const BASIC_AUTH = `Basic ${Buffer.from(`portal:${TOKEN}`).toString('base64')}`;

function sampleTarget(): ResolvedProjectEgressTarget {
  return {
    url: new URL('https://example.com/download?q=1'),
    hostname: 'example.com',
    port: 443,
    addresses: [{ address: '93.184.216.34', family: 4 }],
    selectedAddress: '93.184.216.34',
    selectedFamily: 4,
  };
}

function tlsClientHello(hostname: string): Buffer {
  const name = Buffer.from(hostname, 'ascii');
  const serverName = Buffer.concat([
    Buffer.from([0]),
    Buffer.from([(name.length >> 8) & 0xff, name.length & 0xff]),
    name,
  ]);
  const serverNameList = Buffer.concat([
    Buffer.from([(serverName.length >> 8) & 0xff, serverName.length & 0xff]),
    serverName,
  ]);
  const extension = Buffer.concat([
    Buffer.from([0, 0, (serverNameList.length >> 8) & 0xff, serverNameList.length & 0xff]),
    serverNameList,
  ]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    Buffer.from([(extension.length >> 8) & 0xff, extension.length & 0xff]),
    extension,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([1, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  return Buffer.concat([
    Buffer.from([22, 3, 1, (handshake.length >> 8) & 0xff, handshake.length & 0xff]),
    handshake,
  ]);
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test proxy did not listen');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function requestProxy(input: {
  port: number;
  path: string;
  auth?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: input.port,
      method: input.method || 'GET',
      path: input.path,
      headers: {
        ...(input.auth ? { 'proxy-authorization': input.auth } : {}),
        ...(input.headers || {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(input.body);
  });
}

function fakeOutgoingRequest(input: {
  onOptions?: (options: http.RequestOptions) => void;
  status?: number;
  headers?: http.IncomingHttpHeaders;
  body?: string;
} = {}): (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => http.ClientRequest {
  return (options, callback) => {
    input.onOptions?.(options);
    const request = new PassThrough() as unknown as http.ClientRequest;
    (request as any).setTimeout = jest.fn(() => request);
    request.once('finish', () => {
      const response = new PassThrough() as unknown as http.IncomingMessage;
      response.statusCode = input.status || 200;
      response.statusMessage = response.statusCode === 302 ? 'Found' : 'OK';
      response.headers = input.headers || { 'content-type': 'text/plain' };
      callback(response);
      (response as unknown as PassThrough).end(input.body || 'ok');
    });
    return request;
  };
}

describe('project egress proxy', () => {
  test('requires a high-entropy token and authenticates Bearer or standard Basic proxy credentials', () => {
    expect(() => validateProjectEgressProxyToken('short')).toThrow('256 bits');
    expect(validateProjectEgressProxyToken(TOKEN)).toBe(TOKEN);
    expect(isAuthorizedProjectEgressRequest(AUTH, TOKEN)).toBe(true);
    expect(isAuthorizedProjectEgressRequest(BASIC_AUTH, TOKEN)).toBe(true);
    expect(isAuthorizedProjectEgressRequest(`Basic ${Buffer.from(`other:${TOKEN}`).toString('base64')}`, TOKEN)).toBe(false);
    expect(isAuthorizedProjectEgressRequest(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorizedProjectEgressRequest(['Bearer bad'], TOKEN)).toBe(false);
  });

  test('pins HTTP/TLS requests to the validated IP while preserving Host and SNI', () => {
    const target = sampleTarget();
    const req = {
      method: 'GET',
      headers: {
        host: 'attacker.invalid',
        connection: 'keep-alive, x-remove',
        'x-remove': 'secret',
        'proxy-authorization': AUTH,
        'x-safe': 'yes',
      },
    } as unknown as http.IncomingMessage;
    const options = buildPinnedProjectEgressRequestOptions(req, target);
    expect(options).toMatchObject({
      hostname: '93.184.216.34',
      port: 443,
      family: 4,
      path: '/download?q=1',
      servername: 'example.com',
      rejectUnauthorized: true,
    });
    expect(options.headers).toMatchObject({ host: 'example.com', 'x-safe': 'yes' });
    expect(options.headers).not.toHaveProperty('proxy-authorization');
    expect(options.headers).not.toHaveProperty('x-remove');
    const lookup = options.lookup!;
    const callback = jest.fn();
    (lookup as any)('changed.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  test('sanitizes static and Connection-nominated hop-by-hop headers', () => {
    const headers = sanitizeProjectEgressRequestHeaders({
      host: 'wrong.test',
      connection: 'keep-alive, x-secret',
      'x-secret': 'remove-me',
      upgrade: 'websocket',
      te: 'trailers',
      authorization: 'target-credential',
    }, sampleTarget());
    expect(headers).toMatchObject({
      host: 'example.com',
      authorization: 'target-credential',
    });
    expect(headers).not.toHaveProperty('connection');
    expect(headers).not.toHaveProperty('x-secret');
    expect(headers).not.toHaveProperty('upgrade');
    expect(headers).not.toHaveProperty('te');
  });

  test('requires a TLS ClientHello with SNI matching the validated CONNECT hostname', () => {
    const hello = tlsClientHello('example.com');
    expect(validateProjectEgressTlsClientHello(hello.subarray(0, 10), 'example.com'))
      .toEqual({ status: 'need-more' });
    expect(validateProjectEgressTlsClientHello(hello, 'example.com'))
      .toEqual({ status: 'valid', serverName: 'example.com' });
    expect(validateProjectEgressTlsClientHello(hello, 'other.example'))
      .toEqual({ status: 'invalid' });
    expect(validateProjectEgressTlsClientHello(Buffer.from('SSH-2.0-OpenSSH\r\n'), 'example.com'))
      .toEqual({ status: 'invalid' });
    const oversized = Buffer.alloc(65 * 1024, 0);
    expect(validateProjectEgressTlsClientHello(oversized, 'example.com'))
      .toEqual({ status: 'invalid' });
  });

  test('rejects unauthenticated requests before DNS or outbound dispatch', async () => {
    const resolver = jest.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const outbound = jest.fn(fakeOutgoingRequest());
    const server = createProjectEgressProxyServer({ token: TOKEN, resolver }, { httpRequest: outbound });
    const port = await listen(server);
    try {
      const response = await requestProxy({ port, path: 'http://example.com/' });
      expect(response.status).toBe(407);
      expect(response.headers['proxy-authenticate']).toContain('Basic');
      expect(resolver).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  test('relays redirects without following them, so each redirected URL must be revalidated', async () => {
    const resolver = jest.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const seen: http.RequestOptions[] = [];
    const outbound = jest.fn(fakeOutgoingRequest({
      onOptions: (options) => seen.push(options),
      status: 302,
      headers: {
        location: 'http://169.254.169.254/latest/meta-data',
        connection: 'x-private',
        'x-private': 'remove-me',
      },
    }));
    const server = createProjectEgressProxyServer({ token: TOKEN, resolver }, { httpRequest: outbound });
    const port = await listen(server);
    try {
      const response = await requestProxy({
        port,
        path: 'http://example.com/start',
        auth: BASIC_AUTH,
      });
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('169.254.169.254');
      expect(response.headers['x-private']).toBeUndefined();
      expect(outbound).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(seen[0]).toMatchObject({ hostname: '93.184.216.34', path: '/start' });
    } finally {
      await close(server);
    }
  });

  test.each([
    [{ address: '127.0.0.1', family: 4 as const }, 'DNS_NON_PUBLIC'],
    [{ address: '169.254.169.254', family: 4 as const }, 'DNS_NON_PUBLIC'],
    [{ address: '172.17.0.1', family: 4 as const }, 'DNS_NON_PUBLIC'],
    [{ address: 'fd00::1', family: 6 as const }, 'DNS_NON_PUBLIC'],
  ])('blocks private resolution %j before outbound dispatch', async (record, errorCode) => {
    const outbound = jest.fn(fakeOutgoingRequest());
    const server = createProjectEgressProxyServer({
      token: TOKEN,
      resolver: async () => [record],
    }, { httpRequest: outbound });
    const port = await listen(server);
    try {
      const response = await requestProxy({ port, path: 'http://example.com/', auth: AUTH });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: errorCode });
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  test('bounds DNS resolution so a stuck resolver cannot exhaust proxy capacity', async () => {
    const resolver = jest.fn(() => new Promise<never>(() => undefined));
    const outbound = jest.fn(fakeOutgoingRequest());
    const server = createProjectEgressProxyServer({
      token: TOKEN,
      resolver,
      resolveTimeoutMs: 20,
    }, { httpRequest: outbound });
    const port = await listen(server);
    try {
      const response = await requestProxy({ port, path: 'http://example.com/', auth: AUTH });
      expect(response.status).toBe(504);
      expect(JSON.parse(response.body)).toEqual({ error: 'DNS_TIMEOUT' });
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  test('CONNECT resolves once and opens the tunnel to the exact validated IP', async () => {
    const resolver = jest.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    let connectOptions: net.NetConnectOpts | undefined;
    const upstream = new PassThrough() as unknown as net.Socket;
    (upstream as any).setTimeout = jest.fn(() => upstream);
    const connectSocket = jest.fn((options: net.NetConnectOpts, callback: () => void) => {
      connectOptions = options;
      setImmediate(() => {
        upstream.emit('connect');
        callback();
      });
      return upstream;
    });
    const server = createProjectEgressProxyServer({ token: TOKEN, resolver }, { connectSocket });
    const client = new PassThrough() as unknown as net.Socket;
    (client as any).setTimeout = jest.fn(() => client);
    const responsePromise = new Promise<string>((resolve) => {
      client.once('data', (chunk) => resolve(chunk.toString('utf8')));
    });
    server.emit('connect', {
      url: 'example.com:443',
      headers: { 'proxy-authorization': AUTH },
    } as http.IncomingMessage, client, Buffer.alloc(0));
    const response = await responsePromise;
    client.destroy();
    upstream.destroy();
    expect(response).toContain('200 Connection Established');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(connectOptions).toMatchObject({ host: '93.184.216.34', port: 443, family: 4 });
  });

  test('rejects non-absolute requests and unsafe proxy methods', async () => {
    const resolver = jest.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const server = createProjectEgressProxyServer({ token: TOKEN, resolver });
    const port = await listen(server);
    try {
      expect((await requestProxy({ port, path: '/relative', auth: AUTH })).status).toBe(400);
      expect((await requestProxy({ port, path: 'http://example.com/', auth: AUTH, method: 'TRACE' })).status).toBe(405);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
