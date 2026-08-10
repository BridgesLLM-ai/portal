import client from '../../api/client';
import {
  readStructuredOAuthCancellationState,
  readStructuredOAuthFlowState,
  type OAuthCancellationOutcome,
} from './oauthFlowContract';

export interface OAuthCancellationResult {
  outcome: OAuthCancellationOutcome;
  confirmed: boolean;
  error?: string;
}

const FALLBACK_ERROR = 'Portal could not verify that the provider login stopped. Keep this dialog open and retry cancellation.';
const XAI_CANCELLATION_PROOF_TIMEOUT_MS = 45_000;
const XAI_CANCELLATION_POLL_MS = 1_000;

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

function responseProvider(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const provider = (payload as Record<string, unknown>).provider;
  return typeof provider === 'string' && provider.trim() ? provider.trim().toLowerCase() : null;
}

async function waitForAcceptedXaiCancellation(
  apiBase: string,
  sessionId: string,
): Promise<OAuthCancellationResult> {
  const deadline = Date.now() + XAI_CANCELLATION_PROOF_TIMEOUT_MS;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const statusResponse = await client.get(
        `${apiBase}/oauth/status/${encodeURIComponent(sessionId)}`,
        { timeout: 10_000 },
      );
      const state = readStructuredOAuthFlowState(statusResponse?.data);

      if (state.credentialState === 'committed') {
        return {
          outcome: 'committed',
          confirmed: false,
          error: state.error || 'The xAI credential committed before cancellation finished. Close this dialog and review xAI before starting another sign-in.',
        };
      }

      if (state.credentialState === 'absent' && !state.cleanupPending) {
        // Re-submit the idempotent cancellation once the background proof is
        // durable. This releases the provider lifecycle lease and gives the UI
        // the same explicit confirmation as a fast cancellation.
        const confirmation = await client.post(
          `${apiBase}/oauth/cancel`,
          { sessionId },
          { timeout: 10_000 },
        );
        const confirmed = readStructuredOAuthCancellationState(
          confirmation?.data,
          confirmation?.status,
        );
        if (confirmed.outcome === 'cancelled') {
          return { outcome: 'cancelled', confirmed: true };
        }
        if (confirmed.outcome === 'committed') {
          return {
            outcome: 'committed',
            confirmed: false,
            error: confirmed.error || 'The xAI credential committed before cancellation finished. Close this dialog and review xAI before starting another sign-in.',
          };
        }
        lastError = confirmed.error;
      } else if (!state.cleanupPending && ['cancelled', 'expired', 'error'].includes(state.status)) {
        return {
          outcome: 'review_required',
          confirmed: false,
          error: state.error || 'The xAI sign-in ended without an authoritative credential result. Close this dialog and review xAI before starting another sign-in.',
        };
      } else if (state.error) {
        lastError = state.error;
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return {
          outcome: 'review_required',
          confirmed: false,
          error: 'Portal no longer has the xAI sign-in session record, so it cannot prove whether a credential was committed. Close this dialog and review xAI before starting another sign-in.',
        };
      }
      lastError = responseError(error?.response?.data) || error?.message || lastError;
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => window.setTimeout(resolve, XAI_CANCELLATION_POLL_MS));
  }

  return {
    outcome: 'indeterminate',
    confirmed: false,
    error: actionableError(lastError || 'Portal is still verifying that xAI did not save a credential.'),
  };
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
    if (
      response?.status === 202
      && state.outcome === 'indeterminate'
      && state.cleanupPending
      && responseProvider(response?.data) === 'xai'
    ) {
      return waitForAcceptedXaiCancellation(apiBase, sessionId);
    }
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
