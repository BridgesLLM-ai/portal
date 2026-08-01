import { useState, useEffect, useId, useRef } from 'react';
import {
  ArrowLeft, Reply, Users, Forward, Eye, EyeOff, FolderInput,
  Trash2, Flag, Clock, Loader2, Shield, Download,
  FolderDown, Check,
} from 'lucide-react';
import { formatSize, senderDisplay, senderInitials } from './helpers';
import { MoveToDropdown } from './MoveToDropdown';
import { apiDownloadAttachment, apiFetch } from './api';
import type { EmailFull, ComposeState, MailboxInfo, MailMutationChangeHandler } from './types';
import sounds from '../../utils/sounds';
import { buildEmailDocument, containsRemoteMailContent } from './emailDocument';

interface EmailDetailProps {
  emailId: string;
  onBack: () => void;
  onRefresh: () => boolean | void | Promise<boolean | void>;
  mailboxes: MailboxInfo[];
  onCompose: (state: ComposeState) => void;
  isMobile: boolean;
  onMutationChange?: MailMutationChangeHandler;
  account?: string;
}

type CommittedMailboxMutation =
  | { kind: 'move'; emailId: string; targetMailboxId: string; account?: string }
  | { kind: 'trash'; emailId: string; account?: string };

type EmailDetailMutation =
  | { kind: 'read'; emailId: string; read: boolean; account?: string }
  | CommittedMailboxMutation
  | { kind: 'mailbox-refresh'; operation: CommittedMailboxMutation['kind']; emailId: string; account?: string }
  | { kind: 'flag'; emailId: string; flagged: boolean; account?: string }
  | { kind: 'attachment-save'; blobId: string; downloadToken: string; account?: string }
  | { kind: 'attachment-download'; blobId: string; downloadToken: string; fileName: string; account?: string };

