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
  for (const fn of listeners) {
    try { fn([...errorStore]); } catch { /* Diagnostic listeners must not break the app. */ }
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, maxLength);
}

function sanitizeDebugValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value).slice(0, 2_000);
  if (value instanceof Error) {
    return { name: value.name, message: value.message.slice(0, 2_000), stack: value.stack?.slice(0, 8_000) };
  }
  if (!value || typeof value !== 'object') return String(value).slice(0, 2_000);
  if (seen.has(value)) return '[Circular]';
  if (depth >= 4) return '[Max depth]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeDebugValue(item, seen, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    const sanitizedItem = sanitizeDebugValue(item, seen, depth + 1);
    if (sanitizedItem !== undefined) {
      result[key.slice(0, 200)] = sanitizedItem;
    }
  }
  return result;
}

function sanitizeDebug(debug: Record<string, unknown> | undefined): Record<string, unknown> {
  return (sanitizeDebugValue(debug || {}, new WeakSet()) as Record<string, unknown>) || {};
}

function diagnosticLocation(): { url?: string; route?: string } {
  if (typeof window === 'undefined') return {};
  // Query strings and fragments routinely contain OAuth codes, reset tokens,
  // and app state. They are not needed to identify the failing route.
  return {
    url: `${window.location.origin}${window.location.pathname}`,
    route: window.location.pathname,
  };
}

function safeJsonStringify(value: unknown, maxLength: number): string {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return '{}';
  }
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

  const safeMessage = boundedString(message, 4_000) || 'Unknown error';
  const safeStack = boundedString(stack, 64 * 1024);
  const safeEndpoint = boundedString(endpoint, 1_000);
  const safeComponentName = boundedString(componentName, 1_000);
  const safeContext = boundedString(context, 1_000);
  const location = diagnosticLocation();
  const safeDebug = sanitizeDebug({
    ...sanitizeDebug(debug),
    stack: safeStack,
    endpoint: safeEndpoint,
    componentName: safeComponentName,
    context: safeContext,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 1_000),
    ...location,
    title: typeof document === 'undefined' ? undefined : document.title.slice(0, 500),
  });

  const stored: StoredError = {
    id: `err-${++errorIdCounter}-${Date.now()}`,
    message: safeMessage,
    category,
    severity,
    timestamp: new Date().toISOString(),
    debug: safeDebug,
  };

  errorStore = [stored, ...errorStore].slice(0, MAX_ERRORS);
  notifyListeners();

  // Play error sound
  try { sounds.error(); } catch { /* Sound is best effort. */ }

  // Send to backend (non-blocking, fire-and-forget)
  try {
    activityAPI.reportError({
      message: safeMessage,
      stack: safeStack,
      endpoint: safeEndpoint,
      componentName: safeComponentName,
      context: safeContext || safeJsonStringify(sanitizeDebug(debug), 1_000),
      severity,
    }).catch(() => {});
  } catch { /* Reporting must never become another application error. */ }
}

/**
 * Convenience: extract + report an error from any thrown value.
 */
export function captureError(
  err: unknown,
  category: ErrorCategory = 'frontend',
  contextOrOptions?: string | Readonly<{ context?: string; endpoint?: string }>,
) {
  const contextMsg = typeof contextOrOptions === 'string'
    ? contextOrOptions
    : contextOrOptions?.context;
  const endpoint = typeof contextOrOptions === 'string'
    ? undefined
    : contextOrOptions?.endpoint;
  const extracted = extractError(err, contextMsg);
  reportError({
    message: extracted.message,
    category,
    severity: extracted.status && extracted.status >= 500 ? 'CRITICAL' : 'ERROR',
    stack: extracted.detail,
    endpoint,
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
  try { return JSON.stringify(errorStore, null, 2); } catch { return '[]'; }
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
