// @vitest-environment jsdom
import '../test/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ me: vi.fn(), logout: vi.fn() }));

vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth');
  return {
    ...actual,
    authAPI: {
      ...actual.authAPI,
      me: mocks.me,
      logout: mocks.logout,
    },
  };
});

vi.mock('../api/client', () => ({
  startSessionHeartbeat: vi.fn(),
  stopSessionHeartbeat: vi.fn(),
}));

import { useAuthStore } from './AuthContext';
import {
  buildFileDeepLink,
  parseFileDeepLink,
  WORKSPACE_NAVIGATION_STORAGE_KEY,
} from '../utils/workspaceNavigation';
import {
  claimRouteOperation,
  getRouteOperationOwner,
  isRouteOperationOwned,
  releaseRouteOperation,
} from './RouteOperationContext';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('session restore fail-closed contract', () => {
  beforeEach(() => {
    const activeOwner = getRouteOperationOwner();
    if (activeOwner) releaseRouteOperation(activeOwner);
    localStorage.clear();
    sessionStorage.clear();
    mocks.me.mockReset();
    mocks.logout.mockReset().mockResolvedValue(undefined);
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        username: 'User',
        role: 'USER',
        authorizationVersion: 1,
      } as any,
      isAuthenticated: true,
      isLoading: false,
      sessionRestoreError: false,
      lastSessionRestoreAt: Date.now(),
    });
  });

  it('quarantines cached auth when the server cannot validate it', async () => {
    mocks.me.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(useAuthStore.getState().restoreSession()).resolves.toBe(false);
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      sessionRestoreError: true,
      isLoading: false,
    });
  });

  it('lets a quarantined session be abandoned so the user can sign in fresh', async () => {
    mocks.me.mockRejectedValueOnce(new Error('network unavailable'));
    await useAuthStore.getState().restoreSession();
    expect(useAuthStore.getState().sessionRestoreError).toBe(true);
    localStorage.setItem('accessToken', 'stale-token');

    await useAuthStore.getState().abandonQuarantinedSession();

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      sessionRestoreError: false,
    });
    expect(localStorage.getItem('accessToken')).toBeNull();
    const persisted = JSON.parse(localStorage.getItem('bridgesllm-auth') ?? '{"state":{}}');
    expect(persisted.state?.isAuthenticated ?? false).toBe(false);
  });

  it('does not strand the user again when the logout request never answers', async () => {
    // Only setTimeout: the jsdom setup owns a read-only requestAnimationFrame.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      mocks.logout.mockReturnValue(new Promise(() => {}));
      useAuthStore.setState({ sessionRestoreError: true });

      const abandoning = useAuthStore.getState().abandonQuarantinedSession();
      let settled = false;
      void abandoning.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2000);
      await abandoning;

      expect(settled).toBe(true);
      expect(useAuthStore.getState()).toMatchObject({
        isAuthenticated: false,
        sessionRestoreError: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears cached auth on a definitive authorization failure', async () => {
    const fileUrl = buildFileDeepLink('restore-file', 'owner/restore.txt', {
      actorUserId: 'user-1',
      authorizationVersion: 1,
    });
    sessionStorage.setItem('portal-module-reload:FilesPage', '1');
    mocks.me.mockRejectedValueOnce({ response: { status: 401 } });

    await expect(useAuthStore.getState().restoreSession()).resolves.toBe(false);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      sessionRestoreError: false,
    });
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
    expect(parseFileDeepLink(fileUrl.split('?')[1], {
      actorUserId: 'user-1',
      authorizationVersion: 1,
    })).toBeNull();
    expect(sessionStorage.getItem('portal-module-reload:FilesPage')).toBe('1');
  });

  it('invalidates old opaque targets across explicit logout and same-generation login', async () => {
    const binding = { actorUserId: 'user-1', authorizationVersion: 1 };
    const fileUrl = buildFileDeepLink('logout-file', 'owner/logout.txt', binding);
    expect(parseFileDeepLink(fileUrl.split('?')[1], binding)).toEqual({
      fileId: 'logout-file',
      path: 'owner/logout.txt',
    });
    sessionStorage.setItem('portal-module-reload:FilesPage', '1');

    await useAuthStore.getState().logout();
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('portal-module-reload:FilesPage')).toBe('1');

    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        username: 'User',
        role: 'USER',
        authorizationVersion: 1,
      } as any,
      isAuthenticated: true,
    });
    expect(parseFileDeepLink(fileUrl.split('?')[1], binding)).toBeNull();
  });

  it('scrubs workspace transients during silent logout without clearing reload guards', () => {
    buildFileDeepLink('silent-file', 'owner/silent.txt', {
      actorUserId: 'user-1',
      authorizationVersion: 1,
    });
    sessionStorage.setItem('portal:terminal-state:v1', 'owner shell');
    sessionStorage.setItem('portal-module-reload:FilesPage', '1');

    useAuthStore.getState().silentLogout();

    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('portal:terminal-state:v1')).toBeNull();
    expect(sessionStorage.getItem('portal-module-reload:FilesPage')).toBe('1');
  });

  it('refuses user logout while an exact route operation owns the authenticated shell', async () => {
    const owner = Object.freeze({ scope: 'project-mutation', token: 1 });
    expect(claimRouteOperation(owner)).toBe(true);

    await useAuthStore.getState().logout();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    expect(releaseRouteOperation(owner)).toBe(true);
    await useAuthStore.getState().logout();
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('claims exact ownership before Logout so a same-frame mutation cannot start', async () => {
    const logoutRequest = deferred<void>();
    mocks.logout.mockReturnValueOnce(logoutRequest.promise);

    const logout = useAuthStore.getState().logout();
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(isRouteOperationOwned()).toBe(true);
    expect(claimRouteOperation(Object.freeze({ scope: 'project-mutation', token: 2 }))).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    logoutRequest.resolve(undefined);
    await logout;
    expect(isRouteOperationOwned()).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('releases Logout ownership after a failed request without admitting a competing operation early', async () => {
    mocks.logout.mockRejectedValueOnce(new Error('network unavailable'));
    await useAuthStore.getState().logout();
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(isRouteOperationOwned()).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    const successor = Object.freeze({ scope: 'project-mutation', token: 3 });
    expect(claimRouteOperation(successor)).toBe(true);
    expect(releaseRouteOperation(successor)).toBe(true);
  });

  it('does not clear auth or release a successor when a stale Logout completion lost exact ownership', async () => {
    const logoutRequest = deferred<void>();
    mocks.logout.mockReturnValueOnce(logoutRequest.promise);
    const logout = useAuthStore.getState().logout();
    const logoutOwner = getRouteOperationOwner();
    expect(logoutOwner).not.toBeNull();
    expect(releaseRouteOperation(logoutOwner!)).toBe(true);

    const successor = Object.freeze({ scope: 'project-mutation', token: 4 });
    expect(claimRouteOperation(successor)).toBe(true);
    logoutRequest.resolve(undefined);
    await logout;

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(getRouteOperationOwner()).toBe(successor);
    expect(releaseRouteOperation(successor)).toBe(true);
  });
});