export default function EmailDetail({
  emailId, onBack, onRefresh, mailboxes, onCompose, isMobile, onMutationChange, account,
}: EmailDetailProps) {
  const [email, setEmail] = useState<EmailFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [activeMutation, setActiveMutation] = useState<EmailDetailMutation | null>(null);
  const [committedMailboxMutation, setCommittedMailboxMutation] = useState<CommittedMailboxMutation | null>(null);
  const [savedBlobIds, setSavedBlobIds] = useState<Set<string>>(new Set());
  const [attachmentError, setAttachmentError] = useState('');
  const [actionError, setActionError] = useState('');
  const [showRemoteContent, setShowRemoteContent] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const mutationAdmissionRef = useRef<EmailDetailMutation | null>(null);
  const committedMailboxMutationRef = useRef<CommittedMailboxMutation | null>(null);
  const moveMenuId = useId();
  const mutationBusy = activeMutation !== null;
  const interactionBlocked = mutationBusy || committedMailboxMutation !== null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEmail(null);
    setError('');
    setActionError('');
    committedMailboxMutationRef.current = null;
    setCommittedMailboxMutation(null);
    setAttachmentError('');
    setSavedBlobIds(new Set());
    setShowRemoteContent(false);
    apiFetch(`/messages/${emailId}`, { account })
      .then((data) => {
        if (cancelled) return;
        setEmail(data);
        if (data?.isUnread && !mutationAdmissionRef.current) {
          const admission: EmailDetailMutation = Object.freeze({
            kind: 'read',
            emailId,
            read: true,
            account,
          });
          mutationAdmissionRef.current = admission;
          onMutationChange?.(Object.freeze({
            kind: admission.kind,
            label: 'Marking message as read',
            account: admission.account,
          }));
          setActiveMutation(admission);
          apiFetch(`/messages/${admission.emailId}/read`, {
            method: 'POST',
            body: JSON.stringify({ read: admission.read }),
            account: admission.account,
          }).then(async () => {
            if (cancelled) return;
            setEmail((current) => current?.id === admission.emailId
              ? { ...current, isUnread: false }
              : current);
            if ((await onRefresh()) === false) {
              throw new Error('The message was marked as read, but the mailbox snapshot could not be refreshed.');
            }
          }).catch((err: any) => {
            if (!cancelled) setActionError(err?.message || 'The message opened, but its read status could not be updated.');
          }).finally(() => {
            if (mutationAdmissionRef.current === admission) {
              mutationAdmissionRef.current = null;
              onMutationChange?.(null);
              setActiveMutation(null);
            }
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [account, emailId, onMutationChange, onRefresh]);

  // Write HTML into sandboxed iframe - mobile-first approach
  useEffect(() => {
    if (!email || !iframeRef.current) return;
    const htmlPart = email.htmlBody?.[0];
    const textPart = email.textBody?.[0];
    let content = '';
    let isHtml = false;

    if (htmlPart && email.bodyValues[htmlPart.partId]) {
      content = email.bodyValues[htmlPart.partId].value;
      isHtml = true;
    } else if (textPart && email.bodyValues[textPart.partId]) {
      content = email.bodyValues[textPart.partId].value;
    }

    const doc = iframeRef.current.contentDocument;
    if (doc) {
      doc.open();
      doc.write(buildEmailDocument(content, isHtml, showRemoteContent));
      doc.close();

      // Auto-resize iframe to content height (eliminates scrollbar-in-scrollbar)
      const resizeIframe = () => {
        if (iframeRef.current?.contentDocument?.body) {
          const height = iframeRef.current.contentDocument.body.scrollHeight;
          iframeRef.current.style.height = `${height + 20}px`;
        }
      };

      // Resize after images load
      const timers = [100, 500, 2000].map(delay => window.setTimeout(resizeIframe, delay));
      
      // Also listen for load events on images
      const images = doc.querySelectorAll('img');
      images.forEach(img => img.addEventListener('load', resizeIframe));
      return () => {
        timers.forEach(timer => window.clearTimeout(timer));
        images.forEach(img => img.removeEventListener('load', resizeIframe));
      };
    }
    return undefined;
  }, [email, showRemoteContent]);

  const handleToggleRead = async () => {
    if (!email || mutationAdmissionRef.current || committedMailboxMutationRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'read',
      emailId: email.id,
      read: email.isUnread,
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
      setEmail((current) => current?.id === admission.emailId
        ? { ...current, isUnread: !admission.read }
        : current);
      if ((await onRefresh()) === false) {
        throw new Error('The read state changed, but the mailbox snapshot could not be refreshed. Use Refresh before another action.');
      }
    } catch (actionFailure: any) {
      setActionError(actionFailure?.message || 'Read status could not be updated.');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleMove = async (targetMailboxId: string) => {
    if (!email || mutationAdmissionRef.current || committedMailboxMutationRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'move',
      emailId: email.id,
      targetMailboxId,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Moving message',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch(`/messages/${admission.emailId}/move`, {
        method: 'POST',
        body: JSON.stringify({ targetMailboxId: admission.targetMailboxId }),
        account: admission.account,
      });
      sounds.success();
      committedMailboxMutationRef.current = admission;
      setCommittedMailboxMutation(admission);
      if ((await onRefresh()) === false) {
        throw new Error('The message was moved, but Portal could not verify the refreshed mailbox. Retry mailbox refresh; the move will not be sent again.');
      }
      committedMailboxMutationRef.current = null;
      setCommittedMailboxMutation(null);
      onBack();
    } catch (actionFailure: any) {
      const committed = committedMailboxMutationRef.current === admission;
      setActionError(committed
        ? actionFailure?.message || 'The message was moved, but Portal could not verify the refreshed mailbox. Retry mailbox refresh; the move will not be sent again.'
        : actionFailure?.message || 'The message could not be moved.');
      if (committed) setShowMoveMenu(false);
      else throw actionFailure;
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleTrash = async () => {
    if (!email || mutationAdmissionRef.current || committedMailboxMutationRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'trash',
      emailId: email.id,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Moving message to Trash',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch(`/messages/${admission.emailId}/trash`, { method: 'POST', account: admission.account });
      sounds.delete();
      committedMailboxMutationRef.current = admission;
      setCommittedMailboxMutation(admission);
      if ((await onRefresh()) === false) {
        throw new Error('The message was moved to Trash, but Portal could not verify the refreshed mailbox. Retry mailbox refresh; the trash request will not be sent again.');
      }
      committedMailboxMutationRef.current = null;
      setCommittedMailboxMutation(null);
      onBack();
    } catch (actionFailure: any) {
      const committed = committedMailboxMutationRef.current === admission;
      setActionError(committed
        ? actionFailure?.message || 'The message was moved to Trash, but Portal could not verify the refreshed mailbox. Retry mailbox refresh; the trash request will not be sent again.'
        : actionFailure?.message || 'The message could not be moved to Trash.');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const retryMailboxRefresh = async () => {
    const committed = committedMailboxMutationRef.current;
    if (!committed || mutationAdmissionRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'mailbox-refresh',
      operation: committed.kind,
      emailId: committed.emailId,
      account: committed.account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: committed.kind === 'move' ? 'Verifying moved message' : 'Verifying trashed message',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      if ((await onRefresh()) === false) {
        throw new Error(committed.kind === 'move'
          ? 'Portal still could not verify the moved message in a refreshed mailbox. Retry mailbox refresh; the move will not be sent again.'
          : 'Portal still could not verify the trashed message in a refreshed mailbox. Retry mailbox refresh; the trash request will not be sent again.');
      }
      if (committedMailboxMutationRef.current !== committed) return;
      committedMailboxMutationRef.current = null;
      setCommittedMailboxMutation(null);
      onBack();
    } catch (refreshFailure: any) {
      setActionError(refreshFailure?.message || 'Portal could not verify the refreshed mailbox. Retry will not repeat the accepted mailbox action.');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleFlag = async () => {
    if (!email || mutationAdmissionRef.current || committedMailboxMutationRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'flag',
      emailId: email.id,
      flagged: !email.isFlagged,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: admission.flagged ? 'Flagging message' : 'Removing message flag',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setActionError('');
    try {
      await apiFetch(`/messages/${admission.emailId}/flag`, {
        method: 'POST',
        body: JSON.stringify({ flagged: admission.flagged }),
        account: admission.account,
      });
      sounds.click();
      setEmail((current) => current?.id === admission.emailId
        ? { ...current, isFlagged: admission.flagged }
        : current);
    } catch (actionFailure: any) {
      setActionError(actionFailure?.message || 'The flag could not be updated.');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const saveAttachmentToFiles = async (att: EmailFull['attachments'][number]) => {
    if (!att.downloadToken || mutationAdmissionRef.current || committedMailboxMutationRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'attachment-save',
      blobId: att.blobId,
      downloadToken: att.downloadToken,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Saving attachment to Files',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setAttachmentError('');
    try {
      await apiFetch(`/attachments/${admission.blobId}/save-to-files`, {
        method: 'POST',
        body: JSON.stringify({ token: admission.downloadToken }),
        account: admission.account,
      });
      sounds.success();
      setSavedBlobIds(prev => new Set(prev).add(admission.blobId));
      setTimeout(() => {
        setSavedBlobIds(prev => {
          const next = new Set(prev);
          next.delete(admission.blobId);
          return next;
        });
      }, 2000);
    } catch (saveError: any) {
      sounds.error();
      setAttachmentError(saveError?.message || 'Attachment could not be saved');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const downloadMailAttachment = async (att: EmailFull['attachments'][number]) => {
    if (!att.downloadToken || mutationAdmissionRef.current || committedMailboxMutationRef.current) return;
    const admission: EmailDetailMutation = Object.freeze({
      kind: 'attachment-download',
      blobId: att.blobId,
      downloadToken: att.downloadToken,
      fileName: att.name || 'attachment',
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Downloading attachment',
      account: admission.account,
    }));
    setActiveMutation(admission);
    setAttachmentError('');
    try {
      const blob = await apiDownloadAttachment(
        admission.blobId,
        admission.downloadToken,
        admission.account,
      );
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = admission.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (downloadError: any) {
      sounds.error();
      setAttachmentError(downloadError?.message || 'Attachment download failed');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  if (loading) return (
    <div className="flex-1 flex items-center justify-center text-slate-400 bg-[#080B20]">
      <Loader2 className="animate-spin" size={24} />
    </div>
  );
  if (error) return (
    <div className="flex-1 flex items-center justify-center text-red-400 text-sm bg-[#080B20] px-4 text-center">{error}</div>
  );
  if (!email) return null;

  const readBusy = activeMutation?.kind === 'read';
  const trashBusy = activeMutation?.kind === 'trash';
  const flagBusy = activeMutation?.kind === 'flag';
  const mailboxRefreshBusy = activeMutation?.kind === 'mailbox-refresh';
  const requestBack = () => {
    if (!mutationAdmissionRef.current && !committedMailboxMutationRef.current) onBack();
  };
  const requestCompose = (mode: ComposeState['mode']) => {
    if (!mutationAdmissionRef.current && !committedMailboxMutationRef.current) onCompose({ mode, replyTo: email });
  };

  // Mobile bottom action bar items
  const mobileActions = (
    <div className="flex items-center justify-around py-2 px-2 border-t border-white/[0.06] bg-[#080B20] flex-shrink-0 safe-area-bottom">
      <button
        onClick={() => requestCompose('reply')}
        disabled={interactionBlocked}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-violet-300 active:bg-violet-600/20 disabled:cursor-wait disabled:opacity-50 transition-colors min-w-[56px]"
      >
        <Reply size={20} />
        <span className="text-[10px]">Reply</span>
      </button>
      <button
        onClick={() => requestCompose('replyAll')}
        disabled={interactionBlocked}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-violet-300 active:bg-violet-600/20 disabled:cursor-wait disabled:opacity-50 transition-colors min-w-[56px]"
      >
        <Users size={18} />
        <span className="text-[10px]">Reply All</span>
      </button>
      <button
        onClick={() => requestCompose('forward')}
        disabled={interactionBlocked}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-slate-300 active:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50 transition-colors min-w-[56px]"
      >
        <Forward size={20} />
        <span className="text-[10px]">Forward</span>
      </button>
      <button
        onClick={() => { void handleTrash(); }}
        disabled={interactionBlocked}
        aria-busy={trashBusy}
        aria-label={trashBusy ? 'Moving message to Trash…' : 'Move message to Trash'}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-slate-400 active:bg-red-500/20 disabled:cursor-wait disabled:opacity-50 transition-colors min-w-[56px]"
      >
        {trashBusy ? <Loader2 size={20} className="animate-spin" /> : <Trash2 size={20} />}
        <span className="text-[10px]">{trashBusy ? 'Trashing…' : 'Trash'}</span>
      </button>
      <button
        aria-label={email.isFlagged ? 'Remove flag' : 'Flag message'}
        aria-pressed={email.isFlagged}
        onClick={() => { void handleFlag(); }}
        disabled={interactionBlocked}
        aria-busy={flagBusy}
        className={`flex flex-col items-center gap-0.5 p-2 rounded-xl disabled:cursor-wait disabled:opacity-50 transition-colors min-w-[56px] ${email.isFlagged ? 'text-amber-400' : 'text-slate-400 active:bg-amber-500/20'}`}
      >
        {flagBusy ? <Loader2 size={20} className="animate-spin" /> : <Flag size={20} />}
        <span className="text-[10px]">{flagBusy ? 'Updating…' : 'Flag'}</span>
      </button>
    </div>
  );

  // Desktop toolbar
  const desktopToolbar = (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-white/[0.06] flex-shrink-0 bg-[#080B20]">
      <button aria-label="Back to message list" onClick={requestBack} disabled={interactionBlocked} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 transition-colors">
        <ArrowLeft size={16} />
      </button>
      <div className="flex-1" />
      <button
        onClick={() => requestCompose('reply')}
        disabled={interactionBlocked}
        className="px-3 py-1.5 text-xs rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 font-medium flex items-center gap-1.5 disabled:cursor-wait disabled:opacity-50 transition-colors"
      >
        <Reply size={12} /> Reply
      </button>
      <button
        onClick={() => requestCompose('replyAll')}
        disabled={interactionBlocked}
        className="px-3 py-1.5 text-xs rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 font-medium flex items-center gap-1.5 disabled:cursor-wait disabled:opacity-50 transition-colors"
        title="Reply All"
      >
        <Users size={12} /> Reply All
      </button>
      <button
        onClick={() => requestCompose('forward')}
        disabled={interactionBlocked}
        className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 font-medium flex items-center gap-1.5 disabled:cursor-wait disabled:opacity-50 transition-colors"
        title="Forward"
      >
        <Forward size={12} /> Forward
      </button>
      <button aria-label={readBusy ? 'Updating message read status…' : email.isUnread ? 'Mark as read' : 'Mark as unread'} onClick={() => { void handleToggleRead(); }} disabled={interactionBlocked} aria-busy={readBusy} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 transition-colors" title={email.isUnread ? 'Mark as read' : 'Mark as unread'}>
        {readBusy ? <Loader2 size={14} className="animate-spin" /> : email.isUnread ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <div className="relative">
        <button
          ref={moveRef}
          type="button"
          aria-label="Move message to folder"
          aria-haspopup="menu"
          aria-expanded={showMoveMenu}
          aria-controls={showMoveMenu ? moveMenuId : undefined}
          onClick={() => { if (!mutationAdmissionRef.current && !committedMailboxMutationRef.current) setShowMoveMenu((current) => !current); }}
          disabled={interactionBlocked}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!mutationAdmissionRef.current && !committedMailboxMutationRef.current) setShowMoveMenu(true);
            }
          }}
          className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 transition-colors"
          title="Move to folder"
        >
          <FolderInput size={14} />
        </button>
        <MoveToDropdown
          open={showMoveMenu}
          anchorRef={moveRef}
          menuId={moveMenuId}
          mailboxes={mailboxes}
          onMove={handleMove}
          onClose={() => { if (!mutationAdmissionRef.current) setShowMoveMenu(false); }}
        />
      </div>
      <button aria-label={trashBusy ? 'Moving message to Trash…' : 'Move message to trash'} onClick={() => { void handleTrash(); }} disabled={interactionBlocked} aria-busy={trashBusy} className="p-1.5 rounded-lg hover:bg-red-500/20 text-slate-400 hover:text-red-400 disabled:cursor-wait disabled:opacity-50 transition-colors" title="Move to trash">
        {trashBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
      <button aria-label={flagBusy ? 'Updating message flag…' : email.isFlagged ? 'Remove flag' : 'Flag message'} aria-pressed={email.isFlagged} onClick={() => { void handleFlag(); }} disabled={interactionBlocked} aria-busy={flagBusy} className={`p-1.5 rounded-lg hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-50 ${email.isFlagged ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'} transition-colors`} title="Toggle flag">
        {flagBusy ? <Loader2 size={14} className="animate-spin" /> : <Flag size={14} />}
      </button>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#080B20]">
      {/* Mobile: back button header */}
      {isMobile ? (
        <div className="flex items-center gap-2 px-2 py-2 border-b border-white/[0.06] flex-shrink-0">
          <button aria-label="Back to message list" onClick={requestBack} disabled={interactionBlocked} className="p-2 rounded-xl text-slate-400 hover:text-white active:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50 transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white truncate">{email.subject}</div>
          </div>
          <button aria-label={readBusy ? 'Updating message read status…' : email.isUnread ? 'Mark as read' : 'Mark as unread'} onClick={() => { void handleToggleRead(); }} disabled={interactionBlocked} aria-busy={readBusy} className="p-2 rounded-xl text-slate-400 active:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50 transition-colors">
            {readBusy ? <Loader2 size={18} className="animate-spin" /> : email.isUnread ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>
        </div>
      ) : (
        desktopToolbar
      )}

      {actionError && (!showMoveMenu || committedMailboxMutation) && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-300 md:px-5">
          <span>{actionError}</span>
          {committedMailboxMutation && (
            <button
              type="button"
              onClick={() => { void retryMailboxRefresh(); }}
              disabled={mutationBusy}
              aria-busy={mailboxRefreshBusy}
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 font-medium text-red-100 transition hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-50"
            >
              {mailboxRefreshBusy && <Loader2 size={13} className="animate-spin" />}
              {mailboxRefreshBusy ? 'Refreshing mailbox…' : 'Retry mailbox refresh'}
            </button>
          )}
        </div>
      )}

      {/* Email header */}
      <div className={`px-4 md:px-5 ${isMobile ? 'py-3' : 'py-4'} border-b border-white/[0.06] flex-shrink-0`}>
        {/* Subject (mobile shows inline, desktop shows here) */}
        {!isMobile && (
          <h2 className="text-lg font-semibold text-white mb-3">{email.subject}</h2>
        )}
        <div className="flex items-start gap-3">
          {/* Sender avatar */}
          <div className={`${isMobile ? 'w-8 h-8' : 'w-10 h-10'} rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold bg-violet-600/20 text-violet-300`}>
            {senderInitials(email.from)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-white truncate">{senderDisplay(email.from)}</div>
              <div className="text-xs text-slate-500 whitespace-nowrap flex items-center gap-1 flex-shrink-0">
                <Clock size={11} />
                <span className="hidden sm:inline">{new Date(email.receivedAt).toLocaleString()}</span>
                <span className="sm:hidden">{new Date(email.receivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              </div>
            </div>
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {email.from[0]?.email}
            </div>
            <div className="text-xs text-slate-500 mt-1 truncate">
              To: {email.to.map(t => t.name || t.email).join(', ')}
              {email.cc?.length ? <> · CC: {email.cc.map(c => c.name || c.email).join(', ')}</> : null}
            </div>
          </div>
        </div>
      </div>

      {/* Attachments */}
      {email.attachments.length > 0 && (
        <div className="px-4 md:px-5 py-2.5 border-b border-white/[0.06] flex-shrink-0">
          {attachmentError && <div role="alert" className="mb-2 text-xs text-red-400">{attachmentError}</div>}
          <div className="flex flex-wrap gap-2">
            {email.attachments.map((att) => (
              <div key={att.partId} className="flex items-center gap-1">
                <button
                  disabled={att.isDangerous || !att.downloadToken || interactionBlocked}
                  onClick={() => void downloadMailAttachment(att)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-l-xl text-xs transition-colors ${
                    att.isDangerous || !att.downloadToken
                      ? 'bg-red-500/10 border border-red-500/30 text-red-300 cursor-not-allowed'
                      : 'bg-white/[0.04] border border-white/[0.06] border-r-0 text-slate-300 hover:bg-white/[0.08] active:bg-white/[0.12] cursor-pointer'
                  }`}
                  aria-label={activeMutation?.kind === 'attachment-download' && activeMutation.blobId === att.blobId
                    ? `Downloading ${att.name || 'attachment'}…`
                    : `Download ${att.name || 'attachment'}`}
                  aria-busy={activeMutation?.kind === 'attachment-download' && activeMutation.blobId === att.blobId}
                >
                  {att.isDangerous || !att.downloadToken
                    ? <Shield size={14} className="text-red-400" />
                    : activeMutation?.kind === 'attachment-download' && activeMutation.blobId === att.blobId
                      ? <Loader2 size={14} className="animate-spin" />
                      : <Download size={14} />}
                  <span className="max-w-[140px] sm:max-w-[200px] truncate">{att.name || 'attachment'}</span>
                  <span className="text-slate-500">{formatSize(att.size)}</span>
                  {(att.isDangerous || !att.downloadToken) && <span className="text-red-400 font-medium">BLOCKED</span>}
                </button>
                {!att.isDangerous && att.downloadToken && (
                  <button
                    disabled={interactionBlocked || savedBlobIds.has(att.blobId)}
                    onClick={() => { void saveAttachmentToFiles(att); }}
                    aria-label={activeMutation?.kind === 'attachment-save' && activeMutation.blobId === att.blobId
                      ? `Saving ${att.name || 'attachment'} to Files…`
                      : savedBlobIds.has(att.blobId)
                        ? 'Saved to Files'
                        : 'Save to Files'}
                    aria-busy={activeMutation?.kind === 'attachment-save' && activeMutation.blobId === att.blobId}
                    className={`flex items-center gap-1 px-2.5 py-2 rounded-r-xl text-xs border transition-colors ${
                      savedBlobIds.has(att.blobId)
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : 'bg-white/[0.04] border-white/[0.06] text-slate-400 hover:bg-violet-600/20 hover:text-violet-300 hover:border-violet-500/30'
                    }`}
                    title="Save to Files"
                  >
                    {activeMutation?.kind === 'attachment-save' && activeMutation.blobId === att.blobId ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : savedBlobIds.has(att.blobId) ? (
                      <><Check size={13} /> <span>Saved!</span></>
                    ) : (
                      <><FolderDown size={13} /> <span className="hidden sm:inline">Save to Files</span></>
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {email.htmlBody?.[0] && containsRemoteMailContent(email.bodyValues[email.htmlBody[0].partId]?.value || '') && (
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] bg-amber-500/[0.06] px-4 py-2 text-xs text-amber-200 md:px-5">
          <span>{showRemoteContent ? 'Remote email content is enabled for this message.' : 'Remote images and styles are blocked to protect your privacy.'}</span>
          <button
            type="button"
            onClick={() => { if (!mutationAdmissionRef.current && !committedMailboxMutationRef.current) setShowRemoteContent(value => !value); }}
            disabled={interactionBlocked}
            className="shrink-0 rounded-lg border border-amber-400/20 bg-amber-500/10 px-2.5 py-1.5 font-medium text-amber-200 hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-50"
          >
            {showRemoteContent ? 'Block again' : 'Load once'}
          </button>
        </div>
      )}

      {/* Body iframe */}
      <div className="flex-1 overflow-y-auto">
        <iframe
          ref={iframeRef}
          sandbox="allow-same-origin"
          className="w-full border-0"
          style={{ minHeight: '200px' }}
          title="Email content"
        />
      </div>

      {/* Mobile bottom action bar */}
      {isMobile && mobileActions}
    </div>
  );
}
