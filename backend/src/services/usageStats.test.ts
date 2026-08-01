import {
  buildUsageStatsPayload,
  isValidUsageAgentFilter,
  normalizeUsageCronJobsPayload,
  normalizeUsageSessionsPayload,
  normalizeUsageTimestamp,
} from './usageStats';

describe('usage statistics normalization', () => {
  const now = Date.parse('2026-07-19T16:00:00.000Z');
  const normalizeModel = (value: unknown) => String(value || '').toLowerCase();

  it('normalizes ISO, second, millisecond, and higher precision timestamps', () => {
    expect(normalizeUsageTimestamp('2026-07-19T15:30:00.000Z')).toBe(Date.parse('2026-07-19T15:30:00.000Z'));
    expect(normalizeUsageTimestamp(1_752_940_800)).toBe(1_752_940_800_000);
    expect(normalizeUsageTimestamp(1_752_940_800_000)).toBe(1_752_940_800_000);
    expect(normalizeUsageTimestamp(1_752_940_800_000_000)).toBe(1_752_940_800_000);
    expect(normalizeUsageTimestamp('not-a-date')).toBeNull();
  });

  it('builds a stable payload without mutating the source sessions', () => {
    const sessions = [
      { key: 'older', agentId: 'main', model: 'Model-B', updatedAt: '2026-07-19T14:00:00.000Z', turns: '3' },
      { key: 'newer', agentId: 'main', model: 'Model-A', lastActivityMs: now - 30_000, turns: 2 },
      { key: '', agentId: 'other', model: 'Model-A', updatedAt: now - 10_000 },
      { key: 'future', agentId: 'main', model: 'Model-A', updatedAt: now + 60_000 },
    ];
    const originalOrder = sessions.map((session) => session.key);

    const payload = buildUsageStatsPayload(sessions, [{ agentId: 'main', enabled: true }], 'main', normalizeModel, now);

    expect(sessions.map((session) => session.key)).toEqual(originalOrder);
    expect(payload).toMatchObject({ totalSessions: 3, activeSessions: 1, cronJobs: 1, activeCrons: 1 });
    expect(payload.recentSessions.map((session) => session.key)).toEqual(['future', 'newer', 'older']);
    expect(payload.recentSessions[1]).toMatchObject({ lastActivity: now - 30_000, turns: 2 });
    expect(payload.modelBreakdown).toEqual([
      { model: 'model-a', sessions: 2 },
      { model: 'model-b', sessions: 1 },
    ]);
    expect(payload.recentSessions[2].turns).toBe(3);
  });

  it('keeps unknown turn counts honest and attaches agent ids from grouped payloads', () => {
    const sessions = normalizeUsageSessionsPayload({
      agents: {
        work: { sessions: [{ key: 'work-session', model: 'Model-A' }] },
      },
    });
    const payload = buildUsageStatsPayload(sessions, [], 'work', normalizeModel, now);

    expect(payload.recentSessions).toEqual([
      expect.objectContaining({ key: 'work-session', agent: 'work', turns: null }),
    ]);
    expect(normalizeUsageCronJobsPayload({ data: { jobs: [{ id: 'job' }] } })).toEqual([{ id: 'job' }]);
    expect(normalizeUsageSessionsPayload({ unexpected: [] })).toBeNull();
  });

  it('rejects unbounded or path-like cache keys', () => {
    expect(isValidUsageAgentFilter('main')).toBe(true);
    expect(isValidUsageAgentFilter('project-agent:42')).toBe(true);
    expect(isValidUsageAgentFilter('../main')).toBe(false);
    expect(isValidUsageAgentFilter('x'.repeat(129))).toBe(false);
    expect(isValidUsageAgentFilter('')).toBe(false);
  });
});
