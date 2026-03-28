import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
// Link removed — onboarding cards removed
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { io, Socket } from 'socket.io-client';
import { metricsAPI, alertsAPI } from '../api/endpoints';
import { Metrics, ActivityLog } from '../types';
import ActivityLogTable from '../components/ActivityLogTable';
import client from '../api/client';
import {
  Cpu, HardDrive, Wifi,
  AlertTriangle, MemoryStick,
  ArrowDown, ArrowUp, RefreshCw,
  Gauge, Layers, Timer, Loader2,
} from 'lucide-react';

/* ─── helpers ──────────────────────────────────────────── */

function formatBytes(bytes: number | bigint | string, decimals = 1): string {
  const b = typeof bytes === 'string' ? parseFloat(bytes) : Number(bytes);
  if (b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(decimals) + ' ' + sizes[i];
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function statusColor(v: number): string {
  if (v < 50) return '#10B981';
  if (v < 80) return '#F59E0B';
  return '#EF4444';
}

function statusClass(v: number): string {
  if (v < 50) return 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/20';
  if (v < 80) return 'from-amber-500/20 to-amber-500/5 border-amber-500/20';
  return 'from-red-500/20 to-red-500/5 border-red-500/20';
}

function statusBg(v: number): string {
  if (v < 50) return 'bg-emerald-500';
  if (v < 80) return 'bg-amber-500';
  return 'bg-red-500';
}

/* ─── animation variants ───────────────────────────────── */

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const cardVariant = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 20 } },
};

/* ─── sparkline ────────────────────────────────────────── */

function Sparkline({ data, color, height = 40 }: { data: number[]; color: string; height?: number }) {
  const chartData = useMemo(() => data.map((v, i) => ({ i, v })), [data]);
  if (chartData.length < 2) return null;
  const id = useMemo(() => `spark-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${id})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ─── metric card ──────────────────────────────────────── */

interface MetricCardProps {
  icon: any;
  label: string;
  value: string;
  unit: string;
  percent?: number;
  color: string;
  sparkData?: number[];
  subtitle?: string;
}

function MetricCard({ icon: Icon, label, value, unit, percent, color, sparkData, subtitle }: MetricCardProps) {
  const pct = percent ?? 0;
  const sc = statusColor(pct);

  return (
    <motion.div
      variants={cardVariant}
      className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br backdrop-blur-xl p-5 flex flex-col gap-3 hover-lift hover-glow ${
        percent !== undefined ? statusClass(pct) : 'from-slate-500/10 to-slate-500/5 border-white/[0.08]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: `${color}15`, color }}
          >
            <Icon size={18} />
          </div>
          <div>
            <span className="text-sm text-slate-400 font-medium">{label}</span>
            {subtitle && <p className="text-[10px] text-slate-500 leading-tight">{subtitle}</p>}
          </div>
        </div>
        {percent !== undefined && (
          <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: sc }} />
        )}
      </div>

      {/* Value */}
      <div className="flex items-end justify-between">
        <div>
          <span className="text-3xl font-bold tracking-tight" style={{ color: percent !== undefined ? sc : color }}>
            {value}
          </span>
          <span className="text-sm text-slate-400 ml-1.5">{unit}</span>
        </div>
      </div>

      {/* Progress bar */}
      {percent !== undefined && (
        <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(pct, 100)}%` }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            className="h-full rounded-full"
            style={{ backgroundColor: sc }}
          />
        </div>
      )}

      {/* Sparkline */}
      {sparkData && sparkData.length > 2 && (
        <div className="mt-1">
          <Sparkline data={sparkData} color={percent !== undefined ? sc : color} height={36} />
        </div>
      )}
    </motion.div>
  );
}

