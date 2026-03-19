/**
 * Error extraction and formatting utilities for the portal.
 * Makes debugging trivial by extracting meaningful info from any error.
 */

import { captureError } from '../utils/errorHandler';

export interface ExtractedError {
  message: string;    // User-friendly summary
  detail?: string;    // Technical detail (stack trace, response body)
  hint?: string;      // Troubleshooting suggestion
  status?: number;    // HTTP status code
  code?: string;      // Error code (ECONNREFUSED, etc.)
}

/**
 * Extract structured error info from any error type.
 * Handles: Axios errors, fetch errors, generic JS errors, string errors.
 */
export function extractError(err: unknown, context?: string): ExtractedError {
  // String error
  if (typeof err === 'string') {
    return { message: err, hint: context ? `While: ${context}` : undefined };
  }

  // Null/undefined
  if (!err) {
    return { message: context || 'Unknown error', hint: 'No error details available' };
  }

  const e = err as any;

  // Axios-style error (has response.data)
  if (e.response?.data) {
    const data = e.response.data;
    const status = e.response.status;
    const serverMsg = data.detail || data.error || data.message || JSON.stringify(data);
    const statusText = httpStatusHint(status);
    
    return {
      message: `${context || 'Request failed'}: ${serverMsg}`,
      detail: [
        `HTTP ${status} ${e.response.statusText || ''}`,
        data.projectName ? `Project: ${data.projectName}` : '',
        data.model ? `Model: ${data.model}` : '',
        data.detail || '',
        e.config?.url ? `URL: ${e.config.method?.toUpperCase()} ${e.config.url}` : '',
      ].filter(Boolean).join('\n'),
      hint: statusText,
      status,
      code: data.code,
    };
  }

  // Axios-style error (network failure, no response)
  if (e.request && !e.response) {
    return {
      message: `${context || 'Network error'}: Server unreachable`,
      detail: `${e.message || 'No response received'}\nURL: ${e.config?.url || 'unknown'}`,
      hint: 'Check your internet connection or server status. The backend may be down.',
      code: e.code,
    };
  }

  // Fetch Response object
  if (e instanceof Response) {
    return {
      message: `${context || 'Request failed'}: HTTP ${e.status}`,
      detail: `${e.url}\nStatus: ${e.status} ${e.statusText}`,
      hint: httpStatusHint(e.status),
      status: e.status,
    };
  }

  // Standard Error object
  if (e instanceof Error) {
    const isNetwork = e.message.includes('Failed to fetch') || 
                      e.message.includes('NetworkError') ||
                      e.message.includes('ECONNREFUSED');
    const isAbort = e.name === 'AbortError';
    const isTimeout = e.message.includes('timeout') || e.message.includes('Timeout');

    if (isAbort) {
      return { message: 'Request cancelled', hint: 'The operation was aborted.' };
    }
    if (isNetwork) {
      return {
        message: `${context || 'Connection failed'}: Server unreachable`,
        detail: e.message,
        hint: 'Check your internet connection. The backend server may be down or restarting.',
        code: 'NETWORK_ERROR',
      };
    }
    if (isTimeout) {
      return {
        message: `${context || 'Operation'} timed out`,
        detail: e.message,
        hint: 'The operation took too long. Try again or check server load.',
        code: 'TIMEOUT',
      };
    }

    return {
      message: `${context || 'Error'}: ${e.message}`,
      detail: e.stack || e.message,
      hint: context ? `This happened while: ${context}` : undefined,
    };
  }

  // Object with message property
  if (e.message) {
    return {
      message: `${context || 'Error'}: ${e.message}`,
      detail: e.stack || JSON.stringify(e, null, 2),
    };
  }

  // Fallback
  return {
    message: context || 'An unexpected error occurred',
    detail: JSON.stringify(e, null, 2),
    hint: 'Check the browser console and Activity Log for more details.',
  };
}

/**
 * Give a human-readable hint for common HTTP status codes.
 */
function httpStatusHint(status: number): string {
  const hints: Record<number, string> = {
    400: 'Bad request — check the input data.',
    401: 'Authentication expired — try logging in again.',
    403: 'Access denied — you may not have permission for this action.',
    404: 'Not found — the resource may have been deleted or moved.',
    408: 'Request timeout — the server took too long.',
    409: 'Conflict — the resource may have been modified by another operation.',
    413: 'File too large — reduce file size or use chunked upload.',
    429: 'Rate limited — too many requests. Wait a moment and retry.',
    500: 'Internal server error — check server logs or Activity Log.',
    502: 'Bad gateway — the backend may be restarting.',
    503: 'Service unavailable — the server is overloaded or the AI service is down.',
    504: 'Gateway timeout — the request took too long to process.',
  };
  return hints[status] || `HTTP ${status} — check Activity Log for details.`;
}

/**
 * Log error to console with context (always useful for debugging).
 * Also reports to the error panel.
 */
export function logError(err: unknown, context: string) {
  console.error(`[Portal Error] ${context}:`, err);
  captureError(err, 'frontend', context);
}
