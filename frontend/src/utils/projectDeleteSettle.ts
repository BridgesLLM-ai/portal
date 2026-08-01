/**
 * Deleting a Project is refused while a chat turn still holds a runtime lease.
 *
 * That condition clears itself the moment the lease lapses, and the server
 * reports how long that will take. Surfacing it as a plain failure made delete
 * look broken: the dialog showed an error, the project stayed, and then it
 * disappeared on its own once background recovery finished the admitted
 * deletion. Wait for the lease instead, then ask again.
 *
 * Only the self-clearing code is retried. Every other failure is rethrown
 * immediately so real problems still surface.
 */

export const PROJECT_DELETE_SETTLE_CODE = 'TURN_STILL_ACTIVE';
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 6;

function settleWaitMs(error: unknown): number | null {
  const data = (error as any)?.response?.data;
  if (!data || data.code !== PROJECT_DELETE_SETTLE_CODE) return null;
  if (data.retryable === false) return null;
  const hinted = Number(data.retryAfterMs);
  const wait = Number.isFinite(hinted) && hinted > 0 ? hinted : DEFAULT_WAIT_MS;
  return Math.max(1_000, Math.min(wait, MAX_WAIT_MS));
}

export function isProjectDeleteSettling(error: unknown): boolean {
  return settleWaitMs(error) !== null;
}

export async function deleteProjectAwaitingSettle(
  name: string,
  deleteProject: (name: string) => Promise<unknown>,
  options: {
    onWaiting?: (waitMs: number, attempt: number) => void;
    delay?: (ms: number) => Promise<void>;
    maxAttempts?: number;
  } = {},
): Promise<void> {
  const delay = options.delay
    || ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_ATTEMPTS);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await deleteProject(name);
      return;
    } catch (error) {
      const wait = settleWaitMs(error);
      // Not the self-clearing case, or we have waited long enough to stop
      // pretending it is transient — let the caller show the real error.
      if (wait === null || attempt >= maxAttempts) throw error;
      options.onWaiting?.(wait, attempt);
      await delay(wait);
    }
  }
}
