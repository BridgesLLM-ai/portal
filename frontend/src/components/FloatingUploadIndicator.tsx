import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, ChevronUp, ChevronDown, Pause, Play, XCircle, CheckCircle, AlertCircle } from 'lucide-react';
import { useUploadStore, GlobalUpload } from '../stores/uploadStore';
import { formatBytes, formatSpeed, formatTime } from '../utils/smartUpload';

function UploadCard({ u }: { u: GlobalUpload }) {
  const pct = Math.round(u.progress?.percentage || 0);
  const isActive = u.status === 'uploading';
  const isPaused = u.status === 'paused';
  const isError = u.status === 'error';
  const isComplete = u.status === 'complete';

  const routeLabel = u.route === 'chunked' ? '⚡' :
    u.route === 'tailscale' ? '🔒' : '📡';

  return (
    <div className="px-3 py-2.5 border-b border-white/5 last:border-0">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[10px]">{routeLabel}</span>
          <span className="text-xs text-white truncate">{u.fileName}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isComplete && <CheckCircle size={12} className="text-emerald-400" />}
          {isError && <AlertCircle size={12} className="text-red-400" />}
          {isActive && (
            <button onClick={() => u.controller.pause()} className="p-0.5 text-slate-500 hover:text-amber-400">
              <Pause size={10} />
            </button>
          )}
          {isPaused && (
            <button onClick={() => u.controller.resume()} className="p-0.5 text-amber-400 hover:text-emerald-400">
              <Play size={10} />
            </button>
          )}
          {(isActive || isPaused) && (
            <button onClick={() => u.controller.cancel()} className="p-0.5 text-slate-500 hover:text-red-400">
              <XCircle size={10} />
            </button>
          )}
          <span className={`text-[10px] tabular-nums font-mono ${
            isComplete ? 'text-emerald-400' : isError ? 'text-red-400' : isPaused ? 'text-amber-400' : 'text-slate-400'
          }`}>
            {isComplete ? '✓' : isError ? '✗' : `${pct}%`}
          </span>
        </div>
      </div>
      {/* Progress bar */}
      <div className="relative h-1 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${
            isComplete ? 'bg-emerald-500' :
            isError ? 'bg-red-500' :
            isPaused ? 'bg-amber-500' :
            'bg-gradient-to-r from-emerald-500 to-blue-500'
          }`}
          style={{ width: `${isComplete ? 100 : pct}%` }}
        />
      </div>
      {/* Speed/ETA for active uploads */}
      {isActive && u.progress && u.progress.speed > 0 && (
        <div className="flex items-center gap-2 mt-1 text-[9px] text-slate-600">
          <span>{formatSpeed(u.progress.speed)}</span>
          <span>ETA {formatTime(u.progress.eta)}</span>
          {u.progress.chunksTotal != null && (
            <span>Chunk {u.progress.chunksCompleted}/{u.progress.chunksTotal}</span>
          )}
        </div>
      )}
      {isPaused && <div className="text-[9px] text-amber-400 mt-1">Paused</div>}
      {isError && <div className="text-[9px] text-red-400 mt-1 truncate">{u.error || 'Failed'}</div>}
    </div>
  );
}

export default function FloatingUploadIndicator() {
  const uploads = useUploadStore(s => s.uploads);
  const [expanded, setExpanded] = useState(false);

  const allUploads = Array.from(uploads.values());
  const activeUploads = allUploads.filter(u => u.status === 'uploading' || u.status === 'paused');
  const recentUploads = allUploads.filter(u => u.status === 'complete' || u.status === 'error');

  // Show if there are any uploads at all
  if (allUploads.length === 0) return null;

  const totalProgress = activeUploads.length > 0
    ? activeUploads.reduce((sum, u) => sum + (u.progress?.percentage || 0), 0) / activeUploads.length
    : 100;

  const hasActive = activeUploads.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.9 }}
      className="fixed bottom-4 left-4 z-[90]"
    >
      {/* Collapsed pill */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 px-3 py-2 rounded-xl backdrop-blur-xl shadow-2xl transition-all border ${
          hasActive
            ? 'bg-[#0D1130]/95 border-emerald-500/30 hover:border-emerald-500/50'
            : 'bg-[#0D1130]/95 border-white/10 hover:border-white/20'
        }`}
      >
        <div className="relative w-5 h-5">
          {hasActive ? (
            <Upload size={14} className="text-emerald-400 animate-pulse" />
          ) : (
            <CheckCircle size={14} className="text-emerald-400" />
          )}
        </div>
        <span className="text-xs text-white font-medium">
          {hasActive
            ? `${activeUploads.length} upload${activeUploads.length > 1 ? 's' : ''}`
            : `${recentUploads.length} done`
          }
        </span>
        <span className={`text-[10px] font-mono tabular-nums ${hasActive ? 'text-emerald-400' : 'text-slate-400'}`}>
          {Math.round(totalProgress)}%
        </span>
        {expanded ? <ChevronDown size={12} className="text-slate-400" /> : <ChevronUp size={12} className="text-slate-400" />}
      </button>

      {/* Expanded list */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: 10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: 10, height: 0 }}
            className="mt-2 w-80 bg-[#0D1130]/95 border border-white/10 rounded-xl backdrop-blur-xl shadow-2xl overflow-hidden"
          >
            {activeUploads.length > 0 && (
              <>
                <div className="px-3 py-1.5 border-b border-white/5 text-[10px] text-slate-500 uppercase tracking-wider">
                  Active ({activeUploads.length})
                </div>
                <div className="max-h-40 overflow-auto">
                  {activeUploads.map(u => <UploadCard key={u.id} u={u} />)}
                </div>
              </>
            )}
            {recentUploads.length > 0 && (
              <>
                <div className="px-3 py-1.5 border-b border-white/5 text-[10px] text-slate-500 uppercase tracking-wider">
                  Recent
                </div>
                <div className="max-h-32 overflow-auto">
                  {recentUploads.map(u => <UploadCard key={u.id} u={u} />)}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
