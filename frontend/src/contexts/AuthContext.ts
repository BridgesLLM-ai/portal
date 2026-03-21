import { create } from 'zustand';
import { User } from '../types';
import { authAPI, isTwoFactorRequired, type RegistrationPendingResponse } from '../api/auth';

// Proactive token refresh interval (6 hours in milliseconds)
// This ensures tokens are refreshed well before the 24h expiry, even if the user
// is only using WebSocket (no HTTP requests to trigger reactive refresh).
const PROACTIVE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Track the refresh timer globally so we can clear it on logout
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
  /** Start the proactive refresh timer (called after successful auth) */
  startProactiveRefresh: () => void;
  /** Stop the proactive refresh timer (called on logout) */
  stopProactiveRefresh: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  twoFactorPending: false,
  twoFactorPendingToken: null,
  twoFactorMethod: null,

  startProactiveRefresh: () => {
    // Clear any existing timer first
    if (proactiveRefreshTimer) {
      clearTimeout(proactiveRefreshTimer);
      proactiveRefreshTimer = null;
    }

    const scheduleNextRefresh = () => {
      proactiveRefreshTimer = setTimeout(async () => {
        // Only refresh if still authenticated
        if (!get().isAuthenticated) {
          proactiveRefreshTimer = null;
          return;
        }

        console.debug('[Auth] Proactive token refresh triggered');
        try {
          await authAPI.refresh();
          console.debug('[Auth] Proactive token refresh succeeded');
          // Schedule the next refresh
          scheduleNextRefresh();
        } catch (err) {
          console.warn('[Auth] Proactive token refresh failed, retrying in 30s:', err);
          // Retry once after 30 seconds before giving up
          proactiveRefreshTimer = setTimeout(async () => {
            if (!get().isAuthenticated) {
              proactiveRefreshTimer = null;
              return;
            }
            try {
              await authAPI.refresh();
              console.debug('[Auth] Proactive token refresh retry succeeded');
              scheduleNextRefresh();
            } catch (retryErr) {
              console.error('[Auth] Proactive token refresh retry failed:', retryErr);
              // Don't silently logout — the user will be logged out when their next
              // API call fails. This prevents unexplained logouts while they're
              // actively using the app.
              proactiveRefreshTimer = null;
            }
          }, 30_000);
        }
      }, PROACTIVE_REFRESH_INTERVAL_MS);
    };

    scheduleNextRefresh();
    console.debug('[Auth] Proactive refresh timer started (interval: 6h)');
  },

  stopProactiveRefresh: () => {
    if (proactiveRefreshTimer) {
      clearTimeout(proactiveRefreshTimer);
      proactiveRefreshTimer = null;
      console.debug('[Auth] Proactive refresh timer stopped');
    }
  },

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
      get().startProactiveRefresh();
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
      get().startProactiveRefresh();
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
    get().stopProactiveRefresh();
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
    get().stopProactiveRefresh();
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
      get().startProactiveRefresh();
      return true;
    } catch (error) {
      console.error('Session restore error:', error);
      get().stopProactiveRefresh();
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('token');
      set({ isAuthenticated: false, user: null, isLoading: false });
      return false;
    }
  },
}));
