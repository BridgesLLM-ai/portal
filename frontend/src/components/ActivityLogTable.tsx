import { useState, useEffect, useCallback } from 'react';
import { activityAPI } from '../api/endpoints';
import type { ActivityLog } from '../types/index';
import {
  Shield, ShieldOff, LogIn, LogOut, GitBranch, Server,
  AlertTriangle, Info, AlertCircle, Bug, Zap, Search,
  ChevronLeft, ChevronRight, Activity, Filter, Archive,
  Monitor, Smartphone, Tablet, Globe, Lock, Unlock,
  Copy, Check, Bot, FileText, Upload, Download, Trash2,
  Terminal, BarChart3, Plus, Minus,
} from 'lucide-react';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from './Toast';

const ITEMS_PER_PAGE = 20;

// ── Activity type color themes ──────────────────────────────────
type ColorTheme = {
  border: string;
  bg: string;
  bgHover: string;
  badge: string;
  badgeText: string;
  iconColor: string;
  accent: string;
};

const colorThemes: Record<string, ColorTheme> = {
  git: {
    border: 'border-l-amber-500/60',
    bg: 'bg-amber-500/20',
    bgHover: 'hover:bg-amber-500/30',
    badge: 'bg-amber-500/15',
    badgeText: 'text-amber-400',
    iconColor: 'text-amber-400',
    accent: 'amber',
  },
  deploy: {
    border: 'border-l-violet-500/60',
    bg: 'bg-violet-500/20',
    bgHover: 'hover:bg-violet-500/30',
    badge: 'bg-violet-500/15',
    badgeText: 'text-violet-400',
    iconColor: 'text-violet-400',
    accent: 'violet',
  },
  login: {
    border: 'border-l-emerald-500/60',
    bg: 'bg-emerald-500/20',
    bgHover: 'hover:bg-emerald-500/30',
    badge: 'bg-emerald-500/15',
    badgeText: 'text-emerald-400',
    iconColor: 'text-emerald-400',
    accent: 'emerald',
  },
  error: {
    border: 'border-l-red-500/60',
    bg: 'bg-red-500/20',
    bgHover: 'hover:bg-red-500/30',
    badge: 'bg-red-500/15',
    badgeText: 'text-red-400',
    iconColor: 'text-red-400',
    accent: 'red',
  },
  botTrap: {
    border: 'border-l-rose-500/70',
    bg: 'bg-rose-500/20',
    bgHover: 'hover:bg-rose-500/30',
    badge: 'bg-rose-500/15',
    badgeText: 'text-rose-400',
    iconColor: 'text-rose-500',
    accent: 'rose',
  },
  system: {
    border: 'border-l-blue-500/60',
    bg: 'bg-blue-500/20',
    bgHover: 'hover:bg-blue-500/30',
    badge: 'bg-blue-500/15',
    badgeText: 'text-blue-400',
    iconColor: 'text-blue-400',
    accent: 'blue',
  },
  file: {
    border: 'border-l-cyan-500/60',
    bg: 'bg-cyan-500/20',
    bgHover: 'hover:bg-cyan-500/30',
    badge: 'bg-cyan-500/15',
    badgeText: 'text-cyan-400',
    iconColor: 'text-cyan-400',
    accent: 'cyan',
  },
  agent: {
    border: 'border-l-purple-500/60',
    bg: 'bg-purple-500/20',
    bgHover: 'hover:bg-purple-500/30',
    badge: 'bg-purple-500/15',
    badgeText: 'text-purple-400',
    iconColor: 'text-purple-400',
    accent: 'purple',
  },
  default: {
    border: 'border-l-slate-500/30',
    bg: '',
    bgHover: 'hover:bg-white/[0.02]',
    badge: 'bg-white/5',
    badgeText: 'text-slate-400',
    iconColor: 'text-slate-400',
    accent: 'slate',
  },
};

function getTheme(action: string, severity: string): ColorTheme {
  if (action.endsWith('_ERROR') || severity === 'ERROR' || severity === 'CRITICAL') return colorThemes.error;
  if (action === 'IP_BLOCKED' || action === 'IP_UNBLOCKED') return colorThemes.botTrap;
  if (action === 'LOGIN_FAILED') return colorThemes.error;
  if (action.startsWith('PROJECT_GIT')) return colorThemes.git;
  if (action.startsWith('PROJECT_DEPLOY')) return colorThemes.deploy;
  if (action === 'LOGIN' || action === 'LOGOUT') return colorThemes.login;
  if (action.startsWith('MARCUS')) return colorThemes.agent;
  if (action === 'SYSTEM_ALERT' || action === 'METRICS_COLLECT' || action === 'TERMINAL_EXEC') return colorThemes.system;
  if (action.startsWith('FILE_') || action.startsWith('APP_')) return colorThemes.file;
  return colorThemes.default;
}

