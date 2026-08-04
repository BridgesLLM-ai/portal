'use strict';

/**
 * BridgesLLM owner-scoped ask-user bridge.
 *
 * Native Codex `item/tool/requestUserInput` bypasses OpenClaw's ordinary tool
 * hooks, so the pinned Codex runtime exposes those requests through a
 * process-local Symbol API. Other providers use this plugin's required
 * `ask_user_question` tool. Both paths settle through the same exact
 * session/run/tool-call gateway methods; there is deliberately no chat.send,
 * turn/steer, or session-only fallback that could deliver a late answer to a
 * newer run on the same durable session.
 */

const {
  resolveActiveEmbeddedRunSessionId,
} = require('openclaw/plugin-sdk/agent-harness-runtime');
const { createHash } = require('node:crypto');

// OpenClaw core and the independently installed Codex provider ship separate
// copies of the embedded run bundle. Keep their process-local bridges on
// separate symbols: defining the same non-configurable Symbol API twice makes
// the second bundle fail during module evaluation. The provider is preferred
// because current installs execute Codex turns there; the core symbol remains
// a compatibility fallback for older/runtime-native layouts.
const RUNTIME_SYMBOLS = Object.freeze([
  Symbol.for('bridgesllm.openclaw.pending-input.codex-plugin.v1'),
  Symbol.for('bridgesllm.openclaw.pending-input.v1'),
]);
const RUNTIME_SYMBOL = RUNTIME_SYMBOLS[1];
const GATEWAY_METHODS = Object.freeze({
  pending: 'bridgesllm.ask_user.pending',
  answer: 'bridgesllm.ask_user.answer',
  dismiss: 'bridgesllm.ask_user.dismiss',
  steer: 'bridgesllm.ask_user.steer',
});
const ASK_USER_TOOL_NAME = 'ask_user_question';
const MAX_SESSION_KEY_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_RUN_ID_LENGTH = 512;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 32_768;
const MAX_GENERIC_QUESTIONS = 3;
const MAX_GENERIC_OPTIONS = 3;
const GENERIC_PENDING_TTL_MS = 10 * 60 * 1000;
const TOOL_BINDING_TTL_MS = 30_000;
const MAX_TOOL_BINDINGS = 256;
const MAX_GENERIC_PENDING = 64;
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
  'HOTFIX_ERROR',
]);
const RUNTIME_ADAPTER_MISS_CODES = new Set([
  'NO_ACTIVE_RUN',
  'RUN_MISMATCH',
  'NO_PENDING_INPUT',
  'REQUEST_MISMATCH',
]);
/**
 * Accepted receipts make an exact retry safe when OpenClaw consumed the
 * answer but the gateway response or Portal broker commit was interrupted.
 * Store only a digest for answers so secret/free-text values are not retained.
 */
const terminalReceipts = new Map();
/**
 * `before_tool_call` is the host-authoritative source for runId. Tool factory
 * context intentionally does not expose it, so short-lived one-shot bindings
 * carry exact identities into execute(). A secondary lookup never overwrites
 * a reused provider tool-call id: ambiguous runs fail closed instead.
 */
const toolCallBindings = new Map();
const toolCallBindingLookup = new Map();
const toolCallBindingCountsBySession = new Map();
/**
 * OpenClaw deliberately omits runId from tool execute() context. Once the
 * same session+tool-call identity becomes ambiguous, keep it ineligible for
 * that embedded session's entire lifetime. A delayed execute has no bounded
 * arrival time, so elapsed time is not proof that reusing the identity is
 * safe. Only an OpenClaw-attested embedded session-id rollover reclaims it.
 * Quarantine and capacity are scoped to one embedded session, so a broken
 * provider run cannot disable unrelated Anthropic/OpenClaw sessions.
 */
const quarantinedToolCallIdentities = new Map();
const saturatedToolCallSessions = new Set();
const activeToolCallSessionBySessionKey = new Map();
/** Plugin-owned pending calls for non-Codex providers. Keyed by session+run. */
const genericPendingRequests = new Map();

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

