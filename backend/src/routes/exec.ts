import { Server as SocketIOServer } from 'socket.io';
import { verifyAccessToken } from '../utils/jwt';
import { canUseInteractivePortal, isElevatedRole } from '../utils/authz';
import { parseSafeCookieHeader } from '../utils/safeCookies';
import {
  acquireGlobalWorkspaceAuthorizationMutationLease,
} from '../services/workspaceAuthorizationBarrier';
import { establishLongLivedAccessAuthorization } from '../services/accessTokenAuthorization';
import {
  prepareTerminalSystemdScope,
  TerminalSystemdScopeError,
  type PreparedTerminalSystemdScope,
} from '../services/terminalSystemdScopeBoundary';

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;
export const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;

interface TerminalAuthorizationControl {
  revoked: boolean;
  requestTermination?: () => void;
}

function clampTerminalDimension(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

export function normalizeTerminalDimensions(
  cols: unknown,
  rows: unknown,
): { cols: number; rows: number } {
  return {
    cols: clampTerminalDimension(cols, DEFAULT_TERMINAL_COLS, MAX_TERMINAL_COLS),
    rows: clampTerminalDimension(rows, DEFAULT_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
  };
}

export function setupTerminalNamespace(io: SocketIOServer) {
  const terminal = io.of('/terminal');

  terminal.use((socket, next) => {
    let token = socket.handshake.auth?.token;

    if (!token || typeof token !== 'string') {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      const cookies = parseSafeCookieHeader(cookieHeader);
      token = cookies.accessToken;
    }

    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return next(new Error('Invalid or expired token'));
    }

    const authorizationControl: TerminalAuthorizationControl = {
      revoked: false,
    };
    (socket as any).terminalAuthorizationControl = authorizationControl;
    const revokeInteractiveAuthority = () => {
      authorizationControl.revoked = true;
      authorizationControl.requestTermination?.();
      try {
        socket.disconnect(true);
      } catch {
        // The post-query check below still rejects a handshake being torn down.
      }
    };
    void establishLongLivedAccessAuthorization({
      payload,
      authorize: (identity) => canUseInteractivePortal(
        identity.role,
        identity.accountStatus,
        true,
      ) && isElevatedRole(identity.role),
      onRevoke: revokeInteractiveAuthority,
    }).then((result) => {
      if (!result.ok) {
        next(new Error(result.reason === 'session_revoked'
          ? 'This sign-in session is no longer active'
          : 'Account is not permitted for terminal access'));
        return;
      }
      if (authorizationControl.revoked || socket.disconnected) {
        result.dispose();
        next(new Error('Authorization changed during connection'));
        return;
      }

      (socket as any).user = result.identity;
      (socket as any).authorizationUnsubscribe = result.dispose;
      socket.conn?.once?.('close', result.dispose);
      next();
    }).catch((err) => next(err));
  });

  terminal.on('connection', (socket) => {
    let releaseLeaseBeforeBoundary: (() => void) | null = null;
    let terminateAfterBoundary: (() => void) | null = null;

    void (async () => {
      console.log(`Terminal connected: ${(socket as any).user?.userId}`);
      const unsubscribeAuthorization = (socket as any).authorizationUnsubscribe as
        | (() => void)
        | undefined;
      const authorizationControl = (socket as any).terminalAuthorizationControl as
        | TerminalAuthorizationControl
        | undefined;

      const initialDimensions = normalizeTerminalDimensions(
        socket.handshake.query?.cols,
        socket.handshake.query?.rows,
      );

      let releaseMutationLease: (() => void) | null = null;
      try {
        releaseMutationLease = acquireGlobalWorkspaceAuthorizationMutationLease();
      } catch {
        socket.emit('output', '\r\nTerminal access is temporarily unavailable.\r\n');
        unsubscribeAuthorization?.();
        socket.disconnect();
        return;
      }

      let session: PreparedTerminalSystemdScope | null = null;
      let preparation: Promise<PreparedTerminalSystemdScope> | null = null;
      let terminationPromise: Promise<void> | null = null;
      let terminationRequested = false;
      let acceptingInput = false;
      let leaseReleased = false;

      const releaseLease = () => {
        if (leaseReleased) return;
        leaseReleased = true;
        releaseMutationLease?.();
        releaseMutationLease = null;
      };
      releaseLeaseBeforeBoundary = releaseLease;

      const requestTermination = (): void => {
        terminationRequested = true;
        acceptingInput = false;
        if (terminationPromise) return;
        terminationPromise = (async () => {
          try {
            const prepared = session || (preparation ? await preparation : null);
            if (prepared) await prepared.stop();
            releaseLease();
          } catch (error) {
            if (
              error instanceof TerminalSystemdScopeError
              && error.settlementProven
            ) {
              releaseLease();
            } else {
              // Retain the mutation lease. Authorization transitions must remain
              // fail-closed until restart recovery proves this scope empty.
              console.error(
                '[Terminal Scope] Exact recursive settlement could not be proven',
              );
            }
          } finally {
            if (!socket.disconnected) socket.disconnect(true);
          }
        })();
        void terminationPromise;
      };
      terminateAfterBoundary = requestTermination;
      if (authorizationControl) {
        authorizationControl.requestTermination = requestTermination;
      }

      socket.on('input', (data: unknown) => {
        if (
          typeof data !== 'string'
          || Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_INPUT_BYTES
        ) {
          socket.emit(
            'output',
            '\r\nTerminal input was rejected because it exceeded the 256 KiB safety limit.\r\n',
          );
          return;
        }
        if (!acceptingInput || !session) {
          socket.emit(
            'output',
            '\r\nTerminal input is unavailable until the protected session is ready.\r\n',
          );
          return;
        }
        try {
          session.pty.write(data);
        } catch {
          // pty already closed
        }
      });

      socket.on('resize', (size: unknown) => {
        if (!acceptingInput || !session) return;
        try {
          const dimensions = normalizeTerminalDimensions(
            (size as { cols?: unknown } | null)?.cols,
            (size as { rows?: unknown } | null)?.rows,
          );
          session.pty.resize(dimensions.cols, dimensions.rows);
        } catch {
          // ignore
        }
      });

      socket.on('disconnect', () => {
        unsubscribeAuthorization?.();
        console.log(`Terminal disconnected: ${(socket as any).user?.userId}`);
        requestTermination();
      });

      const targetEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: process.env.HOME || '/root',
        TERM: 'xterm-256color',
      };
      preparation = prepareTerminalSystemdScope({
        command: '/bin/bash',
        args: ['-l'],
        cwd: process.env.HOME || '/root',
        env: targetEnvironment,
        terminalName: 'xterm-256color',
        cols: initialDimensions.cols,
        rows: initialDimensions.rows,
      });

      try {
        session = await preparation;
        if (
          terminationRequested
          || authorizationControl?.revoked
          || socket.disconnected
        ) {
          requestTermination();
          await terminationPromise;
          return;
        }

        session.pty.onData((data: string) => {
          if (!terminationRequested && !socket.disconnected) {
            socket.emit('output', data);
          }
        });
        session.pty.onExit(({ exitCode }: { exitCode: number }) => {
          if (!socket.disconnected) {
            socket.emit('output', `\r\nProcess exited with code ${exitCode}\r\n`);
          }
          requestTermination();
        });

        await session.activate();
        if (
          terminationRequested
          || authorizationControl?.revoked
          || socket.disconnected
        ) {
          requestTermination();
          await terminationPromise;
          return;
        }
        acceptingInput = true;
        socket.emit('terminal_ready', {
          scope: session.identity.scopeUnit,
        });
        console.log('Terminal: attested local systemd scope ready');
      } catch {
        socket.emit('output', '\r\nFailed to start protected terminal session.\r\n');
        requestTermination();
        await terminationPromise;
      }
    })().catch(() => {
      if (terminateAfterBoundary) {
        terminateAfterBoundary();
        return;
      }
      // No scope can exist before the termination boundary is installed.
      releaseLeaseBeforeBoundary?.();
      try { socket.disconnect(true); } catch {}
    });
  });
}
