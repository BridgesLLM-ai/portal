import * as http from 'node:http';
import * as net from 'node:net';
import {
  NATIVE_OLLAMA_STREAM_COMPLETE,
  NATIVE_OLLAMA_TRANSPORT_POLICY,
  NativeOllamaTransportError,
  requestNativeOllama,
  streamNativeOllama,
  type NativeOllamaEndpoint,
  type NativeOllamaTransportDependencies,
  type NativeOllamaTransportRequest,
} from './nativeOllamaTransport';

const openServers = new Set<http.Server>();

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return { server, port: address.port };
}

async function closeServer(server: http.Server): Promise<void> {
  if (!openServers.delete(server)) return;
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface ObservedTransport {
  readonly requests: http.RequestOptions[];
  readonly connects: net.NetConnectOpts[];
  readonly sockets: net.Socket[];
}

function observedTransport(): ObservedTransport {
  return { requests: [], connects: [], sockets: [] };
}

function testDependencies(
  actualPort: number,
  observed: ObservedTransport,
): NativeOllamaTransportDependencies {
  return {
    request: (options, callback) => {
      observed.requests.push({ ...options });
      return http.request(options, callback);
    },
    connect: (options) => {
      observed.connects.push({ ...options });
      const socket = net.createConnection({
        host: '127.0.0.1',
        port: actualPort,
        family: 4,
      });
      observed.sockets.push(socket);
      return socket;
    },
  };
}

function nativeRequest(
  overrides: Partial<NativeOllamaTransportRequest> = {},
): NativeOllamaTransportRequest {
  return {
    endpoint: {
      address: '127.0.0.1',
      family: 4,
      port: 11434,
    },
    path: '/api/tags',
    method: 'GET',
    ...overrides,
  };
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

afterEach(async () => {
  for (const server of [...openServers]) {
    await closeServer(server);
  }
});

test.each([
  {
    endpoint: {
      address: '100.72.19.8',
      family: 4,
      port: 11434,
    } as const,
  },
  {
    endpoint: {
      address: 'fd7a:115c:a1e0::4321',
      family: 6,
      port: 11435,
    } as const,
  },
])(
  'dials the exact literal $endpoint.address:$endpoint.port endpoint',
  async ({ endpoint }) => {
    const requests: http.IncomingMessage[] = [];
    const target = await listen((request, response) => {
      requests.push(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"models":[]}');
    });
    const observed = observedTransport();
    const oldHttpProxy = process.env.HTTP_PROXY;
    const oldNodeProxy = process.env.NODE_USE_ENV_PROXY;
    process.env.HTTP_PROXY = 'http://169.254.169.254:65535';
    process.env.NODE_USE_ENV_PROXY = '1';
    try {
      const response = await requestNativeOllama(nativeRequest({ endpoint }),
        testDependencies(target.port, observed));
      expect(response.body.toString('utf8')).toBe('{"models":[]}');
    } finally {
      if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = oldHttpProxy;
      if (oldNodeProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = oldNodeProxy;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/tags');
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]).toMatchObject({
      protocol: 'http:',
      hostname: endpoint.address,
      port: endpoint.port,
      family: endpoint.family,
      method: 'GET',
      path: '/api/tags',
    });
    expect(observed.requests[0].agent).toBeInstanceOf(http.Agent);
    expect(observed.requests[0].agent).not.toBe(http.globalAgent);
    expect(observed.requests[0]).not.toHaveProperty('lookup');
    expect(observed.requests[0]).not.toHaveProperty('proxy');
    expect(observed.requests[0]).not.toHaveProperty('proxyEnv');
    expect(observed.connects).toEqual([{
      host: endpoint.address,
      port: endpoint.port,
      family: endpoint.family,
    }]);
  },
);

test.each([
  {
    address: 'gpu.example.test',
    family: 4,
    port: 11434,
  },
  {
    address: '127.0.0.1',
    family: 6,
    port: 11434,
  },
  {
    address: '::1',
    family: 4,
    port: 11435,
  },
  {
    address: 'fe80::1%eth0',
    family: 6,
    port: 11435,
  },
  {
    address: '127.0.0.1',
    family: 4,
    port: 80,
  },
  {
    address: '127.0.0.1',
    family: 4,
    port: 11436,
  },
])(
  'rejects non-literal, family-mismatched, scoped, or non-fixed endpoint %#',
  async (endpoint) => {
    const request = nativeRequest({
      endpoint: endpoint as NativeOllamaEndpoint,
    });
    await expect(requestNativeOllama(request)).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
  },
);

test('has an exact API path/method allowlist and rejects coercive inputs', async () => {
  expect(Object.entries(NATIVE_OLLAMA_TRANSPORT_POLICY).map(
    ([path, policy]) => [path, policy.method],
  )).toEqual([
    ['/api/version', 'GET'],
    ['/api/tags', 'GET'],
    ['/api/ps', 'GET'],
    ['/api/show', 'POST'],
    ['/api/chat', 'POST'],
    ['/api/generate', 'POST'],
    ['/api/pull', 'POST'],
  ]);

  await expect(requestNativeOllama(nativeRequest({
    path: '/api/unknown' as '/api/tags',
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestNativeOllama(nativeRequest({
    method: 'POST' as 'GET',
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestNativeOllama(nativeRequest({
    body: '{}',
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestNativeOllama(nativeRequest({
    timeoutMs: '5000' as unknown as number,
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestNativeOllama(nativeRequest({
    timeoutMs: 99,
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestNativeOllama(nativeRequest({
    timeoutMs: 10 * 60_000 + 1,
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestNativeOllama(nativeRequest({
    maxResponseBytes: 0,
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
});

test('enforces request body bounds before opening a socket', async () => {
  let dispatches = 0;
  const dependencies: NativeOllamaTransportDependencies = {
    request: () => {
      dispatches += 1;
      throw new Error('must not dispatch');
    },
  };

  await expect(requestNativeOllama(nativeRequest({
    path: '/api/show',
    method: 'POST',
    body: Buffer.alloc(256 * 1024 + 1, 1),
  }), dependencies)).rejects.toMatchObject({
    code: 'REQUEST_TOO_LARGE',
  });
  expect(dispatches).toBe(0);
});

test('sends a bounded request body exactly once', async () => {
  const received = deferred<Buffer>();
  let requestCount = 0;
  const target = await listen(async (request, response) => {
    requestCount += 1;
    received.resolve(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const observed = observedTransport();
  const body = '{"name":"tiny","stream":true}';

  await expect(requestNativeOllama(nativeRequest({
    path: '/api/pull',
    method: 'POST',
    body,
  }), testDependencies(target.port, observed))).resolves.toMatchObject({
    statusCode: 200,
  });

  expect((await received.promise).toString('utf8')).toBe(body);
  expect(requestCount).toBe(1);
  expect(observed.connects).toHaveLength(1);
  expect(observed.requests[0].headers).toMatchObject({
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'application/json',
  });
});

test('permits the two-hour pull deadline without widening ordinary requests', async () => {
  const aborted = new AbortController();
  aborted.abort();

  await expect(requestNativeOllama(nativeRequest({
    path: '/api/pull',
    method: 'POST',
    body: '{"model":"tiny","stream":true}',
    timeoutMs: 2 * 60 * 60_000,
    signal: aborted.signal,
  }))).rejects.toMatchObject({ code: 'ABORTED' });

  await expect(requestNativeOllama(nativeRequest({
    path: '/api/version',
    method: 'GET',
    timeoutMs: 2 * 60 * 60_000,
    signal: aborted.signal,
  }))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
});

test('rejects declared and streamed responses above the effective bound', async () => {
  const declared = await listen((_request, response) => {
    response.writeHead(200, {
      'content-length': String(64 * 1024 + 1),
    });
    response.flushHeaders();
  });
  await expect(requestNativeOllama(nativeRequest({
    path: '/api/version',
    method: 'GET',
    maxResponseBytes: 1024 * 1024,
  }), testDependencies(declared.port, observedTransport()))).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
  });
  await closeServer(declared.server);

  const streamed = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write('1234');
    response.end('56');
  });
  const seen: string[] = [];
  await expect(streamNativeOllama(nativeRequest({
    path: '/api/pull',
    method: 'POST',
    body: '{"model":"tiny","stream":true}',
    maxResponseBytes: 5,
  }), (chunk) => {
    seen.push(chunk.toString('utf8'));
  }, testDependencies(streamed.port, observedTransport()))).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
  });
  expect(seen.join('')).not.toContain('6');
});

test('streams split chunks sequentially and applies callback backpressure', async () => {
  const responseReady = deferred<http.ServerResponse>();
  const target = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.flushHeaders();
    response.write('alpha');
    responseReady.resolve(response);
  });
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const seen: string[] = [];
  let activeCallbacks = 0;
  let maxActiveCallbacks = 0;

  const action = streamNativeOllama(nativeRequest({
    path: '/api/pull',
    method: 'POST',
    body: '{"model":"tiny","stream":true}',
  }), async (chunk) => {
    activeCallbacks += 1;
    maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
    seen.push(chunk.toString('utf8'));
    if (seen.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else if (seen.length === 2) {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
    activeCallbacks -= 1;
  }, testDependencies(target.port, observedTransport()));

  const response = await responseReady.promise;
  await firstStarted.promise;
  response.write('beta');
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  expect(seen).toEqual(['alpha']);

  releaseFirst.resolve();
  await secondStarted.promise;
  response.end('gamma');
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  expect(seen).toEqual(['alpha', 'beta']);

  releaseSecond.resolve();
  await expect(action).resolves.toMatchObject({
    statusCode: 200,
    responseBytes: Buffer.byteLength('alphabetagamma'),
  });
  expect(seen).toEqual(['alpha', 'beta', 'gamma']);
  expect(maxActiveCallbacks).toBe(1);
});

test('treats a consumer terminal record as success and closes only the withheld-EOF exchange', async () => {
  const responseClosed = deferred();
  const terminal = Buffer.from(
    '{"message":{"role":"assistant","content":"complete"},"done":true}\n',
    'utf8',
  );
  const target = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.once('close', () => responseClosed.resolve());
    response.write(terminal);
    // Deliberately withhold HTTP EOF. The protocol terminal record must be
    // sufficient to close this one exchange.
  });
  const observed = observedTransport();
  const caller = new AbortController();
  const seen: string[] = [];

  await expect(streamNativeOllama(nativeRequest({
    path: '/api/chat',
    method: 'POST',
    body: '{"model":"tiny","messages":[],"stream":true}',
    signal: caller.signal,
  }), (chunk) => {
    seen.push(chunk.toString('utf8'));
    return NATIVE_OLLAMA_STREAM_COMPLETE;
  }, testDependencies(target.port, observed))).resolves.toMatchObject({
    statusCode: 200,
    responseBytes: terminal.byteLength,
  });

  await responseClosed.promise;
  expect(seen.join('')).toBe(terminal.toString('utf8'));
  expect(caller.signal.aborted).toBe(false);
  expect(observed.requests).toHaveLength(1);
  expect(observed.sockets).toHaveLength(1);
  expect(observed.sockets[0].destroyed).toBe(true);
});

test('preserves consumer validation failures instead of relabeling them as socket failures', async () => {
  const target = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end('{"status":"unexpected"}\n');
  });
  const validationError = new Error('invalid bounded NDJSON frame');

  await expect(streamNativeOllama(nativeRequest({
    path: '/api/pull',
    method: 'POST',
    body: '{"model":"tiny","stream":true}',
  }), () => {
    throw validationError;
  }, testDependencies(target.port, observedTransport()))).rejects.toBe(validationError);
});

test('rejects redirects without following them or opening a fallback socket', async () => {
  let sourceRequests = 0;
  let targetRequests = 0;
  const target = await listen((_request, response) => {
    targetRequests += 1;
    response.writeHead(200).end('{}');
  });
  const source = await listen((_request, response) => {
    sourceRequests += 1;
    response.writeHead(307, {
      location: `http://127.0.0.1:${target.port}/metadata`,
    });
    response.end();
  });
  const observed = observedTransport();

  await expect(requestNativeOllama(nativeRequest(),
    testDependencies(source.port, observed))).rejects.toMatchObject({
    code: 'HTTP_STATUS',
    statusCode: 307,
  });
  expect(sourceRequests).toBe(1);
  expect(targetRequests).toBe(0);
  expect(observed.requests).toHaveLength(1);
  expect(observed.connects).toHaveLength(1);
});

test('rejects a non-success status immediately without draining its body', async () => {
  const target = await listen((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"error":"unavailable');
  });
  const observed = observedTransport();
  const startedAt = Date.now();

  await expect(requestNativeOllama(nativeRequest(),
    testDependencies(target.port, observed))).rejects.toEqual(
    new NativeOllamaTransportError(
      'HTTP_STATUS',
      'Ollama returned a non-success status',
      503,
    ),
  );
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(observed.sockets).toHaveLength(1);
  expect(observed.sockets[0].destroyed).toBe(true);
});

test('never retries or falls back after a failed non-idempotent request', async () => {
  let requests = 0;
  const target = await listen((_request, response) => {
    requests += 1;
    response.destroy();
  });
  const observed = observedTransport();

  await expect(requestNativeOllama(nativeRequest({
    path: '/api/generate',
    method: 'POST',
    body: '{"model":"tiny","prompt":"one dispatch","stream":true}',
  }), testDependencies(target.port, observed))).rejects.toMatchObject({
    code: 'CONNECTION_FAILED',
  });
  expect(requests).toBe(1);
  expect(observed.requests).toHaveLength(1);
  expect(observed.connects).toHaveLength(1);
});

test('honors cancellation before dispatch and tears down an in-flight socket', async () => {
  const before = new AbortController();
  before.abort();
  let dispatches = 0;
  await expect(requestNativeOllama(nativeRequest({
    signal: before.signal,
  }), {
    request: () => {
      dispatches += 1;
      throw new Error('must not dispatch');
    },
  })).rejects.toMatchObject({ code: 'ABORTED' });
  expect(dispatches).toBe(0);

  const requestArrived = deferred();
  const target = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write('partial');
    requestArrived.resolve();
  });
  const observed = observedTransport();
  const during = new AbortController();
  const action = streamNativeOllama(nativeRequest({
    path: '/api/pull',
    method: 'POST',
    body: '{"model":"tiny","stream":true}',
    signal: during.signal,
  }), async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }, testDependencies(target.port, observed));

  await requestArrived.promise;
  during.abort();
  await expect(action).rejects.toMatchObject({ code: 'ABORTED' });
  expect(observed.sockets).toHaveLength(1);
  expect(observed.sockets[0].destroyed).toBe(true);
});

test('uses one absolute timeout and tears down a dribbling response socket', async () => {
  const intervals = new Set<NodeJS.Timeout>();
  const target = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const interval = setInterval(() => response.write(' '), 20);
    intervals.add(interval);
    response.once('close', () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  const observed = observedTransport();
  const startedAt = Date.now();

  await expect(streamNativeOllama(nativeRequest({
    timeoutMs: 100,
  }), () => undefined, testDependencies(target.port, observed))).rejects.toMatchObject({
    code: 'TIMEOUT',
  });
  expect(Date.now() - startedAt).toBeLessThan(700);
  expect(observed.sockets).toHaveLength(1);
  expect(observed.sockets[0].destroyed).toBe(true);
  for (const interval of intervals) clearInterval(interval);
});

test('buffers a streamed response without exposing wiped chunk storage', async () => {
  const target = await listen((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-transport-test': 'buffered',
    });
    response.write('{"models":');
    setImmediate(() => response.end('[]}'));
  });

  const response = await requestNativeOllama(nativeRequest(),
    testDependencies(target.port, observedTransport()));
  expect(response).toMatchObject({
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'x-transport-test': 'buffered',
    },
  });
  expect(response.body.toString('utf8')).toBe('{"models":[]}');
  expect(Object.isFrozen(response)).toBe(true);
  expect(Object.isFrozen(response.headers)).toBe(true);
});
