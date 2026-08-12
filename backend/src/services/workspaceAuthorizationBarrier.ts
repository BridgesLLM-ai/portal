import type { Request, Response } from 'express';
import { AppError } from '../middleware/errorHandler';

interface ActiveWorkspaceRequest {
  kind: 'read' | 'mutation';
  response?: Response;
  released: boolean;
  stateKeys: string[];
}

interface WorkspaceAuthorizationState {
  fenced: boolean;
  active: Set<ActiveWorkspaceRequest>;
  mutationDrainWaiters: Set<() => void>;
}

const states = new Map<string, WorkspaceAuthorizationState>();
const admittedRequests = new WeakSet<Request>();
const requestAdmissions = new WeakMap<Request, ActiveWorkspaceRequest>();
const GLOBAL_WORKSPACE_AUTHORIZATION_KEY = '__portal_workspace_topology__';
const globalFenceSubscribers = new Set<() => void>();

function stateFor(userId: string): WorkspaceAuthorizationState {
  let state = states.get(userId);
  if (!state) {
    state = { fenced: false, active: new Set(), mutationDrainWaiters: new Set() };
    states.set(userId, state);
  }
  return state;
}

function releaseAdmission(admission: ActiveWorkspaceRequest): void {
  if (admission.released) return;
  admission.released = true;
  for (const stateKey of admission.stateKeys) {
    const state = states.get(stateKey);
    state?.active.delete(admission);
    if (state && ![...state.active].some((request) => request.kind === 'mutation')) {
      for (const resolve of [...state.mutationDrainWaiters]) resolve();
      state.mutationDrainWaiters.clear();
    }
    if (state && !state.fenced && state.active.size === 0) states.delete(stateKey);
  }
}

export function isWorkspaceAuthorizationPath(req: Pick<Request, 'originalUrl' | 'path'>): boolean {
  return workspaceAuthorizationOperationKind(req) !== null;
}

function workspaceAuthorizationOperationKind(
  req: Pick<Request, 'originalUrl' | 'path'> & { method?: string },
): 'read' | 'mutation' | null {
  const pathname = String(req.originalUrl || req.path || '').split('?')[0];
  // Owner dependency-repair control is the only recovery surface that must
  // remain reachable while the process-global workspace writer fence is held.
  // It has its own exact Project lock, durable go-bit and Owner/session gate;
  // admitting it here would either deadlock on itself or make a lost-response
  // retry impossible while containment is doing its job.
  // Mirror Express's default route equivalence exactly: literals are
  // case-insensitive and one trailing slash is optional, while methods and
  // deeper suffixes remain distinct. Any broader prefix exemption would let
  // ordinary Project mutations bypass the global containment fence.
  const method = String(req.method || '').toUpperCase();
  if ((method === 'GET'
      && /^\/api\/projects\/dependency-repair\/active\/?$/i.test(pathname))
    || (method === 'GET'
      && /^\/api\/projects\/[^/]+\/dependency-repair\/status\/?$/i.test(pathname))
    || (method === 'POST'
      && /^\/api\/projects\/[^/]+\/dependency-repair\/force-forward\/?$/i.test(pathname))) {
    return null;
  }
  if (pathname === '/api/gateway' || pathname.startsWith('/api/gateway/')) {
    // Default every non-read Gateway operation to mutation-capable so a newly
    // added session/runtime control cannot silently bypass an authorization
    // transition. A few nominal GET handlers also converge durable ownership
    // or trigger runtime work and therefore need the same settlement boundary.
    if ([
      '/api/gateway/health',
      '/api/gateway/session-info',
      '/api/gateway/history',
      '/api/gateway/stream-status',
    ].includes(pathname)) {
      return 'mutation';
    }
    return req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'mutation';
  }
  if (pathname === '/api/ai/analyze' || pathname === '/api/ai/file-content') {
    return 'read';
  }
  if (
    pathname === '/api/ai-setup'
    || pathname.startsWith('/api/ai-setup/')
    || pathname === '/api/remote-desktop'
    || pathname.startsWith('/api/remote-desktop/')
  ) {
    // These host-control surfaces can rewrite OpenClaw configuration and
    // restart the provider. Treat even their nominal status/finalization GETs
    // as mutation-capable because several converge pending setup state.
    return 'mutation';
  }
  if (pathname === '/api/agent-jobs' || pathname.startsWith('/api/agent-jobs/')) {
    return req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'mutation';
  }
  if (pathname === '/hosted' || pathname.startsWith('/hosted/')) {
    return req.method === 'GET' || req.method === 'HEAD' ? 'read' : null;
  }
  const projectPath = pathname === '/api/projects'
    || pathname.startsWith('/api/projects/');
  if (projectPath) {
    // Several legacy GET handlers converge durable project identity, chat
    // state, or interrupted lifecycle work. Treat the whole project surface
    // as mutation-capable until those handlers are made side-effect-free.
    return 'mutation';
  }
  const workspacePath = pathname === '/api/files'
    || pathname.startsWith('/api/files/')
    || pathname === '/api/upload'
    || pathname.startsWith('/api/upload/');
  if (!workspacePath) return null;
  return req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'mutation';
}

