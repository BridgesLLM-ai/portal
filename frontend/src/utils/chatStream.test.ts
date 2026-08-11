import { describe, expect, it } from 'vitest';
import {
  createGraduatedThinkingSnapshotTracker,
  markThinkingSnapshotGraduated,
  mergeAssistantStream,
  mergeThinkingStream,
  projectThinkingChunkAfterGraduation,
  reconcileCumulativeFinalTail,
  resetGraduatedThinkingSnapshotTracker,
  seedGraduatedThinkingSnapshot,
} from './chatStream';

describe('long-running stream merges', () => {
  it('does not duplicate cumulative thinking snapshots', () => {
    let current = '';
    let expected = '';

    for (let index = 0; index < 2_000; index += 1) {
      expected += `token-${index} `;
      current = mergeThinkingStream(current, expected, { replace: true });
    }

    expect(current).toBe(expected);
  });

  it('keeps repeated short token deltas', () => {
    let current = '';
    for (let index = 0; index < 2_000; index += 1) {
      current = mergeThinkingStream(current, 'a');
    }
    expect(current).toHaveLength(2_000);
  });

  it('keeps repeated short assistant deltas', () => {
    expect(mergeAssistantStream('the', 'the')).toBe('thethe');
    expect(mergeAssistantStream('a', 'a')).toBe('aa');
    expect(mergeAssistantStream('a', 'ab')).toBe('aab');
    expect(mergeThinkingStream('a', 'ab')).toBe('aab');
  });

  it('keeps repeated phrase and overlapping deltas verbatim', () => {
    let assistant = '';
    let thinking = '';
    for (let index = 0; index < 80; index += 1) {
      assistant = mergeAssistantStream(assistant, 'test 123');
      thinking = mergeThinkingStream(thinking, 'test 123');
    }
    expect(assistant).toBe('test 123'.repeat(80));
    expect(thinking).toBe('test 123'.repeat(80));
    expect(mergeAssistantStream('abcabc', 'abcabc')).toBe('abcabcabcabc');
    expect(mergeThinkingStream('overlap', 'lap again')).toBe('overlaplap again');
  });

  it('replaces a cumulative assistant snapshot without quadratic growth', () => {
    let current = '';
    let expected = '';

    for (let index = 0; index < 2_000; index += 1) {
      expected += `${index},`;
      current = mergeAssistantStream(current, expected, { replace: true });
    }

    expect(current).toBe(expected);
  });

  it('keeps only the new tail of a multi-tool cumulative final', () => {
    expect(reconcileCumulativeFinalTail(
      ['Before tool one. ', 'Between tools. '],
      'Before tool one. Between tools. Final answer.',
    )).toBe('Final answer.');
    expect(reconcileCumulativeFinalTail(
      ['Before tool one.', 'Between tools.'],
      'Before tool one.\n\nBetween tools.',
    )).toBe('');
    expect(reconcileCumulativeFinalTail(
      ['Before tool one.'],
      'Independent final answer.',
    )).toBe('Independent final answer.');
  });

  it('projects only new reasoning after each tool boundary in a cumulative run', () => {
    const tracker = createGraduatedThinkingSnapshotTracker();

    expect(projectThinkingChunkAfterGraduation(tracker, 'raw', 'Inspecting files', true))
      .toBe('Inspecting files');
    markThinkingSnapshotGraduated(tracker, 'raw');
    expect(projectThinkingChunkAfterGraduation(
      tracker,
      'raw',
      'Inspecting files\n\nRunning tests',
      true,
    )).toBe('Running tests');
    markThinkingSnapshotGraduated(tracker, 'raw');
    expect(projectThinkingChunkAfterGraduation(
      tracker,
      'raw',
      'Inspecting files\n\nRunning tests\n\nReviewing output',
      true,
    )).toBe('Reviewing output');
  });

  it('keeps raw and attested preamble snapshots independent and accepts provider resets', () => {
    const tracker = createGraduatedThinkingSnapshotTracker();
    seedGraduatedThinkingSnapshot(tracker, 'raw', 'Raw private summary');
    seedGraduatedThinkingSnapshot(tracker, 'preamble', 'Visible preamble');

    expect(projectThinkingChunkAfterGraduation(
      tracker,
      'preamble',
      'Visible preamble\n\nChecking the build',
      true,
    )).toBe('Checking the build');
    expect(projectThinkingChunkAfterGraduation(
      tracker,
      'raw',
      'A corrected independent summary',
      true,
    )).toBe('A corrected independent summary');

    resetGraduatedThinkingSnapshotTracker(tracker);
    expect(projectThinkingChunkAfterGraduation(tracker, 'raw', 'Fresh run', true))
      .toBe('Fresh run');
  });

  it('does not let a delayed baseline snapshot forget newer deltas', () => {
    const tracker = createGraduatedThinkingSnapshotTracker();
    seedGraduatedThinkingSnapshot(tracker, 'raw', 'Finished inspection');

    expect(projectThinkingChunkAfterGraduation(tracker, 'raw', '\nRunning tests', false))
      .toBe('\nRunning tests');
    expect(projectThinkingChunkAfterGraduation(tracker, 'raw', 'Finished inspection', true))
      .toBe('');
    markThinkingSnapshotGraduated(tracker, 'raw');

    expect(projectThinkingChunkAfterGraduation(
      tracker,
      'raw',
      'Finished inspection\nRunning tests\nReviewing output',
      true,
    )).toBe('Reviewing output');
  });

  it('projects the novel tail when a bounded cumulative window evicts old reasoning', () => {
    const tracker = createGraduatedThinkingSnapshotTracker();
    const entries = Array.from({ length: 66 }, (_, index) => (
      `Reasoning entry ${String(index).padStart(2, '0')}: ${'x'.repeat(40)}.`
    ));
    const firstWindow = entries.slice(0, 64).join('\n\n');
    const shiftedWindow = entries.slice(2, 66).join('\n\n');

    expect(projectThinkingChunkAfterGraduation(tracker, 'preamble', firstWindow, true))
      .toBe(firstWindow);
    markThinkingSnapshotGraduated(tracker, 'preamble');
    expect(projectThinkingChunkAfterGraduation(tracker, 'preamble', shiftedWindow, true))
      .toBe(entries.slice(64).join('\n\n'));
  });

  it('does not strip a weak coincidental overlap from a provider reset', () => {
    const tracker = createGraduatedThinkingSnapshotTracker();
    seedGraduatedThinkingSnapshot(tracker, 'raw', `${'old '.repeat(80)}shared ending`);
    const reset = `shared ending — but this is an independent corrected snapshot`;
    expect(projectThinkingChunkAfterGraduation(tracker, 'raw', reset, true)).toBe(reset);
  });
});
