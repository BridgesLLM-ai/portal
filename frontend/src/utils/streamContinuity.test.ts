import { describe, expect, it } from 'vitest';
import { latestTurnSequence, observeTurnSequence } from './streamContinuity';

describe('observeTurnSequence', () => {
  it('accepts a new baseline and contiguous events', () => {
    expect(observeTurnSequence(null, 40)).toEqual({ nextSequence: 40, gap: null, disposition: 'apply' });
    expect(observeTurnSequence(40, 41)).toEqual({ nextSequence: 41, gap: null, disposition: 'apply' });
  });

  it('quarantines a forward gap without advancing the accepted cursor', () => {
    expect(observeTurnSequence(40, 47)).toEqual({
      nextSequence: 40,
      gap: { from: 41, to: 46 },
      disposition: 'gap',
    });
  });

  it('drops duplicates and out-of-order replay frames', () => {
    expect(observeTurnSequence(40, 40)).toEqual({ nextSequence: 40, gap: null, disposition: 'drop' });
    expect(observeTurnSequence(40, 39)).toEqual({ nextSequence: 40, gap: null, disposition: 'drop' });
  });

  it('requires an explicit transport reset before accepting sequence one again', () => {
    expect(observeTurnSequence(800, 1)).toEqual({ nextSequence: 800, gap: null, disposition: 'drop' });
    expect(observeTurnSequence(null, 1)).toEqual({ nextSequence: 1, gap: null, disposition: 'apply' });
  });

  it('ignores malformed sequence values', () => {
    expect(observeTurnSequence(40, '41')).toEqual({ nextSequence: 40, gap: null, disposition: 'drop' });
    expect(observeTurnSequence(40, -1)).toEqual({ nextSequence: 40, gap: null, disposition: 'drop' });
  });

  it('seeds reconnect continuity from a coalesced resume window', () => {
    const resumedAt = latestTurnSequence([
      { seq: 311 },
      { seq: 318 },
      { seq: 870 },
      { seq: '871' },
    ]);

    expect(resumedAt).toBe(870);
    expect(observeTurnSequence(resumedAt, 871)).toEqual({ nextSequence: 871, gap: null, disposition: 'apply' });
    expect(observeTurnSequence(871, 875)).toEqual({
      nextSequence: 871,
      gap: { from: 872, to: 874 },
      disposition: 'gap',
    });
  });

  it('holds accelerated events behind a missing frame until an authoritative reseed', () => {
    let sequence: number | null = null;
    for (let incoming = 1; incoming <= 414; incoming += 1) {
      const observation = observeTurnSequence(sequence, incoming);
      sequence = observation.nextSequence;
    }

    expect(observeTurnSequence(sequence, 416)).toEqual({
      nextSequence: 414,
      gap: { from: 415, to: 415 },
      disposition: 'gap',
    });
    expect(observeTurnSequence(sequence, 417)).toEqual({
      nextSequence: 414,
      gap: { from: 415, to: 416 },
      disposition: 'gap',
    });

    sequence = latestTurnSequence([{ seq: 415 }, { seq: 416 }, { seq: 417 }]);
    for (let incoming = 418; incoming <= 870; incoming += 1) {
      const observation = observeTurnSequence(sequence, incoming);
      expect(observation.disposition).toBe('apply');
      sequence = observation.nextSequence;
    }
    expect(sequence).toBe(870);
  });
});
