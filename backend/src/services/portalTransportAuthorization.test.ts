const verifyAccessToken = jest.fn();
const userFindUnique = jest.fn();

jest.mock('../utils/jwt', () => ({
  verifyAccessToken,
}));
jest.mock('../config/database', () => ({
  prisma: { user: { findUnique: userFindUnique } },
}));

import {
  authorizeAgentBrowserWebSocketTransport,
  authorizeGatewayWebSocketTransport,
  authorizeRemoteDesktopWebSocketTransport,
  completeAuthorizedWebSocketUpgrade,
  createSocketAccessAuthorizationMiddleware,
} from './portalTransportAuthorization';
import { publishSessionRevoked, sessionRevocationSubscriberCount } from './sessionRevocationBus';
import type { JwtPayload } from '../utils/jwt';

const NOW = new Date('2026-08-11T15:00:00.000Z');

function accessPayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    email: 'owner@example.test',
    role: 'OWNER',
    accountStatus: 'ACTIVE',
    authorizationVersion: 4,
    exp: Math.floor((NOW.getTime() + 60_000) / 1000),
    ...overrides,
  };
}

function activeUser(role = 'OWNER', sessionId = 'session-1') {
  return {
    id: 'user-1',
    email: 'owner@example.test',
    role,
    accountStatus: 'ACTIVE',
    isActive: true,
    sandboxEnabled: true,
    authorizationVersion: 4,
    sessions: [{ id: sessionId, expiresAt: new Date(NOW.getTime() + 60_000) }],
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    database: { user: { findUnique: userFindUnique } },
    now: () => NOW,
    subscribeAuthorization: jest.fn(() => jest.fn()),
    subscribeGlobalFence: jest.fn(() => jest.fn()),
    ...overrides,
  } as any;
}

class FakeUpgradeSocket {
  destroyed = false;
  writes: string[] = [];
  closeListener: (() => void) | null = null;

  write(value: string) {
    this.writes.push(value);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeListener?.();
  }

  once(event: 'close', listener: () => void) {
    if (event === 'close') this.closeListener = listener;
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Portal long-lived transport authorization', () => {
  afterEach(() => {
    jest.clearAllMocks();
    expect(sessionRevocationSubscriberCount()).toBe(0);
  });

  test.each([
    ['Gateway Portal WS', (onRevoke: any) => authorizeGatewayWebSocketTransport(accessPayload(), false, onRevoke, dependencies())],
    ['Gateway direct WS', (onRevoke: any) => authorizeGatewayWebSocketTransport(accessPayload(), true, onRevoke, dependencies())],
    ['Agent Browser WS', (onRevoke: any) => authorizeAgentBrowserWebSocketTransport(accessPayload(), onRevoke, dependencies())],
    ['noVNC WS', (onRevoke: any) => authorizeRemoteDesktopWebSocketTransport(accessPayload(), onRevoke, dependencies())],
    ['audio WS', (onRevoke: any) => authorizeRemoteDesktopWebSocketTransport(accessPayload(), onRevoke, dependencies())],
  ])('%s admits one exact live Session, cleans up on close, and revokes live', async (_label, authorize) => {
    userFindUnique.mockResolvedValue(activeUser());
    const socket = new FakeUpgradeSocket();
    const onAuthorized = jest.fn();

    completeAuthorizedWebSocketUpgrade({ socket, authorize, onAuthorized });
    await settle();

    expect(onAuthorized).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({
        userId: 'user-1',
        sessionId: 'session-1',
        sessionExpiresAt: expect.any(Date),
      }),
    }));
    expect(socket.destroyed).toBe(false);
    expect(sessionRevocationSubscriberCount('user-1')).toBe(1);

