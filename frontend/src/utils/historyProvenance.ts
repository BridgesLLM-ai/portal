/** Runtime provenance, never message text, distinguishes synthetic user turns. */
export function isInternalHistoryUser(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const row = message as { role?: unknown; provenance?: unknown };
  if (row.role !== 'user' || !row.provenance || typeof row.provenance !== 'object') return false;
  return (row.provenance as { kind?: unknown }).kind === 'internal_system';
}

/** Ambiguous legacy user text is authored text; do not strip quoted envelopes. */
export function authoredHistoryText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}
