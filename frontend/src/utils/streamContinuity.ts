export interface TurnSequenceObservation {
  nextSequence: number | null;
  gap: { from: number; to: number } | null;
  disposition: 'apply' | 'drop' | 'gap';
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
 * Observe the Portal's monotonic runtime-turn sequence. Duplicate and stale
 * replay frames must be dropped before they mutate the visible timeline. A
 * forward jump is quarantined without advancing the accepted cursor while
 * durable history repairs the missing interval. Transport reconnection resets
 * the baseline explicitly at the call site.
 */
export function observeTurnSequence(
  previousSequence: number | null,
  incomingSequence: unknown,
): TurnSequenceObservation {
  const sequence = typeof incomingSequence === 'number' && Number.isSafeInteger(incomingSequence) && incomingSequence > 0
    ? incomingSequence
    : null;
  if (sequence === null) return { nextSequence: previousSequence, gap: null, disposition: 'drop' };
  if (previousSequence === null) return { nextSequence: sequence, gap: null, disposition: 'apply' };

  if (sequence <= previousSequence) {
    return { nextSequence: previousSequence, gap: null, disposition: 'drop' };
  }
  if (sequence === previousSequence + 1) {
    return { nextSequence: sequence, gap: null, disposition: 'apply' };
  }

  return {
    nextSequence: previousSequence,
    gap: { from: previousSequence + 1, to: sequence - 1 },
    disposition: 'gap',
  };
}
