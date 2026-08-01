import { execFile, execFileSync } from 'child_process';
import { lstatSync, readFileSync, type Stats } from 'fs';
import {
  AGENT_ZERO_CONNECTOR_PATH,
  AGENT_ZERO_VERSION,
  validateAgentZeroCapabilities,
} from './AgentZeroConnectorContract';
import { readProtectedAgentZeroCredentials } from './AgentZeroAuthSession';

export { AGENT_ZERO_CONNECTOR_PROTOCOL, AGENT_ZERO_VERSION } from './AgentZeroConnectorContract';

export const AGENT_ZERO_CONTAINER_NAME = 'bridgesllm-agent-zero';
export const AGENT_ZERO_DATA_VOLUME = 'bridgesllm-agent-zero-usr';
export const AGENT_ZERO_AUTH_CONTAINER_PATH = '/a0/.env';
export const AGENT_ZERO_DATA_CONTAINER_PATH = '/a0/usr';
export const AGENT_ZERO_LOOPBACK_HOST = '127.0.0.1';
export const AGENT_ZERO_HOST_PORT = '50001';
export const AGENT_ZERO_CONTAINER_PORT = '80/tcp';
export const AGENT_ZERO_DEFAULT_AUTH_FILE = '/etc/bridgesllm/agent-zero.env';
export const AGENT_ZERO_CAPABILITIES_URL =
  `http://${AGENT_ZERO_LOOPBACK_HOST}:${AGENT_ZERO_HOST_PORT}${AGENT_ZERO_CONNECTOR_PATH}/capabilities`;

export const AGENT_ZERO_IMAGE_DIGESTS = {
  amd64: 'sha256:9b48534c1279fb831513b8c970e2d9004e7a2a6708a4d53a91a76d24a4f9f7eb',
  arm64: 'sha256:da107b689828124369d83f017b9664493c0699c60e57809fbd32f647078de49c',
} as const;

export type AgentZeroArchitecture = keyof typeof AGENT_ZERO_IMAGE_DIGESTS;

export interface AgentZeroRuntimeStatus {
  installed: boolean;
  running: boolean;
  ready: boolean;
  version?: string;
  expectedVersion: typeof AGENT_ZERO_VERSION;
  imageRef?: string;
  expectedImageRef?: string;
  architecture?: AgentZeroArchitecture;
  pinnedImage: boolean;
  loopbackOnly: boolean;
  persistentData: boolean;
  protectedAuth: boolean;
  restartPolicy: boolean;
  protocolCompatible: boolean;
  reason: string;
}

type CommandRunner = (command: string, args: string[]) => string;

export interface AgentZeroRuntimeProbeOptions {
  architecture?: string;
  authFilePath?: string;
  runCommand?: CommandRunner;
  readAuthFile?: (path: string) => string;
  statAuthFile?: (path: string) => Stats;
}

const DEFAULT_RUNTIME_PROBE_CACHE_MS = 60_000;
let defaultRuntimeProbeCache: { checkedAt: number; status: AgentZeroRuntimeStatus } | null = null;
let defaultRuntimeProbePromise: Promise<AgentZeroRuntimeStatus> | null = null;
let defaultRuntimeProbeEpoch = 0;

type UnknownRecord = Record<string, any>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentZeroArchitecture(architecture: string): AgentZeroArchitecture | null {
  switch (String(architecture || '').trim().toLowerCase()) {
    case 'x64':
    case 'amd64':
    case 'x86_64':
      return 'amd64';
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    default:
      return null;
  }
}

export function getAgentZeroImageRef(architecture: string): string | null {
  const normalized = normalizeAgentZeroArchitecture(architecture);
  if (!normalized) return null;
  return `agent0ai/agent-zero@${AGENT_ZERO_IMAGE_DIGESTS[normalized]}`;
}

function defaultRunCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

function defaultRunCommandAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
    child?.stdin?.end();
  });
}

