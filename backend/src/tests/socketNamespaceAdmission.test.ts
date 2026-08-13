import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';

// `config/env` validates required variables at import time, so the environment
// has to exist before either module under test is pulled in. Static imports
// hoist above this, which is why both are required lazily below.
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/portal_test';
process.env.JWT_SECRET ||= 'socket-admission-test-secret';
process.env.JWT_REFRESH_SECRET ||= 'socket-admission-test-refresh-secret';

/* eslint-disable @typescript-eslint/no-var-requires */
const { config } = require('../config/env');
const {
  createSocketAccessAuthorizationMiddleware,
} = require('../services/portalTransportAuthorization');
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Admission tests that actually open a socket.
 *
 * The sibling `socketNamespaceAuthorization.test.ts` asserts on source text, so
 * it passes whether or not a real client can ever connect. 4.0.17 shipped a
 * guard that read `socket.disconnected` inside namespace middleware — where
 * Socket.IO has not yet set `connected` — which rejected every connection to
 * every namespace with "Authorization changed during connection". The portal
 * curtain never lifted. Nothing in the grep suite moved.
 *
 * These cases fail against that build and pass against the fix.
 */

const USER_ID = '00000000-0000-4000-8000-00000000beef';
const SESSION_ID = '00000000-0000-4000-8000-00000000cafe';

const activeUser = {
  id: USER_ID,
  email: 'owner@example.test',
  role: 'OWNER',
  accountStatus: 'ACTIVE',
  isActive: true,
  sandboxEnabled: false,
  authorizationVersion: 1,
};

function fakeDatabase(sessionExpiresAt: Date | null) {
  return {
    user: {
      findUnique: async (args: any) => {
        if (args?.where?.id !== USER_ID) return null;
        const wantsSessions = !!args?.select?.sessions;
        return {
          ...activeUser,
          ...(wantsSessions
            ? {
              sessions: sessionExpiresAt
                ? [{ id: SESSION_ID, expiresAt: sessionExpiresAt }]
                : [],
            }
            : {}),
        };
      },
    },
  } as any;
}

/** No-op subscriptions: this suite is about admission, not revocation fan-out. */
const inertSubscriptions = {
  subscribeAuthorization: () => () => {},
  subscribeSession: () => () => {},
  subscribeGlobalFence: () => () => {},
};

function mint(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      userId: USER_ID,
      email: activeUser.email,
      role: 'OWNER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 1,
      ...overrides,
    },
    config.jwtSecret,
    { expiresIn: '5m' },
  );
}

describe('Socket.IO namespace admission (real transport)', () => {
  let httpServer: HttpServer;
  let ioServer: SocketIOServer;
  let port: number;
  let clients: ClientSocket[] = [];

  const startServer = (sessionExpiresAt: Date | null) => new Promise<void>((resolve) => {
    httpServer = createServer();
    ioServer = new SocketIOServer(httpServer);
    const namespace = ioServer.of('/authorization');
    namespace.use(createSocketAccessAuthorizationMiddleware({
      database: fakeDatabase(sessionExpiresAt),
      ...inertSubscriptions,
    } as any));
    namespace.on('connection', (socket) => {
      socket.emit('authorization_snapshot', {
        authorizationVersion: socket.data.user?.authorizationVersion,
      });
    });
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      resolve();
    });
  });

  const connect = (token: string) => new Promise<
    { outcome: 'snapshot'; authorizationVersion: unknown } | { outcome: 'error'; message: string }
  >((resolve) => {
    const socket = ioClient(`http://127.0.0.1:${port}/authorization`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 4000,
    });
    clients.push(socket);
    socket.on('authorization_snapshot', (snapshot: { authorizationVersion?: unknown }) => {
      resolve({ outcome: 'snapshot', authorizationVersion: snapshot?.authorizationVersion });
    });
    socket.on('connect_error', (error: Error) => {
      resolve({ outcome: 'error', message: error.message });
    });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    if (ioServer) await new Promise<void>((resolve) => { ioServer.close(() => resolve()); });
    if (httpServer?.listening) await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  });

  it('admits a session-bound token and delivers the authorization snapshot', async () => {
    await startServer(new Date(Date.now() + 60 * 60 * 1000));
    const result = await connect(mint({ sessionId: SESSION_ID }));

    expect(result).toEqual({ outcome: 'snapshot', authorizationVersion: 1 });
  });

  it('admits a legacy token that carries no durable session identity', async () => {
    await startServer(null);
    const result = await connect(mint());

    expect(result).toEqual({ outcome: 'snapshot', authorizationVersion: 1 });
  });

  it('still refuses a token whose durable session is gone', async () => {
    await startServer(null);
    const result = await connect(mint({ sessionId: SESSION_ID }));

    expect(result).toEqual({
      outcome: 'error',
      message: 'This sign-in session is no longer active',
    });
  });

  it('still refuses a token from a superseded authorization generation', async () => {
    await startServer(new Date(Date.now() + 60 * 60 * 1000));
    const result = await connect(mint({ sessionId: SESSION_ID, authorizationVersion: 2 }));

    expect(result).toEqual({
      outcome: 'error',
      message: 'Authorization changed; sign in again',
    });
  });
});
