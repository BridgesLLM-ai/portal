export type OAuthFlowStatus = 'pending' | 'processing' | 'complete' | 'error' | 'expired' | 'cancelled' | string;

export interface StructuredOAuthFlowState {
  sessionId: string | null;
  status: OAuthFlowStatus;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number | null;
  error: string | null;
  finalized: boolean | null;
  finalizationWarning: string | null;
  createdProfileId: string | null;
  cleanupPending: boolean;
}

export interface StructuredOAuthStartFailure {
  sessionId: string | null;
  error: string | null;
  cleanupPending: boolean;
  credentialState: 'absent' | 'committed' | 'indeterminate' | null;
}

export type OAuthStartRecoveryDisposition = 'retryable' | 'cleanup_required' | 'committed' | 'review_required';

export type OAuthCancellationOutcome = 'cancelled' | 'committed' | 'indeterminate' | 'review_required';

export interface StructuredOAuthCancellationState {
  outcome: OAuthCancellationOutcome;
  error: string | null;
  cleanupPending: boolean;
  credentialState: 'committed' | 'indeterminate' | null;
}

export interface OAuthProviderPresentation {
  label: string;
  completionMode: 'device_code' | 'callback';
  callbackExample: string | null;
}

export function getOAuthProviderPresentation(providerId: string, providerName: string): OAuthProviderPresentation {
  switch (providerId) {
    case 'openai-codex':
      return { label: 'OpenAI', completionMode: 'device_code', callbackExample: null };
    case 'google-gemini-cli':
      return { label: 'Google', completionMode: 'callback', callbackExample: 'localhost:8085/oauth2callback?...' };
    case 'xai':
      return { label: 'xAI', completionMode: 'device_code', callbackExample: null };
    default:
      return { label: providerName, completionMode: 'callback', callbackExample: null };
  }
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readExpiry(value: unknown, expiresIn: unknown): number | null {
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) value = numeric;
    else {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // OAuth APIs commonly return Unix seconds, while Portal state uses milliseconds.
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  const seconds = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Date.now() + (seconds * 1000);
  }

  return null;
}

export function sanitizeOAuthVerificationUrl(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') return parsed.toString();
    if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Reads only the structured OAuth contract. Raw PTY output is intentionally
 * ignored so terminal transcripts, device codes, and token-like text cannot be
 * reflected into the browser by accident.
 */
export function readStructuredOAuthFlowState(payload: unknown): StructuredOAuthFlowState {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const status = readNonEmptyString(data.status) || 'pending';

  return {
    sessionId: readNonEmptyString(data.sessionId) || readNonEmptyString(data.id),
    status,
    verificationUrl: sanitizeOAuthVerificationUrl(data.verificationUrl) || sanitizeOAuthVerificationUrl(data.authUrl),
    userCode: readNonEmptyString(data.userCode) || readNonEmptyString(data.deviceCode),
    expiresAt: readExpiry(data.expiresAt, data.expiresIn),
    error: readNonEmptyString(data.error),
    finalized: typeof data.finalized === 'boolean' ? data.finalized : null,
    finalizationWarning: readNonEmptyString(data.finalizationWarning),
    createdProfileId: readNonEmptyString(data.createdProfileId),
    cleanupPending: data.cleanupPending === true,
  };
}

/**
 * A rejected start can still own a live provider process. Keep the returned
 * session attached to the dialog whenever cleanup remains unresolved; losing
 * this identifier would leave the user with no safe cancellation path.
 */
export function readStructuredOAuthStartFailure(payload: unknown): StructuredOAuthStartFailure {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const credentialState = data.credentialState === 'absent'
    || data.credentialState === 'committed'
    || data.credentialState === 'indeterminate'
    ? data.credentialState
    : null;

  return {
    sessionId: readNonEmptyString(data.sessionId) || readNonEmptyString(data.id),
    error: readNonEmptyString(data.error),
    cleanupPending: data.cleanupPending === true,
    credentialState,
  };
}

export function getOAuthStartRecoveryDisposition(
  failure: StructuredOAuthStartFailure,
): OAuthStartRecoveryDisposition {
  if (failure.credentialState === 'committed') return 'committed';
  if (failure.credentialState === 'indeterminate' || failure.cleanupPending) {
    return failure.sessionId ? 'cleanup_required' : 'review_required';
  }
  if (failure.sessionId && failure.credentialState !== 'absent') return 'cleanup_required';
  return failure.credentialState === 'absent' ? 'retryable' : 'review_required';
}

export function readStructuredOAuthCancellationState(
  payload: unknown,
  httpStatus?: number,
): StructuredOAuthCancellationState {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const error = readNonEmptyString(data.error);
  const cleanupPending = data.cleanupPending === true;
  const credentialState = data.credentialState === 'committed'
    || data.credentialState === 'indeterminate'
    ? data.credentialState
    : null;

  if (credentialState === 'committed') {
    return { outcome: 'committed', error, cleanupPending, credentialState };
  }
  // A missing server-side session can no longer be re-attested from this
  // dialog. Keep that as an explicit provider-review boundary even if a stale
  // response body still carries cleanup metadata.
  if (httpStatus === 404) {
    return { outcome: 'review_required', error, cleanupPending, credentialState };
  }
  if (credentialState === 'indeterminate' || cleanupPending) {
    return { outcome: 'indeterminate', error, cleanupPending, credentialState };
  }
  if (typeof httpStatus === 'number' && httpStatus >= 400) {
    return { outcome: 'indeterminate', error, cleanupPending: false, credentialState: null };
  }
  if (data.success === true && readNonEmptyString(data.status) === 'cancelled') {
    return { outcome: 'cancelled', error, cleanupPending: false, credentialState: null };
  }
  return { outcome: 'indeterminate', error, cleanupPending, credentialState };
}

export function isOAuthFlowExpired(state: StructuredOAuthFlowState, now = Date.now()): boolean {
  return state.status === 'expired' || Boolean(state.expiresAt && state.expiresAt <= now);
}

export function isOAuthFlowCancelled(state: StructuredOAuthFlowState): boolean {
  return state.status === 'cancelled';
}

export function isOAuthFlowReadyForModel(state: StructuredOAuthFlowState, requiresFinalization: boolean): boolean {
  return state.status === 'complete' && (!requiresFinalization || state.finalized === true);
}

export function isOAuthCancellationConfirmed(payload: unknown, httpStatus?: number): boolean {
  return readStructuredOAuthCancellationState(payload, httpStatus).outcome === 'cancelled';
}
