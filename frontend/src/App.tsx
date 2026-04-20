import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './contexts/AuthContext';
import { canUseInteractivePortal, isElevated } from './utils/authz';
import { ChatStateProvider } from './contexts/ChatStateProvider';
import { activityAPI } from './api/endpoints';
import { usePublicSettings } from './hooks/usePublicSettings';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SetupWizardPage from './pages/SetupWizardPage';
import LandingPage from './pages/LandingPage';
import DocsPage from './pages/DocsPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

const DesktopPage = lazy(() => import('./pages/DesktopPage'));
const AppsPage = lazy(() => import('./pages/AppsPage'));
const FilesPage = lazy(() => import('./pages/FilesPage'));
const AgentChatPage = lazy(() => import('./pages/AgentChatPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const MailPage = lazy(() => import('./pages/MailPage'));
const AgentToolsPage = lazy(() => import('./pages/AgentToolsPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));

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
          <Route path="files" element={<InteractiveRoute><Suspense fallback={<RouteFallback />}><FilesPage /></Suspense></InteractiveRoute>} />
          {/* Terminal is rendered persistently in Layout.tsx — this route just prevents fallback */}
          <Route path="terminal" element={<AdminRoute><div /></AdminRoute>} />
          <Route path="desktop" element={<AdminRoute><Suspense fallback={<RouteFallback />}><DesktopPage /></Suspense></AdminRoute>} />
          <Route path="apps" element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<InteractiveRoute><Suspense fallback={<RouteFallback />}><AppsPage /></Suspense></InteractiveRoute>} />
          <Route path="agent-chats" element={<AdminRoute><Suspense fallback={<RouteFallback />}><AgentChatPage /></Suspense></AdminRoute>} />
          <Route path="agent-tools" element={<AdminRoute><Suspense fallback={<RouteFallback />}><AgentToolsPage /></Suspense></AdminRoute>} />
          <Route path="tasks" element={<AdminRoute><Suspense fallback={<RouteFallback />}><TasksPage /></Suspense></AdminRoute>} />
          {/* Backward compatibility redirects */}
          <Route path="automations" element={<LegacyAgentToolsRedirect tab="automations" />} />
          <Route path="usage" element={<LegacyAgentToolsRedirect tab="usage" />} />
          <Route path="skills" element={<LegacyAgentToolsRedirect tab="skills" />} />
          <Route path="mail" element={<InteractiveRoute><Suspense fallback={<RouteFallback />}><MailPage /></Suspense></InteractiveRoute>} />
          <Route path="settings" element={<Suspense fallback={<RouteFallback />}><SettingsPage /></Suspense>} />
          <Route path="admin" element={<AdminRoute><Suspense fallback={<RouteFallback />}><AdminPage /></Suspense></AdminRoute>} />
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
