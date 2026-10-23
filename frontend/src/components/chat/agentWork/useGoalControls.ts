/**
 * Goal start and controls for one conversation.
 *
 * Each user action mints one identity, saved before sending. 202, 5xx, timeouts and lost
 * responses leave the outcome unknown: the identity stays saved and "Check outcome"
 * re-sends it unchanged. A definitive answer retires it. The goal shown afterwards is
 * always the backend readback, never the replayed receipt.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  postGoalControl,
  postGoalStart,
  type GoalMutationOutcome,
  type SessionGoal,
} from './agentWorkApi';
import {
  goalControlBody,
  goalOperationExpired,
  goalStartBody,
  loadGoalOperation,
  newOperationIdentity,
  retireGoalOperation,
  sameGoalRequest,
  saveGoalOperation,
  type GoalOperationAction,
  type SavedGoalOperation,
} from './goalOperationStore';

export interface GoalNotice {
  tone: 'success' | 'warning' | 'error';
  message: string;
  /** Technical detail for the disclosure; never needed to act. */
  detail?: string;
  canCheck?: boolean;
  canDismiss?: boolean;
  canReview?: boolean;
}

export interface GoalRequest {
  action: GoalOperationAction;
  goalId: string | null;
  objective?: string;
  note?: string;
}

export interface GoalControlsState {
  /** The saved operation for this conversation, if its outcome is not settled. */
  saved: SavedGoalOperation | null;
  sending: GoalOperationAction | null;
  notice: GoalNotice | null;
  run(request: GoalRequest): boolean;
  checkOutcome(): void;
  dismiss(): void;
  clearNotice(): void;
}

const ACTION_NAMES: Record<GoalOperationAction, string> = {
  start: 'Start goal',
  edit: 'Edit goal',
  pause: 'Pause goal',
  resume: 'Resume goal',
  block: 'Mark goal blocked',
  complete: 'Mark goal complete',
  clear: 'Clear goal',
};

const SUCCESS: Record<GoalOperationAction, string> = {
  start: 'Goal started. The agent is working on it.',
  edit: 'Goal updated.',
  pause: 'Goal paused.',
  resume: 'Goal resumed. The agent is continuing.',
  block: 'Goal marked blocked.',
  complete: 'Goal marked complete.',
  clear: 'Goal cleared.',
};

export const goalActionName = (action: GoalOperationAction): string => ACTION_NAMES[action];

function savedNotice(operation: SavedGoalOperation): GoalNotice {
  return goalOperationExpired(operation)
    ? {
      tone: 'warning',
      message: `An earlier “${ACTION_NAMES[operation.action]}” request is too old to confirm. Review the current goal before deciding again.`,
      canReview: true,
    }
    : {
      tone: 'warning',
      message: `We couldn’t confirm “${ACTION_NAMES[operation.action]}”. It may or may not have been applied.`,
      canCheck: true,
      canDismiss: true,
    };
}

function rejectionMessage(action: GoalOperationAction, code: string, reason: string | null, status: number): string {
  const startsWork = action === 'start' || action === 'resume';
  switch (code) {
    case 'GOAL_STALE': return 'The goal changed before this action was applied. Review the current goal.';
    case 'GOAL_EXPIRED': return 'This action is too old to apply. Review the current goal.';
    case 'GOAL_OPERATION_CONFLICT': return 'This action conflicts with an earlier request. Review the current goal and try again.';
    case 'SESSION_CHANGED': return 'This conversation was reset or replaced. Review the current goal.';
    case 'GOAL_UNSUPPORTED': return 'Goal controls are not available for this conversation right now.';
    case 'GOAL_INVALID':
      return status === 409
        ? 'This device’s clock looks wrong, so the change was refused. Check the clock and try again.'
        : 'This change is not valid. Check the text and try again.';
    case 'CHILD_EXECUTION_UNSUPPORTED': return 'Sub-agent work can’t be started or resumed here. Use the conversation that started it.';
    case 'OPENCLAW_EXECUTION_MAINTENANCE': return 'OpenClaw is in maintenance, so new work can’t start. You can still edit, pause or clear the goal.';
    case 'OPENCLAW_EXECUTION_RECOVERY_REQUIRED': return 'OpenClaw needs recovery before new work can start.';
    case 'OPENCLAW_EXECUTION_UNAVAILABLE': return 'OpenClaw isn’t ready to start new work right now.';
    case 'SESSION_NOT_FOUND': return 'This conversation isn’t available.';
    case 'UNSUPPORTED': return 'Goal controls are not available on this server.';
    case 'FORBIDDEN': return 'You don’t have permission to change this goal.';
    default:
      if (reason === 'capacity') return 'OpenClaw is handling too many goal changes for this conversation. Try again later.';
      return startsWork
        ? 'OpenClaw didn’t start the goal. The agent may be busy, or this conversation may not support goals.'
        : 'OpenClaw didn’t accept this change.';
  }
}

const REVIEW_CODES = new Set(['GOAL_STALE', 'GOAL_EXPIRED', 'GOAL_OPERATION_CONFLICT', 'SESSION_CHANGED']);

function outcomeNotice(operation: SavedGoalOperation, outcome: Exclude<GoalMutationOutcome, { kind: 'unconfirmed' }>): GoalNotice {
  if (outcome.kind === 'applied') {
    return { tone: 'success', message: outcome.replayed ? 'This change had already been applied.' : SUCCESS[operation.action] };
  }
  return {
    tone: REVIEW_CODES.has(outcome.code) ? 'warning' : 'error',
    message: rejectionMessage(operation.action, outcome.code, outcome.reason, outcome.status),
    detail: `${outcome.code}${outcome.reason ? ` (${outcome.reason})` : ''}`,
    canReview: REVIEW_CODES.has(outcome.code),
  };
}

