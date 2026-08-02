import { describe, expect, it } from 'vitest';
import {
  createPreambleProgressAccumulator,
  mergePreambleProgressSnapshot,
} from './preambleProgress';

describe('mergePreambleProgressSnapshot', () => {
  it('replaces cumulative token snapshots instead of creating one title per token', () => {
    const state = createPreambleProgressAccumulator();
    expect(mergePreambleProgressSnapshot(state, { runId: 'run-1', text: 'Inspect' })).toBe('Inspect');
    expect(mergePreambleProgressSnapshot(state, { runId: 'run-1', text: 'Inspect every' })).toBe('Inspect every');
    expect(mergePreambleProgressSnapshot(state, { runId: 'run-1', text: 'Inspect every file' })).toBe('Inspect every file');
    expect(state.order).toEqual(['__current__']);
  });

  it('keeps distinct item identities ordered and resets for a new run', () => {
    const state = createPreambleProgressAccumulator();
    mergePreambleProgressSnapshot(state, { runId: 'run-1', itemId: 'a', text: 'First item' });
    expect(mergePreambleProgressSnapshot(state, { runId: 'run-1', itemId: 'b', text: 'Second item' }))
      .toBe('First item\n\nSecond item');
    expect(mergePreambleProgressSnapshot(state, { runId: 'run-2', itemId: 'c', text: 'Fresh run' }))
      .toBe('Fresh run');
  });
});