function authFileIsProtected(
  authFilePath: string,
  readAuthFile: (path: string) => string,
  statAuthFile: (path: string) => Stats,
): boolean {
  try {
    readProtectedAgentZeroCredentials(authFilePath, readAuthFile, statAuthFile);
    return true;
  } catch {
    return false;
  }
}

function inspectConnector(payload: string): { compatible: boolean; version?: string } {
  try {
    const capabilities = validateAgentZeroCapabilities(JSON.parse(payload), {
      requireAuthentication: true,
    });
    const launcherCompatible = capabilities.features.includes('launcher_gateway')
      && capabilities.features.includes('launcher_gateway_file_write');
    return { compatible: launcherCompatible, version: capabilities.agentZeroVersion };
  } catch {
    return { compatible: false };
  }
}

function hasExactPortContract(inspect: UnknownRecord): boolean {
  const bindings = inspect.HostConfig?.PortBindings;
  if (!isRecord(bindings) || Object.keys(bindings).length !== 1) return false;
  const httpBindings = bindings[AGENT_ZERO_CONTAINER_PORT];
  return Array.isArray(httpBindings)
    && httpBindings.length === 1
    && httpBindings[0]?.HostIp === AGENT_ZERO_LOOPBACK_HOST
    && String(httpBindings[0]?.HostPort || '') === AGENT_ZERO_HOST_PORT;
}

function hasExactMountContracts(inspect: UnknownRecord, authFilePath: string): {
  persistentData: boolean;
  authMount: boolean;
} {
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
  const dataMount = mounts.find((mount: UnknownRecord) => mount?.Destination === AGENT_ZERO_DATA_CONTAINER_PATH);
  const authMount = mounts.find((mount: UnknownRecord) => mount?.Destination === AGENT_ZERO_AUTH_CONTAINER_PATH);
  return {
    persistentData: dataMount?.Type === 'volume'
      && dataMount?.Name === AGENT_ZERO_DATA_VOLUME
      && dataMount?.RW === true,
    authMount: authMount?.Type === 'bind'
      && authMount?.Source === authFilePath
      && authMount?.RW === false,
  };
}

function failedStatus(reason: string, architecture?: AgentZeroArchitecture, expectedImageRef?: string): AgentZeroRuntimeStatus {
  return {
    installed: false,
    running: false,
    ready: false,
    expectedVersion: AGENT_ZERO_VERSION,
    architecture,
    expectedImageRef,
    pinnedImage: false,
    loopbackOnly: false,
    persistentData: false,
    protectedAuth: false,
    restartPolicy: false,
    protocolCompatible: false,
    reason,
  };
}

/**
 * Synchronous, bounded runtime probe used by turn admission and legacy
 * snapshot callers. Aggregate provider discovery uses the async path below.
 *
 * The raw Docker inspection contains the bind-mounted auth-file path but this
 * function never returns credential contents. Agent Zero remains disabled at
 * the provider layer until its streaming and trust contracts are complete.
 */
