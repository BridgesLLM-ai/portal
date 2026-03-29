import { execFileSync } from 'child_process';
import type { AgentProviderName } from './AgentProvider.interface';

export type ProviderModelSelectionMode = 'none' | 'session' | 'launch';
export type ProviderModelCatalogKind = 'none' | 'dynamic' | 'declared';
export type ProviderFollowUpMode = 'in_turn_inject' | 'queued_follow_up';
export type ProviderAdapterFamily = 'openclaw-gateway' | 'native-cli';

export interface ProviderCapabilitySummary {
  implemented: boolean;
  requiresGateway: boolean;
  adapterFamily: ProviderAdapterFamily;
  adapterKey: string;
  supportsHistory: boolean;
  supportsModelSelection: boolean;
  modelSelectionMode: ProviderModelSelectionMode;
  supportsCustomModelInput: boolean;
  canEnumerateModels: boolean;
  modelCatalogKind: ProviderModelCatalogKind;
  supportsSessionList: boolean;
  supportsExecApproval: boolean;
  supportsInTurnSteering: boolean;
  supportsQueuedFollowUps: boolean;
  followUpMode: ProviderFollowUpMode;
}

export interface ProviderAvailability {
  name: AgentProviderName;
  installed: boolean;
  implemented: boolean;
  usable: boolean;
  native: boolean;
  command?: string;
  version?: string;
  reason?: string;
  capabilities: ProviderCapabilitySummary;
}

interface ProviderProbeDefinition {
  native: boolean;
  implemented: boolean;
  commands: string[];
  versionArgs?: string[];
  capabilities: ProviderCapabilitySummary;
}

const DEFINITIONS: Record<AgentProviderName, ProviderProbeDefinition> = {
  OPENCLAW: {
    native: false,
    implemented: true,
    commands: ['openclaw'],
    versionArgs: ['--version'],
    capabilities: {
      implemented: true,
      requiresGateway: true,
      adapterFamily: 'openclaw-gateway',
      adapterKey: 'openclaw',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
      supportsSessionList: true,
      supportsExecApproval: true,
      supportsInTurnSteering: true,
      supportsQueuedFollowUps: false,
      followUpMode: 'in_turn_inject',    },
  },
  CLAUDE_CODE: {
    native: true,
    implemented: true,
    commands: ['claude'],
    versionArgs: ['--version'],
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'claude-code',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: true,
      canEnumerateModels: false,
      modelCatalogKind: 'none',
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',    },
  },
  CODEX: {
    native: true,
    implemented: true,
    commands: ['codex'],
    versionArgs: ['--version'],
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'codex',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: true,
      canEnumerateModels: false,
      modelCatalogKind: 'none',
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',    },
  },
  AGENT_ZERO: {
    native: true,
    implemented: false,
    commands: ['agent-zero', 'agent_zero', 'agentzero'],
    versionArgs: ['--version'],
    capabilities: {
      implemented: false,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'agent-zero',
      supportsHistory: false,
      supportsModelSelection: false,
      modelSelectionMode: 'none',
      supportsCustomModelInput: false,
      canEnumerateModels: false,
      modelCatalogKind: 'none',
      supportsSessionList: false,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',    },
  },
  GEMINI: {
    native: true,
    implemented: true,
    commands: ['gemini'],
    versionArgs: ['--version'],
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'gemini',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'launch',
      supportsCustomModelInput: true,
      canEnumerateModels: false,
      modelCatalogKind: 'declared',
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',    },
  },
  OLLAMA: {
    native: true,
    implemented: true,
    commands: ['ollama'],
    versionArgs: ['--version'],
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'ollama',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'launch',
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',    },
  },
};

function tryExec(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 2,
    }).trim();
  } catch {
    return null;
  }
}

function resolveCommand(candidates: string[]): string | undefined {
  for (const command of candidates) {
    const out = tryExec('bash', ['-lc', `command -v ${command}`]);
    if (out) return command;
  }
  return undefined;
}

function detectVersion(command: string, args?: string[]): string | undefined {
  if (!args?.length) return undefined;
  const out = tryExec(command, args);
  if (!out) return undefined;
  return out.split(/\r?\n/).find(Boolean)?.trim();
}

export function getProviderAvailability(name: AgentProviderName): ProviderAvailability {
  const def = DEFINITIONS[name];
  const command = resolveCommand(def.commands);
  const installed = Boolean(command);
  const version = command ? detectVersion(command, def.versionArgs) : undefined;

  if (!def.implemented) {
    return {
      name,
      installed,
      implemented: false,
      usable: false,
      native: def.native,
      command,
      version,
      reason: 'Provider adapter is not implemented yet',
      capabilities: def.capabilities,
    };
  }

  if (!installed) {
    return {
      name,
      installed: false,
      implemented: true,
      usable: false,
      native: def.native,
      reason: `Missing CLI: ${def.commands.join(', ')}`,
      capabilities: def.capabilities,
    };
  }

  return {
    name,
    installed: true,
    implemented: true,
    usable: true,
    native: def.native,
    command,
    version,
    reason: def.capabilities.requiresGateway ? 'Uses OpenClaw gateway transport' : 'Runs natively via local provider CLI',
    capabilities: def.capabilities,
  };
}

export function isProviderAvailable(name: AgentProviderName): boolean {
  return getProviderAvailability(name).usable;
}
