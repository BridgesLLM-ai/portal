'use strict';

/**
 * BridgesLLM native Codex pending-input bridge.
 *
 * OpenClaw's generic plugin hooks do not observe Codex
 * `item/tool/requestUserInput`. Portal's exact pinned OpenClaw compatibility
 * patch exposes that pending request through a process-local Symbol API. This
 * plugin intentionally does not fall back to chat.send, turn/steer, or a
 * generic harness queue: each of those can deliver a late answer to a newer
 * run on the same durable session.
 */

const {
  resolveActiveEmbeddedRunSessionId,
} = require('openclaw/plugin-sdk/agent-harness-runtime');
const { createHash } = require('node:crypto');

const RUNTIME_SYMBOL = Symbol.for('bridgesllm.openclaw.pending-input.v1');
const GATEWAY_METHODS = Object.freeze({
  pending: 'bridgesllm.ask_user.pending',
  answer: 'bridgesllm.ask_user.answer',
  dismiss: 'bridgesllm.ask_user.dismiss',
  steer: 'bridgesllm.ask_user.steer',
});
const MAX_SESSION_KEY_LENGTH = 512;
const MAX_RUN_ID_LENGTH = 512;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 32_768;
const TERMINAL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RECEIPTS = 2_048;
const IDENTIFIER_CONTROLS = /[\u0000-\u001F\u007F]/;
const TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const RUNTIME_REJECTION_CODES = new Set([
  'INVALID_IDENTITY',
  'NO_ACTIVE_RUN',
  'RUN_MISMATCH',
  'NO_PENDING_INPUT',
  'INVALID_REQUEST_ID',
  'REQUEST_MISMATCH',
  'REQUEST_EXPIRED',
  'INVALID_ANSWER',
  'PENDING_INPUT',
  'QUEUE_REJECTED',
]);
/**
 * Accepted receipts make an exact retry safe when OpenClaw consumed the
 * answer but the gateway response or Portal broker commit was interrupted.
 * Store only a digest for answers so secret/free-text values are not retained.
 */
const terminalReceipts = new Map();

function boundedIdentifier(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || IDENTIFIER_CONTROLS.test(normalized)) {
    return null;
  }
  return normalized;
}

function boundedText(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_LENGTH || TEXT_CONTROLS.test(normalized)) {
    return null;
  }
  return normalized;
}

function receiptKey(sessionKey, expectedRunId, requestId) {
  return `${sessionKey}\u0000${expectedRunId}\u0000${requestId}`;
}

function answerDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pruneTerminalReceipts(now) {
  for (const [key, receipt] of terminalReceipts) {
    if (receipt.expiresAt <= now) terminalReceipts.delete(key);
  }
}

function replayOrConflict(respond, key, action, digest, requestId, runId) {
  const receipt = terminalReceipts.get(key);
  if (!receipt) return false;
  if (receipt.action !== action || receipt.digest !== digest) {
    nonAcceptance(respond, 'REQUEST_CONFLICT', { requestId, runId });
    return true;
  }
  respond(true, {
    accepted: true,
    replayed: true,
    code: action === 'answer' ? 'ANSWERED' : action === 'dismiss' ? 'DISMISSED' : 'STEERED',
    requestId,
    runId,
  });
  return true;
}

function reserveReceiptCapacity(respond, requestId, runId) {
  if (terminalReceipts.size < MAX_TERMINAL_RECEIPTS) return true;
  nonAcceptance(respond, 'DEDUPE_CAPACITY', { requestId, runId });
  return false;
}

function recordTerminalReceipt(key, action, digest, now) {
  terminalReceipts.set(key, {
    action,
    digest,
    acceptedAt: now,
    expiresAt: now + TERMINAL_RECEIPT_TTL_MS,
  });
}

function runtimeApi() {
  const candidate = globalThis[RUNTIME_SYMBOL];
  if (
    !candidate
    || candidate.version !== 1
    || typeof candidate.read !== 'function'
    || typeof candidate.answer !== 'function'
    || typeof candidate.dismiss !== 'function'
    || typeof candidate.steer !== 'function'
  ) return null;
  return candidate;
}

function respondInvalid(respond, message) {
  respond(false, { accepted: false, code: 'INVALID_REQUEST' }, {
    code: 'invalid_request',
    message,
  });
}

function resolveRuntimeTarget(params) {
  const sessionKey = boundedIdentifier(params?.sessionKey, MAX_SESSION_KEY_LENGTH);
  const expectedRunId = boundedIdentifier(params?.expectedRunId, MAX_RUN_ID_LENGTH);
  if (!sessionKey || !expectedRunId) return { error: 'INVALID_REQUEST' };
  const sessionId = resolveActiveEmbeddedRunSessionId(sessionKey);
  if (!sessionId) return { error: 'NO_ACTIVE_RUN', sessionKey, expectedRunId };
  const runtime = runtimeApi();
  if (!runtime) return { error: 'HOTFIX_UNAVAILABLE', sessionKey, expectedRunId, sessionId };
  return { runtime, sessionKey, expectedRunId, sessionId };
}

