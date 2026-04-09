import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import Editor from '@monaco-editor/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { projectsAPI, aiAPI, alertsAPI } from '../api/endpoints';
import { extractError, logError } from '../utils/errorHelpers';
import ConfirmDialog from '../components/ConfirmDialog';
import ProjectChatPanel from '../components/chat/ProjectChatPanel';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileOverflowMenu, { MenuAction } from '../components/mobile/MobileOverflowMenu';
import sounds from '../utils/sounds';
import { ProgressNotification, ProgressNotificationProps } from '../components/shared/ProgressNotification';
import {
  Rocket, Play, Plus, Trash2, X, Loader2, FolderOpen, FileText, FileCode,
  GitBranch, GitCommit, Upload, ChevronRight, ChevronDown,
  Save, Eye, RefreshCw, Bot, Send, Globe, Copy, Check,
  FolderPlus, FilePlus, ExternalLink, Share2, Link, Clock,
  Undo2, ArrowUp, ArrowDown, Circle, Download,
  Diff, History, Maximize2, Minimize2, Search,
  Activity, FileQuestion, Zap, AlertCircle, CheckCircle,
  PanelLeftClose, PanelLeft, Command, Lock, Shield, Edit3,
  Image, Film, Music, Volume2, ZoomIn, ZoomOut, RotateCw, Mic, MicOff, Bell, GripVertical, Move, Mail, SendHorizonal
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// --- Types ---
interface TreeEntry { name: string; type: 'file' | 'directory'; path: string; size?: number; gitStatus?: string; }
interface Project { name: string; hasGit: boolean; currentBranch: string; deployedUrl: string; createdAt: string; updatedAt: string; }
interface GitFile { path: string; status: string; raw: string; }
interface CommitEntry { hash: string; short: string; author: string; email: string; date: string; message: string; }
interface Branch { name: string; current: boolean; remote: boolean; }
interface EnhancedCommit {
  hash: string; short: string; author: string; email: string; date: string; relativeDate: string;
  message: string; refs: string; parentHash?: string;
  stats: { filesChanged: number; insertions: number; deletions: number; files: Array<{ path: string; additions: number; deletions: number }> };
}
interface ShareLink { id: string; token: string; isActive: boolean; isPublic: boolean; currentUses: number; maxUses: number | null; expiresAt: string | null; createdAt: string; }
interface ActivityEntry { id: string; action: string; resource: string; resourceId?: string; severity: string; createdAt: string; }

// --- Helpers ---
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'sh', 'rb', 'php', 'java', 'c', 'cpp'].includes(ext || '')) return FileCode;
  return FileText;
}

function gitStatusColor(status?: string) {
  if (!status) return '';
  if (status === 'untracked' || status === 'added') return 'text-green-400';
  if (status === 'modified') return 'text-amber-400';
  if (status === 'deleted') return 'text-red-400';
  if (status === 'renamed') return 'text-blue-400';
  return 'text-slate-400';
}

