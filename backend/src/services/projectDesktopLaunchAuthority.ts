import type { JwtPayload } from '../utils/jwt';
import { canUseDesktopRuntimeDeployment } from '../utils/authz';
import { commitUnderDurableAccessAuthorization } from './accessTokenAuthorization';
import { DesktopLaunchCancelledError, type DesktopDispatchGate } from './projectDesktopDeployment';

/**
 * Bind a Desktop host launch to the caller's current durable authority.
 *
 * The synchronous launch runs inside `commitUnderDurableAccessAuthorization`,
 * which holds the User and Session rows: a logout, expiry, credential or role
 * change that committed first denies the launch, and one that arrives later
 * waits for it. The caller's signal (long-lived revocation and workspace fence
 * subscriptions) is re-checked inside the same synchronous commit. Already
 * running apps are not stopped by this gate.
 */
export function durableDesktopDispatchGate(input: {
  payload: JwtPayload;
  signal: AbortSignal;
  onDenied(): void;
  database?: Parameters<typeof commitUnderDurableAccessAuthorization>[0]['database'];
}): DesktopDispatchGate {
  return async (launch) => {
    if (input.signal.aborted) throw new DesktopLaunchCancelledError();
    const result = await commitUnderDurableAccessAuthorization({
      payload: input.payload,
      database: input.database,
      authorize: identity => canUseDesktopRuntimeDeployment(identity.role, identity.accountStatus, undefined),
      commit: () => {
        if (input.signal.aborted) throw new DesktopLaunchCancelledError();
        launch();
      },
    });
    if (!result.ok) {
      input.onDenied();
      throw new DesktopLaunchCancelledError();
    }
  };
}
