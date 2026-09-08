jest.mock('node-pty', () => ({ spawn: jest.fn() }));

jest.mock('../utils/jwt', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('../utils/authz', () => ({
  canUseInteractivePortal: jest.fn(() => true),
  isElevatedRole: jest.fn(() => true),
}));

jest.mock('../utils/safeCookies', () => ({
  parseSafeCookieHeader: jest.fn(() => ({})),
}));

jest.mock('../services/accessTokenAuthorization', () => ({
  establishLongLivedAccessAuthorization: jest.fn(),
}));

jest.mock('../services/workspaceAuthorizationBarrier', () => ({
  acquireGlobalWorkspaceAuthorizationMutationLease: jest.fn(),
}));

jest.mock('../services/oauthFlowManager', () => ({
  attachNativeCliInteractiveTerminal: jest.fn(),
  cancelOAuthFlow: jest.fn(),
}));

import { setupHarnessSetupNamespace } from '../routes/exec';
import { establishLongLivedAccessAuthorization } from '../services/accessTokenAuthorization';
import {
  attachNativeCliInteractiveTerminal,
  cancelOAuthFlow,
} from '../services/oauthFlowManager';
import { verifyAccessToken } from '../utils/jwt';

const USER_ID = 'harness-owner';
const SESSION_ID = 'oauth_test_ab12cd';

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeSocket {
  readonly handshake = {
    auth: { token: 'valid-token' },
    headers: {},
    query: { sessionId: SESSION_ID },
  };

  readonly conn = {
    readyState: 'open',
    once: jest.fn(),
  };

  readonly outbound: Array<{ event: string; payload: unknown }> = [];
  readonly disconnect = jest.fn((force?: boolean) => {
    void force;
    if (this.conn.readyState === 'closed') return;
    this.conn.readyState = 'closed';
    this.disconnected = true;
    this.trigger('disconnect');
  });

  // Socket.IO keeps this true until Namespace._onconnect(), after middleware.
  disconnected = true;
  user?: unknown;
  authorizationUnsubscribe?: () => void;
  harnessSetupAuthorizationControl?: {
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
    for (const handler of this.handlers.get(event) || []) handler(...args);
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

describe('harness-native setup terminal authorization boundary', () => {
  let namespace: FakeNamespace;
  let revokeAuthorization: (() => void) | null;
  let disposeAuthorization: jest.Mock;
  let dataListener: ((data: string) => void) | null;
  let exitListener: ((event: { exitCode: number }) => void) | null;
  let detachData: jest.Mock;
  let detachExit: jest.Mock;
  let attachment: {
    provider: 'hermes';
    output: string;
    status: 'processing';
    processExited: boolean;
    write: jest.Mock;
    resize: jest.Mock;
    onData: jest.Mock;
    onExit: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    namespace = new FakeNamespace();
    revokeAuthorization = null;
    disposeAuthorization = jest.fn();
    dataListener = null;
    exitListener = null;
    detachData = jest.fn();
    detachExit = jest.fn();
    attachment = {
      provider: 'hermes',
      output: 'existing setup output',
      status: 'processing',
      processExited: false,
      write: jest.fn(),
      resize: jest.fn(),
      onData: jest.fn((listener: (data: string) => void) => {
        dataListener = listener;
        return detachData;
      }),
      onExit: jest.fn((listener: (event: { exitCode: number }) => void) => {
        exitListener = listener;
        return detachExit;
      }),
    };

    (verifyAccessToken as jest.Mock).mockReturnValue({
      userId: USER_ID,
      sessionId: 'portal-session',
      role: 'OWNER',
      accountStatus: 'ACTIVE',
      authorizationVersion: 1,
    });
    (establishLongLivedAccessAuthorization as jest.Mock).mockImplementation(async (input: any) => {
      revokeAuthorization = input.onRevoke;
      return {
        ok: true,
        identity: {
          userId: USER_ID,
          sessionId: 'portal-session',
          role: 'OWNER',
          accountStatus: 'ACTIVE',
          authorizationVersion: 1,
        },
        dispose: disposeAuthorization,
      };
    });
    (attachNativeCliInteractiveTerminal as jest.Mock).mockReturnValue(attachment);
    (cancelOAuthFlow as jest.Mock).mockResolvedValue({ success: true, status: 'cancelled' });

    setupHarnessSetupNamespace({
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
    socket.disconnected = false;
    namespace.connection!(socket);
    return socket;
  }

  test('attaches only the fixed session owned by the authenticated Portal user', async () => {
    const socket = await authorizeAndConnect();

    expect(attachNativeCliInteractiveTerminal).toHaveBeenCalledWith(
      SESSION_ID,
      `user:${USER_ID}`,
    );
    expect(socket.outbound).toContainEqual({ event: 'output', payload: 'existing setup output' });
    expect(socket.outbound).toContainEqual({
      event: 'terminal_ready',
      payload: { provider: 'hermes', status: 'processing', processExited: false },
    });

    socket.trigger('input', 'provider-choice\r');
    socket.trigger('resize', { cols: 900, rows: 0 });
    expect(attachment.write).toHaveBeenCalledWith('provider-choice\r');
    expect(attachment.resize).toHaveBeenCalledWith(500, 1);

    dataListener?.('live output');
    exitListener?.({ exitCode: 0 });
    expect(socket.outbound).toContainEqual({ event: 'output', payload: 'live output' });
    expect(socket.outbound).toContainEqual({ event: 'terminal_exit', payload: { exitCode: 0 } });
  });

  test('bounds input and detaches an ordinary browser disconnect without cancelling setup', async () => {
    const socket = await authorizeAndConnect();
    socket.trigger('input', 'x'.repeat((16 * 1024) + 1));
    expect(attachment.write).not.toHaveBeenCalled();
    expect(socket.outbound).toContainEqual({
      event: 'setup_error',
      payload: { error: 'Harness setup input exceeded the 16 KiB safety limit.' },
    });

    socket.disconnect(true);
    expect(detachData).toHaveBeenCalledTimes(1);
    expect(detachExit).toHaveBeenCalledTimes(1);
    expect(disposeAuthorization).toHaveBeenCalledTimes(1);
    expect(cancelOAuthFlow).not.toHaveBeenCalled();
  });

  test('cancels the exact owned setup if the durable session authority is revoked', async () => {
    const socket = await authorizeAndConnect();
    revokeAuthorization?.();
    await flushPromises();

    expect(cancelOAuthFlow).toHaveBeenCalledWith(SESSION_ID, `user:${USER_ID}`);
    expect(socket.disconnected).toBe(true);
  });

  test('rejects malformed or unattached session identifiers without exposing another session', async () => {
    const malformed = new FakeSocket();
    (malformed.handshake.query as any).sessionId = '../../other-session';
    await authorizeAndConnect(malformed);
    expect(attachNativeCliInteractiveTerminal).not.toHaveBeenCalled();
    expect(malformed.outbound).toContainEqual({
      event: 'setup_error',
      payload: { error: 'Harness setup session is invalid.' },
    });

    (attachNativeCliInteractiveTerminal as jest.Mock).mockReturnValueOnce(null);
    const unattached = await authorizeAndConnect();
    expect(unattached.outbound).toContainEqual({
      event: 'setup_error',
      payload: { error: 'Harness setup session was not found or is not owned by this account.' },
    });
    expect(unattached.disconnected).toBe(true);
  });
});
