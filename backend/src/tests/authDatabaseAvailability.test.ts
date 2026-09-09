import http from 'http';
import { EventEmitter } from 'events';
import express from 'express';
import cookieParser from 'cookie-parser';

const userFindUnique = jest.fn();
jest.mock('../config/database', () => ({ prisma: { user: { findUnique: userFindUnique } } }));
jest.mock('../config/env', () => ({ config: {
  jwtSecret: 'isolated-database-availability-access-fixture',
  jwtRefreshSecret: 'isolated-database-availability-refresh-fixture',
  jwtExpiration: '15m', jwtRefreshExpiration: '7d',
} }));
jest.mock('../utils/auth-tracking', () => ({
  blockedIPs: new Set<string>(), extractIP: jest.fn(() => '127.0.0.1'),
}));

import { authenticateToken, browserAuthRedirect, browserAssetAuth } from '../middleware/auth';
import { generateAccessToken } from '../utils/jwt';
import { withWorkspaceAuthorizationFence } from '../services/workspaceAuthorizationBarrier';

const middleware = { authenticateToken, browserAuthRedirect, browserAssetAuth };
const identity = { userId: 'db-availability-owner', email: 'fixture@example.test',
  role: 'OWNER' as const, authorizationVersion: 1, sessionId: 'fixture-session' };
const token = () => generateAccessToken(identity);
function user() { return { id: identity.userId, email: identity.email, role: identity.role,
  accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: false, authorizationVersion: 1,
  sessions: [{ id: identity.sessionId, expiresAt: new Date(Date.now() + 60000) }] }; }
function request(bearer = false): any {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (bearer) headers.authorization = 'Bearer ' + token();
  return { method: 'GET', path: '/private', originalUrl: '/private',
    headers, cookies: bearer ? {} : { accessToken: token() }, get: (name: string) => headers[name.toLowerCase()] };
}
function response(): any {
  const e = new EventEmitter();
  const r: any = { statusCode: 200, body: undefined, writableEnded: false, destroyed: false,
    headers: new Map<string, string>(), once: e.once.bind(e), clearCookie: jest.fn(),
    setHeader(k: string, v: string) { r.headers.set(k.toLowerCase(), String(v)); return r; },
    status(n: number) { r.statusCode = n; return r; },
    json(v: unknown) { r.body = v; r.writableEnded = true; e.emit('finish'); return r; },
    send(v: unknown) { return r.json(v); },
    redirect: jest.fn(),
  }; return r;
}

describe('database-unavailable authorization boundary', () => {
  beforeEach(() => jest.clearAllMocks());
  for (const [name, fn] of Object.entries(middleware)) {
    for (const bearer of [false, true]) {
      test(name + ' contains a failed lookup for ' + (bearer ? 'bearer' : 'cookie') + ' requests', async () => {
        const dbError = new Error('timeout exceeded when trying to connect');
        userFindUnique.mockRejectedValueOnce(dbError);
        const req = request(bearer), res = response(), next = jest.fn();
        req.method = "POST"; req.path = req.originalUrl = "/api/projects/fixture/chat/send";
        await expect(fn(req, res, next)).resolves.toBeUndefined();
        expect(next).not.toHaveBeenCalled();
        expect(req.user).toBeUndefined();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ error: 'Authorization is temporarily unavailable. Retry shortly.',
          code: 'AUTHORIZATION_UNAVAILABLE', retryable: true });
        expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        expect(res.headers.get('retry-after')).toBe('1');
        expect(res.clearCookie).not.toHaveBeenCalled();
        expect(res.redirect).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toContain(dbError.message);
        // An ended denied request must not keep the actor's authorization fence held.
        await expect(withWorkspaceAuthorizationFence(identity.userId, async () => 'released')).resolves.toBe('released');
      });
    }
    test(name + ' rechecks durable authority on retry without cached authorization', async () => {
      userFindUnique.mockRejectedValueOnce(new Error('database offline')).mockResolvedValueOnce(user());
      const req = request(), first = response(), firstNext = jest.fn();
      await fn(req, first, firstNext);
      expect(first.statusCode).toBe(503);
      const retry = request(), next = jest.fn();
      await fn(retry, response(), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(retry.user.userId).toBe(identity.userId);
      expect(userFindUnique).toHaveBeenCalledTimes(2);
    });
    test(name + ' keeps a subsequently revoked session denied', async () => {
      userFindUnique.mockRejectedValueOnce(new Error('database offline')).mockResolvedValueOnce({ ...user(), sessions: [] });
      await fn(request(), response(), jest.fn());
      const res = response(), next = jest.fn();
      await fn(request(), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalled();
      if (name === 'browserAuthRedirect') expect(res.redirect).toHaveBeenCalled();
      else expect(res.statusCode).toBe(401);
    });
  }

  test('Express4 remains serving after repeated database failures and accepts the same cookie after recovery', async () => {
    userFindUnique.mockRejectedValueOnce(new Error('connect timeout')).mockRejectedValueOnce(new Error('connect timeout')).mockResolvedValue(user());
    const app = express(); app.use(cookieParser());
    app.get('/private', authenticateToken, (req, res) => res.json({ owner: req.user?.userId }));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const origin = 'http://127.0.0.1:' + port;
      const cookie = 'accessToken=' + token();
      for (let i=0;i<2;i++) {
        const r = await fetch(origin+'/private', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) });
        expect(r.status).toBe(503);
        expect(r.headers.get('set-cookie')).toBeNull();
        expect(((await r.json()) as any).code).toBe('AUTHORIZATION_UNAVAILABLE');
        expect((await fetch(origin+'/health')).status).toBe(200);
      }
      const r = await fetch(origin+'/private', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) });
      expect(r.status).toBe(200);expect(await r.json()).toEqual({ owner: identity.userId });
    } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
