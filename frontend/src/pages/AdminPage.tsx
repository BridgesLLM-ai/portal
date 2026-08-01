import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { Link, UNSAFE_NavigationContext, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../contexts/AuthContext';
import {
  adminAPI,
  type AdminAuthorizationSafety,
  type RegistrationApprovalResponse,
  type AdminUser,
  type RegistrationRequest,
} from '../api/admin';
import { agentJobsAPI, type AgentJob } from '../api/agentJobs';
import {
  maintenanceAPI,
  type MaintenanceAction,
  type MaintenanceSeverity,
  type MaintenanceStatus,
} from '../api/maintenance';
import { isElevated, isOwner } from '../utils/authz';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';
import ViewportModal from '../components/ViewportModal';
import {
  adminTabIdsForRole,
  isActiveMaintenanceJob,
  maintenanceActionNeedsOwner,
  maintenancePollDelayMs,
  maintenanceRetryDelayLabel,
  nextTabIndex,
  resolveAdminTab,
  shouldPollMaintenance,
  type AdminTabId,
} from './settingsAdminContract';
import {
  Shield, Users, Clock, Trash2, Check, X,
  ChevronLeft, ChevronRight, Search, Loader2, ListTodo, Wrench, ClipboardCheck,
  AlertTriangle, RefreshCw, Play, HardDrive, ShieldCheck, CheckCircle2, XCircle
} from 'lucide-react';
import sounds from '../utils/sounds';

type Tab = AdminTabId;

type AdminMutationKind =
  | 'role'
  | 'status'
  | 'workspace'
  | 'promote'
  | 'transfer'
  | 'approve-registration'
  | 'deny-registration';

type AdminMutationSnapshot = Readonly<{
  kind: AdminMutationKind;
  targetId: string;
  targetValue?: string;
}>;

type AdminMutationLease = Readonly<{
  token: symbol;
  action: AdminMutationSnapshot;
}>;

function boundedAdminError(error: any, fallback: string): string {
  const raw = error?.response?.data?.error || error?.message || fallback;
  const message = String(raw).replace(/\s+/g, ' ').trim() || fallback;
  return message.length > 320 ? `${message.slice(0, 319)}…` : message;
}

type RegistrationFeedback = Readonly<{
  type: 'success' | 'warning' | 'error';
  message: string;
}>;

function boundedApprovalReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const normalized = reason
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
}

function approvalNotificationFeedback(
  response: RegistrationApprovalResponse,
  applicantEmail: string,
): RegistrationFeedback {
  const notification = response.notification;
  if (
    notification?.state === 'sent'
    && notification.delivered === true
    && notification.manualNotificationRequired === false
  ) {
    return {
      type: 'success',
      message: `Registration approved for ${applicantEmail}. The approval email was sent.`,
    };
  }

  const reason = boundedApprovalReason(notification?.reason);
  const detail = reason ? ` ${reason}` : '';
  if (
    notification?.state === 'manual_required'
    && notification.delivered === false
    && notification.manualNotificationRequired === true
  ) {
    return {
      type: 'warning',
      message: `Registration approved for ${applicantEmail}. No approval email was sent; contact the applicant directly.${detail}`,
    };
  }
  if (
    notification?.state === 'failed'
    && notification.delivered === false
    && notification.manualNotificationRequired === true
  ) {
    return {
      type: 'warning',
      message: `Registration approved for ${applicantEmail}, but the approval email could not be delivered. Contact the applicant directly.${detail}`,
    };
  }
  if (
    notification?.state === 'disabled'
    && notification.delivered === false
    && notification.manualNotificationRequired === false
  ) {
    return {
      type: 'warning',
      message: `Registration approved for ${applicantEmail}. Automatic approval email is disabled; contact the applicant directly.${detail}`,
    };
  }

  return unconfirmedApprovalFeedback(applicantEmail);
}

function unconfirmedApprovalFeedback(applicantEmail: string): RegistrationFeedback {
  return {
    type: 'warning',
    message: `Registration approved for ${applicantEmail}, but Portal could not confirm the notification result. Contact the applicant directly. The approval is already complete; do not approve it again.`,
  };
}

function isAmbiguousApprovalError(error: any): boolean {
  if (!error?.response) return true;
  const status = Number(error.response.status);
  return !Number.isFinite(status) || status >= 500;
}

