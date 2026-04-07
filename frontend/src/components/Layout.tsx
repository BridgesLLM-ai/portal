import { useState, useEffect, useCallback, memo, lazy, Suspense } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { usePublicSettings } from '../hooks/usePublicSettings';
import { useIsMobile } from '../hooks/useIsMobile';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../contexts/AuthContext';
import FloatingUploadIndicator from './FloatingUploadIndicator';
import OllamaControl from './OllamaControl';
import ErrorPanel from './ErrorPanel';
import ErrorBoundary from './ErrorBoundary';
import { subscribeErrors, initGlobalErrorHandlers, type StoredError } from '../utils/errorHandler';
import sounds from '../utils/sounds';
import UserAvatar from './UserAvatar';
import { canUseInteractivePortal, isElevated } from '../utils/authz';
import {
  LayoutDashboard, Terminal, Rocket, MessageCircle, Settings, Monitor, FolderOpen,
  LogOut, Menu, X, ChevronRight, Bug, Shield, Mail, Wrench, Globe
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
            <p className="text-[11px] text-emerald-400/70 font-medium">Assistant</p>
          </motion.div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems
          .filter(({ interactiveOnly, adminOnly }) => (!interactiveOnly || canUseInteractivePortal(user)) && (!adminOnly || isElevated(user)))
          .map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => { sounds.click(); onNavClick(); }}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group
              ${isActive
                ? 'bg-emerald-500/10 text-emerald-400 shadow-lg shadow-emerald-500/5 border border-emerald-500/10'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
              }`
            }
          >
            <Icon size={20} className="flex-shrink-0" />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
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
          onClick={() => { sounds.click(); onErrorPanelOpen(); }}
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
            onClick={() => { sounds.click(); onNavClick(); }}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
              ${isActive
                ? 'bg-purple-500/10 text-purple-400 shadow-lg shadow-purple-500/5 border border-purple-500/10'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
              }`
            }
          >
            <Shield size={20} className="flex-shrink-0" />
            {!collapsed && <span>Admin</span>}
          </NavLink>
        )}
        <NavLink
          to="/settings"
          onClick={() => { sounds.click(); onNavClick(); }}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
            ${isActive
              ? 'bg-emerald-500/10 text-emerald-400 shadow-lg shadow-emerald-500/5 border border-emerald-500/10'
              : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
            }`
          }
        >
          <Settings size={20} className="flex-shrink-0" />
          {!collapsed && <span>Settings</span>}
        </NavLink>
        <button
          onClick={() => { sounds.click(); onLogout(); }}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-slate-400 hover:text-red-400 hover:bg-red-500/10 w-full transition-all"
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
  const publicSettings = usePublicSettings();
  const isMobile = useIsMobile();
  const assistantName = publicSettings?.assistantName || 'Assistant';
  const logoUrl = publicSettings?.logoUrl || '';
  const { logout, user } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const isTerminalRoute = location.pathname === '/terminal';
  const showPersistentTerminal = isElevated(user);

  useEffect(() => {
    initGlobalErrorHandlers();
    return subscribeErrors((errors: StoredError[]) => setErrorCount(errors.length));
  }, []);

  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login');
  }, [logout, navigate]);

  const handleNavClick = useCallback(() => setMobileOpen(false), []);
  const handleErrorPanelOpen = useCallback(() => setErrorPanelOpen(true), []);

  return (
    <div className="flex h-dvh overflow-hidden bg-theme-bg ambient-bg" style={{ height: '100dvh' }}>
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
          />
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="absolute -right-3 top-7 w-6 h-6 rounded-full bg-dark-surface border border-white/10 flex items-center justify-center hover:bg-emerald-500/20 transition-colors z-50 shadow-lg shadow-black/30"
          >
            <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-180'}`} />
          </button>
        </motion.aside>
      )}

      {/* Mobile Overlay */}
      <AnimatePresence>
        {isMobile && mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-40 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', damping: 25 }}
              className="fixed left-0 top-0 bottom-0 w-[260px] bg-theme-surface border-r border-theme-border z-50 md:hidden"
            >
              <SidebarContent
                collapsed={false}
                assistantName={assistantName}
                errorCount={errorCount}
                user={user}
                onNavClick={handleNavClick}
                onErrorPanelOpen={handleErrorPanelOpen}
                onLogout={handleLogout}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile Header */}
        {isMobile && (
          <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-theme-border bg-theme-surface/80 backdrop-blur-xl relative z-40 flex-shrink-0" style={{ paddingTop: 'calc(max(0.75rem, env(safe-area-inset-top, 0px)) + 0.25rem)' }}>
          <button onClick={() => setMobileOpen(true)} className="text-slate-400 hover:text-white">
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
          {logoUrl ? <img src={logoUrl} alt="Portal logo" className="w-7 h-7 rounded object-cover" /> : null}
          <span className="font-semibold">Bridges<span className="text-emerald-400">LLM</span></span>
          </div>
        )}

        {/* Page Content */}
        <main className="flex-1 overflow-hidden min-h-0 bg-theme-bg text-theme-text">
          <ErrorBoundary>
            {/* Only mount TerminalPage on the terminal route.
                Keeping it hidden-but-live on every page spins up background Socket.IO
                sessions that interfere with unrelated screens like Agent Chats. */}
            {showPersistentTerminal && isTerminalRoute && (
              <Suspense fallback={null}>
                <TerminalPage />
              </Suspense>
            )}
            {!isTerminalRoute && <Outlet />}
          </ErrorBoundary>
        </main>
      </div>

      {/* Floating upload indicator */}
      <FloatingUploadIndicator />

      {/* Error Panel */}
      <ErrorPanel open={errorPanelOpen} onClose={() => setErrorPanelOpen(false)} />
    </div>
  );
}
