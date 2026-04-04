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

export function sanitizeAssistantContent(text: string): string {
  const cleaned = stripOpenClawReplyTags(text || '');
  // Strip NO_REPLY / HEARTBEAT_OK silent tokens
  const trimmed = cleaned.trim();
  if (trimmed === 'NO_REPLY' || trimmed === 'HEARTBEAT_OK') return '';
  return cleaned.replace(/^\s*NO_REPLY\s*\n?/, '').replace(/^\s*HEARTBEAT_OK\s*\n?/, '');
}

// Streaming-safe sanitization for live OpenClaw chunks.
// Important: do NOT trim here, because some providers emit whitespace as
// standalone delta tokens. Trimming per chunk collapses words together during
// live rendering, while full-history refresh still looks correct.
export function sanitizeAssistantChunk(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[\[\s*(?:reply_to_current|reply_to|reply_to_message|reply_to_user|route_to|delegate_to)\b[^\]]*\]\]/gi,
    '',
  );
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
