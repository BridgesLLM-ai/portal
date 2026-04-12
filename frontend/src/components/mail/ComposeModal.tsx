import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Send, Loader2, Paperclip, AlertTriangle, Settings,
  MailPlus, Reply, Users, Forward, ArrowLeft,
} from 'lucide-react';
import { formatSize } from './helpers';
import { apiFetch, apiSendWithAttachments } from './api';
import type { ComposeState, AttachmentFile, MailboxInfo } from './types';
import sounds from '../../utils/sounds';

interface ComposeModalProps {
  onClose: () => void;
  onSent: () => void;
  composeState: ComposeState;
  mailboxes: MailboxInfo[];
  isMobile: boolean;
  account?: string;
  accountEmail?: string;
}

export default function ComposeModal({
  onClose, onSent, composeState, mailboxes, isMobile, account, accountEmail,
}: ComposeModalProps) {
  const { mode, replyTo } = composeState;
  const normalizedSelfEmail = accountEmail?.trim().toLowerCase() || '';
  const selfEmail = accountEmail?.trim() || 'user@bridgesllm.com';
  const isSelfAddress = (email: string) => normalizedSelfEmail !== '' && email.trim().toLowerCase() === normalizedSelfEmail;

  const getInitialTo = () => {
    if (!replyTo) return '';
    if (mode === 'reply') {
      return (replyTo.replyTo || replyTo.from).map(a => a.email).join(', ');
    }
    if (mode === 'replyAll') {
      const senders = (replyTo.replyTo || replyTo.from).map(a => a.email).filter(email => !isSelfAddress(email));
      const toRecipients = (replyTo.to || []).map(a => a.email).filter(email => !isSelfAddress(email));
      return [...new Set([...senders, ...toRecipients])].join(', ');
    }
    return '';
  };

  const getInitialCc = () => {
    if (mode === 'replyAll' && replyTo?.cc?.length) {
      return replyTo.cc.map(a => a.email).filter(email => !isSelfAddress(email)).join(', ');
    }
    return '';
  };

  const getInitialSubject = () => {
    if (!replyTo) return '';
    if (mode === 'forward') return `Fwd: ${replyTo.subject.replace(/^Fwd:\s*/i, '')}`;
    return `Re: ${replyTo.subject.replace(/^Re:\s*/i, '')}`;
  };

  const [to, setTo] = useState(getInitialTo);
  const [cc, setCc] = useState(getInitialCc);
  const [bcc, setBcc] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(!!getInitialCc());
  const [subject, setSubject] = useState(getInitialSubject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [signature, setSignature] = useState('');
  const [signatureHtml, setSignatureHtml] = useState('');
  const [showSignatureEditor, setShowSignatureEditor] = useState(false);
  const [signatureInput, setSignatureInput] = useState('');
  const [signatureHtmlInput, setSignatureHtmlInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    apiFetch('/signature', { account })
      .then(data => {
        if (data.signatureHtml) {
          setSignatureHtml(data.signatureHtml);
          setSignatureHtmlInput(data.signatureHtml);
        }
        if (data.signature) {
          setSignature(data.signature);
          setSignatureInput(data.signature);
        }
      })
      .catch(() => {});
  }, [account]);

  const getQuotedBody = () => {
    if (mode !== 'forward' || !replyTo) return '';
    const textPart = replyTo.textBody?.[0];
    const originalBody = textPart && replyTo.bodyValues[textPart.partId]
      ? replyTo.bodyValues[textPart.partId].value
      : replyTo.preview;
    return `\n\n---------- Forwarded message ----------\nFrom: ${replyTo.from.map(f => `${f.name} <${f.email}>`).join(', ')}\nDate: ${new Date(replyTo.receivedAt).toLocaleString()}\nSubject: ${replyTo.subject}\nTo: ${replyTo.to.map(t => `${t.name || t.email} <${t.email}>`).join(', ')}\n\n${originalBody}`;
  };

  const parseRecipients = (str: string) =>
    str.split(',').map(e => e.trim()).filter(Boolean).map(email => ({ email }));

  const handleSend = async () => {
    if (!to.trim()) { setError('Recipients required'); return; }
    if (!subject.trim()) { setError('Subject required'); return; }

    // Build body with signature
    let fullTextBody = body;
    let fullHtmlBody = '';
    
    if (signature) {
      fullTextBody = `${body}\n\n-- \n${signature}`;
    }
    
    if (signatureHtml) {
      const escapedBody = body.replace(/\n/g, '<br/>').replace(/  /g, '&nbsp; ');
      fullHtmlBody = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#333;">${escapedBody}</div>
<br/><div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:12px;">${signatureHtml}</div>`;
    }

    if (mode === 'forward' && !fullTextBody.trim() && !replyTo) { setError('Message body required'); return; }
    if (mode === 'forward') fullTextBody = fullTextBody + getQuotedBody();
    if (!fullTextBody.trim() && mode !== 'forward') { setError('Message body required'); return; }

    setSending(true);
    setError('');

    try {
      const recipients = parseRecipients(to);
      const ccList = cc.trim() ? parseRecipients(cc) : undefined;
      const bccList = bcc.trim() ? parseRecipients(bcc) : undefined;
      const files = attachments.map(a => a.file);

      if (mode === 'forward' && replyTo) {
        await apiSendWithAttachments('/forward', {
          originalId: replyTo.id,
          to: recipients,
          cc: ccList,
          bcc: bccList,
          body: body + (signature ? `\n\n-- \n${signature}` : ''),
        }, files, account);
      } else {
        const data: any = {
          to: recipients, cc: ccList, bcc: bccList,
          subject, textBody: fullTextBody,
        };
        // Include HTML body if we have an HTML signature
        if (fullHtmlBody) {
          data.htmlBody = fullHtmlBody;
        }
        if (replyTo?.messageId && (mode === 'reply' || mode === 'replyAll')) {
          data.inReplyTo = replyTo.messageId;
          data.references = [...(replyTo.references || []), ...(replyTo.messageId || [])];
        }
        if (files.length > 0) {
          await apiSendWithAttachments('/send', data, files, account);
        } else {
          await apiFetch('/send', { method: 'POST', body: JSON.stringify(data), account });
        }
      }

      sounds.upload();
      onSent();
      onClose();
    } catch (err: any) {
      sounds.error();
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const newAttachments: AttachmentFile[] = Array.from(files).map(file => ({
      file,
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    setAttachments(prev => [...prev, ...newAttachments]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const handleSaveSignature = async () => {
    try {
      await apiFetch('/signature', {
        method: 'PUT',
        body: JSON.stringify({ 
          signature: signatureInput,
          signatureHtml: signatureHtmlInput,
        }),
        account,
      });
      setSignature(signatureInput);
      setSignatureHtml(signatureHtmlInput);
      setShowSignatureEditor(false);
    } catch {}
  };

  const modeTitle = {
    new: 'New Email',
    reply: 'Reply',
    replyAll: 'Reply All',
    forward: 'Forward',
  }[mode];

  const ModeIcon = mode === 'forward' ? Forward : mode === 'replyAll' ? Users : mode === 'reply' ? Reply : MailPlus;

  const inputClasses = "w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30 transition-colors";

  // Mobile: full screen overlay
  if (isMobile) {
    return (
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="fixed inset-0 z-50 bg-[#080B20] flex flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-2 py-2 border-b border-white/[0.06] flex-shrink-0">
          <button onClick={onClose} className="p-2 rounded-xl text-slate-400 active:bg-white/[0.06] transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <ModeIcon size={16} />
            {modeTitle}
          </h3>
          <button
            onClick={handleSend}
            disabled={sending}
            className="p-2 rounded-xl text-violet-400 active:bg-violet-600/20 disabled:opacity-50 transition-colors"
          >
            {sending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-slate-400 font-medium">To</label>
              {!showCcBcc && (
                <button onClick={() => setShowCcBcc(true)} className="text-xs text-violet-400 active:text-violet-300">CC/BCC</button>
              )}
            </div>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" className={inputClasses} />
          </div>

          <AnimatePresence>
            {showCcBcc && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="space-y-3 overflow-hidden"
              >
                <div>
                  <label className="text-xs text-slate-400 font-medium mb-1.5 block">CC</label>
                  <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="cc@example.com" className={inputClasses} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 font-medium mb-1.5 block">BCC</label>
                  <input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="bcc@example.com" className={inputClasses} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label className="text-xs text-slate-400 font-medium mb-1.5 block">Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className={inputClasses} />
          </div>

          <div>
            <label className="text-xs text-slate-400 font-medium mb-1.5 block">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder={mode === 'forward' ? 'Add a message (optional)…' : 'Write your message…'}
              className={`${inputClasses} resize-none min-h-[200px]`}
            />
          </div>

          {signature && (
            <div className="text-xs text-slate-500 border-t border-white/[0.04] pt-2 font-mono whitespace-pre-wrap">-- {'\n'}{signature}</div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map(att => (
                <div key={att.id} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs bg-white/[0.04] border border-white/[0.06] text-slate-300">
                  <Paperclip size={12} />
                  <span className="max-w-[120px] truncate">{att.file.name}</span>
                  <span className="text-slate-500">{formatSize(att.file.size)}</span>
                  <button onClick={() => removeAttachment(att.id)} className="p-1 rounded-lg active:bg-white/[0.06] text-slate-400 ml-1"><X size={12} /></button>
                </div>
              ))}
            </div>
          )}

          {mode === 'forward' && replyTo && replyTo.attachments.length > 0 && (
            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <Paperclip size={12} />
              {replyTo.attachments.filter(a => !a.isDangerous).length} original attachment(s) will be forwarded
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 flex items-center gap-1.5 px-3 py-2 bg-red-500/10 rounded-xl">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06] flex-shrink-0 safe-area-bottom">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 truncate max-w-[160px]">From: {selfEmail}</span>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <button onClick={() => fileInputRef.current?.click()} className="p-2 rounded-xl active:bg-white/[0.06] text-slate-400 transition-colors" title="Attach files">
              <Paperclip size={18} />
            </button>
            <button onClick={() => setShowSignatureEditor(!showSignatureEditor)} className="p-2 rounded-xl active:bg-white/[0.06] text-slate-400 transition-colors" title="Signature">
              <Settings size={16} />
            </button>
          </div>
        </div>

        {/* Signature editor sheet */}
        <AnimatePresence>
          {showSignatureEditor && (
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 300 }}
              className="fixed inset-x-0 bottom-0 z-[60] bg-[#0D1130] border-t border-white/[0.08] rounded-t-2xl p-4 space-y-3 shadow-2xl"
            >
              <div className="flex justify-center mb-2"><div className="w-10 h-1 rounded-full bg-white/20" /></div>
              <label className="text-xs text-slate-400 font-medium block">Email Signature</label>
              <textarea
                value={signatureInput}
                onChange={(e) => setSignatureInput(e.target.value)}
                rows={3}
                placeholder="Your email signature…"
                className={`${inputClasses} font-mono`}
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowSignatureEditor(false)} className="px-3 py-2 text-xs rounded-xl bg-white/[0.04] active:bg-white/[0.08] text-slate-300">Cancel</button>
                <button onClick={handleSaveSignature} className="px-4 py-2 text-xs rounded-xl bg-violet-600 active:bg-violet-500 text-white font-medium">Save</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  }

  // Desktop: centered modal
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="bg-[#0D1130] border border-white/[0.08] rounded-2xl w-full max-w-2xl mx-4 shadow-2xl shadow-black/50 overflow-hidden max-h-[90vh] flex flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] flex-shrink-0">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <ModeIcon size={16} /> {modeTitle}
          </h3>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowSignatureEditor(!showSignatureEditor)} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors" title="Email signature">
              <Settings size={14} />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Signature Editor */}
        <AnimatePresence>
          {showSignatureEditor && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-b border-white/[0.06] flex-shrink-0"
            >
              <div className="p-4 space-y-2">
                <label className="text-xs text-slate-400 block">Email Signature</label>
                <textarea
                  value={signatureInput}
                  onChange={(e) => setSignatureInput(e.target.value)}
                  rows={3}
                  placeholder="Your email signature…"
                  className={`${inputClasses} font-mono text-xs`}
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowSignatureEditor(false)} className="px-2 py-1 text-xs rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">Cancel</button>
                  <button onClick={handleSaveSignature} className="px-3 py-1 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors">Save Signature</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Form */}
        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-slate-400">To</label>
              {!showCcBcc && (
                <button onClick={() => setShowCcBcc(true)} className="text-xs text-violet-400 hover:text-violet-300">CC/BCC</button>
              )}
            </div>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" className={inputClasses} />
          </div>

          <AnimatePresence>
            {showCcBcc && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="space-y-3 overflow-hidden"
              >
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">CC</label>
                  <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="cc@example.com" className={inputClasses} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">BCC</label>
                  <input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="bcc@example.com" className={inputClasses} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className={inputClasses} />
          </div>

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Message</label>
            <div className={`relative rounded-xl transition-colors ${isDragging ? 'ring-2 ring-violet-500/50' : ''}`}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                placeholder={mode === 'forward' ? 'Add a message (optional)…' : 'Write your message…'}
                className={`${inputClasses} resize-none`}
              />
              {isDragging && (
                <div className="absolute inset-0 bg-violet-600/10 border-2 border-dashed border-violet-500/50 rounded-xl flex items-center justify-center">
                  <div className="text-violet-300 text-sm flex items-center gap-2"><Paperclip size={16} /> Drop files here</div>
                </div>
              )}
            </div>
          </div>

          {signature && (
            <div className="text-xs text-slate-500 border-t border-white/[0.04] pt-2 font-mono whitespace-pre-wrap">-- {'\n'}{signature}</div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map(att => (
                <div key={att.id} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs bg-white/[0.04] border border-white/[0.06] text-slate-300">
                  <Paperclip size={12} />
                  <span className="max-w-[150px] truncate">{att.file.name}</span>
                  <span className="text-slate-500">{formatSize(att.file.size)}</span>
                  <button onClick={() => removeAttachment(att.id)} className="p-0.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white ml-1"><X size={10} /></button>
                </div>
              ))}
            </div>
          )}

          {mode === 'forward' && replyTo && replyTo.attachments.length > 0 && (
            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <Paperclip size={12} />
              {replyTo.attachments.filter(a => !a.isDangerous).length} original attachment(s) will be forwarded
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle size={12} /> {error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">From: {selfEmail}</span>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <button onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors" title="Attach files">
              <Paperclip size={14} />
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">Cancel</button>
            <button
              onClick={handleSend}
              disabled={sending}
              className="px-4 py-1.5 text-xs rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-medium disabled:opacity-50 flex items-center gap-1.5 transition-colors shadow-lg shadow-violet-600/20"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Send
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
