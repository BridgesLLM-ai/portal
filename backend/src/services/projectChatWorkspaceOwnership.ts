import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';
import {
  prepareProjectChatLifecycleWorkspace,
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from './project-lifecycle.service';
import { attestProjectRoot } from './projectIdentity';

const OWNERSHIP_CONTRACT_VERSION = 1;

type WorkspaceOwnershipMarker = Readonly<{
  version: typeof OWNERSHIP_CONTRACT_VERSION;
  projectId: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  runtimeUid: number;
  runtimeGid: number;
  completedAt: string;
}>;

type WorkspaceOwnershipDependencies = Readonly<{
  prepareWorkspace?: (workspace: string) => Promise<string>;
  markerRoot?: string;
}>;

const pendingPreparations = new Map<string, Promise<string>>();

function defaultMarkerRoot(): string {
  const override = process.env.PORTAL_PROJECT_CHAT_OWNERSHIP_ROOT;
  if (override) return path.resolve(override);
  if (process.env.PORTAL_DATA_ROOT) {
    return path.resolve(
      process.env.PORTAL_DATA_ROOT,
      '.data',
      'project-chat-workspace-ownership',
    );
  }
  if (process.env.NODE_ENV === 'production') {
    return '/var/lib/bridgesllm/project-chat-workspace-ownership';
  }
  return path.resolve(
    process.env.PORTAL_ROOT || '/opt/bridgesllm/portal',
    '.data',
    'project-chat-workspace-ownership',
  );
}

function markerPath(context: ProjectSandboxExecutionContext, markerRoot?: string): string {
  const root = ensureRuntimeDirectory(markerRoot || defaultMarkerRoot(), {
    mode: 0o700,
    enforceMode: true,
  });
  const rootStat = fs.lstatSync(root);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : rootStat.uid;
  if (
    rootStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || rootStat.uid !== expectedUid
    || (rootStat.mode & 0o077) !== 0
    || fs.realpathSync.native(root) !== root
  ) {
    throw new Error('Project Chat ownership marker directory is not private');
  }
  const identity = crypto.createHash('sha256')
    .update(`${context.projectId}\0${context.workspaceOwnerId}`)
    .digest('hex');
  return path.join(root, `${identity}.json`);
}

function expectedMarker(context: ProjectSandboxExecutionContext): Omit<WorkspaceOwnershipMarker, 'completedAt'> {
  return {
    version: OWNERSHIP_CONTRACT_VERSION,
    projectId: context.projectId,
    workspaceOwnerId: context.workspaceOwnerId,
    projectName: context.projectName,
    canonicalRoot: context.canonicalRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
    runtimeUid: PROJECT_RUNTIME_UID,
    runtimeGid: PROJECT_RUNTIME_GID,
  };
}

function markerMatches(
  marker: WorkspaceOwnershipMarker,
  expected: Omit<WorkspaceOwnershipMarker, 'completedAt'>,
): boolean {
  return Object.entries(expected).every(([key, value]) => (
    marker[key as keyof WorkspaceOwnershipMarker] === value
  )) && typeof marker.completedAt === 'string' && Number.isFinite(Date.parse(marker.completedAt));
}

function readMarker(
  file: string,
  expected: Omit<WorkspaceOwnershipMarker, 'completedAt'>,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.uid !== expectedUid
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error('Project Chat ownership marker is unsafe');
  }
  let parsed: WorkspaceOwnershipMarker;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceOwnershipMarker;
  } catch {
    throw new Error('Project Chat ownership marker is malformed');
  }
  return markerMatches(parsed, expected);
}

function atomicWriteMarker(file: string, marker: WorkspaceOwnershipMarker): void {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = fs.openSync(temporary, 'wx', 0o600);
  let renamed = false;
  try {
    fs.writeFileSync(handle, `${JSON.stringify(marker)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    fs.renameSync(temporary, file);
    renamed = true;
    fs.chmodSync(file, 0o600);
    const directoryHandle = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(directoryHandle);
    } finally {
      fs.closeSync(directoryHandle);
    }
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // The successful write path already closed the handle before rename.
    }
    if (!renamed) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Nothing remains when an earlier operation already consumed it.
      }
    }
  }
}

function assertContextRoot(context: ProjectSandboxExecutionContext, projectDir: string): void {
  const root = attestProjectRoot(projectDir);
  if (
    root.canonicalRoot !== context.canonicalRoot
    || root.rootDevice !== context.rootDevice
    || root.rootInode !== context.rootInode
    || root.rootBirthtimeNs !== context.rootBirthtimeNs
  ) {
    throw new Error('Project Chat workspace no longer matches its immutable identity');
  }
}

/**
 * Adopt files written by pre-contract Portal releases exactly once for an
 * immutable Project root. The marker is server-owned durable state outside the
 * repository; subsequent warm sends perform only constant-time attestation.
 */
export async function ensureProjectChatWorkspaceOwnership(
  context: ProjectSandboxExecutionContext,
  projectDir: string,
  dependencies: WorkspaceOwnershipDependencies = {},
): Promise<string> {
  assertContextRoot(context, projectDir);
  const file = markerPath(context, dependencies.markerRoot);
  const expected = expectedMarker(context);
  if (readMarker(file, expected)) return context.canonicalRoot;

  const existing = pendingPreparations.get(file);
  if (existing) return existing;

  const preparation = (async () => {
    const prepare = dependencies.prepareWorkspace || prepareProjectChatLifecycleWorkspace;
    await prepare(context.canonicalRoot);
    // A root replacement during recursive adoption must never acquire a valid
    // marker for the old identity.
    assertContextRoot(context, projectDir);
    atomicWriteMarker(file, {
      ...expected,
      completedAt: new Date().toISOString(),
    });
    return context.canonicalRoot;
  })();
  pendingPreparations.set(file, preparation);
  try {
    return await preparation;
  } finally {
    if (pendingPreparations.get(file) === preparation) pendingPreparations.delete(file);
  }
}

export const __projectChatWorkspaceOwnershipTest = {
  defaultMarkerRoot,
  markerPath,
  pendingPreparations,
};
