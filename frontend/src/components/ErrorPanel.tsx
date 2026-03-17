import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, AlertCircle, Zap, AlertTriangle, Bug, Copy, Check,
  Download, Trash2, Search, Filter, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  subscribeErrors, clearErrors, exportErrorsJSON,
  type StoredError, type ErrorCategory,
} from '../utils/errorHandler';

const categoryLabels: Record<string, string> = {
  agent_chat: 'Agent Chat',
  file_op: 'File',
  git: 'Git',
  project: 'Project',
  auth: 'Auth',
  api: 'API',
  system: 'System',
  frontend: 'Frontend',
  react: 'React Crash',
};

const severityConfig: Record<string, { icon: any; color: string; bg: string }> = {
  CRITICAL: { icon: Zap, color: 'text-red-500', bg: 'bg-red-500/20' },
  ERROR: { icon: AlertCircle, color: 'text-orange-400', bg: 'bg-orange-500/15' },
  WARNING: { icon: AlertTriangle, color: 'text-yellow-400', bg: 'bg-yellow-500/15' },
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ErrorPanel({ open, onClose }: Props) {
  const [errors, setErrors] = useState<StoredError[]>([]);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterSeverity, setFilterSeverity] = useState<string>('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => subscribeErrors(setErrors), []);

  const filtered = useMemo(() => {
    let result = errors;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(e =>
        e.message.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        JSON.stringify(e.debug || {}).toLowerCase().includes(q)
      );
    }
    if (filterCategory) result = result.filter(e => e.category === filterCategory);
    if (filterSeverity) result = result.filter(e => e.severity === filterSeverity);
    return result;
  }, [errors, search, filterCategory, filterSeverity]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyDebug = (error: StoredError) => {
    const payload = JSON.stringify(error, null, 2);
    navigator.clipboard.writeText(payload);
    setCopiedId(error.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleExport = () => {
    const json = exportErrorsJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portal-errors-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    if (confirm('Clear all error history?')) clearErrors();
  };

  // Get unique categories from current errors for filter dropdown
  const availableCategories = useMemo(() => {
    const cats = new Set(errors.map(e => e.category));
    return Array.from(cats).sort();
  }, [errors]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-[#0D1130] border-l border-white/10 z-50 flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Bug size={18} className="text-red-400" />
                <h2 className="text-lg font-semibold text-white">Error Log</h2>
                <span className="text-xs text-slate-500">({errors.length})</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleExport}
                  disabled={errors.length === 0}
                  className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-30"
                  title="Export as JSON"
                >
                  <Download size={16} />
                </button>
                <button
                  onClick={handleClear}
                  disabled={errors.length === 0}
                  className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-red-400 transition-colors disabled:opacity-30"
                  title="Clear all"
                >
                  <Trash2 size={16} />
                </button>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex gap-2 p-3 border-b border-white/5">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search errors..."
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:border-red-500/50 focus:outline-none"
                />
              </div>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white appearance-none cursor-pointer"
              >
                <option value="">All Types</option>
                {availableCategories.map(c => (
                  <option key={c} value={c}>{categoryLabels[c] || c}</option>
                ))}
              </select>
              <select
                value={filterSeverity}
                onChange={(e) => setFilterSeverity(e.target.value)}
                className="px-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white appearance-none cursor-pointer"
              >
                <option value="">All Severity</option>
                <option value="CRITICAL">Critical</option>
                <option value="ERROR">Error</option>
              </select>
            </div>

            {/* Error List */}
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-2">
                  <AlertCircle size={24} className="opacity-30" />
                  <span className="text-sm">{errors.length === 0 ? 'No errors recorded' : 'No matching errors'}</span>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {filtered.map((error) => {
                    const sev = severityConfig[error.severity] || severityConfig.ERROR;
                    const SevIcon = sev.icon;
                    const isExpanded = expandedIds.has(error.id);
                    const debug = error.debug || {};

                    return (
                      <div key={error.id} className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 p-1 rounded ${sev.bg}`}>
                            <SevIcon size={14} className={sev.color} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-white/5 text-slate-300">
                                {categoryLabels[error.category] || error.category}
                              </span>
                              <span className="text-[11px] text-slate-500">
                                {new Date(error.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                            </div>
                            <p className="text-sm text-white mt-1 break-words">{error.message}</p>

                            {/* Debug toggle */}
                            <div className="flex items-center gap-2 mt-2">
                              <button
                                onClick={() => toggleExpand(error.id)}
                                className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
                              >
                                {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                {isExpanded ? 'Hide' : 'View'} Debug Info
                              </button>
                              <button
                                onClick={() => copyDebug(error)}
                                className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-emerald-400 transition-colors"
                              >
                                {copiedId === error.id ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                                {copiedId === error.id ? 'Copied!' : 'Copy'}
                              </button>
                            </div>

                            {/* Expanded debug */}
                            {isExpanded && (
                              <div className="mt-2 p-3 rounded-lg bg-black/30 border border-white/5 text-xs space-y-1.5">
                                {debug.endpoint && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Endpoint:</span> <code className="text-red-300">{debug.endpoint}</code>
                                  </div>
                                )}
                                {debug.context && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Context:</span> {debug.context}
                                  </div>
                                )}
                                {debug.status && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">HTTP Status:</span> <code className="text-amber-300">{debug.status}</code>
                                  </div>
                                )}
                                {debug.code && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Code:</span> <code className="text-amber-300">{debug.code}</code>
                                  </div>
                                )}
                                {debug.hint && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">💡 Hint:</span> {debug.hint}
                                  </div>
                                )}
                                {debug.url && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Page:</span> <code className="text-slate-500">{debug.url}</code>
                                  </div>
                                )}
                                {debug.stack && (
                                  <details className="mt-1">
                                    <summary className="text-slate-500 cursor-pointer hover:text-slate-400 text-[10px]">Stack Trace</summary>
                                    <pre className="mt-1 p-2 rounded bg-black/40 text-[10px] text-slate-400 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
                                      {debug.stack}
                                    </pre>
                                  </details>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