function probeAgentZeroRuntimeUncached(options: AgentZeroRuntimeProbeOptions): AgentZeroRuntimeStatus {
  const architecture = normalizeAgentZeroArchitecture(options.architecture || process.arch);
  if (!architecture) {
    return failedStatus(`Unsupported Agent Zero host architecture: ${options.architecture || process.arch}`);
  }
  const expectedImageRef = getAgentZeroImageRef(architecture)!;
  const runCommand = options.runCommand || defaultRunCommand;
  const authFilePath = options.authFilePath
    || process.env.AGENT_ZERO_AUTH_FILE
    || AGENT_ZERO_DEFAULT_AUTH_FILE;

  let inspect: UnknownRecord;
  try {
    const raw = JSON.parse(runCommand('docker', ['inspect', AGENT_ZERO_CONTAINER_NAME])) as unknown;
    if (!Array.isArray(raw) || !isRecord(raw[0])) {
      return failedStatus('Agent Zero returned an invalid Docker inspection result.', architecture, expectedImageRef);
    }
    inspect = raw[0];
  } catch {
    return failedStatus('Managed Agent Zero v2.5 container is not installed.', architecture, expectedImageRef);
  }

  const imageRef = typeof inspect.Config?.Image === 'string' ? inspect.Config.Image : undefined;
  const running = inspect.State?.Running === true;
  const pinnedImage = imageRef === expectedImageRef;
  const loopbackOnly = hasExactPortContract(inspect);
  const mounts = hasExactMountContracts(inspect, authFilePath);
  const authFileProtected = authFileIsProtected(
    authFilePath,
    options.readAuthFile || ((filePath) => readFileSync(filePath, 'utf8')),
    options.statAuthFile || lstatSync,
  );
  const protectedAuth = mounts.authMount && authFileProtected;
  const restartPolicy = inspect.HostConfig?.RestartPolicy?.Name === 'unless-stopped';

  let protocolCompatible = false;
  let version: string | undefined;
  if (running && pinnedImage && loopbackOnly && mounts.persistentData && protectedAuth && restartPolicy) {
    try {
      const capabilities = runCommand('curl', [
        '--fail', '--silent', '--show-error', '--max-time', '3',
        '--request', 'POST',
        '--header', 'Content-Type: application/json',
        '--data', '{}',
        AGENT_ZERO_CAPABILITIES_URL,
      ]);
      ({ compatible: protocolCompatible, version } = inspectConnector(capabilities));
    } catch {
      protocolCompatible = false;
    }
  }

  const checks: Array<[boolean, string]> = [
    [running, 'container is stopped'],
    [pinnedImage, 'container image is outside the Portal-tested v2.5 digest'],
    [loopbackOnly, 'container port is not bound exclusively to 127.0.0.1:50001'],
    [mounts.persistentData, 'container does not use the managed persistent /a0/usr volume'],
    [protectedAuth, 'root-owned private Agent Zero authentication is not mounted'],
    [restartPolicy, 'container restart policy is not unless-stopped'],
    [protocolCompatible, 'Agent Zero v2.5 public connector protocol readiness failed'],
  ];
  const failure = checks.find(([ok]) => !ok)?.[1];

  return {
    installed: true,
    running,
    ready: !failure,
    version,
    expectedVersion: AGENT_ZERO_VERSION,
    imageRef,
    expectedImageRef,
    architecture,
    pinnedImage,
    loopbackOnly,
    persistentData: mounts.persistentData,
    protectedAuth,
    restartPolicy,
    protocolCompatible,
    reason: failure || 'Managed Agent Zero v2.5 runtime is protocol-ready; protected session authentication is checked separately.',
  };
}

export function clearAgentZeroRuntimeProbeCache(): void {
  defaultRuntimeProbeEpoch += 1;
  defaultRuntimeProbeCache = null;
  defaultRuntimeProbePromise = null;
}

export function probeAgentZeroRuntime(options: AgentZeroRuntimeProbeOptions = {}): AgentZeroRuntimeStatus {
  const usesDefaultProbe = Object.keys(options).length === 0;
  if (usesDefaultProbe
    && defaultRuntimeProbeCache
    && Date.now() - defaultRuntimeProbeCache.checkedAt < DEFAULT_RUNTIME_PROBE_CACHE_MS) {
    return defaultRuntimeProbeCache.status;
  }

  const status = probeAgentZeroRuntimeUncached(options);
  if (usesDefaultProbe) {
    defaultRuntimeProbeCache = { checkedAt: Date.now(), status };
  }
  return status;
}

/**
 * Non-blocking catalog probe. Turn admission continues to use the synchronous
 * exact gate above; aggregate provider discovery uses this path so a slow
 * Docker daemon or connector cannot block the HTTP event loop.
 */
