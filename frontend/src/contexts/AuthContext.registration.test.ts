// @vitest-environment jsdom
import '../test/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signup: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth');
  return {
    ...actual,
    authAPI: {
      ...actual.authAPI,
      signup: mocks.signup,
    },
  };
});

vi.mock('../api/client', () => ({
  startSessionHeartbeat: mocks.startHeartbeat,
  stopSessionHeartbeat: mocks.stopHeartbeat,
}));

import { useAuthStore } from './AuthContext';

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

describe('AuthContext registration status', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    resetAuthState();
  });

  it('returns an approval request as a positive pending result instead of an auth error', async () => {
    mocks.signup.mockResolvedValueOnce({
      pending: true,
      message: '  Your access request is waiting for administrator approval.  ',
    });

    await expect(
      useAuthStore.getState().signup(
        'person@example.com',
        'person',
        'ValidPassword1',
      ),
    ).resolves.toEqual({
      pending: true,
      message: 'Your access request is waiting for administrator approval.',
    });

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
    expect(mocks.startHeartbeat).not.toHaveBeenCalled();
  });

  it('does not misreport an unexpected non-session response as a pending registration', async () => {
    mocks.signup.mockResolvedValueOnce({});

    await expect(
      useAuthStore.getState().signup(
        'person@example.com',
        'person',
        'ValidPassword1',
      ),
    ).rejects.toThrow(
      'Portal could not confirm the registration result. Try signing in before submitting another request.',
    );

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: 'Portal could not confirm the registration result. Try signing in before submitting another request.',
    });
  });
});
