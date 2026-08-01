import { execFile, execFileSync } from 'child_process';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { getProviderStatuses } from '../services/openclawConfigManager';
import type { AgentExecutionScope, AgentProviderName } from './AgentProvider.interface';
import {
  getLinkedOpenClawProviderIds,
  getNativeCliAuthStatus,
  nativeCliAuthBlocksUsage,
  type NativeCliAuthStatus,
  type NativeCliAuthState,
} from './nativeCliAuth';
import {
  getNativeProviderReadiness,
  type NativeProviderReadiness,
} from './nativeProviderReadiness';
import {
  AGENT_ZERO_VERSION,
  probeAgentZeroRuntime,
  probeAgentZeroRuntimeAsync,
} from './providers/agentZero/AgentZeroRuntime';
import {
  getAgentZeroAuthReadinessSnapshot,
  refreshAgentZeroAuthReadiness,
  type AgentZeroAuthReadiness,
} from './providers/agentZero/AgentZeroAuthSession';
import {
  AgentZeroOAuthModelCatalogError,
  loadSelectableAgentZeroOAuthModels,
} from './providers/agentZero/AgentZeroOAuthModelCatalog';
import { localOllamaCliEnvironment } from '../services/ollamaPullManager';

export type ProviderModelSelectionMode = 'none' | 'session' | 'launch';
export type ProviderModelCatalogKind = 'none' | 'dynamic' | 'declared';
export type ProviderFollowUpMode = 'interrupt_and_send' | 'queued_follow_up';
export type ProviderAdapterFamily = 'openclaw-gateway' | 'native-cli' | 'agent-zero-connector';

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
  /** Trust zones this adapter can enforce. Missing support is fail-closed. */
  supportedExecutionScopes: readonly AgentExecutionScope[];
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
  // Present when the installed CLI no longer matches the Portal-tested pin.
  // Soft-pinned providers stay usable but must never silently claim the
  // tested version.
  versionDrift?: { tested: string; installed: string };
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
  // Hard pin: availability fails closed on any mismatch (strict transport
  // contracts, e.g. the Grok ACP broker).
  exactTestedVersion?: string;
  // Soft pin: the provider stays usable on mismatch, but the drift is
  // reported in the availability payload and reason text. Used for CLIs the
  // vendor can self-update underneath the installer's convergence.
  driftTestedVersion?: string;
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
      supportsExecApproval: false,
      supportsInTurnSteering: true,
      supportsQueuedFollowUps: false,
      followUpMode: 'interrupt_and_send',
      // Project Chat uses its separately materialized Docker agent/binding;
      // the generic OpenClaw provider adapter must not fabricate that scope.
      supportedExecutionScopes: ['HOST_OPERATOR'],
    },
  },
  CLAUDE_CODE: {
    native: true,
    implemented: true,
    commands: ['claude'],
    versionArgs: ['--version'],
    driftTestedVersion: PORTAL_TOOL_VERSIONS.claudeCode,
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'claude-code',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: false,
      canEnumerateModels: true,
      modelCatalogKind: 'declared',
      supportsSessionList: true,
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'],
    },
  },
  CODEX: {
    native: true,
    implemented: true,
    commands: ['codex'],
    versionArgs: ['--version'],
    driftTestedVersion: PORTAL_TOOL_VERSIONS.codexCli,
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'codex',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'declared',
      supportsSessionList: true,
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'],
    },
  },
  GROK: {
    native: true,
    implemented: true,
    commands: ['grok'],
    versionArgs: ['--no-auto-update', '--version'],
    exactTestedVersion: PORTAL_TOOL_VERSIONS.grokBuild,
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'grok-build',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'session',
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
      supportsSessionList: true,
      // The ACP broker preserves unrestricted host-operator execution while
      // forwarding Grok's native permission requests to Portal admins.
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportedExecutionScopes: ['HOST_OPERATOR'],
    },
  },
  AGENT_ZERO: {
    native: false,
    implemented: true,
    commands: [],
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'agent-zero-connector',
      adapterKey: 'agent-zero-v2.5-connector',
      supportsHistory: true,
      supportsModelSelection: true,
      // Main Agent Chat only publishes exact models returned by currently
      // connected official Agent Zero OAuth providers.
      modelSelectionMode: 'session',
      supportsCustomModelInput: false,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      // Host-operator bridge only: the Project sandbox adapter is a separate
      // contract and stays closed until it passes its own qualification.
      supportedExecutionScopes: ['HOST_OPERATOR'],
    },
  },
  GEMINI: {
    native: true,
    implemented: true,
    commands: ['agy'],
    versionArgs: ['--version'],
    driftTestedVersion: PORTAL_TOOL_VERSIONS.antigravity,
    capabilities: {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'antigravity',
      supportsHistory: true,
      supportsModelSelection: true,
      modelSelectionMode: 'launch',
      supportsCustomModelInput: true,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
      supportsSessionList: true,
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'],
    },
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
      followUpMode: 'queued_follow_up',
      supportedExecutionScopes: ['HOST_OPERATOR'],
    },
  },
};

