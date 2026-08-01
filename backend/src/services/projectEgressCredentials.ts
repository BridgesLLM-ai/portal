import crypto from 'crypto';
import type { AgentProviderName, ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import { config } from '../config/env';
import type { ProjectEgressPlaneConfig } from './projectEgressPlane';

const PROJECT_EGRESS_CREDENTIAL_VERSION = 'portal-project-egress-credential-v1';

export class ProjectEgressCredentialError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectEgressCredentialError';
    this.code = code;
  }
}

function requirePinnedImage(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw new ProjectEgressCredentialError(
      'PROXY_IMAGE_UNAVAILABLE',
      'The installed Project egress proxy image has not been pinned',
    );
  }
  return normalized;
}

function requireSecret(value: string): Buffer {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(normalized)) {
    throw new ProjectEgressCredentialError(
      'TOKEN_SECRET_UNAVAILABLE',
      'The Project egress credential secret is unavailable',
    );
  }
  const decoded = Buffer.from(normalized, 'base64url');
  if (decoded.length < 32) {
    throw new ProjectEgressCredentialError(
      'TOKEN_SECRET_WEAK',
      'The Project egress credential secret is too short',
    );
  }
  return decoded;
}

function assertContext(input: {
  context: ProjectSandboxExecutionContext;
  provider: AgentProviderName;
}): void {
  if (input.context.source !== 'PORTAL_SERVER' || input.context.scope !== 'PROJECT_SANDBOX') {
    throw new ProjectEgressCredentialError(
      'EXECUTION_SCOPE',
      'Project egress credentials require a server-owned Project Sandbox context',
    );
  }
  if (!input.context.userId || !input.context.projectId || !input.provider) {
    throw new ProjectEgressCredentialError('IDENTITY', 'Project egress identity is incomplete');
  }
}

/**
 * Derive a stable, provider-specific proxy credential without persisting a
 * bearer token in project files or the database. Rotation is explicit: a new
 * installer-owned master secret invalidates every prior plane and forces
 * synchronous recreation/attestation before the next turn.
 */
export function deriveProjectEgressProxyToken(input: {
  context: ProjectSandboxExecutionContext;
  provider: AgentProviderName;
  secret?: string;
}): string {
  assertContext(input);
  const secret = requireSecret(input.secret ?? config.projectEgressTokenSecret);
  const identity = JSON.stringify({
    version: PROJECT_EGRESS_CREDENTIAL_VERSION,
    actorUserId: input.context.userId,
    projectIdentityId: input.context.projectId,
    provider: input.provider,
    runtimePolicyVersion: input.context.runtimePolicyVersion,
    egressPolicyVersion: input.context.egressPolicyVersion,
  });
  return crypto.createHmac('sha256', secret).update(identity).digest('base64url');
}

export function buildProjectEgressConfig(input: {
  context: ProjectSandboxExecutionContext;
  provider: AgentProviderName;
  proxyImageId?: string;
  secret?: string;
}): ProjectEgressPlaneConfig {
  assertContext(input);
  return {
    identity: {
      actorId: input.context.userId,
      projectId: input.context.projectId,
      provider: input.provider,
    },
    proxyImage: requirePinnedImage(input.proxyImageId ?? config.projectEgressProxyImageId),
    token: deriveProjectEgressProxyToken({
      context: input.context,
      provider: input.provider,
      secret: input.secret,
    }),
  };
}

export const __projectEgressCredentialTest = {
  PROJECT_EGRESS_CREDENTIAL_VERSION,
};
