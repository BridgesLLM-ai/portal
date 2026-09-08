import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import {
  isNativeBinaryProvider,
  isUnqualifiedNativeBinaryProvider,
  unqualifiedNativeBinaryReason,
  type UnqualifiedNativeBinaryProvider,
} from '../config/unqualifiedNativeBinaryLane';
import { getProviderStatuses } from '../services/openclawConfigManager';
import type { AgentProviderName } from './AgentProvider.interface';
import {
  REGISTERED_AGENT_HARNESS_IDS,
  requireHarnessDefinition,
  type HarnessCapabilities,
  type HarnessFollowUpMode,
  type LegacyProviderAdapterFamily,
  type HarnessModelCatalogKind,
  type HarnessModelSelectionMode,
} from './harnessCatalog';
import {
  getLinkedOpenClawProviderIds,
  getNativeCliAuthStatus,
  nativeCliAuthBlocksUsage,
  type NativeCliAuthStatus,
  type NativeCliAuthState,
} from './nativeCliAuth';
import {
  getCachedNativeProviderReadiness,
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
import { buildNativeCliEnvironment } from './providers/native/NativeCliEnvironment';
import { buildAcpHarnessEnvironment } from './providers/native/acp/AcpHarnessEnvironment';
import {
  getCachedOpenClawExecutionAdmission,
  getOpenClawExecutionAdmission,
} from '../services/openClawExecutionAdmission';

/** @deprecated Harness-aware code should import these names from harnessCatalog. */
export type ProviderModelSelectionMode = HarnessModelSelectionMode;
/** @deprecated Harness-aware code should import these names from harnessCatalog. */
export type ProviderModelCatalogKind = HarnessModelCatalogKind;
/** @deprecated Harness-aware code should import these names from harnessCatalog. */
export type ProviderFollowUpMode = HarnessFollowUpMode;
/** @deprecated Harness-aware code should import these names from harnessCatalog. */
export type ProviderAdapterFamily = LegacyProviderAdapterFamily;
/** @deprecated Harness-aware code should import HarnessCapabilities. */
export type ProviderCapabilitySummary = HarnessCapabilities;

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
  // Soft pin: the provider stays usable on mismatch, but independently
  // changed package drift is reported in the availability payload and reason.
  driftTestedVersion?: string;
  capabilities: ProviderCapabilitySummary;
}

const DEFINITIONS = Object.freeze(Object.fromEntries(
  REGISTERED_AGENT_HARNESS_IDS.map((name) => {
    const harness = requireHarnessDefinition(name);
    const executable = harness.command.executable;
    const versionPolicy = harness.command.versionPolicy;
    return [name, {
      native: harness.native,
      implemented: harness.implemented,
      commands: executable ? [executable] : [],
      versionArgs: [...harness.command.versionArgs],
      exactTestedVersion: versionPolicy.kind === 'exact-pin'
        ? versionPolicy.testedVersion
        : undefined,
      driftTestedVersion: versionPolicy.kind === 'soft-pin'
        ? versionPolicy.testedVersion
        : undefined,
      capabilities: harness.capabilities,
    } satisfies ProviderProbeDefinition];
  }),
)) as Readonly<Record<AgentProviderName, ProviderProbeDefinition>>;

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

function packageVersionRemediation(name: AgentProviderName): string {
  if (name === 'OPENCLAW' || name === 'CODEX' || name === 'CLAUDE_CODE') {
    return 'Owner can restore the exact Portal-qualified bundle under Admin > Maintenance > Update Compatible AI Tools; do not update this tool independently.';
  }
  return 'Use this runtime\'s dedicated Portal setup or maintenance path; do not update it independently.';
}

