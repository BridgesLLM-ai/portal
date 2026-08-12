import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export const PROJECT_DESKTOP_RUNTIME_ROOT = '/var/lib/bridgesllm/desktop-projects';
export const LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT = '/home/bridgesrd/projects';

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function requireProjectId(projectId: string): string {
  const normalized = String(projectId || '').trim();
  if (!PROJECT_ID_RE.test(normalized)) throw new Error('Project desktop runtime identity is invalid');
  return normalized;
}

function safeProjectLabel(projectName: string): string {
  const normalized = String(projectName || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return normalized || 'Project';
}

export interface ProjectDesktopRuntimeIdentity {
  runtimeDir: string;
  processMarker: string;
  systemdUnit: string;
  windowTitle: string;
}

function processLookupReportedAbsent(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { status?: unknown }).status === 1;
}

function projectDesktopRuntimeProcessIds(marker: string): number[] {
  try {
    execFileSync('id', ['-u', 'bridgesrd'], { timeout: 3_000, stdio: 'ignore' });
  } catch (error) {
    if (processLookupReportedAbsent(error)) return [];
    throw error;
  }
  let output: string;
  try {
    output = execFileSync('pgrep', ['-u', 'bridgesrd'], {
      timeout: 3_000,
      encoding: 'utf8',
    });
  } catch (error) {
    if (processLookupReportedAbsent(error)) return [];
    throw error;
  }
  const ids = output.split(/\s+/).filter(Boolean);
  if (ids.some((value) => !/^[1-9][0-9]*$/.test(value))) {
    throw new Error('Project desktop runtime process discovery returned an invalid identity');
  }
  const shellPathToken = path.isAbsolute(marker)
    ? `'${marker.replace(/'/g, `'\\''`)}'`
    : null;
  return ids.flatMap((value) => {
    const processId = Number(value);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(`/proc/${processId}/cmdline`);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const args = raw.toString('utf8').split('\0').filter(Boolean);
    return args.some((argument) => (
      argument === marker || Boolean(shellPathToken && argument.includes(shellPathToken))
    )) ? [processId] : [];
  });
}

function signalProjectDesktopRuntimeProcesses(
  processIds: readonly number[],
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  for (const processId of processIds) {
    try {
      process.kill(processId, signal);
    } catch (error: any) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function projectDesktopRuntimeUnitProperty(unitName: string, property: string): string {
  return execFileSync('systemctl', [
    'show',
    unitName,
    `--property=${property}`,
    '--value',
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  }).trim();
}

function projectDesktopRuntimeCgroupHasProcesses(controlGroup: string): boolean {
  if (!controlGroup) return false;
  if (!controlGroup.startsWith('/system.slice/') || controlGroup.includes('..')) {
    throw new Error('Project desktop runtime cgroup identity is invalid');
  }
  const cgroupRoot = path.resolve('/sys/fs/cgroup', `.${controlGroup}`);
  if (!cgroupRoot.startsWith('/sys/fs/cgroup/system.slice/')) {
    throw new Error('Project desktop runtime cgroup escaped system.slice');
  }
  if (!fs.existsSync(cgroupRoot)) return false;
  const pending = [cgroupRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const processesPath = path.join(current, 'cgroup.procs');
    if (fs.existsSync(processesPath) && fs.readFileSync(processesPath, 'utf8').trim()) return true;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

export interface ProjectDesktopRuntimeQuiescenceDependencies {
  processIds?: (marker: string) => number[];
  signalProcesses?: (
    processIds: readonly number[],
    signal: 'SIGTERM' | 'SIGKILL',
  ) => void;
  unitProperty?: (unitName: string, property: string) => string;
  stopUnit?: (unitName: string) => void;
  resetFailedUnit?: (unitName: string) => void;
  cgroupHasProcesses?: (controlGroup: string) => boolean;
}

/**
 * Stop the immutable systemd/cmdline identities that can keep writing a
 * copied Project desktop runtime across a Portal crash. Legacy recorded paths
 * are accepted only when they remain inside one of the two managed runtime
 * roots; an arbitrary persisted path is not process authority.
 */
export function quiesceProjectDesktopRuntimeForDependencyPromotion(input: {
  projectIdentityId: string;
  projectName: string;
  recordedRuntimeDirectories?: readonly string[];
}, dependencies: ProjectDesktopRuntimeQuiescenceDependencies = {}): {
  systemdUnitStopped: boolean;
  processCount: number;
} {
  const processIds = dependencies.processIds || projectDesktopRuntimeProcessIds;
  const signalProcesses = dependencies.signalProcesses || signalProjectDesktopRuntimeProcesses;
  const unitProperty = dependencies.unitProperty || projectDesktopRuntimeUnitProperty;
  const stopUnit = dependencies.stopUnit || ((unitName: string) => {
    execFileSync('systemctl', ['stop', unitName], { timeout: 20_000 });
  });
  const resetFailedUnit = dependencies.resetFailedUnit || ((unitName: string) => {
    execFileSync('systemctl', ['reset-failed', unitName], { timeout: 5_000 });
  });
  const cgroupHasProcesses = dependencies.cgroupHasProcesses
    || projectDesktopRuntimeCgroupHasProcesses;
  const identity = buildProjectDesktopRuntimeIdentity(input.projectIdentityId, input.projectName);
  const loadState = unitProperty(identity.systemdUnit, 'LoadState');
  let systemdUnitStopped = false;
  if (loadState !== 'not-found') {
    stopUnit(identity.systemdUnit);
    const activeState = unitProperty(identity.systemdUnit, 'ActiveState');
    const controlGroup = unitProperty(identity.systemdUnit, 'ControlGroup');
    if (
      !['inactive', 'failed'].includes(activeState)
      || cgroupHasProcesses(controlGroup)
    ) {
      throw new Error('Project desktop runtime remained active after its exact cgroup stop');
    }
    try {
      resetFailedUnit(identity.systemdUnit);
    } catch {
      // A collected transient unit can disappear immediately after stop.
    }
    systemdUnitStopped = true;
  }

  const markers = new Set<string>([identity.processMarker]);
  for (const recorded of input.recordedRuntimeDirectories || []) {
    const managed = managedProjectDesktopRuntimeDirectory(recorded);
    if (!managed) throw new Error('Recorded Project desktop runtime escaped its managed roots');
    markers.add(managed);
  }
  let processCount = 0;
  for (const marker of markers) {
    const initial = processIds(marker);
    processCount += initial.length;
    signalProcesses(initial, 'SIGTERM');
    const residual = processIds(marker);
    signalProcesses(residual, 'SIGKILL');
    if (processIds(marker).length > 0) {
      throw new Error('Project desktop runtime remained after its exact process stop');
    }
  }
  return Object.freeze({ systemdUnitStopped, processCount });
}

/**
 * Runtime children are writable by bridgesrd, but their parent must not be:
 * otherwise a desktop process can rename an attested Project directory to an
 * arbitrary sibling between lifecycle attestation and quarantine.
 */
export function ensureSecureProjectDesktopRuntimeRoot(
  runtimeRoot = PROJECT_DESKTOP_RUNTIME_ROOT,
): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const ownerRoot = path.dirname(resolvedRuntimeRoot);
  fs.mkdirSync(ownerRoot, { recursive: true, mode: 0o755 });
  const ownerEntry = fs.lstatSync(ownerRoot);
  if (
    ownerEntry.isSymbolicLink()
    || !ownerEntry.isDirectory()
    || ownerEntry.uid !== currentUid
    || (ownerEntry.mode & 0o022) !== 0
    || fs.realpathSync(ownerRoot) !== ownerRoot
  ) {
    throw new Error('Project desktop runtime owner root is not server-owned and non-writable');
  }
  try {
    fs.mkdirSync(resolvedRuntimeRoot, { mode: 0o755 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const descriptor = fs.openSync(
    resolvedRuntimeRoot,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const entry = fs.fstatSync(descriptor);
    if (!entry.isDirectory()) throw new Error('Project desktop runtime root is not a directory');
    if (currentUid === 0) fs.fchownSync(descriptor, 0, 0);
    fs.fchmodSync(descriptor, 0o755);
  } finally {
    fs.closeSync(descriptor);
  }
  const entry = fs.lstatSync(resolvedRuntimeRoot);
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || entry.uid !== currentUid
    || (entry.mode & 0o022) !== 0
    || fs.realpathSync(resolvedRuntimeRoot) !== resolvedRuntimeRoot
  ) {
    throw new Error('Project desktop runtime root is not server-owned and non-writable');
  }
}

export function projectDesktopRuntimeAppState(runtimeError: string | null): {
  isActive: boolean;
  processStatus: 'running' | 'error';
} {
  return runtimeError
    ? { isActive: false, processStatus: 'error' }
    : { isActive: true, processStatus: 'running' };
}

/**
 * Desktop runtimes are keyed by immutable ProjectIdentity UUIDs, never mutable
 * or actor-chosen project names. The readable name is presentation only.
 */
export function buildProjectDesktopRuntimeIdentity(
  projectId: string,
  projectName: string,
): ProjectDesktopRuntimeIdentity {
  const identity = requireProjectId(projectId);
  return {
    runtimeDir: path.join(PROJECT_DESKTOP_RUNTIME_ROOT, identity),
    processMarker: `bridgesllm-project-${identity}`,
    systemdUnit: `bridgesllm-project-${identity}.service`,
    windowTitle: `${safeProjectLabel(projectName)} — BridgesLLM`,
  };
}

/** Return an exact one-level managed runtime directory, or null. */
export function managedProjectDesktopRuntimeDirectory(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  for (const runtimeRoot of [
    PROJECT_DESKTOP_RUNTIME_ROOT,
    LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT,
  ]) {
    const relative = path.relative(runtimeRoot, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep)) {
      return resolved;
    }
  }
  return null;
}

export function projectDesktopRuntimeCleanupDirectories(input: {
  projectId: string;
  projectName: string;
  recordedRuntimeDir?: string | null;
}): string[] {
  const current = buildProjectDesktopRuntimeIdentity(input.projectId, input.projectName).runtimeDir;
  const recorded = managedProjectDesktopRuntimeDirectory(input.recordedRuntimeDir);
  const legacy = managedProjectDesktopRuntimeDirectory(
    path.join(LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT, input.projectName),
  );
  const legacyUuid = managedProjectDesktopRuntimeDirectory(
    path.join(LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT, input.projectId),
  );
  return [...new Set([
    current,
    ...(recorded ? [recorded] : []),
    ...(legacy ? [legacy] : []),
    ...(legacyUuid ? [legacyUuid] : []),
  ])];
}
