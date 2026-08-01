import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'fs';
import { once } from 'events';
import path from 'path';
import {
  getDefaultAgentZeroAuthSessionManager,
  type AgentZeroSessionProvider,
} from './AgentZeroAuthSession';
import {
  AgentZeroConnectorClient,
  type AgentZeroCapabilities,
} from './AgentZeroConnectorClient';
import { safeAgentZeroStatusMessage } from './AgentZeroDiagnostics';
import { redactNativeProviderText } from '../native/NativeProviderDiagnostics';
import {
  probeAgentZeroRuntime,
  type AgentZeroRuntimeStatus,
} from './AgentZeroRuntime';

export const AGENT_ZERO_HOST_GATEWAY_CLI_VERSION = '2.5';
export const AGENT_ZERO_HOST_GATEWAY_CLI_TAG = 'v2.5';
export const AGENT_ZERO_HOST_GATEWAY_CLI_COMMIT = 'db0e53eba65326ee0792cbb007abfda31114b3f2';
export const AGENT_ZERO_HOST_GATEWAY_ARCHIVE_SHA256 =
  '97cc0396b55e517775a0790d974d4c81c6534926fead01b02d150807180521b6';
export const AGENT_ZERO_HOST_GATEWAY_RUNTIME_CONSTRAINTS_SHA256 =
  'bfe27824fca3f23ffc4a1b06b8b2194d59db48ebaeb05c09ca1e46332075a327';
export const AGENT_ZERO_HOST_GATEWAY_BUILD_CONSTRAINTS_SHA256 =
  '7ded8dd591c408dfbe552eeffacb5e75dcddb02cd3072c8cec3653494a37aa19';

export const AGENT_ZERO_HOST_GATEWAY_BINARY =
  '/var/lib/bridgesllm/agent-zero-runtime/a0-cli/bin/a0';
export const AGENT_ZERO_HOST_GATEWAY_PROVENANCE =
  '/var/lib/bridgesllm/agent-zero-runtime/a0-cli/PROVENANCE';
export const AGENT_ZERO_HOST_GATEWAY_HOME =
  '/var/lib/bridgesllm/agent-zero-runtime/host-gateway-home';
export const AGENT_ZERO_HOST_GATEWAY_SESSION_DIRECTORY =
  `${AGENT_ZERO_HOST_GATEWAY_HOME}/.agent-zero`;
export const AGENT_ZERO_HOST_GATEWAY_SESSION_FILE =
  `${AGENT_ZERO_HOST_GATEWAY_SESSION_DIRECTORY}/session_cookies.json`;
export const AGENT_ZERO_HOST_GATEWAY_ID = 'bridgesllm-portal-host';
export const AGENT_ZERO_HOST_GATEWAY_LABEL = 'BridgesLLM Portal host';
export const AGENT_ZERO_HOST_GATEWAY_URL = 'http://127.0.0.1:50001';
export const AGENT_ZERO_HOST_GATEWAY_WORKSPACE = '/';

const START_TIMEOUT_MS = 20_000;
const REMOTE_STATUS_TIMEOUT_MS = 10_000;
const REMOTE_REGISTRATION_POLL_MS = 100;
const STOP_GRACE_MS = 2_000;
const MAX_JSONL_LINE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type ExecFileImplementation = (command: string, args: string[], timeoutMs?: number) => string;

type UnknownRecord = Record<string, unknown>;

export interface AgentZeroHostCapabilities {
  readonly scope: 'HOST_OPERATOR';
  readonly fileRead: true;
  readonly fileWrite: true;
  readonly codeExecution: true;
  readonly browser: false;
  readonly computerUse: false;
}

export interface AgentZeroHostGatewayStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error';
  installed: boolean;
  running: boolean;
  ready: boolean;
  cliVersion?: string;
  expectedCliVersion: typeof AGENT_ZERO_HOST_GATEWAY_CLI_VERSION;
  gatewayId: typeof AGENT_ZERO_HOST_GATEWAY_ID;
  capabilities: AgentZeroHostCapabilities;
  reason: string;
}

export interface AgentZeroHostGatewayController {
  ensureReady(): Promise<AgentZeroHostGatewayStatus>;
  snapshot(): AgentZeroHostGatewayStatus;
  stop(): Promise<void>;
}

