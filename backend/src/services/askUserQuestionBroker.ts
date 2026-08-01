import crypto from 'crypto';

/**
 * Owner-scoped presentation cache for native Codex `requestUserInput`
 * requests. OpenClaw remains the authority for whether an exact run/request is
 * pending; Portal re-attests and reconciles this bounded in-memory cache before
 * every read or settlement. The generic approval channel cannot carry option
 * or free-text answers, so delivery uses the dedicated exact-run plugin RPC.
 */

/** Hard ceiling, matching OpenClaw's documented per-hook budget. */
export const ASK_USER_MAX_WAIT_MS = 600_000;
/** Used when the caller does not ask for a specific budget. */
export const ASK_USER_DEFAULT_WAIT_MS = 300_000;
/** How long an answered/expired record stays queryable for late arrivals. */
const SETTLED_RETENTION_MS = 60_000;
/** Refuse to hold more than this many open questions across all sessions. */
const MAX_OPEN_QUESTIONS = 64;

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  /** Native Codex question identity. Answers are keyed by this value. */
  id: string;
  question: string;
  header?: string;
  /** Native Codex input is single-answer; generic streamed cards own multi-select. */
  multiSelect: false;
  isOther?: boolean;
  isSecret?: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionRecord {
  id: string;
  sessionKey: string;
  runId: string;
  toolCallId: string;
  ownerUserId: string;
  surface: 'agent-chat' | 'project-chat';
  authorityId: string;
  actorAuthorizationVersion: number;
  projectIdentityId: string | null;
  questions: AskUserQuestion[];
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'answered' | 'expired' | 'cancelled';
  answers: Record<string, string> | null;
  answeredAt: number | null;
}

export interface AskUserQuestionPublicRecord {
  id: string;
  sessionKey: string;
  surface: AskUserQuestionRecord['surface'];
  questions: AskUserQuestion[];
  createdAt: number;
  expiresAt: number;
  state: AskUserQuestionRecord['state'];
}

export class AskUserQuestionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
  }
}

const records = new Map<string, AskUserQuestionRecord>();
const recordIdsByCallIdentity = new Map<string, string>();
const deliveryReservations = new Map<string, symbol>();
const waiters = new Map<string, Set<(record: AskUserQuestionRecord) => void>>();
const listeners = new Set<(record: AskUserQuestionPublicRecord) => void>();

function nowMs(): number {
  return Date.now();
}

function boundedText(value: unknown, maxLength: number): string {
  // Strip C0/C7F control characters so a question can never smuggle escape
  // sequences into a terminal-rendered surface.
  const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
  return String(value ?? '')
    .replace(CONTROL_CHARACTERS, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * Accepts the tool's own argument shape. Anything unusable is rejected here
 * rather than rendered as an empty card the user cannot act on.
 */
export function normalizeAskUserQuestions(input: unknown): AskUserQuestion[] {
  const raw = Array.isArray(input)
    ? input
    : Array.isArray((input as any)?.questions)
      ? (input as any).questions
      : [];
  const questions: AskUserQuestion[] = [];
  for (const entry of raw.slice(0, 4)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = boundedText((entry as any).id, 256);
    const question = boundedText((entry as any).question, 2_000);
    if (!id || !question) continue;
    const header = boundedText((entry as any).header, 12);
    const options: AskUserQuestionOption[] = [];
    const rawOptions = Array.isArray((entry as any).options) ? (entry as any).options : [];
    for (const option of rawOptions.slice(0, 8)) {
      const label = typeof option === 'string'
        ? boundedText(option, 200)
        : boundedText((option as any)?.label, 200);
      if (!label) continue;
      const description = typeof option === 'string'
        ? ''
        : boundedText((option as any)?.description, 500);
      options.push(description ? { label, description } : { label });
    }
    questions.push({
      id,
      question,
      ...(header ? { header } : {}),
      multiSelect: false,
      ...((entry as any).isOther === true ? { isOther: true } : {}),
      ...((entry as any).isSecret === true ? { isSecret: true } : {}),
      options,
    });
  }
  return questions;
}

function toPublic(record: AskUserQuestionRecord): AskUserQuestionPublicRecord {
  return {
    id: record.id,
    sessionKey: record.sessionKey,
    surface: record.surface,
    questions: record.questions,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state,
  };
}

function publish(record: AskUserQuestionRecord): void {
  const payload = toPublic(record);
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // A broken listener must never affect the run that is waiting.
    }
  }
}

