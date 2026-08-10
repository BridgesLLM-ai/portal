import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './contexts/AuthContext';
import { canUseInteractivePortal, isElevated } from './utils/authz';
import { activityAPI } from './api/endpoints';
import { usePublicSettings } from './hooks/usePublicSettings';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import { RouteOperationProvider } from './contexts/RouteOperationContext';
import { useWorkspaceAuthorizationLifecycle } from './hooks/useWorkspaceAuthorizationLifecycle';
import {
  isVendorPortalBrandingPath,
  synchronizePortalIconLinks,
} from './utils/portalBranding';
import { usePortalUpdateSessionRecovery } from './hooks/usePortalUpdateSessionRecovery';

const MODULE_RELOAD_PREFIX = 'portal-module-reload:';
const SETUP_STATUS_TIMEOUT_MS = 8_000;

function isModuleLoadFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload css|loading chunk \d+ failed/i.test(message);
}

function getReloadMarker(key: string) {
  return `${MODULE_RELOAD_PREFIX}${key}`;
}

function lazyWithModuleRetry<T extends { default: React.ComponentType<unknown> }>(
  key: string,
  loader: () => Promise<T>
) {
  return lazy(async () => {
    try {
      const module = await loader();
      try {
        window.sessionStorage.removeItem(getReloadMarker(key));
      } catch {
        // Session storage may be unavailable in strict/private browser modes.
      }
      return module;
    } catch (error) {
      if (typeof window !== 'undefined' && isModuleLoadFailure(error)) {
        try {
          const marker = getReloadMarker(key);
          if (window.sessionStorage.getItem(marker) !== '1') {
            window.sessionStorage.setItem(marker, '1');
            const url = new URL(window.location.href);
            url.searchParams.set('reload', Date.now().toString());
            window.location.replace(url.toString());
            return new Promise<T>(() => {});
          }
        } catch {
          window.location.reload();
          return new Promise<T>(() => {});
        }
      }
      throw error;
    }
  });
}

const DesktopPage = lazyWithModuleRetry('DesktopPage', () => import('./pages/DesktopPage'));
const PortalLayoutShell = lazyWithModuleRetry('PortalLayoutShell', () => import('./components/PortalLayoutShell'));
const DashboardPage = lazyWithModuleRetry('DashboardPage', () => import('./pages/DashboardPage'));
const SetupWizardPage = lazyWithModuleRetry('SetupWizardPage', () => import('./pages/SetupWizardPage'));
const LandingPage = lazyWithModuleRetry('LandingPage', () => import('./pages/LandingPage'));
const DocsPage = lazyWithModuleRetry('DocsPage', () => import('./pages/DocsPage'));
const AppsPage = lazyWithModuleRetry('AppsPage', () => import('./pages/AppsPage'));
const FilesPage = lazyWithModuleRetry('FilesPage', () => import('./pages/FilesPage'));
const AgentChatPage = lazyWithModuleRetry('AgentChatPage', () => import('./pages/AgentChatPage'));
const SettingsPage = lazyWithModuleRetry('SettingsPage', () => import('./pages/SettingsPage'));
const AdminPage = lazyWithModuleRetry('AdminPage', () => import('./pages/AdminPage'));
const MailPage = lazyWithModuleRetry('MailPage', () => import('./pages/MailPage'));
const AgentToolsPage = lazyWithModuleRetry('AgentToolsPage', () => import('./pages/AgentToolsPage'));
const TasksPage = lazyWithModuleRetry('TasksPage', () => import('./pages/TasksPage'));

function buildLoginRedirectTarget(location: ReturnType<typeof useLocation>) {
  const target = `${location.pathname}${location.search}${location.hash}`;
  if (!target || target === '/' || target === '/login') {
    return '/login';
  }
  return `/login?redirect=${encodeURIComponent(target)}`;
}

function LoginRedirect() {
  const location = useLocation();
  return <Navigate to={buildLoginRedirectTarget(location)} replace />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  return isAuthenticated ? <>{children}</> : <LoginRedirect />;
}

function InteractiveRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  return canUseInteractivePortal(user) ? <>{children}</> : <Navigate to="/dashboard" replace />;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  return isElevated(user) ? <>{children}</> : <Navigate to="/dashboard" replace />;
}

function RouteFallback() {
  return <div className="h-full w-full bg-theme-bg" />;
}

function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

function BootstrapFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-theme-bg px-6 text-center text-theme-text">
      <div>
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-emerald-500/30 border-t-emerald-400" />
        <p className="text-sm font-medium text-slate-200">Checking your portal session…</p>
        <p className="mt-2 text-xs text-slate-400">If you are signed out, we will send you to login.</p>
      </div>
    </div>
  );
}

export function SessionRestoreFallback({
  onRetry,
  onSignOut,
  updateRecovery,
}: {
  onRetry: () => void;
  onSignOut: () => void;
  updateRecovery: ReturnType<typeof usePortalUpdateSessionRecovery>;
}) {
  // Retry is the right first move, but it is not always the answer: if the
  // cached session cannot be confirmed at all, retrying forever is a dead end.
  // Signing out has to be reachable from this screen.
  const [signingOut, setSigningOut] = useState(false);
  if (updateRecovery.operationId) {
    const progress = updateRecovery.checkpoint;
    const percent = progress?.percent ?? null;
    const phase = progress?.label || 'Restarting the Portal';
    return (
      <div className="flex min-h-dvh items-center justify-center bg-theme-bg px-6 text-theme-text">
        <div className="w-full max-w-lg rounded-2xl border border-theme-border bg-theme-surface p-6 shadow-2xl shadow-black/30">
          <div className="sr-only" role="status" aria-live="polite">
            Portal update is continuing. Reconnecting automatically.
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Signed Portal update</p>
          <h1 className="mt-2 text-xl font-semibold text-theme-text">Portal is restarting</h1>
          <p className="mt-2 text-sm leading-6 text-theme-muted">
            The server-owned update is still running. This screen will reconnect automatically; no second update will be started.
          </p>

          {percent !== null ? (
            <div className="mt-6">
              <div className="mb-2 flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-theme-text">{phase}</p>
                  <p className="mt-1 text-xs text-theme-muted">Last confirmed server checkpoint</p>
                </div>
                <span className="text-2xl font-semibold tabular-nums text-emerald-400">{percent}%</span>
              </div>
              <div
                className="h-2.5 overflow-hidden rounded-full bg-theme-bg"
                role="progressbar"
                aria-label="Portal update progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${percent}% complete. ${phase}. Portal is restarting and will reconnect automatically.`}
              >
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 motion-reduce:transition-none"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {progress?.detail ? (
                <p className="mt-3 text-xs leading-5 text-theme-muted">{progress.detail}</p>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-theme-border bg-theme-bg/60 px-4 py-3 text-sm text-theme-muted">
              Waiting for the first durable progress checkpoint…
            </div>
          )}

          <div className="mt-5 flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-amber-400 motion-reduce:animate-none" />
            <div>
              <p className="text-sm font-medium text-amber-100">
                {updateRecovery.isRetrying ? 'Checking the Portal now…' : 'Reconnecting automatically…'}
              </p>
              <p className="mt-0.5 text-xs text-amber-100/70">
                {updateRecovery.attemptCount === 0
                  ? 'The first reconnect check is queued.'
                  : `${updateRecovery.attemptCount} reconnect ${updateRecovery.attemptCount === 1 ? 'check' : 'checks'} completed.`}
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void updateRecovery.retryNow()}
              disabled={signingOut || updateRecovery.isRetrying}
              className="min-h-[44px] flex-1 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 disabled:opacity-60"
            >
              {updateRecovery.isRetrying ? 'Checking…' : 'Retry now'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSigningOut(true);
                onSignOut();
              }}
              disabled={signingOut}
              className="min-h-[44px] flex-1 rounded-xl border border-theme-border bg-theme-bg/60 px-4 py-2 text-sm font-semibold text-theme-muted hover:text-theme-text disabled:opacity-60"
            >
              {signingOut ? 'Signing out…' : 'Sign out instead'}
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-theme-muted">
            Signing out does not stop the server-owned update. An owner can reattach from the Dashboard after signing in again.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-dvh items-center justify-center bg-theme-bg px-6 text-center text-theme-text" role="alert">
      <div className="max-w-md rounded-2xl border border-amber-500/20 bg-amber-500/10 p-6">
        <h1 className="text-lg font-semibold text-white">Session check unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          The Portal could not confirm your cached session, so authenticated pages remain locked.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={onRetry}
            disabled={signingOut}
            className="min-h-[44px] rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 disabled:opacity-60"
          >
            Retry session check
          </button>
          <button
            type="button"
            onClick={() => {
              setSigningOut(true);
              onSignOut();
            }}
            disabled={signingOut}
            className="min-h-[44px] rounded-xl border border-slate-500/40 bg-slate-900/40 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900/70 disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out and start fresh'}
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          Signing out clears the cached session on this device and returns you to the login page.
        </p>
      </div>
    </div>
  );
}

