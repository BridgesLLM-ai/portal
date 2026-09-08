import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ExternalLink, Eye, FileCode2, FolderOpen, GitBranch, Loader2, Play, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import { useAuthStore } from '../../contexts/AuthContext';
import { buildProjectDeepLink, isValidProjectRelativePath } from '../../utils/projectSurface';
import MarkdownRenderer from './MarkdownRenderer';
import type { WorkCard } from './ProjectWork';

interface FileEntry {
  name?: string;
  path: string;
  type?: 'file' | 'directory';
  size?: number | null;
  modifiedAt?: string | null;
  gitStatus?: string;
  status?: string;
  added?: number | null;
  removed?: number | null;
  binary?: boolean;
  unavailable?: boolean;
}
interface GitState { branch?: string; ahead?: number; behind?: number; files?: FileEntry[]; detailsUnavailable?: boolean }
type PreviewKind = 'text' | 'markdown' | 'image' | 'audio' | 'diff';
const options = { _silent: true, _skipNetworkRetry: true } as any;
const problem = (error: any) => error?.response?.data?.error || error?.message || 'Could not load project files.';
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const audioExtensions = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
function previewKind(path: string): PreviewKind {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (imageExtensions.has(ext)) return 'image';
  if (audioExtensions.has(ext)) return 'audio';
  return ['md', 'markdown', 'mdown'].includes(ext) ? 'markdown' : 'text';
}
function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function FileMetadata({ entry, changed }: { entry: FileEntry; changed: boolean }) {
  const modified = entry.modifiedAt ? new Date(entry.modifiedAt) : null;
  return <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5 text-slate-400">
    {typeof entry.size === 'number' && <span title={`${entry.size.toLocaleString()} bytes`}>{fileSize(entry.size)}</span>}
    {modified && !Number.isNaN(modified.getTime()) && <time dateTime={entry.modifiedAt!} title={modified.toLocaleString()}>Modified {modified.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>}
    {entry.binary ? <span>Binary file</span> : typeof entry.added === 'number' && typeof entry.removed === 'number' ? <span className="inline-flex gap-2 font-mono" aria-label={`${entry.added} lines added, ${entry.removed} lines removed`}><span className="text-emerald-300">+{entry.added}</span><span className="text-rose-300">−{entry.removed}</span></span> : changed && <span>Line counts unavailable</span>}
    {entry.unavailable && <span className="text-amber-200">File unavailable</span>}
  </div>;
}

export default function ProjectWorkFiles({ card, active = false, hasGit = false }: { card: WorkCard; active?: boolean; hasGit?: boolean }) {
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const [path, setPath] = useState('');
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [git, setGit] = useState<GitState | null>(null);
  const [preview, setPreview] = useState<{ path: string; kind: PreviewKind } | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestVersion = useRef(0);
  const base = `/project-work/${encodeURIComponent(card.id)}`;
  useEffect(() => {
    const abort = new AbortController(); let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return; busy = true;
      try {
        const reads = await Promise.allSettled([
          client.get(`${base}/files`, { ...options, signal: abort.signal, params: { path } }),
          hasGit ? client.get(`${base}/git-status`, { ...options, signal: abort.signal }) : Promise.resolve(null),
        ]);
        if (abort.signal.aborted) return;
        const errors: string[] = [];
        if (reads[0].status === 'fulfilled') setEntries(reads[0].value?.data.tree || []);
        else errors.push(problem(reads[0].reason));
        if (reads[1].status === 'fulfilled') setGit(reads[1].value?.data || null);
        else { setGit(null); errors.push(problem(reads[1].reason)); }
        setError(errors.join(' · ') || null);
      } finally { if (!abort.signal.aborted) setLoading(false); busy = false; }
    };
    setLoading(true); setEntries([]); setGit(null);
    void refresh(); const timer = active ? window.setInterval(() => { void refresh(); }, 5000) : undefined;
    return () => { abort.abort(); if (timer) clearInterval(timer); requestVersion.current++; };
  }, [base, path, active, hasGit, refreshKey]);
  const merged = entries.map(entry => {
    const change = git?.files?.find(file => file.path === entry.path);
    return { ...entry, ...change, gitStatus: change?.status || entry.gitStatus };
  });
  const previewEntry = preview ? merged.find(e => e.path === preview.path) || git?.files?.find(e => e.path === preview.path) : null;
  const previewRevision = previewEntry?.modifiedAt || '';
  useEffect(() => {
    const version = ++requestVersion.current;
    const abort = new AbortController();
    setContent(null); setPreviewError(null);
    if (preview && !['audio', 'image'].includes(preview.kind)) {
      void client.get(`${base}/${preview.kind === 'diff' ? 'diff' : 'file'}`, { ...options, signal: abort.signal, params: { path: preview.path } })
        .then(({ data }) => { if (!abort.signal.aborted && requestVersion.current === version) setContent(preview.kind === 'diff' ? data.output || 'No text diff is available.' : data.content); })
        .catch(err => { if (!abort.signal.aborted && requestVersion.current === version) setPreviewError(problem(err)); });
    }
    return () => { abort.abort(); };
  }, [base, preview?.path, preview?.kind, previewRevision, refreshKey]);
  const openProjectFile = (event: React.MouseEvent<HTMLAnchorElement>, name: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!user || !card.scopeValid) return;
    try {
      navigate(buildProjectDeepLink(card.projectName, name, { actorUserId: user.id, authorizationVersion: user.authorizationVersion ?? 1 }));
    } catch { setError('This file cannot be opened in Projects. Refresh the workspace.'); }
  };
  const link = (name: string, label: string) => <a href="/projects" onClick={event => openProjectFile(event, name)} title={`Open ${name} in Projects`} className="min-w-0 break-all font-medium text-slate-200 decoration-[var(--accent-light)] underline-offset-4 hover:text-[var(--accent-light)] hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-[var(--accent-light)]">{label}</a>;
  const rows = tab === 'changes' ? git?.files || [] : merged;
  const mediaUrl = preview ? `${String(client.defaults?.baseURL || '/api').replace(/\/$/, '')}${base}/raw?${new URLSearchParams({ path: preview.path, v: previewRevision })}` : '';
  return <div className="px-4 pb-4 pt-2">
    <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-white/5 pb-2">{(['files', 'changes'] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setPreview(null); }} className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${tab === value ? 'bg-[var(--accent-bg)] text-[var(--accent-light)]' : 'text-slate-400 hover:bg-white/5'}`}>{value === 'files' ? <FileCode2 size={14}/> : <GitBranch size={14}/>} {value === 'files' ? 'Files' : 'Changes'}</button>)}<span className="ml-auto text-[10px] text-slate-500">{active ? 'Updates while you work' : 'Current working tree'}</span><button type="button" aria-label="Refresh project files" onClick={() => setRefreshKey(key => key + 1)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5"><RefreshCw size={14}/></button></div>
    {error && <p role="alert" className="mb-3 rounded-xl bg-amber-300/5 p-3 text-xs text-amber-200">{error} · The last displayed state may be out of date.</p>}
    {git?.detailsUnavailable && <p role="status" className="mb-3 text-xs text-amber-200">Git line counts are temporarily unavailable.</p>}
    {preview ? <div>
      <button type="button" onClick={() => setPreview(null)} className="mb-3 text-xs text-[var(--accent-light)]">← Back to {tab}</button>
      <header className="mb-3 rounded-xl border border-white/5 bg-white/[0.025] p-3"><div className="flex items-center gap-2 text-sm">{link(preview.path, preview.path)}<ExternalLink size={12} className="shrink-0 text-slate-500"/></div>{previewEntry && <FileMetadata entry={previewEntry} changed={Boolean(previewEntry.status || previewEntry.gitStatus)}/>}</header>
      {previewError ? <p role="alert" className="text-sm text-amber-200">{previewError}</p>
        : preview.kind === 'audio' ? <audio key={mediaUrl} aria-label={`Play ${preview.path}`} controls autoPlay preload="metadata" src={mediaUrl} className="w-full" onError={() => setPreviewError('Audio could not be loaded. Open the file in Projects to inspect it.')}/>
        : preview.kind === 'image' ? <div className="flex justify-center rounded-xl bg-black/20 p-3"><img key={mediaUrl} src={mediaUrl} alt={preview.path} className="max-h-64 max-w-full rounded-lg object-contain" onError={() => setPreviewError('Image could not be loaded. Open the file in Projects to inspect it.')}/></div>
        : content === null ? <Loader2 className="animate-spin text-[var(--accent-light)]" size={20}/>
        : preview.kind === 'markdown' ? <div className="max-h-72 overflow-auto rounded-xl border border-white/5 bg-white/[0.025] p-4 text-sm text-slate-200"><MarkdownRenderer content={content} isStreaming={false} hostFileContext={{ source: 'project', project: card.projectName }}/></div>
        : <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/20 p-3 text-xs text-slate-200">{content}</pre>}
    </div> : loading ? <Loader2 className="animate-spin text-[var(--accent-light)]" size={20}/>
      : tab === 'changes' && !hasGit ? <p className="py-5 text-sm text-slate-400">Git isn’t initialized for this project.</p> : <>
        {tab === 'changes' ? <p className="mb-3 text-xs text-slate-400">{git?.branch || 'Git'} · {git?.ahead || 0} ahead · {git?.behind || 0} behind. Compared with the last commit; may include earlier work.</p>
          : <button type="button" disabled={!path} onClick={() => { setPreview(null); setPath(path.split('/').slice(0,-1).join('/')); }} className="mb-2 text-xs text-[var(--accent-light)] disabled:text-slate-500">{path ? `← ${path}` : 'Project root'}</button>}
        {rows.filter(entry => isValidProjectRelativePath(entry.path)).map(entry => {
          const kind = previewKind(entry.path);
          const status = entry.status || entry.gitStatus;
          const deleted = status === 'deleted';
          return <div key={entry.path} className="flex items-start gap-3 border-b border-white/5 py-3 text-sm">
            {entry.type === 'directory' ? <FolderOpen size={16} className="mt-1 shrink-0 text-[var(--accent-light)]"/> : <FileCode2 size={16} className="mt-1 shrink-0 text-slate-500"/>}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">{entry.type === 'directory' ? <button type="button" onClick={() => setPath(entry.path)} className="break-all text-left font-medium text-slate-200 hover:text-[var(--accent-light)]">{entry.name || entry.path}</button> : deleted || entry.unavailable ? <span className="break-all text-slate-400">{entry.name || entry.path}</span> : link(entry.path, entry.name || entry.path)}{status && <span className="rounded-md bg-amber-300/10 px-2 py-0.5 text-[10px] text-amber-200">{status}</span>}</div>
              {entry.type !== 'directory' && <FileMetadata entry={entry} changed={Boolean(status)}/>}
            </div>
            {entry.type === 'directory' ? <button type="button" aria-label={`Open folder ${entry.name || entry.path}`} onClick={() => setPath(entry.path)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5"><ChevronRight size={14}/></button> : <div className="flex shrink-0 flex-wrap gap-1">
              {!deleted && !entry.unavailable && <button type="button" aria-label={`${kind === 'audio' ? 'Play' : 'Preview'} ${entry.path}`} title={kind === 'audio' ? 'Play audio' : 'Preview file'} onClick={() => setPreview({ path: entry.path, kind })} className="rounded-lg border border-white/5 bg-white/[0.025] p-2 text-[var(--accent-light)] hover:bg-[var(--accent-bg)]">{kind === 'audio' ? <Play size={15}/> : <Eye size={15}/>}</button>}
              {status && hasGit && !entry.binary && <button type="button" aria-label={`View diff for ${entry.path}`} title="View diff" onClick={() => setPreview({ path: entry.path, kind: 'diff' })} className="rounded-lg border border-white/5 p-2 text-slate-400 hover:bg-white/5"><GitBranch size={15}/></button>}
            </div>}
          </div>;
        })}
        {!rows.length && <p className="py-5 text-sm text-slate-400">{tab === 'changes' ? 'No uncommitted changes.' : 'This folder is empty.'}</p>}
      </>}
  </div>;
}
