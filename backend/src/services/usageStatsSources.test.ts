import {
  loadUsageStatsSources,
  UsageStatsUnavailableError,
  type UsageStatsSourceDependencies,
} from './usageStatsSources';

function dependencies(
  overrides: Partial<UsageStatsSourceDependencies> = {},
): UsageStatsSourceDependencies {
  return {
    agentsDir: '/agents',
    gatewayCall: async () => ({ ok: false }),
    runOpenClaw: async () => { throw new Error('CLI unavailable'); },
    readDir: async () => { throw new Error('store unavailable'); },
    readFile: async () => { throw new Error('store unavailable'); },
    ...overrides,
  };
}

describe('usage statistics sources', () => {
  it('paginates Gateway sessions and cron jobs without invoking fallbacks', async () => {
    const gatewayCall = jest.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.list') {
        return Number(params.offset) === 0
          ? { ok: true, data: { sessions: [{ key: 'one' }], hasMore: true, nextOffset: 1 } }
          : { ok: true, data: { sessions: [{ key: 'two' }], hasMore: false } };
      }
      return Number(params.offset) === 0
        ? { ok: true, data: { jobs: [{ id: 'cron-one', enabled: true }], hasMore: true, nextOffset: 1 } }
        : { ok: true, data: { jobs: [{ id: 'cron-two', enabled: false }], hasMore: false } };
    });
    const runOpenClaw = jest.fn(async () => { throw new Error('fallback should not run'); });

    const result = await loadUsageStatsSources('main', dependencies({ gatewayCall, runOpenClaw }));

    expect(result.sessions.map((session) => session.key)).toEqual(['one', 'two']);
    expect(result.cronJobs.map((job) => job.id)).toEqual(['cron-one', 'cron-two']);
    expect(gatewayCall).toHaveBeenCalledWith('sessions.list', expect.objectContaining({
      agentId: 'main',
      limit: 200,
    }), 10_000);
    expect(gatewayCall).toHaveBeenCalledWith('cron.list', expect.objectContaining({
      agentId: 'main',
      limit: 200,
    }), 10_000);
    for (const [method, params] of gatewayCall.mock.calls) {
      if (method === 'sessions.list') {
        expect(params).not.toHaveProperty('activeMinutes');
      }
    }
    expect(runOpenClaw).not.toHaveBeenCalled();
  });

  it('uses asynchronous stored sessions and requests complete CLI cron data', async () => {
    const runOpenClaw = jest.fn(async (args: string[]) => {
      expect(args).toEqual(['cron', 'list', '--json', '--all']);
      return JSON.stringify({ jobs: [{ id: 'disabled', enabled: false }] });
    });
    const result = await loadUsageStatsSources('', dependencies({
      runOpenClaw,
      readDir: async () => ['main'],
      readFile: async () => JSON.stringify({ stored: { key: 'stored', model: 'model-a' } }),
    }));

    expect(result.sessions).toEqual([expect.objectContaining({ key: 'stored', agentId: 'main' })]);
    expect(result.cronJobs).toEqual([{ id: 'disabled', enabled: false }]);
  });

  it('requests the unbounded CLI session list when Gateway and disk are unavailable', async () => {
    const runOpenClaw = jest.fn(async (args: string[]) => {
      if (args[0] === 'sessions') {
        expect(args).toEqual(['sessions', '--json', '--limit', 'all', '--agent', 'work']);
        return JSON.stringify({ sessions: [] });
      }
      return JSON.stringify({ jobs: [] });
    });

    await expect(loadUsageStatsSources('work', dependencies({ runOpenClaw }))).resolves.toEqual({
      sessions: [],
      cronJobs: [],
    });
  });

  it('fails closed instead of reporting zero when every source is unavailable', async () => {
    await expect(loadUsageStatsSources('', dependencies())).rejects.toEqual(
      expect.objectContaining<Partial<UsageStatsUnavailableError>>({ statusCode: 503 }),
    );
  });
});
