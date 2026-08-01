import {
  DEFAULT_METRICS_HISTORY_HOURS,
  MAX_METRICS_HISTORY_HOURS,
  parseMetricsHistoryHours,
} from './metricsHistory';

describe('metrics history bounds', () => {
  it('uses the default for missing and malformed values', () => {
    expect(parseMetricsHistoryHours(undefined)).toBe(DEFAULT_METRICS_HISTORY_HOURS);
    expect(parseMetricsHistoryHours('nope')).toBe(DEFAULT_METRICS_HISTORY_HOURS);
  });

  it('clamps requests to a finite supported window', () => {
    expect(parseMetricsHistoryHours('0')).toBe(1);
    expect(parseMetricsHistoryHours('3.9')).toBe(3);
    expect(parseMetricsHistoryHours('999999')).toBe(MAX_METRICS_HISTORY_HOURS);
  });
});