/**
 * Admit one actor-scoped Files/Projects operation. Reads are aborted by a
 * successful authorization fence; mutations make the fence fail busy so an
 * old shared-workspace write can never outlive a reported scope change.
 */
function admitWorkspaceAuthorizationOperation(
  req: Request,
  res: Response,
  actorUserId: string,
  kind: 'read' | 'mutation',
): boolean {
  if (admittedRequests.has(req)) return true;
  const globalState = stateFor(GLOBAL_WORKSPACE_AUTHORIZATION_KEY);
  if (globalState.fenced) {
    res.status(409).json({
      error: 'Workspace authorization is changing. Retry after the Portal reloads.',
      code: 'WORKSPACE_SCOPE_CHANGED',
    });
    return false;
  }
  const state = stateFor(actorUserId);
  if (state.fenced) {
    if (!globalState.fenced && globalState.active.size === 0) {
      states.delete(GLOBAL_WORKSPACE_AUTHORIZATION_KEY);
    }
    res.status(409).json({
      error: 'Workspace authorization is changing. Retry after the Portal reloads.',
      code: 'WORKSPACE_SCOPE_CHANGED',
    });
    return false;
  }

  const admission: ActiveWorkspaceRequest = {
    kind,
    response: res,
    released: false,
    stateKeys: [actorUserId, GLOBAL_WORKSPACE_AUTHORIZATION_KEY],
  };
  admittedRequests.add(req);
  requestAdmissions.set(req, admission);
  state.active.add(admission);
  globalState.active.add(admission);
  const release = () => releaseAdmission(admission);
  res.once('finish', release);
  if (kind === 'read') {
    res.once('close', release);
  } else {
    // A disconnected client does not mean an async route stopped mutating.
    // Release when the handler actually ends the response, even if the socket
    // vanished first. Detached work must hold its own explicit lease.
    const originalEnd = res.end;
    res.end = function patchedWorkspaceAuthorizationEnd(
      this: Response,
      ...args: Parameters<Response['end']>
    ): ReturnType<Response['end']> {
      try {
        return originalEnd.apply(this, args);
      } finally {
        release();
      }
    } as Response['end'];
    res.once('close', () => {
      if (res.writableEnded) release();
    });
  }
  return true;
}

export function admitWorkspaceAuthorizationRequest(
  req: Request,
  res: Response,
  actorUserId: string,
): boolean {
  const kind = workspaceAuthorizationOperationKind(req);
  if (!kind) return true;
  return admitWorkspaceAuthorizationOperation(
    req,
    res,
    actorUserId,
    kind,
  );
}

/** Admit a POST-style endpoint whose operation is semantically read-only. */
export function admitWorkspaceAuthorizationRead(
  req: Request,
  res: Response,
  actorUserId: string,
): boolean {
  return admitWorkspaceAuthorizationOperation(req, res, actorUserId, 'read');
}

export function admitWorkspaceAuthorizationMutation(
  req: Request,
  res: Response,
  actorUserId: string,
): boolean {
  return admitWorkspaceAuthorizationOperation(req, res, actorUserId, 'mutation');
}

/**
 * Mark the request's actual async operation settled. Long-lived SSE/proxy
 * handlers must call this in their own finally path because client disconnect
 * and response completion are not authoritative operation boundaries.
 */
export function settleWorkspaceAuthorizationRequest(req: Request): void {
  const admission = requestAdmissions.get(req);
  if (admission) releaseAdmission(admission);
}

/**
 * Settle an admitted operation when asynchronous middleware discovers that
 * its client vanished while it was awaiting authorization data. Mutation
 * admissions intentionally survive `close`, so every pre-handler early return
 * must make the operation boundary explicit.
 */
