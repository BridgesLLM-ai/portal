export const AUTH_REFRESH_ROTATION_CONFLICT_CODE = 'AUTH_REFRESH_ROTATION_CONFLICT';
export const AUTH_REFRESH_SESSION_GONE_CODE = 'AUTH_REFRESH_SESSION_GONE';
export const AUTH_REFRESH_CONFLICT_MAX_WAIT_MS = 5_000;

const AUTH_REFRESH_GENERATION_KEY = 'bridgesllm-auth-refresh-generation-v1';
const MIN_CONFLICT_WAIT_MS = 100;
let inProcessGeneration = 0;
const generationListeners = new Set<() => void>();

type ConflictResponse = {
  status?: number;
  data?: unknown;
  headers?: unknown;
};

type ConflictLike = {
  response?: ConflictResponse;
};

type GenerationSnapshot = Readonly<{
  inProcess: number;
  browser: string | null;
}>;

export type AuthRefreshFetchOptions = Readonly<{
  onDefinitiveFailure?: () => void;
}>;

/**
 * Browser-local terminal form of two consecutive legacy rotation conflicts.
 *
 * Session-bound 4.0.17+ tokens let the server distinguish a just-rotated old
 * digest from a deleted durable session. Tokens issued before that claim still
 * need this bounded compatibility fallback: when no winning browser generation
 * appears before the retry also conflicts, clear local auth and let /auth/me or
 * the next login reconcile the legacy httpOnly cookie. The Axios-like response
 * shape keeps every existing 401/403 sign-out path working without coupling
 * this utility to Axios.
 */
export class AuthRefreshSessionGoneError extends Error {
  readonly code = AUTH_REFRESH_SESSION_GONE_CODE;
  readonly response = {
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    data: {
      code: AUTH_REFRESH_SESSION_GONE_CODE,
      error: 'The refresh session is no longer current.',
    },
  };

  constructor(readonly conflict: unknown) {
    super('The refresh session is no longer current.');
    this.name = 'AuthRefreshSessionGoneError';
  }
}

function browserGeneration(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(AUTH_REFRESH_GENERATION_KEY);
  } catch {
    return null;
  }
}

function generationSnapshot(): GenerationSnapshot {
  return {
    inProcess: inProcessGeneration,
    browser: browserGeneration(),
  };
}

function generationChanged(snapshot: GenerationSnapshot): boolean {
  return inProcessGeneration !== snapshot.inProcess
    || browserGeneration() !== snapshot.browser;
}

export function publishAuthRefreshSuccess(): void {
  inProcessGeneration += 1;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        AUTH_REFRESH_GENERATION_KEY,
        `${Date.now()}:${inProcessGeneration}:${Math.random().toString(36).slice(2)}`,
      );
    } catch {
      // Same-tab listeners still provide coordination when storage is denied.
    }
  }
  for (const listener of [...generationListeners]) listener();
}

function conflictResponse(value: unknown): ConflictResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const nested = (value as ConflictLike).response;
  if (nested && typeof nested === 'object') return nested;
  const direct = value as ConflictResponse;
  if (typeof direct.status === 'number') return direct;
  return undefined;
}

export function isAuthRefreshRotationConflict(value: unknown): boolean {
  const response = conflictResponse(value);
  const data = response?.data as { code?: unknown; retryable?: unknown } | null | undefined;
  return response?.status === 409
    && data?.code === AUTH_REFRESH_ROTATION_CONFLICT_CODE
    && data.retryable === true;
}

export function isDefinitiveAuthRefreshFailure(value: unknown): boolean {
  if (value instanceof AuthRefreshSessionGoneError) return true;
  const status = conflictResponse(value)?.status;
  return status === 401 || status === 403;
}

function responseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = get.call(headers, name);
    return value == null ? undefined : String(value);
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return value == null ? undefined : String(value);
}

function conflictWaitMs(value: unknown): number {
  const retryAfter = Number(responseHeader(conflictResponse(value)?.headers, 'retry-after'));
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) return AUTH_REFRESH_CONFLICT_MAX_WAIT_MS;
  return Math.max(
    MIN_CONFLICT_WAIT_MS,
    Math.min(AUTH_REFRESH_CONFLICT_MAX_WAIT_MS, Math.ceil(retryAfter * 1_000)),
  );
}

async function waitForRefreshWinner(snapshot: GenerationSnapshot, conflict: unknown): Promise<boolean> {
  if (generationChanged(snapshot)) return true;
  const waitMs = conflictWaitMs(conflict);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      generationListeners.delete(check);
      if (typeof window !== 'undefined') window.removeEventListener('storage', check);
      resolve();
    };
    const check = () => {
      if (generationChanged(snapshot)) finish();
    };
    const timer = setTimeout(finish, waitMs);
    generationListeners.add(check);
    if (typeof window !== 'undefined') window.addEventListener('storage', check);
    // Close the registration race if the winner published between the first
    // check above and listener installation.
    check();
  });
  return generationChanged(snapshot);
}

/**
 * Retry one refresh exactly once after an admitted rotation conflict.
 *
 * The winner publishes only after its HTTP response has installed the new
 * httpOnly cookie. A loser in another tab waits for that browser-wide
 * generation before retrying, so it cannot immediately resend the stale cookie.
 */
export async function withAuthRefreshConvergence<T>(operation: () => Promise<T>): Promise<T> {
  const snapshot = generationSnapshot();
  try {
    const result = await operation();
    publishAuthRefreshSuccess();
    return result;
  } catch (error) {
    if (!isAuthRefreshRotationConflict(error)) throw error;
    await waitForRefreshWinner(snapshot, error);
    try {
      const result = await operation();
      publishAuthRefreshSuccess();
      return result;
    } catch (retryError) {
      if (
        isAuthRefreshRotationConflict(retryError)
        && !generationChanged(snapshot)
      ) {
        throw new AuthRefreshSessionGoneError(retryError);
      }
      throw retryError;
    }
  }
}

async function fetchRotationConflict(response: Response): Promise<ConflictResponse | null> {
  if (response.status !== 409) return null;
  let data: unknown;
  try {
    data = await response.clone().json();
  } catch {
    return null;
  }
  const conflict = { status: response.status, data, headers: response.headers };
  return isAuthRefreshRotationConflict(conflict) ? conflict : null;
}

function notifyDefinitiveFailure(options: AuthRefreshFetchOptions): void {
  try {
    options.onDefinitiveFailure?.();
  } catch {
    // Auth state cleanup is best effort; never turn it into a fetch exception.
  }
}

/** Fetch counterpart used by streaming Agent/Project Chat paths. */
export async function refreshAuthSessionWithFetch(
  apiUrl: string,
  options: AuthRefreshFetchOptions = {},
): Promise<boolean> {
  const snapshot = generationSnapshot();
  const attempt = () => fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  try {
    let response = await attempt();
    const conflict = await fetchRotationConflict(response);
    if (conflict) {
      await waitForRefreshWinner(snapshot, conflict);
      response = await attempt();
      const repeatedConflict = await fetchRotationConflict(response);
      if (repeatedConflict && !generationChanged(snapshot)) {
        notifyDefinitiveFailure(options);
        return false;
      }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        notifyDefinitiveFailure(options);
      }
      return false;
    }
    publishAuthRefreshSuccess();
    return true;
  } catch {
    return false;
  }
}

export const __authRefreshConvergenceTest = {
  reset() {
    inProcessGeneration = 0;
    generationListeners.clear();
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(AUTH_REFRESH_GENERATION_KEY);
      } catch {
        // Nothing to reset when storage is denied.
      }
    }
  },
};
