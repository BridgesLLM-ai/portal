// @vitest-environment jsdom
import '../test/setup';
import React, { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  protectedAction: vi.fn(),
}));

vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth');
  return {
    ...actual,
    authAPI: {
      ...actual.authAPI,
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
  RouteOperationProvider,
  getRouteOperationOwner,
  releaseRouteOperation,
  useRouteOperationGuard,
} from './RouteOperationContext';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function ProtectedProjectAction() {
  const { claim, release } = useRouteOperationGuard();
  const ownerRef = useRef(Object.freeze({ scope: 'project-mutation', token: 1 }));

  const run = () => {
    const owner = ownerRef.current;
    if (!claim(owner)) return;
    try {
      mocks.protectedAction();
    } finally {
      release(owner);
    }
  };

  return <button type="button" onClick={run}>Protected project action</button>;
}

function AuthenticatedShell() {
  const logout = useAuthStore((state) => state.logout);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  return (
    <>
      <button type="button" onClick={() => void logout()}>Logout</button>
      {isAuthenticated ? <ProtectedProjectAction /> : <p>Signed out</p>}
    </>
  );
}

function releaseActiveOwner() {
  const activeOwner = getRouteOperationOwner();
  if (activeOwner) releaseRouteOperation(activeOwner);
}

describe('rendered Logout-first operation ownership', () => {
  beforeEach(() => {
    releaseActiveOwner();
    localStorage.clear();
    mocks.logout.mockReset();
    mocks.protectedAction.mockReset();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', username: 'User', role: 'USER' } as any,
      isAuthenticated: true,
      isLoading: false,
      error: null,
      sessionRestoreError: false,
      lastSessionRestoreAt: Date.now(),
    });
  });

  afterEach(() => {
    releaseActiveOwner();
  });

  it('rejects a same-frame protected action without replacing Logout ownership before auth unmounts', async () => {
    const logoutRequest = deferred<void>();
    mocks.logout.mockReturnValueOnce(logoutRequest.promise);
    render(
      <RouteOperationProvider>
        <AuthenticatedShell />
      </RouteOperationProvider>,
    );

    const logout = screen.getByRole('button', { name: 'Logout' });
    const protectedAction = screen.getByRole('button', { name: 'Protected project action' });

    act(() => {
      fireEvent.click(logout);
      fireEvent.click(protectedAction);
    });

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.protectedAction).not.toHaveBeenCalled();
    const logoutOwner = getRouteOperationOwner();
    expect(logoutOwner).toMatchObject({ scope: 'auth-logout' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    fireEvent.click(protectedAction);
    expect(mocks.protectedAction).not.toHaveBeenCalled();
    expect(getRouteOperationOwner()).toBe(logoutOwner);

    await act(async () => {
      logoutRequest.resolve(undefined);
      await logoutRequest.promise;
    });

    expect(screen.getByText('Signed out')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Protected project action' })).not.toBeInTheDocument();
    expect(mocks.protectedAction).not.toHaveBeenCalled();
    expect(getRouteOperationOwner()).toBeNull();
  });
});
