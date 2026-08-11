import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '../types';
import {
  authAPI,
  isTwoFactorRequired,
  type RegistrationPendingResponse,
  type TwoFactorEmailDelivery,
  type TwoFactorEmailRecoveryResponse,
  TwoFactorEmailRecoveryIndeterminateError,
} from '../api/auth';
import { startSessionHeartbeat, stopSessionHeartbeat } from '../api/client';
import {
  claimRouteOperation,
  isRouteOperationOwner,
  releaseRouteOperation,
} from './RouteOperationContext';
import { clearWorkspaceClientState } from '../utils/clearWorkspaceClientState';
import { StaleWorkspaceAuthorizationResponseError } from '../utils/workspaceAuthorization';

const DEBUG_AUTH = import.meta.env.DEV;
const debugLog = (...args: unknown[]) => {
  if (DEBUG_AUTH) console.debug('[AuthContext]', ...args);
};

let logoutOperationSequence = 0;
let sessionRestoreGeneration = 0;
let sessionRestoreInFlight: Promise<boolean> | null = null;

function invalidateSessionRestoreAttempts(): void {
  sessionRestoreGeneration += 1;
  // The request itself may still settle, but its generation fence prevents it
  // from mutating auth. Clearing the pointer lets a later legitimate session
  // establish its own single shared validation request.
  sessionRestoreInFlight = null;
}

/**
 * A superseded restore attempt must not write auth state — but it still owns
 * the `isLoading` flag it set on entry. Returning without clearing it strands
 * the whole shell: every auth button renders disabled as "Signing in…" forever.
 *
 * That is exactly what happens on a first visit with no session. `/auth/me`
 * 401s, the client's recovery path calls `/auth/refresh`, that 401s too, and
 * `silentLogout()` bumps the generation *before* the rejection reaches this
 * catch — so the only attempt in existence sees itself as stale and bails with
 * `isLoading` stuck true. Clear it unless a newer attempt is genuinely running,
 * in which case that attempt owns the flag and will clear it itself.
 */
function abandonSupersededRestore(): false {
  if (!sessionRestoreInFlight) useAuthStore.setState({ isLoading: false });
  return false;
}

/** Zustand persist key; also cleared explicitly when abandoning a session. */
const AUTH_PERSIST_KEY = 'bridgesllm-auth';
const ABANDON_SESSION_LOGOUT_TIMEOUT_MS = 2000;

function normalizeTwoFactorEmailDelivery(
  delivery: TwoFactorEmailDelivery | undefined,
): TwoFactorEmailDelivery | null {
  if (
    !delivery
    || !['sent', 'unavailable', 'failed'].includes(delivery.state)
    || typeof delivery.message !== 'string'
    || delivery.message.trim().length === 0
  ) {
    return null;
  }
  return {
    state: delivery.state,
    message: delivery.message,
    ...(typeof delivery.recoveryAvailable === 'boolean'
      ? { recoveryAvailable: delivery.recoveryAvailable }
      : {}),
  };
}


interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // 2FA pending state
  twoFactorPending: boolean;
  twoFactorPendingToken: string | null;
  twoFactorMethod: 'totp' | 'email' | null;
  twoFactorEmailDelivery: TwoFactorEmailDelivery | null;

  // Session metadata (for debugging)
  lastSessionRestoreAt: number | null;
  /** True when cached auth exists but the server could not validate it. */
  sessionRestoreError: boolean;
  /** True only when the failed validation is safe to retry automatically. */
  sessionRestoreRetryable: boolean;

  signup: (email: string, username: string, password: string) => Promise<{ pending?: boolean; message?: string }>;
  login: (email: string, password: string) => Promise<{ requiresTwoFactor?: boolean }>;
  completeTwoFactor: (token: string) => Promise<void>;
  recoverEmailTwoFactor: (
    currentPassword: string,
    confirmation: string,
  ) => Promise<TwoFactorEmailRecoveryResponse>;
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  /** Clear auth state locally without calling the logout API (used when token is already invalid) */
  silentLogout: () => void;
  /**
   * Escape hatch out of the quarantined-session state. When the server cannot
   * confirm a cached session the authenticated shell stays locked, and a retry
   * that never succeeds is otherwise the only available action. This abandons
   * the cached session locally so the user can sign in fresh, and makes a
   * bounded best-effort attempt to clear the server-side cookie -- bounded,
   * because an unreachable or hanging backend is the usual reason the user is
   * here, and waiting on it would recreate the dead end.
   */
  abandonQuarantinedSession: () => Promise<void>;
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
      twoFactorEmailDelivery: null,
      lastSessionRestoreAt: null,
      sessionRestoreError: false,
      sessionRestoreRetryable: false,

      signup: async (email, username, password) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authAPI.signup(email, username, password);

          if ('pending' in response && response.pending) {
            const pending = response as RegistrationPendingResponse;
            const message = typeof pending.message === 'string' && pending.message.trim()
              ? pending.message.trim()
              : 'Your access request is pending administrator review.';
            set({ user: null, isAuthenticated: false, isLoading: false, error: null });
            return { pending: true, message };
          }

          if ('user' in response) {
            const { user } = response;
            invalidateSessionRestoreAttempts();
            set({ user, isAuthenticated: true, isLoading: false, lastSessionRestoreAt: Date.now(), sessionRestoreError: false, sessionRestoreRetryable: false });
            startSessionHeartbeat();
            return {};
          }

          const malformedResponseError = Object.assign(
            new Error(
              'Portal could not confirm the registration result. Try signing in before submitting another request.',
            ),
            { registrationResultIndeterminate: true as const },
          );
          set({
            user: null,
            isAuthenticated: false,
            isLoading: false,
            error: malformedResponseError.message,
          });
          throw malformedResponseError;
        } catch (error: any) {
          const message = error.response?.data?.error
            || (error?.registrationResultIndeterminate === true
              ? error.message
              : 'Signup failed');
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
              twoFactorEmailDelivery: response.method === 'email'
                ? normalizeTwoFactorEmailDelivery(response.emailDelivery)
                : null,
            });
            return { requiresTwoFactor: true };
          }

          // Normal login (no 2FA)
          const { user } = response;
          invalidateSessionRestoreAttempts();
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            twoFactorPending: false,
            twoFactorPendingToken: null,
            twoFactorMethod: null,
            twoFactorEmailDelivery: null,
            lastSessionRestoreAt: Date.now(),
            sessionRestoreError: false,
            sessionRestoreRetryable: false,
          });
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
          invalidateSessionRestoreAttempts();
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            twoFactorPending: false,
            twoFactorPendingToken: null,
            twoFactorMethod: null,
            twoFactorEmailDelivery: null,
            lastSessionRestoreAt: Date.now(),
            sessionRestoreError: false,
            sessionRestoreRetryable: false,
          });
          startSessionHeartbeat();
        } catch (error: any) {
          const message = error.response?.data?.error || 'Verification failed';
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      recoverEmailTwoFactor: async (currentPassword, confirmation) => {
        const { twoFactorPendingToken, twoFactorMethod } = get();
        if (!twoFactorPendingToken || twoFactorMethod !== 'email') {
          set({ error: 'No pending Email Code verification session' });
          throw new Error('No pending Email Code verification session');
        }

        set({ isLoading: true, error: null });
        try {
          const response = await authAPI.twoFactorRecoverEmail(
            twoFactorPendingToken,
            currentPassword,
            confirmation,
          );
          // Recovery revokes every server-side session and deliberately does
          // not issue a replacement. Mirror that boundary locally before the
          // fresh sign-in screen is shown.
          stopSessionHeartbeat();
          invalidateSessionRestoreAttempts();
          clearAuthStorage();
          clearWorkspaceClientState();
          set({
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
            sessionRestoreRetryable: false,
          });
          return response;
        } catch (error: any) {
          const responseStatus = Number(error?.response?.status);
          const indeterminate = error instanceof TwoFactorEmailRecoveryIndeterminateError
            || !Number.isInteger(responseStatus)
            || responseStatus >= 500;
          if (indeterminate) {
            // A recovery request can commit before its response is lost or
            // malformed. A fresh sign-in is the only authoritative, harmless
            // reconciliation: it shows either a normal login (committed) or a
            // new pending Email Code challenge (not committed).
            stopSessionHeartbeat();
            invalidateSessionRestoreAttempts();
            clearAuthStorage();
            clearWorkspaceClientState();
            set({
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
              sessionRestoreRetryable: false,
            });
            throw error instanceof TwoFactorEmailRecoveryIndeterminateError
              ? error
              : new TwoFactorEmailRecoveryIndeterminateError();
          }
          const message = error.response?.data?.error || 'Email Code recovery failed';
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      cancelTwoFactor: () => {
        set({
          twoFactorPending: false,
          twoFactorPendingToken: null,
          twoFactorMethod: null,
          twoFactorEmailDelivery: null,
          error: null,
        });
      },

      logout: async () => {
        const owner = Object.freeze({
          scope: 'auth-logout' as const,
          token: ++logoutOperationSequence,
        });
        // Logout participates in the same exact-token admission coordinator
        // as every authenticated mutation. This closes both race directions:
        // an owned operation rejects Logout, and an admitted Logout rejects a
        // mutation before either request can reach the server.
        if (!claimRouteOperation(owner)) return;
        invalidateSessionRestoreAttempts();
        stopSessionHeartbeat();
        try {
          await authAPI.logout();
        } catch (error) {
          debugLog('Logout error:', error);
        } finally {
          // A stale Logout completion must never clear auth or release a newer
          // owner if its exact token was superseded during teardown.
          if (isRouteOperationOwner(owner)) {
            clearAuthStorage();
            clearWorkspaceClientState();
            set({ user: null, isAuthenticated: false, error: null, twoFactorPending: false, twoFactorPendingToken: null, twoFactorMethod: null, twoFactorEmailDelivery: null, lastSessionRestoreAt: null, sessionRestoreError: false, sessionRestoreRetryable: false });
            releaseRouteOperation(owner);
          }
        }
      },

      silentLogout: () => {
        // Clear auth state without calling the backend logout endpoint.
        // Used when the token is already invalid (e.g., refresh failed) to prevent cascading 401 errors.
        invalidateSessionRestoreAttempts();
        stopSessionHeartbeat();
        clearAuthStorage();
        clearWorkspaceClientState();
        set({ user: null, isAuthenticated: false, error: null, twoFactorPending: false, twoFactorPendingToken: null, twoFactorMethod: null, twoFactorEmailDelivery: null, lastSessionRestoreAt: null, sessionRestoreError: false, sessionRestoreRetryable: false });
      },

      abandonQuarantinedSession: async () => {
        invalidateSessionRestoreAttempts();
        stopSessionHeartbeat();
        // Best effort, and strictly bounded: clearing the httpOnly cookie is
        // worth attempting, but the user is already stranded and must not be
        // stranded again by a server that never answers.
        await Promise.race([
          authAPI.logout().catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, ABANDON_SESSION_LOGOUT_TIMEOUT_MS);
          }),
        ]);
        clearAuthStorage();
        clearWorkspaceClientState();
        try {
          localStorage.removeItem(AUTH_PERSIST_KEY);
        } catch {
          // Storage being unavailable must not block the escape.
        }
        set({
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
          sessionRestoreRetryable: false,
        });
      },

      clearError: () => set({ error: null }),

      restoreSession: () => {
        if (sessionRestoreInFlight) return sessionRestoreInFlight;
        const generation = ++sessionRestoreGeneration;
        const attempt = (async (): Promise<boolean> => {
          // Preserve an existing quarantine until the server actually validates
          // the session. Clearing it here would briefly expose the authenticated
          // shell from cached state during an automatic reconnect attempt.
          set({ isLoading: true });
          try {
            // Try /auth/me — works with either localStorage token (Authorization header)
            // or httpOnly cookie (sent automatically with withCredentials: true).
            // This handles both normal login (localStorage) and setup wizard (cookie-only).
            const user = await authAPI.me({ allowSessionRecovery: true });
            if (generation !== sessionRestoreGeneration) return abandonSupersededRestore();
            set({ isAuthenticated: true, user, isLoading: false, lastSessionRestoreAt: Date.now(), sessionRestoreError: false, sessionRestoreRetryable: false });
            startSessionHeartbeat();
            return true;
          } catch (error: any) {
            if (generation !== sessionRestoreGeneration) return abandonSupersededRestore();
            // Only clear auth on definitive auth failures (401/403)
            // Don't clear on network errors — session might still be valid
            const status = error.response?.status;
            if (status === 401 || status === 403) {
              debugLog('[Auth] Session restore failed with', status, '— clearing auth');
              clearAuthStorage();
              clearWorkspaceClientState();
              set({ isAuthenticated: false, user: null, isLoading: false, lastSessionRestoreAt: null, sessionRestoreError: false, sessionRestoreRetryable: false });
            } else {
              // A persisted Zustand snapshot is not proof that the server-side
              // session is still valid. Preserve it only so a successful retry
              // can resume cleanly; App blocks the authenticated shell while
              // sessionRestoreError is true.
              const currentState = get();
              if (currentState.user && currentState.isAuthenticated) {
                const retryable = !(error instanceof StaleWorkspaceAuthorizationResponseError)
                  && (status === undefined || status === 408 || status === 429 || status >= 500);
                debugLog('[Auth] Session restore unavailable — cached auth remains quarantined until retry');
                stopSessionHeartbeat();
                set({ isLoading: false, sessionRestoreError: true, sessionRestoreRetryable: retryable });
                return false;
              }
              set({ isAuthenticated: false, user: null, isLoading: false, sessionRestoreError: false, sessionRestoreRetryable: false });
            }
            return false;
          }
        })();
        sessionRestoreInFlight = attempt;
        void attempt.finally(() => {
          if (sessionRestoreInFlight === attempt) sessionRestoreInFlight = null;
        });
        return attempt;
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
      name: AUTH_PERSIST_KEY,
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
