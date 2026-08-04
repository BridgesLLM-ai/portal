import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { copyTextToClipboard } from '../utils/clipboardCopy';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import { filesAPI } from '../api/endpoints';
import client from '../api/client';
import { smartUpload, formatBytes, formatSpeed, formatTime, UploadProgress, UploadController } from '../utils/smartUpload';
import { workspaceAuthorizedFetch } from '../utils/workspaceAuthorizedFetch';
import {
  hasFileDeepLinkParams,
  parseFileDeepLink,
} from '../utils/workspaceNavigation';
import { useAuthStore } from '../contexts/AuthContext';
import { useUploadStore } from '../stores/uploadStore';
import ConfirmDialog from '../components/ConfirmDialog';
import ViewportModal from '../components/ViewportModal';
import ViewportOverlay from '../components/ViewportOverlay';
import { useThumbnails } from '../hooks/useThumbnail';
import sounds from '../utils/sounds';
import {
  Upload, File as FileIcon, Folder, Trash2, Download,
  X, Loader2, Image, FileText, FileCode, Film, Music, Archive,
  Search, Grid3X3, List, AlertCircle, CheckCircle, Info,
  Pause, Play, XCircle, Filter, RefreshCw, Copy
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────
interface FileEntry {
  id: string;
  path: string;
  originalName?: string;
  size: number;
  mimeType?: string;
  visibility: string;
  createdAt: string;
}

interface ActiveUpload {
  id: string;
  file: File;
  progress: UploadProgress | null;
  status: 'uploading' | 'paused' | 'complete' | 'error';
  controller: UploadController;
  error?: string;
  route?: string;
}

interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration?: number;
}

// ─── Helpers ─────────────────────────────────────────────────
const FILE_ICONS: Record<string, typeof FileIcon> = {
  'image/': Image, 'video/': Film, 'audio/': Music,
};
const ARCHIVE_TYPES = ['zip', 'tar', 'compressed', '7z', 'rar', 'gz'];
const CODE_TYPES = ['javascript', 'json', 'html', 'css', 'python', 'typescript', 'xml', 'yaml', 'shell'];

function getFileIcon(mime?: string) {
  if (!mime) return FileIcon;
  for (const [prefix, icon] of Object.entries(FILE_ICONS)) {
    if (mime.startsWith(prefix)) return icon;
  }
  if (ARCHIVE_TYPES.some(t => mime.includes(t))) return Archive;
  if (CODE_TYPES.some(t => mime.includes(t))) return FileCode;
  return FileText;
}

function formatSize(bytes: number) {
  return formatBytes(Number(bytes));
}

function getDisplayName(file: FileEntry): string {
  if (file.originalName) return file.originalName;
  const name = file.path.split('/').pop() || file.path;
  // Strip the timestamp suffix for cleaner display
  return name.replace(/-\d{13}-\d+(?=\.[^.]+$)/, '');
}

const LazyMediaViewer = lazy(() => import('../components/MediaViewer'));

const MIME_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Images', value: 'image/' },
  { label: 'Videos', value: 'video/' },
  { label: 'Audio', value: 'audio/' },
  { label: 'Documents', value: 'application/pdf' },
  { label: 'Archives', value: 'application/zip' },
];
const EMPTY_FILE_IDS: string[] = [];
const FILES_PAGE_SIZE = 100;
const MAX_PROJECT_DIRECTORIES = 250;
const MAX_FILES_PER_DROP = 20;
const MAX_CONCURRENT_UPLOADS = 3;

// ─── Toast Component ─────────────────────────────────────────
function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <ViewportOverlay anchor="bottom-right" zIndex={1200} className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className={`flex items-start gap-3 p-3 rounded-xl border backdrop-blur-xl shadow-2xl ${
              t.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
              t.type === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-300' :
              t.type === 'warning' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' :
              'bg-blue-500/10 border-blue-500/30 text-blue-300'
            }`}
          >
            {t.type === 'success' ? <CheckCircle size={18} className="flex-shrink-0 mt-0.5" /> :
             t.type === 'error' ? <AlertCircle size={18} className="flex-shrink-0 mt-0.5" /> :
             t.type === 'warning' ? <AlertCircle size={18} className="flex-shrink-0 mt-0.5" /> :
             <Info size={18} className="flex-shrink-0 mt-0.5" />}
            <span className="text-sm flex-1">{t.message}</span>
            <button aria-label="Dismiss notification" onClick={() => onDismiss(t.id)} className="text-white/40 hover:text-white/80">
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </ViewportOverlay>
  );
}

