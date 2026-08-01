import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../contexts/AuthContext';
import { clearWorkspaceClientState } from '../utils/clearWorkspaceClientState';
import {
  WORKSPACE_AUTHORIZATION_CHANGED_EVENT,
  announceWorkspaceAuthorizationVersion,
  observedWorkspaceAuthorizationVersion,
  setWorkspaceAuthorizationBaseline,
  type WorkspaceAuthorizationChangeDetail,
} from '../utils/workspaceAuthorization';

const PRIVACY_CURTAIN_ID = 'portal-workspace-authorization-curtain';

export function showWorkspacePrivacyCurtain(): void {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('root');
  if (root) {
    if (!root.dataset.authorizationPreviousVisibility) {
      root.dataset.authorizationPreviousVisibility = root.style.visibility || 'visible';
    }
    root.style.visibility = 'hidden';
    root.setAttribute('aria-hidden', 'true');
  }
  if (document.getElementById(PRIVACY_CURTAIN_ID)) return;
  const curtain = document.createElement('div');
  curtain.id = PRIVACY_CURTAIN_ID;
  curtain.setAttribute('role', 'status');
  curtain.setAttribute('aria-live', 'polite');
  curtain.textContent = 'Refreshing workspace access…';
  Object.assign(curtain.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'grid',
    placeItems: 'center',
    background: '#05070b',
    color: '#d1fae5',
    font: '600 14px system-ui, sans-serif',
  });
  document.body.appendChild(curtain);
}

export function hideWorkspacePrivacyCurtain(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(PRIVACY_CURTAIN_ID)?.remove();
  const root = document.getElementById('root');
  if (!root) return;
  const previous = root.dataset.authorizationPreviousVisibility;
  if (previous === 'visible') root.style.removeProperty('visibility');
  else if (previous !== undefined) root.style.visibility = previous;
  delete root.dataset.authorizationPreviousVisibility;
  root.removeAttribute('aria-hidden');
}

export function quarantineWorkspaceAuthorization(
  userId: string,
  authorizationVersion: number,
  navigate: (url: string) => void = (url) => window.location.replace(url),
): void {
  showWorkspacePrivacyCurtain();
  try {
    clearWorkspaceClientState();
  } catch {
    // Storage can be unavailable in hardened/private browser modes. The
    // privacy curtain and hard navigation remain mandatory.
  }
  try {
    useAuthStore.setState((state) => ({
      user: state.user?.id === userId
        ? { ...state.user, authorizationVersion }
        : state.user,
    }));
  } catch {
    // A persistence adapter failure must not prevent the hard reload.
  }
  try {
    window.history.replaceState({}, '', '/dashboard');
  } catch {
    // The hard navigation below remains authoritative.
  }
  navigate('/dashboard');
}

export function useWorkspaceAuthorizationLifecycle(
  navigate?: (url: string) => void,
): void {
  const { user, isAuthenticated, sessionRestoreError, restoreSession } = useAuthStore();
  const quarantinedRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !user?.id || sessionRestoreError) {
      hideWorkspacePrivacyCurtain();
      return;
    }

    const userId = user.id;
    const localVersion = Number(user.authorizationVersion ?? 1);
    showWorkspacePrivacyCurtain();
    const wsUrl = import.meta.env.VITE_WS_URL
      || import.meta.env.VITE_API_URL?.replace('/api', '')
      || window.location.origin;
    let socket: Socket | null = null;
    let authProbe: Promise<void> | null = null;
    let trustedSocketVersion: number | null = null;
    let pageRestorePending = false;

    const quarantine = (version: number) => {
      if (quarantinedRef.current) return;
      quarantinedRef.current = true;
      quarantineWorkspaceAuthorization(userId, version, navigate);
    };

    // A response may observe a newer generation between React effect teardown
    // and listener registration. Never promote that observation into the local
    // baseline: it represents a scope change that still requires quarantine.
    const alreadyObservedVersion = observedWorkspaceAuthorizationVersion(userId);
    if (alreadyObservedVersion > localVersion) {
      quarantine(alreadyObservedVersion);
      return;
    }
    setWorkspaceAuthorizationBaseline(userId, localVersion);

    const onAuthorizationChange = (raw: Event) => {
      const event = raw as CustomEvent<WorkspaceAuthorizationChangeDetail>;
      if (event.detail?.userId !== userId) return;
      quarantine(event.detail.authorizationVersion);
    };
    window.addEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, onAuthorizationChange);

    const verifyAfterTransportLoss = () => {
      if (authProbe) return;
      authProbe = restoreSession()
        .then((restored) => {
          if (!restored) return;
          const restoredUser = useAuthStore.getState().user;
          const restoredVersion = Number(restoredUser?.authorizationVersion || 1);
          if (restoredUser?.id === userId && restoredVersion > localVersion) {
            announceWorkspaceAuthorizationVersion(userId, restoredVersion, 'socket');
          } else if (restoredUser?.id === userId
              && restoredVersion === localVersion
              && socket?.connected
              && trustedSocketVersion === localVersion
              && !quarantinedRef.current) {
            pageRestorePending = false;
            hideWorkspacePrivacyCurtain();
          }
        })
        .finally(() => {
          authProbe = null;
        });
    };

    socket = io(`${wsUrl}/authorization`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socket.on('authorization_snapshot', (snapshot: { authorizationVersion?: unknown }) => {
      const version = Number(snapshot?.authorizationVersion);
      if (Number.isSafeInteger(version) && version > localVersion) {
        announceWorkspaceAuthorizationVersion(userId, version, 'socket');
        return;
      }
      if (!Number.isSafeInteger(version) || version !== localVersion) {
        showWorkspacePrivacyCurtain();
        verifyAfterTransportLoss();
        return;
      }
      trustedSocketVersion = version;
      if (!pageRestorePending && !quarantinedRef.current) hideWorkspacePrivacyCurtain();
    });
    socket.on('authorization_changed', (event: {
      userId?: unknown;
      authorizationVersion?: unknown;
    }) => {
      if (event?.userId !== userId) return;
      announceWorkspaceAuthorizationVersion(userId, event.authorizationVersion, 'socket');
    });
    socket.on('disconnect', () => {
      trustedSocketVersion = null;
      if (!quarantinedRef.current) showWorkspacePrivacyCurtain();
    });
    socket.on('connect_error', () => {
      trustedSocketVersion = null;
      if (!quarantinedRef.current) showWorkspacePrivacyCurtain();
      verifyAfterTransportLoss();
    });

    const onPageHide = () => showWorkspacePrivacyCurtain();
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || quarantinedRef.current) return;
      pageRestorePending = true;
      showWorkspacePrivacyCurtain();
      verifyAfterTransportLoss();
      if (!socket?.connected || trustedSocketVersion !== localVersion) socket?.connect();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      window.removeEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, onAuthorizationChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      socket?.disconnect();
      if (!quarantinedRef.current) hideWorkspacePrivacyCurtain();
    };
  }, [
    isAuthenticated,
    restoreSession,
    sessionRestoreError,
    user?.authorizationVersion,
    user?.id,
    navigate,
  ]);
}
