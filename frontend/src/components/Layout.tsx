import { useState, useEffect, useCallback, memo, lazy, Suspense, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { usePublicSettings, type PortalFeatureAvailability } from '../hooks/usePublicSettings';
import { useIsMobile } from '../hooks/useIsMobile';
import { motion } from 'framer-motion';
import { useAuthStore } from '../contexts/AuthContext';
import FloatingUploadIndicator from './FloatingUploadIndicator';
import OllamaControl from './OllamaControl';
import ErrorPanel from './ErrorPanel';
import ErrorBoundary from './ErrorBoundary';
import PendingQuestionToasts from './PendingQuestionToasts';
import { subscribeErrors, initGlobalErrorHandlers, type StoredError } from '../utils/errorHandler';
import sounds from '../utils/sounds';
import UserAvatar from './UserAvatar';
import ViewportModal from './ViewportModal';
import { canUseInteractivePortal, isElevated } from '../utils/authz';
import { isRouteOperationOwned, useRouteOperationGuard } from '../contexts/RouteOperationContext';
import { gatewayAPI } from '../api/endpoints';
import type { GatewayPendingQuestion } from '../api/endpoints';
import { resolvePortalLogoUrl } from '../utils/portalBranding';
import {
  LayoutDashboard, Terminal, Rocket, MessageCircle, Settings, Monitor, FolderOpen,
  LogOut, Menu, X, ChevronRight, Bug, Shield, Mail, Wrench
} from 'lucide-react';

const TerminalPage = lazy(() => import('../pages/TerminalPage'));

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/agent-chats', icon: MessageCircle, label: 'Agent Chats', interactiveOnly: true, adminOnly: true },
  { to: '/agent-tools', icon: Wrench, label: 'Agent Tools', interactiveOnly: true, adminOnly: true },
  { to: '/mail', icon: Mail, label: 'Mail', interactiveOnly: true },
  { to: '/projects', icon: Rocket, label: 'Projects', interactiveOnly: true },
  { to: '/files', icon: FolderOpen, label: 'Files', interactiveOnly: true },
  { to: '/terminal', icon: Terminal, label: 'Terminal', interactiveOnly: true, adminOnly: true },
  { to: '/desktop', icon: Monitor, label: 'Remote Desktop', interactiveOnly: true, adminOnly: true },
];

interface SidebarContentProps {
  collapsed: boolean;
  assistantName: string;
  errorCount: number;
  user: { username: string; role: string } | null;
  onNavClick: () => void;
  onErrorPanelOpen: () => void;
  onLogout: () => void;
  navigationBlocked: boolean;
  mailAvailability?: PortalFeatureAvailability;
  pendingQuestionCounts: Readonly<{ agent: number; project: number }>;
}

/**
 * Defined OUTSIDE Layout so React never remounts it on parent re-renders.
 * Wrapped in memo so it only re-renders when its props actually change.
 */
