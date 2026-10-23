/**
 * Owner-only App credential API over real HTTP routing (store mocked; storage
 * semantics are in services/appCredentials/store*.test.ts). Values are dummies.
 */
import http from 'http';
import express, { type NextFunction, type Request, type Response } from 'express';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    const role = req.header('x-role');
    if (!role) { res.status(401).json({ error: 'Authentication required' }); return; }
    req.user = { userId: req.header('x-user') || 'owner-1', role, accountStatus: req.header('x-status') || 'ACTIVE' } as any;
    next();
  },
}));
jest.mock('../config/database', () => ({
  prisma: { user: { findMany: jest.fn(async () => [{ id: 'owner-1', username: 'site-owner' }]) } },
}));
jest.mock('../services/appCredentials/store', () => ({
  listAppCredentials: jest.fn(),
  setAppCredential: jest.fn(),
  removeAppCredential: jest.fn(),
}));
jest.mock('../services/app-process.service', () => ({ runningAppCredentialState: jest.fn() }));

import router, { appCredentialBodyLimit } from '../routes/project-app-credentials';
import { errorHandler } from '../middleware/errorHandler';
import { AppCredentialError } from '../services/appCredentials/policy';
import { listAppCredentials, removeAppCredential, setAppCredential } from '../services/appCredentials/store';
import { runningAppCredentialState } from '../services/app-process.service';

const APP = '11111111-2222-4333-8444-555555555555';
const SECRET = 'DUMMY-NOT-A-REAL-SECRET';
const listing = {
  app: { id: APP, name: 'demo-app', userId: 'owner-1', projectIdentityId: 'project-1' },
  revision: 5,
  slots: [
    { slot: 'api-token', revision: 5, updatedAt: new Date('2026-10-06T05:00:00Z'), updatedByUserId: null, updatedByOperator: true },
    { slot: 'legacy-key', revision: 2, updatedAt: new Date('2026-10-06T04:00:00Z'), updatedByUserId: 'owner-1', updatedByOperator: false },
  ],
};

