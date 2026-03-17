import client from './client';
import { AuthResponse } from '../types';

export interface RegistrationPendingResponse {
  pending: true;
  message: string;
}

export interface TwoFactorLoginResponse {
  requiresTwoFactor: true;
  pendingToken: string;
  method?: 'totp' | 'email';
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

  me: async () => {
    const { data } = await client.get('/auth/me');
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
    return data;
  },

  twoFactorSendEmailAuthenticated: async (): Promise<{ message: string }> => {
    const { data } = await client.post('/auth/2fa/send-email-authenticated');
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
};
