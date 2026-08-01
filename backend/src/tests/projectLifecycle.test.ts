import { EventEmitter } from 'events';

const execFileSyncMock = jest.fn();
const spawnMock = jest.fn();
const prepareWorkloadMock = jest.fn();
const removeWorkloadMock = jest.fn();
const resolveImageMock = jest.fn();

jest.mock('child_process', () => ({
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

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  __projectLifecycleTest,
  buildProjectContainerArgs,
  copyDesktopRuntimeDeploymentTree,
  copyFullstackDeploymentTree,
  copyStaticDeploymentTree,
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_IMAGE,
  PROJECT_RUNTIME_UID,
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
    execFileSyncMock.mockReturnValue('');
    resolveImageMock.mockResolvedValue(`sha256:${'a'.repeat(64)}`);
    prepareWorkloadMock.mockImplementation(async (options: any) => ({
      ...options,
      runtimeFingerprint: 'f'.repeat(64),
      egressSpec: options.networked ? { internalNetworkName: 'egress-internal' } : null,
    }));
    removeWorkloadMock.mockResolvedValue(undefined);
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
});
