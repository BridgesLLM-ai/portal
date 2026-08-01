import client from '../../api/client';
import { readStructuredOAuthCancellationState, type OAuthCancellationOutcome } from './oauthFlowContract';

export interface OAuthCancellationResult {
  outcome: OAuthCancellationOutcome;
  confirmed: boolean;
  error?: string;
}

const FALLBACK_ERROR = 'Portal could not verify that the provider login stopped. Keep this dialog open and retry cancellation.';

function actionableError(message: string | null | undefined): string {
  const detail = message?.trim();
  if (!detail) return FALLBACK_ERROR;
  if (/keep this (dialog|window) open/i.test(detail)) return detail;
  return `${detail} Keep this dialog open and retry cancellation.`;
}

function responseError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === 'string' && error.trim() ? error.trim() : null;
}

/**
 * Cancels one server-owned OAuth/native-CLI session without treating an
 * indeterminate response as success. A missing in-memory session is not proof
 * that the provider failed to commit a credential, so that outcome requires
 * explicit review. Every 409 stays fail-closed: it may represent cleanup still
 * running or a credential that won the cancellation race.
 */
export async function cancelOAuthSession(apiBase: string, sessionId: string): Promise<OAuthCancellationResult> {
  try {
    const response = await client.post(`${apiBase}/oauth/cancel`, { sessionId }, { timeout: 10_000 });
    const state = readStructuredOAuthCancellationState(response?.data, response?.status);
    if (state.outcome === 'cancelled') return { outcome: 'cancelled', confirmed: true };
    return {
      outcome: state.outcome,
      confirmed: false,
      error: state.outcome === 'committed'
        ? (state.error || 'The provider credential was committed before cancellation finished. Close this dialog and review the provider before starting another sign-in.')
        : actionableError(state.error),
    };
  } catch (error: any) {
    const status = error?.response?.status;
    const state = readStructuredOAuthCancellationState(error?.response?.data, status);
    if (state.outcome === 'committed') {
      return {
        outcome: 'committed',
        confirmed: false,
        error: state.error || 'The provider credential was committed before cancellation finished. Close this dialog and review the provider before starting another sign-in.',
      };
    }
    if (state.outcome === 'review_required') {
      const detail = status === 404
        ? 'Portal no longer has the sign-in session record, so it cannot prove whether a credential was committed. Close this dialog and review the provider before starting another sign-in.'
        : (state.error || 'Portal could not establish a safe terminal state for this sign-in. Close this dialog and review the provider before starting another sign-in.');
      return { outcome: 'review_required', confirmed: false, error: detail };
    }
    return {
      outcome: 'indeterminate',
      confirmed: false,
      error: actionableError(state.error || responseError(error?.response?.data) || error?.message),
    };
  }
}
