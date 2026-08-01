import type { AgentZeroSetupStatus } from '../../api/agentRuntime';

export type AgentZeroNextAction = 'credentials' | 'reconcile' | 'verify' | 'unavailable' | 'ready';

export function nextAgentZeroSetupAction(status: AgentZeroSetupStatus): AgentZeroNextAction {
  if (!status.credentials.configured) return 'credentials';
  if (!status.runtime.protocolReady || !status.hostGateway.installed) return 'reconcile';
  if (!status.authentication.authenticated) return 'verify';
  return status.mainAgentChat.providerEnabled ? 'ready' : 'unavailable';
}

export function completedAgentZeroSetupSteps(status: AgentZeroSetupStatus): {
  complete: number;
  total: number;
} {
  const steps = status.mainAgentChat.steps;
  return {
    complete: steps.filter((step) => step.complete).length,
    total: steps.length,
  };
}

export function agentZeroSurfaceLabel(status: AgentZeroSetupStatus): string {
  if (status.mainAgentChat.providerEnabled) return 'Host Agent Chat ready';
  if (status.mainAgentChat.contractReady) return 'Local components ready · provider unavailable';
  return 'Setup incomplete · provider disabled';
}
