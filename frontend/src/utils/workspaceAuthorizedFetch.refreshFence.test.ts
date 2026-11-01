// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authAPI } from '../api/auth';
import { stopSessionHeartbeat } from '../api/client';
import { useAuthStore } from '../contexts/AuthContext';
import { __authRefreshConvergenceTest } from './authRefreshConvergence';
import { PORTAL_AUTHORIZATION_VERSION_HEADER, resetWorkspaceAuthorizationForTests } from './workspaceAuthorization';
import { workspaceAuthorizedFetch } from './workspaceAuthorizedFetch';

// Mirrors the browser-wide key in authRefreshConvergence.ts; another tab writes
// it after its refresh installed newer cookies.
const CROSS_TAB_GENERATION_KEY = 'bridgesllm-auth-refresh-generation-v1';

function actor(id: string) {
  return { id, email: `${id}@example.com`, username: id, role: 'SUB_ADMIN' as const, authorizationVersion: 3 };
}

function reply(status: number): Response {
  return { ok: status < 400, status, headers: new Headers({ [PORTAL_AUTHORIZATION_VERSION_HEADER]: '3' }) } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function signedInAs(id: string) {
  return expect.objectContaining({ isAuthenticated: true, user: expect.objectContaining({ id }) });
}

describe('streaming fetch refresh: only a current definitive refusal signs out', () => {
  const fetchMock = vi.fn();
  let refresh = deferred<Response>();

  beforeEach(() => {
    __authRefreshConvergenceTest.reset();
    resetWorkspaceAuthorizationForTests();
    useAuthStore.setState({ user: actor('user-1'), isAuthenticated: true, twoFactorPending: false, sessionRestoreError: false });
    refresh = deferred<Response>();
    fetchMock.mockReset();
    // The access cookie expired: the request answers 401 and /auth/refresh waits for the case.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => (
      String(input).endsWith('/auth/refresh') ? refresh.promise : reply(401)
    ));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    refresh.resolve(reply(503)); // settle a refresh a failed case left open
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSessionHeartbeat();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Returned wrapped: awaiting a bare promise here would wait for the refresh itself. */
  async function requestWaitingOnRefresh() {
    const request = workspaceAuthorizedFetch('/api/gateway/sessions');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    return { request };
  }

  it.each([401, 403])('a current %s refusal signs out', async (status) => {
    const { request } = await requestWaitingOnRefresh();
    refresh.resolve(reply(status));

    await expect(request).resolves.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, user: null });
  });

  it.each([502, 503, 504])('a temporary %s keeps the session', async (status) => {
    const { request } = await requestWaitingOnRefresh();
    refresh.resolve(reply(status));

    await expect(request).resolves.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toEqual(signedInAs('user-1'));
  });

  it('a network drop keeps the session', async () => {
    const { request } = await requestWaitingOnRefresh();
    refresh.reject(new TypeError('Failed to fetch'));

    await expect(request).resolves.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toEqual(signedInAs('user-1'));
  });

  it('a refusal superseded by another tab\'s rotation does not sign out', async () => {
    const { request } = await requestWaitingOnRefresh();
    window.localStorage.setItem(CROSS_TAB_GENERATION_KEY, 'other-tab:9:rotated');
    refresh.resolve(reply(401));
    await request;

    expect(useAuthStore.getState()).toEqual(signedInAs('user-1'));
  });

  it('a refusal that lands after a same-tab login does not sign out the new login', async () => {
    const { request } = await requestWaitingOnRefresh();
    vi.spyOn(authAPI, 'login').mockResolvedValue({ user: actor('user-1') } as any);
    await useAuthStore.getState().login('user-1@example.com', 'correct horse');
    refresh.resolve(reply(401));
    await request;

    expect(useAuthStore.getState()).toEqual(signedInAs('user-1'));
  });

  it('a refusal that lands while a login is starting does not sign out', async () => {
    const { request } = await requestWaitingOnRefresh();
    const loginResponse = deferred<any>();
    vi.spyOn(authAPI, 'login').mockReturnValue(loginResponse.promise);
    const login = useAuthStore.getState().login('user-1@example.com', 'correct horse');
    refresh.resolve(reply(401));
    await request;
    const userWhileLoggingIn = useAuthStore.getState().user;
    loginResponse.resolve({ user: actor('user-1') });
    await login;

    expect(userWhileLoggingIn).not.toBeNull();
    expect(useAuthStore.getState()).toEqual(signedInAs('user-1'));
  });

  it('a refusal for an older actor does not sign out the newer one', async () => {
    const { request } = await requestWaitingOnRefresh();
    useAuthStore.setState({ user: actor('user-2') });
    refresh.resolve(reply(401));
    await request;

    expect(useAuthStore.getState()).toEqual(signedInAs('user-2'));
  });
});
