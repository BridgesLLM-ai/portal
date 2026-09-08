'use strict';

/**
 * BridgesLLM Portal runtime guards for OpenClaw 2026.9.1.
 *
 * OpenClaw owns the complete question surface: the native `ask_user` tool,
 * `question.list` / `question.get` / `question.resolve`, and the
 * `question.requested` / `question.resolved` events. This plugin deliberately
 * registers no question tool, question hook, or parallel question RPC.
 *
 * The only chat method retained here is exact-run steering. OpenClaw does not
 * expose the transcript-commit acknowledgement Portal needs through its stock
 * session-level steer API, so the pinned compatibility bridge publishes that
 * narrow process-local adapter.
 */

const {
  resolveActiveEmbeddedRunSessionId,
} = require('openclaw/plugin-sdk/agent-harness-runtime');
const { createHash } = require('node:crypto');

const ACTIVE_RUN_RUNTIME_SYMBOL = Symbol.for('bridgesllm.openclaw.active-run-steer.v1');
const GATEWAY_METHODS = Object.freeze({
  steer: 'bridgesllm.ask_user.steer',
});
const MAX_SESSION_KEY_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 512;
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
  'PENDING_INPUT',
  'QUEUE_REJECTED',
  'DELIVERY_UNCONFIRMED',
  'ACCEPTANCE_UNCONFIRMED',
  'HOTFIX_ERROR',
]);
const TERMINAL_AMBIGUITY_CODES = new Set([
  'DELIVERY_UNCONFIRMED',
  'ACCEPTANCE_UNCONFIRMED',
]);

/** Accepted receipts make exact retries safe after a lost gateway response. */
const terminalReceipts = new Map();
/** A same-identity retry joins the in-flight side effect instead of replaying it. */
const inFlightReceipts = new Map();

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

function textDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pruneTerminalReceipts(now) {
  for (const [key, receipt] of terminalReceipts) {
    if (receipt.expiresAt <= now) terminalReceipts.delete(key);
  }
}

function nonAcceptance(respond, code, extra = {}) {
  respond(true, { accepted: false, code, ...extra });
}

function replayOrConflict(respond, key, digest, requestId, runId) {
  const receipt = terminalReceipts.get(key);
  if (!receipt) return false;
  if (receipt.digest !== digest) {
    nonAcceptance(respond, 'REQUEST_CONFLICT', { requestId, runId });
    return true;
  }
  const { terminal: _terminal, ...outcome } = receipt.outcome;
  respond(true, { ...outcome, replayed: true });
  return true;
}

async function runDeduplicatedSteer({ respond, key, digest, requestId, runId, execute }) {
  const now = Date.now();
  pruneTerminalReceipts(now);
  if (replayOrConflict(respond, key, digest, requestId, runId)) return;

  const existing = inFlightReceipts.get(key);
  if (existing) {
    if (existing.digest !== digest) {
      nonAcceptance(respond, 'REQUEST_CONFLICT', { requestId, runId });
      return;
    }
    const outcome = await existing.promise;
    const { terminal: _terminal, ...publicOutcome } = outcome;
    respond(true, outcome.accepted === true
      ? { ...publicOutcome, replayed: true }
      : publicOutcome);
    return;
  }
  if (terminalReceipts.size + inFlightReceipts.size >= MAX_TERMINAL_RECEIPTS) {
    nonAcceptance(respond, 'DEDUPE_CAPACITY', { requestId, runId });
    return;
  }

  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const receipt = { digest, promise };
  inFlightReceipts.set(key, receipt);

  let outcome;
  try {
    outcome = await execute();
  } catch {
    outcome = { accepted: false, code: 'HOTFIX_ERROR', requestId };
  }
  if (!outcome || typeof outcome !== 'object') {
    outcome = { accepted: false, code: 'HOTFIX_ERROR', requestId };
  }
  if (inFlightReceipts.get(key) === receipt) inFlightReceipts.delete(key);
  if (outcome.accepted === true || outcome.terminal === true) {
    terminalReceipts.set(key, {
      digest,
      outcome: { ...outcome },
      expiresAt: Date.now() + TERMINAL_RECEIPT_TTL_MS,
    });
  }
  settle(outcome);
  const { terminal: _terminal, ...publicOutcome } = outcome;
  respond(true, outcome.accepted === true
    ? { ...publicOutcome, replayed: false }
    : publicOutcome);
}

function respondInvalid(respond, message) {
  respond(false, { accepted: false, code: 'INVALID_REQUEST' }, {
    code: 'invalid_request',
    message,
  });
}

function resolveSteerTarget(params) {
  const sessionKey = boundedIdentifier(params?.sessionKey, MAX_SESSION_KEY_LENGTH);
  const expectedRunId = boundedIdentifier(params?.expectedRunId, MAX_RUN_ID_LENGTH);
  if (!sessionKey || !expectedRunId) return { error: 'INVALID_REQUEST' };
  const sessionId = boundedIdentifier(
    resolveActiveEmbeddedRunSessionId(sessionKey),
    MAX_SESSION_ID_LENGTH,
  );
  if (!sessionId) return { error: 'NO_ACTIVE_RUN', sessionKey, expectedRunId };
  const runtime = globalThis[ACTIVE_RUN_RUNTIME_SYMBOL];
  if (!runtime || runtime.version !== 1 || typeof runtime.steer !== 'function') {
    return { error: 'HOTFIX_UNAVAILABLE', sessionKey, expectedRunId, sessionId };
  }
  return { runtime, sessionKey, expectedRunId, sessionId };
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
    const key = receiptKey(sessionKey, expectedRunId, requestId);
    const digest = textDigest(text);
    await runDeduplicatedSteer({
      respond,
      key,
      digest,
      requestId,
      runId: expectedRunId,
      execute: async () => {
        const target = resolveSteerTarget({ sessionKey, expectedRunId });
        if (target.error) return { accepted: false, code: target.error, requestId };
        let outcome;
        try {
          outcome = await target.runtime.steer(target.sessionId, target.expectedRunId, text);
        } catch {
          outcome = { ok: false, code: 'HOTFIX_ERROR' };
        }
        if (
          outcome?.ok === true
          && outcome.code === 'STEERED'
          && outcome.runId === target.expectedRunId
        ) {
          return {
            accepted: true,
            code: 'STEERED',
            requestId,
            runId: target.expectedRunId,
          };
        }
        const code = RUNTIME_REJECTION_CODES.has(outcome?.code)
          ? outcome.code
          : 'RUNTIME_REJECTED';
        const terminal = TERMINAL_AMBIGUITY_CODES.has(code)
          && outcome?.terminal === true
          && outcome?.retryable === false;
        return {
          accepted: false,
          code,
          requestId,
          ...(outcome?.runId === target.expectedRunId ? { runId: target.expectedRunId } : {}),
          ...(terminal ? { terminal: true, retryable: false } : {}),
        };
      },
    });
  }, { scope: 'operator.write' });
}

module.exports = {
  name: 'bridgesllm-ask-user',
  register(api) {
    registerSteerMethod(api);
  },
  __test: {
    GATEWAY_METHODS,
    ACTIVE_RUN_RUNTIME_SYMBOL,
    TERMINAL_RECEIPT_TTL_MS,
    MAX_TERMINAL_RECEIPTS,
    dedupeCounts() {
      return {
        inFlight: inFlightReceipts.size,
        terminal: terminalReceipts.size,
      };
    },
    reset() {
      terminalReceipts.clear();
      inFlightReceipts.clear();
    },
  },
};
