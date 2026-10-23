// @vitest-environment jsdom
import '../../../test/setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyGoalResponse,
  classifyReadFailure,
  classifyStopResponse,
  isExactStopKey,
  isQualifiedSessionKey,
  normalizeActivity,
  normalizeSessionWork,
  workSessionPath,
} from './agentWorkApi';
import {
  canStartGoal,
  canStopRow,
  goalActionStates,
  groupActivity,
  runStatusView,
  sessionDisplayLabel,
} from './agentWorkModel';
import {
  GOAL_OPERATION_STORAGE_PREFIX,
  goalControlBody,
  goalOperationExpired,
  goalStartBody,
  loadGoalOperation,
  newOperationIdentity,
  retireGoalOperation,
  sameGoalRequest,
  saveGoalOperation,
  type SavedGoalOperation,
} from './goalOperationStore';
import { createCoalescedRefresher } from './useAgentWork';
import { clearWorkspaceClientState } from '../../../utils/clearWorkspaceClientState';

const KEY = 'agent:main:portal-11111111-2222-4333-8444-555555555555-new-1';
const row = (key: string, extra: Record<string, unknown> = {}) => ({ kind: 'session', key, label: 'Chat', status: null, ...extra });
const goal = (status = 'active', extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id: 'goal-1', objective: 'Ship it', status, createdAt: 1, updatedAt: 2, tokenStart: 0, tokensUsed: 1200, continuationTurns: 0, ...extra,
});
const work = (extra: Record<string, unknown> = {}) => ({
  v: 1, sessionKey: KEY, fetchedAt: '2026-10-08T15:00:00.000Z', caps: { goals: true, progress: true },
  session: row(KEY, { status: 'running' }), goal: goal(), progress: null, children: [], ...extra,
});

afterEach(() => { vi.useRealTimers(); });

describe('agent-work responses are not trusted blindly', () => {
  it('keeps only a v1 snapshot for the exact key it asked for', () => {
    expect(normalizeSessionWork(work(), KEY)?.session.status).toBe('running');
    expect(normalizeSessionWork({ ...work(), v: 2 }, KEY)).toBeNull();
    expect(normalizeSessionWork(work(), 'agent:main:other')).toBeNull();
    expect(normalizeSessionWork(work({ session: row('agent:main:other') }), KEY)).toBeNull();
    expect(normalizeSessionWork('<!doctype html>', KEY)).toBeNull();
  });
  it('drops malformed children, self-references and caps that are not literally true', () => {
    const parsed = normalizeSessionWork(work({
      caps: { goals: 'yes', progress: 1 },
      children: [row('agent:main:subagent:a', { parentKey: KEY, status: 'queued' }), { key: '' }, row(KEY), 'x', row('bad key')],
    }), KEY)!;
    expect(parsed.caps).toEqual({ goals: false, progress: false });
    expect(parsed.children.map((child) => child.key)).toEqual(['agent:main:subagent:a']);
    expect(parsed.children[0].kind).toBe('subagent');
  });
  it('keeps progress steps but never upgrades an unknown step status', () => {
    const parsed = normalizeSessionWork(work({ progress: { sessionKey: KEY, revision: 3, updatedAt: 5, steps: [
      { step: 'Read', status: 'completed' }, { step: 'Write', status: 'done' }, { step: '', status: 'pending' },
    ] } }), KEY)!;
    expect(parsed.progress?.steps).toEqual([{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'unknown' }]);
  });
  it('separates OWNER automation rows from ordinary activity', () => {
    expect(normalizeActivity({ v: 1, items: [row(KEY)], automation: [row('agent:main:cron:job')] })?.automation).toHaveLength(1);
    expect(normalizeActivity({ v: 1, items: [row(KEY)] })?.automation).toBeNull();
    expect(normalizeActivity({ items: [] })).toBeNull();
  });
  it('accepts only qualified keys and encodes them as one path segment', () => {
    expect(isQualifiedSessionKey('main')).toBe(false);
    expect(isQualifiedSessionKey('new-123')).toBe(false);
    expect(isQualifiedSessionKey(KEY)).toBe(true);
    expect(workSessionPath('agent:main:a/b c')).toBe('/agent-work/sessions/agent%3Amain%3Aa%2Fb%20c');
  });
});

