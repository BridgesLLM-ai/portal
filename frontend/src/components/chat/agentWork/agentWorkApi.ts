/**
 * The only browser client of the public `/api/agent-work` contract.
 *
 * Responses are treated as untrusted: anything without `v: 1`, or describing a
 * different session than the one asked for, is never rendered. Strings stay raw
 * here; every component shows them through the tool-card display helpers.
 */
import axios from 'axios';
import client from '../../../api/client';
import { isAnyNativeAgentChatSessionId } from '../../../utils/nativeAgentSession';
import { StaleWorkspaceAuthorizationResponseError } from '../../../utils/workspaceAuthorization';

const MAX_KEY_LENGTH = 2048;
const MAX_CHILDREN = 20;
const MAX_ACTIVITY_ROWS = 500;
const MAX_PROGRESS_STEPS = 50;

export interface WorkSessionRow {
  key: string;
  kind: 'session' | 'subagent';
  parentKey: string | null;
  /** Upstream label; the backend falls back to the key when there is none. */
  label: string;
  /** Upstream run status, verbatim. `null` means no run status was reported. */
  status: string | null;
  updatedAt: number | null;
  lastRunError: string | null;
  subagentRole: string | null;
  spawnDepth: number | null;
  /** Present only when the upstream activity summary is current. */
  activityText: string | null;
}

export interface SessionGoal {
  id: string;
  objective: string;
  status: string;
  createdAt: number | null;
  updatedAt: number | null;
  tokensUsed: number | null;
  tokenBudget: number | null;
  lastStatusNote: string | null;
}

export type ProgressStepStatus = 'pending' | 'in_progress' | 'completed' | 'unknown';

export interface ProgressCard {
  revision: number;
  updatedAt: number | null;
  markdown: string | null;
  steps: Array<{ step: string; status: ProgressStepStatus }>;
}

export interface SwarmGroup {
  groupId: string;
  queued: number;
  running: number;
  done: number;
  failed: number;
}

export interface SessionWork {
  sessionKey: string;
  fetchedAt: string | null;
  caps: { goals: boolean; progress: boolean };
  session: WorkSessionRow;
  goal: SessionGoal | null;
  progress: ProgressCard | null;
  children: WorkSessionRow[];
  swarm: { groups: SwarmGroup[]; otherActiveGroups: number } | null;
}

export interface AgentActivity {
  fetchedAt: string | null;
  items: WorkSessionRow[];
  /** Only OWNER receives automation rows; `null` means the field was absent. */
  automation: WorkSessionRow[] | null;
}

export type AgentWorkFailureKind =
  | 'not-found'
  | 'unsupported'
  | 'forbidden'
  | 'unavailable'
  | 'stale-authorization';

export class AgentWorkRequestError extends Error {
  constructor(readonly kind: AgentWorkFailureKind, readonly status: number | null = null, readonly code: string | null = null) {
    super(`Agent work request failed: ${kind}`);
    this.name = 'AgentWorkRequestError';
  }
}

export function isWorkSessionKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_KEY_LENGTH
    && !/[\u0000- \u007f]/.test(value);
}

/** Exact identity accepted by `/api/agent-work`: a qualified OpenClaw key, never a Portal alias. */
export function isQualifiedSessionKey(value: unknown): value is string {
  return isWorkSessionKey(value) && /^agent:[^:]+:.+/.test(value);
}

/**
 * Identities `/work` answers: a qualified OpenClaw key, or the exact Portal
 * session id of a native harness chat. Stops stay OpenClaw-only (isExactStopKey).
 */
export function isWorkIdentity(value: unknown): value is string {
  return isQualifiedSessionKey(value) || (isWorkSessionKey(value) && isAnyNativeAgentChatSessionId(value));
}

export function workSessionPath(key: string): string {
  return `/agent-work/sessions/${encodeURIComponent(key)}`;
}

const record = (value: unknown): Record<string, any> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const finite = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);
const count = (value: unknown): number => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : 0;
};

export function normalizeWorkRow(value: unknown): WorkSessionRow | null {
  const row = record(value);
  if (!row || !isWorkSessionKey(row.key)) return null;
  const parentKey = isWorkSessionKey(row.parentKey) ? row.parentKey : null;
  const activity = record(row.activity);
  const activityText = text(row.activityText)
    ?? (activity?.state === 'current' ? text(activity.text) : null);
  return {
    key: row.key,
    kind: parentKey || row.kind === 'subagent' ? 'subagent' : 'session',
    parentKey,
    label: text(row.label)?.trim() || row.key,
    status: text(row.status),
    updatedAt: finite(row.updatedAt),
    lastRunError: text(row.lastRunError),
    subagentRole: text(row.subagentRole),
    spawnDepth: finite(row.spawnDepth),
    activityText: activityText && activityText.trim() ? activityText : null,
  };
}

