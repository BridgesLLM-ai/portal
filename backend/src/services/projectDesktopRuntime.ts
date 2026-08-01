import fs from 'fs';
import path from 'path';

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