export function settleWorkspaceAuthorizationRequestIfResponseEnded(
  req: Request,
  res: Pick<Response, 'destroyed' | 'writableEnded'>,
): boolean {
  if (!res.destroyed && !res.writableEnded) return false;
  settleWorkspaceAuthorizationRequest(req);
  return true;
}

/**
 * Hold an authorization-impacting mutation open beyond the HTTP response.
 *
 * Project provider turns acknowledge dispatch before their callbacks finish
 * editing/checkpointing the workspace. Their lease must therefore remain
 * visible to the authorization fence until the provider has actually settled.
 */
export function acquireWorkspaceAuthorizationMutationLease(actorUserId: string): () => void {
  const globalState = stateFor(GLOBAL_WORKSPACE_AUTHORIZATION_KEY);
  if (globalState.fenced) {
    throw new AppError(409, 'Workspace authorization is changing. Retry after the Portal reloads.');
  }
  const state = stateFor(actorUserId);
  if (state.fenced) {
    if (!globalState.fenced && globalState.active.size === 0) {
      states.delete(GLOBAL_WORKSPACE_AUTHORIZATION_KEY);
    }
    throw new AppError(409, 'Workspace authorization is changing. Retry after the Portal reloads.');
  }

  const admission: ActiveWorkspaceRequest = {
    kind: 'mutation',
    released: false,
    stateKeys: [actorUserId, GLOBAL_WORKSPACE_AUTHORIZATION_KEY],
  };
  state.active.add(admission);
  globalState.active.add(admission);

  return () => releaseAdmission(admission);
}

export function acquireGlobalWorkspaceAuthorizationMutationLease(): () => void {
  const state = stateFor(GLOBAL_WORKSPACE_AUTHORIZATION_KEY);
  if (state.fenced) {
    throw new AppError(409, 'Workspace ownership is changing. Retry after the Portal reloads.');
  }
  const admission: ActiveWorkspaceRequest = {
    kind: 'mutation',
    released: false,
    stateKeys: [GLOBAL_WORKSPACE_AUTHORIZATION_KEY],
  };
  state.active.add(admission);
  return () => releaseAdmission(admission);
}

function mutationDrainPromise(state: WorkspaceAuthorizationState): Promise<void> {
  if (![...state.active].some((request) => request.kind === 'mutation')) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    state.mutationDrainWaiters.add(resolve);
  });
}

/**
 * Subscribe one long-lived interactive authority to the global authorization
 * fence.
 *
 * Registration and the already-fenced check are deliberately synchronous.
 * JavaScript cannot interleave closeGlobalWorkspaceAuthorizationAdmission()
 * between them, so a socket either observes the existing fence immediately or
 * is present when the next fence synchronously notifies subscribers.
 */
export function subscribeToGlobalWorkspaceAuthorizationFence(
  listener: () => void,
): () => void {
  let subscribed = true;
  globalFenceSubscribers.add(listener);

  if (states.get(GLOBAL_WORKSPACE_AUTHORIZATION_KEY)?.fenced) {
    try {
      listener();
    } catch {
      // One broken transport teardown must not weaken the global fence.
    }
  }

  return () => {
    if (!subscribed) return;
    subscribed = false;
    globalFenceSubscribers.delete(listener);
  };
}

function notifyGlobalWorkspaceAuthorizationFenceSubscribers(): void {
  for (const subscriber of [...globalFenceSubscribers]) {
    try {
      subscriber();
    } catch {
      // Continue revoking every other long-lived authority.
    }
  }
}

interface ClosedWorkspaceAuthorizationFences {
  stateKeys: string[];
  selected: WorkspaceAuthorizationState[];
  drained: Promise<void>;
}

export interface WorkspaceAuthorizationFenceController {
  /**
   * Resolves only after every mutation admitted before the fence has reached
   * its authoritative settlement boundary.
   */
  waitForMutationDrain(): Promise<void>;
  /**
   * Reopens admission. Callers must keep the fence closed through their
   * durable authorization commit (or rollback).
   */
  release(): void;
}