export interface AgentZeroHostGatewayOptions {
  client?: AgentZeroHostGatewayConnectorClient;
  sessionProvider?: AgentZeroSessionProvider;
  persistSession?: (cookieHeader: string) => void;
  binaryPath?: string;
  provenancePath?: string;
  runtimeProbe?: () => AgentZeroRuntimeStatus;
  spawnImpl?: SpawnImplementation;
  execFileImpl?: ExecFileImplementation;
  readFile?: (path: string) => string;
  statFile?: (path: string) => Stats;
  startTimeoutMs?: number;
  remoteStatusTimeoutMs?: number;
}

export interface AgentZeroHostGatewaySessionFileOptions {
  homePath?: string;
  statFile?: (path: string) => Stats;
  mkdir?: (path: string, options: { mode: number }) => void;
  writeFile?: (
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode: number; flag: 'wx' },
  ) => void;
  rename?: (source: string, destination: string) => void;
  chmod?: (path: string, mode: number) => void;
  unlink?: (path: string) => void;
}

export interface AgentZeroHostGatewayConnectorClient {
  getCapabilities(forceRefresh?: boolean): Promise<AgentZeroCapabilities>;
  call<T = Record<string, unknown>>(
    feature: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
}

export class AgentZeroHostGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentZeroHostGatewayError';
  }
}

const REQUIRED_PROVENANCE = {
  A0_CLI_VERSION: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
  A0_CLI_TAG: AGENT_ZERO_HOST_GATEWAY_CLI_TAG,
  A0_CLI_COMMIT: AGENT_ZERO_HOST_GATEWAY_CLI_COMMIT,
  A0_CLI_ARCHIVE_SHA256: AGENT_ZERO_HOST_GATEWAY_ARCHIVE_SHA256,
  A0_CLI_RUNTIME_CONSTRAINTS_SHA256: AGENT_ZERO_HOST_GATEWAY_RUNTIME_CONSTRAINTS_SHA256,
  A0_CLI_BUILD_CONSTRAINTS_SHA256: AGENT_ZERO_HOST_GATEWAY_BUILD_CONSTRAINTS_SHA256,
} as const;

const HOST_CAPABILITIES: AgentZeroHostCapabilities = Object.freeze({
  scope: 'HOST_OPERATOR',
  fileRead: true,
  fileWrite: true,
  codeExecution: true,
  browser: false,
  computerUse: false,
});

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function stoppedStatus(reason: string): AgentZeroHostGatewayStatus {
  return {
    state: 'stopped',
    installed: false,
    running: false,
    ready: false,
    expectedCliVersion: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
    gatewayId: AGENT_ZERO_HOST_GATEWAY_ID,
    capabilities: HOST_CAPABILITIES,
    reason,
  };
}

function parseProvenance(payload: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._:-]+)$/);
    if (!match || !(match[1] in REQUIRED_PROVENANCE) || values.has(match[1])) {
      throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway provenance is invalid.');
    }
    values.set(match[1], match[2]);
  }
  for (const [key, expected] of Object.entries(REQUIRED_PROVENANCE)) {
    if (values.get(key) !== expected) {
      throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway provenance is outside the tested v2.5 pin.');
    }
  }
  return values;
}

function assertProtectedRootFile(path: string, statFile: (path: string) => Stats, executable = false): void {
  if (!path.startsWith('/') || path.includes('\u0000')) {
    throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway path is invalid.');
  }
  let stat: Stats;
  try {
    assertProtectedDirectoryChain(pathModuleDirname(path), statFile);
    stat = statFile(path);
  } catch {
    throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway component is not installed.');
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== 0
    || (stat.mode & 0o022) !== 0
    || (executable && (stat.mode & 0o100) === 0)
  ) {
    throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway component is not root-protected.');
  }
}

