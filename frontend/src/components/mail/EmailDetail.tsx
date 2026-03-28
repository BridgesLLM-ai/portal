import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Reply, Users, Forward, Eye, EyeOff, FolderInput,
  Trash2, Flag, Clock, Loader2, Shield, Download, Paperclip,
  FolderDown, Check,
} from 'lucide-react';
import { formatSize, senderDisplay, senderInitials } from './helpers';
import { MoveToDropdown } from './MoveToDropdown';
import { apiFetch } from './api';
import type { EmailFull, ComposeState, MailboxInfo } from './types';
import sounds from '../../utils/sounds';

interface EmailDetailProps {
  emailId: string;
  onBack: () => void;
  onRefresh: () => void;
  mailboxes: MailboxInfo[];
  onCompose: (state: ComposeState) => void;
  isMobile: boolean;
  account?: string;
}

export default function EmailDetail({
  emailId, onBack, onRefresh, mailboxes, onCompose, isMobile, account,
}: EmailDetailProps) {
  const [email, setEmail] = useState<EmailFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [savingBlobId, setSavingBlobId] = useState<string | null>(null);
  const [savedBlobIds, setSavedBlobIds] = useState<Set<string>>(new Set());
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const moveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/messages/${emailId}`, { account })
      .then((data) => {
        setEmail(data);
        if (data?.isUnread) {
          apiFetch(`/messages/${emailId}/read`, {
            method: 'POST',
            body: JSON.stringify({ read: true }),
            account,
          }).then(() => onRefresh()).catch(() => {});
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [emailId]);

  useEffect(() => {
    if (!showMoveMenu) return;
    const handler = (e: MouseEvent) => {
      if (moveRef.current && !moveRef.current.contains(e.target as Node)) {
        setShowMoveMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMoveMenu]);

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
      content = `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif;font-size:14px;color:#e2e8f0;margin:0;">${
        email.bodyValues[textPart.partId].value
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }</pre>`;
    }

    const doc = iframeRef.current.contentDocument;
    if (doc) {
      doc.open();
      if (isHtml) {
        // For HTML emails: preserve original styling, add responsive scaling
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
          /* Don't force dark mode on HTML emails — respect their design */
          body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; overflow-wrap: break-word; word-break: break-word; }
          a { color: #6366f1; }
          img { max-width: 100% !important; height: auto !important; }
          table { max-width: 100% !important; }
          /* Make email content scale to fit mobile */
          @media (max-width: 640px) {
            body { padding: 12px; font-size: 15px; }
            table { width: 100% !important; }
            td { display: block !important; width: 100% !important; box-sizing: border-box; }
          }
        </style></head><body>${content}</body></html>`);
      } else {
        // For plain text: dark mode is fine
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
          body { margin: 0; padding: 16px; background: #0a0e1a; color: #e2e8f0; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; overflow-wrap: break-word; word-break: break-word; }
          a { color: #818cf8; }
          blockquote { border-left: 3px solid #334155; padding-left: 12px; margin-left: 0; color: #94a3b8; }
          @media (max-width: 640px) { body { padding: 12px; font-size: 15px; } }
        </style></head><body>${content}</body></html>`);
      }
      doc.close();

      // Auto-resize iframe to content height (eliminates scrollbar-in-scrollbar)
      const resizeIframe = () => {
        if (iframeRef.current?.contentDocument?.body) {
          const height = iframeRef.current.contentDocument.body.scrollHeight;
          iframeRef.current.style.height = `${height + 20}px`;
        }
      };

      // Resize after images load
      setTimeout(resizeIframe, 100);
      setTimeout(resizeIframe, 500);
      setTimeout(resizeIframe, 2000);
      
      // Also listen for load events on images
      const images = doc.querySelectorAll('img');
      images.forEach(img => img.addEventListener('load', resizeIframe));
    }
  }, [email]);

  const handleToggleRead = async () => {
    if (!email) return;
    try {
      const newRead = email.isUnread;
      await apiFetch(`/messages/${email.id}/read`, {
        method: 'POST',
        body: JSON.stringify({ read: newRead }),
        account,
      });
      sounds.click();
      setEmail(prev => prev ? { ...prev, isUnread: !newRead } : prev);
      onRefresh();
    } catch {}
  };

  const handleMove = async (targetMailboxId: string) => {
    if (!email) return;
    try {
      await apiFetch(`/messages/${email.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ targetMailboxId }),
        account,
      });
      sounds.success();
      onBack();
      onRefresh();
    } catch {}
  };

  const handleTrash = async () => {
    if (!email) return;
    try {
      await apiFetch(`/messages/${email.id}/trash`, { method: 'POST', account });
      sounds.delete();
      onBack();
      onRefresh();
    } catch {}
  };

  const handleFlag = async () => {
    if (!email) return;
    try {
      await apiFetch(`/messages/${email.id}/flag`, {
        method: 'POST',
        body: JSON.stringify({ flagged: !email.isFlagged }),
        account,
      });
      sounds.click();
      setEmail(prev => prev ? { ...prev, isFlagged: !prev.isFlagged } : prev);
    } catch {}
  };

  const saveAttachmentToFiles = async (att: { blobId: string; name: string | null; type: string }) => {
    setSavingBlobId(att.blobId);
    try {
      await apiFetch(`/attachments/${att.blobId}/save-to-files`, {
        method: 'POST',
        body: JSON.stringify({
          filename: att.name || 'attachment',
          contentType: att.type,
        }),
        account,
      });
      sounds.success();
      setSavedBlobIds(prev => new Set(prev).add(att.blobId));
      setTimeout(() => {
        setSavedBlobIds(prev => {
          const next = new Set(prev);
          next.delete(att.blobId);
          return next;
        });
      }, 2000);
    } catch {
      sounds.error();
    } finally {
      setSavingBlobId(null);
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

  // Mobile bottom action bar items
  const mobileActions = (
    <div className="flex items-center justify-around py-2 px-2 border-t border-white/[0.06] bg-[#080B20] flex-shrink-0 safe-area-bottom">
      <button
        onClick={() => onCompose({ mode: 'reply', replyTo: email })}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-violet-300 active:bg-violet-600/20 transition-colors min-w-[56px]"
      >
        <Reply size={20} />
        <span className="text-[10px]">Reply</span>
      </button>
      <button
        onClick={() => onCompose({ mode: 'replyAll', replyTo: email })}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-violet-300 active:bg-violet-600/20 transition-colors min-w-[56px]"
      >
        <Users size={18} />
        <span className="text-[10px]">Reply All</span>
      </button>
      <button
        onClick={() => onCompose({ mode: 'forward', replyTo: email })}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-slate-300 active:bg-white/[0.06] transition-colors min-w-[56px]"
      >
        <Forward size={20} />
        <span className="text-[10px]">Forward</span>
      </button>
      <button
        onClick={handleTrash}
        className="flex flex-col items-center gap-0.5 p-2 rounded-xl text-slate-400 active:bg-red-500/20 transition-colors min-w-[56px]"
      >
        <Trash2 size={20} />
        <span className="text-[10px]">Trash</span>
      </button>
      <button
        onClick={handleFlag}
        className={`flex flex-col items-center gap-0.5 p-2 rounded-xl transition-colors min-w-[56px] ${email.isFlagged ? 'text-amber-400' : 'text-slate-400 active:bg-amber-500/20'}`}
      >
        <Flag size={20} />
        <span className="text-[10px]">Flag</span>
      </button>
    </div>
  );

  // Desktop toolbar
  const desktopToolbar = (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-white/[0.06] flex-shrink-0 bg-[#080B20]">
      <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors">
        <ArrowLeft size={16} />
      </button>
      <div className="flex-1" />
      <button
        onClick={() => onCompose({ mode: 'reply', replyTo: email })}
        className="px-3 py-1.5 text-xs rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 font-medium flex items-center gap-1.5 transition-colors"
      >
        <Reply size={12} /> Reply
      </button>
      <button
        onClick={() => onCompose({ mode: 'replyAll', replyTo: email })}
        className="px-3 py-1.5 text-xs rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 font-medium flex items-center gap-1.5 transition-colors"
        title="Reply All"
      >
        <Users size={12} /> Reply All
      </button>
      <button
        onClick={() => onCompose({ mode: 'forward', replyTo: email })}
        className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 font-medium flex items-center gap-1.5 transition-colors"
        title="Forward"
      >
        <Forward size={12} /> Forward
      </button>
      <button onClick={handleToggleRead} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors" title={email.isUnread ? 'Mark as read' : 'Mark as unread'}>
        {email.isUnread ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <div className="relative" ref={moveRef}>
        <button onClick={() => setShowMoveMenu(!showMoveMenu)} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors" title="Move to folder">
          <FolderInput size={14} />
        </button>
        {showMoveMenu && (
          <MoveToDropdown mailboxes={mailboxes} onMove={handleMove} onClose={() => setShowMoveMenu(false)} />
        )}
      </div>
      <button onClick={handleTrash} className="p-1.5 rounded-lg hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors" title="Move to trash">
        <Trash2 size={14} />
      </button>
      <button onClick={handleFlag} className={`p-1.5 rounded-lg hover:bg-amber-500/20 ${email.isFlagged ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'} transition-colors`} title="Toggle flag">
        <Flag size={14} />
      </button>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#080B20]">
      {/* Mobile: back button header */}
      {isMobile ? (
        <div className="flex items-center gap-2 px-2 py-2 border-b border-white/[0.06] flex-shrink-0">
          <button onClick={onBack} className="p-2 rounded-xl text-slate-400 hover:text-white active:bg-white/[0.06] transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white truncate">{email.subject}</div>
          </div>
          <button onClick={handleToggleRead} className="p-2 rounded-xl text-slate-400 active:bg-white/[0.06] transition-colors">
            {email.isUnread ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>
        </div>
      ) : (
        desktopToolbar
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
          <div className="flex flex-wrap gap-2">
            {email.attachments.map((att) => (
              <div key={att.partId} className="flex items-center gap-1">
                <button
                  disabled={att.isDangerous}
                  onClick={() => {
                    if (!att.isDangerous) {
                      window.open(`/api/mail/attachments/${att.blobId}?name=${encodeURIComponent(att.name || 'file')}&type=${encodeURIComponent(att.type)}${account && account !== 'personal' ? `&account=${account}` : ''}`, '_blank');
                    }
                  }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-l-xl text-xs transition-colors ${
                    att.isDangerous
                      ? 'bg-red-500/10 border border-red-500/30 text-red-300 cursor-not-allowed'
                      : 'bg-white/[0.04] border border-white/[0.06] border-r-0 text-slate-300 hover:bg-white/[0.08] active:bg-white/[0.12] cursor-pointer'
                  }`}
                >
                  {att.isDangerous ? <Shield size={14} className="text-red-400" /> : <Download size={14} />}
                  <span className="max-w-[140px] sm:max-w-[200px] truncate">{att.name || 'attachment'}</span>
                  <span className="text-slate-500">{formatSize(att.size)}</span>
                  {att.isDangerous && <span className="text-red-400 font-medium">BLOCKED</span>}
                </button>
                {!att.isDangerous && (
                  <button
                    disabled={savingBlobId === att.blobId || savedBlobIds.has(att.blobId)}
                    onClick={() => saveAttachmentToFiles(att)}
                    className={`flex items-center gap-1 px-2.5 py-2 rounded-r-xl text-xs border transition-colors ${
                      savedBlobIds.has(att.blobId)
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : 'bg-white/[0.04] border-white/[0.06] text-slate-400 hover:bg-violet-600/20 hover:text-violet-300 hover:border-violet-500/30'
                    }`}
                    title="Save to Files"
                  >
                    {savingBlobId === att.blobId ? (
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
