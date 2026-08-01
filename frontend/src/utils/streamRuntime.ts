export interface RetiredRunEpoch {
  runId: string;
  expiresAt: number;
}

export interface RunEpochState {
  currentRunId: string | null;
  retiredRunIds: RetiredRunEpoch[];
}

export type RunEpochDecision = 'accept' | 'adopt' | 'reject';

const RETIRED_RUN_TTL_MS = 5 * 60_000;
const MAX_RETIRED_RUNS = 8;

/**
 * Reconcile a transport run ID against the browser's current rendering epoch.
 * A new run may replace an active run only when the backend (or a verified
 * direct-gateway frame) explicitly identifies it as a continuation. The old
 * epoch remains tombstoned so a late terminal cannot close the new turn.
 */
export function reconcileRunEpoch(
  state: RunEpochState,
  input: {
    incomingRunId: string | null;
    streamActive: boolean;
    continuationVerified?: boolean;
    now?: number;
  },
): { state: RunEpochState; decision: RunEpochDecision } {
  const now = input.now ?? Date.now();
  const retiredRunIds = state.retiredRunIds
    .filter((entry) => entry.expiresAt > now)
    .slice(-MAX_RETIRED_RUNS);
  const incomingRunId = input.incomingRunId;

  if (!incomingRunId) {
    return { state: { ...state, retiredRunIds }, decision: 'accept' };
  }
  if (retiredRunIds.some((entry) => entry.runId === incomingRunId)) {
    return { state: { ...state, retiredRunIds }, decision: 'reject' };
  }
  if (!state.currentRunId || !input.streamActive) {
    return {
      state: { currentRunId: incomingRunId, retiredRunIds },
      decision: 'accept',
    };
  }
  if (state.currentRunId === incomingRunId) {
    return { state: { ...state, retiredRunIds }, decision: 'accept' };
  }
  if (!input.continuationVerified) {
    return { state: { ...state, retiredRunIds }, decision: 'reject' };
  }

  const nextRetired = [
    ...retiredRunIds.filter((entry) => entry.runId !== state.currentRunId),
    { runId: state.currentRunId, expiresAt: now + RETIRED_RUN_TTL_MS },
  ].slice(-MAX_RETIRED_RUNS);
  return {
    state: { currentRunId: incomingRunId, retiredRunIds: nextRetired },
    decision: 'adopt',
  };
}

export interface CumulativeSnapshotCursor {
  /** Latest raw cumulative text received from the direct gateway. */
  rawSnapshot: string;
  /** Raw cumulative prefix already graduated before the current tool. */
  segmentBaseline: string;
}

export const EMPTY_CUMULATIVE_SNAPSHOT_CURSOR: CumulativeSnapshotCursor = {
  rawSnapshot: '',
  segmentBaseline: '',
};

export function beginCumulativeSnapshotSegment(
  cursor: CumulativeSnapshotCursor,
): CumulativeSnapshotCursor {
  return {
    rawSnapshot: cursor.rawSnapshot,
    segmentBaseline: cursor.rawSnapshot,
  };
}

/**
 * Convert a direct-gateway cumulative snapshot into the currently live text
 * segment. A shrink or non-prefix rewrite is authoritative: it resets the
 * stale segment cursor instead of slicing at an obsolete numeric offset.
 */
export function reconcileCumulativeSnapshot(
  cursor: CumulativeSnapshotCursor,
  incomingSnapshot: string,
): { cursor: CumulativeSnapshotCursor; segmentText: string; reset: boolean } {
  const extendsBaseline = !cursor.segmentBaseline
    || incomingSnapshot.startsWith(cursor.segmentBaseline);
  const segmentText = extendsBaseline
    ? incomingSnapshot.slice(cursor.segmentBaseline.length)
    : incomingSnapshot;

  return {
    cursor: {
      rawSnapshot: incomingSnapshot,
      segmentBaseline: extendsBaseline ? cursor.segmentBaseline : '',
    },
    segmentText,
    reset: !extendsBaseline,
  };
}

export function appendCumulativeSnapshotDelta(
  cursor: CumulativeSnapshotCursor,
  delta: string,
): CumulativeSnapshotCursor {
  return {
    ...cursor,
    rawSnapshot: cursor.rawSnapshot + delta,
  };
}

export interface StreamActivityClock {
  lastAnyEventAt: number;
  lastVisibleTextAt: number;
}

export interface LatestCallbackRef<TArgs extends unknown[], TResult> {
  current: (...args: TArgs) => TResult;
}

/**
 * Build one transport-facing callback whose identity never changes while its
 * implementation can be replaced through a ref. Long-lived WebSocket clients
 * must not be torn down just because a React render produced a fresher event
 * handler closure.
 */
export function createLatestCallbackDispatcher<TArgs extends unknown[], TResult>(
  callbackRef: LatestCallbackRef<TArgs, TResult>,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => callbackRef.current(...args);
}

/** Schedule a callback through its current ref instead of capturing the
 * callback that happened to exist when the work was queued. */
export function scheduleLatestCallback(
  callbackRef: LatestCallbackRef<[], void>,
  schedule: (callback: () => void) => void = queueMicrotask,
): void {
  schedule(() => callbackRef.current());
}

/** Tool/status/transport activity keeps the connection live but never poses as
 * assistant reasoning. Only actual assistant/reasoning content advances the
 * visible-text clock. */
export function recordStreamActivity(
  clock: StreamActivityClock,
  now: number,
  visible: boolean,
): StreamActivityClock {
  return {
    lastAnyEventAt: now,
    lastVisibleTextAt: visible ? now : clock.lastVisibleTextAt,
  };
}

export function getVisibleSilenceStatus(
  toolName?: string | null,
  hasRecentActivity = true,
): string {
  const tool = typeof toolName === 'string' ? toolName.trim() : '';
  if (tool) {
    return hasRecentActivity
      ? `Using ${tool}… Tool activity is still arriving; no new assistant text yet.`
      : `Using ${tool}… No new assistant text has been emitted yet.`;
  }
  return hasRecentActivity
    ? 'Agent activity is still arriving; no new assistant text has been emitted yet.'
    : 'No new assistant text has been emitted yet; waiting for the active run.';
}
