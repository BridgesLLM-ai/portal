import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './contexts/AuthContext';
import { canUseInteractivePortal, isElevated } from './utils/authz';
import { ChatStateProvider } from './contexts/ChatStateProvider';
import { activityAPI } from './api/endpoints';
import { usePublicSettings } from './hooks/usePublicSettings';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SetupWizardPage from './pages/SetupWizardPage';
import LandingPage from './pages/LandingPage';
import DocsPage from './pages/DocsPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

const MODULE_RELOAD_PREFIX = 'portal-module-reload:';

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

function LegacyAgentToolsRedirect({ tab }: { tab: 'automations' | 'usage' | 'skills' }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('tab', tab);
  const search = params.toString();
  return <Navigate to={`/agent-tools${search ? `?${search}` : ''}`} replace />;
}

export default function App() {
  const { restoreSession, isAuthenticated } = useAuthStore();
  const heartbeatRef = useRef<ReturnType<typeof setInterval>>();
  const [setupChecked, setSetupChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [isReinstall, setIsReinstall] = useState<boolean>(false);
  const publicSettings = usePublicSettings();
  const setupModeActive = needsSetup || isReinstall;

  useEffect(() => {
    let cancelled = false;
    const bootstrapFailoverTimer = window.setTimeout(() => {
      if (!cancelled) {
        setSetupChecked(true);
      }
    }, 4000);

    const bootstrap = async () => {
      try {
        const res = await fetch('/api/setup/status');
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
        // ignore setup-check failure and continue normal restore flow
      }

      try {
        await restoreSession();
      } finally {
        window.clearTimeout(bootstrapFailoverTimer);
        if (!cancelled) {
          setSetupChecked(true);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      window.clearTimeout(bootstrapFailoverTimer);
    };
  }, [restoreSession]);


  useEffect(() => {
    if (publicSettings?.portalName) document.title = publicSettings.portalName;
    if (publicSettings?.logoUrl) {
      let link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = publicSettings.logoUrl;
    }
  }, [publicSettings]);

  // Session heartbeat — update last_activity every 5 min
  useEffect(() => {
    if (!isAuthenticated) return;
    const sendHeartbeat = () => activityAPI.heartbeat().catch(() => {});
    heartbeatRef.current = setInterval(sendHeartbeat, 5 * 60 * 1000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [isAuthenticated]);

  if (!setupChecked) {
    return <BootstrapFallback />;
  }

  return (
    <BrowserRouter>
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
                <ChatStateProvider>
                  <Layout />
                </ChatStateProvider>
              </ProtectedRoute>
            )
          }
        >
          <Route path="dashboard" element={<DashboardPage />} />
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
          element={setupModeActive ? <SetupWizardPage /> : <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />}
        />
        <Route path="*" element={setupModeActive ? <Navigate to="/setup" replace /> : isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
