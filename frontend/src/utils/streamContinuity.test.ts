import { describe, expect, it } from 'vitest';
import { latestTurnSequence, observeTurnSequence } from './streamContinuity';

describe('observeTurnSequence', () => {
  it('accepts a new baseline and contiguous events', () => {
    expect(observeTurnSequence(null, 40)).toEqual({ nextSequence: 40, gap: null });
    expect(observeTurnSequence(40, 41)).toEqual({ nextSequence: 41, gap: null });
  });

  it('reports a forward gap for automatic history reconciliation', () => {
    expect(observeTurnSequence(40, 47)).toEqual({
      nextSequence: 47,
      gap: { from: 41, to: 46 },
    });
  });

  it('ignores duplicates and out-of-order replay frames', () => {
    expect(observeTurnSequence(40, 40)).toEqual({ nextSequence: 40, gap: null });
    expect(observeTurnSequence(40, 39)).toEqual({ nextSequence: 40, gap: null });
  });

  it('recognizes a backend sequence reset', () => {
    expect(observeTurnSequence(800, 1)).toEqual({ nextSequence: 1, gap: null });
  });

  it('ignores malformed sequence values', () => {
    expect(observeTurnSequence(40, '41')).toEqual({ nextSequence: 40, gap: null });
    expect(observeTurnSequence(40, -1)).toEqual({ nextSequence: 40, gap: null });
  });

  it('seeds reconnect continuity from a coalesced resume window', () => {
    const resumedAt = latestTurnSequence([
      { seq: 311 },
      { seq: 318 },
      { seq: 870 },
      { seq: '871' },
    ]);

    expect(resumedAt).toBe(870);
    expect(observeTurnSequence(resumedAt, 871)).toEqual({ nextSequence: 871, gap: null });
    expect(observeTurnSequence(871, 875)).toEqual({
      nextSequence: 875,
      gap: { from: 872, to: 874 },
    });
  });

  it('detects one dropped frame in an accelerated 870-event turn', () => {
    let sequence: number | null = null;
    const gaps: Array<{ from: number; to: number }> = [];
    for (let incoming = 1; incoming <= 870; incoming += 1) {
      if (incoming === 415) continue;
      const observation = observeTurnSequence(sequence, incoming);
      sequence = observation.nextSequence;
      if (observation.gap) gaps.push(observation.gap);
    }

    expect(sequence).toBe(870);
    expect(gaps).toEqual([{ from: 415, to: 415 }]);
  });
});
