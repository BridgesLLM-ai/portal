import {
  NativeProviderDiagnosticError,
  classifyNativeProviderError,
  redactNativeProviderText,
  sanitizeNativeProviderEvent,
  type NativeProviderErrorCode,
} from '../native/NativeProviderDiagnostics';

const MAX_DIAGNOSTIC_PARTS = 24;
const MAX_DIAGNOSTIC_DEPTH = 6;

export const AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE = 'Agent Zero fell back to an OpenRouter default that is not connected instead of completing the selected OAuth-model request. Refresh the Agent Zero model list and reselect a model from a connected OAuth account, or reconnect the selected provider.';
export const AGENT_ZERO_SELECTED_PROVIDER_AUTH_MESSAGE = 'Agent Zero could not authenticate the selected model provider. Reconnect that provider in Agent Zero settings, then choose one of its available models.';
export const AGENT_ZERO_MODEL_REJECTED_MESSAGE = 'Agent Zero rejected the selected model. Refresh the available models and choose one from a connected OAuth provider.';

const KNOWN_SAFE_AGENT_ZERO_ERRORS: ReadonlyArray<readonly [NativeProviderErrorCode, string]> = [
  ['AUTH_REQUIRED', AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE],
  ['AUTH_REQUIRED', AGENT_ZERO_SELECTED_PROVIDER_AUTH_MESSAGE],
  ['MODEL_REJECTED', AGENT_ZERO_MODEL_REJECTED_MESSAGE],
  ['AUTH_REQUIRED', 'Agent Zero authentication is unavailable. Reconnect it in AI Settings and retry.'],
  ['MODEL_REJECTED', 'Agent Zero rejected the selected model. Choose an available model and retry.'],
  ['RATE_LIMITED', 'Agent Zero is temporarily rate limited. Wait for the provider quota window and retry.'],
  ['TIMED_OUT', 'Agent Zero did not respond before the timeout. Retry the turn.'],
  ['PERMISSION_DENIED', 'Agent Zero could not complete an operation within the approved execution scope.'],
  ['RUNTIME_UNAVAILABLE', 'Agent Zero is not available on this server right now.'],
  ['PROVIDER_FAILED', 'Agent Zero could not complete the request. Retry, or check AI Settings if the problem continues.'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectDiagnosticParts(
  value: unknown,
  parts: string[],
  depth = 0,
): void {
  if (parts.length >= MAX_DIAGNOSTIC_PARTS || depth > MAX_DIAGNOSTIC_DEPTH) return;
  if (value instanceof Error) {
    collectDiagnosticParts(value.message, parts, depth + 1);
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (!text) return;
    if ((text.startsWith('{') || text.startsWith('[')) && text.length <= 64 * 1024) {
      try {
        collectDiagnosticParts(JSON.parse(text), parts, depth + 1);
        return;
      } catch {
        // Provider diagnostics often contain a prose prefix followed by JSON.
      }
    }
    parts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_DIAGNOSTIC_PARTS - parts.length)) {
      collectDiagnosticParts(item, parts, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;

  const prioritized = ['error', 'message', 'detail', 'details', 'reason', 'heading', 'text', 'code'];
  const visited = new Set<string>();
  for (const key of prioritized) {
    if (!(key in value)) continue;
    visited.add(key);
    collectDiagnosticParts(value[key], parts, depth + 1);
  }
  for (const [key, item] of Object.entries(value)) {
    if (visited.has(key) || parts.length >= MAX_DIAGNOSTIC_PARTS) continue;
    collectDiagnosticParts(item, parts, depth + 1);
  }
}

export function agentZeroDiagnosticText(value: unknown): string {
  const parts: string[] = [];
  collectDiagnosticParts(sanitizeNativeProviderEvent(value), parts);
  return redactNativeProviderText(parts.join(' | '), 16 * 1024);
}

export function classifyAgentZeroError(value: unknown): NativeProviderDiagnosticError {
  if (value instanceof NativeProviderDiagnosticError) return value;

  const diagnostic = agentZeroDiagnosticText(value);
  const knownSafeError = KNOWN_SAFE_AGENT_ZERO_ERRORS.find(([, message]) => diagnostic.includes(message));
  if (knownSafeError) {
    return new NativeProviderDiagnosticError(knownSafeError[0], knownSafeError[1]);
  }
  const classified = classifyNativeProviderError('Agent Zero', diagnostic);
  const authenticationFailure = classified.code === 'AUTH_REQUIRED'
    || /\b(?:authenticationerror|authentication failed|could not authenticate|invalid auth|unauthori[sz]ed)\b/i.test(diagnostic)
    || /\bdoes not have credentials\b/i.test(diagnostic)
    || /\b(?:api key|access token|proxy token)\b[^\n]{0,120}\b(?:required|missing|invalid|denied)\b/i.test(diagnostic)
    || /\baccess[_ ]denied\b/i.test(diagnostic)
    || /\b(?:401|403)\b[^\n]{0,160}\b(?:auth|credential|cookie|provider|openrouter)\b/i.test(diagnostic)
    || /\bno user or org id found in auth cookie\b/i.test(diagnostic);

  if (authenticationFailure && /\bopenrouter(?:exception)?\b/i.test(diagnostic)) {
    return new NativeProviderDiagnosticError(
      'AUTH_REQUIRED',
      AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
      classified.diagnosticId,
    );
  }
  if (authenticationFailure) {
    return new NativeProviderDiagnosticError(
      'AUTH_REQUIRED',
      AGENT_ZERO_SELECTED_PROVIDER_AUTH_MESSAGE,
      classified.diagnosticId,
    );
  }
  if (/\b(?:did not confirm|model override|unknown agent zero preset|model is not available)\b/i.test(diagnostic)) {
    return new NativeProviderDiagnosticError(
      'MODEL_REJECTED',
      AGENT_ZERO_MODEL_REJECTED_MESSAGE,
      classified.diagnosticId,
    );
  }
  return classified;
}

export function safeAgentZeroErrorMessage(value: unknown): string {
  return classifyAgentZeroError(value).message;
}

export function safeAgentZeroStatusMessage(value: unknown, maxBytes = 1_024): string {
  const text = agentZeroDiagnosticText(value)
    .replace(/\bTraceback \(most recent call last\):[\s\S]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return redactNativeProviderText(text, maxBytes);
}

export function safeAgentZeroRuntimeEventMessage(value: unknown, maxBytes = 1_024): string {
  const diagnostic = agentZeroDiagnosticText(value);
  // Agent Zero emits provider failures through several nonterminal event kinds,
  // including util_message. Treat recognizable LiteLLM/provider exception
  // envelopes as diagnostics even when the connector did not label them
  // `error`; otherwise their traceback/JSON prose becomes a visible chat card.
  if (/\b(?:litellm(?:\.exceptions)?|openrouter(?:exception)?|authenticationerror|apiconnectionerror|apierror|badrequesterror|ratelimiterror|providerexception|traceback|no user or org id found in auth cookie)\b/i.test(diagnostic)) {
    return classifyAgentZeroError(value).message;
  }
  return safeAgentZeroStatusMessage(value, maxBytes);
}
