import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('./client', () => ({ default: clientMocks }));

import { authAPI, isTwoFactorRequired } from './auth';

describe('auth API two-factor contract', () => {
  beforeEach(() => {
    clientMocks.get.mockReset();
    clientMocks.post.mockReset();
  });

  it('preserves explicit email-delivery truth from login', async () => {
    const response = {
      requiresTwoFactor: true as const,
      pendingToken: 'pending-token',
      method: 'email' as const,
      emailDelivery: {
        state: 'unavailable' as const,
        message: 'Mail requires a public domain.',
        recoveryAvailable: true,
      },
    };
    clientMocks.post.mockResolvedValueOnce({ data: response });

    const result = await authAPI.login('owner@example.com', 'CurrentPassword123!');

    expect(clientMocks.post).toHaveBeenCalledWith('/auth/login', {
      email: 'owner@example.com',
      password: 'CurrentPassword123!',
    });
    expect(isTwoFactorRequired(result)).toBe(true);
    expect(result).toEqual(response);
  });

  it('sends the admitted pending challenge, repeated password, and exact recovery phrase', async () => {
    const response = {
      success: true as const,
      code: 'EMAIL_2FA_RECOVERED' as const,
      requiresFreshLogin: true as const,
      message: 'Sign in again.',
    };
    clientMocks.post.mockResolvedValueOnce({ data: response });

    await expect(authAPI.twoFactorRecoverEmail(
      'pending-token',
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    )).resolves.toEqual(response);

    expect(clientMocks.post).toHaveBeenCalledWith('/auth/2fa/recover-email', {
      pendingToken: 'pending-token',
      currentPassword: 'CurrentPassword123!',
      confirmation: 'DISABLE EMAIL 2FA',
    });
  });

  it('rejects a malformed recovery success contract', async () => {
    clientMocks.post.mockResolvedValueOnce({
      data: {
        success: true,
        code: 'UNKNOWN_RESULT',
        requiresFreshLogin: false,
        message: '',
      },
    });

    await expect(authAPI.twoFactorRecoverEmail(
      'pending-token',
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    )).rejects.toMatchObject({
      name: 'TwoFactorEmailRecoveryIndeterminateError',
      requiresFreshLogin: true,
    });
  });

  it('does not promote malformed delivery confirmations to sent', async () => {
    clientMocks.post
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { message: '   ' } });

    await expect(authAPI.twoFactorSendEmail('pending-token'))
      .rejects.toThrow('invalid response');
    await expect(authAPI.twoFactorSendEmailAuthenticated())
      .rejects.toThrow('invalid response');

    expect(clientMocks.post).toHaveBeenNthCalledWith(
      1,
      '/auth/2fa/send-email',
      { pendingToken: 'pending-token' },
    );
    expect(clientMocks.post).toHaveBeenNthCalledWith(
      2,
      '/auth/2fa/send-email-authenticated',
    );
  });
});