function LegacyAgentToolsRedirect({ tab }: { tab: 'automations' | 'usage' | 'skills' }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('tab', tab);
  const search = params.toString();
  return <Navigate to={`/agent-tools${search ? `?${search}` : ''}`} replace />;
}

function PortalBrandingLifecycle() {
  const location = useLocation();
  const publicSettings = usePublicSettings();
  const vendorBrandingSurface = isVendorPortalBrandingPath(location.pathname);
  const tenantLogoUrl = vendorBrandingSurface ? '' : publicSettings?.logoUrl;

  useWorkspaceAuthorizationLifecycle(undefined, tenantLogoUrl);

  useEffect(() => {
    document.title = vendorBrandingSurface
      ? 'BridgesLLM Portal'
      : publicSettings?.portalName?.trim() || 'BridgesLLM Portal';
    synchronizePortalIconLinks(tenantLogoUrl);
  }, [publicSettings?.portalName, tenantLogoUrl, vendorBrandingSurface]);

  return null;
}

export default function App() {
  const {
    restoreSession,
    isAuthenticated,
    sessionRestoreError,
    sessionRestoreRetryable,
    abandonQuarantinedSession,
  } = useAuthStore();
  const heartbeatRef = useRef<ReturnType<typeof setInterval>>();
  const [setupChecked, setSetupChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [isReinstall, setIsReinstall] = useState<boolean>(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const setupModeActive = needsSetup || isReinstall;
  const updateSessionRecovery = usePortalUpdateSessionRecovery({
    enabled: sessionRestoreError && sessionRestoreRetryable,
    restoreSession,
  });

  useEffect(() => {
    let cancelled = false;
    const setupController = new AbortController();
    const setupTimeout = window.setTimeout(() => setupController.abort(), SETUP_STATUS_TIMEOUT_MS);

    const bootstrap = async () => {
      try {
        const res = await fetch('/api/setup/status', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: setupController.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          setNeedsSetup(Boolean(data.needsSetup));
          setIsReinstall(Boolean(data.isReinstall));

          if ((data.needsSetup || data.isReinstall) && window.location.pathname !== '/setup') {
            window.location.assign('/setup' + window.location.search);
            return;
          }
        }
      } catch {
        // A slow/unavailable setup check must not strand session restoration.
      } finally {
        window.clearTimeout(setupTimeout);
      }

      try {
        await restoreSession();
      } finally {
        if (!cancelled) {
          setSetupChecked(true);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      setupController.abort();
      window.clearTimeout(setupTimeout);
    };
  }, [restoreSession, bootstrapAttempt]);

  // Session heartbeat — update last_activity every 5 min
  useEffect(() => {
    if (!isAuthenticated || sessionRestoreError) return;
    const sendHeartbeat = () => activityAPI.heartbeat().catch(() => {});
    heartbeatRef.current = setInterval(sendHeartbeat, 5 * 60 * 1000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [isAuthenticated, sessionRestoreError]);

  if (!setupChecked) {
    return <BootstrapFallback />;
  }

  if (sessionRestoreError) {
    return (
      <SessionRestoreFallback
        updateRecovery={updateSessionRecovery}
        onRetry={() => {
          setSetupChecked(false);
          setBootstrapAttempt((attempt) => attempt + 1);
        }}
        onSignOut={() => {
          // A full navigation, not a router push: the router is not mounted in
          // this state, and reloading also drops any wedged in-memory client.
          void abandonQuarantinedSession().finally(() => {
            window.location.replace('/login');
          });
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <PortalBrandingLifecycle />
      <RouteOperationProvider>
        <Routes>
        <Route
          path="/login"
          element={
            setupModeActive ? (
              <Navigate to="/setup" replace />
            ) : isAuthenticated ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <LoginPage />
            )
          }
        />
        <Route
          path="/forgot-password"
          element={
            setupModeActive ? (
              <Navigate to="/setup" replace />
            ) : isAuthenticated ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <ForgotPasswordPage />
            )
          }
        />
        <Route
          path="/reset-password"
          element={
            setupModeActive ? (
              <Navigate to="/setup" replace />
            ) : isAuthenticated ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <ResetPasswordPage />
            )
          }
        />
        <Route
          path="/"
          element={
            setupModeActive ? (
              <Navigate to="/setup" replace />
            ) : isAuthenticated ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <LoginRedirect />
            )
          }
        />
        <Route
          path="/landing"
          element={<LandingPage />}
        />
        <Route
          path="/docs"
          element={
            setupModeActive ? (
              <Navigate to="/setup" replace />
            ) : isAuthenticated ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <DocsPage />
            )
          }
        />
        <Route
          path="/"
          element={
            setupModeActive ? (
              <Navigate to="/setup" replace />
            ) : (
              <ProtectedRoute>
                <LazyRoute>
                  <PortalLayoutShell />
                </LazyRoute>
              </ProtectedRoute>
            )
          }
        >
          <Route path="dashboard" element={<LazyRoute><DashboardPage /></LazyRoute>} />
          <Route path="errors" element={<div />} />
          <Route path="files" element={<InteractiveRoute><LazyRoute><FilesPage /></LazyRoute></InteractiveRoute>} />
          {/* Terminal is rendered persistently in Layout.tsx — this route just prevents fallback */}
          <Route path="terminal" element={<AdminRoute><div /></AdminRoute>} />
          <Route path="desktop" element={<AdminRoute><LazyRoute><DesktopPage /></LazyRoute></AdminRoute>} />
          <Route path="apps" element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<InteractiveRoute><LazyRoute><AppsPage /></LazyRoute></InteractiveRoute>} />
          <Route path="agent-chats" element={<AdminRoute><LazyRoute><AgentChatPage /></LazyRoute></AdminRoute>} />
          <Route path="agent-tools" element={<AdminRoute><LazyRoute><AgentToolsPage /></LazyRoute></AdminRoute>} />
          <Route path="tasks" element={<AdminRoute><LazyRoute><TasksPage /></LazyRoute></AdminRoute>} />
          {/* Backward compatibility redirects */}
          <Route path="automations" element={<LegacyAgentToolsRedirect tab="automations" />} />
          <Route path="usage" element={<LegacyAgentToolsRedirect tab="usage" />} />
          <Route path="skills" element={<LegacyAgentToolsRedirect tab="skills" />} />
          <Route path="mail" element={<InteractiveRoute><LazyRoute><MailPage /></LazyRoute></InteractiveRoute>} />
          <Route path="settings" element={<LazyRoute><SettingsPage /></LazyRoute>} />
          <Route path="admin" element={<AdminRoute><LazyRoute><AdminPage /></LazyRoute></AdminRoute>} />
        </Route>
        <Route
          path="/setup"
          element={setupModeActive ? <LazyRoute><SetupWizardPage /></LazyRoute> : <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />}
        />
        <Route path="*" element={setupModeActive ? <Navigate to="/setup" replace /> : isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginRedirect />} />
        </Routes>
      </RouteOperationProvider>
    </BrowserRouter>
  );
}
