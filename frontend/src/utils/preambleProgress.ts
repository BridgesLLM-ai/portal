export interface PreambleProgressAccumulator {
  runId: string;
  order: string[];
  textByItem: Map<string, string>;
}

export function createPreambleProgressAccumulator(): PreambleProgressAccumulator {
  return { runId: '', order: [], textByItem: new Map() };
}

/** Merge one cumulative OpenClaw item.preamble snapshot into one live block. */
export function mergePreambleProgressSnapshot(
  state: PreambleProgressAccumulator,
  input: { runId?: string | null; itemId?: string | null; text: string },
): string {
  const text = String(input.text || '');
  if (!text) return '';
  const runId = String(input.runId || 'unknown');
  if (state.runId && state.runId !== runId) {
    state.order = [];
    state.textByItem.clear();
  }
  state.runId = runId;

  const itemId = String(input.itemId || '').trim() || '__current__';
  if (!state.textByItem.has(itemId)) state.order.push(itemId);
  state.textByItem.set(itemId, text);
  return state.order
    .map((id) => state.textByItem.get(id) || '')
    .filter(Boolean)
    .join('\n\n');
}
