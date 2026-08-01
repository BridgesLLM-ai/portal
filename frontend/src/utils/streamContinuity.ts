export interface TurnSequenceObservation {
  nextSequence: number | null;
  gap: { from: number; to: number } | null;
}

export function latestTurnSequence(events: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    const sequence = event && typeof event === 'object'
      ? (event as { seq?: unknown }).seq
      : null;
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > (latest || 0)) {
      latest = sequence;
    }
  }
  return latest;
}

/**
 * Observe the Portal's monotonic runtime-turn sequence. Duplicate and
 * out-of-order replay frames are harmless; a forward jump means the browser
 * missed live events and should reconcile from durable history.
 */
export function observeTurnSequence(
  previousSequence: number | null,
  incomingSequence: unknown,
): TurnSequenceObservation {
  const sequence = typeof incomingSequence === 'number' && Number.isSafeInteger(incomingSequence) && incomingSequence > 0
    ? incomingSequence
    : null;
  if (sequence === null) return { nextSequence: previousSequence, gap: null };
  if (previousSequence === null) return { nextSequence: sequence, gap: null };

  // The Portal process can restart while the browser remains open. Its in-memory
  // sequence then restarts at one; that is a new baseline, not a 1→N gap.
  if (sequence === 1 && previousSequence > 1) {
    return { nextSequence: sequence, gap: null };
  }
  if (sequence <= previousSequence) {
    return { nextSequence: previousSequence, gap: null };
  }
  if (sequence === previousSequence + 1) {
    return { nextSequence: sequence, gap: null };
  }

  return {
    nextSequence: sequence,
    gap: { from: previousSequence + 1, to: sequence - 1 },
  };
}
