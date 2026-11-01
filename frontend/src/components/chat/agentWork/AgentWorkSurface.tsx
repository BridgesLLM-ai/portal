/**
 * Agent Work for every Agent Chat harness: one live state shared by the header
 * "Work" button (popover panel) and the one-line summary above the composer.
 * OpenClaw-only concepts (sub-agents, other conversations, the task board) stay
 * out of native harness chats, whose progress is the plan they report in chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronRight, ListTodo } from 'lucide-react';
import AnchoredPopover from '../../AnchoredPopover';
import type { ChatMessage, WsManager } from '../../../contexts/ChatStateProvider';
import type { WorkCard } from '../ProjectWork';
import { latestChatPlan } from '../../../utils/chatTasks';
import { useAgentActivity, useAgentWork, type AgentActivityState, type AgentWorkState } from './useAgentWork';
import { useGoalControls, type GoalControlsState } from './useGoalControls';
import { useSessionStops, type SessionStopsState } from './useSessionStops';
import { AgentWorkPanel } from './AgentWorkPanel';
import { goalStatusView, progressCounts, runCounts } from './agentWorkModel';
import { GoalToneIcon } from './GoalSection';
import { parseNativeProgress } from '../../../utils/nativeProgress';
import { displayText } from '../toolCards/safeDisplay';

export interface AgentWorkSurface {
  enabled: boolean;
  /** OpenClaw chat: sub-agents, other conversations and the task board apply. */
  openClaw: boolean;
  work: AgentWorkState;
  goals: GoalControlsState;
  activity: AgentActivityState;
  stops: SessionStopsState;
  open: boolean;
  setOpen(open: boolean): void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}

/** The backend caches the session list for 5 s; a stopped row's status can lag behind that. */
const STOP_REREAD_MS = 6000;

export function useAgentWorkSurface({ enabled, provider = 'OPENCLAW', session, wsManager, userId }: {
  enabled: boolean;
  /** Agent Chat harness of the open conversation. */
  provider?: string;
  session: string;
  wsManager: WsManager | null;
  userId: string | null;
}): AgentWorkSurface {
  const openClaw = String(provider || 'OPENCLAW').trim().toUpperCase() === 'OPENCLAW';
  const work = useAgentWork({ enabled, session, wsManager, provider });
  const { applyGoalReadback, requestRefresh, refresh, key } = work;
  const keyRef = useRef(key);
  keyRef.current = key;
  const onSettled = useCallback((target: string) => {
    if (target === keyRef.current) requestRefresh();
  }, [requestRefresh]);
  const goals = useGoalControls({
    userId: enabled ? userId : null,
    sessionKey: enabled ? key : null,
    onReadback: applyGoalReadback,
    onSettled,
  });
  // Opening is tied to the conversation it was opened for; navigating closes it.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = enabled && openFor !== null && openFor === session;
  // Other conversations' activity is the OpenClaw session list.
  const activity = useAgentActivity({ enabled: open && openClaw, wsManager });
  const refreshActivityRef = useRef(activity.refresh);
  refreshActivityRef.current = activity.refresh;
  const rereadRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (rereadRef.current !== null) window.clearTimeout(rereadRef.current);
  }, []);
  // Reread at once, then again after the backend's short session-list cache has expired.
  const onStopSettled = useCallback(() => {
    refresh();
    refreshActivityRef.current();
    if (rereadRef.current !== null) window.clearTimeout(rereadRef.current);
    rereadRef.current = window.setTimeout(() => {
      rereadRef.current = null;
      requestRefresh();
      refreshActivityRef.current();
    }, STOP_REREAD_MS);
  }, [refresh, requestRefresh]);
  const stops = useSessionStops(onStopSettled);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const setOpen = useCallback((value: boolean) => setOpenFor(value ? session : null), [session]);
  return { enabled, openClaw, work, goals, activity, stops, open, setOpen, anchorRef };
}

function summaryParts(surface: AgentWorkSurface) {
  const data = surface.work.work;
  const counts = runCounts(data?.children ?? []);
  const active = counts.running + counts.waiting;
  const progress = data?.caps.progress ? progressCounts(data.progress) : { total: 0, completed: 0, current: null };
  return { data, counts, active, progress };
}