// ─── Epic Upload Progress Card ───────────────────────────────
function UploadProgressCard({
  upload,
  onPause,
  onResume,
  onCancel,
}: {
  upload: ActiveUpload;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const p = upload.progress;
  const pct = p ? Math.round(p.percentage) : 0;
  const routeLabel = upload.route === 'chunked' ? '⚡ Chunked' :
    upload.route === 'tailscale' ? '🔒 Tailscale' : '📡 Direct';

  // SVG progress ring
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (pct / 100) * circumference;

  const isActive = upload.status === 'uploading';
  const isPaused = upload.status === 'paused';
  const isError = upload.status === 'error';
  const isComplete = upload.status === 'complete';

  // Get file extension icon
  const ext = upload.file.name.split('.').pop()?.toLowerCase() || '';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      className={`relative overflow-hidden rounded-2xl p-4 border backdrop-blur-xl ${
        isError ? 'bg-red-500/[0.04] border-red-500/20' :
        isComplete ? 'bg-emerald-500/[0.04] border-emerald-500/20' :
        'bg-white/[0.03] border-white/10'
      }`}
    >
      {/* Animated background shimmer */}
      {isActive && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute inset-0 animate-shimmer opacity-30" />
        </div>
      )}

      <div className="flex items-center gap-4 relative z-10">
        {/* Circular progress ring */}
        <div className="relative flex-shrink-0" style={{ width: 88, height: 88 }}>
          <svg width="88" height="88" className={isActive ? 'animate-[progress-ring-pulse_2s_ease-in-out_infinite]' : ''}>
            {/* Background ring */}
            <circle cx="44" cy="44" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
            {/* Progress ring */}
            <circle
              cx="44" cy="44" r={radius}
              fill="none"
              stroke={isError ? '#EF4444' : isPaused ? '#F59E0B' : isComplete ? '#10B981' : 'url(#progressGrad)'}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              transform="rotate(-90 44 44)"
              style={{ transition: 'stroke-dashoffset 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
            />
            {/* Gradient definition */}
            <defs>
              <linearGradient id="progressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#10B981" />
                <stop offset="100%" stopColor="#3B82F6" />
              </linearGradient>
            </defs>
          </svg>
          {/* Center content */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {isComplete ? (
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', damping: 10 }}>
                <CheckCircle size={24} className="text-emerald-400" />
              </motion.div>
            ) : isError ? (
              <AlertCircle size={24} className="text-red-400" />
            ) : (
              <>
                <span className="text-lg font-bold tabular-nums">{pct}%</span>
              </>
            )}
          </div>
          {/* Glow ring behind */}
          {isActive && (
            <div className="absolute inset-0 rounded-full" style={{
              background: 'radial-gradient(circle, rgba(16,185,129,0.1) 60%, transparent 70%)',
              animation: 'progress-shimmer 2s ease-in-out infinite',
            }} />
          )}
        </div>

        {/* File info */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
              <span className="text-[9px] font-bold uppercase text-slate-400">{ext.slice(0, 4)}</span>
            </div>
            <span className="text-sm font-medium truncate">{upload.file.name}</span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="px-1.5 py-0.5 rounded bg-white/5">{routeLabel}</span>
            <span>{formatSize(p?.loaded || 0)} / {formatSize(upload.file.size)}</span>
            {p?.chunksCompleted != null && (
              <span className="text-slate-600">Chunk {p.chunksCompleted}/{p.chunksTotal}</span>
            )}
          </div>

          {/* Speed & ETA */}
          {isActive && p && (
            <div className="flex items-center gap-3 text-[11px]">
              <span className="text-emerald-400 font-medium">{formatSpeed(p.speed)}</span>
              <span className="text-slate-500">ETA {formatTime(p.eta)}</span>
            </div>
          )}
          {isPaused && <span className="text-[11px] text-amber-400 font-medium">⏸ Paused</span>}
          {isError && <span className="text-[11px] text-red-400">{upload.error || 'Upload failed'}</span>}
          {isComplete && <span className="text-[11px] text-emerald-400 font-medium">✓ Upload complete</span>}

          {/* Mini progress bar */}
          <div className="relative h-1.5 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className={`absolute left-0 top-0 h-full rounded-full ${
                isError ? 'bg-red-500' : isPaused ? 'bg-amber-500' : 'bg-gradient-to-r from-emerald-500 to-blue-500'
              }`}
              initial={{ width: '0%' }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
            />
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-1 flex-shrink-0">
          {isActive && upload.route === 'chunked' && (
            <button onClick={onPause} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-amber-400 transition-colors" title="Pause" aria-label={`Pause upload of ${upload.file.name}`}>
              <Pause size={14} />
            </button>
          )}
          {isPaused && upload.route === 'chunked' && (
            <button onClick={onResume} className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-emerald-400 transition-colors" title="Resume" aria-label={`Resume upload of ${upload.file.name}`}>
              <Play size={14} />
            </button>
          )}
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors" title="Cancel" aria-label={`Cancel upload of ${upload.file.name}`}>
            <XCircle size={14} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ──────────────────────────────────────────
export default function FilesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const fileDeepLinkSearch = searchParams.toString();
  const { user } = useAuthStore();
  const fileNavigationBinding = useMemo(() => {
    const authorizationVersion = Number(user?.authorizationVersion ?? 1);
    if (!user?.id || !Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1) return null;
    return { actorUserId: user.id, authorizationVersion };
  }, [user?.authorizationVersion, user?.id]);
  const fileDeepLinkPresent = useMemo(
    () => hasFileDeepLinkParams(fileDeepLinkSearch),
    [fileDeepLinkSearch],
  );
  const fileDeepLink = useMemo(
    () => parseFileDeepLink(fileDeepLinkSearch, fileNavigationBinding),
    [fileDeepLinkSearch, fileNavigationBinding],
  );
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [mimeFilter, setMimeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalFiles, setTotalFiles] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [totalLibrarySize, setTotalLibrarySize] = useState(0);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeUploads, setActiveUploads] = useState<Map<string, ActiveUpload>>(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<
    { type: 'single'; id: string; name: string } | { type: 'batch'; ids: string[] } | null
  >(null);
  const [renaming, setRenaming] = useState<{ id: string; currentName: string } | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const [showExtensions, setShowExtensions] = useState(false);
  const [extensionWarning, setExtensionWarning] = useState<{ oldExt: string; newExt: string } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [copyToProject, setCopyToProject] = useState<{ fileId: string; fileName: string } | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedDirectory, setSelectedDirectory] = useState('');
  const [projectDirectories, setProjectDirectories] = useState<string[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [moveFile, setMoveFile] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  
  const uploadIdRef = useRef(0);
  const loadRequestRef = useRef(0);
  const renameInFlightRef = useRef(false);
  const copyInFlightRef = useRef(false);
  const deleteInFlightRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const extensionCancelButtonRef = useRef<HTMLButtonElement>(null);
  const copyProjectSelectRef = useRef<HTMLSelectElement>(null);

  // Toast helpers
  const addToast = useCallback((type: Toast['type'], message: string, duration = 4000) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, duration }]);
    if (duration > 0) setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    
    // Play appropriate sound
    if (type === 'success') sounds.success();
    else if (type === 'error') sounds.error();
    else if (type === 'info') sounds.notification();
  }, []);
  const dismissToast = useCallback((id: string) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  const loadFiles = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const data = await filesAPI.list({
        page,
        limit: FILES_PAGE_SIZE,
        search: debouncedSearch || undefined,
        mime: mimeFilter || undefined,
      });
      const nextFiles = Array.isArray(data) ? data : data.files || [];
      const nextTotal = Array.isArray(data) ? nextFiles.length : Number(data.total || 0);
      const nextPages = Array.isArray(data) ? 1 : Math.max(1, Number(data.pages || 1));
      if (requestId !== loadRequestRef.current) return;
      if (page > nextPages) {
        setPage(nextPages);
        return;
      }
      setFiles(nextFiles);
      setTotalFiles(nextTotal);
      setTotalPages(nextPages);
      setTotalLibrarySize(Array.isArray(data)
        ? nextFiles.reduce((sum: number, file: FileEntry) => sum + Number(file.size), 0)
        : Number(data.totalSize || 0));
      setSelected(new Set());
    } catch (e) {
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load files:', e);
      addToast('error', 'Failed to load files');
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [addToast, debouncedSearch, mimeFilter, page]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setDebouncedSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const missingDeepLinkRef = useRef<string | null>(null);
  const resolvingDeepLinkRef = useRef<string | null>(null);

  const clearPreviewSearchParams = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    if (!next.has('open') && !next.has('file') && !next.has('path')) return;
    next.delete('open');
    next.delete('file');
    next.delete('path');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (fileDeepLinkPresent && !fileDeepLink) clearPreviewSearchParams();
  }, [clearPreviewSearchParams, fileDeepLink, fileDeepLinkPresent]);

  useEffect(() => {
    if (loading) return;
    if (!fileDeepLinkPresent || !fileDeepLink) {
      missingDeepLinkRef.current = null;
      resolvingDeepLinkRef.current = null;
      return;
    }

    const requestedId = fileDeepLink.fileId;
    const requestedPath = fileDeepLink.path;
    const normalizedRequestedPath = requestedPath?.trim() || '';
    const match = files.find((file) => {
      if (requestedId && file.id === requestedId) return true;
      if (!normalizedRequestedPath) return false;
      // Only a stored relative path can be matched locally. Physical storage
      // paths must pass through the backend's exact actor/root resolver;
      // basename or suffix matching can select the wrong owner's file.
      return file.path === normalizedRequestedPath;
    });

    if (match) {
      missingDeepLinkRef.current = null;
      resolvingDeepLinkRef.current = null;
      setPreview(current => current?.id === match.id ? current : match);
      return;
    }

    const deepLinkKey = `${requestedId || ''}|${requestedPath || ''}`;
    if (resolvingDeepLinkRef.current === deepLinkKey) return;
    resolvingDeepLinkRef.current = deepLinkKey;

    let cancelled = false;
    (async () => {
      try {
        const resolved = await filesAPI.resolve({ id: requestedId || undefined, path: requestedPath || undefined });
        if (cancelled || !resolved?.id) return;
        setFiles(prev => prev.some(file => file.id === resolved.id) ? prev : [resolved, ...prev]);
        missingDeepLinkRef.current = null;
        setPreview(current => current?.id === resolved.id ? current : resolved);
      } catch {
        if (cancelled) return;
        setPreview(current => current ? null : current);
        if (missingDeepLinkRef.current !== deepLinkKey) {
          addToast('info', 'That file could not be found in your Files library.');
          missingDeepLinkRef.current = deepLinkKey;
        }
        clearPreviewSearchParams();
      } finally {
        if (!cancelled && resolvingDeepLinkRef.current === deepLinkKey) {
          resolvingDeepLinkRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    addToast,
    clearPreviewSearchParams,
    fileDeepLink,
    fileDeepLinkPresent,
    files,
    loading,
  ]);

  const globalUploadStore = useUploadStore();

  const onDrop = useCallback(async (accepted: File[]) => {
    const startUpload = (file: File): Promise<void> => {
      const id = `upload-${++uploadIdRef.current}`;

      const { promise, controller } = smartUpload(file, {
        onProgress: (progress) => {
          setActiveUploads(prev => {
            const next = new Map(prev);
            const existing = next.get(id);
            if (existing) {
              next.set(id, { ...existing, progress, status: controller.isPaused() ? 'paused' : 'uploading' });
            }
            return next;
          });
          // Also update global store for cross-page visibility
          globalUploadStore.updateUpload(id, { progress, status: controller.isPaused() ? 'paused' : 'uploading' });
        },
        onComplete: () => {
          setActiveUploads(prev => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          globalUploadStore.removeUpload(id);
          sounds.upload();
          addToast('success', `${file.name} uploaded successfully`);
        },
        onError: (error) => {
          setActiveUploads(prev => {
            const next = new Map(prev);
            const existing = next.get(id);
            if (existing) {
              next.set(id, { ...existing, status: 'error', error: error.message });
            }
            return next;
          });
          globalUploadStore.updateUpload(id, { status: 'error', error: error.message });
          if (error.message !== 'Upload cancelled') {
            addToast('error', `${file.name}: ${error.message}`);
          }
        },
        onRouteChange: (route) => {
          setActiveUploads(prev => {
            const next = new Map(prev);
            const existing = next.get(id);
            if (existing) next.set(id, { ...existing, route });
            return next;
          });
          globalUploadStore.updateUpload(id, { route });
        },
      });

      setActiveUploads(prev => {
        const next = new Map(prev);
        next.set(id, { id, file, progress: null, status: 'uploading', controller });
        return next;
      });
      // Register in global store
      globalUploadStore.setUpload(id, {
        id,
        fileName: file.name,
        fileSize: file.size,
        progress: null,
        status: 'uploading',
        controller,
      });

      return promise.then(() => undefined).catch(() => undefined);
    };

    // A large drag-and-drop selection used to start every XHR/chunk session at
    // once, which could saturate low-memory clients and the Portal worker. A
    // small worker pool starts the next file as soon as one slot is available.
    let nextUpload = 0;
    const worker = async () => {
      while (nextUpload < accepted.length) {
        const file = accepted[nextUpload++];
        await startUpload(file);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_UPLOADS, accepted.length) },
      () => worker(),
    ));
    if (accepted.length > 0) await loadFiles();
  }, [loadFiles, addToast, globalUploadStore]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: MAX_FILES_PER_DROP,
    onDropRejected: (rejections) => {
      addToast('error', rejections.length > MAX_FILES_PER_DROP
        ? `Select no more than ${MAX_FILES_PER_DROP} files at a time.`
        : 'One or more files could not be queued for upload.');
    },
    noClick: false,
    noKeyboard: false,
  });

  const requestDelete = (id: string) => {
    if (deleteInFlightRef.current) return;
    const file = files.find(f => f.id === id);
    const name = file ? getDisplayName(file) : 'this file';
    setConfirmDelete({ type: 'single', id, name });
  };

  const requestBatchDelete = () => {
    if (selected.size === 0 || deleteInFlightRef.current) return;
    setConfirmDelete({ type: 'batch', ids: Array.from(selected) });
  };

  const executeDelete = async (): Promise<boolean> => {
    if (!confirmDelete || deleteInFlightRef.current) return false;
    const request = confirmDelete;
    deleteInFlightRef.current = true;
    setDeleteBusy(true);
    let deleted = false;

    try {
      if (request.type === 'single') {
        await filesAPI.delete(request.id);
        setFiles(prev => prev.filter(f => f.id !== request.id));
        setSelected(prev => { const next = new Set(prev); next.delete(request.id); return next; });
        sounds.delete();
        addToast('success', 'File deleted');
        await loadFiles();
      } else {
        const idSet = new Set(request.ids);
        const result = await filesAPI.batchDelete(request.ids);
        setFiles(prev => prev.filter(f => !idSet.has(f.id)));
        setSelected(new Set());
        sounds.delete();
        addToast('success', `${Number(result.deleted || request.ids.length)} files deleted`);
        await loadFiles();
      }
      deleted = true;
    } catch {
      if (request.type === 'single') {
        addToast('error', 'Failed to delete file');
      } else {
        addToast('error', 'Batch delete failed; no partial deletion was accepted');
        await loadFiles();
      }
    } finally {
      deleteInFlightRef.current = false;
      setDeleteBusy(false);
      setConfirmDelete(current => current === request ? null : current);
    }

    return deleted;
  };

  const getExtension = (name: string) => {
    const match = name.match(/\.[^/.]+$/);
    return match ? match[0] : '';
  };

  const startRename = (file: FileEntry) => {
    if (renameInFlightRef.current) return;
    const name = file.originalName || file.path.split('/').pop() || '';
    setRenaming({ id: file.id, currentName: name });
    setExtensionWarning(null);
    if (showExtensions) {
      setRenamingValue(name);
    } else {
      setRenamingValue(name.replace(/\.[^/.]+$/, ''));
    }
  };

  const executeRename = async (force = false): Promise<boolean> => {
    if (!renaming || !renamingValue.trim() || renameInFlightRef.current) return false;

    // Determine the full new name
    const request = renaming;
    const oldName = request.currentName;
    const oldExt = getExtension(oldName);
    let newName: string;
    if (showExtensions) {
      newName = renamingValue.trim();
    } else {
      newName = renamingValue.trim() + oldExt;
    }

    // Check extension change when showExtensions is on
    if (showExtensions && !force) {
      const newExt = getExtension(newName);
      if (oldExt && newExt !== oldExt) {
        setExtensionWarning({ oldExt, newExt: newExt || '(none)' });
        return false;
      }
    }

    renameInFlightRef.current = true;
    setRenameBusy(true);
    let renamed = false;
    try {
      const response = await workspaceAuthorizedFetch(`/api/files/${request.id}/rename`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ newName }),
      });
      if (!response.ok) throw new Error('Rename failed');
      addToast('success', 'File renamed');
      await loadFiles();
      renamed = true;
    } catch {
      addToast('error', 'Failed to rename file');
    } finally {
      renameInFlightRef.current = false;
      setRenameBusy(false);
      setRenaming(null);
      setRenamingValue('');
      setExtensionWarning(null);
    }
    return renamed;
  };

  const startCopyToProject = async (file: FileEntry) => {
    if (copyInFlightRef.current) return;
    const name = file.originalName || file.path.split('/').pop() || '';
    setCopyToProject({ fileId: file.id, fileName: name });
    setMoveFile(false);
    setSelectedProject('');
    
    // Load projects list
    try {
      const response = await workspaceAuthorizedFetch('/api/projects', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        const list = Array.isArray(data) ? data : (data.projects || []);
        setProjects(list.map((p: any) => p.name));
      }
    } catch {
      addToast('error', 'Failed to load projects');
    }
  };

  const loadProjectDirectories = async (projectName: string) => {
    if (!projectName) {
      setProjectDirectories([]);
      return;
    }
    setLoadingDirs(true);
    try {
      // Recursively fetch all directories
      const allDirs: string[] = [];
      
      const fetchDirs = async (basePath: string = '') => {
        if (allDirs.length >= MAX_PROJECT_DIRECTORIES) return;
        const response = await client.get(`/api/projects/${projectName}/tree`, {
          params: basePath ? { path: basePath } : {},
        });
        
        for (const entry of response.data.tree) {
          if (entry.type === 'directory') {
            if (allDirs.length >= MAX_PROJECT_DIRECTORIES) break;
            const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
            allDirs.push(fullPath);
            // Recursively fetch subdirectories
            try {
              await fetchDirs(fullPath);
            } catch (err) { console.error(`[Files] Failed to expand: ${fullPath}`, err); }
          }
        }
      };
      
      await fetchDirs();
      setProjectDirectories(['/', ...allDirs.sort()]);
      if (allDirs.length >= MAX_PROJECT_DIRECTORIES) {
        addToast('info', `Showing the first ${MAX_PROJECT_DIRECTORIES} project folders. Enter the project to manage deeper paths.`);
      }
    } catch {
      setProjectDirectories(['/']); // Fallback to root only
    }
    setLoadingDirs(false);
  };

  const executeCopyToProject = async (): Promise<boolean> => {
    if (!copyToProject || !selectedProject || copyInFlightRef.current) return false;
    const request = copyToProject;
    const projectName = selectedProject;
    const destinationPath = selectedDirectory || '/';
    const shouldMove = moveFile;
    copyInFlightRef.current = true;
    setCopyBusy(true);
    let copied = false;
    try {
      const response = await workspaceAuthorizedFetch(`/api/files/${request.fileId}/copy-to-project`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          projectName,
          destinationPath,
          moveFile: shouldMove,
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Copy failed');
      }
      addToast('success', shouldMove ? 'File moved to project' : 'File copied to project');
      if (shouldMove) await loadFiles();
      copied = true;
    } catch (error: any) {
      addToast('error', error.message || 'Failed to copy file');
    } finally {
      copyInFlightRef.current = false;
      setCopyBusy(false);
      setCopyToProject(null);
      setSelectedProject('');
      setSelectedDirectory('');
    }
    return copied;
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const copyAIUrl = (file: FileEntry) => {
    const base = window.location.origin;
        const url = `${base}/api/files/${file.id}/content`;
    void copyTextToClipboard(url).then((ok) => {
      addToast(ok ? 'info' : 'error', ok ? 'AI content URL copied' : 'Could not copy the URL — select it manually');
    });
  };

  // Filter files
  const filtered = useMemo(() => files.filter(f => {
    const name = (f.originalName || f.path).toLowerCase();
    if (search && !name.includes(search.toLowerCase())) return false;
    if (mimeFilter && !(f.mimeType || '').startsWith(mimeFilter)) return false;
    return true;
  }), [files, mimeFilter, search]);

  const visibleThumbnailLimit = viewMode === 'grid' ? 24 : 40;
  const visibleImageFileIds = useMemo(
    () => filtered
      .filter(file => file.mimeType?.startsWith('image/'))
      .slice(0, visibleThumbnailLimit)
      .map(file => file.id),
    [filtered, visibleThumbnailLimit]
  );
  const [thumbnailStartupReady, setThumbnailStartupReady] = useState(false);

  useEffect(() => {
    setThumbnailStartupReady(false);
    const timer = window.setTimeout(() => {
      setThumbnailStartupReady(true);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [files, search, mimeFilter, viewMode]);

  const thumbnailFileIds = useMemo(
    () => thumbnailStartupReady ? visibleImageFileIds : EMPTY_FILE_IDS,
    [thumbnailStartupReady, visibleImageFileIds],
  );
  const thumbnails = useThumbnails(thumbnailFileIds);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="p-3 sm:p-5 md:p-7 lg:p-10 space-y-4 sm:space-y-6 max-w-[1800px] mx-auto overflow-x-hidden overflow-y-auto h-full"
    >
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start sm:items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold">File Manager</h1>
            <p className="text-slate-400 text-xs sm:text-sm mt-1 truncate">
              {totalFiles} files • {formatSize(totalLibrarySize)}
              <span className="hidden sm:inline">{' • '}<span className="text-emerald-400/60">AI accessible via /api/files/:id/content</span></span>
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <button
              onClick={() => setShowFilters(!showFilters)}
              aria-label={showFilters ? 'Hide file filters' : 'Show file filters'}
              aria-expanded={showFilters}
              className={`p-2 rounded-xl border transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center ${showFilters ? 'accent-active' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}
            >
              <Filter size={18} />
            </button>
            <button
              onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              aria-label={viewMode === 'grid' ? 'Switch to file list view' : 'Switch to file grid view'}
              className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              {viewMode === 'grid' ? <List size={18} /> : <Grid3X3 size={18} />}
            </button>
            <button
              onClick={() => { setLoading(true); loadFiles(); }}
              aria-label="Refresh files"
              className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search files"
            placeholder="Search files..."
            className="w-full pl-8 pr-3 py-2 text-sm rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 accent-focus"
          />
        </div>
      </div>

      {/* Filter pills */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-wrap gap-2"
          >
            {MIME_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => { setMimeFilter(f.value); setPage(1); }}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                  mimeFilter === f.value
                    ? 'accent-active'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:text-white hover:border-white/20'
                }`}
              >
                {f.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Batch actions */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/10"
          >
            <span className="text-sm text-slate-300">{selected.size} selected</span>
            <button
              onClick={requestBatchDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={12} /> Delete selected
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-slate-500 hover:text-white transition-colors"
            >
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active uploads */}
      {activeUploads.size > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider">Uploading</h3>
          <AnimatePresence>
            {Array.from(activeUploads.values()).map(u => (
              <UploadProgressCard
                key={u.id}
                upload={u}
                onPause={() => {
                  u.controller.pause();
                  setActiveUploads(previous => {
                    const next = new Map(previous);
                    const current = next.get(u.id);
                    if (current) next.set(u.id, { ...current, status: 'paused' });
                    return next;
                  });
                  globalUploadStore.updateUpload(u.id, { status: 'paused' });
                }}
                onResume={() => {
                  u.controller.resume();
                  setActiveUploads(previous => {
                    const next = new Map(previous);
                    const current = next.get(u.id);
                    if (current) next.set(u.id, { ...current, status: 'uploading' });
                    return next;
                  });
                  globalUploadStore.updateUpload(u.id, { status: 'uploading' });
                }}
                onCancel={() => {
                  u.controller.cancel();
                  setActiveUploads(previous => {
                    const next = new Map(previous);
                    next.delete(u.id);
                    return next;
                  });
                  globalUploadStore.removeUpload(u.id);
                }}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Drop Zone */}
      <div
        {...getRootProps()}
        className={`rounded-2xl p-6 sm:p-10 text-center cursor-pointer transition-all duration-300 border-2 border-dashed backdrop-blur-sm ${
          isDragActive
            ? 'accent-active scale-[1.01]'
            : 'border-white/[0.08] bg-white/[0.015] accent-hover'
        }`}
      >
        <input {...getInputProps({ 'aria-label': 'Upload files' })} aria-label="Upload files" />
        <div className="space-y-2">
          <Upload size={28} className={`mx-auto transition-colors ${isDragActive ? 'accent-text' : 'text-slate-500'}`} />
          <p className="text-slate-300 text-sm sm:text-base">
            {isDragActive ? 'Drop files here...' : 'Browse files or drag and drop'}
          </p>
          <p className="text-[11px] text-slate-600">
            Up to 2 GB per file and 20 files per selection • Large files use resumable 5 MB chunks
          </p>
        </div>
      </div>

      {/* File Grid/List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-emerald-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <Folder size={48} className="mx-auto mb-3 opacity-50" />
          <p>{search || mimeFilter ? 'No files match your filters' : 'No files yet. Upload a file to get started.'}</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {filtered.map(file => {
            const Icon = getFileIcon(file.mimeType);
            const name = getDisplayName(file);
            const isImage = file.mimeType?.startsWith('image/');
            const isSelected = selected.has(file.id);
            return (
              <motion.div
                key={file.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className={`relative rounded-xl p-3 flex flex-col items-center gap-2 group cursor-pointer transition-all border backdrop-blur-sm ${
                  isSelected
                    ? 'accent-active'
                    : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:shadow-lg accent-hover'
                }`}
                onClick={() => setPreview(file)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setPreview(file);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`Preview ${name}`}
              >
                {/* Selection checkbox */}
                <button
                  type="button"
                  aria-label={`${isSelected ? 'Deselect' : 'Select'} ${name}`}
                  className="absolute top-2 left-2 z-10"
                  onClick={e => { e.stopPropagation(); toggleSelect(file.id); }}
                >
                  <div className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${
                    isSelected ? 'accent-fill border-transparent' : 'border-white/20 opacity-0 group-hover:opacity-100'
                  }`}>
                    {isSelected && <CheckCircle size={10} className="text-white" />}
                  </div>
                </button>

                {/* Thumbnail or icon */}
                <div className="w-14 h-14 rounded-xl bg-white/5 flex items-center justify-center overflow-hidden">
                  {isImage ? (
                    thumbnails[file.id] ? (
                      <img
                        src={thumbnails[file.id]}
                        alt={name}
                        className="w-full h-full object-cover rounded-xl"
                        loading="lazy"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <Loader2 size={16} className="animate-spin text-slate-500" />
                    )
                  ) : (
                    <Icon size={24} className="text-slate-400" />
                  )}
                </div>
                <span className="text-xs text-center truncate w-full" title={name}>{name}</span>
                <span className="text-[10px] text-slate-500">{formatSize(file.size)}</span>

                {/* Hover actions */}
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a
                    href={filesAPI.download(file.id)}
                    onClick={e => { e.stopPropagation(); sounds.click(); }}
                    aria-label={`Download ${name}`}
                    className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-emerald-400"
                    title="Download"
                  >
                    <Download size={13} />
                  </a>
                  <button
                    onClick={e => { e.stopPropagation(); copyAIUrl(file); }}
                    aria-label={`Copy AI URL for ${name}`}
                    className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-blue-400"
                    title="Copy AI URL"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); requestDelete(file.id); }}
                    aria-label={`Delete ${name}`}
                    className="p-1 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-white/[0.06] bg-white/[0.02]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-white/5">
                <th className="p-3 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all visible files"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={e => {
                      if (e.target.checked) setSelected(new Set(filtered.map(f => f.id)));
                      else setSelected(new Set());
                    }}
                    className="rounded border-white/20"
                    style={{ accentColor: 'var(--accent, #6366f1)' }}
                  />
                </th>
                <th className="p-3">Name</th>
                <th className="p-3">Size</th>
                <th className="p-3 hidden md:table-cell">Type</th>
                <th className="p-3 hidden sm:table-cell">Date</th>
                <th scope="col" className="p-3 w-28"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map(file => {
                const Icon = getFileIcon(file.mimeType);
                const name = getDisplayName(file);
                const isImage = file.mimeType?.startsWith('image/');
                return (
                  <tr
                    key={file.id}
                    className="hover:bg-white/[0.03] transition-colors cursor-pointer"
                    style={selected.has(file.id) ? { background: 'var(--accent-bg-subtle, rgba(99, 102, 241, 0.08))' } : undefined}
                    onClick={() => setPreview(file)}
                  >
                    <td className="p-3" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${name}`}
                        checked={selected.has(file.id)}
                        onChange={() => toggleSelect(file.id)}
                        className="rounded border-white/20"
                        style={{ accentColor: 'var(--accent, #6366f1)' }}
                      />
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center overflow-hidden flex-shrink-0">
                          {isImage ? (
                            thumbnails[file.id] ? (
                              <img src={thumbnails[file.id]} alt="" className="w-full h-full object-cover" loading="lazy" />
                            ) : (
                              <Loader2 size={12} className="animate-spin text-slate-500" />
                            )
                          ) : (
                            <Icon size={14} className="text-slate-400" />
                          )}
                        </div>
                        <span className="truncate max-w-[300px]">{name}</span>
                      </div>
                    </td>
                    <td className="p-3 text-slate-400">{formatSize(file.size)}</td>
                    <td className="p-3 text-slate-400 hidden md:table-cell">
                      <span className="text-[11px] px-2 py-0.5 rounded-md bg-white/5">{file.mimeType || '—'}</span>
                    </td>
                    <td className="p-3 text-slate-400 hidden sm:table-cell">{new Date(file.createdAt).toLocaleDateString()}</td>
                    <td className="p-3" onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1 justify-end">
                        <a href={filesAPI.download(file.id)} aria-label={`Download ${name}`} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-emerald-400">
                          <Download size={14} />
                        </a>
                        <button aria-label={`Copy AI URL for ${name}`} onClick={() => copyAIUrl(file)} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-blue-400" title="Copy AI URL">
                          <Copy size={14} />
                        </button>
                        <button onClick={() => requestDelete(file.id)} aria-label={`Delete ${name}`} className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-3" aria-label="File pages">
          <button
            type="button"
            onClick={() => setPage(current => Math.max(1, current - 1))}
            disabled={page <= 1 || loading}
            className="min-h-[44px] px-4 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span className="text-sm text-slate-400" aria-live="polite">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage(current => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages || loading}
            className="min-h-[44px] px-4 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </nav>
      )}

      {/* Media Viewer */}
      <AnimatePresence>
        {preview && (
          <Suspense fallback={null}>
            <LazyMediaViewer
              file={preview}
              files={filtered}
              onClose={() => {
                setPreview(null);
                clearPreviewSearchParams();
              }}
              onNavigate={setPreview}
              onDelete={(id) => { requestDelete(id); }}
              onRename={(f) => startRename(f)}
              onCopyToProject={(f) => startCopyToProject(f)}
              downloadUrl={(id) => filesAPI.download(id)}
              copyAIUrl={copyAIUrl}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete?.type === 'batch' ? `Delete ${confirmDelete.ids.length} files?` : '⚠️ Delete file?'}
        message={
          confirmDelete?.type === 'batch'
            ? `This will permanently delete ${confirmDelete.ids.length} selected files. This cannot be undone.`
            : 'This file will be permanently deleted. This action cannot be undone.'
        }
        detail={confirmDelete?.type === 'single' ? confirmDelete.name : undefined}
        confirmLabel="Delete"
        busy={deleteBusy}
        busyLabel={confirmDelete?.type === 'batch' ? 'Deleting files…' : 'Deleting file…'}
        variant="danger"
        icon="trash"
        onConfirm={async () => {
          const request = confirmDelete;
          const deleted = await executeDelete();
          if (deleted && request?.type === 'single' && preview?.id === request.id) {
            setPreview(null);
            clearPreviewSearchParams();
          }
        }}
        onCancel={() => {
          if (!deleteInFlightRef.current) setConfirmDelete(null);
        }}
      />

      {/* Rename Dialog */}
      <ViewportModal
        open={!!renaming}
        onDismiss={() => {
          if (renameInFlightRef.current) return;
          setRenaming(null);
          setRenamingValue('');
          setExtensionWarning(null);
        }}
        dismissible={!renameBusy}
        initialFocusRef={renameInputRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        {renaming && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-slate-900/95 border border-white/10 backdrop-blur-xl rounded-2xl max-h-[calc(100dvh-2rem)] max-w-md w-full overflow-y-auto overscroll-contain p-6 space-y-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-file-title"
          >
            <h3 id="rename-file-title" className="font-medium text-lg">Rename File</h3>
            <div>
                <label htmlFor="rename-file-name" className="text-xs text-slate-400 block mb-2">New name</label>
                <input
                  ref={renameInputRef}
                  id="rename-file-name"
                  type="text"
                  value={renamingValue}
                  onChange={e => setRenamingValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void executeRename();
                    }
                  }}
                  disabled={renameBusy}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:border-emerald-500/30 focus:outline-none"
                  placeholder="Enter new file name"
                />
                <div className="flex items-center justify-between mt-2">
                  <p className="text-xs text-slate-500">{showExtensions ? 'Full filename with extension' : 'Extension will be preserved'}</p>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showExtensions}
                      disabled={renameBusy}
                      onChange={e => {
                        const checked = e.target.checked;
                        setShowExtensions(checked);
                        if (renaming) {
                          const name = renaming.currentName;
                          const ext = getExtension(name);
                          if (checked) {
                            setRenamingValue(renamingValue + ext);
                          } else {
                            setRenamingValue(renamingValue.replace(/\.[^/.]+$/, ''));
                          }
                        }
                      }}
                      className="w-3.5 h-3.5 rounded border-white/10 bg-white/5 text-emerald-500 focus:ring-emerald-500/30"
                    />
                    <span className="text-xs text-slate-400">Show Extensions</span>
                  </label>
                </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setRenaming(null); setRenamingValue(''); }}
                disabled={renameBusy}
                className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 font-medium text-sm transition-all disabled:cursor-not-allowed disabled:opacity-45"
              >
                Cancel
              </button>
              <button
                onClick={() => { void executeRename(); }}
                disabled={!renamingValue.trim() || renameBusy}
                aria-busy={renameBusy}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {renameBusy && <Loader2 size={14} className="animate-spin" />}
                {renameBusy ? 'Renaming…' : 'Rename'}
              </button>
            </div>
          </motion.div>
        )}
      </ViewportModal>

      {/* Extension Change Warning */}
      <ViewportModal
        open={!!extensionWarning}
        onDismiss={() => {
          if (!renameInFlightRef.current) setExtensionWarning(null);
        }}
        dismissible={!renameBusy}
        initialFocusRef={extensionCancelButtonRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        {extensionWarning && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-slate-900/95 border border-amber-500/20 backdrop-blur-xl rounded-2xl max-h-[calc(100dvh-2rem)] max-w-sm w-full overflow-y-auto overscroll-contain p-6 space-y-4 shadow-2xl"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="extension-warning-title"
            aria-describedby="extension-warning-description"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <AlertCircle size={20} className="text-amber-400" />
              </div>
              <h3 id="extension-warning-title" className="font-medium text-lg">Change Extension?</h3>
            </div>
            <p id="extension-warning-description" className="text-sm text-slate-300">
              Changing file extension from <span className="font-mono text-amber-300">{extensionWarning.oldExt}</span> to <span className="font-mono text-amber-300">{extensionWarning.newExt}</span> may break the file.
            </p>
            <div className="flex gap-2">
              <button
                ref={extensionCancelButtonRef}
                onClick={() => setExtensionWarning(null)}
                disabled={renameBusy}
                className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 font-medium text-sm transition-all disabled:cursor-not-allowed disabled:opacity-45"
              >
                Cancel
              </button>
              <button
                onClick={() => { void executeRename(true); }}
                disabled={renameBusy}
                aria-busy={renameBusy}
                className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-white font-medium text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {renameBusy && <Loader2 size={14} className="animate-spin" />}
                {renameBusy ? 'Renaming…' : 'Continue'}
              </button>
            </div>
          </motion.div>
        )}
      </ViewportModal>

      {/* Copy to Project Dialog */}
      <ViewportModal
        open={!!copyToProject}
        onDismiss={() => {
          if (copyInFlightRef.current) return;
          setCopyToProject(null);
          setSelectedProject('');
          setSelectedDirectory('');
        }}
        dismissible={!copyBusy}
        initialFocusRef={copyProjectSelectRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        {copyToProject && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-slate-900/95 border border-white/10 backdrop-blur-xl rounded-2xl max-h-[calc(100dvh-2rem)] max-w-md w-full overflow-y-auto overscroll-contain p-6 space-y-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="copy-file-title"
          >
            <h3 id="copy-file-title" className="font-medium text-lg">Copy to Project</h3>
            <div>
              <p className="text-xs text-slate-400 block mb-2">File</p>
              <div className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-sm">
                {copyToProject.fileName}
              </div>
            </div>
            <div>
              <label htmlFor="copy-file-project" className="text-xs text-slate-400 block mb-2">Destination Project</label>
              <select
                ref={copyProjectSelectRef}
                id="copy-file-project"
                value={selectedProject}
                disabled={copyBusy}
                onChange={e => {
                  setSelectedProject(e.target.value);
                  setSelectedDirectory('');
                  loadProjectDirectories(e.target.value);
                }}
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:border-emerald-500/30 focus:outline-none"
              >
                <option value="">Select a project...</option>
                {projects.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            {selectedProject && (
              <div>
                <label htmlFor="copy-file-directory" className="text-xs text-slate-400 block mb-2">Destination Directory</label>
                {loadingDirs ? (
                  <div className="flex items-center justify-center py-2.5 text-slate-500">
                    <Loader2 size={16} className="animate-spin" />
                  </div>
                ) : (
                  <select
                    id="copy-file-directory"
                    value={selectedDirectory}
                    disabled={copyBusy}
                    onChange={e => setSelectedDirectory(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:border-emerald-500/30 focus:outline-none"
                  >
                    {projectDirectories.map(dir => (
                      <option key={dir} value={dir}>
                        {dir === '/' ? '/ (root)' : dir}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="moveFile"
                checked={moveFile}
                disabled={copyBusy}
                onChange={e => setMoveFile(e.target.checked)}
                className="w-4 h-4 rounded border-white/10 bg-white/5 text-emerald-500 focus:ring-emerald-500/30"
              />
              <label htmlFor="moveFile" className="text-sm text-slate-300 cursor-pointer">
                Move file (delete from File Manager after copy)
              </label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setCopyToProject(null);
                  setSelectedProject('');
                  setSelectedDirectory('');
                }}
                disabled={copyBusy}
                className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 font-medium text-sm transition-all disabled:cursor-not-allowed disabled:opacity-45"
              >
                Cancel
              </button>
              <button
                onClick={() => { void executeCopyToProject(); }}
                disabled={!selectedProject || copyBusy}
                aria-busy={copyBusy}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {copyBusy && <Loader2 size={14} className="animate-spin" />}
                {copyBusy ? (moveFile ? 'Moving…' : 'Copying…') : (moveFile ? 'Move' : 'Copy')}
              </button>
            </div>
          </motion.div>
        )}
      </ViewportModal>

      {/* Toasts */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </motion.div>
  );
}
