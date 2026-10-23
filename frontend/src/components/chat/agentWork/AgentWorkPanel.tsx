import { useEffect, useId, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Circle, CornerLeftUp, Loader2, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarkdownRenderer from '../MarkdownRenderer';
import type { WorkCard } from '../ProjectWork';
import type { ChatTask } from '../../../utils/chatTasks';
import type { AgentActivity, SessionWork, WorkSessionRow } from './agentWorkApi';
import { groupActivity, isNavigableSessionKey, progressCounts, relativeTime, runCounts, runStatusView } from './agentWorkModel';
import type { AgentActivityState, AgentWorkState } from './useAgentWork';
import type { GoalControlsState } from './useGoalControls';
import type { SessionStopsState } from './useSessionStops';
import { GoalSection } from './GoalSection';
import { RunStatusChip, SessionRunRow, StopNotices, WorkSectionHeading } from './AgentWorkParts';
import { displayBlock, displayText } from '../toolCards/safeDisplay';

/** Re-render relative times without refetching anything. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ProgressSection({ work, fallbackPlan, now }: { work: SessionWork | null; fallbackPlan: ChatTask[]; now: number }) {
  const headingId = useId();
  const live = Boolean(work?.caps.progress);
  const card = live ? work!.progress : null;
  const counts = progressCounts(card);
  const markdown = card?.markdown ? displayBlock(card.markdown, 8192, 200) : null;
  const updated = card ? relativeTime(card.updatedAt, now) : null;
  const fallbackDone = fallbackPlan.filter((task) => task.status === 'done').length;
  const aside = live
    ? (counts.total ? `${counts.completed} of ${counts.total} steps` : undefined)
    : fallbackPlan.length ? `${fallbackDone} of ${fallbackPlan.length} steps` : undefined;
  return (
    <section aria-labelledby={headingId} className="border-b border-white/5 px-4 py-3">
      <WorkSectionHeading id={headingId} title="Progress" aside={aside} />
      {live && !card && (
        <p className="text-xs text-slate-400">No progress card yet. The agent shows its plan and progress here when it reports them.</p>
      )}
      {card && (
        <>
          {counts.total > 0 && (
            <progress aria-label="Reported progress" value={counts.completed} max={counts.total} className="mb-2 h-1 w-full overflow-hidden rounded-full accent-sky-400" />
          )}
          {counts.total > 0 && (
            <ol className="space-y-1.5">
              {card.steps.map((step, index) => {
                const label = step.status === 'completed' ? 'Completed' : step.status === 'in_progress' ? 'In progress' : step.status === 'pending' ? 'Pending' : 'Status unavailable';
                return (
                  <li key={`${index}:${step.step}`} className="flex gap-2 text-xs leading-relaxed">
                    {step.status === 'completed'
                      ? <CheckCircle2 size={14} aria-label={label} className="mt-0.5 shrink-0 text-emerald-400" />
                      : step.status === 'in_progress'
                        ? <Loader2 size={14} aria-label={label} className="mt-0.5 shrink-0 text-sky-300 motion-safe:animate-spin" />
                        : <Circle size={14} aria-label={label} className="mt-0.5 shrink-0 text-slate-500" />}
                    <span className={`min-w-0 break-words ${step.status === 'completed' ? 'text-slate-400' : 'text-slate-200'}`}>{displayText(step.step, 300)}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {markdown?.text && (
            <div className="mt-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
              <MarkdownRenderer content={markdown.text} className="text-xs" />
              {markdown.truncated && <p className="mt-1 text-[11px] text-slate-500">Shortened for display.</p>}
            </div>
          )}
          {updated && <p className="mt-2 text-[11px] text-slate-500">Updated {updated}</p>}
        </>
      )}
      {!live && (fallbackPlan.length ? (
        <>
          <p className="mb-2 text-[11px] text-slate-500">From the latest plan in this chat.</p>
          <ol className="space-y-1.5">
            {fallbackPlan.map((task) => (
              <li key={task.id} className="flex gap-2 text-xs leading-relaxed">
                {task.status === 'done'
                  ? <CheckCircle2 size={14} aria-label="Completed" className="mt-0.5 shrink-0 text-emerald-400" />
                  : task.status === 'running'
                    ? <Loader2 size={14} aria-label="In progress" className="mt-0.5 shrink-0 text-sky-300 motion-safe:animate-spin" />
                    : <Circle size={14} aria-label={task.status === 'pending' ? 'Pending' : 'Status unavailable'} className="mt-0.5 shrink-0 text-slate-500" />}
                <span className="min-w-0 break-words text-slate-200">{displayText(task.name, 300)}</span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-xs text-slate-400">No progress reported for this chat yet.</p>
      ))}
    </section>
  );
}

function countsText(rows: WorkSessionRow[]): string | undefined {
  const counts = runCounts(rows);
  const parts = [
    counts.running ? `${counts.running} running` : null,
    counts.waiting ? `${counts.waiting} waiting` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : rows.length ? `${rows.length} total` : undefined;
}

function SubAgentsSection({ work, now, stops, onOpenSession }: { work: SessionWork; now: number; stops: SessionStopsState; onOpenSession?: (key: string) => void }) {
  const headingId = useId();
  const swarm = work.swarm?.groups.length ? work.swarm : null;
  const swarmTotals = swarm?.groups.reduce((sum, group) => ({
    queued: sum.queued + group.queued, running: sum.running + group.running, done: sum.done + group.done, failed: sum.failed + group.failed,
  }), { queued: 0, running: 0, done: 0, failed: 0 });
  return (
    <section aria-labelledby={headingId} className="border-b border-white/5 px-4 py-3">
      <WorkSectionHeading id={headingId} title="Sub-agents" aside={countsText(work.children)} />
      {work.children.length === 0 ? (
        <p className="text-xs text-slate-400">No sub-agents yet. Work the agent hands off appears here with its status.</p>
      ) : (
        <ul className="space-y-2">
          {work.children.map((child) => <SessionRunRow key={child.key} row={child} now={now} onOpen={onOpenSession} stops={stops} />)}
        </ul>
      )}
      {work.children.length >= 20 && <p className="mt-2 text-[11px] text-slate-500">Showing the 20 most recently updated.</p>}
      {swarmTotals && (
        <p className="mt-2 text-[11px] text-slate-500">
          {`Parallel work: ${swarmTotals.running} running, ${swarmTotals.queued} waiting, ${swarmTotals.done} finished, ${swarmTotals.failed} failed`}
          {swarm!.otherActiveGroups ? ` · ${swarm!.otherActiveGroups} more active groups` : ''}
        </p>
      )}
    </section>
  );
}

function ActivityGroup({ title, rows, now, stops, onOpenSession }: { title: string; rows: WorkSessionRow[]; now: number; stops: SessionStopsState; onOpenSession?: (key: string) => void }) {
  if (!rows.length) return null;
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1.5 text-[11px] font-medium text-slate-300">{title}</p>
      <ul className="space-y-2">{rows.map((row) => <SessionRunRow key={row.key} row={row} now={now} onOpen={onOpenSession} stops={stops} />)}</ul>
    </div>
  );
}

function OtherConversationsSection({ activity, currentKey, work, now, stops, onOpenSession }: {
  activity: AgentActivityState;
  currentKey: string | null;
  work: SessionWork | null;
  now: number;
  stops: SessionStopsState;
  onOpenSession?: (key: string) => void;
}) {
  const headingId = useId();
  const data: AgentActivity | null = activity.activity;
  const exclude = useMemo(() => new Set([
    ...(currentKey ? [currentKey] : []),
    ...(work?.children.map((child) => child.key) ?? []),
  ]), [currentKey, work]);
  const groups = useMemo(() => (data ? groupActivity(data.items, exclude, now) : null), [data, exclude, now]);
  const automation = useMemo(() => (data?.automation
    ? [...data.automation].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 10)
    : null), [data]);
  const automationRunning = automation?.filter((row) => runStatusView(row.status).tone === 'running').length ?? 0;
  const busy = groups ? groups.attention.length + groups.running.length + groups.waiting.length : 0;
  const summary = groups ? [
    groups.attention.length ? `${groups.attention.length} failed` : null,
    groups.running.length ? `${groups.running.length} running` : null,
    groups.waiting.length ? `${groups.waiting.length} waiting` : null,
  ].filter(Boolean).join(' · ') : '';
  return (
    <section aria-labelledby={headingId} className="border-b border-white/5 px-4 py-3">
      <WorkSectionHeading id={headingId} title="Other conversations" aside={summary || undefined} />
      {activity.stale && <p role="status" className="mb-2 text-[11px] text-amber-300">Couldn’t refresh. Showing the last update.</p>}
      {!data && (activity.status === 'loading' || activity.status === 'idle') && <p className="text-xs text-slate-400">Loading…</p>}
      {!data && activity.status === 'unavailable' && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          Other conversations couldn’t be loaded.
          <button type="button" onClick={activity.refresh} className="text-sky-300 hover:text-sky-200">Try again</button>
        </p>
      )}
      {!data && (activity.status === 'unsupported' || activity.status === 'forbidden') && (
        <p className="text-xs text-slate-400">Other conversations aren’t available here.</p>
      )}
      {groups && (
        <>
          <ActivityGroup title="Needs attention" rows={groups.attention} now={now} stops={stops} onOpenSession={onOpenSession} />
          <ActivityGroup title="Running" rows={groups.running} now={now} stops={stops} onOpenSession={onOpenSession} />
          <ActivityGroup title="Waiting to start" rows={groups.waiting} now={now} stops={stops} onOpenSession={onOpenSession} />
          {busy === 0 && <p className="text-xs text-slate-400">Nothing else is running.</p>}
          {groups.recent.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">Recent conversations ({groups.recent.length})</summary>
              <ul className="mt-2 space-y-2">{groups.recent.map((row) => <SessionRunRow key={row.key} row={row} now={now} onOpen={onOpenSession} />)}</ul>
            </details>
          )}
          {automation && automation.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
                {`Automation runs (${automation.length})${automationRunning ? ` · ${automationRunning} running` : ''}`}
              </summary>
              {/* Read-only: managing automation jobs and their runs belongs to scheduling. */}
              <ul className="mt-2 space-y-2">{automation.map((row) => <SessionRunRow key={row.key} row={row} now={now} onOpen={onOpenSession} />)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ProjectWorkSection({ cards, onFocus }: { cards: WorkCard[]; onFocus(id: string): void }) {
  const headingId = useId();
  if (!cards.length) return null;
  return (
    <section aria-labelledby={headingId} className="border-b border-white/5 px-4 py-3">
      <WorkSectionHeading id={headingId} title="Project work" />
      <ul className="space-y-2">
        {cards.map((card) => {
          const status = card.turn?.status === 'COMPLETED' ? 'done' : ['RUNNING', 'STARTING'].includes(card.turn?.status || '') ? 'running'
            : !card.turn ? 'queued' : card.turn.status === 'ABORTED' ? 'killed' : 'failed';
          return (
            <li key={card.id} className="flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <button type="button" onClick={() => onFocus(card.id)} className="min-w-0 flex-1 break-words text-left text-xs text-slate-200 hover:text-sky-300">
                {displayText(`${card.projectName} · ${card.prompt}`, 200)}
              </button>
              <RunStatusChip status={status} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const STATUS_MESSAGE: Partial<Record<AgentWorkState['status'], string>> = {
  'not-found': 'Agent work appears here once this conversation has started.',
  unsupported: 'Live agent work isn’t available on this server.',
  forbidden: 'You don’t have access to agent work for this conversation.',
  unavailable: 'Agent work is unavailable right now.',
};

export function AgentWorkPanel({ openClaw = true, work, goals, activity, stops, fallbackPlan, projectWork, isChatRunning, onOpenSession, onClose }: {
  /** OpenClaw chat. Native harness chats show only what they report: goal (when supported) and plan. */
  openClaw?: boolean;
  work: AgentWorkState;
  goals: GoalControlsState;
  activity: AgentActivityState;
  stops: SessionStopsState;
  fallbackPlan: ChatTask[];
  projectWork: WorkCard[];
  isChatRunning: boolean;
  onOpenSession?: (key: string) => void;
  onClose(): void;
}) {
  const now = useNow();
  const reducedMotion = useReducedMotion();
  const data = work.work;
  const session = data?.session ?? null;
  const isChild = Boolean(session?.parentKey);
  const busy = isChatRunning || session?.status === 'running' || session?.status === 'queued';
  const loading = !data && (work.status === 'loading' || work.status === 'resolving');
  const updated = relativeTime(work.loadedAt, now);
  const openParent = session?.parentKey && onOpenSession && isNavigableSessionKey(session.parentKey)
    ? () => onOpenSession(session.parentKey!)
    : undefined;
  const focusProjectWork = (id: string) => {
    onClose();
    document.querySelector(`[data-work-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  };
  return (
    <motion.section role="dialog" aria-label="Agent work" className="flex min-h-0 max-h-full flex-col"
      initial={reducedMotion ? false : { opacity: 0, y: -7 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
      <header className="shrink-0 border-b border-white/5 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Agent work</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
              {session && <RunStatusChip status={session.status} />}
              {session?.activityText && <span className="truncate">{displayText(session.activityText, 120)}</span>}
              {!session && loading && <span>Loading…</span>}
              {updated && !work.stale && <span>Updated {updated}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" aria-label="Refresh agent work" onClick={() => { work.refresh(); activity.refresh(); }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              <RefreshCw size={14} aria-hidden="true" className={work.refreshing ? 'motion-safe:animate-spin' : ''} />
            </button>
            <button type="button" aria-label="Close agent work" onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        {work.stale && (
          <p role="status" className="mt-2 text-[11px] text-amber-300">
            {`Couldn’t refresh. Showing the last update${updated ? ` from ${updated}` : ''}.`}
          </p>
        )}
        {isChild && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-slate-300">
            <span>This is a sub-agent conversation.</span>
            {openParent && (
              <button type="button" onClick={openParent} className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200">
                <CornerLeftUp size={12} aria-hidden="true" />
                Open the conversation that started it
              </button>
            )}
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!data && !loading && STATUS_MESSAGE[work.status] && (
          <div className="border-b border-white/5 px-4 py-3 text-xs text-slate-400">
            <p>{STATUS_MESSAGE[work.status]}</p>
            {work.status === 'unavailable' && (
              <button type="button" onClick={work.refresh} className="mt-1 text-sky-300 hover:text-sky-200">Try again</button>
            )}
          </div>
        )}
        {loading && <p className="border-b border-white/5 px-4 py-3 text-xs text-slate-400">Loading agent work…</p>}
        {data && (openClaw || data.caps.goals || data.goal) && <GoalSection work={data} controls={goals} isChild={isChild} busy={busy} now={now} onOpenParent={openParent} />}
        {(data || !loading) && <ProgressSection work={data} fallbackPlan={fallbackPlan} now={now} />}
        {data && (openClaw || data.children.length > 0) && <SubAgentsSection work={data} now={now} stops={stops} onOpenSession={onOpenSession} />}
        {openClaw && <OtherConversationsSection activity={activity} currentKey={work.key} work={data} now={now} stops={stops} onOpenSession={onOpenSession} />}
        <ProjectWorkSection cards={projectWork} onFocus={focusProjectWork} />
      </div>
      <StopNotices stops={stops} />
      <footer className="shrink-0 border-t border-white/5 px-4 py-2.5 text-[11px] text-slate-400">
        {openClaw
          ? <Link to="/tasks" onClick={onClose} className="text-sky-300">Open task board →</Link>
          : <span>Progress shows the plan this harness reports in chat.</span>}
      </footer>
    </motion.section>
  );
}
