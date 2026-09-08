import { EventEmitter } from 'events';

const execFileSyncMock = jest.fn();
const execFileMock = jest.fn();
const spawnMock = jest.fn();
const prepareWorkloadMock = jest.fn();
const removeWorkloadMock = jest.fn();
const resolveImageMock = jest.fn();

jest.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

jest.mock('../services/projectWorkloadRuntime', () => ({
  preparePortalProjectWorkloadContainer: prepareWorkloadMock,
  removePortalProjectWorkloadByIdentity: jest.fn(),
  removePreparedPortalProjectWorkloadContainer: removeWorkloadMock,
  resolvePinnedProjectRuntimeImage: resolveImageMock,
  startPreparedPortalProjectWorkloadContainer: jest.fn(),
}));

import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  __projectLifecycleTest,
  buildProjectContainerArgs,
  copyDesktopRuntimeDeploymentTree,
  copyFullstackDeploymentTree,
  copyStaticDeploymentTree,
  prepareFullstackDeploymentTree,
  ProjectDeploymentReplayStaleError,
  recoverInterruptedDeploymentPromotions,
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_IMAGE,
  PROJECT_RUNTIME_UID,
  prepareProjectChatLifecycleWorkspace,
  runProjectLifecycleCommand,
  spawnProjectLifecycleCommand,
} from '../services/project-lifecycle.service';

const SCOPE = { actorId: 'actor-1', projectId: 'project-1' };

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'portal-project-lifecycle-test-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { postinstall: 'node -e "process.exit(0)"' },
  }));
  return dir;
}

function makeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = jest.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('project lifecycle sandbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '');
      return makeChild();
    });
    execFileSyncMock.mockReturnValue('');
    resolveImageMock.mockResolvedValue(`sha256:${'a'.repeat(64)}`);
    prepareWorkloadMock.mockImplementation(async (options: any) => ({
      ...options,
      runtimeFingerprint: 'f'.repeat(64),
      egressSpec: options.networked ? { internalNetworkName: 'egress-internal' } : null,
    }));
    removeWorkloadMock.mockResolvedValue(undefined);
  });

  it('prepares Project Chat ownership asynchronously without using synchronous chown', async () => {
    const workspace = makeWorkspace();
    let finish: ((error: Error | null, stdout?: string, stderr?: string) => void) | null = null;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      finish = callback;
      return makeChild();
    });
    try {
      let settled = false;
      const preparation = prepareProjectChatLifecycleWorkspace(workspace).then((value) => {
        settled = true;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settled).toBe(false);
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(execFileMock).toHaveBeenCalledWith('/usr/bin/chown', [
        '-R',
        '--no-dereference',
        `${PROJECT_RUNTIME_UID}:${PROJECT_RUNTIME_GID}`,
        workspace,
      ], expect.objectContaining({
        timeout: 60_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      }), expect.any(Function));

      finish!(null, '', '');
      await expect(preparation).resolves.toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('bounds Project Chat ownership failures and preserves workspace link rejection', async () => {
    const workspace = makeWorkspace();
    const link = `${workspace}-link`;
    symlinkSync(workspace, link);
    try {
      await expect(prepareProjectChatLifecycleWorkspace(link)).rejects.toThrow(
        'Project lifecycle workspace cannot be a symbolic link',
      );
      expect(execFileMock).not.toHaveBeenCalled();

      execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
        callback(Object.assign(new Error('private chown detail'), {
          killed: true,
          code: 'ETIMEDOUT',
        }), '', '');
        return makeChild();
      });
      await expect(prepareProjectChatLifecycleWorkspace(workspace)).rejects.toMatchObject({
        name: 'ProjectLifecycleWorkspacePreparationError',
        code: 'PROJECT_WORKSPACE_PREPARATION_FAILED',
        retryable: true,
        message: 'Project workspace ownership preparation exceeded 60 seconds.',
      });
    } finally {
      rmSync(link, { force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the legacy builder non-root, one-bind, capability-free, and offline', () => {
    const workspace = makeWorkspace();
    try {
      const args = buildProjectContainerArgs({ ...SCOPE, workspace, command: 'npm', args: ['install'] }, 'test-container');
      expect(args).toEqual(expect.arrayContaining([
        '--user', `${PROJECT_RUNTIME_UID}:${PROJECT_RUNTIME_GID}`,
        '--mount', `type=bind,src=${workspace},dst=/workspace/project`,
        '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true',
        '--pids-limit', '256', '--network', 'none',
        PROJECT_RUNTIME_IMAGE, 'npm', 'install',
      ]));
      expect(args.filter((value) => value.startsWith('type=bind,'))).toHaveLength(1);
      expect(args.join(' ')).not.toContain('/var/run/docker.sock');
      expect(args).not.toContain('--privileged');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps local syntax/build work offline and routes explicit package work through the shared proxy plane', async () => {
    const workspace = makeWorkspace();
    const localChild = makeChild();
    const networkChild = makeChild();
    spawnMock.mockReturnValueOnce(localChild).mockReturnValueOnce(networkChild);
    try {
      const local = await spawnProjectLifecycleCommand({ ...SCOPE, workspace, command: 'node', args: ['--check', 'index.js'] });
      const networked = await spawnProjectLifecycleCommand({ ...SCOPE, workspace, command: 'npm', args: ['install'], network: true });
      expect(prepareWorkloadMock.mock.calls[0][0]).toEqual(expect.objectContaining({
        identity: expect.objectContaining({ ...SCOPE, consumerKind: 'PORTAL_LIFECYCLE' }),
        networked: false,
      }));
      expect(prepareWorkloadMock.mock.calls[1][0]).toEqual(expect.objectContaining({
        identity: expect.objectContaining({ ...SCOPE, consumerKind: 'PORTAL_LIFECYCLE' }),
        networked: true,
      }));
      expect(local.containerName).not.toBe(networked.containerName);
      expect(JSON.stringify(spawnMock.mock.calls)).not.toMatch(/--network|--add-host/);
      localChild.emit('close', 0, null);
      networkChild.emit('close', 0, null);
      await Promise.all([local.cleanup, networked.cleanup]);
      expect(removeWorkloadMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns output only after the exact workload cleanup succeeds', async () => {
    const workspace = makeWorkspace();
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    try {
      const result = runProjectLifecycleCommand({ ...SCOPE, workspace, command: 'npm', args: ['install'], network: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.stdout.emit('data', Buffer.from('installed\n'));
      child.emit('close', 0, null);
      await expect(result).resolves.toBe('installed\n');
      expect(removeWorkloadMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed instead of allowing apt, sudo, or arbitrary commands', () => {
    const workspace = makeWorkspace();
    try {
      expect(() => buildProjectContainerArgs({ ...SCOPE, workspace, command: 'apt-get', args: ['install', 'curl'] }, 'apt-job')).toThrow('not allowed');
      expect(() => buildProjectContainerArgs({ ...SCOPE, workspace, command: 'sudo', args: ['anything'] }, 'sudo-job')).toThrow('not allowed');
      expect(() => buildProjectContainerArgs({ ...SCOPE, workspace, command: '/bin/bash', args: ['-c', 'id'] }, 'shell-job')).toThrow('not allowed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('force-cleans a streaming job when the client cancels', async () => {
    const workspace = makeWorkspace();
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    try {
      const job = await spawnProjectLifecycleCommand({ ...SCOPE, workspace, command: 'npm', args: ['install'], network: true });
      job.cancel();
      child.emit('close', null, 'SIGTERM');
      await job.cleanup;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(removeWorkloadMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith('/usr/bin/docker', ['container', 'start', '--attach', job.containerName], expect.objectContaining({
        env: __projectLifecycleTest.dockerCliEnvironment(),
      }));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects static build symlinks instead of exposing host files', () => {
    const workspace = makeWorkspace();
    const destination = path.join(os.tmpdir(), `portal-static-deploy-${Date.now()}`);
    symlinkSync('/etc/passwd', path.join(workspace, 'leak'));
    try {
      expect(() => copyStaticDeploymentTree(workspace, destination)).toThrow('cannot contain symbolic links');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('promotes static deployments by replacing the prior tree as one directory swap', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-static-parent-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'index.html'), 'first');
      writeFileSync(path.join(workspace, '.env'), 'PRIVATE=value');
      writeFileSync(path.join(workspace, 'private.pem'), 'PRIVATE KEY');
      writeFileSync(path.join(workspace, 'package.json'), '{"private":true}');
      mkdirSync(path.join(workspace, 'node_modules'));
      symlinkSync('/etc/passwd', path.join(workspace, 'node_modules', 'ignored-link'));
      copyStaticDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, 'index.html'), 'utf8')).toBe('first');
      expect(() => readFileSync(path.join(destination, '.env'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, 'private.pem'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, 'package.json'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, 'node_modules', 'ignored-link'), 'utf8')).toThrow();

      writeFileSync(path.join(workspace, 'index.html'), 'second');
      writeFileSync(path.join(destination, 'stale.txt'), 'stale');
      copyStaticDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, 'index.html'), 'utf8')).toBe('second');
      expect(() => readFileSync(path.join(destination, 'stale.txt'), 'utf8')).toThrow();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('preserves managed static deployment data while still deleting stale assets', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-static-data-parent-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'index.html'), 'first');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'state.json'), 'seed');
      copyStaticDeploymentTree(workspace, destination);
      writeFileSync(path.join(destination, 'data', 'state.json'), 'runtime');
      writeFileSync(path.join(destination, 'stale.js'), 'stale');
      writeFileSync(path.join(workspace, 'index.html'), 'second');
      writeFileSync(path.join(workspace, 'data', 'state.json'), 'replacement seed');

      copyStaticDeploymentTree(workspace, destination);

      expect(readFileSync(path.join(destination, 'index.html'), 'utf8')).toBe('second');
      expect(readFileSync(path.join(destination, 'data', 'state.json'), 'utf8')).toBe('runtime');
      expect(() => readFileSync(path.join(destination, 'stale.js'), 'utf8')).toThrow();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('atomically replaces fullstack deployments while preserving runtime configuration', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-fullstack-parent-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, '.env'), 'RUNTIME=value');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(destination, 'stale.txt'), 'stale');
      writeFileSync(path.join(workspace, 'server.js'), 'updated');

      const promotion = copyFullstackDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, '.env'), 'utf8')).toBe('RUNTIME=value');
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('updated');
      expect(() => readFileSync(path.join(destination, 'stale.txt'), 'utf8')).toThrow();
      promotion.finalize();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('preserves only the exact managed data root while replacing stale deployed code', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-deploy-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'league.json'), 'seed');
      copyFullstackDeploymentTree(workspace, destination).finalize();

      writeFileSync(path.join(destination, 'data', 'league.json'), 'runtime-v45');
      chmodSync(path.join(destination, 'data'), 0o750);
      chmodSync(path.join(destination, 'data', 'league.json'), 0o640);
      const priorDataStat = statSync(path.join(destination, 'data'));
      const priorFileStat = statSync(path.join(destination, 'data', 'league.json'));
      writeFileSync(path.join(destination, 'stale-server.js'), 'must disappear');
      mkdirSync(path.join(destination, 'uploads'));
      writeFileSync(path.join(destination, 'uploads', 'runtime-only.bin'), 'not managed');
      writeFileSync(path.join(workspace, 'server.js'), 'new');
      writeFileSync(path.join(workspace, 'data', 'league.json'), 'new seed must not win');

      const promotion = copyFullstackDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('new');
      expect(readFileSync(path.join(destination, 'data', 'league.json'), 'utf8')).toBe('runtime-v45');
      expect(statSync(path.join(destination, 'data')).mode & 0o777).toBe(0o750);
      expect(statSync(path.join(destination, 'data', 'league.json')).mode & 0o777).toBe(0o640);
      expect(statSync(path.join(destination, 'data')).uid).toBe(priorDataStat.uid);
      expect(statSync(path.join(destination, 'data')).gid).toBe(priorDataStat.gid);
      expect(statSync(path.join(destination, 'data', 'league.json')).uid).toBe(priorFileStat.uid);
      expect(statSync(path.join(destination, 'data', 'league.json')).gid).toBe(priorFileStat.gid);
      expect(() => readFileSync(path.join(destination, 'stale-server.js'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, 'uploads', 'runtime-only.bin'), 'utf8')).toThrow();
      promotion.finalize();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('restores the prior code and persistent data snapshot after replacement rollback', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-rollback-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'league.json'), 'seed');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(destination, 'data', 'league.json'), 'runtime-before-deploy');
      writeFileSync(path.join(workspace, 'server.js'), 'replacement');

      const promotion = copyFullstackDeploymentTree(workspace, destination);
      writeFileSync(path.join(destination, 'data', 'league.json'), 'failed-generation-write');
      promotion.rollback();

      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      expect(readFileSync(path.join(destination, 'data', 'league.json'), 'utf8'))
        .toBe('runtime-before-deploy');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it.each([
    'after-persistent-data-stage',
    'after-previous-deployment-move',
    'after-deployment-promote',
  ] as const)('rolls back a fault at %s without losing persistent data', (checkpoint) => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-fault-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'state.json'), 'durable');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(workspace, 'server.js'), 'replacement');

      const promotion = prepareFullstackDeploymentTree(
        workspace,
        destination,
        undefined,
        undefined,
        (observed) => {
          if (observed === checkpoint) throw new Error(`fault:${checkpoint}`);
        },
      );
      expect(() => promotion.promote()).toThrow(`fault:${checkpoint}`);
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      expect(readFileSync(path.join(destination, 'data', 'state.json'), 'utf8')).toBe('durable');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('recovers an interrupted journaled preparation before any live mutation', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-recovery-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'state.json'), 'durable');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(workspace, 'server.js'), 'replacement');

      expect(() => prepareFullstackDeploymentTree(
        workspace,
        destination,
        undefined,
        undefined,
        (checkpoint) => {
          if (checkpoint === 'after-deployment-journal-create') throw new Error('simulated process exit');
        },
      )).toThrow('simulated process exit');

      expect(recoverInterruptedDeploymentPromotions(destinationParent)).toEqual({
        rolledBack: 1,
        committed: 0,
      });
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      expect(readFileSync(path.join(destination, 'data', 'state.json'), 'utf8')).toBe('durable');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('converges a durably committed promotion forward after cleanup interruption', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-commit-recovery-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'state.json'), 'seed');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(destination, 'data', 'state.json'), 'durable');
      writeFileSync(path.join(workspace, 'server.js'), 'replacement');

      const promotion = prepareFullstackDeploymentTree(
        workspace,
        destination,
        undefined,
        undefined,
        (checkpoint) => {
          if (checkpoint === 'after-deployment-commit') throw new Error('simulated cleanup interruption');
        },
      );
      promotion.promote();
      expect(() => promotion.finalize()).toThrow('simulated cleanup interruption');
      expect(recoverInterruptedDeploymentPromotions(destinationParent)).toEqual({
        rolledBack: 0,
        committed: 1,
      });
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('replacement');
      expect(readFileSync(path.join(destination, 'data', 'state.json'), 'utf8')).toBe('durable');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('bounds pre-journal staging leftovers and refuses a substituted staging symlink', () => {
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-orphan-'));
    const destination = path.join(destinationParent, 'deployed-app');
    const orphan = path.join(destinationParent, '.deployed-app.deploy-123-0123456789abcdef');
    const unpublishedJournal = path.join(
      destinationParent,
      '.deployed-app.deployment-123-0123456789abcdef.json.tmp-123-fedcba9876543210',
    );
    const outside = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-outside-'));
    try {
      mkdirSync(orphan, { mode: 0o700 });
      writeFileSync(unpublishedJournal, 'private temporary journal');
      chmodSync(unpublishedJournal, 0o600);
      expect(recoverInterruptedDeploymentPromotions(destinationParent)).toEqual({
        rolledBack: 0,
        committed: 0,
      });
      expect(readdirSync(destinationParent)).not.toContain(path.basename(orphan));
      expect(readdirSync(destinationParent)).not.toContain(path.basename(unpublishedJournal));

      writeFileSync(path.join(outside, 'must-survive'), 'outside');
      symlinkSync(outside, orphan);
      expect(() => recoverInterruptedDeploymentPromotions(destinationParent)).toThrow(/not private server-owned/i);
      expect(readFileSync(path.join(outside, 'must-survive'), 'utf8')).toBe('outside');
      rmSync(orphan, { force: true });
      expect(readdirSync(destinationParent)).not.toContain(path.basename(destination));
    } finally {
      rmSync(destinationParent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails closed on symlinked, hard-linked, or type-conflicting managed data', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-persistent-invalid-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      mkdirSync(path.join(workspace, 'data'));
      writeFileSync(path.join(workspace, 'data', 'state.json'), 'durable');
      copyFullstackDeploymentTree(workspace, destination).finalize();

      symlinkSync('/etc/passwd', path.join(destination, 'data', 'escape'));
      writeFileSync(path.join(workspace, 'server.js'), 'replacement');
      expect(() => copyFullstackDeploymentTree(workspace, destination)).toThrow(/real directory|unsupported|symbolic|escaped/i);
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      rmSync(path.join(destination, 'data', 'escape'));

      linkSync(
        path.join(destination, 'data', 'state.json'),
        path.join(destination, 'data', 'hard-link'),
      );
      expect(() => copyFullstackDeploymentTree(workspace, destination)).toThrow(/hard-linked/i);
      expect(readFileSync(path.join(destination, 'data', 'state.json'), 'utf8')).toBe('durable');
      rmSync(path.join(destination, 'data', 'hard-link'));

      rmSync(path.join(workspace, 'data'), { recursive: true, force: true });
      writeFileSync(path.join(workspace, 'data'), 'conflict');
      expect(() => copyFullstackDeploymentTree(workspace, destination)).toThrow(/conflicts with managed persistent path/i);
      expect(readFileSync(path.join(destination, 'data', 'state.json'), 'utf8')).toBe('durable');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('rebuilds desktop runtime trees without relocated environments or stale files', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-desktop-parent-'));
    const destination = path.join(destinationParent, 'desktop-runtime');
    try {
      writeFileSync(path.join(workspace, '.env'), 'RUNTIME=value');
      writeFileSync(path.join(workspace, 'main.py'), 'print("fresh")');
      mkdirSync(path.join(workspace, '.venv'), { recursive: true });
      writeFileSync(path.join(workspace, '.venv', 'poisoned-pip'), '#!/workspace/project/.venv/bin/python3');
      mkdirSync(path.join(workspace, '.portal'), { recursive: true });
      writeFileSync(path.join(workspace, '.portal', 'private-state'), 'private');

      mkdirSync(destination);
      writeFileSync(path.join(destination, 'stale.py'), 'print("stale")');
      mkdirSync(path.join(destination, '.venv'));
      writeFileSync(path.join(destination, '.venv', 'old-python'), 'stale');

      copyDesktopRuntimeDeploymentTree(workspace, destination);

      expect(readFileSync(path.join(destination, 'main.py'), 'utf8')).toBe('print("fresh")');
      expect(readFileSync(path.join(destination, '.env'), 'utf8')).toBe('RUNTIME=value');
      expect(() => readFileSync(path.join(destination, 'stale.py'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, '.venv', 'old-python'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, '.venv', 'poisoned-pip'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(destination, '.portal', 'private-state'), 'utf8')).toThrow();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.desktop-runtime.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('restores the prior fullstack tree when promotion is rolled back', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-fullstack-rollback-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(workspace, 'server.js'), 'new');

      const promotion = copyFullstackDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('new');
      promotion.rollback();
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('prepares a fullstack tree without changing the live deployment before admission', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-fullstack-prepare-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'old');
      copyFullstackDeploymentTree(workspace, destination).finalize();
      writeFileSync(path.join(workspace, 'server.js'), 'new');

      const prepared = prepareFullstackDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      expect(prepared.sourceDigest).toMatch(/^[a-f0-9]{64}$/);

      prepared.rollback();
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);

      const admitted = prepareFullstackDeploymentTree(workspace, destination);
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('old');
      admitted.promote();
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('new');
      admitted.finalize();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });

  it('replays a fullstack deployment only for the exact copied source digest', () => {
    const workspace = makeWorkspace();
    const destinationParent = mkdtempSync(path.join(os.tmpdir(), 'portal-fullstack-replay-'));
    const destination = path.join(destinationParent, 'deployed-app');
    try {
      writeFileSync(path.join(workspace, 'server.js'), 'attempted source');
      const failedAttempt = copyFullstackDeploymentTree(workspace, destination);
      expect(failedAttempt.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      const attemptedDigest = failedAttempt.sourceDigest;
      failedAttempt.rollback();
      expect(() => readFileSync(path.join(destination, 'server.js'), 'utf8')).toThrow();

      writeFileSync(path.join(workspace, 'server.js'), 'changed in another tab');
      expect(() => copyFullstackDeploymentTree(
        workspace,
        destination,
        attemptedDigest,
      )).toThrow(ProjectDeploymentReplayStaleError);
      expect(() => readFileSync(path.join(destination, 'server.js'), 'utf8')).toThrow();
      expect(readdirSync(destinationParent).filter((entry) => entry.startsWith('.deployed-app.'))).toEqual([]);

      writeFileSync(path.join(workspace, 'server.js'), 'attempted source');
      const exactReplay = copyFullstackDeploymentTree(workspace, destination, attemptedDigest);
      expect(exactReplay.sourceDigest).toBe(attemptedDigest);
      exactReplay.finalize();
      expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('attempted source');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(destinationParent, { recursive: true, force: true });
    }
  });
});
