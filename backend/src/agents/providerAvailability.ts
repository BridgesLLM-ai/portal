import { execFileSync } from 'child_process';
import { getProviderStatuses } from '../services/openclawConfigManager';
import type { AgentProviderName } from './AgentProvider.interface';
import {
  getLinkedOpenClawProviderIds,
  getNativeCliAuthStatus,
  nativeCliAuthBlocksUsage,
  type NativeCliAuthState,
} from './nativeCliAuth';

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
  nativeAuthStatus?: NativeCliAuthState;
  nativeAuthMessage?: string;
  nativeAuthLoginCommand?: string;
  requiresSeparateNativeLogin?: boolean;
  linkedOpenClawProviders?: Array<{
    id: string;
    configured: boolean;
    status: string;
  }>;
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
      modelCatalogKind: 'declared',
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
      modelCatalogKind: 'declared',
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

/* ─── Availability cache (avoids blocking execFileSync on every request) ─── */
const _availabilityCache = new Map<AgentProviderName, { data: ProviderAvailability; expiresAt: number }>();
const AVAILABILITY_CACHE_TTL_MS = 30_000; // 30 seconds

let _bgPopulationInFlight = false;

export function getProviderAvailability(name: AgentProviderName): ProviderAvailability {
  const now = Date.now();
  const cached = _availabilityCache.get(name);
  if (cached && cached.expiresAt > now) return cached.data;

  // If cache is cold, trigger background population and return lightweight fallback.
  // This avoids blocking the event loop with execFileSync during request handling.
  if (!_bgPopulationInFlight) {
    _bgPopulationInFlight = true;
    // Use child_process.fork or setImmediate chain to populate in background
    _populateCacheInBackground();
  }

  // Return stale data if available (expired but still usable)
  if (cached) return cached.data;

  // No data at all — return minimal fallback from DEFINITIONS
  const def = DEFINITIONS[name];
  return {
    name,
    installed: false,
    implemented: def.implemented,
    usable: false,
    native: def.native,
    command: undefined,
    version: undefined,
    reason: 'Provider availability is loading...',
    nativeAuthStatus: 'unknown',
    nativeAuthMessage: 'Loading...',
    requiresSeparateNativeLogin: false,
    capabilities: def.capabilities,
  };
}

