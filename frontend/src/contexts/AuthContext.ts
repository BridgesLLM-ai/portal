import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '../types';
import { authAPI, isTwoFactorRequired, type RegistrationPendingResponse } from '../api/auth';
import { startSessionHeartbeat, stopSessionHeartbeat } from '../api/client';

const DEBUG_AUTH = import.meta.env.DEV;
const debugLog = (...args: unknown[]) => {
  if (DEBUG_AUTH) console.debug('[AuthContext]', ...args);
};


interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // 2FA pending state
  twoFactorPending: boolean;
  twoFactorPendingToken: string | null;
  twoFactorMethod: 'totp' | 'email' | null;

  // Session metadata (for debugging)
  lastSessionRestoreAt: number | null;

  signup: (email: string, username: string, password: string) => Promise<{ pending?: boolean; message?: string }>;
  login: (email: string, password: string) => Promise<{ requiresTwoFactor?: boolean }>;
  completeTwoFactor: (token: string) => Promise<void>;
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  /** Clear auth state locally without calling the logout API (used when token is already invalid) */
  silentLogout: () => void;
  clearError: () => void;
  restoreSession: () => Promise<boolean>;
  /** Force a session refresh (proactive) */
  refreshSession: () => Promise<boolean>;
}

/**
 * Clear all auth-related storage (localStorage keys used by legacy code)
 */
function clearAuthStorage() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('token');
}

/**
 * Persist minimal auth state to survive page refreshes.
 * User data + auth status are persisted; tokens are in httpOnly cookies.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      lastSessionRestoreAt: null,

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
            set({ user, isAuthenticated: true, isLoading: false, lastSessionRestoreAt: Date.now() });
            startSessionHeartbeat();
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
          set({ user, isAuthenticated: true, isLoading: false, lastSessionRestoreAt: Date.now() });
          startSessionHeartbeat();
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
            lastSessionRestoreAt: Date.now(),
          });
          startSessionHeartbeat();
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
        stopSessionHeartbeat();
        try {
          await authAPI.logout();
        } catch (error) {
          debugLog('Logout error:', error);
        } finally {
          clearAuthStorage();
          set({ user: null, isAuthenticated: false, error: null, twoFactorPending: false, twoFactorPendingToken: null, twoFactorMethod: null, lastSessionRestoreAt: null });
        }
      },

      silentLogout: () => {
        // Clear auth state without calling the backend logout endpoint.
        // Used when the token is already invalid (e.g., refresh failed) to prevent cascading 401 errors.
        stopSessionHeartbeat();
        clearAuthStorage();
        set({ user: null, isAuthenticated: false, error: null, twoFactorPending: false, twoFactorPendingToken: null, twoFactorMethod: null, lastSessionRestoreAt: null });
      },

      clearError: () => set({ error: null }),

      restoreSession: async () => {
        set({ isLoading: true });
        try {
          // Try /auth/me — works with either localStorage token (Authorization header)
          // or httpOnly cookie (sent automatically with withCredentials: true).
          // This handles both normal login (localStorage) and setup wizard (cookie-only).
          const user = await authAPI.me({ allowSessionRecovery: true });
          set({ isAuthenticated: true, user, isLoading: false, lastSessionRestoreAt: Date.now() });
          startSessionHeartbeat();
          return true;
        } catch (error: any) {
          // Only clear auth on definitive auth failures (401/403)
          // Don't clear on network errors — session might still be valid
          const status = error.response?.status;
          if (status === 401 || status === 403) {
            debugLog('[Auth] Session restore failed with', status, '— clearing auth');
            clearAuthStorage();
            set({ isAuthenticated: false, user: null, isLoading: false, lastSessionRestoreAt: null });
          } else {
            // Network error or other issue — preserve persisted state if we have it
            const currentState = get();
            if (currentState.user && currentState.isAuthenticated) {
              debugLog('[Auth] Session restore failed with network error, keeping cached auth');
              set({ isLoading: false });
              // Start heartbeat anyway — it will retry
              startSessionHeartbeat();
              return true;
            }
            set({ isAuthenticated: false, user: null, isLoading: false });
          }
          return false;
        }
      },

      refreshSession: async () => {
        try {
          await authAPI.refresh();
          return true;
        } catch (error) {
          debugLog('[Auth] Manual refresh failed:', error);
          return false;
        }
      },
    }),
    {
      name: 'bridgesllm-auth',
      storage: createJSONStorage(() => localStorage),
      // Only persist user + isAuthenticated, not loading/error states
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        lastSessionRestoreAt: state.lastSessionRestoreAt,
      }),
      // On rehydrate, validate session is still good
      onRehydrateStorage: () => (state) => {
        if (state?.isAuthenticated) {
          debugLog('[Auth] Rehydrated auth state, will validate session');
          // Don't auto-validate here — App.tsx handles that
        }
      },
    }
  )
);

// Handle visibility change — revalidate session when user returns to tab
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const { isAuthenticated, lastSessionRestoreAt } = useAuthStore.getState();
      if (isAuthenticated && lastSessionRestoreAt) {
        // If session was validated more than 10 minutes ago, revalidate
        const timeSinceRestore = Date.now() - lastSessionRestoreAt;
        if (timeSinceRestore > 10 * 60 * 1000) {
          debugLog('[Auth] Tab became visible, revalidating stale session');
          useAuthStore.getState().restoreSession().catch(() => {});
        }
      }
    }
  });
}
