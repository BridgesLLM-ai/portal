// @vitest-environment jsdom
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authAPI } from '../api/auth';
import { useAuthStore } from './AuthContext';
import {
  __authRefreshConvergenceTest,
  AuthRefreshSessionGoneError,
  publishAuthRefreshSuccess,
} from '../utils/authRefreshConvergence';

vi.mock('../utils/errorHandler', () => ({ captureError: vi.fn() }));
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  startSessionHeartbeat: vi.fn(),
  stopSessionHeartbeat: vi.fn(),
}));

// Mirrors the browser-wide key in authRefreshConvergence.ts; another tab writes
// it after its refresh installed newer cookies.
const CROSS_TAB_GENERATION_KEY = 'bridgesllm-auth-refresh-generation-v1';

function actor(id: string) {
  return { id, email: `${id}@example.com`, username: id, role: 'SUB_ADMIN' as const, authorizationVersion: 3 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function refusal(status: number | 'network'): unknown {
  if (status === 'network') return new AxiosError('Network Error', 'ERR_NETWORK');
  return new AxiosError('refresh failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    data: {}, status, statusText: '', headers: {}, config: {} as InternalAxiosRequestConfig,
  });
}

function signedIn(id = 'user-1') {
  return expect.objectContaining({ isAuthenticated: true, user: expect.objectContaining({ id }) });
}

/** The manual refresh stays in flight until the case settles it. */
function pendingManualRefresh() {
  const refresh = deferred<never>();
  vi.spyOn(authAPI, 'refresh').mockReturnValue(refresh.promise);
  const result = useAuthStore.getState().refreshSession();
  return { refresh, result };
}

describe('manual session refresh signs out only on a current refusal', () => {
  beforeEach(() => {
    __authRefreshConvergenceTest.reset();
    window.localStorage.clear();
    useAuthStore.setState({
      user: actor('user-1'), isAuthenticated: true, twoFactorPending: false,
      sessionRestoreError: false, sessionRestoreRetryable: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['401', refusal(401)],
    ['403', refusal(403)],
    ['a session another tab replaced for good', new AuthRefreshSessionGoneError(refusal(409))],
  ])('a current %s refusal still signs out', async (_label, error) => {
    const { refresh, result } = pendingManualRefresh();
    refresh.reject(error);

    await expect(result).resolves.toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null });
  });

  it.each([
    ['503', refusal(503)],
    ['a network failure', refusal('network')],
  ])('a temporary %s keeps the session', async (_label, error) => {
    const { refresh, result } = pendingManualRefresh();
    refresh.reject(error);

    await expect(result).resolves.toBe(false);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('a same-tab login that completes during the refresh stays signed in', async () => {
    const { refresh, result } = pendingManualRefresh();
    vi.spyOn(authAPI, 'login').mockResolvedValue({ user: actor('user-1') } as any);
    await useAuthStore.getState().login('user-1@example.com', 'correct horse');
    refresh.reject(refusal(401));

    await expect(result).resolves.toBe(false);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('a login that starts while the refresh is failing is not signed out by it', async () => {
    const { refresh, result } = pendingManualRefresh();
    const loginResponse = deferred<any>();
    vi.spyOn(authAPI, 'login').mockReturnValue(loginResponse.promise);
    const signedOut: boolean[] = [];
    const unsubscribe = useAuthStore.subscribe((state) => { if (!state.user) signedOut.push(true); });
    const login = useAuthStore.getState().login('user-1@example.com', 'correct horse');
    refresh.reject(refusal(401));
    await result;
    loginResponse.resolve({ user: actor('user-1') });
    await login;
    unsubscribe();

    expect(signedOut).toEqual([]);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('a newer actor in this tab is not signed out by the old actor\'s refusal', async () => {
    const { refresh, result } = pendingManualRefresh();
    useAuthStore.setState({ user: actor('user-2'), isAuthenticated: true });
    refresh.reject(refusal(401));

    await expect(result).resolves.toBe(false);
    expect(useAuthStore.getState()).toEqual(signedIn('user-2'));
  });

  it('a newer refresh in this tab supersedes the failing one', async () => {
    const { refresh, result } = pendingManualRefresh();
    publishAuthRefreshSuccess();
    refresh.reject(refusal(401));

    await expect(result).resolves.toBe(false);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('a rotation written by another tab supersedes the failing refresh', async () => {
    const { refresh, result } = pendingManualRefresh();
    window.localStorage.setItem(CROSS_TAB_GENERATION_KEY, 'other-tab:7:rotated');
    refresh.reject(refusal(401));

    await expect(result).resolves.toBe(false);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });
});
