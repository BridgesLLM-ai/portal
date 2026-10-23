import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import { resolveOwnedNativeSession } from '../agents/chatBridge/nativeSessionOwnership';
import { loadNativeSessionMetadata, nativeChatBridgeWidgetDirectory } from '../agents/providers/NativeSessionStore';
import { publishSessionWorkChanged } from './openClawSessionWork';
import { streamEventBus } from './StreamEventBus';

/**
 * Agent Work for native (non-OpenClaw) Agent Chat harnesses.
 *
 * OpenClaw owns goals natively. Native harnesses get a Portal-managed goal: the
 * objective lives beside the session, the agent reads/settles it through the
 * Portal Chat Bridge (`get_goal`, `update_goal`), and after each settled turn
 * the Portal continues an active goal with a bounded number of automatic turns.
 * Every automatic turn is dispatched through the same host-operator path as a
 * browser message, re-checking the actor's current authorization.
 */

export const NATIVE_GOAL_MAX_AUTO_TURNS = 8;
const CONTINUE_DELAY_MS = 1_500;
const OBJECTIVE_MAX = 16_000;
const NOTE_MAX = 2_000;
const GOAL_FILE = 'goal.json';

/** Harnesses that load the bridge, so the agent can actually settle its goal. */
const GOAL_CAPABLE: ReadonlySet<AgentProviderName> = new Set<AgentProviderName>([
  'CLAUDE_CODE', 'CODEX', 'GROK', 'HERMES', 'OPENCODE', 'OLLAMA',
]);

export type NativeGoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'complete';

export interface NativeGoal {
  id: string;
  provider: AgentProviderName;
  sessionId: string;
  ownerUserId: string;
  objective: string;
  status: NativeGoalStatus;
  createdAt: number;
  updatedAt: number;
  lastStatusNote: string | null;
  autoTurns: number;
}

export type NativeGoalDispatchResult = 'started' | 'busy' | 'refused';
export type NativeGoalDispatcher = (input: {
  provider: AgentProviderName;
  sessionId: string;
  userId: string;
  message: string;
}) => Promise<NativeGoalDispatchResult>;
export type NativeRunProbe = (provider: AgentProviderName, sessionId: string) => boolean;

let dispatcher: NativeGoalDispatcher | null = null;
const defaultRunProbe: NativeRunProbe = (_provider, sessionId) => streamEventBus.getStreamStatus(sessionId) !== null;
let runProbe: NativeRunProbe = defaultRunProbe;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function registerNativeGoalDispatcher(fn: NativeGoalDispatcher | null): void { dispatcher = fn; }
export function registerNativeRunProbe(fn: NativeRunProbe): void { runProbe = fn; }

