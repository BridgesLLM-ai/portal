import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import client from '../api/client';
import { ollamaTailnetHasDefinitiveHttpResponse } from '../api/ollamaTailnet';
import { useAuthStore } from '../contexts/AuthContext';
import { isOwner } from '../utils/authz';
import { Loader2, Power, RotateCw } from 'lucide-react';
import TypedConfirmationDialog from './TypedConfirmationDialog';
import AnchoredPopover from './AnchoredPopover';

type OllamaControlAction = 'unload' | 'restart';

interface ControlCapability {
  ownerOnly: boolean;
  allowed: boolean;
  available: boolean;
  confirmationPhrase: string | null;
}

interface ProxyStatus {
  available: boolean;
  backend: string;
  version: string | null;
  models: Array<{ name: string; size: string; family: string }>;
  runningModels: string[];
  isGpu: boolean;
  authority: {
    kind: 'LOCAL' | 'TAILNET';
    generation: number | null;
    version: number | null;
    bindingFingerprint: string;
    displayName: string | null;
    selectedModel: string | null;
  } | null;
  controls?: {
    unload: ControlCapability;
    restart: ControlCapability;
  };
}

interface OllamaControlProps {
  collapsed?: boolean;
}

// Module-level cache: status survives component remounts (nav switches).
// A single shared polling interval ensures only one request is ever in-flight.
let _cachedStatus: ProxyStatus | null = null;
const _subscribers: Set<(s: ProxyStatus | null) => void> = new Set();
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _statusRequest: Promise<ProxyStatus | null> | null = null;
let _refetchQueued = false;

function canPollOllamaStatus() {
  const { isAuthenticated, user } = useAuthStore.getState();
  return isAuthenticated && isOwner(user);
}

function publishStatus(status: ProxyStatus | null) {
  _cachedStatus = status;
  _subscribers.forEach(fn => fn(_cachedStatus));
}

async function _fetchStatus(): Promise<ProxyStatus | null> {
  if (!canPollOllamaStatus()) {
    publishStatus(null);
    return null;
  }

  if (_statusRequest) return _statusRequest;
  _statusRequest = (async () => {
    try {
      const res = await client.get('/system-control/ollama/proxy-status', { _silent: true } as any);
      if (!canPollOllamaStatus()) {
        publishStatus(null);
        return null;
      }
      const nextStatus = res.data as ProxyStatus;
      publishStatus(nextStatus);
      return nextStatus;
    } catch {
      if (!canPollOllamaStatus()) {
        publishStatus(null);
        return null;
      }
      const offlineStatus: ProxyStatus = {
        available: false,
        backend: 'offline',
        version: null,
        models: [],
        runningModels: [],
        isGpu: false,
        authority: null,
      };
      publishStatus(offlineStatus);
      return offlineStatus;
    } finally {
      _statusRequest = null;
    }
  })();
  return _statusRequest;
}

