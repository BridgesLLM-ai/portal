import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../contexts/AuthContext';
import { adminAPI, AdminUser, RegistrationRequest } from '../api/admin';
import client from '../api/client';
import { agentJobsAPI, type AgentJob } from '../api/agentJobs';
import { isElevated, isOwner } from '../utils/authz';
import {
  Shield, Users, Clock, Settings, Trash2, Check, X,
  ChevronLeft, ChevronRight, Search, Loader2, ListTodo, Wrench, ClipboardCheck,
  AlertTriangle, RefreshCw, Play, HardDrive, ShieldCheck
} from 'lucide-react';
import sounds from '../utils/sounds';
import { DEFAULT_REGISTRATION_MODE } from '../utils/securityDefaults';

type Tab = 'users' | 'maintenance' | 'pending' | 'settings';
type MaintenanceSeverity = 'healthy' | 'info' | 'warning' | 'critical';
type MaintenanceAction = {
  id: string;
  label: string;
  description: string;
  risk: 'safe' | 'scheduled' | 'manual';
  downtimeExpected: boolean;
  requiresOwner: boolean;
  changesSystem: boolean;
  destructive: boolean;
  requiresBackup: boolean;
  requiresMaintenanceWindow: boolean;
  automationLevel: 'read-only' | 'safe' | 'guarded' | 'manual';
  impact: string;
  recovery: string;
};
type MaintenanceIssue = {
  id: string;
  title: string;
  detail: string;
  severity: Exclude<MaintenanceSeverity, 'healthy'>;
  category: 'security' | 'updates' | 'services' | 'disk' | 'backups' | 'system';
  recommendation: string;
  actionId?: string;
  downtimeExpected?: boolean;
  automationSafe: boolean;
};
type MaintenanceCompatibilityComponent = {
  id: string;
  label: string;
  installedVersion: string | null;
  supportedVersion: string;
  policy: 'self-update-only' | 'known-compatible' | 'manual-review' | 'blocked-until-confirmed';
  status: 'ok' | 'review' | 'blocked' | 'unknown';
  note: string;
};
type MaintenanceStatus = {
  checkedAt: string;
  status: MaintenanceSeverity;
  summary: string;
  host: { hostname: string; os: string; kernel: string; uptimeSeconds: number };
  issues: MaintenanceIssue[];
  actions: MaintenanceAction[];
  compatibility?: {
    policy: 'guarded';
    summary: string;
    components: MaintenanceCompatibilityComponent[];
  };
  backup?: { path: string; createdAt: string; ageHours: number } | null;
  reboot?: { required: boolean; packages: string[] };
};

