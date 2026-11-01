// @vitest-environment jsdom
import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authAPI } from './auth';
import { useAuthStore } from '../contexts/AuthContext';
import {
  PORTAL_AUTHORIZATION_VERSION_HEADER,
  resetWorkspaceAuthorizationForTests,
} from '../utils/workspaceAuthorization';
import { __authRefreshConvergenceTest } from '../utils/authRefreshConvergence';
import client, { stopSessionHeartbeat } from './client';

vi.mock('../utils/errorHandler', () => ({ captureError: vi.fn() }));

// Mirrors the browser-wide key in authRefreshConvergence.ts; another tab writes
// it after its refresh installed newer cookies.
const CROSS_TAB_GENERATION_KEY = 'bridgesllm-auth-refresh-generation-v1';
const VERSION_HEADER = PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase();
const originalAdapter = client.defaults.adapter;

function actor(id: string) {
  return { id, email: `${id}@example.com`, username: id, role: 'SUB_ADMIN' as const, authorizationVersion: 3 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A refresh left pending by a failed assertion would be joined by the next
// case's requests; afterEach settles every one so cases stay independent.
const openRefreshes: Array<(reason?: unknown) => void> = [];

/** /auth/refresh stays in flight until the case settles it. */
function pendingRefresh() {
  const refresh = deferred<never>();
  openRefreshes.push(refresh.reject);
  vi.spyOn(axios, 'post').mockImplementation(() => refresh.promise);
  return refresh;
}

function ok(config: InternalAxiosRequestConfig): AxiosResponse {
  return { data: {}, status: 200, statusText: 'OK', headers: { [VERSION_HEADER]: '3' }, config };
}

/** The access token expired: every request needs a refresh first. */
function expiredAccessToken(config: InternalAxiosRequestConfig): never {
  throw new AxiosError('Access token expired', 'ERR_BAD_REQUEST', config, undefined, {
    data: { error: 'expired' }, status: 401, statusText: 'Unauthorized', headers: { [VERSION_HEADER]: '3' }, config,
  });
}

type RefreshFailure = number | 'network' | 'timeout';

function refreshFailure(kind: RefreshFailure): AxiosError {
  if (kind === 'network') return new AxiosError('Network Error', 'ERR_NETWORK');
  if (kind === 'timeout') return new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED');
  return new AxiosError('refresh failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    data: {}, status: kind, statusText: '', headers: {}, config: {} as InternalAxiosRequestConfig,
  });
}

function signedIn() {
  return expect.objectContaining({ isAuthenticated: true, user: expect.objectContaining({ id: 'user-1' }) });
}

describe('refresh failures while the Portal is restarting or unreachable', () => {
  beforeEach(async () => {
    __authRefreshConvergenceTest.reset();
    resetWorkspaceAuthorizationForTests();
    useAuthStore.setState({
      user: actor('user-1'), isAuthenticated: true, twoFactorPending: false,
      sessionRestoreError: false, sessionRestoreRetryable: false,
    });
    // Start every case from a clean failure history: a successful response
    // resets the client's transient-failure counter.
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ok(config)) as AxiosAdapter;
    await client.get('/health');
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => expiredAccessToken(config)) as AxiosAdapter;
  });

  afterEach(async () => {
    for (const settle of openRefreshes.splice(0)) settle(refreshFailure('network'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSessionHeartbeat();
    client.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  it('three network failures in a row do not log out', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(refreshFailure('network'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.get('/files')).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    }

    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('a burst of requests sharing one failed refresh does not log out', async () => {
    const refresh = pendingRefresh();

    const requests = ['/a', '/b', '/c'].map((url) => client.get(url).catch((error: unknown) => error));
    await vi.waitFor(() => expect(client.defaults.adapter).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    refresh.reject(refreshFailure(502));

    for (const outcome of await Promise.all(requests)) expect(outcome).toMatchObject({ response: { status: 502 } });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it.each<[string, RefreshFailure, boolean]>([
    ['revoked (401)', 401, false],
    ['refused (403)', 403, false],
    ['bad gateway (502)', 502, true],
    ['restarting (503)', 503, true],
    ['gateway timeout (504)', 504, true],
    ['rate limited (429)', 429, true],
    ['network drop', 'network', true],
    ['client timeout', 'timeout', true],
  ])('a %s refresh failure keeps the session: %s', async (_label, kind, keepsSession) => {
    vi.spyOn(axios, 'post').mockRejectedValue(refreshFailure(kind));

    await expect(client.get('/files')).rejects.toBeInstanceOf(AxiosError);

    expect(axios.post).toHaveBeenCalledTimes(1);
    if (keepsSession) {
      expect(useAuthStore.getState()).toEqual(signedIn());
    } else {
      expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null });
    }
  });

  it('a same-tab login that completes during a failing refresh stays signed in', async () => {
    const refresh = pendingRefresh();
    const request = client.get('/files').catch((error: unknown) => error);
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));

    vi.spyOn(authAPI, 'login').mockResolvedValue({ user: actor('user-1') } as any);
    await useAuthStore.getState().login('user-1@example.com', 'correct horse');
    const publishedToOtherTabs = window.localStorage.getItem(CROSS_TAB_GENERATION_KEY);
    refresh.reject(refreshFailure(401));
    await request;

    expect(useAuthStore.getState()).toEqual(signedIn());
    // The login also tells other tabs, so their failing refreshes stand down too.
    expect(publishedToOtherTabs).not.toBeNull();
  });

  it('a login that starts while an older refresh is failing is not signed out by it', async () => {
    const refresh = pendingRefresh();
    const request = client.get('/files').catch((error: unknown) => error);
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));

    const loginResponse = deferred<any>();
    vi.spyOn(authAPI, 'login').mockReturnValue(loginResponse.promise);
    const signedOut: boolean[] = [];
    const unsubscribe = useAuthStore.subscribe((state) => { if (!state.user) signedOut.push(true); });
    const login = useAuthStore.getState().login('user-1@example.com', 'correct horse');
    refresh.reject(refreshFailure(401));
    await request;
    loginResponse.resolve({ user: actor('user-1') });
    await login;
    unsubscribe();

    expect(signedOut).toEqual([]);
    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('a cross-tab rotation written by another tab supersedes a failing refresh', async () => {
    const refresh = pendingRefresh();
    const request = client.get('/files').catch((error: unknown) => error);
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));

    window.localStorage.setItem(CROSS_TAB_GENERATION_KEY, 'other-tab:7:rotated');
    refresh.reject(refreshFailure(401));
    await request;

    expect(useAuthStore.getState()).toEqual(signedIn());
  });

  it('the reconnect screen keeps the session through repeated temporary refresh failures', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(refreshFailure(503));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(useAuthStore.getState().restoreSession()).resolves.toBe(false);
      expect(useAuthStore.getState()).toMatchObject({
        isAuthenticated: true,
        user: expect.objectContaining({ id: 'user-1' }),
        sessionRestoreError: true,
        sessionRestoreRetryable: true,
      });
    }
    expect(axios.post).toHaveBeenCalledTimes(3);
  });
});
