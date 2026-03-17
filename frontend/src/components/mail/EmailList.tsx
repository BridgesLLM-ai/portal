import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Mail, Search, RefreshCw, Loader2, AlertTriangle, Star, Paperclip,
  CheckSquare, Square, Eye, EyeOff, Trash2, FolderInput, ChevronLeft,
  ChevronRight, Menu,
} from 'lucide-react';
import { formatDate, senderDisplay, senderInitials } from './helpers';
import { MoveToDropdown } from './MoveToDropdown';
import type { EmailSummary, MailboxInfo } from './types';
import { apiFetch } from './api';
import { useRef, useEffect } from 'react';
import sounds from '../../utils/sounds';

interface EmailListProps {
  emails: EmailSummary[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  refreshing: boolean;
  error: string;
  searchQuery: string;
  activeMailbox: string;
  inboxUnread: number;
  mailboxes: MailboxInfo[];
  isMobile: boolean;
  onSelectEmail: (id: string) => void;
  onRefresh: () => void;
  onSearchChange: (q: string) => void;
  onPageChange: (page: number) => void;
  onOpenSidebar: () => void;
  onLoadMailboxes: () => void;
  account?: string;
}

export default function EmailList({
  emails, total, page, pageSize, loading, refreshing, error,
  searchQuery, activeMailbox, inboxUnread, mailboxes, isMobile,
  onSelectEmail, onRefresh, onSearchChange, onPageChange,
  onOpenSidebar, onLoadMailboxes, account,
}: EmailListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkMoveMenu, setShowBulkMoveMenu] = useState(false);
  const bulkMoveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showBulkMoveMenu) return;
    const handler = (e: MouseEvent) => {
      if (bulkMoveRef.current && !bulkMoveRef.current.contains(e.target as Node)) {
        setShowBulkMoveMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBulkMoveMenu]);

  // Filter emails by search
  const filtered = searchQuery
    ? emails.filter(e =>
        e.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.preview.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.from.some(f => f.email.toLowerCase().includes(searchQuery.toLowerCase()) || f.name?.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : emails;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = page * pageSize + 1;
  const pageEnd = Math.min((page + 1) * pageSize, total);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(e => e.id)));
    }
  };

  const handleBulkMarkRead = async (read: boolean) => {
    if (!selectedIds.size) return;
    try {
      await apiFetch('/bulk/read', {
        method: 'POST',
        body: JSON.stringify({ emailIds: Array.from(selectedIds), read }),
        account,
      });
      sounds.success();
      setSelectedIds(new Set());
      onRefresh();
    } catch { sounds.error(); }
  };

  const handleBulkTrash = async () => {
    if (!selectedIds.size) return;
    try {
      await apiFetch('/bulk/trash', {
        method: 'POST',
        body: JSON.stringify({ emailIds: Array.from(selectedIds) }),
        account,
      });
      sounds.delete();
      setSelectedIds(new Set());
      onRefresh();
    } catch { sounds.error(); }
  };

  const handleBulkMove = async (targetMailboxId: string) => {
    if (!selectedIds.size) return;
    try {
      await apiFetch('/bulk/move', {
        method: 'POST',
        body: JSON.stringify({ emailIds: Array.from(selectedIds), targetMailboxId }),
        account,
      });
      sounds.success();
      setSelectedIds(new Set());
      onRefresh();
    } catch { sounds.error(); }
  };

  const handleMarkRead = async (emailId: string, read: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apiFetch(`/messages/${emailId}/read`, {
        method: 'POST',
        body: JSON.stringify({ read }),
        account,
      });
      sounds.click();
      onRefresh();
      onLoadMailboxes();
    } catch {}
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 md:px-4 py-2 border-b border-white/[0.06] flex-shrink-0 bg-[#080B20]">
        {/* Mobile hamburger */}
        {isMobile && (
          <button
            onClick={onOpenSidebar}
            className="p-2 -ml-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors flex-shrink-0"
          >
            <Menu size={20} />
          </button>
        )}

        {/* Select All checkbox (desktop) */}
        {!isMobile && (
          <button
            onClick={toggleSelectAll}
            className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white flex-shrink-0"
            title={selectedIds.size === filtered.length && filtered.length > 0 ? 'Deselect all' : 'Select all'}
          >
            {selectedIds.size === filtered.length && filtered.length > 0 ? (
              <CheckSquare size={16} className="text-violet-400" />
            ) : selectedIds.size > 0 ? (
              <CheckSquare size={16} className="text-slate-400" />
            ) : (
              <Square size={16} />
            )}
          </button>
        )}

        {/* Bulk actions */}
        {selectedIds.size > 0 ? (
          <>
            <span className="text-xs text-violet-300 font-medium">{selectedIds.size} selected</span>
            <button onClick={() => handleBulkMarkRead(true)} className="p-1.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white" title="Mark read"><Eye size={14} /></button>
            <button onClick={() => handleBulkMarkRead(false)} className="p-1.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white" title="Mark unread"><EyeOff size={14} /></button>
            <button onClick={handleBulkTrash} className="p-1.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400" title="Trash"><Trash2 size={14} /></button>
            <div className="relative" ref={bulkMoveRef}>
              <button onClick={() => setShowBulkMoveMenu(!showBulkMoveMenu)} className="p-1.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white" title="Move"><FolderInput size={14} /></button>
              {showBulkMoveMenu && (
                <MoveToDropdown mailboxes={mailboxes} onMove={handleBulkMove} onClose={() => setShowBulkMoveMenu(false)} />
              )}
            </div>
            <div className="flex-1" />
          </>
        ) : (
          <>
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search emails…"
                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-8 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30 transition-colors"
              />
            </div>
          </>
        )}

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="p-2 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:opacity-50 transition-colors flex-shrink-0"
          title="Refresh"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>

        {/* Email count (desktop) */}
        {!isMobile && (
          <div className="text-xs text-slate-500 flex-shrink-0">
            {total > 0 ? `${pageStart}–${pageEnd} of ${total}` : '0 emails'}
            {inboxUnread > 0 && activeMailbox !== 'inbox' && (
              <span className="ml-2 text-violet-400">{inboxUnread} unread</span>
            )}
          </div>
        )}
      </div>

      {/* Email list */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && !refreshing ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="animate-spin" size={24} />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <AlertTriangle size={28} className="text-red-400 mb-3" />
            <div className="text-sm text-red-400 mb-2">{error}</div>
            <button onClick={onRefresh} className="text-xs text-violet-400 hover:underline">Try again</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500 px-4">
            <Mail size={40} className="mb-4 opacity-20" />
            <div className="text-sm">
              {searchQuery ? 'No emails match your search' : 'No emails in this folder'}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {filtered.map((email) => {
              const isSelected = selectedIds.has(email.id);
              return (
                <motion.div
                  key={email.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className={`flex items-start gap-3 px-3 md:px-4 py-3 md:py-3 transition-colors group cursor-pointer
                    ${email.isUnread ? 'bg-violet-500/[0.03]' : ''}
                    ${isSelected ? 'bg-violet-600/10' : ''}
                    hover:bg-white/[0.03] active:bg-white/[0.06]
                  `}
                  onClick={() => onSelectEmail(email.id)}
                >
                  {/* Checkbox (desktop only) */}
                  {!isMobile && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSelect(email.id); }}
                      className="pt-1 flex-shrink-0 p-0.5"
                    >
                      {isSelected ? (
                        <CheckSquare size={14} className="text-violet-400" />
                      ) : (
                        <Square size={14} className="text-slate-600 group-hover:text-slate-400" />
                      )}
                    </button>
                  )}

                  {/* Avatar (mobile) */}
                  {isMobile && (
                    <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold mt-0.5 ${
                      email.isUnread
                        ? 'bg-violet-600/20 text-violet-300'
                        : 'bg-white/[0.06] text-slate-400'
                    }`}>
                      {senderInitials(email.from)}
                    </div>
                  )}

                  {/* Email content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {/* Unread dot (desktop) */}
                      {!isMobile && (
                        email.isUnread ? (
                          <div className="w-2 h-2 rounded-full bg-violet-400 flex-shrink-0" />
                        ) : (
                          <div className="w-2 h-2 flex-shrink-0" />
                        )
                      )}
                      <span className={`text-sm truncate ${email.isUnread ? 'font-semibold text-white' : 'text-slate-300'}`}>
                        {senderDisplay(email.from)}
                      </span>
                      <span className="flex-1" />
                      {email.isFlagged && <Star size={12} className="text-amber-400 flex-shrink-0" fill="currentColor" />}
                      {email.hasAttachment && <Paperclip size={12} className="text-slate-500 flex-shrink-0" />}
                      <span className="text-xs text-slate-500 flex-shrink-0 tabular-nums">{formatDate(email.receivedAt)}</span>
                    </div>
                    <div className={`text-sm truncate ${isMobile ? '' : 'ml-4'} ${email.isUnread ? 'font-medium text-slate-200' : 'text-slate-400'}`}>
                      {email.subject || '(no subject)'}
                    </div>
                    <div className={`text-xs text-slate-500 truncate mt-0.5 ${isMobile ? '' : 'ml-4'}`}>
                      {email.preview}
                    </div>
                  </div>

                  {/* Quick action (desktop hover) */}
                  {!isMobile && (
                    <button
                      onClick={(e) => handleMarkRead(email.id, email.isUnread, e)}
                      className="pt-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/[0.06] text-slate-500 hover:text-white"
                      title={email.isUnread ? 'Mark as read' : 'Mark as unread'}
                    >
                      {email.isUnread ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-white/[0.06] flex-shrink-0 bg-[#080B20]">
          <div className="text-xs text-slate-500">
            {isMobile
              ? `${page + 1}/${totalPages}`
              : `Page ${page + 1} of ${totalPages}`
            }
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
              className="p-2 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="p-2 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
