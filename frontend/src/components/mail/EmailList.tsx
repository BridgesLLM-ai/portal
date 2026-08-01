import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Mail, Search, RefreshCw, Loader2, AlertTriangle, Star, Paperclip,
  CheckSquare, Square, Eye, EyeOff, Trash2, FolderInput, ChevronLeft,
  ChevronRight, Menu,
} from 'lucide-react';
import { formatDate, senderDisplay, senderInitials } from './helpers';
import { MoveToDropdown } from './MoveToDropdown';
import type { EmailSummary, MailboxInfo, MailMutationChangeHandler } from './types';
import { apiFetch } from './api';
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
  onRefresh: () => boolean | void | Promise<boolean | void>;
  onSearchChange: (q: string) => void;
  onPageChange: (page: number) => void;
  onOpenSidebar: () => void;
  onLoadMailboxes: () => void;
  onMutationChange?: MailMutationChangeHandler;
  account?: string;
}

type EmailListMutation =
  | { kind: 'bulk-read'; emailIds: readonly string[]; read: boolean; account?: string }
  | { kind: 'bulk-trash'; emailIds: readonly string[]; account?: string }
  | { kind: 'bulk-move'; emailIds: readonly string[]; targetMailboxId: string; account?: string }
  | { kind: 'message-read'; emailId: string; read: boolean; account?: string };

