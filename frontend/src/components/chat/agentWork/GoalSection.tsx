import { useEffect, useId, useState, type FormEvent } from 'react';
import { AlertOctagon, CheckCircle2, ChevronDown, ChevronRight, CornerLeftUp, Loader2, Pause, Pencil, Play, Target, Trash2, type LucideIcon } from 'lucide-react';
import type { SessionWork } from './agentWorkApi';
import { canStartGoal, formatTokens, goalActionStates, goalStatusView, relativeTime, type GoalTone } from './agentWorkModel';
import { goalActionName, type GoalControlsState, type GoalNotice } from './useGoalControls';
import type { GoalOperationAction } from './goalOperationStore';
import { DANGER, NEUTRAL, PRIMARY, WorkSectionHeading } from './AgentWorkParts';
import { displayBlock, displayText, redactSecrets } from '../toolCards/safeDisplay';

const OBJECTIVE_MAX = 16_000;
const NOTE_MAX = 2_000;

type Mode =
  | { kind: 'view' }
  | { kind: 'edit'; draft: string; hidden: boolean; submitted: boolean }
  | { kind: 'note'; action: 'block' | 'complete'; note: string; submitted: boolean }
  | { kind: 'confirm-clear' }
  | { kind: 'start'; draft: string; submitted: boolean };

const GOAL_BOX: Record<GoalTone, string> = {
  active: 'border-emerald-400/20 bg-emerald-400/[0.05]',
  paused: 'border-white/10 bg-white/[0.03]',
  attention: 'border-amber-400/25 bg-amber-400/[0.06]',
  complete: 'border-emerald-400/20 bg-emerald-400/[0.04]',
  unknown: 'border-white/10 bg-white/[0.03]',
};
const GOAL_LABEL: Record<GoalTone, string> = {
  active: 'text-emerald-300',
  paused: 'text-slate-300',
  attention: 'text-amber-200',
  complete: 'text-emerald-300',
  unknown: 'text-slate-300',
};

export function GoalToneIcon({ tone, size = 14 }: { tone: GoalTone; size?: number }) {
  const className = `mt-0.5 shrink-0 ${GOAL_LABEL[tone]}`;
  if (tone === 'paused') return <Pause size={size} aria-hidden="true" className={className} />;
  if (tone === 'attention') return <AlertOctagon size={size} aria-hidden="true" className={className} />;
  if (tone === 'complete') return <CheckCircle2 size={size} aria-hidden="true" className={className} />;
  return <Target size={size} aria-hidden="true" className={className} />;
}

const FIELD = 'w-full resize-y rounded-lg border border-white/10 bg-black/20 p-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400/40 focus:outline-none focus:ring-2 focus:ring-sky-400/30';

const PENDING_LABEL: Record<GoalOperationAction, string> = {
  start: 'Starting…', edit: 'Saving…', pause: 'Pausing…', resume: 'Resuming…', block: 'Saving…', complete: 'Saving…', clear: 'Clearing…',
};

function noteSubmitLabel(action: 'block' | 'complete', sending: GoalOperationAction | null): string {
  if (sending === action) return PENDING_LABEL[action];
  return action === 'block' ? 'Mark blocked' : 'Mark complete';
}

function ActionButton({ action, label, icon: Icon, state, sending, onClick, tone = 'neutral' }: {
  action: GoalOperationAction;
  label: string;
  icon: LucideIcon;
  state: { disabledReason: string | null };
  sending: GoalOperationAction | null;
  onClick(): void;
  tone?: 'neutral' | 'danger';
}) {
  const busy = sending === action;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={Boolean(state.disabledReason) || sending !== null}
      title={state.disabledReason || undefined}
      className={tone === 'danger' ? DANGER : NEUTRAL}
    >
      {busy ? <Loader2 size={12} aria-hidden="true" className="motion-safe:animate-spin" /> : <Icon size={12} aria-hidden="true" />}
      {busy ? PENDING_LABEL[action] : label}
    </button>
  );
}