function providerProbeEnvironment(command: string): NodeJS.ProcessEnv {
  if (command === 'grok') return buildNativeCliEnvironment('GROK');
  if (command === 'agy') return buildNativeCliEnvironment('GEMINI');
  if (command === 'claude') return buildNativeCliEnvironment('CLAUDE_CODE');
  if (command === 'codex') return buildNativeCliEnvironment('CODEX');
  if (command === 'hermes') return buildAcpHarnessEnvironment('HERMES');
  if (command === 'opencode') return buildAcpHarnessEnvironment('OPENCODE');
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

function detectUnqualifiedNativeBinary(provider: UnqualifiedNativeBinaryProvider): boolean {
  const executable = provider === 'GEMINI' ? 'agy' : 'grok';
  return String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        const candidate = path.join(directory, executable);
        return fs.statSync(candidate).isFile() && Boolean(fs.statSync(candidate).mode & 0o111);
      } catch {
        return false;
      }
    });
}

function buildUnqualifiedNativeBinaryAvailability(
  provider: UnqualifiedNativeBinaryProvider,
): ProviderAvailability {
  const definition = DEFINITIONS[provider];
  return {
    name: provider,
    installed: detectUnqualifiedNativeBinary(provider),
    implemented: false,
    usable: false,
    native: true,
    reason: unqualifiedNativeBinaryReason(provider),
    nativeAuthStatus: 'not_applicable',
    nativeAuthMessage: unqualifiedNativeBinaryReason(provider),
    requiresSeparateNativeLogin: false,
    capabilities: definition.capabilities,
  };
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
    || ((name === 'GROK'
      || name === 'GEMINI'
      || name === 'HERMES'
      || name === 'OPENCODE')
      && status?.status !== 'authenticated');
}

export function getProviderCapabilities(name: AgentProviderName): ProviderCapabilitySummary | null {
  return DEFINITIONS[name]?.capabilities || null;
}

function authStatusFromReadiness(readiness: NativeProviderReadiness): NativeCliAuthStatus {
  const loginCommand = readiness.provider === 'GEMINI'
    ? 'agy'
    : readiness.provider === 'HERMES'
      ? 'hermes model'
      : readiness.provider === 'OPENCODE'
        ? 'opencode auth login'
        : undefined;
  return {
    provider: readiness.provider,
    status: readiness.usable
      ? 'authenticated'
      : readiness.state === 'needs_login'
        ? 'needs_login'
        : 'unknown',
    message: readiness.message,
    loginCommand,
    requiresSeparateLogin: true,
  };
}

function buildAdmittedHostCliAvailability(
  name: 'CODEX' | 'CLAUDE_CODE',
  hostReadiness: NativeProviderReadiness | null,
): ProviderAvailability {
  const def = DEFINITIONS[name];
  const nativeAuth = hostReadiness ? authStatusFromReadiness(hostReadiness) : null;
  const packageInstalled = hostReadiness?.runtimeInstalled === true;
  return {
    name,
    installed: packageInstalled,
    implemented: true,
    // Advisory only. The provider freshly repeats admission immediately before
    // each Host Operator attempt under the generic systemd-scope boundary.
    usable: hostReadiness?.usable === true,
    native: true,
    version: hostReadiness?.runtimeVersion,
    reason: hostReadiness?.message
      || 'Native host CLI admission has not been checked asynchronously.',
    nativeAuthStatus: nativeAuth?.status,
    nativeAuthMessage: nativeAuth?.message,
    nativeAuthLoginCommand: nativeAuth?.loginCommand,
    requiresSeparateNativeLogin: nativeAuth?.requiresSeparateLogin,
    linkedOpenClawProviders: [],
    capabilities: def.capabilities,
  };
}