function closeFences(userIds: string[]): ClosedWorkspaceAuthorizationFences {
  const uniqueIds = [...new Set(userIds)].sort();
  const selected = uniqueIds.map(stateFor);
  if (selected.some((state) => state.fenced)) {
    throw new AppError(409, 'Workspace authorization is already changing. Retry shortly.');
  }
  for (const state of selected) state.fenced = true;
  if (uniqueIds.includes(GLOBAL_WORKSPACE_AUTHORIZATION_KEY)) {
    notifyGlobalWorkspaceAuthorizationFenceSubscribers();
  }

  for (const state of selected) {
    for (const request of [...state.active]) {
      if (request.kind !== 'read') continue;
      releaseAdmission(request);
      if (request.response && !request.response.destroyed) request.response.destroy();
    }
  }
  return {
    stateKeys: uniqueIds,
    selected,
    drained: Promise.all(selected.map(mutationDrainPromise)).then(() => undefined),
  };
}

/**
 * Close admission immediately without first waiting for old mutations.
 *
 * Authorization transitions need this two-phase boundary so they can signal
 * and quiesce admitted provider work that owns a mutation lease, then wait for
 * that work to settle. Waiting for the drain before issuing those aborts would
 * deadlock the transition.
 */
export function closeWorkspaceAuthorizationAdmission(
  userIds: string[],
): WorkspaceAuthorizationFenceController {
  const closed = closeFences(userIds);
  let released = false;
  return {
    waitForMutationDrain: () => closed.drained,
    release: () => {
      if (released) return;
      released = true;
      for (const state of closed.selected) state.fenced = false;
      for (const stateKey of closed.stateKeys) {
        const state = states.get(stateKey);
        if (state && state.active.size === 0) states.delete(stateKey);
      }
    },
  };
}

/**
 * Close admission across the entire shared Files/Projects topology.
 *
 * Every actor-scoped admission is also registered against the global key, so
 * this fence covers both existing actors and accounts created while a durable
 * authorization transition is recovering. It is intentionally separate from
 * the convenience wrapper below: transition orchestration must quiesce
 * provider work before waiting for old mutation leases to drain.
 */
export function closeGlobalWorkspaceAuthorizationAdmission(
): WorkspaceAuthorizationFenceController {
  return closeWorkspaceAuthorizationAdmission([GLOBAL_WORKSPACE_AUTHORIZATION_KEY]);
}

/**
 * Close global admission and then remove one exact, already-admitted mutation
 * from the drain set in the same synchronous JavaScript turn.
 *
 * Dependency installation is itself a `/api/projects` mutation. Once it has
 * finished all expensive work in a private staging directory, it becomes the
 * coordinator for a global promotion fence and must not wait for its own HTTP
 * admission forever. Closing first is essential: settling first would leave an
 * admission gap in which another root-capable writer could start. The caller
 * must detach its own global-fence subscription before invoking this helper.
 */
export function closeGlobalWorkspaceAuthorizationAdmissionExcludingRequest(
  req: Request,
): WorkspaceAuthorizationFenceController {
  const admission = requestAdmissions.get(req);
  if (
    !admission
    || admission.released
    || admission.kind !== 'mutation'
    || !admission.stateKeys.includes(GLOBAL_WORKSPACE_AUTHORIZATION_KEY)
  ) {
    throw new AppError(
      500,
      'The promotion coordinator does not own an active workspace mutation admission.',
    );
  }
  const controller = closeGlobalWorkspaceAuthorizationAdmission();
  releaseAdmission(admission);
  return controller;
}

export async function withWorkspaceAuthorizationFences<T>(
  userIds: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const fence = closeWorkspaceAuthorizationAdmission(userIds);
  try {
    // Keep the fence closed while old-generation mutations drain. New
    // admissions are rejected, so a busy client cannot starve a disable,
    // sandbox, role, or ownership change by continuously starting more work.
    await fence.waitForMutationDrain();
    return await operation();
  } finally {
    fence.release();
  }
}

export function withWorkspaceAuthorizationFence<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorkspaceAuthorizationFences([userId], async () => {
    const releaseGlobal = acquireGlobalWorkspaceAuthorizationMutationLease();
    try {
      return await operation();
    } finally {
      releaseGlobal();
    }
  });
}

export function withGlobalWorkspaceAuthorizationFence<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return withWorkspaceAuthorizationFences([GLOBAL_WORKSPACE_AUTHORIZATION_KEY], operation);
}

export function workspaceAuthorizationBarrierSnapshot(userId: string): {
  fenced: boolean;
  reads: number;
  mutations: number;
} {
  const state = states.get(userId);
  const active = [...(state?.active || [])];
  return {
    fenced: Boolean(state?.fenced),
    reads: active.filter((request) => request.kind === 'read').length,
    mutations: active.filter((request) => request.kind === 'mutation').length,
  };
}
