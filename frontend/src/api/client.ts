import axios, { AxiosInstance } from 'axios';
import { useAuthStore } from '../contexts/AuthContext';
import { captureError } from '../utils/errorHandler';

const API_URL = import.meta.env.VITE_API_URL || '/api';

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

// Track whether we're in the middle of handling an auth failure to prevent cascading loops
let isHandlingAuthFailure = false;

// Cookie-first auth: rely on httpOnly cookies, not JS-readable tokens.
// Keep a compatibility fallback for legacy Authorization headers only if already present.
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response?.status;

    // Handle both 401 (unauthorized) and 403 (forbidden/expired token)
    // Skip setup endpoints — their 403s are setup-token failures, not auth failures
    const isSetupEndpoint = originalRequest?.url?.includes('/setup/');
    if ((status === 401 || (status === 403 && !isSetupEndpoint)) && !originalRequest._retry) {
      originalRequest._retry = true;

      // Prevent cascading auth failures (e.g., logout triggering more 401s)
      if (isHandlingAuthFailure) {
        return Promise.reject(error);
      }

      // Skip refresh attempts for auth endpoints themselves to prevent loops
      const isAuthEndpoint = originalRequest?.url?.includes('/auth/');
      if (isAuthEndpoint && !originalRequest?.url?.includes('/auth/me')) {
        return Promise.reject(error);
      }

      try {
        await axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true });
        return client(originalRequest);
      } catch (refreshError) {
        // Refresh failed — clear auth state without calling the authenticated logout endpoint
        isHandlingAuthFailure = true;
        try {
          // Use silentLogout to clear local state without API calls
          useAuthStore.getState().silentLogout();
        } finally {
          isHandlingAuthFailure = false;
        }
        return Promise.reject(refreshError);
      }
    }

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
    if ((!error.response || error.response?.status >= 500) && !originalRequest?.url?.includes('report-error') && !originalRequest?._errorReported) {
      originalRequest._errorReported = true;
      const serverMsg = error.response?.data?.detail || error.response?.data?.error || error.message;
      client.post('/activity/report-error', {
        message: serverMsg || `Server error ${error.response?.status || 'NETWORK'}`,
        endpoint,
        context: error.response ? `HTTP ${error.response.status}` : 'Network/transport failure',
        severity: error.response?.status >= 500 || !error.response ? 'CRITICAL' : 'ERROR',
      }).catch(() => {});
    }

    return Promise.reject(error);
  }
);

export default client;