async function probeAgentZeroRuntimeUncachedAsync(): Promise<AgentZeroRuntimeStatus> {
  const architecture = normalizeAgentZeroArchitecture(process.arch);
  if (!architecture) {
    return failedStatus(`Unsupported Agent Zero host architecture: ${process.arch}`);
  }
  const expectedImageRef = getAgentZeroImageRef(architecture)!;
  const authFilePath = process.env.AGENT_ZERO_AUTH_FILE || AGENT_ZERO_DEFAULT_AUTH_FILE;

  let inspect: UnknownRecord;
  try {
    const raw = JSON.parse(await defaultRunCommandAsync(
      'docker',
      ['inspect', AGENT_ZERO_CONTAINER_NAME],
    )) as unknown;
    if (!Array.isArray(raw) || !isRecord(raw[0])) {
      return failedStatus(
        'Agent Zero returned an invalid Docker inspection result.',
        architecture,
        expectedImageRef,
      );
    }
    inspect = raw[0];
  } catch {
    return failedStatus(
      'Managed Agent Zero v2.5 container is not installed.',
      architecture,
      expectedImageRef,
    );
  }

  const imageRef = typeof inspect.Config?.Image === 'string' ? inspect.Config.Image : undefined;
  const running = inspect.State?.Running === true;
  const pinnedImage = imageRef === expectedImageRef;
  const loopbackOnly = hasExactPortContract(inspect);
  const mounts = hasExactMountContracts(inspect, authFilePath);
  const authFileProtected = authFileIsProtected(
    authFilePath,
    (filePath) => readFileSync(filePath, 'utf8'),
    lstatSync,
  );
  const protectedAuth = mounts.authMount && authFileProtected;
  const restartPolicy = inspect.HostConfig?.RestartPolicy?.Name === 'unless-stopped';

  let protocolCompatible = false;
  let version: string | undefined;
  if (running && pinnedImage && loopbackOnly && mounts.persistentData && protectedAuth && restartPolicy) {
    try {
      const capabilities = await defaultRunCommandAsync('curl', [
        '--fail', '--silent', '--show-error', '--max-time', '3',
        '--request', 'POST',
        '--header', 'Content-Type: application/json',
        '--data', '{}',
        AGENT_ZERO_CAPABILITIES_URL,
      ]);
      ({ compatible: protocolCompatible, version } = inspectConnector(capabilities));
    } catch {
      protocolCompatible = false;
    }
  }

  const checks: Array<[boolean, string]> = [
    [running, 'container is stopped'],
    [pinnedImage, 'container image is outside the Portal-tested v2.5 digest'],
    [loopbackOnly, 'container port is not bound exclusively to 127.0.0.1:50001'],
    [mounts.persistentData, 'container does not use the managed persistent /a0/usr volume'],
    [protectedAuth, 'root-owned private Agent Zero authentication is not mounted'],
    [restartPolicy, 'container restart policy is not unless-stopped'],
    [protocolCompatible, 'Agent Zero v2.5 public connector protocol readiness failed'],
  ];
  const failure = checks.find(([ok]) => !ok)?.[1];

  return {
    installed: true,
    running,
    ready: !failure,
    version,
    expectedVersion: AGENT_ZERO_VERSION,
    imageRef,
    expectedImageRef,
    architecture,
    pinnedImage,
    loopbackOnly,
    persistentData: mounts.persistentData,
    protectedAuth,
    restartPolicy,
    protocolCompatible,
    reason: failure || 'Managed Agent Zero v2.5 runtime is protocol-ready; protected session authentication is checked separately.',
  };
}

export function probeAgentZeroRuntimeAsync(): Promise<AgentZeroRuntimeStatus> {
  if (defaultRuntimeProbeCache
    && Date.now() - defaultRuntimeProbeCache.checkedAt < DEFAULT_RUNTIME_PROBE_CACHE_MS) {
    return Promise.resolve(defaultRuntimeProbeCache.status);
  }
  if (defaultRuntimeProbePromise) return defaultRuntimeProbePromise;

  const epoch = defaultRuntimeProbeEpoch;
  const pending = probeAgentZeroRuntimeUncachedAsync()
    .then((status) => {
      if (epoch === defaultRuntimeProbeEpoch) {
        defaultRuntimeProbeCache = { checkedAt: Date.now(), status };
      }
      return status;
    })
    .finally(() => {
      if (defaultRuntimeProbePromise === pending) defaultRuntimeProbePromise = null;
    });
  defaultRuntimeProbePromise = pending;
  return pending;
}
