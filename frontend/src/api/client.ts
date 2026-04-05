import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../contexts/AuthContext';
import { captureError } from '../utils/errorHandler';

const API_URL = import.meta.env.VITE_API_URL || '/api';
const DEBUG_AUTH = import.meta.env.DEV;
const debugLog = (...args: unknown[]) => {
  if (DEBUG_AUTH) console.debug('[client]', ...args);
};

// Safety check: if VITE_API_URL was not set at build time, the bundle is misconfigured.
// Log a visible warning so it's immediately obvious during testing.
if (!import.meta.env.VITE_API_URL) {
  console.warn(
    '[BridgesLLM] VITE_API_URL was not set at build time — falling back to "/api". ' +
    'Ensure frontend/.env contains VITE_API_URL=/api before building.'
  );
}

const client: AxiosInstance = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

// ═══════════════════════════════════════════════════════════════════════════
// Session Stability: Token refresh management
// ═══════════════════════════════════════════════════════════════════════════

// Track whether we're in the middle of handling an auth failure to prevent cascading loops
let isHandlingAuthFailure = false;

// Track ongoing refresh to deduplicate concurrent refresh requests
let refreshPromise: Promise<void> | null = null;

// Track consecutive network failures to distinguish transient from persistent issues
let consecutiveNetworkFailures = 0;
const MAX_NETWORK_FAILURES_BEFORE_LOGOUT = 3;

// Last successful auth timestamp for debugging
let lastSuccessfulAuth = Date.now();

/**
 * Attempt to refresh the session. Returns true if successful.
 * Deduplicates concurrent refresh attempts.
 */
