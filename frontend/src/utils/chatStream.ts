export function stripOpenClawReplyTags(text: string): string {
  if (!text) return text;
  const stripped = text.replace(
    /\[\[\s*(?:reply_to_current|reply_to|reply_to_message|reply_to_user|route_to|delegate_to)\b[^\]]*\]\]/gi,
    '',
  );
  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CONTROL_ONLY_ASSISTANT_OUTPUTS = new Set([
  'HEARTBEAT_OK',
  'NO_REPLY',
]);

function normalizeAssistantControlCandidate(text: string): string {
  return stripOpenClawReplyTags(text || '').replace(/\r\n/g, '\n');
}

function stripAssistantControlLines(text: string, trimResult: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized) return normalized;
  const filtered = normalized
    .split('\n')
    .filter((line) => !CONTROL_ONLY_ASSISTANT_OUTPUTS.has(line.trim().toUpperCase()))
    .join('\n');

  if (!trimResult) return filtered;
  return filtered
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeAssistantContent(text: string): string {
  return stripAssistantControlLines(stripOpenClawReplyTags(text || ''), true);
}

export function isControlOnlyAssistantContent(text: string): boolean {
  const normalized = normalizeAssistantControlCandidate(text || '');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => CONTROL_ONLY_ASSISTANT_OUTPUTS.has(line.toUpperCase()));
}

// Streaming-safe sanitization for live OpenClaw chunks.
// Important: do NOT trim here, because some providers emit whitespace as
// standalone delta tokens. Trimming per chunk collapses words together during
// live rendering, while full-history refresh still looks correct.
export function sanitizeAssistantChunk(text: string): string {
  if (!text) return text;
  const withoutReplyTags = text.replace(
    /\[\[\s*(?:reply_to_current|reply_to|reply_to_message|reply_to_user|route_to|delegate_to)\b[^\]]*\]\]/gi,
    '',
  );
  return stripAssistantControlLines(withoutReplyTags, false);
}

export function mergeAssistantStream(
  current: string,
  incoming?: string,
  opts?: { replace?: boolean },
): string {
  const chunk = typeof incoming === 'string' ? incoming : '';
  if (!chunk) return current;
  if (opts?.replace) return chunk;
  // Stream semantics come from the transport, not the text. Providers mark
  // cumulative snapshots with `replace`; every other event is a delta. Content
  // heuristics corrupt legitimate repeated output (for example, "test 123"
  // emitted hundreds of times) and overlapping code/text fragments.
  return current + chunk;
}

export function mergeThinkingStream(
  current: string,
  incoming?: string,
  opts?: { replace?: boolean },
): string {
  const chunk = typeof incoming === 'string' ? incoming : '';
  if (!chunk) return current;
  if (opts?.replace) return chunk;
  if (!current) return chunk;
  const normalizedCurrent = current.trim().toLowerCase();
  const normalizedChunk = chunk.trim().toLowerCase();
  if ((normalizedCurrent === 'thinking…' || normalizedCurrent === 'thinking...')
    && normalizedChunk !== normalizedCurrent) {
    return chunk;
  }
  return current + chunk;
}

export type ThinkingSnapshotLane = 'raw' | 'preamble' | 'status';

export interface GraduatedThinkingSnapshotTracker {
  latest: Partial<Record<ThinkingSnapshotLane, string>>;
  graduated: Partial<Record<ThinkingSnapshotLane, string>>;
}

export function createGraduatedThinkingSnapshotTracker(): GraduatedThinkingSnapshotTracker {
  return { latest: {}, graduated: {} };
}

export function resetGraduatedThinkingSnapshotTracker(
  tracker: GraduatedThinkingSnapshotTracker,
): void {
  tracker.latest = {};
  tracker.graduated = {};
}

const MAX_THINKING_SNAPSHOT_OVERLAP_CHARS = 64 * 1024;
const MIN_THINKING_SNAPSHOT_OVERLAP_CHARS = 128;
const MIN_THINKING_SNAPSHOT_OVERLAP_RATIO = 0.6;

function longestSuffixPrefixOverlap(left: string, right: string): number {
  const candidateLength = Math.min(
    left.length,
    right.length,
    MAX_THINKING_SNAPSHOT_OVERLAP_CHARS,
  );
  if (!candidateLength) return 0;

  const pattern = right.slice(0, candidateLength);
  const searchableTail = left.slice(-candidateLength);
  const fallback = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = fallback[matched - 1];
    if (pattern[index] === pattern[matched]) matched += 1;
    fallback[index] = matched;
  }

  let matched = 0;
  for (let index = 0; index < searchableTail.length; index += 1) {
    const character = searchableTail[index];
    while (matched > 0 && character !== pattern[matched]) matched = fallback[matched - 1];
    if (character === pattern[matched]) matched += 1;
    if (matched === pattern.length && index < searchableTail.length - 1) {
      matched = fallback[matched - 1];
    }
  }
  return matched;
}

function highConfidenceSlidingSnapshotOverlap(baseline: string, incoming: string): number {
  const overlap = longestSuffixPrefixOverlap(baseline, incoming);
  const comparableLength = Math.min(
    baseline.length,
    incoming.length,
    MAX_THINKING_SNAPSHOT_OVERLAP_CHARS,
  );
  if (
    overlap < MIN_THINKING_SNAPSHOT_OVERLAP_CHARS
    || comparableLength === 0
    || overlap / comparableLength < MIN_THINKING_SNAPSHOT_OVERLAP_RATIO
  ) return 0;
  return overlap;
}

