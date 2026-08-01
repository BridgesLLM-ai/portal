// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import {
  announceWorkspaceAuthorizationVersion,
  resetWorkspaceAuthorizationForTests,
  setWorkspaceAuthorizationBaseline,
} from '../utils/workspaceAuthorization';

const socketHarness = vi.hoisted(() => {
  const sockets: Array<{
    connected: boolean;
    handlers: Map<string, Set<(...args: any[]) => void>>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    serverEmit: (event: string, ...args: any[]) => void;
  }> = [];
  const io = vi.fn(() => {
    const handlers = new Map<string, Set<(...args: any[]) => void>>();
    const socket = {
      connected: true,
      handlers,
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(),
      serverEmit(event: string, ...args: any[]) {
        for (const listener of handlers.get(event) || []) listener(...args);
      },
    };
    socket.on.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(listener);
      return socket;
    });
    socket.connect.mockImplementation(() => {
      socket.connected = true;
      return socket;
    });
    socket.disconnect.mockImplementation(() => {
      const wasConnected = socket.connected;
      socket.connected = false;
      if (wasConnected) socket.serverEmit('disconnect', 'io client disconnect');
      return socket;
    });
    sockets.push(socket);
    return socket;
  });
  return { io, sockets };
});

vi.mock('socket.io-client', () => ({ io: socketHarness.io }));

import {
  hideWorkspacePrivacyCurtain,
  quarantineWorkspaceAuthorization,
  useWorkspaceAuthorizationLifecycle,
} from './useWorkspaceAuthorizationLifecycle';

const originalRestoreSession = useAuthStore.getState().restoreSession;

function persistedPageShowEvent(): PageTransitionEvent {
  const event = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { configurable: true, value: true });
  return event;
}

describe('workspace authorization quarantine', () => {
  beforeEach(() => {
    cleanup();
    socketHarness.sockets.splice(0);
    socketHarness.io.mockClear();
    resetWorkspaceAuthorizationForTests();
    document.body.innerHTML = '<div id="root"><div>owner-secret-project</div></div>';
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        username: 'User',
        role: 'SUB_ADMIN',
        sandboxEnabled: false,
        authorizationVersion: 1,
      },
      isAuthenticated: true,
      isLoading: false,
      sessionRestoreError: false,
      restoreSession: originalRestoreSession,
    });
  });

  afterEach(() => {
    cleanup();
    hideWorkspacePrivacyCurtain();
    useAuthStore.setState({ restoreSession: originalRestoreSession });
  });

  it('hides stale DOM synchronously, scrubs workspace state, and replaces the route', () => {
    localStorage.setItem('projects-last-selected', 'owner-secret-project');
    localStorage.setItem('theme', 'dark');
    sessionStorage.setItem('portal:terminal-state:v1', 'sensitive');
    sessionStorage.setItem('portal-module-reload:FilesPage', '1');
    window.history.replaceState({}, '', '/projects?project=owner-secret-project');
    const navigate = vi.fn();

    quarantineWorkspaceAuthorization('user-1', 2, navigate);

    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('portal-workspace-authorization-curtain')?.textContent)
      .toContain('Refreshing workspace access');
    expect(localStorage.getItem('projects-last-selected')).toBeNull();
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(sessionStorage.getItem('portal:terminal-state:v1')).toBeNull();
    expect(sessionStorage.getItem('portal-module-reload:FilesPage')).toBe('1');
    expect(window.location.pathname).toBe('/dashboard');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
    expect(useAuthStore.getState().user?.authorizationVersion).toBe(2);
  });

  it('keeps the shell curtained until a matching socket snapshot arrives', () => {
    const { unmount } = renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;

    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    act(() => socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 }));
    expect(document.getElementById('root')?.style.visibility).toBe('');

    act(() => socket.serverEmit('disconnect', 'transport close'));
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    act(() => {
      socket.connected = true;
      socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 });
    });
    expect(document.getElementById('root')?.style.visibility).toBe('');
    unmount();
  });

  it('fails closed on initial connect errors while probing the REST session', async () => {
    let resolveRestore!: (restored: boolean) => void;
    const restoreSession = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRestore = resolve;
    }));
    useAuthStore.setState({ restoreSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;
    socket.connected = false;

    act(() => socket.serverEmit('connect_error', new Error('offline')));
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(restoreSession).toHaveBeenCalledTimes(1);

    await act(async () => resolveRestore(true));
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
  });

  it('revalidates a BFCache restoration before revealing the preserved DOM', async () => {
    const restoreSession = vi.fn(async () => true);
    useAuthStore.setState({ restoreSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;
    act(() => socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 }));
    expect(document.getElementById('root')?.style.visibility).toBe('');

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(persistedPageShowEvent());
    });
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.getElementById('root')?.style.visibility).toBe(''));
  });

  it('ignores another user event and quarantines the exact actor immediately', () => {
    const navigate = vi.fn();
    renderHook(() => useWorkspaceAuthorizationLifecycle(navigate));
    const socket = socketHarness.sockets.at(-1)!;
    act(() => socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 }));

    act(() => socket.serverEmit('authorization_changed', {
      userId: 'user-2',
      authorizationVersion: 9,
    }));
    expect(navigate).not.toHaveBeenCalled();

    act(() => socket.serverEmit('authorization_changed', {
      userId: 'user-1',
      authorizationVersion: 2,
    }));
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('does not swallow a newer generation observed before hook registration', () => {
    const navigate = vi.fn();
    setWorkspaceAuthorizationBaseline('user-1', 1);
    announceWorkspaceAuthorizationVersion('user-1', 2, 'response');

    renderHook(() => useWorkspaceAuthorizationLifecycle(navigate));

    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('cleans the first StrictMode socket and leaves one live lifecycle', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(StrictMode, null, children)
    );
    const { unmount } = renderHook(
      () => useWorkspaceAuthorizationLifecycle(vi.fn()),
      { wrapper },
    );

    expect(socketHarness.io).toHaveBeenCalledTimes(2);
    expect(socketHarness.sockets[0].disconnect).toHaveBeenCalledTimes(1);
    expect(socketHarness.sockets[1].disconnect).not.toHaveBeenCalled();
    unmount();
    expect(socketHarness.sockets[1].disconnect).toHaveBeenCalledTimes(1);
  });
});
