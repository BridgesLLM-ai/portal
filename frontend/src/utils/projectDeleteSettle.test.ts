import { describe, expect, it, vi } from 'vitest';
import {
  deleteProjectAwaitingSettle,
  isProjectDeleteSettling,
} from './projectDeleteSettle';

function settlingError(overrides: Record<string, unknown> = {}) {
  return {
    response: {
      status: 503,
      data: {
        code: 'TURN_STILL_ACTIVE',
        retryable: true,
        retryAfterMs: 4_000,
        error: 'This Project is still finishing a chat turn.',
        ...overrides,
      },
    },
  };
}

describe('project delete settling', () => {
  it('waits out a held turn lease and then succeeds', async () => {
    // The real failure: the first delete was refused because a chat turn still
    // held a lease, the dialog showed an error, and the project deleted itself
    // moments later anyway.
    const deleteProject = vi.fn()
      .mockRejectedValueOnce(settlingError())
      .mockResolvedValueOnce(undefined);
    const waits: number[] = [];

    await deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async (ms) => { waits.push(ms); },
    });

    expect(deleteProject).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([4_000]);
  });

  it('uses the server retry hint, clamped to something sane', async () => {
    const deleteProject = vi.fn()
      .mockRejectedValueOnce(settlingError({ retryAfterMs: 10_000_000 }))
      .mockResolvedValueOnce(undefined);
    const waits: number[] = [];
    await deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async (ms) => { waits.push(ms); },
    });
    expect(waits[0]).toBeLessThanOrEqual(30_000);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('falls back to a default wait when no hint is given', async () => {
    const deleteProject = vi.fn()
      .mockRejectedValueOnce(settlingError({ retryAfterMs: undefined }))
      .mockResolvedValueOnce(undefined);
    const waits: number[] = [];
    await deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([5_000]);
  });

  it('reports each wait so the dialog can explain itself', async () => {
    const deleteProject = vi.fn()
      .mockRejectedValueOnce(settlingError())
      .mockRejectedValueOnce(settlingError())
      .mockResolvedValueOnce(undefined);
    const seen: Array<[number, number]> = [];
    await deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async () => undefined,
      onWaiting: (ms, attempt) => { seen.push([ms, attempt]); },
    });
    expect(seen).toEqual([[4_000, 1], [4_000, 2]]);
  });

  it('rethrows anything that is not the self-clearing case', async () => {
    const hard = { response: { status: 409, data: { code: 'RESIDUAL_RESOURCE', retryable: false } } };
    const deleteProject = vi.fn().mockRejectedValue(hard);
    await expect(deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async () => undefined,
    })).rejects.toBe(hard);
    // No retry storm on a real failure.
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });

  it('respects an explicit non-retryable contract even for this code', async () => {
    const pinned = settlingError({ retryable: false });
    const deleteProject = vi.fn().mockRejectedValue(pinned);
    await expect(deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async () => undefined,
    })).rejects.toBe(pinned);
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than retrying forever', async () => {
    const deleteProject = vi.fn().mockRejectedValue(settlingError());
    await expect(deleteProjectAwaitingSettle('proj', deleteProject, {
      delay: async () => undefined,
      maxAttempts: 3,
    })).rejects.toBeDefined();
    expect(deleteProject).toHaveBeenCalledTimes(3);
  });

  it('classifies the settling error for callers', () => {
    expect(isProjectDeleteSettling(settlingError())).toBe(true);
    expect(isProjectDeleteSettling(settlingError({ retryable: false }))).toBe(false);
    expect(isProjectDeleteSettling(new Error('boom'))).toBe(false);
    expect(isProjectDeleteSettling(undefined)).toBe(false);
  });
});