interface Snapshot {
  key: string | null;
  saved: SavedGoalOperation | null;
  sending: GoalOperationAction | null;
  notice: GoalNotice | null;
}

const SUCCESS_NOTICE_MS = 6000;

export function useGoalControls({ userId, sessionKey, onReadback, onSettled }: {
  userId: string | null;
  sessionKey: string | null;
  onReadback(key: string, goal: SessionGoal | null): void;
  onSettled(key: string): void;
}): GoalControlsState {
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: null, saved: null, sending: null, notice: null });
  const inFlight = useRef(new Map<string, GoalOperationAction>());
  const keyRef = useRef(sessionKey);
  keyRef.current = sessionKey;
  const callbacks = useRef({ onReadback, onSettled });
  callbacks.current = { onReadback, onSettled };

  useEffect(() => {
    const saved = userId && sessionKey ? loadGoalOperation(userId, sessionKey) : null;
    const sending = sessionKey ? inFlight.current.get(sessionKey) ?? null : null;
    setSnapshot({ key: sessionKey, saved, sending, notice: saved && !sending ? savedNotice(saved) : null });
  }, [userId, sessionKey]);

  // Success messages fade; warnings and errors stay until acted on.
  useEffect(() => {
    if (snapshot.notice?.tone !== 'success') return undefined;
    const notice = snapshot.notice;
    const timer = window.setTimeout(() => {
      setSnapshot((current) => (current.notice === notice ? { ...current, notice: null } : current));
    }, SUCCESS_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot.notice]);

  const update = useCallback((key: string, patch: Partial<Snapshot>) => {
    setSnapshot((current) => (current.key === key ? { ...current, ...patch } : current));
  }, []);

  const send = useCallback(async (actor: string, operation: SavedGoalOperation) => {
    const key = operation.sessionKey;
    if (inFlight.current.has(key)) return;
    const controlBody = goalControlBody(operation);
    const startBody = goalStartBody(operation);
    if (!controlBody && !startBody) {
      retireGoalOperation(actor, operation);
      update(key, { saved: null, notice: { tone: 'error', message: 'This request could not be sent.' } });
      return;
    }
    inFlight.current.set(key, operation.action);
    update(key, { saved: operation, sending: operation.action, notice: null });
    let outcome: GoalMutationOutcome;
    try {
      outcome = startBody ? await postGoalStart(key, startBody) : await postGoalControl(key, controlBody!);
    } catch {
      outcome = { kind: 'unconfirmed', status: null, code: null };
    } finally {
      inFlight.current.delete(key);
    }
    if (outcome.kind === 'unconfirmed') {
      update(key, { saved: operation, sending: null, notice: savedNotice(operation) });
      callbacks.current.onSettled(key);
      return;
    }
    retireGoalOperation(actor, operation);
    if (outcome.kind === 'applied' || outcome.goal !== undefined) {
      callbacks.current.onReadback(key, outcome.kind === 'applied' ? outcome.goal : outcome.goal ?? null);
    } else {
      callbacks.current.onSettled(key);
    }
    update(key, { saved: null, sending: null, notice: outcomeNotice(operation, outcome) });
  }, [update]);

  const run = useCallback((request: GoalRequest): boolean => {
    const key = keyRef.current;
    if (!key || !userId || inFlight.current.has(key)) return false;
    const saved = loadGoalOperation(userId, key);
    if (saved) {
      // One unsettled change per conversation: the same request is re-sent unchanged,
      // anything else waits until the earlier one is checked or dismissed.
      if (goalOperationExpired(saved) || !sameGoalRequest(saved, request)) {
        update(key, { saved, notice: savedNotice(saved) });
        return false;
      }
      void send(userId, saved);
      return true;
    }
    const operation: SavedGoalOperation = {
      v: 1,
      sessionKey: key,
      action: request.action,
      goalId: request.action === 'start' ? null : request.goalId,
      identity: newOperationIdentity(),
      issuedAtMs: Date.now(),
      ...(request.objective !== undefined ? { objective: request.objective } : {}),
      ...(request.note ? { note: request.note } : {}),
    };
    if (!saveGoalOperation(userId, operation)) {
      update(key, { notice: { tone: 'error', message: 'This browser couldn’t save the request, so it wasn’t sent. Check that site storage is allowed.' } });
      return false;
    }
    void send(userId, operation);
    return true;
  }, [send, update, userId]);

  const checkOutcome = useCallback(() => {
    const key = keyRef.current;
    if (!key || !userId || inFlight.current.has(key)) return;
    const saved = loadGoalOperation(userId, key);
    if (!saved) {
      update(key, { saved: null, notice: null });
      callbacks.current.onSettled(key);
      return;
    }
    if (goalOperationExpired(saved)) {
      retireGoalOperation(userId, saved);
      update(key, { saved: null, notice: null });
      callbacks.current.onSettled(key);
      return;
    }
    void send(userId, saved);
  }, [send, update, userId]);

  const dismiss = useCallback(() => {
    const key = keyRef.current;
    if (!key || inFlight.current.has(key)) return;
    const saved = userId ? loadGoalOperation(userId, key) : null;
    if (saved && userId) retireGoalOperation(userId, saved);
    update(key, { saved: null, notice: null });
    callbacks.current.onSettled(key);
  }, [update, userId]);

  const clearNotice = useCallback(() => {
    const key = keyRef.current;
    if (key) update(key, { notice: null });
  }, [update]);

  const current = snapshot.key === sessionKey ? snapshot : { saved: null, sending: null, notice: null };
  return { saved: current.saved, sending: current.sending, notice: current.notice, run, checkOutcome, dismiss, clearNotice };
}