export function normalizeGoal(value: unknown): SessionGoal | null {
  const goal = record(value);
  if (!goal || typeof goal.id !== 'string' || !goal.id.trim() || typeof goal.status !== 'string') return null;
  return {
    id: goal.id,
    objective: text(goal.objective) ?? '',
    status: goal.status,
    createdAt: finite(goal.createdAt),
    updatedAt: finite(goal.updatedAt),
    tokensUsed: finite(goal.tokensUsed),
    tokenBudget: finite(goal.tokenBudget),
    lastStatusNote: text(goal.lastStatusNote),
  };
}

const STEP_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

export function normalizeProgress(value: unknown): ProgressCard | null {
  const card = record(value);
  const revision = finite(card?.revision);
  if (!card || revision === null) return null;
  const steps = Array.isArray(card.steps) ? card.steps.slice(0, MAX_PROGRESS_STEPS).flatMap((entry: unknown) => {
    const step = record(entry);
    if (!step || typeof step.step !== 'string' || !step.step.trim()) return [];
    return [{
      step: step.step,
      status: (STEP_STATUSES.has(step.status) ? step.status : 'unknown') as ProgressStepStatus,
    }];
  }) : [];
  return { revision, updatedAt: finite(card.updatedAt), markdown: text(card.markdown), steps };
}

function normalizeSwarm(value: unknown): SessionWork['swarm'] {
  const swarm = record(value);
  if (!swarm || !Array.isArray(swarm.groups)) return null;
  const groups = swarm.groups.slice(0, 5).flatMap((entry: unknown) => {
    const group = record(entry);
    if (!group || typeof group.groupId !== 'string' || !group.groupId) return [];
    return [{ groupId: group.groupId, queued: count(group.queued), running: count(group.running), done: count(group.done), failed: count(group.failed) }];
  });
  return { groups, otherActiveGroups: count(swarm.otherActiveGroups) };
}

export function normalizeSessionWork(value: unknown, expectedKey: string): SessionWork | null {
  const data = record(value);
  if (!data || data.v !== 1 || data.sessionKey !== expectedKey) return null;
  const session = normalizeWorkRow(data.session);
  if (!session || session.key !== expectedKey) return null;
  const caps = record(data.caps);
  const children = (Array.isArray(data.children) ? data.children : [])
    .map(normalizeWorkRow)
    .filter((row): row is WorkSessionRow => Boolean(row) && row!.key !== expectedKey)
    .slice(0, MAX_CHILDREN);
  return {
    sessionKey: expectedKey,
    fetchedAt: text(data.fetchedAt),
    caps: { goals: caps?.goals === true, progress: caps?.progress === true },
    session,
    goal: normalizeGoal(data.goal),
    progress: normalizeProgress(data.progress),
    children,
    swarm: normalizeSwarm(data.swarm),
  };
}

/** `/work` answer for a chat the gateway has not stored yet: exact key, no row. */
export function isUnstartedSessionWork(value: unknown, expectedKey: string): boolean {
  const data = record(value);
  return Boolean(data) && data!.v === 1 && data!.sessionKey === expectedKey
    && data!.started === false && data!.session === null;
}

export function normalizeActivity(value: unknown): AgentActivity | null {
  const data = record(value);
  if (!data || data.v !== 1 || !Array.isArray(data.items)) return null;
  const rows = (entries: unknown[]) => entries.slice(0, MAX_ACTIVITY_ROWS)
    .map(normalizeWorkRow)
    .filter((row): row is WorkSessionRow => Boolean(row));
  return {
    fetchedAt: text(data.fetchedAt),
    items: rows(data.items),
    automation: Array.isArray(data.automation) ? rows(data.automation) : null,
  };
}

function responseCode(error: any): string | null {
  const code = error?.response?.data?.code;
  return typeof code === 'string' && code.length <= 80 ? code : null;
}