function assertProtectedDirectoryChain(
  directoryPath: string,
  statFile: (path: string) => Stats,
  requirePrivateLeaf = false,
): void {
  let directory = directoryPath;
  while (true) {
    const directoryStat = statFile(directory);
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== 0
      || (directoryStat.mode & 0o022) !== 0
      || (requirePrivateLeaf && directory === directoryPath && (directoryStat.mode & 0o077) !== 0)
    ) {
      throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway directory is not root-protected.');
    }
    if (directory === '/') break;
    const parent = pathModuleDirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function pathModuleDirname(filePath: string): string {
  return path.posix.dirname(filePath);
}

function validateLocalGatewayStatus(value: unknown): void {
  if (!isRecord(value) || value.type !== 'status') {
    throw new AgentZeroHostGatewayError('Agent Zero host gateway returned malformed readiness data.');
  }
  if (value.host !== AGENT_ZERO_HOST_GATEWAY_URL || value.workspace !== AGENT_ZERO_HOST_GATEWAY_WORKSPACE) {
    throw new AgentZeroHostGatewayError('Agent Zero host gateway escaped its tested local host contract.');
  }
  validateGatewayMetadata(value.gateway, 'local');
}

function validateGatewayMetadata(value: unknown, source: 'local' | 'remote'): void {
  if (!isRecord(value)) {
    throw new AgentZeroHostGatewayError(`Agent Zero ${source} host-gateway metadata is malformed.`);
  }
  const scopes = isRecord(value.scopes) ? value.scopes : {};
  const scopeKeys = Object.keys(scopes).sort();
  const expectedScopeKeys = [
    'browser',
    'code_execution',
    'computer_use',
    'file_write',
    'files',
  ];
  const exact = value.version === 1
    && value.kind === 'launcher'
    && value.id === AGENT_ZERO_HOST_GATEWAY_ID
    && value.host_label === AGENT_ZERO_HOST_GATEWAY_LABEL
    && value.state === 'connected'
    && value.master_enabled === true
    && scopeKeys.length === expectedScopeKeys.length
    && scopeKeys.every((key, index) => key === expectedScopeKeys[index])
    && scopes.files === true
    && scopes.file_write === true
    && scopes.code_execution === true
    && scopes.browser === false
    && scopes.computer_use === false;
  if (!exact) {
    throw new AgentZeroHostGatewayError(
      `Agent Zero ${source} host gateway did not acknowledge the exact read/write/exec capability contract.`,
    );
  }
}

function validateRemoteGatewayStatus(value: unknown): void {
  if (!isRecord(value)) {
    throw new AgentZeroHostGatewayError('Agent Zero remote host-gateway status is malformed.');
  }
  if (value.multiple_hosts !== false) {
    throw new AgentZeroHostGatewayError('Agent Zero reported an ambiguous host-gateway topology.');
  }
  if (value.connected !== true || value.state !== 'connected') {
    throw new AgentZeroHostGatewayError('Agent Zero did not report one connected Portal host gateway.');
  }
  if (!Array.isArray(value.gateways) || value.gateways.length !== 1) {
    throw new AgentZeroHostGatewayError('Agent Zero reported an ambiguous host-gateway topology.');
  }
  if (!isRecord(value.gateway)
    || !isRecord(value.gateways[0])
    || value.gateway.state !== value.state
    || value.gateways[0].state !== value.state) {
    throw new AgentZeroHostGatewayError(
      'Agent Zero host-gateway readiness state disagreed between the remote status layers.',
    );
  }
  validateGatewayMetadata(value.gateway, 'remote');
  validateGatewayMetadata(value.gateways[0], 'remote');
}

function remoteGatewayRegistrationPending(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.connected === false
    && value.multiple_hosts === false
    && ['stopped', 'disconnected', 'not_connected', 'idle'].includes(String(value.state || ''))
    && value.gateway === null
    && Array.isArray(value.gateways)
    && value.gateways.length === 0;
}

function remoteReadinessFailure(stage: string, error: unknown): AgentZeroHostGatewayError {
  const detail = error instanceof Error
    ? redactNativeProviderText(error.message, 320)
    : safeAgentZeroStatusMessage(error, 320);
  return new AgentZeroHostGatewayError(
    detail
      ? `Agent Zero host-gateway ${stage} failed: ${detail}`
      : `Agent Zero host-gateway ${stage} failed.`,
  );
}

function defaultExecFile(command: string, args: string[], timeoutMs = 5_000): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Math.max(1, Math.min(5_000, Math.floor(timeoutMs))),
    maxBuffer: 256 * 1024,
  }).trim();
}

function processEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: AGENT_ZERO_HOST_GATEWAY_HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
}

function sessionCookieRecords(cookieHeader: string): Array<Record<string, unknown>> {
  const header = String(cookieHeader || '').trim();
  if (!header || header.length > 4096 || /[\u0000-\u001F\u007F]/.test(header)) {
    throw new AgentZeroHostGatewayError('Agent Zero protected web session is malformed.');
  }
  const records: Array<Record<string, unknown>> = [];
  const names = new Set<string>();
  for (const rawPair of header.split(';')) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    const name = separator > 0 ? pair.slice(0, separator).trim() : '';
    const value = separator > 0 ? pair.slice(separator + 1).trim() : '';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
      || !value
      || value.length > 2048
      || /[\u0000-\u001F\u007F;,]/.test(value)
      || names.has(name)) {
      throw new AgentZeroHostGatewayError('Agent Zero protected web session is malformed.');
    }
    names.add(name);
    records.push({
      name,
      value,
      domain: '127.0.0.1',
      path: '/',
      secure: false,
      expires: null,
    });
  }
  if (records.length === 0 || records.length > 20) {
    throw new AgentZeroHostGatewayError('Agent Zero protected web session is malformed.');
  }
  return records;
}

