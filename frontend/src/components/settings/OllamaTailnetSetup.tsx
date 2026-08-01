import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  Wifi,
  XCircle,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ollamaTailnetAPI,
  ollamaTailnetErrorMessage,
  ollamaTailnetHasDefinitiveHttpResponse,
  type OllamaCatalogModel,
  type OllamaPullSnapshot,
  type OllamaTailnetBindingSnapshot,
  type OllamaTailnetModel,
  type OllamaTailnetServerNetwork,
  type OllamaTailnetStatus,
  type OllamaTailnetVerificationEvidence,
} from '../../api/ollamaTailnet';
import { useAuthStore } from '../../contexts/AuthContext';
import { formatBytes, formatSpeed, formatTime } from '../../utils/smartUpload';
import { isOwner } from '../../utils/authz';
import TypedConfirmationDialog from '../TypedConfirmationDialog';
import { useSettingsMutationCoordinator } from './SettingsMutationContext';

export type OllamaTailnetSetupMode = 'settings' | 'setup-handoff';

type Props = {
  mode?: OllamaTailnetSetupMode;
  className?: string;
  onBusyChange?: (busy: boolean) => void;
  onStatusChange?: (status: OllamaTailnetStatus) => void;
};

type BusyOperation =
  | 'connect'
  | 'reverify'
  | 'verify'
  | 'test'
  | 'use-model'
  | 'pull'
  | 'cancel-pull'
  | 'ack-legacy-retirement'
  | 'server-install'
  | 'server-connect'
  | 'inventory-refresh'
  | 'remove'
  | null;

type CleanupHold = Readonly<{
  reason: 'outcome-unknown' | 'same-peer-reconnected';
  command: string;
  stableNodeId: string;
  generation: number;
}>;

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u;
const SERVER_NETWORK_POLL_INTERVAL_MS = 10_000;
const SERVER_NETWORK_MAX_POLLS = 30;
const ACTIVE_PULL_STATES = new Set<OllamaPullSnapshot['state']>([
  'running',
  'cancelling',
]);
const RETRYABLE_PULL_STATES = new Set<OllamaPullSnapshot['state']>([
  'failed',
  'cancelled',
  'timed_out',
]);

function peerName(peer: {
  displayName?: string | null;
  stableNodeId: string;
}): string {
  return peer.displayName?.trim() || peer.stableNodeId;
}

function formatObservedAt(value: string | null | undefined): string {
  if (!value) return 'Not yet';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString();
}

function modelSize(model: OllamaTailnetModel | OllamaCatalogModel): number | null {
  if (typeof model.sizeBytes === 'number') return model.sizeBytes;
  if ('size' in model && typeof model.size === 'number') return model.size;
  return null;
}

function grantSnapshotKey(peer: {
  fingerprint: string;
  grantTemplate: string | null;
  grantTemplateHash: string | null;
} | null | undefined): string | null {
  if (!peer?.grantTemplate || !peer.grantTemplateHash) return null;
  return `${peer.fingerprint}\u0000${peer.grantTemplateHash}`;
}

function inventoryScopeKey(authority: {
  kind: 'LOCAL' | 'TAILNET';
  generation: number | null;
  fingerprint: string;
} | null | undefined): string | null {
  if (!authority) return null;
  return [
    authority.kind,
    authority.generation ?? 'local',
    authority.fingerprint,
  ].join(':');
}

function pullMatchesBindingAuthority(
  pull: OllamaPullSnapshot,
  authority: OllamaTailnetBindingSnapshot | null | undefined,
): boolean {
  return Boolean(
    authority
    && pull.authority.kind === 'TAILNET'
    && pull.authority.generation === authority.generation
    // Version advances for observation refreshes and model selection. A pull
    // remains owned by the same GPU authority across those ordinary CAS
    // changes, while generation + fingerprint prevent cross-GPU leakage.
    && pull.authority.fingerprint === authority.bindingFingerprint,
  );
}

function canonicalModelDigest(value: string | null | undefined): string | null {
  const match = String(value || '').trim().match(/^(?:sha256:)?([a-f0-9]{64})$/iu);
  return match ? `sha256:${match[1].toLowerCase()}` : null;
}

function bindingInventoryScopeKey(
  binding: OllamaTailnetBindingSnapshot | null | undefined,
): string | null {
  if (!binding) return null;
  return inventoryScopeKey({
    kind: 'TAILNET',
    generation: binding.generation,
    fingerprint: binding.bindingFingerprint,
  });
}

function modelInventoryBlockedReason(
  status: OllamaTailnetStatus,
): string | null {
  const authority = status.binding.authority;
  if (!authority) return null;
  if (authority.state === 'DISCONNECTED') {
    return 'The Remote GPU is disconnected. Reverify or reconnect it before refreshing installed models.';
  }
  if (authority.state === 'REMOVED') {
    return 'The Remote GPU authority was removed. Connect a backend before refreshing installed models.';
  }
  if (authority.grantSnapshotState === 'CHANGED') {
    return 'The Remote GPU grant changed. Reconnect it before refreshing installed models.';
  }
  if (authority.grantSnapshotState !== 'CURRENT') {
    return 'The Remote GPU grant could not be verified. Reverify or reconnect it before refreshing installed models.';
  }
  return null;
}

const MUTATION_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
]);

async function reconcileMutationStatus(
  loadStatus: () => Promise<OllamaTailnetStatus>,
  committed: (status: OllamaTailnetStatus) => boolean,
): Promise<{
  status: OllamaTailnetStatus | null;
  committed: boolean;
}> {
  let latest: OllamaTailnetStatus | null = null;
  for (const delayMs of MUTATION_RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });
    }
    try {
      latest = await loadStatus();
      if (committed(latest)) {
        return { status: latest, committed: true };
      }
    } catch {
      // A readback can race a still-settling commit or the same broken proxy.
      // Keep polling within the bounded window and never infer rollback.
    }
  }
  return { status: latest, committed: false };
}

async function reconcileServerNetworkMutation(
  readNetwork: () => Promise<OllamaTailnetServerNetwork>,
  committed: (network: OllamaTailnetServerNetwork) => boolean,
): Promise<{
  network: OllamaTailnetServerNetwork | null;
  committed: boolean;
}> {
  let latest: OllamaTailnetServerNetwork | null = null;
  for (const delayMs of MUTATION_RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });
    }
    try {
      latest = await readNetwork();
      if (committed(latest)) {
        return { network: latest, committed: true };
      }
    } catch {
      // Keep polling within the same bounded response-loss window.
    }
  }
  return { network: latest, committed: false };
}

