export const PORTAL_AUTHORIZATION_VERSION_HEADER = 'X-Portal-Authorization-Version';
export const WORKSPACE_AUTHORIZATION_CHANGED_EVENT = 'portal:workspace-authorization-changed';

export interface WorkspaceAuthorizationChangeDetail {
  userId: string;
  authorizationVersion: number;
  source: 'socket' | 'response';
}

let observedUserId = '';
let observedAuthorizationVersion = 0;
let observedAuthorizationAbortController = new AbortController();

function normalizedVersion(value: unknown): number | null {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return version;
}

export function setWorkspaceAuthorizationBaseline(userId: string, value: unknown): number {
  const version = normalizedVersion(value) ?? 1;
  if (observedUserId !== userId) {
    observedAuthorizationAbortController.abort();
    observedUserId = userId;
    observedAuthorizationVersion = version;
    observedAuthorizationAbortController = new AbortController();
    return version;
  }
  if (version > observedAuthorizationVersion) {
    observedAuthorizationAbortController.abort();
    observedAuthorizationVersion = version;
    observedAuthorizationAbortController = new AbortController();
  }
  return observedAuthorizationVersion;
}

export function observedWorkspaceAuthorizationVersion(userId: string): number {
  return observedUserId === userId ? observedAuthorizationVersion : 0;
}

export function announceWorkspaceAuthorizationVersion(
  userId: string,
  value: unknown,
  source: WorkspaceAuthorizationChangeDetail['source'],
): boolean {
  const version = normalizedVersion(value);
  if (!userId || version === null) return false;
  const current = observedWorkspaceAuthorizationVersion(userId);
  if (current > 0 && version <= current) return false;
  observedAuthorizationAbortController.abort();
  observedUserId = userId;
  observedAuthorizationVersion = version;
  observedAuthorizationAbortController = new AbortController();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<WorkspaceAuthorizationChangeDetail>(
      WORKSPACE_AUTHORIZATION_CHANGED_EVENT,
      { detail: { userId, authorizationVersion: version, source } },
    ));
  }
  return true;
}

/**
 * Signal shared by every workspace request admitted under one authorization
 * generation. Advancing the generation aborts reads, uploads, and response
 * streams before stale client state can consume another byte.
 */
export function workspaceAuthorizationAbortSignal(userId: string, value: unknown): AbortSignal {
  const version = normalizedVersion(value);
  if (!userId || version === null) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const current = setWorkspaceAuthorizationBaseline(userId, version);
  if (current !== version) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  return observedAuthorizationAbortController.signal;
}

export class StaleWorkspaceAuthorizationResponseError extends Error {
  readonly code = 'WORKSPACE_SCOPE_CHANGED';

  constructor() {
    super('The response belongs to an older workspace authorization generation.');
    this.name = 'StaleWorkspaceAuthorizationResponseError';
  }
}

export function assertWorkspaceAuthorizationResponseIsCurrent(
  userId: string,
  value: unknown,
): void {
  const version = normalizedVersion(value);
  if (version === null) return;
  const current = observedWorkspaceAuthorizationVersion(userId);
  if (current > 0 && version < current) {
    throw new StaleWorkspaceAuthorizationResponseError();
  }
  if (version > current) {
    announceWorkspaceAuthorizationVersion(userId, version, 'response');
  }
}

export function resetWorkspaceAuthorizationForTests(): void {
  observedAuthorizationAbortController.abort();
  observedUserId = '';
  observedAuthorizationVersion = 0;
  observedAuthorizationAbortController = new AbortController();
}