function settle(record: AskUserQuestionRecord, state: AskUserQuestionRecord['state']): void {
  if (record.state !== 'pending') return;
  record.state = state;
  const pendingWaiters = waiters.get(record.id);
  waiters.delete(record.id);
  publish(record);
  if (pendingWaiters) {
    for (const resolve of pendingWaiters) {
      try {
        resolve(record);
      } catch {
        // ignore
      }
    }
  }
  setTimeout(() => {
    const current = records.get(record.id);
    if (current && current.state !== 'pending') {
      records.delete(record.id);
      recordIdsByCallIdentity.delete(callIdentityKey(current));
    }
  }, SETTLED_RETENTION_MS).unref?.();
}

function expireOverdue(): void {
  const now = nowMs();
  for (const record of records.values()) {
    if (
      record.state === 'pending'
      && record.expiresAt <= now
      && !deliveryReservations.has(record.id)
    ) settle(record, 'expired');
  }
}

export function registerAskUserQuestion(input: {
  sessionKey: string;
  runId: string;
  toolCallId: string;
  ownerUserId: string;
  surface: 'agent-chat' | 'project-chat';
  authorityId: string;
  actorAuthorizationVersion: number;
  projectIdentityId: string | null;
  questions: unknown;
  waitMs?: number;
  createdAt?: number;
  expiresAt?: number;
}): AskUserQuestionRecord {
  expireOverdue();
  const sessionKey = boundedText(input.sessionKey, 512);
  if (!sessionKey) {
    throw new AskUserQuestionError('ASK_USER_SESSION_REQUIRED', 'A session key is required.');
  }
  const questions = normalizeAskUserQuestions(input.questions);
  const rawQuestions = Array.isArray(input.questions)
    ? input.questions
    : Array.isArray((input.questions as any)?.questions)
      ? (input.questions as any).questions
      : [];
  if (rawQuestions.some((question: any) => (
    question
    && typeof question === 'object'
    && Object.prototype.hasOwnProperty.call(question, 'multiSelect')
    && question.multiSelect !== false
  ))) {
    throw new AskUserQuestionError(
      'ASK_USER_MULTISELECT_UNSUPPORTED',
      'Native Codex questions do not support multi-select answers.',
    );
  }
  if (questions.length === 0) {
    throw new AskUserQuestionError('ASK_USER_QUESTIONS_INVALID', 'No answerable question was supplied.');
  }
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new AskUserQuestionError(
      'ASK_USER_QUESTIONS_AMBIGUOUS',
      'Question identities must be unique within one request.',
    );
  }
  const observedAt = nowMs();
  const suppliedCreatedAt = Number(input.createdAt);
  const createdAt = Number.isSafeInteger(suppliedCreatedAt) && suppliedCreatedAt >= 0
    ? suppliedCreatedAt
    : observedAt;
  const suppliedExpiresAt = Number(input.expiresAt);
  const requestedWaitMs = Number.isSafeInteger(suppliedExpiresAt) && suppliedExpiresAt > createdAt
    ? suppliedExpiresAt - createdAt
    : Number(input.waitMs) || ASK_USER_DEFAULT_WAIT_MS;
  const waitMs = Math.min(Math.max(requestedWaitMs, 1_000), ASK_USER_MAX_WAIT_MS);
  const expiresAt = Math.min(createdAt + waitMs, observedAt + ASK_USER_MAX_WAIT_MS);
  const runId = boundedText(input.runId, 512);
  const toolCallId = boundedText(input.toolCallId, 256);
  if (!runId || !toolCallId) {
    throw new AskUserQuestionError(
      'ASK_USER_RUN_IDENTITY_REQUIRED',
      'A verified run and tool-call identity are required.',
      403,
    );
  }
  const ownerUserId = boundedText(input.ownerUserId, 128);
  if (!ownerUserId) {
    throw new AskUserQuestionError(
      'ASK_USER_OWNER_REQUIRED',
      'A verified question owner is required.',
      403,
    );
  }
  const authorityId = boundedText(input.authorityId, 256);
  const actorAuthorizationVersion = Number(input.actorAuthorizationVersion);
  if (
    !authorityId
    || !['agent-chat', 'project-chat'].includes(input.surface)
    || !Number.isSafeInteger(actorAuthorizationVersion)
    || actorAuthorizationVersion < 1
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_AUTHORITY_REQUIRED',
      'Verified run authority is required.',
      403,
    );
  }
  const projectIdentityId = input.projectIdentityId == null
    ? null
    : boundedText(input.projectIdentityId, 256);
  if (input.surface === 'project-chat' && !projectIdentityId) {
    throw new AskUserQuestionError(
      'ASK_USER_AUTHORITY_REQUIRED',
      'Verified Project run authority is required.',
      403,
    );
  }
  if (input.surface === 'agent-chat' && projectIdentityId !== null) {
    throw new AskUserQuestionError(
      'ASK_USER_AUTHORITY_REQUIRED',
      'Agent Chat authority cannot carry a Project identity.',
      403,
    );
  }
  const identityKey = [sessionKey, runId, toolCallId].join('\u0000');
  const existingId = recordIdsByCallIdentity.get(identityKey);
  if (existingId) {
    const existing = records.get(existingId);
    if (!existing) {
      recordIdsByCallIdentity.delete(identityKey);
    } else {
      const sameRequest = existing.ownerUserId === ownerUserId
        && existing.surface === input.surface
        && existing.authorityId === authorityId
        && existing.actorAuthorizationVersion === actorAuthorizationVersion
        && existing.projectIdentityId === projectIdentityId
        && JSON.stringify(existing.questions) === JSON.stringify(questions);
      if (sameRequest) return existing;
      throw new AskUserQuestionError(
        'ASK_USER_CALL_IDENTITY_CONFLICT',
        'That tool-call identity was already registered with different content.',
        409,
      );
    }
  }
  const openCount = Array.from(records.values()).filter((entry) => entry.state === 'pending').length;
  if (openCount >= MAX_OPEN_QUESTIONS) {
    throw new AskUserQuestionError(
      'ASK_USER_TOO_MANY_OPEN',
      'Too many unanswered questions are already open.',
      429,
    );
  }
  const record: AskUserQuestionRecord = {
    id: `askq_${crypto.randomBytes(12).toString('hex')}`,
    sessionKey,
    runId,
    toolCallId,
    ownerUserId,
    surface: input.surface,
    authorityId,
    actorAuthorizationVersion,
    projectIdentityId,
    questions,
    createdAt,
    expiresAt,
    state: 'pending',
    answers: null,
    answeredAt: null,
  };
  records.set(record.id, record);
  recordIdsByCallIdentity.set(identityKey, record.id);
  publish(record);
  return record;
}

