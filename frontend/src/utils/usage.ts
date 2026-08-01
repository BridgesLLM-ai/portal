export function formatUsageRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
