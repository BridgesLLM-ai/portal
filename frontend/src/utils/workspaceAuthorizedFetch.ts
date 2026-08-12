import { useAuthStore } from '../contexts/AuthContext';
import { refreshAuthSessionWithFetch } from './authRefreshConvergence';
import {
  PORTAL_AUTHORIZATION_VERSION_HEADER,
  StaleWorkspaceAuthorizationResponseError,
  assertWorkspaceAuthorizationResponseIsCurrent,
  observedWorkspaceAuthorizationVersion,
  setWorkspaceAuthorizationBaseline,
  workspaceAuthorizationAbortSignal,
} from './workspaceAuthorization';

export interface WorkspaceAuthorizationRequestContext {
  userId: string;
  authorizationVersion: number;
  signal: AbortSignal;
}

function currentAuthorizationVersion(): number | null {
  const value = Number(useAuthStore.getState().user?.authorizationVersion ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function captureWorkspaceAuthorizationRequestContext():
WorkspaceAuthorizationRequestContext | null {
  const user = useAuthStore.getState().user;
  const authorizationVersion = currentAuthorizationVersion();
  if (!user?.id || authorizationVersion === null) return null;
  setWorkspaceAuthorizationBaseline(user.id, authorizationVersion);
  return {
    userId: user.id,
    authorizationVersion,
    signal: workspaceAuthorizationAbortSignal(user.id, authorizationVersion),
  };
}

export function assertWorkspaceAuthorizationRequestContextIsCurrent(
  context: WorkspaceAuthorizationRequestContext | null,
  responseVersion?: unknown,
): void {
  if (!context) return;
  const currentUser = useAuthStore.getState().user;
  const currentVersion = currentAuthorizationVersion();
  if (currentUser?.id !== context.userId
      || currentVersion !== context.authorizationVersion) {
    throw new StaleWorkspaceAuthorizationResponseError();
  }
  if (responseVersion !== undefined) {
    assertWorkspaceAuthorizationResponseIsCurrent(context.userId, responseVersion);
  }
  if (observedWorkspaceAuthorizationVersion(context.userId) !== context.authorizationVersion) {
    throw new StaleWorkspaceAuthorizationResponseError();
  }
}

function composeSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (available.length === 0) return undefined;
  if (available.length === 1) return available[0];
  const nativeAny = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof nativeAny === 'function') return nativeAny(available);

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of available) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

let workspaceRefreshPromise: Promise<boolean> | null = null;

function refreshWorkspaceSession(): Promise<boolean> {
  if (workspaceRefreshPromise) return workspaceRefreshPromise;
  const apiUrl = import.meta.env.VITE_API_URL || '/api';
  workspaceRefreshPromise = refreshAuthSessionWithFetch(apiUrl, {
    onDefinitiveFailure: () => useAuthStore.getState().silentLogout(),
  })
    .finally(() => {
      workspaceRefreshPromise = null;
    });
  return workspaceRefreshPromise;
}

/**
 * Fetch wrapper for actor-scoped Files, Projects, uploads, and Agent Chat.
 *
 * It stamps the request generation, rejects responses belonging to a previous
 * actor/generation, and keeps the authorization abort signal attached for the
 * lifetime of streaming response bodies.
 */
export async function workspaceAuthorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  admittedContext?: WorkspaceAuthorizationRequestContext | null,
): Promise<Response> {
  const context = admittedContext === undefined
    ? captureWorkspaceAuthorizationRequestContext()
    : admittedContext;
  if (context) assertWorkspaceAuthorizationRequestContextIsCurrent(context);

  const requestHeaders = typeof Request !== 'undefined' && input instanceof Request
    ? input.headers
    : undefined;
  const headers = new Headers(requestHeaders);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (context) {
    headers.set(
      PORTAL_AUTHORIZATION_VERSION_HEADER,
      String(context.authorizationVersion),
    );
  }

  const retryInput = typeof Request !== 'undefined' && input instanceof Request
    ? input.clone()
    : input;
  const requestInit: RequestInit = {
    ...init,
    headers,
    signal: composeSignals([init.signal, context?.signal]),
  };
  let response = await fetch(input, requestInit);
  assertWorkspaceAuthorizationRequestContextIsCurrent(
    context,
    context
      ? response.headers?.get?.(PORTAL_AUTHORIZATION_VERSION_HEADER) ?? undefined
      : undefined,
  );
  const authState = useAuthStore.getState();
  if (
    context
    && (response.status === 401 || response.status === 403)
    && authState.isAuthenticated
    && !authState.twoFactorPending
    && !requestInit.signal?.aborted
    && await refreshWorkspaceSession()
  ) {
    assertWorkspaceAuthorizationRequestContextIsCurrent(context);
    response = await fetch(retryInput, requestInit);
    assertWorkspaceAuthorizationRequestContextIsCurrent(
      context,
      response.headers?.get?.(PORTAL_AUTHORIZATION_VERSION_HEADER) ?? undefined,
    );
  }
  return response;
}

export interface WorkspaceAuthorizationXhrBinding {
  context: WorkspaceAuthorizationRequestContext | null;
  dispose: () => void;
  validateResponse: () => void;
}

/**
 * XMLHttpRequest companion for uploads that need browser upload-progress
 * events. Call after xhr.open() and before xhr.send().
 */
export function bindWorkspaceAuthorizationToXhr(
  xhr: XMLHttpRequest,
  admittedContext?: WorkspaceAuthorizationRequestContext | null,
): WorkspaceAuthorizationXhrBinding {
  const context = admittedContext === undefined
    ? captureWorkspaceAuthorizationRequestContext()
    : admittedContext;
  if (!context) {
    return {
      context: null,
      dispose: () => undefined,
      validateResponse: () => undefined,
    };
  }
  assertWorkspaceAuthorizationRequestContextIsCurrent(context);
  xhr.setRequestHeader(
    PORTAL_AUTHORIZATION_VERSION_HEADER,
    String(context.authorizationVersion),
  );
  const abort = () => xhr.abort();
  context.signal.addEventListener('abort', abort, { once: true });
  return {
    context,
    dispose: () => context.signal.removeEventListener('abort', abort),
    validateResponse: () => assertWorkspaceAuthorizationRequestContextIsCurrent(
      context,
      xhr.getResponseHeader(PORTAL_AUTHORIZATION_VERSION_HEADER) ?? undefined,
    ),
  };
}
