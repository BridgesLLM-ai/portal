import {
  Component,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  lazy,
  Suspense,
  useContext,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { UNSAFE_NavigationContext, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import {
  projectsAPI,
  aiAPI,
  projectRuntimeRecoveryCompletion,
  type ProjectIdentityProof,
  type ProjectDeploymentProcessState,
  type ProjectLifecycleAction,
  type ProjectRuntimeManagement,
  type ProjectRuntimeRecoveryReplayProof,
  type ProjectRuntimeStatusSource,
  type ProjectShareLink,
  type ProjectSummary,
  type ProjectTreeEntry,
  type ShareRateLimitWindowSeconds,
} from '../api/endpoints';
import { extractError, logError } from '../utils/errorHelpers';
import {
  bindWorkspaceAuthorizationToXhr,
  workspaceAuthorizedFetch,
} from '../utils/workspaceAuthorizedFetch';
import { useAuthStore } from '../contexts/AuthContext';
import { isOwner } from '../utils/authz';
import { useTheme } from '../contexts/ThemeContext';
import {
  claimRouteOperation,
  isRouteOperationOwner,
  releaseRouteOperation,
} from '../contexts/RouteOperationContext';
import ConfirmDialog from '../components/ConfirmDialog';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';
import { projectRuntimeImageRepairAPI } from '../api/projectRuntimeImageRepair';
import ViewportOverlay from '../components/ViewportOverlay';
import ViewportModal from '../components/ViewportModal';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileOverflowMenu from '../components/mobile/MobileOverflowMenu';
import sounds from '../utils/sounds';
import { deleteProjectAwaitingSettle as awaitProjectDeleteSettle } from '../utils/projectDeleteSettle';
import { ProgressNotification, ProgressNotificationProps } from '../components/shared/ProgressNotification';
import type { ProjectChatActivity } from '../components/chat/ProjectChatPanel';
import {
  PROJECT_ZIP_MAX_BYTES,
  REMOTE_DESKTOP_RUNTIME_WARNING,
  ProjectFileWriteQueue,
  canLaunchProjectRuntimeDemo,
  hasProjectDeepLinkParams,
  isSameProjectDocument,
  isValidProjectRelativePath,
  parseProjectDeepLink,
  type ProjectFileWrite,
} from '../utils/projectSurface';
import {
  Rocket, Play, Plus, Trash2, X, Loader2, FolderOpen, FileText, FileCode,
  GitBranch, GitCommit, Upload, ChevronRight, ChevronDown,
  Save, Eye, RefreshCw, Bot, Globe, Copy, Check,
  FolderPlus, FilePlus, ExternalLink, Share2,
  Undo2, ArrowUp, ArrowDown, Circle, Download,
  Diff, History, Maximize2, Minimize2, Search,
  Activity, FileQuestion, Zap, AlertCircle, CheckCircle,
  PanelLeftClose, PanelLeft, Command, Lock, Edit3,
  Image, Film, Music, Volume2, ZoomIn, ZoomOut, Mail, SendHorizonal, Users, Gauge
} from 'lucide-react';
const LazyMonacoEditor = lazy(() => import('../components/projects/LazyMonacoEditor'));
const LazyProjectPdfViewer = lazy(() => import('../components/projects/ProjectPdfViewer'));
const LazyProjectExcelViewer = lazy(() => import('../components/projects/ProjectExcelViewer'));
const LazyProjectTextPreviewViewer = lazy(() => import('../components/projects/ProjectTextPreviewViewer'));
const LazyProjectBinaryViewer = lazy(() => import('../components/projects/ProjectBinaryViewer'));
const LazyMarkdownPreviewFrame = lazy(() => import('../components/projects/MarkdownPreviewFrame'));
const LazyProjectChatPanel = lazy(() => import('../components/chat/ProjectChatPanel'));

class ProjectChatChunkBoundary extends Component<{
  resetKey: string;
  onClose: () => void;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(error, `Loading Project Chat (${info.componentStack ? 'component' : 'chunk'})`);
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex w-[340px] max-w-full flex-col justify-center gap-3 border-l border-white/5 bg-[#080B20]/95 p-5 text-sm">
        <div>
          <p className="font-medium text-red-200">Project Chat didn’t load</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">The chat code could not be opened. Your project and files are unchanged.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-purple-500/20 px-3 py-2 text-xs text-purple-200 hover:bg-purple-500/30">Reload Projects</button>
          <button type="button" onClick={this.props.onClose} className="rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-300 hover:bg-white/10">Close</button>
        </div>
      </div>
    );
  }
}

// --- Types ---
type TreeEntry = ProjectTreeEntry;
type Project = ProjectSummary;
interface GitFile { path: string; status: string; raw: string; }
interface CommitEntry { hash: string; short: string; author: string; email: string; date: string; message: string; }
interface Branch { name: string; current: boolean; remote: boolean; }
interface EnhancedCommit {
  hash: string; short: string; author: string; email: string; date: string; relativeDate: string;
  message: string; refs: string; parentHash?: string;
  stats: { filesChanged: number; insertions: number; deletions: number; files: Array<{ path: string; additions: number; deletions: number }> };
}
type ShareLink = ProjectShareLink;
interface ActivityEntry { id: string; action: string; resource: string; resourceId?: string; severity: string; createdAt: string; }

type RuntimeImageRepairRetryAction = 'deploy' | 'start' | 'restart';
type RuntimeImageRepairReplayOutcome = 'completed' | 'stale' | 'indeterminate' | 'failed';

type RuntimeImageRepairRetryOwner = Readonly<{
  projectName: string;
  projectGeneration: number;
  retryAction: RuntimeImageRepairRetryAction;
  recoveryReplay: ProjectRuntimeRecoveryReplayProof;
}>;

interface DeploymentControlFailure {
  message: string;
  detail?: string;
  limitation?: string;
  code?: string;
  recoveryAction?: 'REPAIR_PROJECT_RUNTIME_IMAGE' | 'UNDEPLOY_CURRENT_DEPLOYMENT';
  recoveryReplay?: ProjectRuntimeRecoveryReplayProof;
  retryAction?: RuntimeImageRepairRetryAction;
  retryOwner?: Omit<RuntimeImageRepairRetryOwner, 'retryAction'>;
}

function boundedDeploymentText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function projectRuntimeRecoveryReplayProof(value: unknown): ProjectRuntimeRecoveryReplayProof | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => ![
      'proof',
      'action',
      'projectIdentity',
      'expectedAppId',
      'expectedDeployType',
      'sourceDigest',
    ].includes(key))
    || typeof record.proof !== 'string'
    || !/^v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(record.proof)
    || !['deploy', 'start', 'restart'].includes(String(record.action))
    || !record.projectIdentity
    || typeof record.projectIdentity !== 'object'
    || Array.isArray(record.projectIdentity)
  ) return undefined;
  const identity = record.projectIdentity as Record<string, unknown>;
  if (
    Object.keys(identity).some((key) => key !== 'id' && key !== 'generation')
    || typeof identity.id !== 'string'
    || !identity.id
    || identity.id.length > 128
    || identity.id.trim() !== identity.id
    || !Number.isSafeInteger(identity.generation)
    || (identity.generation as number) < 1
    || (record.expectedAppId !== null && (
      typeof record.expectedAppId !== 'string'
      || !record.expectedAppId
      || record.expectedAppId.length > 128
      || record.expectedAppId.trim() !== record.expectedAppId
    ))
  ) return undefined;
  const action = record.action as ProjectRuntimeRecoveryReplayProof['action'];
  if (
    action === 'deploy'
      ? record.expectedDeployType !== 'fullstack'
        || typeof record.sourceDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.sourceDigest)
      : record.expectedDeployType !== undefined
        || record.sourceDigest !== undefined
        || record.expectedAppId === null
  ) return undefined;
  return Object.freeze({
    proof: record.proof,
    action,
    projectIdentity: Object.freeze({
      id: identity.id,
      generation: identity.generation as number,
    }),
    expectedAppId: record.expectedAppId as string | null,
    ...(action === 'deploy' ? {
      expectedDeployType: 'fullstack' as const,
      sourceDigest: record.sourceDigest as string,
    } : {}),
  });
}

function projectRuntimeRecoveryTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (record.code === 'ERR_CANCELED' || record.name === 'CanceledError') return false;
  return record.response === undefined && (
    record.isAxiosError === true
    || record.request !== undefined
    || ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(String(record.code || ''))
  );
}

function projectRuntimeRecoveryReplayFailureOutcome(
  failure: Pick<DeploymentControlFailure, 'code'>,
): Exclude<RuntimeImageRepairReplayOutcome, 'completed'> {
  if (
    failure.code === 'PROJECT_RUNTIME_RECOVERY_IN_PROGRESS'
    || failure.code === 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE'
  ) return 'indeterminate';
  if (
    failure.code === 'PROJECT_RUNTIME_RECOVERY_STALE'
    || failure.code === 'PROJECT_RUNTIME_RECOVERY_REPLAY_STALE'
    || failure.code === 'PROJECT_RUNTIME_RECOVERY_PROOF_EXPIRED'
    || failure.code === 'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH'
  ) return 'stale';
  return 'failed';
}

async function executeProjectRuntimeRecoveryReplay<T>(
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (firstError) {
    if (!projectRuntimeRecoveryTransportFailure(firstError)) throw firstError;
  }

  try {
    // The durable server receipt makes one bounded application retry safe: it
    // claims the action once, returns its stored completion, or reports that
    // the first execution is still reconciling.
    return await request();
  } catch (secondError) {
    if (!projectRuntimeRecoveryTransportFailure(secondError)) throw secondError;
    throw Object.assign(new Error(
      'Portal did not confirm the recovered Project action. It may still be reconciling; refresh Deployment status before taking another action.',
    ), { code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE' });
  }
}

function deploymentControlFailure(
  error: unknown,
  fallback: string,
): DeploymentControlFailure {
  const errorRecord = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  const responseRecord = errorRecord?.response && typeof errorRecord.response === 'object'
    ? errorRecord.response as Record<string, unknown>
    : null;
  const dataRecord = responseRecord?.data && typeof responseRecord.data === 'object'
    ? responseRecord.data as Record<string, unknown>
    : null;
  // When the server returned a structured body, consume only the explicitly
  // approved singular fields below. In particular, never surface the legacy
  // plural `details` payload, which may contain raw runtime diagnostics.
  const extracted = dataRecord
    ? undefined
    : boundedDeploymentText(extractError(error).message, 500);
  const code = boundedDeploymentText(dataRecord?.code ?? errorRecord?.code, 80);
  const detail = boundedDeploymentText(dataRecord?.detail, 2_000);
  const limitation = boundedDeploymentText(dataRecord?.limitation, 2_000);
  const recoveryReplay = projectRuntimeRecoveryReplayProof(dataRecord?.recoveryReplay);
  const recoveryAction = code === 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE'
    && dataRecord?.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
    && recoveryReplay
    ? 'REPAIR_PROJECT_RUNTIME_IMAGE' as const
    : code === 'PROJECT_DEPLOY_TYPE_TRANSITION_REQUIRES_UNDEPLOY'
      && dataRecord?.recoveryAction === 'UNDEPLOY_CURRENT_DEPLOYMENT'
      ? 'UNDEPLOY_CURRENT_DEPLOYMENT' as const
      : undefined;
  return {
    message: boundedDeploymentText(dataRecord?.error, 500)
      || boundedDeploymentText(dataRecord?.message, 500)
      || extracted
      || fallback,
    ...(detail ? { detail } : {}),
    ...(limitation ? { limitation } : {}),
    ...(code && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? { code } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
    ...(recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE' && recoveryReplay
      ? { recoveryReplay }
      : {}),
  };
}

function projectLifecycleActionAllowed(
  project: Project | null | undefined,
  action: ProjectLifecycleAction,
): boolean {
  if (!project?.deployment) return true;
  return project.deployment.supportedLifecycleActions.includes(action);
}

function deploymentFailureText(error: DeploymentControlFailure | null): string | null {
  if (!error) return null;
  return [
    error.message,
    error.detail,
    error.limitation,
    error.code ? `Code: ${error.code}` : undefined,
  ].filter((part): part is string => Boolean(part)).join('\n\n');
}

function deploymentFailureWithoutRuntimeRepair(
  failure: DeploymentControlFailure,
): DeploymentControlFailure {
  const sanitized = { ...failure };
  delete sanitized.recoveryAction;
  delete sanitized.recoveryReplay;
  delete sanitized.retryAction;
  delete sanitized.retryOwner;
  return sanitized;
}

function runtimeManagementLabel(value: ProjectRuntimeManagement): string {
  switch (value) {
    case 'portal-container': return 'Portal-managed container';
    case 'external-loopback': return 'External service';
    case 'desktop-session': return 'Remote Desktop session';
    case 'static': return 'Static files';
  }
}

function runtimeStatusSourceLabel(value: ProjectRuntimeStatusSource): string {
  switch (value) {
    case 'portal-manager': return 'Portal runtime manager';
    case 'persisted-app': return 'Saved deployment state';
    case 'external-binding': return 'External routing';
    case 'deployment-record': return 'Deployment record';
  }
}

function deploymentProgressAnnouncement(
  busy: 'start' | 'stop' | 'restart' | 'refresh' | 'undeploy' | null,
  status: string,
): string {
  switch (busy) {
    case 'start': return 'Starting deployment.';
    case 'stop': return 'Stopping deployment.';
    case 'restart': return 'Restarting deployment.';
    case 'refresh': return 'Refreshing deployment status.';
    case 'undeploy': return 'Removing deployment.';
    default: return `Deployment status: ${status}.`;
  }
}

type ProjectOperation = Readonly<{
  kind: 'deploy' | 'git' | 'rename' | ProjectChatActivity['kind'];
  projectName: string;
  projectGeneration: number;
  token: number;
  provider?: ProjectChatActivity['provider'];
  runtime?: boolean;
  gitAction?: 'commit' | 'pull' | 'push' | 'checkout' | 'checkout-new' | 'reset-file' | 'revert';
  gitTarget?: string;
  renameSourceName?: string;
  renameTargetName?: string;
  renameAttemptId?: string;
  renameIdentity?: ProjectIdentityProof;
  activity?: Readonly<ProjectChatActivity>;
}>;

type ProjectRenamePhase =
  | 'idle'
  | 'submitting'
  | 'reconciling'
  | 'indeterminate'
  | 'not-admitted'
  | 'recovery-retired'
  | 'recovery-blocked'
  | 'storage-blocked';

type StoredProjectRenameAttempt = Readonly<{
  version: 2;
  actorId: string;
  attemptId: string;
  sourceName: string;
  targetName: string;
  identity: ProjectIdentityProof;
  phase: 'indeterminate';
}>;

type StoredProjectRenameRead =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'malformed' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'valid'; attempt: StoredProjectRenameAttempt }>;

type StoredProjectRenameInventoryRead =
  | Readonly<{ status: 'available'; attempts: readonly StoredProjectRenameAttempt[] }>
  | Readonly<{ status: 'unavailable'; attempts: readonly [] }>;

type ProjectRenameStorageWrite = Readonly<{
  status: 'persisted' | 'unavailable' | 'unverified';
}>;

type ProjectRenameStorageRetirement = Readonly<{
  status: 'retired' | 'unavailable' | 'unverified';
}>;

type ProjectRenameStorageBlock = Readonly<{
  operation: ProjectOperation;
  recovery: 'safe-release' | 'reconcile';
}>;

type ShareActionOwner = Readonly<{
  kind: 'create' | 'email' | 'delete' | 'make-public' | 'toggle' | 'refresh';
  projectName: string;
  projectGeneration: number;
  linkId?: string;
  token: number;
}>;


type ShareLinkAvailability = 'active' | 'disabled' | 'expired' | 'exhausted';

const SHARE_VISITOR_PRESETS = [
  { value: '1', label: 'One', detail: '1' },
  { value: '10', label: 'Small', detail: '10' },
  { value: '100', label: 'Large', detail: '100' },
  { value: '', label: 'Unlimited', detail: '∞' },
] as const;

const SHARE_RATE_LIMIT_WINDOWS: ReadonlyArray<{
  value: ShareRateLimitWindowSeconds;
  label: string;
}> = [
  { value: 60, label: 'per minute' },
  { value: 300, label: 'per 5 minutes' },
  { value: 3600, label: 'per hour' },
];

function shareRateLimitWindowLabel(seconds: number | null | undefined): string {
  if (seconds === 60) return 'minute';
  if (seconds === 300) return '5 minutes';
  if (seconds === 3600) return 'hour';
  return 'configured window';
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function getShareLinkAvailability(link: ShareLink, now = Date.now()): ShareLinkAvailability {
  if (link.expiresAt) {
    const expiresAt = new Date(link.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'expired';
  }
  if (link.maxUses !== null && link.currentUses >= link.maxUses) return 'exhausted';
  if (!link.isActive) return 'disabled';
  return 'active';
}

const LAST_SELECTED_PROJECT_KEY = 'projects-last-selected';
const PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX = 'portal:project-rename-attempt:';
const OLLAMA_ANALYSIS_FALLBACK = 'qwen3.5:4b';

function projectIdentitiesMatch(left: ProjectIdentityProof, right: ProjectIdentityProof): boolean {
  return left.id === right.id && left.generation === right.generation;
}

function isCanonicalProjectName(value: string): boolean {
  const canonical = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  return Boolean(canonical) && canonical !== '.' && canonical !== '..' && canonical === value;
}

function projectRenameStorageKey(projectIdentityId: string, attemptId: string): string {
  return `${PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX}${encodeURIComponent(projectIdentityId)}:${attemptId}`;
}

function parseStoredProjectRenameAttempt(raw: string, actorId: string): StoredProjectRenameRead {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const identity = value.identity as Record<string, unknown> | null;
    if (
      value.version !== 2
      || value.actorId !== actorId
      || value.phase !== 'indeterminate'
      || typeof value.attemptId !== 'string'
      || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.attemptId)
      || typeof value.sourceName !== 'string'
      || !isCanonicalProjectName(value.sourceName)
      || typeof value.targetName !== 'string'
      || !isCanonicalProjectName(value.targetName)
      || !identity
      || typeof identity.id !== 'string'
      || !identity.id
      || identity.id.length > 128
      || !Number.isSafeInteger(identity.generation)
      || (identity.generation as number) < 1
    ) return { status: 'malformed' };
    return {
      status: 'valid',
      attempt: Object.freeze({
        version: 2,
        actorId,
        phase: 'indeterminate',
        attemptId: value.attemptId,
        sourceName: value.sourceName,
        targetName: value.targetName,
        identity: Object.freeze({ id: identity.id, generation: identity.generation as number }),
      }),
    };
  } catch {
    return { status: 'malformed' };
  }
}

function readStoredProjectRenameAttempt(
  actorId: string,
  projectIdentityId: string,
  attemptId: string,
): StoredProjectRenameRead {
  let raw: string | null;
  try {
    // This record is the browser-side half of rename admission. It must
    // survive a closed tab/browser restart; sessionStorage would silently
    // discard the only attempt ID needed to reconcile an ambiguous PATCH.
    raw = localStorage.getItem(projectRenameStorageKey(projectIdentityId, attemptId));
  } catch {
    return { status: 'unavailable' };
  }
  if (raw === null) return { status: 'none' };
  const parsed = parseStoredProjectRenameAttempt(raw, actorId);
  if (
    parsed.status === 'valid'
    && projectRenameStorageKey(parsed.attempt.identity.id, parsed.attempt.attemptId)
      !== projectRenameStorageKey(projectIdentityId, attemptId)
  ) return { status: 'malformed' };
  return parsed;
}

function listStoredProjectRenameAttempts(actorId: string): StoredProjectRenameInventoryRead {
  const attempts: StoredProjectRenameAttempt[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const parsed = parseStoredProjectRenameAttempt(raw, actorId);
      if (
        parsed.status === 'valid'
        && key === projectRenameStorageKey(parsed.attempt.identity.id, parsed.attempt.attemptId)
      ) {
        attempts.push(parsed.attempt);
        continue;
      }
      // Version 1 used one account-wide key. Rename was compile-time rejected
      // in every build that wrote it, so this stale non-admitted tombstone is
      // safe to retire and must not keep unrelated projects locked.
      const legacy = (() => {
        try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
      })();
      if (legacy?.version === 1 && legacy.actorId === actorId && key === `${PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX}${actorId}`) {
        localStorage.removeItem(key);
        index -= 1;
      }
    }
    return { status: 'available', attempts };
  } catch {
    return { status: 'unavailable', attempts: [] };
  }
}

function storedProjectRenameAttemptMatches(
  stored: StoredProjectRenameAttempt,
  actorId: string,
  operation: ProjectOperation,
): boolean {
  return stored.actorId === actorId
    && stored.attemptId === operation.renameAttemptId
    && stored.sourceName === operation.renameSourceName
    && stored.targetName === operation.renameTargetName
    && !!operation.renameIdentity
    && projectIdentitiesMatch(stored.identity, operation.renameIdentity);
}

function persistProjectRenameAttempt(actorId: string, operation: ProjectOperation): ProjectRenameStorageWrite {
  if (
    !operation.renameAttemptId
    || !operation.renameSourceName
    || !operation.renameTargetName
    || !operation.renameIdentity
  ) return { status: 'unverified' };
  const stored: StoredProjectRenameAttempt = Object.freeze({
    version: 2,
    actorId,
    phase: 'indeterminate',
    attemptId: operation.renameAttemptId,
    sourceName: operation.renameSourceName,
    targetName: operation.renameTargetName,
    identity: operation.renameIdentity,
  });
  try {
    localStorage.setItem(
      projectRenameStorageKey(stored.identity.id, stored.attemptId),
      JSON.stringify(stored),
    );
  } catch {
    return { status: 'unavailable' };
  }
  const readback = readStoredProjectRenameAttempt(actorId, stored.identity.id, stored.attemptId);
  if (readback.status === 'unavailable') return { status: 'unavailable' };
  if (
    readback.status !== 'valid'
    || !storedProjectRenameAttemptMatches(readback.attempt, actorId, operation)
  ) return { status: 'unverified' };
  return { status: 'persisted' };
}

function clearStoredProjectRenameAttempt(
  actorId: string,
  operation: ProjectOperation,
): ProjectRenameStorageRetirement {
  if (!operation.renameIdentity || !operation.renameAttemptId) return { status: 'unverified' };
  const storageKey = projectRenameStorageKey(operation.renameIdentity.id, operation.renameAttemptId);
  const stored = readStoredProjectRenameAttempt(
    actorId,
    operation.renameIdentity.id,
    operation.renameAttemptId,
  );
  if (stored.status === 'unavailable') return { status: 'unavailable' };
  if (stored.status === 'none') return { status: 'retired' };
  if (
    stored.status !== 'valid'
    || !storedProjectRenameAttemptMatches(stored.attempt, actorId, operation)
  ) return { status: 'unverified' };
  try {
    localStorage.removeItem(storageKey);
  } catch {
    return { status: 'unavailable' };
  }
  const readback = readStoredProjectRenameAttempt(
    actorId,
    operation.renameIdentity.id,
    operation.renameAttemptId,
  );
  if (readback.status === 'unavailable') return { status: 'unavailable' };
  return readback.status === 'none'
    ? { status: 'retired' }
    : { status: 'unverified' };
}

function isAuthoritativeRenameNonAdmission(error: unknown, attemptId: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: { data?: unknown } }).response;
  if (!response?.data || typeof response.data !== 'object') return false;
  const data = response.data as Record<string, unknown>;
  return data.admitted === false
    && data.status === 'not_admitted'
    && data.attemptId === attemptId
    && typeof data.code === 'string';
}

function formatOllamaModelLabel(model: string): string {
  return model
    .replace(/^ollama\//, '')
    .split(/([:._/-])/)
    .map((part) => (/^[a-z]/.test(part) ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part))
    .join('');
}

// --- Helpers ---
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'sh', 'rb', 'php', 'java', 'c', 'cpp'].includes(ext || '')) return FileCode;
  return FileText;
}

function gitStatusColor(status?: string) {
  if (!status) return '';
  if (status === 'untracked' || status === 'added') return 'text-green-400';
  if (status === 'modified') return 'text-amber-400';
  if (status === 'deleted') return 'text-red-400';
  if (status === 'renamed') return 'text-blue-400';
  return 'text-slate-400';
}

function gitStatusIcon(status?: string) {
  if (!status) return null;
  const map: Record<string, string> = { untracked: 'U', added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
  return map[status] || '?';
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function activityIcon(action: string) {
  if (action.includes('DEPLOY')) return <Rocket size={12} className="text-emerald-400" />;
  if (action.includes('COMMIT') || action.includes('GIT')) return <GitCommit size={12} className="text-orange-400" />;
  if (action.includes('CREATE')) return <Plus size={12} className="text-blue-400" />;
  if (action.includes('DELETE')) return <Trash2 size={12} className="text-red-400" />;
  if (action.includes('UPLOAD')) return <Upload size={12} className="text-cyan-400" />;
  return <Activity size={12} className="text-slate-400" />;
}

function activityLabel(action: string) {
  const map: Record<string, string> = {
    PROJECT_CREATE: 'Project created',
    PROJECT_DEPLOY: 'Deployed',
    PROJECT_UPLOAD_ZIP: 'ZIP uploaded',
    PROJECT_FILE_UPLOAD: 'Files uploaded',
    PROJECT_DELETE: 'Deleted',
    APP_UPLOAD: 'App uploaded',
    APP_DELETE: 'App deleted',
  };
  return map[action] || action.replace(/_/g, ' ').toLowerCase();
}

// --- Media file type detection ---
type FileCategory = 'code' | 'image' | 'video' | 'audio' | 'pdf' | 'excel' | 'binary' | 'text';

function getFileCategory(filename: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  const binaryExts = ['woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite'];
  if (binaryExts.includes(ext)) return 'binary';
  return 'code';
}

function getProjectRawUrl(projectName: string, filePath: string, options?: { mode?: 'text' }): string {
  const apiUrl = import.meta.env.VITE_API_URL || '';
  const params = new URLSearchParams({ path: filePath });
  if (options?.mode) params.set('mode', options.mode);
  return `${apiUrl}/projects/${encodeURIComponent(projectName)}/raw?${params.toString()}`;
}

// --- Inline Media Viewers for Projects ---
function ProjectImageViewer({ src, name }: { src: string; name: string }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.1, Math.min(10, z + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    setDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  }, [zoom, position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const resetView = () => { setZoom(1); setPosition({ x: 0, y: 0 }); };

  if (error) return (
    <div className="flex-1 flex items-center justify-center text-slate-500">
      <div className="text-center">
        <AlertCircle size={48} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm">Failed to load image</p>
        <a href={src} download className="text-xs text-emerald-400 hover:text-emerald-300 mt-2 inline-block">Download instead</a>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="flex items-center justify-center gap-1 py-1.5 border-b border-theme-border bg-theme-surface-raised flex-shrink-0">
        <button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(0.1, z - 0.25))} className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white"><ZoomOut size={14} /></button>
        <span className="text-[10px] text-slate-500 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(10, z + 0.25))} className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white"><ZoomIn size={14} /></button>
        <div className="w-px h-3 bg-white/10 mx-1" />
        <button onClick={resetView} className="px-2 py-1 text-[10px] rounded hover:bg-white/10 text-slate-400 hover:text-white">Reset</button>
        <div className="w-px h-3 bg-white/10 mx-1" />
        <a href={src} download aria-label={`Download ${name}`} className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-emerald-400"><Download size={14} /></a>
      </div>
      {/* Image */}
      <button
        type="button"
        aria-label="Project image viewer. Use arrow keys to pan and plus or minus to zoom."
        className="flex-1 overflow-hidden flex items-center justify-center border-0 bg-[#0a0a0f] p-0 cursor-grab active:cursor-grabbing select-none"
        style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'20\' height=\'20\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Crect width=\'10\' height=\'10\' fill=\'%23111\'/%3E%3Crect x=\'10\' y=\'10\' width=\'10\' height=\'10\' fill=\'%23111\'/%3E%3Crect x=\'10\' width=\'10\' height=\'10\' fill=\'%230d0d0d\'/%3E%3Crect y=\'10\' width=\'10\' height=\'10\' fill=\'%230d0d0d\'/%3E%3C/svg%3E")' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={() => zoom === 1 ? setZoom(2) : resetView()}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 50 : 10;
          if (event.key === 'ArrowLeft') setPosition((current) => ({ ...current, x: current.x - delta }));
          else if (event.key === 'ArrowRight') setPosition((current) => ({ ...current, x: current.x + delta }));
          else if (event.key === 'ArrowUp') setPosition((current) => ({ ...current, y: current.y - delta }));
          else if (event.key === 'ArrowDown') setPosition((current) => ({ ...current, y: current.y + delta }));
          else if (event.key === '+' || event.key === '=') setZoom((current) => Math.min(10, current + 0.25));
          else if (event.key === '-') setZoom((current) => Math.max(0.1, current - 0.25));
          else return;
          event.preventDefault();
        }}
      >
        {!loaded && !error && <Loader2 size={24} className="animate-spin text-slate-600 absolute" />}
        <img
          src={src}
          alt={name}
          className="max-w-none transition-transform duration-100"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
            maxWidth: zoom <= 1 ? '100%' : 'none',
            maxHeight: zoom <= 1 ? '100%' : 'none',
            opacity: loaded ? 1 : 0,
          }}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      </button>
    </div>
  );
}

function ProjectAudioViewer({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 bg-theme-surface">
      <div className="w-28 h-28 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center">
        <Volume2 size={44} className="text-purple-400" />
      </div>
      <div className="text-center">
        <p className="font-medium text-sm text-theme-text">{name}</p>
      </div>
      <audio src={src} controls autoPlay aria-label={`Audio preview for ${name}`} className="w-full max-w-md" />
      <a href={src} download className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"><Download size={12} /> Download</a>
    </div>
  );
}

function ProjectVideoViewer({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-black p-4">
      <video
        src={src}
        aria-label={`Video preview for ${name}`}
        controls
        autoPlay
        className="max-w-full max-h-full rounded-lg"
        style={{ outline: 'none' }}
      />
    </div>
  );
}

