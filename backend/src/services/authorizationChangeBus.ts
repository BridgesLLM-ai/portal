export type AuthorizationChangeReason =
  | 'role'
  | 'account_status'
  | 'active_status'
  | 'workspace_scope'
  | 'credential_recovery';

export interface AuthorizationChangedEvent {
  type: 'authorization_changed';
  userId: string;
  authorizationVersion: number;
  reasons: AuthorizationChangeReason[];
}

type AuthorizationChangeListener = (event: AuthorizationChangedEvent) => void;

const listenersByUser = new Map<string, Set<AuthorizationChangeListener>>();

export function subscribeToAuthorizationChanges(
  userId: string,
  listener: AuthorizationChangeListener,
): () => void {
  let listeners = listenersByUser.get(userId);
  if (!listeners) {
    listeners = new Set();
    listenersByUser.set(userId, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = listenersByUser.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByUser.delete(userId);
  };
}

export function publishAuthorizationChanged(event: AuthorizationChangedEvent): void {
  const listeners = listenersByUser.get(event.userId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One disconnected browser must not prevent the other sessions from
      // receiving the revocation signal.
    }
  }
}

export function authorizationChangeSubscriberCount(userId?: string): number {
  if (userId) return listenersByUser.get(userId)?.size || 0;
  let count = 0;
  for (const listeners of listenersByUser.values()) count += listeners.size;
  return count;
}
