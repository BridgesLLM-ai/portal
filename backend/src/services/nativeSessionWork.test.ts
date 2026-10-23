import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-work-test-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(tempRoot, 'sessions');

/* eslint-disable @typescript-eslint/no-var-requires */
const work = require('./nativeSessionWork') as typeof import('./nativeSessionWork');
const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
/* eslint-enable @typescript-eslint/no-var-requires */

type Dispatch = Parameters<typeof work.registerNativeGoalDispatcher>[0];

function session(provider: 'CODEX' | 'GEMINI', userId = 'owner-1') {
  return store.createNativeSession(provider, userId, {
    executionContext: { scope: 'HOST_OPERATOR', source: 'PORTAL_SERVER', userId },
    metadata: { cwd: tempRoot },
  });
}

let dispatched: Array<{ message: string; userId: string }>;
let busy: boolean;

beforeEach(() => {
  jest.useFakeTimers();
  work.__resetNativeSessionWorkForTests();
  dispatched = [];
  busy = false;
  const dispatcher: Dispatch = async (input) => {
    dispatched.push({ message: input.message, userId: input.userId });
    return 'started';
  };
  work.registerNativeGoalDispatcher(dispatcher);
  work.registerNativeRunProbe(() => busy);
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('Portal-managed native goals', () => {
  it('reads native work in the OpenClaw SessionWork shape', () => {
    const codex = session('CODEX');
    const view = work.readNativeSessionWork(codex.sessionId, 'owner-1');
    expect(view).toMatchObject({ v: 1, sessionKey: codex.sessionId, caps: { goals: true, progress: false },
      goal: null, progress: null, children: [], swarm: null });
    expect(view.session).toMatchObject({ kind: 'session', key: codex.sessionId, parentKey: null, status: null });
    expect(() => work.readNativeSessionWork(codex.sessionId, 'someone-else')).toThrow(work.NativeWorkError);
    const gemini = session('GEMINI');
    expect(work.readNativeSessionWork(gemini.sessionId, 'owner-1').caps.goals).toBe(false);
  });

  it('starts, continues a bounded number of turns, and stops at the usage limit', async () => {
    const codex = session('CODEX');
    const goal = await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Ship the report' });
    expect(goal).toMatchObject({ status: 'active', objective: 'Ship the report' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].message).toContain('Ship the report');
    expect(dispatched[0].message).toContain('update_goal');
    await expect(work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Another' }))
      .rejects.toMatchObject({ code: 'GOAL_EXISTS' });

    for (let turn = 1; turn <= work.NATIVE_GOAL_MAX_AUTO_TURNS; turn += 1) {
      work.notifyNativeTurnSettled({ provider: 'CODEX', sessionId: codex.sessionId, outcome: 'success' });
      await jest.advanceTimersByTimeAsync(2_000);
      expect(dispatched).toHaveLength(1 + turn);
      expect(dispatched[turn].message).toMatch(/^\[Portal goal — continue\] Objective: Ship the report/);
    }
    work.notifyNativeTurnSettled({ provider: 'CODEX', sessionId: codex.sessionId, outcome: 'success' });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(dispatched).toHaveLength(1 + work.NATIVE_GOAL_MAX_AUTO_TURNS);
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toMatchObject({ status: 'usage_limited' });

    const resumed = await work.controlNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', action: 'resume', goalId: goal!.id });
    expect(resumed).toMatchObject({ status: 'active' });
    expect(work.readNativeGoal('CODEX', codex.sessionId)!.autoTurns).toBe(0);
    expect(dispatched).toHaveLength(2 + work.NATIVE_GOAL_MAX_AUTO_TURNS);
  });

  it('lets the agent settle its own goal and never continues a settled one', async () => {
    const codex = session('CODEX');
    await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Fix the bug' });
    expect(work.describeGoalForAgent('CODEX', codex.sessionId).text).toContain('Fix the bug');
    expect(work.settleGoalFromAgent('CODEX', codex.sessionId, { status: 'paused' }).isError).toBe(true);
    expect(work.settleGoalFromAgent('CODEX', codex.sessionId, { status: 'complete', note: 'Patched and tested' }))
      .toEqual({ text: 'Goal marked complete.', isError: false });
    work.notifyNativeTurnSettled({ provider: 'CODEX', sessionId: codex.sessionId, outcome: 'success' });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(dispatched).toHaveLength(1);
    expect(work.readNativeSessionWork(codex.sessionId, 'owner-1').goal)
      .toMatchObject({ status: 'complete', lastStatusNote: 'Patched and tested' });
    // A completed goal may be replaced.
    await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Next goal' });
    expect(dispatched).toHaveLength(2);
  });

  it('pauses on a stopped run, blocks on failure, and waits while a run is active', async () => {
    const codex = session('CODEX');
    await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Long task' });
    work.notifyNativeTurnSettled({ provider: 'CODEX', sessionId: codex.sessionId, outcome: 'aborted' });
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toMatchObject({ status: 'paused' });

    const goalId = work.readNativeGoal('CODEX', codex.sessionId)!.id;
    busy = true;
    await work.controlNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', action: 'resume', goalId });
    expect(dispatched).toHaveLength(1);
    work.notifyNativeTurnSettled({ provider: 'CODEX', sessionId: codex.sessionId, outcome: 'success' });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(dispatched).toHaveLength(1);
    busy = false;
    work.notifyNativeTurnSettled({ provider: 'CODEX', sessionId: codex.sessionId, outcome: 'error', errorText: 'quota' });
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toMatchObject({ status: 'blocked' });
    expect(work.readNativeGoal('CODEX', codex.sessionId)!.lastStatusNote).toContain('quota');
  });

  it('marks the goal blocked when the next turn is refused', async () => {
    const codex = session('CODEX');
    work.registerNativeGoalDispatcher(async () => 'refused');
    await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Anything' });
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toMatchObject({ status: 'blocked' });
  });

  it('refuses goals on harnesses that cannot settle them, and stale or foreign controls', async () => {
    const gemini = session('GEMINI');
    await expect(work.startNativeGoal({ key: gemini.sessionId, actorUserId: 'owner-1', objective: 'x' }))
      .rejects.toMatchObject({ code: 'GOAL_UNSUPPORTED' });
    const codex = session('CODEX');
    await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'x' });
    await expect(work.controlNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', action: 'pause', goalId: 'ng_other' }))
      .rejects.toMatchObject({ code: 'GOAL_STALE' });
    await expect(work.controlNativeGoal({ key: codex.sessionId, actorUserId: 'intruder', action: 'clear', goalId: 'x' }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    const goalId = work.readNativeGoal('CODEX', codex.sessionId)!.id;
    expect(await work.controlNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', action: 'clear', goalId })).toBeNull();
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toBeNull();
  });

  it('pauses active goals after a Portal restart and removes them with the session', async () => {
    const codex = session('CODEX');
    await work.startNativeGoal({ key: codex.sessionId, actorUserId: 'owner-1', objective: 'Survive restart' });
    work.pauseNativeGoalsAfterRestart(store.nativeChatBridgeRootDirectory());
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toMatchObject({ status: 'paused' });
    store.deleteNativeSession('CODEX', codex.sessionId);
    expect(work.readNativeGoal('CODEX', codex.sessionId)).toBeNull();
  });
});