describe('failure classification', () => {
  const failure = (status?: number, data?: unknown) => (status ? { response: { status, data } } : new Error('Network Error'));
  it('treats only the v1 not-found body as a missing conversation', () => {
    expect(classifyReadFailure(failure(404, { v: 1, code: 'SESSION_NOT_FOUND' })).kind).toBe('not-found');
    expect(classifyReadFailure(failure(404, '<html>')).kind).toBe('unsupported');
    expect(classifyReadFailure(failure(403, { error: 'Admin access required' })).kind).toBe('forbidden');
    expect(classifyReadFailure(failure(502, { v: 1, code: 'WORK_UNAVAILABLE' })).kind).toBe('unavailable');
    expect(classifyReadFailure(failure()).kind).toBe('unavailable');
  });
  it('keeps every ambiguous goal answer unconfirmed and every definitive one final', () => {
    expect(classifyGoalResponse(200, { v: 1, result: { replayed: true }, goal: goal('paused') })).toMatchObject({ kind: 'applied', replayed: true, goal: { status: 'paused' } });
    expect(classifyGoalResponse(200, { v: 1, result: {}, goal: null })).toMatchObject({ kind: 'applied', goal: null });
    expect(classifyGoalResponse(202, { v: 1, outcome: 'unconfirmed' }).kind).toBe('unconfirmed');
    expect(classifyGoalResponse(202, { v: 1, status: 202, code: 'GOAL_UNCONFIRMED', outcome: 'unconfirmed', goal: null }).kind).toBe('unconfirmed');
    expect(classifyGoalResponse(502, { v: 1, code: 'WORK_UNAVAILABLE' }).kind).toBe('unconfirmed');
    expect(classifyGoalResponse(503, { v: 1, code: 'SOMETHING_ELSE' }).kind).toBe('unconfirmed');
    expect(classifyGoalResponse(null, undefined).kind).toBe('unconfirmed');
    expect(classifyGoalResponse(200, '<html>').kind).toBe('unconfirmed');
    expect(classifyGoalResponse(503, { v: 1, code: 'OPENCLAW_EXECUTION_MAINTENANCE' })).toMatchObject({ kind: 'rejected', code: 'OPENCLAW_EXECUTION_MAINTENANCE', goal: undefined });
    expect(classifyGoalResponse(409, { v: 1, status: 409, code: 'GOAL_STALE', reason: 'goal-rebound', goal: goal('active', { id: 'goal-2' }) }))
      .toMatchObject({ kind: 'rejected', code: 'GOAL_STALE', reason: 'goal-rebound', goal: { id: 'goal-2' } });
    expect(classifyGoalResponse(409, { v: 1, code: 'GOAL_EXPIRED' })).toMatchObject({ kind: 'rejected', goal: undefined });
    expect(classifyGoalResponse(409, { v: 1, code: 'CHILD_EXECUTION_UNSUPPORTED', error: 'Session work unavailable' })).toMatchObject({ kind: 'rejected', code: 'CHILD_EXECUTION_UNSUPPORTED' });
    expect(classifyGoalResponse(404, '<html>')).toMatchObject({ kind: 'rejected', code: 'UNSUPPORTED' });
    expect(classifyGoalResponse(403, { error: 'Admin access required' })).toMatchObject({ kind: 'rejected', code: 'FORBIDDEN' });
  });
});