export function GoalNoticeView({ notice, busy, onCheck, onDismiss }: {
  notice: GoalNotice;
  busy: boolean;
  onCheck(): void;
  onDismiss(): void;
}) {
  const color = notice.tone === 'success'
    ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-100'
    : notice.tone === 'warning'
      ? 'border-amber-400/25 bg-amber-400/[0.07] text-amber-100'
      : 'border-rose-400/25 bg-rose-500/[0.08] text-rose-100';
  return (
    <div role={notice.tone === 'success' ? 'status' : 'alert'} className={`mt-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${color}`}>
      <p>{notice.message}</p>
      {(notice.canCheck || notice.canDismiss || notice.canReview) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {notice.canCheck && <button type="button" disabled={busy} onClick={onCheck} className={NEUTRAL}>{busy ? 'Checking…' : 'Check outcome'}</button>}
          {notice.canReview && <button type="button" disabled={busy} onClick={onDismiss} className={NEUTRAL}>Review current goal</button>}
          {notice.canDismiss && <button type="button" disabled={busy} onClick={onDismiss} className={NEUTRAL}>Dismiss</button>}
        </div>
      )}
      {notice.detail && (
        <details className="mt-1.5 opacity-80">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 break-words">{displayText(notice.detail, 200)}</p>
        </details>
      )}
    </div>
  );
}

