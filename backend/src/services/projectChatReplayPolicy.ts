import type { ProjectChatTurn } from '@prisma/client';
import {
  PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
  type ProjectNativeRunSnapshot,
} from './projectNativeRunBroker';
import { isProjectChatRuntimeAdmissionTurn } from './projectChatTurnLease';

export function visibleProjectChatActiveTurn(
  turn: ProjectChatTurn | null | undefined,
): ProjectChatTurn | null {
  return turn && !isProjectChatRuntimeAdmissionTurn(turn) ? turn : null;
}

/**
 * The process-local broker is only an acceleration layer. It may retain a
 * previous terminal run, so its text/status can be combined with a durable
 * turn only when both identify the exact same turn.
 */
export function matchingProjectNativeSnapshot(
  turn: Pick<ProjectChatTurn, 'id'> | null | undefined,
  snapshot: ProjectNativeRunSnapshot | null | undefined,
): ProjectNativeRunSnapshot | null {
  if (!turn || !snapshot || snapshot.runId !== turn.id) return null;
  return snapshot;
}

/**
 * Process-local settlement failure is a narrow terminal override for the exact
 * durable run. It exists only for the case where both bounded database
 * settlement passes failed and the durable lease therefore still reads
 * RUNNING. Admissions continue to trust the database; replay may stop the UI
 * spinner and present the fixed safe recovery message immediately.
 */
export function isProjectNativeSettlementFailure(
  snapshot: ProjectNativeRunSnapshot | null | undefined,
): boolean {
  return Boolean(
    snapshot
    && typeof snapshot.runId === 'string'
    && snapshot.runId.length > 0
    && !snapshot.active
    && snapshot.complete
    && snapshot.status === 'error'
    && snapshot.error === PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
  );
}

export function isRequestedProjectChatTurn(
  turn: Pick<ProjectChatTurn, 'id' | 'requestId'> | null | undefined,
  requestedTurnId: string | null | undefined,
): boolean {
  if (!turn || isProjectChatRuntimeAdmissionTurn(turn)) return false;
  return !requestedTurnId || turn.id === requestedTurnId;
}

/**
 * The process-local broker can publish its terminal event one step ahead of
 * the durable turn cursor. Replay must advertise the furthest verified cursor
 * from either source or the client will reject that terminal event as being
 * outside lineCount and fail closed after an otherwise successful turn.
 */
export function resolveProjectChatReplayLineCount(input: {
  durableLastEventSeq?: number | null;
  snapshotLastSeq?: number | null;
  replayEvents: ReadonlyArray<{ seq: number }>;
}): number {
  return input.replayEvents.reduce(
    (lineCount, event) => Math.max(lineCount, event.seq),
    Math.max(input.durableLastEventSeq || 0, input.snapshotLastSeq || 0),
  );
}