function callIdentityKey(record: Pick<AskUserQuestionRecord, 'sessionKey' | 'runId' | 'toolCallId'>): string {
  return [record.sessionKey, record.runId, record.toolCallId].join('\u0000');
}

export function readPendingAskUserQuestionForActor(
  id: string,
  actorUserId: string,
): AskUserQuestionRecord {
  expireOverdue();
  const record = records.get(id);
  if (
    !record
    || record.state !== 'pending'
    || !actorUserId
    || record.ownerUserId !== actorUserId
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_NOT_FOUND',
      'That question is no longer open.',
      404,
    );
  }
  return record;
}

/** Resolves when the question settles, or when its own deadline passes. */
export function waitForAskUserAnswer(id: string): Promise<AskUserQuestionRecord> {
  const record = records.get(id);
  if (!record) {
    return Promise.reject(new AskUserQuestionError('ASK_USER_NOT_FOUND', 'Unknown question.', 404));
  }
  if (record.state !== 'pending') return Promise.resolve(record);
  return new Promise<AskUserQuestionRecord>((resolve) => {
    const set = waiters.get(id) || new Set();
    set.add(resolve);
    waiters.set(id, set);
    const remaining = Math.max(0, record.expiresAt - nowMs());
    setTimeout(() => {
      const current = records.get(id);
      if (current && current.state === 'pending') settle(current, 'expired');
      resolve(records.get(id) || record);
    }, remaining).unref?.();
  });
}

export interface PreparedAskUserQuestionAnswer {
  readonly recordId: string;
  readonly sessionKey: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly actorUserId: string;
  readonly answers: Record<string, string>;
  readonly text: string;
}

export interface AskUserQuestionDeliveryReservation {
  readonly recordId: string;
  readonly actorUserId: string;
  readonly token: symbol;
}

function assertPendingRecordForActor(id: string, actorUserId: string): AskUserQuestionRecord {
  const record = records.get(id);
  if (!record || !actorUserId || record.ownerUserId !== actorUserId) {
    throw new AskUserQuestionError(
      'ASK_USER_NOT_FOUND',
      'That question is no longer open.',
      404,
    );
  }
  if (record.state !== 'pending') {
    throw new AskUserQuestionError(
      'ASK_USER_ALREADY_SETTLED',
      record.state === 'answered'
        ? 'That question was already answered.'
        : 'That question is no longer open.',
      409,
    );
  }
  return record;
}

/**
 * Validate and format an answer without changing broker state. The exact text
 * returned here is what must be accepted by the runtime before `commit` is
 * called. For one question Codex expects the raw answer; for multiple it
 * parses question-id keyed lines.
 */
