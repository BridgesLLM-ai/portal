/**
 * Centralized error handler — every error that shows a toast also gets logged to Activity.
 * Import and use this instead of raw toast.error() calls.
 */
import { activityAPI } from '../api/endpoints';
import { extractError } from './errorHelpers';
import sounds from './sounds';

export type ErrorCategory = 'agent_chat' | 'file_op' | 'git' | 'project' | 'auth' | 'api' | 'system' | 'frontend' | 'react';
export type ErrorSeverity = 'ERROR' | 'CRITICAL';

interface ErrorReportPayload {
  message: string;
  category?: ErrorCategory;
  severity?: ErrorSeverity;
  stack?: string;
  endpoint?: string;
  componentName?: string;
  context?: string;
  debug?: Record<string, any>;
}

// In-memory error store for the ErrorPanel
const MAX_ERRORS = 50;
let errorStore: StoredError[] = [];
let listeners: Array<(errors: StoredError[]) => void> = [];

export interface StoredError {
  id: string;
  message: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  timestamp: string;
  debug?: Record<string, any>;
}

let errorIdCounter = 0;

function notifyListeners() {
  for (const fn of listeners) fn([...errorStore]);
}

export function subscribeErrors(fn: (errors: StoredError[]) => void): () => void {
  listeners.push(fn);
  fn([...errorStore]);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

export function getErrors(): StoredError[] {
  return [...errorStore];
}

export function clearErrors() {
  errorStore = [];
  notifyListeners();
}

export function getErrorCount(): number {
  return errorStore.length;
}

/**
 * Report an error — stores locally AND sends to backend Activity log.
 * Non-blocking, never throws.
 */
export function reportError(payload: ErrorReportPayload) {
  const {
    message,
    category = 'frontend',
    severity = 'ERROR',
    stack,
    endpoint,
    componentName,
    context,
    debug,
  } = payload;

  const stored: StoredError = {
    id: `err-${++errorIdCounter}-${Date.now()}`,
    message,
    category,
    severity,
    timestamp: new Date().toISOString(),
    debug: {
      ...debug,
      stack,
      endpoint,
      componentName,
      context,
      userAgent: navigator.userAgent,
      url: window.location.href,
      route: window.location.pathname + window.location.search + window.location.hash,
      title: document.title,
    },
  };

  errorStore = [stored, ...errorStore].slice(0, MAX_ERRORS);
  notifyListeners();

  // Play error sound
  sounds.error();

  // Send to backend (non-blocking, fire-and-forget)
  activityAPI.reportError({
    message,
    stack,
    endpoint,
    componentName,
    context: context || JSON.stringify(debug || {}),
    severity,
  }).catch(() => {});
}

/**
 * Convenience: extract + report an error from any thrown value.
 */
export function captureError(err: unknown, category: ErrorCategory = 'frontend', contextMsg?: string) {
  const extracted = extractError(err, contextMsg);
  reportError({
    message: extracted.message,
    category,
    severity: extracted.status && extracted.status >= 500 ? 'CRITICAL' : 'ERROR',
    stack: extracted.detail,
    endpoint: undefined,
    context: contextMsg,
    debug: {
      hint: extracted.hint,
      status: extracted.status,
      code: extracted.code,
    },
  });
  return extracted;
}

/**
 * Export errors as JSON for sharing/debugging.
 */
export function exportErrorsJSON(): string {
  return JSON.stringify(errorStore, null, 2);
}


let globalHandlersInstalled = false;

export function initGlobalErrorHandlers() {
  if (globalHandlersInstalled || typeof window === 'undefined') return;
  globalHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    const err = event.error || new Error(event.message || 'Unhandled window error');
    captureError(err, 'frontend', event.filename ? `window error @ ${event.filename}:${event.lineno}:${event.colno}` : 'window error');
  });

  window.addEventListener('unhandledrejection', (event) => {
    captureError(event.reason, 'frontend', 'unhandled promise rejection');
  });
}