function boundedModelText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || TEXT_CONTROLS.test(normalized)) {
    return null;
  }
  return normalized;
}

function canonicalToolName(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[.\-\s]+/g, '_')
    : '';
}

function toolBindingLookupKey(sessionId, toolCallId) {
  return `${sessionId}\u0000${toolCallId}`;
}

function exactToolBindingKey(sessionKey, sessionId, runId, toolCallId) {
  return `${sessionKey}\u0000${sessionId}\u0000${runId}\u0000${toolCallId}`;
}

function genericRunKey(sessionId, runId) {
  return `${sessionId}\u0000${runId}`;
}

function removeToolCallBinding(exactKey, binding) {
  const removed = toolCallBindings.delete(exactKey);
  if (removed) {
    const nextCount = (toolCallBindingCountsBySession.get(binding.sessionId) || 1) - 1;
    if (nextCount > 0) toolCallBindingCountsBySession.set(binding.sessionId, nextCount);
    else toolCallBindingCountsBySession.delete(binding.sessionId);
  }
  const lookupKey = toolBindingLookupKey(binding.sessionId, binding.toolCallId);
  const exactKeys = toolCallBindingLookup.get(lookupKey);
  if (!exactKeys) return;
  exactKeys.delete(exactKey);
  if (exactKeys.size === 0) toolCallBindingLookup.delete(lookupKey);
}

function toolCallIdentityIsQuarantined(sessionId, toolCallId) {
  return saturatedToolCallSessions.has(sessionId)
    || quarantinedToolCallIdentities.get(sessionId)?.has(toolCallId) === true;
}

function quarantineToolCallIdentity(sessionId, toolCallId) {
  const lookupKey = toolBindingLookupKey(sessionId, toolCallId);
  if (!saturatedToolCallSessions.has(sessionId)) {
    const quarantinedIds = quarantinedToolCallIdentities.get(sessionId) || new Set();
    if (!quarantinedIds.has(toolCallId)) {
      if (quarantinedIds.size >= MAX_TOOL_BINDINGS) {
        quarantinedToolCallIdentities.delete(sessionId);
        saturatedToolCallSessions.add(sessionId);
      } else {
        quarantinedIds.add(toolCallId);
        quarantinedToolCallIdentities.set(sessionId, quarantinedIds);
      }
    }
  }
  const exactKeys = toolCallBindingLookup.get(lookupKey);
  if (!exactKeys) return;
  for (const exactKey of [...exactKeys]) {
    const binding = toolCallBindings.get(exactKey);
    if (binding) removeToolCallBinding(exactKey, binding);
    else exactKeys.delete(exactKey);
  }
  toolCallBindingLookup.delete(lookupKey);
}

function clearToolCallSessionState(sessionId) {
  quarantinedToolCallIdentities.delete(sessionId);
  saturatedToolCallSessions.delete(sessionId);
  for (const [exactKey, binding] of [...toolCallBindings]) {
    if (binding.sessionId === sessionId) removeToolCallBinding(exactKey, binding);
  }
  toolCallBindingCountsBySession.delete(sessionId);
}

function observeAuthoritativeToolCallSession(sessionKey, sessionId) {
  let activeSessionId = null;
  try {
    activeSessionId = boundedIdentifier(
      resolveActiveEmbeddedRunSessionId(sessionKey),
      MAX_SESSION_ID_LENGTH,
    );
  } catch {
    // The host hook still attests its own context. Resolver availability only
    // controls whether an older session's quarantine can be reclaimed safely.
  }
  if (activeSessionId && activeSessionId !== sessionId) return false;

  const previousSessionId = activeToolCallSessionBySessionKey.get(sessionKey);
  if (activeSessionId === sessionId && previousSessionId && previousSessionId !== sessionId) {
    clearToolCallSessionState(previousSessionId);
  }
  if (!previousSessionId || previousSessionId === sessionId || activeSessionId === sessionId) {
    // This map is cleanup metadata, not an authority source. Evicting its
    // oldest entry leaves quarantine intact and therefore cannot fail open.
    if (!activeToolCallSessionBySessionKey.has(sessionKey)
      && activeToolCallSessionBySessionKey.size >= MAX_TOOL_BINDINGS) {
      activeToolCallSessionBySessionKey.delete(activeToolCallSessionBySessionKey.keys().next().value);
    }
    activeToolCallSessionBySessionKey.delete(sessionKey);
    activeToolCallSessionBySessionKey.set(sessionKey, sessionId);
  }
  return true;
}

