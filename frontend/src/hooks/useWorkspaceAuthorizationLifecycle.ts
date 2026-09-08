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
import { resolvePortalLogoUrl } from '../utils/portalBranding';

const PRIVACY_CURTAIN_ID = 'portal-workspace-authorization-curtain';
const PRIVACY_CURTAIN_STYLE_ID = 'portal-workspace-authorization-curtain-style';
export const WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS = 6;
export const WORKSPACE_AUTHORIZATION_CHECK_DEADLINE_MS = 20_000;

// The curtain is a privacy control before it is a visual. Two rules constrain
// everything below. The opaque base colour is applied to the curtain element
// itself, synchronously, so the workspace is covered on the first frame -- only
// the ornamental layers fade in. And nothing here may block on the network: the
// mark resolves directly to the install's high-resolution display asset, and
// if it fails to decode the composition still reads as deliberate.
const CURTAIN_INK = '#0A0E27';
const CURTAIN_EMERALD = '16, 185, 129';

function curtainBackgroundImage(logoUrl: string): string {
  // A Portal owner can enter the generic logo URL as text. JSON string syntax
  // is also valid inside CSS url(), and safely quotes backslashes, quotes, and
  // control characters before the value reaches CSSOM.
  return `url(${JSON.stringify(logoUrl)})`;
}

function ensureCurtainStyles(): void {
  if (document.getElementById(PRIVACY_CURTAIN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PRIVACY_CURTAIN_STYLE_ID;
  style.textContent = `
@keyframes portal-curtain-rise { from { opacity: 0; } to { opacity: 1; } }
@keyframes portal-curtain-breathe {
  from { opacity: .045; transform: scale(1); }
  to   { opacity: .085; transform: scale(1.035); }
}
@keyframes portal-curtain-drift { from { background-position: 0 0; } to { background-position: 24px 24px; } }
@keyframes portal-curtain-sweep { from { transform: translate3d(-65%,0,0); } to { transform: translate3d(165%,0,0); } }
@keyframes portal-curtain-spin { to { transform: rotate(360deg); } }
@keyframes portal-curtain-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  #${PRIVACY_CURTAIN_ID} *, #${PRIVACY_CURTAIN_ID} { animation: none !important; }
}`;
  document.head.appendChild(style);
}

function curtainLayer(styles: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { position: 'absolute', inset: '0', ...styles });
  return layer;
}

function curtainStatusElement<T extends HTMLElement>(name: string): T | null {
  return document.querySelector<T>(
    `#${PRIVACY_CURTAIN_ID} [data-portal-curtain-status="${name}"]`,
  );
}

function curtainActionButton(label: string, onClick: () => void, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  Object.assign(button.style, {
    minHeight: '40px',
    padding: '8px 14px',
    borderRadius: '10px',
    border: primary
      ? `1px solid rgba(${CURTAIN_EMERALD},.7)`
      : '1px solid rgba(148,163,184,.35)',
    background: primary
      ? `rgba(${CURTAIN_EMERALD},.9)`
      : 'rgba(15,23,42,.72)',
    color: '#F8FAFC',
    font: '600 13px/1.2 inherit',
    cursor: 'pointer',
  });
  button.addEventListener('click', onClick);
  return button;
}

function showWorkspacePrivacyCurtainCheckingState(): void {
  const curtain = document.getElementById(PRIVACY_CURTAIN_ID);
  const pill = curtainStatusElement<HTMLDivElement>('container');
  const ring = curtainStatusElement<HTMLDivElement>('spinner');
  const label = curtainStatusElement<HTMLSpanElement>('label');
  const sub = curtainStatusElement<HTMLSpanElement>('detail');
  const beacon = curtainStatusElement<HTMLSpanElement>('beacon');
  if (!curtain || !pill || !ring || !label || !sub || !beacon) return;

  curtain.setAttribute('role', 'status');
  pill.querySelector('[data-portal-curtain-status="actions"]')?.remove();
  Object.assign(pill.style, {
    flexWrap: 'nowrap',
    justifyContent: 'flex-start',
    borderRadius: '999px',
  });
  ring.style.display = '';
  beacon.style.display = '';
  label.textContent = 'Refreshing workspace access…';
  label.style.whiteSpace = 'nowrap';
  sub.textContent = 'Verifying your permissions';
  sub.style.whiteSpace = 'nowrap';
}

interface WorkspacePrivacyCurtainRecoveryActions {
  onRetry: () => void;
  onSignInAgain: () => void;
}

/**
 * Convert the still-opaque privacy curtain into a bounded recovery surface.
 * Error objects and transport details deliberately never cross this boundary.
 */
export function showWorkspacePrivacyCurtainFailure(
  logoUrl: string | null | undefined,
  actions: WorkspacePrivacyCurtainRecoveryActions,
): void {
  showWorkspacePrivacyCurtain(logoUrl);
  const curtain = document.getElementById(PRIVACY_CURTAIN_ID);
  const pill = curtainStatusElement<HTMLDivElement>('container');
  const ring = curtainStatusElement<HTMLDivElement>('spinner');
  const label = curtainStatusElement<HTMLSpanElement>('label');
  const sub = curtainStatusElement<HTMLSpanElement>('detail');
  const beacon = curtainStatusElement<HTMLSpanElement>('beacon');
  if (!curtain || !pill || !ring || !label || !sub || !beacon) return;

  curtain.setAttribute('role', 'alert');
  ring.style.display = 'none';
  beacon.style.display = 'none';
  label.textContent = 'Workspace access check unavailable';
  label.style.whiteSpace = 'normal';
  sub.textContent = 'The Portal could not verify your permissions. Authenticated pages remain hidden.';
  sub.style.whiteSpace = 'normal';
  Object.assign(pill.style, {
    flexWrap: 'wrap',
    justifyContent: 'center',
    borderRadius: '18px',
  });

  pill.querySelector('[data-portal-curtain-status="actions"]')?.remove();
  const actionRow = document.createElement('div');
  actionRow.dataset.portalCurtainStatus = 'actions';
  Object.assign(actionRow.style, {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '8px',
    width: '100%',
    paddingTop: '4px',
  });
  const retryButton = curtainActionButton('Retry access check', actions.onRetry, true);
  actionRow.appendChild(retryButton);
  actionRow.appendChild(curtainActionButton('Sign in again', actions.onSignInAgain, false));
  pill.appendChild(actionRow);
  retryButton.focus({ preventScroll: true });
}

function showWorkspacePrivacyCurtainSignInPending(): void {
  const label = curtainStatusElement<HTMLSpanElement>('label');
  const sub = curtainStatusElement<HTMLSpanElement>('detail');
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    `#${PRIVACY_CURTAIN_ID} [data-portal-curtain-status="actions"] button`,
  );
  if (label) label.textContent = 'Preparing a fresh sign-in…';
  if (sub) sub.textContent = 'Authenticated pages remain hidden while this session is cleared.';
  buttons.forEach((button) => {
    button.disabled = true;
    button.style.cursor = 'wait';
    button.style.opacity = '.65';
  });
}

