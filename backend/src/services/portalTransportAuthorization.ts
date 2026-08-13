import { canUseDirectGateway, canUseInteractivePortal, isElevatedRole } from '../utils/authz';
import { verifyAccessToken, type JwtPayload } from '../utils/jwt';
import { parseSafeCookieHeader } from '../utils/safeCookies';
import type { AuthorizationChangedEvent } from './authorizationChangeBus';
import {
  establishLongLivedAccessAuthorization,
  type EstablishedLongLivedAccessResult,
  type LongLivedAccessAuthorizationDependencies,
  type LongLivedAccessRevocationReason,
} from './accessTokenAuthorization';

export type TransportRevocationHandler = (reason: LongLivedAccessRevocationReason) => void;

export interface AuthorizedWebSocketUpgradeSocket {
  destroyed?: boolean;
  write(data: string): unknown;
  destroy(): unknown;
  once(event: 'close', listener: () => void): unknown;
}

type SuccessfulLongLivedAccessResult = Extract<EstablishedLongLivedAccessResult, { ok: true }>;

export function authorizeGatewayWebSocketTransport(
  payload: JwtPayload,
  directProxy: boolean,
  onRevoke: TransportRevocationHandler,
  dependencies?: LongLivedAccessAuthorizationDependencies,
): Promise<EstablishedLongLivedAccessResult> {
  return establishLongLivedAccessAuthorization({
    payload,
    authorize: (identity) => directProxy
      ? canUseDirectGateway(identity.role, identity.accountStatus, true)
      : canUseInteractivePortal(identity.role, identity.accountStatus, true),
    onRevoke,
    dependencies,
  });
}

export function authorizeAgentBrowserWebSocketTransport(
  payload: JwtPayload,
  onRevoke: TransportRevocationHandler,
  dependencies?: LongLivedAccessAuthorizationDependencies,
): Promise<EstablishedLongLivedAccessResult> {
  return establishLongLivedAccessAuthorization({
    payload,
    authorize: (identity) => canUseInteractivePortal(
      identity.role,
      identity.accountStatus,
      true,
    ) && isElevatedRole(identity.role),
    onRevoke,
    dependencies,
  });
}

export function authorizeRemoteDesktopWebSocketTransport(
  payload: JwtPayload,
  onRevoke: TransportRevocationHandler,
  dependencies?: LongLivedAccessAuthorizationDependencies,
): Promise<EstablishedLongLivedAccessResult> {
  return establishLongLivedAccessAuthorization({
    payload,
    authorize: (identity) => canUseInteractivePortal(
      identity.role,
      identity.accountStatus,
      true,
    ) && isElevatedRole(identity.role),
    onRevoke,
    dependencies,
  });
}

type LongLivedAccessFailureReason = Extract<
  EstablishedLongLivedAccessResult,
  { ok: false }
>['reason'];

function socketAuthorizationError(reason: LongLivedAccessFailureReason): Error {
  if (reason === 'session_revoked') {
    return new Error('This sign-in session is no longer active');
  }
  if (reason === 'workspace_fenced') {
    return new Error('Workspace authorization is changing');
  }
  if (reason === 'authorization_changed') {
    return new Error('Authorization changed; sign in again');
  }
  return new Error('Account is not permitted for interactive access');
}

function webSocketAuthorizationStatus(reason: LongLivedAccessFailureReason): string {
  if (reason === 'session_revoked') return '401 Unauthorized';
  if (reason === 'workspace_fenced') return '409 Conflict';
  return '403 Forbidden';
}

/**
 * Complete a raw WebSocket/proxy upgrade without leaving an admission-to-close
 * cleanup gap. Gateway, Agent Browser, noVNC, and audio all use this exact seam.
 */
export function completeAuthorizedWebSocketUpgrade(input: {
  socket: AuthorizedWebSocketUpgradeSocket;
  authorize(onRevoke: TransportRevocationHandler): Promise<EstablishedLongLivedAccessResult>;
  onAuthorized(result: SuccessfulLongLivedAccessResult): void;
}): void {
  let revoked = false;
  const revokeTransport: TransportRevocationHandler = () => {
    revoked = true;
    input.socket.destroy();
  };

  void input.authorize(revokeTransport).then((result) => {
    if (!result.ok || revoked || input.socket.destroyed) {
      if (result.ok) result.dispose();
      if (!input.socket.destroyed) {
        const status = result.ok ? '403 Forbidden' : webSocketAuthorizationStatus(result.reason);
        input.socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      }
      input.socket.destroy();
      return;
    }

    try {
      input.socket.once('close', result.dispose);
      input.onAuthorized(result);
    } catch {
      result.dispose();
      input.socket.destroy();
    }
  }).catch(() => {
    if (!input.socket.destroyed) {
      input.socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    }
    input.socket.destroy();
  });
}

/** Actual Socket.IO namespace middleware used by every non-terminal namespace. */
export function createSocketAccessAuthorizationMiddleware(
  dependencies?: LongLivedAccessAuthorizationDependencies,
) {
  return (socket: any, next: (err?: Error) => void): void => {
    let token = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      const cookies = parseSafeCookieHeader(socket.handshake.headers?.cookie || '');
      token = cookies.accessToken;
    }
    if (!token || typeof token !== 'string') {
      next(new Error('Auth required'));
      return;
    }
    const payload = verifyAccessToken(token);
    if (!payload) {
      next(new Error('Invalid or expired token'));
      return;
    }

    const authorizationNamespace = socket.nsp?.name === '/authorization';
    const pendingEvents: AuthorizationChangedEvent[] = [];
    socket.data = socket.data || {};
    socket.data.authorizationPendingEvents = pendingEvents;
    socket.data.authorizationChangeRelay = null;

    // Revocation that lands while the authorization read is in flight must be
    // recorded explicitly. Socket.IO only sets `connected` in `_onconnect()`,
    // which runs *after* this middleware resolves, so `socket.disconnected` is
    // unconditionally true here and cannot be used to detect a torn-down
    // handshake.
    let revokedDuringHandshake = false;
    const disconnect = () => {
      revokedDuringHandshake = true;
      try {
        socket.disconnect(true);
      } catch {
        // The admission result still rejects a handshake being torn down.
      }
    };

    void establishLongLivedAccessAuthorization({
      payload,
      authorize: (identity) => canUseInteractivePortal(
        identity.role,
        identity.accountStatus,
        true,
      ),
      onRevoke: disconnect,
      onAuthorizationChanged: authorizationNamespace
        ? (event) => {
          const relay = socket.data.authorizationChangeRelay as
            | ((changed: AuthorizationChangedEvent) => void)
            | null
            | undefined;
          if (relay) relay(event);
          else pendingEvents.push(event);
        }
        : undefined,
      subscribeGlobalFence: !authorizationNamespace,
      dependencies,
    }).then((result) => {
      if (!result.ok) {
        next(socketAuthorizationError(result.reason));
        return;
      }
      if (revokedDuringHandshake || socket.conn?.readyState === 'closed') {
        result.dispose();
        next(new Error('Authorization changed during connection'));
        return;
      }
      socket.data.user = result.identity;
      socket.data.authorizationUnsubscribe = result.dispose;
      socket.conn?.once?.('close', result.dispose);
      socket.once?.('disconnect', result.dispose);
      next();
    }).catch((error) => next(error instanceof Error ? error : new Error('Authentication failed')));
  };
}
