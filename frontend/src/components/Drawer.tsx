import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderOpen,
  Terminal,
  Monitor,
  Menu,
  X,
  LogOut,
} from 'lucide-react';
import { useAuthStore } from '../contexts/AuthContext';
import UserAvatar from './UserAvatar';
import { usePublicSettings } from '../hooks/usePublicSettings';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/files', label: 'Files', icon: FolderOpen },
  { path: '/terminal', label: 'Terminal', icon: Terminal },
  { path: '/desktop', label: 'Remote Desktop', icon: Monitor },
];

export default function Drawer({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 1280);
  const location = useLocation();
  const { logout, user } = useAuthStore();
  const publicSettings = usePublicSettings();
  const assistantName = publicSettings?.assistantName || 'Assistant';

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 1280;
      setIsDesktop(desktop);
      if (desktop) setIsOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Close mobile drawer on navigation
  useEffect(() => {
    if (!isDesktop) setIsOpen(false);
  }, [location.pathname, isDesktop]);

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Assistant Profile Card */}
      <div className="p-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <UserAvatar assistant editable size="w-14 h-14" />
          <div className="min-w-0">
            <h1 className="text-base font-bold text-white">{assistantName}</h1>
            <p className="text-[11px] text-emerald-400/70">Assistant</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                isActive
                  ? 'bg-emerald-500/20 text-emerald-400 shadow-lg shadow-emerald-500/10'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon size={20} />
              <span className="font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/10">
        {/* User Profile Card */}
        <div className="flex items-center gap-3 px-3 py-3 mb-1 rounded-xl hover:bg-white/5 transition-all duration-300">
          <UserAvatar size="w-12 h-12" editable={true} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white font-medium truncate">{user?.username}</p>
            {user?.role && (
              <span className="inline-block bg-purple-500/20 text-purple-400 text-[10px] px-2 py-0.5 rounded-full font-medium mt-0.5">{user.role}</span>
            )}
          </div>
        </div>
        <button
          onClick={() => logout()}
          className="flex items-center gap-3 px-4 py-3 w-full rounded-xl text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200"
        >
          <LogOut size={20} />
          <span className="font-medium">Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh bg-[#0A0E27]">
      {/* Desktop sidebar */}
      {isDesktop && (
        <aside className="w-72 flex-shrink-0 bg-[rgba(26,31,58,0.7)] backdrop-blur-xl border-r border-white/10">
          {sidebarContent}
        </aside>
      )}

      {/* Mobile overlay */}
      {!isDesktop && isOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          />
          <aside className="fixed left-0 top-0 bottom-0 w-72 z-50 bg-[rgba(26,31,58,0.95)] backdrop-blur-xl border-r border-white/10">
            <button
              onClick={() => setIsOpen(false)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-white"
            >
              <X size={24} />
            </button>
            {sidebarContent}
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        {!isDesktop && (
          <header className="flex items-center gap-4 px-4 py-3 bg-[rgba(26,31,58,0.7)] backdrop-blur-xl border-b border-white/10">
            <button
              onClick={() => setIsOpen(true)}
              className="p-2 text-gray-400 hover:text-white"
            >
              <Menu size={24} />
            </button>
            <div className="flex items-center gap-2">
              <UserAvatar assistant editable={false} size="w-10 h-10" />
              <h1 className="text-lg font-bold text-emerald-400">{assistantName}</h1>
            </div>
          </header>
        )}

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
