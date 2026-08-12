const deletionTails = new Map<string, Promise<void>>();

type ProjectDeletionLockGuard = (input: {
  key: string;
  workspaceOwnerId: string;
  projectName: string;
  lifecycleLock: ProjectDeletionLockLease;
}) => Promise<void>;

/**
 * Runtime-branded proof that this process still owns one exact owner/name
 * lifecycle lock. It remains callable so existing finally blocks can release
 * it without a second wrapper whose identity could be forged or confused.
 */
export type ProjectDeletionLockLease = (() => void) & {
  readonly key: string;
  readonly workspaceOwnerId: string;
  readonly projectName: string;
  isHeld(): boolean;
};

const issuedProjectDeletionLockLeases = new WeakSet<ProjectDeletionLockLease>();

export interface ExpectedPreparedProjectPromotionLockHandoff {
  readonly key: string;
  readonly workspaceOwnerId: string;
  readonly projectName: string;
  readonly operationId: string;
  readonly manifestDigest: string;
}

export interface ExpectedPreparedProjectPromotionLock {
  readonly lifecycleLock: ProjectDeletionLockLease;
  readonly handoff: ExpectedPreparedProjectPromotionLockHandoff;
}

interface PreparedPromotionHandoffState {
  originalLease: ProjectDeletionLockLease;
  reacquireStarted: boolean;
  reacquiredLease: ProjectDeletionLockLease | null;
}

const issuedPreparedPromotionHandoffs = new WeakMap<
  ExpectedPreparedProjectPromotionLockHandoff,
  PreparedPromotionHandoffState
>();

let projectDeletionLockGuardLoader: Promise<ProjectDeletionLockGuard> | null = null;

async function projectDeletionLockGuard(): Promise<ProjectDeletionLockGuard> {
  if (!projectDeletionLockGuardLoader) {
    projectDeletionLockGuardLoader = import('./project-lifecycle.service').then((module) => (
      module.recoverInterruptedProjectLifecycleArtifactPromotionForLock
    ));
  }
  return projectDeletionLockGuardLoader;
}

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
function parseProjectDeletionLockKey(key: string): {
  workspaceOwnerId: string;
  projectName: string;
} | null {
  try {
    const parsed = JSON.parse(key);
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== 'string'
      || typeof parsed[1] !== 'string'
    ) return null;
    for (const segment of parsed) {
      if (segment === '.' || segment === '..' || /[/\\]/.test(segment)) return null;
    }
    return {
      workspaceOwnerId: requireDeletionKey(parsed[0]),
      projectName: requireDeletionKey(parsed[1]),
    };
  } catch {
    return null;
  }
}

async function acquireProjectDeletionLockGate(keyInput: string): Promise<{
  key: string;
  release(): void;
  isHeld(): boolean;
}> {
  const key = requireDeletionKey(keyInput);
  const previous = deletionTails.get(key) || Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  deletionTails.set(key, current);
  await previous.catch(() => undefined);

  let released = false;
  return { key, isHeld: () => !released, release: () => {
    if (released) return;
    released = true;
    releaseGate();
    if (deletionTails.get(key) === current) deletionTails.delete(key);
  } };
}

function mintProjectDeletionLockLease(input: {
  key: string;
  workspaceOwnerId: string;
  projectName: string;
  release(): void;
  isHeld(): boolean;
}): ProjectDeletionLockLease {
  const lease = (() => input.release()) as ProjectDeletionLockLease;
  Object.defineProperties(lease, {
    key: { value: input.key, enumerable: true },
    workspaceOwnerId: { value: input.workspaceOwnerId, enumerable: true },
    projectName: { value: input.projectName, enumerable: true },
    isHeld: { value: () => input.isHeld(), enumerable: false },
  });
  issuedProjectDeletionLockLeases.add(lease);
  return lease;
}

export function assertHeldProjectDeletionLockLease(
  lease: ProjectDeletionLockLease,
  expectedKey: string,
): void {
  const parsed = parseProjectDeletionLockKey(requireDeletionKey(expectedKey));
  if (
    !parsed
    || typeof lease !== 'function'
    || !issuedProjectDeletionLockLeases.has(lease)
    || !lease.isHeld()
    || lease.key !== expectedKey
    || lease.workspaceOwnerId !== parsed.workspaceOwnerId
    || lease.projectName !== parsed.projectName
  ) throw new Error('A held exact Project lifecycle lock lease is required');
}

/**
 * Recovery itself already owns the exact lock and must not recursively invoke
 * the guard. This is intentionally exported only for the recovery service.
 */
export async function acquireProjectDeletionLockWithoutGuard(
  keyInput: string,
): Promise<ProjectDeletionLockLease> {
  const gate = await acquireProjectDeletionLockGate(keyInput);
  const parsed = parseProjectDeletionLockKey(gate.key);
  if (!parsed) {
    gate.release();
    throw new Error('Project lifecycle lock requires an owner/name key');
  }
  return mintProjectDeletionLockLease({ ...gate, ...parsed });
}

