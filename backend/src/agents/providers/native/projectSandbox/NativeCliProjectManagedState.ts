import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../../executionScope';
import { ensureRuntimeDirectory } from '../../../../utils/runtimeDirectory';
import {
  NATIVE_CLI_PROJECT_CONTAINER_GID,
  NATIVE_CLI_PROJECT_CONTAINER_UID,
  type NativeCliProjectRuntimeProvider,
} from './NativeCliProjectEgressRuntime';

const MAX_MANAGED_FILE_BYTES = 2 * 1024 * 1024;

function pathContains(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configuredStateRoot(): string {
  const configured = String(process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT || '').trim();
  if (configured) return path.resolve(configured);
  const dataRoot = path.resolve(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal');
  return path.join(dataRoot, '.data', 'project-sandboxes', 'native-cli');
}

function stateKey(
  context: ProjectSandboxExecutionContext,
  provider: NativeCliProjectRuntimeProvider,
): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    provider,
    userId: context.userId,
    projectId: context.projectId,
  })).digest('hex');
}

export function nativeCliProjectStateDirectoryForIdentity(input: {
  provider: NativeCliProjectRuntimeProvider;
  userId: string;
  projectId: string;
}): string {
  const normalized = (value: string, label: string) => {
    const result = String(value || '').trim();
    if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
      throw new Error(`Native CLI Project ${label} is invalid`);
    }
    return result;
  };
  const key = crypto.createHash('sha256').update(JSON.stringify({
    provider: input.provider,
    userId: normalized(input.userId, 'actor identity'),
    projectId: normalized(input.projectId, 'project identity'),
  })).digest('hex');
  return path.join(configuredStateRoot(), input.provider.toLowerCase(), key);
}

export function nativeCliProjectStateDirectory(input: {
  context: ProjectSandboxExecutionContext;
  provider: NativeCliProjectRuntimeProvider;
}): string {
  return nativeCliProjectStateDirectoryForIdentity({
    provider: input.provider,
    userId: input.context.userId,
    projectId: input.context.projectId,
  });
}

