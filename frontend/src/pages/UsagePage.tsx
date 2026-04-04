import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { usageAPI } from '../api/endpoints';
import {
  Users, Activity, Timer, Zap, RefreshCw, Loader2, AlertTriangle, Copy, Check,
} from 'lucide-react';

/* ─── types ─────────────────────────────────────────────── */

interface UsageStats {
  totalSessions: number;
  activeSessions: number;
  cronJobs: number;
  activeCrons: number;
  modelBreakdown: Array<{ model: string; sessions: number }>;
  recentSessions: Array<{
    key: string;
    agent: string;
    model: string;
    lastActivity: number;
    turns: number;
  }>;
}

/* ─── helpers ───────────────────────────────────────────── */

function formatRelativeTime(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function truncateSessionKey(key: string, maxLen = 24): string {
  if (!key) return '';
  if (key.length <= maxLen) return key;
  return key.slice(0, maxLen - 3) + '…';
}

/* ─── animation variants ────────────────────────────────── */

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const cardVariant = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 20 } },
};

/* ─── colors ────────────────────────────────────────────── */

const MODEL_COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#F43F5E', '#06B6D4', '#EC4899', '#84CC16'];

/* ─── summary card ──────────────────────────────────────── */

interface SummaryCardProps {
  icon: any;
  label: string;
  value: number;
  color: string;
  loading?: boolean;
}

function SummaryCard({ icon: Icon, label, value, color, loading }: SummaryCardProps) {
  return (
    <motion.div
      variants={cardVariant}
      className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-transparent backdrop-blur-xl p-5 flex flex-col gap-3 hover:border-white/[0.1] transition-colors"
    >
      <div className="flex items-center gap-2.5">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: `${color}15`, color }}
        >
          <Icon size={20} />
        </div>
        <span className="text-sm text-slate-400 font-medium">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        {loading ? (
          <div className="h-9 w-16 bg-white/5 rounded animate-pulse" />
        ) : (
          <span className="text-4xl font-bold tracking-tight" style={{ color }}>
            {value.toLocaleString()}
          </span>
        )}
      </div>
    </motion.div>
  );
}

/* ─── skeleton loaders ──────────────────────────────────── */

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-10 h-10 rounded-xl bg-white/5 animate-pulse" />
        <div className="h-4 w-20 bg-white/5 rounded animate-pulse" />
      </div>
      <div className="h-9 w-16 bg-white/5 rounded animate-pulse" />
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-12 bg-white/[0.02] rounded-lg animate-pulse" />
      ))}
    </div>
  );
}

/* ─── model breakdown chart ─────────────────────────────── */

interface ModelBreakdownProps {
  data: Array<{ model: string; sessions: number }>;
  loading?: boolean;
}