// CLI availability probes are synchronous execs that block the event loop —
// stacked probes (claude/codex/gemini version checks) previously cost multiple
// seconds on every providers/commands request AND stalled unrelated requests
// like dashboard metrics. Binary presence and versions change rarely, so probe
// results are memoized for a few minutes.
const PROBE_CACHE_TTL_MS = 5 * 60_000;
const AGENT_ZERO_CATALOG_AUTH_REFRESH_TIMEOUT_MS = 20_000;
const AGENT_ZERO_TRANSIENT_AUTH_RETRY_TTL_MS = 10_000;
const AGENT_ZERO_TIMED_OUT_ATTEMPT_RETRY_COOLDOWN_MS = 10_000;
const probeCache = new Map<string, { at: number; value: string | null }>();
const pendingProbeCache = new Map<string, Promise<string | null>>();
let probeCacheEpoch = 0;

interface AgentZeroAuthRefreshAttempt {
  promise: Promise<AgentZeroAuthReadiness>;
  underlying: Promise<AgentZeroAuthReadiness>;
  controller: AbortController;
}

let agentZeroCatalogAuthRefreshAttempt: AgentZeroAuthRefreshAttempt | null = null;
let agentZeroAuthRefreshCooldownUntil = 0;
let forceNextAgentZeroAuthRefresh = false;

