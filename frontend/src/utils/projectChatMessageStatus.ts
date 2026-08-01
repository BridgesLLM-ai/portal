import type { ProjectChatMessageStatusResponse } from '../api/endpoints';
import type {
  PendingProjectChatSend,
  ProjectChatSendOutcome,
  ProjectChatSendScope,
} from './projectChatPendingSend';

export const PROJECT_CHAT_ABSENCE_MINIMUM_AGE_MS = 10_000;
export const PROJECT_CHAT_ABSENCE_RECHECK_DELAYS_MS = Object.freeze([500, 1_500]);

type Sleep = (delayMs: number) => Promise<void>;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function validateStatusResponse(
  response: ProjectChatMessageStatusResponse,
  scope: ProjectChatSendScope,
  pending: PendingProjectChatSend,
): void {
  if (
    response?.provider !== scope.provider
    || response?.projectId !== scope.projectId
    || response?.messageId !== pending.messageId
    || !['absent', 'admitted', 'active', 'terminal'].includes(response?.status)
    || response?.found !== (response?.status !== 'absent')
    || !(
      response?.stateVersion === null
      || (Number.isSafeInteger(response?.stateVersion) && Number(response.stateVersion) >= 0)
    )
  ) {
    throw new Error('Project Chat message reconciliation returned a mismatched identity.');
  }
  if (
    response.found
    && (
      !['unconfirmed', 'accepted', 'unknown'].includes(String(response.dispatchStatus || ''))
      || typeof response.turnId !== 'string'
      || !response.turnId.trim()
      || typeof response.turnStatus !== 'string'
      || !response.turnStatus.trim()
      || typeof response.recoveryRequired !== 'boolean'
    )
  ) {
    throw new Error('Project Chat message reconciliation returned an invalid dispatch state.');
  }
  if (
    !response.found
    && (
      response.dispatchStatus !== undefined
      || response.turnId !== undefined
      || response.turnStatus !== undefined
      || response.recoveryRequired !== undefined
    )
  ) {
    throw new Error('Project Chat message reconciliation returned a contradictory absent state.');
  }
}

function outcomeForStatus(response: ProjectChatMessageStatusResponse): ProjectChatSendOutcome | 'recheck-absent' {
  if (!response.found) return 'recheck-absent';
  return response.dispatchStatus === 'accepted' ? 'confirmed' : 'ambiguous';
}

/**
 * An immediate `absent` can race a send whose transaction has not committed
 * yet. Keep the immutable delivery ID locked, wait until the original attempt
 * is old enough to be quiet, and require repeated absent observations before
 * allowing a new ID.
 */
export async function resolveProjectChatPendingMessageStatus(input: {
  scope: ProjectChatSendScope;
  pending: PendingProjectChatSend;
  probe: () => Promise<ProjectChatMessageStatusResponse>;
  now?: () => number;
  sleep?: Sleep;
  minimumAgeMs?: number;
  recheckDelaysMs?: readonly number[];
}): Promise<ProjectChatSendOutcome> {
  const now = input.now || Date.now;
  const sleep = input.sleep || defaultSleep;
  const first = await input.probe();
  validateStatusResponse(first, input.scope, input.pending);
  const firstOutcome = outcomeForStatus(first);
  if (firstOutcome !== 'recheck-absent') return firstOutcome;

  const createdAt = Date.parse(input.pending.createdAt);
  const attemptStartedAt = Math.max(
    Number.isFinite(createdAt) ? createdAt : 0,
    input.pending.attemptStartedAt,
  );
  const minimumAgeMs = input.minimumAgeMs ?? PROJECT_CHAT_ABSENCE_MINIMUM_AGE_MS;
  const quietNotBefore = attemptStartedAt + minimumAgeMs;
  const initialDelay = Math.max(0, quietNotBefore - now());
  if (initialDelay > 0) await sleep(initialDelay);

  const delays = input.recheckDelaysMs ?? PROJECT_CHAT_ABSENCE_RECHECK_DELAYS_MS;
  for (const delay of delays) {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new Error('Project Chat message reconciliation received an invalid quiet-window delay.');
    }
    if (delay > 0) await sleep(delay);
    const response = await input.probe();
    validateStatusResponse(response, input.scope, input.pending);
    const outcome = outcomeForStatus(response);
    if (outcome !== 'recheck-absent') return outcome;
  }
  return 'never-admitted';
}