export function AgentWorkButton({ surface, messages, projectWork, isChatRunning, onOpenSession }: {
  surface: AgentWorkSurface;
  messages: ChatMessage[];
  projectWork: WorkCard[];
  isChatRunning: boolean;
  onOpenSession?: (key: string) => void;
}) {
  const { openClaw, work, goals, activity, stops, open, setOpen, anchorRef } = surface;
  const { data, counts, active } = summaryParts(surface);
  const liveProgress = Boolean(data?.caps.progress);
  // Without the native progress capability, fall back to the plan the harness reported in chat.
  const fallbackPlan = useMemo(() => (liveProgress ? [] : latestChatPlan(messages)), [liveProgress, messages]);
  const goalView = data?.goal ? goalStatusView(data.goal.status) : null;
  const running = data?.session.status === 'running' || active > 0;
  const attention = counts.failed > 0 || Boolean(goals.saved && goals.sending === null);
  const label = [
    'Agent work',
    goalView ? `goal ${goalView.label.toLowerCase()}` : null,
    active ? `${active} sub-agent${active === 1 ? '' : 's'} active` : null,
    counts.failed ? `${counts.failed} failed` : null,
    goals.saved && goals.sending === null ? 'a goal change is unconfirmed' : null,
  ].filter(Boolean).join(', ');
  const close = () => {
    setOpen(false);
    anchorRef.current?.focus();
  };
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={openClaw ? 'Goal, progress and sub-agents' : 'Goal and progress'}
        className={'relative flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 '
          + (open || running ? 'border-sky-400/20 bg-sky-400/10 text-sky-300'
            : attention ? 'border-rose-400/20 bg-rose-500/[0.08] text-rose-200'
              : 'border-transparent text-slate-400 hover:bg-sky-500/10 hover:text-sky-300')}
      >
        <ListTodo size={16} aria-hidden="true" />
        <span className="hidden min-[900px]:inline">Work</span>
        {active > 0 && <span aria-hidden="true" className="text-[10px] font-semibold tabular-nums">{active}</span>}
        {running && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sky-300 motion-safe:animate-pulse" />}
        {attention && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-rose-400" />}
      </button>
      <AnchoredPopover open={open} anchorRef={anchorRef} onDismiss={close} width={420} ariaLabel="Agent work"
        className="overflow-hidden rounded-2xl border border-white/10 bg-[var(--color-surface)] shadow-2xl">
        <AgentWorkPanel
          openClaw={openClaw}
          work={work}
          goals={goals}
          activity={activity}
          stops={stops}
          fallbackPlan={fallbackPlan}
          projectWork={projectWork}
          isChatRunning={isChatRunning}
          onOpenSession={onOpenSession}
          onClose={close}
        />
      </AnchoredPopover>
    </>
  );
}

/** One line above the composer, only when there is a goal, progress, sub-agents or an unconfirmed change. */
export function AgentWorkStrip({ surface }: { surface: AgentWorkSurface }) {
  const { data, counts, active, progress } = summaryParts(surface);
  const unconfirmed = Boolean(surface.goals.saved) && surface.goals.sending === null;
  if (!surface.enabled || !data) return null;
  const goal = data.goal;
  const note = parseNativeProgress(data.caps.progress ? data.progress?.markdown : null);
  const hasNote = Boolean(note.note || note.measure);
  if (!goal && !progress.total && !hasNote && !data.children.length && !unconfirmed) return null;
  const goalView = goal ? goalStatusView(goal.status) : null;
  const objective = goal ? displayText(goal.objective, 140) : '';
  const parts = [
    progress.total ? `${progress.completed}/${progress.total} steps` : hasNote ? 'Progress update' : null,
    active ? `${active} sub-agent${active === 1 ? '' : 's'} active` : null,
    counts.failed ? `${counts.failed} failed` : null,
    !active && !counts.failed && data.children.length ? `${data.children.length} sub-agent${data.children.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean) as string[];
  const goalLabel = goalView ? (goalView.tone === 'active' ? 'Goal' : `Goal ${goalView.label.toLowerCase()}`) : null;
  const name = [
    goalLabel ? `${goalLabel}: ${objective}` : null,
    ...parts,
    unconfirmed ? 'goal change unconfirmed' : null,
  ].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      onClick={() => surface.setOpen(true)}
      aria-haspopup="dialog"
      aria-label={`Agent work: ${name}. Show details`}
      className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-left text-[11px] text-slate-300 transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
    >
      {goalView ? <GoalToneIcon tone={goalView.tone} size={13} /> : <ListTodo size={13} aria-hidden="true" className="shrink-0 text-slate-400" />}
      {goalLabel && <span className="shrink-0 font-semibold text-slate-200">{goalLabel}</span>}
      <span className="min-w-0 flex-1 truncate text-slate-300">{objective || parts.join(' · ')}</span>
      {objective && parts.length > 0 && <span className="hidden shrink-0 text-slate-400 sm:inline">{parts.join(' · ')}</span>}
      {unconfirmed && <span className="shrink-0 text-amber-300">Change unconfirmed</span>}
      <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-slate-500" />
    </button>
  );
}
