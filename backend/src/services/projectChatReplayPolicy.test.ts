import type { ProjectChatTurn } from '@prisma/client';
import type { ProjectNativeRunSnapshot } from './projectNativeRunBroker';
import {
  isProjectNativeSettlementFailure,
  isRequestedProjectChatTurn,
  matchingProjectNativeSnapshot,
  resolveProjectChatReplayLineCount,
  visibleProjectChatActiveTurn,
} from './projectChatReplayPolicy';

function turn(overrides: Partial<ProjectChatTurn> = {}): ProjectChatTurn {
  return {
    id: 'turn-1',
    stateId: 'state-1',
    actorUserId: 'actor-1',
    actorAuthorizationVersion: 1,
    projectIdentityId: 'project-1',
    activeProjectKey: 'project-1',
    provider: 'OPENCLAW',
    runtime: 'runtime',
    requestId: 'message-1',
    status: 'RUNNING',
    leaseTokenHash: 'hash',
    leaseOwner: 'owner',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    heartbeatAt: new Date(),
    providerSessionId: 'session-1',
    model: 'openai/model',
    lastEventSeq: 0,
    resultMetadata: null,
    errorCode: null,
    errorMessage: null,
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function snapshot(runId: string): ProjectNativeRunSnapshot {
  return {
    runId,
    provider: 'OPENCLAW',
    runtime: 'runtime',
    sessionId: 'session-1',
    active: true,
    complete: false,
    status: 'running',
    text: 'working',
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
    lastSeq: 0,
  };
}

test('runtime admissions are never exposed as active transcript turns', () => {
  const admission = turn({ requestId: 'portal-runtime-admission:ensure-session:nonce' });
  expect(visibleProjectChatActiveTurn(admission)).toBeNull();
  expect(isRequestedProjectChatTurn(admission, admission.id)).toBe(false);
});

test('broker snapshots are usable only for the exact durable turn', () => {
  const active = turn();
  expect(matchingProjectNativeSnapshot(active, snapshot('older-turn'))).toBeNull();
  expect(matchingProjectNativeSnapshot(active, snapshot(active.id))?.text).toBe('working');
});

test('only the fixed terminal settlement failure can stop replay for a stranded durable lease', () => {
  const failed = {
    ...snapshot('turn-1'),
    active: false,
    complete: true,
    status: 'error' as const,
    error: 'Project Chat could not finalize durable turn state. Refresh before retrying.',
  };
  expect(isProjectNativeSettlementFailure(failed)).toBe(true);
  expect(isProjectNativeSettlementFailure({ ...failed, active: true })).toBe(false);
  expect(isProjectNativeSettlementFailure({ ...failed, error: 'provider internals' })).toBe(false);
  expect(isProjectNativeSettlementFailure({ ...failed, runId: null })).toBe(false);
});

test('an explicit replay turn cannot drift to a newer or older turn', () => {
  expect(isRequestedProjectChatTurn(turn({ id: 'turn-a' }), 'turn-a')).toBe(true);
  expect(isRequestedProjectChatTurn(turn({ id: 'turn-b' }), 'turn-a')).toBe(false);
});

test('terminal broker replay never advances beyond the advertised line count', () => {
  expect(resolveProjectChatReplayLineCount({
    durableLastEventSeq: 4,
    snapshotLastSeq: 5,
    replayEvents: [{ seq: 5 }],
  })).toBe(5);
  expect(resolveProjectChatReplayLineCount({
    durableLastEventSeq: 4,
    snapshotLastSeq: 5,
    replayEvents: [],
  })).toBe(5);
  expect(resolveProjectChatReplayLineCount({
    durableLastEventSeq: 8,
    snapshotLastSeq: 5,
    replayEvents: [{ seq: 6 }],
  })).toBe(8);
});