const categories = [
  { key: '', label: 'All', icon: Activity },
  { key: 'logins', label: 'Auth', icon: LogIn },
  { key: 'git', label: 'Git', icon: GitBranch },
  { key: 'deploys', label: 'Deploy', icon: Zap },
  { key: 'agent', label: 'AI', icon: Bot },
  { key: 'files', label: 'Files', icon: FileText },
  { key: 'system', label: 'System', icon: Server },
  { key: 'errors', label: 'Errors', icon: AlertCircle },
  { key: 'bot_traps', label: 'Security', icon: Shield },
];

const categoryThemeMap: Record<string, string> = {
  logins: 'emerald',
  git: 'amber',
  deploys: 'violet',
  agent: 'purple',
  files: 'cyan',
  system: 'blue',
  errors: 'red',
  bot_traps: 'rose',
};

const severityStyles: Record<string, { bg: string; text: string; icon: any }> = {
  DEBUG: { bg: 'bg-slate-500/10', text: 'text-slate-400', icon: Bug },
  INFO: { bg: 'bg-blue-500/10', text: 'text-blue-400', icon: Info },
  WARNING: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: AlertTriangle },
  ERROR: { bg: 'bg-red-500/10', text: 'text-red-400', icon: AlertCircle },
  CRITICAL: { bg: 'bg-red-500/20', text: 'text-red-500', icon: Zap },
};

const actionIcons: Record<string, { icon: any }> = {
  LOGIN: { icon: LogIn },
  LOGIN_FAILED: { icon: ShieldOff },
  LOGOUT: { icon: LogOut },
  IP_BLOCKED: { icon: Lock },
  IP_UNBLOCKED: { icon: Unlock },
  FILE_UPLOAD: { icon: Upload },
  FILE_DOWNLOAD: { icon: Download },
  FILE_DELETE: { icon: Trash2 },
  SYSTEM_ALERT: { icon: AlertCircle },
  METRICS_COLLECT: { icon: BarChart3 },
  TERMINAL_EXEC: { icon: Terminal },
  MARCUS_ERROR: { icon: AlertCircle },
  MARCUS_CHAT: { icon: Bot },
  PROJECT_GIT_COMMIT: { icon: GitBranch },
  PROJECT_GIT_PUSH: { icon: GitBranch },
  PROJECT_GIT_PULL: { icon: GitBranch },
  PROJECT_GIT_CLONE: { icon: GitBranch },
  PROJECT_DEPLOY: { icon: Zap },
  API_ERROR: { icon: AlertCircle },
  GIT_ERROR: { icon: GitBranch },
  AUTH_ERROR: { icon: ShieldOff },
  DB_ERROR: { icon: Server },
  FS_ERROR: { icon: AlertTriangle },
  FRONTEND_ERROR: { icon: Bug },
  APP_UPLOAD: { icon: Upload },
  APP_DELETE: { icon: Trash2 },
};

function DeviceIcon({ device }: { device?: string }) {
  if (!device) return <Globe size={12} className="text-slate-500" />;
  const d = device.toLowerCase();
  if (d.includes('mobile')) return <Smartphone size={12} className="text-slate-400" />;
  if (d.includes('tablet')) return <Tablet size={12} className="text-slate-400" />;
  return <Monitor size={12} className="text-slate-400" />;
}

interface Props {
  standalone?: boolean;
}

