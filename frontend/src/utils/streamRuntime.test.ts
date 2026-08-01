import { describe, expect, it } from 'vitest';
import {
  EMPTY_CUMULATIVE_SNAPSHOT_CURSOR,
  appendCumulativeSnapshotDelta,
  beginCumulativeSnapshotSegment,
  createLatestCallbackDispatcher,
  getVisibleSilenceStatus,
  reconcileCumulativeSnapshot,
  reconcileRunEpoch,
  recordStreamActivity,
  scheduleLatestCallback,
} from './streamRuntime';
import type { RunEpochState } from './streamRuntime';

describe('run continuation epochs', () => {
  it('adopts a verified continuation and rejects a late terminal from the old run', () => {
    const activeOld = {
      currentRunId: 'run-old',
      retiredRunIds: [],
    };
    const continuation = reconcileRunEpoch(activeOld, {
      incomingRunId: 'run-new',
      streamActive: true,
      continuationVerified: true,
      now: 1_000,
    });

    expect(continuation.decision).toBe('adopt');
    expect(continuation.state.currentRunId).toBe('run-new');
    expect(continuation.state.retiredRunIds.map((entry) => entry.runId)).toEqual(['run-old']);

    const lateOldTerminal = reconcileRunEpoch(continuation.state, {
      incomingRunId: 'run-old',
      streamActive: true,
      now: 2_000,
    });
    expect(lateOldTerminal.decision).toBe('reject');
    expect(lateOldTerminal.state.currentRunId).toBe('run-new');
  });

  it('rejects an unverified run switch', () => {
    const result = reconcileRunEpoch({ currentRunId: 'run-old', retiredRunIds: [] }, {
      incomingRunId: 'run-new',
      streamActive: true,
      continuationVerified: false,
      now: 1_000,
    });
    expect(result.decision).toBe('reject');
    expect(result.state.currentRunId).toBe('run-old');
  });
});

describe('direct cumulative snapshots', () => {
  it('renders a post-tool snapshot reset instead of slicing it at the old cursor', () => {
    const beforeTool = reconcileCumulativeSnapshot(
      EMPTY_CUMULATIVE_SNAPSHOT_CURSOR,
      'I will inspect the service.',
    );
    const afterToolBoundary = beginCumulativeSnapshotSegment(beforeTool.cursor);

    const reset = reconcileCumulativeSnapshot(afterToolBoundary, 'The service is fixed.');
    expect(reset.reset).toBe(true);
    expect(reset.segmentText).toBe('The service is fixed.');

    const continuation = reconcileCumulativeSnapshot(reset.cursor, 'The service is fixed. Health checks pass.');
    expect(continuation.reset).toBe(false);
    expect(continuation.segmentText).toBe('The service is fixed. Health checks pass.');
  });

  it('continues slicing true cumulative snapshots after a tool boundary', () => {
    const beforeTool = reconcileCumulativeSnapshot(
      EMPTY_CUMULATIVE_SNAPSHOT_CURSOR,
      'Before tool.',
    );
    const boundary = beginCumulativeSnapshotSegment(beforeTool.cursor);
    const afterTool = reconcileCumulativeSnapshot(boundary, 'Before tool.After tool.');
    expect(afterTool.reset).toBe(false);
    expect(afterTool.segmentText).toBe('After tool.');
    expect(appendCumulativeSnapshotDelta(afterTool.cursor, ' More.').rawSnapshot)
      .toBe('Before tool.After tool. More.');
  });
});