function subscribeOllamaStatus(fn: (s: ProxyStatus | null) => void): () => void {
  _subscribers.add(fn);

  if (!canPollOllamaStatus()) {
    fn(null);
  } else if (_cachedStatus !== null) {
    fn(_cachedStatus);
  }

  if (canPollOllamaStatus() && !_intervalId) {
    void _fetchStatus();
    _intervalId = setInterval(() => { void _fetchStatus(); }, 15000);
  }

  return () => {
    _subscribers.delete(fn);
    if (_subscribers.size === 0 && _intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  };
}

export function __resetOllamaControlStateForTests(): void {
  _cachedStatus = null;
  _subscribers.clear();
  if (_intervalId) clearInterval(_intervalId);
  _intervalId = null;
  _statusRequest = null;
  _refetchQueued = false;
}

export function invalidateOllamaControlStatus(): void {
  if (!canPollOllamaStatus()) {
    publishStatus(null);
    return;
  }
  if (_statusRequest) {
    if (_refetchQueued) return;
    _refetchQueued = true;
    void _statusRequest.finally(() => {
      _refetchQueued = false;
      if (canPollOllamaStatus()) void _fetchStatus();
    });
    return;
  }
  void _fetchStatus();
}

function actionErrorMessage(error: any, fallback: string): string {
  const candidate = error?.response?.data?.error || error?.response?.data?.message || error?.message;
  const message = typeof candidate === 'string' ? candidate.replace(/\s+/g, ' ').trim() : '';
  if (!message
    || message.length > 280
    || /(?:traceback|authenticationerror|openrouterexception|litellm|auth cookie|access[_ -]?token|authorization\s*=|cookie\s*=)/i.test(message)
    || /^(?:\{|\[)/.test(message)) {
    return fallback;
  }
  return message;
}

const OllamaControl: React.FC<OllamaControlProps> = ({ collapsed = false }) => {
  const [status, setStatus] = useState<ProxyStatus | null>(() => (
    canPollOllamaStatus() ? _cachedStatus : null
  ));
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<OllamaControlAction | null>(null);
  const [actionInFlight, setActionInFlight] = useState<OllamaControlAction | null>(null);
  const [actionResult, setActionResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const actionLockRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const panelId = useId();
  const { isAuthenticated, user } = useAuthStore();
  const owner = isOwner(user);

  const fetchStatus = useCallback(async () => _fetchStatus(), []);

  useEffect(() => {
    if (!isAuthenticated || !owner) {
      setExpanded(false);
      setStatus(null);
      return;
    }

    return subscribeOllamaStatus(setStatus);
  }, [isAuthenticated, owner]);

  useEffect(() => {
    if (!isAuthenticated || !owner) return undefined;
    const refresh = () => invalidateOllamaControlStatus();
    window.addEventListener('bridgesllm:ollama-runtime-changed', refresh);
    return () => {
      window.removeEventListener('bridgesllm:ollama-runtime-changed', refresh);
    };
  }, [isAuthenticated, owner]);

  useEffect(() => {
    if (!expanded || !panelElement) return undefined;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, panelElement]);

  const closePanel = useCallback(() => {
    setExpanded(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const runControlAction = useCallback(async (confirmation: string) => {
    if (!pendingAction || actionLockRef.current) return;
    const action = pendingAction;
    actionLockRef.current = true;
    setActionInFlight(action);
    setActionResult(null);
    try {
      const endpoint = action === 'unload'
        ? '/system-control/ollama/kill'
        : '/system-control/ollama/restart';
      const response = await client.post(
        endpoint,
        { confirmation },
        { _skipNetworkRetry: true } as any,
      );
      const refreshedStatus = await fetchStatus();
      const actionVerified = action === 'unload'
        ? refreshedStatus?.runningModels.length === 0
        : response.data?.success === true
          && response.data?.verified === true
          && response.data?.active === true;
      const restartUnverified = action === 'restart' && !actionVerified;
      setActionResult({
        tone: restartUnverified ? 'error' : 'success',
        text: `${String(response.data?.message || (action === 'unload'
          ? 'Ollama models unloaded.'
          : 'Local Ollama service restarted.'))}${actionVerified ? '' : action === 'unload'
            ? ' The status panel is still refreshing.'
            : ' The local restart response could not be verified.'}`,
      });
    } catch (error) {
      if (!ollamaTailnetHasDefinitiveHttpResponse(error)) {
        if (action === 'unload') {
          await fetchStatus().catch(() => null);
          setActionResult({
            tone: 'error',
            text: 'The unload response was interrupted. The models may already be idle, but Portal will not replay the request automatically; refresh and retry manually only if needed.',
          });
        } else {
          await fetchStatus().catch(() => null);
          setActionResult({
            tone: 'error',
            text: 'The local restart response was interrupted. The service may have restarted, but Portal will not replay the request automatically; retry manually only if needed.',
          });
        }
        return;
      }
      setActionResult({
        tone: 'error',
        text: actionErrorMessage(
          error,
          action === 'unload'
            ? 'Portal could not unload the running Ollama models.'
            : 'Portal could not restart the local Ollama service.',
        ),
      });
    } finally {
      setPendingAction(null);
      setActionInFlight(null);
      actionLockRef.current = false;
    }
  }, [fetchStatus, pendingAction]);

  if (!status) return null;

  const backendLabel = status.isGpu ? 'GPU' : status.available ? 'CPU' : 'Off';
  const backendDetail = status.isGpu ? 'Remote GPU' : status.available ? 'Local CPU' : 'Unavailable';
  const dotColor = status.isGpu ? 'bg-emerald-400' : status.available ? 'bg-amber-400' : 'bg-gray-500';
  const textColor = status.isGpu ? 'text-emerald-400' : status.available ? 'text-amber-400' : 'text-gray-500';
  const unloadControl = status.controls?.unload;
  const restartControl = status.controls?.restart;
  const unloadConfirmation = unloadControl?.confirmationPhrase || 'UNLOAD OLLAMA MODELS';
  const restartConfirmation = restartControl?.confirmationPhrase || 'RESTART OLLAMA';
  const unloadAvailable = unloadControl?.available
    ?? (status.available && status.runningModels.length > 0);
  const restartAvailable = (
    (restartControl?.available ?? false)
    && status.authority?.kind !== 'TAILNET'
    && !status.isGpu
  );

  return (
    <div className="relative">
      {/* Sidebar button */}
      <button
        ref={triggerRef}
        onClick={() => setExpanded((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setExpanded(true);
          }
        }}
        type="button"
        aria-label={`Ollama: ${backendDetail}`}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 w-full
          ${expanded
            ? 'border border-theme-border bg-theme-surface-hover text-theme-text'
            : 'border border-transparent text-theme-text-muted hover:bg-theme-surface-hover hover:text-theme-text'
          }`}
        title={`Ollama: ${backendDetail}`}
      >
        <div className="relative flex-shrink-0">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
          <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${dotColor} ${status.runningModels.length > 0 ? 'animate-pulse' : ''}`} />
        </div>
        {!collapsed && (
          <div className="flex items-center justify-between flex-1 min-w-0">
            <span>Ollama</span>
            <span className={`text-[10px] font-semibold ${textColor}`}>{backendLabel}</span>
          </div>
        )}
      </button>

      {/* Expanded panel (popover) */}
      <AnchoredPopover
        open={expanded}
        anchorRef={triggerRef}
        onDismiss={closePanel}
        width={collapsed ? 280 : 304}
        align="start"
        preferredMinimumHeight={320}
        mobileBreakpoint={639}
        ariaLabel="Ollama runtime controls"
      >
        <div
          ref={setPanelElement}
          id={panelId}
          role="dialog"
          aria-label="Ollama runtime controls"
          className="max-h-full min-w-0 overflow-y-auto overscroll-contain rounded-xl border border-theme-border bg-theme-surface p-4 text-theme-text shadow-2xl backdrop-blur-sm"
        >
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">{status.isGpu ? '⚡' : status.available ? '🔄' : '⚫'}</span>
              <div>
                <h3 className="text-sm font-semibold text-theme-text">Ollama {status.isGpu ? 'GPU' : status.available ? 'CPU' : 'offline'}</h3>
                <p className="text-[10px] text-theme-text-muted">{backendDetail}{status.version ? ` • v${status.version}` : ''}</p>
              </div>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closePanel}
              className="min-h-[44px] min-w-[44px] rounded-lg text-lg leading-none text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text"
              aria-label="Close Ollama controls"
            >×</button>
          </div>

          {/* Backend indicator */}
          <div className={`rounded-lg px-3 py-2 mb-3 ${status.isGpu ? 'bg-emerald-500/10 border border-emerald-500/20' : status.available ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-gray-500/10 border border-gray-500/20'}`}>
            <div className="flex items-center justify-between">
              <span className={`text-xs font-medium ${status.isGpu ? 'text-emerald-400' : status.available ? 'text-amber-400' : 'text-gray-400'}`}>
                {status.isGpu ? '🖥️ Remote GPU Active' : status.available ? '💻 Local CPU Selected' : '🔌 Disconnected'}
              </span>
              <span className={`text-[10px] ${status.isGpu ? 'text-emerald-500' : status.available ? 'text-amber-500' : 'text-gray-500'}`}>
                {status.backend}
              </span>
            </div>
          </div>

          {status.isGpu && status.authority && (
            <dl className="mb-3 grid gap-2 rounded-lg border border-theme-border bg-theme-bg p-3 text-xs">
              <div className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-theme-text-subtle">
                  Remote GPU
                </dt>
                <dd className="mt-0.5 truncate font-medium text-theme-text">
                  {status.authority.displayName || 'Remote GPU'}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-theme-text-subtle">
                  Active model
                </dt>
                <dd className="mt-0.5 truncate font-mono text-violet-200">
                  {status.authority.selectedModel || 'No model selected'}
                </dd>
              </div>
            </dl>
          )}

          {owner && (
            <a
              href={status.isGpu
                ? '/settings?tab=ai-providers&ollama=tailnet#ollama-tailnet-setup'
                : '/settings?tab=ai-providers#ollama-tailnet-setup'}
              className="mb-3 inline-flex min-h-[40px] w-full items-center justify-center rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 text-xs font-semibold text-violet-100 transition hover:bg-violet-500/20"
            >
              Manage {status.isGpu ? 'Remote GPU' : 'Ollama models'}
            </a>
          )}

          {/* Running models */}
          {status.runningModels.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-theme-text-subtle">Running</div>
              {status.runningModels.map((model, idx) => (
                <div key={idx} className="text-xs text-blue-300 flex items-center gap-1.5 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <span className="truncate">{model}</span>
                </div>
              ))}
            </div>
          )}

          {/* Available models */}
          {status.models.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-theme-text-subtle">Available Models</div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {status.models.map((model, idx) => (
                  <div key={idx} className="flex items-center justify-between text-[11px] py-0.5">
                    <span className="truncate text-theme-text">{model.name}</span>
                    <span className="ml-2 flex-shrink-0 text-theme-text-subtle">{model.size}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!status.available && (
            <p className="py-2 text-center text-xs text-theme-text-muted">
              No Ollama backend available.<br />
              <span className="text-[10px]">Restart the local service or reconnect the remote backend.</span>
            </p>
          )}

          {/* Model unload / local service restart controls */}
          {owner && (
            <div className="mt-3 border-t border-theme-border pt-3">
              <p className="mb-2 text-[10px] leading-4 text-theme-text-muted">
                {status.isGpu
                  ? 'Unload releases Remote GPU model memory. Local CPU restart is unavailable while the Remote GPU is authoritative.'
                  : 'Unload releases model memory. Restart recovers only the installer-managed local CPU Ollama service, including while it is offline.'}
              </p>
              <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setActionResult(null); setPendingAction('unload'); }}
                disabled={!unloadAvailable || Boolean(actionInFlight)}
                className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                title={unloadAvailable ? 'Unload every running Ollama model from memory' : 'No Ollama models are running'}
              >
                {actionInFlight === 'unload' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                Unload
              </button>
              <button
                type="button"
                onClick={() => { setActionResult(null); setPendingAction('restart'); }}
                disabled={!restartAvailable || Boolean(actionInFlight)}
                className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-500/15 px-3 py-1.5 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                title={restartAvailable
                  ? 'Restart the local CPU Ollama system service'
                  : 'Local CPU restart is unavailable while Remote GPU is authoritative'}
              >
                {actionInFlight === 'restart' ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
                Restart local
              </button>
              </div>
            </div>
          )}

          {actionResult && (
            <div
              className={`mt-2 rounded-lg border px-2.5 py-2 text-xs ${actionResult.tone === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-red-500/20 bg-red-500/10 text-red-200'}`}
              role={actionResult.tone === 'error' ? 'alert' : 'status'}
            >
              {actionResult.text}
            </div>
          )}
        </div>
      </AnchoredPopover>

      <TypedConfirmationDialog
        open={pendingAction === 'unload'}
        title="Unload all Ollama models?"
        description="This stops every active Ollama runner and releases its model memory. In-progress Ollama responses may be interrupted."
        confirmationPhrase={unloadConfirmation}
        confirmLabel="Unload models"
        tone="danger"
        busy={actionInFlight === 'unload'}
        onCancel={() => { if (!actionInFlight) setPendingAction(null); }}
        onConfirm={(confirmation) => { void runControlAction(confirmation); }}
      />
      <TypedConfirmationDialog
        open={pendingAction === 'restart'}
        title="Restart local Ollama?"
        description="This restarts only the installer-managed local CPU Ollama service. Active local model requests will be interrupted while it recovers."
        confirmationPhrase={restartConfirmation}
        confirmLabel="Restart Ollama"
        tone="danger"
        busy={actionInFlight === 'restart'}
        onCancel={() => { if (!actionInFlight) setPendingAction(null); }}
        onConfirm={(confirmation) => { void runControlAction(confirmation); }}
      />
    </div>
  );
};

export default OllamaControl;
