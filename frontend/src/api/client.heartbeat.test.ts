// @vitest-environment jsdom
import axios, { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import { publishAuthRefreshSuccess } from '../utils/authRefreshConvergence';
import { startSessionHeartbeat, stopSessionHeartbeat } from './client';

vi.mock('../utils/errorHandler', () => ({ captureError: vi.fn() }));

const failure = (status: number) => new AxiosError('refresh failed', undefined, undefined, undefined,
  { status, statusText: '', data: {}, headers: {}, config: {} as any });
let now = Date.now();

describe('background session invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers(); now += 60 * 60 * 1000; vi.setSystemTime(now);
    useAuthStore.setState({ user: { id: 'owner', authorizationVersion: 1 } as any, isAuthenticated: true, twoFactorPending: false });
    vi.spyOn(axios, 'post'); startSessionHeartbeat();
  });
  afterEach(() => { stopSessionHeartbeat(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each([401, 403])('signs out once on definitive %s and stops the loop', async status => {
    vi.mocked(axios.post).mockRejectedValue(failure(status));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it.each([500, 503, 429])('preserves the session during repeated temporary %s failures', async status => {
    vi.mocked(axios.post).mockRejectedValue(failure(status));
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(axios.post).toHaveBeenCalledTimes(4);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('never logs out a newer actor when an old heartbeat fails', async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(axios.post).mockImplementation(() => new Promise((_r, no) => { reject = no; }));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    useAuthStore.setState({ user: { id: 'other', authorizationVersion: 1 } as any });
    reject(failure(401)); await vi.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('respects a newer cross-tab cookie rotation', async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(axios.post).mockImplementation(() => new Promise((_r, no) => { reject = no; }));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    publishAuthRefreshSuccess(); reject(failure(401)); await vi.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('does not refresh a signed-out or two-factor-pending session', async () => {
    useAuthStore.setState({ isAuthenticated: false });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    useAuthStore.setState({ isAuthenticated: true, twoFactorPending: true });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