async function refreshSession(): Promise<boolean> {
  const { twoFactorPending } = useAuthStore.getState();
  if (twoFactorPending) {
    debugLog('[Auth] Skipping refresh while two-factor login is pending');
    return false;
  }

  // If already refreshing, wait for that result
  if (refreshPromise) {
    try {
      await refreshPromise;
      return true;
    } catch {
      return false;
    }
  }

  refreshPromise = (async () => {
    const response = await axios.post(`${API_URL}/auth/refresh`, {}, { 
      withCredentials: true,
      timeout: 10000, // 10s timeout for refresh
    });
    // Reset network failure counter on success
    consecutiveNetworkFailures = 0;
    lastSuccessfulAuth = Date.now();
    return response;
  })().then(() => {}).finally(() => {
    refreshPromise = null;
  });

  try {
    await refreshPromise;
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an error is a transient network issue (not a real auth failure)
 */
function isTransientNetworkError(error: AxiosError): boolean {
  // No response = network issue (timeout, DNS, connection refused, etc.)
  if (!error.response) {
    return true;
  }
  
  // 5xx errors from refresh endpoint might be transient server issues
  const status = error.response.status;
  if (status >= 500 && status < 600) {
    return true;
  }

  // 408 Request Timeout, 429 Too Many Requests — transient
  if (status === 408 || status === 429) {
    return true;
  }

  return false;
}

/**
 * Determine if we should logout based on the refresh failure
 */
function shouldLogoutOnRefreshFailure(error: AxiosError): boolean {
  // If it's a definitive auth error (401/403 from refresh), logout immediately
  const status = error.response?.status;
  if (status === 401 || status === 403) {
    debugLog('[Auth] Refresh token invalid/expired — logging out');
    return true;
  }

  // For transient errors, only logout after multiple consecutive failures
  if (isTransientNetworkError(error)) {
    consecutiveNetworkFailures++;
    debugLog(`[Auth] Transient network error during refresh (${consecutiveNetworkFailures}/${MAX_NETWORK_FAILURES_BEFORE_LOGOUT})`);
    
    if (consecutiveNetworkFailures >= MAX_NETWORK_FAILURES_BEFORE_LOGOUT) {
      debugLog('[Auth] Too many consecutive network failures — logging out');
      return true;
    }
    
    // Don't logout yet, let the original request fail but keep session
    return false;
  }

  // Unknown error type — be conservative, don't logout
  debugLog('[Auth] Unknown refresh error, not logging out:', error.message);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Response Interceptor: Handle auth failures gracefully
// ═══════════════════════════════════════════════════════════════════════════

client.interceptors.response.use(
  (response) => {
    // Successful response — reset failure counter
    consecutiveNetworkFailures = 0;
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
      _retryCount?: number;
      _silent?: boolean;
      _errorCaptured?: boolean;
      _errorReported?: boolean;
      _allowSessionRecovery?: boolean;
    };
    const status = error.response?.status;

    // ─────────────────────────────────────────────────────────────────────────
    // Auth failure handling (401/403)
    // ─────────────────────────────────────────────────────────────────────────
    
    // Skip setup endpoints — their 403s are setup-token failures, not auth failures
    const isSetupEndpoint = originalRequest?.url?.includes('/setup/');
    const isAuthFailure = (status === 401 || (status === 403 && !isSetupEndpoint));

    if (isAuthFailure && !originalRequest._retry) {
      originalRequest._retry = true;

      // Prevent cascading auth failures (e.g., logout triggering more 401s)
      if (isHandlingAuthFailure) {
        return Promise.reject(error);
      }

      // Skip refresh attempts for auth endpoints themselves to prevent loops
      // Exception: /auth/me should trigger refresh since it's used for session validation
      const isAuthEndpoint = originalRequest?.url?.includes('/auth/');
      if (isAuthEndpoint && !originalRequest?.url?.includes('/auth/me')) {
        return Promise.reject(error);
      }

      const { isAuthenticated, twoFactorPending } = useAuthStore.getState();
      const allowSessionRecovery = Boolean(originalRequest._allowSessionRecovery);

      // Only refresh when we already consider the user authenticated, or when
      // a restore-session probe explicitly opted into cookie-based recovery.
      // During 2FA pending, refresh attempts are always wrong and can poison the UX.
      if (twoFactorPending || (!isAuthenticated && !allowSessionRecovery)) {
        return Promise.reject(error);
      }

      try {
        const refreshed = await refreshSession();
        if (refreshed) {
          // Retry the original request
          return client(originalRequest);
        }
        // Refresh returned false (transient failure, not logging out)
        return Promise.reject(error);
      } catch (refreshError) {
        // Determine if we should logout
        if (shouldLogoutOnRefreshFailure(refreshError as AxiosError)) {
          isHandlingAuthFailure = true;
          try {
            // Use silentLogout to clear local state without API calls
            useAuthStore.getState().silentLogout();
          } finally {
            isHandlingAuthFailure = false;
          }
        }
        return Promise.reject(refreshError);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Network error retry for non-auth requests
    // ─────────────────────────────────────────────────────────────────────────
    
    if (isTransientNetworkError(error) && !originalRequest._retry) {
      const retryCount = originalRequest._retryCount || 0;
      if (retryCount < 2) {
        originalRequest._retryCount = retryCount + 1;
        // Exponential backoff: 500ms, 1500ms
        const delay = 500 * Math.pow(2, retryCount);
        debugLog(`[Network] Retrying request after ${delay}ms (attempt ${retryCount + 1}/2)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return client(originalRequest);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Error reporting and logging
    // ─────────────────────────────────────────────────────────────────────────

    const endpoint = `${(originalRequest?.method || 'GET').toUpperCase()} ${originalRequest?.url || ''}`.trim();

    // Surface meaningful API/network failures in the ErrorPanel too (skip auth refresh/report loops)
    // Also skip capturing auth errors during auth failure handling to prevent error sound spam
    // Requests with _silent=true opt out of error capture (used for expected-failure probes like session-info)
    if (!originalRequest?._silent && !originalRequest?._errorCaptured && !originalRequest?.url?.includes('report-error') && !originalRequest?.url?.includes('/auth/refresh') && !isHandlingAuthFailure) {
      originalRequest._errorCaptured = true;
      if (!status || status >= 400) {
        // Don't play error sounds for auth failures during logout - user already knows they're being logged out
        if (!(status === 401 || status === 403) || !originalRequest?.url?.includes('/auth/logout')) {
          captureError(error, status === 401 || status === 403 ? 'auth' : 'api', endpoint);
        }
      }
    }

    // Report 5xx + network errors to backend activity log (skip report-error endpoint to avoid loops)
    const responseStatus = error.response?.status;
    if ((!error.response || (responseStatus && responseStatus >= 500)) && !originalRequest?.url?.includes('report-error') && !originalRequest?._errorReported) {
      originalRequest._errorReported = true;
      const serverMsg = error.response?.data ? 
        ((error.response.data as any).detail || (error.response.data as any).error || error.message) : 
        error.message;
      client.post('/activity/report-error', {
        message: serverMsg || `Server error ${responseStatus || 'NETWORK'}`,
        endpoint,
        context: error.response ? `HTTP ${responseStatus}` : 'Network/transport failure',
        severity: (responseStatus && responseStatus >= 500) || !error.response ? 'CRITICAL' : 'ERROR',
      }).catch(() => {});
    }

    return Promise.reject(error);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Proactive Session Refresh (background heartbeat)
// ═══════════════════════════════════════════════════════════════════════════

let sessionHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start background session heartbeat to proactively refresh tokens
 * before they expire, preventing mid-request auth failures.
 */
export function startSessionHeartbeat() {
  // Clear any existing interval
  if (sessionHeartbeatInterval) {
    clearInterval(sessionHeartbeatInterval);
  }

  // Check session every 5 minutes
  const HEARTBEAT_INTERVAL = 5 * 60 * 1000;

  sessionHeartbeatInterval = setInterval(async () => {
    const { isAuthenticated } = useAuthStore.getState();
    if (!isAuthenticated) {
      return;
    }

    // If we haven't had a successful auth in 20 minutes, proactively refresh
    const timeSinceLastAuth = Date.now() - lastSuccessfulAuth;
    if (timeSinceLastAuth > 20 * 60 * 1000) {
      debugLog('[Session] Proactive token refresh (last auth:', Math.round(timeSinceLastAuth / 60000), 'min ago)');
      try {
        await refreshSession();
      } catch (err) {
        debugLog('[Session] Proactive refresh failed, will retry on next heartbeat');
      }
    }
  }, HEARTBEAT_INTERVAL);

  debugLog('[Session] Heartbeat started');
}

/**
 * Stop background session heartbeat (call on logout)
 */
export function stopSessionHeartbeat() {
  if (sessionHeartbeatInterval) {
    clearInterval(sessionHeartbeatInterval);
    sessionHeartbeatInterval = null;
    debugLog('[Session] Heartbeat stopped');
  }
}

/**
 * Get debug info about current session state
 */
export function getSessionDebugInfo() {
  return {
    lastSuccessfulAuth: new Date(lastSuccessfulAuth).toISOString(),
    timeSinceLastAuth: Math.round((Date.now() - lastSuccessfulAuth) / 1000) + 's',
    consecutiveNetworkFailures,
    isHandlingAuthFailure,
    isRefreshing: refreshPromise !== null,
  };
}

export default client;
