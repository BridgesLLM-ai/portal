const deletionTails = new Map<string, Promise<void>>();

function requireDeletionKey(value: string): string {
  const key = String(value || '');
  if (!key || key.length > 1024 || key.includes('\0')) {
    throw new Error('Project deletion lock key is invalid');
  }
  return key;
}

/**
 * Serialize destructive teardown for one workspace/project inside the Portal
 * process. A queued caller re-runs the idempotent deletion path after the
 * current caller releases the lock, so failures remain retryable and a
 * successful first request turns every waiter into an `alreadyAbsent` success.
 */
export async function acquireProjectDeletionLock(keyInput: string): Promise<() => void> {
  const key = requireDeletionKey(keyInput);
  const previous = deletionTails.get(key) || Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  deletionTails.set(key, current);
  await previous.catch(() => undefined);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (deletionTails.get(key) === current) deletionTails.delete(key);
  };
}

export function projectDeletionLockKey(workspaceOwnerId: string, projectName: string): string {
  return JSON.stringify([
    requireDeletionKey(workspaceOwnerId),
    requireDeletionKey(projectName),
  ]);
}