export default function ActivityLogTable({ standalone = false }: Props) {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [loading, setLoading] = useState(false);
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [expandedMeta, setExpandedMeta] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const toast = useToast();

  const toggleErrorExpand = (id: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMeta = (id: string) => {
    setExpandedMeta((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await activityAPI.list({
        page,
        limit: ITEMS_PER_PAGE,
        category: category || undefined,
        severity: severity || undefined,
        search: search || undefined,
      });
      setLogs(res.logs || []);
      setTotal(res.total || 0);
      setPages(res.pages || 0);
    } catch (error) {
      console.error('Failed to load activity logs', error);
    } finally {
      setLoading(false);
    }
  }, [page, category, severity, search]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => {
    const iv = setInterval(fetchLogs, 30000);
    return () => clearInterval(iv);
  }, [fetchLogs]);

  const handleUnblock = async (ip: string, activityId: string) => {
    setUnblocking(activityId);
    try {
      await activityAPI.unblockIP(ip, activityId);
      toast.success(`IP ${ip} has been unblocked`);
      fetchLogs();
    } catch {
      toast.error(`Failed to unblock IP`);
    } finally {
      setUnblocking(null);
    }
  };

  const handleArchive = async () => {
    if (!confirm('Archive activity entries older than 120 days?')) return;
    try {
      const res = await activityAPI.archive();
      alert(`Archived ${res.archived} entries`);
      fetchLogs();
    } catch {
      alert('Failed to archive');
    }
  };

  const activeAccent = categoryThemeMap[category] || 'emerald';

  return (
    <>
      <ToastContainer toasts={toast.toasts} onClose={toast.closeToast} />
      <div className="bg-[rgba(26,31,58,0.7)] backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-white/10 bg-gradient-to-r from-white/[0.02] to-transparent">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-emerald-500/10">
                <Activity size={18} className="text-emerald-400" />
              </div>
              <h3 className="text-lg font-semibold text-[#F0F4F8]">Activity Log</h3>
              <span className="text-xs text-slate-500 bg-white/5 px-2 py-0.5 rounded-full">{total}</span>
            </div>
            {standalone && (
              <button
                onClick={handleArchive}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all duration-200"
              >
                <Archive size={12} />
                Archive Old
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2 mt-3">
            <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
              {categories.map((cat) => {
                const Icon = cat.icon;
                const accent = categoryThemeMap[cat.key] || 'emerald';
                const isActive = category === cat.key;
                return (
                  <button
                    key={cat.key}
                    onClick={() => { setCategory(cat.key); setPage(1); }}
                    className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md transition-all duration-200 ${
                      isActive
                        ? `bg-${accent}-500/20 text-${accent}-400 font-medium shadow-sm shadow-${accent}-500/10`
                        : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                    }`}
                    style={isActive ? {
                      backgroundColor: `color-mix(in srgb, var(--tw-${accent}, ${accent === 'amber' ? '#f59e0b' : accent === 'violet' ? '#8b5cf6' : accent === 'emerald' ? '#10b981' : accent === 'purple' ? '#a855f7' : accent === 'blue' ? '#3b82f6' : accent === 'rose' ? '#f43f5e' : accent === 'red' ? '#ef4444' : '#64748b'}) 20%, transparent)`,
                      color: accent === 'amber' ? '#fbbf24' : accent === 'violet' ? '#a78bfa' : accent === 'emerald' ? '#34d399' : accent === 'purple' ? '#c084fc' : accent === 'blue' ? '#60a5fa' : accent === 'rose' ? '#fb7185' : accent === 'red' ? '#f87171' : '#94a3b8',
                    } : {}}
                  >
                    <Icon size={12} />
                    <span className="hidden sm:inline">{cat.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="relative flex-1 min-w-[120px] max-w-[200px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search..."
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:border-emerald-500/50 focus:outline-none transition-colors"
              />
            </div>

            <select
              value={severity}
              onChange={(e) => { setSeverity(e.target.value); setPage(1); }}
              className="px-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white appearance-none cursor-pointer"
            >
              <option value="">All Levels</option>
              <option value="DEBUG">Debug</option>
              <option value="INFO">Info</option>
              <option value="WARNING">Warning</option>
              <option value="ERROR">Error</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </div>
        </div>

        {/* Log entries */}
        <div className={standalone ? 'max-h-[calc(100vh-300px)]' : 'max-h-[480px]'} style={{ overflowY: 'auto' }}>
          {loading && logs.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              <Activity size={20} className="animate-spin mx-auto mb-2 opacity-50" />
              Loading...
            </div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-slate-500">No activity found</div>
          ) : (
            <div className="divide-y divide-white/5">
              {logs.map((log) => {
                const theme = getTheme(log.action, log.severity);
                const sev = severityStyles[log.severity] || severityStyles.INFO;
                const SevIcon = sev.icon;
                const actionDef = actionIcons[log.action];
                const ActionIcon = actionDef?.icon || Activity;
                const meta = log.metadata as any;
                const isBlocked = log.action === 'IP_BLOCKED';
                const isUnblocked = meta?.unblocked === true;
                const isError = log.action.endsWith('_ERROR') || log.severity === 'ERROR' || log.severity === 'CRITICAL';
                const isGit = log.action.startsWith('PROJECT_GIT');
                const isDeploy = log.action.startsWith('PROJECT_DEPLOY');
                const isLogin = log.action === 'LOGIN' || log.action === 'LOGOUT' || log.action === 'LOGIN_FAILED';
                const isBotTrap = log.action === 'IP_BLOCKED' || log.action === 'IP_UNBLOCKED';
                const hasIpInfo = meta && (meta.ip || meta.geo || meta.device);

                return (
                  <div
                    key={log.id}
                    className={`px-4 sm:px-5 py-3 border-l-2 transition-all duration-200 ${theme.border} ${theme.bg} ${theme.bgHover}`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Icon with colored background */}
                      <div className={`mt-0.5 p-1.5 rounded-lg ${theme.badge}`}>
                        <ActionIcon size={14} className={theme.iconColor} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        {/* Header row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${theme.badge} ${theme.badgeText}`}>
                            {log.action.replace(/_/g, ' ')}
                          </span>
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${sev.bg} ${sev.text}`}>
                            <SevIcon size={9} />
                            {log.severity}
                          </span>
                          <span className="text-[11px] text-slate-500 ml-auto">
                            {new Date(log.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        {/* Message */}
                        {log.translatedMessage && (
                          <div className="mt-1.5 text-sm text-slate-300 whitespace-pre-line leading-relaxed">
                            {log.translatedMessage}
                          </div>
                        )}

                        {/* IP / Geo / Device info - for logins and bot traps */}
                        {hasIpInfo && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            {meta.ip && (
                              <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-mono ${theme.badge} ${theme.badgeText}`}>
                                <Globe size={10} />
                                {meta.ip}
                              </span>
                            )}
                            {meta.geo?.summary && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 bg-white/5 px-2 py-0.5 rounded-md">
                                📍 {meta.geo.summary}
                              </span>
                            )}
                            {meta.device?.summary && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 bg-white/5 px-2 py-0.5 rounded-md">
                                <DeviceIcon device={meta.device?.device} />
                                {meta.device.summary}
                              </span>
                            )}
                          </div>
                        )}

                        {/* ── Git commit details ── */}
                        {log.action === 'PROJECT_GIT_COMMIT' && meta?.hash && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <code className="text-[11px] text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-md font-mono font-semibold">
                              {String(meta.hash).slice(0, 7)}
                            </code>
                            {meta.projectName && (
                              <span className="text-[11px] text-blue-300 bg-blue-500/10 px-2 py-0.5 rounded-md font-medium">
                                {meta.projectName}
                              </span>
                            )}
                            {meta.branch && (
                              <span className="text-[11px] text-purple-300 bg-purple-500/10 px-2 py-0.5 rounded-md">
                                ⎇ {meta.branch}
                              </span>
                            )}
                            {meta.filesChanged > 0 && (
                              <span className="text-[11px] text-slate-300 bg-white/5 px-2 py-0.5 rounded-md">
                                <FileText size={10} className="inline mr-0.5 -mt-0.5" />
                                {meta.filesChanged} file{meta.filesChanged > 1 ? 's' : ''}
                              </span>
                            )}
                            {(meta.linesAdded > 0 || meta.linesRemoved > 0) && (
                              <>
                                {meta.linesAdded > 0 && (
                                  <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-md font-mono font-semibold">
                                    <Plus size={10} />
                                    {meta.linesAdded}
                                  </span>
                                )}
                                {meta.linesRemoved > 0 && (
                                  <span className="inline-flex items-center gap-0.5 text-[11px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-md font-mono font-semibold">
                                    <Minus size={10} />
                                    {meta.linesRemoved}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        )}

                        {/* ── Deploy details ── */}
                        {isDeploy && meta && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {meta.projectName && (
                              <span className="text-[11px] text-violet-300 bg-violet-500/10 px-2 py-0.5 rounded-md font-medium">
                                {meta.projectName}
                              </span>
                            )}
                            {meta.version && (
                              <span className="text-[11px] text-violet-300 bg-violet-500/10 px-2 py-0.5 rounded-md font-mono">
                                v{meta.version}
                              </span>
                            )}
                            {meta.status && (
                              <span className={`text-[11px] px-2 py-0.5 rounded-md font-medium ${
                                meta.status === 'success' ? 'text-emerald-300 bg-emerald-500/10' : 'text-red-300 bg-red-500/10'
                              }`}>
                                {meta.status === 'success' ? '✓' : '✗'} {meta.status}
                              </span>
                            )}
                          </div>
                        )}

                        {/* ── Bot trap rich display ── */}
                        {isBotTrap && meta && (
                          <div className="mt-2 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {meta.reason && (
                                <span className="text-[11px] text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md font-medium">
                                  🛡️ {meta.reason.replace(/_/g, ' ')}
                                </span>
                              )}
                              {meta.attemptedEmail && (
                                <span className="text-[11px] text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-md font-mono">
                                  ✉ {meta.attemptedEmail}
                                </span>
                              )}
                              {meta.attemptedUsername && (
                                <span className="text-[11px] text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-md font-mono">
                                  👤 {meta.attemptedUsername}
                                </span>
                              )}
                            </div>
                            {meta.blockedAt && (
                              <span className="text-[10px] text-slate-500">
                                Blocked: {new Date(meta.blockedAt).toLocaleString()}
                              </span>
                            )}
                            {meta.unblocked && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md">
                                <Unlock size={10} />
                                Unblocked {meta.unblockedAt ? new Date(meta.unblockedAt).toLocaleDateString() : ''}
                              </span>
                            )}
                            {meta.device?.summary && !hasIpInfo && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 bg-white/5 px-2 py-0.5 rounded-md">
                                <DeviceIcon device={meta.device?.device} />
                                {meta.device.summary}
                              </span>
                            )}
                          </div>
                        )}

                        {/* ── Error details (expandable) ── */}
                        {meta?.errorMessage && (
                          <div className="mt-2">
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => toggleErrorExpand(log.id)}
                                className="flex items-center gap-1 text-[11px] text-red-400/70 hover:text-red-400 transition-colors"
                              >
                                <Bug size={10} />
                                {expandedErrors.has(log.id) ? 'Hide details' : 'Show error details'}
                              </button>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify({ ...log, metadata: meta }, null, 2));
                                  setCopiedId(log.id);
                                  setTimeout(() => setCopiedId(null), 2000);
                                }}
                                className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-emerald-400 transition-colors"
                              >
                                {copiedId === log.id ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                                {copiedId === log.id ? 'Copied!' : 'Copy Debug'}
                              </button>
                            </div>
                            {expandedErrors.has(log.id) && (
                              <div className="mt-2 p-3 rounded-lg bg-red-500/5 border border-red-500/10 text-xs space-y-1.5">
                                {meta.endpoint && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Endpoint:</span> <code className="text-red-300">{meta.endpoint}</code>
                                  </div>
                                )}
                                {meta.projectName && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Project:</span> {meta.projectName}
                                  </div>
                                )}
                                {meta.componentName && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Component:</span> {meta.componentName}
                                  </div>
                                )}
                                {meta.errorCode && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Code:</span> <code className="text-amber-300">{meta.errorCode}</code>
                                  </div>
                                )}
                                {meta.httpStatus && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">HTTP Status:</span> <code className="text-amber-300">{meta.httpStatus}</code>
                                  </div>
                                )}
                                {meta.stackTrace && (
                                  <details className="mt-1">
                                    <summary className="text-slate-500 cursor-pointer hover:text-slate-400 text-[10px]">Stack Trace</summary>
                                    <pre className="mt-1 p-2 rounded bg-black/30 text-[10px] text-slate-400 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
                                      {meta.stackTrace}
                                    </pre>
                                  </details>
                                )}
                                {meta.context && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Context:</span> {meta.context}
                                  </div>
                                )}
                                {meta.sessionId && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Session:</span> <code className="text-slate-500">{meta.sessionId}</code>
                                  </div>
                                )}
                                {meta.route && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Route:</span> <code className="text-cyan-300">{meta.route}</code>
                                  </div>
                                )}
                                {meta.title && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">Page:</span> {meta.title}
                                  </div>
                                )}
                                {meta.userAgent && (
                                  <div className="text-slate-400">
                                    <span className="text-slate-500">UA:</span> <span className="break-all">{meta.userAgent}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Unblock button for IP_BLOCKED */}
                        {isBlocked && !isUnblocked && (meta?.ip || log.ipAddress) && (
                          <button
                            onClick={() => handleUnblock(meta?.ip || log.ipAddress!, log.id)}
                            disabled={unblocking === log.id}
                            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all duration-200 disabled:opacity-50"
                          >
                            <Unlock size={12} />
                            {unblocking === log.id ? 'Unblocking...' : `Unblock ${meta?.ip || log.ipAddress}`}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {pages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/10 bg-gradient-to-r from-white/[0.01] to-transparent">
            <span className="text-xs text-slate-500">
              Page {page} of {pages} · {total} entries
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              {Array.from({ length: Math.min(5, pages) }, (_, i) => {
                const start = Math.max(1, Math.min(page - 2, pages - 4));
                const p = start + i;
                if (p > pages) return null;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-7 h-7 text-xs rounded-lg transition-colors ${
                      p === page ? 'bg-emerald-500/20 text-emerald-400 font-medium' : 'text-slate-500 hover:bg-white/5'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
              <button
                onClick={() => setPage(Math.min(pages, page + 1))}
                disabled={page >= pages}
                className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