function useAdminMutationAdmission() {
  const { navigator: routerNavigator } = useContext(UNSAFE_NavigationContext);
  const activeRef = useRef<AdminMutationLease | null>(null);
  const [active, setActive] = useState<AdminMutationLease | null>(null);
  const releaseNavigationLockRef = useRef<(() => void) | null>(null);
  const mutationHistoryRef = useRef<{
    url: string;
    state: unknown;
    historyIndex: number | null;
  } | null>(null);

  const releaseNavigationLock = useCallback(() => {
    releaseNavigationLockRef.current?.();
    releaseNavigationLockRef.current = null;
    mutationHistoryRef.current = null;
  }, []);

  const acquireNavigationLock = useCallback(() => {
    if (releaseNavigationLockRef.current) return;
    const originalPush = routerNavigator.push;
    const originalReplace = routerNavigator.replace;
    const originalGo = routerNavigator.go;
    const blockedPush: typeof routerNavigator.push = () => undefined;
    const blockedReplace: typeof routerNavigator.replace = () => undefined;
    const blockedGo: typeof routerNavigator.go = () => undefined;

    routerNavigator.push = blockedPush;
    routerNavigator.replace = blockedReplace;
    routerNavigator.go = blockedGo;
    const browserHistoryIndex = window.history.state?.idx;
    mutationHistoryRef.current = {
      url: window.location.href,
      state: window.history.state,
      historyIndex: typeof browserHistoryIndex === 'number' ? browserHistoryIndex : null,
    };
    releaseNavigationLockRef.current = () => {
      if (routerNavigator.push === blockedPush) routerNavigator.push = originalPush;
      if (routerNavigator.replace === blockedReplace) routerNavigator.replace = originalReplace;
      if (routerNavigator.go === blockedGo) routerNavigator.go = originalGo;
    };
  }, [routerNavigator]);

  const begin = useCallback((action: AdminMutationSnapshot): AdminMutationLease | null => {
    if (activeRef.current) return null;
    const lease = Object.freeze({
      token: Symbol(`admin-${action.kind}-${action.targetId}`),
      action: Object.freeze({ ...action }),
    });
    acquireNavigationLock();
    activeRef.current = lease;
    setActive(lease);
    return lease;
  }, [acquireNavigationLock]);

  const finish = useCallback((lease: AdminMutationLease) => {
    if (activeRef.current?.token !== lease.token) return;
    activeRef.current = null;
    setActive(null);
    releaseNavigationLock();
  }, [releaseNavigationLock]);

  const isRunning = useCallback((lease?: AdminMutationLease | null) => {
    if (!activeRef.current) return false;
    return !lease || activeRef.current.token === lease.token;
  }, []);

  const matches = useCallback((kind: AdminMutationKind, targetId: string) => (
    activeRef.current?.action.kind === kind && activeRef.current.action.targetId === targetId
  ), []);

  useEffect(() => {
    const ownsTopModal = (target: EventTarget | null) => (
      target instanceof Element && Boolean(target.closest('[data-viewport-modal-layer="true"]'))
    );
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!activeRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const preventOutsideModalInteraction = (event: Event) => {
      if (!activeRef.current || ownsTopModal(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const preventHistoryTraversal = (event: PopStateEvent) => {
      if (!activeRef.current) return;
      const guard = mutationHistoryRef.current;
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

    window.addEventListener('beforeunload', preventUnload);
    window.addEventListener('popstate', preventHistoryTraversal, true);
    document.addEventListener('pointerdown', preventOutsideModalInteraction, true);
    document.addEventListener('click', preventOutsideModalInteraction, true);
    return () => {
      window.removeEventListener('beforeunload', preventUnload);
      window.removeEventListener('popstate', preventHistoryTraversal, true);
      document.removeEventListener('pointerdown', preventOutsideModalInteraction, true);
      document.removeEventListener('click', preventOutsideModalInteraction, true);
    };
  }, []);

  useEffect(() => releaseNavigationLock, [releaseNavigationLock]);

  return { active, begin, finish, isRunning, matches };
}

type AdminMutationAdmission = ReturnType<typeof useAdminMutationAdmission>;

function adminMutationWorkingLabel(action: AdminMutationSnapshot): string {
  switch (action.kind) {
    case 'role': return 'Updating role…';
    case 'status': return 'Updating account status…';
    case 'workspace': return 'Updating project workspace…';
    case 'promote': return 'Granting server access…';
    case 'transfer': return 'Transferring ownership…';
    case 'approve-registration': return 'Approving…';
    case 'deny-registration': return 'Denying…';
  }
}

function adminMutationUsesConfirmationDialog(action: AdminMutationSnapshot): boolean {
  return action.kind === 'promote' || action.kind === 'transfer';
}

export default function AdminPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const owner = isOwner(user);
  const activeTab = resolveAdminTab(user?.role, searchParams.get('tab'));
  const mutationAdmission = useAdminMutationAdmission();
  const inlineMutation = mutationAdmission.active && !adminMutationUsesConfirmationDialog(mutationAdmission.active.action)
    ? mutationAdmission.active
    : null;

  useEffect(() => {
    if (user && !isElevated(user)) {
      navigate('/', { replace: true });
    }
  }, [user, navigate]);

  if (!user || !isElevated(user)) return null;

  const tabDefinitions: Record<Tab, { label: string; icon: typeof Users }> = {
    users: { label: 'Users', icon: Users },
    maintenance: { label: 'Maintenance', icon: Wrench },
    pending: { label: 'Pending Approvals', icon: Clock },
  };
  const tabs = adminTabIdsForRole(user.role).map((id) => ({ id, ...tabDefinitions[id] }));

  const selectTab = (id: Tab) => {
    if (mutationAdmission.isRunning()) return;
    const next = new URLSearchParams(searchParams);
    if (id === 'users') next.delete('tab');
    else next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const tabContent = (
    <div
      id={`admin-panel-${activeTab}`}
      role="tabpanel"
      aria-labelledby={`admin-tab-${activeTab}`}
      tabIndex={0}
      className="outline-none"
    >
      {activeTab === 'users' && <UsersTab currentUserId={user.id} isOwner={owner} mutationAdmission={mutationAdmission} />}
      {activeTab === 'maintenance' && <MaintenanceTab owner={owner} />}
      {activeTab === 'pending' && owner && <PendingTab mutationAdmission={mutationAdmission} />}
    </div>
  );

  return (
    <div className="h-full overflow-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
          <Shield size={20} className="text-purple-400" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Admin</h1>
          <p className="text-xs text-slate-400">User authority and guarded server maintenance</p>
        </div>
      </div>

      <div className={`rounded-xl border px-4 py-3 text-xs leading-5 ${owner ? 'border-fuchsia-500/20 bg-fuchsia-500/5 text-fuchsia-100' : 'border-purple-500/20 bg-purple-500/5 text-purple-100'}`}>
        {owner
          ? <>Only the Owner can change users or mutate the server. Promoting someone to <strong>SUB_ADMIN</strong> grants root-equivalent Agent Chat and Terminal access; it does not grant ownership or owner-only maintenance controls. Portal configuration lives in <Link to="/settings" className="font-semibold underline underline-offset-2">Settings</Link>.</>
          : <>Your <strong>SUB_ADMIN</strong> role is an intentional host-operator role: Agent Chat and Terminal can read, write, and execute across this server. Project Chat remains separately container-isolated. User changes and server mutations stay Owner-only.</>}
      </div>

      <div role="tablist" aria-label="Admin sections" className="flex w-full gap-1 overflow-x-auto rounded-xl border border-white/5 bg-white/[0.03] p-1 sm:w-fit">
        {tabs.map(({ id, label, icon: Icon }, index) => (
          <button
            type="button"
            key={id}
            id={`admin-tab-${id}`}
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`admin-panel-${id}`}
            aria-label={label}
            tabIndex={activeTab === id ? 0 : -1}
            disabled={Boolean(mutationAdmission.active)}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => {
              const targetIndex = nextTabIndex(index, tabs.length, event.key);
              if (targetIndex === null) return;
              event.preventDefault();
              const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              buttons?.[targetIndex]?.focus();
              buttons?.[targetIndex]?.click();
            }}
            className={`flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50
              ${activeTab === id
                ? 'accent-active'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border-transparent'
              }`}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {tabContent}

      <ViewportModal
        open={Boolean(inlineMutation)}
        onDismiss={() => undefined}
        dismissible={false}
        className="bg-black/75 px-4 py-6 backdrop-blur-sm"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Admin authority update in progress"
          aria-busy="true"
          className="w-full max-w-md rounded-2xl border border-blue-400/20 bg-theme-surface px-5 py-5 text-theme-text shadow-2xl shadow-black/50"
        >
          <div role="status" aria-live="polite" className="flex items-center gap-3">
            <Loader2 size={20} className="shrink-0 animate-spin text-blue-300" aria-hidden="true" />
            <span className="font-medium">
              {inlineMutation ? adminMutationWorkingLabel(inlineMutation.action) : 'Updating authority…'}
            </span>
          </div>
          <p className="mt-2 text-sm text-theme-text-muted">Keep this page open while Portal verifies the change.</p>
        </div>
      </ViewportModal>
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

type MaintenanceActionProgress = {
  action: MaintenanceAction;
  phase: 'submitting' | 'running' | 'completed' | 'failed';
  jobId: string | null;
  detail: string;
};

function MaintenanceTab({ owner }: { owner: boolean }) {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<MaintenanceAction | null>(null);
  const [actionProgress, setActionProgress] = useState<MaintenanceActionProgress | null>(null);
  const [actionDialogError, setActionDialogError] = useState<string | null>(null);
  const [maintenanceWindowAcknowledged, setMaintenanceWindowAcknowledged] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const requestSequenceRef = useRef(0);
  const previousActiveJobRef = useRef(false);
  const actionSubmissionRef = useRef(false);

  const loadMaintenance = useCallback(async (force = false, background = false) => {
    const requestSequence = ++requestSequenceRef.current;
    if (!background) setLoading(true);
    try {
      const [nextStatus, jobsResult] = await Promise.all([
        maintenanceAPI.getStatus(force),
        agentJobsAPI.list().catch(() => null),
      ]);
      if (requestSequence !== requestSequenceRef.current) return;
      setStatus(nextStatus);
      if (jobsResult) setJobs(jobsResult.filter((job) => job.toolId === 'system-maintenance').slice(0, 6));
      setLoadError(null);
    } catch (err: any) {
      if (requestSequence === requestSequenceRef.current) {
        setLoadError(err.response?.data?.error || err.message || 'Failed to load maintenance status');
      }
    } finally {
      if (!background && requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadMaintenance(); }, [loadMaintenance]);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const actionProgressActive = actionProgress?.phase === 'submitting' || actionProgress?.phase === 'running';
  const hasActiveMaintenanceJob = actionProgressActive
    || jobs.some((job) => isActiveMaintenanceJob(job.status));

  useEffect(() => {
    if (actionProgress?.phase !== 'running' || !actionProgress.jobId) return;
    const job = jobs.find((candidate) => candidate.id === actionProgress.jobId);
    if (!job || isActiveMaintenanceJob(job.status)) return;

    actionSubmissionRef.current = false;
    const completed = job.status === 'completed';
    setActionProgress((current) => current?.jobId === job.id ? {
      ...current,
      phase: completed ? 'completed' : 'failed',
      detail: completed
        ? `${current.action.label} completed. The server snapshot is being refreshed.`
        : `${current.action.label} ${job.status === 'killed' ? 'was cancelled' : 'failed'}. Review the retained job output before retrying.`,
    } : current);
  }, [actionProgress?.jobId, actionProgress?.phase, jobs]);

  useEffect(() => {
    if (!shouldPollMaintenance({
      pageVisible,
      ready: status?.ready,
      refreshing: status?.refreshing,
      retryAfterMs: status?.retryAfterMs,
      hasActiveJob: hasActiveMaintenanceJob,
    })) return;
    let cancelled = false;
    let timer: number | null = null;
    const delay = maintenancePollDelayMs({
      retryAfterMs: status?.retryAfterMs,
      hasActiveJob: hasActiveMaintenanceJob,
    });
    const schedule = () => {
      timer = window.setTimeout(() => {
        void loadMaintenance(false, true).finally(() => {
          if (!cancelled) schedule();
        });
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [hasActiveMaintenanceJob, loadMaintenance, pageVisible, status?.ready, status?.refreshing, status?.retryAfterMs]);

  useEffect(() => {
    const wasActive = previousActiveJobRef.current;
    previousActiveJobRef.current = hasActiveMaintenanceJob;
    if (wasActive && !hasActiveMaintenanceJob && pageVisible) {
      void loadMaintenance(true, true);
    }
  }, [hasActiveMaintenanceJob, loadMaintenance, pageVisible]);

  const requestAction = useCallback((action: MaintenanceAction) => {
    if (maintenanceActionNeedsOwner(action) && !owner) {
      setMessage('Owner access is required for maintenance actions that change the server. Read-only plans remain available.');
      return;
    }
    if (hasActiveMaintenanceJob) {
      setMessage('A maintenance job is already running. Wait for it to finish before starting another action.');
      return;
    }
    setActionProgress(null);
    setActionDialogError(null);
    setMaintenanceWindowAcknowledged(false);
    setPendingAction(action);
  }, [hasActiveMaintenanceJob, owner]);

  const runAction = useCallback(async (action: MaintenanceAction, confirmation: string) => {
    if (actionSubmissionRef.current) return;
    actionSubmissionRef.current = true;
    setRunningAction(action.id);
    setMessage(null);
    setActionDialogError(null);
    setActionProgress({
      action,
      phase: 'submitting',
      jobId: null,
      detail: 'Checking the maintenance window, backup, package-manager locks, and single-flight guard…',
    });
    try {
      const data = await maintenanceAPI.startAction(action.id, confirmation, maintenanceWindowAcknowledged);
      const jobId = data?.job?.id || null;
      if (!jobId) throw new Error('The server accepted the request without returning a background job ID. No retry was started automatically.');

      setJobs((current) => data.job
        ? [data.job, ...current.filter((job) => job.id !== data.job!.id)].slice(0, 6)
        : current);
      setPendingAction(null);
      setMaintenanceWindowAcknowledged(false);
      setActionProgress({
        action,
        phase: 'running',
        jobId,
        detail: `${action.label} is running as a protected background job. Additional server changes stay locked until it finishes.`,
      });
      void loadMaintenance(false, true);
    } catch (err: any) {
      const detail = err.response?.data?.error || err.message || `Failed to start ${action.label}`;
      actionSubmissionRef.current = false;
      setActionDialogError(detail);
      setActionProgress({ action, phase: 'failed', jobId: null, detail });
    } finally {
      setRunningAction(null);
    }
  }, [loadMaintenance, maintenanceWindowAcknowledged]);

  if (loading && !status) {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm text-slate-300">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        Server checks are running in the background. You can leave this page open; it will update automatically.
      </div>
    );
  }

  const issues = status?.issues || [];
  const actions = status?.actions || [];
  const maintenanceRetryDelay = maintenanceRetryDelayLabel(status?.retryAfterMs);

  return (
    <div className="space-y-4">
      <div className={`rounded-xl border px-4 py-3 text-xs leading-5 ${owner ? 'border-cyan-500/20 bg-cyan-500/5 text-cyan-100' : 'border-amber-500/20 bg-amber-500/5 text-amber-100'}`}>
        {owner
          ? 'Read-only plans and checklists do not change the server. Package refreshes, backups, and updates require an exact typed confirmation and run as background jobs.'
          : 'SUB_ADMIN can inspect status and generate read-only plans. Any action that writes to the server remains Owner-only.'}
      </div>
      {message && (
        <div role="status" aria-live="polite" className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-200">
          {message}
        </div>
      )}
      {actionProgress && !pendingAction && (
        <div
          role={actionProgress.phase === 'failed' ? 'alert' : 'status'}
          aria-live="polite"
          className={`rounded-xl border px-4 py-3 ${
            actionProgress.phase === 'failed'
              ? 'border-red-500/25 bg-red-500/10 text-red-100'
              : actionProgress.phase === 'completed'
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
                : 'border-blue-500/25 bg-blue-500/10 text-blue-100'
          }`}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              {actionProgress.phase === 'submitting' || actionProgress.phase === 'running' ? (
                <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
              ) : actionProgress.phase === 'completed' ? (
                <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              ) : (
                <XCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {actionProgress.phase === 'submitting'
                    ? `Starting ${actionProgress.action.label}…`
                    : actionProgress.phase === 'running'
                      ? `${actionProgress.action.label} is running`
                      : actionProgress.phase === 'completed'
                        ? `${actionProgress.action.label} completed`
                        : `${actionProgress.action.label} needs attention`}
                </p>
                <p className="mt-1 text-xs leading-5 opacity-80">{actionProgress.detail}</p>
                {actionProgress.jobId && (
                  <p className="mt-1 break-all font-mono text-[10px] opacity-60">Job {actionProgress.jobId}</p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {actionProgress.jobId && (
                <Link
                  to="/tasks"
                  className="inline-flex min-h-[40px] items-center rounded-lg border border-current/20 bg-black/10 px-3 py-2 text-xs font-medium transition hover:bg-black/20"
                >
                  View progress
                </Link>
              )}
              {actionProgress.phase === 'failed' && !pendingAction && (
                <button
                  type="button"
                  onClick={() => requestAction(actionProgress.action)}
                  className="inline-flex min-h-[40px] items-center rounded-lg border border-current/20 bg-black/10 px-3 py-2 text-xs font-medium transition hover:bg-black/20"
                >
                  Review & retry
                </button>
              )}
              {(actionProgress.phase === 'failed' || actionProgress.phase === 'completed') && (
                <button
                  type="button"
                  onClick={() => setActionProgress(null)}
                  className="inline-flex min-h-[40px] items-center rounded-lg border border-current/20 bg-black/10 px-3 py-2 text-xs font-medium transition hover:bg-black/20"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {(loadError || status?.refreshError) && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          Maintenance status could not refresh: {loadError || status?.refreshError}
          {status?.checkedAt ? ' The last successful snapshot remains visible.' : ''}
          {maintenanceRetryDelay
            ? ` Automatic retry is paused for ${maintenanceRetryDelay}; no additional host scan will run during that cooldown.`
            : status?.refreshing
              ? ' A bounded retry is running now.'
              : ' Use Recheck when the server is ready.'}
        </div>
      )}
      {status?.ready === false && !status.refreshError && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-sm text-cyan-100">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Server checks are running in the background. Read-only plans remain available while the first snapshot is prepared.
        </div>
      )}
      {status?.ready === false && status.refreshError && (
        <div role="status" aria-live="polite" className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-100">
          The initial server snapshot is unavailable.
          {maintenanceRetryDelay
            ? ` The next automatic attempt is scheduled in ${maintenanceRetryDelay}.`
            : status.refreshing
              ? ' A retry is currently running.'
              : ' Automatic checks are waiting for a safe retry window.'}
          {' '}Read-only maintenance plans remain available.
        </div>
      )}
      {hasActiveMaintenanceJob && (
        <div role="status" aria-live="polite" className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
          A maintenance job is running. Status and job history will refresh automatically; additional actions are paused until it finishes.
        </div>
      )}

      {status?.ready !== false && status?.host && (
        <div className={`rounded-xl border p-4 ${maintenanceTone(status.status)}`}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                {status.status === 'healthy' ? <ShieldCheck size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
                <h2 className="text-sm font-semibold text-white">
                  {status.status === 'healthy' ? 'Server maintenance is healthy' : 'Server maintenance needs attention'}
                </h2>
              </div>
              <p className="mt-1 text-sm text-slate-200">{status.summary}</p>
              <p className="mt-1 text-xs text-slate-400">
                {status.host.os} · kernel {status.host.kernel}
                {status.checkedAt ? ` · checked ${new Date(status.checkedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                {status.refreshing ? ' · refreshing in background' : status.cached ? ' · cached' : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { void loadMaintenance(true); }}
                disabled={loading}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
                Recheck
              </button>
              <Link
                to="/tasks"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10"
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
            {status?.ready === false ? (
              <p className="text-sm text-slate-400">Open items will appear when the first server snapshot is ready.</p>
            ) : issues.length === 0 ? (
              <p className="text-sm text-slate-400">No maintenance issues were detected in the latest snapshot.</p>
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
                        type="button"
                        onClick={() => requestAction(action)}
                        disabled={(maintenanceActionNeedsOwner(action) && !owner) || hasActiveMaintenanceJob || runningAction === action.id}
                        title={maintenanceActionNeedsOwner(action) && !owner ? 'Owner-only server mutation' : hasActiveMaintenanceJob ? 'Wait for the running maintenance job to finish' : action.description}
                        className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
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
                  type="button"
                  onClick={() => requestAction(action)}
                  disabled={(maintenanceActionNeedsOwner(action) && !owner) || hasActiveMaintenanceJob || runningAction === action.id}
                  title={maintenanceActionNeedsOwner(action) && !owner ? 'Owner-only server mutation' : hasActiveMaintenanceJob ? 'Wait for the running maintenance job to finish' : action.description}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
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

      <TypedConfirmationDialog
        open={!!pendingAction}
        title={pendingAction?.label || 'Maintenance action'}
        description={pendingAction?.description || ''}
        confirmationPhrase={pendingAction?.confirmationPhrase}
        confirmLabel={pendingAction?.changesSystem ? 'Start server change' : 'Generate read-only report'}
        busyLabel={pendingAction?.changesSystem ? 'Starting server change…' : 'Starting report…'}
        busy={!!pendingAction && runningAction === pendingAction.id}
        tone={pendingAction?.destructive ? 'danger' : 'warning'}
        onCancel={() => {
          setPendingAction(null);
          setActionDialogError(null);
          setMaintenanceWindowAcknowledged(false);
        }}
        onConfirm={(confirmation) => {
          if (!pendingAction) return;
          if (pendingAction.requiresMaintenanceWindow && !maintenanceWindowAcknowledged) {
            setActionDialogError('Confirm that an approved maintenance window is active before starting this action.');
            return;
          }
          void runAction(pendingAction, confirmation);
        }}
        details={pendingAction ? (
          <div className="space-y-3">
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
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-slate-200">{pendingAction.changesSystem ? 'Changes server' : 'Read-only'}</span>
              {pendingAction.requiresBackup && <span className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-amber-100">Backup first</span>}
              {pendingAction.requiresMaintenanceWindow && <span className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-amber-100">Maintenance window</span>}
              {pendingAction.downtimeExpected && <span className="rounded-lg border border-red-400/20 bg-red-500/10 px-2.5 py-1 text-red-100">Downtime expected</span>}
            </div>
            {pendingAction.requiresMaintenanceWindow && (
              <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-100">
                <input
                  type="checkbox"
                  checked={maintenanceWindowAcknowledged}
                  onChange={(event) => setMaintenanceWindowAcknowledged(event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-white/20 bg-black/30"
                />
                <span>I confirm an approved maintenance window is active and affected users have been notified.</span>
              </label>
            )}
            {runningAction === pendingAction.id && (
              <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-xl border border-blue-400/25 bg-blue-500/10 px-3 py-2 text-xs leading-5 text-blue-100">
                <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
                <span>Validating safeguards and creating one protected background job. The button is locked while this request is submitted.</span>
              </div>
            )}
            {actionDialogError && (
              <div role="alert" className="rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100">
                {actionDialogError}
              </div>
            )}
          </div>
        ) : null}
      />
    </div>
  );
}

type PendingUserAction = {
  kind: 'promote' | 'transfer';
  user: AdminUser;
  confirmationPhrase: string;
  title: string;
  description: string;
};

function UsersTab({
  currentUserId,
  isOwner: ownerAccess,
  mutationAdmission,
}: {
  currentUserId: string;
  isOwner: boolean;
  mutationAdmission: AdminMutationAdmission;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authorizationSafety, setAuthorizationSafety] = useState<AdminAuthorizationSafety | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [pendingUserAction, setPendingUserAction] = useState<PendingUserAction | null>(null);
  const [userActionDialogError, setUserActionDialogError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const actionBusy = Boolean(mutationAdmission.active);
  const authorizationChangesAllowed =
    authorizationSafety?.authorizationScopeChanges === true;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadUsers = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    try {
      const res = await adminAPI.listUsers({ page, search: debouncedSearch || undefined });
      if (sequence !== loadSequenceRef.current) return;
      setUsers(res.users);
      setTotal(res.total);
      setPages(res.pages);
      setAuthorizationSafety(res.authorizationSafety);
      setLoadError(null);
    } catch (err: any) {
      if (sequence === loadSequenceRef.current) {
        setLoadError(err.response?.data?.error || err.message || 'Failed to load users');
      }
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [debouncedSearch, page]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const requestUserAction = useCallback((action: PendingUserAction) => {
    if (!authorizationChangesAllowed || mutationAdmission.isRunning()) return;
    setFeedback(null);
    setUserActionDialogError(null);
    setPendingUserAction(action);
  }, [authorizationChangesAllowed, mutationAdmission]);

  const handleRoleChange = async (user: AdminUser, role: AdminUser['role']) => {
    if (!ownerAccess || !authorizationChangesAllowed) return;
    if (role === 'SUB_ADMIN' && user.role !== 'SUB_ADMIN') {
      requestUserAction({
        kind: 'promote',
        user,
        confirmationPhrase: 'GRANT SERVER ACCESS',
        title: `Promote ${user.username || user.email} to SUB_ADMIN?`,
        description: 'SUB_ADMIN is a root-equivalent operator role. This user will be able to use Agent Chat and Terminal to read, write, and execute anywhere on the server. Project Chat remains separately isolated.',
      });
      return;
    }
    const lease = mutationAdmission.begin({ kind: 'role', targetId: user.id, targetValue: role });
    if (!lease) return;
    setFeedback(null);
    try {
      await adminAPI.updateUser(lease.action.targetId, { role: lease.action.targetValue as AdminUser['role'] });
      setUsers(prev => prev.map(u => u.id === lease.action.targetId ? { ...u, role: lease.action.targetValue as AdminUser['role'] } : u));
      setFeedback({ type: 'success', message: `${user.username || user.email} is now ${lease.action.targetValue}.` });
    } catch (err: any) {
      setFeedback({ type: 'error', message: boundedAdminError(err, 'Failed to update role') });
    } finally {
      mutationAdmission.finish(lease);
    }
  };

  const handleStatusChange = async (userId: string, accountStatus: AdminUser['accountStatus']) => {
    if (!ownerAccess || !authorizationChangesAllowed) return;
    const lease = mutationAdmission.begin({ kind: 'status', targetId: userId, targetValue: accountStatus });
    if (!lease) return;
    setFeedback(null);
    try {
      const nextStatus = lease.action.targetValue as AdminUser['accountStatus'];
      await adminAPI.updateUser(lease.action.targetId, { accountStatus: nextStatus });
      setUsers(prev => prev.map(u => u.id === lease.action.targetId ? { ...u, accountStatus: nextStatus, isActive: nextStatus === 'ACTIVE' } : u));
      setFeedback({ type: 'success', message: `Account status changed to ${nextStatus}.` });
    } catch (err: any) {
      setFeedback({ type: 'error', message: boundedAdminError(err, 'Failed to update account status') });
    } finally {
      mutationAdmission.finish(lease);
    }
  };

  const handleSandboxToggle = async (userId: string, sandboxEnabled: boolean) => {
    if (!ownerAccess || !authorizationChangesAllowed) return;
    const lease = mutationAdmission.begin({ kind: 'workspace', targetId: userId, targetValue: String(sandboxEnabled) });
    if (!lease) return;
    setFeedback(null);
    try {
      const nextSandboxEnabled = lease.action.targetValue === 'true';
      await adminAPI.updateUser(lease.action.targetId, { sandboxEnabled: nextSandboxEnabled });
      setUsers(prev => prev.map(u => u.id === lease.action.targetId ? { ...u, sandboxEnabled: nextSandboxEnabled } : u));
      setFeedback({ type: 'success', message: `Project workspace changed to ${nextSandboxEnabled ? 'private' : 'Owner-shared'}.` });
    } catch (err: any) {
      setFeedback({ type: 'error', message: boundedAdminError(err, 'Failed to update project workspace') });
    } finally {
      mutationAdmission.finish(lease);
    }
  };

  const confirmUserAction = async (confirmation: string) => {
    const action = pendingUserAction;
    if (!action || !ownerAccess || !authorizationChangesAllowed) return;
    const lease = mutationAdmission.begin({
      kind: action.kind,
      targetId: action.user.id,
      targetValue: confirmation,
    });
    if (!lease) return;
    setFeedback(null);
    setUserActionDialogError(null);
    try {
      if (lease.action.kind === 'promote') {
        await adminAPI.updateUser(lease.action.targetId, {
          role: 'SUB_ADMIN',
          confirmation: lease.action.targetValue,
        });
        setUsers(prev => prev.map(user => user.id === lease.action.targetId ? { ...user, role: 'SUB_ADMIN' } : user));
        setPendingUserAction(null);
        setFeedback({ type: 'success', message: `${action.user.username || action.user.email} now has SUB_ADMIN host-operator access.` });
        return;
      }
      await adminAPI.transferOwnership(lease.action.targetId, lease.action.targetValue || '');
      mutationAdmission.finish(lease);
      window.location.reload();
    } catch (err: any) {
      sounds.error();
      const fallback = action.kind === 'transfer'
        ? 'Failed to transfer ownership'
        : 'Failed to update user authority';
      setUserActionDialogError(boundedAdminError(err, fallback));
    } finally {
      mutationAdmission.finish(lease);
    }
  };

  const cancelPendingUserAction = () => {
    if (mutationAdmission.isRunning()) return;
    setUserActionDialogError(null);
    setPendingUserAction(null);
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
          Read-only user directory. Your SUB_ADMIN role still has intentional full-server Agent Chat and Terminal access; only the Owner can change accounts or delegate that authority.
        </div>
      )}

      {ownerAccess && authorizationSafety && !authorizationChangesAllowed && (
        <div
          id="admin-authorization-transition-note"
          role="note"
          aria-label="Authorization changes unavailable"
          className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-100"
        >
          <span className="font-semibold">Authorization changes are temporarily unavailable.</span>{' '}
          {authorizationSafety.message} Fixed-generation Project Chat remains available.
        </div>
      )}

      {ownerAccess && (
        <div
          id="admin-user-deletion-retirement-note"
          role="note"
          aria-label="User deletion unavailable"
          className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-100"
        >
          <span className="font-semibold">User deletion is temporarily unavailable.</span>{' '}
          Portal 4 identity-aware project and OpenClaw cleanup is retirement-pending. No deletion request is sent.
        </div>
      )}

      {feedback && (
        <div role={feedback.type === 'error' ? 'alert' : 'status'} aria-live={feedback.type === 'error' ? 'assertive' : 'polite'} className={`rounded-lg border px-3 py-2 text-sm ${feedback.type === 'error' ? 'border-red-500/20 bg-red-500/10 text-red-100' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'}`}>
          {feedback.message}
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-100 sm:flex-row sm:items-center sm:justify-between">
          <span>{loadError}</span>
          <button type="button" onClick={() => { void loadUsers(); }} className="min-h-[44px] rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-medium hover:bg-red-500/20">Retry</button>
        </div>
      )}

      <div className="relative max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search users..."
          aria-label="Search portal users"
          className="w-full pl-9 pr-4 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-sm text-white placeholder-slate-500 outline-none focus:border-emerald-500/40"
        />
      </div>

      <p className="text-xs text-slate-500 md:hidden">Swipe the directory horizontally to review authority and account controls.</p>

      <div className="rounded-xl border border-white/5 overflow-hidden bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <caption className="sr-only">Portal users, roles, account status, project workspace, and available actions</caption>
            <thead>
              <tr className="border-b border-white/5 text-slate-400 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">User</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Account</th>
                <th className="text-center px-4 py-3">Project workspace</th>
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
                        onChange={(e) => { void handleRoleChange(u, e.target.value as AdminUser['role']); }}
                        disabled={actionBusy || !authorizationChangesAllowed}
                        aria-describedby={!authorizationChangesAllowed ? 'admin-authorization-transition-note' : undefined}
                        aria-busy={mutationAdmission.matches('role', u.id)}
                        aria-label={`Role for ${u.email}`}
                        className="min-h-[40px] bg-white/[0.04] border border-white/10 text-white text-xs rounded-md px-2 py-1 outline-none focus:border-emerald-500/40 disabled:opacity-50"
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
                        disabled={actionBusy || !authorizationChangesAllowed}
                        aria-describedby={!authorizationChangesAllowed ? 'admin-authorization-transition-note' : undefined}
                        aria-busy={mutationAdmission.matches('status', u.id)}
                        aria-label={`Account status for ${u.email}`}
                        className="min-h-[40px] bg-white/[0.04] border border-white/10 text-white text-xs rounded-md px-2 py-1 outline-none focus:border-emerald-500/40 disabled:opacity-50"
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="PENDING">PENDING</option>
                        <option value="DISABLED">DISABLED</option>
                        <option value="BANNED">BANNED</option>
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {u.role === 'SUB_ADMIN' ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={u.sandboxEnabled}
                        onClick={() => handleSandboxToggle(u.id, !u.sandboxEnabled)}
                        disabled={!ownerAccess || actionBusy || !authorizationChangesAllowed}
                        aria-describedby={!authorizationChangesAllowed ? 'admin-authorization-transition-note' : undefined}
                        aria-busy={mutationAdmission.matches('workspace', u.id)}
                        aria-label={`${u.sandboxEnabled ? 'Use owner-shared' : 'Use private'} project workspace for ${u.email}`}
                        title={u.sandboxEnabled ? 'Private project workspace. Agent Chat and Terminal remain host-wide.' : 'Owner-shared project workspace. Agent Chat and Terminal remain host-wide.'}
                        className={`relative inline-flex min-h-[44px] min-w-[48px] items-center rounded-full transition-colors
                          ${u.sandboxEnabled ? 'bg-emerald-500' : 'bg-purple-500'} ${!ownerAccess || !authorizationChangesAllowed ? 'cursor-not-allowed opacity-50' : ''}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${u.sandboxEnabled ? 'translate-x-7' : 'translate-x-1'}`} />
                      </button>
                    ) : (
                      <span className="whitespace-nowrap text-[11px] text-slate-400">
                        {u.role === 'OWNER' ? 'Owner workspace' : 'Private · enforced'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs hidden md:table-cell">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {ownerAccess && u.id !== currentUserId && u.role !== 'OWNER' && (
                      <div className="flex items-center justify-end gap-1">
                        {u.accountStatus === 'ACTIVE' && (
                          <button
                            type="button"
                            disabled={actionBusy || !authorizationChangesAllowed}
                            aria-describedby={!authorizationChangesAllowed ? 'admin-authorization-transition-note' : undefined}
                            onClick={() => requestUserAction({
                              kind: 'transfer',
                              user: u,
                              confirmationPhrase: `TRANSFER TO ${u.email.trim().toLowerCase()}`,
                              title: `Transfer ownership to ${u.username || u.email}?`,
                              description: 'This user becomes the sole Owner immediately. Your account becomes SUB_ADMIN, retaining host-operator Agent Chat and Terminal access but losing owner-only user and maintenance controls.',
                            })}
                            className="min-h-[44px] rounded-lg bg-fuchsia-500/10 px-2.5 py-1 text-[11px] text-fuchsia-300 transition hover:bg-fuchsia-500/20 disabled:opacity-50"
                            title="Transfer Portal ownership"
                          >
                            Transfer
                          </button>
                        )}
                        <button
                          type="button"
                          disabled
                          aria-describedby="admin-user-deletion-retirement-note"
                          className="min-h-[44px] min-w-[44px] cursor-not-allowed rounded-lg p-2 text-slate-600 opacity-60"
                          aria-label={`Delete ${u.email} unavailable`}
                          title="User deletion unavailable while identity-aware cleanup is retirement-pending"
                        >
                          <Trash2 size={15} className="mx-auto" />
                        </button>
                      </div>
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
            <button type="button" aria-label="Previous user page" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="min-h-[44px] min-w-[44px] p-1.5 rounded hover:bg-white/5 disabled:opacity-30"><ChevronLeft size={16} className="mx-auto" /></button>
            <span>Page {page} of {pages}</span>
            <button type="button" aria-label="Next user page" onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages} className="min-h-[44px] min-w-[44px] p-1.5 rounded hover:bg-white/5 disabled:opacity-30"><ChevronRight size={16} className="mx-auto" /></button>
          </div>
        </div>
      )}

      <TypedConfirmationDialog
        open={!!pendingUserAction}
        title={pendingUserAction?.title || 'Confirm user change'}
        description={pendingUserAction?.description || ''}
        confirmationPhrase={pendingUserAction?.confirmationPhrase}
        confirmLabel={pendingUserAction?.kind === 'transfer' ? 'Transfer ownership' : 'Grant server access'}
        tone={pendingUserAction?.kind === 'transfer' ? 'danger' : 'warning'}
        busy={actionBusy}
        busyLabel={pendingUserAction ? adminMutationWorkingLabel({ kind: pendingUserAction.kind, targetId: pendingUserAction.user.id }) : undefined}
        onCancel={cancelPendingUserAction}
        onConfirm={(confirmation) => { void confirmUserAction(confirmation); }}
        details={userActionDialogError ? (
          <div role="alert" className="rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {userActionDialogError}
          </div>
        ) : null}
      />
    </div>
  );
}

function PendingTab({ mutationAdmission }: { mutationAdmission: AdminMutationAdmission }) {
  const [requests, setRequests] = useState<RegistrationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<RegistrationFeedback | null>(null);
  const [approvalRefreshRequired, setApprovalRefreshRequired] = useState<{
    id: string;
    applicantEmail: string;
  } | null>(null);
  const [approvalRefreshInProgress, setApprovalRefreshInProgress] = useState(false);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const actionBusy = Boolean(mutationAdmission.active) || Boolean(approvalRefreshRequired);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAPI.listRegistrationRequests({ status: 'PENDING' });
      setRequests(res.requests);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err.response?.data?.error || err.message || 'Failed to load registration requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const reconcileAmbiguousApproval = async (
    id: string,
    applicantEmail: string,
  ): Promise<void> => {
    try {
      const pageLimit = 100;
      const maximumPages = 20;
      let expectedPages: number | null = null;
      let expectedTotal: number | null = null;
      let exactStatus: RegistrationRequest['status'] | null = null;

      for (let page = 1; page === 1 || (expectedPages !== null && page <= expectedPages); page += 1) {
        const refreshed = await adminAPI.listRegistrationRequests({ page, limit: pageLimit });
        if (
          !refreshed
          || !Array.isArray(refreshed.requests)
          || !Number.isInteger(refreshed.total)
          || refreshed.total < 0
          || !Number.isInteger(refreshed.page)
          || refreshed.page !== page
          || !Number.isInteger(refreshed.pages)
          || refreshed.pages < 0
          || refreshed.pages > maximumPages
          || refreshed.total > maximumPages * pageLimit
          || refreshed.requests.length > pageLimit
          || refreshed.requests.some(request => (
            !request
            || typeof request.id !== 'string'
            || !['PENDING', 'APPROVED', 'DENIED'].includes(request.status)
          ))
        ) {
          throw new Error('Registration request refresh was incomplete');
        }
        const expectedPageSize = refreshed.pages === 0
          ? 0
          : page < refreshed.pages
            ? pageLimit
            : refreshed.total - ((page - 1) * pageLimit);
        if (
          refreshed.pages !== Math.ceil(refreshed.total / pageLimit)
          || refreshed.requests.length !== expectedPageSize
        ) {
          throw new Error('Registration request refresh was incomplete');
        }
        if (expectedPages === null) {
          expectedPages = refreshed.pages;
          expectedTotal = refreshed.total;
        } else if (refreshed.pages !== expectedPages || refreshed.total !== expectedTotal) {
          throw new Error('Registration requests changed during refresh');
        }

        const exactMatches = refreshed.requests.filter(request => request.id === id);
        if (exactMatches.length > 1) {
          throw new Error('Registration request refresh returned duplicate identities');
        }
        if (exactMatches.length === 1) {
          exactStatus = exactMatches[0].status;
          break;
        }
        if (page >= refreshed.pages) break;
      }

      if (!exactStatus) {
        throw new Error('Registration request was not found during refresh');
      }
      setApprovalRefreshRequired(null);
      if (exactStatus === 'PENDING') {
        sounds.error();
        setFeedback({
          type: 'error',
          message: `Portal confirmed that ${applicantEmail} is still pending. The approval did not complete, so retrying is safe.`,
        });
        return;
      }
      setRequests(previous => previous.filter(request => request.id !== id));
      if (exactStatus === 'DENIED') {
        sounds.error();
        setFeedback({
          type: 'warning',
          message: `The registration request for ${applicantEmail} was denied in another session. Approval did not complete; do not retry this approval.`,
        });
        return;
      }

      sounds.success();
      setFeedback(unconfirmedApprovalFeedback(applicantEmail));
    } catch {
      setApprovalRefreshRequired({ id, applicantEmail });
      setFeedback({
        type: 'warning',
        message: `Portal could not confirm whether the approval for ${applicantEmail} completed. Refresh pending requests before trying any registration action. Do not approve this request again until the refresh succeeds.`,
      });
    }
  };

  const refreshAmbiguousApproval = async () => {
    const unresolved = approvalRefreshRequired;
    if (!unresolved || approvalRefreshInProgress) return;
    setApprovalRefreshInProgress(true);
    try {
      await reconcileAmbiguousApproval(unresolved.id, unresolved.applicantEmail);
    } finally {
      setApprovalRefreshInProgress(false);
    }
  };

  const handleApprove = async (request: RegistrationRequest) => {
    const lease = mutationAdmission.begin({ kind: 'approve-registration', targetId: request.id });
    if (!lease) return;
    const applicantEmail = request.email.trim() || 'the applicant';
    setFeedback(null);
    try {
      const response = await adminAPI.approveRequest(lease.action.targetId);
      if (response?.success !== true) {
        await reconcileAmbiguousApproval(lease.action.targetId, applicantEmail);
        return;
      }
      sounds.success();
      setRequests(prev => prev.filter(r => r.id !== lease.action.targetId));
      setFeedback(approvalNotificationFeedback(response, applicantEmail));
    } catch (err: any) {
      if (isAmbiguousApprovalError(err)) {
        await reconcileAmbiguousApproval(lease.action.targetId, applicantEmail);
        return;
      }
      sounds.error();
      setFeedback({ type: 'error', message: boundedAdminError(err, 'Failed to approve registration') });
    } finally {
      mutationAdmission.finish(lease);
    }
  };

  const handleDeny = async (id: string) => {
    const reason = denyReason.trim() || undefined;
    const lease = mutationAdmission.begin({ kind: 'deny-registration', targetId: id, targetValue: reason });
    if (!lease) return;
    setFeedback(null);
    try {
      await adminAPI.denyRequest(lease.action.targetId, lease.action.targetValue || undefined);
      sounds.delete();
      setRequests(prev => prev.filter(r => r.id !== lease.action.targetId));
      setDenyingId(null);
      setDenyReason('');
      setFeedback({ type: 'success', message: 'Registration denied.' });
    } catch (err: any) {
      sounds.error();
      setFeedback({ type: 'error', message: boundedAdminError(err, 'Failed to deny registration') });
    } finally {
      mutationAdmission.finish(lease);
    }
  };

  const requestDenial = (id: string) => {
    if (mutationAdmission.isRunning()) return;
    setFeedback(null);
    setDenyReason('');
    setDenyingId(id);
  };

  const cancelDenial = () => {
    if (mutationAdmission.isRunning()) return;
    setDenyingId(null);
    setDenyReason('');
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-slate-500">
        <Loader2 size={20} className="animate-spin inline mr-2" aria-hidden="true" /> Loading requests…
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100 sm:flex-row sm:items-center sm:justify-between">
        <span>{loadError}</span>
        <button type="button" onClick={() => { void loadRequests(); }} className="min-h-[44px] rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-medium hover:bg-red-500/20">Retry</button>
      </div>
    );
  }

  const feedbackBanner = feedback ? (
    <div
      role={feedback.type === 'error' ? 'alert' : 'status'}
      aria-live={feedback.type === 'error' ? 'assertive' : 'polite'}
      className={`rounded-lg border px-3 py-2 text-sm ${
        feedback.type === 'error'
          ? 'border-red-500/20 bg-red-500/10 text-red-100'
          : feedback.type === 'warning'
            ? 'border-amber-400/25 bg-amber-500/10 text-amber-100'
            : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
      }`}
    >
      {feedback.message}
      {approvalRefreshRequired && (
        <button
          type="button"
          onClick={() => { void refreshAmbiguousApproval(); }}
          disabled={approvalRefreshInProgress}
          className="mt-2 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-amber-300/25 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-50 transition hover:bg-amber-500/20 disabled:opacity-50"
        >
          {approvalRefreshInProgress && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {approvalRefreshInProgress ? 'Refreshing requests…' : 'Refresh pending requests'}
        </button>
      )}
    </div>
  ) : null;

  if (requests.length === 0) {
    return (
      <div className="space-y-3">
        {feedbackBanner}
        <div className="text-center py-12">
          <Clock size={40} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-400">No pending registration requests</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {feedbackBanner}
      <p className="text-xs text-slate-500 sm:hidden">Swipe horizontally to review the request message and actions.</p>
      <div className="overflow-x-auto rounded-xl border border-white/5 bg-white/[0.02]">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Pending Portal registration requests and approval actions</caption>
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
                      <input type="text" value={denyReason} onChange={(e) => setDenyReason(e.target.value)} disabled={actionBusy} placeholder="Reason (optional)" aria-label={`Reason for denying ${r.email}`} className="bg-white/[0.04] border border-white/10 text-white text-xs rounded px-2 py-1 w-32 outline-none disabled:opacity-50" />
                      <button type="button" aria-label={mutationAdmission.matches('deny-registration', r.id) ? `Denying registration for ${r.email}` : `Confirm denial for ${r.email}`} aria-busy={mutationAdmission.matches('deny-registration', r.id)} onClick={() => { void handleDeny(r.id); }} disabled={actionBusy} className="inline-flex min-h-[44px] items-center gap-1 rounded bg-red-500/10 px-2 py-1 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50" title="Confirm deny">
                        {mutationAdmission.matches('deny-registration', r.id) ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                        {mutationAdmission.matches('deny-registration', r.id) ? 'Denying…' : 'Confirm deny'}
                      </button>
                      <button type="button" aria-label="Cancel denial" onClick={cancelDenial} disabled={actionBusy} className="min-h-[44px] min-w-[44px] p-1 rounded hover:bg-white/10 text-slate-400 disabled:opacity-50"><X size={14} className="mx-auto" /></button>
                    </div>
                  ) : (
                    <>
                      <button type="button" aria-busy={mutationAdmission.matches('approve-registration', r.id)} onClick={() => { void handleApprove(r); }} disabled={actionBusy} className="flex min-h-[44px] items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs font-medium border border-emerald-500/20 transition-colors disabled:opacity-50">
                        {mutationAdmission.matches('approve-registration', r.id) ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                        {mutationAdmission.matches('approve-registration', r.id) ? 'Approving…' : 'Approve'}
                      </button>
                      <button type="button" onClick={() => requestDenial(r.id)} disabled={actionBusy} className="flex min-h-[44px] items-center gap-1 px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs font-medium border border-red-500/20 transition-colors disabled:opacity-50"><X size={13} aria-hidden="true" /> Deny</button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
