import { create } from 'zustand';
import { User } from '../types';
import { authAPI, isTwoFactorRequired, type RegistrationPendingResponse } from '../api/auth';


interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // 2FA pending state
  twoFactorPending: boolean;
  twoFactorPendingToken: string | null;
  twoFactorMethod: 'totp' | 'email' | null;

  signup: (email: string, username: string, password: string) => Promise<{ pending?: boolean; message?: string }>;
  login: (email: string, password: string) => Promise<{ requiresTwoFactor?: boolean }>;
  completeTwoFactor: (token: string) => Promise<void>;
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  /** Clear auth state locally without calling the logout API (used when token is already invalid) */
  silentLogout: () => void;
  clearError: () => void;
  restoreSession: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  twoFactorPending: false,
  twoFactorPendingToken: null,
  twoFactorMethod: null,

  signup: async (email, username, password) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.signup(email, username, password);

      if ('pending' in response && response.pending) {
        const pending = response as RegistrationPendingResponse;
        set({ user: null, isAuthenticated: false, isLoading: false, error: pending.message });
        return { pending: true, message: pending.message };
      }

      if ('user' in response) {
        const { user } = response;
        set({ user, isAuthenticated: true, isLoading: false });
        return {};
      }

      set({ user: null, isAuthenticated: false, isLoading: false, error: 'Signup pending review' });
      return { pending: true, message: 'Signup pending review' };
    } catch (error: any) {
      const message = error.response?.data?.error || 'Signup failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.login(email, password);

      if (isTwoFactorRequired(response)) {
        // 2FA is required — store pending token, don't issue auth tokens yet
        set({
          isLoading: false,
          twoFactorPending: true,
          twoFactorPendingToken: response.pendingToken,
          twoFactorMethod: response.method || 'totp',
        });
        return { requiresTwoFactor: true };
      }

      // Normal login (no 2FA)
      const { user } = response;
      set({ user, isAuthenticated: true, isLoading: false });
      return {};
    } catch (error: any) {
      const message = error.response?.data?.error || 'Login failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  completeTwoFactor: async (token: string) => {
    const { twoFactorPendingToken } = get();
    if (!twoFactorPendingToken) {
      set({ error: 'No pending two-factor session' });
      throw new Error('No pending two-factor session');
    }

    set({ isLoading: true, error: null });
    try {
      const { user } = await authAPI.twoFactorValidate(twoFactorPendingToken, token);
      set({
        user,
        isAuthenticated: true,
        isLoading: false,
        twoFactorPending: false,
        twoFactorPendingToken: null,
        twoFactorMethod: null,
      });
    } catch (error: any) {
      const message = error.response?.data?.error || 'Verification failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  cancelTwoFactor: () => {
    set({
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      error: null,
    });
  },

  logout: async () => {
    try {
      await authAPI.logout();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('token');
      set({ user: null, isAuthenticated: false, error: null, twoFactorPending: false, twoFactorPendingToken: null, twoFactorMethod: null });
    }
  },

  silentLogout: () => {
    // Clear auth state without calling the backend logout endpoint.
    // Used when the token is already invalid (e.g., refresh failed) to prevent cascading 401 errors.
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('token');
    set({ user: null, isAuthenticated: false, error: null, twoFactorPending: false, twoFactorPendingToken: null, twoFactorMethod: null });
  },

  clearError: () => set({ error: null }),

  restoreSession: async () => {
    set({ isLoading: true });
    try {
      // Try /auth/me — works with either localStorage token (Authorization header)
      // or httpOnly cookie (sent automatically with withCredentials: true).
      // This handles both normal login (localStorage) and setup wizard (cookie-only).
      const user = await authAPI.me();
      set({ isAuthenticated: true, user, isLoading: false });
      return true;
    } catch (error) {
      console.error('Session restore error:', error);
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('token');
      set({ isAuthenticated: false, user: null, isLoading: false });
      return false;
    }
  },
}));
