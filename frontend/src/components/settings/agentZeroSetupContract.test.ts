import { describe, expect, it } from 'vitest';
import type { AgentZeroSetupStatus } from '../../api/agentRuntime';
import {
  agentZeroSurfaceLabel,
  completedAgentZeroSetupSteps,
  nextAgentZeroSetupAction,
} from './agentZeroSetupContract';

function status(overrides: Partial<AgentZeroSetupStatus> = {}): AgentZeroSetupStatus {
  const base = {
    testedVersions: { agentZero: '2.5', connector: '0.1.0', hostBridge: '2.5' },
    credentials: { configured: false, protected: false, reason: 'missing' },
    runtime: {
      installed: false,
      running: false,
      protocolReady: false,
      expectedVersion: '2.5',
      pinnedImage: false,
      loopbackOnly: false,
      persistentData: false,
      protectedAuth: false,
      restartPolicy: false,
      reason: 'missing',
    },
    authentication: { state: 'unconfigured', authenticated: false, reason: 'missing' },
    hostGateway: {
      state: 'stopped',
      installed: false,
      running: false,
      ready: false,
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
      reason: 'missing',
    },
    mainAgentChat: {
      scope: 'HOST_OPERATOR',
      available: false,
      contractReady: false,
      providerEnabled: false,
      reason: 'not ready',
      steps: [
        { code: 'protected_credentials', label: 'Credentials', complete: false, detail: 'missing' },
        { code: 'host_operator_bridge', label: 'Host bridge', complete: false, detail: 'missing' },
      ],
    },
    projectSandbox: {
      scope: 'PROJECT_SANDBOX',
      available: false,
      contractReady: false,
      providerEnabled: false,
      reason: 'separate adapter unavailable',
      steps: [{ code: 'project_sandbox_adapter', label: 'Adapter', complete: false, detail: 'missing' }],
    },
    actions: {
      provisionCredentials: { ownerOnly: true, confirmationPhrase: 'SAVE AGENT ZERO CREDENTIALS' },
      reconcileRuntime: { ownerOnly: true, confirmationPhrase: 'SET UP AGENT ZERO' },
      verifyAuthentication: { ownerOnly: true, available: false },
    },
    provider: { implemented: false, usable: false, supportedExecutionScopes: [] },
    checkedAt: '2026-07-18T00:00:00.000Z',
  } satisfies AgentZeroSetupStatus;
  return { ...base, ...overrides };
}

describe('Agent Zero setup contract', () => {
  it('routes setup through credentials, runtime reconciliation, auth, then live availability', () => {
    const missing = status();
    expect(nextAgentZeroSetupAction(missing)).toBe('credentials');

    const credentials = status({
      credentials: { configured: true, protected: true, reason: 'ready' },
    });
    expect(nextAgentZeroSetupAction(credentials)).toBe('reconcile');

    const runtime = status({
      credentials: { configured: true, protected: true, reason: 'ready' },
      runtime: { ...missing.runtime, installed: true, protocolReady: true },
      hostGateway: { ...missing.hostGateway, installed: true },
      actions: { ...missing.actions, verifyAuthentication: { ownerOnly: true, available: true } },
    });
    expect(nextAgentZeroSetupAction(runtime)).toBe('verify');

    const authenticated = status({
      ...runtime,
      authentication: { state: 'authenticated', authenticated: true, reason: 'ready' },
      mainAgentChat: { ...runtime.mainAgentChat, contractReady: true },
    });
    expect(nextAgentZeroSetupAction(authenticated)).toBe('unavailable');
    expect(agentZeroSurfaceLabel(authenticated)).toMatch(/provider unavailable/i);

    const ready = status({
      ...authenticated,
      mainAgentChat: { ...authenticated.mainAgentChat, providerEnabled: true },
    });
    expect(nextAgentZeroSetupAction(ready)).toBe('ready');
    expect(agentZeroSurfaceLabel(ready)).toMatch(/Host Agent Chat ready/i);
  });

  it('keeps Project Sandbox separate and unavailable even when host components are ready', () => {
    const value = status({
      mainAgentChat: {
        scope: 'HOST_OPERATOR',
        available: false,
        contractReady: true,
        providerEnabled: false,
        reason: 'provider unavailable',
        steps: [
          { code: 'local', label: 'Local', complete: true, detail: 'ready' },
          { code: 'runtime_admission', label: 'Runtime admission', complete: false, detail: 'pending' },
        ],
      },
    });
    expect(value.projectSandbox).toMatchObject({
      scope: 'PROJECT_SANDBOX',
      available: false,
      contractReady: false,
      providerEnabled: false,
    });
    expect(completedAgentZeroSetupSteps(value)).toEqual({ complete: 1, total: 2 });
  });
});