describe('stream liveness clocks', () => {
  it('keeps tool activity separate from visible assistant text', () => {
    const toolOnlyStart = recordStreamActivity({ lastAnyEventAt: 0, lastVisibleTextAt: 0 }, 50, false);
    expect(toolOnlyStart).toEqual({ lastAnyEventAt: 50, lastVisibleTextAt: 0 });

    const initial = recordStreamActivity({ lastAnyEventAt: 0, lastVisibleTextAt: 0 }, 100, true);
    const toolOnly = recordStreamActivity(initial, 200, false);
    expect(toolOnly).toEqual({ lastAnyEventAt: 200, lastVisibleTextAt: 100 });
    expect(getVisibleSilenceStatus('shell')).toBe(
      'Using shell… Tool activity is still arriving; no new assistant text yet.',
    );
    expect(getVisibleSilenceStatus('shell', false)).toBe(
      'Using shell… No new assistant text has been emitted yet.',
    );
  });

  it('keeps a three-hour tool-only turn transport-live without inventing visible text', () => {
    let clock = recordStreamActivity({ lastAnyEventAt: 0, lastVisibleTextAt: 0 }, 1, true);
    for (let minute = 1; minute <= 180; minute += 1) {
      clock = recordStreamActivity(clock, minute * 60_000, false);
    }
    expect(clock.lastAnyEventAt).toBe(180 * 60_000);
    expect(clock.lastVisibleTextAt).toBe(1);

    const resumedText = recordStreamActivity(clock, (180 * 60_000) + 500, true);
    expect(resumedText.lastVisibleTextAt).toBe((180 * 60_000) + 500);
  });
});

describe('long-lived callback bridges', () => {
  it('keeps one transport callback identity while dispatching every event to the latest handler', () => {
    const observed: string[] = [];
    const handlerRef = {
      current: (value: number) => observed.push(`initial:${value}`),
    };
    const stableDispatch = createLatestCallbackDispatcher(handlerRef);
    const originalDispatch = stableDispatch;

    stableDispatch(0);
    for (let index = 1; index <= 10_000; index += 1) {
      handlerRef.current = (value) => observed.push(`handler-${index}:${value}`);
      stableDispatch(index);
    }

    expect(stableDispatch).toBe(originalDispatch);
    expect(observed[0]).toBe('initial:0');
    expect(observed[1]).toBe('handler-1:1');
    expect(observed.at(-1)).toBe('handler-10000:10000');
    expect(observed).toHaveLength(10_001);
  });

  it('runs the latest queue-drain callback after the current send releases its lock', () => {
    const scheduled: Array<() => void> = [];
    const observed: string[] = [];
    const drainRef = { current: () => observed.push('stale-drain') };

    scheduleLatestCallback(drainRef, (callback) => scheduled.push(callback));
    drainRef.current = () => observed.push('latest-drain');
    scheduled.shift()?.();

    expect(observed).toEqual(['latest-drain']);
  });
});

describe('long-turn soak simulations', () => {
  it('keeps snapshot resets visible across hundreds of tool boundaries', () => {
    let cursor = reconcileCumulativeSnapshot(
      EMPTY_CUMULATIVE_SNAPSHOT_CURSOR,
      'initial segment',
    ).cursor;

    for (let index = 0; index < 500; index += 1) {
      cursor = beginCumulativeSnapshotSegment(cursor);
      const reset = reconcileCumulativeSnapshot(cursor, `segment ${index}`);
      expect(reset.segmentText).toBe(`segment ${index}`);
      expect(reset.segmentText).not.toBe('');

      const growth = reconcileCumulativeSnapshot(reset.cursor, `segment ${index} complete`);
      expect(growth.segmentText).toBe(`segment ${index} complete`);
      cursor = growth.cursor;
    }
  });

  it('bounds continuation tombstones during a long chain of run epochs', () => {
    let state: RunEpochState = { currentRunId: 'run-0', retiredRunIds: [] };
    for (let index = 1; index <= 40; index += 1) {
      if (!state.currentRunId) {
        throw new Error('continuation chain unexpectedly lost its active run');
      }
      const previousRunId = state.currentRunId;
      const continuation = reconcileRunEpoch(state, {
        incomingRunId: `run-${index}`,
        streamActive: true,
        continuationVerified: true,
        now: index * 1_000,
      });
      expect(continuation.decision).toBe('adopt');
      const lateTerminal = reconcileRunEpoch(continuation.state, {
        incomingRunId: previousRunId,
        streamActive: true,
        now: (index * 1_000) + 1,
      });
      expect(lateTerminal.decision).toBe('reject');
      state = continuation.state;
    }
    expect(state.currentRunId).toBe('run-40');
    expect(state.retiredRunIds).toHaveLength(8);
  });
});
