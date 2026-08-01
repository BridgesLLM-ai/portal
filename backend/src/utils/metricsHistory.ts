export const DEFAULT_METRICS_HISTORY_HOURS = 6;
export const MAX_METRICS_HISTORY_HOURS = 168;
export const MAX_METRICS_HISTORY_POINTS = 1440;

export function parseMetricsHistoryHours(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_METRICS_HISTORY_HOURS;
  return Math.min(MAX_METRICS_HISTORY_HOURS, Math.max(1, Math.floor(parsed)));
}
