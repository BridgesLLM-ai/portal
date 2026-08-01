import { calculateCpuUsage, parseCpuStat } from './cpuStat';

describe('CPU interval sampling', () => {
  it('calculates utilization from deltas rather than lifetime counters', () => {
    const previous = parseCpuStat([
      'cpu  100 0 100 800 0 0 0 0 0 0',
      'cpu0 50 0 50 400 0 0 0 0 0 0',
    ].join('\n'));
    const current = parseCpuStat([
      'cpu  140 0 140 820 0 0 0 0 0 0',
      'cpu0 70 0 70 410 0 0 0 0 0 0',
    ].join('\n'));

    expect(calculateCpuUsage(previous, current)).toEqual({
      overall: 80,
      perCore: [{ core: 0, usage: 80 }],
    });
  });

  it('fails safely when samples are absent or unchanged', () => {
    const empty = parseCpuStat('not proc stat');
    const unchanged = parseCpuStat('cpu 1 0 1 8 0 0 0 0 0 0');
    expect(calculateCpuUsage(empty, empty)).toEqual({ overall: 0, perCore: [] });
    expect(calculateCpuUsage(unchanged, unchanged).overall).toBe(0);
  });

  it('does not double-count guest time already included in user ticks', () => {
    const snapshot = parseCpuStat('cpu 100 20 30 400 10 5 5 10 80 10');
    expect(snapshot.overall).toEqual({ idle: 410, total: 580 });
  });
});
