import {
  assertOpenClawHostMutationAvailable,
  HOST_CREDENTIAL_FLOW_UNAVAILABLE,
  NativeHostCredentialFlowUnavailableError,
  OPENCLAW_HOST_MUTATION_UNAVAILABLE,
  OpenClawHostMutationUnavailableError,
} from './hostRuntimeMaintenancePolicy';

describe('host runtime maintenance policy', () => {
  test.each(['codex', 'claude-code'] as const)(
    'keeps interactive %s credential processes unavailable without claiming Agent Chat is disabled',
    (toolId) => {
      const error = new NativeHostCredentialFlowUnavailableError(toolId);
      expect(error).toMatchObject({
        toolId,
        statusCode: 503,
        code: 'HOST_CREDENTIAL_FLOW_UNAVAILABLE',
        retryable: false,
      });
      expect(error.message).toContain(HOST_CREDENTIAL_FLOW_UNAVAILABLE.error);
      expect(error.message).not.toMatch(/Agent Chat.*unavailable/i);
    },
  );

  test.each([
    'restart',
    'compatibility-hotfix',
    'configuration',
    'oauth-device',
    'approval',
    'package-extension',
  ] as const)('rejects OpenClaw %s mutation with one operation-specific policy', (operation) => {
    expect(() => assertOpenClawHostMutationAvailable(operation)).toThrow(
      expect.objectContaining({
        name: 'OpenClawHostMutationUnavailableError',
        operation,
        statusCode: 503,
        code: 'OPENCLAW_HOST_MUTATION_UNAVAILABLE',
        retryable: false,
      }),
    );
  });

  test('states the read-only and conversational operations that remain available', () => {
    expect(OPENCLAW_HOST_MUTATION_UNAVAILABLE.remediation).toMatch(
      /Chat, abort, steering, reconnect, history, and read-only discovery remain available/,
    );
    expect(new OpenClawHostMutationUnavailableError('configuration').message)
      .toContain(OPENCLAW_HOST_MUTATION_UNAVAILABLE.error);
    expect(OPENCLAW_HOST_MUTATION_UNAVAILABLE.remediation).toMatch(
      /mutations remain unavailable until a separately supported maintenance operation ships/,
    );
    expect(OPENCLAW_HOST_MUTATION_UNAVAILABLE.remediation).not.toMatch(
      /perform .* through explicit Host Tools Maintenance/i,
    );
  });
});