export function prepareAskUserQuestionAnswer(input: {
  id: string;
  answers: Record<string, unknown>;
  actorUserId: string;
}): PreparedAskUserQuestionAnswer {
  expireOverdue();
  const record = assertPendingRecordForActor(input.id, input.actorUserId);
  // Native question IDs are model/runtime supplied. Require own JSON
  // properties and store results without an Object prototype so names such as
  // `constructor` and `__proto__` remain ordinary identities.
  const suppliedAnswers = input.answers && typeof input.answers === 'object'
    ? input.answers
    : {};
  const answers = Object.create(null) as Record<string, string>;
  for (const question of record.questions) {
    if (!Object.prototype.hasOwnProperty.call(suppliedAnswers, question.id)) {
      throw new AskUserQuestionError(
        'ASK_USER_ANSWER_INCOMPLETE',
        'Every question requires an answer.',
      );
    }
    const supplied = suppliedAnswers[question.id];
    let value = boundedText(supplied, 4_000);
    if (!value) {
      throw new AskUserQuestionError('ASK_USER_ANSWER_EMPTY', 'An answer is required.');
    }
    if (question.options.length > 0) {
      const numericIndex = /^\d+$/.test(value) ? Number(value) - 1 : -1;
      const indexedOption = numericIndex >= 0 && numericIndex < question.options.length
        ? question.options[numericIndex]
        : undefined;
      const labelledOption = question.options.find((option) => (
        option.label.toLowerCase() === value.toLowerCase()
      ));
      const matchedOption = indexedOption || labelledOption;
      if (matchedOption) {
        value = matchedOption.label;
      } else if (question.isOther !== true) {
        throw new AskUserQuestionError(
          'ASK_USER_ANSWER_INVALID',
          'The answer must match one of the available options.',
        );
      }
    }
    answers[question.id] = value;
  }
  const suppliedKeys = Object.keys(suppliedAnswers);
  if (suppliedKeys.some((key) => !record.questions.some((question) => question.id === key))) {
    throw new AskUserQuestionError(
      'ASK_USER_ANSWER_INVALID',
      'The answer contains an unknown question identity.',
    );
  }
  const text = record.questions.length === 1
    ? answers[record.questions[0].id]
    // OpenClaw's native parser guarantees numeric ordinal keys. Native IDs
    // containing `-`, `:` or `=` are not parseable as line keys.
    : record.questions.map((question, index) => `${index + 1}: ${answers[question.id]}`).join('\n');
  return {
    recordId: record.id,
    sessionKey: record.sessionKey,
    runId: record.runId,
    toolCallId: record.toolCallId,
    actorUserId: input.actorUserId,
    answers,
    text,
  };
}

export function reserveAskUserQuestionDelivery(
  id: string,
  actorUserId: string,
): AskUserQuestionDeliveryReservation {
  expireOverdue();
  assertPendingRecordForActor(id, actorUserId);
  if (deliveryReservations.has(id)) {
    throw new AskUserQuestionError(
      'ASK_USER_DELIVERY_IN_PROGRESS',
      'That answer is already being delivered.',
      409,
    );
  }
  const token = Symbol(id);
  deliveryReservations.set(id, token);
  return { recordId: id, actorUserId, token };
}

function assertDeliveryReservation(
  reservation: AskUserQuestionDeliveryReservation,
): AskUserQuestionRecord {
  if (deliveryReservations.get(reservation.recordId) !== reservation.token) {
    throw new AskUserQuestionError(
      'ASK_USER_DELIVERY_STALE',
      'That delivery attempt is no longer current.',
      409,
    );
  }
  return assertPendingRecordForActor(reservation.recordId, reservation.actorUserId);
}

export function releaseAskUserQuestionDelivery(
  reservation: AskUserQuestionDeliveryReservation,
): void {
  if (deliveryReservations.get(reservation.recordId) === reservation.token) {
    deliveryReservations.delete(reservation.recordId);
  }
  expireOverdue();
}

export function commitAskUserQuestionAnswer(
  prepared: PreparedAskUserQuestionAnswer,
  reservation: AskUserQuestionDeliveryReservation,
): AskUserQuestionRecord {
  const record = assertDeliveryReservation(reservation);
  if (
    prepared.recordId !== record.id
    || prepared.actorUserId !== record.ownerUserId
    || prepared.sessionKey !== record.sessionKey
    || prepared.runId !== record.runId
    || prepared.toolCallId !== record.toolCallId
  ) {
    throw new AskUserQuestionError(
      'ASK_USER_DELIVERY_STALE',
      'That delivery attempt no longer matches the pending question.',
      409,
    );
  }
  record.answers = prepared.answers;
  record.answeredAt = nowMs();
  settle(record, 'answered');
  return record;
}

