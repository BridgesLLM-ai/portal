import type { App } from '@prisma/client';
import net from 'net';
import {
  configuredAppApiTarget,
  configuredAppApiTargetBinding,
} from '../utils/appApiProxyAuth';

export type ProjectRuntimeManagement =
  | 'portal-container'
  | 'external-loopback'
  | 'invalid-external-binding'
  | 'desktop-session'
  | 'static';

export type ProjectRuntimeStatusSource =
  | 'portal-manager'
  | 'persisted-app'
  | 'external-binding'
  | 'deployment-record';

export type ProjectLifecycleAction =
  | 'redeploy'
  | 'undeploy'
  | 'rename-project'
  | 'delete-project';

type RuntimeApp = Pick<App, 'id' | 'deployType'>;

export const PROJECT_EXTERNAL_RUNTIME_ERROR_CODE = 'PROJECT_RUNTIME_EXTERNALLY_MANAGED';
export const PROJECT_INVALID_RUNTIME_BINDING_ERROR_CODE = 'PROJECT_RUNTIME_BINDING_INVALID';
export const PROJECT_EXTERNAL_RUNTIME_LIMITATION =
  'This Project uses an externally managed service. Portal can route its traffic but cannot safely control, rename, or remove that service.';
export const PROJECT_INVALID_RUNTIME_BINDING_LIMITATION =
  'This Project has an invalid server-managed API binding. Portal will not route to it or start another runtime until an operator fixes or removes that binding.';

export function projectRuntimeManagement(
  app: RuntimeApp,
  environment: NodeJS.ProcessEnv = process.env,
): ProjectRuntimeManagement {
  // A configured loopback target is an operator-owned process boundary. It
  // takes precedence for both full-stack Apps and static frontends whose
  // `/api/*` traffic is served by an external service.
  const binding = configuredAppApiTargetBinding(app.id, environment);
  if (binding.status === 'configured') return 'external-loopback';
  if (binding.status === 'invalid') return 'invalid-external-binding';
  if (app.deployType === 'fullstack') return 'portal-container';
  if (app.deployType === 'runtime') return 'desktop-session';
  return 'static';
}

export function projectRuntimeStatusSource(
  app: RuntimeApp,
  environment: NodeJS.ProcessEnv = process.env,
): ProjectRuntimeStatusSource {
  const management = projectRuntimeManagement(app, environment);
  if (management === 'external-loopback') return 'external-binding';
  if (management === 'invalid-external-binding') return 'external-binding';
  if (management === 'static') return 'deployment-record';
  return 'persisted-app';
}

export function projectSupportedLifecycleActions(
  app: RuntimeApp,
  detectedDeployType: 'static' | 'fullstack' | 'runtime',
  identityAllowsDestructiveActions: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): ProjectLifecycleAction[] {
  const management = projectRuntimeManagement(app, environment);
  const actions: ProjectLifecycleAction[] = management === 'external-loopback'
    ? app.deployType === 'static' && detectedDeployType === 'static'
      ? ['redeploy']
      : []
    : management === 'invalid-external-binding'
      ? []
    : ['redeploy', 'undeploy', 'rename-project', 'delete-project'];
  return identityAllowsDestructiveActions
    ? actions
    : actions.filter((action) => action !== 'rename-project' && action !== 'delete-project');
}

export async function probeExternalLoopbackRuntime(
  app: RuntimeApp,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 750,
): Promise<'running' | 'unavailable'> {
  const target = configuredAppApiTarget(app.id, environment);
  if (!target) return 'unavailable';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return 'unavailable';
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = Number(parsed.port);
  if (!port || !Number.isInteger(port)) return 'unavailable';
  const boundedTimeout = Math.max(100, Math.min(timeoutMs, 2_000));

  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (status: 'running' | 'unavailable') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(boundedTimeout);
    socket.once('connect', () => finish('running'));
    socket.once('timeout', () => finish('unavailable'));
    socket.once('error', () => finish('unavailable'));
  });
}

export class ProjectExternalRuntimeLifecycleError extends Error {
  readonly code = PROJECT_EXTERNAL_RUNTIME_ERROR_CODE;
  readonly runtimeManagement = 'external-loopback' as const;
  readonly retryable = false;
  readonly guidance = 'Remove the server-managed external API binding and migrate this App to a Portal-managed deployment before changing or deleting its Project lifecycle.';

  constructor(readonly action: string) {
    super(PROJECT_EXTERNAL_RUNTIME_LIMITATION);
    this.name = 'ProjectExternalRuntimeLifecycleError';
  }
}

export class ProjectInvalidRuntimeBindingError extends Error {
  readonly code = PROJECT_INVALID_RUNTIME_BINDING_ERROR_CODE;
  // Keep the public ownership enum compatible with existing Project clients;
  // bindingStatus carries the more specific fail-closed state.
  readonly runtimeManagement = 'external-loopback' as const;
  readonly bindingStatus = 'invalid' as const;
  readonly retryable = false;
  readonly guidance = 'Ask the Portal operator to correct or remove this App\'s server-managed API target, then refresh the Project.';

  constructor(readonly action: string) {
    super(PROJECT_INVALID_RUNTIME_BINDING_LIMITATION);
    this.name = 'ProjectInvalidRuntimeBindingError';
  }
}

export function assertProjectRuntimeLifecycleMutable(
  app: RuntimeApp | null | undefined,
  action: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!app) return;
  const management = projectRuntimeManagement(app, environment);
  if (management === 'external-loopback') {
    throw new ProjectExternalRuntimeLifecycleError(action);
  }
  if (management === 'invalid-external-binding') {
    throw new ProjectInvalidRuntimeBindingError(action);
  }
}

export function projectExternalRuntimeConflict(error: ProjectExternalRuntimeLifecycleError) {
  return {
    code: error.code,
    error: error.message,
    runtimeManagement: error.runtimeManagement,
    supportedActions: [] as string[],
    action: error.action,
    limitation: error.message,
    detail: error.guidance,
    guidance: error.guidance,
    retryable: error.retryable,
  };
}

export function projectInvalidRuntimeBindingConflict(error: ProjectInvalidRuntimeBindingError) {
  return {
    code: error.code,
    error: error.message,
    runtimeManagement: error.runtimeManagement,
    bindingStatus: error.bindingStatus,
    statusSource: 'external-binding' as const,
    supportedActions: [] as string[],
    action: error.action,
    limitation: error.message,
    detail: error.guidance,
    guidance: error.guidance,
    retryable: error.retryable,
  };
}
