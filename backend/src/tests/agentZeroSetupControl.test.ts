import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  AGENT_ZERO_CREDENTIAL_CONFIRMATION,
  AGENT_ZERO_RUNTIME_CONFIRMATION,
  buildAgentZeroSetupStatus,
  runAgentZeroLifecycle,
  runAgentZeroProjectModelBridgeLifecycle,
  serializeProtectedAgentZeroCredentials,
  writeProtectedAgentZeroCredentials,
} from '../agents/providers/agentZero/AgentZeroSetupControl';
import { readProtectedAgentZeroCredentials } from '../agents/providers/agentZero/AgentZeroAuthSession';
import type { AgentZeroHostGatewayStatus } from '../agents/providers/agentZero/AgentZeroHostGateway';
import type { AgentZeroRuntimeStatus } from '../agents/providers/agentZero/AgentZeroRuntime';

function runtimeReady(overrides: Partial<AgentZeroRuntimeStatus> = {}): AgentZeroRuntimeStatus {
  return {
    installed: true,
    running: true,
    ready: true,
    version: '2.5',
    expectedVersion: '2.5',
    pinnedImage: true,
    loopbackOnly: true,
    persistentData: true,
    protectedAuth: true,
    restartPolicy: true,
    protocolCompatible: true,
    reason: 'runtime ready',
    ...overrides,
  };
}

function hostBridgeInstalled(overrides: Partial<AgentZeroHostGatewayStatus> = {}): AgentZeroHostGatewayStatus {
  return {
    state: 'stopped',
    installed: true,
    running: false,
    ready: false,
    cliVersion: '2.5',
    expectedCliVersion: '2.5',
    gatewayId: 'bridgesllm-portal-host',
    capabilities: {
      scope: 'HOST_OPERATOR',
      fileRead: true,
      fileWrite: true,
      codeExecution: true,
      browser: false,
      computerUse: false,
    },
    reason: 'installed; starts on authorized use',
    ...overrides,
  };
}