function ResponsiveProjectPanel({
  isMobile,
  mobileLabel,
  desktopWidth = 340,
  onDismiss,
  children,
}: {
  isMobile: boolean;
  mobileLabel: string;
  desktopWidth?: number;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const panel = (
    <motion.div
      role={isMobile ? 'dialog' : undefined}
      aria-modal={isMobile ? 'true' : undefined}
      aria-label={isMobile ? mobileLabel : undefined}
      initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      animate={isMobile ? { opacity: 1, x: 0 } : { width: desktopWidth, opacity: 1 }}
      exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={isMobile
        ? 'flex h-full w-full flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
        : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/50'}
    >
      {children}
    </motion.div>
  );

  if (!isMobile) return panel;

  return (
    <ViewportModal
      open
      onDismiss={onDismiss}
      className="items-stretch justify-stretch bg-[#080B20]/98 backdrop-blur-sm"
    >
      {panel}
    </ViewportModal>
  );
}

function ResponsiveProjectSidebar({
  isMobile,
  onDismiss,
  children,
}: {
  isMobile: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const sidebar = (
    <motion.div
      id="projects-sidebar"
      role={isMobile ? 'dialog' : undefined}
      aria-modal={isMobile ? 'true' : undefined}
      aria-label={isMobile ? 'Projects sidebar' : undefined}
      initial={{ width: 0, opacity: 0, ...(isMobile ? { x: -280 } : {}) }}
      animate={{ width: isMobile ? 280 : 224, opacity: 1, ...(isMobile ? { x: 0 } : {}) }}
      exit={{ width: 0, opacity: 0, ...(isMobile ? { x: -280 } : {}) }}
      transition={{ duration: 0.15, ...(isMobile ? { type: 'spring', damping: 25 } : {}) }}
      className={`border-r border-white/5 flex h-full max-w-[calc(100dvw-2rem)] flex-col flex-shrink-0 overflow-hidden bg-[#080B20]/95 ${
        isMobile ? 'self-start' : ''
      }`}
    >
      {children}
    </motion.div>
  );

  if (!isMobile) return sidebar;

  return (
    <ViewportModal
      open
      onDismiss={onDismiss}
      className="items-stretch justify-start bg-black/60"
    >
      {sidebar}
    </ViewportModal>
  );
}

// --- Main Component ---
export default function AppsPage() {
  // Core state
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const routerNavigator = navigationContext?.navigator;
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const { resolvedTheme } = useTheme();
  const projectNavigationBinding = useMemo(() => {
    const authorizationVersion = Number(user?.authorizationVersion ?? 1);
    if (!user?.id || !Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1) return null;
    return { actorUserId: user.id, authorizationVersion };
  }, [user?.authorizationVersion, user?.id]);
  const projectDeepLinkPresent = useMemo(
    () => hasProjectDeepLinkParams(location.search),
    [location.search],
  );
  const projectDeepLink = useMemo(
    () => parseProjectDeepLink(location.search, projectNavigationBinding),
    [location.search, projectNavigationBinding],
  );
  const isMobile = useIsMobile();
  const isLocalPortalOrigin = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, TreeEntry[]>>({});
  const [openFile, setOpenFile] = useState<{ path: string; content: string; language: string } | null>(null);
  const [openMedia, setOpenMedia] = useState<{ path: string; category: FileCategory; url: string; note?: string } | null>(null);
  const [modified, setModified] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [projectOperation, setProjectOperation] = useState<ProjectOperation | null>(null);
  const [deployStatus, setDeployStatus] = useState<'idle' | 'deploying' | 'success' | 'failed'>('idle');
  const [isRuntimeProject, setIsRuntimeProject] = useState(false);
  const [checkingProject, setCheckingProject] = useState(false);
  const [deploymentProcess, setDeploymentProcess] = useState<ProjectDeploymentProcessState | null>(null);
  const [deploymentControlBusy, setDeploymentControlBusy] = useState<'start' | 'stop' | 'restart' | 'refresh' | 'undeploy' | null>(null);
  const [deploymentControlError, setDeploymentControlError] = useState<DeploymentControlFailure | null>(null);
  const [pendingUndeploy, setPendingUndeploy] = useState<string | null>(null);
  const [runtimeImageRepairDialog, setRuntimeImageRepairDialog] = useState<Readonly<{
    confirmationPhrase: string;
  } & RuntimeImageRepairRetryOwner> | null>(null);
  const [runtimeImageRepairPhase, setRuntimeImageRepairPhase] = useState<'idle' | 'preparing' | 'running'>('idle');
  const [runtimeImageRepairError, setRuntimeImageRepairError] = useState<string | null>(null);
  const runtimeImageRepairInFlightRef = useRef(false);
  const runtimeImageRepairReplayOutcomeRef = useRef<RuntimeImageRepairReplayOutcome>('stale');
  
  // Progress notification state for deploy/install flow
  const [progressNotification, setProgressNotification] = useState<ProgressNotificationProps | null>(null);
  const installEventSourceRef = useRef<EventSource | null>(null);
  const projectRestoreAttempted = useRef(false);
  const projectActorIdRef = useRef(useAuthStore.getState().user?.id || '');
  const initialRenameReadRef = useRef<StoredProjectRenameInventoryRead | null>(null);
  if (!initialRenameReadRef.current) {
    initialRenameReadRef.current = projectActorIdRef.current
      ? listStoredProjectRenameAttempts(projectActorIdRef.current)
      : { status: 'available', attempts: [] };
  }
  const restoredRenameAttemptsRef = useRef<StoredProjectRenameAttempt[]>(
    initialRenameReadRef.current.status === 'available'
      ? [...initialRenameReadRef.current.attempts]
      : [],
  );

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<'template' | 'clone' | 'zip'>('template');
  const [newName, setNewName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [template, setTemplate] = useState('static-html');
  const [creating, setCreating] = useState(false);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipUploading, setZipUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  // Panels
  const [activePanel, setActivePanel] = useState<'git' | 'share' | 'activity' | 'deployment' | null>(null);
  const [gitTab, setGitTab] = useState<'changes' | 'log' | 'branches'>('changes');
  const [gitStatus, setGitStatus] = useState<{ branch: string; ahead: number; behind: number; files: GitFile[]; clean: boolean } | null>(null);
  const [commitLog, setCommitLog] = useState<CommitEntry[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [selectedDiff, setSelectedDiff] = useState<{ file?: string; content: string } | null>(null);
  const [commitDiff, setCommitDiff] = useState<{ hash: string; output: string; diff: string } | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const gitLoadingCountRef = useRef(0);
  const gitStatusGenerationRef = useRef(0);
  const gitLogGenerationRef = useRef(0);
  const gitBranchesGenerationRef = useRef(0);
  const beginGitLoading = useCallback(() => {
    gitLoadingCountRef.current += 1;
    setGitLoading(true);
  }, []);
  const endGitLoading = useCallback(() => {
    gitLoadingCountRef.current = Math.max(0, gitLoadingCountRef.current - 1);
    setGitLoading(gitLoadingCountRef.current > 0);
  }, []);

  // Enhanced git log
  const [enhancedCommits, setEnhancedCommits] = useState<EnhancedCommit[]>([]);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [revertTarget, setRevertTarget] = useState<EnhancedCommit | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertResult, setRevertResult] = useState<{ success: boolean; message: string } | null>(null);
  const revertCancelButtonRef = useRef<HTMLButtonElement>(null);
  const commitDiffCloseButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenExitButtonRef = useRef<HTMLButtonElement>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  const [logBranchFilter, setLogBranchFilter] = useState<string>('');


  // Project Chat
  const [agentChatOpen, setAgentChatOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  const projectDeepLinkSelectionRef = useRef<string | null>(null);
  const projectDeepLinkFileRef = useRef<string | null>(null);
  const [projectsCollapsed, setProjectsCollapsed] = useState<boolean>(() => localStorage.getItem('projects-sidebar-collapsed') === '1');
  const visibleSidebarProjects = useMemo(() => {
    const filtered = projectsCollapsed
      ? projects.filter((project) => project.name === selectedProject)
      : projects.filter((project) => (
          !projectFilter.trim()
          || project.name.toLowerCase().includes(projectFilter.trim().toLowerCase())
        ));
    const selectedIndex = filtered.findIndex((project) => project.name === selectedProject);
    if (selectedIndex <= 0) return filtered;
    return [
      filtered[selectedIndex],
      ...filtered.slice(0, selectedIndex),
      ...filtered.slice(selectedIndex + 1),
    ];
  }, [projectFilter, projects, projectsCollapsed, selectedProject]);
  
  // Title bar path editing
  const [editingPath, setEditingPath] = useState(false);
  const [pathEditValue, setPathEditValue] = useState('');

  // Code analysis
  const [analyzeModel, setAnalyzeModel] = useState<string>('');
  const [analyzeModels, setAnalyzeModels] = useState<string[]>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<any[]>([]);
  const [showAnalysisPanel, setShowAnalysisPanel] = useState(false);

  // Share panel
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [shareIsPublic, setShareIsPublic] = useState(true);
  const [sharePassword, setSharePassword] = useState('');
  const [sharePasswordConfirm, setSharePasswordConfirm] = useState('');
  const [shareExpiresAt, setShareExpiresAt] = useState('');
  const [shareMaxUses, setShareMaxUses] = useState('');
  const [shareRateLimitEnabled, setShareRateLimitEnabled] = useState(false);
  const [shareRateLimitMaxRequests, setShareRateLimitMaxRequests] = useState('');
  const [shareRateLimitWindowSeconds, setShareRateLimitWindowSeconds] = useState<ShareRateLimitWindowSeconds>(60);
  const [shareCreateError, setShareCreateError] = useState<string | null>(null);
  const sharePasswordByteLength = utf8ByteLength(sharePassword);
  const shareMaxUsesNumber = Number(shareMaxUses);
  const shareMaxUsesInvalid = shareMaxUses !== '' && (
    !Number.isSafeInteger(shareMaxUsesNumber)
    || shareMaxUsesNumber < 1
    || shareMaxUsesNumber > 1_000_000
  );
  const shareRateLimitMaxRequestsNumber = Number(shareRateLimitMaxRequests);
  const shareRateLimitMaxRequestsInvalid = shareRateLimitEnabled && (
    shareRateLimitMaxRequests === ''
    || !Number.isSafeInteger(shareRateLimitMaxRequestsNumber)
    || shareRateLimitMaxRequestsNumber < 1
    || shareRateLimitMaxRequestsNumber > 1_000_000
  );
  const [confirmPublicId, setConfirmPublicId] = useState<string | null>(null);
  const [shareCreating, setShareCreating] = useState(false);
  const [shareMutationIds, setShareMutationIds] = useState<Set<string>>(() => new Set());
  const shareMutationIdsRef = useRef(new Set<string>());
  const [emailingLinkId, setEmailingLinkId] = useState<string | null>(null);
  const [shareEmailInput, setShareEmailInput] = useState('');
  const [shareEmailSending, setShareEmailSending] = useState(false);
  const [shareEmailSuccess, setShareEmailSuccess] = useState<string | null>(null);
  const [shareEmailError, setShareEmailError] = useState<string | null>(null);
  const [shareRefreshError, setShareRefreshError] = useState<string | null>(null);
  const [shareRefreshing, setShareRefreshing] = useState(false);
  const [shareDeleteBusy, setShareDeleteBusy] = useState(false);
  const [shareDeleteError, setShareDeleteError] = useState<string | null>(null);
  const [shareMakePublicBusy, setShareMakePublicBusy] = useState(false);
  const [shareMakePublicError, setShareMakePublicError] = useState<string | null>(null);

  // Activity
  const [activityLogs, setActivityLogs] = useState<ActivityEntry[]>([]);

  // New file/folder
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileIsDir, setNewFileIsDir] = useState(false);
  const [creatingEntry, setCreatingEntry] = useState(false);

  // File upload dialog
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const createProjectNameInputRef = useRef<HTMLInputElement>(null);
  const newProjectEntryInputRef = useRef<HTMLInputElement>(null);
  const uploadDestinationSelectRef = useRef<HTMLSelectElement>(null);
  const projectRenameInputRef = useRef<HTMLInputElement>(null);

  // Inline rename in file tree
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; name: string; type: 'file' | 'directory' } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Fullscreen editor
  const [editorFullscreen, setEditorFullscreen] = useState(false);

  // Sidebar toggle
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // File search
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');

  // Auto-save
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutoSaveRef = useRef<ProjectFileWrite | null>(null);
  const fileWriteQueueRef = useRef(new ProjectFileWriteQueue());
  const projectsRef = useRef<Project[]>(projects);
  const selectedProjectRef = useRef<string | null>(selectedProject);
  const openFileRef = useRef<typeof openFile>(openFile);
  const openFileHandlerRef = useRef<(filePath: string, preserveDeepLink?: boolean) => Promise<void>>();
  const editorContentRef = useRef(editorContent);
  const editorRevisionRef = useRef(0);
  const projectInventoryLoadGenerationRef = useRef(0);
  const projectLoadGenerationRef = useRef(0);
  const deploymentStatusGenerationRef = useRef(0);
  const deploymentStatusReadRef = useRef<Readonly<{
    generation: number;
    projectName: string;
    projectGeneration: number;
    appId: string;
  }> | null>(null);
  const deploymentProcessOwnerRef = useRef<Readonly<{
    projectName: string;
    projectGeneration: number;
    appId: string;
  }> | null>(null);
  const shareLoadGenerationRef = useRef(0);
  const treeRefreshGenerationRef = useRef(0);
  const fileLoadGenerationRef = useRef(0);
  const directoryLoadGenerationRef = useRef(new Map<string, number>());
  const pendingDirectoryLoadsRef = useRef(new Set<string>());
  const zipUploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const modifiedRef = useRef(modified);
  const projectRenameInFlightRef = useRef<ProjectOperation | null>(null);
  const projectRenameRequestActiveRef = useRef(false);
  const projectRenameStorageBlockRef = useRef<ProjectRenameStorageBlock | null>(null);
  const projectRenameRetryBoundaryRef = useRef<'none' | 'confirm' | 'armed'>('none');
  const reconcileOwnedProjectRenameRef = useRef<(operation: ProjectOperation) => Promise<void>>(async () => undefined);
  const entryRenameInFlightRef = useRef(false);
  const pathEditInFlightRef = useRef(false);
  const createProjectInFlightRef = useRef(false);
  const createEntryInFlightRef = useRef(false);
  const uploadFilesInFlightRef = useRef(false);
  const deleteInFlightRef = useRef<Readonly<{
    kind: 'project' | 'file';
    name: string;
    projectName: string;
    path?: string;
  }> | null>(null);
  const projectOperationRef = useRef<ProjectOperation | null>(null);
  const projectOperationTokenRef = useRef(0);
  const projectNavigationReleaseRef = useRef<(() => void) | null>(null);
  const projectNavigationGuardRef = useRef<{
    url: string;
    state: unknown;
    historyIndex: number | null;
  } | null>(null);
  const shareCreateInFlightRef = useRef(false);
  const shareEmailInFlightRef = useRef(false);
  const shareDeleteInFlightRef = useRef(false);
  const shareMakePublicInFlightRef = useRef(false);
  const shareActionOwnerRef = useRef<ShareActionOwner | null>(null);

  const invalidateDeploymentStatusReads = useCallback(() => {
    deploymentStatusGenerationRef.current += 1;
    deploymentStatusReadRef.current = null;
    setDeploymentControlBusy((current) => current === 'refresh' ? null : current);
  }, []);

  const releaseProjectNavigationLock = useCallback(() => {
    projectNavigationReleaseRef.current?.();
    projectNavigationReleaseRef.current = null;
    projectNavigationGuardRef.current = null;
  }, []);

  const acquireProjectNavigationLock = useCallback(() => {
    if (projectNavigationReleaseRef.current) return;
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
    projectNavigationGuardRef.current = {
      url: window.location.href,
      state: window.history.state,
      historyIndex: typeof browserHistoryIndex === 'number' ? browserHistoryIndex : null,
    };
    projectNavigationReleaseRef.current = () => {
      if (routerNavigator.push === blockedPush) routerNavigator.push = originalPush;
      if (routerNavigator.replace === blockedReplace) routerNavigator.replace = originalReplace;
      if (routerNavigator.go === blockedGo) routerNavigator.go = originalGo;
    };
  }, [routerNavigator]);

  const claimProjectOperation = useCallback((operation: ProjectOperation) => {
    if (
      projectOperationRef.current
      || deleteInFlightRef.current
      || selectedProjectRef.current !== operation.projectName
      || projectLoadGenerationRef.current !== operation.projectGeneration
      || !claimRouteOperation(operation)
    ) return false;
    projectOperationRef.current = operation;
    acquireProjectNavigationLock();
    setProjectOperation(operation);
    return true;
  }, [acquireProjectNavigationLock]);

  const releaseProjectOperation = useCallback((operation: ProjectOperation) => {
    if (projectOperationRef.current !== operation) return;
    projectOperationRef.current = null;
    setProjectOperation(null);
    releaseProjectNavigationLock();
    releaseRouteOperation(operation);
  }, [releaseProjectNavigationLock]);

  const claimGitMutation = useCallback((
    gitAction: NonNullable<ProjectOperation['gitAction']>,
    gitTarget?: string,
  ): ProjectOperation | null => {
    const projectName = selectedProjectRef.current;
    if (!projectName) return null;
    const operation = Object.freeze({
      kind: 'git' as const,
      gitAction,
      gitTarget,
      projectName,
      projectGeneration: projectLoadGenerationRef.current,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimProjectOperation(operation)) return null;
    beginGitLoading();
    return operation;
  }, [beginGitLoading, claimProjectOperation]);

  const releaseGitMutation = useCallback((operation: ProjectOperation) => {
    endGitLoading();
    releaseProjectOperation(operation);
  }, [endGitLoading, releaseProjectOperation]);

  const verifyGitMutation = useCallback(async (operation: ProjectOperation) => {
    const fresh = await projectsAPI.git(operation.projectName, 'status');
    if (
      projectOperationRef.current !== operation
      || selectedProjectRef.current !== operation.projectName
      || projectLoadGenerationRef.current !== operation.projectGeneration
    ) throw new Error('The project changed before Git status could be verified.');
    setGitStatus(fresh);
    return fresh as { branch?: string; files?: GitFile[] };
  }, []);

  const handleProjectChatActivity = useCallback((
    activity: Readonly<ProjectChatActivity>,
    active: boolean,
  ) => {
    if (active) {
      const operation = Object.freeze({
        kind: activity.kind,
        projectName: activity.projectName,
        provider: activity.provider,
        projectGeneration: projectLoadGenerationRef.current,
        token: ++projectOperationTokenRef.current,
        activity,
      });
      return claimProjectOperation(operation);
    }
    const current = projectOperationRef.current;
    if (
      !current
      || current.kind !== activity.kind
      || current.activity !== activity
    ) return false;
    releaseProjectOperation(current);
    return true;
  }, [claimProjectOperation, releaseProjectOperation]);

  useEffect(() => {
    const preventProjectUnload = (event: BeforeUnloadEvent) => {
      if (
        !projectOperationRef.current
        && !deleteInFlightRef.current
        && !shareActionOwnerRef.current
      ) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const preventProjectHistoryTraversal = (event: PopStateEvent) => {
      if (
        !projectOperationRef.current
        && !deleteInFlightRef.current
        && !shareActionOwnerRef.current
      ) return;
      const guard = projectNavigationGuardRef.current;
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
    window.addEventListener('beforeunload', preventProjectUnload);
    window.addEventListener('popstate', preventProjectHistoryTraversal, true);
    return () => {
      window.removeEventListener('beforeunload', preventProjectUnload);
      window.removeEventListener('popstate', preventProjectHistoryTraversal, true);
    };
  }, []);

  useEffect(() => () => {
    releaseProjectNavigationLock();
    const projectOwner = projectOperationRef.current;
    if (projectOwner) {
      projectOperationRef.current = null;
      releaseRouteOperation(projectOwner);
    }
    const deleteOwner = deleteInFlightRef.current;
    if (deleteOwner) {
      deleteInFlightRef.current = null;
      releaseRouteOperation(deleteOwner);
    }
    const shareOwner = shareActionOwnerRef.current;
    if (shareOwner) {
      shareActionOwnerRef.current = null;
      releaseRouteOperation(shareOwner);
    }
  }, [releaseProjectNavigationLock]);

  const isShareActionInFlight = useCallback(() => shareActionOwnerRef.current !== null, []);
  const claimShareAction = useCallback((owner: ShareActionOwner) => {
    if (
      shareActionOwnerRef.current
      || projectOperationRef.current
      || deleteInFlightRef.current
      || selectedProjectRef.current !== owner.projectName
      || projectLoadGenerationRef.current !== owner.projectGeneration
      || !claimRouteOperation(owner)
    ) return false;
    shareActionOwnerRef.current = owner;
    acquireProjectNavigationLock();
    return true;
  }, [acquireProjectNavigationLock]);
  const releaseShareAction = useCallback((owner: ShareActionOwner) => {
    if (shareActionOwnerRef.current !== owner) return;
    shareActionOwnerRef.current = null;
    releaseProjectNavigationLock();
    releaseRouteOperation(owner);
  }, [releaseProjectNavigationLock]);
  const shareActionActive = shareCreating
    || shareEmailSending
    || shareDeleteBusy
    || shareMakePublicBusy
    || shareRefreshing
    || shareMutationIds.size > 0;
  const toggleActivePanel = useCallback((panel: 'git' | 'share' | 'activity' | 'deployment') => {
    if (projectOperationRef.current?.kind === 'git') return;
    if (activePanel === 'share' && isShareActionInFlight()) return;
    setActivePanel((current) => current === panel ? null : panel);
  }, [activePanel, isShareActionInFlight]);

  selectedProjectRef.current = selectedProject;
  openFileRef.current = openFile;
  editorContentRef.current = editorContent;
  modifiedRef.current = modified;

  // Toast — enhanced with detail/hint support
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info'; detail?: string; hint?: string } | null>(null);
  const [toastExpanded, setToastExpanded] = useState(false);
  const [toastCopied, setToastCopied] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    | {
      kind: 'project';
      name: string;
      projectName: string;
      identity: ProjectIdentityProof;
    }
    | {
      kind: 'file';
      name: string;
      projectName: string;
      path: string;
    }
    | null
  >(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Shown while a delete waits out a chat turn's runtime lease instead of
  // failing at the user for a condition that clears itself.
  const [deleteSettleNotice, setDeleteSettleNotice] = useState<string | null>(null);
  const [pendingResetFile, setPendingResetFile] = useState<string | null>(null);
  const [resetFileError, setResetFileError] = useState<string | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success', durationOrOpts?: number | { duration?: number; detail?: string; hint?: string }) => {
    const opts = typeof durationOrOpts === 'number' ? { duration: durationOrOpts } : (durationOrOpts || {});
    setToast({ message, type, detail: opts.detail, hint: opts.hint });
    setToastExpanded(false);
    setToastCopied(false);
    const duration = opts.duration || (type === 'error' ? 20000 : 3000);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
    
    // Play appropriate sound
    if (type === 'success') sounds.success();
    else if (type === 'error') sounds.error();
    else if (type === 'info') sounds.notification();
  }, []);

  /** Show error toast from any caught error, with full context */
  const showErrorToast = useCallback((err: unknown, context: string) => {
    const extracted = extractError(err, context);
    logError(err, context);
    showToast(extracted.message, 'error', { detail: extracted.detail, hint: extracted.hint });
  }, [showToast]);

  const persistProjectFile = useCallback(async (write: ProjectFileWrite) => {
    await fileWriteQueueRef.current.enqueue(write, async (queuedWrite) => {
      await projectsAPI.writeFile(queuedWrite.projectName, queuedWrite.filePath, queuedWrite.content);
      if (
        mountedRef.current
        &&
        isSameProjectDocument(
          selectedProjectRef.current,
          openFileRef.current?.path,
          queuedWrite,
        )
        && editorRevisionRef.current === queuedWrite.revision
        && editorContentRef.current === queuedWrite.content
      ) {
        setOpenFile((current) => current?.path === queuedWrite.filePath
          ? { ...current, content: queuedWrite.content }
          : current);
        setModified(false);
      }
    });
  }, []);

  const flushPendingAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const pending = pendingAutoSaveRef.current;
    pendingAutoSaveRef.current = null;
    if (!pending) return Promise.resolve();
    return persistProjectFile(pending).catch((error) => {
      logError(error, 'Auto-save failed');
      throw error;
    });
  }, [persistProjectFile]);

  // --- Auto-suggest project name from repository URL ---
  useEffect(() => {
    if (cloneUrl && !newName.trim()) {
      // Handle both HTTPS and SSH git URLs
      const match = cloneUrl.match(/(?:\/|:)([^\/]+?)(\.git)?$/);
      if (match) {
        const suggestedName = match[1].replace(/[^a-zA-Z0-9_-]/g, '-');
        setNewName(suggestedName);
      }
    }
  }, [cloneUrl, newName]);

  // --- Data Loading ---
  const loadProjects = useCallback(async (): Promise<boolean> => {
    const loadGeneration = ++projectInventoryLoadGenerationRef.current;
    setLoading(true);
    try {
      const data = await projectsAPI.list();
      if (
        !mountedRef.current
        || projectInventoryLoadGenerationRef.current !== loadGeneration
      ) return false;
      projectsRef.current = data.projects;
      setProjects(data.projects);
      setProjectsError(null);
      return true;
    } catch (err) {
      if (
        !mountedRef.current
        || projectInventoryLoadGenerationRef.current !== loadGeneration
      ) return false;
      const extracted = extractError(err, 'Loading projects');
      // This failure has a durable inline retry surface. Keep diagnostics in
      // the browser console without also sounding the global error alarm.
      console.error('[Projects] Loading projects failed:', err);
      setProjectsError(extracted.message);
      return false;
    } finally {
      if (
        mountedRef.current
        && projectInventoryLoadGenerationRef.current === loadGeneration
      ) setLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    let cancelled = false;
    aiAPI.ollamaStatus()
      .then((status) => {
        if (cancelled) return;
        const models = Array.from(new Set(
          (Array.isArray(status?.models) ? status.models : [])
            .filter((model: unknown): model is string => typeof model === 'string' && model.trim().length > 0)
            .map((model: string) => model.trim()),
        ));
        const configuredDefault = typeof status?.defaultModel === 'string' && status.defaultModel.trim()
          ? status.defaultModel.trim()
          : OLLAMA_ANALYSIS_FALLBACK;
        const options = models.length > 0 ? models : [configuredDefault];
        setAnalyzeModels(options);
        setAnalyzeModel((current) => options.includes(current)
          ? current
          : options.includes(configuredDefault) ? configuredDefault : options[0]);
        setOllamaAvailable(Boolean(status?.available && models.length > 0));
      })
      .catch((error) => {
        if (cancelled) return;
        logError(error, 'Loading installed Ollama models');
        setAnalyzeModels([OLLAMA_ANALYSIS_FALLBACK]);
        setAnalyzeModel(OLLAMA_ANALYSIS_FALLBACK);
        setOllamaAvailable(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selectProject = useCallback(async (name: string) => {
    if (projectOperationRef.current || deleteInFlightRef.current || isShareActionInFlight()) return;
    const requestedProject = projectsRef.current.find((project) => project.name === name);
    if (!requestedProject || requestedProject.availability?.available === false) return;
    const previousProject = selectedProjectRef.current;
    const previousFile = openFileRef.current;
    try {
      await flushPendingAutoSave();
      if (previousProject && previousFile) {
        await fileWriteQueueRef.current.waitFor(previousProject, previousFile.path);
      }
    } catch (error) {
      showErrorToast(error, `Saving ${previousFile?.path || 'the open file'} before switching projects`);
      return;
    }
    // A deploy, provider qualification, or share mutation may have claimed this
    // project while the save barrier was settling. Do not let a previously
    // admitted click switch projects after that immutable operation owns it.
    if (projectOperationRef.current || deleteInFlightRef.current || isShareActionInFlight()) return;
    invalidateDeploymentStatusReads();
    const generation = ++projectLoadGenerationRef.current;
    shareLoadGenerationRef.current += 1;
    treeRefreshGenerationRef.current += 1;
    gitStatusGenerationRef.current += 1;
    gitLogGenerationRef.current += 1;
    gitBranchesGenerationRef.current += 1;
    fileLoadGenerationRef.current += 1;
    directoryLoadGenerationRef.current.clear();
    pendingDirectoryLoadsRef.current.clear();
    selectedProjectRef.current = name;
    openFileRef.current = null;
    setSelectedProject(name);
    try {
      localStorage.setItem(LAST_SELECTED_PROJECT_KEY, name);
    } catch {}
    setOpenFile(null);
    setOpenMedia(null);
    setTree([]);
    setTreeError(null);
    setTreeLoading(true);
    setExpandedDirs({});
    setModified(false);
    setSelectedDiff(null);
    setCommitDiff(null);
    setGitStatus(null);
    setCommitLog([]);
    setEnhancedCommits([]);
    setBranches([]);
    setShares([]);
    setShareRefreshError(null);
    setShareIsPublic(true);
    setSharePassword('');
    setSharePasswordConfirm('');
    setShareExpiresAt('');
    setShareMaxUses('');
    setShareRateLimitEnabled(false);
    setShareRateLimitMaxRequests('');
    setShareRateLimitWindowSeconds(60);
    setShareCreateError(null);
    setEmailingLinkId(null);
    setShareEmailInput('');
    setShareEmailSuccess(null);
    setActivityLogs([]);
    setDeployStatus('idle');
    setIsRuntimeProject(false);
    deploymentProcessOwnerRef.current = null;
    setDeploymentProcess(null);
    setDeploymentControlError(null);
    try {
      const data = await projectsAPI.getTree(name);
      if (generation !== projectLoadGenerationRef.current || selectedProjectRef.current !== name) return;
      const inventoryProject = projectsRef.current.find((project) => project.name === name);
      if (!inventoryProject || !projectIdentitiesMatch(data.identity, inventoryProject.identity)) {
        throw new Error('The project identity changed while its file tree was loading.');
      }
      setTree(data.tree);
      setExpandedDirs({});
      // The backend reads package metadata and the full source tree. It is the
      // sole authority for runtime/fullstack/static classification; filename
      // guesses here misclassified existing Node and mixed-language projects.
      setIsRuntimeProject(inventoryProject.detectedDeployType === 'runtime');
    } catch (err) {
      if (generation === projectLoadGenerationRef.current && selectedProjectRef.current === name) {
        const extracted = extractError(err, `Loading project "${name}"`);
        console.error(`[Projects] Loading project "${name}" failed:`, err);
        setTreeError(extracted.message);
      }
    } finally {
      if (generation === projectLoadGenerationRef.current && selectedProjectRef.current === name) {
        setTreeLoading(false);
      }
    }
  }, [flushPendingAutoSave, invalidateDeploymentStatusReads, isShareActionInFlight, showErrorToast]);

  useEffect(() => {
    if (!projectDeepLinkPresent || projectDeepLink) return;
    projectDeepLinkSelectionRef.current = null;
    projectDeepLinkFileRef.current = null;
    navigate('/projects', { replace: true });
  }, [navigate, projectDeepLink, projectDeepLinkPresent]);

  useEffect(() => {
    if (loading || !projectDeepLinkPresent || !projectDeepLink) {
      if (!projectDeepLinkPresent) projectDeepLinkSelectionRef.current = null;
      return;
    }
    const targetProject = projects.find((project) => project.name === projectDeepLink.project);
    if (!targetProject || targetProject.availability?.available === false) {
      projectDeepLinkSelectionRef.current = null;
      projectDeepLinkFileRef.current = null;
      navigate('/projects', { replace: true });
      return;
    }
    if (projectOperationRef.current || isShareActionInFlight()) return;
    const targetKey = `${projectDeepLink.project}\u0000${projectDeepLink.file || ''}`;
    if (projectDeepLinkSelectionRef.current === targetKey) return;
    projectDeepLinkSelectionRef.current = targetKey;
    if (selectedProjectRef.current !== projectDeepLink.project) {
      void selectProject(projectDeepLink.project);
    }
  }, [isShareActionInFlight, loading, navigate, projectDeepLink, projectDeepLinkPresent, projectOperation, projects, selectProject, shareActionActive]);

  useEffect(() => {
    if (loading || selectedProject || projectDeepLinkPresent || projectRestoreAttempted.current) return;
    projectRestoreAttempted.current = true;
    try {
      const lastSelected = localStorage.getItem(LAST_SELECTED_PROJECT_KEY);
      if (!lastSelected) return;
      const restorableProject = projects.find(project => project.name === lastSelected);
      if (!restorableProject || restorableProject.availability?.available === false) {
        localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
        return;
      }
      void selectProject(lastSelected);
    } catch {}
  }, [loading, projectDeepLinkPresent, projects, selectProject, selectedProject]);

  const refreshTree = async (projectName = selectedProjectRef.current) => {
    if (!projectName) return;
    const generation = projectLoadGenerationRef.current;
    const refreshGeneration = ++treeRefreshGenerationRef.current;
    const expandedPaths = Object.keys(expandedDirs);
    setTreeLoading(true);
    setTreeError(null);
    try {
      const [data, expandedResults] = await Promise.all([
        projectsAPI.getTree(projectName),
        Promise.all(expandedPaths.map(async (dirPath) => {
          try {
            const result = await projectsAPI.getTree(projectName, dirPath);
            const inventoryProject = projectsRef.current.find((project) => project.name === projectName);
            if (!inventoryProject || !projectIdentitiesMatch(result.identity, inventoryProject.identity)) {
              throw new Error('The project identity changed while a subdirectory was loading.');
            }
            return [dirPath, result.tree] as const;
          } catch (err) {
            console.error(`[Projects] Refreshing subdirectory "${dirPath}" failed:`, err);
            return [dirPath, null] as const;
          }
        })),
      ]);
      if (
        generation !== projectLoadGenerationRef.current
        || refreshGeneration !== treeRefreshGenerationRef.current
        || selectedProjectRef.current !== projectName
      ) return;
      const inventoryProject = projectsRef.current.find((project) => project.name === projectName);
      if (!inventoryProject || !projectIdentitiesMatch(data.identity, inventoryProject.identity)) {
        throw new Error('The project identity changed while its file tree was refreshing.');
      }
      setTree(data.tree);
      const newExpanded: Record<string, TreeEntry[]> = {};
      expandedResults.forEach(([dirPath, entries]) => {
        if (entries) newExpanded[dirPath] = entries;
      });
      setExpandedDirs(newExpanded);
      if (expandedResults.some(([, entries]) => entries === null)) {
        setTreeError('One or more folders could not be refreshed. Try again to reload the file tree.');
      }
    } catch (err) {
      if (
        generation === projectLoadGenerationRef.current
        && refreshGeneration === treeRefreshGenerationRef.current
        && selectedProjectRef.current === projectName
      ) {
        const extracted = extractError(err, 'Refreshing file tree');
        console.error('[Projects] Refreshing file tree failed:', err);
        setTreeError(extracted.message);
      }
    } finally {
      if (
        generation === projectLoadGenerationRef.current
        && refreshGeneration === treeRefreshGenerationRef.current
        && selectedProjectRef.current === projectName
      ) setTreeLoading(false);
    }
  };

  // Git operations
  const loadGitStatus = useCallback(async () => {
    if (!selectedProject) return;
    const projectName = selectedProject;
    const requestGeneration = ++gitStatusGenerationRef.current;
    beginGitLoading();
    try {
      const data = await projectsAPI.git(projectName, 'status');
      if (selectedProjectRef.current === projectName && gitStatusGenerationRef.current === requestGeneration) setGitStatus(data);
    } catch (err) {
      if (selectedProjectRef.current === projectName && gitStatusGenerationRef.current === requestGeneration) {
        showErrorToast(err, 'Loading git status');
      }
    } finally { endGitLoading(); }
  }, [beginGitLoading, endGitLoading, selectedProject, showErrorToast]);

  const loadCommitLog = useCallback(async () => {
    if (!selectedProject) return;
    const projectName = selectedProject;
    const requestGeneration = ++gitLogGenerationRef.current;
    beginGitLoading();
    try {
      const data = await projectsAPI.gitEnhancedLog(projectName, logBranchFilter || undefined);
      if (selectedProjectRef.current !== projectName || gitLogGenerationRef.current !== requestGeneration) return;
      setEnhancedCommits(data.commits || []);
      // Also keep basic log for backwards compat
      setCommitLog((data.commits || []).map((c: EnhancedCommit) => ({ hash: c.hash, short: c.short, author: c.author, email: c.email, date: c.date, message: c.message })));
    } catch {
      if (selectedProjectRef.current !== projectName || gitLogGenerationRef.current !== requestGeneration) return;
      // Fallback to basic log
      try {
        const data = await projectsAPI.git(projectName, 'log');
        if (selectedProjectRef.current !== projectName || gitLogGenerationRef.current !== requestGeneration) return;
        setCommitLog(data.commits || []);
        setEnhancedCommits([]);
      } catch (err2) {
        if (selectedProjectRef.current === projectName && gitLogGenerationRef.current === requestGeneration) {
          showErrorToast(err2, 'Loading commit log');
        }
      }
    } finally { endGitLoading(); }
  }, [beginGitLoading, endGitLoading, logBranchFilter, selectedProject, showErrorToast]);

  const loadBranches = useCallback(async () => {
    if (!selectedProject) return;
    const projectName = selectedProject;
    const requestGeneration = ++gitBranchesGenerationRef.current;
    beginGitLoading();
    try {
      const data = await projectsAPI.git(projectName, 'branches');
      if (selectedProjectRef.current === projectName && gitBranchesGenerationRef.current === requestGeneration) setBranches(data.branches || []);
    } catch (err) {
      if (selectedProjectRef.current === projectName && gitBranchesGenerationRef.current === requestGeneration) {
        showErrorToast(err, 'Loading branches');
      }
    } finally { endGitLoading(); }
  }, [beginGitLoading, endGitLoading, selectedProject, showErrorToast]);

  const loadShares = useCallback(async (requestedProject = selectedProjectRef.current) => {
    if (!requestedProject) return false;
    const projectName = requestedProject;
    const loadGeneration = ++shareLoadGenerationRef.current;
    const ownsShareReadback = () => (
      mountedRef.current
      && selectedProjectRef.current === projectName
      && shareLoadGenerationRef.current === loadGeneration
    );
    try {
      const data = await projectsAPI.listShares(projectName);
      if (!ownsShareReadback()) return false;
      setShares(data.shares || []);
      setShareRefreshError(null);
      return true;
    } catch (err) {
      if (!ownsShareReadback()) return false;
      logError(err, 'Loading shares');
      const extracted = extractError(err, 'Refreshing share links');
      setShares([]);
      setShareRefreshError(`${extracted.message} The list was cleared so stale links cannot be changed. Retry the refresh.`);
      return false;
    }
  }, []);

  const retryLoadShares = useCallback(async () => {
    const projectName = selectedProjectRef.current;
    if (!projectName || shareActionOwnerRef.current) return;
    const owner = Object.freeze({
      kind: 'refresh' as const,
      projectName,
      projectGeneration: projectLoadGenerationRef.current,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimShareAction(owner)) return;
    setShareRefreshing(true);
    try {
      await loadShares(projectName);
    } finally {
      releaseShareAction(owner);
      setShareRefreshing(false);
    }
  }, [claimShareAction, loadShares, releaseShareAction]);

  const loadActivity = useCallback(async () => {
    if (!selectedProject) return;
    const projectName = selectedProject;
    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const resp = await workspaceAuthorizedFetch(`${apiUrl}/projects/${encodeURIComponent(projectName)}/activity?limit=20`, {
        credentials: 'include',
      });
      if (resp.ok) {
        const data = await resp.json();
        if (selectedProjectRef.current === projectName) setActivityLogs(data.logs || []);
      }
    } catch (err) { logError(err, 'Loading activity logs'); }
  }, [selectedProject]);

  const loadDeploymentProcess = useCallback(async (
    requestedProject = selectedProjectRef.current,
    ownerOperation?: ProjectOperation,
  ) => {
    const projectName = requestedProject;
    if (!projectName) return;
    if (selectedProjectRef.current !== projectName) return;
    const activeOperation = projectOperationRef.current;
    if (activeOperation && activeOperation !== ownerOperation) return;
    const projectGeneration = projectLoadGenerationRef.current;
    const inventory = projectsRef.current.find((project) => project.name === projectName);
    if (!inventory?.deployment) {
      invalidateDeploymentStatusReads();
      if (selectedProjectRef.current === projectName) {
        deploymentProcessOwnerRef.current = null;
        setDeploymentProcess(null);
      }
      return;
    }
    const read = Object.freeze({
      generation: ++deploymentStatusGenerationRef.current,
      projectName,
      projectGeneration,
      appId: inventory.deployment.appId,
    });
    // A newly admitted status read is authoritative for this exact App. Drop
    // the previous snapshot synchronously so a failed refresh can never leave
    // stale process controls or logs actionable in the panel.
    deploymentProcessOwnerRef.current = null;
    setDeploymentProcess(null);
    deploymentStatusReadRef.current = read;
    const readIsCurrent = () => (
      mountedRef.current
      && deploymentStatusReadRef.current === read
      && deploymentStatusGenerationRef.current === read.generation
      && selectedProjectRef.current === read.projectName
      && projectLoadGenerationRef.current === read.projectGeneration
      && projectsRef.current.find((project) => project.name === read.projectName)?.deployment?.appId
        === read.appId
    );
    setDeploymentControlBusy((current) => current || 'refresh');
    setDeploymentControlError((current) => (
      current?.recoveryAction === 'UNDEPLOY_CURRENT_DEPLOYMENT'
        ? current
        : null
    ));
    try {
      const status = await projectsAPI.appProcess(projectName, 'status');
      if (!readIsCurrent()) return;
      deploymentProcessOwnerRef.current = Object.freeze({
        projectName: read.projectName,
        projectGeneration: read.projectGeneration,
        appId: read.appId,
      });
      setDeploymentProcess(status);
    } catch (error) {
      if (!readIsCurrent()) return;
      setDeploymentControlError((current) => (
        current?.recoveryAction === 'UNDEPLOY_CURRENT_DEPLOYMENT'
          ? current
          : deploymentControlFailure(error, 'Could not load deployment status')
      ));
    } finally {
      if (deploymentStatusReadRef.current === read) {
        deploymentStatusReadRef.current = null;
        setDeploymentControlBusy((current) => current === 'refresh' ? null : current);
      }
    }
  }, [invalidateDeploymentStatusReads]);

  // Load panel data
  useEffect(() => {
    if (activePanel === 'git' && selectedProject) {
      if (gitTab === 'changes') loadGitStatus();
      else if (gitTab === 'log') { loadCommitLog(); loadBranches(); }
      else if (gitTab === 'branches') loadBranches();
    }
    if (activePanel === 'share' && selectedProject) loadShares();
    if (activePanel === 'activity' && selectedProject) loadActivity();
    if (activePanel === 'deployment' && selectedProject) void loadDeploymentProcess(selectedProject);
  }, [activePanel, gitTab, loadActivity, loadBranches, loadCommitLog, loadDeploymentProcess, loadGitStatus, loadShares, selectedProject]);

  const viewFileDiff = async (filePath: string) => {
    if (!selectedProject) return;
    const projectName = selectedProject;
    try {
      const data = await projectsAPI.git(projectName, 'diff', { file: filePath });
      if (selectedProjectRef.current === projectName) {
        setSelectedDiff({ file: filePath, content: data.output || 'No changes' });
      }
    } catch (err) { showErrorToast(err, `Viewing diff for ${filePath}`); }
  };

  const viewCommitDiff = async (hash: string) => {
    if (!selectedProject) return;
    const projectName = selectedProject;
    try {
      const data = await projectsAPI.git(projectName, 'diff-commit', { hash });
      if (selectedProjectRef.current === projectName) {
        setCommitDiff({ hash, output: data.output, diff: data.diff });
      }
    } catch (err) { showErrorToast(err, `Viewing commit diff ${hash.substring(0, 7)}`); }
  };

  const handleRevert = async () => {
    if (!selectedProject || !revertTarget || reverting || gitLoadingCountRef.current > 0) return;
    const target = Object.freeze({ hash: revertTarget.hash, message: revertTarget.message });
    const operation = claimGitMutation('revert', target.hash);
    if (!operation) return;
    setReverting(true);
    setRevertResult(null);
    try {
      const data = await projectsAPI.gitRevert(operation.projectName, target.hash);
      const newHash = typeof data?.newHash === 'string' ? data.newHash.trim() : '';
      if (!newHash) throw new Error('Git did not return the new revert commit identity.');
      const [, freshLog] = await Promise.all([
        verifyGitMutation(operation),
        projectsAPI.gitEnhancedLog(operation.projectName, undefined, 25),
      ]);
      const commits = (freshLog?.commits || []) as EnhancedCommit[];
      if (!commits.some((commit) => commit.hash === newHash)) {
        throw new Error('The fresh Git history did not confirm the revert commit.');
      }
      setEnhancedCommits(commits);
      setCommitLog(commits.map((commit) => ({
        hash: commit.hash,
        short: commit.short,
        author: commit.author,
        email: commit.email,
        date: commit.date,
        message: commit.message,
      })));
      await refreshTree(operation.projectName);
      setRevertResult({ success: true, message: `Reverted "${target.message}" — new commit: ${newHash.substring(0, 7)}` });
    } catch (e: any) {
      const msg = e.response?.data?.error || e.message || 'Revert failed';
      setRevertResult({ success: false, message: msg });
    } finally {
      setReverting(false);
      releaseGitMutation(operation);
    }
  };

  // --- File Operations ---
  const toggleDir = async (dirPath: string) => {
    if (expandedDirs[dirPath]) {
      directoryLoadGenerationRef.current.set(dirPath, (directoryLoadGenerationRef.current.get(dirPath) || 0) + 1);
      pendingDirectoryLoadsRef.current.delete(dirPath);
      const next = { ...expandedDirs };
      delete next[dirPath];
      setExpandedDirs(next);
    } else {
      const existingGeneration = directoryLoadGenerationRef.current.get(dirPath);
      if (pendingDirectoryLoadsRef.current.has(dirPath)) {
        directoryLoadGenerationRef.current.set(dirPath, (existingGeneration || 0) + 1);
        pendingDirectoryLoadsRef.current.delete(dirPath);
        return;
      }
      const generation = (existingGeneration || 0) + 1;
      directoryLoadGenerationRef.current.set(dirPath, generation);
      pendingDirectoryLoadsRef.current.add(dirPath);
      const projectName = selectedProjectRef.current;
      if (!projectName) return;
      try {
        const data = await projectsAPI.getTree(projectName, dirPath);
        const inventoryProject = projectsRef.current.find((project) => project.name === projectName);
        if (!inventoryProject || !projectIdentitiesMatch(data.identity, inventoryProject.identity)) {
          throw new Error('The project identity changed while a directory was opening.');
        }
        if (
          selectedProjectRef.current === projectName
          && directoryLoadGenerationRef.current.get(dirPath) === generation
        ) {
          setExpandedDirs(prev => ({ ...prev, [dirPath]: data.tree }));
        }
      } catch (err) {
        console.error(`[Projects] Expanding directory "${dirPath}" failed:`, err);
        if (selectedProjectRef.current === projectName) {
          const extracted = extractError(err, `Opening folder "${dirPath}"`);
          setTreeError(extracted.message);
        }
      }
      finally {
        if (directoryLoadGenerationRef.current.get(dirPath) === generation) {
          pendingDirectoryLoadsRef.current.delete(dirPath);
        }
      }
    }
  };

  const openFileHandler = async (filePath: string, preserveDeepLink = false) => {
    if (projectOperationRef.current) return;
    if (!preserveDeepLink && projectDeepLinkPresent) {
      navigate('/projects', { replace: true });
    }
    const previousProject = selectedProjectRef.current;
    const previousFile = openFileRef.current;
    if (!previousProject) return;
    try {
      await flushPendingAutoSave();
      if (previousFile) {
        await fileWriteQueueRef.current.waitFor(previousProject, previousFile.path);
      }
    } catch (error) {
      showErrorToast(error, `Saving ${previousFile?.path || 'the open file'} before opening another file`);
      return;
    }
    if (projectOperationRef.current) return;
    const projectName = selectedProjectRef.current;
    if (!projectName) return;
    const generation = ++fileLoadGenerationRef.current;
    setSelectedDiff(null);
    setCommitDiff(null);
    
    const category = getFileCategory(filePath);
    if (category !== 'code') {
      // Media/binary file — use raw endpoint
      openFileRef.current = null;
      setOpenFile(null);
      setOpenMedia({
        path: filePath,
        category,
        url: getProjectRawUrl(projectName, filePath),
      });
      setModified(false);
      return;
    }
    
    // Code/text file — use existing text endpoint
    setOpenMedia(null);
    try {
      const data = await projectsAPI.readFile(projectName, filePath);
      if (
        generation !== fileLoadGenerationRef.current
        || selectedProjectRef.current !== projectName
      ) return;
      const nextOpenFile = { path: filePath, content: data.content, language: data.language };
      openFileRef.current = nextOpenFile;
      editorContentRef.current = data.content;
      editorRevisionRef.current += 1;
      setOpenFile(nextOpenFile);
      setEditorContent(data.content);
      setModified(false);
    } catch (err: any) {
      const tooLarge = err?.response?.status === 413;
      if (tooLarge && generation === fileLoadGenerationRef.current && selectedProjectRef.current === projectName) {
        openFileRef.current = null;
        setOpenFile(null);
        setOpenMedia({
          path: filePath,
          category: 'text',
          url: getProjectRawUrl(projectName, filePath, { mode: 'text' }),
          note: 'Preview only, this file is larger than the 10MB inline editor limit.',
        });
        setModified(false);
        showToast('Opened in read-only preview mode because the file is larger than 10MB.', 'info');
        return;
      }
      if (generation === fileLoadGenerationRef.current && selectedProjectRef.current === projectName) {
        showErrorToast(err, `Opening file: ${filePath}`);
      }
    }
  };
  openFileHandlerRef.current = openFileHandler;

  const saveFile = async () => {
    const projectName = selectedProjectRef.current;
    const currentFile = openFileRef.current;
    if (!projectName || !currentFile) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    pendingAutoSaveRef.current = null;
    const write: ProjectFileWrite = {
      projectName,
      filePath: currentFile.path,
      content: editorContentRef.current,
      revision: editorRevisionRef.current,
    };
    setSaving(true);
    try {
      await persistProjectFile(write);
      showToast(`Saved ${write.filePath}`);
      await refreshTree(write.projectName);
    } catch (err) { showErrorToast(err, `Saving file: ${write.filePath}`); } finally { setSaving(false); }
  };

  // Auto-save: debounce 2s after typing
  const handleEditorChange = (val: string | undefined) => {
    const newVal = val || '';
    editorContentRef.current = newVal;
    editorRevisionRef.current += 1;
    setEditorContent(newVal);
    setModified(newVal !== openFile?.content);
    // Auto-save after 2s of no typing
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (newVal !== openFile?.content) {
      const projectName = selectedProjectRef.current;
      const currentFile = openFileRef.current;
      if (!projectName || !currentFile) return;
      const write: ProjectFileWrite = {
        projectName,
        filePath: currentFile.path,
        content: newVal,
        revision: editorRevisionRef.current,
      };
      pendingAutoSaveRef.current = write;
      autoSaveTimerRef.current = setTimeout(() => {
        autoSaveTimerRef.current = null;
        if (pendingAutoSaveRef.current === write) pendingAutoSaveRef.current = null;
        void persistProjectFile(write).catch((err) => showErrorToast(err, `Auto-saving ${write.filePath}`));
      }, 2000);
    } else {
      pendingAutoSaveRef.current = null;
    }
  };

  const handleZipSelect = (file: File) => {
    if (file.size > PROJECT_ZIP_MAX_BYTES) {
      setZipFile(null);
      showToast('Project ZIP files are limited to 200MB.', 'error');
      return;
    }
    setZipFile(file);
    if (!newName.trim()) {
      setNewName(file.name.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-'));
    }
  };

  const uploadZipProject = async () => {
    if (!zipFile || !newName.trim() || zipUploadXhrRef.current) return;
    if (zipFile.size > PROJECT_ZIP_MAX_BYTES) {
      showToast('Project ZIP files are limited to 200MB.', 'error');
      return;
    }
    setZipUploading(true);
    setUploadProgress('Uploading...');
    const apiUrl = import.meta.env.VITE_API_URL || '';

    try {
      const result = await new Promise<any>((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', zipFile);
        formData.append('name', newName);
        const xhr = new XMLHttpRequest();
        zipUploadXhrRef.current = xhr;
        xhr.open('POST', `${apiUrl}/projects/upload-zip`);
        const authorizationBinding = bindWorkspaceAuthorizationToXhr(xhr);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(`Uploading... ${percent}%`);
          }
        };
        xhr.onload = () => {
          try {
            authorizationBinding.validateResponse();
          } catch (error) {
            reject(error);
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress('Extracting & setting up...');
            try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
          } else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || 'Upload failed')); }
            catch { reject(new Error('Upload failed')); }
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
        xhr.onloadend = () => {
          authorizationBinding.dispose();
          if (zipUploadXhrRef.current === xhr) zipUploadXhrRef.current = null;
        };
        xhr.send(formData);
      });

      setShowCreate(false);
      setNewName('');
      setZipFile(null);
      setUploadProgress(null);
      if (result.detectedType && result.detectedType !== 'unknown') {
        showToast(`Project created (${result.detectedType}) — run: ${result.suggestedCommand}`);
      } else {
        showToast('Project created from ZIP');
      }
      await loadProjects();
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToast(err.message || 'Failed to upload ZIP', 'error');
      setUploadProgress(null);
    } finally {
      zipUploadXhrRef.current = null;
      setZipUploading(false);
    }
  };

  const createProject = async () => {
    const requestedName = newName.trim();
    const requestedCloneUrl = cloneUrl.trim();
    if (!requestedName) return;
    if (createMode === 'zip') { await uploadZipProject(); return; }
    if (createMode === 'clone' && !requestedCloneUrl) return;
    if (createProjectInFlightRef.current) return;
    createProjectInFlightRef.current = true;
    setCreating(true);
    try {
      if (createMode === 'clone') {
        await projectsAPI.clone(requestedCloneUrl, requestedName);
      } else {
        await projectsAPI.create(requestedName, template);
      }
      setShowCreate(false);
      setNewName('');
      setCloneUrl('');
      await loadProjects();
      showToast('Project created');
    } catch (err) { showErrorToast(err, 'Creating project'); } finally {
      createProjectInFlightRef.current = false;
      setCreating(false);
    }
  };

  const requestDeleteProject = (name: string) => {
    if (projectOperationRef.current || deleteInFlightRef.current) return;
    const project = projectsRef.current.find((entry) => entry.name === name);
    if (
      !project?.destructiveActions.allowed
      || !projectLifecycleActionAllowed(project, 'delete-project')
    ) return;
    setDeleteError(null);
    setPendingDelete({
      kind: 'project',
      name,
      projectName: name,
      identity: project.identity,
    });
  };

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState('');
  const [renameProjectError, setRenameProjectError] = useState<string | null>(null);
  const [renameProjectPhase, setRenameProjectPhase] = useState<ProjectRenamePhase>('idle');

  const isMountedProjectRenameOwner = useCallback((operation: ProjectOperation) => (
    mountedRef.current
    && projectRenameInFlightRef.current === operation
    && projectOperationRef.current === operation
    && isRouteOperationOwner(operation)
  ), []);

  const blockProjectRenameStorageRecovery = useCallback((
    operation: ProjectOperation,
    action: 'persist' | 'retire',
    recovery: ProjectRenameStorageBlock['recovery'],
  ) => {
    if (!isMountedProjectRenameOwner(operation)) return false;
    projectRenameStorageBlockRef.current = Object.freeze({ operation, recovery });
    setRenameProjectPhase('storage-blocked');
    setRenameProjectError(action === 'persist' && recovery === 'safe-release'
      ? 'Portal could not verify the provisional rename recovery record, so it did not submit the rename. The operation remains locked until Portal can prove that provisional record is retired.'
      : action === 'persist'
        ? 'Portal cannot verify that this admitted rename recovery record is durable. The rename remains locked and will not be submitted again. Restore browser local storage, then retry recovery.'
        : 'Portal proved the rename outcome but could not verify retirement of its recovery record. The rename remains locked. Restore browser local storage, then retry recovery.');
    return true;
  }, [isMountedProjectRenameOwner]);

  const startRenameProject = async (name: string) => {
    if (projectOperationRef.current) return;
    const sourceProject = projectsRef.current.find((project) => project.name === name);
    if (
      !sourceProject?.destructiveActions.allowed
      || !projectLifecycleActionAllowed(sourceProject, 'rename-project')
    ) return;
    // The operation owner is bound to the selected project. A rename dialog
    // opened from an unselected row must operate on that row's project, so
    // select it before arming anything.
    if (selectedProjectRef.current !== name) {
      await selectProject(name);
      if (selectedProjectRef.current !== name) return;
    }
    if (projectOperationRef.current) return;
    projectRenameInFlightRef.current = null;
    projectRenameRequestActiveRef.current = false;
    projectRenameStorageBlockRef.current = null;
    projectRenameRetryBoundaryRef.current = 'none';
    const actorId = projectActorIdRef.current;
    const storedInventory = actorId
      ? listStoredProjectRenameAttempts(actorId)
      : { status: 'available' as const, attempts: [] };
    const stored = storedInventory.attempts.find((attempt) => (
      attempt.identity.id === sourceProject.identity.id
    ));
    if (stored) {
      const operation = Object.freeze({
        kind: 'rename' as const,
        projectName: name,
        projectGeneration: projectLoadGenerationRef.current,
        token: ++projectOperationTokenRef.current,
        renameSourceName: stored.sourceName,
        renameTargetName: stored.targetName,
        renameAttemptId: stored.attemptId,
        renameIdentity: stored.identity,
      });
      if (!claimProjectOperation(operation)) return;
      projectRenameInFlightRef.current = operation;
      setRenameProjectPhase('indeterminate');
      setRenameProjectError('This project has an interrupted rename. Check its saved status before starting another rename.');
      setRenamingProject(stored.sourceName);
      setRenameProjectValue(stored.targetName);
      return;
    }
    setRenameProjectPhase('idle');
    setRenameProjectError(null);
    setRenamingProject(name);
    setRenameProjectValue(name);
  };

  const dismissRenameProject = () => {
    if (projectRenameRequestActiveRef.current) return;
    const operation = projectRenameInFlightRef.current;
    projectRenameInFlightRef.current = null;
    projectRenameStorageBlockRef.current = null;
    projectRenameRetryBoundaryRef.current = 'none';
    if (operation) releaseProjectOperation(operation);
    setRenameProjectPhase('idle');
    setRenameProjectError(null);
    setRenamingProject(null);
  };

  const reconcileProjectRename = async (operation: ProjectOperation) => {
    const oldName = operation.renameSourceName!;
    const newName = operation.renameTargetName!;
    const identity = operation.renameIdentity!;
    const committedIdentity: ProjectIdentityProof = {
      id: identity.id,
      generation: identity.generation + 1,
    };
    if (!Number.isSafeInteger(committedIdentity.generation)) {
      throw new Error('The admitted Project identity generation cannot be advanced safely.');
    }
    const inventory = await projectsAPI.list();
    const source = inventory.projects.find((project) => project.name === oldName);
    const target = inventory.projects.find((project) => project.name === newName);

    if (!source && target && projectIdentitiesMatch(target.identity, committedIdentity)) {
      const treeReadback = await projectsAPI.getTree(newName);
      if (!projectIdentitiesMatch(treeReadback.identity, committedIdentity) || treeReadback.currentPath !== '') {
        throw new Error('The renamed project tree did not prove the admitted immutable project identity.');
      }
      return { status: 'committed' as const, projects: inventory.projects, tree: treeReadback.tree };
    }

    if (
      source
      && !target
      && projectIdentitiesMatch(source.identity, identity)
      && source.destructiveActions.allowed
    ) {
      // The server only re-enables destructive actions after the durable
      // lifecycle journal is ACTIVE again. That makes an unchanged identity,
      // original namespace, and enabled lifecycle controls authoritative
      // rollback proof after expired-lease recovery—not an ambiguous snapshot.
      return { status: 'rolled-back' as const, projects: inventory.projects };
    }

    if (source && !target && projectIdentitiesMatch(source.identity, identity)) {
      return { status: 'indeterminate' as const };
    }

    throw new Error('The project namespace does not provide authoritative proof for this rename attempt.');
  };

  const completeProjectRename = (
    operation: ProjectOperation,
    result: Readonly<{ projects: Project[]; tree: TreeEntry[] }>,
  ): boolean => {
    if (
      !isMountedProjectRenameOwner(operation)
      || selectedProjectRef.current !== operation.projectName
      || projectLoadGenerationRef.current !== operation.projectGeneration
    ) return false;
    const oldName = operation.renameSourceName!;
    const newName = operation.renameTargetName!;
    const actorId = projectActorIdRef.current;
    if (!actorId) {
      blockProjectRenameStorageRecovery(operation, 'retire', 'reconcile');
      return false;
    }
    const retirement = clearStoredProjectRenameAttempt(actorId, operation);
    if (!isMountedProjectRenameOwner(operation)) return false;
    if (retirement.status !== 'retired') {
      blockProjectRenameStorageRecovery(operation, 'retire', 'reconcile');
      return false;
    }
    projectRenameStorageBlockRef.current = null;
    projectsRef.current = result.projects;
    setProjects(result.projects);
    try {
      if (localStorage.getItem(`agent-active-${oldName}`) === 'true') {
        localStorage.setItem(`agent-active-${newName}`, 'true');
        localStorage.removeItem(`agent-active-${oldName}`);
      }
    } catch (error) {
      logError(error, 'Updating optional renamed-project activity preference');
    }
    if (selectedProjectRef.current === oldName) {
      projectLoadGenerationRef.current += 1;
      treeRefreshGenerationRef.current += 1;
      fileLoadGenerationRef.current += 1;
      selectedProjectRef.current = newName;
      setSelectedProject(newName);
      setTree(result.tree);
      try {
        localStorage.setItem(LAST_SELECTED_PROJECT_KEY, newName);
      } catch (error) {
        logError(error, 'Updating optional last-selected project preference');
      }
    }
    projectRenameRequestActiveRef.current = false;
    projectRenameInFlightRef.current = null;
    releaseProjectOperation(operation);
    setRenameProjectPhase('idle');
    setRenamingProject(null);
    setRenameProjectError(null);
    showToast(`Renamed to "${newName}"`);
    return true;
  };

  const completeRolledBackProjectRename = (
    operation: ProjectOperation,
    projects: Project[],
  ): boolean => {
    if (!isMountedProjectRenameOwner(operation)) return false;
    const actorId = projectActorIdRef.current;
    if (!actorId) {
      blockProjectRenameStorageRecovery(operation, 'retire', 'reconcile');
      return false;
    }
    const retirement = clearStoredProjectRenameAttempt(actorId, operation);
    if (!isMountedProjectRenameOwner(operation)) return false;
    if (retirement.status !== 'retired') {
      blockProjectRenameStorageRecovery(operation, 'retire', 'reconcile');
      return false;
    }
    projectRenameStorageBlockRef.current = null;
    projectsRef.current = projects;
    setProjects(projects);
    projectRenameRequestActiveRef.current = false;
    projectRenameInFlightRef.current = null;
    releaseProjectOperation(operation);
    setRenameProjectPhase('not-admitted');
    setRenameProjectError(
      'The interrupted rename was restored automatically. You may deliberately try the rename again.',
    );
    return true;
  };

  const retainIndeterminateProjectRename = (operation: ProjectOperation, error?: unknown) => {
    if (!isMountedProjectRenameOwner(operation)) return false;
    const actorId = projectActorIdRef.current;
    if (!actorId) return blockProjectRenameStorageRecovery(operation, 'persist', 'reconcile');
    const persistence = persistProjectRenameAttempt(actorId, operation);
    if (!isMountedProjectRenameOwner(operation)) return false;
    if (persistence.status !== 'persisted') {
      return blockProjectRenameStorageRecovery(operation, 'persist', 'reconcile');
    }
    projectRenameStorageBlockRef.current = null;
    const detail = error ? extractError(error, 'Reconciling project rename').message : '';
    setRenameProjectPhase('indeterminate');
    setRenameProjectError(
      `Portal cannot yet prove whether this rename committed. It will not submit the rename again. ${detail}`.trim(),
    );
    return true;
  };

  const reconcileOwnedProjectRename = async (operation: ProjectOperation) => {
    if (projectRenameRequestActiveRef.current || !isMountedProjectRenameOwner(operation)) return;
    projectRenameRequestActiveRef.current = true;
    setRenameProjectPhase('reconciling');
    setRenameProjectError(null);
    try {
      const result = await reconcileProjectRename(operation);
      if (!isMountedProjectRenameOwner(operation)) return;
      if (result.status === 'committed') {
        completeProjectRename(operation, result);
        return;
      }
      if (result.status === 'rolled-back') {
        completeRolledBackProjectRename(operation, result.projects);
        return;
      }
      retainIndeterminateProjectRename(operation);
    } catch (error) {
      if (!isMountedProjectRenameOwner(operation)) return;
      logError(error, 'Reconciling project rename');
      retainIndeterminateProjectRename(operation, error);
    } finally {
      if (isMountedProjectRenameOwner(operation)) {
        projectRenameRequestActiveRef.current = false;
      }
    }
  };
  reconcileOwnedProjectRenameRef.current = reconcileOwnedProjectRename;

  const retryPreAdmissionProjectRenameRelease = (operation: ProjectOperation) => {
    if (!isMountedProjectRenameOwner(operation)) return;
    const storageBlock = projectRenameStorageBlockRef.current;
    if (storageBlock?.operation !== operation || storageBlock.recovery !== 'safe-release') return;
    projectRenameRequestActiveRef.current = true;
    setRenameProjectPhase('reconciling');
    setRenameProjectError(null);
    const actorId = projectActorIdRef.current;
    const retirement = actorId
      ? clearStoredProjectRenameAttempt(actorId, operation)
      : { status: 'unavailable' as const };
    if (!isMountedProjectRenameOwner(operation)) return;
    projectRenameRequestActiveRef.current = false;
    if (retirement.status !== 'retired') {
      blockProjectRenameStorageRecovery(operation, 'retire', 'safe-release');
      return;
    }
    projectRenameStorageBlockRef.current = null;
    projectRenameInFlightRef.current = null;
    // Retiring a provisional pre-admission record and admitting a new rename
    // must never be two clicks from the same double-activation sequence. The
    // next activation only arms a new attempt; a later deliberate activation
    // is required before any PATCH can leave the browser.
    projectRenameRetryBoundaryRef.current = 'confirm';
    setRenameProjectPhase('recovery-retired');
    setRenameProjectError('No rename request was admitted. Recovery storage is available again. Confirm that you want to arm a new rename attempt.');
    releaseProjectOperation(operation);
  };

  const submitRenameProject = async () => {
    if (projectRenameRequestActiveRef.current) return;
    if (
      !projectRenameInFlightRef.current
      && projectRenameRetryBoundaryRef.current === 'confirm'
    ) {
      projectRenameRetryBoundaryRef.current = 'armed';
      setRenameProjectPhase('not-admitted');
      setRenameProjectError('A new rename attempt is armed. Choose Try rename again to submit it.');
      return;
    }
    const oldName = renamingProject;
    const newName = renameProjectValue.trim();
    if (!oldName || !newName) {
      setRenameProjectError('Enter a project name.');
      return;
    }
    if (newName === oldName) {
      setRenamingProject(null);
      setRenameProjectError(null);
      return;
    }
    if (!isCanonicalProjectName(newName)) {
      setRenameProjectError('Use a project name without reserved path characters and no more than 120 characters.');
      return;
    }
    const existingAttempt = projectRenameInFlightRef.current;
    if (existingAttempt) {
      if (
        existingAttempt.renameSourceName !== oldName
        || existingAttempt.renameTargetName !== newName
        || (renameProjectPhase !== 'indeterminate' && renameProjectPhase !== 'storage-blocked')
      ) return;
      if (
        renameProjectPhase === 'storage-blocked'
        && projectRenameStorageBlockRef.current?.operation === existingAttempt
        && projectRenameStorageBlockRef.current.recovery === 'safe-release'
      ) {
        retryPreAdmissionProjectRenameRelease(existingAttempt);
        return;
      }
      await reconcileOwnedProjectRename(existingAttempt);
      return;
    }
    const sourceProject = projectsRef.current.find((project) => project.name === oldName);
    if (!sourceProject) {
      setRenameProjectError('The source project is no longer present in the verified project inventory.');
      return;
    }
    if (!projectLifecycleActionAllowed(sourceProject, 'rename-project')) {
      setRenameProjectError('This deployment is externally managed, so Portal cannot safely rename its Project.');
      return;
    }
    // The dialog owns exactly the project it was opened for; the operation is
    // never rebound to whichever project happens to be globally selected.
    const operation = Object.freeze({
      kind: 'rename' as const,
      projectName: oldName,
      projectGeneration: projectLoadGenerationRef.current,
      token: ++projectOperationTokenRef.current,
      renameSourceName: oldName,
      renameTargetName: newName,
      renameAttemptId: globalThis.crypto.randomUUID(),
      renameIdentity: Object.freeze({ ...sourceProject.identity }),
    });
    if (!claimProjectOperation(operation)) {
      setRenameProjectError('Another project operation is in progress. Finish it, then try the rename again.');
      return;
    }
    projectRenameRetryBoundaryRef.current = 'none';
    projectRenameInFlightRef.current = operation;
    projectRenameRequestActiveRef.current = true;
    setRenameProjectPhase('submitting');
    setRenameProjectError(null);
    let submitted = false;
    let terminalNonAdmission = false;
    try {
      if (selectedProjectRef.current === oldName && openFileRef.current) {
        await flushPendingAutoSave();
        if (!isMountedProjectRenameOwner(operation)) return;
        await fileWriteQueueRef.current.waitFor(oldName, openFileRef.current.path);
        if (!isMountedProjectRenameOwner(operation)) return;
      }
      const currentSourceProject = projectsRef.current.find((project) => project.name === oldName);
      if (
        !currentSourceProject
        || !projectIdentitiesMatch(currentSourceProject.identity, operation.renameIdentity!)
        || !projectLifecycleActionAllowed(currentSourceProject, 'rename-project')
      ) {
        throw new Error('The Project deployment no longer permits rename. Refresh Projects and review its deployment manager.');
      }
      const preflight = await projectsAPI.getTree(oldName);
      if (!isMountedProjectRenameOwner(operation)) return;
      if (
        preflight.currentPath !== ''
        || !projectIdentitiesMatch(preflight.identity, operation.renameIdentity!)
      ) {
        throw new Error('The project identity changed before rename admission.');
      }
      const actorId = projectActorIdRef.current;
      if (!actorId) throw new Error('The authenticated project owner is unavailable.');
      // Persist before admission. A refresh in the following instruction gap
      // must conservatively reconcile this exact attempt, never create another.
      const persistence = persistProjectRenameAttempt(actorId, operation);
      if (!isMountedProjectRenameOwner(operation)) return;
      if (persistence.status !== 'persisted') {
        blockProjectRenameStorageRecovery(operation, 'persist', 'safe-release');
        return;
      }
      submitted = true;
      await projectsAPI.rename(oldName, newName, {
        attemptId: operation.renameAttemptId!,
        identity: operation.renameIdentity!,
      });
      if (!isMountedProjectRenameOwner(operation)) return;
      const result = await reconcileProjectRename(operation);
      if (!isMountedProjectRenameOwner(operation)) return;
      if (result.status === 'committed') {
        completeProjectRename(operation, result);
        return;
      }
      if (result.status === 'rolled-back') {
        completeRolledBackProjectRename(operation, result.projects);
        return;
      }
      retainIndeterminateProjectRename(operation);
    } catch (err) {
      if (!isMountedProjectRenameOwner(operation)) return;
      if (!submitted || isAuthoritativeRenameNonAdmission(err, operation.renameAttemptId!)) {
        const actorId = projectActorIdRef.current;
        const retirement = actorId
          ? clearStoredProjectRenameAttempt(actorId, operation)
          : { status: 'unavailable' as const };
        if (!isMountedProjectRenameOwner(operation)) return;
        if (retirement.status !== 'retired') {
          blockProjectRenameStorageRecovery(operation, 'retire', 'safe-release');
          return;
        }
        projectRenameStorageBlockRef.current = null;
        terminalNonAdmission = true;
        const extracted = extractError(err, 'Renaming project');
        logError(err, 'Project rename was not admitted');
        setRenameProjectPhase('not-admitted');
        setRenameProjectError(`${extracted.message} You may deliberately try the rename again.`);
      } else {
        logError(err, 'Project rename response was indeterminate');
        try {
          const result = await reconcileProjectRename(operation);
          if (!isMountedProjectRenameOwner(operation)) return;
          if (result.status === 'committed') {
            completeProjectRename(operation, result);
            return;
          }
          if (result.status === 'rolled-back') {
            completeRolledBackProjectRename(operation, result.projects);
            return;
          }
          retainIndeterminateProjectRename(operation, err);
        } catch (reconcileError) {
          if (!isMountedProjectRenameOwner(operation)) return;
          logError(reconcileError, 'Project rename reconciliation failed');
          retainIndeterminateProjectRename(operation, reconcileError);
        }
      }
    } finally {
      if (isMountedProjectRenameOwner(operation)) {
        projectRenameRequestActiveRef.current = false;
        if (terminalNonAdmission) {
          projectRenameInFlightRef.current = null;
          releaseProjectOperation(operation);
        }
      }
    }
  };

  useEffect(() => {
    if (loading || !selectedProject || projectOperationRef.current || deleteInFlightRef.current) return;
    const selectedInventoryProject = projects.find((project) => project.name === selectedProject);
    if (!selectedInventoryProject) return;
    const storedIndex = restoredRenameAttemptsRef.current.findIndex((attempt) => (
      attempt.identity.id === selectedInventoryProject.identity.id
    ));
    if (storedIndex === -1) return;
    const stored = restoredRenameAttemptsRef.current[storedIndex];
    const operation = Object.freeze({
      kind: 'rename' as const,
      projectName: selectedProject,
      projectGeneration: projectLoadGenerationRef.current,
      token: ++projectOperationTokenRef.current,
      renameSourceName: stored.sourceName,
      renameTargetName: stored.targetName,
      renameAttemptId: stored.attemptId,
      renameIdentity: stored.identity,
    });
    if (!claimProjectOperation(operation)) return;
    restoredRenameAttemptsRef.current.splice(storedIndex, 1);
    projectRenameInFlightRef.current = operation;
    setRenamingProject(stored.sourceName);
    setRenameProjectValue(stored.targetName);
    setRenameProjectPhase('indeterminate');
    setRenameProjectError('Recovering an interrupted rename. Portal will only reconcile the admitted attempt.');
    void reconcileOwnedProjectRenameRef.current(operation);
  }, [claimProjectOperation, loading, projects, selectedProject]);

  const [deleteBusy, setDeleteBusy] = useState(false);

  const doDelete = async () => {
    if (!pendingDelete || deleteInFlightRef.current) return;
    const request = pendingDelete.kind === 'project'
      ? Object.freeze({
        kind: 'project' as const,
        name: pendingDelete.name,
        projectName: pendingDelete.projectName,
        identity: pendingDelete.identity,
      })
      : pendingDelete.path
        ? Object.freeze({
          kind: 'file' as const,
          name: pendingDelete.name,
          projectName: pendingDelete.projectName,
          path: pendingDelete.path,
        })
        : null;
    if (!request) return;
    if (request.kind === 'project') {
      const currentProjectForDelete = projectsRef.current.find((project) => project.name === request.projectName);
      if (
        !currentProjectForDelete?.destructiveActions.allowed
        || !projectLifecycleActionAllowed(currentProjectForDelete, 'delete-project')
      ) {
        setDeleteError('This deployment is externally managed, so Portal cannot safely delete its Project.');
        return;
      }
      if (
        currentProjectForDelete.identity.id !== request.identity.id
        || currentProjectForDelete.identity.generation !== request.identity.generation
      ) {
        setDeleteError('The Project identity changed. Refresh Projects before deleting it.');
        return;
      }
    }
    if (!claimRouteOperation(request)) return;
    deleteInFlightRef.current = request;
    acquireProjectNavigationLock();
    setDeleteBusy(true);
    setDeleteError(null);
    let completed = false;
    if (request.kind === 'project') {
      try {
        if (selectedProjectRef.current === request.projectName && openFileRef.current) {
          await flushPendingAutoSave();
          await fileWriteQueueRef.current.waitFor(request.projectName, openFileRef.current.path);
        }
        const currentProjectForDelete = projectsRef.current.find((project) => (
          project.name === request.projectName
        ));
        if (
          !currentProjectForDelete
          || currentProjectForDelete.identity.id !== request.identity.id
          || currentProjectForDelete.identity.generation !== request.identity.generation
        ) {
          throw new Error('The Project identity changed. Refresh Projects before deleting it.');
        }
        await awaitProjectDeleteSettle(
          request.projectName,
          (name) => projectsAPI.delete(name, request.identity),
          {
            onWaiting: (waitMs) => {
              if (deleteInFlightRef.current !== request) return;
              setDeleteError(null);
              setDeleteSettleNotice(
                `Still finishing a chat turn — deleting as soon as it settles (retrying in ${Math.max(1, Math.ceil(waitMs / 1000))}s)…`,
              );
            },
          },
        );
        setDeleteSettleNotice(null);
        if (selectedProjectRef.current === request.projectName) {
          // The Agent panel must not keep polling a project that no longer
          // exists — that surfaced as "cannot find project" errors.
          if (agentChatOpen) closeAgentChat();
          selectedProjectRef.current = null;
          openFileRef.current = null;
          projectLoadGenerationRef.current += 1;
          treeRefreshGenerationRef.current += 1;
          fileLoadGenerationRef.current += 1;
          setSelectedProject(null);
          setOpenFile(null);
          localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
        }
        await loadProjects();
        showToast('Project deleted');
        completed = true;
      } catch (err) {
        setDeleteSettleNotice(null);
        setDeleteError((err as any)?.response?.data?.error || (err as any)?.message || `Could not delete project "${request.name}".`);
        showErrorToast(err, `Deleting project "${request.name}"`);
      }
    } else {
      try {
        const currentOpenPath = openFileRef.current?.path;
        const removesOpenFile = Boolean(currentOpenPath && (
          currentOpenPath === request.path
          || currentOpenPath.startsWith(`${request.path}/`)
        ));
        await flushPendingAutoSave();
        if (currentOpenPath) await fileWriteQueueRef.current.waitFor(request.projectName, currentOpenPath);
        await projectsAPI.deleteFile(request.projectName, request.path);
        if (removesOpenFile && selectedProjectRef.current === request.projectName) {
          fileLoadGenerationRef.current += 1;
          openFileRef.current = null;
          setOpenFile(null);
          setModified(false);
        }
        if (openMedia && (openMedia.path === request.path || openMedia.path.startsWith(`${request.path}/`))) {
          setOpenMedia(null);
        }
        await refreshTree(request.projectName);
        showToast('Deleted');
        completed = true;
      } catch (err) {
        setDeleteError((err as any)?.response?.data?.error || (err as any)?.message || `Could not delete "${request.path}".`);
        showErrorToast(err, `Deleting file "${request.path}"`);
      }
    }
    if (deleteInFlightRef.current === request) {
      deleteInFlightRef.current = null;
      releaseProjectNavigationLock();
      releaseRouteOperation(request);
      setDeleteBusy(false);
      if (completed) setPendingDelete(null);
    }
  };

  const commitChanges = async () => {
    const message = commitMsg.trim();
    if (!selectedProject || !message || gitLoadingCountRef.current > 0) return;
    const operation = claimGitMutation('commit');
    if (!operation) return;
    try {
      await projectsAPI.git(operation.projectName, 'commit', { message });
      await verifyGitMutation(operation);
      setCommitMsg('');
      showToast('Changes committed');
      await refreshTree(operation.projectName);
    } catch (err) { showErrorToast(err, 'Committing changes or verifying Git status'); } finally { releaseGitMutation(operation); }
  };

  const gitPull = async () => {
    if (!selectedProject || gitLoadingCountRef.current > 0) return;
    const operation = claimGitMutation('pull');
    if (!operation) return;
    try {
      const data = await projectsAPI.git(operation.projectName, 'pull');
      await verifyGitMutation(operation);
      showToast(data.output || 'Pull complete');
      await refreshTree(operation.projectName);
    } catch (err) { showErrorToast(err, 'Pulling or verifying Git changes'); } finally { releaseGitMutation(operation); }
  };

  const gitPush = async () => {
    if (!selectedProject || gitLoadingCountRef.current > 0) return;
    const operation = claimGitMutation('push');
    if (!operation) return;
    try {
      const data = await projectsAPI.git(operation.projectName, 'push');
      await verifyGitMutation(operation);
      showToast(data.output || 'Push complete');
    } catch (err) { showErrorToast(err, 'Pushing or verifying Git changes'); } finally { releaseGitMutation(operation); }
  };

  const switchBranch = async (branchName: string) => {
    if (!selectedProject || gitLoadingCountRef.current > 0) return;
    const requestedBranch = branchName;
    const operation = claimGitMutation('checkout', requestedBranch);
    if (!operation) return;
    try {
      await projectsAPI.git(operation.projectName, 'checkout', { branch: requestedBranch });
      const fresh = await verifyGitMutation(operation);
      if (fresh.branch && fresh.branch !== requestedBranch) {
        throw new Error(`Git remained on ${fresh.branch}; the branch switch was not confirmed.`);
      }
      showToast(`Switched to ${requestedBranch}`);
      await loadBranches();
      await refreshTree(operation.projectName);
      await loadProjects();
    } catch (err) { showErrorToast(err, `Switching to or verifying branch: ${requestedBranch}`); } finally { releaseGitMutation(operation); }
  };

  const createBranch = async () => {
    const requestedBranch = newBranchName.trim();
    if (!selectedProject || !requestedBranch || gitLoadingCountRef.current > 0) return;
    const operation = claimGitMutation('checkout-new', requestedBranch);
    if (!operation) return;
    try {
      await projectsAPI.git(operation.projectName, 'checkout-new', { branch: requestedBranch });
      const fresh = await verifyGitMutation(operation);
      if (fresh.branch && fresh.branch !== requestedBranch) {
        throw new Error(`Git remained on ${fresh.branch}; the new branch was not confirmed.`);
      }
      setNewBranchName('');
      showToast(`Created branch ${requestedBranch}`);
      await loadBranches();
      await loadProjects();
    } catch (err) { showErrorToast(err, `Creating or verifying branch: ${requestedBranch}`); } finally { releaseGitMutation(operation); }
  };

  const resetFile = async (filePath: string): Promise<boolean> => {
    if (!selectedProject || gitLoadingCountRef.current > 0) return false;
    const operation = claimGitMutation('reset-file', filePath);
    if (!operation) return false;
    const requestedPath = filePath;
    setResetFileError(null);
    try {
      await projectsAPI.git(operation.projectName, 'reset-file', { file: requestedPath });
      const fresh = await verifyGitMutation(operation);
      if (fresh.files?.some((file) => file.path === requestedPath)) {
        throw new Error('Git still reports uncommitted changes for that file.');
      }
      await refreshTree(operation.projectName);
      setPendingResetFile(null);
      showToast(`Reset: ${requestedPath}`);
      return true;
    } catch (err: any) {
      setResetFileError(err?.response?.data?.error || err?.message || `Could not reset ${requestedPath}.`);
      showErrorToast(err, `Resetting or verifying file: ${requestedPath}`);
      return false;
    } finally {
      releaseGitMutation(operation);
    }
  };

  // Install dependencies via SSE stream (using fetch for POST with SSE)
  const installDependencies = async (projectName: string): Promise<boolean> => {
    const apiUrl = import.meta.env.VITE_API_URL || '/api';
    const abortController = new AbortController();
    installEventSourceRef.current = { close: () => abortController.abort() } as any;
    
    const logs: string[] = [];
    let success = false;
    
    try {
      const response = await workspaceAuthorizedFetch(`${apiUrl}/projects/${encodeURIComponent(projectName)}/install-deps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: abortController.signal,
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to start installation');
      }
      
      // Check if response is SSE or JSON
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        // Already completed or no deps needed
        const data = await response.json();
        if (data.success || data.cached) {
          return true;
        }
        return false;
      }
      
      // Parse SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        let eventType = '';
        let eventData = '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6);
            
            if (eventType && eventData) {
              try {
                const data = JSON.parse(eventData);
                
                if (eventType === 'start') {
                  setProgressNotification({
                    id: `install-${projectName}`,
                    title: 'Installing Dependencies',
                    status: 'active',
                    progress: 5,
                    statusText: `Installing ${data.packages?.length || 0} packages...`,
                    logs: [`$ ${data.command || 'Installing...'}`],
                    onCancel: () => {
                      abortController.abort();
                      installEventSourceRef.current = null;
                      setProgressNotification(null);
                    },
                    onDismiss: () => {
                      if (!projectOperationRef.current) setProgressNotification(null);
                    },
                  });
                } else if (eventType === 'progress') {
                  if (data.text) logs.push(data.text);
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    progress: Math.min(90, data.progress || prev.progress + 5),
                    statusText: data.text || prev.statusText,
                    logs: [...logs].slice(-50),
                  } : null);
                } else if (eventType === 'log') {
                  if (data.text) logs.push(data.text);
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    logs: [...logs].slice(-50),
                  } : null);
                } else if (eventType === 'complete') {
                  success = true;
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    status: 'complete',
                    progress: 100,
                    statusText: data.message || 'Dependencies installed!',
                    onCancel: undefined,
                  } : null);
                } else if (eventType === 'error') {
                  setProgressNotification(prev => prev ? {
                    ...prev,
                    status: 'error',
                    statusText: 'Installation failed',
                    error: data.message || 'Unknown error',
                    onCancel: undefined,
                  } : null);
                }
              } catch (parseError) {
                console.warn('Failed to parse SSE data:', eventData, parseError);
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return false;
      }
      setProgressNotification(prev => prev ? {
        ...prev,
        status: 'error',
        statusText: 'Installation failed',
        error: err.message || 'Unknown error',
        onCancel: undefined,
      } : null);
      return false;
    } finally {
      installEventSourceRef.current = null;
    }
    
    if (success) {
      await new Promise(r => setTimeout(r, 500));
    }
    return success;
  };

  // Ctrl+K uses a per-tab opaque target tied to this exact authorization
  // generation. Clearing workspace state invalidates every historical URL.
  useEffect(() => {
    if (!projectDeepLink?.file) {
      projectDeepLinkFileRef.current = null;
      return;
    }
    if (selectedProject !== projectDeepLink.project) return;
    if (projectOperationRef.current) return;
    const targetKey = `${projectDeepLink.project}\u0000${projectDeepLink.file}`;
    if (projectDeepLinkFileRef.current === targetKey) return;
    projectDeepLinkFileRef.current = targetKey;
    void openFileHandlerRef.current?.(projectDeepLink.file, true);
  }, [projectDeepLink, projectOperation, selectedProject]);

  const deployProject = async (
    expectedRetryOwner?: RuntimeImageRepairRetryOwner,
  ): Promise<boolean> => {
    const projectName = selectedProjectRef.current;
    if (
      !projectName
      || projectOperationRef.current
      || deploymentStatusReadRef.current
      || deploymentControlBusy !== null
    ) return false;
    if (
      expectedRetryOwner
      && (
        expectedRetryOwner.retryAction !== 'deploy'
        || expectedRetryOwner.projectName !== projectName
        || expectedRetryOwner.projectGeneration !== projectLoadGenerationRef.current
      )
    ) return false;
    const inventoryProject = projectsRef.current.find((project) => project.name === projectName);
    if (
      expectedRetryOwner
      && expectedRetryOwner.recoveryReplay.expectedAppId
        !== (inventoryProject?.deployment?.appId || null)
    ) return false;
    if (!projectLifecycleActionAllowed(inventoryProject, 'redeploy')) return false;
    const projectGeneration = projectLoadGenerationRef.current;
    const runtime = inventoryProject?.detectedDeployType === 'runtime';
    // Runtime (Python/C++/desktop) projects demo inside Remote Desktop, which
    // is deliberately restricted to Owner/Sub-Admin. Tell non-elevated users
    // up front instead of failing after a deploy.
    if (runtime && !canLaunchProjectRuntimeDemo(useAuthStore.getState().user?.role)) {
      setProgressNotification({
        id: `deploy-denied-${projectName}`,
        title: 'Remote Desktop required',
        status: 'error',
        progress: 0,
        statusText: REMOTE_DESKTOP_RUNTIME_WARNING,
        onDismiss: () => setProgressNotification(null),
      });
      return false;
    }
    const operation = Object.freeze({
      kind: 'deploy' as const,
      projectName,
      projectGeneration,
      token: ++projectOperationTokenRef.current,
      runtime,
    });
    if (!claimProjectOperation(operation)) return false;
    invalidateDeploymentStatusReads();
    deploymentProcessOwnerRef.current = null;
    setDeploymentProcess(null);
    setDeploymentControlError(null);
    const operationIsCurrent = () => (
      projectOperationRef.current === operation
      && selectedProjectRef.current === operation.projectName
      && projectLoadGenerationRef.current === operation.projectGeneration
    );
    setDeploying(true);
    try {
      // First check for dependencies (for runtime projects).
      if (operation.runtime) {
        try {
          const depsResult = await projectsAPI.checkDeps(operation.projectName);
          if (!operationIsCurrent()) return false;
          if (depsResult.needsInstall && depsResult.packages?.length > 0) {
            setProgressNotification({
              id: `deps-${operation.projectName}`,
              title: 'Checking Dependencies',
              status: 'pending',
              progress: 0,
              statusText: `Found ${depsResult.packages.length} missing packages`,
              logs: [`Packages: ${depsResult.packages.join(', ')}`],
              onDismiss: () => {
                if (!projectOperationRef.current) setProgressNotification(null);
              },
            });
            const installSuccess = await installDependencies(operation.projectName);
            if (!operationIsCurrent()) return false;
            if (!installSuccess) {
              showErrorToast(new Error('Dependency installation cancelled or failed'), 'Installing dependencies');
              return false;
            }
            await new Promise(r => setTimeout(r, 300));
            if (!operationIsCurrent()) return false;
          }
        } catch (err) {
          if (!operationIsCurrent()) return false;
          // Dependency check failure is advisory; the deploy endpoint performs
          // its own authoritative validation.
          console.warn('Dependency check failed:', err);
        }
      }

      setDeployStatus('deploying');
      setProgressNotification({
        id: `deploy-${operation.projectName}`,
        title: operation.runtime ? 'Running Project' : 'Deploying Project',
        status: 'active',
        progress: 20,
        statusText: operation.runtime ? 'Launching on desktop...' : 'Building and deploying...',
        onDismiss: () => {
          if (!projectOperationRef.current) setProgressNotification(null);
        },
      });

      const data = expectedRetryOwner
        ? await executeProjectRuntimeRecoveryReplay(() => projectsAPI.deploy(
            operation.projectName,
            expectedRetryOwner.recoveryReplay,
          ))
        : await projectsAPI.deploy(operation.projectName);
      if (!operationIsCurrent()) return false;
      const deploySuccess = 'deployType' in data ? data : null;
      const recoveredCompletion = expectedRetryOwner
        ? projectRuntimeRecoveryCompletion(data, expectedRetryOwner.recoveryReplay)
        : null;
      if (!deploySuccess && !recoveredCompletion) {
        throw new Error('Portal returned an invalid Project deployment response. Refresh Deployment status before retrying.');
      }
      setProgressNotification(prev => prev ? {
        ...prev,
        status: 'complete',
        progress: 100,
        statusText: recoveredCompletion
          ? 'Recovered deployment confirmed'
          : deploySuccess?.deployType === 'runtime'
            ? 'Running on Desktop!'
            : `Deployed to ${deploySuccess?.url}`,
      } : null);
      
      setDeployStatus('success');

      if (deploySuccess?.deployType === 'runtime') {
        await loadProjects();
        if (!operationIsCurrent()) return false;
        await new Promise(r => setTimeout(r, 1500));
        if (!operationIsCurrent()) return false;
        setDeployStatus('idle');
        setProgressNotification(null);
        setDeploying(false);
        releaseProjectOperation(operation);
        navigate('/desktop');
        return true;
      } else {
        await loadProjects();
        if (!operationIsCurrent()) return false;
        await loadDeploymentProcess(operation.projectName, operation);
        if (!operationIsCurrent()) return false;
        setTimeout(() => {
          if (
            selectedProjectRef.current === operation.projectName
            && projectLoadGenerationRef.current === operation.projectGeneration
          ) setDeployStatus('idle');
        }, 3000);
      }
    } catch (err) {
      if (!operationIsCurrent()) return false;
      const failure = deploymentControlFailure(err, 'Deploy failed');
      if (expectedRetryOwner) {
        runtimeImageRepairReplayOutcomeRef.current = projectRuntimeRecoveryReplayFailureOutcome(failure);
      }
      const replay = failure.recoveryReplay;
      const retryCanBeBound = failure.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
        && replay?.action === 'deploy'
        && replay.projectIdentity.id === inventoryProject?.identity.id
        && replay.projectIdentity.generation === inventoryProject?.identity.generation
        && replay.expectedAppId === (inventoryProject?.deployment?.appId || null);
      const ownedFailure = retryCanBeBound && replay
        ? {
            ...failure,
            retryAction: 'deploy' as const,
            retryOwner: Object.freeze({
              projectName: operation.projectName,
              projectGeneration: operation.projectGeneration,
              recoveryReplay: replay,
            }),
          }
        : failure.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
          ? deploymentFailureWithoutRuntimeRepair(failure)
          : failure;
      setDeploymentControlError(ownedFailure);
      if (
        failure.recoveryAction === 'UNDEPLOY_CURRENT_DEPLOYMENT'
        || failure.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
      ) {
        setActivePanel('deployment');
      }
      setProgressNotification(prev => prev ? {
        ...prev,
        status: 'error' as const,
        statusText: 'Deploy failed',
        error: failure.message,
      } : null);
      
      setDeployStatus('failed');
      setTimeout(() => {
        if (
          selectedProjectRef.current === operation.projectName
          && projectLoadGenerationRef.current === operation.projectGeneration
        ) setDeployStatus('idle');
      }, 5000);
      return false;
    } finally {
      if (projectOperationRef.current === operation) {
        setDeploying(false);
        releaseProjectOperation(operation);
      }
    }
    return true;
  };

  const executeDeploymentProcessAction = async (request: Readonly<{
    action: 'start' | 'stop' | 'restart';
    projectName: string;
    projectGeneration: number;
    appId: string;
    recoveryReplay?: ProjectRuntimeRecoveryReplayProof;
  }>): Promise<boolean> => {
    const { action, projectName, projectGeneration, appId, recoveryReplay } = request;
    if (
      projectOperationRef.current
      || deploymentStatusReadRef.current
      || selectedProjectRef.current !== projectName
      || projectLoadGenerationRef.current !== projectGeneration
    ) return false;
    const inventory = projectsRef.current.find((project) => project.name === projectName);
    if (!inventory?.deployment || inventory.deployment.appId !== appId) return false;
    const operation = Object.freeze({
      kind: 'deploy' as const,
      projectName,
      projectGeneration,
      token: ++projectOperationTokenRef.current,
      runtime: false,
    });
    if (!claimProjectOperation(operation)) return false;
    invalidateDeploymentStatusReads();
    const operationIsCurrent = () => (
      projectOperationRef.current === operation
      && selectedProjectRef.current === projectName
      && projectLoadGenerationRef.current === operation.projectGeneration
      && projectsRef.current.find((project) => project.name === projectName)?.deployment?.appId === appId
    );
    setDeploymentControlBusy(action);
    setDeploymentControlError(null);
    try {
      const status = recoveryReplay
        ? await executeProjectRuntimeRecoveryReplay(() => projectsAPI.appProcess(
            projectName,
            action,
            recoveryReplay,
          ))
        : await projectsAPI.appProcess(projectName, action);
      if (!operationIsCurrent()) return false;
      deploymentProcessOwnerRef.current = Object.freeze({
        projectName,
        projectGeneration: operation.projectGeneration,
        appId,
      });
      setDeploymentProcess(status);
      await loadProjects();
      if (
        projectOperationRef.current === operation
        && selectedProjectRef.current === projectName
      ) {
        await loadDeploymentProcess(projectName, operation);
      }
    } catch (error) {
      if (projectOperationRef.current === operation) {
        deploymentProcessOwnerRef.current = null;
        setDeploymentProcess(null);
        const failure = deploymentControlFailure(error, `Could not ${action} deployment`);
        if (recoveryReplay) {
          runtimeImageRepairReplayOutcomeRef.current = projectRuntimeRecoveryReplayFailureOutcome(failure);
        }
        const replay = failure.recoveryReplay;
        const retryCanBeBound = action !== 'stop'
          && failure.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
          && replay?.action === action
          && replay.projectIdentity.id === inventory.identity.id
          && replay.projectIdentity.generation === inventory.identity.generation
          && replay.expectedAppId === appId;
        setDeploymentControlError(
          retryCanBeBound && replay
            ? {
                ...failure,
                retryAction: action as 'start' | 'restart',
                retryOwner: Object.freeze({
                  projectName,
                  projectGeneration,
                  recoveryReplay: replay,
                }),
              }
            : failure.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
              ? deploymentFailureWithoutRuntimeRepair(failure)
              : failure,
        );
      }
      return false;
    } finally {
      if (projectOperationRef.current === operation) releaseProjectOperation(operation);
      setDeploymentControlBusy(null);
    }
    return true;
  };

  const controlDeploymentProcess = async (action: 'start' | 'stop' | 'restart') => {
    const projectName = selectedProjectRef.current;
    if (
      !projectName
      || projectOperationRef.current
      || deploymentStatusReadRef.current
      || deploymentControlBusy
    ) return;
    const inventory = projectsRef.current.find((project) => project.name === projectName);
    const processOwner = deploymentProcessOwnerRef.current;
    if (
      !inventory?.deployment
      || !deploymentProcess?.supportedActions.includes(action)
      || !processOwner
      || processOwner.projectName !== projectName
      || processOwner.projectGeneration !== projectLoadGenerationRef.current
      || processOwner.appId !== inventory.deployment.appId
    ) return;
    await executeDeploymentProcessAction({
      action,
      projectName,
      projectGeneration: projectLoadGenerationRef.current,
      appId: inventory.deployment.appId,
    });
  };

  const undeployProject = async () => {
    const projectName = pendingUndeploy;
    if (
      !projectName
      || selectedProjectRef.current !== projectName
      || projectOperationRef.current
      || deploymentStatusReadRef.current
      || deploymentControlBusy
    ) return;
    const inventory = projectsRef.current.find((project) => project.name === projectName);
    if (!inventory?.deployment || !projectLifecycleActionAllowed(inventory, 'undeploy')) return;
    const appId = inventory.deployment.appId;
    const operation = Object.freeze({
      kind: 'deploy' as const,
      projectName,
      projectGeneration: projectLoadGenerationRef.current,
      token: ++projectOperationTokenRef.current,
      runtime: false,
    });
    if (!claimProjectOperation(operation)) return;
    invalidateDeploymentStatusReads();
    deploymentProcessOwnerRef.current = null;
    setDeploymentProcess(null);
    const operationIsCurrent = () => (
      projectOperationRef.current === operation
      && selectedProjectRef.current === projectName
      && projectLoadGenerationRef.current === operation.projectGeneration
      && projectsRef.current.find((project) => project.name === projectName)?.deployment?.appId === appId
    );
    setDeploymentControlBusy('undeploy');
    setDeploymentControlError(null);
    try {
      await projectsAPI.undeploy(projectName);
      if (!operationIsCurrent()) return;
      await loadProjects();
      deploymentProcessOwnerRef.current = null;
      setDeploymentProcess(null);
      setPendingUndeploy(null);
      setActivePanel(null);
      showToast('Deployment removed. Project source and chat were preserved.', 'success');
    } catch (error) {
      if (projectOperationRef.current === operation) {
        setDeploymentControlError(deploymentControlFailure(error, 'Could not remove deployment'));
      }
    } finally {
      if (projectOperationRef.current === operation) releaseProjectOperation(operation);
      setDeploymentControlBusy(null);
    }
  };

  const retryProjectActionAfterRuntimeImageRepair = async (
    owner: RuntimeImageRepairRetryOwner,
  ): Promise<RuntimeImageRepairReplayOutcome> => {
    runtimeImageRepairReplayOutcomeRef.current = 'stale';
    if (!await loadProjects()) {
      runtimeImageRepairReplayOutcomeRef.current = 'failed';
      setDeploymentControlError({
        message: 'Portal could not verify the current Project inventory, so the recovered action was not replayed.',
        detail: 'Refresh Projects and retry from the current Deployment controls.',
        code: 'PROJECT_RUNTIME_RECOVERY_INVENTORY_UNAVAILABLE',
      });
      return 'failed';
    }
    if (
      !mountedRef.current
      || selectedProjectRef.current !== owner.projectName
      || projectLoadGenerationRef.current !== owner.projectGeneration
    ) return 'stale';
    const current = projectsRef.current.find((project) => project.name === owner.projectName);
    if (
      !current
      || current.availability?.available === false
      || current.identity.id !== owner.recoveryReplay.projectIdentity.id
      || current.identity.generation !== owner.recoveryReplay.projectIdentity.generation
      || owner.recoveryReplay.action !== owner.retryAction
    ) return 'stale';

    if (owner.retryAction === 'deploy') {
      if (
        owner.recoveryReplay.expectedAppId
          !== (current.deployment?.appId || null)
      ) return 'stale';
      if (!projectLifecycleActionAllowed(current, 'redeploy')) return 'stale';
      // Once the receipt-backed request leaves the browser, anything except a
      // proved stale response is ambiguous until the server says otherwise.
      runtimeImageRepairReplayOutcomeRef.current = 'indeterminate';
      setDeploymentControlError(null);
      return await deployProject(owner)
        ? 'completed'
        : runtimeImageRepairReplayOutcomeRef.current;
    }

    const expectedAppId = owner.recoveryReplay.expectedAppId;
    if (!expectedAppId || current.deployment?.appId !== expectedAppId) return 'stale';
    const freshStatus = await projectsAPI.appProcess(owner.projectName, 'status');
    if (
      freshStatus.runtimeManagement !== 'portal-container'
      || !freshStatus.supportedActions.includes(owner.retryAction)
    ) return 'stale';
    deploymentProcessOwnerRef.current = Object.freeze({
      projectName: owner.projectName,
      projectGeneration: owner.projectGeneration,
      appId: expectedAppId,
    });
    setDeploymentProcess(freshStatus);
    runtimeImageRepairReplayOutcomeRef.current = 'indeterminate';
    setDeploymentControlError(null);
    return await executeDeploymentProcessAction({
      action: owner.retryAction,
      projectName: owner.projectName,
      projectGeneration: owner.projectGeneration,
      appId: expectedAppId,
      recoveryReplay: owner.recoveryReplay,
    }) ? 'completed' : runtimeImageRepairReplayOutcomeRef.current;
  };

  const prepareRuntimeImageRepair = async () => {
    if (
      runtimeImageRepairInFlightRef.current
      || runtimeImageRepairPhase !== 'idle'
      || !isOwner(user)
      || deploymentControlError?.recoveryAction !== 'REPAIR_PROJECT_RUNTIME_IMAGE'
      || !deploymentControlError.retryAction
      || !deploymentControlError.retryOwner
      || selectedProjectRef.current !== deploymentControlError.retryOwner.projectName
      || projectLoadGenerationRef.current !== deploymentControlError.retryOwner.projectGeneration
    ) return;
    const retryOwner: RuntimeImageRepairRetryOwner = Object.freeze({
      ...deploymentControlError.retryOwner,
      retryAction: deploymentControlError.retryAction,
    });
    setRuntimeImageRepairPhase('preparing');
    setRuntimeImageRepairError(null);
    try {
      const status = await projectRuntimeImageRepairAPI.status();
      if (
        status.ownerOnly !== true
        || status.changesSystem !== true
        || status.restartExpected !== true
        || status.confirmationPhrase !== 'REPAIR PROJECT RUNTIME IMAGE'
      ) {
        throw new Error('Portal returned an invalid Project runtime repair contract. No repair was started.');
      }
      if (status.state === 'ready') {
        const replayOutcome = await retryProjectActionAfterRuntimeImageRepair(retryOwner);
        if (replayOutcome === 'indeterminate') {
          setDeploymentControlError({
            message: 'The recovered Project action is still reconciling.',
            detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
            code: 'PROJECT_RUNTIME_RECOVERY_IN_PROGRESS',
          });
          showToast('Runtime image is ready; the recovered action is still reconciling.', 'info');
          return;
        }
        if (replayOutcome === 'stale') {
          setDeploymentControlError({
            message: 'The runtime image is ready, but the original Project action is stale and was not replayed.',
            detail: 'Refresh this Project, then use its current Deployment controls.',
          });
          showToast('Runtime image is ready; the stale Project action was not replayed.', 'info');
          return;
        }
        if (replayOutcome === 'failed') {
          showToast('Runtime image is ready, but the recovered Project action failed. Review Deployment details.', 'error');
          return;
        }
        showToast(`The runtime image is ready. Portal retried ${retryOwner.retryAction}.`, 'success');
        return;
      }
      if (
        status.state === 'unavailable'
        && status.unavailableReason !== 'image-missing'
      ) {
        setRuntimeImageRepairError(
          status.unavailableReason === 'unit-state-unknown'
            ? 'Portal cannot verify the repair service state. Check Dashboard → Server Maintenance, then check this repair again. No repair was started.'
            : 'Portal cannot verify Docker image state. Check Dashboard → Server Maintenance, then check this repair again. No repair was started.',
        );
        return;
      }
      setRuntimeImageRepairDialog({
        confirmationPhrase: status.confirmationPhrase,
        ...retryOwner,
      });
    } catch (error) {
      setRuntimeImageRepairError(extractError(error).message || 'Could not load the Project runtime repair contract.');
    } finally {
      setRuntimeImageRepairPhase('idle');
    }
  };

  const runRuntimeImageRepair = async (confirmation: string) => {
    const owner = runtimeImageRepairDialog;
    if (!owner || runtimeImageRepairInFlightRef.current || !isOwner(user)) return;
    runtimeImageRepairInFlightRef.current = true;
    setRuntimeImageRepairPhase('running');
    setRuntimeImageRepairError(null);
    let submissionError: string | null = null;
    let acceptedState: 'ready' | 'running' | null = null;
    try {
      try {
        const accepted = await projectRuntimeImageRepairAPI.repair(confirmation);
        acceptedState = accepted.state;
      } catch (error) {
        // The repair restarts Portal after committing a new immutable image.
        // A disconnected POST is therefore indeterminate, not a safe reason
        // to launch a second host mutation. Reconcile through the read-only
        // status endpoint below before offering another submission.
        submissionError = extractError(error).message || 'Portal did not acknowledge the repair request.';
      }

      let unavailableReads = 0;
      let transportFailures = 0;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        if (!mountedRef.current) return;
        if (acceptedState === 'ready') break;
        try {
          const status = await projectRuntimeImageRepairAPI.status();
          transportFailures = 0;
          if (status.state === 'ready') {
            acceptedState = 'ready';
            break;
          }
          if (status.state === 'failed') {
            throw new Error('Project runtime image repair failed. Review the retained server log before retrying.');
          }
          if (status.state === 'unavailable') {
            unavailableReads += 1;
            if (unavailableReads >= 3) {
              throw new Error(submissionError || 'Project runtime image repair did not start. Retry the same repair after checking server maintenance.');
            }
          } else {
            unavailableReads = 0;
          }
        } catch (error) {
          const message = extractError(error).message;
          if (/repair (?:failed|did not start)|response is malformed/i.test(message)) throw error;
          transportFailures += 1;
          if (transportFailures >= 20) {
            throw new Error(submissionError || 'Portal did not return after the Project runtime repair restart. Check server health before retrying.');
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      }

      if (acceptedState !== 'ready') {
        throw new Error('Project runtime image repair is still running. Leave this dialog open or check server maintenance before retrying.');
      }
      if (!mountedRef.current) return;
      const replayOutcome = await retryProjectActionAfterRuntimeImageRepair(owner);
      setRuntimeImageRepairDialog(null);
      if (replayOutcome === 'indeterminate') {
        setDeploymentControlError({
          message: 'The recovered Project action is still reconciling.',
          detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
          code: 'PROJECT_RUNTIME_RECOVERY_IN_PROGRESS',
        });
        showToast('Runtime image repaired; the recovered action is still reconciling.', 'info');
        return;
      }
      if (replayOutcome === 'stale') {
        setDeploymentControlError({
          message: 'The runtime image was repaired, but the original Project action is stale and was not replayed.',
          detail: 'Refresh this Project, then use its current Deployment controls.',
        });
        showToast('Runtime image repaired; the stale Project action was not replayed.', 'info');
        return;
      }
      if (replayOutcome === 'failed') {
        showToast('Runtime image repaired, but the recovered Project action failed. Review Deployment details.', 'error');
        return;
      }
      showToast(`Project runtime image repaired. Portal retried ${owner.retryAction}.`, 'success');
    } catch (error) {
      if (mountedRef.current) {
        setRuntimeImageRepairError(extractError(error).message || 'Project runtime image repair failed.');
      }
    } finally {
      runtimeImageRepairInFlightRef.current = false;
      if (mountedRef.current) setRuntimeImageRepairPhase('idle');
    }
  };
  
  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (installEventSourceRef.current) {
        installEventSourceRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!modifiedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('beforeunload', warnBeforeUnload);
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      zipUploadXhrRef.current?.abort();
      const pending = pendingAutoSaveRef.current;
      pendingAutoSaveRef.current = null;
      if (pending) void persistProjectFile(pending).catch((error) => logError(error, 'Final auto-save failed'));
    };
  }, [persistProjectFile]);

  // Check syntax/compile for runtime projects
  const checkProject = async () => {
    if (!selectedProject) return;
    setCheckingProject(true);
    try {
      const res = await workspaceAuthorizedFetch(`${import.meta.env.VITE_API_URL || '/api'}/projects/${encodeURIComponent(selectedProject)}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Project check failed with HTTP ${res.status}`);
      if (data.ok) {
        showToast(`✅ No syntax errors (${data.language})`, 'success');
      } else {
        showToast(`❌ ${data.language} errors found`, 'error', { 
          detail: data.output,
          hint: data.errors?.join('\n')
        });
      }
    } catch (err) {
      showErrorToast(err, 'Checking project syntax');
    } finally { setCheckingProject(false); }
  };

  const createShareLink = async () => {
    if (!selectedProject || shareCreateInFlightRef.current || shareActionOwnerRef.current) return;
    const request = {
      projectName: selectedProject,
      isPublic: shareIsPublic,
      password: sharePassword,
      passwordConfirm: sharePasswordConfirm,
      expiresAtInput: shareExpiresAt,
      maxUsesInput: shareMaxUses,
      rateLimitEnabled: shareRateLimitEnabled,
      rateLimitMaxRequestsInput: shareRateLimitMaxRequests,
      rateLimitWindowSeconds: shareRateLimitWindowSeconds,
    };
    setShareCreateError(null);
    const rejectSharePolicy = (message: string) => {
      setShareCreateError(message);
    };
    if (!request.isPublic) {
      if (request.password.length < 8) { rejectSharePolicy('Password must be at least 8 characters'); return; }
      if (utf8ByteLength(request.password) > 72) { rejectSharePolicy('Password must be at most 72 UTF-8 bytes'); return; }
      if (request.password !== request.passwordConfirm) { rejectSharePolicy('Passwords do not match'); return; }
    }
    const expiresAt = request.expiresAtInput ? new Date(request.expiresAtInput) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      rejectSharePolicy('Expiration must be in the future');
      return;
    }
    const maxUses = request.maxUsesInput ? Number(request.maxUsesInput) : null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)) {
      rejectSharePolicy('Visitor slots must be a whole number from 1 to 1,000,000');
      return;
    }
    const rateLimitMaxRequests = request.rateLimitEnabled
      ? Number(request.rateLimitMaxRequestsInput)
      : null;
    if (
      request.rateLimitEnabled
      && (
        rateLimitMaxRequests === null
        || !Number.isSafeInteger(rateLimitMaxRequests)
        || rateLimitMaxRequests < 1
        || rateLimitMaxRequests > 1_000_000
      )
    ) {
      rejectSharePolicy('API request limit must be a whole number from 1 to 1,000,000');
      return;
    }
    if (
      request.rateLimitEnabled
      && !SHARE_RATE_LIMIT_WINDOWS.some(({ value }) => value === request.rateLimitWindowSeconds)
    ) {
      rejectSharePolicy('Choose a valid API request window');
      return;
    }
    const owner = Object.freeze({
      kind: 'create' as const,
      projectName: request.projectName,
      projectGeneration: projectLoadGenerationRef.current,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimShareAction(owner)) return;
    shareCreateInFlightRef.current = true;
    setShareCreating(true);
    try {
      await projectsAPI.share(request.projectName, {
        isPublic: request.isPublic,
        ...(request.isPublic ? {} : { password: request.password }),
        ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
        ...(maxUses !== null ? { maxUses } : {}),
        ...(rateLimitMaxRequests !== null ? {
          rateLimitMaxRequests,
          rateLimitWindowSeconds: request.rateLimitWindowSeconds,
        } : {}),
      });
      setSharePassword('');
      setSharePasswordConfirm('');
      setShareExpiresAt('');
      setShareMaxUses('');
      setShareRateLimitEnabled(false);
      setShareRateLimitMaxRequests('');
      setShareRateLimitWindowSeconds(60);
      setShareCreateError(null);
      setShareIsPublic(true);
      if (await loadShares(request.projectName)) showToast('Share link created');
    } catch (err) { showErrorToast(err, 'Creating share link'); }
    finally {
      releaseShareAction(owner);
      shareCreateInFlightRef.current = false;
      setShareCreating(false);
    }
  };

  const toggleShareActive = async (linkId: string) => {
    if (!selectedProject || shareActionOwnerRef.current) return;
    const share = shares.find(s => s.id === linkId);
    if (!share || shareMutationIdsRef.current.has(linkId)) return;
    const availability = getShareLinkAvailability(share);
    if (!share.isActive && (availability === 'expired' || availability === 'exhausted')) {
      showToast(
        availability === 'expired'
          ? 'Expired links cannot be reactivated; create a new link.'
          : 'Links that reached their visitor slot limit cannot be reactivated; create a new link.',
        'error',
      );
      return;
    }
    const request = {
      projectName: selectedProject,
      linkId,
      nextActive: !share.isActive,
      wasActive: share.isActive,
    };
    const owner = Object.freeze({
      kind: 'toggle' as const,
      projectName: request.projectName,
      projectGeneration: projectLoadGenerationRef.current,
      linkId,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimShareAction(owner)) return;
    shareMutationIdsRef.current.add(linkId);
    setShareMutationIds(new Set(shareMutationIdsRef.current));
    try {
      await projectsAPI.updateShare(request.projectName, request.linkId, { isActive: request.nextActive });
      if (await loadShares(request.projectName)) {
        showToast(request.wasActive ? 'Link disabled' : 'Link activated');
      }
    } catch (err) { showErrorToast(err, 'Updating share link'); }
    finally {
      releaseShareAction(owner);
      shareMutationIdsRef.current.delete(linkId);
      setShareMutationIds(new Set(shareMutationIdsRef.current));
    }
  };

  // Download project
  const downloadProject = async (mode: 'full' | 'clean' | 'stripped') => {
    if (!selectedProject) return;
    try {
      const modeLabels = {
        full: 'Full',
        clean: 'Clean',
        stripped: 'Stripped',
      };
      
      const response = await workspaceAuthorizedFetch(`/api/projects/${encodeURIComponent(selectedProject)}/download?mode=${mode}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || `Download failed with HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedProject}-${mode}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      showToast(`Downloaded ${selectedProject} (${modeLabels[mode]})`, 'success');
    } catch (error) {
      showErrorToast(error, `Downloading project: ${selectedProject}`);
    }
  };

  const [pendingDeleteShare, setPendingDeleteShare] = useState<string | null>(null);

  const sendShareEmail = async (linkId: string) => {
    const recipientEmail = shareEmailInput.trim();
    if (
      !selectedProject
      || !recipientEmail
      || emailingLinkId !== linkId
      || shareEmailInFlightRef.current
      || shareActionOwnerRef.current
    ) return;
    const request = { projectName: selectedProject, linkId, recipientEmail };
    const owner = Object.freeze({
      kind: 'email' as const,
      projectName: request.projectName,
      projectGeneration: projectLoadGenerationRef.current,
      linkId,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimShareAction(owner)) return;
    shareEmailInFlightRef.current = true;
    setShareEmailSending(true);
    setShareEmailError(null);
    setShareEmailSuccess(null);
    try {
      await projectsAPI.emailShare(request.projectName, request.linkId, {
        recipientEmail: request.recipientEmail,
      });
      setShareEmailSuccess(request.linkId);
    } catch (err) {
      const extracted = extractError(err, 'Sending share email');
      logError(err, 'Sending share email');
      setShareEmailError(extracted.message);
    } finally {
      releaseShareAction(owner);
      shareEmailInFlightRef.current = false;
      setShareEmailSending(false);
    }
  };

  const deleteSharePermanently = async () => {
    if (!pendingDeleteShare || !selectedProject || shareDeleteInFlightRef.current || shareActionOwnerRef.current) return;
    const request = { projectName: selectedProject, linkId: pendingDeleteShare };
    const owner = Object.freeze({
      kind: 'delete' as const,
      projectName: request.projectName,
      projectGeneration: projectLoadGenerationRef.current,
      linkId: request.linkId,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimShareAction(owner)) return;
    shareDeleteInFlightRef.current = true;
    setShareDeleteBusy(true);
    setShareDeleteError(null);
    try {
      await projectsAPI.deleteShare(request.projectName, request.linkId);
      setPendingDeleteShare(null);
      if (await loadShares(request.projectName)) showToast('Share link deleted');
    } catch (err) {
      const extracted = extractError(err, 'Deleting share link');
      logError(err, 'Deleting share link');
      setShareDeleteError(extracted.message);
    } finally {
      releaseShareAction(owner);
      shareDeleteInFlightRef.current = false;
      setShareDeleteBusy(false);
    }
  };

  const makeSharePublic = async () => {
    if (!confirmPublicId || !selectedProject || shareMakePublicInFlightRef.current || shareActionOwnerRef.current) return;
    const request = { projectName: selectedProject, linkId: confirmPublicId };
    const owner = Object.freeze({
      kind: 'make-public' as const,
      projectName: request.projectName,
      projectGeneration: projectLoadGenerationRef.current,
      linkId: request.linkId,
      token: ++projectOperationTokenRef.current,
    });
    if (!claimShareAction(owner)) return;
    shareMakePublicInFlightRef.current = true;
    setShareMakePublicBusy(true);
    setShareMakePublicError(null);
    try {
      await projectsAPI.updateShare(request.projectName, request.linkId, { isPublic: true });
      setConfirmPublicId(null);
      if (await loadShares(request.projectName)) showToast('Link is now public');
    } catch (err) {
      const extracted = extractError(err, 'Making share link public');
      logError(err, 'Making share link public');
      setShareMakePublicError(extracted.message);
    } finally {
      releaseShareAction(owner);
      shareMakePublicInFlightRef.current = false;
      setShareMakePublicBusy(false);
    }
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((current) => current === id ? null : current), 2000);
    } catch (error) {
      showErrorToast(error, 'Copying link');
    }
  };

  // Project Chat panel — open/close/auto-restore
  const agentAutoRestoreAttempted = useRef<string | null>(null);

  const openAgentChat = useCallback(() => {
    if (!selectedProject || projectOperationRef.current) return;
    const inventoryProject = projectsRef.current.find((project) => project.name === selectedProject);
    if (inventoryProject?.availability?.available === false) return;
    setAgentChatOpen(true);
  }, [selectedProject]);

  const closeAgentChat = useCallback(() => {
    if (projectOperationRef.current) return;
    if (selectedProject) {
      localStorage.removeItem(`agent-active-${selectedProject}`);
    }
    agentAutoRestoreAttempted.current = null;
    setAgentChatOpen(false);
  }, [selectedProject]);

  // Auto-restore Agent chat on project selection if there was an active session
  useEffect(() => {
    if (!selectedProject || agentAutoRestoreAttempted.current === selectedProject) return;
    if (agentChatOpen) {
      agentAutoRestoreAttempted.current = selectedProject;
      return;
    }
    const wasActive = localStorage.getItem(`agent-active-${selectedProject}`) === 'true';
    agentAutoRestoreAttempted.current = selectedProject;
    if (!wasActive) return undefined;
    const timer = window.setTimeout(() => {
      if (selectedProjectRef.current === selectedProject && !projectOperationRef.current) {
        openAgentChat();
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [selectedProject, agentChatOpen, openAgentChat]);

  const analyzeFile = async () => {
    if (!openFile || !editorContent) return;
    if (!analyzeModel || ollamaAvailable === false) {
      showToast('Install and start an Ollama model before running local code analysis.', 'error');
      return;
    }

    // File size guard
    const lineCount = editorContent.split('\n').length;
    const sizeKB = new TextEncoder().encode(editorContent).length / 1024;
    if (lineCount > 5000 || sizeKB > 200) {
      showToast(`File too large (${lineCount} lines, ${sizeKB.toFixed(0)}KB). Max 5 000 lines / 200 KB.`, 'error');
      return;
    }

    setAnalyzing(true);
    setShowAnalysisPanel(true);
    setAnalysisResults([]);

    try {
      if (lineCount > 500) {
        // Chunk large files
        const lines = editorContent.split('\n');
        const chunkSize = 400;
        const allIssues: any[] = [];
        showToast(`Large file — analyzing in ${Math.ceil(lines.length / chunkSize)} parts…`, 'info');

        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize).join('\n');
          try {
            const data = await aiAPI.analyzeCode(chunk, openFile.language, analyzeModel);
            const adjusted = (data.issues || []).map((issue: any) => ({
              ...issue,
              line: (issue.line || 1) + i,
            }));
            allIssues.push(...adjusted);
          } catch (err) {
            logError(err, `Analyzing code chunk ${i}/${Math.ceil(lineCount / 400)}`);
          }
        }

        setAnalysisResults(allIssues);
        showToast(allIssues.length ? `Found ${allIssues.length} issues` : 'No issues found!', allIssues.length ? 'info' : 'success');
      } else {
        const data = await aiAPI.analyzeCode(editorContent, openFile.language, analyzeModel);
        setAnalysisResults(data.issues || []);
        if (data.issues?.length === 0) {
          showToast('No issues found!', 'success');
        }
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Analysis failed';
      showToast(msg, 'error');
    } finally { setAnalyzing(false); }
  };

  const dismissIssue = (idx: number) => {
    setAnalysisResults(prev => prev.filter((_, i) => i !== idx));
  };

  const acceptFix = (issue: any) => {
    if (!issue.code || !openFile) return;

    const lines = editorContent.split('\n');
    const startLine = issue.line - 1; // Convert to 0-indexed
    const endLine = (issue.endLine || issue.line) - 1;

    // Validate range
    if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
      showToast('Could not apply fix — line number out of range', 'error');
      return;
    }

    // Replace line(s) with the fix code
    lines.splice(startLine, endLine - startLine + 1, issue.code);

    const newContent = lines.join('\n');
    handleEditorChange(newContent);

    // Remove this issue from results
    setAnalysisResults(prev => prev.filter(i => i !== issue));

    showToast(`Applied fix at line${issue.endLine ? `s ${issue.line}-${issue.endLine}` : ` ${issue.line}`}`, 'success');
  };

  const createNewFile = async () => {
    if (!selectedProject || !newFilePath.trim() || createEntryInFlightRef.current) return;
    const requestedPath = newFilePath.trim();
    if (!isValidProjectRelativePath(requestedPath)) {
      showToast('Use a project-relative path without empty, dot, or parent segments.', 'error');
      return;
    }
    createEntryInFlightRef.current = true;
    setCreatingEntry(true);
    try {
      if (newFileIsDir) {
        await projectsAPI.createFile(selectedProject, `${requestedPath}/.gitkeep`, '');
      } else {
        await projectsAPI.createFile(selectedProject, requestedPath, '');
      }
      setShowNewFile(false);
      setNewFilePath('');
      await refreshTree();
      showToast(`${newFileIsDir ? 'Folder' : 'File'} created`);
    } catch (err) { showErrorToast(err, `Creating ${newFileIsDir ? 'folder' : 'file'}: ${newFilePath}`); }
    finally {
      createEntryInFlightRef.current = false;
      setCreatingEntry(false);
    }
  };

  const requestDeleteFile = (filePath: string) => {
    if (!selectedProject || projectOperationRef.current || deleteInFlightRef.current) return;
    setDeleteError(null);
    setPendingDelete({
      kind: 'file',
      name: filePath.split('/').pop() || filePath,
      projectName: selectedProject,
      path: filePath,
    });
  };

  const handleUploadFiles = async () => {
    if (!selectedProject || uploadFiles.length === 0 || uploadFilesInFlightRef.current) return;
    const aggregateBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
    if (uploadFiles.some((file) => file.size > 100 * 1024 * 1024)) {
      showToast('Each project upload is limited to 100MB.', 'error');
      return;
    }
    if (aggregateBytes > 500 * 1024 * 1024) {
      showToast('The combined project upload is limited to 500MB.', 'error');
      return;
    }
    uploadFilesInFlightRef.current = true;
    setUploadingFiles(true);
    try {
      const data = await projectsAPI.uploadFiles(selectedProject, uploadFiles, uploadTargetPath || undefined);
      const count = data.uploaded?.length || uploadFiles.length;
      showToast(`Uploaded ${count} file${count !== 1 ? 's' : ''}${uploadTargetPath ? ` to ${uploadTargetPath}` : ''}`, 'success');
      if (data.errors?.length) {
        showToast(`${data.errors.length} file(s) failed: ${data.errors.map((e: any) => e.name).join(', ')}`, 'error');
      }
      setShowUploadDialog(false);
      setUploadFiles([]);
      setUploadTargetPath('');
      await refreshTree();
    } catch (err) {
      showErrorToast(err, 'Uploading files');
    } finally {
      uploadFilesInFlightRef.current = false;
      setUploadingFiles(false);
    }
  };

  const openUploadDialog = (targetDir?: string) => {
    setUploadTargetPath(targetDir || '');
    setUploadFiles([]);
    setShowUploadDialog(true);
  };

  // react-dropzone for upload dialog (works on iPad)
  const { getRootProps: getUploadRootProps, getInputProps: getUploadInputProps, isDragActive: uploadIsDragActive } = useDropzone({
    disabled: uploadingFiles,
    onDrop: (acceptedFiles) => {
      setUploadFiles(prev => [...prev, ...acceptedFiles]);
    },
    onDropRejected: (rejections) => {
      showToast(`${rejections.length} file(s) were rejected. Files must be 100MB or smaller.`, 'error');
    },
    maxFiles: 50,
    maxSize: 100 * 1024 * 1024,
    noClick: false,
    noKeyboard: false,
  });

  // Collect directory paths for upload target selection
  const collectDirPaths = (entries: TreeEntry[], expanded: Record<string, TreeEntry[]>): string[] => {
    const dirs: string[] = [''];
    const walk = (items: TreeEntry[]) => {
      for (const item of items) {
        if (item.type === 'directory') {
          dirs.push(item.path);
          if (expanded[item.path]) walk(expanded[item.path]);
        }
      }
    };
    walk(entries);
    return dirs;
  };

  const startRenameEntry = (entry: TreeEntry) => {
    if (projectOperationRef.current) return;
    setRenamingEntry({ path: entry.path, name: entry.name, type: entry.type });
    setRenameValue(entry.name);
  };

  const executeRenameEntry = async () => {
    if (entryRenameInFlightRef.current) return;
    if (!renamingEntry || !selectedProject || !renameValue.trim()) { setRenamingEntry(null); return; }
    const newName = renameValue.trim();
    if (newName === renamingEntry.name) { setRenamingEntry(null); return; }
    // Validate: no path traversal
    if (newName.includes('/') || !isValidProjectRelativePath(newName)) {
      showToast('Invalid name', 'error'); setRenamingEntry(null); return;
    }
    const parentDir = renamingEntry.path.includes('/') ? renamingEntry.path.substring(0, renamingEntry.path.lastIndexOf('/')) : '';
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    const currentOpenFile = openFileRef.current;
    const openFileIsAffected = Boolean(currentOpenFile && (
      currentOpenFile.path === renamingEntry.path
      || currentOpenFile.path.startsWith(`${renamingEntry.path}/`)
    ));
    entryRenameInFlightRef.current = true;
    try {
      if (openFileIsAffected && currentOpenFile) {
        await flushPendingAutoSave();
        await fileWriteQueueRef.current.waitFor(selectedProject, currentOpenFile.path);
      }
      await projectsAPI.renameFile(selectedProject, renamingEntry.path, newPath);
      showToast('Renamed successfully');
      await refreshTree();
      // If the renamed file was open, update the open file path
      if (openFileIsAffected && currentOpenFile) {
        const renamedOpenFile = {
          ...currentOpenFile,
          path: `${newPath}${currentOpenFile.path.slice(renamingEntry.path.length)}`,
        };
        openFileRef.current = renamedOpenFile;
        setOpenFile(renamedOpenFile);
      }
      if (openMedia && (openMedia.path === renamingEntry.path || openMedia.path.startsWith(`${renamingEntry.path}/`))) {
        const renamedMediaPath = `${newPath}${openMedia.path.slice(renamingEntry.path.length)}`;
        setOpenMedia({
          ...openMedia,
          path: renamedMediaPath,
          url: getProjectRawUrl(selectedProject, renamedMediaPath, openMedia.category === 'text' ? { mode: 'text' } : undefined),
        });
      }
    } catch (e: any) {
      showToast(e?.response?.data?.error || 'Failed to rename', 'error');
    } finally {
      entryRenameInFlightRef.current = false;
      setRenamingEntry(null);
    }
  };

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Ctrl+S = save
      if (mod && e.key === 's') { e.preventDefault(); saveFile(); }
      // Ctrl+Shift+F = fullscreen editor
      if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); if (openFile) setEditorFullscreen(f => !f); }
      // Ctrl+B = toggle sidebar
      if (mod && e.key === 'b') { e.preventDefault(); setSidebarVisible(v => !v); }
      // Ctrl+P = file search
      if (mod && e.key === 'p') { e.preventDefault(); setShowFileSearch(true); }
      // ESC = exit fullscreen or close search
      if (e.key === 'Escape') {
        if (editorFullscreen) setEditorFullscreen(false);
        if (showFileSearch) setShowFileSearch(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const currentProject = projects.find(p => p.name === selectedProject);
  const deploymentProcessOwner = deploymentProcessOwnerRef.current;
  const ownedDeploymentProcess = deploymentProcess
    && deploymentProcessOwner
    && currentProject?.deployment
    && deploymentProcessOwner.projectName === selectedProject
    && deploymentProcessOwner.projectGeneration === projectLoadGenerationRef.current
    && deploymentProcessOwner.appId === currentProject.deployment.appId
    ? deploymentProcess
    : null;
  const displayedRuntimeManagement = ownedDeploymentProcess?.runtimeManagement
    ?? currentProject?.deployment?.runtimeManagement;
  const displayedRuntimeStatusSource = ownedDeploymentProcess?.statusSource
    ?? currentProject?.deployment?.statusSource;
  const displayedDeploymentStatus = ownedDeploymentProcess?.status
    ?? (displayedRuntimeManagement === 'static'
      ? 'deployed'
      : displayedRuntimeStatusSource === 'portal-manager'
        ? currentProject?.deployment?.processStatus
        : 'unknown')
    ?? 'unknown';
  const displayedPersistedStatus = ownedDeploymentProcess?.persistedStatus
    ?? (displayedRuntimeStatusSource === 'persisted-app'
      || displayedRuntimeStatusSource === 'external-binding'
      ? currentProject?.deployment?.processStatus
      : null);
  const displayedDeploymentPort = displayedRuntimeManagement === 'portal-container'
    ? ownedDeploymentProcess?.port ?? currentProject?.deployment?.port
    : null;
  const deploymentSupportedActions = ownedDeploymentProcess?.supportedActions ?? [];
  const canRedeployCurrentProject = projectLifecycleActionAllowed(currentProject, 'redeploy');
  const canUndeployCurrentProject = projectLifecycleActionAllowed(currentProject, 'undeploy');
  const deploymentPanelAvailable = Boolean(
    currentProject?.deployment
    || (
      deploymentControlError?.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
      && deploymentControlError.retryOwner
    )
  );
  const deploymentLiveStatusText = deploymentProgressAnnouncement(
    deploymentControlBusy,
    displayedDeploymentStatus,
  );
  const currentProjectAvailable = !selectedProject
    || Boolean(currentProject && currentProject.availability?.available !== false);
  useEffect(() => {
    if (!selectedProject || currentProjectAvailable) return;
    if (agentChatOpen) setAgentChatOpen(false);
    selectedProjectRef.current = null;
    openFileRef.current = null;
    setSelectedProject(null);
    setOpenFile(null);
    setOpenMedia(null);
    setTree([]);
    setExpandedDirs({});
    setTreeError(null);
    setTreeLoading(false);
    try { localStorage.removeItem(LAST_SELECTED_PROJECT_KEY); } catch {}
  }, [agentChatOpen, currentProjectAvailable, selectedProject]);

  // Collect all file paths for search
  const collectAllPaths = (entries: TreeEntry[], expanded: Record<string, TreeEntry[]>): string[] => {
    const paths: string[] = [];
    const walk = (items: TreeEntry[]) => {
      for (const item of items) {
        if (item.type === 'file') paths.push(item.path);
        if (item.type === 'directory' && expanded[item.path]) {
          walk(expanded[item.path]);
        }
      }
    };
    walk(entries);
    return paths;
  };

  const allFilePaths = collectAllPaths(tree, expandedDirs);
  const filteredFiles = fileSearchQuery
    ? allFilePaths.filter(p => p.toLowerCase().includes(fileSearchQuery.toLowerCase()))
    : allFilePaths.slice(0, 20);

  // --- Render helpers ---
  const renderTree = (entries: TreeEntry[], depth = 0) => (
    <div style={{ paddingLeft: depth * 14 }}>
      {entries.map(entry => (
        <div key={entry.path}>
          {entry.type === 'directory' ? (
            <>
              <div className="group flex items-center">
                <button
                  onClick={() => toggleDir(entry.path)}
                  aria-expanded={Boolean(expandedDirs[entry.path])}
                  className="flex items-center gap-1.5 flex-1 px-2 py-1 text-xs text-slate-300 hover:bg-white/5 rounded transition-colors"
                >
                  {expandedDirs[entry.path] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <FolderOpen size={13} className={entry.gitStatus ? 'text-amber-400' : 'text-amber-400/70'} />
                  {renamingEntry?.path === entry.path ? (
                    <input
                      aria-label={`Rename folder ${entry.name}`}
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={executeRenameEntry}
                      onKeyDown={e => { if (e.key === 'Enter') executeRenameEntry(); if (e.key === 'Escape') setRenamingEntry(null); }}
                      onClick={e => e.stopPropagation()}
                      className="flex-1 bg-slate-800 text-white px-1.5 py-0.5 rounded text-xs min-w-0 border border-emerald-500/30 focus:outline-none"
                      autoFocus
                      onFocus={e => e.target.select()}
                    />
                  ) : (
                    <span className="flex-1 text-left truncate">{entry.name}</span>
                  )}
                  {entry.gitStatus && !renamingEntry && <span className={`text-[10px] ${gitStatusColor(entry.gitStatus)}`}>●</span>}
                </button>
                {!renamingEntry && (
                  <div className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all">
                    <button aria-label={`Rename folder ${entry.name}`} onClick={e => { e.stopPropagation(); startRenameEntry(entry); }} className="inline-flex size-7 items-center justify-center text-slate-600 hover:text-blue-400 transition-all" title="Rename">
                      <Edit3 size={10} />
                    </button>
                    <button aria-label={`Delete folder ${entry.name}`} onClick={() => requestDeleteFile(entry.path)} className="inline-flex size-7 items-center justify-center mr-1 text-slate-600 hover:text-red-400 transition-all" title="Delete">
                      <Trash2 size={10} />
                    </button>
                  </div>
                )}
              </div>
              {expandedDirs[entry.path] && renderTree(expandedDirs[entry.path], depth + 1)}
            </>
          ) : (
            <div className="group flex items-center">
              <button
                onClick={() => { if (renamingEntry?.path !== entry.path) { openFileHandler(entry.path); if (isMobile) setSidebarVisible(false); } }}
                disabled={projectOperation !== null}
                className={`flex items-center gap-1.5 flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  (openFile?.path === entry.path || openMedia?.path === entry.path) ? 'accent-active' : 'text-slate-400 hover:bg-white/5 hover:text-white'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span className="w-3" />
                {(() => { const Icon = getFileIcon(entry.name); return <Icon size={13} />; })()}
                {renamingEntry?.path === entry.path ? (
                  <input
                    aria-label={`Rename file ${entry.name}`}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={executeRenameEntry}
                    onKeyDown={e => { if (e.key === 'Enter') executeRenameEntry(); if (e.key === 'Escape') setRenamingEntry(null); }}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 bg-slate-800 text-white px-1.5 py-0.5 rounded text-xs min-w-0 border border-emerald-500/30 focus:outline-none"
                    autoFocus
                    onFocus={e => e.target.select()}
                  />
                ) : (
                  <span className="truncate flex-1 text-left">{entry.name}</span>
                )}
                {entry.gitStatus && !renamingEntry && (
                  <span className={`text-[10px] font-mono font-bold ${gitStatusColor(entry.gitStatus)}`}>
                    {gitStatusIcon(entry.gitStatus)}
                  </span>
                )}
              </button>
              {!renamingEntry && (
                <div className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all">
                  <button aria-label={`Rename file ${entry.name}`} onClick={e => { e.stopPropagation(); startRenameEntry(entry); }} className="inline-flex size-7 items-center justify-center text-slate-600 hover:text-blue-400 transition-all" title="Rename">
                    <Edit3 size={10} />
                  </button>
                  <button aria-label={`Delete file ${entry.name}`} onClick={() => requestDeleteFile(entry.path)} className="inline-flex size-7 items-center justify-center mr-1 text-slate-600 hover:text-red-400 transition-all" title="Delete">
                    <Trash2 size={10} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const renderDiff = (diffText: string) => {
    const lines = diffText.split('\n');
    return (
      <pre className="text-[11px] font-mono leading-relaxed overflow-auto">
        {lines.map((line, i) => {
          let cls = 'text-slate-400';
          let bg = '';
          if (line.startsWith('+') && !line.startsWith('+++')) { cls = 'text-green-400'; bg = 'bg-green-500/5'; }
          else if (line.startsWith('-') && !line.startsWith('---')) { cls = 'text-red-400'; bg = 'bg-red-500/5'; }
          else if (line.startsWith('@@')) { cls = 'text-blue-400'; bg = 'bg-blue-500/5'; }
          else if (line.startsWith('diff') || line.startsWith('index')) { cls = 'text-slate-500'; }
          return <div key={i} className={`px-3 ${bg} ${cls}`}>{line || ' '}</div>;
        })}
      </pre>
    );
  };

  // Handle title bar path editing
  const handlePathEdit = async (newPath: string) => {
    if (pathEditInFlightRef.current) return;
    if (!selectedProject || !openFile) return;
    if (newPath === openFile.path || !newPath.trim()) {
      setEditingPath(false);
      return;
    }
    
    if (!isValidProjectRelativePath(newPath.trim())) {
      showToast('Invalid path', 'error');
      setEditingPath(false);
      return;
    }
    
    pathEditInFlightRef.current = true;
    try {
      await flushPendingAutoSave();
      await fileWriteQueueRef.current.waitFor(selectedProject, openFile.path);
      const normalizedPath = newPath.trim();
      await projectsAPI.renameFile(selectedProject, openFile.path, normalizedPath);
      const renamedOpenFile = { ...openFile, path: normalizedPath };
      openFileRef.current = renamedOpenFile;
      setOpenFile(renamedOpenFile);
      showToast('File moved - refresh sidebar to see changes');
    } catch (err: any) {
      showToast(err.response?.data?.error || 'Move failed', 'error');
    } finally {
      pathEditInFlightRef.current = false;
      setEditingPath(false);
    }
  };

  // File breadcrumbs
  const renderBreadcrumbs = (filePath: string) => {
    
    if (editingPath) {
      return (
        <input
          aria-label="File path"
          type="text"
          value={pathEditValue}
          onChange={(e) => setPathEditValue(e.target.value)}
          onBlur={() => handlePathEdit(pathEditValue)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handlePathEdit(pathEditValue);
            if (e.key === 'Escape') setEditingPath(false);
          }}
          autoFocus
          className="flex-1 px-2 py-0.5 text-xs bg-white/5 border border-emerald-500/50 rounded text-slate-200 focus:outline-none focus:border-emerald-500"
          placeholder="path/to/file.ext"
        />
      );
    }
    
    const parts = filePath.split('/');
    return (
      <button
        type="button"
        className="flex items-center gap-0.5 text-left text-xs text-slate-500 hover:text-slate-300 transition-colors group"
        onClick={() => {
          setEditingPath(true);
          setPathEditValue(filePath);
        }}
        title="Click to edit path (move/rename file)"
      >
        {parts.map((part, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight size={10} />}
            <span className={i === parts.length - 1 ? 'text-slate-300' : ''}>{part}</span>
          </span>
        ))}
        <Edit3 size={10} className="ml-1 opacity-0 group-hover:opacity-50" />
      </button>
    );
  };

  // Monaco editor component (reused for normal and fullscreen)
  const editorElement = openFile && (
    <Suspense fallback={<div className="h-full w-full flex items-center justify-center bg-theme-surface text-theme-text-muted"><Loader2 size={20} className="animate-spin" /></div>}>
      <LazyMonacoEditor
      height="100%"
      language={openFile.language}
      value={editorContent}
      onChange={handleEditorChange}
      theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
      options={{
        minimap: { enabled: editorFullscreen },
        fontSize: editorFullscreen ? 14 : 13,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
        fontLigatures: true,
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'on',
        padding: { top: 8 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        bracketPairColorization: { enabled: true },
      }}
      />
    </Suspense>
  );

  const runtimeImageRepairRecovery = deploymentControlError?.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
    ? isOwner(user) ? (
      <div className="space-y-1.5 pt-1 text-red-100/90">
        <button
          type="button"
          onClick={() => { void prepareRuntimeImageRepair(); }}
          disabled={runtimeImageRepairPhase !== 'idle'}
          aria-busy={runtimeImageRepairPhase === 'preparing'}
          className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-red-300/20 bg-red-300/10 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-300/20 disabled:cursor-wait disabled:opacity-40"
        >
          {runtimeImageRepairPhase === 'preparing'
            ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> Checking repair…</>
            : 'Repair runtime image and retry'}
        </button>
        <p className="text-[10px] leading-relaxed">
          This narrow host repair verifies a new immutable image, restarts Portal once, then safely retries the exact failed Project action if its Project and App identity are unchanged.
        </p>
        {runtimeImageRepairError && (
          <p role="alert" className="text-[10px] leading-relaxed text-red-100">{runtimeImageRepairError}</p>
        )}
      </div>
    ) : (
      <p className="pt-1 text-[10px] leading-relaxed text-red-100/90">
        Ask the Portal Owner to run this Project runtime image repair. Portal will verify the image and retry the exact failed Project action only if its identity is still current. No repair has started.
      </p>
    )
    : null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col">
      {/* Enhanced Toast with expandable details */}
      {toast && (
        <ViewportOverlay anchor="top-right" zIndex={1200} className="w-[min(32rem,calc(100vw-2rem))]">
          <AnimatePresence>
            <motion.div
              role={toast.type === 'error' ? 'alert' : 'status'}
              aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className={`rounded-xl text-sm font-medium shadow-2xl backdrop-blur-xl border ${
              toast.type === 'success' ? 'bg-emerald-500/90 border-emerald-400/30 text-white' :
              toast.type === 'error' ? 'bg-red-700 border-red-500/50 text-white' :
              'bg-blue-500/90 border-blue-400/30 text-white'
            }`}
          >
            {/* Main message row */}
            <div className="flex items-start gap-2 px-4 py-3">
              <span className="mt-0.5 flex-shrink-0">{toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : 'ℹ️'}</span>
              <span className="flex-1 min-w-0 whitespace-pre-line break-words leading-relaxed">{toast.message}</span>
              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                {(toast.detail || toast.hint) && (
                  <button
                    aria-label={toastExpanded ? 'Hide notification details' : 'Show notification details'}
                    aria-expanded={toastExpanded}
                    onClick={() => setToastExpanded(!toastExpanded)}
                    className="p-1 rounded hover:bg-white/20 transition-colors text-xs"
                    title={toastExpanded ? 'Collapse' : 'Show details'}
                  >
                    {toastExpanded ? '▲' : '▼'}
                  </button>
                )}
                <button aria-label="Dismiss notification" onClick={() => setToast(null)} className="p-1 rounded hover:bg-white/20 transition-colors font-bold">✕</button>
              </div>
            </div>
            {/* Hint (always visible for errors) */}
            {toast.hint && !toastExpanded && (
              <div className="px-4 pb-2 text-xs opacity-80">💡 {toast.hint}</div>
            )}
            {/* Expanded details */}
            {toastExpanded && (toast.detail || toast.hint) && (
              <div className="px-4 pb-3 pt-1 border-t border-white/10">
                {toast.hint && <div className="text-xs mb-2 opacity-90">💡 <strong>Hint:</strong> {toast.hint}</div>}
                {toast.detail && (
                  <div className="relative">
                    <pre className="theme-fixed-dark text-[11px] bg-black/40 rounded-lg p-2.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed text-white/95">
                      {toast.detail}
                    </pre>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText([toast.message, toast.detail, toast.hint].filter(Boolean).join('\n\n'));
                        setToastCopied(true);
                        setTimeout(() => setToastCopied(false), 2000);
                      }}
                      className="theme-fixed-dark absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] bg-black/60 hover:bg-black/80 text-white transition-colors"
                      title="Copy error details"
                    >
                      {toastCopied ? '✓ Copied' : '📋 Copy'}
                    </button>
                  </div>
                )}
              </div>
            )}
            </motion.div>
          </AnimatePresence>
        </ViewportOverlay>
      )}

      {/* Fullscreen Editor Overlay */}
      <ViewportModal
        open={editorFullscreen && !!openFile}
        onDismiss={() => setEditorFullscreen(false)}
        initialFocusRef={fullscreenExitButtonRef}
        className="bg-[#0A0E27]/98 backdrop-blur-sm"
      >
        {editorFullscreen && openFile && (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Fullscreen editor for ${openFile.path}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex h-full w-full flex-col"
          >
            {/* Fullscreen toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-[#0D1130]/90">
              <div className="flex items-center gap-3">
                <FileCode size={14} className="text-emerald-400" />
                {renderBreadcrumbs(openFile.path)}
                {modified && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="Unsaved changes" />}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 px-2 py-0.5 rounded bg-white/5">{openFile.language}</span>
                <button onClick={saveFile} disabled={!modified || saving} aria-busy={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs disabled:opacity-30 transition-colors">
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {saving ? 'Saving…' : 'Save'}
                </button>
                <button ref={fullscreenExitButtonRef} onClick={() => setEditorFullscreen(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white text-xs transition-colors">
                  <Minimize2 size={12} /> Exit <kbd className="ml-1 text-[9px] px-1 py-0.5 rounded bg-white/5 border border-white/10">ESC</kbd>
                </button>
              </div>
            </div>
            {/* Editor fills remaining space */}
            <div className="flex-1">
              {editorElement}
            </div>
          </motion.div>
        )}
      </ViewportModal>

      {/* File Search Dialog (Ctrl+P) */}
      <ViewportModal
        open={showFileSearch && !!selectedProject}
        onDismiss={() => setShowFileSearch(false)}
        initialFocusRef={fileSearchInputRef}
        className="items-start bg-black/60 p-4 pt-[15vh] backdrop-blur-sm"
      >
        {showFileSearch && selectedProject && (
            <motion.div initial={{ scale: 0.95, y: -10 }} animate={{ scale: 1, y: 0 }}
              role="dialog" aria-modal="true" aria-label="Search project files"
              className="glass max-h-[calc(85dvh-1rem)] w-full max-w-lg overflow-hidden shadow-2xl">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
                <Search size={14} className="text-slate-500" />
                <input
                  ref={fileSearchInputRef}
                  aria-label="Search project files"
                  value={fileSearchQuery}
                  onChange={e => setFileSearchQuery(e.target.value)}
                  className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
                  placeholder="Search files..."
                />
                <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-500">ESC</kbd>
              </div>
              <div className="max-h-64 overflow-auto py-1">
                {filteredFiles.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-slate-500">No files found</div>
                ) : filteredFiles.map(fp => (
                  <button key={fp} onClick={() => { openFileHandler(fp); setShowFileSearch(false); setFileSearchQuery(''); }}
                    className="w-full px-4 py-2 text-left text-xs text-slate-300 hover:bg-emerald-500/10 hover:text-emerald-400 flex items-center gap-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50">
                    <FileText size={12} className="text-slate-500 flex-shrink-0" />
                    <span className="truncate">{fp}</span>
                  </button>
                ))}
              </div>
            </motion.div>
        )}
      </ViewportModal>

      {/* Top Bar */}
      <div className="flex items-center justify-between px-2 md:px-4 py-2 md:py-2.5 border-b border-white/5 bg-[#0D1130]/80 flex-shrink-0 gap-1">
        <div className="flex items-center gap-1.5 md:gap-3 min-w-0 flex-shrink overflow-hidden">
          <button aria-label="Toggle projects sidebar" aria-expanded={sidebarVisible} aria-controls="projects-sidebar" onClick={() => setSidebarVisible(v => !v)} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white transition-colors flex-shrink-0" title="Toggle sidebar (Ctrl+B)">
            {sidebarVisible ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
          </button>
          <Rocket size={16} className="text-emerald-400 flex-shrink-0 hidden md:block" />
          <span className="font-medium text-sm hidden md:inline">Projects</span>
          {selectedProject && (
            <>
              <span className="text-xs text-slate-500 hidden md:inline">/</span>
              <span className="text-xs text-slate-300 font-medium truncate">{selectedProject}</span>
              {currentProject?.currentBranch && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20 flex-shrink-0 hidden sm:flex">
                  <GitBranch size={10} />
                  {currentProject.currentBranch}
                </span>
              )}
            </>
          )}
          {modified && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0 md:hidden" />}
          {modified && <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1 flex-shrink-0 hidden md:flex"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> Unsaved</span>}
        </div>
        <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
          {/* === MOBILE: Only Save + Deploy/Run + Overflow Menu === */}
          {isMobile && selectedProject && (
            <>
              {openFile && (
                <button onClick={saveFile} disabled={!modified || saving}
                  aria-label={saving ? 'Saving file…' : 'Save file'}
                  aria-busy={saving}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs disabled:opacity-30 min-w-[44px] min-h-[44px] justify-center">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                </button>
              )}
              {canRedeployCurrentProject && (
                <button
                  onClick={() => { void deployProject(); }}
                  disabled={deploying || deploymentControlBusy !== null}
                  aria-label={deploying ? (isRuntimeProject ? 'Starting project…' : 'Deploying project…') : (isRuntimeProject ? 'Run project' : 'Deploy project')}
                  aria-busy={deploying}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium min-w-[44px] min-h-[44px] justify-center ${
                    deployStatus === 'success' ? 'bg-emerald-500/20 text-emerald-300' :
                    deployStatus === 'failed' ? 'bg-red-500/20 text-red-300' :
                    isRuntimeProject ? 'bg-green-500 text-white' : 'bg-emerald-500 text-white'
                  } disabled:opacity-50`}>
                  {deploying ? <Loader2 size={14} className="animate-spin" /> :
                   deployStatus === 'success' ? <CheckCircle size={14} /> :
                   isRuntimeProject ? <Play size={14} /> : <Upload size={14} />}
                </button>
              )}
              <MobileOverflowMenu actions={[
                ...(openFile ? [
                  { label: 'Fullscreen Editor', icon: <Maximize2 size={16} />, onClick: () => setEditorFullscreen(true) },
                  { label: `Analyze (${analyzeModel ? formatOllamaModelLabel(analyzeModel) : 'No local model'})`, icon: <Zap size={16} />, onClick: analyzeFile, disabled: analyzing || !analyzeModel || ollamaAvailable === false },
                ] : []),
                // Show Check for runtime, Preview for others
                ...(isRuntimeProject 
                  ? [{ label: 'Check Syntax', icon: <CheckCircle size={16} />, onClick: checkProject, disabled: checkingProject }]
                  : [{ label: 'Preview', icon: <Eye size={16} />, onClick: () => setShowPreview(!showPreview), active: showPreview }]
                ),
                { label: 'Git', icon: <GitBranch size={16} />, onClick: () => toggleActivePanel('git'), active: activePanel === 'git', disabled: shareActionActive && activePanel === 'share' },
                { label: 'Activity', icon: <Activity size={16} />, onClick: () => toggleActivePanel('activity'), active: activePanel === 'activity', disabled: shareActionActive && activePanel === 'share' },
                { label: 'Share', icon: <Share2 size={16} />, onClick: () => toggleActivePanel('share'), active: activePanel === 'share', disabled: shareActionActive && activePanel === 'share' },
                ...(deploymentPanelAvailable ? [{
                  label: 'Deployment controls',
                  icon: <Rocket size={16} />,
                  onClick: () => toggleActivePanel('deployment'),
                  active: activePanel === 'deployment',
                }] : []),
                { label: 'Project Chat', icon: <Bot size={16} />, onClick: () => agentChatOpen ? closeAgentChat() : openAgentChat(), active: agentChatOpen, disabled: !currentProjectAvailable },
                { label: 'Download (Full)', icon: <Download size={16} />, onClick: () => downloadProject('full') },
                { label: 'Download (Clean)', icon: <Download size={16} />, onClick: () => downloadProject('clean') },
                { label: 'Download (Stripped)', icon: <Download size={16} />, onClick: () => downloadProject('stripped'), variant: 'danger' as const },
                ...(currentProject?.deployedUrl ? [{ label: 'Open Live Site', icon: <ExternalLink size={16} />, onClick: () => window.open(currentProject.deployedUrl, '_blank') }] : []),
              ]} />
            </>
          )}
          {/* === DESKTOP: Full toolbar (unchanged) === */}
          {!isMobile && (
            <>
              {selectedProject && openFile && (
                <>
                  <button onClick={saveFile} disabled={!modified || saving}
                    aria-busy={saving}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs disabled:opacity-30 transition-colors">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditorFullscreen(true)}
                    aria-label="Open fullscreen editor"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white text-xs transition-colors" title="Fullscreen (Ctrl+Shift+F)">
                    <Maximize2 size={12} />
                  </button>
                  <select value={analyzeModel} onChange={e => setAnalyzeModel(e.target.value)} disabled={analyzeModels.length === 0}
                    aria-label="Ollama model for code analysis"
                    className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 focus:outline-none focus:border-purple-500/30">
                    {analyzeModels.length === 0 && <option value="">No installed Ollama models</option>}
                    {analyzeModels.map((model) => (
                      <option key={model} value={model}>{formatOllamaModelLabel(model)}</option>
                    ))}
                  </select>
                  <button onClick={analyzeFile} disabled={analyzing || !analyzeModel || ollamaAvailable === false}
                    aria-busy={analyzing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 text-xs transition-colors disabled:opacity-50">
                    {analyzing ? <><Loader2 size={12} className="animate-spin" /> Analyzing...</> : <><Zap size={12} /> Analyze</>}
                  </button>
                </>
              )}
              {selectedProject && (
                <>
                  {/* Preview button for static/fullstack, Check button for runtime */}
                  {isRuntimeProject ? (
                    <button onClick={checkProject} disabled={checkingProject}
                      aria-busy={checkingProject}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${checkingProject ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}>
                      {checkingProject ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />} {checkingProject ? 'Checking…' : 'Check'}
                    </button>
                  ) : (
                    <button onClick={() => setShowPreview(!showPreview)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${showPreview ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}>
                      <Eye size={12} /> Preview
                    </button>
                  )}
                  <button onClick={() => toggleActivePanel('git')} disabled={shareActionActive && activePanel === 'share'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${activePanel === 'git' ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30' : 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20'}`}>
                    <GitBranch size={12} /> Git
                  </button>
                  <button onClick={() => toggleActivePanel('activity')} disabled={shareActionActive && activePanel === 'share'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${activePanel === 'activity' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20'}`}>
                    <Activity size={12} /> Activity
                  </button>
                  <button onClick={() => toggleActivePanel('share')} disabled={shareActionActive && activePanel === 'share'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${activePanel === 'share' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-500/10 text-violet-400 hover:bg-violet-500/20'}`}>
                    <Share2 size={12} /> Share
                  </button>
                  {deploymentPanelAvailable && (
                    <button
                      onClick={() => toggleActivePanel('deployment')}
                      aria-pressed={activePanel === 'deployment'}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                        activePanel === 'deployment'
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                          : 'bg-sky-500/10 text-sky-400 hover:bg-sky-500/20'
                      }`}
                    >
                      <Rocket size={12} /> Deployment
                    </button>
                  )}
                  {/* Deploy button for static/fullstack, Run button for runtime */}
                  {canRedeployCurrentProject && (
                    <button onClick={() => { void deployProject(); }} disabled={deploying || deploymentControlBusy !== null}
                      aria-busy={deploying}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors font-medium ${
                        deployStatus === 'success' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                        deployStatus === 'failed' ? 'bg-red-500/20 text-red-300 border border-red-500/30' :
                        isRuntimeProject ? 'bg-green-500 text-white hover:bg-green-400' : 'bg-emerald-500 text-white hover:bg-emerald-400'
                      } disabled:opacity-50`}>
                      {deploying ? <Loader2 size={12} className="animate-spin" /> :
                       deployStatus === 'success' ? <CheckCircle size={12} /> :
                       deployStatus === 'failed' ? <AlertCircle size={12} /> :
                       isRuntimeProject ? <Play size={12} /> : <Upload size={12} />}
                      {deploying ? (isRuntimeProject ? 'Starting…' : 'Deploying…') :
                       deployStatus === 'success' ? (isRuntimeProject ? 'Running!' : 'Deployed!') :
                       deployStatus === 'failed' ? 'Failed' :
                       isRuntimeProject ? 'Run' : 'Deploy'}
                    </button>
                  )}
                  
                  {/* Download buttons */}
                  <div className="flex gap-1">
                    <button onClick={() => downloadProject('full')} title="Full backup - everything included"
                      aria-label="Download full project backup"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs transition-colors border border-emerald-500/20">
                      <Download size={12} />
                    </button>
                    <button onClick={() => downloadProject('clean')} title="Clean - no junk files, comments preserved"
                      aria-label="Download clean project backup"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 text-xs transition-colors border border-yellow-500/20">
                      <Download size={12} />
                    </button>
                    <button onClick={() => downloadProject('stripped')} title="Stripped - no junk files, no comments"
                      aria-label="Download stripped project backup"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs transition-colors border border-red-500/20">
                      <Download size={12} />
                    </button>
                  </div>
                  {currentProject?.deployedUrl && (
                    <a href={currentProject.deployedUrl} target="_blank" rel="noopener noreferrer"
                      aria-label={`Open deployed site for ${currentProject.name}`}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:text-white text-xs transition-colors">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </>
              )}
              {selectedProject && (
                <button
                  onClick={() => agentChatOpen ? closeAgentChat() : openAgentChat()}
                  disabled={projectOperation !== null || !currentProjectAvailable}
                  aria-label={agentChatOpen ? 'Close Project Chat' : 'Open Project Chat'}
                  aria-pressed={agentChatOpen}
                  title={!currentProjectAvailable ? currentProject?.availability?.message : undefined}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${agentChatOpen ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20'}`}>
                  <Bot size={12} /> Project Chat
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Project List & File Tree */}
        <AnimatePresence>
          {sidebarVisible && (
            <ResponsiveProjectSidebar
              isMobile={isMobile}
              onDismiss={() => {
                if (!projectOperationRef.current) setSidebarVisible(false);
              }}
            >
              <div className="p-2 border-b border-white/5 flex items-center justify-between">
                <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider px-1">Projects</span>
                <div className="flex gap-0.5">
                  <button
                    aria-label={projectsCollapsed ? 'Expand project list' : 'Collapse project list'}
                    aria-expanded={!projectsCollapsed}
                    onClick={() => setProjectsCollapsed((value) => { const next = !value; localStorage.setItem('projects-sidebar-collapsed', next ? '1' : '0'); return next; })}
                    className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-white transition-colors"
                    title={projectsCollapsed ? 'Show all projects' : 'Collapse to the active project'}
                  >
                    {projectsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <button aria-label="Create project" onClick={() => { setShowCreate(true); setNewName(''); setCloneUrl(''); setZipFile(null); setUploadProgress(null); }} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-500 hover:text-emerald-400 transition-colors" title="New Project">
                    <Plus size={14} />
                  </button>
                  <button aria-label="Search project files" onClick={() => setShowFileSearch(true)} className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-white transition-colors" title="Search files (Ctrl+P)">
                    <Search size={11} />
                  </button>
                  <button aria-label="Refresh projects" onClick={loadProjects} className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-white transition-colors" title="Refresh">
                    <RefreshCw size={11} />
                  </button>
                  {isMobile && (
                    <button aria-label="Close projects sidebar" onClick={() => setSidebarVisible(false)} className="inline-flex size-7 items-center justify-center rounded text-slate-500 hover:bg-white/5 hover:text-white">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div
                role="region"
                aria-label="Project list"
                className={`min-h-0 overflow-y-auto ${selectedProject ? 'max-h-[42%] flex-none' : 'flex-1'}`}
              >
                {projectsError && (
                  <div role="alert" className="m-2 rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-xs text-red-100">
                    <p className="font-medium">Projects couldn’t be loaded</p>
                    <p className="mt-1 break-words text-[11px] leading-relaxed text-red-200/75">{projectsError}</p>
                    <button type="button" onClick={() => { void loadProjects(); }} disabled={loading} className="mt-2 rounded-md bg-red-400/15 px-2 py-1 text-[11px] hover:bg-red-400/25 disabled:opacity-50">Try again</button>
                  </div>
                )}
                {loading && projects.length === 0 ? (
                  <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
                ) : projects.length === 0 && !projectsError ? (
                  <div className="text-center py-8 px-4">
                    <Globe size={32} className="mx-auto mb-2 text-slate-600" />
                    <p className="text-slate-500 text-xs">No projects yet</p>
                    <button onClick={() => setShowCreate(true)} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300">Create one →</button>
                  </div>
                ) : (
                  <div className="p-1 space-y-0.5">
                    {!projectsCollapsed && projects.length > 5 && (
                      <div className="px-1 pb-1">
                        <input
                          aria-label="Filter projects"
                          value={projectFilter}
                          onChange={(e) => setProjectFilter(e.target.value)}
                          placeholder="Filter projects…"
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-emerald-500/40"
                        />
                      </div>
                    )}
                    {projectsCollapsed && (
                      <button
                        onClick={() => { setProjectsCollapsed(false); localStorage.setItem('projects-sidebar-collapsed', '0'); }}
                        className="w-full text-left px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                      >
                        {projects.length - (selectedProject ? 1 : 0)} more project{projects.length - (selectedProject ? 1 : 0) === 1 ? '' : 's'} hidden — show all
                      </button>
                    )}
                    {visibleSidebarProjects.map((p) => {
                      const canRenameProject = p.destructiveActions.allowed
                        && projectLifecycleActionAllowed(p, 'rename-project');
                      const canDeleteProject = p.destructiveActions.allowed
                        && projectLifecycleActionAllowed(p, 'delete-project');
                      const projectActionLimitation = p.destructiveActions.reason
                        || ((!canRenameProject || !canDeleteProject)
                          ? 'The server-managed deployment policy does not allow Portal to rename or delete this Project.'
                          : null);
                      const projectActionsLimited = !canRenameProject || !canDeleteProject;
                      return (
                      <div key={p.name} className="group">
                          <div
                            className={`flex items-center w-full text-xs rounded-lg transition-colors ${
                              p.availability?.available === false
                                ? 'border border-amber-400/15 bg-amber-500/[0.06] text-amber-100/70'
                                : selectedProject === p.name ? 'accent-active border' : 'text-slate-300 hover:bg-white/5'
                            }`}
                          >
                            <button
                              disabled={p.availability?.available === false || shareActionActive || projectOperation !== null || deleteBusy}
                              onClick={() => {
                                if (projectOperationRef.current) return;
                                if (projectDeepLinkPresent) navigate('/projects', { replace: true });
                                void selectProject(p.name);
                              }}
                              onDoubleClick={(e) => { e.preventDefault(); void startRenameProject(p.name); }}
                              aria-current={selectedProject === p.name ? 'page' : undefined}
                              aria-describedby={p.availability?.available === false ? `project-availability-${p.identity.id}` : undefined}
                              title={p.availability?.available === false ? p.availability.message : undefined}
                              className="flex flex-1 items-center gap-1.5 min-w-0 px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {p.availability?.available === false
                                ? <AlertCircle size={13} className="flex-shrink-0 text-amber-300" />
                                : <Globe size={13} className="flex-shrink-0" />}
                              <span className="truncate">{p.name}</span>
                              {p.deployedUrl && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" title="Deployed" />}
                              {p.currentBranch && p.currentBranch !== 'main' && p.currentBranch !== 'master' && (
                                <span className="text-[9px] text-orange-400/60 flex-shrink-0">⌥ {p.currentBranch}</span>
                              )}
                            </button>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all flex-shrink-0">
                              <button
                                aria-label={`Rename project ${p.name}`}
                                aria-describedby={!canRenameProject ? `project-actions-${p.identity.id}` : undefined}
                                disabled={!canRenameProject || projectOperation !== null || deleteBusy}
                                onClick={(e) => { e.stopPropagation(); void startRenameProject(p.name); }}
                                className="inline-flex size-8 items-center justify-center hover:text-emerald-300 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                                title={canRenameProject ? 'Rename project' : projectActionLimitation || undefined}
                              >
                                <Edit3 size={11} />
                              </button>
                              <button
                                aria-label={`Delete project ${p.name}`}
                                aria-describedby={!canDeleteProject ? `project-actions-${p.identity.id}` : undefined}
                                disabled={!canDeleteProject || projectOperation !== null || deleteBusy}
                                onClick={(e) => { e.stopPropagation(); requestDeleteProject(p.name); }}
                                className="inline-flex size-8 items-center justify-center hover:text-red-400 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                                title={canDeleteProject ? 'Delete project' : projectActionLimitation || undefined}
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </div>
                          {p.availability?.available === false && (
                            <div id={`project-availability-${p.identity.id}`} className="px-2 pb-2 pt-1 text-[10px] leading-relaxed text-amber-100/70">
                              <p>{p.availability.message}</p>
                              {p.availability.retryable && (
                                <button type="button" onClick={() => { void loadProjects(); }} disabled={loading} className="mt-1 text-amber-300 underline-offset-2 hover:underline disabled:opacity-50">Check again</button>
                              )}
                              {!p.availability.retryable && (
                                <p className="mt-1 font-medium text-amber-200">Administrator reconciliation is required.</p>
                              )}
                            </div>
                          )}
                          {projectActionsLimited && selectedProject === p.name && (
                            <p
                              id={`project-actions-${p.identity.id}`}
                              className="px-2 pb-1.5 pt-1 text-[10px] leading-relaxed text-amber-200/80"
                            >
                              {projectActionLimitation}
                            </p>
                          )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* The active project's files own their own scroll pane so a
                  large project inventory can never push them off-screen. */}
              {selectedProject && (
                <div
                  role="region"
                  aria-label={`Files for ${selectedProject}`}
                  className="flex min-h-0 flex-1 flex-col border-t border-white/5"
                >
                    <div className="p-2 flex items-center justify-between">
                      <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider px-1">Files</span>
                      <div className="flex gap-0.5">
                        <button aria-label="Create file" onClick={() => { setShowNewFile(true); setNewFileIsDir(false); }} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white" title="New File"><FilePlus size={12} /></button>
                        <button aria-label="Create folder" onClick={() => { setShowNewFile(true); setNewFileIsDir(true); }} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white" title="New Folder"><FolderPlus size={12} /></button>
                        <button aria-label="Upload project files" onClick={() => openUploadDialog()} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-emerald-400" title="Upload Files"><Upload size={12} /></button>
                        <button aria-label="Refresh project files" aria-busy={treeLoading} disabled={treeLoading} onClick={() => { void refreshTree(); }} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white disabled:opacity-50" title="Refresh"><RefreshCw size={12} className={treeLoading ? 'animate-spin' : undefined} /></button>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                      {treeError && (
                        <div role="alert" className="mx-1 mb-2 rounded-lg border border-red-400/20 bg-red-500/10 p-2 text-[11px] text-red-100">
                          <p className="font-medium">Files couldn’t be loaded</p>
                          <p className="mt-1 break-words leading-relaxed text-red-200/70">{treeError}</p>
                          <button type="button" onClick={() => { void refreshTree(); }} disabled={treeLoading} className="mt-2 rounded bg-red-400/15 px-2 py-1 hover:bg-red-400/25 disabled:opacity-50">Try again</button>
                        </div>
                      )}
                      {treeLoading && tree.length === 0 ? (
                        <div role="status" className="flex items-center gap-2 px-2 py-3 text-[10px] text-slate-500"><Loader2 size={12} className="animate-spin" /> Loading files…</div>
                      ) : tree.length > 0 ? renderTree(tree) : !treeError ? (
                        <p className="px-2 py-3 text-[10px] text-slate-600">No files yet</p>
                      ) : null}
                    </div>
                </div>
              )}

              {/* Keyboard shortcuts hint */}
              <div className="p-2 border-t border-white/5 text-[9px] text-slate-600 space-y-0.5">
                <div className="flex justify-between"><span>Save</span><kbd className="px-1 rounded bg-white/5">⌘S</kbd></div>
                <div className="flex justify-between"><span>Fullscreen</span><kbd className="px-1 rounded bg-white/5">⌘⇧F</kbd></div>
                <div className="flex justify-between"><span>Search</span><kbd className="px-1 rounded bg-white/5">⌘P</kbd></div>
              </div>
            </ResponsiveProjectSidebar>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {selectedDiff ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                <Diff size={12} className="text-orange-400" />
                <span className="text-slate-300">{selectedDiff.file ? `Diff: ${selectedDiff.file}` : 'Diff'}</span>
                <button aria-label="Close file diff" onClick={() => setSelectedDiff(null)} className="ml-auto inline-flex size-8 items-center justify-center text-slate-500 hover:text-white"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-auto bg-theme-surface-raised">{renderDiff(selectedDiff.content)}</div>
            </>
          ) : openMedia ? (
            /* Media Preview */
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                {openMedia.category === 'image' ? <Image size={12} className="text-blue-400" /> :
                 openMedia.category === 'video' ? <Film size={12} className="text-purple-400" /> :
                 openMedia.category === 'audio' ? <Music size={12} className="text-pink-400" /> :
                 openMedia.category === 'pdf' ? <FileText size={12} className="text-red-400" /> :
                 openMedia.category === 'excel' ? <FileText size={12} className="text-emerald-400" /> :
                 openMedia.category === 'text' ? <FileCode size={12} className="text-cyan-400" /> :
                 <FileQuestion size={12} className="text-slate-400" />}
                <span className="text-slate-300">{openMedia.path.split('/').pop()}</span>
                <span className="text-[10px] text-slate-600 bg-white/5 px-1.5 py-0.5 rounded">{openMedia.category}</span>
                {openMedia.note && <span className="text-[10px] text-amber-300/80 ml-1">{openMedia.note}</span>}
              </div>
              <div className="flex-1 flex overflow-hidden">
                {openMedia.category === 'image' && <ProjectImageViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'audio' && <ProjectAudioViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'video' && <ProjectVideoViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} />}
                {openMedia.category === 'pdf' && <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500"><Loader2 size={20} className="animate-spin" /></div>}><LazyProjectPdfViewer src={openMedia.url} /></Suspense>}
                {openMedia.category === 'excel' && <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500"><Loader2 size={20} className="animate-spin" /></div>}><LazyProjectExcelViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} /></Suspense>}
                {openMedia.category === 'text' && <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500"><Loader2 size={20} className="animate-spin" /></div>}><LazyProjectTextPreviewViewer src={openMedia.url} name={openMedia.path.split('/').pop() || ''} /></Suspense>}
                {openMedia.category === 'binary' && <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500"><Loader2 size={20} className="animate-spin" /></div>}><LazyProjectBinaryViewer name={openMedia.path.split('/').pop() || ''} src={openMedia.url} /></Suspense>}
              </div>
            </>
          ) : openFile ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.02] text-xs">
                <FileCode size={12} className="text-slate-400" />
                {renderBreadcrumbs(openFile.path)}
                {modified && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="Unsaved changes" />}
                <div className="ml-auto flex items-center gap-2 text-[10px] text-slate-600">
                  <span className="text-[9px] text-slate-600 bg-white/5 px-1.5 py-0.5 rounded">auto-save</span>
                  <span>{openFile.language}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">⌘S</kbd>
                </div>
              </div>
              <div className="flex-1 flex overflow-hidden">
                {/* On narrow screens a half-width preview pane has no room and
                    the toggle looked dead; preview takes the full area there
                    with an explicit way back to the code. */}
                <div className={`${showPreview ? (isMobile ? 'hidden' : 'w-1/2') : 'w-full'} flex-shrink-0`}>
                  {!editorFullscreen && editorElement}
                </div>
                {showPreview && (
                  <div className={`${isMobile ? 'w-full' : 'w-1/2 border-l'} border-white/5 bg-white overflow-auto relative`}>
                    {isMobile && (
                      <button
                        onClick={() => setShowPreview(false)}
                        className="absolute top-2 right-2 z-10 px-2.5 py-1 rounded-md bg-black/70 text-white text-[11px] font-medium border border-white/20"
                      >
                        Back to code
                      </button>
                    )}
                    <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-theme-text-muted bg-theme-surface"><Loader2 size={20} className="animate-spin" /></div>}>
                      <LazyMarkdownPreviewFrame language={openFile.language} content={editorContent} theme={resolvedTheme} />
                    </Suspense>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <div className="text-center">
                <Rocket size={48} className="mx-auto mb-4 opacity-20" />
                <p className="text-sm font-medium mb-1">{selectedProject ? 'Select a file to edit or preview' : 'Select or create a project'}</p>
                <p className="text-xs text-slate-600">
                  {selectedProject ? 'Choose a file from the sidebar to open it.' : 'Choose a project from the sidebar or create a new one.'}
                </p>
                {selectedProject && (
                  <div className="mt-4 flex items-center justify-center gap-3 text-[10px] text-slate-600">
                    <span className="flex items-center gap-1"><Command size={10} />P — Search files</span>
                    <span className="flex items-center gap-1"><Command size={10} />B — Toggle sidebar</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Git / Share / Activity */}
        <AnimatePresence>
          {activePanel === 'git' && selectedProject && (
            <ResponsiveProjectPanel
              isMobile={isMobile}
              mobileLabel="Project Git panel"
              onDismiss={() => { if (projectOperationRef.current?.kind !== 'git') setActivePanel(null); }}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><GitBranch size={13} className="text-orange-400" /> Git</span>
                <div className="flex items-center gap-1">
                  {gitLoading && projectOperation?.kind !== 'git' && <Loader2 size={12} className="animate-spin text-slate-500" aria-label="Refreshing Git data" />}
                  <button aria-label="Close Git panel" onClick={() => { if (projectOperationRef.current?.kind !== 'git') setActivePanel(null); }} disabled={projectOperation?.kind === 'git'} className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-40"><X size={14} /></button>
                </div>
              </div>
              
              <div className="flex border-b border-white/5" role="tablist" aria-label="Git views">
                {[
                  { id: 'changes' as const, label: 'Changes', icon: Circle },
                  { id: 'log' as const, label: 'History', icon: History },
                  { id: 'branches' as const, label: 'Branches', icon: GitBranch },
                ].map(tab => (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={gitTab === tab.id}
                    disabled={projectOperation?.kind === 'git'}
                    onClick={() => { if (projectOperationRef.current?.kind !== 'git') setGitTab(tab.id); }}
                    className={`flex-1 flex items-center justify-center gap-1 py-2 text-[11px] transition-colors border-b-2 ${
                      gitTab === tab.id ? 'text-orange-400 border-orange-400' : 'text-slate-500 border-transparent hover:text-slate-300'
                    } disabled:cursor-wait disabled:opacity-50`}
                  >
                    <tab.icon size={11} />
                    {tab.label}
                    {tab.id === 'changes' && gitStatus && gitStatus.files.length > 0 && (
                      <span className="ml-1 w-4 h-4 rounded-full bg-orange-500/20 text-orange-400 text-[9px] flex items-center justify-center">
                        {gitStatus.files.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-auto">
                {gitTab === 'changes' && (
                  <div className="p-3 space-y-3">
                    {gitStatus && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] flex items-center gap-1 text-slate-400">
                          <GitBranch size={11} /> {gitStatus.branch}
                          {gitStatus.ahead > 0 && <span className="text-emerald-400 ml-1">↑{gitStatus.ahead}</span>}
                          {gitStatus.behind > 0 && <span className="text-blue-400 ml-1">↓{gitStatus.behind}</span>}
                        </span>
                        <div className="flex gap-1">
                          <button aria-label={projectOperation?.kind === 'git' && projectOperation.gitAction === 'pull' ? 'Pulling Git changes' : 'Pull Git changes'} aria-busy={projectOperation?.kind === 'git' && projectOperation.gitAction === 'pull'} disabled={gitLoading} onClick={gitPull} className="p-1.5 rounded bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30" title="Pull">{projectOperation?.kind === 'git' && projectOperation.gitAction === 'pull' ? <Loader2 size={12} className="animate-spin" /> : <ArrowDown size={12} />}</button>
                          <button aria-label={projectOperation?.kind === 'git' && projectOperation.gitAction === 'push' ? 'Pushing Git changes' : 'Push Git changes'} aria-busy={projectOperation?.kind === 'git' && projectOperation.gitAction === 'push'} disabled={gitLoading} onClick={gitPush} className="p-1.5 rounded bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30" title="Push">{projectOperation?.kind === 'git' && projectOperation.gitAction === 'push' ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={12} />}</button>
                          <button aria-label="Refresh Git status" disabled={gitLoading} onClick={loadGitStatus} className="p-1.5 rounded bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30" title="Refresh"><RefreshCw size={12} /></button>
                        </div>
                      </div>
                    )}
                    {gitStatus?.clean ? (
                      <div className="text-center py-6 text-slate-500 text-xs">
                        <Check size={24} className="mx-auto mb-2 text-emerald-400/50" />
                        <p>Working tree clean</p>
                      </div>
                    ) : gitStatus?.files.map(f => (
                      <div key={f.path} className="group flex items-center gap-1.5 py-1 text-xs">
                        <span className={`font-mono font-bold w-4 text-center ${gitStatusColor(f.status)}`}>{gitStatusIcon(f.status)}</span>
                        <button onClick={() => viewFileDiff(f.path)} className="flex-1 text-left text-slate-300 hover:text-white truncate">{f.path}</button>
                        {f.status !== 'untracked' && (
                          <button aria-label={`Discard changes to ${f.path}`} disabled={gitLoading} onClick={() => { setResetFileError(null); setPendingResetFile(f.path); }} className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 inline-flex size-7 items-center justify-center text-slate-600 hover:text-amber-400 disabled:opacity-30" title="Discard changes"><Undo2 size={11} /></button>
                        )}
                      </div>
                    ))}
                    {gitStatus && !gitStatus.clean && (
                      <div className="border-t border-white/5 pt-3">
                        <textarea aria-label="Commit message" value={commitMsg} onChange={e => setCommitMsg(e.target.value)} placeholder="Commit message..."
                          rows={2} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 resize-none focus:border-orange-500/30 focus:outline-none" />
                        <button onClick={commitChanges} disabled={!commitMsg.trim() || gitLoading}
                          aria-label={projectOperation?.kind === 'git' && projectOperation.gitAction === 'commit' ? 'Committing Git changes' : 'Commit All Changes'}
                          aria-busy={projectOperation?.kind === 'git' && projectOperation.gitAction === 'commit'}
                          className="mt-1.5 w-full py-2 rounded-lg bg-orange-500/10 text-orange-400 text-[11px] hover:bg-orange-500/20 flex items-center justify-center gap-1.5 disabled:opacity-30 font-medium transition-colors">
                          {projectOperation?.kind === 'git' && projectOperation.gitAction === 'commit'
                            ? <><Loader2 size={12} className="animate-spin" /> Committing…</>
                            : <><GitCommit size={12} /> Commit All Changes</>}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {gitTab === 'log' && (
                  <div>
                    {/* Branch filter */}
                    <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                      <GitBranch size={11} className="text-slate-500" />
                      <select aria-label="Filter commits by branch" value={logBranchFilter} onChange={e => setLogBranchFilter(e.target.value)}
                        className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-orange-500/30">
                        <option value="">All branches</option>
                        {branches.filter(b => !b.remote).map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
                        <option value="main">main</option>
                      </select>
                    </div>
                    <div className="divide-y divide-white/5">
                      {enhancedCommits.length === 0 && commitLog.length === 0 ? (
                        <div className="text-center py-8 text-slate-500 text-xs">No commits yet</div>
                      ) : (enhancedCommits.length > 0 ? enhancedCommits : []).map(c => {
                        const isExpanded = expandedCommit === c.hash;
                        const maxBar = Math.max(...c.stats.files.map(f => f.additions + f.deletions), 1);
                        return (
                          <div key={c.hash} className={`transition-colors ${isExpanded ? 'bg-white/[0.03]' : ''}`}>
                            <button onClick={() => setExpandedCommit(isExpanded ? null : c.hash)}
                              className="w-full text-left px-3 py-2.5 hover:bg-white/5 transition-colors">
                              <div className="flex items-center gap-2 mb-1">
                                <CheckCircle size={12} className="text-emerald-400/70 flex-shrink-0" />
                                <span className="text-xs text-slate-200 font-medium truncate flex-1">{c.message}</span>
                                <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded flex-shrink-0">{c.short}</span>
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-slate-500 ml-5">
                                <span title={new Date(c.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' })}>
                                  📅 {c.relativeDate}
                                </span>
                                <span>👤 {c.author}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-1 ml-5">
                                {c.refs && c.refs.split(',').filter(Boolean).map(ref => (
                                  <span key={ref.trim()} className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
                                    🌿 {ref.trim()}
                                  </span>
                                ))}
                                {c.stats.filesChanged > 0 && (
                                  <span className="text-[10px] text-slate-500">
                                    <span className="text-emerald-400">+{c.stats.insertions}</span>
                                    {' '}<span className="text-red-400">-{c.stats.deletions}</span>
                                    {' '}({c.stats.filesChanged} file{c.stats.filesChanged !== 1 ? 's' : ''})
                                  </span>
                                )}
                              </div>
                            </button>
                            
                            {/* Expanded details */}
                            {isExpanded && (
                              <div className="px-3 pb-3 space-y-2">
                                {/* File stats bars */}
                                {c.stats.files.length > 0 && (
                                  <div className="bg-white/[0.02] rounded-lg p-2 space-y-1.5">
                                    {c.stats.files.map(f => {
                                      const addWidth = maxBar > 0 ? (f.additions / maxBar) * 100 : 0;
                                      const delWidth = maxBar > 0 ? (f.deletions / maxBar) * 100 : 0;
                                      return (
                                        <div key={f.path} className="flex items-center gap-2 text-[10px]">
                                          <span className="text-slate-400 truncate flex-1 min-w-0 font-mono">{f.path}</span>
                                          <span className="text-emerald-400 w-8 text-right">+{f.additions}</span>
                                          <span className="text-red-400 w-8 text-right">-{f.deletions}</span>
                                          <div className="w-20 h-2 bg-white/5 rounded-full overflow-hidden flex flex-shrink-0">
                                            <div className="h-full bg-emerald-500/60" style={{ width: `${addWidth}%` }} />
                                            <div className="h-full bg-red-500/60" style={{ width: `${delWidth}%` }} />
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                
                                {/* Action buttons */}
                                <div className="flex gap-2">
                                  <button onClick={(e) => { e.stopPropagation(); viewCommitDiff(c.hash); }}
                                    className="flex-1 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-[10px] hover:bg-blue-500/20 flex items-center justify-center gap-1 transition-colors">
                                    <Diff size={11} /> View Diff
                                  </button>
                                  <button disabled={gitLoading} onClick={(e) => { e.stopPropagation(); setRevertTarget(c); }}
                                    className="flex-1 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 text-[10px] hover:bg-amber-500/20 flex items-center justify-center gap-1 transition-colors disabled:opacity-30">
                                    <Undo2 size={11} /> Revert
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {/* Fallback for basic commits when enhanced not available */}
                      {enhancedCommits.length === 0 && commitLog.map(c => (
                        <button key={c.hash} onClick={() => viewCommitDiff(c.hash)}
                          className={`w-full text-left px-3 py-2.5 hover:bg-white/5 transition-colors ${commitDiff?.hash === c.hash ? 'bg-white/5' : ''}`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{c.short}</span>
                            <span className="text-[10px] text-slate-600">{timeAgo(c.date)}</span>
                          </div>
                          <p className="text-xs text-slate-300 truncate">{c.message}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5">{c.author}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {gitTab === 'branches' && (
                  <div className="p-3 space-y-3">
                    <div className="flex gap-1.5">
                      <input aria-label="New branch name" value={newBranchName} onChange={e => setNewBranchName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createBranch()}
                        placeholder="New branch name..." className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-orange-500/30 focus:outline-none" />
                      <button aria-label={projectOperation?.kind === 'git' && projectOperation.gitAction === 'checkout-new' ? 'Creating Git branch' : 'Create branch'} aria-busy={projectOperation?.kind === 'git' && projectOperation.gitAction === 'checkout-new'} onClick={createBranch} disabled={!newBranchName.trim() || gitLoading} className="px-3 py-2 rounded-lg bg-orange-500/10 text-orange-400 text-xs hover:bg-orange-500/20 disabled:opacity-30">{projectOperation?.kind === 'git' && projectOperation.gitAction === 'checkout-new' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}</button>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-[10px] text-slate-600 uppercase tracking-wider mb-1">Local</div>
                      {branches.filter(b => !b.remote).map(b => (
                        <button key={b.name} disabled={gitLoading || b.current} aria-busy={projectOperation?.kind === 'git' && projectOperation.gitAction === 'checkout' && projectOperation.gitTarget === b.name} onClick={() => !b.current && switchBranch(b.name)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors disabled:opacity-50 ${b.current ? 'bg-orange-500/10 text-orange-400' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
                          {projectOperation?.kind === 'git' && projectOperation.gitAction === 'checkout' && projectOperation.gitTarget === b.name ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
                          <span className="truncate">{b.name}</span>
                          {b.current && <Check size={12} className="ml-auto" />}
                        </button>
                      ))}
                      {branches.some(b => b.remote) && (
                        <>
                          <div className="text-[10px] text-slate-600 uppercase tracking-wider mt-3 mb-1">Remote</div>
                          {branches.filter(b => b.remote).map(b => (
                            <button key={b.name} disabled={gitLoading} onClick={() => switchBranch(b.name.replace('origin/', ''))}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-slate-500 hover:bg-white/5 hover:text-slate-300 transition-colors disabled:opacity-50">
                              <Globe size={12} />
                              <span className="truncate">{b.name}</span>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </ResponsiveProjectPanel>
          )}

          {/* Analysis Results Panel */}
          {showAnalysisPanel && (
            <ResponsiveProjectPanel
              isMobile={isMobile}
              mobileLabel="Project analysis results"
              desktopWidth={380}
              onDismiss={() => setShowAnalysisPanel(false)}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Zap size={13} className="text-purple-400" /> Analysis Results</span>
                <button aria-label="Close analysis results" onClick={() => setShowAnalysisPanel(false)} className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white"><X size={14} /></button>
              </div>
              {analyzing && (
                <div className="h-1 bg-white/10 overflow-hidden">
                  <div className="h-full bg-purple-500 animate-pulse" style={{ width: '100%' }} />
                </div>
              )}
              <div className="flex-1 overflow-auto p-3 space-y-2">
                {analyzing && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-purple-400" /></div>}
                {!analyzing && analysisResults.length === 0 && (
                  <div className="text-center py-8 text-xs text-slate-500">No issues found ✨</div>
                )}
                {analysisResults.map((issue: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-lg bg-white/5 border border-white/10">
                    <div className="flex items-start gap-2 mb-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                        issue.severity === 'error' ? 'bg-red-500/20 text-red-400' :
                        issue.severity === 'warning' ? 'bg-amber-500/20 text-amber-400' :
                        'bg-blue-500/20 text-blue-400'
                      }`}>{issue.severity}</span>
                      {issue.line && <span className="text-[10px] text-slate-500">Line {issue.line}</span>}
                    </div>
                    <p className="text-xs text-slate-200 mb-1">{issue.message}</p>
                    {issue.suggestion && <p className="text-[11px] text-slate-400 mb-2">{issue.suggestion}</p>}
                    {issue.code && (
                      <div className="mb-2">
                        <pre className="text-[10px] bg-black/30 rounded p-2 text-emerald-300 overflow-x-auto">{issue.code}</pre>
                      </div>
                    )}
                    <div className="flex gap-2">
                      {(issue.code || issue.suggestion) && issue.line && (
                        <button onClick={() => acceptFix({ ...issue, code: issue.code || issue.suggestion })}
                          className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 text-[10px] hover:bg-emerald-500/30 transition-colors font-medium">
                          <Check className="w-3 h-3" />
                          Apply Fix
                        </button>
                      )}
                      <button onClick={() => dismissIssue(idx)}
                        className="px-2 py-1 rounded bg-slate-500/20 text-slate-400 text-[10px] hover:bg-slate-500/30 transition-colors">
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </ResponsiveProjectPanel>
          )}

          {/* A first full-stack deploy can fail before an App row exists. Keep
              the structured repair reachable even without deployment inventory. */}
          {activePanel === 'deployment'
            && selectedProject
            && currentProject
            && !currentProject.deployment
            && deploymentControlError?.recoveryAction === 'REPAIR_PROJECT_RUNTIME_IMAGE'
            && (
              <ResponsiveProjectPanel
                isMobile={isMobile}
                mobileLabel="Project deployment recovery"
                onDismiss={() => {
                  if (runtimeImageRepairPhase === 'idle') setActivePanel(null);
                }}
              >
                <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <Rocket size={13} className="text-sky-400" /> Deployment recovery
                  </span>
                  <button
                    aria-label="Close deployment recovery"
                    onClick={() => setActivePanel(null)}
                    disabled={runtimeImageRepairPhase !== 'idle'}
                    className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-40"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  <div role="alert" className="space-y-1.5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-200">
                    <p className="font-medium">{deploymentControlError.message}</p>
                    {deploymentControlError.detail && (
                      <p className="whitespace-pre-wrap leading-relaxed text-red-100/90">{deploymentControlError.detail}</p>
                    )}
                    {deploymentControlError.code && (
                      <p className="font-mono text-[10px] text-red-300">Code: {deploymentControlError.code}</p>
                    )}
                    {runtimeImageRepairRecovery}
                  </div>
                </div>
              </ResponsiveProjectPanel>
            )}

          {/* Deployment controls */}
          {activePanel === 'deployment' && selectedProject && currentProject?.deployment && (
            <ResponsiveProjectPanel
              isMobile={isMobile}
              mobileLabel="Project deployment controls"
              onDismiss={() => {
                if (!deploymentControlBusy) setActivePanel(null);
              }}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Rocket size={13} className="text-sky-400" /> Deployment
                </span>
                <div className="flex items-center gap-1">
                  <button
                    aria-label="Refresh deployment status"
                    aria-busy={deploymentControlBusy === 'refresh'}
                    onClick={() => { void loadDeploymentProcess(selectedProject); }}
                    disabled={deploymentControlBusy !== null}
                    className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-40"
                  >
                    <RefreshCw size={12} className={deploymentControlBusy === 'refresh' ? 'animate-spin' : ''} />
                  </button>
                  <button
                    aria-label="Close deployment controls"
                    onClick={() => setActivePanel(null)}
                    disabled={deploymentControlBusy !== null}
                    className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-40"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-3 space-y-3">
                <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                  {deploymentLiveStatusText}
                </p>
                {deploymentControlError && (
                  <div role="alert" className="space-y-1.5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-200">
                    <p className="font-medium">{deploymentControlError.message}</p>
                    {deploymentControlError.detail && (
                      <p className="whitespace-pre-wrap leading-relaxed text-red-100/90">{deploymentControlError.detail}</p>
                    )}
                    {deploymentControlError.limitation && (
                      <p className="whitespace-pre-wrap leading-relaxed text-amber-100">{deploymentControlError.limitation}</p>
                    )}
                    {deploymentControlError.code && (
                      <p className="font-mono text-[10px] text-red-300">Code: {deploymentControlError.code}</p>
                    )}
                    {runtimeImageRepairRecovery}
                    {deploymentControlError.recoveryAction === 'UNDEPLOY_CURRENT_DEPLOYMENT' && (
                      canUndeployCurrentProject ? (
                        <div className="space-y-1.5 pt-1 text-red-100/90">
                          <button
                            type="button"
                            onClick={() => setPendingUndeploy(currentProject.name)}
                            disabled={deploymentControlBusy !== null}
                            className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-red-300/20 bg-red-300/10 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-300/20 disabled:cursor-wait disabled:opacity-40"
                          >
                            Remove current deployment
                          </button>
                          <p className="text-[10px] leading-relaxed">
                            You will confirm removal before anything changes. Project source, Git history, and Project Chat are preserved.
                          </p>
                        </div>
                      ) : (
                        <p className="pt-1 text-[10px] leading-relaxed text-red-100/90">
                          Refresh the Project inventory. Portal will not remove a deployment unless the server confirms that action is supported.
                        </p>
                      )
                    )}
                  </div>
                )}
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Type</span>
                    <span className="font-medium text-slate-200">{ownedDeploymentProcess?.deployType || currentProject.deployment.deployType}</span>
                  </div>
                  {displayedRuntimeManagement && (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-slate-500">Managed by</span>
                      <span className="text-right font-medium text-slate-200">
                        {runtimeManagementLabel(displayedRuntimeManagement)}
                      </span>
                    </div>
                  )}
                  {displayedRuntimeStatusSource && (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-slate-500">Status source</span>
                      <span className="text-right text-slate-300">
                        {runtimeStatusSourceLabel(displayedRuntimeStatusSource)}
                      </span>
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-slate-500">Status</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      displayedDeploymentStatus === 'running'
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : displayedDeploymentStatus === 'error'
                          ? 'bg-red-500/10 text-red-300'
                          : displayedDeploymentStatus === 'unknown' || displayedDeploymentStatus === 'unavailable'
                            ? 'bg-amber-500/10 text-amber-300'
                            : 'bg-slate-500/10 text-slate-300'
                    }`}>
                      {displayedDeploymentStatus}
                    </span>
                  </div>
                  {displayedDeploymentPort && (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-slate-500">Internal port</span>
                      <code className="text-slate-300">{displayedDeploymentPort}</code>
                    </div>
                  )}
                  {displayedPersistedStatus && displayedPersistedStatus !== displayedDeploymentStatus && (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-slate-500">Last saved state</span>
                      <span className="text-slate-300">{displayedPersistedStatus}</span>
                    </div>
                  )}
                  {typeof ownedDeploymentProcess?.restartCount === 'number' && (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-slate-500">Restarts</span>
                      <span className="text-slate-300">{ownedDeploymentProcess.restartCount}</span>
                    </div>
                  )}
                </div>

                {displayedRuntimeManagement === 'external-loopback' && (
                  <div className="space-y-1 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-100">
                    <p className="font-medium">
                      {currentProject.deployment.bindingStatus === 'invalid'
                        ? 'Deployment configuration needs attention'
                        : 'Read-only external deployment'}
                    </p>
                    <p>
                      {ownedDeploymentProcess?.limitation
                        || currentProject.deployment.limitation
                        || 'Portal routes this deployment to an external service, but cannot start, stop, restart, or inspect that service. Manage it with the service controls on its host.'}
                    </p>
                  </div>
                )}
                {displayedRuntimeManagement !== 'external-loopback' && ownedDeploymentProcess?.limitation && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-100">
                    {ownedDeploymentProcess.limitation}
                  </div>
                )}
                {ownedDeploymentProcess?.recoveryRequired && (
                  <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-100">
                    Live status could not be verified. The saved deployment state is shown for context, not as proof that the app is stopped or running. The actions below are the server-approved recovery choices; Restart remains unavailable until the runtime is recovered.
                  </div>
                )}
                {ownedDeploymentProcess?.lastError && (
                  <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-[11px] text-red-200">
                    {ownedDeploymentProcess.lastError}
                  </div>
                )}

                {deploymentSupportedActions.some((action) => (
                  action === 'start' || action === 'stop' || action === 'restart'
                )) && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {deploymentSupportedActions.includes('start') && (
                      <button
                        onClick={() => { void controlDeploymentProcess('start'); }}
                        disabled={deploymentControlBusy !== null || displayedDeploymentStatus === 'running'}
                        aria-busy={deploymentControlBusy === 'start'}
                        className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {deploymentControlBusy === 'start' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Start
                      </button>
                    )}
                    {deploymentSupportedActions.includes('stop') && (
                      <button
                        onClick={() => { void controlDeploymentProcess('stop'); }}
                        disabled={deploymentControlBusy !== null || displayedDeploymentStatus === 'stopped'}
                        aria-busy={deploymentControlBusy === 'stop'}
                        className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-amber-500/10 text-xs text-amber-300 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {deploymentControlBusy === 'stop' ? <Loader2 size={12} className="animate-spin" /> : <Circle size={11} />} Stop
                      </button>
                    )}
                    {deploymentSupportedActions.includes('restart') && (
                      <button
                        onClick={() => { void controlDeploymentProcess('restart'); }}
                        disabled={deploymentControlBusy !== null || displayedDeploymentStatus === 'stopped'}
                        aria-busy={deploymentControlBusy === 'restart'}
                        className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-sky-500/10 text-xs text-sky-300 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {deploymentControlBusy === 'restart' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Restart
                      </button>
                    )}
                  </div>
                )}

                {deploymentSupportedActions.includes('logs') && ownedDeploymentProcess && (
                  <div className="rounded-lg border border-white/5 bg-black/20">
                    <div className="border-b border-white/5 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      Recent logs
                    </div>
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words p-3 text-[10px] leading-relaxed text-slate-300">
                      {ownedDeploymentProcess.logs.length > 0 ? ownedDeploymentProcess.logs.join('\n') : 'No runtime logs yet.'}
                    </pre>
                  </div>
                )}

                {currentProject.deployedUrl && (
                  <a
                    href={currentProject.deployedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-200 hover:bg-sky-500/20"
                  >
                    <ExternalLink size={13} /> Open App
                  </a>
                )}

                {!canUndeployCurrentProject ? (
                  <p className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-[10px] leading-relaxed text-slate-400">
                    Removal is unavailable because the server-managed deployment policy does not allow Portal to remove this deployment.
                    {displayedRuntimeManagement === 'external-loopback'
                      ? ' Manage or disconnect the external service with the controls on its host.'
                      : ''}
                  </p>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setDeploymentControlError(null);
                        setPendingUndeploy(selectedProject);
                      }}
                      disabled={deploymentControlBusy !== null}
                      aria-busy={deploymentControlBusy === 'undeploy'}
                      className="inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-40"
                    >
                      {deploymentControlBusy === 'undeploy' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      Remove deployment
                    </button>
                    <p className="text-[10px] leading-relaxed text-slate-600">
                      Project source, Git history, and Project Chat remain. Hosted files, runtime state, and deployment share links are removed.
                    </p>
                  </>
                )}
              </div>
            </ResponsiveProjectPanel>
          )}

          {/* Activity Panel */}
          {activePanel === 'activity' && selectedProject && (
            <ResponsiveProjectPanel
              isMobile={isMobile}
              mobileLabel="Project activity panel"
              onDismiss={() => setActivePanel(null)}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Activity size={13} className="text-cyan-400" /> Activity</span>
                <div className="flex items-center gap-1">
                  <button aria-label="Refresh project activity" onClick={loadActivity} className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white"><RefreshCw size={12} /></button>
                  <button aria-label="Close activity panel" onClick={() => setActivePanel(null)} className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white"><X size={14} /></button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {activityLogs.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-xs">
                    <Activity size={24} className="mx-auto mb-2 opacity-30" />
                    <p>No activity yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/5">
                    {activityLogs.map(log => (
                      <div key={log.id} className="px-3 py-2.5 flex items-start gap-2.5">
                        <div className="mt-0.5">{activityIcon(log.action)}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-slate-300">{activityLabel(log.action)}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5">{timeAgo(log.createdAt)}</p>
                        </div>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                          log.severity === 'ERROR' ? 'bg-red-500/10 text-red-400' :
                          log.severity === 'WARN' ? 'bg-amber-500/10 text-amber-400' :
                          'bg-emerald-500/10 text-emerald-400'
                        }`}>{log.severity}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </ResponsiveProjectPanel>
          )}

          {/* Share Panel */}
          {activePanel === 'share' && selectedProject && (
            <ResponsiveProjectPanel
              isMobile={isMobile}
              mobileLabel="Project sharing panel"
              onDismiss={() => {
                if (!isShareActionInFlight()) setActivePanel(null);
              }}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs font-medium flex items-center gap-1.5"><Share2 size={13} className="text-violet-400" /> Share & Hosting</span>
                <button aria-label="Close sharing panel" onClick={() => { if (!isShareActionInFlight()) setActivePanel(null); }} disabled={shareActionActive} className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-auto p-3 space-y-4">
                {isLocalPortalOrigin && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-[11px] text-amber-100">
                    <div className="text-[10px] text-amber-300 uppercase font-medium mb-2 flex items-center gap-1"><AlertCircle size={10} /> Local beta disclaimer</div>
                    <p>This Windows / WSL path is currently <strong className="text-amber-50">experimental, untested in the field, and still under development</strong>. URLs and <code className="rounded bg-black/20 px-1 py-0.5 text-[10px]">/share/...</code> links created here point back to this machine, not a public VPS.</p>
                    <p className="mt-2 text-amber-200/90">Public hosting, stable external share links, and custom-domain HTTPS are VPS features for now.</p>
                  </div>
                )}
                {currentProject?.deployedUrl && (
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3">
                    <div className="text-[10px] text-emerald-400 uppercase font-medium mb-2 flex items-center gap-1"><Globe size={10} /> {isLocalPortalOrigin ? 'Local URL' : 'Live URL'}</div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-[11px] text-emerald-300 bg-black/30 px-2 py-1.5 rounded truncate">
                        {window.location.origin}{currentProject.deployedUrl}
                      </code>
                      <button aria-label="Copy hosted project URL" onClick={() => copyToClipboard(window.location.origin + currentProject.deployedUrl, 'hosted')}
                        className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                        {copiedId === 'hosted' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                      <a aria-label="Open hosted project" href={currentProject.deployedUrl} target="_blank" rel="noopener noreferrer"
                        className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                )}
                {shareRefreshError && (
                  <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[11px] text-amber-100">
                    <p>{shareRefreshError}</p>
                    <button
                      type="button"
                      onClick={() => { void retryLoadShares(); }}
                      disabled={shareActionActive}
                      aria-busy={shareRefreshing}
                      className="mt-2 inline-flex min-w-24 items-center justify-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {shareRefreshing && <Loader2 size={11} className="animate-spin" />}
                      {shareRefreshing ? 'Refreshing…' : 'Retry refresh'}
                    </button>
                  </div>
                )}
                {!currentProject?.deployedUrl && (
                  <div className="text-center py-4 text-slate-500 text-xs">
                    <Upload size={24} className="mx-auto mb-2 opacity-50" />
                    <p>Deploy your project first to get a hosted URL and create share links</p>
                  </div>
                )}
                {currentProject?.deployedUrl && (
                  <>
                    {/* Create new share link */}
                    <fieldset disabled={shareActionActive || Boolean(shareRefreshError)} className="min-w-0 bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-3 disabled:opacity-70">
                      <div className="text-[10px] text-slate-500 uppercase font-medium tracking-wider">New Share Link</div>
                      <div className="flex gap-2">
                        <button type="button" aria-pressed={shareIsPublic} onClick={() => { setShareIsPublic(true); setShareCreateError(null); }}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-medium transition-all ${
                            shareIsPublic ? 'bg-green-500/10 text-green-400 border border-green-500/30' : 'bg-white/5 text-slate-500 border border-white/10'
                          }`}>
                          <Globe size={12} /> Public
                        </button>
                        <button type="button" aria-pressed={!shareIsPublic} onClick={() => { setShareIsPublic(false); setShareCreateError(null); }}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-medium transition-all ${
                            !shareIsPublic ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-white/5 text-slate-500 border border-white/10'
                          }`}>
                          <Lock size={12} /> Password
                        </button>
                      </div>
                      {!shareIsPublic && (
                        <div className="space-y-2">
                          <input aria-label="Share link password" aria-describedby={`share-password-requirements${sharePasswordByteLength > 72 ? ' share-password-byte-error' : ''}`} aria-invalid={sharePassword.length > 0 && (sharePassword.length < 8 || sharePasswordByteLength > 72)} type="password" maxLength={72} value={sharePassword} onChange={e => { setSharePassword(e.target.value); setShareCreateError(null); }}
                            placeholder="Password (min 8 chars)"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-amber-500/30 focus:outline-none" />
                          <input aria-label="Confirm share link password" aria-describedby={sharePasswordConfirm.length > 0 && sharePassword !== sharePasswordConfirm ? 'share-password-mismatch-error' : undefined} aria-invalid={sharePasswordConfirm.length > 0 && sharePassword !== sharePasswordConfirm} type="password" maxLength={72} value={sharePasswordConfirm} onChange={e => { setSharePasswordConfirm(e.target.value); setShareCreateError(null); }}
                            placeholder="Confirm password"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-slate-600 focus:border-amber-500/30 focus:outline-none" />
                          <p id="share-password-requirements" className="text-[9px] text-slate-500">8 characters minimum · 72 UTF-8 bytes maximum</p>
                          {sharePasswordByteLength > 72 ? (
                            <p id="share-password-byte-error" role="alert" className="text-[10px] text-red-400">
                              Password is {sharePasswordByteLength} UTF-8 bytes; maximum 72. Shorten it by {sharePasswordByteLength - 72} byte{sharePasswordByteLength - 72 === 1 ? '' : 's'}.
                            </p>
                          ) : sharePassword.length > 0 && sharePassword.length < 8 ? (
                            <p className="text-[10px] text-red-400">Min 8 characters ({8 - sharePassword.length} more needed)</p>
                          ) : sharePassword.length >= 8 && sharePassword.length < 12 ? (
                            <p className="text-[10px] text-amber-400">Good — 12+ characters recommended</p>
                          ) : sharePassword.length >= 12 ? (
                            <p className="text-[10px] text-green-400">Strong password ✓</p>
                          ) : null}
                          {sharePasswordConfirm.length > 0 && sharePassword !== sharePasswordConfirm && (
                            <p id="share-password-mismatch-error" role="alert" className="text-[10px] text-red-400">Passwords do not match.</p>
                          )}
                        </div>
                      )}
                      <label className="space-y-1 text-[10px] text-slate-500">
                        <span>Expires (optional)</span>
                        <input
                          aria-label="Share link expiration"
                          type="datetime-local"
                          value={shareExpiresAt}
                          onChange={event => { setShareExpiresAt(event.target.value); setShareCreateError(null); }}
                          className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[11px] text-white focus:border-violet-500/30 focus:outline-none"
                        />
                      </label>

                      <div className="space-y-2 rounded-lg border border-white/[0.07] bg-black/10 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1 text-[10px] font-medium text-slate-300"><Users size={10} /> Visitor slots</span>
                          <span className="text-[9px] text-slate-600">Default: unlimited</span>
                        </div>
                        <div role="group" aria-label="Visitor slot presets" className="grid grid-cols-4 gap-1">
                          {SHARE_VISITOR_PRESETS.map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              aria-label={preset.value
                                ? `${preset.label} audience: ${preset.value} visitor slot${preset.value === '1' ? '' : 's'}`
                                : 'Unlimited visitor slots'}
                              aria-pressed={shareMaxUses === preset.value}
                              onClick={() => { setShareMaxUses(preset.value); setShareCreateError(null); }}
                              className={`min-w-0 rounded-md border px-1 py-1.5 text-center transition ${
                                shareMaxUses === preset.value
                                  ? 'border-violet-400/40 bg-violet-500/15 text-violet-200'
                                  : 'border-white/[0.08] bg-white/[0.03] text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              <span className="block truncate text-[9px] font-medium">{preset.label}</span>
                              <span className="block text-[10px]">{preset.detail}</span>
                            </button>
                          ))}
                        </div>
                        <label className="space-y-1 text-[10px] text-slate-500">
                          <span>Custom visitor slots</span>
                          <input
                            aria-label="Share link visitor slots"
                            aria-describedby={`share-visitor-slots-hint${shareCreateError ? ' share-create-error' : ''}`}
                            aria-invalid={shareMaxUsesInvalid}
                            type="number"
                            min={1}
                            max={1_000_000}
                            step={1}
                            value={shareMaxUses}
                            onChange={event => { setShareMaxUses(event.target.value); setShareCreateError(null); }}
                            placeholder="Unlimited"
                            className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-white placeholder-slate-600 focus:border-violet-500/30 focus:outline-none"
                          />
                        </label>
                        <p id="share-visitor-slots-hint" className="text-[9px] leading-relaxed text-slate-500">
                          Each slot grants one browser up to 30 days of access while the link remains active. Clearing cookies or switching browsers can use another slot.
                        </p>
                      </div>

                      <div className="space-y-2 rounded-lg border border-white/[0.07] bg-black/10 p-2.5">
                        <label className="flex min-h-8 cursor-pointer items-center justify-between gap-3 text-[10px] text-slate-300">
                          <span className="flex items-center gap-1 font-medium"><Gauge size={10} /> Limit API requests</span>
                          <span className="flex items-center gap-2 text-[9px] text-slate-500">
                            {shareRateLimitEnabled ? 'Enabled' : 'Unlimited'}
                            <input
                              aria-label="Limit share link API requests"
                              type="checkbox"
                              checked={shareRateLimitEnabled}
                              onChange={event => {
                                setShareRateLimitEnabled(event.target.checked);
                                if (!event.target.checked) setShareRateLimitMaxRequests('');
                                setShareCreateError(null);
                              }}
                              className="size-4 accent-violet-500"
                            />
                          </span>
                        </label>
                        {shareRateLimitEnabled && (
                          <div className="grid grid-cols-[minmax(0,1fr)_minmax(110px,0.9fr)] gap-2">
                            <label className="space-y-1 text-[10px] text-slate-500">
                              <span>API requests</span>
                              <input
                                aria-label="Share link API request limit"
                                aria-describedby={`share-api-rate-hint${shareCreateError ? ' share-create-error' : ''}`}
                                aria-invalid={shareRateLimitMaxRequestsInvalid}
                                type="number"
                                min={1}
                                max={1_000_000}
                                step={1}
                                value={shareRateLimitMaxRequests}
                                onChange={event => { setShareRateLimitMaxRequests(event.target.value); setShareCreateError(null); }}
                                placeholder="Requests"
                                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-white placeholder-slate-600 focus:border-violet-500/30 focus:outline-none"
                              />
                            </label>
                            <label className="space-y-1 text-[10px] text-slate-500">
                              <span>Window</span>
                              <select
                                aria-label="Share link API request window"
                                value={shareRateLimitWindowSeconds}
                                onChange={event => {
                                  setShareRateLimitWindowSeconds(Number(event.target.value) as ShareRateLimitWindowSeconds);
                                  setShareCreateError(null);
                                }}
                                className="w-full rounded-lg border border-white/10 bg-[#10142d] px-2 py-1.5 text-[11px] text-white focus:border-violet-500/30 focus:outline-none"
                              >
                                {SHARE_RATE_LIMIT_WINDOWS.map((window) => (
                                  <option key={window.value} value={window.value}>{window.label}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                        )}
                        <p id="share-api-rate-hint" className="text-[9px] leading-relaxed text-slate-500">
                          Shared by everyone using this link. Counts dynamic API requests only; static files are excluded.
                        </p>
                      </div>

                      {shareCreateError && (
                        <p id="share-create-error" role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-2 text-[10px] text-red-200">
                          {shareCreateError}
                        </p>
                      )}
                      <button type="button" onClick={createShareLink}
                        disabled={shareActionActive || (!shareIsPublic && (sharePassword.length < 8 || sharePasswordByteLength > 72 || sharePassword !== sharePasswordConfirm))}
                        aria-busy={shareCreating}
                        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-violet-500/10 text-violet-400 text-[11px] hover:bg-violet-500/20 transition-colors disabled:opacity-30 font-medium">
                        {shareCreating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                        {shareCreating ? 'Creating…' : `Create ${shareIsPublic ? 'Public' : 'Password-Protected'} Link`}
                      </button>
                    </fieldset>

                    {/* Existing share links */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-500 uppercase font-medium tracking-wider">Share Links</span>
                    </div>
                    {shares.length === 0 ? (
                      <p className="text-xs text-slate-600 text-center py-2">No share links yet</p>
                    ) : (
                      <div className="space-y-2">
                        {shares.map(link => (
                          <div key={link.id} className={`rounded-lg border ${getShareLinkAvailability(link) === 'active' ? 'bg-white/[0.02] border-white/5' : 'bg-white/[0.01] border-white/[0.03] opacity-60'}`}>
                            <div className="p-2.5">
                              <div className="flex items-center gap-2 mb-1.5">
                                {link.isPublic ? (
                                  <Globe size={11} className="text-green-400 flex-shrink-0" />
                                ) : (
                                  <Lock size={11} className="text-amber-400 flex-shrink-0" />
                                )}
                                <code className="text-[10px] text-slate-400 truncate flex-1">/share/{link.token}</code>
                                {/* Email button */}
                                {getShareLinkAvailability(link) === 'active' && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (isShareActionInFlight()) return;
                                      setShareEmailError(null);
                                      setShareEmailSuccess(null);
                                      if (emailingLinkId === link.id) {
                                        setEmailingLinkId(null);
                                        setShareEmailInput('');
                                      } else {
                                        setEmailingLinkId(link.id);
                                        setShareEmailInput('');
                                      }
                                    }}
                                    disabled={shareActionActive}
                                    aria-label={emailingLinkId === link.id ? 'Close share email form' : 'Send share link via email'}
                                    className={`p-1 rounded hover:bg-white/5 transition disabled:cursor-not-allowed disabled:opacity-40 ${emailingLinkId === link.id ? 'text-violet-400' : 'text-slate-500 hover:text-violet-400'}`}
                                    title="Send via email"
                                  >
                                    <Mail size={10} />
                                  </button>
                                )}
                                <button onClick={() => copyToClipboard(`${window.location.origin}/share/${link.token}`, link.id)}
                                  disabled={getShareLinkAvailability(link) !== 'active'}
                                  aria-label="Copy share link"
                                  className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
                                  {copiedId === link.id ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                                </button>
                              </div>
                              <div className="mb-1.5 space-y-1 text-[10px] text-slate-600">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span className={link.isPublic ? 'text-green-400/70' : 'text-amber-400/70'}>
                                    {link.isPublic ? 'Public' : 'Password-Protected'}
                                  </span>
                                  {link.expiresAt && (
                                    <><span className="text-slate-700">•</span><span>expires {new Date(link.expiresAt).toLocaleString()}</span></>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Users size={9} className="flex-shrink-0 text-violet-400/70" />
                                  <span>{link.maxUses !== null && link.maxUses !== undefined
                                    ? `${link.currentUses} / ${link.maxUses} visitor slots used`
                                    : `${link.currentUses} visitor slot${link.currentUses === 1 ? '' : 's'} used · unlimited`}</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Gauge size={9} className="flex-shrink-0 text-sky-400/70" />
                                  <span>{link.rateLimitMaxRequests && link.rateLimitWindowSeconds
                                    ? `${link.rateLimitMaxRequests} API requests / ${shareRateLimitWindowLabel(link.rateLimitWindowSeconds)} · shared`
                                    : 'Unlimited API requests'}</span>
                                </div>
                              </div>
                              <div className="flex items-center justify-between text-[10px] text-slate-600">
                                <span>{timeAgo(link.createdAt)}</span>
                                <div className="flex items-center gap-3">
                                  {getShareLinkAvailability(link) === 'active' && !link.isPublic && (
                                    <button
                                      onClick={() => {
                                        setShareMakePublicError(null);
                                        setConfirmPublicId(link.id);
                                      }}
                                      disabled={shareActionActive}
                                      className="text-green-400/60 hover:text-green-400 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      Make Public
                                    </button>
                                  )}
                                  <button onClick={() => toggleShareActive(link.id)}
                                    disabled={shareActionActive || getShareLinkAvailability(link) === 'expired' || getShareLinkAvailability(link) === 'exhausted'}
                                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition disabled:cursor-wait disabled:opacity-50 ${
                                      getShareLinkAvailability(link) === 'active'
                                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                                        : 'bg-slate-500/20 text-slate-400 hover:bg-slate-500/30'
                                    }`}>
                                    {shareMutationIds.has(link.id)
                                      ? 'Updating…'
                                      : getShareLinkAvailability(link) === 'expired'
                                        ? 'Expired'
                                        : getShareLinkAvailability(link) === 'exhausted'
                                          ? 'Limit reached'
                                          : getShareLinkAvailability(link) === 'active' ? 'Active' : 'Disabled'}
                                  </button>
                                  <button onClick={() => { setShareDeleteError(null); setPendingDeleteShare(link.id); }}
                                    disabled={shareActionActive}
                                    aria-label="Delete share link permanently"
                                    className="text-red-400/40 hover:text-red-400 transition disabled:cursor-not-allowed disabled:opacity-40" title="Delete permanently">
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* Email form — inline accordion */}
                            {emailingLinkId === link.id && (
                              <div className="border-t border-white/5 px-2.5 pb-2.5 pt-2">
                                <p className="text-[10px] text-violet-400/80 font-medium mb-2 flex items-center gap-1">
                                  <Mail size={9} /> Send this link via email
                                </p>
                                <div className="space-y-1.5">
                                  <input
                                    aria-label="Recipient email address"
                                    type="email"
                                    maxLength={320}
                                    placeholder="Recipient email address"
                                    value={shareEmailInput}
                                    disabled={shareActionActive || shareEmailSuccess === link.id}
                                    onChange={e => { setShareEmailInput(e.target.value); setShareEmailError(null); setShareEmailSuccess(null); }}
                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void sendShareEmail(link.id); } }}
                                    className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/50"
                                  />
                                  {!link.isPublic && (
                                    <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[10px] text-amber-200">
                                      For security, the password is never included with the link. Send it separately.
                                    </p>
                                  )}
                                  {shareEmailError && (
                                    <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-2 text-[10px] text-red-200">{shareEmailError}</p>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => sendShareEmail(link.id)}
                                    disabled={!shareEmailInput.trim() || shareActionActive || shareEmailSuccess === link.id || getShareLinkAvailability(link) !== 'active'}
                                    aria-busy={shareEmailSending}
                                    className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition ${
                                      shareEmailSuccess === link.id
                                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                        : 'bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed'
                                    }`}
                                  >
                                    {shareEmailSuccess === link.id ? (
                                      <><Check size={10} /> Sent!</>
                                    ) : shareEmailSending ? (
                                      <><Loader2 size={10} className="animate-spin" /> Sending…</>
                                    ) : (
                                      <><SendHorizonal size={10} /> Send Email</>
                                    )}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </ResponsiveProjectPanel>
          )}

          {/* Confirm Delete Share Link */}
          <ConfirmDialog
            open={!!pendingDeleteShare}
            title="Delete Share Link"
            message="This will permanently delete the share link. Anyone with this link will no longer be able to access the project."
            confirmLabel="Delete"
            variant="danger"
            icon="trash"
            busy={shareDeleteBusy}
            busyLabel="Deleting…"
            error={shareDeleteError}
            onConfirm={deleteSharePermanently}
            onCancel={() => {
              if (shareDeleteInFlightRef.current) return;
              setShareDeleteError(null);
              setPendingDeleteShare(null);
            }}
          />

          {/* Confirm Make Public Dialog */}
          <ConfirmDialog
            open={!!confirmPublicId}
            title="⚠️ Security Warning"
            message="You are about to make this link PUBLIC. Anyone with the link will be able to access the project WITHOUT a password."
            confirmLabel="Yes, Make Public"
            variant="danger"
            icon="shield"
            busy={shareMakePublicBusy}
            busyLabel="Making public…"
            error={shareMakePublicError}
            onConfirm={makeSharePublic}
            onCancel={() => {
              if (shareMakePublicInFlightRef.current) return;
              setShareMakePublicError(null);
              setConfirmPublicId(null);
            }}
          />
        </AnimatePresence>

        {/* Project Chat Panel */}
        <AnimatePresence>
          {agentChatOpen && selectedProject && (
            <ProjectChatChunkBoundary resetKey={selectedProject} onClose={closeAgentChat}>
              <Suspense fallback={(
                <div role="status" className="flex w-[340px] max-w-full items-center justify-center gap-2 border-l border-white/5 bg-[#080B20]/95 p-5 text-xs text-slate-400">
                  <Loader2 size={14} className="animate-spin text-purple-300" /> Loading Project Chat…
                </div>
              )}>
                <LazyProjectChatPanel
                  key={`project-agent-chat:${selectedProject}`}
                  projectName={selectedProject}
                  onClose={closeAgentChat}
                  onProjectPrepared={async (preparedProjectName) => {
                    await loadProjects();
                    await selectProject(preparedProjectName);
                  }}
                  onActivityChange={handleProjectChatActivity}
                />
              </Suspense>
            </ProjectChatChunkBoundary>
          )}
        </AnimatePresence>
      </div>

      {/* Create Project Dialog */}
      <ViewportModal
        open={showCreate}
        onDismiss={() => setShowCreate(false)}
        dismissible={!(creating || zipUploading)}
        initialFocusRef={createProjectNameInputRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          className="glass max-h-[calc(100dvh-2rem)] w-full max-w-md space-y-4 overflow-y-auto p-6"
        >
              <div className="flex justify-between items-center">
                <h3 id="create-project-title" className="text-lg font-semibold">New Project</h3>
                <button
                  aria-label={zipUploading ? 'Cancel project ZIP upload' : 'Close new project dialog'}
                  disabled={creating}
                  onClick={() => {
                    if (zipUploading) zipUploadXhrRef.current?.abort();
                    else setShowCreate(false);
                  }}
                  className="inline-flex size-8 items-center justify-center text-slate-400 hover:text-white disabled:opacity-30"
                ><X size={20} /></button>
              </div>

              <div className="flex gap-2">
                {(['template', 'clone', 'zip'] as const).map(mode => (
                  <button key={mode} aria-pressed={createMode === mode} disabled={creating || zipUploading} onClick={() => setCreateMode(mode)}
                    className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all border ${createMode === mode ? 'accent-active' : 'bg-white/5 text-slate-400 border-white/10'}`}>
                    {mode === 'template' ? 'Template' : mode === 'clone' ? 'Clone Repo' : 'Upload ZIP'}
                  </button>
                ))}
              </div>

              <div>
                <label htmlFor="new-project-name" className="text-xs text-slate-400 block mb-1">Project Name</label>
                <input ref={createProjectNameInputRef} id="new-project-name" aria-label="Project name" value={newName} maxLength={120} disabled={creating || zipUploading} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createProject()}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:border-emerald-500/30 focus:outline-none"
                  placeholder="my-project" />
              </div>

              {createMode === 'template' ? (
                <fieldset>
                  <legend className="text-xs text-slate-400 block mb-1">Template</legend>
                  <div className="grid grid-cols-5 gap-2">
                    {[
                      { id: 'static-html', label: 'HTML', icon: '🌐', desc: 'Static site' },
                      { id: 'react', label: 'React', icon: '⚛️', desc: 'React SPA' },
                      { id: 'node-api', label: 'Node.js', icon: '🟢', desc: 'API server' },
                      { id: 'python', label: 'Python', icon: '🐍', desc: 'Script/app' },
                      { id: 'cpp', label: 'C++', icon: '⚙️', desc: 'Compiled' },
                    ].map(t => (
                      <button key={t.id} aria-pressed={template === t.id} onClick={() => setTemplate(t.id)}
                        className={`p-3 rounded-xl text-center text-xs transition-all border ${template === t.id ? 'accent-active' : 'bg-white/5 border-white/10 text-slate-400 hover:border-white/20'}`}>
                        <span className="text-lg block mb-1">{t.icon}</span>
                        {t.label}
                        <span className="block text-[9px] text-slate-600 mt-0.5">{t.desc}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : createMode === 'clone' ? (
                <div>
                  <label htmlFor="new-project-repository" className="text-xs text-slate-400 block mb-1">Repository URL</label>
                  <input id="new-project-repository" aria-label="Repository URL" value={cloneUrl} disabled={creating || zipUploading} onChange={e => setCloneUrl(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:border-emerald-500/30 focus:outline-none"
                    placeholder="https://git.example.com/user/repo.git" />
                  {cloneUrl && newName && (
                    <p className="text-[10px] text-emerald-400/60 mt-1.5 flex items-center gap-1">
                      <Zap size={10} /> Auto-detected name: <strong>{newName}</strong>
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="text-xs text-slate-400 block mb-1">ZIP File</p>
                    <label className={`flex items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed cursor-pointer transition-all ${
                      zipFile ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/10 hover:border-emerald-500/20 bg-white/[0.02]'
                    }`}>
                      <input aria-label="Choose project ZIP file" type="file" accept=".zip,application/zip" disabled={zipUploading} className="hidden"
                        onChange={e => { const file = e.target.files?.[0]; if (file) handleZipSelect(file); }} />
                      {zipFile ? (
                        <div className="text-center">
                          <Upload size={20} className="mx-auto mb-1 text-emerald-400" />
                          <span className="text-sm text-emerald-400 font-medium">{zipFile.name}</span>
                          <span className="text-xs text-slate-500 block">{(zipFile.size / 1024 / 1024).toFixed(1)} MB</span>
                        </div>
                      ) : (
                        <div className="text-center">
                          <Upload size={20} className="mx-auto mb-1 text-slate-500" />
                          <span className="text-sm text-slate-400">Click to select ZIP file</span>
                          <span className="text-xs text-slate-600 block">Max 200MB</span>
                        </div>
                      )}
                    </label>
                  </div>
                  {uploadProgress && (
                    <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-3 text-center">
                      <Loader2 size={16} className="animate-spin text-blue-400 mx-auto mb-1" />
                      <p className="text-xs text-blue-400 font-medium">{uploadProgress}</p>
                    </div>
                  )}
                  <div className="bg-white/[0.02] rounded-xl p-3 border border-white/5">
                    <p className="text-[11px] text-slate-500 mb-1.5 font-medium">Auto-detection after upload:</p>
                    <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-600">
                      <span>📦 package.json → Node.js</span>
                      <span>🐍 requirements.txt → Python</span>
                      <span>🦀 Cargo.toml → Rust</span>
                      <span>🐳 Dockerfile → Docker</span>
                      <span>🌐 index.html → Static</span>
                      <span>🔵 go.mod → Go</span>
                    </div>
                  </div>
                </div>
              )}

              <button onClick={createProject}
                disabled={(creating || zipUploading) || !newName.trim() || (createMode === 'zip' && !zipFile) || (createMode === 'clone' && !cloneUrl.trim())}
                aria-busy={creating || zipUploading}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-50">
                {(creating || zipUploading) && <Loader2 size={16} className="animate-spin" />}
                {zipUploading
                  ? 'Uploading project…'
                  : creating
                    ? createMode === 'clone' ? 'Cloning project…' : 'Creating project…'
                    : createMode === 'clone' ? 'Clone Project' : createMode === 'zip' ? 'Upload & Create Project' : 'Create Project'}
              </button>
        </motion.div>
      </ViewportModal>

      {/* New File Dialog */}
      <ViewportModal
        open={showNewFile}
        onDismiss={() => setShowNewFile(false)}
        dismissible={!creatingEntry}
        initialFocusRef={newProjectEntryInputRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-project-entry-title"
          className="glass max-h-[calc(100dvh-2rem)] w-full max-w-sm space-y-4 overflow-y-auto p-6"
        >
              <h3 id="new-project-entry-title" className="font-semibold">New {newFileIsDir ? 'Folder' : 'File'}</h3>
              <input ref={newProjectEntryInputRef} aria-label={newFileIsDir ? 'New folder name' : 'New file name'} value={newFilePath} disabled={creatingEntry} onChange={e => setNewFilePath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createNewFile()}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:border-emerald-500/30 focus:outline-none"
                placeholder={newFileIsDir ? 'folder-name' : 'filename.ext'} />
              <button onClick={createNewFile} disabled={!newFilePath.trim() || creatingEntry}
                aria-busy={creatingEntry}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-50">
                {creatingEntry && <Loader2 size={14} className="animate-spin" />}
                {creatingEntry ? `Creating ${newFileIsDir ? 'folder' : 'file'}…` : `Create ${newFileIsDir ? 'Folder' : 'File'}`}
              </button>
        </motion.div>
      </ViewportModal>

      {/* Upload Files Dialog */}
      <ViewportModal
        open={showUploadDialog && !!selectedProject}
        onDismiss={() => setShowUploadDialog(false)}
        dismissible={!uploadingFiles}
        initialFocusRef={uploadDestinationSelectRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="upload-project-files-title"
          className="glass max-h-[calc(100dvh-2rem)] w-full max-w-md space-y-4 overflow-y-auto p-6"
        >
              <div className="flex items-center justify-between">
                <h3 id="upload-project-files-title" className="font-semibold flex items-center gap-2"><Upload size={16} className="text-emerald-400" /> Upload Files</h3>
                <button
                  aria-label="Close upload files dialog"
                  disabled={uploadingFiles}
                  onClick={() => setShowUploadDialog(false)}
                  className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-40"
                ><X size={16} /></button>
              </div>

              {/* Target directory selector */}
              <div>
                <label htmlFor="project-upload-directory" className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">Upload to directory</label>
                <select
                  ref={uploadDestinationSelectRef}
                  id="project-upload-directory"
                  aria-label="Upload destination directory"
                  value={uploadTargetPath}
                  disabled={uploadingFiles}
                  onChange={e => setUploadTargetPath(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm focus:border-emerald-500/30 focus:outline-none"
                >
                  <option value="">/ (project root)</option>
                  {collectDirPaths(tree, expandedDirs).filter(d => d).map(d => (
                    <option key={d} value={d}>/{d}</option>
                  ))}
                </select>
              </div>

              {/* Drag and drop zone (react-dropzone for iPad compatibility) */}
              <div
                {...getUploadRootProps()}
                className={`border-2 border-dashed rounded-xl p-6 text-center transition-all ${
                  uploadingFiles
                    ? 'cursor-wait border-white/10 bg-white/[0.02] opacity-55'
                    : uploadIsDragActive
                    ? 'border-emerald-400 bg-emerald-500/10'
                    : 'cursor-pointer border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
                }`}
              >
                <input {...getUploadInputProps({ 'aria-label': 'Choose files to upload' })} aria-label="Choose files to upload" />
                <Upload size={28} className={`mx-auto mb-2 ${uploadIsDragActive ? 'text-emerald-400' : 'text-slate-600'}`} />
                <p className="text-sm text-slate-400">
                  {uploadIsDragActive ? 'Drop files here' : 'Drag & drop files or click to browse'}
                </p>
                <p className="text-[10px] text-slate-600 mt-1">Any file type • 100MB per file • 500MB total</p>
              </div>

              {/* File list */}
              {uploadFiles.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  <div className="text-[10px] text-slate-500 mb-1">{uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''} selected ({(uploadFiles.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB)</div>
                  {uploadFiles.map((file, i) => (
                    <div key={`${file.name}-${i}`} className="flex items-center gap-2 px-2 py-1 rounded bg-white/5 text-xs">
                      <FileText size={12} className="text-slate-500 flex-shrink-0" />
                      <span className="text-slate-300 truncate flex-1">{file.name}</span>
                      <span className="text-[10px] text-slate-600 flex-shrink-0">{(file.size / 1024).toFixed(1)}KB</span>
                      <button
                        aria-label={`Remove ${file.name} from upload`}
                        disabled={uploadingFiles}
                        onClick={() => setUploadFiles(prev => prev.filter((_, idx) => idx !== i))}
                        className="inline-flex size-7 flex-shrink-0 items-center justify-center text-slate-600 hover:text-red-400 disabled:cursor-wait disabled:opacity-40"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Upload button */}
              <button
                onClick={handleUploadFiles}
                disabled={uploadingFiles || uploadFiles.length === 0}
                aria-busy={uploadingFiles}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-50"
              >
                {uploadingFiles ? <><Loader2 size={16} className="animate-spin" /> Uploading files…</> : <><Upload size={16} /> Upload {uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''}</>}
              </button>
        </motion.div>
      </ViewportModal>

      <ViewportModal
        open={!!renamingProject}
        onDismiss={dismissRenameProject}
        dismissible={renameProjectPhase !== 'submitting' && renameProjectPhase !== 'reconciling'}
        initialFocusRef={projectRenameInputRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        {renamingProject && (
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-project-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRenameProject();
            }}
            className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl"
          >
            <h3 id="rename-project-title" className="text-base font-semibold text-theme-text">
              Rename project “{renamingProject}”
            </h3>
            <p className="mt-2 text-sm text-slate-400">
              Project files, deployment state, and Project Chat identity will remain attached to this project.
            </p>
            <label htmlFor="rename-project-name" className="mt-4 block text-xs font-medium text-slate-300">
              New project name
            </label>
            <input
              ref={projectRenameInputRef}
              id="rename-project-name"
              value={renameProjectValue}
              disabled={!!projectRenameInFlightRef.current || renameProjectPhase === 'recovery-blocked'}
              onChange={(event) => {
                setRenameProjectValue(event.target.value);
                setRenameProjectError(null);
              }}
              className="mt-1 min-h-[44px] w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50 disabled:cursor-wait disabled:opacity-60"
            />
            {renameProjectError && (
              <div role="alert" className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {renameProjectError}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={renameProjectPhase === 'submitting' || renameProjectPhase === 'reconciling'}
                onClick={dismissRenameProject}
                className="min-h-[44px] rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:cursor-wait disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  renameProjectPhase === 'submitting'
                  || renameProjectPhase === 'reconciling'
                  || renameProjectPhase === 'recovery-blocked'
                  || !renameProjectValue.trim()
                }
                aria-busy={renameProjectPhase === 'submitting' || renameProjectPhase === 'reconciling'}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-50"
              >
                {renameProjectPhase === 'submitting'
                  ? <><Loader2 size={15} className="animate-spin" /> Renaming project…</>
                  : renameProjectPhase === 'reconciling'
                    ? <><Loader2 size={15} className="animate-spin" /> Checking rename status…</>
                    : renameProjectPhase === 'indeterminate'
                      ? 'Check rename status'
                    : renameProjectPhase === 'storage-blocked'
                      ? 'Retry rename recovery'
                      : renameProjectPhase === 'recovery-retired'
                        ? 'Arm new rename attempt'
                      : renameProjectPhase === 'not-admitted'
                        ? 'Try rename again'
                        : renameProjectPhase === 'recovery-blocked'
                          ? 'Rename blocked'
                        : 'Rename project'}
              </button>
            </div>
          </form>
        )}
      </ViewportModal>

      <TypedConfirmationDialog
        open={!!runtimeImageRepairDialog}
        title="Repair runtime image and retry?"
        description="Portal will rebuild and attest the isolated Project runtime image, update only its immutable image pin, restart the Portal service once, then retry the exact failed Project action only if its server-verified Project, App, and source identity are unchanged."
        confirmationPhrase={runtimeImageRepairDialog?.confirmationPhrase || null}
        confirmLabel="Repair runtime image"
        busy={runtimeImageRepairPhase === 'running'}
        busyLabel="Repairing image and waiting for Portal…"
        tone="warning"
        details={runtimeImageRepairError ? (
          <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {runtimeImageRepairError}
          </div>
        ) : (
          <p className="text-sm leading-6 text-theme-text-muted">
            When the repair finishes, Portal will safely retry the original {runtimeImageRepairDialog?.retryAction || 'Project'} action. If anything changed while the repair ran, the retry is rejected and you will refresh before acting again.
          </p>
        )}
        onConfirm={(confirmation) => { void runRuntimeImageRepair(confirmation); }}
        onCancel={() => {
          if (runtimeImageRepairInFlightRef.current) return;
          setRuntimeImageRepairError(null);
          setRuntimeImageRepairDialog(null);
        }}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.kind === 'project' ? `⚠️ Delete project "${pendingDelete.name}"?` : `⚠️ Delete ${pendingDelete?.name || 'file'}?`}
        message={pendingDelete?.kind === 'project' ? 'All files, commit history, and deployments will be permanently lost.' : 'This file will be permanently deleted.'}
        detail={pendingDelete?.kind === 'file' ? pendingDelete.path : undefined}
        confirmLabel="Delete"
        variant="danger"
        icon={pendingDelete?.kind === 'project' ? 'shield' : 'trash'}
        error={deleteError}
        busy={deleteBusy}
        busyLabel={deleteSettleNotice
          || (pendingDelete?.kind === 'project' ? 'Deleting project…' : 'Deleting…')}
        onConfirm={doDelete}
        onCancel={() => {
          if (deleteInFlightRef.current) return;
          setDeleteError(null);
          setDeleteSettleNotice(null);
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={!!pendingUndeploy}
        title={`Remove deployment for "${pendingUndeploy || ''}"?`}
        message="The Project source, Git history, and Project Chat will be preserved."
        detail="Hosted files, runtime state, and deployment share links will be permanently removed."
        confirmLabel="Remove deployment"
        variant="danger"
        icon="trash"
        error={deploymentFailureText(deploymentControlError)}
        busy={deploymentControlBusy === 'undeploy'}
        busyLabel="Removing deployment…"
        onConfirm={() => { void undeployProject(); }}
        onCancel={() => {
          if (deploymentControlBusy === 'undeploy') return;
          setDeploymentControlError(null);
          setPendingUndeploy(null);
        }}
      />

      <ConfirmDialog
        open={!!pendingResetFile}
        title="Discard file changes?"
        message="This restores the file from Git and permanently discards its uncommitted changes."
        detail={pendingResetFile || undefined}
        confirmLabel="Discard changes"
        variant="warning"
        icon="warning"
        error={resetFileError}
        busy={projectOperation?.kind === 'git' && projectOperation.gitAction === 'reset-file'}
        busyLabel="Discarding changes…"
        onConfirm={() => {
          const filePath = pendingResetFile;
          if (filePath) void resetFile(filePath);
        }}
        onCancel={() => {
          if (projectOperationRef.current?.kind === 'git') return;
          setResetFileError(null);
          setPendingResetFile(null);
        }}
      />

      {/* Revert Confirmation Modal */}
      <ViewportModal
        open={!!revertTarget}
        onDismiss={() => {
          if (projectOperationRef.current?.kind === 'git') return;
          setRevertTarget(null);
          setRevertResult(null);
        }}
        dismissible={!reverting}
        initialFocusRef={revertCancelButtonRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        {revertTarget && (
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              role="dialog" aria-modal="true" aria-labelledby="revert-commit-title"
              className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
              <div className="flex items-center gap-2 mb-4">
                <AlertCircle size={20} className="text-amber-400" />
                <h3 id="revert-commit-title" className="text-sm font-semibold text-white">Revert Commit?</h3>
              </div>
              
              <div className="bg-white/5 rounded-lg p-3 mb-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{revertTarget.short}</span>
                  <span className="text-xs text-slate-200 font-medium truncate">{revertTarget.message}</span>
                </div>
                <div className="text-[10px] text-slate-500 space-y-0.5">
                  <p>👤 {revertTarget.author} ({revertTarget.email})</p>
                  <p>📅 {new Date(revertTarget.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' })}</p>
                </div>
              </div>

              <div className="text-xs text-slate-400 mb-3">
                <p className="mb-2">This will create a new commit that undoes:</p>
                <div className="bg-white/[0.03] rounded-lg p-2 space-y-1">
                  <p>• {revertTarget.stats.filesChanged} file{revertTarget.stats.filesChanged !== 1 ? 's' : ''} changed</p>
                  <p>• <span className="text-emerald-400">{revertTarget.stats.insertions} insertions</span> / <span className="text-red-400">{revertTarget.stats.deletions} deletions</span> will be reversed</p>
                  {revertTarget.stats.files.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/5">
                      <p className="text-[10px] text-slate-600 mb-1">Files affected:</p>
                      {revertTarget.stats.files.map(f => (
                        <p key={f.path} className="text-[10px] font-mono text-slate-500">- {f.path}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <p className="text-[10px] text-amber-400/70 mb-4">⚠️ This action cannot be undone (but you can revert the revert).</p>

              {revertResult && (
                <div className={`text-xs p-2 rounded mb-3 ${revertResult.success ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                  {revertResult.message}
                </div>
              )}

              <div className="flex gap-2">
                <button ref={revertCancelButtonRef} onClick={() => {
                  if (projectOperationRef.current?.kind === 'git') return;
                  setRevertTarget(null);
                  setRevertResult(null);
                }} disabled={reverting}
                  className="flex-1 py-2 rounded-lg bg-white/5 text-slate-400 text-xs hover:bg-white/10 transition-colors disabled:opacity-30">
                  {revertResult?.success ? 'Close' : 'Cancel'}
                </button>
                <button onClick={handleRevert} disabled={reverting || revertResult?.success === true}
                  aria-busy={reverting}
                  className="flex-1 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-xs hover:bg-amber-500/30 font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-30">
                  {reverting ? <><Loader2 size={12} className="animate-spin" /> Reverting…</> : <><Undo2 size={12} /> Confirm Revert</>}
                </button>
              </div>
            </motion.div>
        )}
      </ViewportModal>

      {/* Side-by-Side Diff Viewer Modal */}
      <ViewportModal
        open={!!commitDiff}
        onDismiss={() => setCommitDiff(null)}
        initialFocusRef={commitDiffCloseButtonRef}
        className="bg-black/70 p-4 backdrop-blur-sm"
      >
        {commitDiff && (
            <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }}
              role="dialog" aria-modal="true" aria-label="Commit diff"
              className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[90vw] flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <Diff size={14} className="text-blue-400" />
                  <span className="text-xs font-medium text-white">Commit Diff</span>
                  <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{commitDiff.hash.substring(0, 7)}</span>
                </div>
                <button ref={commitDiffCloseButtonRef} aria-label="Close commit diff" onClick={() => setCommitDiff(null)} className="inline-flex size-8 items-center justify-center text-slate-500 hover:text-white"><X size={14} /></button>
              </div>
              
              {/* Stats summary */}
              {commitDiff.output && (
                <div className="px-4 py-2 border-b border-white/5 bg-white/[0.02]">
                  <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap">{commitDiff.output}</pre>
                </div>
              )}
              
              {/* Diff content - side by side */}
              <div className="flex-1 overflow-auto">
                {(() => {
                  const diffText = commitDiff.diff || '';
                  // Parse unified diff into file sections
                  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);
                  
                  return fileSections.map((section, idx) => {
                    const lines = section.split('\n');
                    const fileHeader = lines[0] || '';
                    const fileMatch = fileHeader.match(/a\/(.+?) b\/(.+)/);
                    const fileName = fileMatch ? fileMatch[2] : fileHeader;
                    
                    // Extract hunks
                    const oldLines: Array<{ num: number | null; content: string; type: 'context' | 'add' | 'remove' | 'header' }> = [];
                    const newLines: Array<{ num: number | null; content: string; type: 'context' | 'add' | 'remove' | 'header' }> = [];
                    let oldNum = 0, newNum = 0;
                    
                    for (const line of lines.slice(1)) {
                      if (line.startsWith('@@')) {
                        const hunkMatch = line.match(/@@ -(\d+)/);
                        const newMatch = line.match(/\+(\d+)/);
                        if (hunkMatch) oldNum = parseInt(hunkMatch[1]) - 1;
                        if (newMatch) newNum = parseInt(newMatch[1]) - 1;
                        oldLines.push({ num: null, content: line, type: 'header' });
                        newLines.push({ num: null, content: line, type: 'header' });
                      } else if (line.startsWith('+') && !line.startsWith('+++')) {
                        newNum++;
                        oldLines.push({ num: null, content: '', type: 'add' });
                        newLines.push({ num: newNum, content: line.slice(1), type: 'add' });
                      } else if (line.startsWith('-') && !line.startsWith('---')) {
                        oldNum++;
                        oldLines.push({ num: oldNum, content: line.slice(1), type: 'remove' });
                        newLines.push({ num: null, content: '', type: 'remove' });
                      } else if (line.startsWith(' ')) {
                        oldNum++; newNum++;
                        oldLines.push({ num: oldNum, content: line.slice(1), type: 'context' });
                        newLines.push({ num: newNum, content: line.slice(1), type: 'context' });
                      }
                    }
                    
                    if (oldLines.length === 0) return null;
                    
                    return (
                      <div key={idx} className="border-b border-white/5">
                        <div className="px-4 py-1.5 bg-blue-500/5 border-b border-white/5 sticky top-0">
                          <span className="text-[11px] font-mono text-blue-400">{fileName}</span>
                        </div>
                        <div className="flex">
                          {/* Old (left) */}
                          <div className="flex-1 border-r border-white/5 overflow-x-auto">
                            {oldLines.map((l, i) => (
                              <div key={i} className={`flex text-[10px] font-mono leading-5 ${
                                l.type === 'remove' ? 'bg-red-500/10' : l.type === 'add' ? 'bg-transparent' : l.type === 'header' ? 'bg-blue-500/5' : ''
                              }`}>
                                <span className="w-10 text-right pr-2 text-slate-600 select-none flex-shrink-0 border-r border-white/5">
                                  {l.num || ''}
                                </span>
                                <pre className={`px-2 whitespace-pre flex-1 ${
                                  l.type === 'remove' ? 'text-red-300' : l.type === 'header' ? 'text-blue-400' : 'text-slate-400'
                                }`}>{l.content}</pre>
                              </div>
                            ))}
                          </div>
                          {/* New (right) */}
                          <div className="flex-1 overflow-x-auto">
                            {newLines.map((l, i) => (
                              <div key={i} className={`flex text-[10px] font-mono leading-5 ${
                                l.type === 'add' ? 'bg-emerald-500/10' : l.type === 'remove' ? 'bg-transparent' : l.type === 'header' ? 'bg-blue-500/5' : ''
                              }`}>
                                <span className="w-10 text-right pr-2 text-slate-600 select-none flex-shrink-0 border-r border-white/5">
                                  {l.num || ''}
                                </span>
                                <pre className={`px-2 whitespace-pre flex-1 ${
                                  l.type === 'add' ? 'text-emerald-300' : l.type === 'header' ? 'text-blue-400' : 'text-slate-400'
                                }`}>{l.content}</pre>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </motion.div>
        )}
      </ViewportModal>
      
      {/* Progress Notification for deploy/install */}
      <AnimatePresence>
        {progressNotification && (
          <ProgressNotification {...progressNotification} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
