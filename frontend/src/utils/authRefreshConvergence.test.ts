// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REFRESH_CONFLICT_MAX_WAIT_MS,
  __authRefreshConvergenceTest,
  refreshAuthSessionWithFetch,
} from './authRefreshConvergence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function successResponse(): Response {
  return new Response(JSON.stringify({ accessToken: 'rotated' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function conflictResponse(retryAfter = '5'): Response {
  return new Response(JSON.stringify({
    code: 'AUTH_REFRESH_ROTATION_CONFLICT',
    retryable: true,
  }), {
    status: 409,
    headers: {
      'content-type': 'application/json',
      'retry-after': retryAfter,
    },
  });
}

describe('browser-wide auth refresh convergence', () => {
  beforeEach(() => {
    __authRefreshConvergenceTest.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps both tabs authenticated when the winner cookie arrives before the conflict', async () => {
    const winner = deferred<Response>();
    const loser = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => winner.promise)
      .mockImplementationOnce(() => loser.promise)
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const winnerTab = refreshAuthSessionWithFetch('/api');
    const losingTab = refreshAuthSessionWithFetch('/api');
    winner.resolve(successResponse());
    await expect(winnerTab).resolves.toBe(true);
    loser.resolve(conflictResponse());

    await expect(losingTab).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits for the winner cookie when the conflict response arrives first', async () => {
    const winner = deferred<Response>();
    const loser = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => winner.promise)
      .mockImplementationOnce(() => loser.promise)
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const winnerTab = refreshAuthSessionWithFetch('/api');
    const losingTab = refreshAuthSessionWithFetch('/api');
    loser.resolve(conflictResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    winner.resolve(successResponse());

    await expect(winnerTab).resolves.toBe(true);
    await expect(losingTab).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('still converges when the winning response takes more than 1.5 seconds', async () => {
    vi.useFakeTimers();
    const winner = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => winner.promise)
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const winnerTab = refreshAuthSessionWithFetch('/api');
    const losingTab = refreshAuthSessionWithFetch('/api');
    setTimeout(() => winner.resolve(successResponse()), 2_000);

    await vi.advanceTimersByTimeAsync(1_600);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);

    await expect(winnerTab).resolves.toBe(true);
    await expect(losingTab).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('signs out locally after one repeated conflict with no winner generation', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(conflictResponse());
    const onDefinitiveFailure = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const refresh = refreshAuthSessionWithFetch('/api', { onDefinitiveFailure });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_CONFLICT_MAX_WAIT_MS);

    await expect(refresh).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onDefinitiveFailure).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('treats a terminal %s refresh response as local sign-out', async (status) => {
    const onDefinitiveFailure = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));

    await expect(refreshAuthSessionWithFetch('/api', { onDefinitiveFailure })).resolves.toBe(false);

    expect(onDefinitiveFailure).toHaveBeenCalledTimes(1);
  });
});