const SidebarContent = memo(function SidebarContent({
  collapsed,
  assistantName,
  errorCount,
  user,
  onNavClick,
  onErrorPanelOpen,
  onLogout,
  navigationBlocked,
  mailAvailability,
  pendingQuestionCounts,
}: SidebarContentProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Assistant Profile Card */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-theme-border">
        <UserAvatar assistant editable size={collapsed ? 'w-11 h-11' : 'w-14 h-14'} />
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="min-w-0"
          >
            <h1 className="text-base font-bold text-theme-text leading-tight">{assistantName}</h1>
            <p className="text-[11px] accent-text opacity-70 font-medium">Assistant</p>
          </motion.div>
        )}
      </div>

      {/* Nav */}
      <nav aria-label="Primary navigation" className="flex-1 min-h-0 overflow-y-auto py-4 px-2 space-y-1">
        {navItems
          .filter(({ interactiveOnly, adminOnly }) => (!interactiveOnly || canUseInteractivePortal(user)) && (!adminOnly || isElevated(user)))
          .map(({ to, icon: Icon, label }) => {
            const isMail = to === '/mail';
            const mailState = !isMail || mailAvailability?.available === true
              ? null
              : mailAvailability?.available === false
                ? 'unavailable'
                : 'checking availability';
            const mailBadge = mailState === 'unavailable' ? 'Unavailable' : 'Checking';
            const linkLabel = mailState ? `${label} — ${mailState}` : (collapsed ? label : undefined);
            const pendingCount = to === '/agent-chats'
              ? pendingQuestionCounts.agent
              : to === '/projects'
                ? pendingQuestionCounts.project
                : 0;

            return (
              <NavLink
                key={to}
                to={to}
                aria-label={linkLabel}
                aria-disabled={navigationBlocked || undefined}
                title={mailState
                  ? `${label} ${mailState}.${mailAvailability?.reason ? ` ${mailAvailability.reason}` : ''}`
                  : undefined}
                tabIndex={navigationBlocked ? -1 : undefined}
                onClick={(event) => {
                  if (navigationBlocked || isRouteOperationOwned()) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  sounds.click();
                  onNavClick();
                }}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group
                  ${isActive
                    ? 'accent-active border'
                    : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
                  } ${navigationBlocked ? 'pointer-events-none cursor-wait opacity-40' : ''}`
                }
              >
                <span className="relative flex-shrink-0">
                  <Icon size={20} aria-hidden="true" />
                  {collapsed && mailState && (
                    <span
                      aria-hidden="true"
                      className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-theme-surface ${
                        mailState === 'unavailable' ? 'bg-amber-400' : 'bg-slate-400'
                      }`}
                    />
                  )}
                  {collapsed && pendingCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-500 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-theme-surface"
                    >
                      {pendingCount > 9 ? '9+' : pendingCount}
                    </span>
                  )}
                </span>
                {!collapsed && (
                  <>
                    <span>{label}</span>
                    {mailState && (
                      <span
                        aria-hidden="true"
                        className={`ml-auto rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                          mailState === 'unavailable'
                            ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                            : 'border-slate-500/30 bg-slate-500/10 text-slate-400'
                        }`}
                      >
                        {mailBadge}
                      </span>
                    )}
                    {pendingCount > 0 && (
                      <span
                        role="status"
                        className="ml-auto rounded-full border border-violet-400/30 bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-200"
                      >
                        {pendingCount} waiting
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
      </nav>

      {/* Ollama + Error Panel + Settings + Logout */}
      <div className="px-3 py-4 border-t border-theme-border space-y-1">
        {isElevated(user) && <OllamaControl collapsed={collapsed} />}
        {user && (
          <div className={`mb-2 ${collapsed ? 'flex justify-center' : 'px-2'}`}>
            <div className={`flex items-center ${collapsed ? '' : 'gap-2'}`}>
              <UserAvatar size="w-9 h-9" editable={true} />
              {!collapsed && <span className="text-xs text-slate-400 truncate">{user.username}</span>}
            </div>
          </div>
        )}
        <button
          disabled={navigationBlocked}
          onClick={() => {
            if (isRouteOperationOwned()) return;
            sounds.click();
            onErrorPanelOpen();
          }}
          aria-label={collapsed ? `Open errors${errorCount > 0 ? ` (${errorCount} unread)` : ''}` : undefined}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent w-full relative"
        >
          <Bug size={20} className="flex-shrink-0" />
          {!collapsed && <span>Errors</span>}
          {errorCount > 0 && (
            <span className="absolute top-1.5 left-7 w-4 h-4 flex items-center justify-center rounded-full bg-red-500 text-[9px] text-white font-bold leading-none">
              {errorCount > 9 ? '9+' : errorCount}
            </span>
          )}
        </button>
        {isElevated(user) && (
          <NavLink
            to="/admin"
            aria-disabled={navigationBlocked || undefined}
            tabIndex={navigationBlocked ? -1 : undefined}
            onClick={(event) => {
              if (navigationBlocked || isRouteOperationOwned()) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              sounds.click();
              onNavClick();
            }}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
              ${isActive
                ? 'accent-active border'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
              } ${navigationBlocked ? 'pointer-events-none cursor-wait opacity-40' : ''}`
            }
          >
            <Shield size={20} className="flex-shrink-0" />
            {!collapsed && <span>Admin</span>}
          </NavLink>
        )}
        <NavLink
          to="/settings"
          aria-disabled={navigationBlocked || undefined}
          tabIndex={navigationBlocked ? -1 : undefined}
          onClick={(event) => {
            if (navigationBlocked || isRouteOperationOwned()) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            sounds.click();
            onNavClick();
          }}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
            ${isActive
              ? 'accent-active border'
              : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
            } ${navigationBlocked ? 'pointer-events-none cursor-wait opacity-40' : ''}`
          }
        >
          <Settings size={20} className="flex-shrink-0" />
          {!collapsed && <span>Settings</span>}
        </NavLink>
        <button
          disabled={navigationBlocked}
          onClick={() => {
            if (isRouteOperationOwned()) return;
            sounds.click();
            onLogout();
          }}
          aria-label={collapsed ? 'Log out' : undefined}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-slate-400 hover:text-red-400 hover:bg-red-500/10 w-full transition-all disabled:cursor-wait disabled:opacity-40"
        >
          <LogOut size={20} />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </div>
  );
});

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [pendingQuestions, setPendingQuestions] = useState<GatewayPendingQuestion[]>([]);
  const publicSettings = usePublicSettings();
  const isMobile = useIsMobile();
  const assistantName = publicSettings?.assistantName || 'Assistant';
  const portalName = publicSettings?.portalName?.trim() || 'BridgesLLM';
  const logoUrl = resolvePortalLogoUrl(publicSettings?.logoUrl);
  const { logout, user } = useAuthStore();
  const userId = user?.id || '';
  const userRole = user?.role || '';
  const navigate = useNavigate();
  const location = useLocation();
  const isTerminalRoute = location.pathname === '/terminal';
  const isErrorsRoute = location.pathname === '/errors';
  const showPersistentTerminal = isElevated(user);
  const mobileNavRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const { active: routeOperationActive } = useRouteOperationGuard();

  useEffect(() => {
    initGlobalErrorHandlers();
    return subscribeErrors((errors: StoredError[]) => setErrorCount(errors.length));
  }, []);

  useEffect(() => {
    setPendingQuestions([]);
    if (!canUseInteractivePortal({ role: userRole })) return undefined;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await gatewayAPI.pendingQuestions();
        if (cancelled) return;
        const now = Date.now();
        setPendingQuestions((Array.isArray(data?.questions) ? data.questions : []).filter((entry) => (
          entry?.state === 'pending' && entry.expiresAt > now
        )));
      } catch {
        // A shell badge is advisory. Keep the last confirmed state and retry.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [userId, userRole]);

  const pendingQuestionCounts = pendingQuestions.reduce((counts, question) => {
    if (question.surface === 'project-chat') counts.project += 1;
    else if (question.surface === 'agent-chat') counts.agent += 1;
    return counts;
  }, { agent: 0, project: 0 });
  const pendingQuestionTotal = pendingQuestionCounts.agent + pendingQuestionCounts.project;
  const pendingQuestionTarget = pendingQuestionCounts.agent > 0 ? '/agent-chats' : '/projects';

  // Drop a settled question immediately instead of waiting for the next poll,
  // so the notification cannot linger over an answer that already landed.
  const handlePendingQuestionSettled = useCallback((id: string) => {
    setPendingQuestions((current) => current.filter((question) => question.id !== id));
  }, []);

  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (isErrorsRoute) setErrorPanelOpen(true);
  }, [isErrorsRoute]);

  const handleLogout = useCallback(async () => {
    if (isRouteOperationOwned()) return;
    await logout();
    if (isRouteOperationOwned()) return;
    navigate('/login');
  }, [logout, navigate]);

  const handleNavClick = useCallback(() => setMobileOpen(false), []);
  const handleErrorPanelOpen = useCallback(() => setErrorPanelOpen(true), []);
  const handleErrorPanelClose = useCallback(() => {
    setErrorPanelOpen(false);
    if (isErrorsRoute) navigate('/dashboard', { replace: true });
  }, [isErrorsRoute, navigate]);

  return (
    <div className="flex h-dvh overflow-hidden bg-theme-bg ambient-bg" style={{ height: '100dvh' }}>
      <a
        href="#portal-main-content"
        className="accent-btn fixed left-3 top-3 z-[300] -translate-y-24 rounded-lg px-3 py-2 text-sm font-semibold shadow-lg transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>
      {/* Desktop Sidebar */}
      {!isMobile && (
        <motion.aside
          animate={{ width: collapsed ? 72 : 240 }}
          transition={{ duration: 0.2 }}
          className="hidden md:flex flex-col border-r border-theme-border bg-theme-surface/70 backdrop-blur-2xl flex-shrink-0 relative z-40"
        >
          <SidebarContent
            collapsed={collapsed}
            assistantName={assistantName}
            errorCount={errorCount}
            user={user}
            onNavClick={handleNavClick}
            onErrorPanelOpen={handleErrorPanelOpen}
            onLogout={handleLogout}
            navigationBlocked={routeOperationActive}
            mailAvailability={publicSettings?.mail}
            pendingQuestionCounts={pendingQuestionCounts}
          />
          <button
            disabled={routeOperationActive}
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
            aria-expanded={!collapsed}
            className="accent-hover absolute -right-3 top-7 w-6 h-6 rounded-full bg-dark-surface border border-white/10 flex items-center justify-center transition-colors z-50 shadow-lg shadow-black/30"
          >
            <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-180'}`} />
          </button>
        </motion.aside>
      )}

      {/* Mobile navigation owns the visual viewport and participates in the
          same deterministic modal stack as every other blocking surface. */}
      <ViewportModal
        open={isMobile && mobileOpen}
        onDismiss={() => setMobileOpen(false)}
        initialFocusRef={mobileNavRef}
        className="bg-black/60 !items-stretch !justify-start md:hidden"
      >
        <motion.aside
          ref={mobileNavRef}
          id="portal-mobile-navigation"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          tabIndex={-1}
          initial={{ x: -280 }}
          animate={{ x: 0 }}
          transition={{ type: 'spring', damping: 25 }}
          className="relative h-full w-[260px] max-w-full bg-theme-surface border-r border-theme-border shadow-2xl md:hidden"
        >
          <SidebarContent
            collapsed={false}
            assistantName={assistantName}
            errorCount={errorCount}
            user={user}
            onNavClick={handleNavClick}
            onErrorPanelOpen={handleErrorPanelOpen}
            onLogout={handleLogout}
            navigationBlocked={routeOperationActive}
            mailAvailability={publicSettings?.mail}
            pendingQuestionCounts={pendingQuestionCounts}
          />
        </motion.aside>
      </ViewportModal>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile Header */}
        {isMobile && (
          <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-theme-border bg-theme-surface/80 backdrop-blur-xl relative z-40 flex-shrink-0" style={{ paddingTop: 'calc(max(0.75rem, env(safe-area-inset-top, 0px)) + 0.25rem)' }}>
          <button ref={mobileMenuButtonRef} disabled={routeOperationActive} onClick={() => { if (!isRouteOperationOwned()) setMobileOpen(true); }} aria-label="Open navigation menu" aria-expanded={mobileOpen} aria-controls="portal-mobile-navigation" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-40">
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
          <img src={logoUrl} alt={`${portalName} logo`} className="h-7 w-7 rounded object-contain" />
          <span className="min-w-0 truncate font-semibold">{portalName}</span>
          {pendingQuestionTotal > 0 && (
            <button
              type="button"
              aria-label={`${pendingQuestionTotal} agent ${pendingQuestionTotal === 1 ? 'question is' : 'questions are'} waiting`}
              onClick={() => {
                if (!routeOperationActive && !isRouteOperationOwned()) navigate(pendingQuestionTarget);
              }}
              disabled={routeOperationActive}
              className="ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/15 px-2.5 text-xs font-medium text-violet-100 disabled:opacity-40"
            >
              <MessageCircle size={14} aria-hidden="true" />
              {pendingQuestionTotal} waiting
            </button>
          )}
          </div>
        )}

        {/* Page Content */}
        <main id="portal-main-content" tabIndex={-1} className="flex-1 overflow-hidden min-h-0 bg-theme-bg text-theme-text outline-none">
          <ErrorBoundary>
            {/* Only mount TerminalPage on the terminal route.
                Keeping it hidden-but-live on every page spins up background Socket.IO
                sessions that interfere with unrelated screens like Agent Chats. */}
            {showPersistentTerminal && isTerminalRoute && (
              <Suspense fallback={null}>
                <TerminalPage />
              </Suspense>
            )}
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* Floating upload indicator */}
      <FloatingUploadIndicator />

      {/* A paused run is answerable from anywhere in the Portal, not just from
          the surface that asked. */}
      <PendingQuestionToasts
        questions={pendingQuestions}
        onSettled={handlePendingQuestionSettled}
      />

      {/* Error Panel */}
      <ErrorPanel open={errorPanelOpen} onClose={handleErrorPanelClose} />
    </div>
  );
}
