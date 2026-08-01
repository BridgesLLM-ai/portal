import {
  checkForUpdatesWithCooldown,
  resetUpdateCheckCooldownForTests,
} from './telemetryService';

const status = (latest: string | null) => ({
  current: '4.0.0',
  latest,
  updateAvailable: latest !== null,
  details: null,
  detailsStatus: 'unavailable' as const,
});

describe('dashboard update-check cooldown', () => {
  beforeEach(() => {
    resetUpdateCheckCooldownForTests();
  });

  test('first view executes the live check and stamps checkedAt', async () => {
    const checkImpl = jest.fn().mockResolvedValue(status('4.1.0'));
    const statusImpl = jest.fn().mockResolvedValue(status('4.1.0'));
    const result = await checkForUpdatesWithCooldown(false, {
      checkImpl,
      statusImpl,
      nowImpl: () => 1_000_000,
    });
    expect(checkImpl).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.checkedAt).toBe(1_000_000);
  });

  test('views inside the cooldown replay the cached result with zero executions', async () => {
    const checkImpl = jest.fn().mockResolvedValue(status('4.1.0'));
    const statusImpl = jest.fn().mockResolvedValue(status('4.1.0'));
    let now = 1_000_000;
    await checkForUpdatesWithCooldown(false, { checkImpl, statusImpl, nowImpl: () => now });
    now += 5 * 60_000;
    const second = await checkForUpdatesWithCooldown(false, { checkImpl, statusImpl, nowImpl: () => now });
    expect(checkImpl).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.checkedAt).toBe(1_000_000);
    expect(statusImpl).toHaveBeenCalledTimes(1);
  });

  test('a view after the cooldown expires re-executes the live check', async () => {
    const checkImpl = jest.fn().mockResolvedValue(status('4.1.0'));
    let now = 1_000_000;
    await checkForUpdatesWithCooldown(false, { checkImpl, nowImpl: () => now });
    now += 16 * 60_000;
    const result = await checkForUpdatesWithCooldown(false, { checkImpl, nowImpl: () => now });
    expect(checkImpl).toHaveBeenCalledTimes(2);
    expect(result.cached).toBe(false);
  });

  test('the per-check refresh button (force) bypasses only the cooldown, not the single-flight', async () => {
    const checkImpl = jest.fn().mockResolvedValue(status('4.1.0'));
    let now = 1_000_000;
    await checkForUpdatesWithCooldown(false, { checkImpl, nowImpl: () => now });
    now += 1_000;
    const forced = await checkForUpdatesWithCooldown(true, { checkImpl, nowImpl: () => now });
    expect(checkImpl).toHaveBeenCalledTimes(2);
    expect(forced.cached).toBe(false);
    expect(forced.checkedAt).toBe(now);
  });

  test('concurrent views share one in-flight execution', async () => {
    let release: (value: ReturnType<typeof status>) => void = () => {};
    const gate = new Promise<ReturnType<typeof status>>((resolve) => { release = resolve; });
    const checkImpl = jest.fn().mockReturnValue(gate);
    const first = checkForUpdatesWithCooldown(false, { checkImpl });
    const second = checkForUpdatesWithCooldown(false, { checkImpl });
    release(status('4.1.0'));
    const [a, b] = await Promise.all([first, second]);
    expect(checkImpl).toHaveBeenCalledTimes(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
  });

  test('a failed live check falls back to the cached status instead of throwing', async () => {
    const checkImpl = jest.fn().mockRejectedValue(new Error('telemetry down'));
    const statusImpl = jest.fn().mockResolvedValue(status(null));
    const result = await checkForUpdatesWithCooldown(true, { checkImpl, statusImpl });
    expect(result.latest).toBeNull();
    expect(statusImpl).toHaveBeenCalledTimes(1);
  });
});