function _populateCacheInBackground(): void {
  // Use async child_process.exec to resolve all providers in parallel.
  // Each provider's command resolution runs in a separate child process,
  // so the main event loop is never blocked.
  const { exec: execAsync } = require('child_process');
  const names = Object.keys(DEFINITIONS) as AgentProviderName[];
  let completed = 0;

  for (const name of names) {
    const def = DEFINITIONS[name];
    const candidates = def.commands || [];
    const versionArgs = (def.versionArgs || []).join(' ');

    // Build a shell one-liner that finds the command and gets its version
    const findCmd = candidates.map((cmd: string) =>
      `command -v ${cmd} >/dev/null 2>&1 && echo "CMD:${cmd}" && ${cmd} ${versionArgs} 2>/dev/null | head -1`
    ).join(' || ');
    const script = findCmd || 'echo NONE';

    execAsync(
      `bash -lc ${JSON.stringify(script)}`,
      { timeout: 10000, encoding: 'utf8' as const },
      (_err: any, stdout: string) => {
        try {
          const output = String(stdout || '');
          const cmdMatch = output.match(/CMD:(\S+)/);
          const command = cmdMatch ? cmdMatch[1] : undefined;
          const installed = Boolean(command);
          // Version is the line after CMD:
          const versionLine = output.split('\n').find((l: string) => l.trim() && !l.startsWith('CMD:'));
          const version = versionLine?.trim() || undefined;

          // Build availability without any sync exec calls
          const linkedProviderStatuses = def.native
            ? getProviderStatuses()
                .filter((status) => getLinkedOpenClawProviderIds(name).includes(status.id))
                .map((status) => ({
                  id: status.id,
                  configured: status.status === 'configured' || status.status === 'cooldown' || status.status === 'error' || status.status === 'expired',
                  status: status.status,
                }))
            : [];
          const nativeAuth = def.native ? getNativeCliAuthStatus(name) : null;

          let result: ProviderAvailability;
          if (!def.implemented) {
            result = {
              name, installed, implemented: false, usable: false, native: def.native, command, version,
              reason: 'Provider adapter is not implemented yet',
              nativeAuthStatus: nativeAuth?.status || 'unknown',
              nativeAuthMessage: nativeAuth?.message || `${name} auth could not be determined.`,
              nativeAuthLoginCommand: nativeAuth?.loginCommand,
              requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin || false,
              capabilities: def.capabilities,
            };
          } else if (!installed) {
            result = {
              name, installed: false, implemented: true, usable: false, native: def.native,
              reason: `${name} CLI not found`,
              nativeAuthStatus: nativeAuth?.status || 'unknown',
              nativeAuthMessage: nativeAuth?.message || 'CLI not installed.',
              nativeAuthLoginCommand: nativeAuth?.loginCommand,
              requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin || false,
              capabilities: def.capabilities,
            };
          } else {
            const authBlocked = def.native && nativeCliAuthBlocksUsage(nativeAuth);
            const hasLinkedProvider = linkedProviderStatuses.some(s => s.configured);
            const gatewayConfigured = Boolean(process.env.OPENCLAW_API_URL && process.env.OPENCLAW_GATEWAY_TOKEN);
            const usable = def.capabilities.requiresGateway
              ? (installed && gatewayConfigured)
              : (installed && !authBlocked);
            result = {
              name, installed, implemented: true, usable, native: def.native, command, version,
              reason: usable ? undefined : (authBlocked ? 'Authentication required' : 'Not configured'),
              nativeAuthStatus: nativeAuth?.status || 'unknown',
              nativeAuthMessage: nativeAuth?.message || '',
              nativeAuthLoginCommand: nativeAuth?.loginCommand,
              requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin || false,
              capabilities: def.capabilities,
            };
          }

          _availabilityCache.set(name, { data: result, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
        } catch {}

        completed++;
        if (completed >= names.length) _bgPopulationInFlight = false;
      }
    );
  }
}


/** Invalidate the availability cache (e.g. after permission toggle or config change) */
export function invalidateProviderAvailabilityCache(name?: AgentProviderName): void {
  if (name) {
    _availabilityCache.delete(name);
  } else {
    _availabilityCache.clear();
  }
}

function _getProviderAvailabilityUncached(name: AgentProviderName): ProviderAvailability {
  const def = DEFINITIONS[name];
  const command = resolveCommand(def.commands);
  const installed = Boolean(command);
  const version = command ? detectVersion(command, def.versionArgs) : undefined;
  const linkedProviderStatuses = def.native
    ? getProviderStatuses()
        .filter((status) => getLinkedOpenClawProviderIds(name).includes(status.id))
        .map((status) => ({
          id: status.id,
          configured: status.status === 'configured' || status.status === 'cooldown' || status.status === 'error' || status.status === 'expired',
          status: status.status,
        }))
    : [];
  const nativeAuth = def.native ? getNativeCliAuthStatus(name) : null;

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
      nativeAuthStatus: nativeAuth?.status,
      nativeAuthMessage: nativeAuth?.message,
      nativeAuthLoginCommand: nativeAuth?.loginCommand,
      requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin,
      linkedOpenClawProviders: linkedProviderStatuses,
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
      nativeAuthStatus: nativeAuth?.status,
      nativeAuthMessage: nativeAuth?.message,
      nativeAuthLoginCommand: nativeAuth?.loginCommand,
      requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin,
      linkedOpenClawProviders: linkedProviderStatuses,
      capabilities: def.capabilities,
    };
  }

  const linkedConfigured = linkedProviderStatuses.filter((entry) => entry.configured).map((entry) => entry.id);
  const reason = nativeCliAuthBlocksUsage(nativeAuth)
    ? linkedConfigured.length
      ? `${nativeAuth?.message} OpenClaw is configured for ${linkedConfigured.join(', ')}, but those credentials are not copied into this CLI.`
      : nativeAuth?.message
    : def.capabilities.requiresGateway
      ? 'Uses OpenClaw gateway transport'
      : (nativeAuth?.message || 'Runs natively via local provider CLI');

  return {
    name,
    installed: true,
    implemented: true,
    usable: def.capabilities.requiresGateway
      ? Boolean(process.env.OPENCLAW_API_URL && process.env.OPENCLAW_GATEWAY_TOKEN)
      : !nativeCliAuthBlocksUsage(nativeAuth),
    native: def.native,
    command,
    version,
    reason,
    nativeAuthStatus: nativeAuth?.status,
    nativeAuthMessage: nativeAuth?.message,
    nativeAuthLoginCommand: nativeAuth?.loginCommand,
    requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin,
    linkedOpenClawProviders: linkedProviderStatuses,
    capabilities: def.capabilities,
  };
}

export function isProviderAvailable(name: AgentProviderName): boolean {
  return getProviderAvailability(name).usable;
}