export function GoalSection({ work, controls, isChild, busy, now, onOpenParent }: {
  work: SessionWork;
  controls: GoalControlsState;
  isChild: boolean;
  busy: boolean;
  now: number;
  onOpenParent?: () => void;
}) {
  const headingId = useId();
  const fieldId = useId();
  const goal = work.goal;
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [expanded, setExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // A different goal or conversation never inherits an open editor.
  useEffect(() => {
    setMode({ kind: 'view' });
    setExpanded(false);
    setMoreOpen(false);
  }, [work.sessionKey, goal?.id]);
  // Forms stay open until the change is confirmed, so a refused edit keeps its text.
  const { sending, notice } = controls;
  useEffect(() => {
    if (sending !== null || !notice) return;
    setMode((current) => {
      if (!('submitted' in current) || !current.submitted) return current;
      return notice.tone === 'success' ? { kind: 'view' } : { ...current, submitted: false };
    });
  }, [sending, notice]);

  const operationBlocked = Boolean(controls.saved) || sending !== null;
  const context = { supported: work.caps.goals, isChild, busy, operationBlocked };
  const noticeView = notice ? (
    <GoalNoticeView notice={notice} busy={sending !== null} onCheck={controls.checkOutcome} onDismiss={controls.dismiss} />
  ) : null;
  const sendingStatus = sending ? <p role="status" className="sr-only">{`${goalActionName(sending)}…`}</p> : null;

  if (!goal) {
    const start = canStartGoal(work, context);
    const submitStart = (event: FormEvent) => {
      event.preventDefault();
      if (mode.kind !== 'start' || !mode.draft.trim() || start.disabledReason) return;
      if (controls.run({ action: 'start', goalId: null, objective: mode.draft })) setMode({ ...mode, submitted: true });
    };
    return (
      <section aria-labelledby={headingId} className="border-b border-white/5 px-4 py-3">
        <WorkSectionHeading id={headingId} title="Goal" />
        {!work.caps.goals ? (
          <p className="text-xs text-slate-400">Goals aren’t available for this conversation right now.</p>
        ) : isChild ? (
          <p className="text-xs text-slate-400">Goals can’t be started from a sub-agent conversation here.</p>
        ) : mode.kind === 'start' ? (
          <form onSubmit={submitStart} className="space-y-2">
            <label htmlFor={fieldId} className="block text-[11px] text-slate-400">What should the agent achieve?</label>
            <textarea
              id={fieldId}
              value={mode.draft}
              maxLength={OBJECTIVE_MAX}
              rows={3}
              autoFocus
              disabled={mode.submitted}
              onChange={(event) => setMode({ ...mode, draft: event.target.value })}
              className={FIELD}
            />
            <p className="text-[11px] text-slate-500">The agent starts working on it right away and keeps it in view until it is done.</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="submit" disabled={!mode.draft.trim() || Boolean(start.disabledReason) || sending !== null} title={start.disabledReason || undefined} className={PRIMARY}>
                {sending === 'start' ? <Loader2 size={12} aria-hidden="true" className="motion-safe:animate-spin" /> : <Target size={12} aria-hidden="true" />}
                {sending === 'start' ? PENDING_LABEL.start : 'Start goal'}
              </button>
              <button type="button" disabled={sending !== null} onClick={() => setMode({ kind: 'view' })} className={NEUTRAL}>Cancel</button>
            </div>
            {start.disabledReason && <p className="text-[11px] text-slate-500">{start.disabledReason}</p>}
          </form>
        ) : start.visible ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-400">No goal yet. Give the agent one objective to keep working toward.</p>
            <button type="button" disabled={operationBlocked} onClick={() => setMode({ kind: 'start', draft: '', submitted: false })} className={NEUTRAL}>
              <Target size={12} aria-hidden="true" />
              Set a goal
            </button>
            {start.disabledReason && <p className="w-full text-[11px] text-slate-500">{start.disabledReason}</p>}
          </div>
        ) : (
          <p className="text-xs text-slate-400">No goal for this conversation.</p>
        )}
        {sendingStatus}
        {noticeView}
      </section>
    );
  }

  const view = goalStatusView(goal.status);
  const actions = goalActionStates(goal, context);
  const objective = displayBlock(goal.objective, expanded ? OBJECTIVE_MAX : 600, expanded ? 400 : 8);
  const note = goal.status !== 'active' && goal.lastStatusNote ? displayText(goal.lastStatusNote, 400) : '';
  const tokens = formatTokens(goal.tokensUsed);
  const budget = formatTokens(goal.tokenBudget);
  const updated = relativeTime(goal.updatedAt, now);
  const meta = [
    tokens ? (budget ? `${tokens} of ${budget} tokens` : `${tokens} tokens`) : null,
    updated ? `Updated ${updated}` : null,
  ].filter(Boolean).join(' · ');
  const resumable = ['paused', 'blocked', 'usage_limited', 'budget_limited'].includes(goal.status);
  const secondary = actions.block.visible || actions.complete.visible || actions.clear.visible;
  const primaryHint = [actions.resume, actions.pause, actions.edit].find((state) => state.visible && state.disabledReason)?.disabledReason;

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    if (mode.kind !== 'edit' || !mode.draft.trim()) return;
    if (controls.run({ action: 'edit', goalId: goal.id, objective: mode.draft })) setMode({ ...mode, submitted: true });
  };
  const submitNote = (event: FormEvent) => {
    event.preventDefault();
    if (mode.kind !== 'note') return;
    const trimmed = mode.note.trim();
    if (controls.run({ action: mode.action, goalId: goal.id, ...(trimmed ? { note: trimmed } : {}) })) setMode({ ...mode, submitted: true });
  };
  const startEdit = () => {
    // Secret-shaped text is never put back on screen, even in the editor.
    const masked = redactSecrets(goal.objective);
    setMode({ kind: 'edit', draft: masked, hidden: masked !== goal.objective, submitted: false });
  };

  return (
    <section aria-labelledby={headingId} className="border-b border-white/5 px-4 py-3">
      <WorkSectionHeading id={headingId} title="Goal" aside={meta || undefined} />
      <div className={`rounded-xl border p-3 ${GOAL_BOX[view.tone]}`}>
        <div className="flex items-start gap-2">
          <GoalToneIcon tone={view.tone} />
          <div className="min-w-0 flex-1">
            <p className={`text-[11px] font-semibold ${GOAL_LABEL[view.tone]}`} title={view.description}>{view.label}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-100">{objective.text || 'No objective text.'}</p>
            {(objective.truncated || expanded) && (
              <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-[11px] text-sky-300 hover:text-sky-200">
                {expanded ? 'Show less' : 'Show full goal'}
              </button>
            )}
            {note && <p className="mt-1.5 break-words text-[11px] text-slate-400">Note: {note}</p>}
            {view.tone !== 'active' && <p className="mt-1 text-[11px] text-slate-500">{view.description}</p>}
          </div>
        </div>

        {mode.kind === 'edit' ? (
          <form onSubmit={submitEdit} className="mt-3 space-y-2">
            <label htmlFor={fieldId} className="block text-[11px] text-slate-400">Edit the goal</label>
            <textarea id={fieldId} value={mode.draft} maxLength={OBJECTIVE_MAX} rows={4} autoFocus disabled={mode.submitted}
              onChange={(event) => setMode({ ...mode, draft: event.target.value })} className={FIELD} />
            {mode.hidden && (
              <p className="text-[11px] text-amber-200">Parts that look like secrets are hidden (••••••) and will be saved as shown. Re-enter them only if the goal needs them.</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <button type="submit" disabled={!mode.draft.trim() || Boolean(actions.edit.disabledReason) || sending !== null} className={PRIMARY}>
                {sending === 'edit' ? <Loader2 size={12} aria-hidden="true" className="motion-safe:animate-spin" /> : null}
                {sending === 'edit' ? PENDING_LABEL.edit : 'Save goal'}
              </button>
              <button type="button" disabled={sending !== null} onClick={() => setMode({ kind: 'view' })} className={NEUTRAL}>Cancel</button>
            </div>
          </form>
        ) : mode.kind === 'note' ? (
          <form onSubmit={submitNote} className="mt-3 space-y-2">
            <label htmlFor={fieldId} className="block text-[11px] text-slate-400">
              {mode.action === 'block' ? 'What is blocking it? (optional)' : 'Anything to record? (optional)'}
            </label>
            <textarea id={fieldId} value={mode.note} maxLength={NOTE_MAX} rows={2} autoFocus disabled={mode.submitted}
              onChange={(event) => setMode({ ...mode, note: event.target.value })} className={FIELD} />
            <div className="flex flex-wrap gap-1.5">
              <button type="submit" disabled={Boolean(actions[mode.action].disabledReason) || sending !== null} className={PRIMARY}>
                {noteSubmitLabel(mode.action, sending)}
              </button>
              <button type="button" disabled={sending !== null} onClick={() => setMode({ kind: 'view' })} className={NEUTRAL}>Cancel</button>
            </div>
          </form>
        ) : mode.kind === 'confirm-clear' ? (
          <div role="group" aria-label="Confirm clearing the goal" className="mt-3 space-y-2">
            <p className="text-[11px] text-slate-300">Clear this goal? The agent stops tracking it. The conversation is kept.</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={Boolean(actions.clear.disabledReason) || sending !== null} className={DANGER}
                onClick={() => { if (controls.run({ action: 'clear', goalId: goal.id })) setMode({ kind: 'view' }); }}>
                <Trash2 size={12} aria-hidden="true" />
                Clear goal
              </button>
              <button type="button" onClick={() => setMode({ kind: 'view' })} className={NEUTRAL}>Cancel</button>
            </div>
          </div>
        ) : work.caps.goals ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {actions.pause.visible && <ActionButton action="pause" label="Pause" icon={Pause} state={actions.pause} sending={sending}
                onClick={() => { controls.run({ action: 'pause', goalId: goal.id }); }} />}
              {actions.resume.visible && <ActionButton action="resume" label="Resume" icon={Play} state={actions.resume} sending={sending}
                onClick={() => { controls.run({ action: 'resume', goalId: goal.id }); }} />}
              {actions.edit.visible && <ActionButton action="edit" label="Edit" icon={Pencil} state={actions.edit} sending={sending} onClick={startEdit} />}
              {secondary && (
                <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)} className={NEUTRAL}>
                  {moreOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                  More
                </button>
              )}
            </div>
            {moreOpen && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {actions.block.visible && <ActionButton action="block" label="Mark blocked" icon={AlertOctagon} state={actions.block} sending={sending}
                  onClick={() => setMode({ kind: 'note', action: 'block', note: '', submitted: false })} />}
                {actions.complete.visible && <ActionButton action="complete" label="Mark complete" icon={CheckCircle2} state={actions.complete} sending={sending}
                  onClick={() => setMode({ kind: 'note', action: 'complete', note: '', submitted: false })} />}
                {actions.clear.visible && <ActionButton action="clear" label="Clear goal" icon={Trash2} state={actions.clear} sending={sending} tone="danger"
                  onClick={() => setMode({ kind: 'confirm-clear' })} />}
              </div>
            )}
            {primaryHint && <p className="mt-1.5 text-[11px] text-slate-500">{primaryHint}</p>}
            {isChild && resumable && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                Resume this goal from the conversation that started this sub-agent.
                {onOpenParent && (
                  <button type="button" onClick={onOpenParent} className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200">
                    <CornerLeftUp size={12} aria-hidden="true" />
                    Open it
                  </button>
                )}
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-[11px] text-slate-500">Goal controls aren’t available for this conversation right now.</p>
        )}
      </div>
      {sendingStatus}
      {noticeView}
    </section>
  );
}
