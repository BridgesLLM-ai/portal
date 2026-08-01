export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

export interface BracketedPasteState {
  active: boolean;
  buffer: string;
  pendingMarker: string;
}

export interface BracketedPasteChunkResult {
  state: BracketedPasteState;
  ordinaryData: string;
  completedPastes: string[];
  events: Array<{ type: 'ordinary' | 'paste'; data: string }>;
}

export type TerminalPasteDecision =
  | { kind: 'ignore'; value: '' }
  | { kind: 'insert'; value: string }
  | { kind: 'confirm'; value: string };

export interface FlushedLooseTerminalPaste {
  remaining: '';
  raw: string;
  decision: TerminalPasteDecision;
}

export function createBracketedPasteState(): BracketedPasteState {
  return { active: false, buffer: '', pendingMarker: '' };
}

function markerPrefixSuffixLength(value: string, marker: string): number {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

/**
 * Parse xterm's bracketed-paste protocol as a stream. Markers and payloads may
 * arrive in arbitrary chunks, including chunks that split the marker itself.
 */
export function consumeBracketedPasteChunk(
  previous: BracketedPasteState,
  data: string,
): BracketedPasteChunkResult {
  let active = previous.active;
  let buffer = previous.buffer;
  let cursor = previous.pendingMarker + data;
  let pendingMarker = '';
  let ordinaryData = '';
  const completedPastes: string[] = [];
  const events: Array<{ type: 'ordinary' | 'paste'; data: string }> = [];

  const appendOrdinary = (value: string) => {
    if (!value) return;
    ordinaryData += value;
    const last = events[events.length - 1];
    if (last?.type === 'ordinary') last.data += value;
    else events.push({ type: 'ordinary', data: value });
  };

  while (cursor.length > 0) {
    const marker = active ? BRACKETED_PASTE_END : BRACKETED_PASTE_START;
    const markerIndex = cursor.indexOf(marker);
    if (markerIndex >= 0) {
      const beforeMarker = cursor.slice(0, markerIndex);
      if (active) {
        buffer += beforeMarker;
        completedPastes.push(buffer);
        events.push({ type: 'paste', data: buffer });
        buffer = '';
      } else {
        appendOrdinary(beforeMarker);
      }
      active = !active;
      cursor = cursor.slice(markerIndex + marker.length);
      continue;
    }

    const pendingLength = markerPrefixSuffixLength(cursor, marker);
    const completeData = pendingLength > 0 ? cursor.slice(0, -pendingLength) : cursor;
    pendingMarker = pendingLength > 0 ? cursor.slice(-pendingLength) : '';
    if (active) buffer += completeData;
    else appendOrdinary(completeData);
    cursor = '';
  }

  return {
    state: { active, buffer, pendingMarker },
    ordinaryData,
    completedPastes,
    events,
  };
}

export function sanitizeTerminalPaste(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function decideTerminalPaste(currentInput: string, paste: string): TerminalPasteDecision {
  const sanitized = sanitizeTerminalPaste(paste);
  if (/[\r\n]/.test(sanitized)) {
    const command = `${currentInput}${sanitized}`.trim();
    if (command) return { kind: 'confirm', value: command };
  }
  if (sanitized) return { kind: 'insert', value: sanitized };
  return { kind: 'ignore', value: '' };
}

export function appendLooseTerminalPaste(buffer: string, chunk: string): string {
  return buffer + chunk;
}

export function flushLooseTerminalPaste(buffer: string, currentInput: string): FlushedLooseTerminalPaste {
  return {
    remaining: '',
    raw: buffer,
    decision: decideTerminalPaste(currentInput, buffer),
  };
}