/* ─── main dashboard ──────────────────────────────────── */

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metadata, setMetadata] = useState<any>(null);
  const [history, setHistory] = useState<Metrics[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [activeAlerts, setActiveAlerts] = useState<ActivityLog[]>([]);
  const [updateStatus, setUpdateStatus] = useState<{ current: string; latest: string | null; updateAvailable: boolean } | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [openClawStatus, setOpenClawStatus] = useState<'checking' | 'connected' | 'misconfigured' | 'offline'>('checking');
  const [openClawIssues, setOpenClawIssues] = useState<string[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  // readiness + recentActivity sections removed per design cleanup
  const socketRef = useRef<Socket | null>(null);

  // Socket.io real-time connection
  useEffect(() => {
    const wsUrl = import.meta.env.VITE_WS_URL || import.meta.env.VITE_API_URL?.replace('/api', '') || window.location.origin;
    const socket = io(`${wsUrl}/metrics`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('metrics', (data: any) => {
      const m: Metrics = {
        ...data,
        memoryTotal: data.memoryTotal,
        diskTotal: data.diskTotal,
        networkIn: data.networkIn,
        networkOut: data.networkOut,
      };
      setMetrics(m);
      setMetadata(data.metadata || null);
      setLastUpdate(new Date());
      setHistory(prev => {
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        const filtered = [...prev, m].filter(
          x => new Date(x.timestamp).getTime() > sixHoursAgo
        );
        return filtered;
      });
    });

    socketRef.current = socket;

    // Alerts socket
    const alertSocket = io(`${wsUrl}/alerts`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    alertSocket.on('alert', (alert: any) => {
      const newAlert: ActivityLog = {
        id: `rt-${Date.now()}`,
        action: 'SYSTEM_ALERT',
        resource: alert.resource,
        severity: alert.severity,
        translatedMessage: alert.translatedMessage,
        createdAt: new Date().toISOString(),
      };
      setActiveAlerts(prev => [newAlert, ...prev].slice(0, 20));
    });

    return () => { socket.disconnect(); alertSocket.disconnect(); };
  }, []);



  // Initial data fetch
  const fetchData = useCallback(async () => {
    try {
      const [m, h, al, upd, gateway] = await Promise.all([
        metricsAPI.latest().catch(() => null),
        metricsAPI.history(6).catch(() => []),
        alertsAPI.list({ limit: 10, severity: 'CRITICAL' }).catch(() => ({ alerts: [], total: 0 })),
        client.post('/admin/check-updates', {}, { _silent: true } as any).then(r => r.data).catch(() =>
          client.get('/admin/update-status', { _silent: true } as any).then(r => r.data).catch(() => null)
        ),
        client.get('/gateway/health', { _silent: true } as any).then(r => r.data).catch(() => null),
      ]);
      if (gateway?.ok) {
        setOpenClawStatus('connected');
        setOpenClawIssues([]);
      } else if (gateway?.connected && !gateway?.wsConnected) {
        // Gateway process is reachable but the authenticated WS channel is down — chat won't work
        setOpenClawStatus('offline');
        setOpenClawIssues(gateway?.issues || ['Gateway is reachable but agent chat connection failed. Try restarting the portal service.']);
      } else if (gateway?.connected && !gateway?.modelsConfigured) {
        setOpenClawStatus('misconfigured');
        setOpenClawIssues(gateway?.issues || ['No AI models configured. Run "openclaw onboard" on the server.']);
      } else {
        setOpenClawStatus('offline');
        setOpenClawIssues(gateway?.issues || []);
      }
      if (upd) {
        setUpdateStatus(upd);
        const latest = typeof upd?.latest === 'string' ? upd.latest : null;
        if (latest && localStorage.getItem(`dashboard-update-dismissed:${latest}`) === 'true') {
          setUpdateBannerDismissed(true);
        } else {
          setUpdateBannerDismissed(false);
        }
      }
      if (m) { setMetrics(m); setMetadata((m as any).metadata || null); }
      if (Array.isArray(h)) setHistory(h);
      if (al.alerts?.length) {
        setActiveAlerts(prev => {
          const ids = new Set(prev.map(p => p.id));
          const merged = [...prev];
          for (const alert of al.alerts) {
            if (!ids.has(alert.id)) merged.push(alert);
          }
          return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 20);
        });
      }
    } catch (err) { console.error('[Dashboard] Failed to fetch data:', err); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Fallback polling if WebSocket disconnects
  useEffect(() => {
    if (connected) return;
    const iv = setInterval(async () => {
      try {
        const m = await metricsAPI.latest();
        if (m) { setMetrics(m); setMetadata((m as any).metadata || null); setLastUpdate(new Date()); }
      } catch (err) { console.error('[Dashboard] Metrics poll error:', err); }
    }, 10000);
    return () => clearInterval(iv);
  }, [connected]);

  // Derived sparkline data
  const cpuHistory = useMemo(() => history.map(m => m.cpuUsage), [history]);
  const memHistory = useMemo(() => history.map(m => m.memoryUsage), [history]);
  const diskHistory = useMemo(() => history.map(m => m.diskUsage), [history]);
  const netInHistory = useMemo(() => history.map(m => Number(m.networkIn) / 1024 / 1024), [history]);
  const netOutHistory = useMemo(() => history.map(m => Number(m.networkOut) / 1024 / 1024), [history]);
  const processHistory = useMemo(() => history.map(m => m.processCount), [history]);

  const chartData = useMemo(() => history.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu: m.cpuUsage,
    memory: m.memoryUsage,
    disk: m.diskUsage,
    netIn: Number(m.networkIn) / 1024 / 1024,
    netOut: Number(m.networkOut) / 1024 / 1024,
  })), [history]);

  const uptimeSeconds = metadata?.uptimeSeconds || 0;
  const cpuCores = metadata?.cpuCores || 0;
  const memUsedGB = metadata?.memoryUsedBytes ? (metadata.memoryUsedBytes / 1073741824).toFixed(1) : '—';
  const memTotalGB = metrics?.memoryTotal ? (Number(metrics.memoryTotal) / 1073741824).toFixed(1) : '—';
  const diskTotalGB = metrics?.diskTotal ? (Number(metrics.diskTotal) / 1073741824).toFixed(0) : '—';
  const loadAvg = metrics?.loadAverage || [];

  const showUpdateBanner = Boolean(updateStatus?.updateAvailable && updateStatus.latest && !updateBannerDismissed);

  const dismissUpdateBanner = () => {
    if (updateStatus?.latest) {
      localStorage.setItem(`dashboard-update-dismissed:${updateStatus.latest}`, 'true');
    }
    setUpdateBannerDismissed(true);
  };

  const runSelfUpdate = useCallback(async () => {
    try {
      setUpdateInProgress(true);
      setUpdateMessage('Updating... This may take a minute.');
      const { data } = await client.post('/admin/self-update');
      const logFile = data?.logFile;
      if (logFile) {
        try {
          await client.get(`/admin/self-update/log?file=${encodeURIComponent(logFile)}`, { _silent: true } as any);
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 5000));

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch('/health', { cache: 'no-store' });
          if (res.ok) {
            setUpdateMessage('Update complete! Refreshing...');
            window.location.reload();
            return;
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      setUpdateMessage('Update may have failed. Check server logs.');
      setUpdateInProgress(false);
    } catch (err: any) {
      setUpdateMessage(err?.response?.data?.error || 'Update may have failed. Check server logs.');
      setUpdateInProgress(false);
    }
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-3 sm:p-5 md:p-7 lg:p-10 space-y-5 sm:space-y-7 max-w-[1800px] mx-auto overflow-y-auto h-full overflow-x-hidden"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Server Dashboard</h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-1">Real-time system monitoring & analytics</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {/* Connection status */}
          <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-full glass-sm text-xs">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
            <span className="text-slate-400">{connected ? 'Live' : 'Polling'}</span>
          </div>
          {lastUpdate && (
            <span className="text-xs text-slate-500 hidden sm:block">
              Updated {lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button
            onClick={fetchData}
            className="p-2 rounded-lg hover:bg-white/5 transition-colors text-slate-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {showUpdateBanner && updateStatus?.latest && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative overflow-hidden rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-500/15 via-sky-500/10 to-blue-500/15 p-5 shadow-[0_0_30px_rgba(34,211,238,0.12)]"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(45,212,191,0.18),transparent_35%)] pointer-events-none" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold text-cyan-200">Update available: v{updateStatus.latest} (you have v{updateStatus.current})</p>
              <p className="mt-1 text-sm text-slate-300">Install the latest portal bundle to pick up fixes and improvements.</p>
              {updateMessage && (
                <p className="mt-2 text-sm text-cyan-50">{updateMessage}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={runSelfUpdate}
                disabled={updateInProgress}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/80 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {updateInProgress ? <Loader2 size={16} className="animate-spin" /> : null}
                Update Now
              </button>
              <button
                onClick={dismissUpdateBanner}
                disabled={updateInProgress}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-70"
              >
                Dismiss
              </button>
            </div>
          </div>
        </motion.div>
      )}

      <div className="flex flex-wrap items-start gap-3">
        <div className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
          openClawStatus === 'connected' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
          : openClawStatus === 'misconfigured' ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
          : openClawStatus === 'checking' ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
          : 'border-red-500/20 bg-red-500/10 text-red-300'
        }`}>
          <span className={`h-2.5 w-2.5 rounded-full ${
            openClawStatus === 'connected' ? 'bg-emerald-400'
            : openClawStatus === 'misconfigured' ? 'bg-amber-400'
            : openClawStatus === 'checking' ? 'bg-amber-400 animate-pulse'
            : 'bg-red-400'
          }`} />
          <span>OpenClaw {
            openClawStatus === 'connected' ? 'Connected'
            : openClawStatus === 'misconfigured' ? 'Needs Setup'
            : openClawStatus === 'checking' ? 'Checking...'
            : 'Offline'
          }</span>
        </div>
        {(openClawStatus === 'offline' || openClawStatus === 'misconfigured') && openClawIssues.length > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            <span className="flex-1">{openClawIssues[0]}</span>
            <button
              onClick={async () => {
                setReconnecting(true);
                try {
                  const { data } = await client.post('/gateway/reconnect');
                  if (data?.ok) {
                    setOpenClawStatus('connected');
                    setOpenClawIssues([]);
                  } else {
                    setOpenClawIssues([data?.message || 'Reconnect failed']);
                  }
                } catch {
                  setOpenClawIssues(['Reconnect request failed']);
                } finally {
                  setReconnecting(false);
                  fetchData();
                }
              }}
              disabled={reconnecting}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/20 hover:bg-amber-500/30 px-3 py-1 text-xs font-medium text-amber-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {reconnecting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {reconnecting ? 'Reconnecting…' : 'Reconnect'}
            </button>
          </div>
        )}
        {openClawStatus === 'offline' && openClawIssues.length === 0 && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            OpenClaw gateway is not responding. Check Settings → System.
          </div>
        )}
      </div>

      {/* Critical Alert Banner */}
      <AnimatePresence>
        {activeAlerts.filter(a => (a.severity === 'CRITICAL' || a.severity === 'ERROR') && !(a.metadata as any)?.dismissedAt).length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -10, height: 0 }}
            className="rounded-xl border border-red-500/30 bg-red-500/10 backdrop-blur-xl p-4"
          >
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={18} className="text-red-400" />
              <span className="text-sm font-medium text-red-300">System Alerts</span>
              <span className="text-xs text-red-400/70 ml-1">
                ({activeAlerts.filter(a => (a.severity === 'CRITICAL' || a.severity === 'ERROR') && !(a.metadata as any)?.dismissedAt).length})
              </span>
            </div>
            <div className="space-y-1.5">
              {activeAlerts
                .filter(a => (a.severity === 'CRITICAL' || a.severity === 'ERROR') && !(a.metadata as any)?.dismissedAt)
                .slice(0, 5)
                .map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        alert.severity === 'CRITICAL' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        {alert.resource}
                      </span>
                      <span className="text-slate-300 truncate">{alert.translatedMessage}</span>
                      <span className="text-xs text-slate-500 shrink-0">
                        {new Date(alert.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <button
                      onClick={async () => {
                        // Optimistically mark as dismissed in local state
                        setActiveAlerts(prev => prev.map(a => 
                          a.id === alert.id 
                            ? { ...a, metadata: { ...(a.metadata as any || {}), dismissedAt: new Date().toISOString() } }
                            : a
                        ));
                        // Save to backend (skip for real-time alerts)
                        if (!alert.id.startsWith('rt-')) {
                          alertsAPI.dismiss(alert.id).catch(() => {});
                        }
                      }}
                      className="shrink-0 text-xs text-slate-500 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Metric Cards Grid */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
      >
        <MetricCard
          icon={Cpu}
          label="CPU Usage"
          color="#10B981"
          value={metrics?.cpuUsage?.toFixed(1) ?? '—'}
          unit="%"
          percent={metrics?.cpuUsage}
          sparkData={cpuHistory}
          subtitle={cpuCores ? `${cpuCores} cores` : undefined}
        />
        <MetricCard
          icon={MemoryStick}
          label="Memory"
          color="#3B82F6"
          value={metrics?.memoryUsage?.toFixed(1) ?? '—'}
          unit="%"
          percent={metrics?.memoryUsage}
          sparkData={memHistory}
          subtitle={`${memUsedGB} / ${memTotalGB} GB`}
        />
        <MetricCard
          icon={HardDrive}
          label="Disk Usage"
          color="#8B5CF6"
          value={metrics?.diskUsage?.toFixed(1) ?? '—'}
          unit="%"
          percent={metrics?.diskUsage}
          sparkData={diskHistory}
          subtitle={`${diskTotalGB} GB total`}
        />
        <MetricCard
          icon={ArrowDown}
          label="Network In"
          color="#06B6D4"
          value={metrics?.networkIn ? (Number(metrics.networkIn) / 1024 / 1024).toFixed(2) : '—'}
          unit="MB/s"
          sparkData={netInHistory}
        />
        <MetricCard
          icon={ArrowUp}
          label="Network Out"
          color="#F59E0B"
          value={metrics?.networkOut ? (Number(metrics.networkOut) / 1024 / 1024).toFixed(2) : '—'}
          unit="MB/s"
          sparkData={netOutHistory}
        />
        <MetricCard
          icon={Layers}
          label="Processes"
          color="#EC4899"
          value={metrics?.processCount?.toString() ?? '—'}
          unit="running"
          sparkData={processHistory}
        />
        <MetricCard
          icon={Gauge}
          label="Load Average"
          color="#F97316"
          value={loadAvg.length >= 1 ? loadAvg[0].toFixed(2) : '—'}
          unit={loadAvg.length >= 3 ? `${loadAvg[1]?.toFixed(1)} / ${loadAvg[2]?.toFixed(1)}` : '1 / 5 / 15m'}
          subtitle="1 / 5 / 15 min"
        />
        <MetricCard
          icon={Timer}
          label="Uptime"
          color="#14B8A6"
          value={uptimeSeconds ? formatUptime(uptimeSeconds) : '—'}
          unit=""
          subtitle={metadata?.hostname || ''}
        />
      </motion.div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="glass hover-glow p-5"
        >
          <h3 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
            <Cpu size={14} className="text-emerald-400" />
            CPU & Memory (6h)
          </h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} width={35} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(26,31,58,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12,
                  color: '#F0F4F8',
                  backdropFilter: 'blur(12px)',
                }}
              />
              <Area type="monotone" dataKey="cpu" stroke="#10B981" fill="url(#cpuGrad)" strokeWidth={2} name="CPU %" />
              <Area type="monotone" dataKey="memory" stroke="#3B82F6" fill="url(#memGrad)" strokeWidth={2} name="Memory %" />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="glass hover-glow p-5"
        >
          <h3 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
            <Wifi size={14} className="text-cyan-400" />
            Network I/O (6h)
          </h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="netInGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06B6D4" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#06B6D4" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="netOutGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#F59E0B" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(26,31,58,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12,
                  color: '#F0F4F8',
                  backdropFilter: 'blur(12px)',
                }}
                formatter={(v: number) => `${v.toFixed(2)} MB/s`}
              />
              <Area type="monotone" dataKey="netIn" stroke="#06B6D4" fill="url(#netInGrad)" strokeWidth={2} name="In" />
              <Area type="monotone" dataKey="netOut" stroke="#F59E0B" fill="url(#netOutGrad)" strokeWidth={2} name="Out" />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>
      </div>

      {/* Activity Log */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        <ActivityLogTable />
      </motion.div>
    </motion.div>
  );
}
