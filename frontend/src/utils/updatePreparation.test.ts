import { describe, expect, it, vi } from 'vitest';
import {
  createFreshBackupForUpdate,
  describeUpdateBackup,
  waitForExpectedPortalVersion,
  type UpdateBackupReadiness,
} from './updatePreparation';

const fresh: UpdateBackupReadiness = {
  state: 'fresh',
  maxAgeHours: 24,
  newestCreatedAt: '2026-07-20T20:00:30.000Z',
  ageHours: 0,
  activeStatus: null,
};

describe('update backup preparation', () => {
  it('waits for a new fresh archive before allowing the update to continue', async () => {
    const progress = vi.fn();
    const getBackupStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'completed' });
    const getBackupReadiness = vi.fn().mockResolvedValue(fresh);

    await expect(createFreshBackupForUpdate({
      startDailyBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus,
      getBackupReadiness,
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 3,
      onProgress: progress,
    })).resolves.toEqual(fresh);

    expect(getBackupStatus).toHaveBeenCalledTimes(2);
    expect(getBackupReadiness).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith('Creating and verifying the fresh backup…');
  });

  it('waits on an already-running backup instead of starting a competing run', async () => {
    const conflict = Object.assign(new Error('busy'), {
      response: { status: 409, data: { status: 'running' } },
    });
    await expect(createFreshBackupForUpdate({
      startDailyBackup: vi.fn().mockRejectedValue(conflict),
      getBackupStatus: vi.fn().mockResolvedValue({ status: 'completed' }),
      getBackupReadiness: vi.fn().mockResolvedValue(fresh),
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 1,
    })).resolves.toEqual(fresh);
  });

  it('fails closed when backup creation fails or never yields a new archive', async () => {
    await expect(createFreshBackupForUpdate({
      startDailyBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus: vi.fn().mockResolvedValue({ status: 'failed', error: 'Archive verification failed' }),
      getBackupReadiness: vi.fn(),
    }, { delay: async () => {}, maxAttempts: 1 })).rejects.toThrow('Archive verification failed');

    await expect(createFreshBackupForUpdate({
      startDailyBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus: vi.fn().mockResolvedValue({ status: 'completed' }),
      getBackupReadiness: vi.fn().mockResolvedValue({
        ...fresh,
        newestCreatedAt: '2026-07-19T20:00:00.000Z',
      }),
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 1,
    })).rejects.toThrow('update was not started');
  });

  it('turns backend readiness into concise user-facing copy', () => {
    expect(describeUpdateBackup(fresh)).toMatchObject({ tone: 'good', label: 'Recent backup ready' });
    expect(describeUpdateBackup({ ...fresh, state: 'stale', ageHours: 72 })).toEqual({
      tone: 'warning',
      label: 'Backup is stale',
      detail: 'The latest Portal backup is 3 days old. The update safety window is 24 hours.',
    });
    expect(describeUpdateBackup({ ...fresh, state: 'missing', newestCreatedAt: null, ageHours: null })).toMatchObject({
      label: 'No backup found',
    });
  });

  it('accepts only the exact expected Portal version after an updater restart', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ version: '4.0.0' })
      .mockRejectedValueOnce(new Error('Portal restarting'))
      .mockResolvedValueOnce({ version: '4.0.0' })
      .mockResolvedValueOnce({ version: '4.1.0' });

    await expect(waitForExpectedPortalVersion('4.1.0', {
      probe,
      delay: async () => {},
      initialDelayMs: 0,
      pollIntervalMs: 0,
      maxAttempts: 4,
    })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('does not mistake recovery on the previous version for update success', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ version: '4.0.0' })
      .mockRejectedValueOnce(new Error('Portal restarting'))
      .mockResolvedValue({ version: '4.0.0' });

    await expect(waitForExpectedPortalVersion('4.1.0', {
      probe,
      delay: async () => {},
      initialDelayMs: 0,
      pollIntervalMs: 0,
      maxAttempts: 4,
    })).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
