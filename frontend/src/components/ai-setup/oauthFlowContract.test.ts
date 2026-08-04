import { describe, expect, it } from 'vitest';
import {
  getOAuthStartRecoveryDisposition,
  getOAuthProviderPresentation,
  isOAuthCancellationConfirmed,
  isOAuthFlowCancelled,
  isOAuthFlowExpired,
  isOAuthFlowReadyForModel,
  readStructuredOAuthFlowState,
  readStructuredOAuthCancellationState,
  readStructuredOAuthStartFailure,
  sanitizeOAuthVerificationUrl,
} from './oauthFlowContract';

describe('structured OAuth flow contract', () => {
  it('uses device authorization for xAI without localhost callback copy', () => {
    expect(getOAuthProviderPresentation('xai', 'xAI (Grok)')).toEqual({
      label: 'xAI',
      completionMode: 'device_code',
      callbackExample: null,
    });
  });

  it('reads structured xAI device fields and ignores raw PTY output', () => {
    const state = readStructuredOAuthFlowState({
      sessionId: 'oauth-123',
      status: 'pending',
      verificationUrl: 'https://auth.x.ai/activate',
      userCode: 'ABCD-EFGH',
      expiresAt: 2_000_000_000,
      finalized: false,
      createdProfileId: 'xai:portal-oauth-test',
      credentialState: 'committed',
      output: 'SECRET_FROM_RAW_TERMINAL_OUTPUT',
    });

    expect(state).toMatchObject({
      sessionId: 'oauth-123',
      status: 'pending',
      verificationUrl: 'https://auth.x.ai/activate',
      userCode: 'ABCD-EFGH',
      expiresAt: 2_000_000_000_000,
      error: null,
      finalized: false,
      createdProfileId: 'xai:portal-oauth-test',
      credentialState: 'committed',
    });
    expect(JSON.stringify(state)).not.toContain('SECRET_FROM_RAW_TERMINAL_OUTPUT');
  });

  it('accepts the legacy deviceCode name during backend rollout', () => {
    expect(readStructuredOAuthFlowState({ id: 'legacy', deviceCode: 'WXYZ-1234' })).toMatchObject({
      sessionId: 'legacy',
      userCode: 'WXYZ-1234',
    });
  });

  it('retains only allowlisted recovery metadata from a rejected start', () => {
    const state = readStructuredOAuthStartFailure({
      sessionId: 'recovery-session',
      error: 'Portal is still reconciling the provider process.',
      cleanupPending: true,
      credentialState: 'indeterminate',
      rawOutput: 'SECRET TERMINAL TRANSCRIPT',
    });

    expect(state).toEqual({
      sessionId: 'recovery-session',
      code: null,
      error: 'Portal is still reconciling the provider process.',
      cleanupPending: true,
      credentialState: 'indeterminate',
    });
    expect(JSON.stringify(state)).not.toContain('SECRET TERMINAL TRANSCRIPT');
  });

  it('classifies rejected starts without losing committed or indeterminate credential state', () => {
    expect(getOAuthStartRecoveryDisposition(readStructuredOAuthStartFailure({
      sessionId: 'cleanup-session',
      cleanupPending: true,
      credentialState: 'indeterminate',
    }))).toBe('cleanup_required');
    expect(getOAuthStartRecoveryDisposition(readStructuredOAuthStartFailure({
      sessionId: 'committed-session',
      credentialState: 'committed',
    }))).toBe('committed');
    expect(getOAuthStartRecoveryDisposition(readStructuredOAuthStartFailure({
      cleanupPending: true,
      credentialState: 'indeterminate',
    }))).toBe('review_required');
    expect(getOAuthStartRecoveryDisposition(readStructuredOAuthStartFailure({
      sessionId: 'owned-without-extra-markers',
      error: 'start response was interrupted',
    }))).toBe('cleanup_required');
    expect(getOAuthStartRecoveryDisposition(readStructuredOAuthStartFailure({
      credentialState: 'absent',
    }))).toBe('retryable');
    expect(getOAuthStartRecoveryDisposition(readStructuredOAuthStartFailure({}))).toBe('review_required');
  });

  it('rejects script and non-local plaintext verification links', () => {
    expect(sanitizeOAuthVerificationUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeOAuthVerificationUrl('http://auth.x.ai/activate')).toBeNull();
    expect(sanitizeOAuthVerificationUrl('http://localhost:1455/auth/callback')).toBe('http://localhost:1455/auth/callback');
  });

  it('recognizes expiry and cancellation terminal states', () => {
    const now = Date.parse('2026-07-18T18:00:00Z');
    expect(isOAuthFlowExpired(readStructuredOAuthFlowState({ expiresAt: now - 1 }), now)).toBe(true);
    expect(isOAuthFlowCancelled(readStructuredOAuthFlowState({ status: 'cancelled' }))).toBe(true);
  });

  it('does not advance xAI until Portal finalization succeeds', () => {
    const pendingFinalization = readStructuredOAuthFlowState({ status: 'complete', finalized: false });
    const finalized = readStructuredOAuthFlowState({ status: 'complete', finalized: true });
    expect(isOAuthFlowReadyForModel(pendingFinalization, true)).toBe(false);
    expect(isOAuthFlowReadyForModel(finalized, true)).toBe(true);
  });

  it('requires finalization for every OAuth provider while allowing finalized native bridges', () => {
    const pendingFinalization = readStructuredOAuthFlowState({ status: 'complete', finalized: false });
    const finalized = readStructuredOAuthFlowState({ status: 'complete', finalized: true });
    expect(isOAuthFlowReadyForModel(pendingFinalization, true)).toBe(false);
    expect(isOAuthFlowReadyForModel(finalized, true)).toBe(true);
    expect(isOAuthFlowReadyForModel(pendingFinalization, false)).toBe(true);
  });

  it('does not treat a repeated cancellation as stopped while cleanup is pending', () => {
    expect(isOAuthCancellationConfirmed({ success: false, status: 'cancelled', cleanupPending: true }, 409)).toBe(false);
    expect(isOAuthCancellationConfirmed({ success: false, status: 'cancelled' }, 409)).toBe(false);
    expect(isOAuthCancellationConfirmed({ success: false, status: 'expired' }, 409)).toBe(false);
    expect(isOAuthCancellationConfirmed({ success: false, status: 'error' }, 409)).toBe(false);
    expect(isOAuthCancellationConfirmed({ success: true, status: 'cancelled' }, 200)).toBe(true);
    expect(isOAuthCancellationConfirmed({ success: true, status: 'cancelled', cleanupPending: true }, 200)).toBe(false);
    expect(isOAuthCancellationConfirmed({}, 404)).toBe(false);
    expect(isOAuthCancellationConfirmed(undefined, undefined)).toBe(false);
  });

  it('keeps cancellation outcomes distinct and treats a missing in-memory session as review-required', () => {
    expect(readStructuredOAuthCancellationState({ success: true, status: 'cancelled' }, 200).outcome).toBe('cancelled');
    expect(readStructuredOAuthCancellationState({
      success: false,
      status: 'error',
      credentialState: 'committed',
    }, 409).outcome).toBe('committed');
    expect(readStructuredOAuthCancellationState({
      success: false,
      status: 'error',
      cleanupPending: true,
      credentialState: 'indeterminate',
    }, 409).outcome).toBe('indeterminate');
    expect(readStructuredOAuthCancellationState({ error: 'gateway unavailable' }, 500).outcome).toBe('indeterminate');
    expect(readStructuredOAuthCancellationState({}, 404).outcome).toBe('review_required');
    expect(readStructuredOAuthCancellationState({
      cleanupPending: true,
      credentialState: 'indeterminate',
      error: 'The old session record is gone.',
    }, 404)).toMatchObject({ outcome: 'review_required', cleanupPending: true });
  });
});
