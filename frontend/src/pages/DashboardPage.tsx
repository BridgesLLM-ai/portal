import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UNSAFE_NavigationContext } from 'react-router-dom';
// Link removed — onboarding cards removed
import { io, Socket } from 'socket.io-client';
import { metricsAPI, alertsAPI, systemStatsAPI, type SystemStats } from '../api/endpoints';
import { Metrics, ActivityLog } from '../types';
import ActivityLogTable from '../components/ActivityLogTable';
import client from '../api/client';
import { maintenanceAPI, type MaintenanceSeverity, type MaintenanceStatus } from '../api/maintenance';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated, isOwner } from '../utils/authz';
import { mergeDashboardMetricHistory } from '../utils/dashboardMetrics';
import { maintenancePollDelayMs, shouldPollMaintenance } from './settingsAdminContract';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';
import {
  createFreshBackupForUpdate,
  describeUpdateBackup,
  waitForExpectedPortalVersion,
  type PortalUpdatePreparation,
} from '../utils/updatePreparation';
import {
  Cpu, HardDrive,
  AlertTriangle, MemoryStick,
  ArrowDown, ArrowUp, RefreshCw,
  Gauge, Layers, Timer, Loader2,
  ShieldAlert, Wrench, CheckCircle2, ChevronDown,
} from 'lucide-react';

const LazyDashboardCharts = lazy(() => import('../components/dashboard/DashboardCharts'));

type OpenClawVersionStatus = {
  installedVersion: string | null;
  runningVersion: string | null;
  latestVersion: string | null;
  updateChannel: string | null;
  mismatch: boolean;
  restartRecommended: boolean;
  reason: string | null;
  listenerPid: number | null;
  listenerStartedAt: string | null;
  installedPackageMtime: string | null;
  probeOk: boolean;
  probeError?: string | null;
  cached?: boolean;
  lightweight?: boolean;
  checkedAt?: string;
};

type ReleaseClass = 'hotfix' | 'security' | 'feature' | 'maintenance';
type VerifiedReleaseDetails = {
  version: string;
  releasedAt: string;
  releaseClass: ReleaseClass;
  highlights: string[];
  provenance: 'signed-release-manifest';
};
type UpdateStatus = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  details: VerifiedReleaseDetails | null;
  detailsStatus: 'verified' | 'unavailable';
  preparation?: PortalUpdatePreparation;
};

type PortalUpdatePlan = 'create-backup' | 'use-current' | 'skip-backup';

const MAINTENANCE_DISMISS_KEY = 'dashboard-maintenance-dismissed-signature';
const DASHBOARD_MAINTENANCE_MAX_POLL_ATTEMPTS = 6;
const DASHBOARD_MAINTENANCE_POLL_DEADLINE_MS = 45_000;
const DASHBOARD_MAINTENANCE_MAX_POLL_DELAY_MS = 8_000;
const DASHBOARD_GATEWAY_FORCE_PROBE_MAX_ATTEMPTS = 3;
const DASHBOARD_GATEWAY_FORCE_PROBE_INITIAL_DELAY_MS = 1_600;
const DASHBOARD_GATEWAY_FORCE_PROBE_MAX_DELAY_MS = 5_000;

type RenderableMaintenanceStatus = MaintenanceStatus & {
  host: NonNullable<MaintenanceStatus['host']>;
};

type MaintenancePollBudget = {
  startedAt: number;
  attempts: number;
};

function isMaintenanceStatus(value: unknown): value is MaintenanceStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<MaintenanceStatus>;
  return ['healthy', 'info', 'warning', 'critical'].includes(String(status.status))
    && typeof status.summary === 'string'
    && (status.checkedAt === null || typeof status.checkedAt === 'string')
    && Array.isArray(status.issues)
    && Array.isArray(status.actions);
}

function hasRenderableMaintenanceHost(status: MaintenanceStatus): status is RenderableMaintenanceStatus {
  return Boolean(status.host
    && typeof status.host.hostname === 'string'
    && typeof status.host.os === 'string'
    && typeof status.host.kernel === 'string'
    && Number.isFinite(status.host.uptimeSeconds));
}

