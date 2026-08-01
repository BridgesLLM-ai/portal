import { useState, useRef, useEffect, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Send, Loader2, Paperclip, AlertTriangle, Settings,
  MailPlus, Reply, Users, Forward, ArrowLeft,
} from 'lucide-react';
import { formatSize } from './helpers';
import { apiFetch, apiSendWithAttachments } from './api';
import type { ComposeState, AttachmentFile, MailboxInfo, MailMutationChangeHandler } from './types';
import sounds from '../../utils/sounds';
import ViewportModal from '../ViewportModal';

interface ComposeModalProps {
  onClose: () => void;
  onSent: () => void;
  composeState: ComposeState;
  mailboxes: MailboxInfo[];
  isMobile: boolean;
  account?: string;
  accountEmail?: string;
  onMutationChange?: MailMutationChangeHandler;
}

type ComposeSendRequest =
  | {
      kind: 'forward';
      originalId: string;
      to: readonly { email: string }[];
      cc?: readonly { email: string }[];
      bcc?: readonly { email: string }[];
      body: string;
      files: readonly File[];
      account?: string;
    }
  | {
      kind: 'send';
      payload: Readonly<Record<string, unknown>>;
      files: readonly File[];
      account?: string;
    };

type ComposeMutation =
  | { kind: 'send'; request: ComposeSendRequest }
  | { kind: 'signature-save'; signature: string; signatureHtml: string; account?: string };

