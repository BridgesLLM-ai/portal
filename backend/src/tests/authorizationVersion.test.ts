import { EventEmitter } from 'events';

const userFindUnique = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}));

jest.mock('../config/env', () => ({
  config: {
    jwtSecret: 'authorization-version-test-access-secret',
    jwtRefreshSecret: 'authorization-version-test-refresh-secret',
    jwtExpiration: '15m',
    jwtRefreshExpiration: '7d',
  },
}));

jest.mock('../utils/auth-tracking', () => ({
  blockedIPs: new Set<string>(),
  extractIP: jest.fn(() => '127.0.0.1'),
}));

import { authenticateToken, AUTHORIZATION_VERSION_HEADER } from '../middleware/auth';
import { withWorkspaceAuthorizationFence } from '../services/workspaceAuthorizationBarrier';
import { generateAccessToken } from '../utils/jwt';

function response(): any {
  const events = new EventEmitter();
  const headers = new Map<string, string>();
  const res: any = {
    destroyed: false,
    writableEnded: false,
    statusCode: 200,
    body: undefined,
    headers,
    once: events.once.bind(events),
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), String(value));
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.writableEnded = true;
      events.emit('finish');
      return res;
    },
    destroy() {
      res.destroyed = true;
      events.emit('close');
    },
  };
  return res;
}

function request(token: string, versionHeader?: string, path = '/api/auth/me'): any {
  const headers: Record<string, string> = {};
  if (versionHeader) headers[AUTHORIZATION_VERSION_HEADER.toLowerCase()] = versionHeader;
  return {
    method: 'GET',
    path,
    originalUrl: path,
    cookies: { accessToken: token },
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function dbUser(version: number) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    role: 'SUB_ADMIN',
    accountStatus: 'ACTIVE',
    isActive: true,
    sandboxEnabled: false,
    authorizationVersion: version,
  };
}

describe('durable authorization version', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('accepts a pre-migration token only while the user remains on generation one', async () => {
    userFindUnique.mockResolvedValue(dbUser(1));
    const token = generateAccessToken({
      userId: 'user-1',
      email: 'user@example.com',
      role: 'SUB_ADMIN',
    });
    const req = request(token);
    const res = response();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ authorizationVersion: 1 });
    expect(res.headers.get(AUTHORIZATION_VERSION_HEADER.toLowerCase())).toBe('1');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('checks a session-bound access token inside the existing user lookup', async () => {
    userFindUnique.mockResolvedValue({
      ...dbUser(1),
      sessions: [{ id: 'session-1', expiresAt: new Date(Date.now() + 60_000) }],
    });
    const token = generateAccessToken({
      userId: 'user-1',
      sessionId: 'session-1',
      email: 'user@example.com',
      role: 'SUB_ADMIN',
      authorizationVersion: 1,
    });
    const req = request(token);
    const res = response();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ sessionId: 'session-1' });
    expect(userFindUnique).toHaveBeenCalledTimes(1);
    expect(userFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        sessions: expect.objectContaining({
          where: expect.objectContaining({ id: 'session-1' }),
          take: 1,
        }),
      }),
    }));
  });

  test('rejects the same old access token after an authorization generation change', async () => {
    userFindUnique.mockResolvedValue(dbUser(2));
    const token = generateAccessToken({
      userId: 'user-1',
      email: 'user@example.com',
      role: 'SUB_ADMIN',
      authorizationVersion: 1,
    });
    const res = response();
    const next = jest.fn();

    await authenticateToken(request(token), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'Account is no longer authorized' });
  });

  test('rejects a stale browser generation header before the route handler', async () => {
    userFindUnique.mockResolvedValue(dbUser(3));
    const token = generateAccessToken({
      userId: 'user-1',
      email: 'user@example.com',
      role: 'SUB_ADMIN',
      authorizationVersion: 3,
    });
    const res = response();
    const next = jest.fn();

    await authenticateToken(request(token, '2'), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      code: 'WORKSPACE_SCOPE_CHANGED',
      authorizationVersion: 3,
    });
    expect(res.headers.get(AUTHORIZATION_VERSION_HEADER.toLowerCase())).toBe('3');
  });

  test('admits a workspace read before the database lookup so a racing fence aborts it', async () => {
    let resolveUser!: (value: ReturnType<typeof dbUser>) => void;
    userFindUnique.mockReturnValue(new Promise((resolve) => {
      resolveUser = resolve;
    }));
    const token = generateAccessToken({
      userId: 'user-1',
      email: 'user@example.com',
      role: 'SUB_ADMIN',
      authorizationVersion: 1,
    });
    const res = response();
    const next = jest.fn();

    const authentication = authenticateToken(
      request(token, undefined, '/api/files/search'),
      res,
      next,
    );
    await Promise.resolve();
    await expect(withWorkspaceAuthorizationFence('user-1', async () => 'committed'))
      .resolves.toBe('committed');
    resolveUser(dbUser(1));
    await authentication;

    expect(res.destroyed).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  test('settles a disconnected mutation when the authorization lookup returns', async () => {
    let resolveUser!: (value: ReturnType<typeof dbUser>) => void;
    userFindUnique.mockReturnValue(new Promise((resolve) => {
      resolveUser = resolve;
    }));
    const token = generateAccessToken({
      userId: 'user-1',
      email: 'user@example.com',
      role: 'SUB_ADMIN',
      authorizationVersion: 1,
    });
    const req = request(token, undefined, '/api/projects/example/chat/send');
    req.method = 'POST';
    const res = response();
    const next = jest.fn();

    const authentication = authenticateToken(req, res, next);
    await Promise.resolve();
    res.destroy();
    const commit = jest.fn(async () => 'committed');
    const fenced = withWorkspaceAuthorizationFence('user-1', commit);
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();

    resolveUser(dbUser(1));
    await authentication;
    await expect(fenced).resolves.toBe('committed');
    expect(next).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