export default function AdminPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const owner = isOwner(user);
  const requestedTab = searchParams.get('tab');
  const initialTab: Tab = requestedTab === 'maintenance' || requestedTab === 'pending' || requestedTab === 'settings' ? requestedTab : 'users';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (user && !isElevated(user)) {
      navigate('/', { replace: true });
    }
  }, [user, navigate]);

  useEffect(() => {
    if (user && !owner && (activeTab === 'pending' || activeTab === 'settings')) {
      setActiveTab('users');
      setSearchParams({});
    }
  }, [activeTab, owner, setSearchParams, user]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'users' || tab === 'maintenance' || tab === 'pending' || tab === 'settings') {
      if (tab !== activeTab) setActiveTab(tab);
    }
  }, [activeTab, searchParams]);

  if (!user || !isElevated(user)) return null;

  const tabs: { id: Tab; label: string; icon: typeof Users }[] = [
    { id: 'users', label: 'Users', icon: Users },
    { id: 'maintenance', label: 'Maintenance', icon: Wrench },
    ...(owner ? [{ id: 'pending' as Tab, label: 'Pending Approvals', icon: Clock }] : []),
    ...(owner ? [{ id: 'settings' as Tab, label: 'Settings', icon: Settings }] : []),
  ];

  return (
    <div className="h-full overflow-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
          <Shield size={20} className="text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Admin Panel</h1>
          <p className="text-xs text-slate-400">Manage users, approvals, and access controls</p>
        </div>
      </div>

      <div className="flex gap-1 bg-white/[0.03] rounded-xl p-1 border border-white/5 w-fit">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setActiveTab(id);
              setSearchParams(id === 'users' ? {} : { tab: id });
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
              ${activeTab === id
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
              }`}
          >
            <Icon size={16} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === 'users' && <UsersTab currentUserId={user.id} isOwner={owner} />}
          {activeTab === 'maintenance' && <MaintenanceTab owner={owner} />}
          {activeTab === 'pending' && owner && <PendingTab />}
          {activeTab === 'settings' && owner && <SettingsTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function maintenanceTone(status: MaintenanceSeverity): string {
  return status === 'critical' ? 'border-red-500/20 bg-red-500/[0.06] text-red-100'
    : status === 'warning' ? 'border-amber-500/20 bg-amber-500/[0.06] text-amber-100'
      : status === 'info' ? 'border-cyan-500/20 bg-cyan-500/[0.06] text-cyan-100'
        : 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-100';
}

function riskTone(action: MaintenanceAction): string {
  if (action.destructive) return 'border-red-500/25 bg-red-500/10 text-red-100';
  if (action.automationLevel === 'guarded' || action.requiresMaintenanceWindow) return 'border-amber-500/25 bg-amber-500/10 text-amber-100';
  if (action.changesSystem) return 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100';
  return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100';
}

function jobStatusLabel(status: AgentJob['status']): string {
  return status === 'completed' ? 'done' : status === 'error' || status === 'killed' ? 'failed' : status;
}

function MaintenanceTab({ owner }: { owner: boolean }) {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<MaintenanceAction | null>(null);

  const loadMaintenance = useCallback(async () => {
    setLoading(true);
    try {
      const [statusResult, jobsResult] = await Promise.all([
        client.get<MaintenanceStatus>('/system/maintenance'),
        agentJobsAPI.list().catch(() => [] as AgentJob[]),
      ]);
      setStatus(statusResult.data);
      setJobs(jobsResult.filter((job) => job.toolId === 'system-maintenance').slice(0, 6));
      setMessage(null);
    } catch (err: any) {
      setMessage(err.response?.data?.error || err.message || 'Failed to load maintenance status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMaintenance(); }, [loadMaintenance]);

  const requestAction = useCallback((action: MaintenanceAction) => {
    if (!owner) {
      setMessage('Owner access is required to run maintenance actions.');
      return;
    }
    setPendingAction(action);
  }, [owner]);

  const runAction = useCallback(async (action: MaintenanceAction) => {
    setPendingAction(null);
    setRunningAction(action.id);
    setMessage(null);
    try {
      const { data } = await client.post(`/system/maintenance/actions/${action.id}`);
      setMessage(data?.job?.id ? `${action.label} started. Job ${data.job.id}` : `${action.label} started.`);
      await loadMaintenance();
    } catch (err: any) {
      setMessage(err.response?.data?.error || err.message || `Failed to start ${action.label}`);
    } finally {
      setRunningAction(null);
    }
  }, [loadMaintenance]);

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm text-slate-300">
        <Loader2 size={16} className="animate-spin" />
        Loading maintenance state...
      </div>
    );
  }

  const issues = status?.issues || [];
  const actions = status?.actions || [];

  return (
    <div className="space-y-4">
      {message && (
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-200">
          {message}
        </div>
      )}

      {status && (
        <div className={`rounded-xl border p-4 ${maintenanceTone(status.status)}`}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                {status.status === 'healthy' ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}
                <h2 className="text-sm font-semibold text-white">
                  {status.status === 'healthy' ? 'Server maintenance is healthy' : 'Server maintenance needs attention'}
                </h2>
              </div>
              <p className="mt-1 text-sm text-slate-200">{status.summary}</p>
              <p className="mt-1 text-xs text-slate-400">
                {status.host.os} · kernel {status.host.kernel} · checked {new Date(status.checkedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={loadMaintenance}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                Recheck
              </button>
              <Link
                to="/tasks"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10"
              >
                <ListTodo size={14} />
                Job History
              </Link>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2">
            <ClipboardCheck size={17} className="text-emerald-300" />
            <h2 className="text-sm font-semibold text-white">Open Items</h2>
          </div>
          <div className="mt-3 space-y-3">
            {issues.length === 0 ? (
              <p className="text-sm text-slate-400">No maintenance issues are currently detected.</p>
            ) : issues.map((issue) => {
              const action = actions.find((candidate) => candidate.id === issue.actionId);
              return (
                <div key={issue.id} className="rounded-xl border border-white/8 bg-black/15 p-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          issue.severity === 'critical' ? 'bg-red-500/20 text-red-100'
                            : issue.severity === 'warning' ? 'bg-amber-500/20 text-amber-100'
                              : 'bg-cyan-500/20 text-cyan-100'
                        }`}>
                          {issue.severity}
                        </span>
                        <span className="rounded-md bg-slate-700/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">{issue.category}</span>
                        <h3 className="text-sm font-medium text-white">{issue.title}</h3>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-300">{issue.detail}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{issue.recommendation}</p>
                      {issue.downtimeExpected && <p className="mt-1 text-xs text-red-200">Downtime required. Schedule this instead of automating it blindly.</p>}
                    </div>
                    {action ? (
                      <button
                        onClick={() => requestAction(action)}
                        disabled={!owner || runningAction === action.id}
                        title={action.description}
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {runningAction === action.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                        {action.label}
                      </button>
                    ) : (
                      <span className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                        Manual review
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={17} className="text-cyan-300" />
            <h2 className="text-sm font-semibold text-white">Compatibility Guardrails</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            {status?.compatibility?.summary || 'Maintenance automation is guarded by Portal compatibility policy.'}
          </p>
          <div className="mt-3 space-y-2">
            {status?.compatibility?.components.map((component) => (
              <div key={component.id} className="rounded-lg border border-white/8 bg-black/15 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-white">{component.label}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{component.installedVersion || 'Version unknown'} · {component.supportedVersion}</p>
                  </div>
                  <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    component.status === 'blocked' ? 'bg-red-500/15 text-red-100'
                      : component.status === 'review' ? 'bg-amber-500/15 text-amber-100'
                        : component.status === 'ok' ? 'bg-emerald-500/15 text-emerald-100'
                          : 'bg-slate-500/15 text-slate-200'
                  }`}>
                    {component.status}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-slate-400">{component.note}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <div className="flex items-center gap-2">
          <Wrench size={17} className="text-amber-200" />
          <h2 className="text-sm font-semibold text-white">Available Actions</h2>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {actions.map((action) => (
            <div key={action.id} className={`rounded-xl border p-3 ${riskTone(action)}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{action.label}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{action.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="rounded-md bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wide">{action.automationLevel}</span>
                    <span className="rounded-md bg-black/20 px-2 py-0.5 text-[10px]">{action.changesSystem ? 'changes server' : 'read-only'}</span>
                    <span className="rounded-md bg-black/20 px-2 py-0.5 text-[10px]">{action.destructive ? 'destructive' : 'non-destructive'}</span>
                    {action.requiresBackup && <span className="rounded-md bg-black/20 px-2 py-0.5 text-[10px]">backup first</span>}
                    {action.requiresMaintenanceWindow && <span className="rounded-md bg-black/20 px-2 py-0.5 text-[10px]">maintenance window</span>}
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-slate-400"><span className="text-slate-300">Impact:</span> {action.impact}</p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500"><span className="text-slate-400">Recovery:</span> {action.recovery}</p>
                </div>
                <button
                  onClick={() => requestAction(action)}
                  disabled={!owner || runningAction === action.id}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {runningAction === action.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Run
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HardDrive size={17} className="text-blue-300" />
            <h2 className="text-sm font-semibold text-white">Recent Maintenance Jobs</h2>
          </div>
          <Link to="/tasks" className="text-xs font-medium text-emerald-300 hover:text-emerald-200">Full history</Link>
        </div>
        <div className="mt-3 space-y-2">
          {jobs.length === 0 ? (
            <p className="text-sm text-slate-400">No maintenance jobs have run yet.</p>
          ) : jobs.map((job) => (
            <div key={job.id} className="flex flex-col gap-1 rounded-lg border border-white/8 bg-black/15 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-white">{job.title || job.toolId}</p>
                <p className="text-[11px] text-slate-500">{new Date(job.startedAt || job.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</p>
              </div>
              <span className={`w-fit rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${
                job.status === 'completed' ? 'bg-emerald-500/15 text-emerald-100'
                  : job.status === 'running' ? 'bg-blue-500/15 text-blue-100'
                    : 'bg-red-500/15 text-red-100'
              }`}>
                {jobStatusLabel(job.status)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {pendingAction && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-[#0A0E27] shadow-2xl shadow-black/40">
            <div className={`border-b px-5 py-4 ${riskTone(pendingAction)}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                      {pendingAction.automationLevel}
                    </span>
                    <span className="rounded-md bg-black/25 px-2 py-0.5 text-[10px]">
                      {pendingAction.changesSystem ? 'changes server' : 'read-only'}
                    </span>
                    <span className="rounded-md bg-black/25 px-2 py-0.5 text-[10px]">
                      {pendingAction.destructive ? 'destructive' : 'non-destructive'}
                    </span>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-white">{pendingAction.label}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-300">{pendingAction.description}</p>
                </div>
                <button
                  onClick={() => setPendingAction(null)}
                  className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
                  aria-label="Close maintenance action confirmation"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Impact</p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{pendingAction.impact}</p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recovery</p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{pendingAction.recovery}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {pendingAction.requiresBackup && <span className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-100">Backup first</span>}
                {pendingAction.requiresMaintenanceWindow && <span className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-100">Maintenance window</span>}
                {pendingAction.downtimeExpected && <span className="rounded-lg border border-red-400/20 bg-red-500/10 px-2.5 py-1 text-xs text-red-100">Downtime expected</span>}
                {!pendingAction.requiresBackup && !pendingAction.requiresMaintenanceWindow && !pendingAction.downtimeExpected && (
                  <span className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-100">No downtime expected</span>
                )}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-white/8 bg-black/15 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                onClick={() => setPendingAction(null)}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={() => runAction(pendingAction)}
                disabled={runningAction === pendingAction.id}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {runningAction === pendingAction.id ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                Start Background Job
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UsersTab({ currentUserId, isOwner: ownerAccess }: { currentUserId: string; isOwner: boolean }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [transferConfirm, setTransferConfirm] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAPI.listUsers({ page, search: search || undefined });
      setUsers(res.users);
      setTotal(res.total);
      setPages(res.pages);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleRoleChange = async (userId: string, role: AdminUser['role']) => {
    if (!ownerAccess) return;
    try {
      await adminAPI.updateUser(userId, { role });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role } : u));
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update role');
    }
  };

  const handleStatusChange = async (userId: string, accountStatus: AdminUser['accountStatus']) => {
    if (!ownerAccess) return;
    try {
      await adminAPI.updateUser(userId, { accountStatus });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, accountStatus, isActive: accountStatus === 'ACTIVE' } : u));
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update account status');
    }
  };

  const handleSandboxToggle = async (userId: string, sandboxEnabled: boolean) => {
    if (!ownerAccess) return;
    try {
      await adminAPI.updateUser(userId, { sandboxEnabled });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, sandboxEnabled } : u));
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update sandbox');
    }
  };

  const handleDelete = async (userId: string) => {
    if (!ownerAccess) return;
    try {
      await adminAPI.deleteUser(userId);
      sounds.delete();
      setUsers(prev => prev.filter(u => u.id !== userId));
      setTotal(prev => prev - 1);
      setDeleteConfirm(null);
    } catch (err: any) {
      sounds.error();
      alert(err.response?.data?.error || 'Failed to delete user');
    }
  };

  const handleTransferOwnership = async (userId: string) => {
    if (!ownerAccess) return;
    try {
      await adminAPI.transferOwnership(userId);
      alert('Ownership transferred. You are now SUB_ADMIN.');
      window.location.reload();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to transfer ownership');
    }
  };

  const roleBadge = (role: string) => {
    const styles: Record<string, string> = {
      OWNER: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30',
      SUB_ADMIN: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
      USER: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      VIEWER: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    };
    return (
      <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${styles[role] || 'bg-slate-500/10 text-slate-400'}`}>
        {role}
      </span>
    );
  };

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      ACTIVE: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
      PENDING: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
      DISABLED: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
      BANNED: 'bg-red-500/10 text-red-300 border-red-500/20',
    };
    return (
      <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${styles[status] || 'bg-slate-500/10 text-slate-400'}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {!ownerAccess && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-200 text-xs px-3 py-2">
          Read-only: only the OWNER can promote/demote, change account status, approve requests, or delete users.
        </div>
      )}

      <div className="relative max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search users..."
          className="w-full pl-9 pr-4 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white placeholder-slate-500 outline-none focus:border-emerald-500/40"
        />
      </div>

      <div className="rounded-xl border border-white/5 overflow-hidden bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-slate-400 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">User</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Account</th>
                <th className="text-center px-4 py-3">Sandbox</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Joined</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-500">
                    <Loader2 size={20} className="animate-spin inline mr-2" /> Loading...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-500">No users found</td>
                </tr>
              ) : users.map(u => (
                <tr key={u.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-white overflow-hidden flex-shrink-0">
                        {u.avatarPath
                          ? <img src={`/static-assets/avatars/${u.avatarPath}`} alt="" className="w-full h-full object-cover" />
                          : (u.username?.[0] || u.email[0]).toUpperCase()
                        }
                      </div>
                      <div className="min-w-0">
                        <p className="text-white font-medium truncate">{u.username}</p>
                        <p className="text-xs text-slate-500 truncate">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.id === currentUserId || u.role === 'OWNER' || !ownerAccess ? (
                      roleBadge(u.role)
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as AdminUser['role'])}
                        className="bg-white/[0.04] border border-white/10 text-white text-xs rounded-md px-2 py-1 outline-none focus:border-emerald-500/40"
                      >
                        <option value="SUB_ADMIN">SUB_ADMIN</option>
                        <option value="USER">USER</option>
                        <option value="VIEWER">VIEWER</option>
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.role === 'OWNER' || !ownerAccess ? (
                      statusBadge(u.accountStatus)
                    ) : (
                      <select
                        value={u.accountStatus}
                        onChange={(e) => handleStatusChange(u.id, e.target.value as AdminUser['accountStatus'])}
                        className="bg-white/[0.04] border border-white/10 text-white text-xs rounded-md px-2 py-1 outline-none focus:border-emerald-500/40"
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="PENDING">PENDING</option>
                        <option value="DISABLED">DISABLED</option>
                        <option value="BANNED">BANNED</option>
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleSandboxToggle(u.id, !u.sandboxEnabled)}
                      disabled={!ownerAccess || u.role === 'OWNER'}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                        ${u.sandboxEnabled ? 'bg-emerald-500' : 'bg-slate-600'} ${(!ownerAccess || u.role === 'OWNER') ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform
                          ${u.sandboxEnabled ? 'translate-x-4' : 'translate-x-1'}`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs hidden md:table-cell">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {ownerAccess && u.id !== currentUserId && u.role !== 'OWNER' && (
                      deleteConfirm === u.id ? (
                        <div className="flex items-center gap-1 justify-end">
                          <span className="text-xs text-red-400 mr-1">Delete?</span>
                          <button onClick={() => handleDelete(u.id)} className="p-1 rounded hover:bg-red-500/20 text-red-400" title="Confirm"><Check size={14} /></button>
                          <button onClick={() => setDeleteConfirm(null)} className="p-1 rounded hover:bg-white/10 text-slate-400" title="Cancel"><X size={14} /></button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 justify-end">
                          {u.accountStatus === 'ACTIVE' && transferConfirm === u.id ? (
                            <>
                              <button
                                onClick={() => handleTransferOwnership(u.id)}
                                className="px-2 py-1 text-[11px] rounded bg-fuchsia-500/20 text-fuchsia-300 hover:bg-fuchsia-500/30"
                                title="Confirm ownership transfer"
                              >
                                Confirm Transfer
                              </button>
                              <button onClick={() => setTransferConfirm(null)} className="p-1 rounded hover:bg-white/10 text-slate-400" title="Cancel transfer"><X size={14} /></button>
                            </>
                          ) : u.accountStatus === 'ACTIVE' ? (
                            <button
                              onClick={() => setTransferConfirm(u.id)}
                              className="px-2 py-1 text-[11px] rounded bg-fuchsia-500/10 text-fuchsia-300 hover:bg-fuchsia-500/20"
                              title="Transfer ownership"
                            >
                              Transfer
                            </button>
                          ) : null}
                          <button onClick={() => setDeleteConfirm(u.id)} className="p-1.5 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-400 transition-colors" title="Delete user"><Trash2 size={15} /></button>
                        </div>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>{total} user{total !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30"><ChevronLeft size={16} /></button>
            <span>Page {page} of {pages}</span>
            <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages} className="p-1.5 rounded hover:bg-white/5 disabled:opacity-30"><ChevronRight size={16} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function PendingTab() {
  const [requests, setRequests] = useState<RegistrationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAPI.listRegistrationRequests({ status: 'PENDING' });
      setRequests(res.requests);
    } catch (err) {
      console.error('Failed to load requests:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const handleApprove = async (id: string) => {
    try {
      await adminAPI.approveRequest(id);
      sounds.success();
      setRequests(prev => prev.filter(r => r.id !== id));
    } catch (err: any) {
      sounds.error();
      alert(err.response?.data?.error || 'Failed to approve');
    }
  };

  const handleDeny = async (id: string) => {
    try {
      await adminAPI.denyRequest(id, denyReason || undefined);
      sounds.delete();
      setRequests(prev => prev.filter(r => r.id !== id));
      setDenyingId(null);
      setDenyReason('');
    } catch (err: any) {
      sounds.error();
      alert(err.response?.data?.error || 'Failed to deny');
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-slate-500">
        <Loader2 size={20} className="animate-spin inline mr-2" /> Loading requests...
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock size={40} className="mx-auto text-slate-600 mb-3" />
        <p className="text-slate-400">No pending registration requests</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/5 overflow-hidden bg-white/[0.02]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/5 text-slate-400 text-xs uppercase tracking-wider">
            <th className="text-left px-4 py-3">Name</th>
            <th className="text-left px-4 py-3">Email</th>
            <th className="text-left px-4 py-3 hidden md:table-cell">Message</th>
            <th className="text-left px-4 py-3 hidden sm:table-cell">Requested</th>
            <th className="text-right px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {requests.map(r => (
            <tr key={r.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="px-4 py-3 text-white font-medium">{r.name}</td>
              <td className="px-4 py-3 text-slate-300">{r.email}</td>
              <td className="px-4 py-3 text-slate-400 text-xs max-w-[200px] truncate hidden md:table-cell">{r.message || '—'}</td>
              <td className="px-4 py-3 text-slate-400 text-xs hidden sm:table-cell">{new Date(r.requestedAt).toLocaleDateString()}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2 justify-end">
                  {denyingId === r.id ? (
                    <div className="flex items-center gap-1">
                      <input type="text" value={denyReason} onChange={(e) => setDenyReason(e.target.value)} placeholder="Reason (optional)" className="bg-white/[0.04] border border-white/10 text-white text-xs rounded px-2 py-1 w-32 outline-none" />
                      <button onClick={() => handleDeny(r.id)} className="p-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20" title="Confirm deny"><Check size={14} /></button>
                      <button onClick={() => { setDenyingId(null); setDenyReason(''); }} className="p-1 rounded hover:bg-white/10 text-slate-400"><X size={14} /></button>
                    </div>
                  ) : (
                    <>
                      <button onClick={() => handleApprove(r.id)} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs font-medium border border-emerald-500/20 transition-colors"><Check size={13} /> Approve</button>
                      <button onClick={() => setDenyingId(r.id)} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs font-medium border border-red-500/20 transition-colors"><X size={13} /> Deny</button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminAPI.getSettings()
      .then(s => { setSettings(s); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await adminAPI.updateSettings(settings);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-slate-500">
        <Loader2 size={20} className="animate-spin inline mr-2" /> Loading settings...
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-3">
        <h3 className="text-sm font-semibold text-white">Registration Mode</h3>
        <p className="text-xs text-slate-400">Control how new users can join the portal.</p>
        <div className="space-y-2">
          {[
            { value: 'open', label: 'Open', desc: 'Anyone can register and immediately access the portal' },
            { value: 'approval', label: 'Approval Required', desc: 'New registrations require owner approval' },
            { value: 'closed', label: 'Closed', desc: 'Registration is disabled — owner must create accounts' },
          ].map(opt => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors border
                ${((settings['security.registrationMode'] || settings.registrationMode || DEFAULT_REGISTRATION_MODE)) === opt.value
                  ? 'bg-emerald-500/5 border-emerald-500/20'
                  : 'bg-white/[0.02] border-white/5 hover:border-white/10'
                }`}
            >
              <input
                type="radio"
                name="registrationMode"
                value={opt.value}
                checked={((settings['security.registrationMode'] || settings.registrationMode || DEFAULT_REGISTRATION_MODE)) === opt.value}
                onChange={() => setSettings(s => ({ ...s, registrationMode: opt.value, 'security.registrationMode': opt.value }))}
                className="mt-0.5 accent-emerald-500"
              />
              <div>
                <p className="text-sm text-white font-medium">{opt.label}</p>
                <p className="text-xs text-slate-400">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all
          ${saved
            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            : 'bg-emerald-500 text-white hover:bg-emerald-600 border border-emerald-500'
          }`}
      >
        {saving ? (
          <><Loader2 size={14} className="animate-spin" /> Saving...</>
        ) : saved ? (
          <><Check size={14} /> Saved</>
        ) : (
          'Save Settings'
        )}
      </button>
    </div>
  );
}
