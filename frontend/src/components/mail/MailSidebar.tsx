import { motion, AnimatePresence } from 'framer-motion';
import { MailPlus, X, Smartphone, ArrowRightFromLine } from 'lucide-react';
import { FolderIcon } from './helpers';
import type { MailboxInfo } from './types';

// ── Folder ordering ────────────────────────────────────────────
const folderOrder = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive'];

function sortMailboxes(mailboxes: MailboxInfo[]) {
  return [...mailboxes].sort((a, b) => {
    const ai = a.role ? folderOrder.indexOf(a.role) : 99;
    const bi = b.role ? folderOrder.indexOf(b.role) : 99;
    return (ai === -1 ? 98 : ai) - (bi === -1 ? 98 : bi);
  });
}

interface MailSidebarProps {
  mailboxes: MailboxInfo[];
  activeMailbox: string;
  onSelectMailbox: (role: string) => void;
  onCompose: () => void;
  isOpen: boolean;
  onClose: () => void;
  isMobile: boolean;
  children?: React.ReactNode;
  onSetupGuide?: () => void;
  onForwardSettings?: () => void;
}

export default function MailSidebar({
  mailboxes, activeMailbox, onSelectMailbox, onCompose,
  isOpen, onClose, isMobile, children, onSetupGuide, onForwardSettings,
}: MailSidebarProps) {
  const sorted = sortMailboxes(mailboxes);

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#080B20]">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
        <h2 className="text-base font-semibold text-white">Mail</h2>
        {isMobile && (
          <button
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
          >
            <X size={20} />
          </button>
        )}
      </div>

      {/* Compose button */}
      <div className="p-3">
        <button
          onClick={() => { onCompose(); if (isMobile) onClose(); }}
          className="w-full px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors shadow-lg shadow-violet-600/20"
        >
          <MailPlus size={18} /> Compose
        </button>
      </div>

      {/* Account switcher (injected via children) */}
      {children}

      {/* Folder list */}
      <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
        {sorted.map((mb) => {
          const role = mb.role || mb.name.toLowerCase();
          const isActive = activeMailbox === role;
          return (
            <button
              key={mb.id}
              onClick={() => {
                onSelectMailbox(role);
                if (isMobile) onClose();
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                isActive
                  ? 'bg-violet-600/20 text-violet-300'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04] active:bg-white/[0.08]'
              }`}
            >
              <FolderIcon role={mb.role} size={18} />
              <span className="flex-1 text-left truncate">{mb.name}</span>
              {mb.unreadEmails > 0 && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full min-w-[24px] text-center ${
                  isActive ? 'bg-violet-500/30 text-violet-200' : 'bg-white/[0.08] text-slate-300'
                }`}>
                  {mb.unreadEmails}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Settings links */}
      <div className="px-3 py-2 space-y-1">
        {onSetupGuide && (
          <button
            onClick={() => { onSetupGuide(); if (isMobile) onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-white hover:bg-white/[0.04] transition-colors"
          >
            <Smartphone size={14} />
            <span>Connect Your Phone</span>
          </button>
        )}
        {onForwardSettings && (
          <button
            onClick={() => { onForwardSettings(); if (isMobile) onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-white hover:bg-white/[0.04] transition-colors"
          >
            <ArrowRightFromLine size={14} />
            <span>Auto-Forward</span>
          </button>
        )}
      </div>

      {/* Spacer at bottom */}
      <div className="p-4 border-t border-white/[0.06]" />
    </div>
  );

  // Desktop: persistent sidebar
  if (!isMobile) {
    return (
      <div className="w-60 flex-shrink-0 border-r border-white/[0.06] hidden md:flex flex-col">
        {sidebarContent}
      </div>
    );
  }

  // Mobile: slide-in drawer with backdrop
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          {/* Drawer */}
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="fixed left-0 top-0 bottom-0 w-[280px] z-50 shadow-2xl shadow-black/50"
          >
            {sidebarContent}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
