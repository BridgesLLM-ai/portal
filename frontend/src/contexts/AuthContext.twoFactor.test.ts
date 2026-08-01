// @vitest-environment jsdom
import '../test/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  validate: vi.fn(),
  recover: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth');
  return {
    ...actual,
    authAPI: {
      ...actual.authAPI,
      login: mocks.login,
      twoFactorValidate: mocks.validate,
      twoFactorRecoverEmail: mocks.recover,
    },
  };
});

vi.mock('../api/client', () => ({
  startSessionHeartbeat: mocks.startHeartbeat,
  stopSessionHeartbeat: mocks.stopHeartbeat,
}));

import { useAuthStore } from './AuthContext';

const user = {
  id: 'user-1',
  email: 'owner@example.com',
  username: 'Owner',
  role: 'OWNER',
  authorizationVersion: 1,
};

function resetAuthState() {
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    twoFactorPending: false,
    twoFactorPendingToken: null,
    twoFactorMethod: null,
    twoFactorEmailDelivery: null,
    lastSessionRestoreAt: null,
    sessionRestoreError: false,
  });
}

describe('AuthContext two-factor delivery and recovery state', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    resetAuthState();
  });

  it('retains unavailable delivery truth for the pending login challenge', async () => {
    mocks.login.mockResolvedValueOnce({
      requiresTwoFactor: true,
      pendingToken: 'pending-token',
      method: 'email',
      emailDelivery: {
        state: 'unavailable',
        message: 'Mail requires a public domain.',
        recoveryAvailable: true,
      },
    });

    await expect(
      useAuthStore.getState().login('owner@example.com', 'CurrentPassword123!'),
    ).resolves.toEqual({ requiresTwoFactor: true });

    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: false,
      twoFactorPending: true,
      twoFactorPendingToken: 'pending-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'unavailable',
        message: 'Mail requires a public domain.',
        recoveryAvailable: true,
      },
    });
  });

  it('treats missing email-delivery metadata as unknown instead of sent', async () => {
    mocks.login.mockResolvedValueOnce({
      requiresTwoFactor: true,
      pendingToken: 'legacy-pending-token',
      method: 'email',
    });

    await useAuthStore.getState().login('owner@example.com', 'CurrentPassword123!');

    expect(useAuthStore.getState()).toMatchObject({
      twoFactorPending: true,
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: null,
    });
  });

  it('clears delivery metadata after successful validation and cancellation', async () => {
    useAuthStore.setState({
      twoFactorPending: true,
      twoFactorPendingToken: 'pending-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'sent',
        message: 'A verification code was sent.',
      },
    });
    mocks.validate.mockResolvedValueOnce({ user });

    await useAuthStore.getState().completeTwoFactor('123456');

    expect(useAuthStore.getState()).toMatchObject({
      user,
      isAuthenticated: true,
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      twoFactorEmailDelivery: null,
    });
    expect(mocks.startHeartbeat).toHaveBeenCalledTimes(1);

    useAuthStore.setState({
      twoFactorPending: true,
      twoFactorPendingToken: 'another-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'failed',
        message: 'Not sent.',
      },
    });
    useAuthStore.getState().cancelTwoFactor();
    expect(useAuthStore.getState()).toMatchObject({
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      twoFactorEmailDelivery: null,
    });
  });

  it('clears all client auth state after recovery and returns the fresh-sign-in response', async () => {
    localStorage.setItem('accessToken', 'stale-access');
    localStorage.setItem('refreshToken', 'stale-refresh');
    localStorage.setItem('token', 'stale-token');
    useAuthStore.setState({
      user: user as any,
      isAuthenticated: true,
      twoFactorPending: true,
      twoFactorPendingToken: 'pending-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'unavailable',
        message: 'Mail requires a public domain.',
        recoveryAvailable: true,
      },
    });
    const recoveryResponse = {
      success: true as const,
      code: 'EMAIL_2FA_RECOVERED' as const,
      requiresFreshLogin: true as const,
      message: 'Email Code 2FA was disabled. Sign in again.',
    };
    mocks.recover.mockResolvedValueOnce(recoveryResponse);

    await expect(useAuthStore.getState().recoverEmailTwoFactor(
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    )).resolves.toEqual(recoveryResponse);

    expect(mocks.recover).toHaveBeenCalledWith(
      'pending-token',
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    );
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      twoFactorEmailDelivery: null,
      lastSessionRestoreAt: null,
    });
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('keeps the pending challenge intact when recovery fails', async () => {
    useAuthStore.setState({
      twoFactorPending: true,
      twoFactorPendingToken: 'pending-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'unavailable',
        message: 'Mail requires a public domain.',
        recoveryAvailable: true,
      },
    });
    const failure = {
      response: {
        status: 409,
        data: {
          error: 'A backup code is still available. Use it to finish signing in.',
        },
      },
    };
    mocks.recover.mockRejectedValueOnce(failure);

    await expect(useAuthStore.getState().recoverEmailTwoFactor(
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    )).rejects.toBe(failure);

    expect(useAuthStore.getState()).toMatchObject({
      isLoading: false,
      error: 'A backup code is still available. Use it to finish signing in.',
      twoFactorPending: true,
      twoFactorPendingToken: 'pending-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'unavailable',
        recoveryAvailable: true,
      },
    });
  });

  it('clears stale pending state after an indeterminate recovery response', async () => {
    useAuthStore.setState({
      user: user as any,
      isAuthenticated: true,
      twoFactorPending: true,
      twoFactorPendingToken: 'pending-token',
      twoFactorMethod: 'email',
      twoFactorEmailDelivery: {
        state: 'unavailable',
        message: 'Mail requires a public domain.',
        recoveryAvailable: true,
      },
    });
    mocks.recover.mockRejectedValueOnce(new Error('connection closed after request upload'));

    await expect(useAuthStore.getState().recoverEmailTwoFactor(
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    )).rejects.toMatchObject({
      name: 'TwoFactorEmailRecoveryIndeterminateError',
      requiresFreshLogin: true,
    });

    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      twoFactorEmailDelivery: null,
    });
  });
});
