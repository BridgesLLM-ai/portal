import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../api/agentJobs';
import { mergeBoundedTranscript } from './AgentChatsPage';

function entry(index: number): TranscriptEntry {
  return {
    type: 'output',
    stream: 'stdout',
    text: `line-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

describe('Agent Chat retained transcript window', () => {
  it('deduplicates snapshot/live overlap without dropping later live output', () => {
    expect(mergeBoundedTranscript(
      [entry(1), entry(2)],
      [entry(2), entry(3)],
    ).map((item) => item.text)).toEqual(['line-1', 'line-2', 'line-3']);
  });

  it('bounds multi-hour rendered output while keeping the newest entries', () => {
    const merged = mergeBoundedTranscript(Array.from({ length: 2500 }, (_, index) => entry(index)));
    expect(merged).toHaveLength(2000);
    expect(merged[0].text).toBe('line-500');
    expect(merged.at(-1)?.text).toBe('line-2499');
  });
});