export function showWorkspacePrivacyCurtain(logoUrl?: string | null): void {
  if (typeof document === 'undefined') return;
  const resolvedLogoUrl = resolvePortalLogoUrl(logoUrl);
  const root = document.getElementById('root');
  if (root) {
    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (!root.dataset.authorizationPreviousVisibility) {
      root.dataset.authorizationPreviousVisibility = root.style.visibility || 'visible';
    }
    root.style.visibility = 'hidden';
    root.setAttribute('aria-hidden', 'true');
  }
  const existingCurtain = document.getElementById(PRIVACY_CURTAIN_ID);
  if (existingCurtain) {
    const existingMark = existingCurtain.querySelector<HTMLElement>('[data-portal-curtain-layer="mark"]');
    if (existingMark) existingMark.style.backgroundImage = curtainBackgroundImage(resolvedLogoUrl);
    return;
  }
  ensureCurtainStyles();

  const curtain = document.createElement('div');
  curtain.id = PRIVACY_CURTAIN_ID;
  curtain.setAttribute('role', 'status');
  curtain.setAttribute('aria-live', 'polite');
  Object.assign(curtain.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    isolation: 'isolate',
    background: CURTAIN_INK,
    color: '#F0F4F8',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    letterSpacing: '-0.01em',
  });

  // Everything decorative lives on one stage so a single fade brings it in.
  // Fading the children individually would mean an opacity animation on layers
  // that already carry a deliberate opacity, and the animation would win.
  const stage = curtainLayer({
    display: 'grid',
    placeItems: 'center',
    animation: 'portal-curtain-rise 260ms ease-out both',
  });
  // The visual children are individually hidden from assistive technology,
  // but the status/recovery controls below must remain reachable.
  stage.removeAttribute('aria-hidden');

  // Depth first: a cool wash lifts the centre off the flat navy so the mark and
  // the dot field have something to sit in.
  stage.appendChild(curtainLayer({
    background:
      `radial-gradient(120% 90% at 50% 42%, rgba(37,43,74,.85) 0%, rgba(10,14,39,0) 62%),`
      + `radial-gradient(80% 60% at 50% 118%, rgba(${CURTAIN_EMERALD},.10) 0%, rgba(10,14,39,0) 70%)`,
  }));

  // The install's own mark, oversized and translucent. Desaturating it first
  // means any uploaded logo -- whatever its palette -- resolves into the same
  // cool register instead of fighting the theme.
  const mark = curtainLayer({
    backgroundImage: curtainBackgroundImage(resolvedLogoUrl),
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center 46%',
    backgroundSize: 'min(78vmin, 880px)',
    filter: 'grayscale(1) brightness(1.45) contrast(1.05)',
    mixBlendMode: 'screen',
    opacity: '.04',
    animation: 'portal-curtain-breathe 9s ease-in-out infinite alternate',
  });
  mark.dataset.portalCurtainLayer = 'mark';
  stage.appendChild(mark);

  // Dot matrix, densest at the centre and dissolving outward.
  const matrixFade = 'radial-gradient(ellipse 68% 58% at 50% 50%, #000 0%, rgba(0,0,0,.5) 46%, transparent 78%)';
  const matrix = curtainLayer({
    backgroundImage:
      `radial-gradient(circle at center, rgba(${CURTAIN_EMERALD},.55) 1px, transparent 1.8px),`
      + `radial-gradient(circle at center, rgba(240,244,248,.16) 1px, transparent 1.8px)`,
    backgroundSize: '24px 24px, 24px 24px',
    backgroundPosition: '0 0, 12px 12px',
    opacity: '.9',
    animation: 'portal-curtain-drift 14s linear infinite',
  });
  matrix.style.setProperty('-webkit-mask-image', matrixFade);
  matrix.style.setProperty('mask-image', matrixFade);
  stage.appendChild(matrix);

  // A slow band of light crossing the field. Low contrast on purpose -- this is
  // seen many times a day and must never read as a flash.
  const sheen = curtainLayer({
    top: '-30%',
    bottom: '-30%',
    left: '0',
    width: '38%',
    background: 'linear-gradient(100deg, transparent 0%, rgba(240,244,248,.055) 50%, transparent 100%)',
    filter: 'blur(14px)',
    animation: 'portal-curtain-sweep 7.5s ease-in-out infinite',
  });
  stage.appendChild(sheen);

  // An uploaded logo can be any shape or density, so the status copy gets its
  // own pool of darkness rather than depending on whatever sits behind it.
  stage.appendChild(curtainLayer({
    background: 'radial-gradient(46% 26% at 50% 50%, rgba(10,14,39,.72) 0%, rgba(10,14,39,0) 70%)',
  }));

  const pill = document.createElement('div');
  pill.dataset.portalCurtainLayer = 'status';
  pill.dataset.portalCurtainStatus = 'container';
  Object.assign(pill.style, {
    position: 'relative',
    zIndex: '1',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 16px 12px 14px',
    borderRadius: '999px',
    maxWidth: 'calc(100vw - 24px)',
    boxSizing: 'border-box',
    background: 'rgba(26,31,58,.55)',
    border: '1px solid rgba(240,244,248,.07)',
    backdropFilter: 'blur(20px) saturate(1.2)',
    boxShadow: `0 20px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(${CURTAIN_EMERALD},.06), 0 0 44px rgba(${CURTAIN_EMERALD},.07)`,
  });
  (pill.style as unknown as Record<string, string>).webkitBackdropFilter = 'blur(20px) saturate(1.2)';

  const ring = document.createElement('div');
  ring.dataset.portalCurtainStatus = 'spinner';
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, {
    width: '17px',
    height: '17px',
    flex: '0 0 auto',
    borderRadius: '50%',
    border: `2px solid rgba(${CURTAIN_EMERALD},.20)`,
    borderTopColor: `rgb(${CURTAIN_EMERALD})`,
    animation: 'portal-curtain-spin 900ms linear infinite',
  });
  pill.appendChild(ring);

  const copy = document.createElement('div');
  Object.assign(copy.style, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });

  const label = document.createElement('span');
  label.dataset.portalCurtainStatus = 'label';
  label.textContent = 'Refreshing workspace access…';
  Object.assign(label.style, {
    font: '600 clamp(13px, 3.7vw, 14px)/1.25 inherit',
    color: '#F0F4F8',
    whiteSpace: 'nowrap',
  });

  const sub = document.createElement('span');
  sub.dataset.portalCurtainStatus = 'detail';
  sub.textContent = 'Verifying your permissions';
  Object.assign(sub.style, {
    font: '500 11.5px/1.25 inherit',
    color: '#94A3B8',
    letterSpacing: '.01em',
    whiteSpace: 'nowrap',
  });

  copy.appendChild(label);
  copy.appendChild(sub);
  pill.appendChild(copy);

  const beacon = document.createElement('span');
  beacon.dataset.portalCurtainStatus = 'beacon';
  beacon.setAttribute('aria-hidden', 'true');
  Object.assign(beacon.style, {
    width: '5px',
    height: '5px',
    marginLeft: '2px',
    borderRadius: '50%',
    flex: '0 0 auto',
    background: `rgb(${CURTAIN_EMERALD})`,
    boxShadow: `0 0 10px rgba(${CURTAIN_EMERALD},.9)`,
    animation: 'portal-curtain-pulse 1.9s ease-in-out infinite',
  });
  pill.appendChild(beacon);
  stage.appendChild(pill);

  // The opaque base above never fades, so the workspace is not briefly legible
  // through a translucent overlay while the ornament arrives.
  curtain.appendChild(stage);
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
  logoUrl?: string | null,
): void {
  showWorkspacePrivacyCurtain(logoUrl);
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
  logoUrl?: string | null,
): void {
  const { user, isAuthenticated, sessionRestoreError, restoreSession } = useAuthStore();
  const quarantinedRef = useRef(false);
  const logoUrlRef = useRef<string | null | undefined>(logoUrl);
  logoUrlRef.current = logoUrl;

  useEffect(() => {
    if (document.getElementById(PRIVACY_CURTAIN_ID)) {
      showWorkspacePrivacyCurtain(logoUrl);
    }
  }, [logoUrl]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id || sessionRestoreError) {
      hideWorkspacePrivacyCurtain();
      return;
    }

    const userId = user.id;
    const localVersion = Number(user.authorizationVersion ?? 1);
    showWorkspacePrivacyCurtain(logoUrlRef.current);
    showWorkspacePrivacyCurtainCheckingState();
    const wsUrl = import.meta.env.VITE_WS_URL
      || import.meta.env.VITE_API_URL?.replace('/api', '')
      || window.location.origin;
    let socket: Socket | null = null;
    let authProbe: Promise<void> | null = null;
    let trustedSocketVersion: number | null = null;
    let pageRestorePending = false;
    let disposed = false;
    let accessCheckFailed = false;
    let reconnectErrorCount = 0;
    let accessCheckDeadline: number | null = null;
    const hardNavigate = navigate ?? ((url: string) => window.location.replace(url));

    const clearAccessCheckDeadline = () => {
      if (accessCheckDeadline === null) return;
      window.clearTimeout(accessCheckDeadline);
      accessCheckDeadline = null;
    };

    const markAccessCheckFailed = () => {
      if (disposed || quarantinedRef.current || accessCheckFailed) return;
      accessCheckFailed = true;
      clearAccessCheckDeadline();
      showWorkspacePrivacyCurtainFailure(logoUrlRef.current, {
        onRetry: retryAccessCheck,
        onSignInAgain: signInAgain,
      });
      // Stop an exhausted manager from continuing quietly behind the recovery
      // surface. A deliberate retry below starts a fresh finite attempt window.
      socket?.disconnect();
    };

    const armAccessCheckDeadline = () => {
      if (disposed || quarantinedRef.current || accessCheckFailed || accessCheckDeadline !== null) return;
      accessCheckDeadline = window.setTimeout(
        markAccessCheckFailed,
        WORKSPACE_AUTHORIZATION_CHECK_DEADLINE_MS,
      );
    };

    const quarantine = (version: number) => {
      if (quarantinedRef.current) return;
      quarantinedRef.current = true;
      clearAccessCheckDeadline();
      quarantineWorkspaceAuthorization(userId, version, hardNavigate, logoUrlRef.current);
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
          if (disposed || quarantinedRef.current) return;
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
            clearAccessCheckDeadline();
            hideWorkspacePrivacyCurtain();
          }
        })
        .catch(() => {
          // The curtain exposes only the fixed recovery copy above. Provider,
          // network, and server error details may contain sensitive context.
        })
        .finally(() => {
          authProbe = null;
        });
    };

    function retryAccessCheck() {
      if (disposed || quarantinedRef.current) return;
      accessCheckFailed = false;
      reconnectErrorCount = 0;
      trustedSocketVersion = null;
      // A deliberate retry creates a fresh authenticated socket admission. A
      // matching snapshot can therefore recover even if an older BFCache REST
      // probe is still hung inside the auth store's single-flight request.
      pageRestorePending = false;
      showWorkspacePrivacyCurtain(logoUrlRef.current);
      showWorkspacePrivacyCurtainCheckingState();
      clearAccessCheckDeadline();
      armAccessCheckDeadline();
      verifyAfterTransportLoss();
      if (socket?.connected) socket.disconnect();
      socket?.connect();
    }

    function signInAgain() {
      if (disposed || quarantinedRef.current) return;
      // Keep cleanup from uncovering cached workspace DOM while the auth store
      // and hard navigation converge, including when server logout fails.
      quarantinedRef.current = true;
      accessCheckFailed = true;
      clearAccessCheckDeadline();
      showWorkspacePrivacyCurtainSignInPending();
      socket?.disconnect();
      void Promise.resolve()
        .then(() => useAuthStore.getState().abandonQuarantinedSession())
        .catch(() => undefined)
        .finally(() => hardNavigate('/login'));
    }

    armAccessCheckDeadline();

    socket = io(`${wsUrl}/authorization`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS,
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
        trustedSocketVersion = null;
        showWorkspacePrivacyCurtain(logoUrlRef.current);
        showWorkspacePrivacyCurtainCheckingState();
        armAccessCheckDeadline();
        verifyAfterTransportLoss();
        return;
      }
      trustedSocketVersion = version;
      reconnectErrorCount = 0;
      accessCheckFailed = false;
      if (!pageRestorePending && !quarantinedRef.current) {
        clearAccessCheckDeadline();
        hideWorkspacePrivacyCurtain();
      }
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
      if (disposed || quarantinedRef.current || accessCheckFailed) return;
      showWorkspacePrivacyCurtain(logoUrlRef.current);
      showWorkspacePrivacyCurtainCheckingState();
      armAccessCheckDeadline();
    });
    socket.on('connect_error', () => {
      trustedSocketVersion = null;
      if (disposed || quarantinedRef.current || accessCheckFailed) return;
      reconnectErrorCount += 1;
      showWorkspacePrivacyCurtain(logoUrlRef.current);
      showWorkspacePrivacyCurtainCheckingState();
      armAccessCheckDeadline();
      verifyAfterTransportLoss();
      if (reconnectErrorCount >= WORKSPACE_AUTHORIZATION_RECONNECT_ATTEMPTS) {
        markAccessCheckFailed();
      }
    });

    const onPageHide = () => showWorkspacePrivacyCurtain(logoUrlRef.current);
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || quarantinedRef.current) return;
      pageRestorePending = true;
      showWorkspacePrivacyCurtain(logoUrlRef.current);
      showWorkspacePrivacyCurtainCheckingState();
      armAccessCheckDeadline();
      verifyAfterTransportLoss();
      if (!socket?.connected || trustedSocketVersion !== localVersion) socket?.connect();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      disposed = true;
      clearAccessCheckDeadline();
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
