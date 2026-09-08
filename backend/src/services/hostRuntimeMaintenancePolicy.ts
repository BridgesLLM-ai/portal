export type NativeHostCredentialTool = 'codex' | 'claude-code';

export const HOST_CREDENTIAL_FLOW_UNAVAILABLE = Object.freeze({
  status: 503,
  code: 'HOST_CREDENTIAL_FLOW_UNAVAILABLE',
  error: 'This interactive host credential flow is unavailable in this release; a bounded credential-lifecycle maintenance operation has not shipped.',
  retryable: false,
  remediation: 'Use an existing admitted credential, the process-free OAuth flow when offered, or Remote Desktop manual login. Package and credential-process mutations remain unavailable until a separately supported maintenance operation ships.',
} as const);

export class NativeHostCredentialFlowUnavailableError extends Error {
  readonly statusCode = HOST_CREDENTIAL_FLOW_UNAVAILABLE.status;
  readonly code = HOST_CREDENTIAL_FLOW_UNAVAILABLE.code;
  readonly retryable = HOST_CREDENTIAL_FLOW_UNAVAILABLE.retryable;

  constructor(readonly toolId: NativeHostCredentialTool) {
    super(`${HOST_CREDENTIAL_FLOW_UNAVAILABLE.code}: ${HOST_CREDENTIAL_FLOW_UNAVAILABLE.error}`);
    this.name = 'NativeHostCredentialFlowUnavailableError';
  }
}

export const OPENCLAW_HOST_MUTATION_UNAVAILABLE = Object.freeze({
  status: 503,
  code: 'OPENCLAW_HOST_MUTATION_UNAVAILABLE',
  error: 'This OpenClaw host mutation is unavailable in this release; a crash-recoverable maintenance operation has not shipped.',
  retryable: false,
  remediation: 'Chat, abort, steering, reconnect, history, and read-only discovery remain available. Package, configuration, restart, OAuth/device, and approval mutations remain unavailable until a separately supported maintenance operation ships.',
} as const);

export type OpenClawHostMutationOperation =
  | 'restart'
  | 'compatibility-hotfix'
  | 'configuration'
  | 'oauth-device'
  | 'approval'
  | 'package-extension';

export class OpenClawHostMutationUnavailableError extends Error {
  readonly statusCode = OPENCLAW_HOST_MUTATION_UNAVAILABLE.status;
  readonly code = OPENCLAW_HOST_MUTATION_UNAVAILABLE.code;
  readonly retryable = OPENCLAW_HOST_MUTATION_UNAVAILABLE.retryable;

  constructor(readonly operation: OpenClawHostMutationOperation) {
    super(`${OPENCLAW_HOST_MUTATION_UNAVAILABLE.code}: ${OPENCLAW_HOST_MUTATION_UNAVAILABLE.error}`);
    this.name = 'OpenClawHostMutationUnavailableError';
  }
}

export function assertOpenClawHostMutationAvailable(
  operation: OpenClawHostMutationOperation,
): never {
  throw new OpenClawHostMutationUnavailableError(operation);
}