describe('status presentation', () => {
  it('shows upstream status as reported and never turns idle into finished', () => {
    expect(runStatusView(null)).toEqual({ tone: 'idle', label: 'Idle' });
    expect(runStatusView('done').label).toBe('Finished');
    expect(runStatusView('queued')).toEqual({ tone: 'waiting', label: 'Waiting to start' });
    expect(runStatusView('timeout').tone).toBe('failed');
    expect(runStatusView('killed')).toEqual({ tone: 'stopped', label: 'Stopped' });
    expect(runStatusView('paused-for-review')).toEqual({ tone: 'unknown', label: 'paused-for-review' });
  });
  it('offers only the goal controls the status allows', () => {
    const base = { supported: true, isChild: false, busy: false, operationBlocked: false };
    const visible = (status: string, context = base) => Object.entries(goalActionStates(normalizeSessionWork(work({ goal: goal(status) }), KEY)!.goal!, context))
      .filter(([, state]) => state.visible).map(([action]) => action);
    expect(visible('active')).toEqual(['edit', 'pause', 'block', 'complete', 'clear']);
    expect(visible('paused')).toEqual(['edit', 'resume', 'block', 'complete', 'clear']);
    expect(visible('budget_limited')).toEqual(['edit', 'resume', 'complete', 'clear']);
    expect(visible('complete')).toEqual(['clear']);
    expect(visible('paused', { ...base, isChild: true })).not.toContain('resume');
    const busy = goalActionStates(normalizeSessionWork(work({ goal: goal('paused') }), KEY)!.goal!, { ...base, busy: true });
    expect(busy.resume.disabledReason).toBe('Available when the agent is idle.');
    expect(busy.pause.visible).toBe(false);
    const unsupported = goalActionStates(normalizeSessionWork(work({ goal: goal('active') }), KEY)!.goal!, { ...base, supported: false });
    expect(unsupported.pause.disabledReason).toMatch(/not available/);
  });
  it('never offers goal start on a sub-agent, an existing goal or without the capability', () => {
    const none = normalizeSessionWork(work({ goal: null }), KEY);
    const context = { isChild: false, busy: false, operationBlocked: false };
    expect(canStartGoal(none, context)).toEqual({ visible: true, disabledReason: null });
    expect(canStartGoal(none, { ...context, isChild: true }).visible).toBe(false);
    expect(canStartGoal(normalizeSessionWork(work(), KEY), context).visible).toBe(false);
    expect(canStartGoal(normalizeSessionWork(work({ goal: null, caps: { goals: false, progress: true } }), KEY), context).visible).toBe(false);
    expect(canStartGoal(none, { ...context, busy: true }).disabledReason).toBe('Available when the agent is idle.');
  });
  it('groups other conversations without the current one, its children or day-old failures', () => {
    const now = Date.UTC(2026, 9, 8, 16);
    const rows = normalizeActivity({ v: 1, items: [
      row(KEY, { status: 'running' }),
      row('agent:main:subagent:child', { status: 'running', parentKey: KEY }),
      row('agent:main:a', { status: 'running', updatedAt: now - 1000 }),
      row('agent:main:b', { status: 'queued', updatedAt: now - 2000 }),
      row('agent:main:c', { status: 'failed', updatedAt: now - 60_000 }),
      row('agent:main:d', { status: 'failed', updatedAt: now - 2 * 86_400_000 }),
      row('agent:main:e', { status: null, updatedAt: now - 5000 }),
    ] })!.items;
    const groups = groupActivity(rows, new Set([KEY, 'agent:main:subagent:child']), now);
    expect(groups.attention.map((item) => item.key)).toEqual(['agent:main:c']);
    expect(groups.running.map((item) => item.key)).toEqual(['agent:main:a']);
    expect(groups.waiting.map((item) => item.key)).toEqual(['agent:main:b']);
    expect(groups.recent.map((item) => item.key)).toEqual(['agent:main:e', 'agent:main:d']);
  });
  it('does not use a session key as a human title', () => {
    expect(sessionDisplayLabel({ key: 'agent:main:subagent:abc-123456', label: 'agent:main:subagent:abc-123456', kind: 'subagent' })).toBe('Sub-agent · 123456');
    expect(sessionDisplayLabel({ key: 'agent:ops:cron:nightly', label: 'agent:ops:cron:nightly', kind: 'session' })).toBe('Automation run · ops · ightly');
    expect(sessionDisplayLabel({ key: KEY, label: 'Portal · deploy sk-ant-abcdefghijklmnopqrstuvwx', kind: 'session' })).toBe('Portal · deploy ••••••');
  });
});

