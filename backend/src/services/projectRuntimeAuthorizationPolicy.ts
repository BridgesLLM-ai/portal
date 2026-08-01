export const PROJECT_RUNTIME_AUTHORIZATION_READY_CODE =
  'PROJECT_RUNTIME_AUTHORIZATION_DURABLE';
export const PROJECT_RUNTIME_AUTHORIZATION_READY_MESSAGE =
  'Authorization-changing operations use a durable restart-recoverable transition that retires every attested Project provider runtime before the authorization generation commits.';

export interface ProjectRuntimeAuthorizationPolicy {
  ready: true;
  code: typeof PROJECT_RUNTIME_AUTHORIZATION_READY_CODE;
  message: typeof PROJECT_RUNTIME_AUTHORIZATION_READY_MESSAGE;
  fixedGenerationProjectExecution: true;
  authorizationScopeChanges: true;
  retryable: false;
}

/**
 * This release capability is compile-time truth, not an operator toggle.
 *
 * The transition journal closes database-backed Project/host admission before
 * provider cleanup, snapshots every immutable ProjectIdentity, proves each
 * provider plane and the OpenClaw Gateway cgroup quiescent, then commits the
 * authorization generation and transition phase in one serializable
 * transaction. PREPARED through COMMITTED phases are restart-recoverable and
 * keep admission closed until COMPLETE.
 */
export const PROJECT_RUNTIME_AUTHORIZATION_POLICY: Readonly<ProjectRuntimeAuthorizationPolicy> =
  Object.freeze({
    ready: true,
    code: PROJECT_RUNTIME_AUTHORIZATION_READY_CODE,
    message: PROJECT_RUNTIME_AUTHORIZATION_READY_MESSAGE,
    fixedGenerationProjectExecution: true,
    authorizationScopeChanges: true,
    retryable: false,
  });
