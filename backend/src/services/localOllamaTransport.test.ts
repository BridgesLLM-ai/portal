import * as http from 'node:http';
import * as net from 'node:net';
import {
  LOCAL_OLLAMA_TRANSPORT_HOST,
  LOCAL_OLLAMA_TRANSPORT_PORT,
  LocalOllamaTransportError,
  requestLocalOllama,
  requestLocalOllamaJson,
  type LocalOllamaTransportDependencies,
} from './localOllamaTransport';

const openServers = new Set<http.Server>();

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return { server, port: address.port };
}

async function closeServer(server: http.Server): Promise<void> {
  if (!openServers.delete(server)) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function testDependencies(
  actualPort: number,
  observed: Array<http.RequestOptions>,
): LocalOllamaTransportDependencies {
  return {
    request: (options, callback) => {
      observed.push({ ...options });
      return http.request(options, callback);
    },
    connect: () => net.createConnection({
      host: '127.0.0.1',
      port: actualPort,
      family: 4,
    }),
  };
}

afterEach(async () => {
  for (const server of [...openServers]) await closeServer(server);
});

test('uses a literal fixed loopback socket with no proxy, DNS, redirect, retry, or fallback', async () => {
  const requests: http.IncomingMessage[] = [];
  const { server, port } = await listen((request, response) => {
    requests.push(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"version":"test"}');
  });
  const observed: http.RequestOptions[] = [];
  const originalProxy = process.env.HTTP_PROXY;
  const originalNodeProxy = process.env.NODE_USE_ENV_PROXY;
  process.env.HTTP_PROXY = 'http://169.254.169.254:9999';
  process.env.NODE_USE_ENV_PROXY = '1';
  try {
    await expect(requestLocalOllamaJson<{ version: string }>({
      path: '/api/version',
      method: 'GET',
    }, testDependencies(port, observed))).resolves.toEqual({ version: 'test' });
  } finally {
    if (originalProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalProxy;
    if (originalNodeProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = originalNodeProxy;
    await closeServer(server);
  }

  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('/api/version');
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({
    protocol: 'http:',
    hostname: LOCAL_OLLAMA_TRANSPORT_HOST,
    port: LOCAL_OLLAMA_TRANSPORT_PORT,
    family: 4,
    method: 'GET',
    path: '/api/version',
  });
  expect(observed[0].agent).toBeInstanceOf(http.Agent);
  expect(observed[0].agent).not.toBe(http.globalAgent);
  expect(observed[0]).not.toHaveProperty('proxy');
  expect(observed[0]).not.toHaveProperty('proxyEnv');
  expect(observed[0]).not.toHaveProperty('createConnection');
});

test('rejects redirects without following them', async () => {
  let targetRequests = 0;
  const target = await listen((_request, response) => {
    targetRequests += 1;
    response.writeHead(200).end('{}');
  });
  const source = await listen((_request, response) => {
    response.writeHead(307, {
      location: `http://127.0.0.1:${target.port}/metadata`,
    }).end();
  });

  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
  }, testDependencies(source.port, []))).rejects.toMatchObject({
    code: 'HTTP_STATUS',
    statusCode: 307,
  });
  expect(targetRequests).toBe(0);
});

test('never retries a failed POST', async () => {
  let requests = 0;
  const { port } = await listen((_request, response) => {
    requests += 1;
    response.destroy();
  });

  await expect(requestLocalOllamaJson({
    path: '/api/generate',
    method: 'POST',
    json: { model: 'tiny', prompt: 'one dispatch', stream: false },
  }, testDependencies(port, []))).rejects.toMatchObject({
    code: 'CONNECTION_FAILED',
  });
  expect(requests).toBe(1);
});

test('enforces one absolute deadline against a slow response dribble', async () => {
  const intervals = new Set<NodeJS.Timeout>();
  const { port } = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const interval = setInterval(() => response.write(' '), 20);
    intervals.add(interval);
    response.once('close', () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  const startedAt = Date.now();

  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    timeoutMs: 100,
  }, testDependencies(port, []))).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(Date.now() - startedAt).toBeLessThan(700);
  for (const interval of intervals) clearInterval(interval);
});

