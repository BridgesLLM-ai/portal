import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { qualifiedOnThisMachine, type ToolPolicyIntegrity } from './toolPolicyIntegrity';

/**
 * Updater v2 read side (DESIGN g.1). The root-side runner
 * (`installer/tools/bridgesllm-toolctl.py`) owns every mutation and writes
 * atomic JSON under the tools state root. This module only reads those files,
 * the release's tool policy and a few cheap package.json versions; it never
 * runs an OpenClaw or tool CLI on the request path.
 *
 * The one write it performs is queuing a run: a private run directory with
 * `request.json` and a `queued` status, which toolctl revalidates.
 */

export const TOOLS_STATUS_SCHEMA = 'bridgesllm.tools.status.v1';
export const TOOLS_POLICY_SCHEMA = 'bridgesllm.tools.policy.v2';
export const TOOLS_REQUEST_SCHEMA = 'bridgesllm.tools.request.v1';
export const TOOLS_RUN_SCHEMA = 'bridgesllm.tools.run.v1';
export const TOOLS_HISTORY_SCHEMA = 'bridgesllm.tools.history.v1';
export const TOOLS_STATUS_CACHE_TTL_MS = 60_000;
/** While a run is active its progress is read from cheap files, so refresh often. */
export const TOOLS_STATUS_ACTIVE_TTL_MS = 3_000;
export const TOOLS_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const OPENCLAW_UPDATE_CONFIRMATION = 'UPDATE OPENCLAW';

