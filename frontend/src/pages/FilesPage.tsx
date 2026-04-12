import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import { filesAPI } from '../api/endpoints';
import client from '../api/client';
import { smartUpload, formatBytes, formatSpeed, formatTime, UploadProgress, UploadController } from '../utils/smartUpload';
import { useUploadStore } from '../stores/uploadStore';
import ConfirmDialog from '../components/ConfirmDialog';
import { useThumbnails } from '../hooks/useThumbnail';
import sounds from '../utils/sounds';
import {
  Upload, File as FileIcon, Folder, Trash2, Download,
  X, Loader2, Image, FileText, FileCode, Film, Music, Archive,
  Search, Grid3X3, List, AlertCircle, CheckCircle, Info,
  Pause, Play, XCircle, Filter, RefreshCw, Copy, MoreVertical
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

// ─── Toast Component ─────────────────────────────────────────
function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
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
            <button onClick={() => onDismiss(t.id)} className="text-white/40 hover:text-white/80">
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Epic Upload Progress Card ───────────────────────────────
function UploadProgressCard({ upload }: { upload: ActiveUpload }) {
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
          {isActive && (
            <button onClick={() => upload.controller.pause()} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-amber-400 transition-colors" title="Pause">
              <Pause size={14} />
            </button>
          )}
          {isPaused && (
            <button onClick={() => upload.controller.resume()} className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-emerald-400 transition-colors" title="Resume">
              <Play size={14} />
            </button>
          )}
          <button onClick={() => upload.controller.cancel()} className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors" title="Cancel">
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
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [mimeFilter, setMimeFilter] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeUploads, setActiveUploads] = useState<Map<string, ActiveUpload>>(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'single' | 'batch'; id?: string; name?: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; currentName: string } | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const [showExtensions, setShowExtensions] = useState(false);
  const [extensionWarning, setExtensionWarning] = useState<{ oldExt: string; newExt: string } | null>(null);
  const [copyToProject, setCopyToProject] = useState<{ fileId: string; fileName: string } | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedDirectory, setSelectedDirectory] = useState('');
  const [projectDirectories, setProjectDirectories] = useState<string[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [moveFile, setMoveFile] = useState(false);
  
  const uploadIdRef = useRef(0);

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
    try {
      const data = await filesAPI.list({ limit: 200 });
      setFiles(Array.isArray(data) ? data : data.files || []);
    } catch (e) {
      console.error('Failed to load files:', e);
      addToast('error', 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const missingDeepLinkRef = useRef<string | null>(null);
  const resolvingDeepLinkRef = useRef<string | null>(null);

  const clearPreviewSearchParams = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    if (!next.has('file') && !next.has('path')) return;
    next.delete('file');
    next.delete('path');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (loading) return;
    const requestedId = searchParams.get('file');
    const requestedPath = searchParams.get('path');
    if (!requestedId && !requestedPath) {
      missingDeepLinkRef.current = null;
      resolvingDeepLinkRef.current = null;
      return;
    }

    const normalizedRequestedPath = requestedPath?.trim() || '';
    const match = files.find((file) => {
      if (requestedId && file.id === requestedId) return true;
      if (!normalizedRequestedPath) return false;
      return file.path === normalizedRequestedPath
        || normalizedRequestedPath.endsWith(`/${file.path}`);
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
      } catch (err) {
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
  }, [addToast, clearPreviewSearchParams, loading, files, searchParams]);

  useEffect(() => {
    if (!preview) return;
    const next = new URLSearchParams(searchParams);
    next.set('file', preview.id);
    next.set('path', preview.path);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [preview, searchParams, setSearchParams]);

  const globalUploadStore = useUploadStore();

  const onDrop = useCallback(async (accepted: File[]) => {
    for (const file of accepted) {
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
          loadFiles();
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

      // Fire and forget - each upload runs independently
      promise.catch(() => {});
    }
  }, [loadFiles, addToast, globalUploadStore]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: false,
    noKeyboard: false,
  });

  const requestDelete = (id: string) => {
    const file = files.find(f => f.id === id);
    const name = file ? getDisplayName(file) : 'this file';
    setConfirmDelete({ type: 'single', id, name });
  };

  const requestBatchDelete = () => {
    if (selected.size === 0) return;
    setConfirmDelete({ type: 'batch' });
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === 'single' && confirmDelete.id) {
      try {
        await filesAPI.delete(confirmDelete.id);
        setFiles(prev => prev.filter(f => f.id !== confirmDelete.id));
        setSelected(prev => { const n = new Set(prev); n.delete(confirmDelete.id!); return n; });
        sounds.delete();
        addToast('success', 'File deleted');
      } catch {
        addToast('error', 'Failed to delete file');
      }
    } else if (confirmDelete.type === 'batch') {
      const ids = Array.from(selected);
      try {
        await Promise.all(ids.map(id => filesAPI.delete(id)));
        setFiles(prev => prev.filter(f => !selected.has(f.id)));
        setSelected(new Set());
        sounds.delete();
        addToast('success', `${ids.length} files deleted`);
      } catch {
        addToast('error', 'Failed to delete some files');
        loadFiles();
      }
    }
    setConfirmDelete(null);
  };

  const getExtension = (name: string) => {
    const match = name.match(/\.[^/.]+$/);
    return match ? match[0] : '';
  };

  const startRename = (file: FileEntry) => {
    const name = file.originalName || file.path.split('/').pop() || '';
    setRenaming({ id: file.id, currentName: name });
    if (showExtensions) {
      setRenamingValue(name);
    } else {
      setRenamingValue(name.replace(/\.[^/.]+$/, ''));
    }
  };

  const executeRename = async (force = false) => {
    if (!renaming || !renamingValue.trim()) return;

    // Determine the full new name
    const oldName = renaming.currentName;
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
        return;
      }
    }

    try {
      const response = await fetch(`/api/files/${renaming.id}/rename`, {
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
    } catch {
      addToast('error', 'Failed to rename file');
    } finally {
      setRenaming(null);
      setRenamingValue('');
      setExtensionWarning(null);
    }
  };

  const startCopyToProject = async (file: FileEntry) => {
    const name = file.originalName || file.path.split('/').pop() || '';
    setCopyToProject({ fileId: file.id, fileName: name });
    setMoveFile(false);
    setSelectedProject('');
    
    // Load projects list
    try {
      const response = await fetch('/api/projects', {
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
        const response = await client.get(`/api/projects/${projectName}/tree`, {
          params: basePath ? { path: basePath } : {},
        });
        
        for (const entry of response.data.tree) {
          if (entry.type === 'directory') {
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
    } catch {
      setProjectDirectories(['/']); // Fallback to root only
    }
    setLoadingDirs(false);
  };

  const executeCopyToProject = async () => {
    if (!copyToProject || !selectedProject) return;
    try {
      const response = await fetch(`/api/files/${copyToProject.fileId}/copy-to-project`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          projectName: selectedProject,
          destinationPath: selectedDirectory || '/',
          moveFile,
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Copy failed');
      }
      addToast('success', moveFile ? 'File moved to project' : 'File copied to project');
      if (moveFile) await loadFiles();
    } catch (error: any) {
      addToast('error', error.message || 'Failed to copy file');
    } finally {
      setCopyToProject(null);
      setSelectedProject('');
    }
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
    navigator.clipboard.writeText(url);
    addToast('info', 'AI content URL copied');
  };

  // Filter files
  const filtered = files.filter(f => {
    const name = (f.originalName || f.path).toLowerCase();
    if (search && !name.includes(search.toLowerCase())) return false;
    if (mimeFilter && !(f.mimeType || '').startsWith(mimeFilter)) return false;
    return true;
  });

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

  const thumbnails = useThumbnails(thumbnailStartupReady ? visibleImageFileIds : []);

  const totalSize = files.reduce((sum, f) => sum + Number(f.size), 0);

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
              {files.length} files • {formatSize(totalSize)}
              <span className="hidden sm:inline">{' • '}<span className="text-emerald-400/60">AI accessible via /api/files/:id/content</span></span>
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-2 rounded-xl border transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center ${showFilters ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}
            >
              <Filter size={18} />
            </button>
            <button
              onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              {viewMode === 'grid' ? <List size={18} /> : <Grid3X3 size={18} />}
            </button>
            <button
              onClick={() => { setLoading(true); loadFiles(); }}
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
            placeholder="Search files..."
            className="w-full pl-8 pr-3 py-2 text-sm rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:border-emerald-500/50 focus:outline-none"
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
                onClick={() => setMimeFilter(f.value)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                  mimeFilter === f.value
                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
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
              <UploadProgressCard key={u.id} upload={u} />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Drop Zone */}
      <div
        {...getRootProps()}
        className={`rounded-2xl p-6 sm:p-10 text-center cursor-pointer transition-all duration-300 border-2 border-dashed backdrop-blur-sm ${
          isDragActive
            ? 'border-emerald-500 bg-emerald-500/10 shadow-[0_0_60px_rgba(16,185,129,0.12)] scale-[1.01]'
            : 'border-white/[0.08] hover:border-emerald-500/30 bg-white/[0.015] hover:bg-emerald-500/[0.03]'
        }`}
      >
        <input {...getInputProps()} />
        <div className="space-y-2">
          <Upload size={28} className={`mx-auto transition-colors ${isDragActive ? 'text-emerald-400' : 'text-slate-500'}`} />
          <p className="text-slate-300 text-sm sm:text-base">
            {isDragActive ? 'Drop files here...' : 'Browse files or drag and drop'}
          </p>
          <p className="text-[11px] text-slate-600 hidden sm:block">
            Up to 500MB per file • Large uploads are chunked automatically • Pause and resume supported
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
                    ? 'bg-emerald-500/10 border-emerald-500/30'
                    : 'bg-white/[0.02] border-white/[0.06] hover:border-emerald-500/15 hover:bg-white/[0.04] hover:shadow-lg hover:shadow-emerald-500/[0.03]'
                }`}
                onClick={() => setPreview(file)}
              >
                {/* Selection checkbox */}
                <div
                  className="absolute top-2 left-2 z-10"
                  onClick={e => { e.stopPropagation(); toggleSelect(file.id); }}
                >
                  <div className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${
                    isSelected ? 'bg-emerald-500 border-emerald-500' : 'border-white/20 opacity-0 group-hover:opacity-100'
                  }`}>
                    {isSelected && <CheckCircle size={10} className="text-white" />}
                  </div>
                </div>

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
                    className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-emerald-400"
                    title="Download"
                  >
                    <Download size={13} />
                  </a>
                  <button
                    onClick={e => { e.stopPropagation(); copyAIUrl(file); }}
                    className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-blue-400"
                    title="Copy AI URL"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); requestDelete(file.id); }}
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
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={e => {
                      if (e.target.checked) setSelected(new Set(filtered.map(f => f.id)));
                      else setSelected(new Set());
                    }}
                    className="rounded border-white/20"
                  />
                </th>
                <th className="p-3">Name</th>
                <th className="p-3">Size</th>
                <th className="p-3 hidden md:table-cell">Type</th>
                <th className="p-3 hidden sm:table-cell">Date</th>
                <th className="p-3 w-28"></th>
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
                    className={`hover:bg-white/[0.03] transition-colors cursor-pointer ${
                      selected.has(file.id) ? 'bg-emerald-500/5' : ''
                    }`}
                    onClick={() => setPreview(file)}
                  >
                    <td className="p-3" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(file.id)}
                        onChange={() => toggleSelect(file.id)}
                        className="rounded border-white/20"
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
                        <a href={filesAPI.download(file.id)} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-emerald-400">
                          <Download size={14} />
                        </a>
                        <button onClick={() => copyAIUrl(file)} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-blue-400" title="Copy AI URL">
                          <Copy size={14} />
                        </button>
                        <button onClick={() => requestDelete(file.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400">
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
        title={confirmDelete?.type === 'batch' ? `Delete ${selected.size} files?` : '⚠️ Delete file?'}
        message={
          confirmDelete?.type === 'batch'
            ? `This will permanently delete ${selected.size} selected files. This cannot be undone.`
            : 'This file will be permanently deleted. This action cannot be undone.'
        }
        detail={confirmDelete?.type === 'single' ? confirmDelete.name : undefined}
        confirmLabel="Delete"
        variant="danger"
        icon="trash"
        onConfirm={() => {
          executeDelete();
          setPreview(null);
          clearPreviewSearchParams();
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Rename Dialog */}
      <AnimatePresence>
        {renaming && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setRenaming(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-slate-900/95 border border-white/10 backdrop-blur-xl rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-medium text-lg">Rename File</h3>
              <div>
                <label className="text-xs text-slate-400 block mb-2">New name</label>
                <input
                  type="text"
                  value={renamingValue}
                  onChange={e => setRenamingValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && executeRename()}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white focus:border-emerald-500/30 focus:outline-none"
                  autoFocus
                  placeholder="Enter new file name"
                />
                <div className="flex items-center justify-between mt-2">
                  <p className="text-xs text-slate-500">{showExtensions ? 'Full filename with extension' : 'Extension will be preserved'}</p>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showExtensions}
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
                  onClick={() => setRenaming(null)}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 font-medium text-sm transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => executeRename()}
                  disabled={!renamingValue.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm transition-all disabled:opacity-50"
                >
                  Rename
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Extension Change Warning */}
      <AnimatePresence>
        {extensionWarning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
            onClick={() => setExtensionWarning(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-slate-900/95 border border-amber-500/20 backdrop-blur-xl rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <AlertCircle size={20} className="text-amber-400" />
                </div>
                <h3 className="font-medium text-lg">Change Extension?</h3>
              </div>
              <p className="text-sm text-slate-300">
                Changing file extension from <span className="font-mono text-amber-300">{extensionWarning.oldExt}</span> to <span className="font-mono text-amber-300">{extensionWarning.newExt}</span> may break the file.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setExtensionWarning(null)}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 font-medium text-sm transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setExtensionWarning(null); executeRename(true); }}
                  className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-white font-medium text-sm transition-all"
                >
                  Continue
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Copy to Project Dialog */}
      <AnimatePresence>
        {copyToProject && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setCopyToProject(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-slate-900/95 border border-white/10 backdrop-blur-xl rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-medium text-lg">Copy to Project</h3>
              <div>
                <label className="text-xs text-slate-400 block mb-2">File</label>
                <div className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-sm">
                  {copyToProject.fileName}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-2">Destination Project</label>
                <select
                  value={selectedProject}
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
                  <label className="text-xs text-slate-400 block mb-2">Destination Directory</label>
                  {loadingDirs ? (
                    <div className="flex items-center justify-center py-2.5 text-slate-500">
                      <Loader2 size={16} className="animate-spin" />
                    </div>
                  ) : (
                    <select
                      value={selectedDirectory}
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
                  onChange={e => setMoveFile(e.target.checked)}
                  className="w-4 h-4 rounded border-white/10 bg-white/5 text-emerald-500 focus:ring-emerald-500/30"
                />
                <label htmlFor="moveFile" className="text-sm text-slate-300 cursor-pointer">
                  Move file (delete from File Manager after copy)
                </label>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setCopyToProject(null)}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 font-medium text-sm transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={executeCopyToProject}
                  disabled={!selectedProject}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm transition-all disabled:opacity-50"
                >
                  {moveFile ? 'Move' : 'Copy'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toasts */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </motion.div>
  );
}
