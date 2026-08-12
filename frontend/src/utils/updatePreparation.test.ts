import { describe, expect, it, vi } from 'vitest';
import {
  createFreshBackupForUpdate,
  describeUpdateBackup,
  waitForExpectedPortalVersion,
  type UpdateBackupReadiness,
} from './updatePreparation';

const candidate: UpdateBackupReadiness = {
  state: 'candidate',
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
    const getBackupReadiness = vi.fn().mockResolvedValue(candidate);

    await expect(createFreshBackupForUpdate({
      startComprehensiveBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus,
      getBackupReadiness,
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 3,
      onProgress: progress,
    })).resolves.toEqual(candidate);

    expect(getBackupStatus).toHaveBeenCalledTimes(2);
    expect(getBackupReadiness).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith('Creating and verifying the comprehensive recovery backup…');
  });

  it('waits on an already-running backup instead of starting a competing run', async () => {
    const conflict = Object.assign(new Error('busy'), {
      response: { status: 409, data: { status: 'running' } },
    });
    await expect(createFreshBackupForUpdate({
      startComprehensiveBackup: vi.fn().mockRejectedValue(conflict),
      getBackupStatus: vi.fn().mockResolvedValue({ status: 'completed' }),
      getBackupReadiness: vi.fn().mockResolvedValue(candidate),
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 1,
    })).resolves.toEqual(candidate);
  });

  it('tolerates bounded Portal downtime while the comprehensive backup holds the recovery fence', async () => {
    const progress = vi.fn();
    const getBackupStatus = vi.fn()
      .mockRejectedValueOnce(new Error('Portal intentionally paused'))
      .mockResolvedValueOnce({ status: 'completed' })
      .mockResolvedValueOnce({ status: 'completed' });
    const getBackupReadiness = vi.fn()
      .mockRejectedValueOnce(new Error('Portal still restarting'))
      .mockResolvedValueOnce(candidate);

    await expect(createFreshBackupForUpdate({
      startComprehensiveBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus,
      getBackupReadiness,
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 3,
      onProgress: progress,
    })).resolves.toEqual(candidate);

    expect(progress).toHaveBeenCalledWith('Portal is paused while the recovery backup is captured…');
    expect(progress).toHaveBeenCalledWith('Backup finished. Waiting for Portal readiness verification…');
    expect(getBackupStatus).toHaveBeenCalledTimes(3);
    expect(getBackupReadiness).toHaveBeenCalledTimes(2);
  });

  it('fails closed when backup creation fails or never yields a new archive', async () => {
    await expect(createFreshBackupForUpdate({
      startComprehensiveBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus: vi.fn().mockResolvedValue({ status: 'failed', error: 'Archive verification failed' }),
      getBackupReadiness: vi.fn(),
    }, { delay: async () => {}, maxAttempts: 1 })).rejects.toThrow('Archive verification failed');

    await expect(createFreshBackupForUpdate({
      startComprehensiveBackup: vi.fn().mockResolvedValue({ status: 'queued' }),
      getBackupStatus: vi.fn().mockResolvedValue({ status: 'completed' }),
      getBackupReadiness: vi.fn().mockResolvedValue({
        ...candidate,
        newestCreatedAt: '2026-07-19T20:00:00.000Z',
      }),
    }, {
      now: () => Date.parse('2026-07-20T20:00:00.000Z'),
      delay: async () => {},
      maxAttempts: 1,
    })).rejects.toThrow('update was not started');
  });

  it('turns backend readiness into concise user-facing copy', () => {
    expect(describeUpdateBackup(candidate)).toEqual({
      tone: 'info',
      label: 'Backup candidate found',
      detail: 'The newest authenticated comprehensive backup candidate is less than an hour old. Strict restore verification will run before the update is admitted.',
    });
    expect(describeUpdateBackup({ ...candidate, state: 'fresh' })).toEqual({
      tone: 'good',
      label: 'Recovery backup strictly verified',
      detail: 'Strict restore verification succeeded for the comprehensive backup less than an hour old.',
    });
    expect(describeUpdateBackup({ ...candidate, state: 'stale', ageHours: 72 })).toEqual({
      tone: 'warning',
      label: 'Backup is stale',
      detail: 'The newest authenticated comprehensive backup candidate is 3 days old. The update safety window is 24 hours.',
    });
    expect(describeUpdateBackup({ ...candidate, state: 'missing', newestCreatedAt: null, ageHours: null })).toMatchObject({
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