function providerProbeEnvironment(command: string): NodeJS.ProcessEnv {
  if (command === 'grok') return { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' };
  if (command === 'agy') return { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1' };
  if (command === 'ollama') return localOllamaCliEnvironment();
  return process.env;
}

function tryExec(command: string, args: string[]): string | null {
  const cacheKey = `${command}\u0000${args.join('\u0000')}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.value;
  let value: string | null = null;
  try {
    value = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: providerProbeEnvironment(command),
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 2,
    }).trim();
  } catch {
    value = null;
  }
  probeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function tryExecAsync(command: string, args: string[]): Promise<string | null> {
  const cacheKey = `${command}\u0000${args.join('\u0000')}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const existing = pendingProbeCache.get(cacheKey);
  if (existing) return existing;

  const epoch = probeCacheEpoch;
  const pending = new Promise<string | null>((resolve) => {
    const child = execFile(command, args, {
      encoding: 'utf8',
      env: providerProbeEnvironment(command),
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 2,
    }, (error, stdout) => {
      resolve(error ? null : String(stdout || '').trim());
    });
    child?.stdin?.end();
  }).then((value) => {
    if (epoch === probeCacheEpoch) {
      probeCache.set(cacheKey, { at: Date.now(), value });
    }
    return value;
  }).finally(() => {
    if (pendingProbeCache.get(cacheKey) === pending) pendingProbeCache.delete(cacheKey);
  });
  pendingProbeCache.set(cacheKey, pending);
  return pending;
}

function resolveCommand(candidates: string[]): string | undefined {
  for (const command of candidates) {
    const out = tryExec('bash', ['-lc', `command -v ${command}`]);
    if (out) return command;
  }
  return undefined;
}

async function resolveCommandAsync(candidates: string[]): Promise<string | undefined> {
  for (const command of candidates) {
    const out = await tryExecAsync('bash', ['-lc', `command -v ${command}`]);
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

async function detectVersionAsync(command: string, args?: string[]): Promise<string | undefined> {
  if (!args?.length) return undefined;
  const out = await tryExecAsync(command, args);
  if (!out) return undefined;
  return out.split(/\r?\n/).find(Boolean)?.trim();
}

export function extractCliVersion(output: string | undefined): string {
  return String(output || '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || '';
}

export function cliVersionMatchesExact(output: string | undefined, expected: string): boolean {
  return extractCliVersion(output) === expected;
}

export function nativeAuthBlocksProviderUsage(
  name: AgentProviderName,
  status: ReturnType<typeof getNativeCliAuthStatus> | null | undefined,
): boolean {
  // Grok Build cannot safely probe a subscription over `grok models`: that
  // command exits successfully even with an invalid API key. Antigravity's
  // `agy models` probe can time out without proving either login or logout.
  // Ambiguous auth for either provider must therefore fail closed so the
  // provider catalog never advertises a turn that execution admission rejects.
  return nativeCliAuthBlocksUsage(status)
    || ((name === 'GROK' || name === 'GEMINI') && status?.status !== 'authenticated');
}

export function getProviderCapabilities(name: AgentProviderName): ProviderCapabilitySummary | null {
  return DEFINITIONS[name]?.capabilities || null;
}

function authStatusFromReadiness(readiness: NativeProviderReadiness): NativeCliAuthStatus {
  return {
    provider: readiness.provider,
    status: readiness.usable
      ? 'authenticated'
      : readiness.state === 'needs_login'
        ? 'needs_login'
        : 'unknown',
    message: readiness.message,
    loginCommand: readiness.provider === 'GEMINI' ? 'agy' : undefined,
    requiresSeparateLogin: true,
  };
}

function agentZeroAuthReadinessSnapshot(): AgentZeroAuthReadiness {
  try {
    return getAgentZeroAuthReadinessSnapshot();
  } catch {
    return {
      state: 'unchecked',
      authenticated: false,
      reason: 'Agent Zero protected session authentication has not been checked yet.',
    };
  }
}

function shouldRefreshAgentZeroAuthReadiness(
  readiness: AgentZeroAuthReadiness,
  now = Date.now(),
): boolean {
  if (readiness.state === 'unchecked') return true;
  // `needs_login` and `unconfigured` are durable operator-action states. Only
  // transient runtime/protocol/network failures retry automatically, after a
  // short fail-closed window that prevents provider-list polling from becoming
  // an authentication request storm.
  if (readiness.state !== 'error') return false;
  const checkedAt = Date.parse(String(readiness.checkedAt || ''));
  return !Number.isFinite(checkedAt)
    || now - checkedAt >= AGENT_ZERO_TRANSIENT_AUTH_RETRY_TTL_MS;
}

function refreshAgentZeroAuthReadinessBounded(): Promise<AgentZeroAuthReadiness> {
  const existing = agentZeroCatalogAuthRefreshAttempt;
  if (existing) return existing.promise;
  if (Date.now() < agentZeroAuthRefreshCooldownUntil) {
    return Promise.resolve({
      state: 'error',
      authenticated: false,
      reason: 'Agent Zero protected authentication is cooling down after an interrupted readiness check.',
    });
  }

  const controller = new AbortController();
  const forcedRecovery = forceNextAgentZeroAuthRefresh;
  const underlying = Promise.resolve().then(() => (
    refreshAgentZeroAuthReadiness(forcedRecovery, controller.signal)
  ));
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<AgentZeroAuthReadiness>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      forceNextAgentZeroAuthRefresh = true;
      agentZeroAuthRefreshCooldownUntil = Date.now()
        + AGENT_ZERO_TIMED_OUT_ATTEMPT_RETRY_COOLDOWN_MS;
      controller.abort();
      resolve({
        state: 'error',
        authenticated: false,
        reason: 'Agent Zero protected authentication could not be verified within the provider catalog readiness window.',
      });
    }, AGENT_ZERO_CATALOG_AUTH_REFRESH_TIMEOUT_MS);
    timeout.unref?.();
  });
  const bounded = Promise.race([underlying, deadline])
    .catch(() => {
      const snapshot = agentZeroAuthReadinessSnapshot();
      return snapshot.state === 'unchecked'
        ? {
            state: 'error' as const,
            authenticated: false,
            reason: 'Agent Zero protected authentication could not be verified for the provider catalog.',
          }
        : snapshot;
    })
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  const attempt: AgentZeroAuthRefreshAttempt = {
    promise: bounded,
    underlying,
    controller,
  };
  agentZeroCatalogAuthRefreshAttempt = attempt;
  const settleAttempt = () => {
    if (agentZeroCatalogAuthRefreshAttempt === attempt) agentZeroCatalogAuthRefreshAttempt = null;
  };
  void underlying.then((readiness) => {
    if (!timedOut && !controller.signal.aborted && readiness.authenticated) {
      forceNextAgentZeroAuthRefresh = false;
      agentZeroAuthRefreshCooldownUntil = 0;
    }
    settleAttempt();
  }, settleAttempt);
  return bounded;
}

function buildAgentZeroAvailability(
  authentication: AgentZeroAuthReadiness,
  runtime: ReturnType<typeof probeAgentZeroRuntime>,
): ProviderAvailability {
  const def = DEFINITIONS.AGENT_ZERO;
  const runtimeReason = runtime.reason.replace(/[.\s]+$/, '');
  const runtimeDetail = runtime.installed
    ? runtime.ready
      ? `Managed Agent Zero ${AGENT_ZERO_VERSION} runtime is protocol-ready.`
      : `Managed Agent Zero runtime is installed but not ready: ${runtimeReason}.`
    : `${runtimeReason}.`;
  const authDetail = runtime.ready
    ? ` Protected session: ${authentication.reason}`
    : '';
  // Fail-closed live gate: the adapter is implemented, but it is only
  // usable on a box whose managed runtime is protocol-ready AND whose
  // protected session authentication has actually been verified.
  const agentZeroUsable = runtime.ready && authentication.authenticated;
  return {
    name: 'AGENT_ZERO',
    installed: runtime.installed,
    implemented: true,
    usable: agentZeroUsable,
    native: false,
    command: runtime.installed ? 'docker' : undefined,
    version: runtime.version,
    reason: agentZeroUsable
      ? `${runtimeDetail}${authDetail}`
      : `${runtimeDetail}${authDetail} Provider stays disabled until the managed runtime is ready and protected authentication verifies.`,
    nativeAuthStatus: authentication.authenticated
      ? 'authenticated'
      : ['needs_login', 'unconfigured'].includes(authentication.state)
        ? 'needs_login'
        : 'unknown',
    nativeAuthMessage: authentication.reason,
    requiresSeparateNativeLogin: true,
    capabilities: def.capabilities,
  };
}

function buildDetectedProviderAvailability(
  name: AgentProviderName,
  command: string | undefined,
  version: string | undefined,
  nativeReadiness?: NativeProviderReadiness,
  linkedProviderStatusesOverride?: NonNullable<ProviderAvailability['linkedOpenClawProviders']>,
): ProviderAvailability {
  const def = DEFINITIONS[name];
  const installed = Boolean(command);
  const linkedProviderStatuses = def.native
    ? linkedProviderStatusesOverride
      ?? getProviderStatuses()
          .filter((status) => getLinkedOpenClawProviderIds(name).includes(status.id))
          .map((status) => ({
            id: status.id,
            configured: status.status === 'configured' || status.status === 'cooldown' || status.status === 'error' || status.status === 'expired',
            status: status.status,
          }))
    : [];
  const nativeAuth = def.native
    ? nativeReadiness
      ? authStatusFromReadiness(nativeReadiness)
      : getNativeCliAuthStatus(name)
    : null;

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

  if (def.exactTestedVersion && !cliVersionMatchesExact(version, def.exactTestedVersion)) {
    return {
      name,
      installed: true,
      implemented: true,
      usable: false,
      native: def.native,
      command,
      version,
      reason: `Installed CLI is outside the Portal-tested version (${def.exactTestedVersion}). Reinstall the pinned version before using this provider.`,
      nativeAuthStatus: nativeAuth?.status,
      nativeAuthMessage: nativeAuth?.message,
      nativeAuthLoginCommand: nativeAuth?.loginCommand,
      requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin,
      linkedOpenClawProviders: linkedProviderStatuses,
      capabilities: def.capabilities,
    };
  }

  const linkedConfigured = linkedProviderStatuses.filter((entry) => entry.configured).map((entry) => entry.id);
  const authBlocked = nativeReadiness
    ? !nativeReadiness.usable
    : nativeAuthBlocksProviderUsage(name, nativeAuth);
  const installedVersion = extractCliVersion(version);
  const versionDrift = def.driftTestedVersion && installedVersion
    && installedVersion !== def.driftTestedVersion
    ? { tested: def.driftTestedVersion, installed: installedVersion }
    : undefined;
  const driftNote = versionDrift
    ? ` Installed ${def.commands[0]} ${versionDrift.installed} has drifted from the Portal-tested ${versionDrift.tested}; run the Portal update (or the installer with --maintain-tools) to reconverge.`
    : '';
  const reason = authBlocked
    ? linkedConfigured.length
      ? `${nativeAuth?.message} OpenClaw is configured for ${linkedConfigured.join(', ')}, but those credentials are not copied into this CLI.`
      : (nativeAuth?.message || `${name === 'GEMINI' ? 'Google Antigravity' : 'Grok Build'} authentication could not be verified safely on this server.`)
    : def.capabilities.requiresGateway
      ? 'Uses OpenClaw gateway transport'
      : name === 'GROK'
        ? `${nativeAuth?.message || 'Grok Build is authenticated on this server.'} Uses the pinned Grok Build ${PORTAL_TOOL_VERSIONS.grokBuild} ACP transport with native text, thought, tool, permission, cancellation, and persisted-session events.`
        : (nativeAuth?.message || 'Runs natively via local provider CLI');

  return {
    name,
    installed: true,
    implemented: true,
    usable: !authBlocked,
    native: def.native,
    command,
    version,
    reason: `${reason}${driftNote}`,
    versionDrift,
    nativeAuthStatus: nativeAuth?.status,
    nativeAuthMessage: nativeAuth?.message,
    nativeAuthLoginCommand: nativeAuth?.loginCommand,
    requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin,
    linkedOpenClawProviders: linkedProviderStatuses,
    capabilities: def.capabilities,
  };
}

function buildProviderAvailability(
  name: AgentProviderName,
  nativeReadiness?: NativeProviderReadiness,
): ProviderAvailability {
  const def = DEFINITIONS[name];
  if (name === 'AGENT_ZERO') {
    const runtime = probeAgentZeroRuntime();
    const authentication = agentZeroAuthReadinessSnapshot();
    if (runtime.ready && shouldRefreshAgentZeroAuthReadiness(authentication)) {
      void refreshAgentZeroAuthReadinessBounded().catch(() => undefined);
    }
    return buildAgentZeroAvailability(authentication, runtime);
  }
  const command = resolveCommand(def.commands);
  const version = command ? detectVersion(command, def.versionArgs) : undefined;
  return buildDetectedProviderAvailability(name, command, version, nativeReadiness);
}

async function buildProviderAvailabilityAsync(
  name: Exclude<AgentProviderName, 'AGENT_ZERO'>,
  nativeReadiness?: NativeProviderReadiness,
): Promise<ProviderAvailability> {
  const def = DEFINITIONS[name];
  const command = await resolveCommandAsync(def.commands);
  const version = command ? await detectVersionAsync(command, def.versionArgs) : undefined;
  // Aggregate discovery must not synchronously invoke OpenClaw's auth-store
  // CLI for each native row. Native auth remains authoritative for usability;
  // linked OpenClaw profile hints are populated by their dedicated settings API.
  return buildDetectedProviderAvailability(name, command, version, nativeReadiness, []);
}

export function getProviderAvailability(name: AgentProviderName): ProviderAvailability {
  return buildProviderAvailability(name);
}

/**
 * Resolve exact provider readiness for callers that also require Agent Zero
 * model qualification. Aggregate discovery uses the narrower non-blocking
 * path below and keeps model enumeration on `/models`.
 */
export async function getProviderAvailabilityAsync(name: AgentProviderName): Promise<ProviderAvailability> {
  if (name === 'CLAUDE_CODE' || name === 'CODEX' || name === 'GROK' || name === 'GEMINI') {
    const readiness = await getNativeProviderReadiness(name);
    return buildProviderAvailability(name, readiness);
  }
  if (name === 'AGENT_ZERO') {
    const runtime = probeAgentZeroRuntime();
    let authentication = agentZeroAuthReadinessSnapshot();
    if (runtime.ready && shouldRefreshAgentZeroAuthReadiness(authentication)) {
      authentication = await refreshAgentZeroAuthReadinessBounded();
    }
    const availability = buildAgentZeroAvailability(authentication, runtime);
    if (!availability.usable) return availability;
    try {
      await loadSelectableAgentZeroOAuthModels();
      return availability;
    } catch (error) {
      return {
        ...availability,
        usable: false,
        reason: error instanceof AgentZeroOAuthModelCatalogError
          ? error.message
          : 'Agent Zero is running, but no connected official OAuth provider returned a selectable model. Connect Agent Zero OAuth in AI Settings before starting a chat.',
      };
    }
  }
  const availability = buildProviderAvailability(name);
  return availability;
}

/**
 * Aggregate-catalog readiness is intentionally narrower than model readiness.
 * Each provider is probed independently with non-blocking, bounded subprocesses,
 * and Agent Zero model enumeration remains on the dedicated `/models` path.
 */
export async function getProviderCatalogAvailabilityAsync(
  name: AgentProviderName,
): Promise<ProviderAvailability> {
  if (name === 'AGENT_ZERO') {
    const runtime = await probeAgentZeroRuntimeAsync();
    let authentication = agentZeroAuthReadinessSnapshot();
    if (runtime.ready && shouldRefreshAgentZeroAuthReadiness(authentication)) {
      authentication = await refreshAgentZeroAuthReadinessBounded();
    }
    return buildAgentZeroAvailability(authentication, runtime);
  }
  if (name === 'CLAUDE_CODE' || name === 'CODEX' || name === 'GROK' || name === 'GEMINI') {
    const readiness = await getNativeProviderReadiness(name);
    return buildProviderAvailabilityAsync(name, readiness);
  }
  return buildProviderAvailabilityAsync(name);
}

export function __resetProviderAvailabilityForTests(): void {
  probeCacheEpoch += 1;
  probeCache.clear();
  pendingProbeCache.clear();
  agentZeroCatalogAuthRefreshAttempt?.controller.abort();
  agentZeroCatalogAuthRefreshAttempt = null;
  agentZeroAuthRefreshCooldownUntil = 0;
  forceNextAgentZeroAuthRefresh = false;
}

export function isProviderAvailable(name: AgentProviderName): boolean {
  return getProviderAvailability(name).usable;
}