function pruneToolCallBindings(now = Date.now()) {
  for (const [exactKey, binding] of toolCallBindings) {
    if (binding.expiresAt <= now) {
      // An execute that did not arrive before its attestation expired can
      // still arrive later. Retiring the pair prevents it from consuming a
      // future run that happens to reuse the provider's tool-call id.
      quarantineToolCallIdentity(binding.sessionId, binding.toolCallId);
    }
  }
}

function recordAskUserToolBinding(event, context) {
  const eventToolName = canonicalToolName(event?.toolName);
  const contextToolName = canonicalToolName(context?.toolName);
  if (eventToolName !== ASK_USER_TOOL_NAME && contextToolName !== ASK_USER_TOOL_NAME) return;
  const eventRunId = boundedIdentifier(event?.runId, MAX_RUN_ID_LENGTH);
  const contextRunId = boundedIdentifier(context?.runId, MAX_RUN_ID_LENGTH);
  const eventToolCallId = boundedIdentifier(event?.toolCallId, MAX_REQUEST_ID_LENGTH);
  const contextToolCallId = boundedIdentifier(context?.toolCallId, MAX_REQUEST_ID_LENGTH);
  const sessionKey = boundedIdentifier(context?.sessionKey, MAX_SESSION_KEY_LENGTH);
  const sessionId = boundedIdentifier(context?.sessionId, MAX_SESSION_ID_LENGTH);
  const runId = contextRunId || eventRunId;
  const toolCallId = contextToolCallId || eventToolCallId;
  if (
    eventToolName !== ASK_USER_TOOL_NAME
    || contextToolName !== ASK_USER_TOOL_NAME
    || !sessionKey
    || !sessionId
    || !runId
    || !toolCallId
    || (eventRunId && contextRunId && eventRunId !== contextRunId)
    || (eventToolCallId && contextToolCallId && eventToolCallId !== contextToolCallId)
  ) {
    if (sessionId) {
      const candidateToolCallIds = new Set([eventToolCallId, contextToolCallId].filter(Boolean));
      for (const candidateToolCallId of candidateToolCallIds) {
        quarantineToolCallIdentity(sessionId, candidateToolCallId);
      }
    }
    return;
  }

  const now = Date.now();
  pruneToolCallBindings(now);
  if (!observeAuthoritativeToolCallSession(sessionKey, sessionId)) {
    quarantineToolCallIdentity(sessionId, toolCallId);
    return;
  }
  if (toolCallIdentityIsQuarantined(sessionId, toolCallId)) return;
  const exactKey = exactToolBindingKey(sessionKey, sessionId, runId, toolCallId);
  const lookupKey = toolBindingLookupKey(sessionId, toolCallId);
  const existingExactKeys = toolCallBindingLookup.get(lookupKey);
  if (existingExactKeys && [...existingExactKeys].some((key) => key !== exactKey)) {
    quarantineToolCallIdentity(sessionId, toolCallId);
    return;
  }
  if (
    !toolCallBindings.has(exactKey)
    && (toolCallBindingCountsBySession.get(sessionId) || 0) >= MAX_TOOL_BINDINGS
  ) {
    quarantineToolCallIdentity(sessionId, toolCallId);
    return;
  }
  const binding = {
    sessionKey,
    sessionId,
    runId,
    toolCallId,
    expiresAt: now + TOOL_BINDING_TTL_MS,
  };
  const isNewBinding = !toolCallBindings.has(exactKey);
  toolCallBindings.set(exactKey, binding);
  if (isNewBinding) {
    toolCallBindingCountsBySession.set(
      sessionId,
      (toolCallBindingCountsBySession.get(sessionId) || 0) + 1,
    );
  }
  const exactKeys = toolCallBindingLookup.get(lookupKey) || new Set();
  exactKeys.add(exactKey);
  toolCallBindingLookup.set(lookupKey, exactKeys);
}