async function getAdmittedHostProviderAvailability(
  name: 'CODEX' | 'CLAUDE_CODE',
): Promise<ProviderAvailability> {
  const hostReadiness = await getNativeProviderReadiness(name, {
    executionScope: 'HOST_OPERATOR',
  });
  return buildAdmittedHostCliAvailability(name, hostReadiness);
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

  if (name === 'OPENCLAW') {
    const admission = getCachedOpenClawExecutionAdmission();
    return {
      name,
      installed,
      implemented: true,
      usable: installed && admission.ready,
      native: false,
      command,
      version,
      reason: installed
        ? admission.reason
        : 'OpenClaw is not installed on this host.',
      capabilities: def.capabilities,
    };
  }

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
      reason: `Installed CLI is outside the Portal-tested version (${def.exactTestedVersion}). Portal refuses this runtime. ${packageVersionRemediation(name)}`,
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
    ? ` Installed ${def.commands[0]} ${versionDrift.installed} has drifted from the Portal-tested ${versionDrift.tested}; Portal refuses the drifted runtime. ${packageVersionRemediation(name)}`
    : '';
  const reason = authBlocked
    ? linkedConfigured.length
      ? `${nativeAuth?.message} OpenClaw is configured for ${linkedConfigured.join(', ')}, but those credentials are not copied into this CLI.`
      : (nativeAuth?.message || `${name === 'GEMINI' ? 'Google Antigravity' : 'Grok Build'} authentication could not be verified safely on this server.`)
    : def.capabilities.requiresGateway
      ? 'Uses OpenClaw gateway transport'
      : name === 'GROK'
        ? `${nativeAuth?.message || 'Grok Build is authenticated on this server.'} Uses the pinned Grok Build ${PORTAL_TOOL_VERSIONS.grokBuild} ACP transport with native text, thought, tool, permission, cancellation, and persisted-session events.`
        : name === 'HERMES' || name === 'OPENCODE'
          ? `${nativeAuth?.message || `${requireHarnessDefinition(name).displayName} is authenticated on this server.`} Uses the exact-pinned ACP stdio transport with attested identity/version, native text, reasoning, tool, permission, cancellation, dynamic model, and persisted-session events.`
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
  if (isNativeBinaryProvider(name) && isUnqualifiedNativeBinaryProvider(name)) {
    return buildUnqualifiedNativeBinaryAvailability(name);
  }
  if (name === 'CODEX' || name === 'CLAUDE_CODE') {
    return buildAdmittedHostCliAvailability(
      name,
      nativeReadiness || getCachedNativeProviderReadiness(name),
    );
  }
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
  if (isNativeBinaryProvider(name) && isUnqualifiedNativeBinaryProvider(name)) {
    return buildUnqualifiedNativeBinaryAvailability(name);
  }
  if (name === 'CODEX' || name === 'CLAUDE_CODE') {
    return getAdmittedHostProviderAvailability(name);
  }
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
  if (isNativeBinaryProvider(name) && isUnqualifiedNativeBinaryProvider(name)) {
    return buildUnqualifiedNativeBinaryAvailability(name);
  }
  if (name === 'CLAUDE_CODE' || name === 'CODEX') {
    return getAdmittedHostProviderAvailability(name);
  }
  if (name === 'OPENCLAW') {
    await getOpenClawExecutionAdmission();
    return buildProviderAvailability(name);
  }
  if (name === 'HERMES'
    || name === 'OPENCODE'
    || name === 'GROK'
    || name === 'GEMINI') {
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
  if (isNativeBinaryProvider(name) && isUnqualifiedNativeBinaryProvider(name)) {
    return buildUnqualifiedNativeBinaryAvailability(name);
  }
  if (name === 'AGENT_ZERO') {
    const runtime = await probeAgentZeroRuntimeAsync();
    let authentication = agentZeroAuthReadinessSnapshot();
    if (runtime.ready && shouldRefreshAgentZeroAuthReadiness(authentication)) {
      authentication = await refreshAgentZeroAuthReadinessBounded();
    }
    return buildAgentZeroAvailability(authentication, runtime);
  }
  if (name === 'CLAUDE_CODE' || name === 'CODEX') {
    return getAdmittedHostProviderAvailability(name);
  }
  if (name === 'OPENCLAW') {
    await getOpenClawExecutionAdmission();
    return buildProviderAvailability(name);
  }
  if (name === 'HERMES'
    || name === 'OPENCODE'
    || name === 'GROK'
    || name === 'GEMINI') {
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