const TERMINAL_RUN_STATES = new Set([
  'succeeded', 'succeeded-degraded', 'refused', 'failed', 'rolled-back', 'recovery-required',
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RUN_DIRS_SCANNED = 500;
const MAX_RUNS_READ = 50;
const HISTORY_TAIL_BYTES = 256 * 1024;
const HISTORY_LIMIT = 50;

/** Same ids, order and paths as `legacy_roots()` in bridgesllm-toolctl.py. */
export const LEGACY_ROOT_IDS = [
  'openclaw-migration-v2',
  'openclaw-native-chat-v1',
  'native-cli-bundle-v1',
  'native-cli-bundle-terminal-intent',
  'gateway-authorization-fence',
  'gateway-migration-permit',
  'tested-pair-commit-record',
  'ask-user-transaction',
] as const;

export type ToolsPaths = {
  stateRoot: string;
  installerStateRoot: string;
  gatewayFenceMarker: string;
  gatewayFencePermit: string;
  openclawStateDir: string;
  policyPath: string;
  npmGlobalRoot: string;
  /** Versioned harness runtimes (installer/<tool>-runtime.sh); unset means their launchers are not read. */
  harnessRuntimeRoot?: string;
  /** Where Portal 5.0.x installed OpenCode and Hermes (`<root>/<tool>/<version>/`); unset means it is not read. */
  harnessLegacyRoot?: string;
  harnessBinDir?: string;
  /** Agent Zero is configured only when this file exists (installer/agent-zero-runtime.sh A0_DEFAULT_AUTH_FILE). */
  agentZeroEnvPath?: string;
  /** The root-side runner and its unit template; both must exist before runs are offered. */
  toolctlPath: string;
  toolsUnitPaths: string[];
};

export function defaultToolsPaths(env: NodeJS.ProcessEnv = process.env): ToolsPaths {
  const portalRoot = env.PORTAL_ROOT || '/opt/bridgesllm/portal';
  return {
    stateRoot: env.BRIDGESLLM_TOOLS_STATE_ROOT || '/var/lib/bridgesllm/tools',
    installerStateRoot: env.BRIDGESLLM_INSTALLER_STATE_ROOT || '/var/lib/bridgesllm-installer',
    gatewayFenceMarker: env.BRIDGESLLM_GATEWAY_FENCE_MARKER || '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
    gatewayFencePermit: env.BRIDGESLLM_GATEWAY_FENCE_PERMIT || '/run/bridgesllm/openclaw-gateway-migration-permit.v1',
    openclawStateDir: env.BRIDGESLLM_OPENCLAW_STATE_DIR || '/root/.openclaw',
    policyPath: env.BRIDGESLLM_TOOL_POLICY || path.join(portalRoot, 'installer', 'tools', 'tool-policy.v2.json'),
    npmGlobalRoot: env.BRIDGESLLM_NPM_GLOBAL_ROOT || '/usr/lib/node_modules',
    harnessRuntimeRoot: env.BRIDGESLLM_HARNESS_RUNTIME_ROOT || '/usr/local/lib/bridgesllm-runtimes',
    harnessLegacyRoot: env.BRIDGESLLM_HARNESS_LEGACY_ROOT || '/opt/bridgesllm/tools',
    harnessBinDir: env.BRIDGESLLM_HARNESS_BIN_DIR || '/usr/local/bin',
    agentZeroEnvPath: env.BRIDGESLLM_AGENT_ZERO_ENV || '/etc/bridgesllm/agent-zero.env',
    toolctlPath: env.BRIDGESLLM_TOOLCTL || path.join(portalRoot, 'installer', 'tools', 'bridgesllm-toolctl.py'),
    toolsUnitPaths: env.BRIDGESLLM_TOOLS_UNIT
      ? [env.BRIDGESLLM_TOOLS_UNIT]
      : ['/etc/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system'].map((dir) => path.join(dir, 'bridgesllm-tools@.service')),
  };
}

export type ToolsRunnerState = { installed: boolean; reason: string | null };

function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Hosts installed before updater v2 have neither toolctl nor its unit: they keep
 * the old all-tools maintenance action, and the per-tool cards stay read-only.
 */
export function readToolsRunnerState(paths: ToolsPaths = defaultToolsPaths()): ToolsRunnerState {
  if (!isRegularFile(paths.toolctlPath)) {
    return { installed: false, reason: 'This installation does not include the per-tool AI updater yet.' };
  }
  if (!paths.toolsUnitPaths.some(isRegularFile)) {
    return { installed: false, reason: 'The per-tool AI updater service is not installed on this server.' };
  }
  return { installed: true, reason: null };
}

export function legacyRootPaths(paths: ToolsPaths): Array<{ id: (typeof LEGACY_ROOT_IDS)[number]; path: string }> {
  const installer = paths.installerStateRoot;
  const ocState = paths.openclawStateDir;
  return [
    { id: 'openclaw-migration-v2', path: path.join(installer, 'openclaw-2026.9.1-migration-v2') },
    { id: 'openclaw-native-chat-v1', path: path.join(installer, 'openclaw-native-chat-v1') },
    { id: 'native-cli-bundle-v1', path: path.join(installer, 'native-cli-bundle-v1') },
    { id: 'native-cli-bundle-terminal-intent', path: path.join(installer, 'native-cli-bundle-v1.terminal-intent.json') },
    { id: 'gateway-authorization-fence', path: paths.gatewayFenceMarker },
    { id: 'gateway-migration-permit', path: paths.gatewayFencePermit },
    { id: 'tested-pair-commit-record', path: path.join(ocState, '.bridgesllm-tested-pair-commit-v5.json') },
    { id: 'ask-user-transaction', path: path.join(ocState, '.bridgesllm-ask-user-tested-pair-v1') },
  ];
}

// ---------------------------------------------------------------------------
// Types (DESIGN g.1)
// ---------------------------------------------------------------------------

export type ToolPolicyTool = {
  id: string;
  label: string;
  category: 'core' | 'cli' | 'harness' | 'runtime';
  source: { kind: string; package?: string; repository?: string; endpoint?: string; checksums?: string };
  floor: string;
  newestProven: { version: string; status: 'proposed' | 'qualified'; integrity: ToolPolicyIntegrity; qualifiedAt: string | null };
  newestSelector: Record<string, string>;
  denylist: Array<{ version: string; reason: string }>;
  probes: { required: string[]; optional: string[]; conditional: string[] };
  swapLayout: string;
  restartsGateway: boolean;
};

export type ToolPolicy = {
  schema: string;
  policyRevision: number;
  openclaw: {
    channels: string[]; defaultChannel: string; coreAutoUpdateDefault: boolean; gatewayService: string;
    /** "later-release" (5.2.0): Maintenance offers no OpenClaw update; toolctl refuses one (OPENCLAW_UPDATE_LATER_RELEASE). */
    coreUpdates?: string;
  };
  tools: ToolPolicyTool[];
};

export type ToolRunStep = {
  id: string;
  label: string;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
  evidence: string[];
};

export type ToolRunStatus = {
  schema: string;
  runId: string;
  tool: string;
  phase: string;
  phaseStartedAt: string | null;
  state: string;
  createdAt: string | null;
  updatedAt?: string | null;
  endedAt?: string | null;
  steps: ToolRunStep[];
  native?: unknown;
  /** toolctl's own control of the OpenClaw gateway unit (K7): `stoppedByToolctl` while it holds it stopped. */
  gateway?: { stoppedByToolctl?: unknown } | null;
  error?: {
    id?: string; message?: string; nextAction?: string | null;
    refusals?: Array<{ id?: unknown; check?: unknown; message?: unknown; nextAction?: unknown }>;
  } | null;
  result?: {
    action?: string; from?: string | null; to?: string | null; contract?: unknown; preflight?: unknown; updateMode?: unknown;
    /** OpenClaw: the Portal plugins plugins-pre installed before the core update (N4). */
    pluginsInstalled?: unknown;
    /** The installed version a refused harness Re-check read (it wrote no record). */
    installedVersion?: string | null;
  } | null;
  /** The request's action, recorded by toolctl when the run starts (absent on runs of older runners). */
  action?: string | null;
};

export type ToolsHistoryEntry = {
  runId: string;
  tool: string;
  action: string | null;
  from: string | null;
  to: string | null;
  outcome: string;
  errorId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** User id from the run's request.json; null for runs the Portal did not request. */
  initiator: string | null;
};

/**
 * `not-checked`: installed, but nothing has read its version yet (no Re-check so far); never "checking".
 * `needs-portal-release`: behind the recommended version, but its pre-flight proved it can't update itself under the
 * Portal (N3), so Maintenance offers no update for it until a later Portal release; it keeps working until then.
 */
export type ToolStatusValue =
  | 'ok' | 'update-available' | 'below-floor' | 'drifted-requalifying' | 'drifted-failed' | 'degraded'
  | 'blocked' | 'updating' | 'failed-last-run' | 'recovery-required' | 'unknown-retrying' | 'not-installed'
  | 'not-checked' | 'needs-portal-release';

export type ToolAction = 'update-recommended' | 'update-newest' | 'requalify' | 'install' | 'review-plugin-consent' | 'repair';

/** Wave-3 run contract (closed enums). toolctl refuses a pair it does not implement yet, in plain words. */
export const TOOLS_RUN_TOOLS = ['openclaw', 'codex', 'claude-code', 'clawhub', 'opencode', 'hermes', 'grok-build', 'antigravity', 'ollama', 'agent-zero'] as const;
export type ToolsRunTool = (typeof TOOLS_RUN_TOOLS)[number];
export const TOOLS_RUN_ACTIONS = ['preflight', 'update', 'requalify', 'install', 'recover-native', 'retry-checks'] as const;
export type ToolsRunAction = (typeof TOOLS_RUN_ACTIONS)[number];
export const TOOLS_RUN_TARGETS = ['recommended', 'newest'] as const;
export const TOOLS_RUN_ACTIONS_BY_TOOL: Readonly<Record<ToolsRunTool, readonly ToolsRunAction[]>> = {
  openclaw: ['preflight', 'update', 'recover-native', 'retry-checks'],
  // npm CLIs: toolctl runs every check inside `update` and offers `requalify` as the
  // standalone check; `install` is the update path for a missing CLI (offered only while it is absent).
  codex: ['update', 'requalify', 'install'],
  'claude-code': ['update', 'requalify', 'install'],
  clawhub: ['update', 'requalify', 'install'],
  // Harness tools toolctl runs in this build (its harness section); the others stay read-only. `install` runs the
  // same verified flow from nothing while the tool is absent (Agent Zero needs its Owner login file first: no install).
  opencode: ['update', 'requalify', 'install'],
  // Hermes: tag -> commit -> verified source tree; the installer helper builds the new generation, toolctl switches it.
  hermes: ['update', 'requalify', 'install'],
  // Vendor programs without checksums: toolctl installs only the Portal-tested version.
  'grok-build': ['update', 'requalify', 'install'],
  antigravity: ['update', 'requalify', 'install'],
  // Ollama: the installer's own transaction; restarts ollama.service only (never the gateway). `install`
  // runs the installer's fresh-install function through the same entry while Ollama is absent.
  ollama: ['update', 'requalify', 'install'],
  // Agent Zero: the helper's pinned image only, and only when it is configured.
  'agent-zero': ['update', 'requalify'],
};

/**
 * 5.2.0: "Update to newest" only where the candidate's own code runs solely inside the probe sandbox: the npm CLIs
 * (npm --ignore-scripts; allowlisted lifecycle commands sandboxed). Every other tool's helpers run the candidate as
 * root outside it, so it updates only to the version this Portal release qualified (toolctl refuses `newest` with
 * NEWEST_NOT_OFFERED before any download). OpenClaw stays governed by the policy's coreUpdates flag.
 */
export const TOOLS_NEWEST_TOOLS: readonly ToolsRunTool[] = ['openclaw', 'codex', 'claude-code', 'clawhub'];
export const NEWEST_NOT_OFFERED_MESSAGE = 'This tool updates only to the version this Portal release qualified.';

export function newestOffered(toolId: string): boolean {
  return (TOOLS_NEWEST_TOOLS as readonly string[]).includes(toolId);
}

export function isToolsRunTool(value: unknown): value is ToolsRunTool {
  return typeof value === 'string' && (TOOLS_RUN_TOOLS as readonly string[]).includes(value);
}

export function isToolsRunAction(value: unknown): value is ToolsRunAction {
  return typeof value === 'string' && (TOOLS_RUN_ACTIONS as readonly string[]).includes(value);
}

/** How the installed version read went: absent = not installed; unreadable = transient, check again. */
/** `present`: the launcher exists but its version has no cheap read; a Re-check establishes it. */
export type InstalledReadState = 'ok' | 'absent' | 'unreadable' | 'present';

export type ToolStatusItem = {
  id: string;
  label: string;
  category: ToolPolicyTool['category'];
  installed: {
    version: string | null;
    admittedAt: string | null;
    admission: 'proven' | 'verified' | 'requalified' | 'unverified' | 'none';
    source: string | null;
    /** The admission record's `source.authority` (who vouches for the bytes); null without a record or field. */
    authority?: string | null;
    /** The record's `source.bytesVerified`: false = re-checked without comparing the installed bytes to a download. */
    bytesVerified?: boolean | null;
  };
  newest: { version: string | null; checkedAt: string | null; channel?: string };
  recommended: { version: string | null; proven: boolean };
  floor: string;
  status: ToolStatusValue;
  statusReason: string;
  capabilities: { required: { passed: string[]; failed: string[] }; optionalOff: string[] };
  restartsGateway: boolean;
  actions: ToolAction[];
  /** Run actions `POST /tools/run` accepts for this tool right now (owner permitting). */
  runActions: ToolsRunAction[];
  /** For a missing tool this Portal can install: the version Install installs (the recommended one); otherwise null.
   *  Set while another run is open too; `actions` says whether Install is offered now. */
  installVersion: string | null;
  /** Installed above the recommended (newest proven) version: works, but not yet tested by this Portal. */
  newerThanTested: boolean;
  /** This release updates the tool only to its recommended (qualified) version: no "Update to newest" (newestOffered). */
  newestNotOffered?: boolean;
  /** The policy holds this tool's update for a later Portal release (OpenClaw core, 5.2.0): nothing here updates it. */
  heldForLaterRelease?: boolean;
  /** Set when the installed version could not be read now and the last good read is shown instead. */
  lastGoodAt: string | null;
  lastRun?: ToolLastRun | null;
  /**
   * PF-8 disk lines ("Needs 49.0 GB free on /, has 19.0 GB.") from the latest finished pre-flight of a
   * gateway-restarting tool; null when that pre-flight recorded none (it passed, or none ran yet).
   */
  diskCheck?: { messages: string[]; checkedAt: string | null } | null;
  /**
   * How the latest OpenClaw pre-flight says the update runs (K7): `live` keeps chat up until OpenClaw switches over;
   * `stopped` stops the gateway for the whole update. Null when no pre-flight recorded it.
   */
  updateMode?: { mode: 'live' | 'stopped'; reason: string | null; checkedAt: string | null } | null;
  /**
   * When the latest pre-flight of the installed version passed; null when the latest one did not pass, was for
   * another version, or none ran. The consent dialog needs a fresh one to state the update mode (N2).
   */
  preflightPassedAt?: string | null;
};

export type ToolLastRun = {
  runId: string;
  action: string | null;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  errorId: string | null;
  message: string | null;
  nextAction: string | null;
  from: string | null;
  to: string | null;
  refusals: Array<{ id: string; check: string | null; message: string; nextAction: string | null }>;
  /** OpenClaw verification (c.4) from `result.contract`; null when the run did not reach it. */
  contract?: ToolRunContract | null;
  /** Portal plugins ("<id> <version>") the run installed into OpenClaw before its own update stopped (N4). */
  pluginsInstalled?: string[];
};

/** The Portal feature checks of an OpenClaw run, as toolctl's run_contract() records them (bounded). */
export type ToolRunContract = {
  /** Optional feature -> the gateway methods it needs that OpenClaw doesn't offer. */
  featuresOff: Record<string, string[]>;
  /** Required gateway methods OpenClaw doesn't offer (a degraded result). */
  missingMethods: string[];
  /** Whether the hello's method list was read: passed/failed = checked; not-run = not checked, with toolctl's reason. */
  methods: { state: 'passed' | 'failed' | 'not-run'; reason: string | null };
};

export type ToolsRecovery = {
  kind: 'legacy-ledger' | 'native-pending' | 'tools-run-interrupted';
  title: string;
  detail: string;
  action: { id: string; label: string };
  roots?: string[];
  runId?: string;
  /** The tool whose run the action starts (`recover-native`, `requalify`); absent when the action is not a tool run. */
  tool?: string;
};

export type ToolsSummary = {
  status: 'ok' | 'attention' | 'blocked' | 'recovery-required';
  text: string;
  counts: Record<string, number>;
};

export type ToolsStatus = {
  schema: typeof TOOLS_STATUS_SCHEMA;
  generatedAt: string;
  policy: { valid: boolean; revision: number | null; sha256: string | null; error: string | null; defaultChannel: string | null; channels: string[] };
  /** Whether this host can run per-tool updates at all (toolctl + unit present). */
  runner: ToolsRunnerState;
  recovery: ToolsRecovery | null;
  activeRun: null | {
    runId: string; tool: string; phase: string; state: string; startedAt: string | null; steps: ToolRunStep[];
    nativePhase?: string | null; gatewayRestarting: boolean; stale: boolean;
    /** What the run does, once toolctl has recorded it (an install reads as an installation); null before. */
    action: string | null;
    /** Why Stop is not offered right now (plain sentence), or null when a stop may be requested. */
    stopRefusal: string | null;
  };
  tools: ToolStatusItem[];
  summary: ToolsSummary;
  history: ToolsHistoryEntry[];
};

type InstalledRecord = ToolStatusItem['installed'];

export type ToolsSnapshot = {
  generatedAtMs: number;
  policy: ToolPolicy | null;
  policySha256: string | null;
  policyError: string | null;
  legacyOpen: Array<{ id: string; path: string }>;
  runs: ToolRunStatus[];
  lockOwner: { runId: string | null; pid: number | null; bootId: string | null } | null;
  history: ToolsHistoryEntry[];
  installed: Record<string, InstalledRecord>;
  /** Missing entries read as 'ok' when a version is present, else 'unreadable'. */
  installedReads?: Record<string, InstalledReadState>;
  /** Version in the tool's admission record when it differs from the live tree (b.5 drift). */
  drift?: Record<string, { admittedVersion: string; liveVersion: string }>;
  runner: ToolsRunnerState;
  bootId: string | null;
};

// ---------------------------------------------------------------------------
// File reads (bounded, no symlinks)
// ---------------------------------------------------------------------------

function pathPresent(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile<T>(target: string, maxBytes = MAX_JSON_BYTES): T | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(descriptor, buffer, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as T;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function sha256File(target: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  } catch {
    return null;
  }
}

/** Mirrors validate_policy() in toolctl for the fields this module relies on. */
export function policyShapeError(policy: unknown): string | null {
  if (!policy || typeof policy !== 'object') return 'policy is missing or not an object';
  const value = policy as Partial<ToolPolicy>;
  if (value.schema !== TOOLS_POLICY_SCHEMA) return `policy schema must be ${TOOLS_POLICY_SCHEMA}`;
  if (!value.openclaw || !Array.isArray(value.openclaw.channels) || !value.openclaw.channels.includes(value.openclaw.defaultChannel as string)) {
    return 'policy openclaw channels are invalid';
  }
  if (!Array.isArray(value.tools) || value.tools.length === 0) return 'policy has no tools';
  const ids = new Set<string>();
  for (const tool of value.tools) {
    if (!tool || typeof tool.id !== 'string' || ids.has(tool.id)) return 'policy tool ids are invalid';
    ids.add(tool.id);
    if (typeof tool.floor !== 'string' || !parseVersion(tool.floor)) return `policy floor of ${tool.id} is invalid`;
    if (!tool.newestProven || !parseVersion(tool.newestProven.version)) return `policy newestProven of ${tool.id} is invalid`;
    if (!Array.isArray(tool.denylist)) return `policy denylist of ${tool.id} is invalid`;
  }
  if (!ids.has('openclaw')) return 'policy must include openclaw';
  return null;
}

function installedNpmVersion(paths: ToolsPaths, packageName: string | undefined): { version: string | null; read: InstalledReadState } {
  if (!packageName || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(packageName)) {
    return { version: null, read: 'unreadable' };
  }
  const packageDir = path.join(paths.npmGlobalRoot, ...packageName.split('/'));
  try {
    fs.lstatSync(packageDir);
  } catch (error: any) {
    // Only a missing package directory means "not installed"; anything else is
    // a transient read (an npm swap in progress, a permission blip): check again.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { version: null, read: 'absent' };
    return { version: null, read: 'unreadable' };
  }
  const pkg = readJsonFile<{ version?: unknown }>(path.join(packageDir, 'package.json'));
  return typeof pkg?.version === 'string' && parseVersion(pkg.version)
    ? { version: pkg.version, read: 'ok' }
    : { version: null, read: 'unreadable' };
}

/** Versioned-dir harnesses: `<bin>/<executable>` links to `<runtime root>/<dir>/<version>/<executable>`. */
const HARNESS_LAUNCHERS: Readonly<Record<string, { executable: string; runtimeDir: string }>> = {
  opencode: { executable: 'opencode', runtimeDir: 'opencode' },
};

/** Harnesses whose version has no cheap read: only the launcher's presence (never executed). */
const HARNESS_PRESENCE: Readonly<Record<string, string>> = {
  'grok-build': 'grok',
  antigravity: 'agy',
  hermes: 'hermes',
  ollama: 'ollama',
  // Not a launcher: Agent Zero's configuration file (read in launcherPresence).
  'agent-zero': 'agent-zero.env',
};

function launcherPresence(paths: ToolsPaths, toolId: string): { version: null; read: InstalledReadState } {
  const marker = toolId === 'agent-zero'
    ? paths.agentZeroEnvPath
    : (paths.harnessBinDir ? path.join(paths.harnessBinDir, HARNESS_PRESENCE[toolId]) : undefined);
  if (!marker) return { version: null, read: 'unreadable' };
  try {
    fs.lstatSync(marker);
    return { version: null, read: 'present' };
  } catch (error: any) {
    return { version: null, read: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : 'unreadable' };
  }
}

/**
 * Portal 5.0.x installed OpenCode and Hermes under `/opt/bridgesllm/tools/<tool>/<version>/` (5.1.0 did not move them).
 * Only that exact shape is read: the launcher is a direct absolute link to `<legacy root>/<tool>/<version>/<entry>`
 * (the one toolctl adopts on its next update, installer/*-runtime.sh `*_legacy_managed_alias`). Never executed.
 */
const LEGACY_HARNESS_LAUNCHERS: Readonly<Record<string, { executable: string; runtimeDir: string; entry: string }>> = {
  opencode: { executable: 'opencode', runtimeDir: 'opencode', entry: 'opencode' },
  hermes: { executable: 'hermes', runtimeDir: 'hermes', entry: '.venv/bin/hermes' },
};

function legacyLauncherVersion(paths: ToolsPaths, toolId: string, target: string): string | null {
  const layout = LEGACY_HARNESS_LAUNCHERS[toolId];
  if (!layout || !paths.harnessLegacyRoot || !path.isAbsolute(target) || path.normalize(target) !== target) return null;
  const relative = path.relative(path.join(paths.harnessLegacyRoot, layout.runtimeDir), target);
  const [version, ...entry] = relative.split(path.sep);
  return !relative.startsWith('..') && entry.join('/') === layout.entry && parseVersion(version) ? version : null;
}

function installedLauncherVersion(paths: ToolsPaths, toolId: string): { version: string | null; read: InstalledReadState } {
  if (HARNESS_PRESENCE[toolId]) {
    // A 5.0.x Hermes has its version in its path (and no admission record); a managed one is read by presence.
    if (LEGACY_HARNESS_LAUNCHERS[toolId] && paths.harnessBinDir) {
      try {
        const legacy = legacyLauncherVersion(paths, toolId, fs.readlinkSync(path.join(paths.harnessBinDir, HARNESS_PRESENCE[toolId])));
        if (legacy) return { version: legacy, read: 'ok' };
      } catch {
        // Not a link, or gone: the presence read below says which.
      }
    }
    return launcherPresence(paths, toolId);
  }
  const layout = HARNESS_LAUNCHERS[toolId];
  if (!layout || !paths.harnessBinDir || !paths.harnessRuntimeRoot) return { version: null, read: 'unreadable' };
  const launcher = path.join(paths.harnessBinDir, layout.executable);
  let target: string;
  try {
    target = fs.readlinkSync(launcher);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { version: null, read: 'absent' };
    // Not a link (an unmanaged copy) or a transient read: never guess a version.
    return { version: null, read: 'unreadable' };
  }
  const relative = path.relative(
    path.join(paths.harnessRuntimeRoot, layout.runtimeDir),
    path.resolve(path.dirname(launcher), target),
  );
  const parts = relative.split(path.sep);
  if (!relative.startsWith('..') && parts.length === 2 && parts[1] === layout.executable && parseVersion(parts[0])) {
    return { version: parts[0], read: 'ok' };
  }
  const legacy = legacyLauncherVersion(paths, toolId, target);
  return legacy ? { version: legacy, read: 'ok' } : { version: null, read: 'unreadable' };
}

type InstalledReads = Pick<ToolsSnapshot, 'installed' | 'installedReads' | 'drift'>;

function readInstalled(paths: ToolsPaths, policy: ToolPolicy | null): Required<InstalledReads> {
  const installed: Record<string, InstalledRecord> = {};
  const installedReads: Record<string, InstalledReadState> = {};
  const drift: Record<string, { admittedVersion: string; liveVersion: string }> = {};
  for (const tool of policy?.tools || []) {
    // `bridgesllm.tools.admission.v1` (nativeHostCliAdmissionRecord.ts) for the npm CLIs; the deep
    // tree comparison stays with the admission reader. Here only the cheap version facts are read.
    const record = readJsonFile<{ version?: unknown; admittedAt?: unknown; admittedBy?: unknown; source?: unknown }>(
      path.join(paths.stateRoot, 'admission', `${tool.id}.json`),
    );
    const live = tool.source.kind === 'npm'
      ? installedNpmVersion(paths, tool.source.package)
      : installedLauncherVersion(paths, tool.id);
    installedReads[tool.id] = live.read;
    const recordVersion = record && typeof record.version === 'string' && parseVersion(record.version) ? record.version : null;
    if (recordVersion && live.version && recordVersion !== live.version) {
      drift[tool.id] = { admittedVersion: recordVersion, liveVersion: live.version };
    }
    // A launcher-presence read has no version, so the record stands in for it, but never for a launcher that is gone.
    if (recordVersion && (live.version === recordVersion || (tool.source.kind !== 'npm' && !live.version && live.read !== 'absent'))) {
      const admittedBy = typeof record?.admittedBy === 'string' ? record.admittedBy : '';
      const admission: InstalledRecord['admission'] = admittedBy.startsWith('requalify:')
        ? 'requalified'
        : (qualifiedOnThisMachine(tool) && tool.newestProven.version === recordVersion ? 'proven' : 'verified');
      const source = (record?.source && typeof record.source === 'object' ? record.source : {}) as { authority?: unknown; bytesVerified?: unknown };
      installed[tool.id] = {
        version: recordVersion,
        admittedAt: typeof record?.admittedAt === 'string' ? record.admittedAt : null,
        admission,
        source: 'admission-record',
        authority: typeof source.authority === 'string' && /^[a-z0-9-]{1,40}$/.test(source.authority) ? source.authority : null,
        bytesVerified: typeof source.bytesVerified === 'boolean' ? source.bytesVerified : null,
      };
      if (!live.version) installedReads[tool.id] = 'ok';
      continue;
    }
    installed[tool.id] = {
      version: live.version,
      admittedAt: null,
      admission: live.version && drift[tool.id] ? 'unverified' : 'none',
      source: live.version ? 'package-json' : null,
    };
  }
  return { installed, installedReads, drift };
}

function readRuns(paths: ToolsPaths): ToolRunStatus[] {
  const runsDir = path.join(paths.stateRoot, 'runs');
  let names: string[];
  try {
    names = fs.readdirSync(runsDir).filter((name) => TOOLS_RUN_ID_PATTERN.test(name)).slice(0, MAX_RUN_DIRS_SCANNED);
  } catch {
    return [];
  }
  const withTimes = names.map((name) => {
    try {
      return { name, mtimeMs: fs.lstatSync(path.join(runsDir, name, 'status.json')).mtimeMs };
    } catch {
      return { name, mtimeMs: 0 };
    }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_RUNS_READ);
  const runs: ToolRunStatus[] = [];
  for (const { name } of withTimes) {
    const status = readJsonFile<ToolRunStatus>(path.join(runsDir, name, 'status.json'));
    if (status && status.schema === TOOLS_RUN_SCHEMA && status.runId === name && typeof status.state === 'string') {
      runs.push({ ...status, steps: Array.isArray(status.steps) ? status.steps : [] });
    }
  }
  return runs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function readHistory(paths: ToolsPaths): ToolsHistoryEntry[] {
  const historyPath = path.join(paths.stateRoot, 'history.jsonl');
  let text: string;
  try {
    const descriptor = fs.openSync(historyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const size = fs.fstatSync(descriptor).size;
      const start = Math.max(0, size - HISTORY_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return [];
  }
  const entries: ToolsHistoryEntry[] = [];
  for (const line of text.split('\n').slice(-HISTORY_LIMIT - 1)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.runId === 'string') {
        entries.push({
          runId: entry.runId,
          tool: String(entry.tool || ''),
          action: entry.action ?? null,
          from: entry.from ?? null,
          to: entry.to ?? null,
          outcome: String(entry.outcome || ''),
          errorId: entry.errorId ?? null,
          startedAt: entry.startedAt ?? null,
          endedAt: entry.endedAt ?? null,
          durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
          initiator: null,
        });
      }
    } catch {
      // A torn or foreign line is skipped; toolctl appends whole lines with fsync.
    }
  }
  const recent = entries.slice(-HISTORY_LIMIT).reverse();
  for (const entry of recent) {
    if (!TOOLS_RUN_ID_PATTERN.test(entry.runId)) continue;
    const request = readJsonFile<{ requestedBy?: unknown }>(path.join(paths.stateRoot, 'runs', entry.runId, 'request.json'), 64 * 1024);
    entry.initiator = typeof request?.requestedBy === 'string' ? request.requestedBy.slice(0, 120) : null;
  }
  return recent;
}

export type ToolsRunReport = { run: ToolRunStatus; evidence: string[] };

const EVIDENCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** One run's status record plus the names of its evidence files (contents stay on the server). */
export function readToolsRunReport(paths: ToolsPaths, runId: string): ToolsRunReport | null {
  if (!TOOLS_RUN_ID_PATTERN.test(runId)) return null;
  const runDir = path.join(paths.stateRoot, 'runs', runId);
  const run = readJsonFile<ToolRunStatus>(path.join(runDir, 'status.json'));
  if (!run || run.schema !== TOOLS_RUN_SCHEMA || run.runId !== runId) return null;
  let evidence: string[] = [];
  try {
    evidence = fs.readdirSync(runDir)
      .filter((name) => EVIDENCE_NAME_PATTERN.test(name) && name !== 'request.json')
      .sort()
      .slice(0, 200);
  } catch {
    evidence = [];
  }
  return { run: { ...run, steps: Array.isArray(run.steps) ? run.steps : [] }, evidence };
}

function readBootId(): string | null {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().slice(0, 64) || null;
  } catch {
    return null;
  }
}

export function readToolsSnapshot(paths: ToolsPaths = defaultToolsPaths(), nowMs = Date.now()): ToolsSnapshot {
  const rawPolicy = readJsonFile<ToolPolicy>(paths.policyPath);
  const policyError = rawPolicy ? policyShapeError(rawPolicy) : `tool policy ${paths.policyPath} is missing or unreadable`;
  const policy = policyError ? null : rawPolicy;
  const owner = readJsonFile<{ runId?: unknown; pid?: unknown; bootId?: unknown }>(path.join(paths.stateRoot, 'lock.owner.json'));
  return {
    generatedAtMs: nowMs,
    policy,
    policySha256: rawPolicy ? sha256File(paths.policyPath) : null,
    policyError,
    legacyOpen: legacyRootPaths(paths).filter((root) => pathPresent(root.path)),
    runs: readRuns(paths),
    lockOwner: owner ? {
      runId: typeof owner.runId === 'string' ? owner.runId : null,
      pid: Number.isSafeInteger(owner.pid) ? owner.pid as number : null,
      bootId: typeof owner.bootId === 'string' ? owner.bootId : null,
    } : null,
    history: readHistory(paths),
    ...readInstalled(paths, policy),
    runner: readToolsRunnerState(paths),
    bootId: readBootId(),
  };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

type ParsedVersion = { nums: number[]; pre: Array<number | string> | null };

export function parseVersion(text: unknown): ParsedVersion | null {
  if (typeof text !== 'string') return null;
  const match = /^v?((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3})(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/.exec(text.trim());
  if (!match) return null;
  const nums = match[1].split('.').map(Number);
  while (nums.length < 4) nums.push(0);
  const pre = match[2] ? match[2].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : null;
  return { nums, pre };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`not a version: ${a} / ${b}`);
  for (let index = 0; index < 4; index += 1) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] < right.nums[index] ? -1 : 1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'string') return -1;
    if (typeof l === 'string' && typeof r === 'number') return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Status model (g.1): recovery, active run, items, and the summary derived
// from those same items in one function.
// ---------------------------------------------------------------------------

function ownerAlive(owner: ToolsSnapshot['lockOwner'], bootId: string | null, processAlive: (pid: number) => boolean): boolean {
  if (!owner || owner.pid === null) return false;
  if (owner.bootId && bootId && owner.bootId !== bootId) return false;
  return processAlive(owner.pid);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

const NATIVE_PHASES = new Set(['requested', 'staging', 'validating', 'repairing', 'activating', 'restarting', 'verifying', 'finished']);

/** OpenClaw's own update phase as toolctl last observed it (c.2.3); unknown values read as null. */
export function nativePhaseOf(run: ToolRunStatus): string | null {
  const native = run.native as { phase?: unknown } | null | undefined;
  return native && typeof native.phase === 'string' && NATIVE_PHASES.has(native.phase) ? native.phase : null;
}

/** True while the policy holds the OpenClaw core update for a later Portal release (openclaw.coreUpdates). */
export function openClawCoreUpdatesHeld(policy: ToolPolicy | null | undefined): boolean {
  return policy?.openclaw?.coreUpdates === 'later-release';
}

/** What a card says for every installed OpenClaw version while its core update is held (the toolctl refusal's text). */
export function openClawLaterReleaseReason(floor: string): string {
  return 'Updating OpenClaw from Maintenance comes in a later Portal release. OpenClaw keeps working; '
    + `this Portal works with OpenClaw ${floor} and newer.`;
}

/**
 * An UPDATE_NOT_APPLIED result: native stopped before its swap, so the package never changed and the previous
 * version runs again. While the core update is held, Retry checks closes it once that version answers every check
 * (toolctl's not_applied_closable); its repair can't finish on a Portal host.
 */
export function notAppliedRecoveryClosable(run: ToolRunStatus, installedVersion: string | null | undefined): boolean {
  return run.tool === 'openclaw' && run.state === 'recovery-required' && run.error?.id === 'UPDATE_NOT_APPLIED'
    && Boolean(installedVersion) && run.result?.from === installedVersion && run.result?.to === installedVersion;
}

export function deriveRecovery(snapshot: ToolsSnapshot, activeRunStale: boolean, activeRun: ToolRunStatus | null): ToolsRecovery | null {
  if (snapshot.legacyOpen.length > 0) {
    return {
      kind: 'legacy-ledger',
      title: 'An earlier maintenance run is unfinished.',
      // Text only this release (design h.2's guarded recovery job is not built): the installer recovers it.
      detail: 'AI tool updates stay unavailable until the interrupted maintenance is recovered. On the server, as root, from the '
        + 'directory that contains install.sh, run: sudo bash install.sh --recover (see docs/INSTALLER_RECOVERY.md). '
        + 'Then choose Check AI tools again.',
      action: { id: 'recover-legacy', label: 'Recover interrupted maintenance' },
      roots: snapshot.legacyOpen.map((root) => root.id),
    };
  }
  if (activeRun && activeRunStale && activeRun.state !== 'queued') {
    return {
      kind: 'tools-run-interrupted',
      title: 'An AI tools update stopped unexpectedly.',
      detail: 'Its runner is no longer running. Check the interrupted run before starting another update.',
      action: { id: 'reconcile-tools-run', label: 'Check interrupted update' },
      runId: activeRun.runId,
    };
  }
  const coreHeld = openClawCoreUpdatesHeld(snapshot.policy);
  const latestByTool = new Map<string, ToolRunStatus>();
  for (const run of snapshot.runs) {
    // Held core update: a refused OpenClaw run changed nothing, so it neither opens nor closes a recovery (as toolctl).
    if (coreHeld && run.tool === 'openclaw' && run.state === 'refused') continue;
    if (!latestByTool.has(run.tool)) latestByTool.set(run.tool, run);
  }
  for (const run of latestByTool.values()) {
    if (run.state !== 'recovery-required') continue;
    if (coreHeld && notAppliedRecoveryClosable(run, snapshot.installed.openclaw?.version)) {
      return {
        kind: 'tools-run-interrupted',
        title: 'OpenClaw was not updated and is running again.',
        detail: `OpenClaw ${run.result?.from} never changed: its update stopped before it replaced anything. `
          + 'Retry checks confirms it answers the Portal\'s checks and closes this recovery.',
        action: { id: 'retry-checks', label: 'Retry checks' },
        runId: run.runId,
        tool: 'openclaw',
      };
    }
    if (run.tool === 'openclaw' && run.error?.nextAction === 'retry-checks') {
      // toolctl started the new version again after its checks failed and the Portal could not return to the
      // previous one: the gateway is running, so the recovery's one action is Retry checks, not a repair.
      return {
        kind: 'tools-run-interrupted',
        title: 'OpenClaw is running, but its Portal checks did not pass.',
        detail: run.error.message || 'The Portal could not return OpenClaw to the previous version.',
        action: { id: 'retry-checks', label: 'Retry checks' },
        runId: run.runId,
        tool: 'openclaw',
      };
    }
    if (run.tool === 'openclaw') {
      return {
        kind: 'tools-run-interrupted',
        title: 'OpenClaw needs recovery. Chat may be unavailable.',
        detail: run.error?.message || 'The last update was interrupted while it was changing the server.',
        action: { id: 'recover-native', label: 'Run OpenClaw repair' },
        runId: run.runId,
        tool: 'openclaw',
      };
    }
    // Only OpenClaw has a repair run. toolctl reconcile settles open runs only, so nothing else ever settles this
    // finished one: the tool's Re-check does. It re-reads what is live; success records it and clears recovery, and a
    // refusal or failure is a newer finished run that clears it too and shows its own next action.
    const label = snapshot.policy?.tools.find((tool) => tool.id === run.tool)?.label || run.tool;
    const installing = (run.result?.action ?? run.action) === 'install';
    return {
      kind: 'tools-run-interrupted',
      title: `The ${label} ${installing ? 'installation' : 'update'} needs to be checked.`,
      detail: run.error?.message || `The last ${installing ? 'installation' : 'update'} stopped while it was changing the tool.`,
      action: { id: 'requalify', label: `Re-check ${label}` },
      runId: run.runId,
      tool: run.tool,
    };
  }
  return null;
}

function isDenylisted(tool: ToolPolicyTool, version: string): { version: string; reason: string } | null {
  return tool.denylist.find((entry) => entry.version === version) || null;
}

/** OpenClaw restarts in these phases, so reads may fail briefly and chats pause (c.2.3, c.3). */
const RESTART_NATIVE_PHASES = new Set(['activating', 'restarting', 'verifying']);
const RESTART_RUN_PHASES = new Set(['plugins-post', 'contract']);

/** toolctl holds the OpenClaw gateway unit stopped (K7: for the switch-over, a repair, or the whole mode-B update). */
export function gatewayStoppedByRun(run: ToolRunStatus | null): boolean {
  return Boolean(run && run.tool === 'openclaw' && run.gateway && run.gateway.stoppedByToolctl === true);
}

export function inGatewayRestartWindow(run: ToolRunStatus | null): boolean {
  if (!run) return false;
  const nativePhase = nativePhaseOf(run);
  return (nativePhase !== null && RESTART_NATIVE_PHASES.has(nativePhase)) || RESTART_RUN_PHASES.has(run.phase)
    || gatewayStoppedByRun(run);
}

/**
 * Steps a stop must not interrupt: one long child that SIGTERM would leave half done (harness_2: Ollama's
 * installer transaction and Agent Zero's helper during `swap`; harness_3: the Hermes helper's build during
 * `stage`), and OpenClaw's own switch-over, where a stop leaves a repair to run (DESIGN failure injection 4).
 * The step comes from the run status: toolctl sets `phase` to the running step for tool runs.
 */
const UNSTOPPABLE_STEPS: ReadonlyArray<{ tool: string; step: string; reason: string }> = [
  { tool: 'ollama', step: 'swap', reason: 'Ollama\'s installer is switching versions and restarting the local model server; stopping it now could leave Ollama stopped.' },
  { tool: 'agent-zero', step: 'swap', reason: 'Agent Zero is switching to its new container; stopping it now could leave it half switched.' },
  { tool: 'hermes', step: 'stage', reason: 'Hermes is building its new version in one long step; the current version keeps working meanwhile.' },
  // K7: toolctl's own control of the OpenClaw gateway around the native update.
  { tool: 'openclaw', step: 'gateway-stop', reason: 'The OpenClaw gateway is stopping for the update; stopping the run now could leave it stopped.' },
  { tool: 'openclaw', step: 'native-repair', reason: 'OpenClaw is finishing its maintenance with the gateway stopped; stopping now would leave it needing a repair.' },
  { tool: 'openclaw', step: 'gateway-start', reason: 'The OpenClaw gateway is starting again; stopping now could leave it stopped.' },
  { tool: 'openclaw', step: 'rollback', reason: 'OpenClaw is returning to the previous version; stopping now would leave it needing a repair.' },
];
const UNSTOPPABLE_NATIVE_PHASES = new Set(['activating', 'restarting']);

/** Why Stop is unavailable for this live run now, or null when a stop may be requested. */
export function toolsRunStopRefusal(run: ToolRunStatus, stale: boolean): string | null {
  if (stale) return 'Its runner is no longer running, so there is nothing to stop. Check the interrupted update instead.';
  if (run.state === 'queued') return 'The update has not started yet. Stop is available once it starts.';
  const running = (step: string) => run.phase === step || run.steps.some((entry) => entry?.id === step && entry.state === 'running');
  const unstoppable = UNSTOPPABLE_STEPS.find((entry) => entry.tool === run.tool && running(entry.step));
  if (unstoppable) return `${unstoppable.reason} Stop is available again when this step ends.`;
  const nativePhase = nativePhaseOf(run);
  if (run.tool === 'openclaw' && nativePhase && UNSTOPPABLE_NATIVE_PHASES.has(nativePhase)) {
    return 'OpenClaw is switching over and restarting; stopping now would leave it needing a repair. Stop is available again when the restart ends.';
  }
  return null;
}

function runningReason(tool: ToolPolicyTool, run: ToolRunStatus): string {
  if (run.state === 'queued') return 'Starting…';
  if (run.phase === 'preflight') return 'Checking…';
  if (run.action === 'install') return `Installing ${tool.label}…`;
  if (tool.restartsGateway && gatewayStoppedByRun(run)) {
    return `${tool.label}'s gateway is stopped while the update finishes. Chat is unavailable until it starts again; this page keeps checking.`;
  }
  if (tool.restartsGateway && inGatewayRestartWindow(run)) {
    return `${tool.label} is restarting. Chats pause for a few minutes; this page keeps checking.`;
  }
  return 'An update is running.';
}

function ageLabel(fromIso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(fromIso)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return 'less than a minute';
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function boundedText(value: unknown, max = 600): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

const CONTRACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,79}$/;

function contractNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string' && CONTRACT_NAME_PATTERN.test(name)).slice(0, 20)
    : [];
}

/** `result.contract` -> the fields the card shows; anything else (or an odd shape) reads as not reached. */
export function toolRunContract(value: unknown): ToolRunContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const contract = value as { featuresOff?: unknown; missingMethods?: unknown; methods?: unknown };
  const methods = (contract.methods && typeof contract.methods === 'object' ? contract.methods : {}) as { state?: unknown; reason?: unknown };
  const featuresOff: Record<string, string[]> = {};
  if (contract.featuresOff && typeof contract.featuresOff === 'object' && !Array.isArray(contract.featuresOff)) {
    for (const [feature, needed] of Object.entries(contract.featuresOff).slice(0, 20)) {
      const names = contractNames(needed);
      if (CONTRACT_NAME_PATTERN.test(feature) && names.length) featuresOff[feature] = names;
    }
  }
  const state = methods.state === 'passed' || methods.state === 'failed' ? methods.state : 'not-run';
  return {
    featuresOff,
    missingMethods: contractNames(contract.missingMethods),
    methods: { state, reason: boundedText(methods.reason) },
  };
}

export function toolLastRun(run: ToolRunStatus | null): ToolLastRun | null {
  if (!run) return null;
  const refusals = Array.isArray(run.error?.refusals) ? run.error!.refusals! : [];
  const pluginsInstalled = Array.isArray(run.result?.pluginsInstalled)
    ? (run.result!.pluginsInstalled as unknown[]).slice(0, 10).flatMap((entry) => {
      const text = boundedText(entry, 120);
      return text ? [text] : [];
    })
    : [];
  return {
    runId: run.runId,
    action: boundedText(run.result?.action ?? run.action, 40),
    state: run.state,
    startedAt: run.createdAt ?? null,
    endedAt: run.endedAt ?? null,
    errorId: run.error?.id ?? null,
    message: boundedText(run.error?.message),
    nextAction: boundedText(run.error?.nextAction),
    from: boundedText(run.result?.from, 80),
    to: boundedText(run.result?.to, 80),
    refusals: refusals.slice(0, 20).flatMap((entry) => {
      const message = boundedText(entry?.message);
      return message ? [{
        id: boundedText(entry.id, 80) || 'REFUSED',
        check: boundedText(entry.check, 40),
        message,
        nextAction: boundedText(entry.nextAction),
      }] : [];
    }),
    contract: toolRunContract(run.result?.contract),
    ...(pluginsInstalled.length ? { pluginsInstalled } : {}),
  };
}

/** The run actions POST /tools/run accepts for a tool in this state (P7: nothing but repair while recovery is open). */
export function allowedRunActions(
  toolId: string,
  context: { recovery: ToolsRecovery | null; activeRun: ToolRunStatus | null | { runId: string } },
): ToolsRunAction[] {
  if (!isToolsRunTool(toolId) || context.activeRun) return [];
  if (context.recovery) {
    const { action, tool } = context.recovery;
    if (action.id === 'recover-native') return toolId === 'openclaw' ? ['recover-native'] : [];
    // OpenClaw is running again after a refused rollback: only its Retry checks.
    if (action.id === 'retry-checks' && tool === toolId && TOOLS_RUN_ACTIONS_BY_TOOL[toolId].includes('retry-checks')) {
      return ['retry-checks'];
    }
    // A finished recovery-required run of another tool: only that tool's Re-check.
    if (action.id === 'requalify' && tool === toolId && TOOLS_RUN_ACTIONS_BY_TOOL[toolId].includes('requalify')) return ['requalify'];
    return [];
  }
  return TOOLS_RUN_ACTIONS_BY_TOOL[toolId].filter((action) => action !== 'recover-native');
}

export type ToolLastGood = { installed: InstalledRecord; observedAt: string };

/** PF-8's refusal lines of a finished run that ran the OpenClaw pre-flight (status.json only; preflight.json is not read). */
export function preflightDiskCheck(run: ToolRunStatus | null): ToolStatusItem['diskCheck'] {
  if (!run) return null;
  const refusals = Array.isArray(run.error?.refusals) ? run.error!.refusals! : [];
  const messages = refusals.flatMap((entry) => {
    const message = entry?.check === 'PF-8' ? boundedText(entry.message, 200) : null;
    return message ? [message] : [];
  }).slice(0, 4);
  return messages.length ? { messages, checkedAt: run.endedAt ?? run.createdAt ?? null } : null;
}

const UPDATE_MODE_REASONS = new Set(['replacement-watcher', 'no-replacement-watcher', 'service-inspection']);

/** The update mode toolctl's pre-flight recorded in a finished run's result (K7); null when absent or unknown. */
export function preflightUpdateMode(run: ToolRunStatus | null, installedVersion?: string | null): ToolStatusItem['updateMode'] {
  // The mode belongs to the version that pre-flight checked (mode B: a version without the replacement watcher).
  if (installedVersion !== undefined && (!installedVersion || run?.result?.from !== installedVersion)) return null;
  const raw = run?.result?.updateMode;
  if (!raw || typeof raw !== 'object') return null;
  const { mode, reason } = raw as { mode?: unknown; reason?: unknown };
  if (mode !== 'live' && mode !== 'stopped') return null;
  return {
    mode,
    reason: typeof reason === 'string' && UPDATE_MODE_REASONS.has(reason) ? reason : null,
    checkedAt: run?.endedAt ?? run?.createdAt ?? null,
  };
}

/**
 * PF-11 refusals proving the installed OpenClaw can't update itself under the Portal's unit, running or stopped
 * (5.2.0 has no supervisor-side runtime replacement). The second id is the same refusal recorded by 5.2.0
 * candidates that stopped the gateway before asking again.
 */
const SELF_UPDATE_REFUSAL_IDS = new Set(['PF11_SELF_UPDATE_UNSUPPORTED', 'PF11_SERVICE_INSPECTION_UNAVAILABLE']);

/** The installed version a refused run's pre-flight proved can't update itself here; null when none did. */
export function selfUpdateRefusedVersion(run: ToolRunStatus | null): string | null {
  if (!run || run.state !== 'refused') return null;
  const refusals = Array.isArray(run.error?.refusals) ? run.error!.refusals! : [];
  const ids = [run.error?.id, ...refusals.map((entry) => entry?.id)];
  if (!ids.some((id) => typeof id === 'string' && SELF_UPDATE_REFUSAL_IDS.has(id))) return null;
  const from = run.result?.from;
  return typeof from === 'string' && from ? from : null;
}

/** When a pre-flight run (not an update) of ``installedVersion`` passed; null otherwise. */
export function preflightPassedAt(run: ToolRunStatus | null, installedVersion: string | null): string | null {
  if (!run || run.state !== 'succeeded' || run.result?.action !== 'preflight') return null;
  if (!installedVersion || run.result?.from !== installedVersion) return null;
  return run.endedAt ?? run.createdAt ?? null;
}

export function selfUpdateUnsupportedReason(label: string, version: string): string {
  return `${label} ${version} cannot update itself while the Portal runs it; it keeps working with this Portal; `
    + 'updating it from Maintenance needs a later Portal release.';
}

export function buildToolItem(
  tool: ToolPolicyTool,
  installed: InstalledRecord,
  context: {
    recovery: ToolsRecovery | null;
    activeRun: ToolRunStatus | null;
    lastRun: ToolRunStatus | null;
    runnableTools: ReadonlySet<string>;
    read?: InstalledReadState;
    drift?: { admittedVersion: string; liveVersion: string } | null;
    lastGood?: ToolLastGood | null;
    nowMs?: number;
    /** The tool's latest finished run that ran a pre-flight (OpenClaw). */
    lastPreflight?: ToolRunStatus | null;
    /** The tool's latest finished run that was not refused and not a pre-flight (absent: `lastRun`). */
    lastOutcome?: ToolRunStatus | null;
    /** The installed version the tool's latest Re-check read and refused as not admitted (checkedVersions). */
    checkedVersion?: string | null;
    /** The policy holds the OpenClaw core update for a later Portal release (openclaw.coreUpdates). */
    coreUpdatesHeld?: boolean;
  },
): ToolStatusItem {
  const recommended = tool.newestProven.version;
  // F5: a launcher with no cheap version read is known only through its Re-check. One that read a version the Portal
  // does not admit (below the floor, or refused) shows it, so the card offers the update instead of another Re-check.
  const checked = !installed.version && context.read === 'present' && context.checkedVersion
    && (compareVersions(context.checkedVersion, tool.floor) < 0 || isDenylisted(tool, context.checkedVersion))
    ? context.checkedVersion : null;
  if (checked) installed = { ...installed, version: checked, source: 'last-check' };
  const version = installed.version;
  const read: InstalledReadState = context.read ?? (version ? 'ok' : 'unreadable');
  // F2: a failed read shows the last good result, labelled with its age, never a verdict.
  const lastGood = !version && read === 'unreadable' && context.lastGood?.installed.version ? context.lastGood : null;
  const item: ToolStatusItem = {
    id: tool.id,
    label: tool.label,
    category: tool.category,
    installed: lastGood ? lastGood.installed : installed,
    newest: { version: null, checkedAt: null },
    recommended: { version: recommended, proven: qualifiedOnThisMachine(tool) },
    floor: tool.floor,
    status: 'ok',
    statusReason: '',
    capabilities: { required: { passed: [], failed: [] }, optionalOff: [] },
    restartsGateway: tool.restartsGateway,
    actions: [],
    runActions: context.runnableTools.has(tool.id) ? allowedRunActions(tool.id, context) : [],
    installVersion: null,
    newerThanTested: false,
    ...(newestOffered(tool.id) ? {} : { newestNotOffered: true }),
    lastGoodAt: lastGood ? lastGood.observedAt : null,
    lastRun: toolLastRun(context.lastRun),
    ...(tool.restartsGateway ? {
      diskCheck: preflightDiskCheck(context.lastPreflight ?? null),
      updateMode: preflightUpdateMode(context.lastPreflight ?? null, version),
      preflightPassedAt: preflightPassedAt(context.lastPreflight ?? null, version),
    } : {}),
  };
  const deny = version ? isDenylisted(tool, version) : null;
  const belowFloor = version ? compareVersions(version, tool.floor) < 0 : false;
  const behind = version ? compareVersions(version, recommended) < 0 : false;
  const lastFailed = Boolean(context.lastRun && ['failed', 'rolled-back'].includes(context.lastRun.state));
  // The update finished but a Portal check did not pass (chat unavailable, readiness unconfirmed): never "Up to date".
  // A later refused run or pre-flight changed nothing and checked no Portal feature, so it does not clear that.
  const outcomeRun = context.lastOutcome === undefined ? context.lastRun : context.lastOutcome;
  const lastDegraded = outcomeRun?.state === 'succeeded-degraded';
  const lastRequalifyFailed = Boolean(context.lastRun && context.lastRun.result?.action === 'requalify'
    && ['failed', 'refused', 'recovery-required'].includes(context.lastRun.state));

  if (context.recovery) {
    item.status = 'recovery-required';
    item.statusReason = context.recovery.title;
  } else if (context.activeRun && context.activeRun.tool === tool.id) {
    item.status = 'updating';
    item.statusReason = runningReason(tool, context.activeRun);
  } else if (!version && read === 'absent') {
    item.status = 'not-installed';
    item.statusReason = tool.id === 'agent-zero' ? 'Not configured.' : 'Not installed on this server.';
  } else if (!version && read === 'present') {
    item.status = 'not-checked';
    item.statusReason = item.runActions.includes('requalify')
      ? `Installed; not checked yet. Re-check ${tool.label} to confirm its version.`
      : 'Installed; not checked yet.';
  } else if (!version) {
    item.status = 'unknown-retrying';
    item.statusReason = lastGood
      ? `Checking again. Last confirmed ${ageLabel(lastGood.observedAt, context.nowMs ?? Date.now())} ago.`
      : (context.activeRun ? 'Checking… another update is running.' : 'Checking…');
  } else if (deny) {
    item.status = 'blocked';
    item.statusReason = `${tool.label} ${version} is blocked: ${deny.reason}`;
  } else if (belowFloor) {
    item.status = 'below-floor';
    item.statusReason = `Update required: ${tool.label} ${version} is older than the minimum ${tool.floor}.`;
  } else if (context.drift && lastRequalifyFailed) {
    item.status = 'drifted-failed';
    item.statusReason = `${tool.label} changed itself to ${version} and the re-check failed: ${context.lastRun?.error?.message || 'see the last run.'}`;
  } else if (context.drift) {
    item.status = 'drifted-requalifying';
    item.statusReason = `${tool.label} changed itself (now ${version}, last checked ${context.drift.admittedVersion}). Re-check it before relying on it.`;
  } else if (lastFailed) {
    item.status = 'failed-last-run';
    item.statusReason = context.lastRun?.error?.message || 'The last update did not finish.';
  } else if (lastDegraded) {
    item.status = 'degraded';
    item.statusReason = boundedText(outcomeRun?.error?.message) || 'Updated, but some Portal checks did not pass.';
  } else if (behind) {
    item.status = 'update-available';
    item.statusReason = `${recommended} is recommended${item.recommended.proven ? '' : ' (not yet qualified)'}.`;
  } else if (compareVersions(version, recommended) > 0) {
    item.status = 'ok';
    item.newerThanTested = true;
    item.statusReason = `Newer than tested: ${recommended} is the newest version this Portal has tested.`;
  } else {
    item.status = 'ok';
    item.statusReason = 'Up to date.';
  }

  // N3: the latest pre-flight proved this installed version's own updater refuses here: no update is offered
  // for it (the server refuses one too), and the pre-flight stays available to check again. Behind but admitted,
  // it is not an available update; below the minimum it stays required, and nothing here can do it.
  const coreHeld = tool.restartsGateway && context.coreUpdatesHeld === true;
  const selfUpdateRefused = !coreHeld && tool.restartsGateway && Boolean(version)
    && selfUpdateRefusedVersion(context.lastPreflight ?? null) === version;
  if (coreHeld) {
    // 5.2.0 holds the OpenClaw core update: every installed version reads "Needs a later Portal
    // release" with toolctl's words. A minimum or a block stays what it is, in the same plain words; a recovery, a
    // run or an unknown version keeps its own status.
    item.heldForLaterRelease = true;
    if (version && ['ok', 'update-available', 'needs-portal-release', 'failed-last-run'].includes(item.status)) {
      item.status = 'needs-portal-release';
      item.statusReason = openClawLaterReleaseReason(tool.floor);
    } else if (version && ['below-floor', 'blocked', 'degraded'].includes(item.status)) {
      item.statusReason = `${item.statusReason} Updating OpenClaw from Maintenance comes in a later Portal release.`;
    }
  }
  if (selfUpdateRefused && item.status === 'update-available') {
    item.status = 'needs-portal-release';
    item.statusReason = selfUpdateUnsupportedReason(tool.label, version as string);
  } else if (selfUpdateRefused && item.status === 'below-floor') {
    item.statusReason = `${item.statusReason} It cannot update itself while the Portal runs it; updating it from `
      + 'Maintenance needs a later Portal release.';
  }

  // P7: never offer an update while recovery is pending or any run is open.
  const updatesAllowed = !context.recovery && !context.activeRun && context.runnableTools.has(tool.id);
  if (updatesAllowed && version) {
    if (item.status === 'drifted-requalifying') {
      // b.5: re-check first; an update is offered only once the re-check failed.
      item.actions.push('requalify');
    } else {
      if (item.status === 'drifted-failed') item.actions.push('requalify');
      if (behind || deny || belowFloor || lastFailed || lastRequalifyFailed) {
        // toolctl refuses an update to the installed version (already current) or below it (a downgrade) unless its
        // last re-check offered that update (a same-version reinstall: the tree differs from its record).
        if (behind || (version === recommended && context.lastRun?.error?.nextAction === 'update-recommended')) {
          item.actions.push('update-recommended');
        } else if (!deny && !item.actions.includes('requalify')) item.actions.push('requalify');
      }
      // d.2 step 7: a vendor that publishes no checksums, and the pinned Agent Zero image, have no "newest" install;
      // in 5.2.0 only the npm CLIs (and OpenClaw, under its coreUpdates flag) offer one at all (newestOffered).
      if (newestOffered(tool.id) && !(tool.source.kind === 'vendor' && tool.source.checksums === 'unavailable')
        && tool.source.kind !== 'container-image') {
        item.actions.push('update-newest');
      }
      // A version read by an earlier Re-check may be re-read at any time, and so may a current one (TEST N6): up to
      // date or newer than tested, the run endpoint accepts a Re-check, so the card offers it (not beside the
      // same-version reinstall a failed Re-check asked for: another Re-check would only give that answer again).
      if ((checked || (item.status === 'ok' && !item.actions.includes('update-recommended')))
        && !item.actions.includes('requalify')) item.actions.push('requalify');
    }
  }
  // Nothing to update or re-check while the installed version is unknown (F2) or absent; a launcher
  // that is present but not checked yet is offered only the Re-check, which establishes its version.
  // A recovery's own Re-check stays offered whatever the read: it ends in a finished run either way.
  const recoveryRecheck = context.recovery?.action.id === 'requalify' && context.recovery.tool === tool.id;
  if (!version) {
    item.runActions = item.runActions.filter((action) => action !== 'update'
      && (action !== 'requalify' || read === 'present' || recoveryRecheck));
    if (updatesAllowed && item.runActions.includes('requalify')) item.actions.push('requalify');
  }
  if (!item.runActions.includes('requalify')) item.actions = item.actions.filter((action) => action !== 'requalify');
  // Install: only a missing tool (the read found nothing) and only the recommended version, admitted exactly as
  // its update would admit it (qualified or not, like `update-recommended`). A failed read is never "missing".
  const installable = !version && read === 'absent' && context.runnableTools.has(tool.id)
    && isToolsRunTool(tool.id) && TOOLS_RUN_ACTIONS_BY_TOOL[tool.id].includes('install');
  if (!installable) {
    item.runActions = item.runActions.filter((action) => action !== 'install');
  } else {
    // Named while another run is open too (its card stays); offered only when nothing is open (P7).
    item.installVersion = recommended;
    if (updatesAllowed && item.runActions.includes('install')) item.actions.push('install');
  }
  if (selfUpdateRefused) {
    item.actions = item.actions.filter((action) => action !== 'update-recommended' && action !== 'update-newest');
    item.runActions = item.runActions.filter((action) => action !== 'update');
    // No update is offered, so no line about how one would run (TEST's refused run still carried a mode).
    item.updateMode = null;
  }
  if (coreHeld) {
    // No update and no pre-flight (toolctl refuses both); repair and Retry checks only for an open recovery.
    item.actions = item.actions.filter((action) => action !== 'update-recommended' && action !== 'update-newest');
    item.runActions = context.recovery
      ? item.runActions.filter((action) => action === 'recover-native' || action === 'retry-checks') : [];
    item.updateMode = null;
    item.preflightPassedAt = null;
    // The open UPDATE_NOT_APPLIED recovery's one action is Retry checks: its last run says so, not "Run repair".
    if (context.recovery?.action.id === 'retry-checks' && item.lastRun && item.lastRun.runId === context.recovery.runId
      && item.lastRun.errorId === 'UPDATE_NOT_APPLIED') {
      item.lastRun = { ...item.lastRun, nextAction: 'retry-checks', message: context.recovery.detail };
    }
  }
  return item;
}

const ATTENTION_STATUSES = new Set<ToolStatusValue>([
  'update-available', 'degraded', 'drifted-requalifying', 'drifted-failed', 'failed-last-run', 'unknown-retrying', 'updating',
  'not-checked',
]);

/** The summary is derived only from `tools` and `recovery` (P4-B324 stale-summary fix). */
export function computeToolsSummary(tools: ToolStatusItem[], recovery: ToolsRecovery | null): ToolsSummary {
  const counts: Record<string, number> = {};
  for (const tool of tools) counts[tool.status] = (counts[tool.status] || 0) + 1;
  if (recovery) {
    return { status: 'recovery-required', text: `${recovery.title} ${recovery.action.label} to continue.`, counts };
  }
  const blocked = tools.filter((tool) => tool.status === 'below-floor' || tool.status === 'blocked'
    || (tool.status === 'not-installed' && tool.category === 'core'));
  if (blocked.length > 0) {
    const missing = blocked.filter((tool) => tool.status === 'not-installed');
    if (missing.length === blocked.length) {
      return { status: 'blocked', text: `${listLabels(missing)} ${missing.length === 1 ? 'is' : 'are'} not installed on this server.`, counts };
    }
    return { status: 'blocked', text: `${listLabels(blocked)} ${blocked.length === 1 ? 'needs' : 'need'} an update before ${blocked.length === 1 ? 'it' : 'they'} can be used.`, counts };
  }
  const attention = tools.filter((tool) => ATTENTION_STATUSES.has(tool.status));
  // Not an available update: nothing in Maintenance can update it, and it keeps working (N3).
  const waiting = tools.filter((tool) => tool.status === 'needs-portal-release');
  const waitingText = waiting.length
    ? `${listLabels(waiting)} ${waiting.length === 1 ? 'needs' : 'need'} a later Portal release to update from `
      + `Maintenance and ${waiting.length === 1 ? 'keeps' : 'keep'} working until then.`
    : '';
  if (attention.length > 0) {
    const updating = attention.filter((tool) => tool.status === 'updating');
    if (updating.length > 0) return { status: 'attention', text: `${listLabels(updating)} ${updating.length === 1 ? 'is' : 'are'} updating.`, counts };
    const degraded = attention.filter((tool) => tool.status === 'degraded');
    const available = attention.filter((tool) => tool.status === 'update-available');
    const unknown = attention.filter((tool) => tool.status === 'unknown-retrying');
    const unchecked = attention.filter((tool) => tool.status === 'not-checked');
    const parts: string[] = [];
    if (degraded.length) parts.push(`${listLabels(degraded)} ${degraded.length === 1 ? 'is' : 'are'} running with some Portal features off.`);
    if (available.length) parts.push(`Updates are available for ${listLabels(available)}.`);
    if (waitingText) parts.push(waitingText);
    const other = attention.length - degraded.length - available.length - unknown.length - unchecked.length;
    if (other > 0) parts.push(`${other} ${other === 1 ? 'tool needs' : 'tools need'} attention.`);
    if (unknown.length) parts.push(`${unknown.length} ${unknown.length === 1 ? 'tool is' : 'tools are'} being checked.`);
    if (unchecked.length) parts.push(`${listLabels(unchecked)} ${unchecked.length === 1 ? 'is' : 'are'} not checked yet.`);
    return { status: 'attention', text: parts.join(' '), counts };
  }
  if (waitingText) {
    const others = tools.some((tool) => tool.status === 'ok');
    return { status: 'ok', text: others ? `${waitingText} The other installed AI tools are up to date.` : waitingText, counts };
  }
  return { status: 'ok', text: 'All installed AI tools are up to date.', counts };
}

function listLabels(tools: ToolStatusItem[]): string {
  const labels = tools.map((tool) => tool.label);
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Tools whose runs this Portal's toolctl accepts (the wave-3 contract); other tools stay read-only. */
export const RUNNABLE_TOOLS: ReadonlySet<string> = new Set(TOOLS_RUN_TOOLS);
const NO_TOOLS: ReadonlySet<string> = new Set();

/** The release's tool policy when it is valid (floors and tested versions for other maintenance views). */
export function readToolPolicy(paths: ToolsPaths = defaultToolsPaths()): ToolPolicy | null {
  const raw = readJsonFile<ToolPolicy>(paths.policyPath);
  return raw && !policyShapeError(raw) ? raw : null;
}

/**
 * F5: per tool, the installed version its newest version-reading Re-check read and refused as not admitted
 * (HARNESS_VERSION_NOT_ADMISSIBLE). A refusal before the read changed nothing and is passed over; any newer read, or
 * any newer finished run that was not refused (it may have changed the tool), ends it. Runs are newest first.
 */
export function checkedVersionsByTool(runs: ToolRunStatus[]): Map<string, string | null> {
  const checked = new Map<string, string | null>();
  for (const run of runs) {
    if (!TERMINAL_RUN_STATES.has(run.state) || checked.has(run.tool)) continue;
    const read = run.state === 'refused' && run.result?.action === 'requalify' ? run.result.installedVersion : null;
    const known = typeof read === 'string' && parseVersion(read) ? read : null;
    if (run.state === 'refused' && !known) continue;
    checked.set(run.tool, known && run.error?.id === 'HARNESS_VERSION_NOT_ADMISSIBLE' ? known : null);
  }
  return checked;
}

/** Same bound as toolctl `reconcile --stale-queued-seconds`: a queued run this old never started. */
export const TOOLS_STALE_QUEUED_MS = 10 * 60_000;

export function buildToolsStatus(
  snapshot: ToolsSnapshot,
  options: {
    processAlive?: (pid: number) => boolean;
    runnableTools?: ReadonlySet<string>;
    lastGood?: ReadonlyMap<string, ToolLastGood>;
  } = {},
): ToolsStatus {
  const processAlive = options.processAlive || defaultProcessAlive;
  // A queued run whose unit never started changed nothing (toolctl reconcile
  // marks it TOOLS_RUN_NEVER_STARTED); it must not block new runs meanwhile.
  const neverStarted = (run: ToolRunStatus) => run.state === 'queued'
    && snapshot.lockOwner?.runId !== run.runId
    && snapshot.generatedAtMs - Date.parse(String(run.createdAt || '')) >= TOOLS_STALE_QUEUED_MS;
  const activeRun = snapshot.runs.find((run) => !TERMINAL_RUN_STATES.has(run.state) && !neverStarted(run)) || null;
  const ownerMatches = Boolean(activeRun && snapshot.lockOwner?.runId === activeRun.runId);
  const activeRunStale = Boolean(activeRun && activeRun.state !== 'queued'
    && !(ownerMatches && ownerAlive(snapshot.lockOwner, snapshot.bootId, processAlive)));
  const recovery = deriveRecovery(snapshot, activeRunStale, activeRun);
  const lastRunByTool = new Map<string, ToolRunStatus>();
  const lastPreflightByTool = new Map<string, ToolRunStatus>();
  const lastOutcomeByTool = new Map<string, ToolRunStatus>();
  for (const run of snapshot.runs) {
    if (TERMINAL_RUN_STATES.has(run.state) && !lastRunByTool.has(run.tool)) lastRunByTool.set(run.tool, run);
    if (TERMINAL_RUN_STATES.has(run.state) && run.state !== 'refused' && run.result?.action !== 'preflight'
      && !lastOutcomeByTool.has(run.tool)) lastOutcomeByTool.set(run.tool, run);
    if (TERMINAL_RUN_STATES.has(run.state) && run.result && 'preflight' in run.result && !lastPreflightByTool.has(run.tool)) {
      lastPreflightByTool.set(run.tool, run);
    }
  }
  const checkedVersions = checkedVersionsByTool(snapshot.runs);
  const tools = (snapshot.policy?.tools || []).map((tool) => buildToolItem(
    tool,
    snapshot.installed[tool.id] || { version: null, admittedAt: null, admission: 'none', source: null },
    {
      recovery,
      activeRun,
      lastRun: lastRunByTool.get(tool.id) || null,
      runnableTools: snapshot.runner.installed ? options.runnableTools || RUNNABLE_TOOLS : NO_TOOLS,
      read: snapshot.installedReads?.[tool.id],
      drift: snapshot.drift?.[tool.id] || null,
      lastGood: options.lastGood?.get(tool.id) || null,
      nowMs: snapshot.generatedAtMs,
      lastPreflight: lastPreflightByTool.get(tool.id) || null,
      lastOutcome: lastOutcomeByTool.get(tool.id) || null,
      checkedVersion: checkedVersions.get(tool.id) || null,
      coreUpdatesHeld: openClawCoreUpdatesHeld(snapshot.policy),
    },
  ));
  const summary = snapshot.policy
    ? computeToolsSummary(tools, recovery)
    : { status: 'blocked' as const, text: 'This Portal\'s tool policy could not be read.', counts: {} };
  return {
    schema: TOOLS_STATUS_SCHEMA,
    generatedAt: new Date(snapshot.generatedAtMs).toISOString(),
    policy: {
      valid: !snapshot.policyError,
      revision: snapshot.policy?.policyRevision ?? null,
      sha256: snapshot.policySha256,
      error: snapshot.policyError,
      defaultChannel: snapshot.policy?.openclaw.defaultChannel ?? null,
      channels: snapshot.policy?.openclaw.channels ?? [],
    },
    runner: snapshot.runner,
    recovery,
    activeRun: activeRun ? {
      runId: activeRun.runId,
      tool: activeRun.tool,
      phase: activeRun.phase,
      state: activeRun.state,
      startedAt: activeRun.createdAt,
      steps: activeRun.steps,
      nativePhase: nativePhaseOf(activeRun),
      gatewayRestarting: inGatewayRestartWindow(activeRun),
      stale: activeRunStale,
      action: boundedText(activeRun.action, 40),
      stopRefusal: toolsRunStopRefusal(activeRun, activeRunStale),
    } : null,
    tools,
    summary,
    history: snapshot.history,
  };
}

// ---------------------------------------------------------------------------
// Cached, single-flight service
// ---------------------------------------------------------------------------

export type ToolsStatusServiceOptions = {
  paths?: ToolsPaths;
  nowMs?: () => number;
  ttlMs?: number;
  activeTtlMs?: number;
  processAlive?: (pid: number) => boolean;
  readSnapshot?: (paths: ToolsPaths, nowMs: number) => ToolsSnapshot;
};

export class ToolsStatusService {
  private cache: { at: number; value: ToolsStatus } | null = null;
  private inflight: Promise<ToolsStatus> | null = null;
  /** Last successful installed read per tool, shown (with its age) while a read fails (F2). */
  private readonly lastGood = new Map<string, ToolLastGood>();
  private readonly nowMs: () => number;

  private rememberLastGood(snapshot: ToolsSnapshot): void {
    const observedAt = new Date(snapshot.generatedAtMs).toISOString();
    for (const [toolId, installed] of Object.entries(snapshot.installed)) {
      const read = snapshot.installedReads?.[toolId] ?? (installed.version ? 'ok' : 'unreadable');
      if (installed.version && read === 'ok') this.lastGood.set(toolId, { installed, observedAt });
      else if (read === 'absent') this.lastGood.delete(toolId);
    }
  }

  constructor(private readonly options: ToolsStatusServiceOptions = {}) {
    this.nowMs = options.nowMs || Date.now;
  }

  get paths(): ToolsPaths {
    return this.options.paths || defaultToolsPaths();
  }

  private ttl(value: ToolsStatus): number {
    return value.activeRun
      ? (this.options.activeTtlMs ?? TOOLS_STATUS_ACTIVE_TTL_MS)
      : (this.options.ttlMs ?? TOOLS_STATUS_CACHE_TTL_MS);
  }

  async get(force = false): Promise<ToolsStatus> {
    if (!force && this.cache && this.nowMs() - this.cache.at < this.ttl(this.cache.value)) {
      return this.cache.value;
    }
    if (this.inflight) return this.inflight;
    const refresh = Promise.resolve()
      .then(() => {
        const snapshot = (this.options.readSnapshot || readToolsSnapshot)(this.paths, this.nowMs());
        const status = buildToolsStatus(snapshot, { processAlive: this.options.processAlive, lastGood: this.lastGood });
        this.rememberLastGood(snapshot);
        return status;
      })
      .then((value) => {
        this.cache = { at: this.nowMs(), value };
        return value;
      })
      .finally(() => {
        if (this.inflight === refresh) this.inflight = null;
      });
    this.inflight = refresh;
    return refresh;
  }

  invalidate(): void {
    this.cache = null;
  }
}

export const toolsStatusService = new ToolsStatusService();

// ---------------------------------------------------------------------------
// Queuing a run (the backend runs as root; toolctl revalidates everything)
// ---------------------------------------------------------------------------

export type ToolsRunRequest = {
  schema: typeof TOOLS_REQUEST_SCHEMA;
  runId: string;
  tool: string;
  action: ToolsRunAction;
  target: (typeof TOOLS_RUN_TARGETS)[number];
  /** OpenClaw only; null for the npm CLIs. */
  channel: string | null;
  requestedBy: string;
  requestedAt: string;
  portalVersion: string | null;
  policySha256: string | null;
  /** nodeRuntime: the owner ticked "also update Node.js" (openclaw `update` only). */
  acknowledgements: { confirmation: boolean; maintenanceWindow: boolean; nodeRuntime?: boolean };
  backup: { path: string; receiptDigest: string } | null;
};

export type ToolsRunLauncher = (runId: string) => Promise<void>;
/** Asks toolctl to stop the run; it stops at its next safe point (SIGTERM to toolctl only, never SIGKILL). */
export type ToolsRunStopper = (runId: string) => Promise<void>;

/**
 * SIGTERM to toolctl alone (`systemctl kill --kill-who=main`), no shell. Never `systemctl stop`: the unit's
 * KillMode=control-group would signal every child directly, including an installer or helper that is mid-switch.
 * toolctl records the stop, forwards it only to children that may be interrupted, and stops at its next check.
 * `--kill-who` (not the newer `--kill-whom`) is the spelling every supported systemd accepts.
 */
export const SYSTEMD_TOOLS_RUN_STOP_ARGS = (runId: string): string[] =>
  ['kill', '--kill-who=main', '--signal=SIGTERM', `bridgesllm-tools@${runId}.service`];

export const systemdToolsRunStopper: ToolsRunStopper = (runId) => new Promise((resolve, reject) => {
  if (!TOOLS_RUN_ID_PATTERN.test(runId)) {
    reject(new Error('invalid run id'));
    return;
  }
  execFile('systemctl', SYSTEMD_TOOLS_RUN_STOP_ARGS(runId), { timeout: 15_000 }, (error) => {
    if (error) reject(new Error(`systemctl could not stop the tools run: ${error.message}`.slice(0, 400)));
    else resolve();
  });
});

/** `systemctl start --no-block bridgesllm-tools@<runId>.service`, no shell. */
export const systemdToolsRunLauncher: ToolsRunLauncher = (runId) => new Promise((resolve, reject) => {
  if (!TOOLS_RUN_ID_PATTERN.test(runId)) {
    reject(new Error('invalid run id'));
    return;
  }
  execFile('systemctl', ['start', '--no-block', `bridgesllm-tools@${runId}.service`], { timeout: 15_000 }, (error) => {
    if (error) reject(new Error(`systemctl could not start the tools run: ${error.message}`.slice(0, 400)));
    else resolve();
  });
});

export type ToolsUnitStarter = (args: string[], done: (error: Error | null) => void) => void;

const systemctlStarter: ToolsUnitStarter = (args, done) => {
  execFile('systemctl', args, { timeout: 15_000 }, (error) => done(error));
};

/** The one argv that starts toolctl reconcile, at Portal start and from Maintenance (no shell). */
export const TOOLS_RECONCILE_START_ARGS: readonly string[] = ['start', '--no-block', 'bridgesllm-tools-reconcile.service'];

/** The owner's "Check interrupted update": start the reconcile unit now; rejects with a bounded reason. */
export function startToolsReconcile(start: ToolsUnitStarter = systemctlStarter): Promise<void> {
  return new Promise((resolve, reject) => {
    start([...TOOLS_RECONCILE_START_ARGS], (error) => {
      if (error) reject(new Error(`systemctl could not start the AI tools check: ${error.message}`.slice(0, 400)));
      else resolve();
    });
  });
}

/**
 * Once per Portal start: `systemctl start --no-block bridgesllm-tools-reconcile.service`,
 * no shell (DESIGN c.6, h.1). It settles runs a crash left open and retires legacy
 * gateway drop-ins (h.4). While a Portal update holds the installer operation lock,
 * toolctl reconcile changes nothing and exits 0; the boot unit or the next start
 * runs it again. Hosts without the runner skip it.
 */
export function startToolsReconcileAtPortalStart(
  paths: ToolsPaths = defaultToolsPaths(),
  start: ToolsUnitStarter = systemctlStarter,
): boolean {
  if (!readToolsRunnerState(paths).installed) return false;
  start([...TOOLS_RECONCILE_START_ARGS], (error) => {
    if (error) console.warn(`[tools] start-up reconcile could not be started: ${error.message}`.slice(0, 400));
  });
  return true;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(path.dirname(directory));
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory} is not a real directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${directory} is not owned by the Portal service user`);
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
}

/** tmp + fsync + rename + directory fsync, file mode 0600. */
export function atomicWriteJson(target: string, value: unknown): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  fsyncDirectory(directory);
}

export function queuedRunStatus(runId: string, tool: string, nowIso: string): ToolRunStatus {
  return {
    schema: TOOLS_RUN_SCHEMA,
    runId,
    tool,
    phase: 'queued',
    phaseStartedAt: nowIso,
    state: 'queued',
    createdAt: nowIso,
    updatedAt: nowIso,
    steps: [],
    native: null,
    error: null,
    result: null,
  };
}

/** Create the private run directory (exclusively) with request.json and a queued status. */
export function writeToolsRunRequest(paths: ToolsPaths, request: ToolsRunRequest): ToolRunStatus {
  if (!TOOLS_RUN_ID_PATTERN.test(request.runId)) throw new Error('invalid run id');
  if (!fs.existsSync(path.dirname(paths.stateRoot))) throw new Error(`${path.dirname(paths.stateRoot)} does not exist`);
  ensurePrivateDirectory(paths.stateRoot);
  const runsDir = path.join(paths.stateRoot, 'runs');
  ensurePrivateDirectory(runsDir);
  const runDir = path.join(runsDir, request.runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
  fsyncDirectory(runsDir);
  atomicWriteJson(path.join(runDir, 'request.json'), request);
  const status = queuedRunStatus(request.runId, request.tool, request.requestedAt);
  atomicWriteJson(path.join(runDir, 'status.json'), status);
  return status;
}

/** Record a run the runner never received (launch failure); toolctl leaves terminal runs alone. */
export function markToolsRunLaunchFailed(paths: ToolsPaths, runId: string, message: string, nowIso: string): void {
  const statusPath = path.join(paths.stateRoot, 'runs', runId, 'status.json');
  const status = readJsonFile<ToolRunStatus>(statusPath);
  if (!status || status.state !== 'queued') return;
  const failed: ToolRunStatus = {
    ...status,
    phase: 'failed',
    state: 'failed',
    phaseStartedAt: nowIso,
    updatedAt: nowIso,
    endedAt: nowIso,
    error: { id: 'TOOLS_RUN_LAUNCH_FAILED', message: 'The update could not be started. Nothing was changed.' },
  };
  atomicWriteJson(statusPath, failed);
  const line = `${JSON.stringify({
    schema: TOOLS_HISTORY_SCHEMA,
    runId,
    tool: status.tool,
    action: null,
    from: null,
    to: null,
    outcome: 'failed',
    errorId: 'TOOLS_RUN_LAUNCH_FAILED',
    startedAt: status.createdAt,
    endedAt: nowIso,
    durationMs: null,
    reportPath: path.join('runs', runId, 'status.json'),
  })}\n`;
  console.warn(`[tools] run ${runId} could not be launched: ${message.slice(0, 200)}`);
  const descriptor = fs.openSync(path.join(paths.stateRoot, 'history.jsonl'),
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(descriptor, line);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
