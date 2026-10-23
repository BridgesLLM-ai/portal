import { useEffect, type ReactNode } from 'react';
import { ArrowUpRight, Ban, CheckCircle2, Circle, Hourglass, Loader2, Square, X, XCircle } from 'lucide-react';
import type { StopOutcome, WorkSessionRow } from './agentWorkApi';
import { canStopRow, isNavigableSessionKey, relativeTime, runStatusView, sessionDisplayLabel, type RunTone } from './agentWorkModel';
import { isStopOutcome, type SessionStopsState } from './useSessionStops';
import { displayText } from '../toolCards/safeDisplay';

const BUTTON = 'inline-flex min-h-[30px] items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 disabled:cursor-not-allowed disabled:opacity-50';
export const NEUTRAL = `${BUTTON} border-white/10 text-slate-200 hover:bg-white/[0.06]`;
export const PRIMARY = `${BUTTON} border-sky-400/30 bg-sky-400/15 text-sky-100 hover:bg-sky-400/25`;
export const DANGER = `${BUTTON} border-rose-400/25 text-rose-200 hover:bg-rose-500/10`;

const TONE_CLASS: Record<RunTone, string> = {
  running: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
  waiting: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  failed: 'border-rose-400/25 bg-rose-500/10 text-rose-200',
  stopped: 'border-white/10 bg-white/[0.04] text-slate-300',
  done: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  idle: 'border-white/10 bg-white/[0.03] text-slate-400',
  unknown: 'border-white/10 bg-white/[0.03] text-slate-300',
};

function ToneIcon({ tone }: { tone: RunTone }) {
  const props = { size: 11, 'aria-hidden': true as const, className: 'shrink-0' };
  if (tone === 'running') return <Loader2 {...props} className="shrink-0 motion-safe:animate-spin" />;
  if (tone === 'waiting') return <Hourglass {...props} />;
  if (tone === 'failed') return <XCircle {...props} />;
  if (tone === 'stopped') return <Ban {...props} />;
  if (tone === 'done') return <CheckCircle2 {...props} />;
  return <Circle {...props} />;
}

