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
  if (!current) return chunk;
  if (chunk === current) return current;
  if (chunk.startsWith(current)) return chunk;
  if (current.endsWith(chunk)) return current;
  if (current.includes(chunk)) return current;

  const maxOverlap = Math.min(current.length, chunk.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (current.slice(-overlap) === chunk.slice(0, overlap)) {
      return current + chunk.slice(overlap);
    }
  }
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
  if (chunk === current) return current;
  if (chunk.startsWith(current)) return chunk;
  if (current.startsWith(chunk)) return current;

  const maxOverlap = Math.min(current.length, chunk.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (current.slice(-overlap) === chunk.slice(0, overlap)) {
      return current + chunk.slice(overlap);
    }
  }

  return current + chunk;
}

export function extractThinkingChunk(
  eventType: string | undefined,
  content: unknown,
  hasAssistantText: boolean,
): string {
  const text = typeof content === 'string' ? content : '';
  if (!text) return '';
  if (eventType === 'thinking') return text;
  if (eventType !== 'status') return '';

  const cleaned = text.trim().toLowerCase();
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

  if (cleaned.includes('thinking') || cleaned.startsWith('🧠')) return text;
  return hasAssistantText ? '' : text;
}