export function commitAskUserQuestionCancellation(
  reservation: AskUserQuestionDeliveryReservation,
): AskUserQuestionRecord {
  const record = assertDeliveryReservation(reservation);
  settle(record, 'cancelled');
  return record;
}

/** Legacy synchronous settlement retained for the old loopback adapter. */
export function answerAskUserQuestion(input: {
  id: string;
  answers: Record<string, unknown>;
  actorUserId: string;
}): AskUserQuestionRecord {
  const prepared = prepareAskUserQuestionAnswer(input);
  const reservation = reserveAskUserQuestionDelivery(input.id, input.actorUserId);
  try {
    return commitAskUserQuestionAnswer(prepared, reservation);
  } finally {
    releaseAskUserQuestionDelivery(reservation);
  }
}

/** Legacy synchronous settlement retained for the old loopback adapter. */
export function cancelAskUserQuestion(input: { id: string; actorUserId: string }): void {
  const reservation = reserveAskUserQuestionDelivery(input.id, input.actorUserId);
  try {
    commitAskUserQuestionCancellation(reservation);
  } finally {
    releaseAskUserQuestionDelivery(reservation);
  }
}

export function listPendingAskUserQuestions(input: {
  actorUserId: string;
  sessionKey?: string;
}): AskUserQuestionPublicRecord[] {
  expireOverdue();
  const actorUserId = boundedText(input.actorUserId, 128);
  if (!actorUserId) return [];
  return Array.from(records.values())
    .filter((record) => record.state === 'pending')
    .filter((record) => record.ownerUserId === actorUserId)
    .filter((record) => !input.sessionKey || record.sessionKey === input.sessionKey)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toPublic);
}

/**
 * Reconcile the in-memory presentation cache with authoritative runtime
 * snapshots. Only records inside the authenticated actor/scope are touched;
 * in-flight deliveries are left alone until their exact RPC settles.
 */
export function reconcilePendingAskUserQuestions(input: {
  actorUserId: string;
  sessionKey?: string;
  activeCalls: Array<{ sessionKey: string; runId: string; toolCallId: string }>;
}): void {
  expireOverdue();
  const actorUserId = boundedText(input.actorUserId, 128);
  const sessionKey = input.sessionKey == null ? '' : boundedText(input.sessionKey, 512);
  if (!actorUserId) return;
  const active = new Set(input.activeCalls.map((call) => (
    [call.sessionKey, call.runId, call.toolCallId].join('\u0000')
  )));
  for (const record of records.values()) {
    if (
      record.state !== 'pending'
      || record.ownerUserId !== actorUserId
      || (sessionKey && record.sessionKey !== sessionKey)
      || deliveryReservations.has(record.id)
    ) continue;
    if (!active.has(callIdentityKey(record))) settle(record, 'cancelled');
  }
}

export function subscribeAskUserQuestions(
  actorUserId: string,
  listener: (record: AskUserQuestionPublicRecord) => void,
): () => void {
  const owner = boundedText(actorUserId, 128);
  if (!owner) return () => undefined;
  const scopedListener = (record: AskUserQuestionPublicRecord) => {
    const stored = records.get(record.id);
    if (stored?.ownerUserId === owner) listener(record);
  };
  listeners.add(scopedListener);
  return () => listeners.delete(scopedListener);
}

/**
 * The string handed back to the model as the tool result. Plain and literal:
 * the model asked a question and this is what the human said.
 */
export function formatAskUserAnswerForModel(record: AskUserQuestionRecord): string {
  if (record.state === 'answered' && record.answers) {
    if (record.questions.length === 1) {
      const answer = record.answers[record.questions[0].id];
      if (answer) return answer;
    }
    const lines = record.questions
      .map((question, index) => {
        const answer = Object.prototype.hasOwnProperty.call(record.answers, question.id)
          ? record.answers?.[question.id]
          : undefined;
        return answer ? `${index + 1}: ${answer}` : null;
      })
      .filter((line): line is string => Boolean(line));
    if (lines.length > 0) return lines.join('\n');
  }
  if (record.state === 'cancelled') return 'The user dismissed the question without answering.';
  return 'The user did not answer the questions.';
}

/** Test-only reset so suites do not leak state between cases. */
export function __resetAskUserQuestionsForTests(): void {
  records.clear();
  recordIdsByCallIdentity.clear();
  deliveryReservations.clear();
  waiters.clear();
  listeners.clear();
}