export async function acquireProjectDeletionLock(keyInput: string): Promise<ProjectDeletionLockLease> {
  const gate = await acquireProjectDeletionLockGate(keyInput);
  let lease: ProjectDeletionLockLease | null = null;
  try {
    const parsed = parseProjectDeletionLockKey(gate.key);
    if (!parsed) throw new Error('Guarded Project deletion lock requires an owner/name key');
    lease = mintProjectDeletionLockLease({ ...gate, ...parsed });
    await (await projectDeletionLockGuard())({
      key: gate.key,
      ...parsed,
      lifecycleLock: lease,
    });
    return lease;
  } catch (error) {
    (lease || gate.release)();
    throw error;
  }
}

function requiredPromotionBinding(value: string, label: string, pattern: RegExp): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!pattern.test(normalized)) {
    throw new Error(`Prepared Project promotion ${label} is invalid`);
  }
  return normalized;
}

/**
 * Bind a one-use lock handoff to the exact PREPARED operation while the caller
 * still owns the ordinary guarded lifecycle lease.
 *
 * The reacquire intentionally skips the generic promotion-recovery guard: that
 * guard would otherwise interpret this installer's own PREPARED journal as an
 * abandoned operation and roll it back. No trust is transferred by skipping
 * the guard; the caller must subsequently re-attest the exact immutable
 * manifest and Project identity before authorizing any live rename.
 */
export function createExpectedPreparedProjectPromotionLockHandoff(input: {
  lifecycleLock: ProjectDeletionLockLease;
  operationId: string;
  manifestDigest: string;
}): ExpectedPreparedProjectPromotionLockHandoff {
  assertHeldProjectDeletionLockLease(input.lifecycleLock, input.lifecycleLock.key);
  const operationId = requiredPromotionBinding(
    input.operationId,
    'operation identity',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const manifestDigest = requiredPromotionBinding(
    input.manifestDigest,
    'manifest digest',
    /^[0-9a-f]{64}$/,
  );
  const handoff = Object.freeze({
    key: input.lifecycleLock.key,
    workspaceOwnerId: input.lifecycleLock.workspaceOwnerId,
    projectName: input.lifecycleLock.projectName,
    operationId,
    manifestDigest,
  });
  issuedPreparedPromotionHandoffs.set(handoff, {
    originalLease: input.lifecycleLock,
    reacquireStarted: false,
    reacquiredLease: null,
  });
  return handoff;
}

export async function reacquireExpectedPreparedProjectPromotionLock(
  handoff: ExpectedPreparedProjectPromotionLockHandoff,
): Promise<ExpectedPreparedProjectPromotionLock> {
  const state = issuedPreparedPromotionHandoffs.get(handoff);
  if (!state || state.reacquireStarted || state.originalLease.isHeld()) {
    throw new Error('Prepared Project promotion lock handoff is not available');
  }
  state.reacquireStarted = true;
  const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(handoff.key);
  state.reacquiredLease = lifecycleLock;
  return Object.freeze({ lifecycleLock, handoff });
}

export function assertHeldExpectedPreparedProjectPromotionLock(
  expected: ExpectedPreparedProjectPromotionLock,
  operationId: string,
  manifestDigest: string,
): void {
  const handoffState = issuedPreparedPromotionHandoffs.get(expected?.handoff);
  if (
    !handoffState
    || handoffState.reacquiredLease !== expected.lifecycleLock
    || expected.handoff.operationId !== String(operationId || '').trim().toLowerCase()
    || expected.handoff.manifestDigest !== String(manifestDigest || '').trim().toLowerCase()
  ) {
    throw new Error('Exact prepared Project promotion lock handoff is required');
  }
  assertHeldProjectDeletionLockLease(expected.lifecycleLock, expected.handoff.key);
}

/**
 * Run one owner/name-scoped filesystem mutation under the shared Project
 * lifecycle lock. Callers that already hold the exact branded lease pass it
 * through so a service can compose mutations without recursively queueing
 * behind itself.
 */
export async function withProjectDeletionLock<T>(input: {
  workspaceOwnerId: string;
  projectName: string;
  lifecycleLock?: ProjectDeletionLockLease;
}, operation: (lifecycleLock: ProjectDeletionLockLease) => Promise<T> | T): Promise<T> {
  const key = projectDeletionLockKey(input.workspaceOwnerId, input.projectName);
  if (input.lifecycleLock) {
    assertHeldProjectDeletionLockLease(input.lifecycleLock, key);
    return operation(input.lifecycleLock);
  }

  const lifecycleLock = await acquireProjectDeletionLock(key);
  try {
    return await operation(lifecycleLock);
  } finally {
    lifecycleLock();
  }
}

export function projectDeletionLockKey(workspaceOwnerId: string, projectName: string): string {
  for (const [label, value] of [
    ['owner', workspaceOwnerId],
    ['name', projectName],
  ] as const) {
    const segment = requireDeletionKey(value);
    if (segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
      throw new Error(`Project deletion lock ${label} is invalid`);
    }
  }
  return JSON.stringify([
    requireDeletionKey(workspaceOwnerId),
    requireDeletionKey(projectName),
  ]);
}
