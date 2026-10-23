import express from 'express';
import type { Server } from 'http';
import { z } from 'zod';
import { AppError, errorHandler } from '../middleware/errorHandler';
import { mountGlobalApiRateLimit } from '../middleware/rateLimitPolicy';
import { createPortalSecurityHeaders } from '../services/embedSecurityPolicy';

jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../utils/errorLogger', () => ({ logRequestError: jest.fn(async () => undefined) }));

let server: Server;
let base: string;
const originalOrigin = process.env.CORS_ORIGIN;
async function start(app: express.Express) {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP fixture');
  base = `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  if (originalOrigin === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = originalOrigin;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('async validation failures keep useful 400 details and operational role failures keep 403', async () => {
  const app = express();
  app.use(express.json());
  app.post('/validate', async req => { await Promise.resolve(); z.object({ name: z.string().min(1) }).parse(req.body); });
  app.get('/role', async () => { throw new AppError(403, 'Owner access required'); });
  app.use(errorHandler);
  await start(app);
  const invalid = await fetch(base + '/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: 'Validation error', details: [{ path: ['name'], code: 'invalid_type' }] });
  const denied = await fetch(base + '/role');
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: 'Owner access required', statusCode: 403 });
});

test('malformed JSON, URI parameters and oversized bodies stay sanitized client failures', async () => {
  const app = express(); app.use(express.json({ limit: 16 }));
  app.post('/body', (_req, res) => res.json({ ok: true }));
  app.get('/item/:id', (_req, res) => res.end());
  app.use(errorHandler); await start(app);
  const request = (body: string) => fetch(base + '/body', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const invalid = await request('{secret');
  expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: 'Invalid request' });
  const oversized = await request(JSON.stringify({ secret: 'x'.repeat(30) }));
  expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: 'Request body is too large' });
  const uri = await fetch(base + '/item/%E0%A4%A');
  expect(uri.status).toBe(400); expect(await uri.json()).toEqual({ error: 'Invalid request' });
});

test('named wildcard arrays and scalar parameters decode once; extended duplicate/nested query values are preserved', async () => {
  const app = express(); app.set('query parser', 'extended');
  app.get('/:owner/api/{*parts}', (req, res) => res.json({ owner: req.params.owner, parts: req.params.parts ?? [], query: req.query }));
  await start(app);
  const result = await fetch(base + '/a%2Fb/api/one%2Ftwo/%252e%252e?filter[role]=USER&tag=a&tag=b');
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ owner: 'a/b', parts: ['one/two', '%2e%2e'], query: { filter: { role: 'USER' }, tag: ['a', 'b'] } });
  expect(await (await fetch(base + '/owner/api/')).json()).toEqual({ owner: 'owner', parts: [], query: {} });
});

test.each([false, true])('actual Portal Helmet headers preserve framing/COOP policy (HTTPS=%s)', async secure => {
  process.env.CORS_ORIGIN = secure ? 'https://portal.example.com' : 'http://portal.example.com';
  const app = express(); app.use(createPortalSecurityHeaders()); app.get('/', (_req, res) => res.send('ok')); await start(app);
  const response = await fetch(base);
  expect(response.headers.get('content-security-policy')).toContain("frame-src 'self' blob: data:");
  expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
  expect(response.headers.get('content-security-policy')?.includes('upgrade-insecure-requests')).toBe(secure);
  expect(response.headers.get('cross-origin-opener-policy')).toBe(secure ? 'same-origin' : null);
  expect(response.headers.get('origin-agent-cluster')).toBe(secure ? '?1' : null);
  expect(response.headers.get('cross-origin-embedder-policy')).toBeNull();
  expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  expect(response.headers.get('x-powered-by')).toBeNull();
});

test('real limiter aggregates IPv6 /56 addresses and retains standard headers without legacy headers', async () => {
  const app = express(); app.set('trust proxy', 'loopback');
  mountGlobalApiRateLimit(app, { max: 1 }); app.get('/api/ping', (_req, res) => res.json({ ok: true })); await start(app);
  const first = await fetch(base + '/api/ping', { headers: { 'x-forwarded-for': '2001:db8:abcd:1200::1' } });
  const second = await fetch(base + '/api/ping', { headers: { 'x-forwarded-for': '2001:db8:abcd:12ff::2' } });
  expect(first.status).toBe(200); expect(second.status).toBe(429);
  expect(second.headers.get('ratelimit-limit')).toBe('1');
  expect(second.headers.get('ratelimit-remaining')).toBe('0');
  expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(second.headers.get('x-ratelimit-limit')).toBeNull();
});