function consumeAskUserToolBinding(toolContext, rawToolCallId) {
  const sessionKey = boundedIdentifier(toolContext?.sessionKey, MAX_SESSION_KEY_LENGTH);
  const sessionId = boundedIdentifier(toolContext?.sessionId, MAX_SESSION_ID_LENGTH);
  const toolCallId = boundedIdentifier(rawToolCallId, MAX_REQUEST_ID_LENGTH);
  if (!sessionId || !toolCallId) return null;
  if (!sessionKey) {
    quarantineToolCallIdentity(sessionId, toolCallId);
    return null;
  }
  const now = Date.now();
  pruneToolCallBindings(now);
  if (toolCallIdentityIsQuarantined(sessionId, toolCallId)) return null;
  const lookupKey = toolBindingLookupKey(sessionId, toolCallId);
  const exactKeys = toolCallBindingLookup.get(lookupKey);
  if (!exactKeys) return null;
  const candidates = [];
  for (const exactKey of [...exactKeys]) {
    const binding = toolCallBindings.get(exactKey);
    if (!binding) {
      exactKeys.delete(exactKey);
      continue;
    }
    if (binding.expiresAt <= now) {
      removeToolCallBinding(exactKey, binding);
      continue;
    }
    if (
      binding.sessionKey === sessionKey
      && binding.sessionId === sessionId
      && binding.toolCallId === toolCallId
    ) candidates.push([exactKey, binding]);
  }
  if (exactKeys.size === 0) toolCallBindingLookup.delete(lookupKey);
  if (candidates.length !== 1 || exactKeys.size !== 1) {
    // execute() receives no runId from OpenClaw. If a provider reuses the same
    // tool-call id across overlapping runs, permanently retiring the lookup
    // identity is the only safe outcome; a delayed execute can outlive the
    // short-lived bindings and must never inherit a later run.
    quarantineToolCallIdentity(sessionId, toolCallId);
    return null;
  }
  const [exactKey, binding] = candidates[0];
  removeToolCallBinding(exactKey, binding);
  return binding;
}

function normalizeGenericQuestions(params) {
  if (!params || typeof params !== 'object' || !Array.isArray(params.questions)) return null;
  if (params.questions.length < 1 || params.questions.length > MAX_GENERIC_QUESTIONS) return null;
  const questions = [];
  for (let index = 0; index < params.questions.length; index += 1) {
    const raw = params.questions[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const question = boundedModelText(raw.question, 2_000);
    if (!question) return null;
    let header;
    if (raw.header != null) {
      header = boundedModelText(raw.header, 12);
      if (!header) return null;
    }
    const rawOptions = raw.options == null ? [] : raw.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > MAX_GENERIC_OPTIONS) return null;
    const options = [];
    const seenLabels = new Set();
    for (const rawOption of rawOptions) {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return null;
      const label = boundedModelText(rawOption.label, 200);
      if (!label) return null;
      const normalizedLabel = label.toLocaleLowerCase('en-US');
      if (seenLabels.has(normalizedLabel)) return null;
      seenLabels.add(normalizedLabel);
      let description;
      if (rawOption.description != null) {
        description = boundedModelText(rawOption.description, 500);
        if (!description) return null;
      }
      options.push(description ? { label, description } : { label });
    }
    questions.push({
      id: String(index + 1),
      ...(header ? { header } : {}),
      question,
      isOther: true,
      isSecret: false,
      options,
    });
  }
  return questions;
}

function removeGenericPendingRequest(request) {
  const key = genericRunKey(request.sessionId, request.runId);
  if (genericPendingRequests.get(key) === request) genericPendingRequests.delete(key);
  if (request.timer) clearTimeout(request.timer);
  if (request.signal && request.abortListener) {
    request.signal.removeEventListener('abort', request.abortListener);
  }
}