function validPendingSnapshot(snapshot, expectedRunId) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (boundedIdentifier(snapshot.requestId, MAX_REQUEST_ID_LENGTH) !== snapshot.requestId) return false;
  if (boundedIdentifier(snapshot.runId, MAX_RUN_ID_LENGTH) !== expectedRunId) return false;
  if (!Number.isFinite(snapshot.createdAt) || !Number.isFinite(snapshot.expiresAt)) return false;
  if (snapshot.createdAt <= 0 || snapshot.expiresAt <= snapshot.createdAt) return false;
  if (!Array.isArray(snapshot.questions) || snapshot.questions.length < 1 || snapshot.questions.length > 4) {
    return false;
  }
  return snapshot.questions.every((question) => {
    if (!question || typeof question !== 'object') return false;
    if (!boundedIdentifier(question.id, MAX_REQUEST_ID_LENGTH)) return false;
    if (typeof question.question !== 'string' || !question.question.trim() || question.question.length > 2_000) {
      return false;
    }
    if (question.header != null && (typeof question.header !== 'string' || question.header.length > 64)) {
      return false;
    }
    if (typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean') return false;
    if (!Array.isArray(question.options) || question.options.length > 8) return false;
    return question.options.every((option) => (
      option
      && typeof option === 'object'
      && typeof option.label === 'string'
      && option.label.trim().length > 0
      && option.label.length <= 200
      && (option.description == null
        || (typeof option.description === 'string' && option.description.length <= 500))
    ));
  });
}

function nonAcceptance(respond, code, extra = {}) {
  respond(true, { accepted: false, code, ...extra });
}

function registerPendingMethod(api) {
  api.registerGatewayMethod(GATEWAY_METHODS.pending, async ({ params, respond }) => {
    const target = resolveRuntimeTarget(params);
    if (target.error === 'INVALID_REQUEST') {
      respondInvalid(respond, 'sessionKey and expectedRunId must be valid bounded strings.');
      return;
    }
    if (target.error) {
      respond(true, { pending: false, code: target.error });
      return;
    }
    try {
      const snapshot = target.runtime.read(target.sessionId, target.expectedRunId);
      if (snapshot == null) {
        respond(true, { pending: false, code: 'NO_PENDING_INPUT' });
        return;
      }
      if (!validPendingSnapshot(snapshot, target.expectedRunId)) {
        respond(true, { pending: false, code: 'HOTFIX_INVALID_STATE' });
        return;
      }
      respond(true, {
        pending: true,
        requestId: snapshot.requestId,
        runId: snapshot.runId,
        questions: snapshot.questions,
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt,
      });
    } catch {
      respond(true, { pending: false, code: 'HOTFIX_ERROR' });
    }
  }, { scope: 'operator.write' });
}

function registerAnswerMethod(api) {
  api.registerGatewayMethod(GATEWAY_METHODS.answer, async ({ params, respond }) => {
    const sessionKey = boundedIdentifier(params?.sessionKey, MAX_SESSION_KEY_LENGTH);
    const expectedRunId = boundedIdentifier(params?.expectedRunId, MAX_RUN_ID_LENGTH);
    const requestId = boundedIdentifier(params?.requestId, MAX_REQUEST_ID_LENGTH);
    const answer = boundedText(params?.text);
    if (!sessionKey || !expectedRunId || !requestId || !answer) {
      respondInvalid(
        respond,
        'sessionKey, expectedRunId, requestId, and text must be valid bounded strings.',
      );
      return;
    }
    const now = Date.now();
    pruneTerminalReceipts(now);
    const key = receiptKey(sessionKey, expectedRunId, requestId);
    const digest = answerDigest(answer);
    if (replayOrConflict(respond, key, 'answer', digest, requestId, expectedRunId)) return;
    if (!reserveReceiptCapacity(respond, requestId, expectedRunId)) return;
    const target = resolveRuntimeTarget({ sessionKey, expectedRunId });
    if (target.error) {
      nonAcceptance(respond, target.error, { requestId });
      return;
    }
    try {
      const outcome = target.runtime.answer(
        target.sessionId,
        target.expectedRunId,
        requestId,
        answer,
      );
      if (
        outcome?.ok === true
        && outcome.code === 'ANSWERED'
        && outcome.requestId === requestId
        && outcome.runId === target.expectedRunId
      ) {
        recordTerminalReceipt(key, 'answer', digest, now);
        respond(true, {
          accepted: true,
          replayed: false,
          code: 'ANSWERED',
          requestId,
          runId: target.expectedRunId,
        });
        return;
      }
      const code = RUNTIME_REJECTION_CODES.has(outcome?.code)
        ? outcome.code
        : 'RUNTIME_REJECTED';
      nonAcceptance(respond, code, {
        requestId,
        ...(outcome?.runId === target.expectedRunId ? { runId: target.expectedRunId } : {}),
      });
    } catch {
      nonAcceptance(respond, 'HOTFIX_ERROR', { requestId });
    }
  }, { scope: 'operator.write' });
}

