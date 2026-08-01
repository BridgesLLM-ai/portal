import { describe, expect, it } from 'vitest';
import { formatUsageRelativeTime } from './usage';

describe('usage relative time', () => {
  const now = 1_800_000_000_000;

  it('formats valid timestamps and contains future clock skew', () => {
    expect(formatUsageRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatUsageRelativeTime(now - 90_000, now)).toBe('1m ago');
    expect(formatUsageRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatUsageRelativeTime(now + 60_000, now)).toBe('just now');
  });

  it('renders absent or invalid timestamps as unavailable', () => {
    expect(formatUsageRelativeTime(null, now)).toBe('—');
    expect(formatUsageRelativeTime(Number.NaN, now)).toBe('—');
  });
});