function settleGenericPendingRequest(request, state, text) {
  if (!request || request.state !== 'pending') return false;
  request.state = state;
  removeGenericPendingRequest(request);
  request.resolve({ state, text });
  return true;
}

function findGenericPendingRequest(sessionId, runId) {
  const request = genericPendingRequests.get(genericRunKey(sessionId, runId));
  if (!request) return null;
  if (request.expiresAt <= Date.now()) {
    settleGenericPendingRequest(
      request,
      'expired',
      'The user did not answer before the question expired.',
    );
    return null;
  }
  return request;
}

function sessionHasDifferentGenericRun(sessionId, runId) {
  const prefix = `${sessionId}\u0000`;
  for (const [key, request] of genericPendingRequests) {
    if (key.startsWith(prefix) && request.runId !== runId && request.state === 'pending') return true;
  }
  return false;
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

const genericRuntimeApi = Object.freeze({
  version: 1,
  read(sessionId, expectedRunId) {
    const request = findGenericPendingRequest(sessionId, expectedRunId);
    if (!request) return null;
    return {
      requestId: request.requestId,
      runId: request.runId,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      questions: request.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option })),
      })),
    };
  },
  answer(sessionId, expectedRunId, requestId, text) {
    const safeSessionId = boundedIdentifier(sessionId, MAX_SESSION_ID_LENGTH);
    const safeRunId = boundedIdentifier(expectedRunId, MAX_RUN_ID_LENGTH);
    const safeRequestId = boundedIdentifier(requestId, MAX_REQUEST_ID_LENGTH);
    const safeText = boundedText(text);
    if (!safeSessionId || !safeRunId || !safeRequestId || !safeText) {
      return { ok: false, code: 'INVALID_IDENTITY' };
    }
    const request = findGenericPendingRequest(safeSessionId, safeRunId);
    if (!request) {
      return {
        ok: false,
        code: sessionHasDifferentGenericRun(safeSessionId, safeRunId)
          ? 'RUN_MISMATCH'
          : 'NO_PENDING_INPUT',
      };
    }
    if (request.requestId !== safeRequestId) {
      return { ok: false, code: 'REQUEST_MISMATCH', runId: safeRunId };
    }
    if (!settleGenericPendingRequest(request, 'answered', safeText)) {
      return { ok: false, code: 'REQUEST_EXPIRED', runId: safeRunId };
    }
    return {
      ok: true,
      code: 'ANSWERED',
      requestId: safeRequestId,
      runId: safeRunId,
    };
  },
  dismiss(sessionId, expectedRunId, requestId) {
    const safeSessionId = boundedIdentifier(sessionId, MAX_SESSION_ID_LENGTH);
    const safeRunId = boundedIdentifier(expectedRunId, MAX_RUN_ID_LENGTH);
    const safeRequestId = boundedIdentifier(requestId, MAX_REQUEST_ID_LENGTH);
    if (!safeSessionId || !safeRunId || !safeRequestId) {
      return { ok: false, code: 'INVALID_IDENTITY' };
    }
    const request = findGenericPendingRequest(safeSessionId, safeRunId);
    if (!request) {
      return {
        ok: false,
        code: sessionHasDifferentGenericRun(safeSessionId, safeRunId)
          ? 'RUN_MISMATCH'
          : 'NO_PENDING_INPUT',
      };
    }
    if (request.requestId !== safeRequestId) {
      return { ok: false, code: 'REQUEST_MISMATCH', runId: safeRunId };
    }
    if (!settleGenericPendingRequest(
      request,
      'dismissed',
      'The user dismissed the question without answering.',
    )) {
      return { ok: false, code: 'REQUEST_EXPIRED', runId: safeRunId };
    }
    return {
      ok: true,
      code: 'DISMISSED',
      requestId: safeRequestId,
      runId: safeRunId,
    };
  },
  steer(sessionId, expectedRunId) {
    return {
      ok: false,
      code: findGenericPendingRequest(sessionId, expectedRunId)
        ? 'PENDING_INPUT'
        : 'NO_PENDING_INPUT',
      runId: expectedRunId,
    };
  },
});