describe('saved goal operations', () => {
  const USER = 'user-1';
  const op = (extra: Partial<SavedGoalOperation> = {}): SavedGoalOperation => ({
    v: 1, sessionKey: KEY, action: 'pause', goalId: 'goal-1', identity: newOperationIdentity(), issuedAtMs: Date.now(), ...extra,
  });
  it('mints a fresh UUID identity per action and round-trips it per user and conversation', () => {
    const first = op();
    expect(first.identity).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(op().identity).not.toBe(first.identity);
    expect(saveGoalOperation(USER, first)).toBe(true);
    expect(loadGoalOperation(USER, KEY)).toEqual(first);
    expect(loadGoalOperation('user-2', KEY)).toBeNull();
    expect(loadGoalOperation(USER, 'agent:main:other')).toBeNull();
  });
  it('drops unreadable or reshaped records instead of sending them', () => {
    const storageKey = `${GOAL_OPERATION_STORAGE_PREFIX}${JSON.stringify([USER, KEY])}`;
    window.sessionStorage.setItem(storageKey, JSON.stringify({ ...op(), identity: 'not-a-uuid' }));
    expect(loadGoalOperation(USER, KEY)).toBeNull();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    window.sessionStorage.setItem(storageKey, JSON.stringify({ ...op({ action: 'edit' }) }));
    expect(loadGoalOperation(USER, KEY)).toBeNull();
  });
  it('retires only the operation it settled', () => {
    const older = op();
    const newer = op({ action: 'resume' });
    saveGoalOperation(USER, newer);
    retireGoalOperation(USER, older);
    expect(loadGoalOperation(USER, KEY)?.identity).toBe(newer.identity);
    retireGoalOperation(USER, newer);
    expect(loadGoalOperation(USER, KEY)).toBeNull();
  });
  it('builds closed request bodies from the saved identity, unchanged', () => {
    const pause = op();
    expect(goalControlBody(pause)).toEqual({ action: 'pause', goalId: 'goal-1', operationId: pause.identity, issuedAtMs: pause.issuedAtMs });
    expect(goalControlBody(op({ action: 'block', note: 'waiting on CI' }))).toMatchObject({ action: 'block', note: 'waiting on CI' });
    expect(goalControlBody(op({ action: 'clear', note: 'ignored' }))).not.toHaveProperty('note');
    expect(goalControlBody(op({ action: 'edit', objective: 'New' }))).toMatchObject({ action: 'edit', objective: 'New' });
    const start = op({ action: 'start', goalId: null, objective: 'Do it' });
    expect(goalStartBody(start)).toEqual({ objective: 'Do it', idempotencyKey: start.identity, issuedAtMs: start.issuedAtMs });
    expect(goalControlBody(start)).toBeNull();
  });
  it('matches retries exactly and expires before the 24 hour receipt window closes', () => {
    const saved = op({ action: 'edit', objective: 'A' });
    expect(sameGoalRequest(saved, { action: 'edit', goalId: 'goal-1', objective: 'A' })).toBe(true);
    expect(sameGoalRequest(saved, { action: 'edit', goalId: 'goal-1', objective: 'B' })).toBe(false);
    expect(sameGoalRequest(saved, { action: 'edit', goalId: 'goal-2', objective: 'A' })).toBe(false);
    const now = Date.now();
    expect(goalOperationExpired({ issuedAtMs: now - 23 * 3_600_000 }, now)).toBe(false);
    expect(goalOperationExpired({ issuedAtMs: now - 24 * 3_600_000 + 30_000 }, now)).toBe(true);
  });
  it('is scrubbed with the rest of the workspace state on sign-out', () => {
    saveGoalOperation(USER, op());
    window.sessionStorage.setItem('unrelated', 'kept');
    clearWorkspaceClientState(window.localStorage, window.sessionStorage);
    expect(loadGoalOperation(USER, KEY)).toBeNull();
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
  });
});

