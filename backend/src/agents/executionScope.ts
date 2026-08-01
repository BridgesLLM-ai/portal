import path from 'path';
import type {
  AgentExecutionContext,
  AgentExecutionScope,
  HostOperatorExecutionContext,
  ProjectSandboxExecutionContext,
} from './AgentProvider.interface';

function requireNonEmpty(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function createHostOperatorExecutionContext(userId: string): HostOperatorExecutionContext {
  return Object.freeze({
    scope: 'HOST_OPERATOR',
    source: 'PORTAL_SERVER',
    userId: requireNonEmpty(userId, 'Execution context userId'),
  });
}

export function createProjectSandboxExecutionContext(input: {
  userId: string;
  projectId: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  runtimePolicyVersion: string;
  egressPolicyVersion: string;
  runtimeImageDigest: string;
  policyFingerprint: string;
}): ProjectSandboxExecutionContext {
  const canonicalRoot = path.resolve(requireNonEmpty(input.canonicalRoot, 'Project canonicalRoot'));
  return Object.freeze({
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: requireNonEmpty(input.userId, 'Execution context userId'),
    projectId: requireNonEmpty(input.projectId, 'Project id'),
    workspaceOwnerId: requireNonEmpty(input.workspaceOwnerId, 'Workspace owner id'),
    projectName: requireNonEmpty(input.projectName, 'Project name'),
    canonicalRoot,
    rootDevice: requireNonEmpty(input.rootDevice, 'Project root device'),
    rootInode: requireNonEmpty(input.rootInode, 'Project root inode'),
    rootBirthtimeNs: requireNonEmpty(input.rootBirthtimeNs, 'Project root birth time'),
    runtimePolicyVersion: requireNonEmpty(input.runtimePolicyVersion, 'Runtime policy version'),
    egressPolicyVersion: requireNonEmpty(input.egressPolicyVersion, 'Egress policy version'),
    runtimeImageDigest: requireNonEmpty(input.runtimeImageDigest, 'Runtime image digest'),
    policyFingerprint: requireNonEmpty(input.policyFingerprint, 'Sandbox policy fingerprint'),
  });
}

export function assertExecutionContextBinding(
  context: AgentExecutionContext | null | undefined,
  expectedUserId: string,
  expectedScope?: AgentExecutionScope,
): asserts context is AgentExecutionContext {
  if (!context || context.source !== 'PORTAL_SERVER') {
    throw new Error('Agent session has no server-assigned execution context');
  }
  if (context.userId !== expectedUserId) {
    throw new Error('Agent session execution context does not match its owner');
  }
  if (expectedScope && context.scope !== expectedScope) {
    throw new Error(`Agent session execution scope mismatch: expected ${expectedScope}, got ${context.scope}`);
  }
  if (context.scope === 'PROJECT_SANDBOX') {
    if (
      !context.projectId
      || !context.workspaceOwnerId
      || !context.projectName
      || !context.rootDevice
      || !context.rootInode
      || !context.rootBirthtimeNs
      || !context.runtimePolicyVersion
      || !context.egressPolicyVersion
      || !context.runtimeImageDigest
      || !context.policyFingerprint
      || !path.isAbsolute(context.canonicalRoot)
    ) {
      throw new Error('Project sandbox execution context is incomplete');
    }
  } else if (context.scope !== 'HOST_OPERATOR') {
    throw new Error('Unknown agent execution scope');
  }
}

export function assertProviderSupportsExecutionScope(
  providerName: string,
  supportedScopes: readonly AgentExecutionScope[] | null | undefined,
  context: AgentExecutionContext,
): void {
  if (!supportedScopes?.includes(context.scope)) {
    throw new Error(`${providerName} does not support ${context.scope} execution`);
  }
}

export function executionContextsMatch(
  left: AgentExecutionContext,
  right: AgentExecutionContext,
): boolean {
  if (left.scope !== right.scope || left.source !== right.source || left.userId !== right.userId) return false;
  if (left.scope === 'HOST_OPERATOR' && right.scope === 'HOST_OPERATOR') return true;
  if (left.scope === 'PROJECT_SANDBOX' && right.scope === 'PROJECT_SANDBOX') {
    return left.projectId === right.projectId
      && left.workspaceOwnerId === right.workspaceOwnerId
      && left.projectName === right.projectName
      && path.resolve(left.canonicalRoot) === path.resolve(right.canonicalRoot)
      && left.rootDevice === right.rootDevice
      && left.rootInode === right.rootInode
      && left.rootBirthtimeNs === right.rootBirthtimeNs
      && left.runtimePolicyVersion === right.runtimePolicyVersion
      && left.egressPolicyVersion === right.egressPolicyVersion
      && left.runtimeImageDigest === right.runtimeImageDigest
      && left.policyFingerprint === right.policyFingerprint;
  }
  return false;
}
