import type { Metrics } from '../types';

export const DASHBOARD_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
export const MAX_DASHBOARD_HISTORY_POINTS = 360;

export function mergeDashboardMetricHistory(
  current: Metrics[],
  incoming: Metrics[],
  now = Date.now(),
): Metrics[] {
  const cutoff = now - DASHBOARD_HISTORY_WINDOW_MS;
  const byTimestamp = new Map<number, Metrics>();

  for (const metric of [...current, ...incoming]) {
    const timestamp = new Date(metric?.timestamp).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= cutoff || timestamp > now + 60_000) continue;
    byTimestamp.set(timestamp, metric);
  }

  const sorted = Array.from(byTimestamp.entries())
    .sort(([left], [right]) => left - right)
    .map(([, metric]) => metric);
  if (sorted.length <= MAX_DASHBOARD_HISTORY_POINTS) return sorted;

  const result: Metrics[] = [];
  const lastIndex = sorted.length - 1;
  for (let index = 0; index < MAX_DASHBOARD_HISTORY_POINTS; index += 1) {
    const sourceIndex = Math.round((index * lastIndex) / (MAX_DASHBOARD_HISTORY_POINTS - 1));
    result.push(sorted[sourceIndex]);
  }
  return result;
}
