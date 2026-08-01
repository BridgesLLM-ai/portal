import { execFile } from 'child_process';
import {
  chmodSync,
  chownSync,
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ensureRuntimeDirectory } from '../../../utils/runtimeDirectory';
import {
  getAgentZeroAuthReadinessSnapshot,
  getDefaultAgentZeroAuthSessionManager,
  readProtectedAgentZeroCredentials,
  refreshAgentZeroAuthReadiness,
  type AgentZeroAuthReadiness,
} from './AgentZeroAuthSession';
import {
  getDefaultAgentZeroHostGatewayManager,
  type AgentZeroHostGatewayStatus,
} from './AgentZeroHostGateway';
import {
  AGENT_ZERO_DEFAULT_AUTH_FILE,
  clearAgentZeroRuntimeProbeCache,
  probeAgentZeroRuntime,
  type AgentZeroRuntimeStatus,
} from './AgentZeroRuntime';

export const AGENT_ZERO_RUNTIME_CONFIRMATION = 'SET UP AGENT ZERO';
export const AGENT_ZERO_CREDENTIAL_CONFIRMATION = 'SAVE AGENT ZERO CREDENTIALS';

const MAX_USERNAME_LENGTH = 256;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
const LIFECYCLE_TIMEOUT_MS = 20 * 60_000;
const execFileAsync = promisify(execFile);
const UNSAFE_CREDENTIAL_DIRECTORIES = new Set([
  '/',
  '/etc',
  '/root',
  '/var',
  '/var/lib',
  '/opt',
  '/opt/bridgesllm',
]);

export type AgentZeroSetupStepCode =
  | 'protected_credentials'
  | 'managed_runtime'
  | 'connector_protocol'
  | 'connector_authentication'
  | 'host_operator_bridge'
  | 'test_box_validation'
  | 'project_sandbox_adapter'
  | 'project_escape_validation';

export interface AgentZeroSetupStep {
  code: AgentZeroSetupStepCode;
  label: string;
  complete: boolean;
  detail: string;
}

export interface AgentZeroSetupSurface {
  scope: 'HOST_OPERATOR' | 'PROJECT_SANDBOX';
  available: boolean;
  contractReady: boolean;
  providerEnabled: boolean;
  reason: string;
  steps: AgentZeroSetupStep[];
}

export interface AgentZeroSetupStatus {
  testedVersions: {
    agentZero: '2.5';
    connector: '0.1.0';
    hostBridge: '2.5';
  };
  credentials: {
    configured: boolean;
    protected: boolean;
    reason: string;
  };
  runtime: {
    installed: boolean;
    running: boolean;
    protocolReady: boolean;
    version?: string;
    expectedVersion: '2.5';
    pinnedImage: boolean;
    loopbackOnly: boolean;
    persistentData: boolean;
    protectedAuth: boolean;
    restartPolicy: boolean;
    reason: string;
  };
  authentication: AgentZeroAuthReadiness;
  hostGateway: AgentZeroHostGatewayStatus;
  mainAgentChat: AgentZeroSetupSurface;
  projectSandbox: AgentZeroSetupSurface;
  actions: {
    provisionCredentials: {
      ownerOnly: true;
      confirmationPhrase: typeof AGENT_ZERO_CREDENTIAL_CONFIRMATION;
    };
    reconcileRuntime: {
      ownerOnly: true;
      confirmationPhrase: typeof AGENT_ZERO_RUNTIME_CONFIRMATION;
    };
    verifyAuthentication: {
      ownerOnly: true;
      available: boolean;
    };
  };
  provider: {
    implemented: boolean;
    usable: boolean;
    supportedExecutionScopes: readonly string[];
  };
  checkedAt: string;
}

export interface AgentZeroCredentialFileOptions {
  authFilePath?: string;
  ensureDirectory?: (directory: string) => string;
  statFile?: (target: string) => Stats;
  readFile?: (target: string) => string;
  unlinkFile?: (target: string) => void;
}

export interface AgentZeroCredentialWrite {
  authFilePath: string;
  restore(): void;
}

export interface AgentZeroLifecycleOptions {
  portalRoot?: string;
  run?: (scriptPath: string, command: AgentZeroLifecycleCommand) => Promise<void>;
}

export type AgentZeroLifecycleCommand = 'reconcile' | 'credentials-reload';

export interface AgentZeroProjectModelBridgeLifecycleOptions {
  portalRoot?: string;
  run?: (scriptPath: string, command: 'reconcile') => Promise<void>;
}

function authFilePath(): string {
  return process.env.AGENT_ZERO_AUTH_FILE || AGENT_ZERO_DEFAULT_AUTH_FILE;
}