    publishSessionRevoked({ userId: 'user-1', sessionId: 'session-1', reason: 'logout' });
    expect(socket.destroyed).toBe(true);
    expect(sessionRevocationSubscriberCount('user-1')).toBe(0);
  });

  test('rejects a missing Session before a raw upgrade is handed to its target', async () => {
    userFindUnique.mockResolvedValue({ ...activeUser(), sessions: [] });
    const socket = new FakeUpgradeSocket();
    const onAuthorized = jest.fn();

    completeAuthorizedWebSocketUpgrade({
      socket,
      authorize: (onRevoke) => authorizeRemoteDesktopWebSocketTransport(
        accessPayload(),
        onRevoke,
        dependencies(),
      ),
      onAuthorized,
    });
    await settle();

    expect(onAuthorized).not.toHaveBeenCalled();
    expect(socket.writes).toEqual(['HTTP/1.1 401 Unauthorized\r\n\r\n']);
    expect(socket.destroyed).toBe(true);
  });

  test.each([
    ['Gateway Portal WS', (deps: any, onRevoke: any) => authorizeGatewayWebSocketTransport(accessPayload({ exp: Math.floor((NOW.getTime() + 5_000) / 1000) }), false, onRevoke, deps)],
    ['Gateway direct WS', (deps: any, onRevoke: any) => authorizeGatewayWebSocketTransport(accessPayload({ exp: Math.floor((NOW.getTime() + 5_000) / 1000) }), true, onRevoke, deps)],
    ['Agent Browser WS', (deps: any, onRevoke: any) => authorizeAgentBrowserWebSocketTransport(accessPayload({ exp: Math.floor((NOW.getTime() + 5_000) / 1000) }), onRevoke, deps)],
    ['noVNC WS', (deps: any, onRevoke: any) => authorizeRemoteDesktopWebSocketTransport(accessPayload({ exp: Math.floor((NOW.getTime() + 5_000) / 1000) }), onRevoke, deps)],
    ['audio WS', (deps: any, onRevoke: any) => authorizeRemoteDesktopWebSocketTransport(accessPayload({ exp: Math.floor((NOW.getTime() + 5_000) / 1000) }), onRevoke, deps)],
  ])('%s is retired at its authority expiry', async (_label, authorize) => {
    userFindUnique.mockResolvedValue(activeUser());
    let clock = NOW;
    let timerCallback: (() => void) | null = null;
    const socket = new FakeUpgradeSocket();
    completeAuthorizedWebSocketUpgrade({
      socket,
      authorize: (onRevoke) => authorize(dependencies({
        now: () => clock,
        setTimer: (callback: () => void) => {
          timerCallback = callback;
          return { unref: jest.fn() } as unknown as NodeJS.Timeout;
        },
        clearTimer: jest.fn(),
      }), onRevoke),
      onAuthorized: jest.fn(),
    });
    await settle();

    clock = new Date(NOW.getTime() + 5_000);
    (timerCallback as unknown as () => void)();
    expect(socket.destroyed).toBe(true);
    expect(sessionRevocationSubscriberCount('user-1')).toBe(0);
  });

  test('disposes a successful authority when the raw socket closes during its database query', async () => {
    let resolveUser!: (user: any) => void;
    userFindUnique.mockReturnValue(new Promise((resolve) => { resolveUser = resolve; }));
    const socket = new FakeUpgradeSocket();
    const onAuthorized = jest.fn();

    completeAuthorizedWebSocketUpgrade({
      socket,
      authorize: (onRevoke) => authorizeGatewayWebSocketTransport(
        accessPayload(),
        false,
        onRevoke,
        dependencies(),
      ),
      onAuthorized,
    });
    socket.destroy();
    resolveUser(activeUser());
    await settle();

    expect(onAuthorized).not.toHaveBeenCalled();
    expect(sessionRevocationSubscriberCount('user-1')).toBe(0);
  });

  test('keeps ordinary users out of operator-only direct, browser, noVNC, and audio transports', async () => {
    userFindUnique.mockResolvedValue(activeUser('USER'));
    const ordinaryPayload = accessPayload({ role: 'USER' });
    const cases = [
      authorizeGatewayWebSocketTransport(ordinaryPayload, true, jest.fn(), dependencies()),
      authorizeAgentBrowserWebSocketTransport(ordinaryPayload, jest.fn(), dependencies()),
      authorizeRemoteDesktopWebSocketTransport(ordinaryPayload, jest.fn(), dependencies()),
    ];

    await expect(Promise.all(cases)).resolves.toEqual([
      { ok: false, reason: 'account_denied' },
      { ok: false, reason: 'account_denied' },
      { ok: false, reason: 'account_denied' },
    ]);
  });

  test('Socket.IO middleware preserves the normalized Session identity and disconnects on exact logout', async () => {
    verifyAccessToken.mockReturnValue(accessPayload());
    userFindUnique.mockResolvedValue(activeUser());
    const closeListeners: Array<() => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const socket: any = {
      handshake: { auth: { token: 'signed' }, headers: {} },
      nsp: { name: '/metrics' },
      data: {},
      disconnected: false,
      conn: { once: (_event: string, listener: () => void) => closeListeners.push(listener) },
      once: (_event: string, listener: () => void) => disconnectListeners.push(listener),
      disconnect: jest.fn(() => {
        socket.disconnected = true;
        for (const listener of disconnectListeners) listener();
      }),
    };
    const middleware = createSocketAccessAuthorizationMiddleware(dependencies());

    await new Promise<void>((resolve, reject) => middleware(socket, (error?: Error) => (
      error ? reject(error) : resolve()
    )));

    expect(socket.data.user).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      sessionExpiresAt: expect.any(Date),
    }));
    publishSessionRevoked({ userId: 'user-1', sessionId: 'session-1', reason: 'logout' });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(sessionRevocationSubscriberCount('user-1')).toBe(0);
    expect(closeListeners).toHaveLength(1);
  });

  test('Socket.IO expiry timer disconnects an established namespace authority', async () => {
    let clock = NOW;
    let timerCallback: (() => void) | null = null;
    verifyAccessToken.mockReturnValue(accessPayload({ exp: Math.floor((NOW.getTime() + 5_000) / 1000) }));
    userFindUnique.mockResolvedValue(activeUser());
    const socket: any = {
      handshake: { auth: { token: 'signed' }, headers: {} },
      nsp: { name: '/metrics' },
      data: {},
      disconnected: false,
      conn: { once: jest.fn() },
      once: jest.fn(),
      disconnect: jest.fn(() => { socket.disconnected = true; }),
    };
    const middleware = createSocketAccessAuthorizationMiddleware(dependencies({
      now: () => clock,
      setTimer: (callback: () => void) => {
        timerCallback = callback;
        return { unref: jest.fn() } as unknown as NodeJS.Timeout;
      },
      clearTimer: jest.fn(),
    }));
    await new Promise<void>((resolve, reject) => middleware(socket, (error?: Error) => (
      error ? reject(error) : resolve()
    )));

    clock = new Date(NOW.getTime() + 5_000);
    (timerCallback as unknown as () => void)();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