function registerDismissMethod(api) {
  api.registerGatewayMethod(GATEWAY_METHODS.dismiss, async ({ params, respond }) => {
    const sessionKey = boundedIdentifier(params?.sessionKey, MAX_SESSION_KEY_LENGTH);
    const expectedRunId = boundedIdentifier(params?.expectedRunId, MAX_RUN_ID_LENGTH);
    const requestId = boundedIdentifier(params?.requestId, MAX_REQUEST_ID_LENGTH);
    if (!sessionKey || !expectedRunId || !requestId) {
      respondInvalid(
        respond,
        'sessionKey, expectedRunId, and requestId must be valid bounded strings.',
      );
      return;
    }
    const now = Date.now();
    pruneTerminalReceipts(now);
    const key = receiptKey(sessionKey, expectedRunId, requestId);
    if (replayOrConflict(respond, key, 'dismiss', '', requestId, expectedRunId)) return;
    if (!reserveReceiptCapacity(respond, requestId, expectedRunId)) return;
    const target = resolveRuntimeTarget({ sessionKey, expectedRunId });
    if (target.error) {
      nonAcceptance(respond, target.error, { requestId });
      return;
    }
    try {
      const outcome = target.runtime.dismiss(
        target.sessionId,
        target.expectedRunId,
        requestId,
      );
      if (
        outcome?.ok === true
        && outcome.code === 'DISMISSED'
        && outcome.requestId === requestId
        && outcome.runId === target.expectedRunId
      ) {
        recordTerminalReceipt(key, 'dismiss', '', now);
        respond(true, {
          accepted: true,
          replayed: false,
          code: 'DISMISSED',
          requestId,
          runId: target.expectedRunId,
        });
        return;
      }
      const code = RUNTIME_REJECTION_CODES.has(outcome?.code)
        ? outcome.code
        : 'RUNTIME_REJECTED';
      nonAcceptance(respond, code, {
        requestId,
        ...(outcome?.runId === target.expectedRunId ? { runId: target.expectedRunId } : {}),
      });
    } catch {
      nonAcceptance(respond, 'HOTFIX_ERROR', { requestId });
    }
  }, { scope: 'operator.write' });
}

function registerSteerMethod(api) {
  api.registerGatewayMethod(GATEWAY_METHODS.steer, async ({ params, respond }) => {
    const sessionKey = boundedIdentifier(params?.sessionKey, MAX_SESSION_KEY_LENGTH);
    const expectedRunId = boundedIdentifier(params?.expectedRunId, MAX_RUN_ID_LENGTH);
    const requestId = boundedIdentifier(params?.requestId, MAX_REQUEST_ID_LENGTH);
    const text = boundedText(params?.text);
    if (!sessionKey || !expectedRunId || !requestId || !text) {
      respondInvalid(
        respond,
        'sessionKey, expectedRunId, requestId, and text must be valid bounded strings.',
      );
      return;
    }
    const now = Date.now();
    pruneTerminalReceipts(now);
    const key = receiptKey(sessionKey, expectedRunId, requestId);
    const digest = answerDigest(text);
    if (replayOrConflict(respond, key, 'steer', digest, requestId, expectedRunId)) return;
    if (!reserveReceiptCapacity(respond, requestId, expectedRunId)) return;
    const target = resolveRuntimeTarget({ sessionKey, expectedRunId });
    if (target.error) {
      nonAcceptance(respond, target.error, { requestId });
      return;
    }
    try {
      const outcome = await target.runtime.steer(
        target.sessionId,
        target.expectedRunId,
        text,
      );
      if (
        outcome?.ok === true
        && outcome.code === 'STEERED'
        && outcome.runId === target.expectedRunId
      ) {
        recordTerminalReceipt(key, 'steer', digest, now);
        respond(true, {
          accepted: true,
          replayed: false,
          code: 'STEERED',
          requestId,
          runId: target.expectedRunId,
        });
        return;
      }
      const code = RUNTIME_REJECTION_CODES.has(outcome?.code)
        ? outcome.code
        : 'RUNTIME_REJECTED';
      nonAcceptance(respond, code, {
        requestId,
        ...(outcome?.runId === target.expectedRunId ? { runId: target.expectedRunId } : {}),
      });
    } catch {
      nonAcceptance(respond, 'HOTFIX_ERROR', { requestId });
    }
  }, { scope: 'operator.write' });
}

module.exports = {
  name: 'bridgesllm-ask-user',
  register(api) {
    registerPendingMethod(api);
    registerAnswerMethod(api);
    registerDismissMethod(api);
    registerSteerMethod(api);
  },
  __test: {
    GATEWAY_METHODS,
    RUNTIME_SYMBOL,
    TERMINAL_RECEIPT_TTL_MS,
    MAX_TERMINAL_RECEIPTS,
    reset() {
      terminalReceipts.clear();
    },
  },
};
