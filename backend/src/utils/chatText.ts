export function stripEnvelope(text: string): string {
  if (!text) return text;
  const timestampPattern = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,4}\]\s*/;
  const match = text.match(timestampPattern);
  if (match && match.index !== undefined) {
    const beforeTimestamp = text.substring(0, match.index);
    if (
      beforeTimestamp.includes('Conversation info (untrusted metadata)') ||
      beforeTimestamp.includes('Sender (untrusted metadata)')
    ) {
      return text.substring(match.index + match[0].length).trim();
    }
  }
  return text;
}

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

export function sanitizeAssistantText(text: string): string {
  const cleaned = stripOpenClawReplyTags(stripEnvelope(text || ''));
  // Strip NO_REPLY / HEARTBEAT_OK silent tokens
  const trimmed = cleaned.trim();
  if (trimmed === 'NO_REPLY' || trimmed === 'HEARTBEAT_OK') return '';
  // Strip NO_REPLY prefix (agent sometimes adds it before real content)
  return cleaned.replace(/^\s*NO_REPLY\s*\n?/, '').replace(/^\s*HEARTBEAT_OK\s*\n?/, '');
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return sanitizeAssistantText(content);
  if (Array.isArray(content)) {
    const joined = (content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    return sanitizeAssistantText(joined);
  }
  return '';
}
