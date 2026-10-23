import crypto from 'crypto';
import {
  AskUserQuestionError,
  answerAskUserQuestion,
  cancelAskUserQuestion,
  formatAskUserAnswerForModel,
  listPendingAskUserQuestions,
  readAskUserQuestionChannel,
  readPendingAskUserQuestionForActor,
  registerAskUserQuestion,
  waitForAskUserAnswer,
  type AskUserQuestionPublicRecord,
  type AskUserQuestionRecord,
} from '../../services/askUserQuestionBroker';
import { CHAT_BRIDGE_OPEN_QUESTIONS_PER_TURN_MAX, CHAT_BRIDGE_QUESTION_WAIT_MS } from './contract';
import type { ChatBridgeTurnRecord } from './registry';

/**
 * Questions asked through the Portal Chat Bridge. They live in the same broker
 * as OpenClaw questions, so the existing pending card, global toasts and
 * answer API render them, but they settle only here: the harness is blocked on
 * its MCP call, not on an OpenClaw runtime request.
 */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

/** Accept the common ask-user shapes (Claude AskUserQuestion, OpenClaw ask_user_question). */
export function normalizeBridgeQuestions(args: unknown): Array<Record<string, unknown>> {
  const source = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const raw = Array.isArray(source.questions)
    ? source.questions
    : typeof source.question === 'string'
      ? [source]
      : [];
  const questions: Array<Record<string, unknown>> = [];
  raw.slice(0, MAX_QUESTIONS).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const value = entry as Record<string, unknown>;
    const question = text(value.question, 2_000);
    if (!question) return;
    const options = (Array.isArray(value.options) ? value.options : [])
      .slice(0, MAX_OPTIONS)
      .map((option) => (typeof option === 'string'
        ? { label: text(option, 200) }
        : { label: text((option as any)?.label, 200), description: text((option as any)?.description, 500) || undefined }))
      .filter((option) => option.label);
    questions.push({
      id: `q${index + 1}`,
      question,
      header: text(value.header, 12) || undefined,
      multiSelect: value.multiSelect === true || value.multi_select === true,
      // A typed answer stays possible unless the agent explicitly closes the choice.
      isOther: options.length === 0 || (value.allowOther !== false && value.isOther !== false),
      options,
    });
  });
  return questions;
}

function abortPromise(signal: AbortSignal): Promise<'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
}

export async function askThroughBridge(
  turn: ChatBridgeTurnRecord,
  args: unknown,
  requestSignal: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const questions = normalizeBridgeQuestions(args);
  if (questions.length === 0) {
    return { text: 'ask_user needs at least one question with a non-empty "question" field.', isError: true };
  }
  const { binding } = turn;
  const open = listPendingAskUserQuestions({ actorUserId: binding.userId, sessionKey: binding.portalSessionId, channel: 'bridge' })
    .filter((entry) => turn.questionIds.has(entry.id)).length;
  if (open >= CHAT_BRIDGE_OPEN_QUESTIONS_PER_TURN_MAX) {
    return { text: 'Several questions are already waiting for the person. Wait for those answers first.', isError: true };
  }
  const record = registerAskUserQuestion({
    channel: 'bridge',
    sessionKey: binding.portalSessionId,
    runId: binding.runId,
    toolCallId: `bridge-${crypto.randomUUID()}`,
    ownerUserId: binding.userId,
    surface: 'agent-chat',
    authorityId: `native-bridge:${binding.provider}`,
    actorAuthorizationVersion: binding.authorizationVersion,
    projectIdentityId: null,
    questions,
    waitMs: CHAT_BRIDGE_QUESTION_WAIT_MS,
  });
  turn.questionIds.add(record.id);
  const outcome = await Promise.race([
    waitForAskUserAnswer(record.id),
    abortPromise(turn.abort.signal),
    abortPromise(requestSignal),
  ]);
  if (outcome === 'aborted') {
    try { cancelAskUserQuestion({ id: record.id, actorUserId: binding.userId }); } catch { /* already settled */ }
    return { text: 'The question was withdrawn because the turn ended.', isError: true };
  }
  const settled = outcome as AskUserQuestionRecord;
  return { text: formatAskUserAnswerForModel(settled), isError: settled.state !== 'answered' };
}

/** Cancel every still-open question a revoked turn asked. */
export function cancelTurnQuestions(turn: ChatBridgeTurnRecord): void {
  for (const id of turn.questionIds) {
    try { cancelAskUserQuestion({ id, actorUserId: turn.binding.userId }); } catch { /* settled */ }
  }
  turn.questionIds.clear();
}

export function isBridgeQuestion(id: string): boolean {
  return readAskUserQuestionChannel(id) === 'bridge';
}

export function listBridgeQuestions(actorUserId: string, sessionKey?: string): AskUserQuestionPublicRecord[] {
  return listPendingAskUserQuestions({ actorUserId, sessionKey, channel: 'bridge' });
}

/** Settle a bridge question for its owner. Throws AskUserQuestionError like the OpenClaw path. */
export function answerBridgeQuestion(input: { id: string; actorUserId: string; answers: Record<string, unknown> }) {
  if (!isBridgeQuestion(input.id)) {
    throw new AskUserQuestionError('ASK_USER_NOT_FOUND', 'That question is no longer open.', 404);
  }
  readPendingAskUserQuestionForActor(input.id, input.actorUserId);
  return answerAskUserQuestion(input);
}

export function dismissBridgeQuestion(input: { id: string; actorUserId: string }): void {
  if (!isBridgeQuestion(input.id)) {
    throw new AskUserQuestionError('ASK_USER_NOT_FOUND', 'That question is no longer open.', 404);
  }
  readPendingAskUserQuestionForActor(input.id, input.actorUserId);
  cancelAskUserQuestion(input);
}