export function hasNativeCliProjectManagedStateForIdentity(input: {
  provider: NativeCliProjectRuntimeProvider;
  userId: string;
  projectId: string;
  projectRoot: string;
}): boolean {
  const stateRoot = configuredStateRoot();
  assertNativeCliProjectPathSeparation({
    projectRoot: input.projectRoot,
    stateRoot,
  });
  const providerRoot = path.join(stateRoot, input.provider.toLowerCase());
  const stateDir = nativeCliProjectStateDirectoryForIdentity(input);
  if (
    path.dirname(stateDir) !== providerRoot
    || !/^[a-f0-9]{64}$/.test(path.basename(stateDir))
  ) {
    throw new Error('Native CLI Project managed-state identity is invalid');
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(stateDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || fs.realpathSync.native(stateDir) !== stateDir
    || stat.uid !== NATIVE_CLI_PROJECT_CONTAINER_UID
    || stat.gid !== NATIVE_CLI_PROJECT_CONTAINER_GID
    || (stat.mode & 0o777) !== 0o500
  ) {
    throw new Error('Native CLI Project managed-state directory is unsafe');
  }
  return true;
}

export function assertNativeCliProjectPathSeparation(input: {
  projectRoot: string;
  stateRoot?: string;
  sourcePath?: string;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const stateRoot = path.resolve(input.stateRoot || configuredStateRoot());
  if (projectRoot === path.parse(projectRoot).root) {
    throw new Error('Native CLI Project root may not be a filesystem root');
  }
  if (pathContains(projectRoot, stateRoot) || pathContains(stateRoot, projectRoot)) {
    throw new Error('Native CLI Project root and protected sandbox state must not overlap');
  }
  if (input.sourcePath && pathContains(projectRoot, path.resolve(input.sourcePath))) {
    throw new Error('Native CLI authentication source must not be inside the Project root');
  }
}

export function readProtectedNativeCliSource(input: {
  sourcePath: string;
  projectRoot: string;
  label: string;
  maxBytes?: number;
}): Buffer {
  const sourcePath = path.resolve(String(input.sourcePath || ''));
  assertNativeCliProjectPathSeparation({
    projectRoot: input.projectRoot,
    sourcePath,
  });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`${input.label} is missing`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync.native(sourcePath) !== sourcePath) {
    throw new Error(`${input.label} must be a canonical regular file and may not be a symbolic link`);
  }
  const serviceUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (stat.uid !== serviceUid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${input.label} must be owned by the Portal service account with mode 0600 or stricter`);
  }
  const maxBytes = input.maxBytes || MAX_MANAGED_FILE_BYTES;
  if (stat.size < 1 || stat.size > maxBytes) {
    throw new Error(`${input.label} has an invalid size`);
  }
  return fs.readFileSync(sourcePath);
}

function requireManagedFile(filePath: string, label: string): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync.native(filePath) !== filePath) {
    throw new Error(`${label} must be a canonical regular file and may not be a symbolic link`);
  }
  if (
    stat.uid !== NATIVE_CLI_PROJECT_CONTAINER_UID
    || stat.gid !== NATIVE_CLI_PROJECT_CONTAINER_GID
    || (stat.mode & 0o777) !== 0o400
  ) {
    throw new Error(`${label} must be owned by the confined runtime with mode 0400`);
  }
  return stat;
}

function writeProtectedFileAtomic(filePath: string, content: Buffer): void {
  const parent = path.dirname(filePath);
  const tempPath = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = fs.openSync(
    tempPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chownSync(tempPath, NATIVE_CLI_PROJECT_CONTAINER_UID, NATIVE_CLI_PROJECT_CONTAINER_GID);
  fs.chmodSync(tempPath, 0o400);
  fs.renameSync(tempPath, filePath);
}

export function stageNativeCliProjectManagedFile(input: {
  context: ProjectSandboxExecutionContext;
  provider: NativeCliProjectRuntimeProvider;
  fileName: string;
  content: Buffer | string;
  label: string;
}): string {
  assertExecutionContextBinding(input.context, input.context.userId, 'PROJECT_SANDBOX');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.fileName)) {
    throw new Error('Native CLI Project managed file name is invalid');
  }
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
  if (content.length < 1 || content.length > MAX_MANAGED_FILE_BYTES) {
    throw new Error(`${input.label} has an invalid size`);
  }
  const stateRoot = configuredStateRoot();
  assertNativeCliProjectPathSeparation({
    projectRoot: input.context.canonicalRoot,
    stateRoot,
  });
  const providerRoot = ensureRuntimeDirectory(path.join(stateRoot, input.provider.toLowerCase()), {
    mode: 0o700,
    enforceMode: true,
  });
  const stateDir = ensureRuntimeDirectory(path.join(providerRoot, stateKey(input.context, input.provider)), {
    mode: 0o700,
    enforceMode: true,
  });
  const filePath = path.join(stateDir, input.fileName);
  const current = requireManagedFile(filePath, input.label);
  const currentContent = current ? fs.readFileSync(filePath) : null;
  if (!currentContent?.equals(content)) {
    writeProtectedFileAtomic(filePath, content);
  }
  requireManagedFile(filePath, input.label);
  fs.chownSync(stateDir, NATIVE_CLI_PROJECT_CONTAINER_UID, NATIVE_CLI_PROJECT_CONTAINER_GID);
  fs.chmodSync(stateDir, 0o500);
  return filePath;
}

export function removeNativeCliProjectManagedState(input: {
  context: ProjectSandboxExecutionContext;
  provider: NativeCliProjectRuntimeProvider;
}): void {
  assertExecutionContextBinding(input.context, input.context.userId, 'PROJECT_SANDBOX');
  removeNativeCliProjectManagedStateForIdentity({
    provider: input.provider,
    userId: input.context.userId,
    projectId: input.context.projectId,
    projectRoot: input.context.canonicalRoot,
  });
}

export function removeNativeCliProjectManagedStateForIdentity(input: {
  provider: NativeCliProjectRuntimeProvider;
  userId: string;
  projectId: string;
  projectRoot: string;
}): void {
  const stateRoot = configuredStateRoot();
  assertNativeCliProjectPathSeparation({
    projectRoot: input.projectRoot,
    stateRoot,
  });
  const providerRoot = path.join(stateRoot, input.provider.toLowerCase());
  const stateDir = nativeCliProjectStateDirectoryForIdentity(input);
  if (
    path.dirname(stateDir) !== providerRoot
    || !/^[a-f0-9]{64}$/.test(path.basename(stateDir))
  ) {
    throw new Error('Native CLI Project state cleanup identity is invalid');
  }
  let stateStat: fs.Stats;
  try {
    stateStat = fs.lstatSync(stateDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory() || fs.realpathSync.native(stateDir) !== stateDir) {
    throw new Error('Native CLI Project state cleanup target is unsafe');
  }
  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  if (entries.length > 16) throw new Error('Native CLI Project state cleanup target contains unexpected resources');
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.name)) {
      throw new Error('Native CLI Project state cleanup entry is invalid');
    }
    const filePath = path.join(stateDir, entry.name);
    const stat = fs.lstatSync(filePath);
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.uid !== NATIVE_CLI_PROJECT_CONTAINER_UID
      || stat.gid !== NATIVE_CLI_PROJECT_CONTAINER_GID
      || (stat.mode & 0o777) !== 0o400
    ) {
      throw new Error('Native CLI Project state cleanup entry is unsafe');
    }
  }
  for (const entry of entries) fs.unlinkSync(path.join(stateDir, entry.name));
  fs.rmdirSync(stateDir);
}

export const __nativeCliProjectManagedStateTest = {
  configuredStateRoot,
  stateKey,
  MAX_MANAGED_FILE_BYTES,
};