function validateCredentialValue(value: unknown, label: 'username' | 'password'): string {
  if (typeof value !== 'string') throw new Error(`Agent Zero ${label} is required.`);
  const minimum = label === 'password' ? MIN_PASSWORD_LENGTH : 1;
  const maximum = label === 'password' ? MAX_PASSWORD_LENGTH : MAX_USERNAME_LENGTH;
  if (value.length < minimum || value.length > maximum || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error(
      label === 'password'
        ? `Agent Zero password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} printable characters.`
        : `Agent Zero username must be 1-${MAX_USERNAME_LENGTH} printable characters.`,
    );
  }
  if (label === 'username' && value.trim() !== value) {
    throw new Error('Agent Zero username cannot start or end with whitespace.');
  }
  return value;
}

function encodeDotEnvValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function serializeProtectedAgentZeroCredentials(username: unknown, password: unknown): string {
  const safeUsername = validateCredentialValue(username, 'username');
  const safePassword = validateCredentialValue(password, 'password');
  return `AUTH_LOGIN=${encodeDotEnvValue(safeUsername)}\nAUTH_PASSWORD=${encodeDotEnvValue(safePassword)}\n`;
}

function safeExistingFile(target: string, statFile: (path: string) => Stats): Stats | null {
  try {
    const stat = statFile(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
      throw new Error('Existing Agent Zero credential file is not root-protected.');
    }
    return stat;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function atomicCredentialWrite(target: string, contents: string): void {
  const directory = path.dirname(target);
  if (UNSAFE_CREDENTIAL_DIRECTORIES.has(directory)) {
    throw new Error('Agent Zero credentials require a dedicated private directory.');
  }
  const temporary = path.join(
    directory,
    `.agent-zero.env.portal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fchmodSync(descriptor, 0o600);
    fchownSync(descriptor, 0, 0);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    chownSync(target, 0, 0);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* descriptor may already be closed */ }
    }
    try { unlinkSync(temporary); } catch { /* temporary may not exist */ }
    throw error;
  }
}

/**
 * Atomically store the two protected Agent Zero login values without ever
 * returning them to an API caller. The returned closure is kept server-side
 * only so a failed container reload can restore the previous file.
 */
export function writeProtectedAgentZeroCredentials(
  username: unknown,
  password: unknown,
  options: AgentZeroCredentialFileOptions = {},
): AgentZeroCredentialWrite {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Agent Zero credentials can only be provisioned by the root Portal service.');
  }
  const target = path.resolve(options.authFilePath || authFilePath());
  if (!target.startsWith('/') || target.includes('\u0000')) {
    throw new Error('Agent Zero credential path is invalid.');
  }
  const directory = path.dirname(target);
  if (UNSAFE_CREDENTIAL_DIRECTORIES.has(directory)) {
    throw new Error('Agent Zero credentials require a dedicated private directory.');
  }
  const ensureDirectory = options.ensureDirectory
    || ((value: string) => ensureRuntimeDirectory(value, { mode: 0o700, enforceMode: true }));
  const statFile = options.statFile || lstatSync;
  const readFile = options.readFile || ((value: string) => readFileSync(value, 'utf8'));
  const unlinkFile = options.unlinkFile || unlinkSync;
  const canonicalDirectory = ensureDirectory(directory);
  if (canonicalDirectory !== directory) throw new Error('Agent Zero credential directory is unsafe.');
  const directoryStat = statFile(canonicalDirectory);
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || directoryStat.uid !== 0
    || (directoryStat.mode & 0o077) !== 0
  ) {
    throw new Error('Agent Zero credential directory is not root-private.');
  }

  const current = safeExistingFile(target, statFile);
  const previous = current ? readFile(target) : null;
  const next = serializeProtectedAgentZeroCredentials(username, password);
  atomicCredentialWrite(target, next);

  return {
    authFilePath: target,
    restore: () => {
      if (previous !== null) {
        atomicCredentialWrite(target, previous);
        return;
      }
      const existing = safeExistingFile(target, statFile);
      if (existing) unlinkFile(target);
    },
  };
}

export function probeAgentZeroCredentialConfiguration(
  target = authFilePath(),
): { configured: boolean; protected: boolean; reason: string } {
  try {
    readProtectedAgentZeroCredentials(target);
    return {
      configured: true,
      protected: true,
      reason: 'Protected Agent Zero credentials are configured in a root-only server file.',
    };
  } catch {
    return {
      configured: false,
      protected: false,
      reason: 'The Owner must save protected Agent Zero credentials before the managed runtime can start.',
    };
  }
}

function setupStep(
  code: AgentZeroSetupStepCode,
  label: string,
  complete: boolean,
  detail: string,
): AgentZeroSetupStep {
  return { code, label, complete, detail };
}

export function buildAgentZeroSetupStatus(input: {
  runtime: AgentZeroRuntimeStatus;
  authentication: AgentZeroAuthReadiness;
  hostGateway: AgentZeroHostGatewayStatus;
  credentials?: { configured: boolean; protected: boolean; reason: string };
  now?: Date;
}): AgentZeroSetupStatus {
  const credentials = input.credentials || probeAgentZeroCredentialConfiguration();
  const runtime = input.runtime;
  const authentication = input.authentication;
  const hostGateway = input.hostGateway;
  const componentContractReady = credentials.configured
    && runtime.ready
    && authentication.authenticated
    && hostGateway.installed;

  const mainSteps: AgentZeroSetupStep[] = [
    setupStep('protected_credentials', 'Protected credentials', credentials.configured, credentials.reason),
    setupStep(
      'managed_runtime',
      'Pinned Agent Zero 2.5 runtime',
      runtime.installed && runtime.pinnedImage && runtime.loopbackOnly && runtime.persistentData,
      runtime.reason,
    ),
    setupStep(
      'connector_protocol',
      'Connector 0.1.0 protocol',
      runtime.ready && runtime.protocolCompatible,
      runtime.protocolCompatible
        ? 'The loopback connector advertises the tested authenticated HTTP/WebSocket contract.'
        : 'Reconcile the runtime so the tested loopback connector contract can be verified.',
    ),
    setupStep(
      'connector_authentication',
      'Protected connector session',
      authentication.authenticated,
      authentication.reason,
    ),
    setupStep(
      'host_operator_bridge',
      'Official A0 2.5 host bridge',
      hostGateway.installed,
      hostGateway.reason,
    ),
  ];
  // Keep this checklist limited to owner-actionable runtime components.
  // Provider availability is derived from these live checks instead of an
  // extra duplicate status row that the owner cannot act on.

  const projectSteps: AgentZeroSetupStep[] = [
    setupStep(
      'project_sandbox_adapter',
      'Project-confined Agent Zero adapter',
      true,
      'A deterministic per-project v2.5 container, volume, credentials, authenticated connector, loopback port, read-only host baseline, and no-egress firewall are implemented. The unrestricted host bridge is never reused for Projects.',
    ),
    setupStep(
      'project_escape_validation',
      'Project escape validation',
      false,
      'Each project must still pass a real exact-image/connector escape probe, WebSocket replay test, safe model round-trip, hard-abort restart, and provider-switch soak before Project Chat can offer Agent Zero.',
    ),
  ];

  return {
    testedVersions: { agentZero: '2.5', connector: '0.1.0', hostBridge: '2.5' },
    credentials,
    runtime: {
      installed: runtime.installed,
      running: runtime.running,
      protocolReady: runtime.ready,
      version: runtime.version,
      expectedVersion: runtime.expectedVersion,
      pinnedImage: runtime.pinnedImage,
      loopbackOnly: runtime.loopbackOnly,
      persistentData: runtime.persistentData,
      protectedAuth: runtime.protectedAuth,
      restartPolicy: runtime.restartPolicy,
      reason: runtime.reason,
    },
    authentication,
    hostGateway,
    mainAgentChat: {
      scope: 'HOST_OPERATOR',
      // Enablement mirrors the live provider gate: every local component must
      // be converged and protected authentication verified. No blind flags.
      available: componentContractReady,
      contractReady: componentContractReady,
      providerEnabled: componentContractReady,
      reason: componentContractReady
        ? 'Agent Zero host-operator chat is enabled: managed runtime, protected authentication, and the host gateway all verify.'
        : 'Complete every local setup step before full-host Agent Chat can enable.',
      steps: mainSteps,
    },
    projectSandbox: {
      scope: 'PROJECT_SANDBOX',
      available: false,
      contractReady: false,
      providerEnabled: false,
      reason: 'The isolated Project adapter is implemented but remains fail-closed until current project-specific live qualification and a safe model-egress path are proven.',
      steps: projectSteps,
    },
    actions: {
      provisionCredentials: {
        ownerOnly: true,
        confirmationPhrase: AGENT_ZERO_CREDENTIAL_CONFIRMATION,
      },
      reconcileRuntime: {
        ownerOnly: true,
        confirmationPhrase: AGENT_ZERO_RUNTIME_CONFIRMATION,
      },
      verifyAuthentication: {
        ownerOnly: true,
        available: runtime.ready && credentials.configured,
      },
    },
    provider: {
      implemented: true,
      usable: componentContractReady,
      supportedExecutionScopes: componentContractReady ? ['HOST_OPERATOR'] : [],
    },
    checkedAt: (input.now || new Date()).toISOString(),
  };
}

export async function collectAgentZeroSetupStatus(forceAuthentication = false): Promise<AgentZeroSetupStatus> {
  const runtime = probeAgentZeroRuntime();
  const credentials = probeAgentZeroCredentialConfiguration();
  const authentication = runtime.ready && credentials.configured
    ? await refreshAgentZeroAuthReadiness(forceAuthentication)
    : getAgentZeroAuthReadinessSnapshot();
  const hostGateway = getDefaultAgentZeroHostGatewayManager().probeInstallation();
  return buildAgentZeroSetupStatus({ runtime, authentication, hostGateway, credentials });
}

async function defaultLifecycleRun(scriptPath: string, command: AgentZeroLifecycleCommand): Promise<void> {
  await execFileAsync('bash', [scriptPath, command], {
    cwd: path.dirname(path.dirname(scriptPath)),
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      AGENT_ZERO_AUTH_FILE: authFilePath(),
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      no_proxy: process.env.no_proxy,
    },
    timeout: LIFECYCLE_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
}

export async function runAgentZeroLifecycle(
  command: AgentZeroLifecycleCommand,
  options: AgentZeroLifecycleOptions = {},
): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Managed Agent Zero lifecycle requires the root Portal service.');
  }
  const portalRoot = path.resolve(options.portalRoot || process.env.PORTAL_ROOT || '/opt/bridgesllm/portal');
  const scriptPath = path.join(portalRoot, 'installer', 'agent-zero-runtime.sh');
  const stat = lstatSync(scriptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('Managed Agent Zero lifecycle script is missing or unsafe.');
  }
  let directory = path.dirname(scriptPath);
  while (true) {
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== 0
      || (directoryStat.mode & 0o022) !== 0
    ) {
      throw new Error('Managed Agent Zero lifecycle path is not root-protected.');
    }
    if (directory === '/') break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  await (options.run || defaultLifecycleRun)(scriptPath, command);
}

export async function runAgentZeroProjectModelBridgeLifecycle(
  options: AgentZeroProjectModelBridgeLifecycleOptions = {},
): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Managed Agent Zero Project model bridge lifecycle requires the root Portal service.');
  }
  const portalRoot = path.resolve(options.portalRoot || process.env.PORTAL_ROOT || '/opt/bridgesllm/portal');
  const scriptPath = path.join(portalRoot, 'installer', 'agent-zero-project-model-bridge.sh');
  const stat = lstatSync(scriptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('Managed Agent Zero Project model bridge lifecycle script is missing or unsafe.');
  }
  let directory = path.dirname(scriptPath);
  while (true) {
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== 0
      || (directoryStat.mode & 0o022) !== 0
    ) {
      throw new Error('Managed Agent Zero Project model bridge lifecycle path is not root-protected.');
    }
    if (directory === '/') break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  await (options.run || defaultLifecycleRun)(scriptPath, 'reconcile');
}

let mutationRunning = false;

export async function withAgentZeroSetupMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (mutationRunning) throw new Error('Another Agent Zero setup action is already running.');
  mutationRunning = true;
  try {
    return await operation();
  } finally {
    mutationRunning = false;
  }
}

export async function reconcileAgentZeroRuntime(): Promise<AgentZeroSetupStatus> {
  return withAgentZeroSetupMutation(async () => {
    await getDefaultAgentZeroHostGatewayManager().stop();
    await runAgentZeroLifecycle('reconcile');
    await runAgentZeroProjectModelBridgeLifecycle();
    clearAgentZeroRuntimeProbeCache();
    await getDefaultAgentZeroAuthSessionManager().resetReadiness();
    return collectAgentZeroSetupStatus(true);
  });
}

export async function provisionAgentZeroCredentials(
  username: unknown,
  password: unknown,
): Promise<AgentZeroSetupStatus> {
  return withAgentZeroSetupMutation(async () => {
    const before = probeAgentZeroRuntime();
    const verifyImmediately = before.installed && before.running;
    const credentialWrite = writeProtectedAgentZeroCredentials(username, password);
    await getDefaultAgentZeroHostGatewayManager().stop();
    try {
      if (verifyImmediately) await runAgentZeroLifecycle('credentials-reload');
      clearAgentZeroRuntimeProbeCache();
      await getDefaultAgentZeroAuthSessionManager().resetReadiness();
      const status = await collectAgentZeroSetupStatus(verifyImmediately);
      if (verifyImmediately && !status.authentication.authenticated) {
        throw new Error('Agent Zero rejected the protected credentials.');
      }
      return status;
    } catch (error) {
      credentialWrite.restore();
      clearAgentZeroRuntimeProbeCache();
      await getDefaultAgentZeroAuthSessionManager().resetReadiness();
      if (verifyImmediately) {
        await runAgentZeroLifecycle('credentials-reload').catch(() => undefined);
        clearAgentZeroRuntimeProbeCache();
      }
      throw error;
    }
  });
}
