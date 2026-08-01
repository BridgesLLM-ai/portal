import client from './client';
import { AuthResponse } from '../types';

export interface RegistrationPendingResponse {
  pending: true;
  message: string;
}

export type TwoFactorEmailDeliveryState = 'sent' | 'unavailable' | 'failed';

export interface TwoFactorEmailDelivery {
  state: TwoFactorEmailDeliveryState;
  message: string;
  recoveryAvailable?: boolean;
}

export interface TwoFactorLoginResponse {
  requiresTwoFactor: true;
  pendingToken: string;
  method?: 'totp' | 'email';
  emailDelivery?: TwoFactorEmailDelivery;
}

export interface TwoFactorEmailRecoveryResponse {
  success: true;
  code: 'EMAIL_2FA_RECOVERED';
  requiresFreshLogin: true;
  message: string;
}

export class TwoFactorEmailRecoveryIndeterminateError extends Error {
  readonly requiresFreshLogin = true;

  constructor(message = 'Portal could not confirm the recovery result. Sign in again to verify the account state before retrying.') {
    super(message);
    this.name = 'TwoFactorEmailRecoveryIndeterminateError';
  }
}

function requireEmailDeliveryMessage(data: unknown, operation: string): { message: string } {
  const message = (data as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error(`${operation} returned an invalid response`);
  }
  return { message: message.trim() };
}

export interface TwoFactorSetupResponse {
  method?: 'totp' | 'email';
  secret?: string;
  qrCodeDataUrl?: string;
  otpauthUrl?: string;
  message?: string;
}

export interface TwoFactorStatusResponse {
  enabled: boolean;
  method: 'totp' | 'email' | null;
  backupCodesRemaining: number;
}

export type LoginResponse = AuthResponse | TwoFactorLoginResponse;
export type SignupResponse = AuthResponse | RegistrationPendingResponse;

export function isTwoFactorRequired(response: LoginResponse): response is TwoFactorLoginResponse {
  return 'requiresTwoFactor' in response && response.requiresTwoFactor === true;
}

export interface SessionInfo {
  userId: string;
  sessionCount: number;
  currentSessionId: string | null;
  sessions: Array<{
    id: string;
    isCurrent: boolean;
    createdAt: string;
    expiresAt: string;
    expiresIn: string;
    ipAddress: string;
    userAgent: string;
  }>;
  serverTime: string;
}

export const authAPI = {
  signup: async (email: string, username: string, password: string): Promise<SignupResponse> => {
    const { data } = await client.post('/auth/register', { email, name: username, password });
    return data;
  },

  login: async (email: string, password: string): Promise<LoginResponse> => {
    const { data } = await client.post('/auth/login', { email, password });
    return data;
  },

  refresh: async (): Promise<{ accessToken?: string }> => {
    const { data } = await client.post('/auth/refresh', {});
    return data;
  },

  logout: async (): Promise<void> => {
    await client.post('/auth/logout');
  },

  me: async (options?: { allowSessionRecovery?: boolean }) => {
    const { data } = await client.get('/auth/me', {
      _allowSessionRecovery: options?.allowSessionRecovery,
      timeout: 12000,
    } as any);
    return data;
  },

  // Two-Factor Authentication
  twoFactorSetup: async (method: 'totp' | 'email' = 'totp'): Promise<TwoFactorSetupResponse> => {
    const { data } = await client.post('/auth/2fa/setup', { method });
    return data;
  },

  twoFactorVerifySetup: async (token: string, method: 'totp' | 'email' = 'totp'): Promise<{ backupCodes: string[] }> => {
    const { data } = await client.post('/auth/2fa/verify-setup', { token, method });
    return data;
  },

  twoFactorDisable: async (token: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await client.post('/auth/2fa/disable', { token });
    return data;
  },

  twoFactorSendEmail: async (pendingToken: string): Promise<{ message: string }> => {
    const { data } = await client.post('/auth/2fa/send-email', { pendingToken });
    return requireEmailDeliveryMessage(data, 'Email Code delivery');
  },

  twoFactorSendEmailAuthenticated: async (): Promise<{ message: string }> => {
    const { data } = await client.post('/auth/2fa/send-email-authenticated');
    return requireEmailDeliveryMessage(data, 'Authenticated Email Code delivery');
  },

  twoFactorRecoverEmail: async (
    pendingToken: string,
    currentPassword: string,
    confirmation: string,
  ): Promise<TwoFactorEmailRecoveryResponse> => {
    const { data } = await client.post('/auth/2fa/recover-email', {
      pendingToken,
      currentPassword,
      confirmation,
    });
    if (
      data?.success !== true
      || data?.code !== 'EMAIL_2FA_RECOVERED'
      || data?.requiresFreshLogin !== true
      || typeof data?.message !== 'string'
      || data.message.trim().length === 0
    ) {
      throw new TwoFactorEmailRecoveryIndeterminateError();
    }
    return data;
  },

  twoFactorValidate: async (pendingToken: string, token: string): Promise<AuthResponse> => {
    const { data } = await client.post('/auth/2fa/validate', { pendingToken, token });
    return data;
  },

  twoFactorStatus: async (): Promise<TwoFactorStatusResponse> => {
    const { data } = await client.get('/auth/2fa/status');
    return data;
  },

  twoFactorRegenerateBackupCodes: async (token: string): Promise<{ backupCodes: string[] }> => {
    const { data } = await client.post('/auth/2fa/regenerate-backup-codes', { token });
    return data;
  },

  /**
   * Get session debug info (authenticated only).
   * Use _silent to prevent error capture on expected failures.
   */
  sessionInfo: async (): Promise<SessionInfo> => {
    const { data } = await client.get('/auth/session-info', {
      _silent: true, // Don't capture errors for this probe endpoint
    } as any);
    return data;
  },
};
