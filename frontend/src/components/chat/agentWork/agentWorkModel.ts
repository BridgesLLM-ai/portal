/**
 * Presentation rules for Agent Work. Upstream status values are shown as reported:
 * an unknown or missing status never becomes "finished", and nothing here infers success.
 */
import { isExactStopKey, type GoalControlAction, type ProgressCard, type SessionGoal, type SessionWork, type WorkSessionRow } from './agentWorkApi';
import { displayText } from '../toolCards/safeDisplay';
import { openClawTaskConversation } from '../../../utils/taskConversation';

export type RunTone = 'running' | 'waiting' | 'failed' | 'stopped' | 'done' | 'idle' | 'unknown';

export interface RunStatusView {
  tone: RunTone;
  label: string;
}

export function runStatusView(status: string | null | undefined): RunStatusView {
  switch (status) {
    case null:
    case undefined:
    case '':
      return { tone: 'idle', label: 'Idle' };
    case 'running': return { tone: 'running', label: 'Running' };
    case 'queued': return { tone: 'waiting', label: 'Waiting to start' };
    case 'failed': return { tone: 'failed', label: 'Failed' };
    case 'timeout': return { tone: 'failed', label: 'Timed out' };
    case 'interrupted': return { tone: 'stopped', label: 'Interrupted' };
    case 'killed': return { tone: 'stopped', label: 'Stopped' };
    case 'done': return { tone: 'done', label: 'Finished' };
    default: return { tone: 'unknown', label: displayText(status, 40) || 'Status unavailable' };
  }
}

export const isActiveRun = (status: string | null | undefined): boolean => status === 'running' || status === 'queued';

/** Automation (cron) runs, classified the way the activity route does. */
export const isAutomationKey = (key: string): boolean => key.includes(':cron:');

/**
 * A row offers Stop only while it is running or waiting, when the stop route acts on exactly
 * its key, and when it is not an automation run (those stay read-only here).
 */
export function canStopRow(row: Pick<WorkSessionRow, 'key' | 'status'>): boolean {
  return isActiveRun(row.status) && isExactStopKey(row.key) && !isAutomationKey(row.key);
}

export type GoalTone = 'active' | 'paused' | 'attention' | 'complete' | 'unknown';

export interface GoalStatusView {
  tone: GoalTone;
  label: string;
  description: string;
}

export function goalStatusView(status: string): GoalStatusView {
  switch (status) {
    case 'active': return { tone: 'active', label: 'Active', description: 'The agent is working toward this goal.' };
    case 'paused': return { tone: 'paused', label: 'Paused', description: 'Paused. Resume when the agent should continue.' };
    case 'blocked': return { tone: 'attention', label: 'Blocked', description: 'Waiting on a blocker. Resume once it is resolved.' };
    case 'usage_limited': return { tone: 'attention', label: 'Usage limit reached', description: 'Stopped by a usage limit. Resume to continue.' };
    case 'budget_limited': return { tone: 'attention', label: 'Token budget reached', description: 'Stopped at its token budget. Resume to start a fresh budget.' };
    case 'complete': return { tone: 'complete', label: 'Complete', description: 'Marked complete. Clear it before starting another goal.' };
    default: return { tone: 'unknown', label: displayText(status, 40) || 'Status unavailable', description: 'OpenClaw reported a goal status this Portal does not recognize.' };
  }
}

const RESUMABLE = new Set(['paused', 'blocked', 'usage_limited', 'budget_limited']);

export interface GoalActionContext {
  /** OpenClaw advertises structured goal controls. */
  supported: boolean;
  /** Sub-agent conversations cannot start or resume work from here. */
  isChild: boolean;
  /** The conversation already has a run in progress or queued. */
  busy: boolean;
  /** A goal change is being sent, or an earlier one is unconfirmed. */
  operationBlocked: boolean;
}

export interface GoalActionState {
  visible: boolean;
  /** Why a visible action cannot be used right now. */
  disabledReason: string | null;
}