/** Map a read failure to what the user can be told. A 404 only means "not found" with the v1 body. */
export function classifyReadFailure(error: unknown): AgentWorkRequestError {
  if (error instanceof AgentWorkRequestError) return error;
  if (error instanceof StaleWorkspaceAuthorizationResponseError) return new AgentWorkRequestError('stale-authorization');
  const status = Number((error as any)?.response?.status) || null;
  const code = responseCode(error);
  if (status === 404) {
    return (error as any)?.response?.data?.v === 1 && code === 'SESSION_NOT_FOUND'
      ? new AgentWorkRequestError('not-found', status, code)
      : new AgentWorkRequestError('unsupported', status, code);
  }
  if (status === 403) return new AgentWorkRequestError('forbidden', status, code);
  return new AgentWorkRequestError('unavailable', status, code);
}

export const isAbortError = (error: unknown): boolean => axios.isCancel(error)
  || (error as any)?.name === 'AbortError' || (error as any)?.name === 'CanceledError';

const READ_OPTIONS = { _silent: true } as const;

export async function fetchSessionWork(key: string, signal?: AbortSignal): Promise<SessionWork> {
  if (!isWorkIdentity(key)) throw new AgentWorkRequestError('not-found');
  let data: unknown;
  try {
    ({ data } = await client.get(`${workSessionPath(key)}/work`, { signal, timeout: 30_000, ...READ_OPTIONS } as any));
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw classifyReadFailure(error);
  }
  // The gateway has not stored this chat yet (a fresh main session, or a new
  // chat before its first turn lands): the same empty state as a missing one.
  if (isUnstartedSessionWork(data, key)) throw new AgentWorkRequestError('not-found', 200, 'SESSION_NOT_STARTED');
  const work = normalizeSessionWork(data, key);
  // A 200 without the v1 shape is not this API (for example an HTML fallback).
  if (!work) throw new AgentWorkRequestError(record(data)?.v === 1 ? 'unavailable' : 'unsupported', 200);
  return work;
}

export async function fetchAgentActivity(signal?: AbortSignal): Promise<AgentActivity> {
  let data: unknown;
  try {
    ({ data } = await client.get('/agent-work/activity', { signal, timeout: 35_000, ...READ_OPTIONS } as any));
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw classifyReadFailure(error);
  }
  const activity = normalizeActivity(data);
  if (!activity) throw new AgentWorkRequestError(record(data)?.v === 1 ? 'unavailable' : 'unsupported', 200);
  return activity;
}

export type GoalControlAction = 'edit' | 'pause' | 'resume' | 'block' | 'complete' | 'clear';

export type GoalControlBody =
  | { action: 'edit'; goalId: string; operationId: string; issuedAtMs: number; objective: string }
  | { action: 'pause' | 'resume' | 'block' | 'complete'; goalId: string; operationId: string; issuedAtMs: number; note?: string }
  | { action: 'clear'; goalId: string; operationId: string; issuedAtMs: number };

export interface GoalStartBody {
  objective: string;
  idempotencyKey: string;
  issuedAtMs: number;
}

export type GoalMutationOutcome =
  | { kind: 'applied'; goal: SessionGoal | null; replayed: boolean }
  | { kind: 'unconfirmed'; status: number | null; code: string | null }
  | {
    kind: 'rejected';
    status: number;
    code: string;
    reason: string | null;
    /** `undefined` when the response carried no readback. */
    goal: SessionGoal | null | undefined;
  };

/** What chat says while an OpenClaw update holds new work back (`OPENCLAW_EXECUTION_MAINTENANCE`, retryable). */
export const OPENCLAW_MAINTENANCE_NOTICE = 'OpenClaw is being updated. Chat resumes shortly.';

/** Refusals raised before anything reached OpenClaw; they are definitive. */
const ADMISSION_REFUSALS = new Set([
  'OPENCLAW_EXECUTION_MAINTENANCE',
  'OPENCLAW_EXECUTION_RECOVERY_REQUIRED',
  'OPENCLAW_EXECUTION_UNAVAILABLE',
]);

function readbackOf(data: Record<string, any> | null): SessionGoal | null | undefined {
  if (!data || !('goal' in data)) return undefined;
  return normalizeGoal(data.goal);
}

/**
 * The goal routes answer 200 (applied), 202 (unconfirmed) or a closed error. Anything else
 * that could have reached OpenClaw (5xx, timeouts, lost responses) stays unconfirmed so the
 * saved identity can be re-sent unchanged.
 */