function safeLstat(statFile: (path: string) => Stats, target: string): Stats | null {
  try {
    return statFile(target);
  } catch {
    return null;
  }
}

/**
 * Persist only the already-authenticated browser cookie for official A0 CLI
 * session restoration. Login credentials never enter the gateway process
 * environment, where its intentional HOST_OPERATOR shell could inherit them.
 */
export function writeAgentZeroHostGatewaySession(
  cookieHeader: string,
  options: AgentZeroHostGatewaySessionFileOptions = {},
): void {
  const homePath = options.homePath || AGENT_ZERO_HOST_GATEWAY_HOME;
  const sessionDirectory = `${homePath}/.agent-zero`;
  const sessionFile = `${sessionDirectory}/session_cookies.json`;
  const statFile = options.statFile || lstatSync;
  const mkdir = options.mkdir || ((target, mkdirOptions) => mkdirSync(target, mkdirOptions));
  const writeFile = options.writeFile || ((target, data, writeOptions) => writeFileSync(target, data, writeOptions));
  const rename = options.rename || renameSync;
  const chmod = options.chmod || chmodSync;
  const unlink = options.unlink || unlinkSync;

  assertProtectedDirectoryChain(homePath, statFile, true);
  const currentDirectory = safeLstat(statFile, sessionDirectory);
  if (!currentDirectory) mkdir(sessionDirectory, { mode: 0o700 });
  assertProtectedDirectoryChain(sessionDirectory, statFile, true);

  const existing = safeLstat(statFile, sessionFile);
  if (existing && (
    !existing.isFile()
    || existing.isSymbolicLink()
    || existing.uid !== 0
    || (existing.mode & 0o077) !== 0
  )) {
    throw new AgentZeroHostGatewayError('Agent Zero gateway session file is not root-protected.');
  }

  const payload = JSON.stringify({
    version: 1,
    hosts: {
      [AGENT_ZERO_HOST_GATEWAY_URL]: sessionCookieRecords(cookieHeader),
    },
  });
  const temporary = `${sessionDirectory}/.session_cookies.portal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFile(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmod(temporary, 0o600);
    rename(temporary, sessionFile);
    chmod(sessionFile, 0o600);
  } catch (error) {
    try {
      unlink(temporary);
    } catch {
      // The atomic temporary may not have been created yet.
    }
    throw error instanceof AgentZeroHostGatewayError
      ? error
      : new AgentZeroHostGatewayError('Could not persist the protected Agent Zero gateway session.');
  }
}

function gatewayArguments(): string[] {
  return [
    'gateway',
    '--host', AGENT_ZERO_HOST_GATEWAY_URL,
    '--workspace', AGENT_ZERO_HOST_GATEWAY_WORKSPACE,
    '--gateway-id', AGENT_ZERO_HOST_GATEWAY_ID,
    '--host-label', AGENT_ZERO_HOST_GATEWAY_LABEL,
    '--master',
    '--scopes', 'file_read,file_write,code_execution',
  ];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

export class AgentZeroHostGatewayManager implements AgentZeroHostGatewayController {
  private readonly client: AgentZeroHostGatewayConnectorClient;
  private readonly sessionProvider: AgentZeroSessionProvider;
  private readonly persistSession: (cookieHeader: string) => void;
  private readonly binaryPath: string;
  private readonly provenancePath: string;
  private readonly runtimeProbe: () => AgentZeroRuntimeStatus;
  private readonly spawnImpl: SpawnImplementation;
  private readonly execFileImpl: ExecFileImplementation;
  private readonly readFile: (path: string) => string;
  private readonly statFile: (path: string) => Stats;
  private readonly startTimeoutMs: number;
  private readonly remoteStatusTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private status = stoppedStatus('Agent Zero host gateway has not been started.');
  private startPromise: Promise<AgentZeroHostGatewayStatus> | null = null;

  constructor(options: AgentZeroHostGatewayOptions = {}) {
    this.client = options.client || new AgentZeroConnectorClient();
    this.sessionProvider = options.sessionProvider || getDefaultAgentZeroAuthSessionManager();
    this.persistSession = options.persistSession || ((cookieHeader) => writeAgentZeroHostGatewaySession(cookieHeader));
    this.binaryPath = options.binaryPath || AGENT_ZERO_HOST_GATEWAY_BINARY;
    this.provenancePath = options.provenancePath || AGENT_ZERO_HOST_GATEWAY_PROVENANCE;
    this.runtimeProbe = options.runtimeProbe || (() => probeAgentZeroRuntime());
    this.spawnImpl = options.spawnImpl || ((command, args, spawnOptions) => (
      spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams
    ));
    this.execFileImpl = options.execFileImpl || defaultExecFile;
    this.readFile = options.readFile || ((path) => readFileSync(path, 'utf8'));
    this.statFile = options.statFile || lstatSync;
    this.startTimeoutMs = boundedInteger(options.startTimeoutMs, START_TIMEOUT_MS, 500, 120_000);
    this.remoteStatusTimeoutMs = boundedInteger(
      options.remoteStatusTimeoutMs,
      REMOTE_STATUS_TIMEOUT_MS,
      500,
      120_000,
    );
  }

  snapshot(): AgentZeroHostGatewayStatus {
    return {
      ...this.status,
      capabilities: HOST_CAPABILITIES,
    };
  }

  probeInstallation(): AgentZeroHostGatewayStatus {
    if (this.child && this.child.exitCode === null) return this.snapshot();
    try {
      this.verifyInstallation();
      this.status = {
        ...stoppedStatus('Official A0 CLI v2.5 host gateway is installed and will start on first authorized use.'),
        installed: true,
        cliVersion: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
      };
    } catch (error) {
      const reason = error instanceof AgentZeroHostGatewayError
        ? error.message
        : 'Managed Agent Zero host-gateway installation could not be verified.';
      this.status = { ...stoppedStatus(reason), state: 'error' };
    }
    return this.snapshot();
  }

  async ensureReady(): Promise<AgentZeroHostGatewayStatus> {
    if (this.startPromise) return this.startPromise;
    const deadline = Date.now() + this.startTimeoutMs;
    if (this.child && this.child.exitCode === null && this.status.ready) {
      const child = this.child;
      const pending = this.reverifyReadyChild(child, deadline);
      this.startPromise = pending;
      try {
        return await pending;
      } finally {
        if (this.startPromise === pending) this.startPromise = null;
      }
    }

    const pending = this.start(deadline);
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  async stop(deadline?: number): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) {
      this.status = stoppedStatus('Agent Zero host gateway is stopped.');
      return;
    }

    this.writeControl(child, { action: 'set_master', enabled: false });
    this.writeControl(child, {
      action: 'replace_scopes',
      scopes: {
        files: false,
        file_write: false,
        code_execution: false,
        browser: false,
        computer_use: false,
      },
    });
    this.writeControl(child, { action: 'shutdown' });

    const firstGraceMs = this.stopGraceRemaining(deadline);
    if (firstGraceMs <= 0 || !await this.waitForExit(child, firstGraceMs)) {
      child.kill('SIGTERM');
      const secondGraceMs = this.stopGraceRemaining(deadline);
      if (child.exitCode === null
        && (secondGraceMs <= 0 || !await this.waitForExit(child, secondGraceMs))) {
        child.kill('SIGKILL');
      }
    }
    this.status = stoppedStatus('Agent Zero host gateway is stopped.');
  }

  private async reverifyReadyChild(
    child: ChildProcessWithoutNullStreams,
    deadline: number,
  ): Promise<AgentZeroHostGatewayStatus> {
    try {
      await this.verifyRemoteReadiness(child, false, deadline);
      return this.snapshot();
    } catch (error) {
      await this.stop(deadline).catch(() => undefined);
      throw error;
    }
  }

  private async start(deadline: number): Promise<AgentZeroHostGatewayStatus> {
    const runtime = this.runtimeProbe();
    this.assertWithinReadinessDeadline(deadline);
    if (!runtime.ready) {
      throw this.fail(`Managed Agent Zero runtime is unavailable: ${runtime.reason}`);
    }

    try {
      this.verifyInstallation(deadline);
    } catch (error) {
      throw this.recordFailure(
        error,
        'Managed Agent Zero host-gateway installation could not be verified.',
        false,
      );
    }
    this.assertWithinReadinessDeadline(deadline);
    let sessionCookie: string;
    try {
      sessionCookie = await this.runWithinReadinessDeadline(
        () => this.sessionProvider.getSessionCookie(),
        deadline,
        'Agent Zero host gateway did not obtain its protected session within the readiness deadline.',
      );
    } catch (error) {
      throw this.recordFailure(
        error,
        'Agent Zero host gateway could not obtain its protected session.',
        true,
      );
    }
    try {
      this.persistSession(sessionCookie);
    } catch (error) {
      throw this.recordFailure(
        error,
        'Agent Zero host gateway could not persist its protected session.',
        true,
      );
    }
    this.assertWithinReadinessDeadline(deadline);
    this.status = {
      state: 'starting',
      installed: true,
      running: false,
      ready: false,
      cliVersion: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
      expectedCliVersion: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION,
      gatewayId: AGENT_ZERO_HOST_GATEWAY_ID,
      capabilities: HOST_CAPABILITIES,
      reason: 'Starting the authenticated Agent Zero host gateway.',
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(this.binaryPath, gatewayArguments(), {
        cwd: AGENT_ZERO_HOST_GATEWAY_WORKSPACE,
        env: processEnvironment(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw this.fail('Managed Agent Zero host gateway could not be started.', true);
    }
    this.child = child;
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.status = {
        ...stoppedStatus('Agent Zero host gateway exited and host access was disabled.'),
        state: 'error',
        installed: true,
      };
    });
    child.once('error', () => {
      if (this.child !== child) return;
      this.child = null;
      this.status = {
        ...stoppedStatus('Agent Zero host gateway process failed and host access was disabled.'),
        state: 'error',
        installed: true,
      };
    });
    this.status = { ...this.status, running: true };

    try {
      this.assertWithinReadinessDeadline(deadline);
      await this.waitForLocalReadiness(child, deadline);
      await this.verifyRemoteReadiness(child, true, deadline);
      if (this.child !== child || child.exitCode !== null) {
        throw new AgentZeroHostGatewayError('Agent Zero host gateway exited during readiness verification.');
      }
      this.status = {
        ...this.status,
        state: 'ready',
        installed: true,
        running: true,
        ready: true,
        reason: 'Agent Zero v2.5 host gateway is authenticated with read/write/exec access.',
      };
      return this.snapshot();
    } catch (error) {
      await this.stop(deadline).catch(() => undefined);
      throw this.recordFailure(
        error,
        'Agent Zero host gateway failed readiness verification.',
        true,
      );
    }
  }

  private verifyInstallation(deadline?: number): void {
    assertProtectedDirectoryChain(AGENT_ZERO_HOST_GATEWAY_HOME, this.statFile, true);
    assertProtectedRootFile(this.binaryPath, this.statFile, true);
    assertProtectedRootFile(this.provenancePath, this.statFile);
    parseProvenance(this.readFile(this.provenancePath));

    let version = '';
    try {
      const remainingMs = deadline === undefined
        ? undefined
        : this.readinessRemainingMs(deadline);
      if (remainingMs !== undefined && remainingMs <= 0) {
        throw new AgentZeroHostGatewayError(
          'Agent Zero host gateway did not complete readiness within its hard deadline.',
        );
      }
      version = String(this.execFileImpl(this.binaryPath, ['--version'], remainingMs) || '')
        .trim()
        .replace(/^v/, '');
    } catch {
      if (deadline !== undefined && this.readinessRemainingMs(deadline) === 0) {
        throw new AgentZeroHostGatewayError(
          'Agent Zero host gateway did not complete readiness within its hard deadline.',
        );
      }
      throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway executable failed verification.');
    }
    if (deadline !== undefined) this.assertWithinReadinessDeadline(deadline);
    if (version !== AGENT_ZERO_HOST_GATEWAY_CLI_VERSION) {
      throw new AgentZeroHostGatewayError('Managed Agent Zero host-gateway executable is outside the tested v2.5 pin.');
    }

    // The runtime probe and shared authentication manager independently verify
    // the protected auth file. Never return credentials to the gateway path.
  }

  private waitForLocalReadiness(
    child: ChildProcessWithoutNullStreams,
    deadline: number,
  ): Promise<void> {
    const remainingMs = this.readinessRemainingMs(deadline);
    if (remainingMs <= 0) {
      return Promise.reject(new AgentZeroHostGatewayError(
        'Agent Zero host gateway did not become ready in time.',
      ));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = Buffer.alloc(0);
      let stderrBytes = 0;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onError = () => finish(new AgentZeroHostGatewayError('Agent Zero host gateway process failed.'));
      const onExit = () => finish(new AgentZeroHostGatewayError('Agent Zero host gateway exited before readiness.'));
      const onStderr = (chunk: Buffer | string) => {
        if (settled) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_STDERR_BYTES) {
          finish(new AgentZeroHostGatewayError('Agent Zero host gateway exceeded its diagnostic output bound.'));
        }
      };
      const onStdout = (chunk: Buffer | string) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
        if (stdoutBuffer.length > MAX_JSONL_LINE_BYTES && !stdoutBuffer.includes(0x0a)) {
          if (settled) child.kill('SIGTERM');
          else finish(new AgentZeroHostGatewayError('Agent Zero host gateway returned an oversized readiness record.'));
          return;
        }
        while (true) {
          const newline = stdoutBuffer.indexOf(0x0a);
          if (newline < 0) break;
          const line = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          if (line.length > MAX_JSONL_LINE_BYTES) {
            if (settled) child.kill('SIGTERM');
            else finish(new AgentZeroHostGatewayError('Agent Zero host gateway returned an oversized readiness record.'));
            return;
          }
          const text = line.toString('utf8').trim();
          if (!text) continue;
          let record: unknown;
          try {
            record = JSON.parse(text);
          } catch {
            if (settled) {
              child.kill('SIGTERM');
            } else {
              finish(new AgentZeroHostGatewayError('Agent Zero host gateway returned malformed JSONL.'));
            }
            return;
          }
          if (isRecord(record) && record.type === 'error' && record.fatal === true) {
            if (settled) {
              child.kill('SIGTERM');
            } else {
              finish(new AgentZeroHostGatewayError('Agent Zero host gateway reported a fatal startup error.'));
            }
            return;
          }
          if (!settled && isRecord(record) && record.type === 'status') {
            try {
              validateLocalGatewayStatus(record);
              finish();
            } catch (error) {
              finish(error instanceof Error ? error : new AgentZeroHostGatewayError('Invalid gateway status.'));
            }
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        finish(new AgentZeroHostGatewayError('Agent Zero host gateway did not become ready in time.'));
      }, remainingMs);
      timer.unref?.();
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  private async verifyRemoteReadiness(
    child: ChildProcessWithoutNullStreams,
    waitForRegistration: boolean,
    deadline: number,
  ): Promise<void> {
    const timeoutMessage = waitForRegistration
      ? 'Agent Zero host gateway did not complete remote registration in time.'
      : 'Agent Zero host gateway did not complete remote readiness verification in time.';
    let capabilities: AgentZeroCapabilities;
    try {
      capabilities = await this.runWhileChildHealthy(
        child,
        () => this.client.getCapabilities(),
        deadline,
        timeoutMessage,
      );
    } catch (error) {
      if (error instanceof AgentZeroHostGatewayError) throw error;
      throw remoteReadinessFailure('capability discovery', error);
    }
    if (!capabilities.features.includes('launcher_gateway')
      || !capabilities.features.includes('launcher_gateway_file_write')) {
      throw new AgentZeroHostGatewayError(
        'Agent Zero does not advertise the tested Launcher read/write host-gateway contract.',
      );
    }

    while (true) {
      const remainingMs = this.readinessRemainingMs(deadline);
      if (remainingMs === 0) throw new AgentZeroHostGatewayError(timeoutMessage);

      let raw: unknown;
      try {
        raw = await this.runWhileChildHealthy(
          child,
          () => this.client.call<unknown>(
            'launcher_gateway_status',
            {},
            Math.max(250, Math.min(this.remoteStatusTimeoutMs, remainingMs)),
          ),
          deadline,
          timeoutMessage,
        );
      } catch (error) {
        if (error instanceof AgentZeroHostGatewayError) throw error;
        throw remoteReadinessFailure('remote registration status check', error);
      }

      if (!remoteGatewayRegistrationPending(raw)) {
        validateRemoteGatewayStatus(raw);
        return;
      }
      if (!waitForRegistration) {
        throw new AgentZeroHostGatewayError(
          'Agent Zero did not report one connected Portal host gateway.',
        );
      }

      const retryDelayMs = Math.min(
        REMOTE_REGISTRATION_POLL_MS,
        this.readinessRemainingMs(deadline),
      );
      if (retryDelayMs === 0) {
        throw new AgentZeroHostGatewayError(
          'Agent Zero host gateway did not complete remote registration in time.',
        );
      }
      await this.runWhileChildHealthy(
        child,
        () => wait(retryDelayMs),
        deadline,
        timeoutMessage,
      );
    }
  }

  private async runWhileChildHealthy<T>(
    child: ChildProcessWithoutNullStreams,
    operation: () => Promise<T>,
    deadline: number,
    timeoutMessage: string,
  ): Promise<T> {
    this.assertChildHealthy(child);
    let onExit: (() => void) | undefined;
    let onError: (() => void) | undefined;
    const childFailure = new Promise<never>((_resolve, reject) => {
      onExit = () => reject(new AgentZeroHostGatewayError(
        'Agent Zero host gateway exited before remote readiness completed.',
      ));
      onError = () => reject(new AgentZeroHostGatewayError(
        'Agent Zero host gateway process failed during remote readiness.',
      ));
      child.once('exit', onExit);
      child.once('error', onError);
    });

    try {
      const result = await this.runWithinReadinessDeadline(
        () => Promise.race([
          Promise.resolve().then(operation),
          childFailure,
        ]),
        deadline,
        timeoutMessage,
      );
      this.assertChildHealthy(child);
      return result;
    } finally {
      if (onExit) child.off('exit', onExit);
      if (onError) child.off('error', onError);
    }
  }

  private assertChildHealthy(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child || child.exitCode !== null) {
      throw new AgentZeroHostGatewayError(
        'Agent Zero host gateway exited before remote readiness completed.',
      );
    }
  }

  private readinessRemainingMs(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  private assertWithinReadinessDeadline(deadline: number): void {
    if (this.readinessRemainingMs(deadline) === 0) {
      throw new AgentZeroHostGatewayError(
        'Agent Zero host gateway did not complete readiness within its hard deadline.',
      );
    }
  }

  private async runWithinReadinessDeadline<T>(
    operation: () => Promise<T>,
    deadline: number,
    timeoutMessage: string,
  ): Promise<T> {
    const remainingMs = this.readinessRemainingMs(deadline);
    if (remainingMs <= 0) throw new AgentZeroHostGatewayError(timeoutMessage);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AgentZeroHostGatewayError(timeoutMessage)), remainingMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private stopGraceRemaining(deadline?: number): number {
    return deadline === undefined
      ? STOP_GRACE_MS
      : Math.min(STOP_GRACE_MS, this.readinessRemainingMs(deadline));
  }

  private writeControl(child: ChildProcessWithoutNullStreams, payload: UnknownRecord): void {
    if (!child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify({
        request_id: `portal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ...payload,
      })}\n`);
    } catch {
      // Process termination below remains the final fail-closed control.
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return true;
    return Promise.race([
      once(child, 'exit').then(() => true),
      wait(timeoutMs).then(() => false),
    ]);
  }

  private recordFailure(
    error: unknown,
    fallback: string,
    installed: boolean,
  ): AgentZeroHostGatewayError {
    const detail = error instanceof AgentZeroHostGatewayError
      ? error.message
      : error instanceof Error
        ? redactNativeProviderText(error.message, 320)
        : safeAgentZeroStatusMessage(error, 320);
    const failure = error instanceof AgentZeroHostGatewayError
      ? error
      : new AgentZeroHostGatewayError(detail || fallback);
    this.status = {
      ...stoppedStatus(failure.message),
      state: 'error',
      installed,
      ...(installed ? { cliVersion: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION } : {}),
    };
    return failure;
  }

  private fail(reason: string, installed = false): AgentZeroHostGatewayError {
    this.status = {
      ...stoppedStatus(reason),
      state: 'error',
      installed,
      ...(installed ? { cliVersion: AGENT_ZERO_HOST_GATEWAY_CLI_VERSION } : {}),
    };
    return new AgentZeroHostGatewayError(reason);
  }
}

let defaultManager: AgentZeroHostGatewayManager | null = null;

export function getDefaultAgentZeroHostGatewayManager(): AgentZeroHostGatewayManager {
  if (!defaultManager) defaultManager = new AgentZeroHostGatewayManager();
  return defaultManager;
}

export async function stopDefaultAgentZeroHostGateway(): Promise<void> {
  if (!defaultManager) return;
  await defaultManager.stop();
  defaultManager = null;
}

export function clearDefaultAgentZeroHostGatewayForTests(): void {
  defaultManager = null;
}