/** Upstream run status with text, icon and colour; colour is never the only signal. */
export function RunStatusChip({ status }: { status: string | null }) {
  const view = runStatusView(status);
  return (
    <span data-run-tone={view.tone} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASS[view.tone]}`}>
      <ToneIcon tone={view.tone} />
      {view.label}
    </span>
  );
}

export function WorkSectionHeading({ id, title, aside }: { id: string; title: string; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h4 id={id} className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {aside ? <div className="min-w-0 truncate text-[11px] text-slate-500">{aside}</div> : null}
    </div>
  );
}

const ROW_ACTION = 'flex min-h-[28px] shrink-0 items-center gap-1 rounded-md px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2';

export function SessionRunRow({ row, now, onOpen, openLabel = 'Open', stops }: {
  row: WorkSessionRow;
  now: number;
  onOpen?: (key: string) => void;
  openLabel?: string;
  /** Lists that may stop work pass this; automation runs stay read-only. */
  stops?: SessionStopsState;
}) {
  const label = sessionDisplayLabel(row);
  const tone = runStatusView(row.status).tone;
  const updated = relativeTime(row.updatedAt, now);
  const activity = row.activityText ? displayText(row.activityText, 240) : '';
  const error = (tone === 'failed' || tone === 'stopped') && row.lastRunError ? displayText(row.lastRunError, 300) : '';
  const role = row.subagentRole === 'orchestrator' ? 'Coordinator' : row.subagentRole === 'leaf' ? 'Worker' : null;
  const stoppable = Boolean(stops) && canStopRow(row);
  const phase = stops?.phaseOf(row.key) ?? null;
  // A confirmation belongs to the work the user saw; it never carries over to later work.
  useEffect(() => {
    if (!stoppable && phase === 'confirm') stops?.cancel(row.key);
  }, [phase, row.key, stoppable, stops]);
  // No second stop while a confirmed one settles, or after the server reported acting elsewhere.
  const canAsk = stoppable && (phase === null || !['confirm', 'stopping', 'stopped', 'elsewhere'].includes(phase));
  const subject = row.kind === 'subagent' ? 'sub-agent' : 'conversation';
  return (
    <li data-session-key={row.key} className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-slate-200" title={label}>{label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            <RunStatusChip status={row.status} />
            {role && <span>{role}</span>}
            {updated && <span>{updated}</span>}
          </div>
          {activity && <p className="mt-1 line-clamp-2 break-words text-[11px] text-slate-400">{activity}</p>}
          {error && <p className="mt-1 line-clamp-3 break-words text-[11px] text-rose-200/90">{error}</p>}
        </div>
        {stoppable && phase === 'stopping' && (
          <span role="status" className={`${ROW_ACTION} text-slate-400`}>
            <Loader2 size={12} aria-hidden="true" className="motion-safe:animate-spin" />
            Stopping…
          </span>
        )}
        {canAsk && (
          <button
            type="button"
            onClick={() => stops!.ask(row.key, label)}
            aria-label={`Stop ${label}`}
            className={`${ROW_ACTION} text-rose-200 hover:bg-rose-500/10 focus-visible:ring-rose-400/70`}
          >
            <Square size={10} aria-hidden="true" />
            Stop
          </button>
        )}
        {onOpen && isNavigableSessionKey(row.key) && (
          <button
            type="button"
            onClick={() => onOpen(row.key)}
            aria-label={`${openLabel} ${label}`}
            className={`${ROW_ACTION} text-sky-300 hover:bg-sky-400/10 focus-visible:ring-sky-400/70`}
          >
            {openLabel}
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {stoppable && phase === 'confirm' && (
        <div role="group" aria-label={`Confirm stopping ${label}`} className="mt-2 rounded-md border border-rose-400/20 bg-rose-500/[0.06] p-2">
          <p className="text-[11px] text-rose-100">
            {row.status === 'queued'
              ? `Stop this ${subject} before it starts? Its history is kept.`
              : `Stop what this ${subject} is doing now? Its history is kept.`}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => stops!.confirm(row.key)} className={DANGER}>
              <Square size={10} aria-hidden="true" />
              Stop now
            </button>
            {/* The safe choice takes focus, so the keyboard does not lose its place. */}
            <button type="button" autoFocus onClick={() => stops!.cancel(row.key)} className={NEUTRAL}>Keep running</button>
          </div>
        </div>
      )}
    </li>
  );
}

const NOTICE_TONE = {
  success: 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-100',
  warning: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-100',
  error: 'border-rose-400/25 bg-rose-500/[0.08] text-rose-100',
} as const;

const STOP_NOTICE: Record<StopOutcome, { tone: keyof typeof NOTICE_TONE; text(label: string): string }> = {
  stopped: { tone: 'success', text: (label) => `Stopped “${label}”.` },
  'not-confirmed': {
    tone: 'warning',
    text: (label) => `Stop wasn’t confirmed for “${label}”. It may have already finished, or it may still be running.`,
  },
  denied: { tone: 'error', text: (label) => `You don’t have permission to stop “${label}”.` },
  elsewhere: {
    tone: 'error',
    text: (label) => `The server reported stopping a different conversation, not “${label}”. Check your running conversations.`,
  },
  unknown: { tone: 'error', text: (label) => `Couldn’t confirm the stop for “${label}”. Check its status before trying again.` },
  unavailable: { tone: 'warning', text: (label) => `“${label}” can’t be stopped from here. Open it to stop it.` },
};

/** Results of recent stops; kept outside the scrolling lists so they stay in view. */
export function StopNotices({ stops }: { stops: SessionStopsState }) {
  const notices = stops.entries.filter((entry) => isStopOutcome(entry.phase)).slice(0, 2);
  if (!notices.length) return null;
  return (
    <div className="shrink-0 space-y-1.5 border-t border-white/5 px-4 py-2">
      {notices.map((entry) => {
        const notice = STOP_NOTICE[entry.phase as StopOutcome];
        return (
          <div key={entry.key} role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${NOTICE_TONE[notice.tone]}`}>
            <p className="min-w-0 flex-1 break-words">{notice.text(entry.label)}</p>
            <button type="button" onClick={() => stops.dismiss(entry.key)} aria-label="Dismiss"
              className="-m-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-80 hover:bg-white/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70">
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