function ModelBreakdown({ data, loading }: ModelBreakdownProps) {
  const chartData = useMemo(() => {
    return data.slice(0, 8).map((item) => ({
      ...item,
      // Shorten model name for display
      displayName: (typeof item.model === 'string' && item.model.includes('/'))
        ? item.model.split('/').slice(-1)[0]
        : String(item.model || ''),
    }));
  }, [data]);

  if (loading) {
    return (
      <motion.div
        variants={cardVariant}
        className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-transparent backdrop-blur-xl p-6"
      >
        <h3 className="text-lg font-semibold text-white mb-4">Model Breakdown</h3>
        <div className="h-[200px] bg-white/[0.02] rounded-lg animate-pulse" />
      </motion.div>
    );
  }

  if (!data.length) {
    return (
      <motion.div
        variants={cardVariant}
        className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-transparent backdrop-blur-xl p-6"
      >
        <h3 className="text-lg font-semibold text-white mb-4">Model Breakdown</h3>
        <p className="text-slate-500 text-sm">No session data available</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={cardVariant}
      className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-transparent backdrop-blur-xl p-6"
    >
      <h3 className="text-lg font-semibold text-white mb-4">Model Breakdown</h3>
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 20, top: 5, bottom: 5 }}>
            <XAxis type="number" hide />
            <YAxis 
              type="category" 
              dataKey="displayName" 
              tick={{ fill: '#94A3B8', fontSize: 12 }}
              width={120}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                background: 'rgba(13, 17, 48, 0.95)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '8px 12px',
              }}
              labelStyle={{ color: '#fff', fontWeight: 600 }}
              formatter={(value: number) => [`${value} sessions`, 'Count']}
            />
            <Bar dataKey="sessions" radius={[0, 4, 4, 0]}>
              {chartData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={MODEL_COLORS[index % MODEL_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}

/* ─── recent sessions table ─────────────────────────────── */

interface RecentSessionsProps {
  sessions: UsageStats['recentSessions'];
  loading?: boolean;
}

function RecentSessions({ sessions, loading }: RecentSessionsProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = useCallback((key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  if (loading) {
    return (
      <motion.div
        variants={cardVariant}
        className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-transparent backdrop-blur-xl p-6"
      >
        <h3 className="text-lg font-semibold text-white mb-4">Recent Sessions</h3>
        <SkeletonTable />
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={cardVariant}
      className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-transparent backdrop-blur-xl p-6"
    >
      <h3 className="text-lg font-semibold text-white mb-4">Recent Sessions</h3>
      {sessions.length === 0 ? (
        <p className="text-slate-500 text-sm">No sessions found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-white/[0.06]">
                <th className="pb-3 font-medium">Session</th>
                <th className="pb-3 font-medium">Agent</th>
                <th className="pb-3 font-medium">Model</th>
                <th className="pb-3 font-medium text-right">Last Activity</th>
                <th className="pb-3 font-medium text-right">Turns</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, idx) => (
                <tr
                  key={session.key}
                  className={`border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors cursor-pointer ${
                    idx % 2 === 0 ? 'bg-white/[0.01]' : ''
                  }`}
                  onClick={() => handleCopy(session.key)}
                  title="Click to copy session key"
                >
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-300 font-mono text-xs">
                        {truncateSessionKey(session.key)}
                      </span>
                      {copiedKey === session.key ? (
                        <Check size={14} className="text-emerald-400" />
                      ) : (
                        <Copy size={14} className="text-slate-500 opacity-0 group-hover:opacity-100" />
                      )}
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="text-slate-400">{session.agent}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="text-slate-300 font-mono text-xs">
                      {(typeof session.model === 'string' && session.model.includes('/'))
                        ? session.model.split('/').slice(-1)[0]
                        : String(session.model || '')}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right">
                    <span className="text-slate-500 text-xs">
                      {session.lastActivity ? formatRelativeTime(session.lastActivity) : '—'}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <span className="text-slate-400">{session.turns}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}

/* ─── Content Props ─────────────────────────────────────── */

interface UsageContentProps {
  agentId?: string;
  showHeader?: boolean;
}

/* ─── Embeddable Content Component ──────────────────────── */

export function UsageContent({ agentId, showHeader = false }: UsageContentProps) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const effectiveAgentId = agentId && agentId !== 'main' ? agentId : undefined;
      const data = await usageAPI.stats(effectiveAgentId);
      setStats(data);
    } catch (err: any) {
      console.error('[UsagePage] Failed to fetch stats:', err);
      setError(err.message || 'Failed to load usage statistics');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [agentId]);

  // Initial fetch
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchStats(true), 60000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  return (
    <div className="h-full overflow-auto p-6 md:p-8">
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-7xl mx-auto space-y-6"
      >
        {/* Header - only shown when used standalone or showHeader is true */}
        {showHeader && (
          <motion.div variants={cardVariant} className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">Usage & Sessions</h1>
              <p className="text-slate-400 text-sm mt-1">Session counts, model usage, and automation statistics</p>
            </div>
            <button
              onClick={() => fetchStats(true)}
              disabled={refreshing || loading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.06] text-slate-300 text-sm font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </motion.div>
        )}

        {/* Compact refresh button when embedded */}
        {!showHeader && (
          <div className="flex justify-end">
            <button
              onClick={() => fetchStats(true)}
              disabled={refreshing || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 text-sm transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        )}

        {/* Error state */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400"
            >
              <AlertTriangle size={20} />
              <span className="flex-1">{error}</span>
              <button
                onClick={() => fetchStats()}
                className="px-3 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-sm font-medium transition-colors"
              >
                Retry
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : (
            <>
              <SummaryCard
                icon={Users}
                label="Total Sessions"
                value={stats?.totalSessions || 0}
                color="#10B981"
              />
              <SummaryCard
                icon={Activity}
                label="Active Sessions"
                value={stats?.activeSessions || 0}
                color="#3B82F6"
              />
              <SummaryCard
                icon={Timer}
                label="Cron Jobs"
                value={stats?.cronJobs || 0}
                color="#8B5CF6"
              />
              <SummaryCard
                icon={Zap}
                label="Active Crons"
                value={stats?.activeCrons || 0}
                color="#F59E0B"
              />
            </>
          )}
        </div>

        {/* Model Breakdown & Recent Sessions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ModelBreakdown data={stats?.modelBreakdown || []} loading={loading} />
          <RecentSessions sessions={stats?.recentSessions || []} loading={loading} />
        </div>
      </motion.div>
    </div>
  );
}

/* ─── Main Page Component (Standalone) ──────────────────── */

export default function UsagePage() {
  return <UsageContent showHeader={true} />;
}