export default function EmailList({
  emails, total, page, pageSize, loading, refreshing, error,
  searchQuery, activeMailbox, inboxUnread, mailboxes, isMobile,
  onSelectEmail, onRefresh, onSearchChange, onPageChange,
  onOpenSidebar, onMutationChange, account,
}: EmailListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkMoveMenu, setShowBulkMoveMenu] = useState(false);
  const [actionError, setActionError] = useState('');
  const [activeMutation, setActiveMutation] = useState<EmailListMutation | null>(null);
  const mutationAdmissionRef = useRef<EmailListMutation | null>(null);
  const bulkMoveRef = useRef<HTMLButtonElement>(null);
  const bulkMoveMenuId = useId();
  const mutationBusy = activeMutation !== null;

  // JMAP performs search across the full mailbox. Filtering this one page in
  // the browser would silently hide valid matches from every other page.
  const filtered = emails;

  useEffect(() => {
    setSelectedIds(new Set());
    setShowBulkMoveMenu(false);
  }, [account, activeMailbox, page]);

  useEffect(() => {
    const visibleIds = new Set(emails.map((email) => email.id));
    setSelectedIds((current) => new Set(Array.from(current).filter((id) => visibleIds.has(id))));
  }, [emails]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = page * pageSize + 1;
  const pageEnd = Math.min((page + 1) * pageSize, total);

  const toggleSelect = (id: string) => {
    if (mutationAdmissionRef.current) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (mutationAdmissionRef.current) return;
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(e => e.id)));
    }
  };

  const handleBulkMarkRead = async (read: boolean) => {
    if (!selectedIds.size || mutationAdmissionRef.current) return;
    const admission: EmailListMutation = Object.freeze({
      kind: 'bulk-read',
      emailIds: Object.freeze(Array.from(selectedIds)),
      read,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: admission.read ? 'Marking selected messages as read' : 'Marking selected messages as unread',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch('/bulk/read', {
        method: 'POST',
        body: JSON.stringify({ emailIds: admission.emailIds, read: admission.read }),
        account: admission.account,
      });
      sounds.success();
      if ((await onRefresh()) === false) {
        throw new Error('The change was accepted, but the mailbox snapshot could not be refreshed. Use Retry before another action.');
      }
      setSelectedIds(new Set());
    } catch (err: any) {
      sounds.error();
      setActionError(err?.message || 'Failed to update the selected messages');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleBulkTrash = async () => {
    if (!selectedIds.size || mutationAdmissionRef.current) return;
    const admission: EmailListMutation = Object.freeze({
      kind: 'bulk-trash',
      emailIds: Object.freeze(Array.from(selectedIds)),
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Moving selected messages to Trash',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch('/bulk/trash', {
        method: 'POST',
        body: JSON.stringify({ emailIds: admission.emailIds }),
        account: admission.account,
      });
      sounds.delete();
      if ((await onRefresh()) === false) {
        throw new Error('The messages were moved to Trash, but the mailbox snapshot could not be refreshed. Use Retry before another action.');
      }
      setSelectedIds(new Set());
    } catch (err: any) {
      sounds.error();
      setActionError(err?.message || 'Failed to move the selected messages to trash');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleBulkMove = async (targetMailboxId: string) => {
    if (!selectedIds.size || mutationAdmissionRef.current) return;
    const admission: EmailListMutation = Object.freeze({
      kind: 'bulk-move',
      emailIds: Object.freeze(Array.from(selectedIds)),
      targetMailboxId,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Moving selected messages',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch('/bulk/move', {
        method: 'POST',
        body: JSON.stringify({ emailIds: admission.emailIds, targetMailboxId: admission.targetMailboxId }),
        account: admission.account,
      });
      sounds.success();
      if ((await onRefresh()) === false) {
        throw new Error('The messages were moved, but the mailbox snapshot could not be refreshed. Use Retry before another action.');
      }
      setSelectedIds(new Set());
    } catch (err: any) {
      sounds.error();
      setActionError(err?.message || 'Failed to move the selected messages');
      throw err;
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleMarkRead = async (emailId: string, read: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (mutationAdmissionRef.current) return;
    const admission: EmailListMutation = Object.freeze({
      kind: 'message-read',
      emailId,
      read,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: admission.read ? 'Marking message as read' : 'Marking message as unread',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch(`/messages/${admission.emailId}/read`, {
        method: 'POST',
        body: JSON.stringify({ read: admission.read }),
        account: admission.account,
      });
      sounds.click();
      if ((await onRefresh()) === false) {
        throw new Error('The read state changed, but the mailbox snapshot could not be refreshed. Use Retry before another action.');
      }
    } catch (err: any) {
      sounds.error();
      setActionError(err?.message || 'Failed to update the message');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 md:px-4 py-2 border-b border-white/[0.06] flex-shrink-0 bg-[#080B20]">
        {/* Mobile hamburger */}
        {isMobile && (
          <button
            onClick={() => { if (!mutationAdmissionRef.current) onOpenSidebar(); }}
            disabled={mutationBusy}
            aria-label="Open mailbox navigation"
            className="p-2 -ml-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] active:bg-white/[0.1] disabled:cursor-wait disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <Menu size={20} />
          </button>
        )}

        {/* Select All checkbox (desktop) */}
        {!isMobile && (
          <button
            onClick={toggleSelectAll}
            disabled={mutationBusy}
            className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 flex-shrink-0"
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
            <button
              type="button"
              onClick={() => { void handleBulkMarkRead(true); }}
              disabled={mutationBusy}
              aria-busy={activeMutation?.kind === 'bulk-read' && activeMutation.read}
              aria-label={activeMutation?.kind === 'bulk-read' && activeMutation.read ? 'Marking selected messages as read…' : 'Mark selected messages as read'}
              className="p-1.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50"
              title="Mark read"
            >
              {activeMutation?.kind === 'bulk-read' && activeMutation.read ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            </button>
            <button
              type="button"
              onClick={() => { void handleBulkMarkRead(false); }}
              disabled={mutationBusy}
              aria-busy={activeMutation?.kind === 'bulk-read' && !activeMutation.read}
              aria-label={activeMutation?.kind === 'bulk-read' && !activeMutation.read ? 'Marking selected messages as unread…' : 'Mark selected messages as unread'}
              className="p-1.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50"
              title="Mark unread"
            >
              {activeMutation?.kind === 'bulk-read' && !activeMutation.read ? <Loader2 size={14} className="animate-spin" /> : <EyeOff size={14} />}
            </button>
            <button
              type="button"
              onClick={() => { void handleBulkTrash(); }}
              disabled={mutationBusy}
              aria-busy={activeMutation?.kind === 'bulk-trash'}
              aria-label={activeMutation?.kind === 'bulk-trash' ? 'Moving selected messages to Trash…' : 'Move selected messages to Trash'}
              className="p-1.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 disabled:cursor-wait disabled:opacity-50"
              title="Trash"
            >
              {activeMutation?.kind === 'bulk-trash' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
            <div className="relative">
              <button
                ref={bulkMoveRef}
                type="button"
                onClick={() => { if (!mutationAdmissionRef.current) setShowBulkMoveMenu((current) => !current); }}
                disabled={mutationBusy}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    if (!mutationAdmissionRef.current) setShowBulkMoveMenu(true);
                  }
                }}
                aria-label="Move selected messages to folder"
                aria-haspopup="menu"
                aria-expanded={showBulkMoveMenu}
                aria-controls={showBulkMoveMenu ? bulkMoveMenuId : undefined}
                className="p-1.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50"
                title="Move"
              ><FolderInput size={14} /></button>
              <MoveToDropdown
                open={showBulkMoveMenu}
                anchorRef={bulkMoveRef}
                menuId={bulkMoveMenuId}
                mailboxes={mailboxes}
                onMove={handleBulkMove}
                onClose={() => { if (!mutationAdmissionRef.current) setShowBulkMoveMenu(false); }}
              />
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
                onChange={(e) => { if (!mutationAdmissionRef.current) onSearchChange(e.target.value); }}
                disabled={mutationBusy}
                aria-label="Search emails"
                placeholder="Search emails…"
                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-8 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30 disabled:cursor-wait disabled:opacity-50 transition-colors"
              />
            </div>
          </>
        )}

        <button
          onClick={() => { if (!mutationAdmissionRef.current) void onRefresh(); }}
          disabled={refreshing || mutationBusy}
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

      {actionError && !showBulkMoveMenu && (
        <div role="alert" className="mx-3 md:mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')} className="text-red-200 hover:text-white" aria-label="Dismiss mail action error">Dismiss</button>
        </div>
      )}

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
            <button onClick={() => { if (!mutationAdmissionRef.current) void onRefresh(); }} disabled={mutationBusy} className="text-xs text-violet-400 hover:underline disabled:cursor-wait disabled:opacity-50">Try again</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500 px-4 text-center">
            <Mail size={40} className="mb-4 opacity-20" />
            <div className="text-sm text-slate-300">
              {searchQuery ? 'No emails match your search.' : 'This folder is empty.'}
            </div>
            <div className="mt-1 text-xs text-slate-500 max-w-xs">
              {searchQuery ? 'Try a different keyword or clear the search to see everything in this mailbox.' : 'New messages will appear here when mail arrives.'}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {filtered.map((email) => {
              const isSelected = selectedIds.has(email.id);
              const rowReadBusy = activeMutation?.kind === 'message-read' && activeMutation.emailId === email.id;
              return (
                <motion.div
                  key={email.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className={`flex items-start gap-3 px-3 md:px-4 py-3 md:py-3 transition-colors group ${mutationBusy ? 'cursor-wait opacity-70' : 'cursor-pointer'}
                    ${email.isUnread ? 'bg-violet-500/[0.03]' : ''}
                    ${isSelected ? 'bg-violet-600/10' : ''}
                    hover:bg-white/[0.03] active:bg-white/[0.06]
                  `}
                  onClick={() => { if (!mutationAdmissionRef.current) onSelectEmail(email.id); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (!mutationAdmissionRef.current) onSelectEmail(email.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-disabled={mutationBusy}
                  aria-label={`Open email ${email.subject || '(no subject)'}`}
                >
                  {/* Checkbox (desktop only) */}
                  {!isMobile && (
                    <button
                      aria-label={`${isSelected ? 'Deselect' : 'Select'} email ${email.subject || '(no subject)'}`}
                      onClick={(e) => { e.stopPropagation(); toggleSelect(email.id); }}
                      disabled={mutationBusy}
                      className="pt-1 flex-shrink-0 p-0.5 disabled:cursor-wait disabled:opacity-50"
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
                      disabled={mutationBusy}
                      aria-busy={rowReadBusy}
                      aria-label={rowReadBusy ? 'Updating message read status…' : email.isUnread ? 'Mark message as read' : 'Mark message as unread'}
                      className="pt-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/[0.06] text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-50"
                      title={email.isUnread ? 'Mark as read' : 'Mark as unread'}
                    >
                      {rowReadBusy ? <Loader2 size={14} className="animate-spin" /> : email.isUnread ? <Eye size={14} /> : <EyeOff size={14} />}
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
              aria-label="Previous email page"
              onClick={() => { if (!mutationAdmissionRef.current) onPageChange(page - 1); }}
              disabled={page === 0 || mutationBusy}
              className="p-2 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              aria-label="Next email page"
              onClick={() => { if (!mutationAdmissionRef.current) onPageChange(page + 1); }}
              disabled={page >= totalPages - 1 || mutationBusy}
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
