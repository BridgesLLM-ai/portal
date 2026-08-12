jest.mock('../utils/jwt', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('../config/database', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('../utils/authz', () => ({
  canAccessPortal: jest.fn(() => true),
  canUseInteractivePortal: jest.fn(() => true),
  isElevatedRole: jest.fn(() => true),
}));

jest.mock('../utils/safeCookies', () => ({
  parseSafeCookieHeader: jest.fn(() => ({})),
}));

jest.mock('../services/authorizationChangeBus', () => ({
  subscribeToAuthorizationChanges: jest.fn(),
}));

jest.mock('../services/workspaceAuthorizationBarrier', () => ({
  acquireGlobalWorkspaceAuthorizationMutationLease: jest.fn(),
  subscribeToGlobalWorkspaceAuthorizationFence: jest.fn(),
}));

jest.mock('../services/terminalSystemdScopeBoundary', () => {
  const actual = jest.requireActual('../services/terminalSystemdScopeBoundary');
  return {
    ...actual,
    prepareTerminalSystemdScope: jest.fn(),
  };
});

import { prisma } from '../config/database';
import { setupTerminalNamespace } from '../routes/exec';
import { subscribeToAuthorizationChanges } from '../services/authorizationChangeBus';
import {
  prepareTerminalSystemdScope,
  TerminalSystemdScopeError,
  type PreparedTerminalSystemdScope,
} from '../services/terminalSystemdScopeBoundary';
import {
  acquireGlobalWorkspaceAuthorizationMutationLease,
  subscribeToGlobalWorkspaceAuthorizationFence,
} from '../services/workspaceAuthorizationBarrier';
import { publishSessionRevoked } from '../services/sessionRevocationBus';
import { verifyAccessToken } from '../utils/jwt';

const USER_ID = 'terminal-owner';
const SCOPE_UNIT = 'bridgesllm-terminal-123456789abc4def8abc123456789abc.scope';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeSocket {
  readonly handshake = {
    auth: { token: 'valid-token' },
    headers: {},
    query: { cols: '120', rows: '40' },
  };

  readonly conn = {
    once: jest.fn(),
    removeListener: jest.fn(),
  };

  readonly outbound: Array<{ event: string; payload: unknown }> = [];
  readonly disconnect = jest.fn((force?: boolean) => {
    void force;
    if (this.disconnected) return;
    this.disconnected = true;
    this.trigger('disconnect');
  });

  disconnected = false;
  user?: unknown;
  authorizationUnsubscribe?: () => void;
  terminalAuthorizationControl?: {
    revoked: boolean;
    requestTermination?: () => void;
  };

  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, handler: (...args: any[]) => void): this {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    this.outbound.push({ event, payload });
    return true;
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) || []) {
      handler(...args);
    }
  }
}

class FakeNamespace {
  middleware?: (socket: any, next: (error?: Error) => void) => void;
  connection?: (socket: any) => void;

  use(handler: (socket: any, next: (error?: Error) => void) => void): this {
    this.middleware = handler;
    return this;
  }

  on(event: string, handler: (socket: any) => void): this {
    if (event === 'connection') this.connection = handler;
    return this;
  }
}

function createSession(options: {
  activate?: () => Promise<void>;
  stop?: () => Promise<any>;
} = {}): PreparedTerminalSystemdScope & {
  pty: PreparedTerminalSystemdScope['pty'] & {
    write: jest.Mock;
    resize: jest.Mock;
    emitData(data: string): void;
    emitExit(exitCode: number): void;
  };
  activate: jest.Mock;
  stop: jest.Mock;
} {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const pty: any = {
    pid: 123,
    process: 'systemd-run',
    cols: 120,
    rows: 40,
    write: jest.fn(),
    resize: jest.fn(),
    clear: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    kill: jest.fn(),
    onData: jest.fn((handler: (data: string) => void) => {
      onData = handler;
      return { dispose: jest.fn() };
    }),
    onExit: jest.fn((handler: (event: { exitCode: number; signal?: number }) => void) => {
      onExit = handler;
      return { dispose: jest.fn() };
    }),
    emitData(data: string) {
      onData?.(data);
    },
    emitExit(exitCode: number) {
      onExit?.({ exitCode });
    },
  };
  return {
    pty,
    identity: {
      scopeUnit: SCOPE_UNIT,
      scopeTag: 'a'.repeat(64),
      description: `BridgesLLM privileged terminal tag=${'a'.repeat(64)}`,
      controlGroup: `/system.slice/${SCOPE_UNIT}`,
      bootId: '12345678-1234-1234-1234-123456789abc',
      invocationId: 'b'.repeat(32),
    },
    activate: jest.fn(options.activate || (async () => undefined)),
    stop: jest.fn(options.stop || (async () => ({
      scopeUnit: SCOPE_UNIT,
      invocationId: 'b'.repeat(32),
      bootId: '12345678-1234-1234-1234-123456789abc',
      stopRequested: true,
      bootChanged: false,
      cgroupEmpty: true,
      finalLoadState: 'not-found',
      finalActiveState: 'inactive',
      finalSubState: 'dead',
    }))),
  } as any;
}