function SetupHandoff({ className = '' }: { className?: string }) {
  return (
    <section className={`rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <Cpu
          size={20}
          className="mt-0.5 shrink-0 text-violet-300"
          aria-hidden="true"
        />
        <div>
          <h3 className="text-sm font-semibold text-theme-text">
            Add your Windows GPU after launch
          </h3>
          <p className="mt-1 text-xs leading-5 text-theme-text-muted">
            Finish Portal setup and sign in as the Owner. Then open Settings →
            AI Providers → Remote GPU to connect a Windows PC already on your
            tailnet.
          </p>
        </div>
      </div>
      <ol className="mt-4 grid gap-2 text-xs leading-5 text-theme-text-muted sm:grid-cols-3">
        <li className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
          <span className="font-semibold text-theme-text">1. Choose the PC</span>
          <br />
          Portal discovers its stable Tailscale identity.
        </li>
        <li className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
          <span className="font-semibold text-theme-text">2. Run one setup</span>
          <br />
          The signed-in Owner downloads one Windows setup zip.
        </li>
        <li className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
          <span className="font-semibold text-theme-text">3. Pick a model</span>
          <br />
          Use an installed model or download one from the curated catalog.
        </li>
      </ol>
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-amber-100">
        <ShieldCheck
          size={15}
          className="mt-0.5 shrink-0"
          aria-hidden="true"
        />
        This handoff is informational. It performs no discovery, download,
        authority, or model API work.
      </div>
    </section>
  );
}

function PullProgress({
  pull,
  locked,
  onCancel,
  onRetry,
}: {
  pull: OllamaPullSnapshot;
  locked: boolean;
  onCancel: (pull: OllamaPullSnapshot) => void;
  onRetry: (pull: OllamaPullSnapshot) => void;
}) {
  const determinate = (
    pull.totalBytes !== null
    && pull.totalBytes > 0
    && pull.completedBytes !== null
    && pull.completedBytes >= 0
    && pull.completedBytes <= pull.totalBytes
    && pull.percent !== null
  );
  const percent = determinate
    ? Math.min(100, Math.max(0, pull.percent ?? 0))
    : 0;
  const active = ACTIVE_PULL_STATES.has(pull.state);
  const succeeded = pull.state === 'succeeded';
  const phaseLabel = pull.phase.replace(/[_-]+/gu, ' ');
  const layerLabel = pull.digest ?? 'not reported yet';

  return (
    <article
      className="rounded-xl border border-theme-border bg-theme-bg p-3"
      aria-label={`Model download ${pull.model}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs font-semibold text-theme-text">
              {pull.model}
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              succeeded
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                : active
                  ? 'border-violet-500/25 bg-violet-500/10 text-violet-100'
                  : 'border-red-500/25 bg-red-500/10 text-red-100'
            }`}>
              {pull.state.replace('_', ' ')}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-theme-text-muted">
            {pull.status}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {pull.canCancel && (
            <button
              type="button"
              onClick={() => onCancel(pull)}
              disabled={locked || pull.state === 'cancelling'}
              className="inline-flex min-h-[38px] items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 text-xs font-medium text-red-100 hover:bg-red-500/20 disabled:opacity-45"
            >
              {pull.state === 'cancelling'
                ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                : <Square size={12} aria-hidden="true" />}
              {pull.state === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {RETRYABLE_PULL_STATES.has(pull.state) && (
            <button
              type="button"
              onClick={() => onRetry(pull)}
              disabled={locked}
              className="inline-flex min-h-[38px] items-center gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text hover:bg-theme-surface-hover disabled:opacity-45"
            >
              <RefreshCw size={13} aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      </div>

      {active && (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px] text-theme-text-subtle">
            <span className="font-semibold text-theme-text-muted">
              Current layer progress
            </span>
            <span>
              Phase: <span className="font-medium text-theme-text-muted">{phaseLabel}</span>
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`Current layer progress for ${pull.model}`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(determinate
              ? {
                  'aria-valuenow': Math.round(percent),
                  'aria-valuetext': `${Math.round(percent)} percent of the current layer`,
                }
              : {
                  'aria-valuetext': pull.status
                    ? `Current layer: ${pull.status}`
                    : 'Current-layer progress unknown',
                })}
            className="h-2 w-full overflow-hidden rounded-full bg-theme-border/70"
          >
            {determinate ? (
              <div
                className="h-full rounded-full bg-violet-400 transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            ) : (
              <div className="typed-confirmation-progress-sweep h-full w-1/3 rounded-full bg-violet-400" />
            )}
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] tabular-nums text-theme-text-subtle">
            <span>
              {determinate && pull.completedBytes !== null && pull.totalBytes !== null
                ? `Current layer: ${formatBytes(pull.completedBytes)} of ${formatBytes(pull.totalBytes)} · ${Math.round(percent)}%`
                : 'Waiting for Ollama to report current-layer byte counters…'}
            </span>
            <span>
              {pull.speedBytesPerSecond !== null
                ? formatSpeed(pull.speedBytesPerSecond)
                : ''}
              {pull.speedBytesPerSecond !== null && pull.etaSeconds !== null
                ? ' · '
                : ''}
              {pull.etaSeconds !== null
                ? `${formatTime(pull.etaSeconds)} remaining`
                : ''}
            </span>
          </div>
          <p className="mt-2 break-all font-mono text-[10px] leading-4 text-theme-text-subtle">
            Layer digest: {layerLabel}
          </p>
        </div>
      )}

      {pull.error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs leading-5 text-red-100">
          <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {pull.error}
        </div>
      )}
      <p className="mt-2 text-[10px] leading-4 text-theme-text-subtle">
        Percent and ETA describe Ollama&apos;s current model layer, not the
        entire model. Cancelling or restarting Portal can leave reusable
        partial layers; Retry resumes from what Ollama already has.
      </p>
    </article>
  );
}

export default function OllamaTailnetSetup({
  mode = 'settings',
  className = '',
  onBusyChange,
  onStatusChange,
}: Props) {
  const user = useAuthStore((state) => state.user);
  const owner = isOwner(user);
  const settingsMutation = useSettingsMutationCoordinator();
  const mountedRef = useRef(true);
  const operationRef = useRef<string | null>(null);
  const statusRef = useRef<OllamaTailnetStatus | null>(null);
  const completedPullsRef = useRef(new Set<string>());
  const serverLoginPollUrlRef = useRef<string | null>(null);
  const serverLoginPollCountRef = useRef(0);

  const [status, setStatus] = useState<OllamaTailnetStatus | null>(null);
  const [models, setModels] = useState<readonly OllamaTailnetModel[]>([]);
  const [modelInventoryScope, setModelInventoryScope] =
    useState<string | null>(null);
  const [modelInventoryStale, setModelInventoryStale] = useState(true);
  const [modelInventoryError, setModelInventoryError] =
    useState<string | null>(null);
  const [catalog, setCatalog] = useState<readonly OllamaCatalogModel[]>([]);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null);
  const [pulls, setPulls] = useState<readonly OllamaPullSnapshot[]>([]);
  const [serverNetwork, setServerNetwork] =
    useState<OllamaTailnetServerNetwork | null>(null);
  const [serverNetworkError, setServerNetworkError] =
    useState<string | null>(null);
  const [authKeyInput, setAuthKeyInput] = useState('');
  const authKeyInputRef = useRef<HTMLInputElement>(null);
  const [selectedPeerId, setSelectedPeerId] = useState('');
  const [acknowledgedGrantSnapshot, setAcknowledgedGrantSnapshot] =
    useState<string | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [diagnostics, setDiagnostics] =
    useState<OllamaTailnetVerificationEvidence | null>(null);
  const [cleanupCommand, setCleanupCommand] = useState('');
  const [cleanupHold, setCleanupHold] = useState<CleanupHold | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [loading, setLoading] = useState(mode === 'settings' && owner);
  const [refreshing, setRefreshing] = useState(false);
  const [busyOperation, setBusyOperation] = useState<BusyOperation>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyStatus = useCallback((next: OllamaTailnetStatus) => {
    statusRef.current = next;
    if (!mountedRef.current) return;
    setStatus(next);
    onStatusChange?.(next);
    setSelectedPeerId((current) => {
      if (
        !current
        || !next.tailscale.available
        || next.tailscale.inventory.peers.some(
          (peer) => peer.stableNodeId === current,
        )
      ) {
        return current;
      }
      setAcknowledgedGrantSnapshot(null);
      return '';
    });
  }, [onStatusChange]);

  const loadStatus = useCallback(async () => {
    const next = await ollamaTailnetAPI.status();
    applyStatus(next);
    return next;
  }, [applyStatus]);

  const invalidateModelInventory = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setModels([]);
    setModelInventoryScope(null);
    setModelInventoryStale(true);
    setModelInventoryError(message);
  }, []);

  const loadModels = useCallback(async () => {
    let next: Awaited<ReturnType<typeof ollamaTailnetAPI.models>>;
    try {
      next = await ollamaTailnetAPI.models();
    } catch (requestError) {
      if (mountedRef.current) {
        setModelInventoryStale(true);
        setModelInventoryError(ollamaTailnetErrorMessage(
          requestError,
          'Installed-model inventory could not be refreshed.',
        ));
      }
      throw requestError;
    }
    const receivedScope = inventoryScopeKey(next.authority);
    const expectedScope = bindingInventoryScopeKey(
      statusRef.current?.binding.authority,
    );
    if (expectedScope && receivedScope !== expectedScope) {
      if (mountedRef.current) {
        setModels([]);
        setModelInventoryScope(receivedScope);
        setModelInventoryStale(true);
        setModelInventoryError(
          'The Remote GPU authority changed while inventory was loading. Refresh inventory again.',
        );
      }
      throw new Error(
        'Installed-model inventory did not match the current Remote GPU authority.',
      );
    }
    if (mountedRef.current) {
      setModels(next.models);
      setModelInventoryScope(receivedScope);
      setModelInventoryStale(false);
      setModelInventoryError(null);
    }
    return next;
  }, []);

  const loadServerNetwork = useCallback(async () => {
    try {
      const next = await ollamaTailnetAPI.serverNetwork();
      if (mountedRef.current) {
        setServerNetwork(next);
        setServerNetworkError(null);
      }
      return next;
    } catch (requestError) {
      if (mountedRef.current) {
        setServerNetworkError(ollamaTailnetErrorMessage(
          requestError,
          'The Portal server network state could not be refreshed.',
        ));
      }
      throw requestError;
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    const next = await ollamaTailnetAPI.catalog();
    if (mountedRef.current) {
      setCatalog(next.models);
      setCatalogWarning(next.warning ?? null);
    }
    return next;
  }, []);

  const applyPulls = useCallback((
    next: readonly OllamaPullSnapshot[],
  ) => {
    if (!mountedRef.current) return;
    setPulls(next);
    let inventoryChanged = false;
    for (const pull of next) {
      if (
        pull.state === 'succeeded'
        && !completedPullsRef.current.has(pull.id)
      ) {
        completedPullsRef.current.add(pull.id);
        if (pullMatchesBindingAuthority(
          pull,
          statusRef.current?.binding.authority,
        )) {
          inventoryChanged = true;
        }
      }
    }
    if (inventoryChanged) {
      void loadModels().catch(() => undefined);
    }
  }, [loadModels]);

  const loadPulls = useCallback(async () => {
    const next = await ollamaTailnetAPI.pulls();
    applyPulls(next);
    return next;
  }, [applyPulls]);

  const refreshAll = useCallback(async (initial = false) => {
    if (mode !== 'settings' || !owner) return;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    const statusPromise = loadStatus();
    const modelsPromise = statusPromise.then((nextStatus) => {
      const blockedReason = modelInventoryBlockedReason(nextStatus);
      if (blockedReason) {
        invalidateModelInventory(blockedReason);
        return null;
      }
      return loadModels();
    });
    const results = await Promise.allSettled([
      statusPromise,
      loadServerNetwork(),
      modelsPromise,
      loadCatalog(),
      loadPulls(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure && mountedRef.current) {
      setError(ollamaTailnetErrorMessage(
        failure.reason,
        'Remote GPU state could not be fully refreshed.',
      ));
    }
    if (mountedRef.current) {
      setLoading(false);
      setRefreshing(false);
    }
  }, [
    loadCatalog,
    invalidateModelInventory,
    loadModels,
    loadPulls,
    loadServerNetwork,
    loadStatus,
    mode,
    owner,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    if (mode === 'settings' && owner) void refreshAll(true);
    return () => {
      mountedRef.current = false;
    };
  }, [mode, owner, refreshAll]);

  useEffect(() => {
    const loginUrl = serverNetwork?.running
      ? null
      : serverNetwork?.loginUrl ?? null;
    if (!loginUrl) {
      serverLoginPollUrlRef.current = null;
      serverLoginPollCountRef.current = 0;
      return undefined;
    }
    if (serverLoginPollUrlRef.current !== loginUrl) {
      serverLoginPollUrlRef.current = loginUrl;
      serverLoginPollCountRef.current = 0;
    }
    if (serverLoginPollCountRef.current >= SERVER_NETWORK_MAX_POLLS) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      serverLoginPollCountRef.current += 1;
      const pollingExhausted =
        serverLoginPollCountRef.current >= SERVER_NETWORK_MAX_POLLS;
      if (pollingExhausted) {
        window.clearInterval(timer);
      }
      void loadServerNetwork()
        .then((next) => {
          if (next.running) {
            serverLoginPollUrlRef.current = null;
            serverLoginPollCountRef.current = 0;
            void loadStatus().catch(() => undefined);
          } else if (pollingExhausted && mountedRef.current) {
            setServerNetworkError(
              'Portal did not detect Tailscale approval within five minutes. Approve the sign-in link, then select Refresh to check again.',
            );
          }
        })
        .catch(() => undefined);
    }, SERVER_NETWORK_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadServerNetwork, loadStatus, serverNetwork]);

  const hasActivePull = pulls.some((pull) => ACTIVE_PULL_STATES.has(pull.state));
  useEffect(() => {
    if (!hasActivePull || mode !== 'settings' || !owner) return undefined;
    const timer = window.setInterval(() => {
      void loadPulls().catch((requestError) => {
        if (mountedRef.current) {
          setError(ollamaTailnetErrorMessage(
            requestError,
            'Model download progress could not be refreshed.',
          ));
        }
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [hasActivePull, loadPulls, mode, owner]);

  useEffect(() => {
    onBusyChange?.(busyOperation !== null);
  }, [busyOperation, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const beginOperation = useCallback((
    kind: Exclude<BusyOperation, null>,
  ) => {
    const operationOwner = `settings:ollama-remote-gpu:${kind}`;
    if (operationRef.current) return null;
    if (settingsMutation?.claim && !settingsMutation.claim(operationOwner)) {
      return null;
    }
    operationRef.current = operationOwner;
    if (mountedRef.current) {
      setBusyOperation(kind);
      setError(null);
      setNotice(null);
    }
    return operationOwner;
  }, [settingsMutation]);

  const finishOperation = useCallback((operationOwner: string) => {
    if (operationRef.current !== operationOwner) return;
    operationRef.current = null;
    settingsMutation?.release?.(operationOwner);
    if (mountedRef.current) setBusyOperation(null);
  }, [settingsMutation]);

  const patchAuthority = useCallback((
    authority: OllamaTailnetBindingSnapshot | null,
  ) => {
    const current = statusRef.current;
    if (!current) return;
    applyStatus({
      ...current,
      binding: {
        ...current.binding,
        authority,
      },
    });
  }, [applyStatus]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
      setError(null);
    } catch {
      setError('The browser could not copy this text. Select and copy it manually.');
    }
  }, []);

  const installServerTailscale = useCallback(async () => {
    const operationOwner = beginOperation('server-install');
    if (!operationOwner) return;
    try {
      const next = await ollamaTailnetAPI.installServerTailscale();
      if (mountedRef.current) {
        setServerNetwork(next);
        setServerNetworkError(null);
        setNotice(next.running
          ? 'Tailscale is installed and this Portal server is already on your tailnet.'
          : 'Tailscale is installed on the Portal server. Connect it to your tailnet next.');
      }
    } catch (requestError) {
      if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
        if (mountedRef.current) {
          setServerNetworkError(ollamaTailnetErrorMessage(
            requestError,
            'Tailscale could not be installed on the Portal server.',
          ));
        }
        return;
      }
      const readback = await reconcileServerNetworkMutation(
        loadServerNetwork,
        (next) => next.installed,
      );
      if (!mountedRef.current) return;
      if (readback.committed && readback.network) {
        setServerNetwork(readback.network);
        setServerNetworkError(null);
        setNotice(readback.network.running
          ? 'Tailscale installation succeeded and this Portal server is already on your tailnet; Portal confirmed it after the original response was interrupted.'
          : 'Tailscale installation succeeded; Portal confirmed it after the original response was interrupted. Connect this server to your tailnet next.');
      } else {
        setServerNetworkError(
          'Portal could not confirm the Tailscale installation outcome after the response was interrupted. Select Refresh before retrying.',
        );
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [beginOperation, finishOperation, loadServerNetwork]);

  const connectServerNetwork = useCallback(async (useAuthKey: boolean) => {
    const authKey = authKeyInput.trim();
    if (useAuthKey && !authKey) {
      setServerNetworkError(
        'Paste a Tailscale auth key first (auth keys start with "tskey-").',
      );
      return;
    }
    const operationOwner = beginOperation('server-connect');
    if (!operationOwner) return;
    if (useAuthKey) {
      if (authKeyInputRef.current) authKeyInputRef.current.value = '';
      setAuthKeyInput('');
    }
    try {
      const next = await ollamaTailnetAPI.connectServerNetwork(
        useAuthKey ? { authKey } : {},
      );
      if (!mountedRef.current) return;
      setServerNetwork(next);
      setServerNetworkError(null);
      if (next.running) {
        setNotice(
          `This Portal server joined ${next.tailnetName || 'your tailnet'} as ${next.hostName || 'a new machine'}.`,
        );
        void loadStatus().catch((requestError) => {
          if (mountedRef.current) {
            setError(ollamaTailnetErrorMessage(
              requestError,
              'The server joined your tailnet, but Remote GPU discovery could not be refreshed.',
            ));
          }
        });
      } else if (!next.loginUrl) {
        setServerNetworkError(
          'Tailscale did not report a sign-in link yet. Wait a moment, then select Refresh.',
        );
      }
    } catch (requestError) {
      if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
        if (mountedRef.current) {
          setServerNetworkError(ollamaTailnetErrorMessage(
            requestError,
            'The Portal server could not be connected to your tailnet.',
          ));
        }
        return;
      }
      const readback = await reconcileServerNetworkMutation(
        loadServerNetwork,
        (next) => useAuthKey
          ? next.running
          : next.running || Boolean(next.loginUrl),
      );
      if (!mountedRef.current) return;
      if (!readback.committed || !readback.network) {
        setServerNetworkError(
          'Portal could not confirm the Tailscale connection outcome after the response was interrupted. The auth key was not retained; select Refresh before retrying.',
        );
        return;
      }
      const next = readback.network;
      setServerNetwork(next);
      setServerNetworkError(null);
      if (next.running) {
        setNotice(
          `This Portal server joined ${next.tailnetName || 'your tailnet'} as ${next.hostName || 'a new machine'}; Portal confirmed it after the original response was interrupted.`,
        );
        void loadStatus().catch((statusError) => {
          if (mountedRef.current) {
            setError(ollamaTailnetErrorMessage(
              statusError,
              'The server joined your tailnet, but Remote GPU discovery could not be refreshed.',
            ));
          }
        });
      } else {
        setNotice(
          'The Tailscale sign-in flow started; Portal confirmed its approval link after the original response was interrupted.',
        );
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [
    authKeyInput,
    beginOperation,
    finishOperation,
    loadServerNetwork,
    loadStatus,
  ]);

  const retryModelInventory = useCallback(async () => {
    const currentStatus = statusRef.current;
    if (!currentStatus) {
      invalidateModelInventory(
        'Remote GPU status is unavailable. Refresh the connection status before retrying installed models.',
      );
      return;
    }
    const blockedReason = modelInventoryBlockedReason(currentStatus);
    if (blockedReason) {
      invalidateModelInventory(blockedReason);
      return;
    }
    const operationOwner = beginOperation('inventory-refresh');
    if (!operationOwner) return;
    try {
      await loadModels();
      if (mountedRef.current) {
        setNotice('Installed-model inventory refreshed.');
      }
    } catch {
      // loadModels owns the bounded, actionable inventory error state.
    } finally {
      finishOperation(operationOwner);
    }
  }, [
    beginOperation,
    finishOperation,
    invalidateModelInventory,
    loadModels,
  ]);

  const connectPeer = useCallback(async () => {
    const current = statusRef.current;
    const peer = current?.tailscale.available
      ? current.tailscale.inventory.peers.find(
          (entry) => entry.stableNodeId === selectedPeerId,
        )
      : null;
    const currentGrantSnapshot = grantSnapshotKey(peer);
    if (
      !current
      || !peer
      || !currentGrantSnapshot
      || acknowledgedGrantSnapshot !== currentGrantSnapshot
    ) {
      setError('Choose one Windows PC and generate its exact narrow Grant before connecting.');
      return;
    }
    const operationOwner = beginOperation('connect');
    if (!operationOwner) return;
    const authority = current.binding.authority;
    try {
      let binding: OllamaTailnetBindingSnapshot;
      try {
        binding = await ollamaTailnetAPI.connect({
          stableNodeId: selectedPeerId,
          expectedGeneration: authority?.generation ?? null,
          expectedVersion: authority?.version ?? null,
          expectedPeerAttestationFingerprint: peer.fingerprint,
          expectedGrantTemplateHash: peer.grantTemplateHash!,
          grantAcknowledged: true,
        });
      } catch (requestError) {
        if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
          setError(ollamaTailnetErrorMessage(
            requestError,
            'Portal could not connect to the selected Windows GPU. Run the downloaded setup once, apply the narrow Grant, and retry.',
          ));
          return;
        }
        invalidateModelInventory(
          'The connection response was interrupted. Inventory stays hidden until Portal confirms the current authority.',
        );
        const readback = await reconcileMutationStatus(
          loadStatus,
          (next) => {
            const reconciled = next.binding.authority;
            return Boolean(
              reconciled
              && reconciled.state === 'ACTIVE'
              && reconciled.stableNodeId === selectedPeerId
              && reconciled.nodePublicKey === peer.nodePublicKey
              && reconciled.grantSnapshotState === 'CURRENT'
              && (
                !authority
                || reconciled.generation !== authority.generation
                || reconciled.version !== authority.version
              ),
            );
          },
        );
        const reconciled = readback.status?.binding.authority;
        if (!readback.committed || !reconciled) {
          setError(
            'Portal could not confirm the connection outcome after the response was interrupted. Installed-model inventory is hidden; select Refresh before retrying.',
          );
          return;
        }
        setAcknowledgedGrantSnapshot(null);
        setReconnectOpen(false);
        setDiagnostics(null);
        setNotice(
          `${reconciled.displayName || 'Windows GPU'} connected successfully; Portal confirmed it after the original response was interrupted.`,
        );
        const refreshResults = await Promise.allSettled([
          loadModels(),
          loadPulls(),
        ]);
        if (refreshResults.some((result) => result.status === 'rejected')) {
          setError(
            'The Remote GPU connection was confirmed, but its current inventory could not be fully refreshed. Select Retry inventory.',
          );
        }
        return;
      }
      patchAuthority(binding);
      invalidateModelInventory(
        'The Remote GPU authority changed. Refresh installed-model inventory before using model actions.',
      );
      setAcknowledgedGrantSnapshot(null);
      setReconnectOpen(false);
      setDiagnostics(null);
      setNotice(
        `${binding.displayName || 'Windows GPU'} is connected. You can download a model now, even if its inventory is empty.`,
      );
      const refreshResults = await Promise.allSettled([
        loadStatus(),
        loadModels(),
        loadPulls(),
      ]);
      if (refreshResults.some((result) => result.status === 'rejected')) {
        setError(refreshResults[1].status === 'rejected'
          ? 'The Remote GPU connection succeeded, but installed-model inventory could not be refreshed. Inventory stays hidden until Retry inventory succeeds.'
          : 'The Remote GPU connection succeeded, but some current state could not be refreshed. Select Refresh to retry.');
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [
    beginOperation,
    finishOperation,
    acknowledgedGrantSnapshot,
    invalidateModelInventory,
    loadModels,
    loadPulls,
    loadStatus,
    patchAuthority,
    selectedPeerId,
  ]);

  const reverify = useCallback(async () => {
    const authority = statusRef.current?.binding.authority;
    if (!authority) return;
    const operationOwner = beginOperation('reverify');
    if (!operationOwner) return;
    try {
      let binding: OllamaTailnetBindingSnapshot;
      let confirmedAfterInterruption = false;
      try {
        binding = await ollamaTailnetAPI.reverifyAuthority({
          generation: authority.generation,
          expectedVersion: authority.version,
        });
      } catch (requestError) {
        if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
          setError(ollamaTailnetErrorMessage(
            requestError,
            'The Remote GPU could not be reverified.',
          ));
          return;
        }
        const readback = await reconcileMutationStatus(
          loadStatus,
          (next) => {
            const reconciled = next.binding.authority;
            return Boolean(
              reconciled
              && reconciled.state === 'ACTIVE'
              && reconciled.generation === authority.generation
              && reconciled.version > authority.version
              && reconciled.stableNodeId === authority.stableNodeId
              && reconciled.nodePublicKey === authority.nodePublicKey
              && reconciled.grantSnapshotState === 'CURRENT'
              && Boolean(reconciled.verifiedAt)
              && reconciled.verifiedAt !== authority.verifiedAt,
            );
          },
        );
        const reconciled = readback.status?.binding.authority;
        if (!readback.committed || !reconciled) {
          setError(
            'Portal could not confirm the reverify outcome after the response was interrupted. Select Refresh before retrying.',
          );
          return;
        }
        binding = reconciled;
        confirmedAfterInterruption = true;
      }
      patchAuthority(binding);
      setNotice(confirmedAfterInterruption
        ? 'The exact Tailscale identity and private Ollama Serve route were reverified; Portal confirmed the commit after the response was interrupted.'
        : 'The exact Tailscale identity and private Ollama Serve route were reverified.');
      const refreshResults = await Promise.allSettled([
        loadStatus(),
        loadModels(),
      ]);
      if (refreshResults.some((result) => result.status === 'rejected')) {
        setError(
          'Remote GPU reverify succeeded, but its current status or inventory could not be refreshed. Select Refresh to retry.',
        );
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [beginOperation, finishOperation, loadModels, loadStatus, patchAuthority]);

  const verify = useCallback(async () => {
    const authority = statusRef.current?.binding.authority;
    if (!authority) return;
    const operationOwner = beginOperation('verify');
    if (!operationOwner) return;
    try {
      const result = await ollamaTailnetAPI.verifyAuthority({
        generation: authority.generation,
        expectedVersion: authority.version,
      });
      patchAuthority(result.binding);
      setDiagnostics(result.evidence);
      setNotice('Remote identity, Serve route, and Ollama inventory verified.');
      await loadStatus();
    } catch (requestError) {
      setError(ollamaTailnetErrorMessage(
        requestError,
        'Remote GPU verification failed.',
      ));
      await loadStatus().catch(() => undefined);
    } finally {
      finishOperation(operationOwner);
    }
  }, [beginOperation, finishOperation, loadStatus, patchAuthority]);

  const testModel = useCallback(async () => {
    const authority = statusRef.current?.binding.authority;
    if (
      !authority?.selectedModel
      || authority.state !== 'ACTIVE'
      || authority.grantSnapshotState !== 'CURRENT'
    ) {
      setError(
        'Restore the exact acknowledged Grant snapshot before testing the Remote GPU model.',
      );
      return;
    }
    const operationOwner = beginOperation('test');
    if (!operationOwner) return;
    try {
      const result = await ollamaTailnetAPI.testModel({
        generation: authority.generation,
        expectedVersion: authority.version,
      });
      patchAuthority(result.binding);
      setDiagnostics(result.evidence);
      setNotice(`Model test passed for ${result.binding.selectedModel || authority.selectedModel}.`);
      await loadStatus();
    } catch (requestError) {
      setError(ollamaTailnetHasDefinitiveHttpResponse(requestError)
        ? ollamaTailnetErrorMessage(
          requestError,
          'The active Remote GPU model test failed.',
        )
        : 'The model-test response was interrupted. The one-token test may have completed; Portal will not replay it automatically. Retry manually when ready.');
      await loadStatus().catch(() => undefined);
    } finally {
      finishOperation(operationOwner);
    }
  }, [beginOperation, finishOperation, loadStatus, patchAuthority]);

  const activateModel = useCallback(async (model: OllamaTailnetModel) => {
    const authority = statusRef.current?.binding.authority;
    if (!authority || !model.digest) {
      setError('Portal needs the installed model’s exact digest before it can activate it.');
      return;
    }
    if (
      authority.state !== 'ACTIVE'
      || authority.grantSnapshotState !== 'CURRENT'
    ) {
      setError(
        'Restore the exact acknowledged Grant snapshot before activating a Remote GPU model.',
      );
      return;
    }
    const operationOwner = beginOperation('use-model');
    if (!operationOwner) return;
    try {
      let binding: OllamaTailnetBindingSnapshot;
      try {
        binding = await ollamaTailnetAPI.setActiveModel({
          model: model.name,
          expectedDigest: model.digest,
          generation: authority.generation,
          expectedVersion: authority.version,
        });
      } catch (requestError) {
        if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
          setError(ollamaTailnetErrorMessage(
            requestError,
            `Portal could not activate ${model.name}.`,
          ));
          return;
        }
        invalidateModelInventory(
          'The model-selection response was interrupted. Inventory stays hidden until Portal confirms the active digest.',
        );
        const readback = await reconcileMutationStatus(
          loadStatus,
          (next) => {
            const reconciled = next.binding.authority;
            return Boolean(
              reconciled
              && reconciled.state === 'ACTIVE'
              && reconciled.generation === authority.generation
              && reconciled.version > authority.version
              && reconciled.selectedModel === model.name
              && canonicalModelDigest(reconciled.selectedModelDigest)
                === canonicalModelDigest(model.digest),
            );
          },
        );
        const reconciled = readback.status?.binding.authority;
        if (!readback.committed || !reconciled) {
          setError(
            `Portal could not confirm the ${model.name} activation outcome after the response was interrupted. Inventory is hidden; select Refresh before retrying.`,
          );
          return;
        }
        setDiagnostics(null);
        setNotice(
          `${model.name} is active. Portal confirmed the exact digest after the original response was interrupted.`,
        );
        try {
          await loadModels();
        } catch {
          setError(
            `${model.name} is active, but installed-model inventory could not be refreshed. Inventory stays hidden until Retry inventory succeeds.`,
          );
        }
        return;
      }
      patchAuthority(binding);
      invalidateModelInventory(
        'The active model changed. Refresh installed-model inventory before using another model action.',
      );
      setDiagnostics(null);
      setNotice(`${model.name} passed the bounded one-token test and is now the active Remote GPU model. The connection did not need to be rebuilt.`);
      const refreshResults = await Promise.allSettled([
        loadStatus(),
        loadModels(),
      ]);
      if (refreshResults.some((result) => result.status === 'rejected')) {
        setError(refreshResults[1].status === 'rejected'
          ? `${model.name} is active, but installed-model inventory could not be refreshed. Inventory stays hidden until Retry inventory succeeds.`
          : `${model.name} is active, but Remote GPU status could not be refreshed. Select Refresh to retry.`);
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [
    beginOperation,
    finishOperation,
    invalidateModelInventory,
    loadModels,
    loadStatus,
    patchAuthority,
  ]);

  const startPull = useCallback(async (rawModel: string) => {
    const model = rawModel.trim();
    const authority = statusRef.current?.binding.authority;
    if (!MODEL_NAME_PATTERN.test(model)) {
      setError('Enter an exact Ollama model tag using letters, numbers, ".", "_", "/", "-", or ":".');
      return;
    }
    if (
      !authority
      || authority.state !== 'ACTIVE'
      || authority.grantSnapshotState !== 'CURRENT'
    ) {
      setError(
        'Connect and verify one Remote GPU with its exact Grant snapshot current before downloading a model.',
      );
      return;
    }
    const operationOwner = beginOperation('pull');
    if (!operationOwner) return;
    const operationId = globalThis.crypto.randomUUID();
    try {
      const pull = await ollamaTailnetAPI.startPull({
        operationId,
        model,
        expectedAuthority: {
          kind: 'TAILNET',
          generation: authority.generation,
          version: authority.version,
          fingerprint: authority.bindingFingerprint,
        },
      });
      applyPulls([
        pull,
        ...pulls.filter((entry) => entry.id !== pull.id),
      ]);
      setCustomModel('');
      setNotice(`Started downloading ${model} on the connected Remote GPU.`);
    } catch (requestError) {
      if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
        setError(ollamaTailnetErrorMessage(
          requestError,
          `Portal could not start downloading ${model}.`,
        ));
        return;
      }
      let readback: readonly OllamaPullSnapshot[] | null = null;
      try {
        readback = await loadPulls();
      } catch {
        // Outcome remains unknown. The user can safely reconcile via Refresh.
      }
      const committed = readback?.find((entry) => (
        entry.operationId === operationId
        && entry.model === model
        && pullMatchesBindingAuthority(entry, authority)
      ));
      if (committed) {
        setCustomModel('');
        setNotice(
          `Started downloading ${model}; Portal confirmed the pull after the original response was interrupted.`,
        );
      } else {
        setError(
          `Portal could not confirm whether the ${model} download started after the response was interrupted. Select Refresh before retrying.`,
        );
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [applyPulls, beginOperation, finishOperation, loadPulls, pulls]);

  const cancelPull = useCallback(async (pull: OllamaPullSnapshot) => {
    if (!pull.canCancel) return;
    const operationOwner = beginOperation('cancel-pull');
    if (!operationOwner) return;
    try {
      const cancelled = await ollamaTailnetAPI.cancelPull(pull.id);
      applyPulls(pulls.map((entry) => (
        entry.id === cancelled.id ? cancelled : entry
      )));
      setNotice(`Cancellation requested for ${pull.model}.`);
    } catch (requestError) {
      if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
        setError(ollamaTailnetErrorMessage(
          requestError,
          `Portal could not cancel the ${pull.model} download.`,
        ));
        return;
      }
      let readback: readonly OllamaPullSnapshot[] | null = null;
      try {
        readback = await loadPulls();
      } catch {
        // Outcome remains unknown. The user can safely reconcile via Refresh.
      }
      const reconciled = readback?.find((entry) => entry.id === pull.id);
      if (
        reconciled?.state === 'cancelling'
        || reconciled?.state === 'cancelled'
      ) {
        setNotice(
          `Cancellation was accepted for ${pull.model}; Portal confirmed it after the original response was interrupted.`,
        );
      } else if (reconciled?.state === 'succeeded') {
        setNotice(
          `${pull.model} finished downloading before Portal could confirm the cancellation response.`,
        );
      } else if (reconciled?.state === 'failed') {
        setError(
          reconciled.error
            ? `${pull.model} failed before Portal could confirm the cancellation response: ${reconciled.error}`
            : `${pull.model} failed before Portal could confirm the cancellation response.`,
        );
      } else if (reconciled?.state === 'timed_out') {
        setError(
          `${pull.model} timed out before Portal could confirm the cancellation response.`,
        );
      } else {
        setError(
          `Portal could not confirm whether the ${pull.model} cancellation was accepted after the response was interrupted. Select Refresh before retrying.`,
        );
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [applyPulls, beginOperation, finishOperation, loadPulls, pulls]);

  const acknowledgeLegacyHelperRetirement = useCallback(async () => {
    const current = statusRef.current;
    const authority = current?.binding.authority;
    if (
      !current
      || !authority
      || authority.state !== 'ACTIVE'
      || authority.grantSnapshotState !== 'CURRENT'
      || !current.legacyHelperRetirement.required
    ) {
      setError(
        'Refresh and restore a healthy native Remote GPU before recording legacy helper retirement.',
      );
      return;
    }
    const operationOwner = beginOperation('ack-legacy-retirement');
    if (!operationOwner) return;
    try {
      let binding: OllamaTailnetBindingSnapshot;
      let confirmedAfterInterruption = false;
      try {
        binding = await ollamaTailnetAPI.acknowledgeLegacyHelperRetirement({
          generation: authority.generation,
          expectedVersion: authority.version,
          cleanupConfirmed: true,
        });
      } catch (requestError) {
        if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
          setError(ollamaTailnetErrorMessage(
            requestError,
            'Legacy helper retirement could not be recorded.',
          ));
          return;
        }
        const readback = await reconcileMutationStatus(
          loadStatus,
          (next) => {
            const reconciled = next.binding.authority;
            return Boolean(
              reconciled
              && reconciled.generation === authority.generation
              && reconciled.version > authority.version
              && reconciled.legacyHelperRetirementAcknowledgedAt,
            );
          },
        );
        const reconciled = readback.status?.binding.authority;
        if (!readback.committed || !reconciled) {
          setError(
            'Portal could not confirm the legacy-helper retirement acknowledgement after the response was interrupted. Select Refresh before retrying.',
          );
          return;
        }
        binding = reconciled;
        confirmedAfterInterruption = true;
      }
      patchAuthority(binding);
      setNotice(confirmedAfterInterruption
        ? 'Legacy helper retirement was recorded; Portal confirmed it after the response was interrupted. Rollback-safe database rows remain retained.'
        : 'Legacy helper retirement was recorded. Rollback-safe database rows remain retained.');
      const refresh = await Promise.allSettled([loadStatus()]);
      if (refresh[0].status === 'rejected') {
        setError(
          'Legacy helper retirement was recorded, but current Remote GPU status could not be refreshed. Select Refresh to retry.',
        );
      }
    } finally {
      finishOperation(operationOwner);
    }
  }, [beginOperation, finishOperation, loadStatus, patchAuthority]);

  const confirmRemoval = useCallback(async () => {
    const current = statusRef.current;
    const authority = current?.binding.authority;
    if (!current || !authority) return;
    const operationOwner = beginOperation('remove');
    if (!operationOwner) return;
    const exactCleanup = current.setup.removeCommand;
    const finishConfirmedRemoval = (
      reconciled: OllamaTailnetBindingSnapshot | null,
      responseInterrupted: boolean,
    ) => {
      invalidateModelInventory(
        reconciled
          ? 'The Remote GPU authority changed. Refresh its exact installed-model inventory.'
          : 'The Remote GPU authority was removed. Connect a backend before loading inventory.',
      );
      patchAuthority(reconciled);
      setDiagnostics(null);
      setRemoveOpen(false);
      if (reconciled?.stableNodeId === authority.stableNodeId) {
        setCleanupCommand('');
        setCleanupHold({
          reason: 'same-peer-reconnected',
          command: exactCleanup,
          stableNodeId: authority.stableNodeId,
          generation: authority.generation,
        });
        setNotice(
          'The previous authority was removed, but the same Windows PC is already connected again. Do not run the Serve cleanup command while that current connection is in use.',
        );
        return;
      }
      setCleanupHold(null);
      setCleanupCommand(exactCleanup);
      if (reconciled) {
        setNotice(
          'The previous Remote GPU was removed and a different GPU is now current. Use the Windows setup bundle on the removed PC for scoped cleanup; Portal hides the generic cleanup command while any authority is live.',
        );
        return;
      }
      setNotice(responseInterrupted
        ? 'Remote GPU removal succeeded; Portal confirmed it after the original response was interrupted. Run the exact cleanup command on that Windows PC.'
        : 'Remote GPU authority was removed. Run the exact cleanup command shown below on that Windows PC.');
    };
    try {
      let responseInterrupted = false;
      try {
        await ollamaTailnetAPI.removeAuthority({
          generation: authority.generation,
          expectedVersion: authority.version,
        });
      } catch (requestError) {
        if (ollamaTailnetHasDefinitiveHttpResponse(requestError)) {
          setError(ollamaTailnetErrorMessage(
            requestError,
            'Remote GPU authority could not be removed.',
          ));
          return;
        }
        responseInterrupted = true;
        invalidateModelInventory(
          'The removal response was interrupted. Inventory stays hidden until Portal confirms the current authority.',
        );
      }
      const readback = await reconcileMutationStatus(
        loadStatus,
        (next) => {
          const reconciled = next.binding.authority;
          return !reconciled
            || reconciled.generation !== authority.generation;
        },
      );
      const reconciled = readback.status?.binding.authority ?? null;
      if (!readback.committed) {
        setCleanupCommand('');
        setCleanupHold({
          reason: 'outcome-unknown',
          command: exactCleanup,
          stableNodeId: authority.stableNodeId,
          generation: authority.generation,
        });
        setRemoveOpen(false);
        if (responseInterrupted) {
          setError(
            'Portal could not confirm the removal outcome after the response was interrupted. Inventory is hidden; do not run Serve cleanup until Refresh confirms the current authority.',
          );
        } else {
          setNotice(
            'The authority removal committed, but Portal could not confirm whether the same Windows PC was reconnected. Do not run Serve cleanup until Refresh confirms the current authority.',
          );
        }
        return;
      }
      finishConfirmedRemoval(reconciled, responseInterrupted);
    } finally {
      finishOperation(operationOwner);
    }
  }, [
    beginOperation,
    finishOperation,
    invalidateModelInventory,
    loadStatus,
    patchAuthority,
  ]);

  const filteredCatalog = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter((model) => (
      model.name.toLowerCase().includes(query)
      || model.description.toLowerCase().includes(query)
      || model.useCase?.toLowerCase().includes(query)
    ));
  }, [catalog, catalogQuery]);

  const peers = status?.tailscale.available
    ? status.tailscale.inventory.peers
    : [];
  const selectedPeer = peers.find(
    (peer) => peer.stableNodeId === selectedPeerId,
  ) ?? null;
  const selectedPeerGrant = selectedPeer?.grantTemplate ?? null;
  const selectedGrantSnapshot = grantSnapshotKey(selectedPeer);
  const grantAcknowledged = Boolean(
    selectedGrantSnapshot
    && acknowledgedGrantSnapshot === selectedGrantSnapshot,
  );

  useEffect(() => {
    if (
      acknowledgedGrantSnapshot
      && acknowledgedGrantSnapshot !== selectedGrantSnapshot
    ) {
      setAcknowledgedGrantSnapshot(null);
    }
  }, [acknowledgedGrantSnapshot, selectedGrantSnapshot]);

  useEffect(() => {
    if (!cleanupHold || !status) return;
    const currentAuthority = status.binding.authority;
    if (
      currentAuthority?.stableNodeId === cleanupHold.stableNodeId
      && currentAuthority.generation === cleanupHold.generation
    ) {
      // This can be a stale read of the authority whose removal outcome was
      // unknown. Keep the destructive command unavailable.
      return;
    }
    if (currentAuthority?.stableNodeId === cleanupHold.stableNodeId) {
      if (cleanupHold.reason !== 'same-peer-reconnected') {
        setCleanupHold({
          ...cleanupHold,
          reason: 'same-peer-reconnected',
        });
      }
      return;
    }
    setCleanupCommand(cleanupHold.command);
    setCleanupHold(null);
  }, [cleanupHold, status]);

  if (mode === 'setup-handoff') {
    return <SetupHandoff className={className} />;
  }

  if (!owner) {
    return (
      <section className={`rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 ${className}`}>
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={20}
            className="mt-0.5 shrink-0 text-amber-300"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-theme-text">
              Owner access required
            </h3>
            <p className="mt-1 text-xs leading-5 text-theme-text-muted">
              Connecting a Remote GPU changes Portal&apos;s Ollama execution
              authority. Only the Owner can inspect or change it.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const authority = status?.binding.authority ?? null;
  const authorityPulls = pulls.filter(
    (pull) => pullMatchesBindingAuthority(pull, authority),
  );
  const currentInventoryScope = bindingInventoryScopeKey(authority);
  const modelInventoryReady = Boolean(
    currentInventoryScope
    && !modelInventoryStale
    && modelInventoryScope === currentInventoryScope,
  );
  const visibleModels = modelInventoryReady ? models : [];
  const authorityGrantHealthy = Boolean(
    authority?.state === 'ACTIVE'
    && authority.grantSnapshotState === 'CURRENT',
  );
  const authorityStatusLabel = authority?.state === 'ACTIVE'
    ? authority.grantSnapshotState === 'CURRENT'
      ? 'ACTIVE'
      : authority.grantSnapshotState === 'CHANGED'
        ? 'RECONNECT REQUIRED'
        : 'HEALTH UNKNOWN'
    : authority?.state ?? null;
  const surfaceLocked = Boolean(busyOperation || settingsMutation?.owner);
  const runningPull = authorityPulls.some(
    (pull) => ACTIVE_PULL_STATES.has(pull.state),
  );

  return (
    <section className={`space-y-4 rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm ${className}`}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-2.5">
            <Cpu size={22} className="text-violet-300" aria-hidden="true" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-theme-text">
                Remote GPU
              </h3>
              {authority && (
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  authorityGrantHealthy
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/25 bg-amber-500/10 text-amber-100'
                }`}>
                  {authorityStatusLabel}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-theme-text-muted">
              Run Ollama on one Windows GPU over a private, identity-bound
              Tailscale Serve route. Portal never accepts a raw Ollama URL and
              never stores a browser pairing secret.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void refreshAll(); }}
          disabled={refreshing || surfaceLocked}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-medium text-theme-text hover:bg-theme-surface-hover disabled:opacity-45"
        >
          <RefreshCw
            size={14}
            className={refreshing ? 'animate-spin' : ''}
            aria-hidden="true"
          />
          Refresh
        </button>
      </header>

      <div aria-live="polite" className="space-y-2">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs leading-5 text-red-100">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs leading-5 text-emerald-100">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}
        {authority?.state === 'ACTIVE' && !authorityGrantHealthy && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-amber-100">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {authority.grantSnapshotState === 'CHANGED'
                ? 'The peer or exact Tailscale Grant snapshot changed. Remote requests are blocked; review the current Grant and reconnect.'
                : 'Portal cannot currently prove the acknowledged Tailscale Grant snapshot. Remote requests are blocked until status is refreshed or the GPU is reconnected.'}
            </span>
          </div>
        )}
      </div>

      <article className="rounded-xl border border-theme-border bg-theme-bg p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-theme-text-subtle">
              Portal server network
            </div>
            <h4 className="mt-1 text-sm font-semibold text-theme-text">
              {serverNetwork?.running
                ? `On tailnet ${serverNetwork.tailnetName || ''}`.trim()
                : 'Put this Portal server on your tailnet'}
            </h4>
          </div>
          {serverNetwork && (
            <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
              serverNetwork.running
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                : 'border-amber-500/25 bg-amber-500/10 text-amber-100'
            }`}>
              {serverNetwork.running
                ? 'Connected'
                : serverNetwork.installed
                  ? (serverNetwork.backendState || 'Not connected')
                  : 'Not installed'}
            </span>
          )}
        </div>

        {serverNetworkError && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-xs leading-5 text-red-100"
          >
            <AlertTriangle
              size={15}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>{serverNetworkError}</span>
          </div>
        )}

        {!serverNetwork ? (
          <p className="mt-3 text-xs leading-5 text-theme-text-muted">
            Checking the Portal server&apos;s Tailscale state…
          </p>
        ) : serverNetwork.running ? (
          <p className="mt-3 text-xs leading-5 text-theme-text-muted">
            This server is{' '}
            <span className="font-medium text-theme-text">
              {serverNetwork.hostName || 'connected'}
            </span>
            {serverNetwork.tailnetIp && (
              <> at <span className="font-mono text-theme-text">{serverNetwork.tailnetIp}</span></>
            )}
            {serverNetwork.version ? ` · Tailscale ${serverNetwork.version}` : ''}.
            {' '}Your Windows GPU must sign into this same tailnet.
          </p>
        ) : !serverNetwork.installed ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-theme-text-muted">
              Tailscale is not installed on this server. Portal can install it
              using Tailscale&apos;s official installer; this usually takes
              about a minute.
            </p>
            <button
              type="button"
              onClick={() => { void installServerTailscale(); }}
              disabled={surfaceLocked}
              className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-violet-400/40 bg-violet-500/20 px-4 text-xs font-semibold text-violet-50 hover:bg-violet-500/30 disabled:opacity-45"
            >
              {busyOperation === 'server-install'
                ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                : <Download size={14} aria-hidden="true" />}
              {busyOperation === 'server-install'
                ? 'Installing Tailscale…'
                : 'Install Tailscale on this server'}
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {serverNetwork.loginUrl ? (
              <>
                <p className="text-xs leading-5 text-theme-text-muted">
                  Approve this server with the same Tailscale account as your
                  Windows GPU. Portal checks for approval for up to five minutes.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <a
                    href={serverNetwork.loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-violet-400/40 bg-violet-500/20 px-4 text-xs font-semibold text-violet-50 hover:bg-violet-500/30"
                  >
                    <ShieldCheck size={14} aria-hidden="true" />
                    Open Tailscale sign-in
                  </a>
                  <span className="inline-flex items-center gap-2 text-[11px] text-theme-text-muted">
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    Waiting for your approval…
                  </span>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs leading-5 text-theme-text-muted">
                  Tailscale is installed. Request a sign-in link to connect this
                  Portal server to the same tailnet as your Windows GPU.
                </p>
                <button
                  type="button"
                  onClick={() => { void connectServerNetwork(false); }}
                  disabled={surfaceLocked}
                  className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-violet-400/40 bg-violet-500/20 px-4 text-xs font-semibold text-violet-50 hover:bg-violet-500/30 disabled:opacity-45"
                >
                  {busyOperation === 'server-connect'
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <ShieldCheck size={14} aria-hidden="true" />}
                  Get a sign-in link
                </button>
              </>
            )}

            <details className="rounded-lg border border-theme-border bg-theme-surface p-3">
              <summary className="cursor-pointer select-none text-[11px] font-medium text-theme-text-muted">
                Advanced: connect with an auth key instead
              </summary>
              <p className="mt-2 text-[11px] leading-5 text-theme-text-subtle">
                Portal sends the auth key once, clears this field immediately,
                and never stores the key.
              </p>
              <label
                htmlFor="tailnet-server-auth-key"
                className="mt-2 block text-[11px] font-medium text-theme-text-muted"
              >
                Tailscale auth key
              </label>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                <input
                  id="tailnet-server-auth-key"
                  ref={authKeyInputRef}
                  type="password"
                  value={authKeyInput}
                  onChange={(event) => setAuthKeyInput(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={256}
                  disabled={surfaceLocked}
                  placeholder="tskey-auth-…"
                  className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-theme-border bg-theme-bg px-3 font-mono text-xs text-theme-text outline-none focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/20 disabled:opacity-45"
                />
                <button
                  type="button"
                  onClick={() => { void connectServerNetwork(true); }}
                  disabled={surfaceLocked || !authKeyInput.trim()}
                  className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-medium text-theme-text hover:bg-theme-surface-hover disabled:opacity-45"
                >
                  {busyOperation === 'server-connect' && (
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  )}
                  Connect
                </button>
              </div>
            </details>
          </div>
        )}
      </article>

      {loading ? (
        <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-theme-text-muted">
          <Loader2 size={18} className="animate-spin text-violet-300" aria-hidden="true" />
          Loading Remote GPU…
        </div>
      ) : status ? (
        <>
          {status.legacyRemoteAuthorityPresent
          && status.legacyHelperRetirement.acknowledgedAt ? (
            <div
              data-testid="remote-gpu-legacy-retirement-complete"
              className="flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-xs leading-5 text-emerald-100"
            >
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p>
                  Legacy helper retirement was recorded on{' '}
                  {formatObservedAt(
                    status.legacyHelperRetirement.acknowledgedAt,
                  )}. Rollback-safe database rows remain retained; the helper
                  task and Windows state are no longer part of this connection.
                </p>
                {status.legacyHelperRetirement.evidence && (
                  <code className="mt-2 block break-all rounded-lg border border-emerald-500/20 bg-black/20 p-2 font-mono text-[10px] text-emerald-50">
                    {status.legacyHelperRetirement.evidence}
                  </code>
                )}
              </div>
            </div>
          ) : status.legacyRemoteAuthorityPresent ? (
            <div
              data-testid="remote-gpu-legacy-transition"
              className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs leading-5 text-amber-100"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                {authorityGrantHealthy
                && status.legacyHelperRetirement.required ? (
                  <>
                    <p>
                      The native Remote GPU is active. You may now retire the
                      exact legacy helper without interrupting this connection.
                      Run the command below from the same extracted local
                      folder. It requests one UAC prompt when needed and never
                      runs cleanup without an Administrator token.
                    </p>
                    <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded-lg border border-amber-500/20 bg-black/20 p-2 font-mono text-[11px] text-amber-50">
                      {status.setup.legacyHelperRetireCommand}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(
                          status.setup.legacyHelperRetireCommand,
                          'Legacy helper retirement command',
                        );
                      }}
                      disabled={surfaceLocked}
                      className="mt-2 inline-flex min-h-[38px] items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 text-xs font-medium text-amber-50 hover:bg-amber-500/20 disabled:opacity-45"
                    >
                      <Copy size={13} aria-hidden="true" />
                      Copy post-activation cleanup
                    </button>
                    <p className="mt-3">
                      After the script reports that exact retirement is
                      complete, record that result here. Portal cannot inspect
                      the Windows filesystem; this stores your Owner
                      acknowledgement and procedure-bound evidence.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        void acknowledgeLegacyHelperRetirement();
                      }}
                      disabled={surfaceLocked}
                      className="mt-2 inline-flex min-h-[38px] items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-50 hover:bg-emerald-500/20 disabled:opacity-45"
                    >
                      {busyOperation === 'ack-legacy-retirement'
                        ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        : <ShieldCheck size={13} aria-hidden="true" />}
                      Record completed cleanup
                    </button>
                  </>
                ) : (
                  <p>
                    Your existing legacy Remote GPU remains the live Ollama
                    authority while you complete native setup, so existing
                    Agent Chat sessions continue to use it. Native model
                    browsing, downloads with live progress, and model switching
                    become available here after Connect succeeds with the exact
                    Grant snapshot current. Do not retire the helper before
                    that handoff.
                  </p>
                )}
              </div>
            </div>
          ) : null}

          {authority && !reconnectOpen ? (
            <article className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Monitor size={18} className="text-violet-300" aria-hidden="true" />
                    <h4 className="text-sm font-semibold text-theme-text">
                      {authority.displayName || 'Connected Windows GPU'}
                    </h4>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-theme-text-subtle">Private route</dt>
                      <dd className="mt-0.5 font-mono text-theme-text">
                        {authority.address}:{authority.servePort}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-theme-text-subtle">Active model</dt>
                      <dd className="mt-0.5 break-all font-mono text-theme-text">
                        {authority.selectedModel || 'None selected'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-theme-text-subtle">Last observed</dt>
                      <dd className="mt-0.5 text-theme-text">
                        {formatObservedAt(authority.observedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-theme-text-subtle">Last verified</dt>
                      <dd className="mt-0.5 text-theme-text">
                        {formatObservedAt(authority.verifiedAt)}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="flex flex-wrap gap-2">
                  {authority.state === 'DISCONNECTED' && (
                    <button
                      type="button"
                      onClick={() => { void reverify(); }}
                      disabled={surfaceLocked}
                      className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 text-xs font-medium text-amber-100 hover:bg-amber-500/20 disabled:opacity-45"
                    >
                      {busyOperation === 'reverify'
                        ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        : <Wifi size={13} aria-hidden="true" />}
                      Reverify connection
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { void verify(); }}
                    disabled={surfaceLocked}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-medium text-theme-text hover:bg-theme-surface-hover disabled:opacity-45"
                  >
                    {busyOperation === 'verify'
                      ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                      : <ShieldCheck size={13} aria-hidden="true" />}
                    Verify identity
                  </button>
                  <button
                    type="button"
                    onClick={() => { void testModel(); }}
                    disabled={surfaceLocked || !authority.selectedModel}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-45"
                  >
                    {busyOperation === 'test'
                      ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                      : <Activity size={13} aria-hidden="true" />}
                    Test model
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const currentPeers = status.tailscale.available
                        ? status.tailscale.inventory.peers
                        : [];
                      const currentPeer = currentPeers.find(
                        (peer) => peer.stableNodeId === authority.stableNodeId,
                      );
                      setSelectedPeerId(currentPeer?.stableNodeId ?? '');
                      setAcknowledgedGrantSnapshot(null);
                      setError(null);
                      setReconnectOpen(true);
                    }}
                    disabled={surfaceLocked}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 text-xs font-medium text-violet-100 hover:bg-violet-500/20 disabled:opacity-45"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Reconnect / change GPU
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoveOpen(true)}
                    disabled={surfaceLocked}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 text-xs font-medium text-red-100 hover:bg-red-500/20 disabled:opacity-45"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    Remove
                  </button>
                </div>
              </div>

              {diagnostics && (
                <div className="mt-4 rounded-xl border border-theme-border bg-theme-bg p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-theme-text">
                    <Gauge size={14} className="text-emerald-300" aria-hidden="true" />
                    Diagnostics · {formatObservedAt(diagnostics.verifiedAt)}
                  </div>
                  {diagnostics.checks?.length ? (
                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                      {diagnostics.checks.map((check) => (
                        <li
                          key={check.id}
                          className="flex items-start gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs"
                        >
                          {check.state === 'pass'
                            ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
                            : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />}
                          <span>
                            <span className="font-medium text-theme-text">{check.label}</span>
                            {check.detail && (
                              <span className="mt-0.5 block text-theme-text-muted">
                                {check.detail}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs leading-5 text-theme-text-muted">
                      Ollama {diagnostics.ollamaVersion || 'responded'}; inventory
                      {diagnostics.inventoryVerified ? ', exact digest' : ''}
                      {diagnostics.modelToolsVerified ? ', native tools' : ''}
                      {diagnostics.inferenceVerified ? ', and bounded inference' : ''} verified.
                    </p>
                  )}
                </div>
              )}
            </article>
          ) : (
            <div className="space-y-3">
              {authority && (
                <article className="flex flex-col gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-violet-100">
                      Reconnect or replace the Remote GPU
                    </h4>
                    <p className="mt-1 max-w-3xl text-xs leading-5 text-theme-text-muted">
                      The current authority remains active until the newly
                      selected peer and exact Grant are independently verified
                      and atomically replace it.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setReconnectOpen(false);
                      setSelectedPeerId('');
                      setAcknowledgedGrantSnapshot(null);
                      setError(null);
                    }}
                    disabled={surfaceLocked}
                    className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-medium text-theme-text hover:bg-theme-surface-hover disabled:opacity-45"
                  >
                    Cancel reconnect
                  </button>
                </article>
              )}
              <article className="rounded-xl border border-theme-border bg-theme-bg p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-xs font-bold text-violet-200">
                    1
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-theme-text">
                      Choose a Windows PC
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                      Portal discovers devices from Tailscale and binds the exact
                      stable node identity. Offline and non-Windows devices cannot
                      be selected.
                    </p>
                    {!status.tailscale.available ? (
                      <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-100">
                        {status.tailscale.error.message}
                      </div>
                    ) : peers.length === 0 ? (
                      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs leading-5 text-amber-100">
                        No Tailnet peers were discovered. Complete the Portal
                        server network step above, sign the Windows GPU into
                        that same tailnet, then select Refresh.
                      </div>
                    ) : (
                      <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
                        <legend className="sr-only">Windows GPU peer</legend>
                        {peers.map((peer, index) => {
                          const windows = /windows/iu.test(
                            peer.operatingSystem || '',
                          );
                          const selectable = windows && peer.online !== false;
                          const selected = peer.stableNodeId === selectedPeerId;
                          const inputId = `ollama-tailnet-peer-${index}`;
                          return (
                            <label
                              key={peer.fingerprint}
                              htmlFor={inputId}
                              className={`flex min-w-0 items-start gap-3 rounded-xl border p-3 transition ${
                                selected
                                  ? 'border-violet-400/50 bg-violet-500/10'
                                  : 'border-theme-border bg-theme-surface'
                              } ${selectable ? 'cursor-pointer hover:border-violet-400/30' : 'cursor-not-allowed opacity-55'}`}
                            >
                              <span className="sr-only">Select Remote GPU peer</span>
                              <input
                                id={inputId}
                                type="radio"
                                name="ollama-tailnet-peer"
                                value={peer.stableNodeId}
                                checked={selected}
                                disabled={!selectable || surfaceLocked}
                                onChange={() => {
                                  setSelectedPeerId(peer.stableNodeId);
                                  setAcknowledgedGrantSnapshot(null);
                                }}
                                className="mt-1 accent-violet-400"
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-semibold text-theme-text">
                                  {peerName(peer)}
                                </span>
                                <span className="mt-1 block text-[11px] text-theme-text-muted">
                                  {peer.operatingSystem || 'Unknown OS'} · {peer.address}
                                </span>
                                <span className={`mt-1 block text-[10px] ${
                                  peer.online === false
                                    ? 'text-red-200'
                                    : windows
                                      ? 'text-emerald-200'
                                      : 'text-amber-100'
                                }`}>
                                  {peer.online === false
                                    ? 'Offline'
                                    : windows
                                      ? 'Ready for setup'
                                      : 'Windows required'}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </fieldset>
                    )}
                  </div>
                </div>
              </article>

              <article className={`rounded-xl border border-theme-border bg-theme-bg p-4 ${selectedPeer ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-xs font-bold text-violet-200">
                    2
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-theme-text">
                      Run the Windows setup as Administrator
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                      Download on the selected PC, extract it to a local folder,
                      and double-click
                      <span className="mx-1 font-mono text-theme-text">Start-Here.cmd</span>
                      . On Windows, Tailscale says Serve commands should run in
                      an Administrator terminal. Approve the one UAC prompt when
                      asked; only that elevated setup performs changes, and no
                      helper or background window remains open.
                    </p>
                    <a
                      href={status.setup.windowsBundle}
                      download
                      aria-disabled={!selectedPeer}
                      onClick={(event) => {
                        if (!selectedPeer) event.preventDefault();
                      }}
                      className={`mt-3 inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-4 text-xs font-semibold text-violet-100 hover:bg-violet-500/20 ${
                        selectedPeer ? '' : 'pointer-events-none'
                      }`}
                    >
                      <Download size={15} aria-hidden="true" />
                      Download Windows setup
                    </a>
                    <details className="mt-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text-muted">
                      <summary className="cursor-pointer select-none font-medium text-theme-text">
                        What the setup changes
                      </summary>
                      <p className="mt-2 leading-5">
                        It exposes only Ollama&apos;s loopback API through
                        Tailscale Serve on private port {status.setup.servePort}.
                        It does not open a public listener.
                      </p>
                      <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded bg-black/25 p-2 font-mono text-[11px] text-violet-100">
                        {status.setup.serveCommand}
                      </code>
                    </details>
                  </div>
                </div>
              </article>

              <article className={`rounded-xl border border-theme-border bg-theme-bg p-4 ${selectedPeer ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-xs font-bold text-violet-200">
                    3
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-theme-text">
                      Allow only this Portal server
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                      {status.setup.grantWarning}
                    </p>
                    <ol className="mt-3 list-decimal space-y-1 pl-5 text-[11px] leading-5 text-theme-text-muted">
                      <li>
                        Open{' '}
                        <a
                          href="https://login.tailscale.com/admin/acls"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-violet-200 underline decoration-violet-400/40 underline-offset-2 hover:text-violet-100"
                        >
                          Tailscale Access Controls
                        </a>.
                      </li>
                      <li>
                        Merge the single entry inside the shown top-level
                        <span className="mx-1 font-mono text-theme-text">grants</span>
                        array into your existing policy&apos;s
                        <span className="mx-1 font-mono text-theme-text">grants</span>
                        array. Never replace your whole policy with this snippet.
                      </li>
                      <li>
                        Save and validate the policy, then review or remove
                        broader overlapping rules that also allow this GPU on
                        tcp:{status.setup.servePort}.
                      </li>
                    </ol>
                    <details className="mt-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
                      <summary className="cursor-pointer select-none text-xs font-medium text-theme-text">
                        Narrow Tailscale Grant template
                      </summary>
                      {selectedPeerGrant ? (
                        <pre
                          data-testid="remote-gpu-grant-template"
                          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-3 font-mono text-[11px] leading-5 text-violet-100"
                        >
                          {selectedPeerGrant}
                        </pre>
                      ) : (
                        <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3 text-[11px] leading-5 text-amber-100">
                          {selectedPeer
                            ? 'Portal could not materialize an exact Portal-to-GPU Grant. Confirm the Portal server is connected to Tailscale, then refresh. Acknowledgement and connection remain disabled.'
                            : 'Choose one Windows PC to generate its exact per-peer Grant.'}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedPeerGrant) {
                            void copyText(selectedPeerGrant, 'Grant template');
                          }
                        }}
                        disabled={!selectedPeerGrant}
                        className="mt-2 inline-flex min-h-[38px] items-center gap-2 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-medium text-theme-text hover:bg-theme-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <Copy size={13} aria-hidden="true" />
                        Copy Grant template
                      </button>
                    </details>
                    <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs leading-5 text-amber-100">
                      <input
                        type="checkbox"
                        checked={grantAcknowledged}
                        disabled={!selectedPeerGrant || surfaceLocked}
                        onChange={(event) => setAcknowledgedGrantSnapshot(
                          event.target.checked ? selectedGrantSnapshot : null,
                        )}
                        className="mt-1 accent-violet-400"
                      />
                      <span>
                        I applied the narrow Tailscale Grant for this Portal
                        server and selected Windows PC, and reviewed broader
                        rules that could also allow tcp:{status.setup.servePort}.
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => { void connectPeer(); }}
                      disabled={!selectedPeerGrant || !grantAcknowledged || surfaceLocked}
                      className="mt-3 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/15 px-4 text-sm font-semibold text-violet-100 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {busyOperation === 'connect'
                        ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        : <Wifi size={15} aria-hidden="true" />}
                      Connect {selectedPeer ? peerName(selectedPeer) : 'Remote GPU'}
                    </button>
                    <p className="mt-2 text-[11px] leading-5 text-theme-text-subtle">
                      Connecting does not require an installed model. You can
                      download and select one after the identity-bound route is active.
                    </p>
                  </div>
                </div>
              </article>
            </div>
          )}

          {cleanupHold ? (
            <article
              data-testid="remote-gpu-cleanup-withheld"
              className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4"
            >
              <h4 className="text-sm font-semibold text-amber-100">
                Serve cleanup withheld
              </h4>
              <p className="mt-1 text-xs leading-5 text-amber-100">
                {cleanupHold.reason === 'same-peer-reconnected'
                  ? 'The same Windows PC has a current Remote GPU authority, so its Serve listener is still required. Portal has hidden the cleanup command to prevent disabling the live route.'
                  : 'Portal has not confirmed the removal outcome. The cleanup command remains hidden until Refresh proves that no current authority on this Windows PC needs the Serve listener.'}
              </p>
            </article>
          ) : authority ? (
            <article
              data-testid="remote-gpu-cleanup-protected"
              className="rounded-xl border border-theme-border bg-theme-bg p-4"
            >
              <h4 className="text-sm font-semibold text-theme-text">
                Scoped listener cleanup
              </h4>
              <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                Cleanup becomes available only after Portal confirms that no
                current Remote GPU authority needs this Serve listener. Use
                Remove above; Portal never exposes the off command while an
                authority is live.
              </p>
            </article>
          ) : (
            <article
              data-testid="remote-gpu-scoped-cleanup"
              className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4"
            >
              <h4 className="text-sm font-semibold text-red-100">
                Scoped listener cleanup
              </h4>
              <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                {cleanupCommand && !authority
                  ? 'The Portal authority is removed. Run this exact command on that Windows PC to finish private-route cleanup. It removes only Portal’s owned Serve listener, not other Tailscale Serve configuration.'
                  : 'Keep this exact command for removal or recovery. It removes only Portal’s owned Serve listener, not other Tailscale Serve configuration.'}
              </p>
              <code className="mt-3 block overflow-x-auto whitespace-nowrap rounded-lg border border-theme-border bg-black/25 p-3 font-mono text-xs text-red-100">
                {cleanupCommand || status.setup.removeCommand}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copyText(
                    cleanupCommand || status.setup.removeCommand,
                    'Cleanup command',
                  );
                }}
                className="mt-3 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 text-xs font-medium text-red-100 hover:bg-red-500/20"
              >
                <Copy size={13} aria-hidden="true" />
                Copy cleanup command
              </button>
            </article>
          )}

          {authority && !modelInventoryReady && (
            <div
              role="alert"
              data-testid="remote-gpu-inventory-stale"
              className="flex flex-col gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-xs leading-5 text-amber-100 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle
                  size={15}
                  className="mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Installed-model inventory is stale or unavailable for the
                  current Remote GPU authority. Old model rows are hidden.
                  {modelInventoryError ? ` ${modelInventoryError}` : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => { void retryModelInventory(); }}
                disabled={surfaceLocked || !authorityGrantHealthy}
                className="inline-flex min-h-[38px] shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-semibold text-amber-50 hover:bg-amber-500/20 disabled:opacity-45"
              >
                {busyOperation === 'inventory-refresh'
                  ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  : <RefreshCw size={13} aria-hidden="true" />}
                Retry inventory
              </button>
            </div>
          )}

          {authority && (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
              <article className="rounded-xl border border-theme-border bg-theme-bg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <HardDrive size={17} className="text-violet-300" aria-hidden="true" />
                      <h4 className="text-sm font-semibold text-theme-text">
                        Installed models
                      </h4>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                      Switch the active model directly. The Remote GPU
                      connection and identity stay unchanged.
                    </p>
                  </div>
                  <span className="rounded-full border border-theme-border px-2 py-1 text-[10px] text-theme-text-muted">
                    {modelInventoryReady
                      ? `${visibleModels.length} installed`
                      : 'Inventory unavailable'}
                  </span>
                </div>
                {!modelInventoryReady ? (
                  <div className="mt-4 rounded-lg border border-dashed border-amber-500/25 p-4 text-center text-xs leading-5 text-amber-100">
                    Installed models stay hidden until Portal refreshes inventory
                    for this exact Remote GPU authority.
                  </div>
                ) : visibleModels.length === 0 ? (
                  <div className="mt-4 rounded-lg border border-dashed border-theme-border p-4 text-center text-xs leading-5 text-theme-text-muted">
                    No models are installed yet. Download one from the curated
                    catalog or enter an exact Ollama tag.
                  </div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {visibleModels.map((model) => {
                      const selected = authority.selectedModel === model.name;
                      const active = selected
                        && (
                          !authority.selectedModelDigest
                          || authority.selectedModelDigest === model.digest
                        );
                      const updatedDigestAvailable = Boolean(
                        selected
                        && authority.selectedModelDigest
                        && model.digest
                        && authority.selectedModelDigest !== model.digest,
                      );
                      const size = modelSize(model);
                      return (
                        <li
                          key={`${model.name}:${model.digest || 'unknown'}`}
                          className={`flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between ${
                            active
                              ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                              : 'border-theme-border bg-theme-surface'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="break-all font-mono text-xs font-semibold text-theme-text">
                                {model.name}
                              </span>
                              {active && (
                                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                                  Active
                                </span>
                              )}
                              {updatedDigestAvailable && (
                                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-100">
                                  Updated digest available
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11px] text-theme-text-subtle">
                              {size !== null ? formatBytes(size) : 'Size unknown'}
                              {model.digest ? ` · ${model.digest.slice(0, 19)}…` : ' · Digest unavailable'}
                            </p>
                          </div>
                          {!active && (
                            <button
                              type="button"
                              onClick={() => { void activateModel(model); }}
                              disabled={
                                surfaceLocked
                                || !modelInventoryReady
                                || !model.digest
                              }
                              className="inline-flex min-h-[38px] shrink-0 items-center justify-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-45"
                            >
                              {busyOperation === 'use-model'
                                ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                                : <Play size={13} aria-hidden="true" />}
                              {updatedDigestAvailable ? 'Use updated digest' : 'Use model'}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </article>

              <article className="rounded-xl border border-theme-border bg-theme-bg p-4">
                <div className="flex items-center gap-2">
                  <Search size={17} className="text-violet-300" aria-hidden="true" />
                  <h4 className="text-sm font-semibold text-theme-text">
                    Browse model catalog
                  </h4>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-theme-text-muted">
                  These are curated starting points.{' '}
                  <a
                    href="https://ollama.com/search"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-violet-200 underline decoration-violet-400/40 underline-offset-2 hover:text-violet-100"
                  >
                    Browse the full Ollama library
                  </a>
                  {' '}and paste any exact model tag in the field below.
                </p>
                <label className="relative mt-3 block">
                  <span className="sr-only">Search curated model catalog</span>
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-3.5 text-theme-text-subtle"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={catalogQuery}
                    onChange={(event) => setCatalogQuery(event.target.value)}
                    placeholder="Search models or use cases"
                    className="min-h-[42px] w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text outline-none focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/20"
                  />
                </label>
                {catalogWarning && (
                  <p className="mt-2 text-[11px] leading-5 text-amber-100">
                    {catalogWarning}
                  </p>
                )}
                <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                  {filteredCatalog.map((model) => {
                    const installed = visibleModels.some(
                      (entry) => entry.name === model.name,
                    );
                    const size = modelSize(model);
                    return (
                      <div
                        key={model.name}
                        className="rounded-xl border border-theme-border bg-theme-surface p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="break-all font-mono text-xs font-semibold text-theme-text">
                                {model.name}
                              </span>
                              {model.useCase && (
                                <span className="rounded-full border border-theme-border px-1.5 py-0.5 text-[9px] uppercase text-theme-text-muted">
                                  {model.useCase}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11px] leading-5 text-theme-text-muted">
                              {model.description}
                            </p>
                            <p className="mt-1 text-[10px] text-theme-text-subtle">
                              {size !== null
                                ? formatBytes(size)
                                : model.size || 'Size varies by tag'}
                              {model.contextWindow ? ` · ${model.contextWindow} context` : ''}
                            </p>
                            {model.sourceUrl && (
                              <a
                                href={model.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex text-[11px] font-medium text-violet-200 underline decoration-violet-400/40 underline-offset-2 hover:text-violet-100"
                              >
                                View on Ollama
                              </a>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => { void startPull(model.name); }}
                            disabled={
                              surfaceLocked
                              || !modelInventoryReady
                              || runningPull
                              || installed
                            }
                            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-violet-500/25 bg-violet-500/10 px-2.5 text-[11px] font-medium text-violet-100 hover:bg-violet-500/20 disabled:opacity-45"
                          >
                            <Download size={12} aria-hidden="true" />
                            {installed ? 'Installed' : 'Download'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {filteredCatalog.length === 0 && (
                    <p className="rounded-lg border border-dashed border-theme-border p-3 text-center text-xs text-theme-text-muted">
                      No curated models match that search.
                    </p>
                  )}
                </div>

                <div className="mt-4 border-t border-theme-border pt-4">
                  <label className="text-xs font-medium text-theme-text">
                    Exact custom Ollama tag
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={customModel}
                        onChange={(event) => setCustomModel(event.target.value)}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="organization/model:tag"
                        className="min-h-[42px] min-w-0 flex-1 rounded-lg border border-theme-border bg-theme-surface px-3 font-mono text-xs text-theme-text outline-none focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/20"
                      />
                      <button
                        type="button"
                        onClick={() => { void startPull(customModel); }}
                        disabled={
                          surfaceLocked
                          || !modelInventoryReady
                          || runningPull
                          || !MODEL_NAME_PATTERN.test(customModel.trim())
                        }
                        className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 text-xs font-semibold text-violet-100 hover:bg-violet-500/20 disabled:opacity-45"
                      >
                        <Download size={13} aria-hidden="true" />
                        Download exact tag
                      </button>
                    </div>
                  </label>
                </div>
              </article>
            </div>
          )}

          {authority && authorityPulls.length > 0 && (
            <article className="rounded-xl border border-theme-border bg-theme-surface p-4">
              <div className="flex items-center gap-2">
                <Download size={17} className="text-violet-300" aria-hidden="true" />
                <h4 className="text-sm font-semibold text-theme-text">
                  Model downloads
                </h4>
              </div>
              <div className="mt-3 space-y-2">
                {authorityPulls.map((pull) => (
                  <PullProgress
                    key={pull.id}
                    pull={pull}
                    locked={surfaceLocked}
                    onCancel={(entry) => { void cancelPull(entry); }}
                    onRetry={(entry) => { void startPull(entry.model); }}
                  />
                ))}
              </div>
            </article>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-xs leading-5 text-theme-text-subtle">
            <ShieldCheck
              size={15}
              className="mt-0.5 shrink-0 text-violet-300"
              aria-hidden="true"
            />
            Portal pins the tailnet, stable node identity, node key, private
            Serve port, authority generation, and exact model digest. It
            reattests the peer&apos;s current address before use. Identity
            changes fail closed and require an explicit Owner action.
          </div>
        </>
      ) : null}

      <TypedConfirmationDialog
        open={removeOpen}
        title="Remove this Remote GPU?"
        description="Portal will revoke this identity-bound Ollama authority. Running the Windows setup later will not reconnect it automatically."
        confirmationPhrase="REMOVE REMOTE GPU"
        confirmLabel="Remove Remote GPU"
        busyLabel="Removing Remote GPU…"
        busy={busyOperation === 'remove'}
        tone="danger"
        details={authority ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] p-3 text-sm text-red-100">
            {authority.displayName || authority.stableNodeId}
            {authority.selectedModel && (
              <span className="mt-1 block font-mono text-xs">
                Active model: {authority.selectedModel}
              </span>
            )}
          </div>
        ) : null}
        onCancel={() => {
          if (busyOperation !== 'remove') setRemoveOpen(false);
        }}
        onConfirm={() => { void confirmRemoval(); }}
      />
    </section>
  );
}