export default function ComposeModal({
  onClose, onSent, composeState, isMobile, account, accountEmail, onMutationChange,
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
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [signature, setSignature] = useState('');
  const [signatureHtml, setSignatureHtml] = useState('');
  const [showSignatureEditor, setShowSignatureEditor] = useState(false);
  const [signatureInput, setSignatureInput] = useState('');
  const [signatureHtmlInput, setSignatureHtmlInput] = useState('');
  const [signatureError, setSignatureError] = useState('');
  const [activeMutation, setActiveMutation] = useState<ComposeMutation | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const mutationAdmissionRef = useRef<ComposeMutation | null>(null);
  const signatureLoadRevisionRef = useRef(0);
  const titleId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const sending = activeMutation?.kind === 'send';
  const savingSignature = activeMutation?.kind === 'signature-save';
  const mutationBusy = activeMutation !== null;

  useEffect(() => {
    let cancelled = false;
    const loadRevision = ++signatureLoadRevisionRef.current;
    setSignature('');
    setSignatureHtml('');
    setSignatureInput('');
    setSignatureHtmlInput('');
    setSignatureError('');
    apiFetch('/signature', { account })
      .then(data => {
        if (cancelled || signatureLoadRevisionRef.current !== loadRevision) return;
        setSignatureHtml(data.signatureHtml || '');
        setSignatureHtmlInput(data.signatureHtml || '');
        setSignature(data.signature || '');
        setSignatureInput(data.signature || '');
      })
      .catch((err: any) => {
        if (!cancelled && signatureLoadRevisionRef.current === loadRevision) {
          setSignatureError(err?.message || 'Email signature is unavailable');
        }
      });
    return () => { cancelled = true; };
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
    if (mutationAdmissionRef.current) return;
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

    const recipients = Object.freeze(parseRecipients(to));
    const ccList = cc.trim() ? Object.freeze(parseRecipients(cc)) : undefined;
    const bccList = bcc.trim() ? Object.freeze(parseRecipients(bcc)) : undefined;
    const files = Object.freeze(attachments.map(a => a.file));
    let request: ComposeSendRequest;
    if (mode === 'forward' && replyTo) {
      request = Object.freeze({
        kind: 'forward',
        originalId: replyTo.id,
        to: recipients,
        cc: ccList,
        bcc: bccList,
        body: body + (signature ? `\n\n-- \n${signature}` : ''),
        files,
        account,
      });
    } else {
      const payload: Record<string, unknown> = {
        to: recipients, cc: ccList, bcc: bccList,
        subject, textBody: fullTextBody,
      };
      if (fullHtmlBody) payload.htmlBody = fullHtmlBody;
      if (replyTo?.messageId && (mode === 'reply' || mode === 'replyAll')) {
        payload.inReplyTo = replyTo.messageId;
        payload.references = [...(replyTo.references || []), ...(replyTo.messageId || [])];
      }
      request = Object.freeze({
        kind: 'send',
        payload: Object.freeze(payload),
        files,
        account,
      });
    }
    const admission: ComposeMutation = Object.freeze({ kind: 'send', request });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Sending message',
      account: admission.request.account,
    }));
    setActiveMutation(admission);
    setError('');

    try {
      if (admission.request.kind === 'forward') {
        await apiSendWithAttachments('/forward', {
          originalId: admission.request.originalId,
          to: admission.request.to,
          cc: admission.request.cc,
          bcc: admission.request.bcc,
          body: admission.request.body,
        }, [...admission.request.files], admission.request.account);
      } else {
        if (admission.request.files.length > 0) {
          await apiSendWithAttachments(
            '/send',
            admission.request.payload,
            [...admission.request.files],
            admission.request.account,
          );
        } else {
          await apiFetch('/send', {
            method: 'POST',
            body: JSON.stringify(admission.request.payload),
            account: admission.request.account,
          });
        }
      }

      sounds.upload();
      onSent();
      onClose();
    } catch (err: any) {
      sounds.error();
      setError(err.message);
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSend();
  };

  const handleRequestClose = () => {
    if (mutationAdmissionRef.current) return;
    onClose();
  };

  const addFiles = (files: FileList | File[]) => {
    if (mutationAdmissionRef.current) return;
    const newAttachments: AttachmentFile[] = Array.from(files).map(file => ({
      file,
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    setAttachments(prev => [...prev, ...newAttachments]);
  };

  const removeAttachment = (id: string) => {
    if (mutationAdmissionRef.current) return;
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); if (!mutationAdmissionRef.current) setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    if (!mutationAdmissionRef.current && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const handleSaveSignature = async () => {
    if (mutationAdmissionRef.current) return;
    const admission: ComposeMutation = Object.freeze({
      kind: 'signature-save',
      signature: signatureInput,
      signatureHtml: signatureHtmlInput,
      account,
    });
    mutationAdmissionRef.current = admission;
    onMutationChange?.(Object.freeze({
      kind: admission.kind,
      label: 'Saving mail signature',
      account: admission.account,
    }));
    signatureLoadRevisionRef.current += 1;
    setActiveMutation(admission);
    setSignatureError('');
    try {
      await apiFetch('/signature', {
        method: 'PUT',
        body: JSON.stringify({ 
          signature: admission.signature,
          signatureHtml: admission.signatureHtml,
        }),
        account: admission.account,
      });
      setSignature(admission.signature);
      setSignatureHtml(admission.signatureHtml);
      setShowSignatureEditor(false);
    } catch (err: any) {
      setSignatureError(err?.message || 'Failed to save email signature');
    } finally {
      if (mutationAdmissionRef.current === admission) {
        mutationAdmissionRef.current = null;
        onMutationChange?.(null);
        setActiveMutation(null);
      }
    }
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
      <ViewportModal
        open
        onDismiss={handleRequestClose}
        dismissible={!mutationBusy}
        initialFocusRef={toInputRef}
        className="items-stretch justify-stretch"
      >
        <motion.form
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 300 }}
          className="flex h-full min-h-0 w-full flex-col bg-[#080B20]"
          onSubmit={handleSubmit}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
        {/* Header */}
        <div className="flex items-center justify-between px-2 py-2 border-b border-white/[0.06] flex-shrink-0">
          <button type="button" onClick={handleRequestClose} disabled={mutationBusy} aria-label="Close message composer" className="p-2 rounded-xl text-slate-400 active:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50 transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h3 id={titleId} className="text-sm font-semibold text-white flex items-center gap-2">
            <ModeIcon size={16} />
            {modeTitle}
          </h3>
          <button
            type="submit"
            disabled={mutationBusy}
            aria-busy={sending}
            aria-label={sending ? 'Sending message' : 'Send message'}
            className="p-2 rounded-xl text-violet-400 active:bg-violet-600/20 disabled:opacity-50 transition-colors"
          >
            {sending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="compose-mobile-to" className="text-xs text-slate-400 font-medium">To</label>
              {!showCcBcc && (
                <button type="button" onClick={() => { if (!mutationAdmissionRef.current) setShowCcBcc(true); }} disabled={mutationBusy} className="text-xs text-violet-400 active:text-violet-300 disabled:cursor-wait disabled:opacity-50">CC/BCC</button>
              )}
            </div>
            <input ref={toInputRef} id="compose-mobile-to" value={to} onChange={(e) => setTo(e.target.value)} disabled={mutationBusy} placeholder="recipient@example.com" aria-label="To" className={inputClasses} />
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
                  <label htmlFor="compose-mobile-cc" className="text-xs text-slate-400 font-medium mb-1.5 block">CC</label>
                  <input id="compose-mobile-cc" value={cc} onChange={(e) => setCc(e.target.value)} disabled={mutationBusy} placeholder="cc@example.com" aria-label="CC" className={inputClasses} />
                </div>
                <div>
                  <label htmlFor="compose-mobile-bcc" className="text-xs text-slate-400 font-medium mb-1.5 block">BCC</label>
                  <input id="compose-mobile-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} disabled={mutationBusy} placeholder="bcc@example.com" aria-label="BCC" className={inputClasses} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label htmlFor="compose-mobile-subject" className="text-xs text-slate-400 font-medium mb-1.5 block">Subject</label>
            <input id="compose-mobile-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={mutationBusy} placeholder="Subject" aria-label="Subject" className={inputClasses} />
          </div>

          <div>
            <label htmlFor="compose-mobile-message" className="text-xs text-slate-400 font-medium mb-1.5 block">Message</label>
            <textarea
              id="compose-mobile-message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={mutationBusy}
              rows={10}
              placeholder={mode === 'forward' ? 'Add a message (optional)…' : 'Write your message…'}
              aria-label="Message"
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
                  <button type="button" onClick={() => removeAttachment(att.id)} disabled={mutationBusy} aria-label={`Remove ${att.file.name}`} className="p-1 rounded-lg active:bg-white/[0.06] text-slate-400 disabled:cursor-wait disabled:opacity-50 ml-1"><X size={12} /></button>
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

          {(error || (!showSignatureEditor && signatureError)) && (
            <div className="text-xs text-red-400 flex items-center gap-1.5 px-3 py-2 bg-red-500/10 rounded-xl">
              <AlertTriangle size={14} /> {error || signatureError}
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06] flex-shrink-0 safe-area-bottom">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 truncate max-w-[160px]">From: {selfEmail}</span>
            <input ref={fileInputRef} type="file" multiple disabled={mutationBusy} aria-label="Attach files" className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" onClick={() => { if (!mutationAdmissionRef.current) fileInputRef.current?.click(); }} disabled={mutationBusy} aria-label="Attach files" className="p-2 rounded-xl active:bg-white/[0.06] text-slate-400 disabled:cursor-wait disabled:opacity-50 transition-colors" title="Attach files">
              <Paperclip size={18} />
            </button>
            <button type="button" onClick={() => { if (!mutationAdmissionRef.current) setShowSignatureEditor(!showSignatureEditor); }} disabled={mutationBusy} aria-label="Edit signature" className="p-2 rounded-xl active:bg-white/[0.06] text-slate-400 disabled:cursor-wait disabled:opacity-50 transition-colors" title="Signature">
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
              <label htmlFor="compose-mobile-signature" className="text-xs text-slate-400 font-medium block">Email Signature</label>
              <textarea
                id="compose-mobile-signature"
                value={signatureInput}
                onChange={(e) => setSignatureInput(e.target.value)}
                disabled={mutationBusy}
                rows={3}
                placeholder="Your email signature…"
                aria-label="Email signature"
                className={`${inputClasses} font-mono`}
              />
              {signatureError && <div role="alert" className="text-xs text-red-400">{signatureError}</div>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { if (!mutationAdmissionRef.current) setShowSignatureEditor(false); }} disabled={mutationBusy} className="px-3 py-2 text-xs rounded-xl bg-white/[0.04] active:bg-white/[0.08] text-slate-300 disabled:cursor-wait disabled:opacity-50">Cancel</button>
                <button type="button" onClick={() => { void handleSaveSignature(); }} disabled={mutationBusy} aria-busy={savingSignature} className="px-4 py-2 text-xs rounded-xl bg-violet-600 active:bg-violet-500 text-white font-medium disabled:cursor-wait disabled:opacity-50">{savingSignature ? 'Saving…' : 'Save'}</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        </motion.form>
      </ViewportModal>
    );
  }

  // Desktop: centered modal
  return (
    <ViewportModal
      open
      onDismiss={handleRequestClose}
      dismissible={!mutationBusy}
      initialFocusRef={toInputRef}
      className="bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.form
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0D1130] shadow-2xl shadow-black/50"
        onSubmit={handleSubmit}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] flex-shrink-0">
          <h3 id={titleId} className="text-sm font-semibold text-white flex items-center gap-2">
            <ModeIcon size={16} /> {modeTitle}
          </h3>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Edit email signature" onClick={() => { if (!mutationAdmissionRef.current) setShowSignatureEditor(!showSignatureEditor); }} disabled={mutationBusy} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 transition-colors" title="Email signature">
              <Settings size={14} />
            </button>
            <button type="button" aria-label="Close compose window" onClick={handleRequestClose} disabled={mutationBusy} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 transition-colors">
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
                <label htmlFor="compose-desktop-signature" className="text-xs text-slate-400 block">Email Signature</label>
                <textarea
                  id="compose-desktop-signature"
                  value={signatureInput}
                  onChange={(e) => setSignatureInput(e.target.value)}
                  disabled={mutationBusy}
                  rows={3}
                  placeholder="Your email signature…"
                  aria-label="Email signature"
                  className={`${inputClasses} font-mono text-xs`}
                />
                {signatureError && <div role="alert" className="text-xs text-red-400">{signatureError}</div>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { if (!mutationAdmissionRef.current) setShowSignatureEditor(false); }} disabled={mutationBusy} className="px-2 py-1 text-xs rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 disabled:cursor-wait disabled:opacity-50 transition-colors">Cancel</button>
                  <button type="button" onClick={() => { void handleSaveSignature(); }} disabled={mutationBusy} aria-busy={savingSignature} className="px-3 py-1 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:cursor-wait disabled:opacity-50">{savingSignature ? 'Saving…' : 'Save Signature'}</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Form */}
        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="compose-desktop-to" className="text-xs text-slate-400">To</label>
              {!showCcBcc && (
                <button type="button" onClick={() => { if (!mutationAdmissionRef.current) setShowCcBcc(true); }} disabled={mutationBusy} className="text-xs text-violet-400 hover:text-violet-300 disabled:cursor-wait disabled:opacity-50">CC/BCC</button>
              )}
            </div>
            <input ref={toInputRef} id="compose-desktop-to" value={to} onChange={(e) => setTo(e.target.value)} disabled={mutationBusy} placeholder="recipient@example.com" aria-label="To" className={inputClasses} />
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
                  <label htmlFor="compose-desktop-cc" className="text-xs text-slate-400 mb-1 block">CC</label>
                  <input id="compose-desktop-cc" value={cc} onChange={(e) => setCc(e.target.value)} disabled={mutationBusy} placeholder="cc@example.com" aria-label="CC" className={inputClasses} />
                </div>
                <div>
                  <label htmlFor="compose-desktop-bcc" className="text-xs text-slate-400 mb-1 block">BCC</label>
                  <input id="compose-desktop-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} disabled={mutationBusy} placeholder="bcc@example.com" aria-label="BCC" className={inputClasses} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label htmlFor="compose-desktop-subject" className="text-xs text-slate-400 mb-1 block">Subject</label>
            <input id="compose-desktop-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={mutationBusy} placeholder="Subject" aria-label="Subject" className={inputClasses} />
          </div>

          <div>
            <label htmlFor="compose-desktop-message" className="text-xs text-slate-400 mb-1 block">Message</label>
            <div className={`relative rounded-xl transition-colors ${isDragging ? 'ring-2 ring-violet-500/50' : ''}`}>
              <textarea
                id="compose-desktop-message"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={mutationBusy}
                rows={8}
                placeholder={mode === 'forward' ? 'Add a message (optional)…' : 'Write your message…'}
                aria-label="Message"
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
                  <button type="button" onClick={() => removeAttachment(att.id)} disabled={mutationBusy} aria-label={`Remove ${att.file.name}`} className="p-0.5 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 ml-1"><X size={10} /></button>
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

          {(error || (!showSignatureEditor && signatureError)) && (
            <div className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle size={12} /> {error || signatureError}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">From: {selfEmail}</span>
            <input ref={fileInputRef} type="file" multiple disabled={mutationBusy} aria-label="Attach files" className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" onClick={() => { if (!mutationAdmissionRef.current) fileInputRef.current?.click(); }} disabled={mutationBusy} aria-label="Attach files" className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:cursor-wait disabled:opacity-50 transition-colors" title="Attach files">
              <Paperclip size={14} />
            </button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={handleRequestClose} disabled={mutationBusy} className="px-3 py-1.5 text-xs rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 disabled:cursor-wait disabled:opacity-50 transition-colors">Cancel</button>
            <button
              type="submit"
              disabled={mutationBusy}
              aria-busy={sending}
              aria-label={sending ? 'Sending message' : 'Send message'}
              className="px-4 py-1.5 text-xs rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-medium disabled:opacity-50 flex items-center gap-1.5 transition-colors shadow-lg shadow-violet-600/20"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </motion.form>
    </ViewportModal>
  );
}
