export interface CpuTicks {
  idle: number;
  total: number;
}

export interface CpuSnapshot {
  overall: CpuTicks | null;
  perCore: Map<number, CpuTicks>;
}

export function parseCpuStat(stat: string): CpuSnapshot {
  const snapshot: CpuSnapshot = { overall: null, perCore: new Map() };
  for (const line of stat.split('\n')) {
    if (!/^cpu(?:\d+)?\s/.test(line)) continue;
    const [label, ...rawParts] = line.trim().split(/\s+/);
    const parts = rawParts.map(Number);
    if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) continue;
    const ticks = {
      idle: parts[3] + (parts[4] || 0),
      // guest and guest_nice are already included in user/nice on Linux and
      // would be double-counted if every exported column were summed.
      total: parts.slice(0, 8).reduce((sum, value) => sum + value, 0),
    };
    if (label === 'cpu') snapshot.overall = ticks;
    else snapshot.perCore.set(Number(label.slice(3)), ticks);
  }
  return snapshot;
}

function usageBetween(previous: CpuTicks | undefined | null, current: CpuTicks | undefined | null): number {
  if (!previous || !current) return 0;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta) || totalDelta <= 0) return 0;
  const usage = ((totalDelta - Math.max(0, idleDelta)) / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, usage)) * 10) / 10;
}

export function calculateCpuUsage(previous: CpuSnapshot, current: CpuSnapshot) {
  return {
    overall: usageBetween(previous.overall, current.overall),
    perCore: Array.from(current.perCore.entries())
      .sort(([left], [right]) => left - right)
      .map(([core, ticks]) => ({ core, usage: usageBetween(previous.perCore.get(core), ticks) })),
  };
}
