import {
  attestNativeHostCli,
  type NativeHostCliId,
} from './nativeHostCliAdmission';

export const NATIVE_HOST_CLI_STATUS_TOOLS = Object.freeze([
  'codex',
  'claude-code',
  'clawhub',
] as const satisfies readonly NativeHostCliId[]);

export const NATIVE_HOST_CLI_EXECUTION_CONTRACT = 'bridgesllm-native-host-cli-admission-v1';

export type NativeHostCliStatusTool = typeof NATIVE_HOST_CLI_STATUS_TOOLS[number];

export type NativeHostCliStatusState =
  | 'verified'
  | 'absent'
  | 'unsupported'
  | 'status_only'
  | 'drifted'
  | 'indeterminate';

export type NativeHostCliStatus = Readonly<{
  toolId: NativeHostCliStatusTool;
  executablePath: string;
  state: NativeHostCliStatusState;
  installed: boolean | null;
  executionEligible: boolean;
  checkedAt: string;
  observedVersion: string | null;
  fingerprint: string | null;
  reasonCode: string | null;
}>;

const EXECUTABLE_PATHS = Object.freeze({
  codex: '/usr/bin/codex',
  'claude-code': '/usr/bin/claude',
  clawhub: '/usr/bin/clawhub',
} satisfies Readonly<Record<NativeHostCliStatusTool, string>>);

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; status: NativeHostCliStatus }>();
const pending = new Map<string, Promise<NativeHostCliStatus>>();
const requestGenerations = new Map<string, number>();
let cacheEpoch = 0;

function admissionErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code || '');
    if (/^[A-Z0-9_]{1,80}$/.test(code)) return code;
  }
  return 'IO_ERROR';
}

function admissionObservedVersion(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('observedVersion' in error)) return null;
  const version = (error as { observedVersion?: unknown }).observedVersion;
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
}

function stateForErrorCode(code: string): NativeHostCliStatusState {
  if (code === 'ABSENT') return 'absent';
  if (code === 'UNSUPPORTED_VERSION' || code === 'UNSUPPORTED_PLATFORM') return 'unsupported';
  if (code === 'STATUS_ONLY_VERSION') return 'status_only';
  if (code === 'INVALID_EXECUTABLE_PATH'
    || code === 'DRIFT_DETECTED'
    || code === 'RACE_DETECTED'
    || code === 'BOUND_EXCEEDED') {
    return 'drifted';
  }
  return 'indeterminate';
}

function installedForErrorCode(code: string): boolean | null {
  if (code === 'ABSENT') return false;
  if (code === 'UNSUPPORTED_VERSION'
    || code === 'STATUS_ONLY_VERSION'
    || code === 'DRIFT_DETECTED'
    || code === 'RACE_DETECTED'
    || code === 'BOUND_EXCEEDED') return true;
  return null;
}

function cacheKey(toolId: NativeHostCliStatusTool, executablePath: string): string {
  return `${toolId}\u0000${executablePath}`;
}

export function isNativeHostCliStatusTool(value: unknown): value is NativeHostCliStatusTool {
  return typeof value === 'string'
    && NATIVE_HOST_CLI_STATUS_TOOLS.includes(value as NativeHostCliStatusTool);
}

export async function getNativeHostCliStatus(
  toolId: NativeHostCliStatusTool,
  options: Readonly<{ force?: boolean; executablePath?: string }> = {},
): Promise<NativeHostCliStatus> {
  const executablePath = options.executablePath || EXECUTABLE_PATHS[toolId];
  const key = cacheKey(toolId, executablePath);
  const now = Date.now();
  const cached = cache.get(key);
  if (!options.force && cached && cached.expiresAt > now) return cached.status;

  const existing = pending.get(key);
  if (!options.force && existing) return existing;

  const epoch = cacheEpoch;
  const requestGeneration = (requestGenerations.get(key) || 0) + 1;
  requestGenerations.set(key, requestGeneration);
  const task = attestNativeHostCli(toolId, executablePath)
    .then((identity): NativeHostCliStatus => Object.freeze({
      toolId,
      executablePath,
      state: 'verified',
      installed: true,
      executionEligible: true,
      checkedAt: identity.checkedAt,
      observedVersion: identity.version,
      fingerprint: identity.fingerprint,
      reasonCode: null,
    }))
    .catch((error: unknown): NativeHostCliStatus => {
      const reasonCode = admissionErrorCode(error);
      return Object.freeze({
        toolId,
        executablePath,
        state: stateForErrorCode(reasonCode),
        installed: installedForErrorCode(reasonCode),
        executionEligible: false,
        checkedAt: new Date().toISOString(),
        observedVersion: admissionObservedVersion(error),
        fingerprint: null,
        reasonCode,
      });
    })
    .then((status) => {
      if (
        epoch === cacheEpoch
        && requestGenerations.get(key) === requestGeneration
      ) {
        cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, status });
      }
      return status;
    })
    .finally(() => {
      if (pending.get(key) === task) pending.delete(key);
    });
  pending.set(key, task);
  return task;
}

export function invalidateNativeHostCliStatus(toolId?: NativeHostCliStatusTool): void {
  cacheEpoch += 1;
  if (!toolId) {
    cache.clear();
    pending.clear();
    requestGenerations.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${toolId}\u0000`)) cache.delete(key);
  }
  for (const key of pending.keys()) {
    if (key.startsWith(`${toolId}\u0000`)) pending.delete(key);
  }
  for (const key of requestGenerations.keys()) {
    if (key.startsWith(`${toolId}\u0000`)) requestGenerations.delete(key);
  }
}

export function __resetNativeHostCliStatusForTests(): void {
  invalidateNativeHostCliStatus();
}