/**
 * Provider `replace` reasoning frames are often cumulative for the entire run,
 * not merely for the bubble currently on screen. Once a tool/text boundary has
 * graduated the visible prefix, a later cumulative frame must project only the
 * new suffix or every old thought is repeated in the next bubble.
 */
export function projectThinkingChunkAfterGraduation(
  tracker: GraduatedThinkingSnapshotTracker,
  lane: ThinkingSnapshotLane,
  incoming: string,
  replace = false,
): string {
  if (!incoming) return '';

  if (!replace) {
    tracker.latest[lane] = `${tracker.latest[lane] || ''}${incoming}`;
    return incoming;
  }

  const previousLatest = tracker.latest[lane] || '';
  const graduated = tracker.graduated[lane] || '';
  if (!graduated) {
    tracker.latest[lane] = incoming;
    return incoming;
  }
  if (incoming === graduated) {
    // A delayed baseline snapshot must not roll back append-style reasoning
    // that already arrived after that baseline.
    if (!(previousLatest.startsWith(incoming) && previousLatest.length > incoming.length)) {
      tracker.latest[lane] = incoming;
    }
    return '';
  }
  if (incoming.startsWith(graduated)) {
    tracker.latest[lane] = incoming;
    return incoming.slice(graduated.length).trimStart();
  }

  // OpenClaw bounds long preamble histories by evicting their oldest items.
  // The next replace frame is then a sliding cumulative window rather than a
  // strict prefix extension. A large suffix/prefix overlap is the only safe
  // evidence that the overlapping text was already graduated.
  const slidingOverlap = highConfidenceSlidingSnapshotOverlap(graduated, incoming);
  if (slidingOverlap > 0) {
    tracker.latest[lane] = incoming;
    return incoming.slice(slidingOverlap).trimStart();
  }

  // The provider reset/corrected its snapshot instead of extending it. The new
  // value is authoritative, and the old run prefix must not suppress it.
  tracker.latest[lane] = incoming;
  tracker.graduated[lane] = '';
  return incoming;
}

export function markThinkingSnapshotGraduated(
  tracker: GraduatedThinkingSnapshotTracker,
  lane: ThinkingSnapshotLane | null,
): void {
  if (!lane) return;
  const latest = tracker.latest[lane];
  if (typeof latest === 'string') tracker.graduated[lane] = latest;
}

export function seedGraduatedThinkingSnapshot(
  tracker: GraduatedThinkingSnapshotTracker,
  lane: ThinkingSnapshotLane,
  snapshot: string,
): void {
  if (!snapshot) return;
  tracker.latest[lane] = snapshot;
  tracker.graduated[lane] = snapshot;
}

/**
 * Remove text already represented by graduated pre/tool/post segments from a
 * cumulative provider final. Returns only the genuinely new terminal tail.
 * If the final is not a cumulative mirror, it is returned unchanged.
 */
export function reconcileCumulativeFinalTail(
  graduatedText: readonly string[],
  rawFinalContent: string,
): string {
  const finalContent = String(rawFinalContent || '');
  const represented = graduatedText.filter((value) => String(value || '').trim());
  if (!finalContent || represented.length === 0) return finalContent;

  let cursor = 0;
  let matched = 0;
  for (const value of represented) {
    const text = String(value || '');
    const index = finalContent.indexOf(text, cursor);
    if (index < 0 || finalContent.slice(cursor, index).trim()) {
      matched = 0;
      break;
    }
    cursor = index + text.length;
    matched += 1;
  }
  if (matched === represented.length) {
    return finalContent.slice(cursor).replace(/^\s+/, '');
  }

  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const representedComparable = normalize(represented.join(''));
  const finalComparable = normalize(finalContent);
  if (!representedComparable) return finalContent;
  if (finalComparable === representedComparable) return '';
  if (finalComparable.startsWith(`${representedComparable} `)) {
    return finalComparable.slice(representedComparable.length).trimStart();
  }
  return finalContent;
}

const GENERIC_THINKING_PLACEHOLDER_RE = /^(?:🧠\s*)?(?:agent is thinking|thinking)(?:\s*(?:\.|…|\.\.\.))*$/i;

export function extractThinkingChunk(
  eventType: string | undefined,
  content: unknown,
  hasAssistantText: boolean,
): string {
  const text = typeof content === 'string' ? content : '';
  if (!text) return '';

  const cleaned = text.trim().toLowerCase();
  if (!cleaned || GENERIC_THINKING_PLACEHOLDER_RE.test(cleaned)) return '';

  if (eventType === 'thinking') return text;
  if (eventType !== 'status') return '';
  if (!cleaned) return '';
  if (
    cleaned.includes('using tool') ||
    cleaned.includes('tool completed') ||
    cleaned.includes('waiting for command approval') ||
    cleaned.includes('compacting context') ||
    cleaned.includes('context compacted') ||
    cleaned.includes('reconnecting')
  ) {
    return '';
  }

  if (cleaned.startsWith('🧠')) return text;
  return hasAssistantText ? '' : text;
}