const ASK_USER_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_GENERIC_QUESTIONS,
      description: 'One to three decisions or missing details that require the person to answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          header: {
            type: 'string',
            minLength: 1,
            maxLength: 12,
            description: 'Short label, at most 12 characters.',
          },
          question: {
            type: 'string',
            minLength: 1,
            maxLength: 2_000,
            description: 'A concise question the person can answer without hidden context.',
          },
          options: {
            type: 'array',
            minItems: 0,
            maxItems: MAX_GENERIC_OPTIONS,
            description: 'Two or three mutually exclusive choices when practical; omit for free text.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label'],
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 200 },
                description: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
          },
        },
      },
    },
  },
});

function createGenericPendingRequest(binding, questions, signal) {
  for (const request of [...genericPendingRequests.values()]) {
    if (request.expiresAt <= Date.now()) {
      settleGenericPendingRequest(
        request,
        'expired',
        'The user did not answer before the question expired.',
      );
    }
  }
  const key = genericRunKey(binding.sessionId, binding.runId);
  if (genericPendingRequests.has(key)) {
    throw new Error('ASK_USER_ALREADY_PENDING: this exact run is already waiting on a question.');
  }
  if (genericPendingRequests.size >= MAX_GENERIC_PENDING) {
    throw new Error('ASK_USER_CAPACITY: too many questions are already waiting for answers.');
  }

  let resolvePending;
  const pending = new Promise((resolve) => {
    resolvePending = resolve;
  });
  const createdAt = Date.now();
  const request = {
    sessionKey: binding.sessionKey,
    sessionId: binding.sessionId,
    runId: binding.runId,
    requestId: binding.toolCallId,
    questions,
    createdAt,
    expiresAt: createdAt + GENERIC_PENDING_TTL_MS,
    state: 'pending',
    signal,
    abortListener: null,
    timer: null,
    resolve: resolvePending,
  };
  request.timer = setTimeout(() => {
    settleGenericPendingRequest(
      request,
      'expired',
      'The user did not answer before the question expired.',
    );
  }, GENERIC_PENDING_TTL_MS);
  request.timer.unref?.();
  if (signal) {
    request.abortListener = () => {
      settleGenericPendingRequest(request, 'aborted', 'The question was cancelled because the run ended.');
    };
    signal.addEventListener('abort', request.abortListener, { once: true });
  }
  genericPendingRequests.set(key, request);
  if (signal?.aborted) request.abortListener();
  return pending;
}

function createAskUserQuestionTool(toolContext) {
  const sessionKey = boundedIdentifier(toolContext?.sessionKey, MAX_SESSION_KEY_LENGTH);
  const sessionId = boundedIdentifier(toolContext?.sessionId, MAX_SESSION_ID_LENGTH);
  if (!sessionKey || !sessionId) return null;
  return {
    name: ASK_USER_TOOL_NAME,
    label: 'Ask the user',
    description: [
      'Pause and ask the person for a decision or missing detail that is required to continue.',
      'Use one to three concise questions. Provide two or three mutually exclusive options when practical;',
      'free-text answers remain available. Do not use this for progress updates or questions you can answer from context.',
    ].join(' '),
    promptSnippet: 'Ask the person for a required decision or missing detail and wait for the answer.',
    executionMode: 'sequential',
    parameters: ASK_USER_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('ASK_USER_ABORTED: the run ended before the question opened.');
      const binding = consumeAskUserToolBinding({ sessionKey, sessionId }, toolCallId);
      if (!binding) {
        throw new Error('ASK_USER_IDENTITY_REQUIRED: OpenClaw did not attest this exact tool call.');
      }
      const questions = normalizeGenericQuestions(params);
      if (!questions) {
        throw new Error('ASK_USER_INVALID_QUESTIONS: supply one to three bounded, answerable questions.');
      }
      const settlement = await createGenericPendingRequest(binding, questions, signal);
      if (settlement.state === 'aborted') {
        throw new Error('ASK_USER_ABORTED: the run ended while waiting for an answer.');
      }
      return {
        content: [{ type: 'text', text: settlement.text }],
      };
    },
  };
}

