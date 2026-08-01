import { describe, expect, it } from 'vitest';
import type { Metrics } from '../types';
import {
  MAX_DASHBOARD_HISTORY_POINTS,
  mergeDashboardMetricHistory,
} from './dashboardMetrics';

function metric(timestamp: number, cpuUsage: number): Metrics {
  return {
    id: String(timestamp),
    timestamp: new Date(timestamp).toISOString(),
    cpuUsage,
    memoryUsage: 0,
    memoryTotal: BigInt(0),
    diskUsage: 0,
    diskTotal: BigInt(0),
    networkIn: BigInt(0),
    networkOut: BigInt(0),
    processCount: 0,
    loadAverage: [],
  };
}

describe('dashboard metric history', () => {
  const now = Date.parse('2026-07-19T16:00:00.000Z');

  it('deduplicates timestamps and drops stale, invalid, and future points', () => {
    const timestamp = now - 60_000;
    const result = mergeDashboardMetricHistory(
      [metric(timestamp, 1), metric(now - 7 * 60 * 60 * 1000, 2)],
      [metric(timestamp, 9), { ...metric(now, 3), timestamp: 'invalid' }, metric(now + 120_000, 4)],
      now,
    );

    expect(result).toHaveLength(1);
    expect(result[0].cpuUsage).toBe(9);
  });

  it('keeps a bounded, ordered sample including both ends of the window', () => {
    const points = Array.from({ length: 1000 }, (_, index) => metric(now - (1000 - index) * 10_000, index));
    const result = mergeDashboardMetricHistory([], points, now);

    expect(result).toHaveLength(MAX_DASHBOARD_HISTORY_POINTS);
    expect(new Date(result[0].timestamp).getTime()).toBe(new Date(points[0].timestamp).getTime());
    expect(new Date(result.at(-1)!.timestamp).getTime()).toBe(new Date(points.at(-1)!.timestamp).getTime());
  });
});