test('rejects an oversized declared response before buffering it', async () => {
  const { port } = await listen((_request, response) => {
    response.writeHead(200, {
      'content-length': String(64 * 1024 + 1),
    }).end();
  });

  await expect(requestLocalOllama({
    path: '/api/version',
    method: 'GET',
  }, testDependencies(port, []))).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
  });
});

test('rejects unsupported paths, method mismatches, bodies, and coercive timeouts', async () => {
  await expect(requestLocalOllama({
    path: '/api/unknown' as '/api/tags',
    method: 'GET',
  })).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'POST' as 'GET',
  })).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    body: '{}',
  })).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    timeoutMs: '5000' as unknown as number,
  })).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    maxResponseBytes: 0,
  })).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
});

test('clamps caller response budgets to the per-path policy ceiling instead of rejecting', async () => {
  // Callers state their own memory budget; the path policy stays the hard
  // ceiling. A budget above the cap must not fail the request — that exact
  // rejection once turned a healthy Ollama into "offline" status and wedged
  // Project Ollama preparation behind an opaque backend-unavailable error.
  const oversized = await listen((_request, response) => {
    // Declared larger than the 8 MiB /api/tags policy cap but smaller than
    // the caller's 9 MiB budget: only the clamped policy cap can refuse it.
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(8 * 1024 * 1024 + 1),
    });
    response.flushHeaders();
  });
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    maxResponseBytes: 9 * 1024 * 1024,
  }, testDependencies(oversized.port, []))).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  await closeServer(oversized.server);

  const healthy = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"models":[]}');
  });
  await expect(requestLocalOllamaJson<{ models: unknown[] }>({
    path: '/api/tags',
    method: 'GET',
    maxResponseBytes: 9 * 1024 * 1024,
  }, testDependencies(healthy.port, []))).resolves.toEqual({ models: [] });
});

test('permits the two-hour pull deadline without widening ordinary requests', async () => {
  const aborted = new AbortController();
  aborted.abort();

  await expect(requestLocalOllama({
    path: '/api/pull',
    method: 'POST',
    body: '{"model":"tiny","stream":false}',
    timeoutMs: 2 * 60 * 60_000,
    signal: aborted.signal,
  })).rejects.toMatchObject({ code: 'ABORTED' });

  await expect(requestLocalOllama({
    path: '/api/version',
    method: 'GET',
    timeoutMs: 2 * 60 * 60_000,
    signal: aborted.signal,
  })).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
});

test('honors cancellation before and during a request', async () => {
  const before = new AbortController();
  before.abort();
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    signal: before.signal,
  })).rejects.toMatchObject({ code: 'ABORTED' });

  const { port } = await listen((_request, response) => {
    setTimeout(() => response.end('{}'), 1_000).unref?.();
  });
  const during = new AbortController();
  const action = requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    signal: during.signal,
  }, testDependencies(port, []));
  setTimeout(() => during.abort(), 20).unref?.();
  await expect(action).rejects.toMatchObject({ code: 'ABORTED' });
});

test('redacts network failures and rejects invalid JSON', async () => {
  await expect(requestLocalOllama({
    path: '/api/tags',
    method: 'GET',
    timeoutMs: 100,
  }, {
    request: () => {
      throw new Error('secret upstream diagnostic');
    },
  })).rejects.toEqual(
    new LocalOllamaTransportError(
      'CONNECTION_FAILED',
      'Local Ollama connection failed',
    ),
  );

  const { port } = await listen((_request, response) => {
    response.writeHead(200).end('not-json');
  });
  await expect(requestLocalOllamaJson({
    path: '/api/tags',
    method: 'GET',
  }, testDependencies(port, []))).rejects.toMatchObject({
    code: 'RESPONSE_INVALID',
  });
});
