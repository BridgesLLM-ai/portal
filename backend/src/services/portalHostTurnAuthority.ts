import { AsyncLocalStorage } from 'async_hooks';
import { isOpenClawSessionScopedToAnotherUser, classifyOpenClawSessionLane } from '../agents/openclawSessionOwnership';
import { isElevatedRole } from '../utils/authz';
import type { OpenClawHostRunHandle } from './openClawHostRunJournal';

interface Scope { handle: OpenClawHostRunHandle; active: boolean; consumed: boolean }
const current = new AsyncLocalStorage<Scope>();

/** Called only after the Portal Host route's actor/session/model admission and
 * durable run journal. The route retains its authorization-generation lease
 * through settlement. Nothing in a browser request or native tool can mint this
 * in-process capability; Project dispatch does not enter this wrapper. */
export async function withPortalHostTurnAuthority<T>(handle: OpenClawHostRunHandle, role: unknown,
  operation: () => Promise<T>): Promise<T> {
  if (!isElevatedRole(typeof role === 'string' ? role : undefined)
    || handle.executionScope !== 'HOST_OPERATOR' || handle.provider !== 'OPENCLAW'
    || !handle.actorUserId || !handle.id || !Number.isSafeInteger(handle.actorAuthorizationVersion)
    || handle.actorAuthorizationVersion < 1 || !/^agent:[^:]+:.+/.test(handle.sessionKey)
    || /^agent:(?:p4oc-|portal(?:-|:))/i.test(handle.sessionKey)
    || classifyOpenClawSessionLane(handle.sessionKey) !== 'direct'
    || isOpenClawSessionScopedToAnotherUser(handle.sessionKey, handle.actorUserId)) {
    throw new Error('Portal Host requester authority is unavailable');
  }
  const scope: Scope = { handle: Object.freeze({ ...handle }), active: true, consumed: false };
  try { return await current.run(scope, operation); }
  finally { scope.active = false; }
}

/** One exact owned rich socket may retain this check, not generic RPC or a
 * reconnect. Native still authenticates the signed device/scopes and decides
 * whether its actual network/client provenance permits creation. */
export function consumePortalHostTurnAuthority(sessionKey: string): () => void {
  const scope = current.getStore();
  if (!scope?.active || scope.consumed || scope.handle.sessionKey !== sessionKey)
    throw new Error('Portal Host requester authority is unavailable');
  scope.consumed = true;
  return () => {
    if (!scope.active || scope.handle.sessionKey !== sessionKey)
      throw new Error('Portal Host requester authority expired');
  };
}
