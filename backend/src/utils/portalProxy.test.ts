import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import express from 'express';
import { createProxyMiddleware } from './portalProxy';
import { stripHostedPortalCookies } from './hostedProxyHeaders';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}
function request(url: string, options: http.RequestOptions = {}, body = '') {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('Portal fixed-target proxy wire contracts', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  });
  async function start(handler?: http.RequestListener) {
    const server = http.createServer(handler); servers.push(server);
    return { server, url: await listen(server) };
  }

  test.each(['GET', 'HEAD', 'POST'])('preserves %s, mounted path, Host, body and response hooks', async (method) => {
    let observed: any;
    const upstream = await start((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        observed = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        res.setHeader('X-Upstream', 'yes'); res.end('reply');
      });
    });
    const app = express();
    const proxy = createProxyMiddleware({ target: upstream.url, changeOrigin: true, on: {
      proxyReq: (outgoing) => outgoing.removeHeader('cookie'),
      proxyRes: (_incoming, resReq, res) => { res.setHeader('X-Method', resReq.method!); },
    } });
    app.use('/hosted/app', proxy);
    const portal = await start(app);
    const body = method === 'POST' ? '--boundary\r\nraw multipart\r\n--boundary--' : '';
    const result = await request(`${portal.url}/hosted/app/path?q=1`, {
      method, headers: { cookie: 'accessToken=fixture', 'content-type': 'multipart/form-data; boundary=boundary', 'content-length': Buffer.byteLength(body) },
    }, body);
    expect(result.status).toBe(200);
    expect(result.body).toBe(method === 'HEAD' ? '' : 'reply');
    expect(result.headers['x-method']).toBe(method);
    expect(observed).toMatchObject({ method, url: '/path?q=1', body });
    expect(observed.headers.host).toBe(new URL(upstream.url).host);
    expect(observed.headers.cookie).toBeUndefined();
  });

  test('handles Expect: 100-continue without depending on proxyReq events', async () => {
    let cookie: string | undefined;
    const upstream = await start((req, res) => {
      cookie = req.headers.cookie;
      req.resume(); req.on('end', () => res.end(req.url));
    });
    const proxy = createProxyMiddleware({ target: upstream.url, pathRewrite: { '^/bridge': '/' } });
    const portal = await start((req, res) => {
      stripHostedPortalCookies(req.headers, 'hosted_fixture');
      proxy(req as any, res as any, () => res.end('next'));
    });
    const result = await request(`${portal.url}/bridge?x=1`, { method: 'POST', headers: { expect: '100-continue', 'content-length': '4', cookie: 'app_session=keep; accessToken=secret; refreshToken=secret; hosted_fixture=secret; share_password_token=secret; share_visit_token=secret' } }, 'data');
    expect(result).toMatchObject({ status: 200, body: '/?x=1' });
    expect(cookie).toBe('app_session=keep');
  });

  test('returns bounded HTTP failure and calls the settlement hook for an unavailable upstream', async () => {
    const gone = await start(); await new Promise<void>((resolve) => gone.server.close(() => resolve()));
    const error = jest.fn();
    const proxy = createProxyMiddleware({ target: gone.url, on: { error } });
    const portal = await start((req, res) => proxy(req as any, res as any, () => res.end('next')));
    expect(await request(portal.url)).toMatchObject({ status: 502, body: 'Upstream unavailable' });
    expect(error).toHaveBeenCalledTimes(1);
  });


  test('ends a stalled upstream through proxy timeout and the error settlement hook', async () => {
    const upstream = await start((_req, _res) => {});
    const error = jest.fn();
    const proxy = createProxyMiddleware({ target: upstream.url, proxyTimeout: 50, on: { error } });
    const portal = await start((req, res) => proxy(req as any, res as any, () => res.end('next')));
    expect(await request(portal.url)).toMatchObject({ status: 502 });
    expect(error).toHaveBeenCalledTimes(1);
  });

  test.each(['', 'accessToken=secret; hosted_fixture=secret; share_visit_x=secret'])('omits an empty or Portal-only cookie header (%s)', (cookie) => {
    const headers = { cookie };
    stripHostedPortalCookies(headers, 'hosted_fixture');
    expect(headers).not.toHaveProperty('cookie');
  });

  test('cancels an upstream streaming response when the client leaves', async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => { closed = resolve; });
    const upstream = await start((_req, res) => { res.write('first'); res.on('close', closed); });
    const proxy = createProxyMiddleware({ target: upstream.url });
    const portal = await start((req, res) => proxy(req as any, res as any, () => res.end('next')));
    await new Promise<void>((resolve, reject) => {
      const req = http.get(portal.url, (res) => res.once('data', () => { res.destroy(); resolve(); })); req.on('error', reject);
    });
    await upstreamClosed;
  });

  test('rewrites explicit WS upgrades and never auto-subscribes to upgrades', async () => {
    let path = '';
    const upstream = await start((_req, res) => res.end('ready'));
    upstream.server.on('upgrade', (req, socket) => {
      path = req.url!;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.on('data', (chunk) => socket.write(chunk));
      socket.on('end', () => socket.end());
    });
    const proxy = createProxyMiddleware({ target: upstream.url, ws: true, pathRewrite: { '^/novnc/audio': '/' } });
    const portal = await start((req, res) => proxy(req as any, res as any, () => res.end()));
    await request(portal.url);
    expect(portal.server.listenerCount('upgrade')).toBe(0);
    portal.server.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket as net.Socket, head));
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${portal.url}/novnc/audio?token=fixture`, { headers: { connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('error', reject);
      req.on('upgrade', (_res, socket) => {
        socket.write('wire-echo'); socket.once('data', (data) => {
          try { expect(data.toString()).toBe('wire-echo'); socket.end(); resolve(); } catch (error) { socket.destroy(); reject(error); }
        });
      }); req.end();
    });
    expect(path).toBe('/?token=fixture');
  });
});
