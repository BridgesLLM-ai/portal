import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import ViewportModal from '../ViewportModal';
import {
  gatewayAPI,
  type AgentChatDiagnosticEvent,
  type AgentChatDiagnosticEventsResponse,
} from '../../api/endpoints';

interface AgentChatDiagnosticsDrawerProps {
  open: boolean;
  onDismiss: () => void;
  session: string;
  provider: string;
  harnessName: string;
}

function isDiagnosticEvent(value: unknown): value is AgentChatDiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentChatDiagnosticEvent>;
  return candidate.schema === 'bridgesllm.agent-chat-diagnostic.v1'
    && typeof candidate.id === 'string'
    && typeof candidate.timestamp === 'string'
    && Number.isFinite(Date.parse(candidate.timestamp))
    && ['info', 'warning', 'error'].includes(String(candidate.severity))
    && ['maintenance', 'lifecycle', 'runtime'].includes(String(candidate.category))
    && typeof candidate.title === 'string'
    && typeof candidate.detail === 'string';
}

export function normalizeAgentChatDiagnosticEvents(
  payload: unknown,
): AgentChatDiagnosticEventsResponse | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = payload as Partial<AgentChatDiagnosticEventsResponse>;
  if (
    typeof candidate.provider !== 'string'
    || typeof candidate.sessionId !== 'string'
    || !Array.isArray(candidate.events)
    || typeof candidate.truncated !== 'boolean'
    || typeof candidate.generatedAt !== 'string'
  ) return null;
  const events = candidate.events.filter(isDiagnosticEvent).slice(0, 200);
  return {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    events,
    truncated: candidate.truncated || candidate.events.length > events.length,
    generatedAt: candidate.generatedAt,
  };
}

function formatDiagnosticTimestamp(timestamp: string): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

const severityPresentation = {
  info: {
    Icon: CheckCircle2,
    iconClass: 'text-cyan-300',
    borderClass: 'border-cyan-400/15',
    backgroundClass: 'bg-cyan-400/[0.045]',
  },
  warning: {
    Icon: ShieldAlert,
    iconClass: 'text-amber-300',
    borderClass: 'border-amber-400/20',
    backgroundClass: 'bg-amber-400/[0.055]',
  },
  error: {
    Icon: XCircle,
    iconClass: 'text-rose-300',
    borderClass: 'border-rose-400/20',
    backgroundClass: 'bg-rose-400/[0.055]',
  },
} as const;

export default function AgentChatDiagnosticsDrawer({
  open,
  onDismiss,
  session,
  provider,
  harnessName,
}: AgentChatDiagnosticsDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<AgentChatDiagnosticEventsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!open || !session) return;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const raw = await gatewayAPI.sessionEvents(session, provider, {
        limit: 200,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      const normalized = normalizeAgentChatDiagnosticEvents(raw);
      if (!normalized) throw new Error('Session events returned an invalid response');
      setSnapshot(normalized);
    } catch {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setError('Session events could not be loaded. Retry the audit view.');
    } finally {
      if (!controller.signal.aborted && generation === requestGenerationRef.current) setLoading(false);
    }
  }, [open, provider, session]);

  useEffect(() => {
    if (!open) {
      requestAbortRef.current?.abort();
      setLoading(false);
      return;
    }
    setSnapshot(null);
    void load();
    return () => requestAbortRef.current?.abort();
  }, [load, open]);

  return (
    <ViewportModal
      open={open}
      onDismiss={onDismiss}
      initialFocusRef={closeRef}
      className="items-stretch justify-end bg-black/60 p-0"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-chat-diagnostics-title"
        className="flex h-full w-full max-w-md flex-col border-l border-white/[0.09] bg-[#0B102A] shadow-2xl shadow-black/50"
      >
        <header className="flex items-start gap-3 border-b border-white/[0.07] px-4 py-4">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/15 bg-cyan-400/[0.07] text-cyan-300">
            <Activity size={18} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="agent-chat-diagnostics-title" className="text-sm font-semibold text-slate-100">
              Session events
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-400">
              {harnessName} maintenance, lifecycle, and runtime audit. Conversation content is excluded.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onDismiss}
            aria-label="Close session events"
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5">
          <div className="min-w-0 text-[11px] uppercase tracking-[0.12em] text-slate-500">
            Newest first · source timestamps
          </div>
          <button
            type="button"
            onClick={() => { void load(); }}
            disabled={loading}
            aria-label="Refresh session events"
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
            Refresh
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          {error ? (
            <div role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3 py-3 text-sm text-rose-100">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => { void load(); }}
                className="mt-3 rounded-lg border border-rose-300/20 bg-rose-300/[0.08] px-3 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-300/[0.13]"
              >
                Retry
              </button>
            </div>
          ) : loading && !snapshot ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Loading session events…
            </div>
          ) : snapshot?.events.length ? (
            <ol className="space-y-2" aria-label="Session event history">
              {snapshot.events.map((event) => {
                const presentation = severityPresentation[event.severity];
                const Icon = presentation.Icon;
                return (
                  <li
                    key={event.id}
                    className={`rounded-xl border px-3 py-3 ${presentation.borderClass} ${presentation.backgroundClass}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon size={15} className={`mt-0.5 shrink-0 ${presentation.iconClass}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                          <h3 className="text-sm font-medium text-slate-100">{event.title}</h3>
                          <time
                            dateTime={event.timestamp}
                            title={event.timestamp}
                            className="shrink-0 text-[10px] tabular-nums text-slate-500"
                          >
                            {formatDiagnosticTimestamp(event.timestamp)}
                          </time>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{event.detail}</p>
                        <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-slate-600">
                          <span>{event.category}</span>
                          <span aria-hidden="true">·</span>
                          <span>{event.presentation}</span>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] px-6 text-center">
              <CheckCircle2 size={20} className="text-emerald-300" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-slate-200">No retained session events</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Routine chat content and tool output are intentionally absent from this audit view.
              </p>
            </div>
          )}

          {snapshot?.truncated ? (
            <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs leading-5 text-slate-500">
              Older events are outside this bounded diagnostic window.
            </p>
          ) : null}
        </div>
      </section>
    </ViewportModal>
  );
}