describe('Agent Zero owner setup control plane', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('reports full-host and project readiness as separate fail-closed contracts', () => {
    const value = buildAgentZeroSetupStatus({
      runtime: runtimeReady(),
      authentication: {
        state: 'authenticated',
        authenticated: true,
        checkedAt: '2026-07-18T00:00:00.000Z',
        reason: 'authenticated',
      },
      hostGateway: hostBridgeInstalled(),
      credentials: { configured: true, protected: true, reason: 'configured' },
      now: new Date('2026-07-18T00:00:00.000Z'),
    });

    expect(value).toMatchObject({
      testedVersions: { agentZero: '2.5', connector: '0.1.0', hostBridge: '2.5' },
      mainAgentChat: {
        scope: 'HOST_OPERATOR',
        available: true,
        contractReady: true,
        providerEnabled: true,
      },
      projectSandbox: {
        scope: 'PROJECT_SANDBOX',
        available: false,
        contractReady: false,
        providerEnabled: false,
      },
      provider: { implemented: true, usable: true, supportedExecutionScopes: ['HOST_OPERATOR'] },
      actions: {
        provisionCredentials: { confirmationPhrase: AGENT_ZERO_CREDENTIAL_CONFIRMATION },
        reconcileRuntime: { confirmationPhrase: AGENT_ZERO_RUNTIME_CONFIRMATION },
      },
    });
    // The duplicate derived-status row is gone. The owner sees only steps
    // they can act on.
    expect(value.mainAgentChat.steps.map((step) => step.code)).toEqual([
      'protected_credentials',
      'managed_runtime',
      'connector_protocol',
      'connector_authentication',
      'host_operator_bridge',
    ]);
    expect(JSON.stringify(value.mainAgentChat)).not.toMatch(/release validation|internal gate/i);
    expect(value.projectSandbox.steps.map((step) => step.code))
      .toEqual(['project_sandbox_adapter', 'project_escape_validation']);
    expect(value.projectSandbox.steps.find((step) => step.code === 'project_sandbox_adapter'))
      .toMatchObject({ complete: true });
    expect(value.projectSandbox.steps.find((step) => step.code === 'project_escape_validation'))
      .toMatchObject({ complete: false });
    expect(JSON.stringify(value)).not.toMatch(/username|password|cookie/i);
  });

  test('atomically writes root-only credentials, supports quotes, and restores the prior file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-zero-setup-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'protected', 'agent-zero.env');
    const firstPassword = "correct'horse\\battery";
    const first = writeProtectedAgentZeroCredentials('portal-owner', firstPassword, { authFilePath: target });

    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(readProtectedAgentZeroCredentials(target)).toEqual({
      username: 'portal-owner',
      password: firstPassword,
    });

    const second = writeProtectedAgentZeroCredentials('replacement', 'a-different-secure-password', {
      authFilePath: target,
    });
    expect(readProtectedAgentZeroCredentials(target).username).toBe('replacement');
    second.restore();
    expect(readProtectedAgentZeroCredentials(target)).toEqual({
      username: 'portal-owner',
      password: firstPassword,
    });
    first.restore();
    expect(() => lstatSync(target)).toThrow();
  });

  test('refuses unsafe credential values and an existing symlink target', () => {
    expect(() => serializeProtectedAgentZeroCredentials('owner\nother', 'correct-horse-battery-staple'))
      .toThrow(/username/i);
    expect(() => serializeProtectedAgentZeroCredentials('owner', 'short'))
      .toThrow(/password/i);
    expect(() => writeProtectedAgentZeroCredentials('owner', 'correct-horse-battery-staple', {
      authFilePath: '/etc/passwd',
    })).toThrow(/dedicated private directory/i);

    const root = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-zero-symlink-'));
    temporaryRoots.push(root);
    const protectedDirectory = path.join(root, 'protected');
    const realFile = path.join(root, 'real.env');
    const target = path.join(protectedDirectory, 'agent-zero.env');
    writeProtectedAgentZeroCredentials('owner', 'correct-horse-battery-staple', {
      authFilePath: realFile,
    });
    // Reuse the safely-created private parent, then place an attacker-controlled target.
    writeProtectedAgentZeroCredentials('owner', 'correct-horse-battery-staple', {
      authFilePath: path.join(protectedDirectory, 'seed.env'),
    });
    symlinkSync(realFile, target);
    expect(() => writeProtectedAgentZeroCredentials('owner', 'replacement-secure-password', {
      authFilePath: target,
    })).toThrow(/root-protected/i);
    expect(readFileSync(realFile, 'utf8')).toContain('AUTH_LOGIN');
  });

  test('invokes only the fixed lifecycle script and supported control commands', async () => {
    const calls: Array<{ scriptPath: string; command: string }> = [];
    await runAgentZeroLifecycle('credentials-reload', {
      portalRoot: path.resolve(process.cwd(), '..'),
      run: async (scriptPath, command) => { calls.push({ scriptPath, command }); },
    });
    await runAgentZeroLifecycle('reconcile', {
      portalRoot: path.resolve(process.cwd(), '..'),
      run: async (scriptPath, command) => { calls.push({ scriptPath, command }); },
    });
    await runAgentZeroProjectModelBridgeLifecycle({
      portalRoot: path.resolve(process.cwd(), '..'),
      run: async (scriptPath, command) => { calls.push({ scriptPath, command }); },
    });
    expect(calls).toEqual([
      { scriptPath: path.resolve(process.cwd(), '../installer/agent-zero-runtime.sh'), command: 'credentials-reload' },
      { scriptPath: path.resolve(process.cwd(), '../installer/agent-zero-runtime.sh'), command: 'reconcile' },
      {
        scriptPath: path.resolve(
          process.cwd(),
          '../installer/agent-zero-project-model-bridge.sh',
        ),
        command: 'reconcile',
      },
    ]);
  });
});