describe('App credential API', () => {
  let server: http.Server;
  let port: number;
  const consoleOutput: string[] = [];
  const spies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    const app = express();
    app.use('/api/app-credentials', appCredentialBodyLimit);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/app-credentials', router);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    port = (server.address() as any).port;
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      spies.push(jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
      }));
    }
  });
  afterAll(async () => {
    spies.forEach((spy) => spy.mockRestore());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(consoleOutput.join('\n')).not.toContain(SECRET);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (listAppCredentials as jest.Mock).mockResolvedValue(listing);
    (runningAppCredentialState as jest.Mock).mockReturnValue({ running: false, revision: 0, slots: [] });
  });

  function call(method: string, path: string, options: { role?: string; status?: string; body?: string | Buffer; type?: string; user?: string } = {}) {
    return new Promise<{ status: number; body: string; json: any; cache?: string }>((resolve, reject) => {
      const body = options.body === undefined ? undefined : Buffer.from(options.body);
      const req = http.request({ hostname: '127.0.0.1', port, method, path: `/api/app-credentials${path}`, headers: {
        ...(options.role === '' ? {} : { 'x-role': options.role || 'OWNER' }),
        ...(options.status ? { 'x-status': options.status } : {}),
        ...(options.user ? { 'x-user': options.user } : {}),
        ...(body ? { 'content-type': options.type || 'application/json', 'content-length': String(body.length) } : {}),
      } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode!, body: text, json, cache: res.headers['cache-control'] });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  test('only an active Portal Owner reaches the store; every answer is private and uncached', async () => {
    for (const role of ['USER', 'SUB_ADMIN', 'UNSUPPORTED_ADMIN', 'VIEWER']) {
      const refused = await call('PUT', `/${APP}/api-token`, { role, body: JSON.stringify({ value: SECRET, expectedRevision: null }) });
      expect(refused.status).toBe(403);
      expect(refused.cache).toBe('private, no-store');
      expect((await call('GET', `/${APP}`, { role })).status).toBe(403);
    }
    expect((await call('GET', `/${APP}`, { role: '' })).status).toBe(401);
    expect((await call('GET', `/${APP}`, { status: 'DISABLED' })).status).toBe(403);
    expect(listAppCredentials).not.toHaveBeenCalled();
    expect(setAppCredential).not.toHaveBeenCalled();
    const ok = await call('GET', `/${APP}`);
    expect(ok.status).toBe(200);
    expect(ok.cache).toBe('private, no-store');
  });

  test('lists names and metadata, and says when the running App predates a change', async () => {
    const first = await call('GET', `/${APP}`);
    expect(first.json).toEqual({
      app: { id: APP, name: 'demo-app' },
      revision: 5,
      slots: [
        { slot: 'api-token', revision: 5, updatedAt: '2026-10-06T05:00:00.000Z', updatedBy: { kind: 'operator' } },
        { slot: 'legacy-key', revision: 2, updatedAt: '2026-10-06T04:00:00.000Z', updatedBy: { kind: 'user', username: 'site-owner' } },
      ],
      limits: { maxSlots: 16, maxBytes: 65536 },
      containerDirectory: '/portal/credentials',
      runtime: { running: false, restartRequired: false },
    });
    (runningAppCredentialState as jest.Mock).mockReturnValue({ running: true, revision: 5, slots: ['api-token', 'legacy-key'] });
    expect((await call('GET', `/${APP}`)).json.runtime).toEqual({ running: true, restartRequired: false });
    (runningAppCredentialState as jest.Mock).mockReturnValue({ running: true, revision: 4, slots: ['api-token', 'legacy-key'] });
    expect((await call('GET', `/${APP}`)).json.runtime.restartRequired).toBe(true);
    (runningAppCredentialState as jest.Mock).mockReturnValue({ running: true, revision: 5, slots: ['api-token', 'legacy-key', 'removed'] });
    expect((await call('GET', `/${APP}`)).json.runtime.restartRequired).toBe(true);
    (runningAppCredentialState as jest.Mock).mockReturnValue({ running: true, revision: 0, slots: [] });
    expect((await call('GET', `/${APP}`)).json.runtime.restartRequired).toBe(true);
    expect((await call('GET', `/${APP}?x=1`)).status).toBe(400);
  });

  test('add/replace takes exactly { value, expectedRevision } and never echoes the value', async () => {
    (setAppCredential as jest.Mock).mockResolvedValue({ appId: APP, slot: 'api-token', revision: 6, storedAt: 'x', replaced: true, bytes: 23 });
    const stored = await call('PUT', `/${APP}/api-token`, { body: JSON.stringify({ value: SECRET, expectedRevision: 5 }) });
    expect(stored.status).toBe(200);
    expect(stored.json.stored).toEqual({ slot: 'api-token', revision: 6, replaced: true });
    expect(stored.body).not.toContain(SECRET);
    expect(stored.body).not.toContain('"bytes"');
    expect(setAppCredential).toHaveBeenCalledWith({ appId: APP, slot: 'api-token', value: SECRET, expectedRevision: 5,
      actor: { kind: 'user', userId: 'owner-1' } });
    for (const body of [{ value: SECRET }, { value: SECRET, expectedRevision: 5, extra: 1 }, { value: SECRET, expectedRevision: '5' }, [SECRET]]) {
      const refused = await call('PUT', `/${APP}/api-token`, { body: JSON.stringify(body) });
      expect(refused.status).toBe(400);
      expect(refused.body).not.toContain(SECRET);
    }
    expect(setAppCredential).toHaveBeenCalledTimes(1);
  });

  test('removal needs the exact expected revision', async () => {
    (removeAppCredential as jest.Mock).mockResolvedValue({ appId: APP, slot: 'legacy-key', revision: 6 });
    expect((await call('DELETE', `/${APP}/legacy-key`)).status).toBe(400);
    expect((await call('DELETE', `/${APP}/legacy-key?expectedRevision=2&force=1`)).status).toBe(400);
    expect((await call('DELETE', `/${APP}/legacy-key?expectedRevision=0`)).status).toBe(400);
    const removed = await call('DELETE', `/${APP}/legacy-key?expectedRevision=2`);
    expect(removed.status).toBe(200);
    expect(removed.json.removed).toEqual({ slot: 'legacy-key' });
    expect(removeAppCredential).toHaveBeenCalledWith({ appId: APP, slot: 'legacy-key', expectedRevision: 2, actor: { kind: 'user', userId: 'owner-1' } });
  });

  test('bodies are bounded and parser failures never reach the global handler or logs', async () => {
    const huge = JSON.stringify({ value: SECRET.repeat(20000), expectedRevision: null });
    const tooLarge = await call('PUT', `/${APP}/api-token`, { body: huge });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.json).toEqual({ code: 'APP_CREDENTIAL_TOO_LARGE', error: 'A credential value is at most 65536 bytes.' });
    const malformed = await call('PUT', `/${APP}/api-token`, { body: `{"value":"${SECRET}", oops}` });
    expect(malformed.status).toBe(400);
    expect(malformed.json).toEqual({ code: 'APP_CREDENTIAL_INVALID', error: 'The request body is not valid JSON.' });
    expect(malformed.body).not.toContain(SECRET);
    const form = await call('PUT', `/${APP}/api-token`, { body: `value=${SECRET}`, type: 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    expect(setAppCredential).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).not.toContain(SECRET);
    expect(consoleOutput.join('\n')).not.toContain('Unhandled error');
  });

  test('store refusals keep their status; unexpected failures are generic and logged by type only', async () => {
    (setAppCredential as jest.Mock).mockRejectedValueOnce(new AppCredentialError('APP_CREDENTIAL_LIMIT', 'An App can hold at most 16 credentials. Remove one first.', 409));
    const limited = await call('PUT', `/${APP}/another`, { body: JSON.stringify({ value: SECRET, expectedRevision: null }) });
    expect(limited.status).toBe(409);
    expect(limited.json.code).toBe('APP_CREDENTIAL_LIMIT');
    const leaky = Object.assign(new Error(`Invalid value ${SECRET} for column ciphertext`), { name: 'PrismaClientKnownRequestError' });
    (setAppCredential as jest.Mock).mockRejectedValueOnce(leaky);
    const failed = await call('PUT', `/${APP}/another`, { body: JSON.stringify({ value: SECRET, expectedRevision: null }) });
    expect(failed.status).toBe(500);
    expect(failed.json.code).toBe('APP_CREDENTIAL_FAILED');
    expect(failed.body).not.toContain(SECRET);
    expect(consoleOutput.some((line) => line.includes('[app-credentials] operation failed: PrismaClientKnownRequestError'))).toBe(true);
  });

  test('changes are rate limited per Owner', async () => {
    (removeAppCredential as jest.Mock).mockResolvedValue({ appId: APP, slot: 'legacy-key', revision: 6 });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push((await call('DELETE', `/${APP}/legacy-key?expectedRevision=2`, { user: 'owner-rate' })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