function gitStatusIcon(status?: string) {
  if (!status) return null;
  const map: Record<string, string> = { untracked: 'U', added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
  return map[status] || '?';
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function activityIcon(action: string) {
  if (action.includes('DEPLOY')) return <Rocket size={12} className="text-emerald-400" />;
  if (action.includes('COMMIT') || action.includes('GIT')) return <GitCommit size={12} className="text-orange-400" />;
  if (action.includes('CREATE')) return <Plus size={12} className="text-blue-400" />;
  if (action.includes('DELETE')) return <Trash2 size={12} className="text-red-400" />;
  if (action.includes('UPLOAD')) return <Upload size={12} className="text-cyan-400" />;
  return <Activity size={12} className="text-slate-400" />;
}

function activityLabel(action: string) {
  const map: Record<string, string> = {
    PROJECT_CREATE: 'Project created',
    PROJECT_DEPLOY: 'Deployed',
    PROJECT_UPLOAD_ZIP: 'ZIP uploaded',
    PROJECT_FILE_UPLOAD: 'Files uploaded',
    PROJECT_DELETE: 'Deleted',
    APP_UPLOAD: 'App uploaded',
    APP_DELETE: 'App deleted',
  };
  return map[action] || action.replace(/_/g, ' ').toLowerCase();
}

// --- Media file type detection ---
type FileCategory = 'code' | 'image' | 'video' | 'audio' | 'pdf' | 'excel' | 'binary' | 'text';

function getFileCategory(filename: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  const binaryExts = ['woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite'];
  if (binaryExts.includes(ext)) return 'binary';
  return 'code';
}

function getProjectRawUrl(projectName: string, filePath: string, options?: { mode?: 'text' }): string {
  const apiUrl = import.meta.env.VITE_API_URL || '';
  const params = new URLSearchParams({ path: filePath });
  if (options?.mode) params.set('mode', options.mode);
  return `${apiUrl}/projects/${encodeURIComponent(projectName)}/raw?${params.toString()}`;
}

// --- Inline Media Viewers for Projects ---
function ProjectImageViewer({ src, name }: { src: string; name: string }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.1, Math.min(10, z + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    setDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  }, [zoom, position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const resetView = () => { setZoom(1); setPosition({ x: 0, y: 0 }); };

  if (error) return (
    <div className="flex-1 flex items-center justify-center text-slate-500">
      <div className="text-center">
        <AlertCircle size={48} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm">Failed to load image</p>
        <a href={src} download className="text-xs text-emerald-400 hover:text-emerald-300 mt-2 inline-block">Download instead</a>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="flex items-center justify-center gap-1 py-1.5 border-b border-white/5 bg-black/20 flex-shrink-0">
        <button onClick={() => setZoom(z => Math.max(0.1, z - 0.25))} className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white"><ZoomOut size={14} /></button>
        <span className="text-[10px] text-slate-500 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(10, z + 0.25))} className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white"><ZoomIn size={14} /></button>
        <div className="w-px h-3 bg-white/10 mx-1" />
        <button onClick={resetView} className="px-2 py-1 text-[10px] rounded hover:bg-white/10 text-slate-400 hover:text-white">Reset</button>
        <div className="w-px h-3 bg-white/10 mx-1" />
        <a href={src} download className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-emerald-400"><Download size={14} /></a>
      </div>
      {/* Image */}
      <div
        className="flex-1 overflow-hidden flex items-center justify-center bg-[#0a0a0f] cursor-grab active:cursor-grabbing select-none"
        style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'20\' height=\'20\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Crect width=\'10\' height=\'10\' fill=\'%23111\'/%3E%3Crect x=\'10\' y=\'10\' width=\'10\' height=\'10\' fill=\'%23111\'/%3E%3Crect x=\'10\' width=\'10\' height=\'10\' fill=\'%230d0d0d\'/%3E%3Crect y=\'10\' width=\'10\' height=\'10\' fill=\'%230d0d0d\'/%3E%3C/svg%3E")' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={() => zoom === 1 ? setZoom(2) : resetView()}
      >
        {!loaded && !error && <Loader2 size={24} className="animate-spin text-slate-600 absolute" />}
        <img
          src={src}
          alt={name}
          className="max-w-none transition-transform duration-100"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
            maxWidth: zoom <= 1 ? '100%' : 'none',
            maxHeight: zoom <= 1 ? '100%' : 'none',
            opacity: loaded ? 1 : 0,
          }}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      </div>
    </div>
  );
}

function ProjectAudioViewer({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 bg-[#0a0a0f]">
      <div className="w-28 h-28 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center">
        <Volume2 size={44} className="text-purple-400" />
      </div>
      <div className="text-center">
        <p className="font-medium text-sm text-white">{name}</p>
      </div>
      <audio src={src} controls autoPlay className="w-full max-w-md" />
      <a href={src} download className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"><Download size={12} /> Download</a>
    </div>
  );
}

function ProjectVideoViewer({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-black p-4">
      <video
        src={src}
        controls
        autoPlay
        className="max-w-full max-h-full rounded-lg"
        style={{ outline: 'none' }}
      />
    </div>
  );
}

function ProjectPdfViewer({ src }: { src: string }) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<{ data: Uint8Array } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buf => { if (!cancelled) setPdfData({ data: new Uint8Array(buf) }); })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load PDF'); });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(containerRef.current);
    setContainerWidth(containerRef.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!pdfData && !error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-slate-500" />
        <span className="ml-2 text-sm text-slate-500">Loading PDF…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <AlertCircle size={24} className="text-red-400" />
        <span className="text-red-400 text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-[#2a2a2a]">
      <Document
        file={pdfData}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={(err) => setError(err.message || 'Failed to render PDF')}
        loading={
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-slate-500" />
            <span className="ml-2 text-sm text-slate-500">Rendering pages…</span>
          </div>
        }
      >
        {numPages > 0 && Array.from({ length: numPages }, (_, i) => (
          <div key={i} className="flex justify-center py-2">
            <Page
              pageNumber={i + 1}
              width={Math.min(containerWidth - 32, 1200)}
              renderTextLayer={true}
              renderAnnotationLayer={true}
            />
          </div>
        ))}
      </Document>
      {numPages > 0 && (
        <div className="sticky bottom-0 text-center py-2 bg-[#2a2a2a]/90 backdrop-blur-sm text-xs text-slate-500">
          {numPages} page{numPages !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

function ProjectTextPreviewViewer({ src, name }: { src: string; name: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {!loaded && !error && (
        <div className="flex-1 flex items-center justify-center gap-3 bg-[#0a0e1a] text-slate-400">
          <Loader2 size={22} className="animate-spin" />
          <div className="text-sm">
            <div className="text-slate-200">Loading preview…</div>
            <div className="text-xs text-slate-500">This file is too large for inline editing, so it is opening read-only.</div>
          </div>
        </div>
      )}
      {error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-[#0a0e1a] text-slate-400">
          <AlertCircle size={24} className="text-red-400" />
          <div className="text-center">
            <div className="text-sm text-slate-200">Could not load text preview</div>
            <div className="text-xs text-slate-500">Try downloading {name} instead.</div>
          </div>
          <a href={src} download className="px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 inline-flex items-center gap-2">
            <Download size={14} /> Download
          </a>
        </div>
      ) : (
        <iframe
          title={`${name} preview`}
          src={src}
          className={`flex-1 w-full border-0 ${loaded ? 'block' : 'hidden'}`}
          onLoad={() => setLoaded(true)}
          onError={() => { setError(true); setLoaded(false); }}
        />
      )}
    </div>
  );
}

function ProjectBinaryViewer({ name, src }: { name: string; src: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-slate-500">
      <div className="text-center">
        <FileQuestion size={48} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm font-medium text-slate-300 mb-1">{name}</p>
        <p className="text-xs mb-4">Binary file — cannot be previewed</p>
        <a href={src} download className="px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 inline-flex items-center gap-2">
          <Download size={14} /> Download
        </a>
      </div>
    </div>
  );
}

// ─── Excel parsing (direct import, no worker) ──────────────
import * as XLSX from 'xlsx';

const APPS_INITIAL_ROWS = 500;
const APPS_LOAD_MORE = 500;

function parseExcelBufferApps(buf: ArrayBuffer, sheetIndex: number, maxRows: number = 5000) {
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetNames = wb.SheetNames;
  const sheet = wb.Sheets[sheetNames[sheetIndex]];
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  const totalRows = range ? range.e.r + 1 : 0;
  if (range && range.e.r >= maxRows) {
    range.e.r = maxRows - 1;
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
  return { sheetNames, data, totalRows, sheetIndex };
}

function ProjectExcelViewer({ src, name }: { src: string; name: string }) {
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [data, setData] = useState<any[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [visibleRows, setVisibleRows] = useState(APPS_INITIAL_ROWS);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [sizeWarningAccepted, setSizeWarningAccepted] = useState(false);
  const bufferRef = useRef<ArrayBuffer | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchFile() {
      try {
        setLoading(true); setError(null);
        const resp = await fetch(src, { credentials: 'include' });
        const buf = await resp.arrayBuffer();
        if (cancelled) return;
        setFileSize(buf.byteLength);
        if (buf.byteLength > 20 * 1024 * 1024) {
          setError(`File is too large (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB). Please download it instead.`);
          setLoading(false); return;
        }
        bufferRef.current = buf;
        if (buf.byteLength > 5 * 1024 * 1024 && !sizeWarningAccepted) { setLoading(false); return; }
        parseSheet(buf, 0);
      } catch (e: any) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    }
    fetchFile();
    return () => { cancelled = true; };
  }, [src, sizeWarningAccepted]);

  function parseSheet(buf: ArrayBuffer, sheetIndex: number) {
    setParsing(true); setError(null); setVisibleRows(APPS_INITIAL_ROWS);
    try {
      const result = parseExcelBufferApps(buf, sheetIndex, 5000);
      setSheetNames(result.sheetNames); setData(result.data);
      setTotalRows(result.totalRows); setActiveSheet(result.sheetIndex);
    } catch (err: any) {
      setError(err.message || 'Failed to parse Excel file');
    } finally {
      setParsing(false); setLoading(false);
    }
  }

  function handleSheetChange(i: number) {
    if (bufferRef.current && i !== activeSheet) parseSheet(bufferRef.current, i);
  }

  if (!loading && fileSize > 5 * 1024 * 1024 && !sizeWarningAccepted && !error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1e1e1e]">
        <div className="text-center space-y-3 p-6 max-w-sm">
          <AlertCircle size={32} className="text-amber-400 mx-auto" />
          <p className="text-amber-300 text-sm font-medium">Large File Warning</p>
          <p className="text-slate-400 text-xs">This file is {(fileSize / 1024 / 1024).toFixed(1)}MB. Previewing may be slow.</p>
          <button onClick={() => setSizeWarningAccepted(true)}
            className="px-4 py-1.5 text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded hover:bg-amber-500/30 transition-colors">
            Load Preview Anyway
          </button>
        </div>
      </div>
    );
  }

  if (loading || parsing) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2">
      <Loader2 size={24} className="animate-spin text-slate-500" />
      <span className="text-xs text-slate-500">{parsing ? 'Parsing spreadsheet…' : 'Loading file…'}</span>
    </div>
  );
  if (error) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
      <AlertCircle size={20} className="text-red-400" />
      <span className="text-red-400 text-sm">{error}</span>
    </div>
  );

  const displayData = data.slice(0, visibleRows + 1);
  const hasMore = data.length > visibleRows + 1 || totalRows > data.length;

  return (
    <div className="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 border-b border-white/5 bg-black/20 text-[10px] text-slate-500 shrink-0">
        <span>{totalRows.toLocaleString()} rows · {sheetNames.length} sheet{sheetNames.length !== 1 ? 's' : ''}</span>
        {totalRows > APPS_INITIAL_ROWS && <span className="text-amber-400/70">Showing first {Math.min(visibleRows, data.length - 1).toLocaleString()} rows</span>}
      </div>
      {sheetNames.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-white/5 bg-black/30 overflow-x-auto shrink-0">
          {sheetNames.map((sn, i) => (
            <button key={sn} onClick={() => handleSheetChange(i)}
              className={`px-3 py-1 text-xs rounded transition-colors whitespace-nowrap ${i === activeSheet ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:bg-white/10 hover:text-white'}`}>
              {sn}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {displayData.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">Empty sheet</div>
        ) : (
          <>
            <table className="w-full text-xs text-slate-300 border-collapse">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="bg-[#2a2a2a] border border-white/10 px-2 py-1.5 text-slate-500 font-normal text-center w-10">#</th>
                  {(displayData[0] || []).map((_: any, ci: number) => (
                    <th key={ci} className="bg-[#2a2a2a] border border-white/10 px-3 py-1.5 text-left font-semibold text-slate-200 whitespace-nowrap">
                      {String(displayData[0][ci] ?? '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayData.slice(1).map((row, ri) => (
                  <tr key={ri} className="hover:bg-white/[0.03]">
                    <td className="bg-[#252525] border border-white/10 px-2 py-1 text-slate-500 text-center tabular-nums">{ri + 2}</td>
                    {(displayData[0] || []).map((_: any, ci: number) => (
                      <td key={ci} className="border border-white/10 px-3 py-1 whitespace-nowrap">{String(row[ci] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {hasMore && (
              <div className="flex items-center justify-center py-3 border-t border-white/5">
                <button onClick={() => setVisibleRows(v => v + APPS_LOAD_MORE)}
                  className="px-4 py-1.5 text-xs bg-white/5 text-slate-400 rounded hover:bg-white/10 hover:text-white transition-colors">
                  Load more rows
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Agent Chat Helpers ---
function getToolEmoji(toolName: string): string {
  const t = toolName.toLowerCase().replace(/_/g, '');
  if (t.includes('search') || t.includes('web')) return '🔍';
  if (t.includes('read') || t.includes('file') || t.includes('cat')) return '📄';
  if (t.includes('write') || t.includes('save') || t.includes('create')) return '✏️';
  if (t.includes('edit') || t.includes('patch') || t.includes('replace')) return '🔧';
  if (t.includes('exec') || t.includes('run') || t.includes('shell') || t.includes('bash') || t.includes('command')) return '⚡';
  if (t.includes('browser') || t.includes('navigate') || t.includes('screenshot')) return '🌐';
  if (t.includes('image') || t.includes('vision') || t.includes('photo')) return '🖼️';
  if (t.includes('memory') || t.includes('recall')) return '🧠';
  if (t.includes('message') || t.includes('send') || t.includes('notify')) return '💬';
  if (t.includes('fetch') || t.includes('download') || t.includes('curl')) return '📥';
  if (t.includes('git') || t.includes('commit') || t.includes('push')) return '📦';
  if (t.includes('deploy') || t.includes('build')) return '🚀';
  if (t.includes('delete') || t.includes('remove') || t.includes('trash')) return '🗑️';
  if (t.includes('list') || t.includes('ls') || t.includes('dir')) return '📋';
  if (t.includes('think') || t.includes('reason') || t.includes('analyze')) return '💭';
  return '🔧';
}

function parseMessageSections(content: string): { type: 'text' | 'tool' | 'thinking'; content: string }[] {
  const sections: { type: 'text' | 'tool' | 'thinking'; content: string }[] = [];
  const lines = content.split('\n');
  let currentType: 'text' | 'tool' | 'thinking' = 'text';
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text) sections.push({ type: currentType, content: text });
    currentLines = [];
  };

  for (const line of lines) {
    if (/^(🔧|Tool|Running|Executing|tool_call|<tool)/i.test(line.trim())) {
      flush();
      currentType = 'tool';
      currentLines.push(line);
    } else if (/^(🧠|Thinking|<thinking)/i.test(line.trim())) {
      flush();
      currentType = 'thinking';
      currentLines.push(line);
    } else if (currentType !== 'text' && line.trim() === '') {
      flush();
      currentType = 'text';
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ type: 'text', content }];
}

function TruncatableContent({ content, maxHeight = 300 }: { content: string; maxHeight?: number }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsTruncation, setNeedsTruncation] = useState(false);

  useEffect(() => {
    if (contentRef.current && contentRef.current.scrollHeight > maxHeight) {
      setNeedsTruncation(true);
    }
  }, [content, maxHeight]);

  const sections = parseMessageSections(content);

  return (
    <div>
      <div
        ref={contentRef}
        className={!expanded && needsTruncation ? 'overflow-hidden' : ''}
        style={!expanded && needsTruncation ? { maxHeight: `${maxHeight}px` } : undefined}
      >
        {sections.map((section, i) => (
          <div key={i}>
            {sections.length > 1 && i > 0 && (
              <div className="border-t border-white/5 my-1.5" />
            )}
            {section.type === 'tool' && (
              <div className="text-[10px] text-amber-400/60 font-medium mb-0.5">🔧 Tool</div>
            )}
            {section.type === 'thinking' && (
              <div className="text-[10px] text-purple-400/60 font-medium mb-0.5">🧠 Thinking</div>
            )}
            <div className={`text-[11px] whitespace-pre-wrap break-words leading-relaxed ${
              section.type === 'tool' ? 'text-amber-200/80 font-mono text-[10px] pl-2 border-l border-amber-500/20' :
              section.type === 'thinking' ? 'text-purple-200/70 italic text-[10px] pl-2 border-l border-purple-500/20' :
              ''
            }`}>
              {section.content}
            </div>
          </div>
        ))}
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-emerald-400 hover:text-emerald-300 mt-1"
        >
          {expanded ? '▲ Show less' : '▼ Show more...'}
        </button>
      )}
    </div>
  );
}

// --- Main Component ---
export default function AppsPage() {
  // Core state
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, TreeEntry[]>>({});
  const [openFile, setOpenFile] = useState<{ path: string; content: string; language: string } | null>(null);
  const [openMedia, setOpenMedia] = useState<{ path: string; category: FileCategory; url: string; note?: string } | null>(null);
  const [modified, setModified] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<'idle' | 'deploying' | 'success' | 'failed'>('idle');
  const [isRuntimeProject, setIsRuntimeProject] = useState(false);
  const [checkingProject, setCheckingProject] = useState(false);
  
  // Progress notification state for deploy/install flow
  const [progressNotification, setProgressNotification] = useState<ProgressNotificationProps | null>(null);
  const installEventSourceRef = useRef<EventSource | null>(null);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<'template' | 'clone' | 'zip'>('template');
  const [newName, setNewName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [template, setTemplate] = useState('static-html');
  const [creating, setCreating] = useState(false);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipUploading, setZipUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  // Panels
  const [activePanel, setActivePanel] = useState<'git' | 'ai' | 'share' | 'activity' | null>(null);
  const [gitTab, setGitTab] = useState<'changes' | 'log' | 'branches'>('changes');
  const [gitStatus, setGitStatus] = useState<{ branch: string; ahead: number; behind: number; files: GitFile[]; clean: boolean } | null>(null);
  const [commitLog, setCommitLog] = useState<CommitEntry[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [selectedDiff, setSelectedDiff] = useState<{ file?: string; content: string } | null>(null);
  const [commitDiff, setCommitDiff] = useState<{ hash: string; output: string; diff: string } | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  // Enhanced git log
  const [enhancedCommits, setEnhancedCommits] = useState<EnhancedCommit[]>([]);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [diffViewCommit, setDiffViewCommit] = useState<{ hash: string; diff: string } | null>(null);
  const [revertTarget, setRevertTarget] = useState<EnhancedCommit | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertResult, setRevertResult] = useState<{ success: boolean; message: string } | null>(null);
  const [logBranchFilter, setLogBranchFilter] = useState<string>('');

  // AI panel
  const [aiMessage, setAiMessage] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // Agent Chat
  const [agentChatOpen, setAgentChatOpen] = useState(false);
  
  // Title bar path editing
  const [editingPath, setEditingPath] = useState(false);
  const [pathEditValue, setPathEditValue] = useState('');

  // Code analysis
  const [analyzeModel, setAnalyzeModel] = useState<string>('qwen3:4b');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<any[]>([]);
  const [showAnalysisPanel, setShowAnalysisPanel] = useState(false);

  // Share panel
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [shareIsPublic, setShareIsPublic] = useState(true);
  const [sharePassword, setSharePassword] = useState('');
  const [sharePasswordConfirm, setSharePasswordConfirm] = useState('');
  const [confirmPublicId, setConfirmPublicId] = useState<string | null>(null);

  // Activity
  const [activityLogs, setActivityLogs] = useState<ActivityEntry[]>([]);

  // New file/folder
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileIsDir, setNewFileIsDir] = useState(false);

  // File upload dialog
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadDragOver, setUploadDragOver] = useState(false);

  // Inline rename in file tree
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; name: string; type: 'file' | 'directory' } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Fullscreen editor
  const [editorFullscreen, setEditorFullscreen] = useState(false);

  // Sidebar toggle
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // File search
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');

  // Auto-save
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Toast — enhanced with detail/hint support
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info'; detail?: string; hint?: string } | null>(null);
  const [toastExpanded, setToastExpanded] = useState(false);
  const [toastCopied, setToastCopied] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'project' | 'file'; name: string; path?: string } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success', durationOrOpts?: number | { duration?: number; detail?: string; hint?: string }) => {
    const opts = typeof durationOrOpts === 'number' ? { duration: durationOrOpts } : (durationOrOpts || {});
    setToast({ message, type, detail: opts.detail, hint: opts.hint });
    setToastExpanded(false);
    setToastCopied(false);
    const duration = opts.duration || (type === 'error' ? 20000 : 3000);
    setTimeout(() => setToast(null), duration);
    
    // Play appropriate sound
    if (type === 'success') sounds.success();
    else if (type === 'error') sounds.error();
    else if (type === 'info') sounds.notification();
  };

  /** Show error toast from any caught error, with full context */
  const showErrorToast = (err: unknown, context: string) => {
    const extracted = extractError(err, context);
    logError(err, context);
    showToast(extracted.message, 'error', { detail: extracted.detail, hint: extracted.hint });
  };

  // --- Auto-suggest project name from repository URL ---
  useEffect(() => {
    if (cloneUrl && !newName.trim()) {
      // Handle both HTTPS and SSH git URLs
      const match = cloneUrl.match(/(?:\/|:)([^\/]+?)(\.git)?$/);
      if (match) {
        const suggestedName = match[1].replace(/[^a-zA-Z0-9_-]/g, '-');
        setNewName(suggestedName);
      }
    }
  }, [cloneUrl]);

  // --- Data Loading ---
  const loadProjects = useCallback(async () => {
    try {
      const data = await projectsAPI.list();
      setProjects(data.projects || []);
    } catch (err) { showErrorToast(err, 'Loading projects'); } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const selectProject = async (name: string) => {
    setSelectedProject(name);
    setOpenFile(null);
    setOpenMedia(null);
    setModified(false);
    setSelectedDiff(null);
    setCommitDiff(null);
    setDeployStatus('idle');
    setIsRuntimeProject(false);
    try {
      const data = await projectsAPI.getTree(name);
      setTree(data.tree || []);
      setExpandedDirs({});
      
      // Check if this is a runtime project (Python, C++, or Node CLI)
      const fileNames = (data.tree || []).filter((e: TreeEntry) => e.type === 'file').map((e: TreeEntry) => e.name);
      const hasMainPy = fileNames.includes('main.py');
      const hasRequirementsTxt = fileNames.includes('requirements.txt');
      const hasMainCpp = fileNames.includes('main.cpp');
      const hasMakefile = fileNames.includes('Makefile');
      const hasPackageJson = fileNames.includes('package.json');
      const hasIndexHtml = fileNames.includes('index.html');
      
      // Runtime if: Python/C++ without package.json, or Node without start script and without index.html
      if ((hasMainPy || hasRequirementsTxt) && !hasPackageJson) {
        setIsRuntimeProject(true);
      } else if ((hasMainCpp || hasMakefile) && !hasPackageJson && !hasIndexHtml) {
        setIsRuntimeProject(true);
      }
      // Note: Node CLI detection requires checking package.json contents, handled server-side
    } catch (err) { showErrorToast(err, `Loading project "${name}"`); }
  };

  const refreshTree = async () => {
    if (!selectedProject) return;
    try {
      const data = await projectsAPI.getTree(selectedProject);
      setTree(data.tree || []);
      const newExpanded: Record<string, TreeEntry[]> = {};
      for (const dirPath of Object.keys(expandedDirs)) {
        try {
          const d = await projectsAPI.getTree(selectedProject, dirPath);
          newExpanded[dirPath] = d.tree || [];
        } catch (err) { logError(err, `Refreshing subdirectory: ${dirPath}`); }
      }
      setExpandedDirs(newExpanded);
    } catch (err) { logError(err, 'Refreshing file tree'); }
  };

  // Git operations
  const loadGitStatus = async () => {
    if (!selectedProject) return;
    setGitLoading(true);
    try {
      const data = await projectsAPI.git(selectedProject, 'status');
      setGitStatus(data);
    } catch (err) { showErrorToast(err, 'Loading git status'); } finally { setGitLoading(false); }
  };

  const loadCommitLog = async () => {
    if (!selectedProject) return;
    setGitLoading(true);
    try {
      const data = await projectsAPI.gitEnhancedLog(selectedProject, logBranchFilter || undefined);
      setEnhancedCommits(data.commits || []);
      // Also keep basic log for backwards compat
      setCommitLog((data.commits || []).map((c: EnhancedCommit) => ({ hash: c.hash, short: c.short, author: c.author, email: c.email, date: c.date, message: c.message })));
    } catch (err) {
      // Fallback to basic log
      try {
        const data = await projectsAPI.git(selectedProject, 'log');
        setCommitLog(data.commits || []);
        setEnhancedCommits([]);
      } catch (err2) { showErrorToast(err2, 'Loading commit log'); }
    } finally { setGitLoading(false); }
  };

  const loadBranches = async () => {
    if (!selectedProject) return;
    setGitLoading(true);
    try {
      const data = await projectsAPI.git(selectedProject, 'branches');
      setBranches(data.branches || []);
    } catch (err) { showErrorToast(err, 'Loading branches'); } finally { setGitLoading(false); }
  };

  const loadShares = async () => {
    if (!selectedProject) return;
    try {
      const data = await projectsAPI.listShares(selectedProject);
      setShares(data.shares || []);
    } catch (err) { logError(err, 'Loading shares'); }
  };

  const loadActivity = async () => {
    if (!selectedProject) return;
    try {
            const apiUrl = import.meta.env.VITE_API_URL || '';
      const resp = await fetch(`${apiUrl}/projects/${selectedProject}/activity?limit=20`, {
        credentials: 'include',
      });
      if (resp.ok) {
        const data = await resp.json();
        setActivityLogs(data.logs || []);
      }
    } catch (err) { logError(err, 'Loading activity logs'); }
  };

  // Load panel data
  useEffect(() => {
    if (activePanel === 'git' && selectedProject) {
      if (gitTab === 'changes') loadGitStatus();
      else if (gitTab === 'log') { loadCommitLog(); loadBranches(); }
      else if (gitTab === 'branches') loadBranches();
    }
    if (activePanel === 'share' && selectedProject) loadShares();
    if (activePanel === 'activity' && selectedProject) loadActivity();
  }, [activePanel, gitTab, selectedProject]);

  const viewFileDiff = async (filePath: string) => {
    if (!selectedProject) return;
    try {
      const data = await projectsAPI.git(selectedProject, 'diff', { file: filePath });
      setSelectedDiff({ file: filePath, content: data.output || 'No changes' });
    } catch (err) { showErrorToast(err, `Viewing diff for ${filePath}`); }
  };

  const viewCommitDiff = async (hash: string) => {
    if (!selectedProject) return;
    try {
      const data = await projectsAPI.git(selectedProject, 'diff-commit', { hash });
      setCommitDiff({ hash, output: data.output, diff: data.diff });
    } catch (err) { showErrorToast(err, `Viewing commit diff ${hash.substring(0, 7)}`); }
  };

  const handleRevert = async () => {
    if (!selectedProject || !revertTarget) return;
    setReverting(true);
    setRevertResult(null);
    try {
      const data = await projectsAPI.gitRevert(selectedProject, revertTarget.hash);
      setRevertResult({ success: true, message: `Reverted "${revertTarget.message}" — new commit: ${data.newHash?.substring(0, 7)}` });
      setTimeout(() => { setRevertTarget(null); setRevertResult(null); loadCommitLog(); }, 2000);
    } catch (e: any) {
      const msg = e.response?.data?.error || e.message || 'Revert failed';
      setRevertResult({ success: false, message: msg });
    } finally { setReverting(false); }
  };

  // --- File Operations ---
  const toggleDir = async (dirPath: string) => {
    if (expandedDirs[dirPath]) {
      const next = { ...expandedDirs };
      delete next[dirPath];
      setExpandedDirs(next);
    } else {
      try {
        const data = await projectsAPI.getTree(selectedProject!, dirPath);
        setExpandedDirs(prev => ({ ...prev, [dirPath]: data.tree || [] }));
      } catch (err) { logError(err, `Expanding directory: ${dirPath}`); }
    }
  };

  const openFileHandler = async (filePath: string) => {
    if (!selectedProject) return;
    setSelectedDiff(null);
    setCommitDiff(null);
    
    const category = getFileCategory(filePath);
    if (category !== 'code') {
      // Media/binary file — use raw endpoint
      setOpenFile(null);
      setOpenMedia({
        path: filePath,
        category,
        url: getProjectRawUrl(selectedProject, filePath),
      });
      setModified(false);
      return;
    }
    
    // Code/text file — use existing text endpoint
    setOpenMedia(null);
    try {
      const data = await projectsAPI.readFile(selectedProject, filePath);
      setOpenFile({ path: filePath, content: data.content, language: data.language });
      setEditorContent(data.content);
      setModified(false);
    } catch (err: any) {
      const tooLarge = err?.response?.status === 413;
      if (tooLarge) {
        setOpenFile(null);
        setOpenMedia({
          path: filePath,
          category: 'text',
          url: getProjectRawUrl(selectedProject, filePath, { mode: 'text' }),
          note: 'Preview only, this file is larger than the 10MB inline editor limit.',
        });
        setModified(false);
        showToast('Opened in read-only preview mode because the file is larger than 10MB.', 'info');
        return;
      }
      showErrorToast(err, `Opening file: ${filePath}`);
    }
  };

  const saveFile = async () => {
    if (!selectedProject || !openFile) return;
    setSaving(true);
    try {
      await projectsAPI.writeFile(selectedProject, openFile.path, editorContent);
      setOpenFile(prev => prev ? { ...prev, content: editorContent } : null);
      setModified(false);
      showToast('File saved');
      await refreshTree();
    } catch (err) { showErrorToast(err, `Saving file: ${openFile.path}`); } finally { setSaving(false); }
  };

  // Auto-save: debounce 2s after typing
  const handleEditorChange = (val: string | undefined) => {
    const newVal = val || '';
    setEditorContent(newVal);
    setModified(newVal !== openFile?.content);
    // Auto-save after 2s of no typing
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (newVal !== openFile?.content) {
      autoSaveTimerRef.current = setTimeout(async () => {
        if (selectedProject && openFile) {
          try {
            await projectsAPI.writeFile(selectedProject, openFile.path, newVal);
            setOpenFile(prev => prev ? { ...prev, content: newVal } : null);
            setModified(false);
          } catch (err) { logError(err, 'Auto-save failed'); }
        }
      }, 2000);
    }
  };

  const handleZipSelect = (file: File) => {
    setZipFile(file);
    if (!newName.trim()) {
      setNewName(file.name.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-'));
    }
  };

  const uploadZipProject = async () => {
    if (!zipFile || !newName.trim()) return;
    setZipUploading(true);
    setUploadProgress('Uploading...');
        const apiUrl = import.meta.env.VITE_API_URL || '';
    const CHUNK_THRESHOLD = 500 * 1024 * 1024; // 500MB - chunked upload threshold

    try {
      let result: any;

      if (zipFile.size <= CHUNK_THRESHOLD) {
        // Direct upload for files under threshold
        result = await new Promise<any>((resolve, reject) => {
          const formData = new FormData();
          formData.append('file', zipFile);
          formData.append('name', newName);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${apiUrl}/projects/upload-zip`);
          xhr.withCredentials = true;
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(`Uploading... ${pct}%`);
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              setUploadProgress('Extracting & setting up...');
              try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
            } else {
              try { reject(new Error(JSON.parse(xhr.responseText).error || 'Upload failed')); }
              catch { reject(new Error('Upload failed')); }
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(formData);
        });
      } else {
        // Chunked upload for large files
        setUploadProgress('🔄 Switching to chunked upload for large file...');
        const CHUNK_SIZE = 5 * 1024 * 1024;
        const totalChunks = Math.ceil(zipFile.size / CHUNK_SIZE);
        const baseUrl = window.location.origin || window.location.origin;

        // Init chunked upload
        const initResp = await fetch(`${baseUrl}/api/upload/init`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: zipFile.name, fileSize: zipFile.size, totalChunks }),
        });
        if (!initResp.ok) throw new Error('Failed to init chunked upload');
        const { uploadId } = await initResp.json();

        // Upload chunks
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, zipFile.size);
          const chunk = await zipFile.slice(start, end).arrayBuffer();
          const pct = Math.round(((i + 1) / totalChunks) * 100);
          setUploadProgress(`📦 Chunked upload: ${pct}% (chunk ${i + 1}/${totalChunks})`);

          let retries = 3;
          while (retries > 0) {
            try {
              const resp = await fetch(`${baseUrl}/api/upload/chunk`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'x-upload-id': uploadId,
                  'x-chunk-index': i.toString(),
                  'Content-Type': 'application/octet-stream',
                },
                body: chunk,
              });
              if (!resp.ok) throw new Error(`Chunk ${i} failed: ${resp.status}`);
              break;
            } catch (e) {
              retries--;
              if (retries === 0) throw e;
              await new Promise(r => setTimeout(r, 1000 * (4 - retries)));
            }
          }
        }

        // Complete chunked upload
        const completeResp = await fetch(`${baseUrl}/api/upload/complete`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId, projectName: newName }),
        });
        if (!completeResp.ok) throw new Error('Failed to complete chunked upload');
        result = await completeResp.json();

        // If chunked upload completed but we need to create project from the uploaded file
        if (result.filePath) {
          setUploadProgress('Extracting & setting up project...');
          const createResp = await fetch(`${apiUrl}/projects/create-from-upload`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, filePath: result.filePath }),
          });
          if (createResp.ok) {
            result = await createResp.json();
          } else {
            const errorData = await createResp.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to create project from uploaded ZIP');
          }
        }
      }

      setShowCreate(false);
      setNewName('');
      setZipFile(null);
      setUploadProgress(null);
      if (result.detectedType && result.detectedType !== 'unknown') {
        showToast(`Project created (${result.detectedType}) — run: ${result.suggestedCommand}`);
      } else {
        showToast('Project created from ZIP');
      }
      await loadProjects();
    } catch (err: any) {
      showToast(err.message || 'Failed to upload ZIP', 'error');
      setUploadProgress(null);
    } finally { setZipUploading(false); }
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    if (createMode === 'zip') { await uploadZipProject(); return; }
    setCreating(true);
    try {
      if (createMode === 'clone') {
        await projectsAPI.clone(cloneUrl, newName);
      } else {
        await projectsAPI.create(newName, template);
      }
      setShowCreate(false);
      setNewName('');
      setCloneUrl('');
      await loadProjects();
      showToast('Project created');
    } catch (err) { showErrorToast(err, 'Creating project'); } finally { setCreating(false); }
  };

  const requestDeleteProject = (name: string) => setPendingDelete({ kind: 'project', name });

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState('');

  const startRenameProject = (name: string) => {
    setRenamingProject(name);
    setRenameProjectValue(name);
  };

  const submitRenameProject = async () => {
    if (!renamingProject || !renameProjectValue.trim()) { setRenamingProject(null); return; }
    const newName = renameProjectValue.trim();
    if (newName === renamingProject) { setRenamingProject(null); return; }
    try {
      const wasAgentChatActive = localStorage.getItem(`agent-active-${renamingProject}`) === 'true';
      const result = await projectsAPI.rename(renamingProject, newName);
      if (wasAgentChatActive) {
        localStorage.setItem(`agent-active-${result.name}`, 'true');
        localStorage.removeItem(`agent-active-${renamingProject}`);
      }
      if (selectedProject === renamingProject) setSelectedProject(result.name);
      await loadProjects();
      showToast(`Renamed to "${result.name}"`);
    } catch (err) { showErrorToast(err, 'Renaming project'); }
    setRenamingProject(null);
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === 'project') {
      try {
        await projectsAPI.delete(pendingDelete.name);
        if (selectedProject === pendingDelete.name) { setSelectedProject(null); setOpenFile(null); }
        await loadProjects();
        showToast('Project deleted');
      } catch (err) { showErrorToast(err, `Deleting project "${pendingDelete.name}"`); }
    } else if (pendingDelete.kind === 'file' && selectedProject && pendingDelete.path) {
      try {
        await projectsAPI.deleteFile(selectedProject, pendingDelete.path);
        if (openFile?.path === pendingDelete.path) setOpenFile(null);
        await refreshTree();
        showToast('Deleted');
      } catch (err) { showErrorToast(err, `Deleting file "${pendingDelete.path}"`); }
    }
    setPendingDelete(null);
  };

  const commitChanges = async () => {
    if (!selectedProject || !commitMsg.trim()) return;
    setGitLoading(true);
    try {
      await projectsAPI.git(selectedProject, 'commit', { message: commitMsg });
      setCommitMsg('');
      showToast('Changes committed');
      await loadGitStatus();
      await refreshTree();
    } catch (err) { showErrorToast(err, 'Committing changes'); } finally { setGitLoading(false); }
  };

  const gitPull = async () => {
    if (!selectedProject) return;
    setGitLoading(true);
    try {
      const data = await projectsAPI.git(selectedProject, 'pull');
      showToast(data.output || 'Pull complete');
      await loadGitStatus();
    } catch (err) { showErrorToast(err, 'Git pull'); } finally { setGitLoading(false); }
  };

  const gitPush = async () => {
    if (!selectedProject) return;
    setGitLoading(true);
    try {
      const data = await projectsAPI.git(selectedProject, 'push');
      showToast(data.output || 'Push complete');
      await loadGitStatus();
    } catch (err) { showErrorToast(err, 'Git push'); } finally { setGitLoading(false); }
  };

  const switchBranch = async (branchName: string) => {
    if (!selectedProject) return;
    setGitLoading(true);
    try {
      await projectsAPI.git(selectedProject, 'checkout', { branch: branchName });
      showToast(`Switched to ${branchName}`);
      await loadBranches();
      await refreshTree();
      await loadProjects();
    } catch (err) { showErrorToast(err, `Switching to branch: ${branchName}`); } finally { setGitLoading(false); }
  };

  const createBranch = async () => {
    if (!selectedProject || !newBranchName.trim()) return;
    setGitLoading(true);
    try {
      await projectsAPI.git(selectedProject, 'checkout-new', { branch: newBranchName });
      setNewBranchName('');
      showToast(`Created branch ${newBranchName}`);
      await loadBranches();
      await loadProjects();
    } catch (err) { showErrorToast(err, `Creating branch: ${newBranchName}`); } finally { setGitLoading(false); }
  };

  const resetFile = async (filePath: string) => {
    if (!selectedProject) return;
    try {
      await projectsAPI.git(selectedProject, 'reset-file', { file: filePath });
      showToast(`Reset: ${filePath}`);
      await loadGitStatus();
      await refreshTree();
    } catch (err) { showErrorToast(err, `Resetting file: ${filePath}`); }
  };

  // Install dependencies via SSE stream (using fetch for POST with SSE)
  const installDependencies = async (projectName: string): Promise<boolean> => {
    const apiUrl = import.meta.env.VITE_API_URL || '/api';
    const abortController = new AbortController();
    installEventSourceRef.current = { close: () => abortController.abort() } as any;
    
    const logs: string[] = [];
    let success = false;
    
    try {
      const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(projectName)}/install-deps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: abortController.signal,
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to start installation');
      }
      
      // Check if response is SSE or JSON
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        // Already completed or no deps needed
        const data = await response.json();
        if (data.success || data.cached) {
          return true;
        }
        return false;
      }
      
      // Parse SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        let eventType = '';
        let eventData = '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6);
            
            if (eventType && eventData) {
              try {
                const data = JSON.parse(eventData);
                
                if (eventType === 'start') {
                  setProgressNotification({
                    id: `install-${projectName}`,
                    title: 'Installing Dependencies',
                    status: 'active',
                    progress: 5,
                    statusText: `Installing ${data.packages?.length || 0} packages...`,
                    logs: [`$ ${data.command || 'Installing...'}`],
                    onCancel: () => {
                      abortController.abort();
                      installEventSourceRef.current = null;
                      setProgressNotification(null);
                    },
                    onDismiss: () => setProgressNotification(null),
                  });
                } else if (eventType === 'progress') {
                  if (data.text) logs.push(data.text);
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    progress: Math.min(90, data.progress || prev.progress + 5),
                    statusText: data.text || prev.statusText,
                    logs: [...logs].slice(-50),
                  } : null);
                } else if (eventType === 'log') {
                  if (data.text) logs.push(data.text);
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    logs: [...logs].slice(-50),
                  } : null);
                } else if (eventType === 'complete') {
                  success = true;
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    status: 'complete',
                    progress: 100,
                    statusText: data.message || 'Dependencies installed!',
                    onCancel: undefined,
                  } : null);
                } else if (eventType === 'error') {
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    status: 'error',
                    statusText: 'Installation failed',
                    error: data.message || 'Unknown error',
                    onCancel: undefined,
                  } : null);
                }
              } catch (parseError) {
                console.warn('Failed to parse SSE data:', eventData);
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return false;
      }
      setProgressNotification(prev => prev ? {
        ...prev,
        status: 'error',
        statusText: 'Installation failed',
        error: err.message || 'Unknown error',
        onCancel: undefined,
      } : null);
      return false;
    } finally {
      installEventSourceRef.current = null;
    }
    
    if (success) {
      await new Promise(r => setTimeout(r, 500));
    }
    return success;
  };

  const deployProject = async () => {
    if (!selectedProject) return;
    
    // First check for dependencies (for runtime projects)
    if (isRuntimeProject) {
      try {
        const depsResult = await projectsAPI.checkDeps(selectedProject);
        
        if (depsResult.needsInstall && depsResult.packages?.length > 0) {
          // Show notification and install dependencies
          setProgressNotification({
            id: `deps-${selectedProject}`,
            title: 'Checking Dependencies',
            status: 'pending',
            progress: 0,
            statusText: `Found ${depsResult.packages.length} missing packages`,
            logs: [`Packages: ${depsResult.packages.join(', ')}`],
            onDismiss: () => setProgressNotification(null),
          });
          
          const installSuccess = await installDependencies(selectedProject);
          if (!installSuccess) {
            showErrorToast(new Error('Dependency installation cancelled or failed'), 'Installing dependencies');
            return;
          }
          
          // Brief pause before deploy
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (err) {
        // Dependency check failed, continue with deploy anyway
        console.warn('Dependency check failed:', err);
      }
    }
    
    // Now deploy
    setDeploying(true);
    setDeployStatus('deploying');
    
    // Show deploy notification
    setProgressNotification({
      id: `deploy-${selectedProject}`,
      title: isRuntimeProject ? 'Running Project' : 'Deploying Project',
      status: 'active',
      progress: 20,
      statusText: isRuntimeProject ? 'Launching on desktop...' : 'Building and deploying...',
      onDismiss: () => setProgressNotification(null),
    });
    
    try {
      const data = await projectsAPI.deploy(selectedProject);
      
      setProgressNotification(prev => prev ? {
        ...prev,
        status: 'complete',
        progress: 100,
        statusText: data.deployType === 'runtime' ? 'Running on Desktop!' : `Deployed to ${data.url}`,
      } : null);
      
      setDeployStatus('success');
      
      // Handle runtime projects - redirect to desktop
      if (data.deployType === 'runtime') {
        await loadProjects();
        setTimeout(() => {
          setDeployStatus('idle');
          setProgressNotification(null);
          navigate('/desktop');
        }, 1500);
      } else {
        await loadProjects();
        setTimeout(() => {
          setDeployStatus('idle');
        }, 3000);
      }
    } catch (err) {
      const errObj = extractError(err);
      setProgressNotification(prev => prev ? {
        ...prev,
        status: 'error' as const,
        statusText: 'Deploy failed',
        error: errObj.message || String(errObj),
      } : null);
      
      setDeployStatus('failed');
      setTimeout(() => setDeployStatus('idle'), 5000);
    } finally { 
      setDeploying(false); 
    }
  };
  
  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (installEventSourceRef.current) {
        installEventSourceRef.current.close();
      }
    };
  }, []);

  // Check syntax/compile for runtime projects
  const checkProject = async () => {
    if (!selectedProject) return;
    setCheckingProject(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/projects/${encodeURIComponent(selectedProject)}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`✅ No syntax errors (${data.language})`, 'success');
      } else {
        showToast(`❌ ${data.language} errors found`, 'error', { 
          detail: data.output,
          hint: data.errors?.join('\n')
        });
      }
    } catch (err) {
      showErrorToast(err, 'Checking project syntax');
    } finally { setCheckingProject(false); }
  };

  const createShareLink = async () => {
    if (!selectedProject) return;
    if (!shareIsPublic) {
      if (sharePassword.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
      if (sharePassword !== sharePasswordConfirm) { showToast('Passwords do not match', 'error'); return; }
    }
    try {
      await projectsAPI.share(selectedProject, {
        isPublic: shareIsPublic,
        ...(shareIsPublic ? {} : { password: sharePassword }),
      });
      showToast('Share link created');
      setSharePassword('');
      setSharePasswordConfirm('');
      setShareIsPublic(true);
      await loadShares();
    } catch (err) { showErrorToast(err, 'Creating share link'); }
  };

  const revokeShare = async (linkId: string) => {
    if (!selectedProject) return;
    try {
      await projectsAPI.revokeShare(selectedProject, linkId);
      showToast('Share link revoked');
      await loadShares();
    } catch (err) { showErrorToast(err, 'Revoking share link'); }
  };

  const toggleShareActive = async (linkId: string) => {
    if (!selectedProject) return;
    const share = shares.find(s => s.id === linkId);
    if (!share) return;
    try {
      await projectsAPI.updateShare(selectedProject, linkId, { isActive: !share.isActive });
      showToast(share.isActive ? 'Link disabled' : 'Link activated');
      await loadShares();
    } catch (err) { showErrorToast(err, 'Updating share link'); }
  };

  // Download project
  const downloadProject = async (mode: 'full' | 'clean' | 'stripped') => {
    if (!selectedProject) return;
    try {
      const modeLabels = {
        full: 'Full',
        clean: 'Clean',
        stripped: 'Stripped',
      };
      
      const response = await fetch(`/api/projects/${selectedProject}/download?mode=${mode}`, {
        headers: {},
      });

      if (!response.ok) throw new Error('Download failed');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedProject}-${mode}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      showToast(`Downloaded ${selectedProject} (${modeLabels[mode]})`, 'success');
    } catch (error) {
      showErrorToast(error, `Downloading project: ${selectedProject}`);
    }
  };

  const [pendingDeleteShare, setPendingDeleteShare] = useState<string | null>(null);
  const [emailingLinkId, setEmailingLinkId] = useState<string | null>(null);
  const [shareEmailInput, setShareEmailInput] = useState('');
  const [shareEmailPassword, setShareEmailPassword] = useState('');
  const [shareEmailSending, setShareEmailSending] = useState(false);
  const [shareEmailSuccess, setShareEmailSuccess] = useState<string | null>(null);

  const sendShareEmail = async (linkId: string, isPasswordProtected: boolean) => {
    if (!selectedProject || !shareEmailInput) return;
    setShareEmailSending(true);
    try {
      await projectsAPI.emailShare(selectedProject, linkId, {
        recipientEmail: shareEmailInput,
        ...(isPasswordProtected && shareEmailPassword ? { password: shareEmailPassword } : {}),
      });
      setShareEmailSuccess(linkId);
      setTimeout(() => {
        setShareEmailSuccess(null);
        setEmailingLinkId(null);
        setShareEmailInput('');
        setShareEmailPassword('');
      }, 2000);
    } catch (err) {
      showErrorToast(err, 'Sending share email');
    } finally {
      setShareEmailSending(false);
    }
  };

  const deleteSharePermanently = async () => {
    if (!pendingDeleteShare || !selectedProject) return;
    try {
      await projectsAPI.deleteShare(selectedProject, pendingDeleteShare);
      setPendingDeleteShare(null);
      showToast('Share link deleted');
      await loadShares();
    } catch (err) { showErrorToast(err, 'Deleting share link'); }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const askAI = async () => {
    if (!aiMessage.trim()) return;
    setAiLoading(true);
    try {
      const context = openFile ? editorContent : undefined;
      const data = await aiAPI.chat(aiMessage, context);
      setAiResponse(data.response);
    } catch (err) { showErrorToast(err, 'AI chat request'); } finally { setAiLoading(false); }
  };

  // Agent Chat functions
  // Agent chat panel — open/close/auto-restore
  const agentAutoRestoreAttempted = useRef<string | null>(null);

  const openAgentChat = useCallback(() => {
    if (!selectedProject) return;
    setAgentChatOpen(true);
  }, [selectedProject]);

  const closeAgentChat = useCallback(() => {
    if (selectedProject) {
      localStorage.removeItem(`agent-active-${selectedProject}`);
    }
    agentAutoRestoreAttempted.current = null;
    setAgentChatOpen(false);
  }, [selectedProject]);

  // Auto-restore Agent chat on project selection if there was an active session
  useEffect(() => {
    if (!selectedProject || agentAutoRestoreAttempted.current === selectedProject) return;
    if (agentChatOpen) {
      agentAutoRestoreAttempted.current = selectedProject;
      return;
    }
    const wasActive = localStorage.getItem(`agent-active-${selectedProject}`) === 'true';
    agentAutoRestoreAttempted.current = selectedProject;
    if (wasActive) {
      setTimeout(() => openAgentChat(), 300);
    }
  }, [selectedProject, agentChatOpen, openAgentChat]);

  const analyzeFile = async () => {
    if (!openFile || !editorContent) return;

    // File size guard
    const lineCount = editorContent.split('\n').length;
    const sizeKB = new TextEncoder().encode(editorContent).length / 1024;
    if (lineCount > 5000 || sizeKB > 200) {
      showToast(`File too large (${lineCount} lines, ${sizeKB.toFixed(0)}KB). Max 5 000 lines / 200 KB.`, 'error');
      return;
    }

    setAnalyzing(true);
    setShowAnalysisPanel(true);
    setAnalysisResults([]);

    try {
      if (lineCount > 500) {
        // Chunk large files
        const lines = editorContent.split('\n');
        const chunkSize = 400;
        const allIssues: any[] = [];
        showToast(`Large file — analyzing in ${Math.ceil(lines.length / chunkSize)} parts…`, 'info');

        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize).join('\n');
          try {
            const data = await aiAPI.analyzeCode(chunk, openFile.language, analyzeModel);
            const adjusted = (data.issues || []).map((issue: any) => ({
              ...issue,
              line: (issue.line || 1) + i,
            }));
            allIssues.push(...adjusted);
          } catch (err) {
            logError(err, `Analyzing code chunk ${i}/${Math.ceil(lineCount / 400)}`);
          }
        }

        setAnalysisResults(allIssues);
        showToast(allIssues.length ? `Found ${allIssues.length} issues` : 'No issues found!', allIssues.length ? 'info' : 'success');
      } else {
        const data = await aiAPI.analyzeCode(editorContent, openFile.language, analyzeModel);
        setAnalysisResults(data.issues || []);
        if (data.issues?.length === 0) {
          showToast('No issues found!', 'success');
        }
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Analysis failed';
      showToast(msg, 'error');
    } finally { setAnalyzing(false); }
  };

  const dismissIssue = (idx: number) => {
    setAnalysisResults(prev => prev.filter((_, i) => i !== idx));
  };

  const acceptFix = (issue: any) => {
    if (!issue.code || !openFile) return;

    const lines = editorContent.split('\n');
    const startLine = issue.line - 1; // Convert to 0-indexed
    const endLine = (issue.endLine || issue.line) - 1;

    // Validate range
    if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
      showToast('Could not apply fix — line number out of range', 'error');
      return;
    }

    // Replace line(s) with the fix code
    lines.splice(startLine, endLine - startLine + 1, issue.code);

    const newContent = lines.join('\n');
    setEditorContent(newContent);
    setModified(true);

    // Remove this issue from results
    setAnalysisResults(prev => prev.filter(i => i !== issue));

    showToast(`Applied fix at line${issue.endLine ? `s ${issue.line}-${issue.endLine}` : ` ${issue.line}`}`, 'success');
  };

  const createNewFile = async () => {
    if (!selectedProject || !newFilePath.trim()) return;
    try {
      if (newFileIsDir) {
        await projectsAPI.createFile(selectedProject, newFilePath + '/.gitkeep', '');
      } else {
        await projectsAPI.createFile(selectedProject, newFilePath, '');
      }
      setShowNewFile(false);
      setNewFilePath('');
      await refreshTree();
      showToast(`${newFileIsDir ? 'Folder' : 'File'} created`);
    } catch (err) { showErrorToast(err, `Creating ${newFileIsDir ? 'folder' : 'file'}: ${newFilePath}`); }
  };

  const requestDeleteFile = (filePath: string) => {
    if (!selectedProject) return;
    setPendingDelete({ kind: 'file', name: filePath.split('/').pop() || filePath, path: filePath });
  };

  const handleUploadFiles = async () => {
    if (!selectedProject || uploadFiles.length === 0) return;
    setUploadingFiles(true);
    try {
      const data = await projectsAPI.uploadFiles(selectedProject, uploadFiles, uploadTargetPath || undefined);
      const count = data.uploaded?.length || uploadFiles.length;
      showToast(`Uploaded ${count} file${count !== 1 ? 's' : ''}${uploadTargetPath ? ` to ${uploadTargetPath}` : ''}`, 'success');
      if (data.errors?.length) {
        showToast(`${data.errors.length} file(s) failed: ${data.errors.map((e: any) => e.name).join(', ')}`, 'error');
      }
      setShowUploadDialog(false);
      setUploadFiles([]);
      setUploadTargetPath('');
      await refreshTree();
    } catch (err) {
      showErrorToast(err, 'Uploading files');
    } finally {
      setUploadingFiles(false);
    }
  };

  const openUploadDialog = (targetDir?: string) => {
    setUploadTargetPath(targetDir || '');
    setUploadFiles([]);
    setUploadDragOver(false);
    setShowUploadDialog(true);
  };

  // react-dropzone for upload dialog (works on iPad)
  const { getRootProps: getUploadRootProps, getInputProps: getUploadInputProps, isDragActive: uploadIsDragActive } = useDropzone({
    onDrop: (acceptedFiles) => {
      setUploadFiles(prev => [...prev, ...acceptedFiles]);
    },
    noClick: false,
    noKeyboard: false,
  });

  // Collect directory paths for upload target selection
  const collectDirPaths = (entries: TreeEntry[], expanded: Record<string, TreeEntry[]>): string[] => {
    const dirs: string[] = [''];
    const walk = (items: TreeEntry[]) => {
      for (const item of items) {
        if (item.type === 'directory') {
          dirs.push(item.path);
          if (expanded[item.path]) walk(expanded[item.path]);
        }
      }
    };
    walk(entries);
    return dirs;
  };

  const startRenameEntry = (entry: TreeEntry) => {
    setRenamingEntry({ path: entry.path, name: entry.name, type: entry.type });
    setRenameValue(entry.name);
  };

  const executeRenameEntry = async () => {
    if (!renamingEntry || !selectedProject || !renameValue.trim()) { setRenamingEntry(null); return; }
    const newName = renameValue.trim();
    if (newName === renamingEntry.name) { setRenamingEntry(null); return; }
    // Validate: no path traversal
    if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      showToast('Invalid name', 'error'); setRenamingEntry(null); return;
    }
    const parentDir = renamingEntry.path.includes('/') ? renamingEntry.path.substring(0, renamingEntry.path.lastIndexOf('/')) : '';
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    try {
      await projectsAPI.renameFile(selectedProject, renamingEntry.path, newPath);
      showToast('Renamed successfully');
      await refreshTree();
      // If the renamed file was open, update the open file path
      if (openFile && openFile.path === renamingEntry.path) {
        setOpenFile({ ...openFile, path: newPath });
      }
    } catch (e: any) {
      showToast(e?.response?.data?.error || 'Failed to rename', 'error');
    } finally {
      setRenamingEntry(null);
    }
  };

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Ctrl+S = save
      if (mod && e.key === 's') { e.preventDefault(); saveFile(); }
      // Ctrl+Shift+F = fullscreen editor
      if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); if (openFile) setEditorFullscreen(f => !f); }
      // Ctrl+B = toggle sidebar
      if (mod && e.key === 'b') { e.preventDefault(); setSidebarVisible(v => !v); }
      // Ctrl+P = file search
      if (mod && e.key === 'p') { e.preventDefault(); setShowFileSearch(true); }
      // ESC = exit fullscreen or close search
      if (e.key === 'Escape') {
        if (editorFullscreen) setEditorFullscreen(false);
        if (showFileSearch) setShowFileSearch(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const currentProject = projects.find(p => p.name === selectedProject);

  // Collect all file paths for search
  const collectAllPaths = (entries: TreeEntry[], expanded: Record<string, TreeEntry[]>): string[] => {
    const paths: string[] = [];
    const walk = (items: TreeEntry[]) => {
      for (const item of items) {
        paths.push(item.path);
        if (item.type === 'directory' && expanded[item.path]) {
          walk(expanded[item.path]);
        }
      }
    };
    walk(entries);
    return paths;
  };

  const allFilePaths = collectAllPaths(tree, expandedDirs);
  const filteredFiles = fileSearchQuery
    ? allFilePaths.filter(p => p.toLowerCase().includes(fileSearchQuery.toLowerCase()))
    : allFilePaths.slice(0, 20);

  // --- Render helpers ---
  const renderTree = (entries: TreeEntry[], depth = 0) => (
    <div style={{ paddingLeft: depth * 14 }}>
      {entries.map(entry => (
        <div key={entry.path}>
          {entry.type === 'directory' ? (
            <>
              <div className="group flex items-center">
                <button
                  onClick={() => toggleDir(entry.path)}
                  className="flex items-center gap-1.5 flex-1 px-2 py-1 text-xs text-slate-300 hover:bg-white/5 rounded transition-colors"
                >
                  {expandedDirs[entry.path] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <FolderOpen size={13} className={entry.gitStatus ? 'text-amber-400' : 'text-amber-400/70'} />
                  {renamingEntry?.path === entry.path ? (
                    <input
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={executeRenameEntry}
                      onKeyDown={e => { if (e.key === 'Enter') executeRenameEntry(); if (e.key === 'Escape') setRenamingEntry(null); }}
                      onClick={e => e.stopPropagation()}
                      className="flex-1 bg-slate-800 text-white px-1.5 py-0.5 rounded text-xs min-w-0 border border-emerald-500/30 focus:outline-none"
                      autoFocus
                      onFocus={e => e.target.select()}
                    />
                  ) : (
                    <span className="flex-1 text-left truncate">{entry.name}</span>
                  )}
                  {entry.gitStatus && !renamingEntry && <span className={`text-[10px] ${gitStatusColor(entry.gitStatus)}`}>●</span>}
                </button>
                {!renamingEntry && (
                  <div className="flex opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={e => { e.stopPropagation(); startRenameEntry(entry); }} className="p-0.5 mr-0.5 text-slate-600 hover:text-blue-400 transition-all" title="Rename">
                      <Edit3 size={10} />
                    </button>
                    <button onClick={() => requestDeleteFile(entry.path)} className="p-0.5 mr-1 text-slate-600 hover:text-red-400 transition-all" title="Delete">
                      <Trash2 size={10} />
                    </button>
                  </div>
                )}
              </div>
              {expandedDirs[entry.path] && renderTree(expandedDirs[entry.path], depth + 1)}
            </>
          ) : (
            <div className="group flex items-center">
              <button
                onClick={() => { if (renamingEntry?.path !== entry.path) { openFileHandler(entry.path); if (isMobile) setSidebarVisible(false); } }}
                className={`flex items-center gap-1.5 flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  (openFile?.path === entry.path || openMedia?.path === entry.path) ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span className="w-3" />
                {(() => { const Icon = getFileIcon(entry.name); return <Icon size={13} />; })()}
                {renamingEntry?.path === entry.path ? (
                  <input
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={executeRenameEntry}
                    onKeyDown={e => { if (e.key === 'Enter') executeRenameEntry(); if (e.key === 'Escape') setRenamingEntry(null); }}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 bg-slate-800 text-white px-1.5 py-0.5 rounded text-xs min-w-0 border border-emerald-500/30 focus:outline-none"
                    autoFocus
                    onFocus={e => e.target.select()}
                  />
                ) : (
                  <span className="truncate flex-1 text-left">{entry.name}</span>
                )}
                {entry.gitStatus && !renamingEntry && (
                  <span className={`text-[10px] font-mono font-bold ${gitStatusColor(entry.gitStatus)}`}>
                    {gitStatusIcon(entry.gitStatus)}
                  </span>
                )}
              </button>
              {!renamingEntry && (
                <div className="flex opacity-0 group-hover:opacity-100 transition-all">
                  <button onClick={e => { e.stopPropagation(); startRenameEntry(entry); }} className="p-0.5 mr-0.5 text-slate-600 hover:text-blue-400 transition-all" title="Rename">
                    <Edit3 size={10} />
                  </button>
                  <button onClick={() => requestDeleteFile(entry.path)} className="p-0.5 mr-1 text-slate-600 hover:text-red-400 transition-all" title="Delete">
                    <Trash2 size={10} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const renderDiff = (diffText: string) => {
    const lines = diffText.split('\n');
    return (
      <pre className="text-[11px] font-mono leading-relaxed overflow-auto">
        {lines.map((line, i) => {
          let cls = 'text-slate-400';
          let bg = '';
          if (line.startsWith('+') && !line.startsWith('+++')) { cls = 'text-green-400'; bg = 'bg-green-500/5'; }
          else if (line.startsWith('-') && !line.startsWith('---')) { cls = 'text-red-400'; bg = 'bg-red-500/5'; }
          else if (line.startsWith('@@')) { cls = 'text-blue-400'; bg = 'bg-blue-500/5'; }
          else if (line.startsWith('diff') || line.startsWith('index')) { cls = 'text-slate-500'; }
          return <div key={i} className={`px-3 ${bg} ${cls}`}>{line || ' '}</div>;
        })}
      </pre>
    );
  };

  // Handle title bar path editing
  const handlePathEdit = async (newPath: string) => {
    if (!selectedProject || !openFile) return;
    if (newPath === openFile.path || !newPath.trim()) {
      setEditingPath(false);
      return;
    }
    
    // Validate path (no .., no leading/trailing slashes)
    if (newPath.includes('..') || newPath.startsWith('/') || newPath.endsWith('/')) {
      showToast('Invalid path', 'error');
      setEditingPath(false);
      return;
    }
    
    try {
      await projectsAPI.renameFile(selectedProject, openFile.path, newPath);
      setOpenFile({ ...openFile, path: newPath });
      showToast('File moved - refresh sidebar to see changes');
    } catch (err: any) {
      showToast(err.response?.data?.error || 'Move failed', 'error');
    }
    setEditingPath(false);
  };

  // File breadcrumbs
  const renderBreadcrumbs = (filePath: string) => {
    
    if (editingPath) {
      return (
        <input
          type="text"
          value={pathEditValue}
          onChange={(e) => setPathEditValue(e.target.value)}
          onBlur={() => handlePathEdit(pathEditValue)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handlePathEdit(pathEditValue);
            if (e.key === 'Escape') setEditingPath(false);
          }}
          autoFocus
          className="flex-1 px-2 py-0.5 text-xs bg-white/5 border border-emerald-500/50 rounded text-slate-200 focus:outline-none focus:border-emerald-500"
          placeholder="path/to/file.ext"
        />
      );
    }
    
    const parts = filePath.split('/');
    return (
      <div 
        className="flex items-center gap-0.5 text-xs text-slate-500 cursor-pointer hover:text-slate-300 transition-colors group"
        onClick={() => {
          setEditingPath(true);
          setPathEditValue(filePath);
        }}
        title="Click to edit path (move/rename file)"
      >
        {parts.map((part, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight size={10} />}
            <span className={i === parts.length - 1 ? 'text-slate-300' : ''}>{part}</span>
          </span>
        ))}
        <Edit3 size={10} className="ml-1 opacity-0 group-hover:opacity-50" />
      </div>
    );
  };

  // Monaco editor component (reused for normal and fullscreen)
  const editorElement = openFile && (
    <Editor
      height="100%"
      language={openFile.language}
      value={editorContent}
      onChange={handleEditorChange}
      theme="vs-dark"
      options={{
        minimap: { enabled: editorFullscreen },
        fontSize: editorFullscreen ? 14 : 13,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
        fontLigatures: true,
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'on',
        padding: { top: 8 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        bracketPairColorization: { enabled: true },
      }}
    />
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col">
      {/* Enhanced Toast with expandable details */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-[100] rounded-xl text-sm font-medium shadow-2xl backdrop-blur-xl max-w-lg border ${
              toast.type === 'success' ? 'bg-emerald-500/90 border-emerald-400/30 text-white' :
              toast.type === 'error' ? 'bg-red-900/95 border-red-500/50 text-red-100' :
              'bg-blue-500/90 border-blue-400/30 text-white'
            }`}
          >
            {/* Main message row */}
            <div className="flex items-start gap-2 px-4 py-3">
              <span className="mt-0.5 flex-shrink-0">{toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : 'ℹ️'}</span>
              <span className="flex-1 min-w-0 whitespace-pre-line break-words leading-relaxed">{toast.message}</span>
              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                {(toast.detail || toast.hint) && (
                  <button
                    onClick={() => setToastExpanded(!toastExpanded)}
                    className="p-1 rounded hover:bg-white/20 transition-colors text-xs"
                    title={toastExpanded ? 'Collapse' : 'Show details'}
                  >
                    {toastExpanded ? '▲' : '▼'}
                  </button>
                )}
                <button onClick={() => setToast(null)} className="p-1 rounded hover:bg-white/20 transition-colors font-bold">✕</button>
              </div>
            </div>
            {/* Hint (always visible for errors) */}
            {toast.hint && !toastExpanded && (
              <div className="px-4 pb-2 text-xs opacity-80">💡 {toast.hint}</div>
            )}
            {/* Expanded details */}
            {toastExpanded && (toast.detail || toast.hint) && (
              <div className="px-4 pb-3 pt-1 border-t border-white/10">
                {toast.hint && <div className="text-xs mb-2 opacity-90">💡 <strong>Hint:</strong> {toast.hint}</div>}
                {toast.detail && (
                  <div className="relative">
                    <pre className="text-[11px] bg-black/40 rounded-lg p-2.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed text-red-200">
                      {toast.detail}
                    </pre>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText([toast.message, toast.detail, toast.hint].filter(Boolean).join('\n\n'));
                        setToastCopied(true);
                        setTimeout(() => setToastCopied(false), 2000);
                      }}
                      className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] bg-black/60 hover:bg-black/80 transition-colors"
                      title="Copy error details"
                    >
                      {toastCopied ? '✓ Copied' : '📋 Copy'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen Editor Overlay */}
      <AnimatePresence>
        {editorFullscreen && openFile && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-[#0A0E27]/98 backdrop-blur-sm flex flex-col"
          >
            {/* Fullscreen toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-[#0D1130]/90">
              <div className="flex items-center gap-3">
                <FileCode size={14} className="text-emerald-400" />
                {renderBreadcrumbs(openFile.path)}
                {modified && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="Unsaved changes" />}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 px-2 py-0.5 rounded bg-white/5">{openFile.language}</span>
                <button onClick={saveFile} disabled={!modified || saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs disabled:opacity-30 transition-colors">
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
                </button>
                <button onClick={() => setEditorFullscreen(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white text-xs transition-colors">
                  <Minimize2 size={12} /> Exit <kbd className="ml-1 text-[9px] px-1 py-0.5 rounded bg-white/5 border border-white/10">ESC</kbd>
                </button>
              </div>
            </div>
            {/* Editor fills remaining space */}
            <div className="flex-1">
              {editorElement}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* File Search Dialog (Ctrl+P) */}
      <AnimatePresence>
        {showFileSearch && selectedProject && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-[15vh]" onClick={() => setShowFileSearch(false)}>
            <motion.div initial={{ scale: 0.95, y: -10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: -10 }}
              className="glass max-w-lg w-full shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
                <Search size={14} className="text-slate-500" />
                <input
                  value={fileSearchQuery}
                  onChange={e => setFileSearchQuery(e.target.value)}
                  className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
                  placeholder="Search files..."
                  autoFocus
                />
                <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-500">ESC</kbd>
              </div>
              <div className="max-h-64 overflow-auto py-1">
                {filteredFiles.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-slate-500">No files found</div>
                ) : filteredFiles.map(fp => (
                  <button key={fp} onClick={() => { openFileHandler(fp); setShowFileSearch(false); setFileSearchQuery(''); }}
                    className="w-full px-4 py-2 text-left text-xs text-slate-300 hover:bg-emerald-500/10 hover:text-emerald-400 flex items-center gap-2 transition-colors">
                    <FileText size={12} className="text-slate-500 flex-shrink-0" />
                    <span className="truncate">{fp}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Bar */}
      <div className="flex items-center justify-between px-2 md:px-4 py-2 md:py-2.5 border-b border-white/5 bg-[#0D1130]/80 flex-shrink-0 gap-1">
        <div className="flex items-center gap-1.5 md:gap-3 min-w-0 flex-shrink overflow-hidden">
          <button onClick={() => setSidebarVisible(v => !v)} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white transition-colors flex-shrink-0" title="Toggle sidebar (Ctrl+B)">
            {sidebarVisible ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
          </button>
          <Rocket size={16} className="text-emerald-400 flex-shrink-0 hidden md:block" />
          <span className="font-medium text-sm hidden md:inline">Projects</span>
          {selectedProject && (
            <>
              <span className="text-xs text-slate-500 hidden md:inline">/</span>
              <span className="text-xs text-slate-300 font-medium truncate">{selectedProject}</span>
              {currentProject?.currentBranch && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20 flex-shrink-0 hidden sm:flex">
                  <GitBranch size={10} />
                  {currentProject.currentBranch}
                </span>
              )}
            </>
          )}
          {modified && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0 md:hidden" />}
          {modified && <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1 flex-shrink-0 hidden md:flex"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> Unsaved</span>}
        </div>
        <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
          {/* === MOBILE: Only Save + Deploy/Run + Overflow Menu === */}
          {isMobile && selectedProject && (
            <>
              {openFile && (
                <button onClick={saveFile} disabled={!modified || saving}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs disabled:opacity-30 min-w-[44px] min-h-[44px] justify-center">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                </button>
              )}
              <button onClick={deployProject} disabled={deploying}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium min-w-[44px] min-h-[44px] justify-center ${
                  deployStatus === 'success' ? 'bg-emerald-500/20 text-emerald-300' :
                  deployStatus === 'failed' ? 'bg-red-500/20 text-red-300' :
                  isRuntimeProject ? 'bg-green-500 text-white' : 'bg-emerald-500 text-white'
                } disabled:opacity-50`}>
                {deploying ? <Loader2 size={14} className="animate-spin" /> :
                 deployStatus === 'success' ? <CheckCircle size={14} /> :
                 isRuntimeProject ? <Play size={14} /> : <Upload size={14} />}
              </button>
              <MobileOverflowMenu actions={[
                ...(openFile ? [
                  { label: 'Fullscreen Editor', icon: <Maximize2 size={16} />, onClick: () => setEditorFullscreen(true) },
                  { label: `Analyze (${analyzeModel === 'qwen3:1.7b' ? 'Snappy' : analyzeModel === 'qwen3:8b' ? 'Best' : 'Smart'})`, icon: <Zap size={16} />, onClick: analyzeFile, disabled: analyzing },
                ] : []),
                // Show Check for runtime, Preview for others
                ...(isRuntimeProject 
                  ? [{ label: 'Check Syntax', icon: <CheckCircle size={16} />, onClick: checkProject, disabled: checkingProject }]
                  : [{ label: 'Preview', icon: <Eye size={16} />, onClick: () => setShowPreview(!showPreview), active: showPreview }]
                ),
                { label: 'Git', icon: <GitBranch size={16} />, onClick: () => setActivePanel(activePanel === 'git' ? null : 'git'), active: activePanel === 'git' },
                { label: 'Activity', icon: <Activity size={16} />, onClick: () => setActivePanel(activePanel === 'activity' ? null : 'activity'), active: activePanel === 'activity' },
                { label: 'Share', icon: <Share2 size={16} />, onClick: () => setActivePanel(activePanel === 'share' ? null : 'share'), active: activePanel === 'share' },
                { label: 'Agent AI', icon: <Bot size={16} />, onClick: () => agentChatOpen ? closeAgentChat() : openAgentChat(), active: agentChatOpen },
                { label: 'Download (Full)', icon: <Download size={16} />, onClick: () => downloadProject('full') },
                { label: 'Download (Clean)', icon: <Download size={16} />, onClick: () => downloadProject('clean') },
                { label: 'Download (Stripped)', icon: <Download size={16} />, onClick: () => downloadProject('stripped'), variant: 'danger' as const },
                ...(currentProject?.deployedUrl ? [{ label: 'Open Live Site', icon: <ExternalLink size={16} />, onClick: () => window.open(currentProject.deployedUrl, '_blank') }] : []),
              ]} />
            </>
          )}
          {/* === DESKTOP: Full toolbar (unchanged) === */}
          {!isMobile && (
            <>
              {selectedProject && openFile && (
                <>
                  <button onClick={saveFile} disabled={!modified || saving}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs disabled:opacity-30 transition-colors">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
                  </button>
                  <button onClick={() => setEditorFullscreen(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white text-xs transition-colors" title="Fullscreen (Ctrl+Shift+F)">
                    <Maximize2 size={12} />
                  </button>
                  <select value={analyzeModel} onChange={e => setAnalyzeModel(e.target.value)}
                    className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 focus:outline-none focus:border-purple-500/30">
                    <option value="qwen3:1.7b">⚡ Snappy (Qwen3 1.7B)</option>
                    <option value="qwen3:4b">🧠 Smart (Qwen3 4B)</option>
                    <option value="qwen3:8b">🚀 Best (Qwen3 8B)</option>
                  </select>
                  <button onClick={analyzeFile} disabled={analyzing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 text-xs transition-colors disabled:opacity-50">
                    {analyzing ? <><Loader2 size={12} className="animate-spin" /> Analyzing...</> : <><Zap size={12} /> Analyze</>}
                  </button>
                </>
              )}
              {selectedProject && (
                <>
                  {/* Preview button for static/fullstack, Check button for runtime */}
                  {isRuntimeProject ? (
                    <button onClick={checkProject} disabled={checkingProject}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${checkingProject ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}>
                      {checkingProject ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />} Check
                    </button>
                  ) : (
                    <button onClick={() => setShowPreview(!showPreview)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${showPreview ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}>
                      <Eye size={12} /> Preview
                    </button>
                  )}
                  <button onClick={() => setActivePanel(activePanel === 'git' ? null : 'git')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${activePanel === 'git' ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30' : 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20'}`}>
                    <GitBranch size={12} /> Git
                  </button>
                  <button onClick={() => setActivePanel(activePanel === 'activity' ? null : 'activity')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${activePanel === 'activity' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20'}`}>
                    <Activity size={12} /> Activity
                  </button>
                  <button onClick={() => setActivePanel(activePanel === 'share' ? null : 'share')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${activePanel === 'share' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-500/10 text-violet-400 hover:bg-violet-500/20'}`}>
                    <Share2 size={12} /> Share
                  </button>
                  {/* Deploy button for static/fullstack, Run button for runtime */}
                  <button onClick={deployProject} disabled={deploying}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors font-medium ${
                      deployStatus === 'success' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                      deployStatus === 'failed' ? 'bg-red-500/20 text-red-300 border border-red-500/30' :
                      isRuntimeProject ? 'bg-green-500 text-white hover:bg-green-400' : 'bg-emerald-500 text-white hover:bg-emerald-400'
                    } disabled:opacity-50`}>
                    {deploying ? <Loader2 size={12} className="animate-spin" /> :
                     deployStatus === 'success' ? <CheckCircle size={12} /> :
                     deployStatus === 'failed' ? <AlertCircle size={12} /> :
                     isRuntimeProject ? <Play size={12} /> : <Upload size={12} />}
                    {deployStatus === 'success' ? (isRuntimeProject ? 'Running!' : 'Deployed!') : 
                     deployStatus === 'failed' ? 'Failed' : 
                     isRuntimeProject ? 'Run' : 'Deploy'}
                  </button>
                  
                  {/* Download buttons */}
                  <div className="flex gap-1">
                    <button onClick={() => downloadProject('full')} title="Full backup - everything included"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs transition-colors border border-emerald-500/20">
                      <Download size={12} />
                    </button>
                    <button onClick={() => downloadProject('clean')} title="Clean - no junk files, comments preserved"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 text-xs transition-colors border border-yellow-500/20">
                      <Download size={12} />
                    </button>
                    <button onClick={() => downloadProject('stripped')} title="Stripped - no junk files, no comments"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs transition-colors border border-red-500/20">
                      <Download size={12} />
                    </button>
                  </div>
                  {currentProject?.deployedUrl && (
                    <a href={currentProject.deployedUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:text-white text-xs transition-colors">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </>
              )}
              {selectedProject && (
                <button onClick={() => agentChatOpen ? closeAgentChat() : openAgentChat()}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${agentChatOpen ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20'}`}>
                  <Bot size={12} /> Agent
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Project List & File Tree */}
        {/* Mobile sidebar backdrop */}
        <AnimatePresence>
          {isMobile && sidebarVisible && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-30 md:hidden"
              onClick={() => setSidebarVisible(false)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {sidebarVisible && (
            <motion.div
              initial={{ width: 0, opacity: 0, ...(isMobile ? { x: -280 } : {}) }}
              animate={{ width: isMobile ? 280 : 224, opacity: 1, ...(isMobile ? { x: 0 } : {}) }}
              exit={{ width: 0, opacity: 0, ...(isMobile ? { x: -280 } : {}) }}
              transition={{ duration: 0.15, ...(isMobile ? { type: 'spring', damping: 25 } : {}) }}
              className={`border-r border-white/5 flex flex-col flex-shrink-0 overflow-hidden bg-[#080B20]/95 ${
                isMobile ? 'fixed left-0 top-0 bottom-0 z-40' : ''
              }`}
            >
              <div className="p-2 border-b border-white/5 flex items-center justify-between">
                <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider px-1">Projects</span>
                <div className="flex gap-0.5">
                  <button onClick={() => { setShowCreate(true); setNewName(''); setCloneUrl(''); setZipFile(null); setUploadProgress(null); }} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-500 hover:text-emerald-400 transition-colors" title="New Project">
                    <Plus size={14} />
                  </button>
                  <button onClick={() => setShowFileSearch(true)} className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-white transition-colors" title="Search files (Ctrl+P)">
                    <Search size={11} />
                  </button>
                  <button onClick={loadProjects} className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-white transition-colors" title="Refresh">
                    <RefreshCw size={11} />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {loading ? (
                  <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
                ) : projects.length === 0 ? (
                  <div className="text-center py-8 px-4">
                    <Globe size={32} className="mx-auto mb-2 text-slate-600" />
                    <p className="text-slate-500 text-xs">No projects yet</p>
                    <button onClick={() => setShowCreate(true)} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300">Create one →</button>
                  </div>
                ) : (
                  <div className="p-1 space-y-0.5">
                    {projects.map(p => (
                      <div key={p.name} className="group">
                        {renamingProject === p.name ? (
                          <div className="flex items-center gap-1 px-2 py-1">
                            <Globe size={13} className="flex-shrink-0 text-emerald-400" />
                            <input
                              autoFocus
                              value={renameProjectValue}
                              onChange={e => setRenameProjectValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') submitRenameProject(); if (e.key === 'Escape') setRenamingProject(null); }}
                              onBlur={() => submitRenameProject()}
                              className="flex-1 min-w-0 bg-white/10 border border-emerald-500/30 rounded px-1.5 py-0.5 text-xs text-white outline-none focus:border-emerald-400/50"
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => selectProject(p.name)}
                            onDoubleClick={(e) => { e.preventDefault(); startRenameProject(p.name); }}
                            className={`flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-lg transition-colors ${
                              selectedProject === p.name ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'text-slate-300 hover:bg-white/5'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 truncate min-w-0">
                              <Globe size={13} className="flex-shrink-0" />
                              <span className="truncate">{p.name}</span>
                              {p.deployedUrl && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" title="Deployed" />}
                              {p.currentBranch && p.currentBranch !== 'main' && p.currentBranch !== 'master' && (
                                <span className="text-[9px] text-orange-400/60 flex-shrink-0">⌥ {p.currentBranch}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); startRenameProject(p.name); }}
                                className="p-0.5 hover:text-emerald-300 transition-all"
                                title="Rename project"
                              >
                                <Edit3 size={11} />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); requestDeleteProject(p.name); }}
                                className="p-0.5 hover:text-red-400 transition-all"
                                title="Delete project"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* File Tree */}
                {selectedProject && tree.length > 0 && (
                  <>
                    <div className="p-2 border-t border-white/5 flex items-center justify-between">
                      <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider px-1">Files</span>
                      <div className="flex gap-0.5">
                        <button onClick={() => { setShowNewFile(true); setNewFileIsDir(false); }} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white" title="New File"><FilePlus size={12} /></button>
                        <button onClick={() => { setShowNewFile(true); setNewFileIsDir(true); }} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white" title="New Folder"><FolderPlus size={12} /></button>
                        <button onClick={() => openUploadDialog()} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-emerald-400" title="Upload Files"><Upload size={12} /></button>
                        <button onClick={refreshTree} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white" title="Refresh"><RefreshCw size={12} /></button>
                      </div>
                    </div>
                    <div className="px-1 pb-2">
                      {renderTree(tree)}
                    </div>
                  </>
                )}
              </div>

              {/* Keyboard shortcuts hint */}
              <div className="p-2 border-t border-white/5 text-[9px] text-slate-600 space-y-0.5">
                <div className="flex justify-between"><span>Save</span><kbd className="px-1 rounded bg-white/5">⌘S</kbd></div>
                <div className="flex justify-between"><span>Fullscreen</span><kbd className="px-1 rounded bg-white/5">⌘⇧F</kbd></div>
                <div className="flex justify-between"><span>Search</span><kbd className="px-1 rounded bg-white/5">⌘P</kbd></div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {selectedDiff ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                <Diff size={12} className="text-orange-400" />
                <span className="text-slate-300">{selectedDiff.file ? `Diff: ${selectedDiff.file}` : 'Diff'}</span>
                <button onClick={() => setSelectedDiff(null)} className="ml-auto text-slate-500 hover:text-white"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-auto bg-[#0a0e1a]">{renderDiff(selectedDiff.content)}</div>
            </>
          ) : commitDiff ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                <History size={12} className="text-blue-400" />
                <span className="text-slate-300">Commit: {commitDiff.hash.substring(0, 8)}</span>
                <button onClick={() => setCommitDiff(null)} className="ml-auto text-slate-500 hover:text-white"><X size={14} /></button>
              </div>
              <div className="p-3 border-b border-white/5 text-xs text-slate-400 bg-white/[0.01]">
                <pre className="font-mono whitespace-pre-wrap">{commitDiff.output}</pre>
              </div>
              <div className="flex-1 overflow-auto bg-[#0a0e1a]">{renderDiff(commitDiff.diff)}</div>
            </>
          ) : openMedia ? (
            /* Media Preview */
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                {openMedia.category === 'image' ? <Image size={12} className="text-blue-400" /> :
                 openMedia.category === 'video' ? <Film size={12} className="text-purple-400" /> :
                 openMedia.category === 'audio' ? <Music size={12} className="text-pink-400" /> :
                 openMedia.category === 'pdf' ? <FileText size={12} className="text-red-400" /> :
                 openMedia.category === 'excel' ? <FileText size={12} className="text-emerald-400" /> :
                 openMedia.category === 'text' ? <FileCode size={12} className="text-cyan-400" /> :
                 <FileQuestion size={12} className="text-slate-400" />}
                <span className="text-slate-300">{openMedia.path.split('/').pop()}</span>
                <span className="text-[10px] text-slate-600 bg-white/5 px-1.5 py-0.5 rounded">{openMedia.category}</span>
                {openMedia.note && <span className="text-[10px] text-amber-300/80 ml-1">{openMedia.note}</span>}
              </div>
              <div className="flex-1 flex overflow-hidden">
                {openMedia.category === 'image' && <ProjectImageViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'audio' && <ProjectAudioViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'video' && <ProjectVideoViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'pdf' && <ProjectPdfViewer src={openMedia.url} />}
                {openMedia.category === 'excel' && <ProjectExcelViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'text' && <ProjectTextPreviewViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'binary' && <ProjectBinaryViewer name={openMedia.path.split('/').pop() || ''} src={openMedia.url} />}
              </div>
            </>
          ) : openFile ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                <FileCode size={12} className="text-slate-400" />
                {renderBreadcrumbs(openFile.path)}
                {modified && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="Unsaved changes" />}
                <div className="ml-auto flex items-center gap-2 text-[10px] text-slate-600">
                  <span className="text-[9px] text-slate-600 bg-white/5 px-1.5 py-0.5 rounded">auto-save</span>
                  <span>{openFile.language}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">⌘S</kbd>
                </div>
              </div>
              <div className="flex-1 flex overflow-hidden">
                <div className={`${showPreview ? 'w-1/2' : 'w-full'} flex-shrink-0`}>
                  {editorElement}
                </div>
                {showPreview && (
                  <div className="w-1/2 border-l border-white/5 bg-white overflow-auto">
                    <iframe
                      srcDoc={(() => {
                        if (openFile.language === 'html') {
                          return editorContent;
                        } else if (openFile.language === 'markdown') {
                          // Configure marked for GFM
                          marked.setOptions({
                            gfm: true,
                            breaks: true,
                          });
                          const rawHtml = marked.parse(editorContent) as string;
                          const safeHtml = DOMPurify.sanitize(rawHtml);
                          
                          return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
      line-height: 1.6;
      color: #e2e8f0;
      background: #0a0a0a;
      padding: 3rem;
      max-width: 56rem;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 { font-weight: 700; color: #fff; margin-top: 2rem; margin-bottom: 1rem; }
    h1 { font-size: 2.25rem; border-bottom: 2px solid rgba(255,255,255,0.1); padding-bottom: 0.5rem; }
    h2 { font-size: 1.875rem; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 0.5rem; margin-top: 3rem; }
    h3 { font-size: 1.5rem; margin-top: 2rem; }
    h4 { font-size: 1.25rem; }
    h5 { font-size: 1.125rem; }
    h6 { font-size: 1rem; }
    p { margin-bottom: 1rem; color: #cbd5e1; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; color: #fff; }
    em { font-style: italic; }
    code {
      background: rgba(255,255,255,0.05);
      color: #34d399;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: 'Courier New', monospace;
      font-size: 0.875em;
    }
    pre {
      background: #0d1117;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 0.5rem;
      padding: 1rem;
      overflow-x: auto;
      margin: 1rem 0;
    }
    pre code {
      background: none;
      color: #e2e8f0;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid rgba(96, 165, 250, 0.3);
      background: rgba(96, 165, 250, 0.05);
      padding: 0.5rem 1rem;
      margin: 1rem 0;
      font-style: normal;
      color: #cbd5e1;
    }
    ul, ol { margin: 1rem 0; padding-left: 2rem; color: #cbd5e1; }
    li { margin: 0.5rem 0; }
    li::marker { color: #64748b; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 0.5rem;
      overflow: hidden;
    }
    thead {
      background: rgba(255,255,255,0.05);
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    th {
      padding: 0.75rem 1rem;
      text-align: left;
      font-weight: 600;
      color: #fff;
    }
    td {
      padding: 0.75rem 1rem;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 0.5rem;
      border: 1px solid rgba(255,255,255,0.1);
      margin: 1rem 0;
    }
    hr {
      border: none;
      border-top: 1px solid rgba(255,255,255,0.1);
      margin: 2rem 0;
    }
    input[type="checkbox"] {
      margin-right: 0.5rem;
      accent-color: #34d399;
    }
  </style>
</head>
<body>
  ${safeHtml}
</body>
</html>`;
                        } else {
                          return `<pre style="padding:16px;font-family:monospace;white-space:pre-wrap;background:#1a1a2e;color:#e2e8f0;margin:0;min-height:100vh">${editorContent.replace(/</g, '&lt;')}</pre>`;
                        }
                      })()}
                      className="w-full h-full border-0"
                      sandbox="allow-scripts"
                      title="Preview"
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <div className="text-center">
                <Rocket size={48} className="mx-auto mb-4 opacity-20" />
                <p className="text-sm font-medium mb-1">{selectedProject ? 'Select a file to edit or preview' : 'Select or create a project'}</p>
                <p className="text-xs text-slate-600">
                  {selectedProject ? 'Click any file in the tree to open it' : 'Choose from the sidebar or click New'}
                </p>
                {selectedProject && (
                  <div className="mt-4 flex items-center justify-center gap-3 text-[10px] text-slate-600">
                    <span className="flex items-center gap-1"><Command size={10} />P — Search files</span>
                    <span className="flex items-center gap-1"><Command size={10} />B — Toggle sidebar</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Git / AI / Share / Activity */}
        <AnimatePresence>
          {activePanel === 'git' && selectedProject && (
            <motion.div
              initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              animate={isMobile ? { opacity: 1, x: 0 } : { width: 340, opacity: 1 }}
              exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={isMobile
                ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
                : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/50'}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><GitBranch size={13} className="text-orange-400" /> Git</span>
                <div className="flex items-center gap-1">
                  {gitLoading && <Loader2 size={12} className="animate-spin text-slate-500" />}
                  <button onClick={() => setActivePanel(null)} className="text-slate-500 hover:text-white p-0.5"><X size={14} /></button>
                </div>
              </div>
              
              <div className="flex border-b border-white/5">
                {[
                  { id: 'changes' as const, label: 'Changes', icon: Circle },
                  { id: 'log' as const, label: 'History', icon: History },
                  { id: 'branches' as const, label: 'Branches', icon: GitBranch },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setGitTab(tab.id)}
                    className={`flex-1 flex items-center justify-center gap-1 py-2 text-[11px] transition-colors border-b-2 ${
                      gitTab === tab.id ? 'text-orange-400 border-orange-400' : 'text-slate-500 border-transparent hover:text-slate-300'
                    }`}
                  >
                    <tab.icon size={11} />
                    {tab.label}
                    {tab.id === 'changes' && gitStatus && gitStatus.files.length > 0 && (
                      <span className="ml-1 w-4 h-4 rounded-full bg-orange-500/20 text-orange-400 text-[9px] flex items-center justify-center">
                        {gitStatus.files.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-auto">
                {gitTab === 'changes' && (
                  <div className="p-3 space-y-3">
                    {gitStatus && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] flex items-center gap-1 text-slate-400">
                          <GitBranch size={11} /> {gitStatus.branch}
                          {gitStatus.ahead > 0 && <span className="text-emerald-400 ml-1">↑{gitStatus.ahead}</span>}
                          {gitStatus.behind > 0 && <span className="text-blue-400 ml-1">↓{gitStatus.behind}</span>}
                        </span>
                        <div className="flex gap-1">
                          <button onClick={gitPull} className="p-1.5 rounded bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white" title="Pull"><ArrowDown size={12} /></button>
                          <button onClick={gitPush} className="p-1.5 rounded bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white" title="Push"><ArrowUp size={12} /></button>
                          <button onClick={loadGitStatus} className="p-1.5 rounded bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white" title="Refresh"><RefreshCw size={12} /></button>
                        </div>
                      </div>
                    )}
                    {gitStatus?.clean ? (
                      <div className="text-center py-6 text-slate-500 text-xs">
                        <Check size={24} className="mx-auto mb-2 text-emerald-400/50" />
                        <p>Working tree clean</p>
                      </div>
                    ) : gitStatus?.files.map(f => (
                      <div key={f.path} className="group flex items-center gap-1.5 py-1 text-xs">
                        <span className={`font-mono font-bold w-4 text-center ${gitStatusColor(f.status)}`}>{gitStatusIcon(f.status)}</span>
                        <button onClick={() => viewFileDiff(f.path)} className="flex-1 text-left text-slate-300 hover:text-white truncate">{f.path}</button>
                        {f.status !== 'untracked' && (
                          <button onClick={() => resetFile(f.path)} className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-600 hover:text-amber-400" title="Discard changes"><Undo2 size={11} /></button>
                        )}
                      </div>
                    ))}
                    {gitStatus && !gitStatus.clean && (
                      <div className="border-t border-white/5 pt-3">
                        <textarea value={commitMsg} onChange={e => setCommitMsg(e.target.value)} placeholder="Commit message..."
                          rows={2} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 resize-none focus:border-orange-500/30 focus:outline-none" />
                        <button onClick={commitChanges} disabled={!commitMsg.trim() || gitLoading}
                          className="mt-1.5 w-full py-2 rounded-lg bg-orange-500/10 text-orange-400 text-[11px] hover:bg-orange-500/20 flex items-center justify-center gap-1.5 disabled:opacity-30 font-medium transition-colors">
                          <GitCommit size={12} /> Commit All Changes
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {gitTab === 'log' && (
                  <div>
                    {/* Branch filter */}
                    <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                      <GitBranch size={11} className="text-slate-500" />
                      <select value={logBranchFilter} onChange={e => { setLogBranchFilter(e.target.value); setTimeout(loadCommitLog, 50); }}
                        className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-orange-500/30">
                        <option value="">All branches</option>
                        {branches.filter(b => !b.remote).map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
                        <option value="main">main</option>
                      </select>
                    </div>
                    <div className="divide-y divide-white/5">
                      {enhancedCommits.length === 0 && commitLog.length === 0 ? (
                        <div className="text-center py-8 text-slate-500 text-xs">No commits yet</div>
                      ) : (enhancedCommits.length > 0 ? enhancedCommits : []).map(c => {
                        const isExpanded = expandedCommit === c.hash;
                        const maxBar = Math.max(...c.stats.files.map(f => f.additions + f.deletions), 1);
                        return (
                          <div key={c.hash} className={`transition-colors ${isExpanded ? 'bg-white/[0.03]' : ''}`}>
                            <button onClick={() => setExpandedCommit(isExpanded ? null : c.hash)}
                              className="w-full text-left px-3 py-2.5 hover:bg-white/5 transition-colors">
                              <div className="flex items-center gap-2 mb-1">
                                <CheckCircle size={12} className="text-emerald-400/70 flex-shrink-0" />
                                <span className="text-xs text-slate-200 font-medium truncate flex-1">{c.message}</span>
                                <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded flex-shrink-0">{c.short}</span>
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-slate-500 ml-5">
                                <span title={new Date(c.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' })}>
                                  📅 {c.relativeDate}
                                </span>
                                <span>👤 {c.author}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-1 ml-5">
                                {c.refs && c.refs.split(',').filter(Boolean).map(ref => (
                                  <span key={ref.trim()} className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
                                    🌿 {ref.trim()}
                                  </span>
                                ))}
                                {c.stats.filesChanged > 0 && (
                                  <span className="text-[10px] text-slate-500">
                                    <span className="text-emerald-400">+{c.stats.insertions}</span>
                                    {' '}<span className="text-red-400">-{c.stats.deletions}</span>
                                    {' '}({c.stats.filesChanged} file{c.stats.filesChanged !== 1 ? 's' : ''})
                                  </span>
                                )}
                              </div>
                            </button>
                            
                            {/* Expanded details */}
                            {isExpanded && (
                              <div className="px-3 pb-3 space-y-2">
                                {/* File stats bars */}
                                {c.stats.files.length > 0 && (
                                  <div className="bg-white/[0.02] rounded-lg p-2 space-y-1.5">
                                    {c.stats.files.map(f => {
                                      const total = f.additions + f.deletions;
                                      const addWidth = maxBar > 0 ? (f.additions / maxBar) * 100 : 0;
                                      const delWidth = maxBar > 0 ? (f.deletions / maxBar) * 100 : 0;
                                      return (
                                        <div key={f.path} className="flex items-center gap-2 text-[10px]">
                                          <span className="text-slate-400 truncate flex-1 min-w-0 font-mono">{f.path}</span>
                                          <span className="text-emerald-400 w-8 text-right">+{f.additions}</span>
                                          <span className="text-red-400 w-8 text-right">-{f.deletions}</span>
                                          <div className="w-20 h-2 bg-white/5 rounded-full overflow-hidden flex flex-shrink-0">
                                            <div className="h-full bg-emerald-500/60" style={{ width: `${addWidth}%` }} />
                                            <div className="h-full bg-red-500/60" style={{ width: `${delWidth}%` }} />
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                
                                {/* Action buttons */}
                                <div className="flex gap-2">
                                  <button onClick={(e) => { e.stopPropagation(); viewCommitDiff(c.hash); }}
                                    className="flex-1 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-[10px] hover:bg-blue-500/20 flex items-center justify-center gap-1 transition-colors">
                                    <Diff size={11} /> View Diff
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); setRevertTarget(c); }}
                                    className="flex-1 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 text-[10px] hover:bg-amber-500/20 flex items-center justify-center gap-1 transition-colors">
                                    <Undo2 size={11} /> Revert
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {/* Fallback for basic commits when enhanced not available */}
                      {enhancedCommits.length === 0 && commitLog.map(c => (
                        <button key={c.hash} onClick={() => viewCommitDiff(c.hash)}
                          className={`w-full text-left px-3 py-2.5 hover:bg-white/5 transition-colors ${commitDiff?.hash === c.hash ? 'bg-white/5' : ''}`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{c.short}</span>
                            <span className="text-[10px] text-slate-600">{timeAgo(c.date)}</span>
                          </div>
                          <p className="text-xs text-slate-300 truncate">{c.message}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5">{c.author}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {gitTab === 'branches' && (
                  <div className="p-3 space-y-3">
                    <div className="flex gap-1.5">
                      <input value={newBranchName} onChange={e => setNewBranchName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createBranch()}
                        placeholder="New branch name..." className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-orange-500/30 focus:outline-none" />
                      <button onClick={createBranch} disabled={!newBranchName.trim()} className="px-3 py-2 rounded-lg bg-orange-500/10 text-orange-400 text-xs hover:bg-orange-500/20 disabled:opacity-30"><Plus size={12} /></button>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-[10px] text-slate-600 uppercase tracking-wider mb-1">Local</div>
                      {branches.filter(b => !b.remote).map(b => (
                        <button key={b.name} onClick={() => !b.current && switchBranch(b.name)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${b.current ? 'bg-orange-500/10 text-orange-400' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
                          <GitBranch size={12} />
                          <span className="truncate">{b.name}</span>
                          {b.current && <Check size={12} className="ml-auto" />}
                        </button>
                      ))}
                      {branches.some(b => b.remote) && (
                        <>
                          <div className="text-[10px] text-slate-600 uppercase tracking-wider mt-3 mb-1">Remote</div>
                          {branches.filter(b => b.remote).map(b => (
                            <button key={b.name} onClick={() => switchBranch(b.name.replace('origin/', ''))}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-slate-500 hover:bg-white/5 hover:text-slate-300 transition-colors">
                              <Globe size={12} />
                              <span className="truncate">{b.name}</span>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* AI Panel */}
          {activePanel === 'ai' && (
            <motion.div
              initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              animate={isMobile ? { opacity: 1, x: 0 } : { width: 340, opacity: 1 }}
              exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={isMobile
                ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
                : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/50'}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Bot size={13} className="text-purple-400" /> Agent AI</span>
                <button onClick={() => setActivePanel(null)} className="text-slate-500 hover:text-white p-0.5"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-auto p-3">
                {aiResponse && (
                  <div className="text-xs text-slate-300 bg-purple-500/5 border border-purple-500/10 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">{aiResponse}</div>
                )}
                {aiLoading && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-purple-400" /></div>}
              </div>
              <div className="p-3 border-t border-white/5">
                <div className="flex gap-2">
                  <input value={aiMessage} onChange={e => setAiMessage(e.target.value)} onKeyDown={e => e.key === 'Enter' && askAI()}
                    placeholder="Ask about your code..." className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-purple-500/30 focus:outline-none" />
                  <button onClick={askAI} disabled={aiLoading || !aiMessage.trim()}
                    className="p-2 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 disabled:opacity-30 transition-colors"><Send size={14} /></button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Analysis Results Panel */}
          {showAnalysisPanel && (
            <motion.div
              initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              animate={isMobile ? { opacity: 1, x: 0 } : { width: 380, opacity: 1 }}
              exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={isMobile
                ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
                : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/50'}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Zap size={13} className="text-purple-400" /> Analysis Results</span>
                <button onClick={() => setShowAnalysisPanel(false)} className="text-slate-500 hover:text-white p-0.5"><X size={14} /></button>
              </div>
              {analyzing && (
                <div className="h-1 bg-white/10 overflow-hidden">
                  <div className="h-full bg-purple-500 animate-pulse" style={{ width: '100%' }} />
                </div>
              )}
              <div className="flex-1 overflow-auto p-3 space-y-2">
                {analyzing && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-purple-400" /></div>}
                {!analyzing && analysisResults.length === 0 && (
                  <div className="text-center py-8 text-xs text-slate-500">No issues found ✨</div>
                )}
                {analysisResults.map((issue: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-lg bg-white/5 border border-white/10">
                    <div className="flex items-start gap-2 mb-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                        issue.severity === 'error' ? 'bg-red-500/20 text-red-400' :
                        issue.severity === 'warning' ? 'bg-amber-500/20 text-amber-400' :
                        'bg-blue-500/20 text-blue-400'
                      }`}>{issue.severity}</span>
                      {issue.line && <span className="text-[10px] text-slate-500">Line {issue.line}</span>}
                    </div>
                    <p className="text-xs text-slate-200 mb-1">{issue.message}</p>
                    {issue.suggestion && <p className="text-[11px] text-slate-400 mb-2">{issue.suggestion}</p>}
                    {issue.code && (
                      <div className="mb-2">
                        <pre className="text-[10px] bg-black/30 rounded p-2 text-emerald-300 overflow-x-auto">{issue.code}</pre>
                      </div>
                    )}
                    <div className="flex gap-2">
                      {(issue.code || issue.suggestion) && issue.line && (
                        <button onClick={() => acceptFix({ ...issue, code: issue.code || issue.suggestion })}
                          className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 text-[10px] hover:bg-emerald-500/30 transition-colors font-medium">
                          <Check className="w-3 h-3" />
                          Apply Fix
                        </button>
                      )}
                      <button onClick={() => dismissIssue(idx)}
                        className="px-2 py-1 rounded bg-slate-500/20 text-slate-400 text-[10px] hover:bg-slate-500/30 transition-colors">
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Activity Panel */}
          {activePanel === 'activity' && selectedProject && (
            <motion.div
              initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              animate={isMobile ? { opacity: 1, x: 0 } : { width: 340, opacity: 1 }}
              exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={isMobile
                ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
                : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/50'}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Activity size={13} className="text-cyan-400" /> Activity</span>
                <div className="flex items-center gap-1">
                  <button onClick={loadActivity} className="text-slate-500 hover:text-white p-0.5"><RefreshCw size={12} /></button>
                  <button onClick={() => setActivePanel(null)} className="text-slate-500 hover:text-white p-0.5"><X size={14} /></button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {activityLogs.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-xs">
                    <Activity size={24} className="mx-auto mb-2 opacity-30" />
                    <p>No activity yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/5">
                    {activityLogs.map(log => (
                      <div key={log.id} className="px-3 py-2.5 flex items-start gap-2.5">
                        <div className="mt-0.5">{activityIcon(log.action)}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-slate-300">{activityLabel(log.action)}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5">{timeAgo(log.createdAt)}</p>
                        </div>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                          log.severity === 'ERROR' ? 'bg-red-500/10 text-red-400' :
                          log.severity === 'WARN' ? 'bg-amber-500/10 text-amber-400' :
                          'bg-emerald-500/10 text-emerald-400'
                        }`}>{log.severity}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* Share Panel */}
          {activePanel === 'share' && selectedProject && (
            <motion.div
              initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              animate={isMobile ? { opacity: 1, x: 0 } : { width: 340, opacity: 1 }}
              exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={isMobile
                ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
                : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/50'}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Share2 size={13} className="text-violet-400" /> Share & Hosting</span>
                <button onClick={() => setActivePanel(null)} className="text-slate-500 hover:text-white p-0.5"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-auto p-3 space-y-4">
                {currentProject?.deployedUrl && (
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3">
                    <div className="text-[10px] text-emerald-400 uppercase font-medium mb-2 flex items-center gap-1"><Globe size={10} /> Live URL</div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-[11px] text-emerald-300 bg-black/30 px-2 py-1.5 rounded truncate">
                        {window.location.origin}{currentProject.deployedUrl}
                      </code>
                      <button onClick={() => copyToClipboard(window.location.origin + currentProject.deployedUrl, 'hosted')}
                        className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                        {copiedId === 'hosted' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                      <a href={currentProject.deployedUrl} target="_blank" rel="noopener noreferrer"
                        className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                )}
                {!currentProject?.deployedUrl && (
                  <div className="text-center py-4 text-slate-500 text-xs">
                    <Upload size={24} className="mx-auto mb-2 opacity-50" />
                    <p>Deploy your project first to get a hosted URL and create share links</p>
                  </div>
                )}
                {currentProject?.deployedUrl && (
                  <>
                    {/* Create new share link */}
                    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-3">
                      <div className="text-[10px] text-slate-500 uppercase font-medium tracking-wider">New Share Link</div>
                      <div className="flex gap-2">
                        <button onClick={() => setShareIsPublic(true)}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-medium transition-all ${
                            shareIsPublic ? 'bg-green-500/10 text-green-400 border border-green-500/30' : 'bg-white/5 text-slate-500 border border-white/10'
                          }`}>
                          <Globe size={12} /> Public
                        </button>
                        <button onClick={() => setShareIsPublic(false)}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-medium transition-all ${
                            !shareIsPublic ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-white/5 text-slate-500 border border-white/10'
                          }`}>
                          <Lock size={12} /> Password
                        </button>
                      </div>
                      {!shareIsPublic && (
                        <div className="space-y-2">
                          <input type="password" value={sharePassword} onChange={e => setSharePassword(e.target.value)}
                            placeholder="Password (min 8 chars)"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-amber-500/30 focus:outline-none" />
                          <input type="password" value={sharePasswordConfirm} onChange={e => setSharePasswordConfirm(e.target.value)}
                            placeholder="Confirm password"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-amber-500/30 focus:outline-none" />
                          {sharePassword.length > 0 && sharePassword.length < 8 && (
                            <p className="text-[10px] text-red-400">Min 8 characters ({8 - sharePassword.length} more needed)</p>
                          )}
                          {sharePassword.length >= 8 && sharePassword.length < 12 && (
                            <p className="text-[10px] text-amber-400">Good — 12+ characters recommended</p>
                          )}
                          {sharePassword.length >= 12 && (
                            <p className="text-[10px] text-green-400">Strong password ✓</p>
                          )}
                        </div>
                      )}
                      <button onClick={createShareLink}
                        disabled={!shareIsPublic && (sharePassword.length < 8 || sharePassword !== sharePasswordConfirm)}
                        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-violet-500/10 text-violet-400 text-[11px] hover:bg-violet-500/20 transition-colors disabled:opacity-30 font-medium">
                        <Plus size={11} /> Create {shareIsPublic ? 'Public' : 'Password-Protected'} Link
                      </button>
                    </div>

                    {/* Existing share links */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-500 uppercase font-medium tracking-wider">Share Links</span>
                    </div>
                    {shares.length === 0 ? (
                      <p className="text-xs text-slate-600 text-center py-2">No share links yet</p>
                    ) : (
                      <div className="space-y-2">
                        {shares.map(link => (
                          <div key={link.id} className={`rounded-lg border ${link.isActive ? 'bg-white/[0.02] border-white/5' : 'bg-white/[0.01] border-white/[0.03] opacity-50'}`}>
                            <div className="p-2.5">
                              <div className="flex items-center gap-2 mb-1.5">
                                {link.isPublic ? (
                                  <Globe size={11} className="text-green-400 flex-shrink-0" />
                                ) : (
                                  <Lock size={11} className="text-amber-400 flex-shrink-0" />
                                )}
                                <code className="text-[10px] text-slate-400 truncate flex-1">/share/{link.token}</code>
                                {/* Email button */}
                                {link.isActive && (
                                  <button
                                    onClick={() => {
                                      if (emailingLinkId === link.id) {
                                        setEmailingLinkId(null);
                                        setShareEmailInput('');
                                        setShareEmailPassword('');
                                      } else {
                                        setEmailingLinkId(link.id);
                                        setShareEmailInput('');
                                        setShareEmailPassword('');
                                      }
                                    }}
                                    className={`p-1 rounded hover:bg-white/5 transition ${emailingLinkId === link.id ? 'text-violet-400' : 'text-slate-500 hover:text-violet-400'}`}
                                    title="Send via email"
                                  >
                                    <Mail size={10} />
                                  </button>
                                )}
                                <button onClick={() => copyToClipboard(`${window.location.origin}/share/${link.token}`, link.id)}
                                  className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white">
                                  {copiedId === link.id ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                                </button>
                              </div>
                              <div className="flex items-center gap-2 mb-1.5 text-[10px]">
                                <span className={link.isPublic ? 'text-green-400/70' : 'text-amber-400/70'}>
                                  {link.isPublic ? 'Public' : 'Password-Protected'}
                                </span>
                                <span className="text-slate-700">•</span>
                                <span className="text-slate-600">{link.currentUses} views{link.maxUses ? ` / ${link.maxUses} max` : ''}</span>
                              </div>
                              <div className="flex items-center justify-between text-[10px] text-slate-600">
                                <span>{timeAgo(link.createdAt)}</span>
                                <div className="flex items-center gap-3">
                                  {link.isActive && !link.isPublic && (
                                    <button onClick={() => setConfirmPublicId(link.id)} className="text-green-400/60 hover:text-green-400">Make Public</button>
                                  )}
                                  <button onClick={() => toggleShareActive(link.id)}
                                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition ${
                                      link.isActive
                                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                                        : 'bg-slate-500/20 text-slate-400 hover:bg-slate-500/30'
                                    }`}>
                                    {link.isActive ? 'Active' : 'Disabled'}
                                  </button>
                                  <button onClick={() => setPendingDeleteShare(link.id)}
                                    className="text-red-400/40 hover:text-red-400 transition" title="Delete permanently">
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* Email form — inline accordion */}
                            {emailingLinkId === link.id && (
                              <div className="border-t border-white/5 px-2.5 pb-2.5 pt-2">
                                <p className="text-[10px] text-violet-400/80 font-medium mb-2 flex items-center gap-1">
                                  <Mail size={9} /> Send this link via email
                                </p>
                                <div className="space-y-1.5">
                                  <input
                                    type="email"
                                    placeholder="Recipient email address"
                                    value={shareEmailInput}
                                    onChange={e => setShareEmailInput(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && sendShareEmail(link.id, !link.isPublic)}
                                    className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/50"
                                  />
                                  {!link.isPublic && (
                                    <input
                                      type="text"
                                      placeholder="Password to include in email (optional)"
                                      value={shareEmailPassword}
                                      onChange={e => setShareEmailPassword(e.target.value)}
                                      className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-amber-500/20 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-amber-500/40"
                                    />
                                  )}
                                  <button
                                    onClick={() => sendShareEmail(link.id, !link.isPublic)}
                                    disabled={!shareEmailInput || shareEmailSending || shareEmailSuccess === link.id}
                                    className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition ${
                                      shareEmailSuccess === link.id
                                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                        : 'bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed'
                                    }`}
                                  >
                                    {shareEmailSuccess === link.id ? (
                                      <><Check size={10} /> Sent!</>
                                    ) : shareEmailSending ? (
                                      <><Loader2 size={10} className="animate-spin" /> Sending…</>
                                    ) : (
                                      <><SendHorizonal size={10} /> Send Email</>
                                    )}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          )}

          {/* Confirm Delete Share Link */}
          <ConfirmDialog
            open={!!pendingDeleteShare}
            title="Delete Share Link"
            message="This will permanently delete the share link. Anyone with this link will no longer be able to access the project."
            confirmLabel="Delete"
            variant="danger"
            icon="trash"
            onConfirm={deleteSharePermanently}
            onCancel={() => setPendingDeleteShare(null)}
          />

          {/* Confirm Make Public Dialog */}
          <ConfirmDialog
            open={!!confirmPublicId}
            title="⚠️ Security Warning"
            message="You are about to make this link PUBLIC. Anyone with the link will be able to access the project WITHOUT a password."
            confirmLabel="Yes, Make Public"
            variant="danger"
            icon="shield"
            onConfirm={async () => {
              if (confirmPublicId && selectedProject) {
                try {
                  await projectsAPI.updateShare(selectedProject, confirmPublicId, { isPublic: true });
                  showToast('Link is now public');
                  await loadShares();
                } catch (err) { showErrorToast(err, 'Making share link public'); }
              }
              setConfirmPublicId(null);
            }}
            onCancel={() => setConfirmPublicId(null)}
          />
        </AnimatePresence>

        {/* Agent Chat Panel — WebSocket streaming */}
        <AnimatePresence>
          {agentChatOpen && selectedProject && (
            <ProjectChatPanel
              key={`project-agent-chat:${selectedProject}`}
              projectName={selectedProject}
              onClose={closeAgentChat}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Floating Agent Button */}
      {selectedProject && !agentChatOpen && (
        <button
          onClick={openAgentChat}
          className="fixed bottom-4 right-4 z-40 w-12 h-12 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shadow-lg shadow-purple-500/10 hover:bg-purple-500/30 transition-colors"
          title="Chat with Agent"
        >
          <Bot size={20} className="text-purple-400" />
        </button>
      )}

      {/* Create Project Dialog */}
      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="glass max-w-md w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">New Project</h3>
                <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-white"><X size={20} /></button>
              </div>

              <div className="flex gap-2">
                {(['template', 'clone', 'zip'] as const).map(mode => (
                  <button key={mode} onClick={() => setCreateMode(mode)}
                    className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${createMode === mode ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-white/5 text-slate-400 border border-white/10'}`}>
                    {mode === 'template' ? 'Template' : mode === 'clone' ? 'Clone Repo' : 'Upload ZIP'}
                  </button>
                ))}
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Project Name</label>
                <input value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createProject()}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:border-emerald-500/30 focus:outline-none"
                  placeholder="my-project" autoFocus />
              </div>

              {createMode === 'template' ? (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Template</label>
                  <div className="grid grid-cols-5 gap-2">
                    {[
                      { id: 'static-html', label: 'HTML', icon: '🌐', desc: 'Static site' },
                      { id: 'react', label: 'React', icon: '⚛️', desc: 'React SPA' },
                      { id: 'node-api', label: 'Node.js', icon: '🟢', desc: 'API server' },
                      { id: 'python', label: 'Python', icon: '🐍', desc: 'Script/app' },
                      { id: 'cpp', label: 'C++', icon: '⚙️', desc: 'Compiled' },
                    ].map(t => (
                      <button key={t.id} onClick={() => setTemplate(t.id)}
                        className={`p-3 rounded-xl text-center text-xs transition-all ${template === t.id ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' : 'bg-white/5 border border-white/10 text-slate-400 hover:border-white/20'}`}>
                        <span className="text-lg block mb-1">{t.icon}</span>
                        {t.label}
                        <span className="block text-[9px] text-slate-600 mt-0.5">{t.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : createMode === 'clone' ? (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Repository URL</label>
                  <input value={cloneUrl} onChange={e => setCloneUrl(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:border-emerald-500/30 focus:outline-none"
                    placeholder="https://git.example.com/user/repo.git" />
                  {cloneUrl && newName && (
                    <p className="text-[10px] text-emerald-400/60 mt-1.5 flex items-center gap-1">
                      <Zap size={10} /> Auto-detected name: <strong>{newName}</strong>
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">ZIP File</label>
                    <label className={`flex items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed cursor-pointer transition-all ${
                      zipFile ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/10 hover:border-emerald-500/20 bg-white/[0.02]'
                    }`}>
                      <input type="file" accept=".zip" className="hidden"
                        onChange={e => { const file = e.target.files?.[0]; if (file) handleZipSelect(file); }} />
                      {zipFile ? (
                        <div className="text-center">
                          <Upload size={20} className="mx-auto mb-1 text-emerald-400" />
                          <span className="text-sm text-emerald-400 font-medium">{zipFile.name}</span>
                          <span className="text-xs text-slate-500 block">{(zipFile.size / 1024 / 1024).toFixed(1)} MB</span>
                        </div>
                      ) : (
                        <div className="text-center">
                          <Upload size={20} className="mx-auto mb-1 text-slate-500" />
                          <span className="text-sm text-slate-400">Click to select ZIP file</span>
                          <span className="text-xs text-slate-600 block">Max 200MB</span>
                        </div>
                      )}
                    </label>
                  </div>
                  {uploadProgress && (
                    <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-3 text-center">
                      <Loader2 size={16} className="animate-spin text-blue-400 mx-auto mb-1" />
                      <p className="text-xs text-blue-400 font-medium">{uploadProgress}</p>
                    </div>
                  )}
                  <div className="bg-white/[0.02] rounded-xl p-3 border border-white/5">
                    <p className="text-[11px] text-slate-500 mb-1.5 font-medium">Auto-detection after upload:</p>
                    <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-600">
                      <span>📦 package.json → Node.js</span>
                      <span>🐍 requirements.txt → Python</span>
                      <span>🦀 Cargo.toml → Rust</span>
                      <span>🐳 Dockerfile → Docker</span>
                      <span>🌐 index.html → Static</span>
                      <span>🔵 go.mod → Go</span>
                    </div>
                  </div>
                </div>
              )}

              <button onClick={createProject}
                disabled={(creating || zipUploading) || !newName.trim() || (createMode === 'zip' && !zipFile) || (createMode === 'clone' && !cloneUrl.trim())}
                className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-2 transition-colors">
                {(creating || zipUploading) && <Loader2 size={16} className="animate-spin" />}
                {createMode === 'clone' ? 'Clone' : createMode === 'zip' ? 'Upload & Create' : 'Create'} Project
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New File Dialog */}
      <AnimatePresence>
        {showNewFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowNewFile(false)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="glass max-w-sm w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold">New {newFileIsDir ? 'Folder' : 'File'}</h3>
              <input value={newFilePath} onChange={e => setNewFilePath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createNewFile()}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:border-emerald-500/30 focus:outline-none"
                placeholder={newFileIsDir ? 'folder-name' : 'filename.ext'} autoFocus />
              <button onClick={createNewFile} disabled={!newFilePath.trim()}
                className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm disabled:opacity-50 transition-colors">
                Create
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload Files Dialog */}
      <AnimatePresence>
        {showUploadDialog && selectedProject && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !uploadingFiles && setShowUploadDialog(false)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="glass max-w-md w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2"><Upload size={16} className="text-emerald-400" /> Upload Files</h3>
                <button onClick={() => !uploadingFiles && setShowUploadDialog(false)} className="text-slate-500 hover:text-white"><X size={16} /></button>
              </div>

              {/* Target directory selector */}
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">Upload to directory</label>
                <select
                  value={uploadTargetPath}
                  onChange={e => setUploadTargetPath(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm focus:border-emerald-500/30 focus:outline-none"
                >
                  <option value="">/ (project root)</option>
                  {collectDirPaths(tree, expandedDirs).filter(d => d).map(d => (
                    <option key={d} value={d}>/{d}</option>
                  ))}
                </select>
              </div>

              {/* Drag and drop zone (react-dropzone for iPad compatibility) */}
              <div
                {...getUploadRootProps()}
                className={`border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer ${
                  uploadIsDragActive
                    ? 'border-emerald-400 bg-emerald-500/10'
                    : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
                }`}
              >
                <input {...getUploadInputProps()} />
                <Upload size={28} className={`mx-auto mb-2 ${uploadIsDragActive ? 'text-emerald-400' : 'text-slate-600'}`} />
                <p className="text-sm text-slate-400">
                  {uploadIsDragActive ? 'Drop files here' : 'Drag & drop files or click to browse'}
                </p>
                <p className="text-[10px] text-slate-600 mt-1">Any file type • Up to 500MB per file</p>
              </div>

              {/* File list */}
              {uploadFiles.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  <div className="text-[10px] text-slate-500 mb-1">{uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''} selected ({(uploadFiles.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB)</div>
                  {uploadFiles.map((file, i) => (
                    <div key={`${file.name}-${i}`} className="flex items-center gap-2 px-2 py-1 rounded bg-white/5 text-xs">
                      <FileText size={12} className="text-slate-500 flex-shrink-0" />
                      <span className="text-slate-300 truncate flex-1">{file.name}</span>
                      <span className="text-[10px] text-slate-600 flex-shrink-0">{(file.size / 1024).toFixed(1)}KB</span>
                      <button
                        onClick={() => setUploadFiles(prev => prev.filter((_, idx) => idx !== i))}
                        className="text-slate-600 hover:text-red-400 flex-shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Upload button */}
              <button
                onClick={handleUploadFiles}
                disabled={uploadingFiles || uploadFiles.length === 0}
                className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
              >
                {uploadingFiles ? <><Loader2 size={16} className="animate-spin" /> Uploading...</> : <><Upload size={16} /> Upload {uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''}</>}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.kind === 'project' ? `⚠️ Delete project "${pendingDelete.name}"?` : `⚠️ Delete ${pendingDelete?.name || 'file'}?`}
        message={pendingDelete?.kind === 'project' ? 'All files, commit history, and deployments will be permanently lost.' : 'This file will be permanently deleted.'}
        detail={pendingDelete?.path}
        confirmLabel="Delete"
        variant="danger"
        icon={pendingDelete?.kind === 'project' ? 'shield' : 'trash'}
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* Revert Confirmation Modal */}
      <AnimatePresence>
        {revertTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => !reverting && setRevertTarget(null)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0d1117] border border-white/10 rounded-xl p-5 max-w-md w-full mx-4 shadow-2xl"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-4">
                <AlertCircle size={20} className="text-amber-400" />
                <h3 className="text-sm font-semibold text-white">Revert Commit?</h3>
              </div>
              
              <div className="bg-white/5 rounded-lg p-3 mb-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{revertTarget.short}</span>
                  <span className="text-xs text-slate-200 font-medium truncate">{revertTarget.message}</span>
                </div>
                <div className="text-[10px] text-slate-500 space-y-0.5">
                  <p>👤 {revertTarget.author} ({revertTarget.email})</p>
                  <p>📅 {new Date(revertTarget.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' })}</p>
                </div>
              </div>

              <div className="text-xs text-slate-400 mb-3">
                <p className="mb-2">This will create a new commit that undoes:</p>
                <div className="bg-white/[0.03] rounded-lg p-2 space-y-1">
                  <p>• {revertTarget.stats.filesChanged} file{revertTarget.stats.filesChanged !== 1 ? 's' : ''} changed</p>
                  <p>• <span className="text-emerald-400">{revertTarget.stats.insertions} insertions</span> / <span className="text-red-400">{revertTarget.stats.deletions} deletions</span> will be reversed</p>
                  {revertTarget.stats.files.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/5">
                      <p className="text-[10px] text-slate-600 mb-1">Files affected:</p>
                      {revertTarget.stats.files.map(f => (
                        <p key={f.path} className="text-[10px] font-mono text-slate-500">- {f.path}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <p className="text-[10px] text-amber-400/70 mb-4">⚠️ This action cannot be undone (but you can revert the revert).</p>

              {revertResult && (
                <div className={`text-xs p-2 rounded mb-3 ${revertResult.success ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                  {revertResult.message}
                </div>
              )}

              <div className="flex gap-2">
                <button onClick={() => { setRevertTarget(null); setRevertResult(null); }} disabled={reverting}
                  className="flex-1 py-2 rounded-lg bg-white/5 text-slate-400 text-xs hover:bg-white/10 transition-colors disabled:opacity-30">
                  Cancel
                </button>
                <button onClick={handleRevert} disabled={reverting || revertResult?.success === true}
                  className="flex-1 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-xs hover:bg-amber-500/30 font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-30">
                  {reverting ? <><Loader2 size={12} className="animate-spin" /> Reverting...</> : <><Undo2 size={12} /> Confirm Revert</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Side-by-Side Diff Viewer Modal */}
      <AnimatePresence>
        {commitDiff && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => setCommitDiff(null)}>
            <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }}
              className="bg-[#0d1117] border border-white/10 rounded-xl max-w-[90vw] w-full max-h-[85vh] mx-4 shadow-2xl flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <Diff size={14} className="text-blue-400" />
                  <span className="text-xs font-medium text-white">Commit Diff</span>
                  <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{commitDiff.hash.substring(0, 7)}</span>
                </div>
                <button onClick={() => setCommitDiff(null)} className="text-slate-500 hover:text-white p-1"><X size={14} /></button>
              </div>
              
              {/* Stats summary */}
              {commitDiff.output && (
                <div className="px-4 py-2 border-b border-white/5 bg-white/[0.02]">
                  <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap">{commitDiff.output}</pre>
                </div>
              )}
              
              {/* Diff content - side by side */}
              <div className="flex-1 overflow-auto">
                {(() => {
                  const diffText = commitDiff.diff || '';
                  // Parse unified diff into file sections
                  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);
                  
                  return fileSections.map((section, idx) => {
                    const lines = section.split('\n');
                    const fileHeader = lines[0] || '';
                    const fileMatch = fileHeader.match(/a\/(.+?) b\/(.+)/);
                    const fileName = fileMatch ? fileMatch[2] : fileHeader;
                    
                    // Extract hunks
                    const oldLines: Array<{ num: number | null; content: string; type: 'context' | 'add' | 'remove' | 'header' }> = [];
                    const newLines: Array<{ num: number | null; content: string; type: 'context' | 'add' | 'remove' | 'header' }> = [];
                    let oldNum = 0, newNum = 0;
                    
                    for (const line of lines.slice(1)) {
                      if (line.startsWith('@@')) {
                        const hunkMatch = line.match(/@@ -(\d+)/);
                        const newMatch = line.match(/\+(\d+)/);
                        if (hunkMatch) oldNum = parseInt(hunkMatch[1]) - 1;
                        if (newMatch) newNum = parseInt(newMatch[1]) - 1;
                        oldLines.push({ num: null, content: line, type: 'header' });
                        newLines.push({ num: null, content: line, type: 'header' });
                      } else if (line.startsWith('+') && !line.startsWith('+++')) {
                        newNum++;
                        oldLines.push({ num: null, content: '', type: 'add' });
                        newLines.push({ num: newNum, content: line.slice(1), type: 'add' });
                      } else if (line.startsWith('-') && !line.startsWith('---')) {
                        oldNum++;
                        oldLines.push({ num: oldNum, content: line.slice(1), type: 'remove' });
                        newLines.push({ num: null, content: '', type: 'remove' });
                      } else if (line.startsWith(' ')) {
                        oldNum++; newNum++;
                        oldLines.push({ num: oldNum, content: line.slice(1), type: 'context' });
                        newLines.push({ num: newNum, content: line.slice(1), type: 'context' });
                      }
                    }
                    
                    if (oldLines.length === 0) return null;
                    
                    return (
                      <div key={idx} className="border-b border-white/5">
                        <div className="px-4 py-1.5 bg-blue-500/5 border-b border-white/5 sticky top-0">
                          <span className="text-[11px] font-mono text-blue-400">{fileName}</span>
                        </div>
                        <div className="flex">
                          {/* Old (left) */}
                          <div className="flex-1 border-r border-white/5 overflow-x-auto">
                            {oldLines.map((l, i) => (
                              <div key={i} className={`flex text-[10px] font-mono leading-5 ${
                                l.type === 'remove' ? 'bg-red-500/10' : l.type === 'add' ? 'bg-transparent' : l.type === 'header' ? 'bg-blue-500/5' : ''
                              }`}>
                                <span className="w-10 text-right pr-2 text-slate-600 select-none flex-shrink-0 border-r border-white/5">
                                  {l.num || ''}
                                </span>
                                <pre className={`px-2 whitespace-pre flex-1 ${
                                  l.type === 'remove' ? 'text-red-300' : l.type === 'header' ? 'text-blue-400' : 'text-slate-400'
                                }`}>{l.content}</pre>
                              </div>
                            ))}
                          </div>
                          {/* New (right) */}
                          <div className="flex-1 overflow-x-auto">
                            {newLines.map((l, i) => (
                              <div key={i} className={`flex text-[10px] font-mono leading-5 ${
                                l.type === 'add' ? 'bg-emerald-500/10' : l.type === 'remove' ? 'bg-transparent' : l.type === 'header' ? 'bg-blue-500/5' : ''
                              }`}>
                                <span className="w-10 text-right pr-2 text-slate-600 select-none flex-shrink-0 border-r border-white/5">
                                  {l.num || ''}
                                </span>
                                <pre className={`px-2 whitespace-pre flex-1 ${
                                  l.type === 'add' ? 'text-emerald-300' : l.type === 'header' ? 'text-blue-400' : 'text-slate-400'
                                }`}>{l.content}</pre>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Progress Notification for deploy/install */}
      <AnimatePresence>
        {progressNotification && (
          <ProgressNotification {...progressNotification} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