export function classifyGoalResponse(status: number | null, body: unknown): GoalMutationOutcome {
  const data = record(body);
  const code = typeof data?.code === 'string' ? data.code : null;
  if (status === 200 && data?.v === 1) {
    return { kind: 'applied', goal: normalizeGoal(data.goal), replayed: record(data.result)?.replayed === true };
  }
  if (status === 202 || data?.outcome === 'unconfirmed') return { kind: 'unconfirmed', status, code };
  if (status === 503 && code && ADMISSION_REFUSALS.has(code)) {
    return { kind: 'rejected', status, code, reason: null, goal: undefined };
  }
  if (status === 404 && data?.v !== 1) return { kind: 'rejected', status, code: 'UNSUPPORTED', reason: null, goal: undefined };
  if (status !== null && [400, 403, 404, 409].includes(status)) {
    return {
      kind: 'rejected',
      status,
      code: code || (status === 403 ? 'FORBIDDEN' : status === 404 ? 'SESSION_NOT_FOUND' : 'GOAL_REJECTED'),
      reason: typeof data?.reason === 'string' ? data.reason : null,
      goal: readbackOf(data),
    };
  }
  return { kind: 'unconfirmed', status, code };
}

async function postGoal(path: string, body: GoalControlBody | GoalStartBody): Promise<GoalMutationOutcome> {
  try {
    const response = await client.post(path, body, {
      timeout: 45_000,
      _silent: true,
      // Nothing is retried automatically; "Check outcome" re-sends the same identity.
      _skipNetworkRetry: true,
    } as any);
    return classifyGoalResponse(response.status, response.data);
  } catch (error) {
    if (error instanceof StaleWorkspaceAuthorizationResponseError) return { kind: 'unconfirmed', status: null, code: null };
    const response = (error as any)?.response;
    return classifyGoalResponse(response ? Number(response.status) : null, response?.data);
  }
}

export function postGoalControl(key: string, body: GoalControlBody): Promise<GoalMutationOutcome> {
  return postGoal(`${workSessionPath(key)}/goal`, body);
}

export function postGoalStart(key: string, body: GoalStartBody): Promise<GoalMutationOutcome> {
  return postGoal(`${workSessionPath(key)}/goal/start`, body);
}

/**
 * Keys the existing session-scoped abort acts on exactly as given. That route maps a `main`
 * or `new-…` name it does not attribute to the caller onto the caller's own conversation, so
 * a Stop on such a row could end a different conversation. Those rows are opened, not stopped.
 */
export function isExactStopKey(key: unknown): key is string {
  if (!isQualifiedSessionKey(key)) return false;
  const name = key.slice(key.indexOf(':', 'agent:'.length) + 1);
  return name !== 'main' && !name.startsWith('new-') && !name.startsWith('portal-new-');
}

/**
 * `stopped`: OpenClaw confirmed it stopped a run in exactly this conversation.
 * `not-confirmed`: nothing was confirmed; it may have finished already or still be running.
 * `elsewhere`: the server reports it acted on a different conversation.
 * `unknown`: no usable answer (network, timeout, server error); the stop may or may not have happened.
 * `unavailable`: not sent, because this conversation cannot be stopped from a list.
 */
export type StopOutcome = 'stopped' | 'not-confirmed' | 'denied' | 'elsewhere' | 'unknown' | 'unavailable';

export function classifyStopResponse(key: string, status: number | null, body: unknown): StopOutcome {
  const data = record(body);
  if (status === 403) return 'denied';
  if (status !== 200 || !data) return 'unknown';
  if (typeof data.sessionKey === 'string' && data.sessionKey !== key) {
    return data.ok === true ? 'elsewhere' : 'not-confirmed';
  }
  return data.ok === true && data.sessionKey === key ? 'stopped' : 'not-confirmed';
}

/** The existing session-scoped stop (`/gateway/chat/abort`), for one exact conversation key. */
export async function postSessionStop(key: string): Promise<StopOutcome> {
  if (!isExactStopKey(key)) return 'unavailable';
  try {
    const response = await client.post('/gateway/chat/abort', { session: key, provider: 'OPENCLAW' }, {
      timeout: 30_000,
      _silent: true,
      // Never repeated automatically: a second session-scoped stop could end newer work.
      _skipNetworkRetry: true,
    } as any);
    return classifyStopResponse(key, response.status, response.data);
  } catch (error) {
    if (error instanceof StaleWorkspaceAuthorizationResponseError) return 'unknown';
    const response = (error as any)?.response;
    return classifyStopResponse(key, response ? Number(response.status) : null, response?.data);
  }
}