function maintenanceDismissSignature(status: MaintenanceStatus): string {
  const issues = [...(status.issues || [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((issue) => `${issue.id}:${issue.severity}:${issue.actionId || ''}:${issue.detail}`)
    .join('|');
  const compatibility = status.compatibility?.components
    .map((component) => `${component.id}:${component.status}:${component.installedVersion || ''}`)
    .join('|') || '';
  return `${status.status}::${issues}::${compatibility}`;
}

/* ─── helpers ──────────────────────────────────────────── */

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Adaptive rate units: an idle appliance sits at a few hundred B/s, which a
// fixed MB/s tile rendered as a dead-looking "0.00MB/s".
function formatNetworkRate(bytesPerSecond: number): { value: string; unit: string } {
  if (bytesPerSecond >= 1024 * 1024) {
    return { value: (bytesPerSecond / 1024 / 1024).toFixed(2), unit: 'MB/s' };
  }
  if (bytesPerSecond >= 1024) {
    return { value: (bytesPerSecond / 1024).toFixed(1), unit: 'KB/s' };
  }
  return { value: String(Math.round(bytesPerSecond)), unit: 'B/s' };
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

function maintenanceTone(status: MaintenanceSeverity): string {
  if (status === 'critical') return 'border-red-500/30 bg-red-500/10 text-red-100';
  if (status === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-100';
  if (status === 'info') return 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100';
  return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100';
}

function maintenanceDot(status: MaintenanceSeverity): string {
  if (status === 'critical') return 'bg-red-400';
  if (status === 'warning') return 'bg-amber-400';
  if (status === 'info') return 'bg-cyan-400';
  return 'bg-emerald-400';
}

function verifiedUpdateDetails(status: UpdateStatus | null): VerifiedReleaseDetails | null {
  const details = status?.details;
  if (!details
    || status?.detailsStatus !== 'verified'
    || details.provenance !== 'signed-release-manifest'
    || details.version !== status.latest
    || !['hotfix', 'security', 'feature', 'maintenance'].includes(details.releaseClass)
    || !/^\d{4}-\d{2}-\d{2}$/.test(details.releasedAt)
    || !Array.isArray(details.highlights)
    || details.highlights.length < 1
    || details.highlights.length > 5
    || details.highlights.some((highlight) => typeof highlight !== 'string'
      || highlight !== highlight.trim()
      || Array.from(highlight).length < 1
      || Array.from(highlight).length > 200
      || /[\u0000-\u001f\u007f]/.test(highlight))
    || new Set(details.highlights).size !== details.highlights.length) {
    return null;
  }
  return details;
}

function releaseClassLabel(releaseClass: ReleaseClass): string {
  if (releaseClass === 'hotfix') return 'Hotfix';
  if (releaseClass === 'security') return 'Security';
  if (releaseClass === 'feature') return 'Feature drop';
  return 'Maintenance';
}

function releaseClassTone(releaseClass: ReleaseClass): string {
  if (releaseClass === 'hotfix') return 'border-amber-400/30 bg-amber-500/15 text-amber-100';
  if (releaseClass === 'security') return 'border-red-400/30 bg-red-500/15 text-red-100';
  if (releaseClass === 'feature') return 'border-violet-400/30 bg-violet-500/15 text-violet-100';
  return 'border-slate-400/25 bg-slate-500/15 text-slate-200';
}

function formatReleaseDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/* ─── animation variants ───────────────────────────────── */

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const cardVariant = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 20 } },
};

/* ─── sparkline ────────────────────────────────────────── */

function Sparkline({ data, color, height = 40 }: { data: number[]; color: string; height?: number }) {
  if (data.length < 2) return null;
  const values = data.map((v) => Number.isFinite(v) ? v : 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 160;
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - (((value - min) / range) * (height - 6) + 3);
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none" aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
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

function getPrimaryDisk(disks: SystemStats['disk'] | undefined) {
  if (!Array.isArray(disks) || disks.length === 0) return null;
  return disks.find(d => d.mount === '/') || disks[0];
}

function hasNetworkTelemetry(metric: Metrics | null | undefined): boolean {
  if (!metric) return false;
  return metric.metadata?.networkMetricsAvailable ?? !metric.metadata?.lightweightCollector;
}

export default function DashboardPage() {
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const routerNavigator = navigationContext?.navigator;
  const user = useAuthStore((state) => state.user);
  const canViewOperatorDiagnostics = isElevated(user);
  const canRunSelfUpdate = isOwner(user);
  const canReconnectGateway = isElevated(user);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [history, setHistory] = useState<Metrics[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [activeAlerts, setActiveAlerts] = useState<ActivityLog[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [updateDetailsExpanded, setUpdateDetailsExpanded] = useState(false);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updatePlan, setUpdatePlan] = useState<PortalUpdatePlan>('create-backup');
  const [openClawStatus, setOpenClawStatus] = useState<'checking' | 'connected' | 'misconfigured' | 'offline'>('checking');
  const [openClawIssues, setOpenClawIssues] = useState<string[]>([]);
  const [openClawVersion, setOpenClawVersion] = useState<OpenClawVersionStatus | null>(null);
  const [maintenanceStatus, setMaintenanceStatus] = useState<RenderableMaintenanceStatus | null>(null);
  const [maintenanceProbe, setMaintenanceProbe] = useState<MaintenanceStatus | null>(null);
  const [maintenancePageVisible, setMaintenancePageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  // Background system checks run independently of the metric gauges. Each one
  // reports its own progress so slow scans (apt, OpenClaw probes) read as
  // "checks running" instead of a stalled dashboard.
  type SystemCheckState = 'pending' | 'done' | 'error';
  type SystemCheckKey = 'openclaw' | 'updates' | 'maintenance';
  const [systemChecks, setSystemChecks] = useState<Record<SystemCheckKey, SystemCheckState>>({
    openclaw: 'pending',
    updates: 'pending',
    maintenance: 'pending',
  });
  // Server-side cooldowns decide whether a view re-executes a check
  //; the page only reports how old each rendered result is and
  // lets each check be refreshed on its own without touching the other two.
  const [checkedAt, setCheckedAt] = useState<Record<SystemCheckKey, number | null>>({
    openclaw: null,
    updates: null,
    maintenance: null,
  });
  const [checkRefreshing, setCheckRefreshing] = useState<Record<SystemCheckKey, boolean>>({
    openclaw: false,
    updates: false,
    maintenance: false,
  });
  const [checkAgeTick, setCheckAgeTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setCheckAgeTick(t => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const markCheckedAt = useCallback((key: SystemCheckKey, at: number | null) => {
    setCheckedAt(prev => (prev[key] === at ? prev : { ...prev, [key]: at }));
  }, []);
  const [maintenanceDismissedSignature, setMaintenanceDismissedSignature] = useState(() => {
    try {
      return localStorage.getItem(MAINTENANCE_DISMISS_KEY) || '';
    } catch {
      return '';
    }
  });
  const [reconnecting, setReconnecting] = useState(false);
  const [restartingGateway, setRestartingGateway] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  // readiness + recentActivity sections removed per design cleanup
  const socketRef = useRef<Socket | null>(null);
  const alertSocketRef = useRef<Socket | null>(null);
  const updateSubmissionRef = useRef(false);
  const updateNavigationReleaseRef = useRef<(() => void) | null>(null);
  const updateNavigationGuardRef = useRef<{
    url: string;
    state: unknown;
    historyIndex: number | null;
  } | null>(null);
  const gatewayActionRef = useRef<'restart' | 'reconnect' | null>(null);
  const maintenanceRequestSequenceRef = useRef(0);
  const maintenancePollBudgetRef = useRef<MaintenancePollBudget | null>(null);

  const releaseUpdateNavigationLock = useCallback(() => {
    updateNavigationReleaseRef.current?.();
    updateNavigationReleaseRef.current = null;
    updateNavigationGuardRef.current = null;
  }, []);

  const acquireUpdateNavigationLock = useCallback(() => {
    if (updateNavigationReleaseRef.current) return;
    const originalPush = routerNavigator?.push;
    const originalReplace = routerNavigator?.replace;
    const originalGo = routerNavigator?.go;
    const blockedPush = () => undefined;
    const blockedReplace = () => undefined;
    const blockedGo = () => undefined;
    if (routerNavigator) {
      routerNavigator.push = blockedPush;
      routerNavigator.replace = blockedReplace;
      routerNavigator.go = blockedGo;
    }
    const browserHistoryIndex = window.history.state?.idx;
    updateNavigationGuardRef.current = {
      url: window.location.href,
      state: window.history.state,
      historyIndex: typeof browserHistoryIndex === 'number' ? browserHistoryIndex : null,
    };
    updateNavigationReleaseRef.current = () => {
      if (!routerNavigator) return;
      if (routerNavigator.push === blockedPush && originalPush) routerNavigator.push = originalPush;
      if (routerNavigator.replace === blockedReplace && originalReplace) routerNavigator.replace = originalReplace;
      if (routerNavigator.go === blockedGo && originalGo) routerNavigator.go = originalGo;
    };
  }, [routerNavigator]);

  useEffect(() => {
    const ownsUpdateInteraction = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      const modalLayer = target.closest('[data-viewport-modal-layer="true"]');
      if (!modalLayer) return false;
      const modalRoot = modalLayer.closest<HTMLElement>('[data-viewport-overlay-root="true"]');
      return Boolean(
        modalRoot
        && !modalRoot.hasAttribute('inert')
        && modalRoot.getAttribute('aria-hidden') !== 'true',
      );
    };
    const preventUpdateUnload = (event: BeforeUnloadEvent) => {
      if (!updateSubmissionRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const preventOutsideUpdateInteraction = (event: Event) => {
      if (!updateSubmissionRef.current || ownsUpdateInteraction(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const preventHistoryTraversal = (event: PopStateEvent) => {
      if (!updateSubmissionRef.current) return;
      const guard = updateNavigationGuardRef.current;
      if (!guard) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const nextIndex = window.history.state?.idx;
      if (guard.historyIndex !== null && typeof nextIndex === 'number') {
        const distanceToOwner = guard.historyIndex - nextIndex;
        if (distanceToOwner !== 0) window.history.go(distanceToOwner);
        return;
      }
      window.history.pushState(guard.state, '', guard.url);
    };

    window.addEventListener('beforeunload', preventUpdateUnload);
    window.addEventListener('popstate', preventHistoryTraversal, true);
    document.addEventListener('pointerdown', preventOutsideUpdateInteraction, true);
    document.addEventListener('click', preventOutsideUpdateInteraction, true);
    return () => {
      window.removeEventListener('beforeunload', preventUpdateUnload);
      window.removeEventListener('popstate', preventHistoryTraversal, true);
      document.removeEventListener('pointerdown', preventOutsideUpdateInteraction, true);
      document.removeEventListener('click', preventOutsideUpdateInteraction, true);
    };
  }, []);

  useEffect(() => releaseUpdateNavigationLock, [releaseUpdateNavigationLock]);

  // Metrics socket is critical to the page, so keep it on the immediate path
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
      setLastUpdate(new Date());
      setHistory(prev => mergeDashboardMetricHistory(prev, [m]));
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, []);

  // Alerts are secondary dashboard data, so keep their live connection off the initial mount path
  useEffect(() => {
    if (!canViewOperatorDiagnostics) return;
    const wsUrl = import.meta.env.VITE_WS_URL || import.meta.env.VITE_API_URL?.replace('/api', '') || window.location.origin;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
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
      alertSocketRef.current = alertSocket;
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      alertSocketRef.current?.disconnect();
      alertSocketRef.current = null;
    };
  }, [canViewOperatorDiagnostics]);



  // Initial critical data fetch
  const fetchData = useCallback(async () => {
    try {
      const [m, s, h] = await Promise.all([
        metricsAPI.latest().catch(() => null),
        canViewOperatorDiagnostics ? systemStatsAPI.latest().catch(() => null) : Promise.resolve(null),
        metricsAPI.history(6).catch(() => []),
      ]);
      if (m) setMetrics(m);
      if (s) {
        setSystemStats(s);
        setLastUpdate(new Date());
      }
      if (Array.isArray(h)) setHistory(mergeDashboardMetricHistory([], h));
    } catch (err) { console.error('[Dashboard] Failed to fetch core data:', err); }
  }, [canViewOperatorDiagnostics]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const applyGatewayHealth = useCallback((gateway: any) => {
    const versionStatus = gateway?.openclawVersion || null;
    setOpenClawVersion(versionStatus);
    if (versionStatus?.restartRecommended) {
      setOpenClawStatus('misconfigured');
      setOpenClawIssues(gateway?.issues || [versionStatus.reason || 'OpenClaw gateway is running a stale version and should be restarted.']);
    } else if (gateway?.ok) {
      setOpenClawStatus('connected');
      setOpenClawIssues([]);
    } else if (gateway?.connected && !gateway?.wsConnected) {
      setOpenClawStatus('offline');
      setOpenClawIssues(gateway?.issues || ['Gateway is reachable but agent chat connection failed. Try restarting the portal service.']);
    } else if (gateway?.connected && !gateway?.modelsConfigured) {
      setOpenClawStatus('misconfigured');
      setOpenClawIssues(gateway?.issues || ['No AI models configured. Run "openclaw onboard" on the server.']);
    } else {
      setOpenClawStatus('offline');
      setOpenClawIssues(gateway?.issues || []);
    }
  }, []);

  const needsForcedGatewayVersionProbe = useCallback((gateway: any) => {
    const status = gateway?.openclawVersion;
    const reason = String(status?.reason || '').toLowerCase();
    const gatewayReady = gateway?.connected === true
      && gateway?.wsConnected === true
      && gateway?.modelsConfigured === true;
    if (!gatewayReady || status?.mismatch === true || status?.restartRecommended === true) return false;

    return Boolean(
      status?.lightweight
      || reason.includes('probe scheduled')
      || reason.includes('probe already running')
      // A healthy authenticated Portal connection paired with a failed CLI
      // version probe is internally inconsistent, and commonly happens while
      // OpenClaw is still settling after an update. Retry it briefly instead
      // of leaving the mounted Dashboard on a cached "runtime unknown" card.
      || status?.probeOk === false,
    );
  }, []);

  const markSystemCheck = useCallback((key: 'openclaw' | 'updates' | 'maintenance', state: SystemCheckState) => {
    setSystemChecks(prev => (prev[key] === state ? prev : { ...prev, [key]: state }));
  }, []);

  const loadDashboardMaintenance = useCallback(async (forceRefresh = false) => {
    const requestSequence = ++maintenanceRequestSequenceRef.current;
    try {
      const maintenance = await maintenanceAPI.getStatus(forceRefresh, { silent: true });
      if (requestSequence !== maintenanceRequestSequenceRef.current) return;
      if (!isMaintenanceStatus(maintenance)) {
        maintenancePollBudgetRef.current = null;
        markSystemCheck('maintenance', 'error');
        return;
      }

      if (maintenance.ready !== false) {
        markCheckedAt('maintenance', Date.now() - (typeof maintenance.cacheAgeMs === 'number' ? maintenance.cacheAgeMs : 0));
      }
      setMaintenanceProbe(maintenance);
      const refreshPending = maintenance.ready === false
        || maintenance.refreshing === true
        || (maintenance.retryAfterMs || 0) > 0;
      const renderable = maintenance.ready !== false && hasRenderableMaintenanceHost(maintenance);
      if (renderable) setMaintenanceStatus(maintenance);
      const coldRefreshFailed = maintenance.ready === false
        && typeof maintenance.refreshError === 'string'
        && maintenance.refreshError.trim().length > 0;
      if (coldRefreshFailed) {
        maintenancePollBudgetRef.current = null;
        markSystemCheck('maintenance', 'error');
        return;
      }
      if (refreshPending) {
        maintenancePollBudgetRef.current ||= { startedAt: Date.now(), attempts: 0 };
      } else {
        maintenancePollBudgetRef.current = null;
      }
      markSystemCheck('maintenance', refreshPending ? 'pending' : renderable ? 'done' : 'error');
    } catch {
      if (requestSequence === maintenanceRequestSequenceRef.current) {
        maintenancePollBudgetRef.current = null;
        markSystemCheck('maintenance', 'error');
      }
    }
  }, [markCheckedAt, markSystemCheck]);

  // Per-check refresh: each button bypasses only its own check's
  // server cooldown. The main dashboard refresh never reaches these paths.
  const refreshSystemCheck = useCallback(async (key: SystemCheckKey) => {
    setCheckRefreshing(prev => (prev[key] ? prev : { ...prev, [key]: true }));
    markSystemCheck(key, 'pending');
    try {
      if (key === 'openclaw') {
        const { data } = await client.get('/gateway/health?forceVersion=1', { _silent: true } as any);
        applyGatewayHealth(data);
        markCheckedAt('openclaw', typeof data?.checkedAt === 'number' ? data.checkedAt : Date.now());
        markSystemCheck('openclaw', 'done');
      } else if (key === 'updates') {
        const { data } = await client.post('/admin/check-updates', { force: true }, { _silent: true } as any);
        if (data) {
          setUpdateStatus(data);
          markCheckedAt('updates', typeof data?.checkedAt === 'number' ? data.checkedAt : Date.now());
        }
        markSystemCheck('updates', data ? 'done' : 'error');
      } else {
        await loadDashboardMaintenance(true);
      }
    } catch {
      markSystemCheck(key, 'error');
    } finally {
      setCheckRefreshing(prev => (prev[key] ? { ...prev, [key]: false } : prev));
    }
  }, [applyGatewayHealth, loadDashboardMaintenance, markCheckedAt, markSystemCheck]);

  const checkAges = useMemo(() => {
    const describe = (at: number | null): string | null => {
      if (at === null) return null;
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
      if (minutes < 1) return 'Checked just now';
      if (minutes === 1) return 'Checked 1 min ago';
      if (minutes < 120) return `Checked ${minutes} min ago`;
      return `Checked ${Math.round(minutes / 60)} h ago`;
    };
    return {
      openclaw: describe(checkedAt.openclaw),
      updates: describe(checkedAt.updates),
      maintenance: describe(checkedAt.maintenance),
    };
    // checkAgeTick re-derives the labels every 30 seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedAt, checkAgeTick]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const pageVisible = document.visibilityState !== 'hidden';
      if (pageVisible) maintenancePollBudgetRef.current = null;
      setMaintenancePageVisible(pageVisible);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!canViewOperatorDiagnostics) {
      maintenancePollBudgetRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => {
      void loadDashboardMaintenance();
    }, 1200);
    return () => {
      window.clearTimeout(timer);
      maintenanceRequestSequenceRef.current += 1;
      maintenancePollBudgetRef.current = null;
    };
  }, [canViewOperatorDiagnostics, loadDashboardMaintenance]);

  useEffect(() => {
    if (!canViewOperatorDiagnostics || !maintenanceProbe || !shouldPollMaintenance({
      pageVisible: maintenancePageVisible,
      ready: maintenanceProbe.ready,
      refreshing: maintenanceProbe.refreshing,
      retryAfterMs: maintenanceProbe.retryAfterMs,
      hasActiveJob: false,
    })) return;
    if (maintenanceProbe.ready === false
      && typeof maintenanceProbe.refreshError === 'string'
      && maintenanceProbe.refreshError.trim().length > 0) {
      markSystemCheck('maintenance', 'error');
      return;
    }

    const budget = maintenancePollBudgetRef.current
      ||= { startedAt: Date.now(), attempts: 0 };
    const elapsedMs = Date.now() - budget.startedAt;
    const remainingMs = DASHBOARD_MAINTENANCE_POLL_DEADLINE_MS - elapsedMs;
    if (budget.attempts >= DASHBOARD_MAINTENANCE_MAX_POLL_ATTEMPTS || remainingMs <= 0) {
      markSystemCheck('maintenance', 'error');
      return;
    }

    const requestedDelayMs = maintenancePollDelayMs({
      retryAfterMs: maintenanceProbe.retryAfterMs,
      hasActiveJob: false,
    });
    const backoffDelayMs = Math.min(
      DASHBOARD_MAINTENANCE_MAX_POLL_DELAY_MS,
      requestedDelayMs * (2 ** budget.attempts),
    );
    const pollDelayMs = Math.max(requestedDelayMs, backoffDelayMs);
    const deadlineExpiresFirst = pollDelayMs >= remainingMs;
    const timer = window.setTimeout(() => {
      if (deadlineExpiresFirst) {
        markSystemCheck('maintenance', 'error');
        return;
      }
      const currentBudget = maintenancePollBudgetRef.current;
      if (!currentBudget
        || currentBudget !== budget
        || currentBudget.attempts >= DASHBOARD_MAINTENANCE_MAX_POLL_ATTEMPTS
        || Date.now() - currentBudget.startedAt >= DASHBOARD_MAINTENANCE_POLL_DEADLINE_MS) {
        markSystemCheck('maintenance', 'error');
        return;
      }
      currentBudget.attempts += 1;
      void loadDashboardMaintenance();
    }, Math.min(pollDelayMs, remainingMs));
    return () => window.clearTimeout(timer);
  }, [canViewOperatorDiagnostics, loadDashboardMaintenance, maintenancePageVisible, maintenanceProbe, markSystemCheck]);

  // Defer non-critical startup checks so the main dashboard cards can settle
  // first, then run every check INDEPENDENTLY: one slow scan (apt, OpenClaw
  // version probes) must never hold back the others or the metric gauges.
  useEffect(() => {
    if (!canViewOperatorDiagnostics) return;
    let cancelled = false;
    let forceProbeTimer: number | undefined;
    let forcedProbeAttempts = 0;
    const markCheck = (key: 'openclaw' | 'updates' | 'maintenance', state: SystemCheckState) => {
      if (!cancelled) setSystemChecks(prev => (prev[key] === state ? prev : { ...prev, [key]: state }));
    };
    const scheduleForcedGatewayVersionProbe = (delayMs: number) => {
      if (cancelled || forcedProbeAttempts >= DASHBOARD_GATEWAY_FORCE_PROBE_MAX_ATTEMPTS) return;
      forceProbeTimer = window.setTimeout(async () => {
        if (cancelled) return;
        forcedProbeAttempts += 1;
        try {
          const { data } = await client.get('/gateway/health?forceVersion=1', { _silent: true } as any);
          if (cancelled) return;
          applyGatewayHealth(data);
          if (
            needsForcedGatewayVersionProbe(data)
            && forcedProbeAttempts < DASHBOARD_GATEWAY_FORCE_PROBE_MAX_ATTEMPTS
          ) {
            const nextDelayMs = Math.min(
              DASHBOARD_GATEWAY_FORCE_PROBE_MAX_DELAY_MS,
              DASHBOARD_GATEWAY_FORCE_PROBE_INITIAL_DELAY_MS * (2 ** forcedProbeAttempts),
            );
            scheduleForcedGatewayVersionProbe(nextDelayMs);
          }
        } catch (err) {
          if (cancelled) return;
          if (forcedProbeAttempts < DASHBOARD_GATEWAY_FORCE_PROBE_MAX_ATTEMPTS) {
            const nextDelayMs = Math.min(
              DASHBOARD_GATEWAY_FORCE_PROBE_MAX_DELAY_MS,
              DASHBOARD_GATEWAY_FORCE_PROBE_INITIAL_DELAY_MS * (2 ** forcedProbeAttempts),
            );
            scheduleForcedGatewayVersionProbe(nextDelayMs);
          } else {
            console.error('[Dashboard] Forced OpenClaw version probe failed:', err);
          }
        }
      }, delayMs);
    };

    const timer = window.setTimeout(() => {
      alertsAPI.list({ limit: 10, severity: 'CRITICAL' })
        .then((al) => {
          if (cancelled || !al.alerts?.length) return;
          setActiveAlerts(prev => {
            const ids = new Set(prev.map(p => p.id));
            const merged = [...prev];
            for (const alert of al.alerts) {
              if (!ids.has(alert.id)) merged.push(alert);
            }
            return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 20);
          });
        })
        .catch(() => {});

      (canRunSelfUpdate
        ? client.post('/admin/check-updates', {}, { _silent: true } as any).then(r => r.data).catch(() =>
            client.get('/admin/update-status', { _silent: true } as any).then(r => r.data).catch(() => null)
          )
        : client.get('/admin/update-status', { _silent: true } as any).then(r => r.data).catch(() => null))
        .then((upd) => {
          if (cancelled) return;
          if (upd) {
            markCheckedAt('updates', typeof upd?.checkedAt === 'number' ? upd.checkedAt : null);
            setUpdateStatus(upd);
            const latest = typeof upd?.latest === 'string' ? upd.latest : null;
            if (latest && localStorage.getItem(`dashboard-update-dismissed:${latest}`) === 'true') {
              setUpdateBannerDismissed(true);
            } else {
              setUpdateBannerDismissed(false);
            }
          }
          markCheck('updates', upd ? 'done' : 'error');
        })
        .catch(() => markCheck('updates', 'error'));

      client.get('/gateway/health?cooldown=1', { _silent: true } as any)
        .then(({ data: gateway }) => {
          if (cancelled) return;
          applyGatewayHealth(gateway);
          markCheckedAt('openclaw', typeof gateway?.checkedAt === 'number' ? gateway.checkedAt : Date.now());
          markCheck('openclaw', 'done');
          if (needsForcedGatewayVersionProbe(gateway)) {
            scheduleForcedGatewayVersionProbe(DASHBOARD_GATEWAY_FORCE_PROBE_INITIAL_DELAY_MS);
          }
        })
        .catch(() => markCheck('openclaw', 'error'));

    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (forceProbeTimer !== undefined) window.clearTimeout(forceProbeTimer);
    };
  }, [applyGatewayHealth, canRunSelfUpdate, canViewOperatorDiagnostics, markCheckedAt, needsForcedGatewayVersionProbe]);

  // Fallback polling if WebSocket disconnects
  useEffect(() => {
    if (connected) return;
    const iv = setInterval(async () => {
      try {
        const [m, s] = await Promise.all([
          metricsAPI.latest().catch(() => null),
          canViewOperatorDiagnostics ? systemStatsAPI.latest().catch(() => null) : Promise.resolve(null),
        ]);
        if (m) setMetrics(m);
        if (s) {
          setSystemStats(s);
          setLastUpdate(new Date());
        }
      } catch (err) { console.error('[Dashboard] Metrics poll error:', err); }
    }, 10000);
    return () => clearInterval(iv);
  }, [canViewOperatorDiagnostics, connected]);

  // Defer chart bundle work until the cards have had a chance to render first
  useEffect(() => {
    let cancelled = false;
    const revealCharts = () => {
      if (!cancelled) setShowCharts(true);
    };

    const idleCallback = window.requestIdleCallback?.(() => revealCharts(), { timeout: 1500 });
    const timer = window.setTimeout(revealCharts, 1200);

    return () => {
      cancelled = true;
      if (idleCallback !== undefined) window.cancelIdleCallback?.(idleCallback);
      window.clearTimeout(timer);
    };
  }, []);

  // Derived sparkline data
  const cpuHistory = useMemo(() => history.map(m => m.cpuUsage), [history]);
  const memHistory = useMemo(() => history.map(m => m.memoryUsage), [history]);
  const diskHistory = useMemo(() => history.map(m => m.diskUsage), [history]);
  const netInHistory = useMemo(() => history.filter(hasNetworkTelemetry).map(m => Number(m.networkIn) / 1024 / 1024), [history]);
  const netOutHistory = useMemo(() => history.filter(hasNetworkTelemetry).map(m => Number(m.networkOut) / 1024 / 1024), [history]);
  const processHistory = useMemo(() => history.map(m => m.processCount), [history]);

  const chartData = useMemo(() => history.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu: m.cpuUsage,
    memory: m.memoryUsage,
    disk: m.diskUsage,
    // Samples without a genuine rate measurement gap the chart instead of
    // drawing a false zero line.
    netIn: hasNetworkTelemetry(m) ? Number(m.networkIn) / 1024 / 1024 : null,
    netOut: hasNetworkTelemetry(m) ? Number(m.networkOut) / 1024 / 1024 : null,
  })), [history]);

  const primaryDisk = getPrimaryDisk(systemStats?.disk);
  const metricMemoryTotal = Number(metrics?.memoryTotal || 0);
  const metricMemoryUsed = Number(metrics?.metadata?.memoryUsedBytes ?? (metricMemoryTotal * ((metrics?.memoryUsage || 0) / 100)));
  const metricDiskTotal = Number(metrics?.diskTotal || 0);
  const uptimeSeconds = systemStats?.uptime ?? Number(metrics?.metadata?.uptimeSeconds || 0);
  const cpuCores = systemStats?.cpu?.perCore?.length || Number(metrics?.metadata?.cpuCores || 0);
  const memoryUsed = systemStats?.memory?.used ?? metricMemoryUsed;
  const memoryTotal = systemStats?.memory?.total ?? metricMemoryTotal;
  const diskTotal = primaryDisk?.total ?? metricDiskTotal;
  const memUsedGB = memoryUsed > 0 ? (memoryUsed / 1073741824).toFixed(1) : '—';
  const memTotalGB = memoryTotal > 0 ? (memoryTotal / 1073741824).toFixed(1) : '—';
  const diskTotalGB = diskTotal > 0 ? (diskTotal / 1073741824).toFixed(0) : '—';
  const currentCpuUsage = systemStats?.cpu?.overall ?? metrics?.cpuUsage;
  const currentMemoryUsage = systemStats?.memory?.usagePercent ?? metrics?.memoryUsage;
  const currentDiskUsage = primaryDisk?.usagePercent ?? metrics?.diskUsage;
  const currentNetworkIn = metrics?.networkIn;
  const currentNetworkOut = metrics?.networkOut;
  const networkTelemetryAvailable = hasNetworkTelemetry(metrics);
  const currentProcessCount = systemStats?.processes ?? metrics?.processCount;
  const loadAvg = systemStats ? [systemStats.loadAverage['1min'], systemStats.loadAverage['5min'], systemStats.loadAverage['15min']] : (metrics?.loadAverage || []);

  const showUpdateBanner = Boolean(updateStatus?.updateAvailable && updateStatus.latest && !updateBannerDismissed);
  const updateDetails = useMemo(() => verifiedUpdateDetails(updateStatus), [updateStatus]);
  const updateBackup = updateStatus?.preparation?.backup;
  const updateBackupDescription = useMemo(() => describeUpdateBackup(updateBackup), [updateBackup]);
  const updateBackupRunning = updateBackup?.state === 'running';
  const visibleMaintenanceIssues = maintenanceStatus?.issues?.slice(0, 5) || [];
  const maintenanceSignature = useMemo(() => (
    maintenanceStatus ? maintenanceDismissSignature(maintenanceStatus) : ''
  ), [maintenanceStatus]);
  const showMaintenanceBanner = Boolean(maintenanceStatus && maintenanceSignature !== maintenanceDismissedSignature);

  const dismissUpdateBanner = () => {
    if (updateStatus?.latest) {
      localStorage.setItem(`dashboard-update-dismissed:${updateStatus.latest}`, 'true');
    }
    setUpdateBannerDismissed(true);
    setUpdateDetailsExpanded(false);
  };

  const dismissMaintenanceBanner = () => {
    if (!maintenanceSignature) return;
    try {
      localStorage.setItem(MAINTENANCE_DISMISS_KEY, maintenanceSignature);
    } catch {}
    setMaintenanceDismissedSignature(maintenanceSignature);
  };

  const restartOpenClawGateway = useCallback(async () => {
    if (!canReconnectGateway || gatewayActionRef.current) return;
    gatewayActionRef.current = 'restart';
    setRestartingGateway(true);
    try {
      const { data } = await client.post('/gateway/restart');
      const nextVersion = data?.after || data?.openclawVersion || null;
      setOpenClawVersion(nextVersion);
      if (data?.ok || (nextVersion && !nextVersion.restartRecommended)) {
        setOpenClawStatus('connected');
        setOpenClawIssues([]);
      } else {
        setOpenClawStatus('misconfigured');
        setOpenClawIssues([data?.message || nextVersion?.reason || 'OpenClaw gateway restart did not clear the version warning.']);
      }
    } catch (err: any) {
      setOpenClawStatus('misconfigured');
      setOpenClawIssues([err?.response?.data?.message || err?.response?.data?.error || 'OpenClaw gateway restart request failed.']);
    } finally {
      gatewayActionRef.current = null;
      setRestartingGateway(false);
      fetchData();
    }
  }, [canReconnectGateway, fetchData]);

  const reconnectOpenClawGateway = useCallback(async () => {
    if (!canReconnectGateway || gatewayActionRef.current) return;
    gatewayActionRef.current = 'reconnect';
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
      gatewayActionRef.current = null;
      setReconnecting(false);
      fetchData();
    }
  }, [canReconnectGateway, fetchData]);

  const runSelfUpdate = useCallback(async (confirmation: string) => {
    if (!canRunSelfUpdate || updateSubmissionRef.current) return;
    const expectedVersion = String(updateStatus?.latest || '').trim();
    if (!expectedVersion) {
      setUpdateMessage('The reviewed update version is unavailable. Refresh update status before retrying.');
      return;
    }
    updateSubmissionRef.current = true;
    acquireUpdateNavigationLock();
    try {
      setUpdateInProgress(true);
      let backupDecision: 'use-current' | 'proceed-without-fresh' = updatePlan === 'skip-backup'
        ? 'proceed-without-fresh'
        : 'use-current';

      if (updatePlan === 'create-backup') {
        await createFreshBackupForUpdate({
          startDailyBackup: async () => {
            const { data } = await client.post('/backups/create', { type: 'daily' });
            return data;
          },
          getBackupStatus: async () => {
            const { data } = await client.get('/backups/status', { _silent: true } as any);
            return data;
          },
          getBackupReadiness: async () => {
            const { data } = await client.get<UpdateStatus>('/admin/update-status', { _silent: true } as any);
            setUpdateStatus(data);
            return data.preparation?.backup || null;
          },
        }, {
          onProgress: setUpdateMessage,
        });
        backupDecision = 'use-current';
      }

      setUpdateMessage(backupDecision === 'use-current'
        ? 'Verifying the recent backup and starting the reviewed signed release…'
        : 'Backup warning acknowledged. Starting the signed updater…');
      const { data } = await client.post('/admin/self-update', {
        confirmation,
        backupDecision,
        expectedVersion,
      });
      const logFile = data?.logFile;
      if (logFile) {
        try {
          await client.get(`/admin/self-update/log?file=${encodeURIComponent(logFile)}`, { _silent: true } as any);
        } catch {}
      }
      const installedExpectedVersion = await waitForExpectedPortalVersion(expectedVersion);
      if (installedExpectedVersion) {
        setUpdateMessage('Update complete. Refreshing…');
        updateSubmissionRef.current = false;
        setUpdateInProgress(false);
        releaseUpdateNavigationLock();
        window.location.reload();
        return;
      }

      setUpdateMessage('The updater did not report the new version within 10 minutes. Check the update log before retrying.');
      updateSubmissionRef.current = false;
      setUpdateInProgress(false);
      releaseUpdateNavigationLock();
    } catch (err: any) {
      const serverPreparation = err?.response?.data?.preparation as PortalUpdatePreparation | undefined;
      if (serverPreparation) {
        setUpdateStatus((current) => current ? { ...current, preparation: serverPreparation } : current);
      }
      const responseLost = !err?.response;
      const updaterAlreadyRunning = err?.response?.data?.code === 'PORTAL_UPDATE_BUSY';
      if (responseLost || updaterAlreadyRunning) {
        setUpdateMessage(responseLost
          ? 'The updater response was interrupted. Portal is checking the installed version before allowing another attempt…'
          : 'Another signed update is already running. Portal is waiting for its installed-version proof…');
        const installedExpectedVersion = await waitForExpectedPortalVersion(expectedVersion);
        if (installedExpectedVersion) {
          setUpdateMessage('Update complete. Refreshing…');
          updateSubmissionRef.current = false;
          setUpdateInProgress(false);
          releaseUpdateNavigationLock();
          window.location.reload();
          return;
        }
        setUpdateMessage('Portal could not confirm the reviewed version within 10 minutes. Check the updater log and refresh update status before retrying.');
        updateSubmissionRef.current = false;
        setUpdateInProgress(false);
        releaseUpdateNavigationLock();
        return;
      }
      setUpdateMessage(err?.response?.data?.error || err?.message || 'The update was not started. Check the update log before retrying.');
      updateSubmissionRef.current = false;
      setUpdateInProgress(false);
      releaseUpdateNavigationLock();
    }
  }, [acquireUpdateNavigationLock, canRunSelfUpdate, releaseUpdateNavigationLock, updatePlan, updateStatus?.latest]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-3 sm:p-5 md:p-7 lg:p-10 space-y-5 sm:space-y-7 max-w-[1800px] mx-auto overflow-y-auto h-full overflow-x-hidden"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{canViewOperatorDiagnostics ? 'Server Dashboard' : 'Portal Dashboard'}</h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-1">Recent resource telemetry and portal activity</p>
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
            aria-label="Refresh dashboard metrics"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {canViewOperatorDiagnostics && showUpdateBanner && updateStatus?.latest && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative overflow-hidden rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-500/15 via-sky-500/10 to-blue-500/15 p-5 shadow-[0_0_30px_rgba(34,211,238,0.12)]"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(45,212,191,0.18),transparent_35%)] pointer-events-none" />
          <div className="relative">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-cyan-200">Update available: v{updateStatus.latest} (you have v{updateStatus.current})</p>
                  {updateDetails && (
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${releaseClassTone(updateDetails.releaseClass)}`}>
                      {releaseClassLabel(updateDetails.releaseClass)}
                    </span>
                  )}
                </div>
              <p className="mt-1 text-sm text-slate-300">
                {canRunSelfUpdate
                  ? 'Install the latest portal bundle to pick up fixes and improvements.'
                  : 'A newer portal bundle is available. Only the owner can install updates from this dashboard.'}
              </p>
              {canRunSelfUpdate && (
                <div className={`mt-3 flex max-w-2xl items-start gap-2.5 rounded-xl border bg-theme-surface px-3 py-2.5 ${
                  updateBackupDescription.tone === 'good'
                    ? 'border-emerald-400/25'
                    : updateBackupDescription.tone === 'info'
                      ? 'border-cyan-400/25'
                      : 'border-amber-400/30'
                }`}>
                  {updateBackupDescription.tone === 'good' ? (
                    <CheckCircle2 size={16} className="mt-0.5 flex-none text-emerald-400" aria-hidden="true" />
                  ) : updateBackupDescription.tone === 'info' ? (
                    <Loader2 size={16} className="mt-0.5 flex-none animate-spin text-cyan-400" aria-hidden="true" />
                  ) : (
                    <AlertTriangle size={16} className="mt-0.5 flex-none text-amber-400" aria-hidden="true" />
                  )}
                  <div>
                    <p className="text-xs font-semibold text-theme-text">{updateBackupDescription.label}</p>
                    <p className="mt-0.5 text-xs leading-5 text-theme-text-muted">{updateBackupDescription.detail}</p>
                  </div>
                </div>
              )}
              {canRunSelfUpdate && updateMessage && !updateDialogOpen && (
                <p className="mt-2 text-sm text-theme-text">{updateMessage}</p>
              )}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  id="dashboard-update-details-toggle"
                  type="button"
                  onClick={() => setUpdateDetailsExpanded((expanded) => !expanded)}
                  aria-expanded={updateDetailsExpanded}
                  aria-controls={updateDetailsExpanded ? 'dashboard-update-details' : undefined}
                  className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-400/15"
                >
                  {updateDetailsExpanded ? 'Hide details' : 'View details'}
                  <ChevronDown
                    size={16}
                    className={`transition-transform ${updateDetailsExpanded ? 'rotate-180' : ''}`}
                    aria-hidden="true"
                  />
                </button>
                {canRunSelfUpdate ? (
                  <button
                    onClick={() => {
                      setUpdatePlan(updateBackup?.state === 'fresh' ? 'use-current' : 'create-backup');
                      setUpdateDialogOpen(true);
                      setUpdateMessage(null);
                    }}
                    disabled={updateDialogOpen || updateInProgress || updateBackupRunning}
                    className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/80 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {updateBackupRunning && !updateDialogOpen ? <Loader2 size={16} className="animate-spin" /> : null}
                    {updateDialogOpen ? 'Update dialog open' : updateBackupRunning ? 'Backup running' : 'Review & update'}
                  </button>
                ) : (
                  <div className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300">
                    Owner access required
                  </div>
                )}
                <button
                  onClick={dismissUpdateBanner}
                  disabled={updateInProgress}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Dismiss
                </button>
              </div>
            </div>

            <AnimatePresence initial={false}>
              {updateDetailsExpanded && (
                <motion.div
                  id="dashboard-update-details"
                  role="region"
                  aria-labelledby="dashboard-update-details-toggle"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="overflow-hidden"
                >
                  <div className="mt-4 border-t border-cyan-200/10 pt-4">
                    {updateDetails ? (
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,220px)_1fr]">
                        <div className="text-sm text-slate-300">
                          <p className="font-medium text-white">{releaseClassLabel(updateDetails.releaseClass)} release</p>
                          <p className="mt-1 text-xs text-slate-400">Released {formatReleaseDate(updateDetails.releasedAt)}</p>
                          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-200">
                            <CheckCircle2 size={14} aria-hidden="true" />
                            Verified signed release metadata
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Highlights</p>
                          <ul className="mt-2 space-y-2 text-sm text-slate-200">
                            {updateDetails.highlights.map((highlight, index) => (
                              <li key={`${index}-${highlight}`} className="flex gap-2">
                                <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-cyan-300" aria-hidden="true" />
                                <span>{highlight}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-3 rounded-xl border border-white/10 bg-black/10 p-3 text-sm text-slate-300">
                        <AlertTriangle size={17} className="mt-0.5 flex-none text-amber-300" aria-hidden="true" />
                        <div>
                          <p className="font-medium text-slate-100">Verified update details are unavailable.</p>
                          <p className="mt-1 text-xs text-slate-400">
                            The signed updater will still verify the release bundle before making changes. No unverified release notes are shown here.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}

      {canViewOperatorDiagnostics && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-xl"
        >
          <div className="flex items-center gap-2">
            {Object.values(systemChecks).some((state) => state === 'pending')
              ? <Loader2 size={16} className="animate-spin text-violet-300" />
              : Object.values(systemChecks).some((state) => state === 'error')
                ? <AlertTriangle size={16} className="text-amber-300" />
                : <CheckCircle2 size={16} className="text-emerald-400" />}
            <h3 className="text-sm font-semibold text-white">
              {Object.values(systemChecks).some((state) => state === 'pending')
                ? 'System checks running'
                : Object.values(systemChecks).some((state) => state === 'error')
                  ? 'Some system checks could not complete'
                  : 'System checks'}
            </h3>
            <span className="text-xs text-slate-500">Each check keeps its last result until you refresh it — opening the dashboard does not rerun them.</span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {([
              { key: 'openclaw' as const, label: 'OpenClaw gateway' },
              { key: 'updates' as const, label: 'Portal updates' },
              { key: 'maintenance' as const, label: 'Server maintenance' },
            ]).map(({ key, label }) => (
              <div key={key} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-200">{label}</span>
                  <div className="flex items-center gap-1.5">
                    {systemChecks[key] === 'pending' ? (
                      <span className="text-[10px] uppercase tracking-wide text-violet-300">Scanning</span>
                    ) : systemChecks[key] === 'done' ? (
                      <CheckCircle2 size={14} className="text-emerald-400" />
                    ) : (
                      <AlertTriangle size={14} className="text-amber-400" />
                    )}
                    {(key !== 'updates' || canRunSelfUpdate) && (
                      <button
                        onClick={() => { void refreshSystemCheck(key); }}
                        disabled={checkRefreshing[key] || systemChecks[key] === 'pending'}
                        className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                        title={`Refresh ${label} check`}
                        aria-label={`Refresh ${label} check`}
                      >
                        {checkRefreshing[key] ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {systemChecks[key] === 'pending'
                    ? 'Checking…'
                    : checkAges[key] ?? (systemChecks[key] === 'error' ? 'Last attempt failed' : 'Not checked yet')}
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  {systemChecks[key] === 'pending' ? (
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-violet-500/40 via-violet-400 to-violet-500/40" />
                  ) : (
                    <div className={`h-full w-full rounded-full ${systemChecks[key] === 'done' ? 'bg-emerald-500/60' : 'bg-amber-500/60'}`} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {canViewOperatorDiagnostics && showMaintenanceBanner && maintenanceStatus && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-2xl border p-5 backdrop-blur-xl ${maintenanceTone(maintenanceStatus.status)}`}
        >
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {maintenanceStatus.status === 'healthy' ? <ShieldAlert size={18} className="text-emerald-300" /> : <AlertTriangle size={18} />}
                <p className="text-sm font-semibold">
                  {maintenanceStatus.status === 'healthy' ? 'Maintenance healthy' : 'Server maintenance needs attention'}
                </p>
                <span className={`h-2 w-2 rounded-full ${maintenanceDot(maintenanceStatus.status)}`} />
              </div>
              <p className="mt-1 text-sm text-slate-300">{maintenanceStatus.summary}</p>
              <p className="mt-1 text-xs text-slate-500">
                {maintenanceStatus.host.os} · kernel {maintenanceStatus.host.kernel} · checked {maintenanceStatus.checkedAt ? new Date(maintenanceStatus.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href="/admin?tab=maintenance"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
              >
                <Wrench size={15} />
                Admin Maintenance
              </a>
              <button
                onClick={dismissMaintenanceBanner}
                className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
              >
                Dismiss
              </button>
            </div>
          </div>

          {maintenanceStatus.compatibility && (
            <div className="mt-4 rounded-xl border border-amber-400/15 bg-amber-500/[0.04] p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-100">Compatibility guarded</p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{maintenanceStatus.compatibility.summary}</p>
                </div>
                <a
                  href="/admin?tab=maintenance"
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10"
                >
                  <Wrench size={13} />
                  Open Admin
                </a>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {maintenanceStatus.compatibility.components
                  .filter((component) => component.status === 'blocked' || component.status === 'review')
                  .slice(0, 3)
                  .map((component) => (
                    <span key={component.id} className="rounded-lg border border-white/10 bg-black/15 px-2.5 py-1 text-[11px] text-slate-200" title={component.note}>
                      {component.label}: {component.status === 'blocked' ? 'blocked pending confirmation' : 'review before upgrade'}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {visibleMaintenanceIssues.length > 0 && (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {visibleMaintenanceIssues.map((issue) => {
                const action = maintenanceStatus.actions.find((candidate) => candidate.id === issue.actionId);
                return (
                  <div key={issue.id} className="rounded-xl border border-white/10 bg-black/15 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            issue.severity === 'critical' ? 'bg-red-500/20 text-red-200'
                            : issue.severity === 'warning' ? 'bg-amber-500/20 text-amber-200'
                            : 'bg-cyan-500/20 text-cyan-200'
                          }`}>
                            {issue.severity}
                          </span>
                          <p className="text-sm font-medium text-white">{issue.title}</p>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-300">{issue.detail}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{issue.recommendation}</p>
                        {issue.downtimeExpected && <p className="mt-1 text-xs text-red-200">Downtime expected. Schedule a maintenance window.</p>}
                      </div>
                      {action ? (
                        <span className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300" title={action.description}>
                          Action in Admin
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>
      )}

      {canViewOperatorDiagnostics && (
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
        {openClawVersion?.restartRecommended && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
            <span className="flex-1 min-w-[16rem]">
              {openClawVersion.reason || 'OpenClaw gateway should be restarted to load the installed version.'}
              {openClawVersion.installedVersion ? ` Installed: v${openClawVersion.installedVersion}.` : ''}
              {openClawVersion.runningVersion ? ` Running: v${openClawVersion.runningVersion}.` : ''}
            </span>
            {canReconnectGateway ? (
              <button
                onClick={restartOpenClawGateway}
                disabled={restartingGateway || reconnecting}
                aria-busy={restartingGateway}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-cyan-500/20 hover:bg-cyan-500/30 px-3 py-1 text-xs font-medium text-cyan-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {restartingGateway ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {restartingGateway ? 'Restarting…' : 'Restart OpenClaw'}
              </button>
            ) : (
              <span className="shrink-0 rounded-lg border border-cyan-300/20 bg-black/10 px-2.5 py-1 text-xs text-cyan-100/90">
                Admin access required to restart OpenClaw.
              </span>
            )}
          </div>
        )}
        {(openClawStatus === 'offline' || openClawStatus === 'misconfigured') && openClawIssues.length > 0 && !openClawVersion?.restartRecommended && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            <span className="flex-1 min-w-[14rem]">{openClawIssues[0]}</span>
            {canReconnectGateway ? (
              <button
                onClick={reconnectOpenClawGateway}
                disabled={reconnecting || restartingGateway}
                aria-busy={reconnecting}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/20 hover:bg-amber-500/30 px-3 py-1 text-xs font-medium text-amber-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {reconnecting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {reconnecting ? 'Reconnecting…' : 'Reconnect'}
              </button>
            ) : (
              <span className="shrink-0 rounded-lg border border-amber-400/20 bg-black/10 px-2.5 py-1 text-xs text-amber-200/90">
                Admin access required to reconnect OpenClaw.
              </span>
            )}
          </div>
        )}
        {openClawStatus === 'offline' && openClawIssues.length === 0 && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            {canReconnectGateway
              ? 'OpenClaw gateway is not responding. Check Settings → System.'
              : 'OpenClaw gateway is not responding. An admin must reconnect it from Settings → System.'}
          </div>
        )}
      </div>
      )}

      {/* Critical Alert Banner */}
      <AnimatePresence>
        {canViewOperatorDiagnostics && activeAlerts.filter(a => (a.severity === 'CRITICAL' || a.severity === 'ERROR') && !(a.metadata as any)?.dismissedAt).length > 0 && (
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
                      type="button"
                      aria-label={`Dismiss ${alert.resource} alert`}
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
          label={systemStats ? 'CPU Usage' : 'CPU Load'}
          color="#10B981"
          value={currentCpuUsage?.toFixed(1) ?? '—'}
          unit="%"
          percent={currentCpuUsage}
          sparkData={cpuHistory}
          subtitle={systemStats ? (cpuCores ? `${cpuCores} cores` : undefined) : '1-minute load normalized by core count'}
        />
        <MetricCard
          icon={MemoryStick}
          label="Memory"
          color="#3B82F6"
          value={currentMemoryUsage?.toFixed(1) ?? '—'}
          unit="%"
          percent={currentMemoryUsage}
          sparkData={memHistory}
          subtitle={`${memUsedGB} / ${memTotalGB} GB`}
        />
        <MetricCard
          icon={HardDrive}
          label="Disk Usage"
          color="#8B5CF6"
          value={currentDiskUsage?.toFixed(1) ?? '—'}
          unit="%"
          percent={currentDiskUsage}
          sparkData={diskHistory}
          subtitle={`${diskTotalGB} GB total`}
        />
        <MetricCard
          icon={ArrowDown}
          label="Network In"
          color="#06B6D4"
          value={networkTelemetryAvailable && currentNetworkIn !== undefined && currentNetworkIn !== null ? formatNetworkRate(Number(currentNetworkIn)).value : '—'}
          unit={networkTelemetryAvailable && currentNetworkIn !== undefined && currentNetworkIn !== null ? formatNetworkRate(Number(currentNetworkIn)).unit : 'MB/s'}
          sparkData={netInHistory}
          subtitle={networkTelemetryAvailable ? undefined : 'telemetry unavailable'}
        />
        <MetricCard
          icon={ArrowUp}
          label="Network Out"
          color="#F59E0B"
          value={networkTelemetryAvailable && currentNetworkOut !== undefined && currentNetworkOut !== null ? formatNetworkRate(Number(currentNetworkOut)).value : '—'}
          unit={networkTelemetryAvailable && currentNetworkOut !== undefined && currentNetworkOut !== null ? formatNetworkRate(Number(currentNetworkOut)).unit : 'MB/s'}
          sparkData={netOutHistory}
          subtitle={networkTelemetryAvailable ? undefined : 'telemetry unavailable'}
        />
        <MetricCard
          icon={Layers}
          label="Processes"
          color="#EC4899"
          value={currentProcessCount?.toString() ?? '—'}
          unit=""
          subtitle="running"
          sparkData={processHistory}
        />
        <MetricCard
          icon={Gauge}
          label="Load Average"
          color="#F97316"
          value={loadAvg.length >= 3 ? `${loadAvg[0]?.toFixed(2)} / ${loadAvg[1]?.toFixed(2)} / ${loadAvg[2]?.toFixed(2)}` : (loadAvg.length >= 1 ? loadAvg[0].toFixed(2) : '—')}
          unit=""
          subtitle="1 / 5 / 15 min"
        />
        <MetricCard
          icon={Timer}
          label="Uptime"
          color="#14B8A6"
          value={uptimeSeconds ? formatUptime(uptimeSeconds) : '—'}
          unit=""
          subtitle={systemStats?.hostname || metrics?.metadata?.hostname || ''}
        />
      </motion.div>

      {/* Charts */}
      {showCharts ? (
        <Suspense fallback={<div className="grid grid-cols-1 lg:grid-cols-2 gap-5"><div className="glass p-5 h-[304px] flex items-center justify-center text-slate-500 text-sm">Loading charts…</div><div className="glass p-5 h-[304px] flex items-center justify-center text-slate-500 text-sm">Loading charts…</div></div>}>
          <LazyDashboardCharts chartData={chartData} networkAvailable={networkTelemetryAvailable} />
        </Suspense>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" aria-hidden="true">
          <div className="glass p-5 h-[304px] flex items-center justify-center text-slate-500 text-sm">Preparing charts…</div>
          <div className="glass p-5 h-[304px] flex items-center justify-center text-slate-500 text-sm">Preparing charts…</div>
        </div>
      )}

      {/* Activity Log */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        <ActivityLogTable />
      </motion.div>

      <TypedConfirmationDialog
        open={updateDialogOpen}
        title={`Install Portal ${updateStatus?.latest ? `v${updateStatus.latest}` : 'update'}`}
        description="Review the release and recovery plan, then confirm the owner-only update."
        confirmationPhrase={updateStatus?.preparation?.confirmationPhrase || 'UPDATE PORTAL'}
        confirmLabel={updatePlan === 'create-backup'
          ? 'Back up & update'
          : updatePlan === 'skip-backup'
            ? 'Update without backup'
            : 'Install update'}
        busyLabel={updatePlan === 'create-backup' ? 'Backing up safely…' : 'Starting signed updater…'}
        busy={updateInProgress}
        tone="warning"
        onCancel={() => {
          if (!updateSubmissionRef.current) setUpdateDialogOpen(false);
        }}
        onConfirm={(confirmation) => { void runSelfUpdate(confirmation); }}
        details={(
          <div className="space-y-4">
            <div className="rounded-xl border border-theme-border bg-theme-bg p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-theme-text">
                    v{updateStatus?.current || '—'} → v{updateStatus?.latest || '—'}
                  </p>
                  <p className="mt-0.5 text-xs text-theme-text-muted">
                    {updateDetails
                      ? `${releaseClassLabel(updateDetails.releaseClass)} released ${formatReleaseDate(updateDetails.releasedAt)}`
                      : 'The signed updater will verify the release bundle before installation.'}
                  </p>
                </div>
                {updateDetails && (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${releaseClassTone(updateDetails.releaseClass)}`}>
                    {releaseClassLabel(updateDetails.releaseClass)}
                  </span>
                )}
              </div>
              {updateDetails && (
                <ul className="mt-3 space-y-1.5 text-xs leading-5 text-theme-text-muted">
                  {updateDetails.highlights.map((highlight) => (
                    <li key={highlight} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 flex-none rounded-full bg-cyan-400" aria-hidden="true" />
                      <span>{highlight}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={`rounded-xl border bg-theme-surface p-3 ${
              updateBackupDescription.tone === 'good'
                ? 'border-emerald-400/25'
                : updateBackupDescription.tone === 'info'
                  ? 'border-cyan-400/25'
                  : 'border-amber-400/30'
            }`}>
              <p className="text-sm font-semibold text-theme-text">{updateBackupDescription.label}</p>
              <p className="mt-1 text-xs leading-5 text-theme-text-muted">{updateBackupDescription.detail}</p>
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-theme-text-muted">Recovery plan</legend>
              {updateBackup?.state === 'fresh' && (
                <label aria-label="Use the recent backup" htmlFor="portal-update-use-current" className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
                  updatePlan === 'use-current'
                    ? 'accent-active'
                    : 'border-theme-border bg-theme-surface accent-hover'
                }`}>
                  <input
                    id="portal-update-use-current"
                    type="radio"
                    name="portal-update-plan"
                    value="use-current"
                    checked={updatePlan === 'use-current'}
                    onChange={() => setUpdatePlan('use-current')}
                    disabled={updateInProgress}
                    className="mt-1"
                    style={{ accentColor: 'var(--accent, #6366f1)' }}
                  />
                  <span>
                    <span className="block text-sm font-semibold text-theme-text">Use the recent backup</span>
                    <span className="mt-0.5 block text-xs leading-5 text-theme-text-muted">Fastest path; the server will recheck freshness before the updater starts.</span>
                  </span>
                </label>
              )}
              <label aria-label="Create a fresh backup, then update" htmlFor="portal-update-create-backup" className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
                updatePlan === 'create-backup'
                  ? 'accent-active'
                  : 'border-theme-border bg-theme-surface accent-hover'
              }`}>
                <input
                  id="portal-update-create-backup"
                  type="radio"
                  name="portal-update-plan"
                  value="create-backup"
                  checked={updatePlan === 'create-backup'}
                  onChange={() => setUpdatePlan('create-backup')}
                  disabled={updateInProgress}
                  className="mt-1"
                  style={{ accentColor: 'var(--accent, #6366f1)' }}
                />
                <span>
                  <span className="block text-sm font-semibold text-theme-text">Create a fresh backup, then update</span>
                  <span className="mt-0.5 block text-xs leading-5 text-theme-text-muted">Recommended. Portal waits for the archive to finish before starting the signed updater.</span>
                </span>
              </label>
              {updateBackup?.state !== 'fresh' && (
                <label aria-label="Continue without a fresh backup" htmlFor="portal-update-skip-backup" className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
                  updatePlan === 'skip-backup'
                    ? 'accent-active'
                    : 'border-theme-border bg-theme-surface accent-hover'
                }`}>
                  <input
                    id="portal-update-skip-backup"
                    type="radio"
                    name="portal-update-plan"
                    value="skip-backup"
                    checked={updatePlan === 'skip-backup'}
                    onChange={() => setUpdatePlan('skip-backup')}
                    disabled={updateInProgress}
                    className="mt-1"
                    style={{ accentColor: 'var(--accent, #6366f1)' }}
                  />
                  <AlertTriangle size={16} className="mt-0.5 flex-none text-amber-300" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-semibold text-theme-text">Continue without a fresh backup</span>
                    <span className="mt-0.5 block text-xs leading-5 text-theme-text-muted">Available for emergencies, but recovery may rely on an older archive or the updater rollback dump.</span>
                  </span>
                </label>
              )}
            </fieldset>

            {updateMessage && (
              <div role="status" className="rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-xs leading-5 text-theme-text">
                {updateMessage}
              </div>
            )}
          </div>
        )}
      />
    </motion.div>
  );
}