export class NativeWorkError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function goalPath(provider: AgentProviderName, sessionId: string): string {
  return path.join(nativeChatBridgeWidgetDirectory(provider, sessionId), GOAL_FILE);
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

export function readNativeGoal(provider: AgentProviderName, sessionId: string): NativeGoal | null {
  let raw: string;
  try {
    const file = goalPath(provider, sessionId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || value.provider !== provider || value.sessionId !== sessionId || typeof value.id !== 'string') return null;
    if (!['active', 'paused', 'blocked', 'usage_limited', 'complete'].includes(value.status)) return null;
    return {
      id: value.id,
      provider,
      sessionId,
      ownerUserId: String(value.ownerUserId || ''),
      objective: clean(value.objective, OBJECTIVE_MAX),
      status: value.status,
      createdAt: Number(value.createdAt) || 0,
      updatedAt: Number(value.updatedAt) || 0,
      lastStatusNote: typeof value.lastStatusNote === 'string' ? clean(value.lastStatusNote, NOTE_MAX) : null,
      autoTurns: Number.isSafeInteger(value.autoTurns) ? value.autoTurns : 0,
    };
  } catch {
    return null;
  }
}

function writeNativeGoal(goal: NativeGoal): void {
  const file = goalPath(goal.provider, goal.sessionId);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let current = directory, depth = 0; depth < 3; depth += 1, current = path.dirname(current)) {
    if ((fs.statSync(current).mode & 0o777) !== 0o700) fs.chmodSync(current, 0o700);
  }
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(goal)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function deleteNativeGoal(provider: AgentProviderName, sessionId: string): void {
  try { fs.unlinkSync(goalPath(provider, sessionId)); } catch { /* absent */ }
}

function changed(sessionId: string): void {
  publishSessionWorkChanged(sessionId, ['goal', 'status']);
}

function timerKey(provider: AgentProviderName, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function cancelContinuation(provider: AgentProviderName, sessionId: string): void {
  const key = timerKey(provider, sessionId);
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

function setStatus(goal: NativeGoal, status: NativeGoalStatus, note: string | null): NativeGoal {
  const next = { ...goal, status, lastStatusNote: note, updatedAt: Date.now() };
  writeNativeGoal(next);
  if (status !== 'active') cancelContinuation(goal.provider, goal.sessionId);
  changed(goal.sessionId);
  return next;
}

const GOAL_INSTRUCTIONS = '[Portal goal] Work toward this goal across turns; the Portal will prompt you to continue. '
  + 'When it is fully achieved, call the update_goal tool with status "complete" and a one-line note. '
  + 'If you cannot continue without the user, call update_goal with status "blocked" and say what you need.';

export function goalStartMessage(objective: string): string {
  return `${objective}\n\n${GOAL_INSTRUCTIONS}`;
}

export function goalContinueMessage(goal: NativeGoal): string {
  return `[Portal goal — continue] Objective: ${goal.objective}\n\n${GOAL_INSTRUCTIONS}`;
}

async function dispatch(goal: NativeGoal, message: string): Promise<void> {
  if (!dispatcher) {
    setStatus(goal, 'blocked', 'The Portal could not start the next turn.');
    return;
  }
  let result: NativeGoalDispatchResult;
  try {
    result = await dispatcher({ provider: goal.provider, sessionId: goal.sessionId, userId: goal.ownerUserId, message });
  } catch {
    result = 'refused';
  }
  if (result === 'refused') {
    const current = readNativeGoal(goal.provider, goal.sessionId);
    if (current?.id === goal.id && current.status === 'active') {
      setStatus(current, 'blocked', 'The Portal could not start the next turn (authorization or runtime unavailable).');
    }
  }
  // 'busy': the running turn's own settlement continues the goal.
}

function scheduleContinuation(provider: AgentProviderName, sessionId: string): void {
  const key = timerKey(provider, sessionId);
  if (timers.has(key)) return;
  const timer = setTimeout(() => {
    timers.delete(key);
    const goal = readNativeGoal(provider, sessionId);
    if (!goal || goal.status !== 'active' || runProbe(provider, sessionId)) return;
    if (goal.autoTurns >= NATIVE_GOAL_MAX_AUTO_TURNS) {
      setStatus(goal, 'usage_limited', `Stopped after ${NATIVE_GOAL_MAX_AUTO_TURNS} automatic turns. Resume to continue.`);
      return;
    }
    const next = { ...goal, autoTurns: goal.autoTurns + 1, updatedAt: Date.now() };
    writeNativeGoal(next);
    void dispatch(next, goalContinueMessage(next));
  }, CONTINUE_DELAY_MS);
  timer.unref?.();
  timers.set(key, timer);
}

/** Called once for every settled native host turn (browser or goal initiated). */
export function notifyNativeTurnSettled(input: {
  provider: AgentProviderName;
  sessionId: string;
  outcome: 'success' | 'error' | 'aborted';
  errorText?: string;
}): void {
  if (input.provider === ('OPENCLAW' as AgentProviderName)) return;
  let goal: NativeGoal | null;
  try { goal = readNativeGoal(input.provider, input.sessionId); } catch { return; }
  if (!goal) return;
  changed(input.sessionId);
  if (goal.status !== 'active') return;
  if (input.outcome === 'aborted') {
    setStatus(goal, 'paused', 'Paused because the run was stopped.');
    return;
  }
  if (input.outcome === 'error') {
    setStatus(goal, 'blocked', clean(`The last turn failed: ${input.errorText || 'agent error'}`, NOTE_MAX));
    return;
  }
  scheduleContinuation(input.provider, input.sessionId);
}

function publicGoal(goal: NativeGoal | null) {
  if (!goal) return null;
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    tokensUsed: null,
    tokenBudget: null,
    lastStatusNote: goal.lastStatusNote,
  };
}

function ownedOrThrow(key: string, actorUserId: string) {
  const owned = resolveOwnedNativeSession(key, actorUserId);
  if (!owned) throw new NativeWorkError(404, 'SESSION_NOT_FOUND');
  return owned;
}

export function isNativeWorkSessionKey(key: unknown, actorUserId: string): boolean {
  return resolveOwnedNativeSession(key, actorUserId) !== null;
}

/** Same `SessionWork` shape the OpenClaw route returns. */
export function readNativeSessionWork(key: string, actorUserId: string) {
  const owned = ownedOrThrow(key, actorUserId);
  const session = loadNativeSessionMetadata(owned.provider, owned.sessionId);
  if (!session) throw new NativeWorkError(404, 'SESSION_NOT_FOUND');
  const running = runProbe(owned.provider, owned.sessionId);
  const updatedAt = Date.parse(session.lastActivityAt) || null;
  const label = session.historyFirstUserMessage || 'Conversation';
  return {
    v: 1,
    sessionKey: key,
    fetchedAt: new Date().toISOString(),
    caps: { goals: GOAL_CAPABLE.has(owned.provider), progress: false },
    session: {
      kind: 'session',
      key,
      parentKey: null,
      label: label.length > 80 ? `${label.slice(0, 79)}…` : label,
      status: running ? 'running' : null,
      updatedAt,
      lastRunError: null,
      subagentRole: null,
      spawnDepth: null,
    },
    goal: GOAL_CAPABLE.has(owned.provider) ? publicGoal(readNativeGoal(owned.provider, owned.sessionId)) : null,
    progress: null,
    children: [],
    swarm: null,
  };
}

export async function startNativeGoal(input: { key: string; actorUserId: string; objective: string }) {
  const owned = ownedOrThrow(input.key, input.actorUserId);
  if (!GOAL_CAPABLE.has(owned.provider)) throw new NativeWorkError(409, 'GOAL_UNSUPPORTED');
  const objective = clean(input.objective, OBJECTIVE_MAX);
  if (!objective) throw new NativeWorkError(400, 'GOAL_INVALID');
  const existing = readNativeGoal(owned.provider, owned.sessionId);
  if (existing && existing.status !== 'complete') throw new NativeWorkError(409, 'GOAL_EXISTS');
  if (runProbe(owned.provider, owned.sessionId)) throw new NativeWorkError(409, 'SESSION_BUSY');
  const now = Date.now();
  const goal: NativeGoal = {
    id: `ng_${crypto.randomBytes(12).toString('hex')}`,
    provider: owned.provider,
    sessionId: owned.sessionId,
    ownerUserId: input.actorUserId,
    objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastStatusNote: null,
    autoTurns: 0,
  };
  writeNativeGoal(goal);
  changed(owned.sessionId);
  await dispatch(goal, goalStartMessage(objective));
  return publicGoal(readNativeGoal(owned.provider, owned.sessionId));
}

export async function controlNativeGoal(input: {
  key: string;
  actorUserId: string;
  action: 'edit' | 'pause' | 'resume' | 'block' | 'complete' | 'clear';
  goalId: string;
  objective?: string;
  note?: string;
}) {
  const owned = ownedOrThrow(input.key, input.actorUserId);
  if (!GOAL_CAPABLE.has(owned.provider)) throw new NativeWorkError(409, 'GOAL_UNSUPPORTED');
  const goal = readNativeGoal(owned.provider, owned.sessionId);
  if (!goal || goal.id !== input.goalId) throw new NativeWorkError(409, 'GOAL_STALE');
  const note = clean(input.note, NOTE_MAX) || null;
  switch (input.action) {
    case 'clear':
      cancelContinuation(goal.provider, goal.sessionId);
      deleteNativeGoal(goal.provider, goal.sessionId);
      changed(goal.sessionId);
      return null;
    case 'edit': {
      const objective = clean(input.objective, OBJECTIVE_MAX);
      if (!objective) throw new NativeWorkError(400, 'GOAL_INVALID');
      const next = { ...goal, objective, updatedAt: Date.now() };
      writeNativeGoal(next);
      changed(goal.sessionId);
      return publicGoal(next);
    }
    case 'pause':
      if (goal.status !== 'active') throw new NativeWorkError(409, 'GOAL_REJECTED');
      return publicGoal(setStatus(goal, 'paused', note));
    case 'block':
      return publicGoal(setStatus(goal, 'blocked', note));
    case 'complete':
      return publicGoal(setStatus(goal, 'complete', note));
    case 'resume': {
      if (!['paused', 'blocked', 'usage_limited'].includes(goal.status)) throw new NativeWorkError(409, 'GOAL_REJECTED');
      const next = { ...goal, status: 'active' as const, autoTurns: 0, lastStatusNote: null, updatedAt: Date.now() };
      writeNativeGoal(next);
      changed(goal.sessionId);
      if (!runProbe(goal.provider, goal.sessionId)) await dispatch(next, goalContinueMessage(next));
      return publicGoal(readNativeGoal(goal.provider, goal.sessionId));
    }
    default:
      throw new NativeWorkError(400, 'GOAL_INVALID');
  }
}

/** Bridge tool `get_goal`. */
export function describeGoalForAgent(provider: AgentProviderName, sessionId: string): { text: string; isError: boolean } {
  const goal = readNativeGoal(provider, sessionId);
  if (!goal) return { text: 'No Portal goal is set for this conversation.', isError: false };
  return {
    text: JSON.stringify({ objective: goal.objective, status: goal.status, note: goal.lastStatusNote }),
    isError: false,
  };
}

/** Bridge tool `update_goal`: the agent may only complete or block its own active goal. */
export function settleGoalFromAgent(
  provider: AgentProviderName,
  sessionId: string,
  args: unknown,
): { text: string; isError: boolean } {
  const goal = readNativeGoal(provider, sessionId);
  if (!goal) return { text: 'No Portal goal is set for this conversation.', isError: true };
  const value = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const status = value.status;
  if (status !== 'complete' && status !== 'blocked') {
    return { text: 'update_goal status must be "complete" or "blocked".', isError: true };
  }
  if (goal.status !== 'active') {
    return { text: `The goal is ${goal.status}; only an active goal can be updated by the agent.`, isError: true };
  }
  setStatus(goal, status, clean(value.note, NOTE_MAX) || null);
  return { text: status === 'complete' ? 'Goal marked complete.' : 'Goal marked blocked.', isError: false };
}

/** A restart ends every in-flight run; an "active" goal would otherwise look alive. */
export function pauseNativeGoalsAfterRestart(root: string): void {
  let providers: string[];
  try { providers = fs.readdirSync(root); } catch { return; }
  for (const providerDir of providers) {
    let sessions: string[];
    try { sessions = fs.readdirSync(path.join(root, providerDir)); } catch { continue; }
    for (const sessionId of sessions) {
      const provider = providerDir.toUpperCase() as AgentProviderName;
      try {
        const goal = readNativeGoal(provider, sessionId);
        if (goal?.status === 'active') setStatus(goal, 'paused', 'Paused when the Portal restarted. Resume to continue.');
      } catch { /* unreadable entries are left alone */ }
    }
  }
}

export function __resetNativeSessionWorkForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  dispatcher = null;
  runProbe = defaultRunProbe;
}
