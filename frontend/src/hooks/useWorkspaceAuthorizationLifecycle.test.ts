// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
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
  WORKSPACE_AUTHORIZATION_CHECK_DEADLINE_MS,
  WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS,
  hideWorkspacePrivacyCurtain,
  quarantineWorkspaceAuthorization,
  showWorkspacePrivacyCurtain,
  useWorkspaceAuthorizationLifecycle,
} from './useWorkspaceAuthorizationLifecycle';

const originalRestoreSession = useAuthStore.getState().restoreSession;
const originalAbandonQuarantinedSession = useAuthStore.getState().abandonQuarantinedSession;

function persistedPageShowEvent(): PageTransitionEvent {
  const event = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { configurable: true, value: true });
  return event;
}

describe('workspace authorization quarantine', () => {
  beforeEach(() => {
    vi.useRealTimers();
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
      restoreSession: vi.fn(async () => true),
      abandonQuarantinedSession: originalAbandonQuarantinedSession,
    });
  });

  afterEach(() => {
    cleanup();
    hideWorkspacePrivacyCurtain();
    vi.useRealTimers();
    useAuthStore.setState({
      restoreSession: originalRestoreSession,
      abandonQuarantinedSession: originalAbandonQuarantinedSession,
    });
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
    expect(document.querySelector<HTMLElement>('[data-portal-curtain-layer="mark"]')?.style.backgroundImage)
      .toContain('/logo-display.png');
    expect(localStorage.getItem('projects-last-selected')).toBeNull();
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(sessionStorage.getItem('portal:terminal-state:v1')).toBeNull();
    expect(sessionStorage.getItem('portal-module-reload:FilesPage')).toBe('1');
    expect(window.location.pathname).toBe('/dashboard');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
    expect(useAuthStore.getState().user?.authorizationVersion).toBe(2);
  });

  it('covers the first frame with an opaque branded composition that remains motion-safe', () => {
    quarantineWorkspaceAuthorization(
      'user-1',
      2,
      vi.fn(),
      '/static-assets/branding/customer-mark.png',
    );

    const curtain = document.getElementById('portal-workspace-authorization-curtain');
    const mark = curtain?.querySelector<HTMLElement>('[data-portal-curtain-layer="mark"]');
    const status = curtain?.querySelector<HTMLElement>('[data-portal-curtain-layer="status"]');
    const styles = document.getElementById('portal-workspace-authorization-curtain-style');
    expect(curtain?.style.background).toBe('rgb(10, 14, 39)');
    expect(curtain?.style.opacity).toBe('');
    expect(mark?.style.backgroundImage).toContain('/static-assets/branding/customer-mark.png');
    expect(status?.textContent).toContain('Verifying your permissions');
    expect(styles?.textContent).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('quotes an owner-provided curtain logo URL before assigning it to CSS', () => {
    showWorkspacePrivacyCurtain('/branding/customer"\\mark.png');

    const mark = document.querySelector<HTMLElement>('[data-portal-curtain-layer="mark"]');
    expect(mark?.style.backgroundImage).toContain('customer');
    expect(mark?.style.backgroundImage).toContain('mark.png');
    expect(mark?.style.opacity).toBe('0.04');
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

  it('bounds socket reconnect attempts and exposes sanitized recovery actions when they exhaust', async () => {
    const restoreSession = vi.fn(async () => true);
    useAuthStore.setState({ restoreSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;
    socket.connected = false;

    await act(async () => {
      for (let attempt = 0; attempt < WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS; attempt += 1) {
        socket.serverEmit('connect_error', new Error('internal host and credential detail'));
      }
    });

    const socketOptions = (socketHarness.io.mock.calls.at(-1) as unknown as [
      string,
      Record<string, unknown>,
    ])[1];
    expect(socketOptions).toMatchObject({
      reconnectionAttempts: WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS,
    });
    const retryButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Retry access check' });
    expect(retryButton.disabled).toBe(false);
    expect(document.activeElement).toBe(retryButton);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in again' }).disabled)
      .toBe(false);
    expect(document.getElementById('portal-workspace-authorization-curtain')?.textContent)
      .not.toContain('internal host and credential detail');
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('turns a stalled access check into a finite privacy-closed failure state', () => {
    vi.useFakeTimers();
    const restoreSession = vi.fn(() => new Promise<boolean>(() => {}));
    useAuthStore.setState({ restoreSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;

    act(() => socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 }));
    expect(document.getElementById('root')?.style.visibility).toBe('');
    act(() => {
      socket.connected = false;
      socket.serverEmit('disconnect', 'transport close');
      vi.advanceTimersByTime(WORKSPACE_AUTHORIZATION_CHECK_DEADLINE_MS);
    });

    expect(screen.getByRole('alert').textContent).toContain('Workspace access check unavailable');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry access check' }).disabled)
      .toBe(false);
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(document.getElementById('root')?.textContent).toContain('owner-secret-project');
  });

  it('bounds a BFCache revalidation even when the socket recovers but the REST probe stalls', () => {
    vi.useFakeTimers();
    const restoreSession = vi.fn(() => new Promise<boolean>(() => {}));
    useAuthStore.setState({ restoreSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;

    act(() => socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 }));
    expect(document.getElementById('root')?.style.visibility).toBe('');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(persistedPageShowEvent());
      socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 });
      vi.advanceTimersByTime(WORKSPACE_AUTHORIZATION_CHECK_DEADLINE_MS);
    });

    expect(screen.getByRole('alert').textContent).toContain('Workspace access check unavailable');
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(restoreSession).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry access check' }));
      socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 });
    });
    expect(document.getElementById('portal-workspace-authorization-curtain')).toBeNull();
    expect(document.getElementById('root')?.style.visibility).toBe('');
  });

  it('recovers only after retry receives a matching authorization snapshot', async () => {
    const restoreSession = vi.fn(async () => true);
    useAuthStore.setState({ restoreSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(vi.fn()));
    const socket = socketHarness.sockets.at(-1)!;
    socket.connected = false;

    await act(async () => {
      for (let attempt = 0; attempt < WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS; attempt += 1) {
        socket.serverEmit('connect_error', new Error('offline'));
      }
    });
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry access check' }));
    });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');

    act(() => socket.serverEmit('authorization_snapshot', { authorizationVersion: 1 }));
    expect(document.getElementById('portal-workspace-authorization-curtain')).toBeNull();
    expect(document.getElementById('root')?.style.visibility).toBe('');
  });

  it('keeps stale DOM covered and navigates to sign-in even when session abandonment fails', async () => {
    const navigate = vi.fn();
    const restoreSession = vi.fn(async () => true);
    const abandonQuarantinedSession = vi.fn(async () => {
      throw new Error('private logout transport detail');
    });
    useAuthStore.setState({ restoreSession, abandonQuarantinedSession });
    renderHook(() => useWorkspaceAuthorizationLifecycle(navigate));
    const socket = socketHarness.sockets.at(-1)!;
    socket.connected = false;

    await act(async () => {
      for (let attempt = 0; attempt < WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS; attempt += 1) {
        socket.serverEmit('connect_error', new Error('offline'));
      }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
    expect(abandonQuarantinedSession).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root')?.style.visibility).toBe('hidden');
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('portal-workspace-authorization-curtain')?.textContent)
      .not.toContain('private logout transport detail');
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
