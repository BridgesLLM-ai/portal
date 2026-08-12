export type SessionRevocationReason =
  | 'logout'
  | 'expired'
  | 'account_blocked'
  | 'credential_change'
  | 'credential_recovery'
  | 'account_reactivation'
  | 'authorization_transition';

export interface SessionRevocationEvent {
  type: 'session_revoked';
  userId: string;
  /** Null means every durable session belonging to the user. */
  sessionId: string | null;
  reason: SessionRevocationReason;
}

type SessionRevocationListener = (event: SessionRevocationEvent) => void;

interface SessionRevocationSubscription {
  sessionId: string | null;
  listener: SessionRevocationListener;
}

const subscriptionsByUser = new Map<string, Set<SessionRevocationSubscription>>();

/**
 * Subscribe a long-lived authority before its durable-session lookup begins.
 * Exact revocations reach only the matching session. User-wide revocations also
 * reach legacy access tokens, which intentionally have no stable session id.
 */
export function subscribeToSessionRevocations(
  userId: string,
  sessionId: string | null,
  listener: SessionRevocationListener,
): () => void {
  const subscription: SessionRevocationSubscription = { sessionId, listener };
  let subscriptions = subscriptionsByUser.get(userId);
  if (!subscriptions) {
    subscriptions = new Set();
    subscriptionsByUser.set(userId, subscriptions);
  }
  subscriptions.add(subscription);

  return () => {
    const current = subscriptionsByUser.get(userId);
    if (!current) return;
    current.delete(subscription);
    if (current.size === 0) subscriptionsByUser.delete(userId);
  };
}

export function publishSessionRevoked(input: {
  userId: string;
  sessionId: string;
  reason: SessionRevocationReason;
}): void {
  publish({
    type: 'session_revoked',
    userId: input.userId,
    sessionId: input.sessionId,
    reason: input.reason,
  });
}

export function publishAllSessionsRevoked(input: {
  userId: string;
  reason: SessionRevocationReason;
}): void {
  publish({
    type: 'session_revoked',
    userId: input.userId,
    sessionId: null,
    reason: input.reason,
  });
}

function publish(event: SessionRevocationEvent): void {
  const subscriptions = subscriptionsByUser.get(event.userId);
  if (!subscriptions) return;
  for (const subscription of [...subscriptions]) {
    // A legacy access JWT predates stable Session claims, so its transport
    // cannot prove that it belongs to a different sibling Session. Conservatively
    // retire legacy authorities on any exact revocation for the user while
    // preserving modern sibling sessions with a different stable id.
    if (
      event.sessionId !== null
      && subscription.sessionId !== null
      && subscription.sessionId !== event.sessionId
    ) continue;
    try {
      subscription.listener(event);
    } catch {
      // One broken transport teardown must not prevent sibling authorities from
      // observing the same durable revocation commit.
    }
  }
}

export function sessionRevocationSubscriberCount(userId?: string): number {
  if (userId) return subscriptionsByUser.get(userId)?.size || 0;
  let count = 0;
  for (const subscriptions of subscriptionsByUser.values()) count += subscriptions.size;
  return count;
}