function runtimeApis() {
  const runtimes = [];
  const seen = new Set();
  for (const symbol of RUNTIME_SYMBOLS) {
    const candidate = globalThis[symbol];
    if (
      !candidate
      || candidate.version !== 1
      || typeof candidate.read !== 'function'
      || typeof candidate.answer !== 'function'
      || typeof candidate.dismiss !== 'function'
      || typeof candidate.steer !== 'function'
      || seen.has(candidate)
    ) continue;
    seen.add(candidate);
    runtimes.push(candidate);
  }
  runtimes.push(genericRuntimeApi);
  return runtimes;
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
  const runtimes = runtimeApis();
  if (runtimes.length === 0) {
    return { error: 'HOTFIX_UNAVAILABLE', sessionKey, expectedRunId, sessionId };
  }
  return { runtimes, sessionKey, expectedRunId, sessionId };
}

async function invokeExactRuntime(runtimes, method, args) {
  let adapterMiss = null;
  let runtimeThrew = false;
  for (const runtime of runtimes) {
    try {
      const outcome = await runtime[method](...args);
      if (RUNTIME_ADAPTER_MISS_CODES.has(outcome?.code)) {
        adapterMiss = outcome;
        continue;
      }
      return outcome;
    } catch {
      runtimeThrew = true;
    }
  }
  if (runtimeThrew) return { ok: false, code: 'HOTFIX_ERROR' };
  return adapterMiss || { ok: false, code: 'NO_ACTIVE_RUN' };
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
    let runtimeThrew = false;
    for (const runtime of target.runtimes) {
      try {
        const snapshot = runtime.read(target.sessionId, target.expectedRunId);
        if (snapshot == null) continue;
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
        return;
      } catch {
        runtimeThrew = true;
      }
    }
    respond(true, {
      pending: false,
      code: runtimeThrew ? 'HOTFIX_ERROR' : 'NO_PENDING_INPUT',
    });
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
      const outcome = await invokeExactRuntime(target.runtimes, 'answer', [
        target.sessionId,
        target.expectedRunId,
        requestId,
        answer,
      ]);
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
      const outcome = await invokeExactRuntime(target.runtimes, 'dismiss', [
        target.sessionId,
        target.expectedRunId,
        requestId,
      ]);
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
      const outcome = await invokeExactRuntime(target.runtimes, 'steer', [
        target.sessionId,
        target.expectedRunId,
        text,
      ]);
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

function registerAskUserQuestionTool(api) {
  api.on('before_tool_call', (event, context) => {
    recordAskUserToolBinding(event, context);
  }, { priority: 100 });
  api.registerTool(
    (toolContext) => createAskUserQuestionTool(toolContext),
    { name: ASK_USER_TOOL_NAME },
  );
}

module.exports = {
  name: 'bridgesllm-ask-user',
  register(api) {
    registerAskUserQuestionTool(api);
    registerPendingMethod(api);
    registerAnswerMethod(api);
    registerDismissMethod(api);
    registerSteerMethod(api);
  },
  __test: {
    GATEWAY_METHODS,
    RUNTIME_SYMBOL,
    RUNTIME_SYMBOLS,
    ASK_USER_TOOL_NAME,
    ASK_USER_TOOL_PARAMETERS,
    GENERIC_PENDING_TTL_MS,
    TERMINAL_RECEIPT_TTL_MS,
    MAX_TERMINAL_RECEIPTS,
    reset() {
      terminalReceipts.clear();
      toolCallBindings.clear();
      toolCallBindingLookup.clear();
      toolCallBindingCountsBySession.clear();
      quarantinedToolCallIdentities.clear();
      saturatedToolCallSessions.clear();
      activeToolCallSessionBySessionKey.clear();
      for (const request of [...genericPendingRequests.values()]) {
        settleGenericPendingRequest(request, 'dismissed', 'The test reset the pending question.');
      }
      genericPendingRequests.clear();
    },
  },
};
