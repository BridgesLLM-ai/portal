// @vitest-environment jsdom
import '../test/setup';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePortalUpdateSessionRecovery } from './usePortalUpdateSessionRecovery';
import {
  PORTAL_UPDATE_CHECKPOINT_SESSION_KEY,
  PORTAL_UPDATE_OPERATION_SESSION_KEY,
} from '../utils/portalUpdateSession';

const OPERATION_ID = '0123456789abcdef0123456789abcdef';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Portal update session recovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('automatically retries a quarantined session only for an exact updater identity', async () => {
    sessionStorage.setItem(PORTAL_UPDATE_OPERATION_SESSION_KEY, OPERATION_ID);
    const restoreSession = vi.fn().mockResolvedValue(false);
    renderHook(() => usePortalUpdateSessionRecovery({ enabled: true, restoreSession }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(restoreSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(restoreSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(restoreSession).toHaveBeenCalledTimes(2);
  });

  it('does not retry for missing or malformed operation IDs', async () => {
    const restoreSession = vi.fn().mockResolvedValue(false);
    const { rerender } = renderHook(() => usePortalUpdateSessionRecovery({ enabled: true, restoreSession }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    sessionStorage.setItem(PORTAL_UPDATE_OPERATION_SESSION_KEY, 'NOT-A-DURABLE-ID');
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it('does not treat a terminal checkpoint as an active Portal restart', async () => {
    sessionStorage.setItem(PORTAL_UPDATE_OPERATION_SESSION_KEY, OPERATION_ID);
    sessionStorage.setItem(PORTAL_UPDATE_CHECKPOINT_SESSION_KEY, JSON.stringify({
      schema: 1,
      operationId: OPERATION_ID,
      previousVersion: '4.0.14',
      expectedVersion: '4.0.15',
      status: 'succeeded',
      phase: 'complete',
      percent: 100,
      label: 'Update complete',
      detail: 'The signed update completed.',
      startedAt: '2026-08-10T10:00:00.000Z',
      updatedAt: '2026-08-10T10:10:00.000Z',
      finishedAt: '2026-08-10T10:10:00.000Z',
      events: [],
      logAvailable: true,
      isCurrent: true,
      admissionBlocked: false,
    }));
    const restoreSession = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => usePortalUpdateSessionRecovery({ enabled: true, restoreSession }));

    expect(result.current.operationId).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it('never overlaps reconnect probes and clears its timer on unmount', async () => {
    sessionStorage.setItem(PORTAL_UPDATE_OPERATION_SESSION_KEY, OPERATION_ID);
    const first = deferred<boolean>();
    const restoreSession = vi.fn().mockReturnValue(first.promise);
    const { unmount } = renderHook(() => usePortalUpdateSessionRecovery({ enabled: true, restoreSession }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(restoreSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(false);
      await first.promise;
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });
});
