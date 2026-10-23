const SESSION_KEY_PATTERN = /^agent:[A-Za-z0-9_-]+:[^\u0000-\u001f\u007f]{1,1980}$/;
const SIGNAL_GROUP_ID_PATTERN = /(^|:)signal:group:([^:]+)/gi;
const MATRIX_ROOM_KEY_PATTERN = /^(?:(?:agent:[^:]*:)+:*)?matrix:(?:channel|group):/i;
function isValidOpenClawSessionKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 2_048
    && SESSION_KEY_PATTERN.test(value);
}

/**
 * The exact form OpenClaw 2026.9.6 stores, returns and resets for a session key
 * (its normalizeSessionKeyPreservingOpaquePeerIds): trimmed and lowercased,
 * except Signal group ids and Matrix room/thread ids, which keep their case.
 */
export function openClawStoredSessionKey(rawSessionKey: string): string {
  const key = rawSessionKey.trim();
  const folded = key.toLowerCase();
  if (!folded.includes('signal:') && !folded.includes('matrix:')) return folded;
  const spans: Array<{ start: number; end: number; trim: boolean }> = [];
  for (const match of key.matchAll(SIGNAL_GROUP_ID_PATTERN)) {
    const segment = match[2] ?? '';
    const start = (match.index ?? 0) + match[0].length - segment.length;
    spans.push({ start, end: start + segment.length, trim: true });
  }
  const room = MATRIX_ROOM_KEY_PATTERN.exec(key);
  if (room && room[0].length < key.length) {
    const tailStart = room[0].length;
    const thread = key.slice(tailStart).toLowerCase().lastIndexOf(':thread:');
    if (thread === -1) {
      spans.push({ start: tailStart, end: key.length, trim: false });
    } else {
      spans.push({ start: tailStart, end: tailStart + thread, trim: false });
      if (tailStart + thread + 8 < key.length) spans.push({ start: tailStart + thread + 8, end: key.length, trim: false });
    }
  }
  let stored = '';
  let cursor = 0;
  for (const span of spans.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue;
    stored += key.slice(cursor, span.start).trim().toLowerCase();
    const preserved = key.slice(span.start, span.end);
    stored += span.trim ? preserved.trim() : preserved;
    cursor = span.end;
  }
  return stored + key.slice(cursor).trim().toLowerCase();
}

/** Whether OpenClaw keeps this agent-qualified host key byte-for-byte. */
export function isGatewayNormalizedHostSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:.+$/.test(sessionKey) && openClawStoredSessionKey(sessionKey) === sessionKey;
}

/**
 * The exact host session identity form every durable OpenClaw claim must use:
 * the key OpenClaw itself keeps, so a reset returns the same key (B536-ALIAS-02).
 */
export function isCanonicalOpenClawSessionKey(value: unknown): value is string {
  return isValidOpenClawSessionKey(value) && isGatewayNormalizedHostSessionKey(value);
}
