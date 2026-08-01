import { describe, expect, it } from 'vitest';
import {
  mergeAssistantStream,
  mergeThinkingStream,
  reconcileCumulativeFinalTail,
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
});