describe('privileged terminal systemd-scope authorization boundary', () => {
  let namespace: FakeNamespace;
  let globalFenceListener: (() => void) | null;
  let authorizationListener: (() => void) | null;
  let releaseLease: jest.Mock;
  let unsubscribeGlobal: jest.Mock;
  let unsubscribeAuthorization: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    namespace = new FakeNamespace();
    globalFenceListener = null;
    authorizationListener = null;
    releaseLease = jest.fn();
    unsubscribeGlobal = jest.fn();
    unsubscribeAuthorization = jest.fn();

    (verifyAccessToken as jest.Mock).mockReturnValue({
      userId: USER_ID,
      sessionId: 'terminal-session',
      email: 'owner@example.test',
      role: 'OWNER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 7,
    });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      email: 'owner@example.test',
      role: 'OWNER',
      accountStatus: 'ACTIVE',
      isActive: true,
      authorizationVersion: 7,
      sessions: [{
        id: 'terminal-session',
        expiresAt: new Date(Date.now() + 60_000),
      }],
    });
    (subscribeToGlobalWorkspaceAuthorizationFence as jest.Mock)
      .mockImplementation((listener: () => void) => {
        globalFenceListener = listener;
        return unsubscribeGlobal;
      });
    (subscribeToAuthorizationChanges as jest.Mock)
      .mockImplementation((_userId: string, listener: () => void) => {
        authorizationListener = listener;
        return unsubscribeAuthorization;
      });
    (acquireGlobalWorkspaceAuthorizationMutationLease as jest.Mock)
      .mockReturnValue(releaseLease);

    setupTerminalNamespace({
      of: jest.fn(() => namespace),
    } as any);
  });

  async function authorizeAndConnect(socket = new FakeSocket()): Promise<FakeSocket> {
    await new Promise<void>((resolve, reject) => {
      namespace.middleware!(socket, (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    namespace.connection!(socket);
    await flushPromises();
    return socket;
  }

  test('admits no input before exact attestation and activation, then releases the lease only after stop proof', async () => {
    const prepared = deferred<PreparedTerminalSystemdScope>();
    const activated = deferred<void>();
    const stopped = deferred<any>();
    const session = createSession({
      activate: () => activated.promise,
      stop: () => stopped.promise,
    });
    (prepareTerminalSystemdScope as jest.Mock).mockReturnValue(prepared.promise);

    const socket = await authorizeAndConnect();
    socket.trigger('input', 'before-attestation');
    expect(session.pty.write).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();

    prepared.resolve(session);
    await flushPromises();
    expect(session.activate).toHaveBeenCalledTimes(1);
    socket.trigger('input', 'during-activation');
    expect(session.pty.write).not.toHaveBeenCalled();

    activated.resolve();
    await flushPromises();
    socket.trigger('input', 'after-activation');
    socket.trigger('resize', { cols: 90, rows: 33 });
    expect(session.pty.write).toHaveBeenCalledWith('after-activation');
    expect(session.pty.resize).toHaveBeenCalledWith(90, 33);
    expect(socket.outbound).toContainEqual({
      event: 'terminal_ready',
      payload: { scope: SCOPE_UNIT },
    });

    socket.disconnect(true);
    await flushPromises();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(releaseLease).not.toHaveBeenCalled();
    stopped.resolve({ cgroupEmpty: true });
    await flushPromises();
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(session.pty.kill).not.toHaveBeenCalled();
  });

  test('a global fence during attestation waits for the late exact scope and its recursive stop proof', async () => {
    const prepared = deferred<PreparedTerminalSystemdScope>();
    const stopped = deferred<any>();
    const session = createSession({ stop: () => stopped.promise });
    (prepareTerminalSystemdScope as jest.Mock).mockReturnValue(prepared.promise);

    const socket = await authorizeAndConnect();
    expect(acquireGlobalWorkspaceAuthorizationMutationLease)
      .toHaveBeenCalledTimes(1);
    expect(prepareTerminalSystemdScope).toHaveBeenCalledTimes(1);
    globalFenceListener!();
    expect(socket.disconnected).toBe(true);
    expect(releaseLease).not.toHaveBeenCalled();

    prepared.resolve(session);
    await flushPromises();
    expect(session.activate).not.toHaveBeenCalled();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(releaseLease).not.toHaveBeenCalled();

    stopped.resolve({ cgroupEmpty: true });
    await flushPromises();
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(session.pty.kill).not.toHaveBeenCalled();
  });

  test('per-user revocation during activation stops the exact scope and never reopens input', async () => {
    const activated = deferred<void>();
    const stopped = deferred<any>();
    const session = createSession({
      activate: () => activated.promise,
      stop: () => stopped.promise,
    });
    (prepareTerminalSystemdScope as jest.Mock).mockResolvedValue(session);

    const socket = await authorizeAndConnect();
    expect(session.activate).toHaveBeenCalledTimes(1);
    authorizationListener!();
    await flushPromises();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(releaseLease).not.toHaveBeenCalled();

    stopped.resolve({ cgroupEmpty: true });
    activated.resolve();
    await flushPromises();
    socket.trigger('input', 'must-not-run');
    expect(session.pty.write).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  test('exact Session logout stops the established systemd scope while it is activating', async () => {
    const activated = deferred<void>();
    const stopped = deferred<any>();
    const session = createSession({
      activate: () => activated.promise,
      stop: () => stopped.promise,
    });
    (prepareTerminalSystemdScope as jest.Mock).mockResolvedValue(session);

    const socket = await authorizeAndConnect();
    expect(session.activate).toHaveBeenCalledTimes(1);
    publishSessionRevoked({
      userId: USER_ID,
      sessionId: 'terminal-session',
      reason: 'logout',
    });
    await flushPromises();

    expect(socket.disconnected).toBe(true);
    expect(session.stop).toHaveBeenCalledTimes(1);
    stopped.resolve({ cgroupEmpty: true });
    activated.resolve();
    await flushPromises();
    socket.trigger('input', 'must-not-run-after-logout');
    expect(session.pty.write).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  test('releases the lease after a pre-attestation launch failure only when cleanup is proven', async () => {
    (prepareTerminalSystemdScope as jest.Mock).mockRejectedValue(
      new TerminalSystemdScopeError(
        'launcher failed after exact cleanup',
        'TERMINAL_SCOPE_LAUNCH_FAILED',
        true,
      ),
    );

    const socket = await authorizeAndConnect();
    await flushPromises();
    expect(socket.disconnected).toBe(true);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  test('retains the lease when exact recursive settlement cannot be proven', async () => {
    const session = createSession({
      stop: async () => {
        throw new TerminalSystemdScopeError(
          'cgroup remained populated',
          'TERMINAL_SCOPE_SETTLEMENT_UNPROVEN',
          false,
        );
      },
    });
    (prepareTerminalSystemdScope as jest.Mock).mockResolvedValue(session);

    const socket = await authorizeAndConnect();
    await flushPromises();
    socket.disconnect(true);
    await flushPromises();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  test('PTY exit settles by exact scope identity and suppresses output after revocation', async () => {
    const session = createSession();
    (prepareTerminalSystemdScope as jest.Mock).mockResolvedValue(session);

    const socket = await authorizeAndConnect();
    await flushPromises();
    session.pty.emitData('visible');
    expect(socket.outbound).toContainEqual({ event: 'output', payload: 'visible' });

    globalFenceListener!();
    await flushPromises();
    session.pty.emitData('hidden');
    expect(socket.outbound).not.toContainEqual({ event: 'output', payload: 'hidden' });
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});
