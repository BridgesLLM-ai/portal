import { describe, expect, it, vi } from 'vitest';

import {
  monitorPortalSelfUpdate,
  parsePortalSelfUpdateProgress,
  type PortalSelfUpdateProgress,
} from './portalUpdateProgress';

const OPERATION_ID = '0123456789abcdef0123456789abcdef';

function updateProgress(
  overrides: Partial<PortalSelfUpdateProgress> = {},
): PortalSelfUpdateProgress {
  return {
    schema: 1,
    operationId: OPERATION_ID,
    previousVersion: '4.0.13',
    expectedVersion: '4.0.14',
    status: 'running',
    phase: 'signed-release',
    percent: 34,
    label: 'Verifying signed release',
    detail: 'Checking the manifest, signature, and artifact digest.',
    startedAt: '2026-08-10T06:00:00Z',
    updatedAt: '2026-08-10T06:00:04Z',
    finishedAt: null,
    events: [],
    logAvailable: true,
    isCurrent: true,
    admissionBlocked: true,
    ...overrides,
  };
}

describe('Portal self-update progress contract', () => {
  it('accepts the bounded server contract and rejects untrusted shapes', () => {
    expect(parsePortalSelfUpdateProgress(updateProgress())).toMatchObject({
      status: 'running',
      percent: 34,
      expectedVersion: '4.0.14',
    });
    expect(parsePortalSelfUpdateProgress({ ...updateProgress(), percent: 101 })).toBeNull();
    expect(parsePortalSelfUpdateProgress({ ...updateProgress(), operationId: '../../etc/passwd' })).toBeNull();
    expect(parsePortalSelfUpdateProgress({
      ...updateProgress(),
      status: 'failed',
      finishedAt: null,
    })).toBeNull();
    expect(parsePortalSelfUpdateProgress({
      ...updateProgress(),
      detail: 'bad\u0000text',
    })).toBeNull();
  });

  it('preserves resolved attention history without presenting a live admission block', () => {
    expect(parsePortalSelfUpdateProgress(updateProgress({
      status: 'updated_with_errors',
      phase: 'updated-with-errors',
      finishedAt: '2026-08-10T06:01:00Z',
      isCurrent: false,
      admissionBlocked: false,
    }))).toMatchObject({
      status: 'updated_with_errors',
      isCurrent: false,
      admissionBlocked: false,
    });
  });

  it('streams real phases and stops immediately on a reported failure', async () => {
    const onProgress = vi.fn();
    const readProgress = vi.fn()
      .mockResolvedValueOnce(updateProgress())
      .mockResolvedValueOnce(updateProgress({
        status: 'recovering',
        phase: 'recovery',
        percent: 34,
        label: 'Update stopped — checking recovery',
        detail: 'Unsafe scheduled Docker cleanup remains active.',
        updatedAt: '2026-08-10T06:00:05Z',
      }))
      .mockResolvedValueOnce(updateProgress({
        status: 'failed',
        phase: 'failed',
        percent: 34,
        label: 'Update could not be installed',
        detail: 'Unsafe scheduled Docker cleanup remains active.',
        updatedAt: '2026-08-10T06:00:06Z',
        finishedAt: '2026-08-10T06:00:06Z',
      }));

    await expect(monitorPortalSelfUpdate('4.0.14', OPERATION_ID, {
      readProgress,
      readPortalVersion: vi.fn().mockResolvedValue({ version: '4.0.13' }),
    }, {
      delay: async () => {},
      maxAttempts: 4,
      onProgress,
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: 'Unsafe scheduled Docker cleanup remains active.',
    });
    expect(onProgress.mock.calls.map(([value]) => value.status)).toEqual([
      'running',
      'recovering',
      'failed',
    ]);
  });

  it('survives a backend restart and requires exact version proof for success', async () => {
    const connection = vi.fn();
    const onProgress = vi.fn();
    const readProgress = vi.fn()
      .mockRejectedValueOnce(new Error('Portal restarting'))
      .mockResolvedValue(updateProgress({
        status: 'succeeded',
        phase: 'complete',
        percent: 100,
        label: 'Update complete',
        detail: 'Portal v4.0.14 finished the signed update and postflight checks.',
        updatedAt: '2026-08-10T06:01:00Z',
        finishedAt: '2026-08-10T06:01:00Z',
      }));
    const readPortalVersion = vi.fn()
      .mockRejectedValueOnce(new Error('Portal restarting'))
      .mockResolvedValueOnce({ status: 'ok', version: '4.0.13' })
      .mockResolvedValueOnce({ status: 'ok', version: '4.0.14' });

    await expect(monitorPortalSelfUpdate('4.0.14', OPERATION_ID, {
      readProgress,
      readPortalVersion,
    }, {
      delay: async () => {},
      maxAttempts: 4,
      onConnectionChange: connection,
      onProgress,
    })).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(connection).toHaveBeenCalledWith('reconnecting');
    expect(readPortalVersion).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }));
  });

  it('never treats target-version health as success without a terminal updater receipt', async () => {
    await expect(monitorPortalSelfUpdate('4.0.14', undefined, {
      readProgress: vi.fn().mockRejectedValue(new Error('connection reset')),
      readPortalVersion: vi.fn().mockResolvedValue({ status: 'starting', version: '4.0.14' }),
    }, {
      delay: async () => {},
      maxAttempts: 1,
    })).resolves.toMatchObject({ outcome: 'timeout', progress: null });
  });

  it('surfaces rollback and attention outcomes as terminal failures', async () => {
    for (const status of ['rolled_back', 'updated_with_errors', 'recovery_required'] as const) {
      await expect(monitorPortalSelfUpdate('4.0.14', OPERATION_ID, {
        readProgress: vi.fn().mockResolvedValue(updateProgress({
          status,
          phase: status.replace(/_/g, '-'),
          label: 'Update needs attention',
          detail: `terminal ${status}`,
          finishedAt: '2026-08-10T06:01:00Z',
        })),
        readPortalVersion: vi.fn().mockResolvedValue({ status: 'ok', version: '4.0.14' }),
      }, {
        delay: async () => {},
        maxAttempts: 1,
      })).resolves.toMatchObject({ outcome: 'failed', progress: { status } });
    }
  });

  it('ignores a regressing snapshot for the same operation', async () => {
    const onProgress = vi.fn();
    const readProgress = vi.fn()
      .mockResolvedValueOnce(updateProgress({ percent: 70, phase: 'installing' }))
      .mockResolvedValueOnce(updateProgress({ percent: 34, phase: 'signed-release' }));
    await expect(monitorPortalSelfUpdate('4.0.14', OPERATION_ID, {
      readProgress,
      readPortalVersion: vi.fn().mockResolvedValue({ status: 'ok', version: '4.0.14' }),
    }, {
      delay: async () => {},
      maxAttempts: 2,
      onProgress,
    })).resolves.toMatchObject({ outcome: 'timeout', progress: { percent: 70 } });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('pins the current active same-version receipt despite browser/server clock skew', async () => {
    const freshId = 'fedcba9876543210fedcba9876543210';
    const readProgress = vi.fn()
      .mockResolvedValueOnce(updateProgress({
        operationId: freshId,
        // The browser that submitted the update may be well ahead of the
        // server clock. Current-operation identity, active status, and target
        // version are the safe attachment fence; wall-clock comparison is not.
        startedAt: '2026-08-10T05:00:00Z',
        updatedAt: '2026-08-10T05:00:02Z',
      }))
      .mockResolvedValueOnce(updateProgress({
        operationId: freshId,
        status: 'succeeded',
        phase: 'complete',
        percent: 100,
        label: 'Update complete',
        detail: 'Exact target health passed.',
        startedAt: '2026-08-10T05:00:00Z',
        updatedAt: '2026-08-10T06:01:00Z',
        finishedAt: '2026-08-10T06:01:00Z',
      }));
    await expect(monitorPortalSelfUpdate('4.0.14', undefined, {
      readProgress,
      readPortalVersion: vi.fn().mockResolvedValue({ status: 'ok', version: '4.0.14' }),
    }, {
      delay: async () => {},
      maxAttempts: 2,
      maxUnattachedAttempts: 1,
    })).resolves.toMatchObject({ outcome: 'succeeded', progress: { operationId: freshId } });
    expect(readProgress.mock.calls[1][0]).toBe(freshId);
  });

  it('returns a bounded timeout instead of spinning forever', async () => {
    await expect(monitorPortalSelfUpdate('4.0.14', OPERATION_ID, {
      readProgress: vi.fn().mockResolvedValue(updateProgress()),
      readPortalVersion: vi.fn().mockResolvedValue({ version: '4.0.13' }),
    }, {
      delay: async () => {},
      maxAttempts: 2,
    })).resolves.toMatchObject({ outcome: 'timeout' });
  });

  it('bounds only unattached admission ambiguity and never infers a second operation', async () => {
    const readProgress = vi.fn().mockResolvedValue({
      schema: 1,
      operationId: null,
      previousVersion: null,
      expectedVersion: null,
      status: 'idle',
      phase: 'idle',
      percent: 0,
      label: 'No update is running',
      detail: '',
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      events: [],
      logAvailable: false,
      isCurrent: false,
      admissionBlocked: false,
    });
    await expect(monitorPortalSelfUpdate('4.0.14', undefined, {
      readProgress,
      readPortalVersion: vi.fn().mockResolvedValue({ status: 'ok', version: '4.0.13' }),
    }, {
      delay: async () => {},
      maxUnattachedAttempts: 3,
    })).resolves.toEqual({ outcome: 'timeout', progress: null });
    expect(readProgress).toHaveBeenCalledTimes(3);
  });
});