describe('signal coalescing', () => {
  it('turns a burst of signals into one read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = vi.fn(async () => undefined);
    const refresher = createCoalescedRefresher(run);
    refresher.request(); refresher.request(); refresher.request();
    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    refresher.dispose();
  });
  it('cannot be starved by a steady stream of signals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = vi.fn(async () => undefined);
    const refresher = createCoalescedRefresher(run);
    for (let elapsed = 0; elapsed < 1000; elapsed += 200) {
      refresher.request();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(run).toHaveBeenCalledTimes(1);
    refresher.dispose();
  });
  it('never overlaps reads and follows an in-flight read with exactly one more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const refresher = createCoalescedRefresher(run);
    refresher.request(true);
    await vi.advanceTimersByTimeAsync(0);
    refresher.request(); refresher.request();
    await vi.advanceTimersByTimeAsync(300);
    refresher.request();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    refresher.dispose();
  });
});

describe('stopping chosen work', () => {
  const CHILD = 'agent:main:subagent:aaaa-111111';
  it('stops only keys the abort route uses exactly as given', () => {
    for (const key of [CHILD, KEY, 'agent:main:dashboard:c9beac29', 'agent:ops:telegram:direct:42']) expect(isExactStopKey(key)).toBe(true);
    // The route maps these names onto the caller's own conversation when it does not attribute them to the caller.
    for (const key of ['agent:main:main', 'agent:ops:new-1700000000', 'agent:main:portal-new-1700000000']) expect(isExactStopKey(key)).toBe(false);
    for (const key of ['main', 'new-1', '', 'agent:main:sub agent', undefined, 42]) expect(isExactStopKey(key)).toBe(false);
  });
  it('offers Stop only for running or waiting work outside automation', () => {
    expect(canStopRow({ key: CHILD, status: 'running' })).toBe(true);
    expect(canStopRow({ key: CHILD, status: 'queued' })).toBe(true);
    for (const status of ['done', 'failed', 'killed', 'timeout', 'interrupted', null, 'mystery']) {
      expect(canStopRow({ key: CHILD, status })).toBe(false);
    }
    expect(canStopRow({ key: 'agent:main:cron:job-1:run:r1', status: 'running' })).toBe(false);
    expect(canStopRow({ key: 'agent:main:main', status: 'running' })).toBe(false);
  });
  it('counts only a confirmation that names the exact key as stopped', () => {
    const other = 'agent:main:portal-11111111-2222-4333-8444-555555555555';
    expect(classifyStopResponse(CHILD, 200, { ok: true, sessionKey: CHILD, runIds: ['run-1'] })).toBe('stopped');
    expect(classifyStopResponse(CHILD, 200, { ok: false, sessionKey: CHILD, runIds: [] })).toBe('not-confirmed');
    expect(classifyStopResponse(CHILD, 200, { ok: true })).toBe('not-confirmed');
    expect(classifyStopResponse(CHILD, 200, { ok: 'true', sessionKey: CHILD })).toBe('not-confirmed');
    expect(classifyStopResponse(CHILD, 200, { ok: true, sessionKey: other })).toBe('elsewhere');
    expect(classifyStopResponse(CHILD, 200, { ok: false, sessionKey: other })).toBe('not-confirmed');
    expect(classifyStopResponse(CHILD, 403, { error: 'Admin access required' })).toBe('denied');
    expect(classifyStopResponse(CHILD, 500, { error: 'Abort failed' })).toBe('unknown');
    expect(classifyStopResponse(CHILD, null, undefined)).toBe('unknown');
    expect(classifyStopResponse(CHILD, 200, '<!doctype html>')).toBe('unknown');
  });
});