export function goalActionStates(goal: SessionGoal, context: GoalActionContext): Record<GoalControlAction, GoalActionState> {
  const complete = goal.status === 'complete';
  const known = ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'].includes(goal.status);
  const shared = !context.supported
    ? 'Goal controls are not available for this conversation right now.'
    : context.operationBlocked
      ? 'Finish or dismiss the earlier goal change first.'
      : null;
  const state = (visible: boolean, reason: string | null = null): GoalActionState => (
    { visible, disabledReason: visible ? shared ?? reason : null }
  );
  return {
    edit: state(known && !complete),
    pause: state(goal.status === 'active'),
    resume: state(RESUMABLE.has(goal.status) && !context.isChild, context.busy ? 'Available when the agent is idle.' : null),
    block: state(goal.status === 'active' || goal.status === 'paused'),
    complete: state(known && !complete),
    clear: state(true),
  };
}

export function canStartGoal(work: SessionWork | null, context: Pick<GoalActionContext, 'isChild' | 'busy' | 'operationBlocked'>): { visible: boolean; disabledReason: string | null } {
  if (!work || work.goal || !work.caps.goals || context.isChild) return { visible: false, disabledReason: null };
  if (context.operationBlocked) return { visible: true, disabledReason: 'Finish or dismiss the earlier goal change first.' };
  if (context.busy) return { visible: true, disabledReason: 'Available when the agent is idle.' };
  return { visible: true, disabledReason: null };
}

export function progressCounts(progress: ProgressCard | null) {
  const steps = progress?.steps || [];
  const completed = steps.filter((step) => step.status === 'completed').length;
  const current = steps.find((step) => step.status === 'in_progress')?.step ?? null;
  return { total: steps.length, completed, current };
}

export function runCounts(rows: WorkSessionRow[]) {
  const counts = { total: rows.length, running: 0, waiting: 0, failed: 0, stopped: 0, done: 0, idle: 0, unknown: 0 };
  for (const row of rows) counts[runStatusView(row.status).tone] += 1;
  return counts;
}

const KEY_LIKE = /^agent:[^:]+:/;

/** A human label. Keys are identifiers, not names, so they are never shown as the title. */
export function sessionDisplayLabel(row: Pick<WorkSessionRow, 'key' | 'label' | 'kind'>): string {
  const label = displayText(row.label, 120);
  if (label && row.label !== row.key && !KEY_LIKE.test(row.label)) return label;
  const match = /^agent:([^:]+):(.*)$/.exec(row.key);
  const agent = match ? displayText(match[1], 40) : '';
  const tail = (match?.[2] || row.key).replace(/[^a-zA-Z0-9]/g, '').slice(-6);
  const base = row.kind === 'subagent' ? 'Sub-agent' : isAutomationKey(row.key) ? 'Automation run' : 'Conversation';
  return [base, agent && agent !== 'main' ? agent : null, tail || null].filter(Boolean).join(' · ');
}

/** Only keys the existing conversation navigation accepts get an Open control. */
export function isNavigableSessionKey(key: string): boolean {
  return openClawTaskConversation(key) !== null;
}

const toMs = (value: number): number => (value > 0 && value < 1e11 ? value * 1000 : value);

export function relativeTime(value: number | null | undefined, now: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const at = toMs(value);
  const diff = Math.max(0, now - at);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
  return new Date(at).toLocaleDateString();
}

export function formatTokens(value: number | null): string | null {
  if (value === null || value < 0) return null;
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`.replace('.0k', 'k');
  return `${Math.round(value / 100_000) / 10}M`.replace('.0M', 'M');
}

export interface ActivityGroups {
  attention: WorkSessionRow[];
  running: WorkSessionRow[];
  waiting: WorkSessionRow[];
  recent: WorkSessionRow[];
}

const byNewest = (a: WorkSessionRow, b: WorkSessionRow) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** Other conversations: failures from the last day first, then running and waiting work. */
export function groupActivity(rows: WorkSessionRow[], exclude: ReadonlySet<string>, now: number): ActivityGroups {
  const groups: ActivityGroups = { attention: [], running: [], waiting: [], recent: [] };
  for (const row of [...rows].sort(byNewest)) {
    if (exclude.has(row.key)) continue;
    const tone = runStatusView(row.status).tone;
    const updated = row.updatedAt === null ? null : toMs(row.updatedAt);
    if (tone === 'failed' && updated !== null && now - updated < 86_400_000) groups.attention.push(row);
    else if (tone === 'running') groups.running.push(row);
    else if (tone === 'waiting') groups.waiting.push(row);
    else groups.recent.push(row);
  }
  return {
    attention: groups.attention.slice(0, 10),
    running: groups.running.slice(0, 20),
    waiting: groups.waiting.slice(0, 20),
    recent: groups.recent.slice(0, 8),
  };
}
