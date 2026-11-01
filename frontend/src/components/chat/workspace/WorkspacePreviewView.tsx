import { Suspense, useEffect, useMemo, useState } from 'react';
import { lazyWithRecovery } from '../../../utils/moduleRecovery';
import { Check, Copy, Download, Eye, EyeOff, ExternalLink, Loader2 } from 'lucide-react';
import client from '../../../api/client';
import type { WorkspacePreview } from '../../../stores/agentWorkspaceStore';
import MarkdownRenderer, { buildPreviewDocument } from '../MarkdownRenderer';
import MermaidDiagram from '../MermaidDiagram';
import { useOwnedWidgetDocument, WidgetFrame } from '../richContent/WidgetFrame';

const PdfViewer = lazyWithRecovery(() => import('../../projects/ProjectPdfViewer'));
const button = 'inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/[0.08] hover:text-white';
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|csv))/i;

function CodePreview({ preview }: { preview: Extract<WorkspacePreview, { kind: 'code' }> }) {
  const document = useMemo(() => buildPreviewDocument(preview.code, preview.language), [preview.code, preview.language]);
  const [rendered, setRendered] = useState(Boolean(document) && ['html', 'svg'].includes(preview.language));
  const [copied, setCopied] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([preview.code], { type: 'text/plain;charset=utf-8' }));
    const link = window.document.createElement('a');
    link.href = url; link.download = `${(preview.title || 'snippet').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'snippet'}.${/^[a-z0-9]{1,12}$/.test(preview.language) ? preview.language : 'txt'}`;
    window.document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-3 py-2">
      <span className="mr-auto text-[10px] font-semibold uppercase tracking-wider text-slate-400">{preview.language || 'code'}</span>
      {document && <button type="button" className={button} onClick={() => setRendered((value) => !value)}>{rendered ? <EyeOff size={12} /> : <Eye size={12} />}{rendered ? 'Code' : 'Preview'}</button>}
      <button type="button" className={button} onClick={download}><Download size={12} />Download</button>
      <button type="button" className={button} onClick={() => void navigator.clipboard.writeText(preview.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined)}>
        {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</button>
    </div>
    {rendered && document
      // Same opaque-origin preview sandbox as the in-chat code block.
      ? <iframe title={`${preview.title} preview`} sandbox="allow-scripts" srcDoc={document} className="min-h-0 w-full flex-1 border-0 bg-white" />
      : <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-[12px] leading-relaxed text-slate-200">{preview.code}</pre>}
  </div>;
}

function FilePreview({ preview }: { preview: Extract<WorkspacePreview, { kind: 'file' }> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; id?: string; mime?: string; name?: string; text?: string }>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    const fileId = /^\/api\/files\/([^/?#\s]+)/.exec(preview.href)?.[1];
    const query = preview.href.startsWith('/files?') ? new URLSearchParams(preview.href.slice(7)) : null;
    let params: Record<string, string | undefined>;
    try { params = fileId ? { id: decodeURIComponent(fileId) } : { id: query?.get('fileId') || undefined, path: query?.get('path') || undefined }; }
    catch { setState({ status: 'error' }); return; }
    setState({ status: 'loading' });
    // The owner-scoped resolve route decides access; a link in chat grants nothing.
    void client.get('/files/resolve', { params, _silent: true } as any).then(async ({ data }) => {
      const mime = String(data?.mimeType || '');
      const id = String(data?.id || '');
      if (!id) throw new Error('missing');
      let text: string | undefined;
      if (TEXT_TYPES.test(mime) && Number(data?.size || 0) <= 2 * 1024 * 1024) {
        text = (await client.get(`/files/${encodeURIComponent(id)}/content`, { responseType: 'text', _silent: true } as any)).data;
      }
      if (active) setState({ status: 'ready', id, mime, name: String(data?.originalName || preview.title), text: typeof text === 'string' ? text : undefined });
    }).catch(() => { if (active) setState({ status: 'error' }); });
    return () => { active = false; };
  }, [preview.href, preview.title]);
  if (state.status === 'loading') return <p role="status" className="flex items-center gap-2 p-4 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" />Opening file…</p>;
  if (state.status === 'error' || !state.id) return <p className="p-4 text-sm text-amber-300">This file could not be opened here. It may have moved or you may not have access.</p>;
  const content = `/api/files/${encodeURIComponent(state.id)}/content`;
  const body = state.text !== undefined
    ? (/markdown/.test(state.mime || '') || /\.md$/i.test(state.name || '')
      ? <div className="min-h-0 flex-1 overflow-auto p-4"><MarkdownRenderer content={state.text} /></div>
      : <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-[12px] text-slate-200">{state.text}</pre>)
    : /^image\//.test(state.mime || '') ? <div className="min-h-0 flex-1 overflow-auto p-3"><img src={content} alt={state.name} className="max-w-full" /></div>
    : state.mime === 'application/pdf' ? <div className="min-h-0 flex-1 overflow-auto"><Suspense fallback={<p role="status" className="p-4 text-sm text-slate-400">Opening PDF…</p>}><PdfViewer src={content} /></Suspense></div>
    : <p className="p-4 text-sm text-slate-400">This file type has no preview. Use Open to download or view it.</p>;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={state.name}>{state.name}</span>
      <a className={button} href={content} target="_blank" rel="noopener noreferrer">Open<ExternalLink size={12} /></a>
    </div>
    {body}
  </div>;
}

/** A chat widget opened beside the chat, read through the owner-checked document route. */
export function WidgetPreview({ provider, session, toolCallId, title, boardName }: {
  provider: string; session: string; toolCallId: string; title: string; boardName?: string;
}) {
  const document = useOwnedWidgetDocument(provider, session, toolCallId, true, boardName);
  const [frameError, setFrameError] = useState('');
  useEffect(() => { setFrameError(''); }, [document.html]);
  if (document.status === 'error' || frameError) return <div role="alert" className="flex items-center gap-2 p-3 text-sm text-amber-400"><span className="flex-1">{frameError || document.message}</span>
    <button type="button" className={button} onClick={() => { setFrameError(''); document.retry(); }}>Retry</button></div>;
  if (!document.html) return <p role="status" className="p-3 text-sm text-slate-400">Loading interactive widget…</p>;
  return <WidgetFrame html={document.html} title={title} onState={(next, message) => { if (next === 'error') setFrameError(message || 'Widget unavailable.'); }} />;
}

export default function WorkspacePreviewView({ preview }: { preview: WorkspacePreview }) {
  if (preview.kind === 'code') return <CodePreview preview={preview} />;
  if (preview.kind === 'mermaid') return <div className="h-full overflow-auto p-3"><MermaidDiagram source={preview.source} /></div>;
  if (preview.kind === 'markdown') return <div className="h-full overflow-auto p-4"><MarkdownRenderer content={preview.markdown} /></div>;
  if (preview.kind === 'file') return <FilePreview preview={preview} />;
  return <div className="h-full overflow-auto p-3"><WidgetPreview provider={preview.provider} session={preview.session} toolCallId={preview.toolCallId} title={preview.title} boardName={preview.boardName} /></div>;
}
