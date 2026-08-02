/**
 * Ownership rules for OpenClaw session keys.
 *
 * Two distinct questions live here, and conflating them is what made
 * host-created sessions invisible in Agent Chat:
 *
 *  1. Is this key *self-describing* — does the key itself name the Portal user
 *     it belongs to (`agent:<agent>:portal-<userId>…`)? Those keys are safe to
 *     claim on first use because the key cannot be forged into another user's
 *     namespace without already knowing that user's id, and the claim is then
 *     durable.
 *
 *  2. Is this key merely *unscoped* — created outside the Portal by the host
 *     operator (OpenClaw web UI, CLI, a `dashboard:` lane)? Those carry no
 *     user id at all. Portal 4.0 refused them outright, which is correct for
 *     ordinary accounts but wrong for the OWNER: on a self-hosted install the
 *     OWNER *is* the host operator and already controls the gateway, its
 *     transcripts, and the filesystem underneath both. Hiding their own
 *     sessions from them protects nothing and loses their chat history.
 *
 * The invariant that must never move: a key scoped to a *different* Portal user
 * is off limits to everybody, OWNER included.
 */

const PORTAL_ACTOR_PATTERN =
  /^agent:[^:]+:portal-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/i;

/** Portal user id embedded in a self-describing session key, if any. */
export function openClawSessionActorId(rawSessionKey: string): string | null {
  const sessionKey = String(rawSessionKey || '').trim();
  return PORTAL_ACTOR_PATTERN.exec(sessionKey)?.[1]?.toLowerCase() || null;
}

/** True when the key names this exact actor. */
export function isOpenClawSessionActorScopedTo(
  rawSessionKey: string,
  rawActorUserId: string,
): boolean {
  const sessionKey = String(rawSessionKey || '').trim();
  const actorUserId = String(rawActorUserId || '').trim();
  if (!sessionKey || !actorUserId) return false;
  const sessionName = /^agent:[^:]+:(.+)$/.exec(sessionKey)?.[1] || '';
  return sessionName === `portal-${actorUserId}`
    || sessionName.startsWith(`portal-${actorUserId}-`);
}

/** True when the key names some *other* Portal user. Never adoptable. */
export function isOpenClawSessionScopedToAnotherUser(
  rawSessionKey: string,
  rawActorUserId: string,
): boolean {
  const embeddedActorId = openClawSessionActorId(rawSessionKey);
  if (!embeddedActorId) return false;
  return embeddedActorId !== String(rawActorUserId || '').trim().toLowerCase();
}

/**
 * Classify a session lane the way OpenClaw itself does, from the key namespace.
 *
 * The `kind` field on the `sessions.list` RPC cannot be used for this: it
 * reports `direct` for cron lanes too, because it describes the chat type
 * rather than the lane. OpenClaw's own `classifySessionKind` derives the lane
 * from the key, and mirroring that keeps this in step with upstream instead of
 * inventing a second, divergent notion of what a conversation is.
 */
export type OpenClawSessionLane = 'cron' | 'subagent' | 'group' | 'direct';

export function classifyOpenClawSessionLane(
  rawSessionKey: string,
  session?: { chatType?: unknown },
): OpenClawSessionLane {
  const key = String(rawSessionKey || '').trim();
  const rest = /^agent:[^:]+:(.+)$/.exec(key)?.[1]?.toLowerCase() || key.toLowerCase();
  if (rest.startsWith('cron:')) return 'cron';
  if (rest.startsWith('subagent:')) return 'subagent';
  const chatType = String(session?.chatType || '').toLowerCase();
  if (chatType === 'group' || chatType === 'channel') return 'group';
  if (key.includes(':group:') || key.includes(':channel:')) return 'group';
  return 'direct';
}

/** Only real conversations belong in Agent Chat. */
export const HOST_ADOPTABLE_SESSION_LANE: OpenClawSessionLane = 'direct';

export function isHostAdoptableOpenClawSession(
  session: { key?: unknown; chatType?: unknown },
  actorUserId: string,
): boolean {
  const key = String(session?.key || '').trim();
  if (!key) return false;
  if (classifyOpenClawSessionLane(key, session) !== HOST_ADOPTABLE_SESSION_LANE) return false;
  return !isOpenClawSessionScopedToAnotherUser(key, actorUserId);
}
