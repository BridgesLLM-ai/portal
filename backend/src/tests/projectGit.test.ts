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
  removePreparedPortalProjectWorkloadContainer: removeWorkloadMock,
  resolvePinnedProjectRuntimeImage: resolveImageMock,
}));

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  __projectGitTest,
  assertSafeProjectGitRepository,
  assertSafeProjectGitUrl,
  buildProjectGitContainerArgs,
  runPreparedProjectGitCommand,
  spawnProjectGitCommand,
} from '../services/project-git.service';
import { PROJECT_RUNTIME_IMAGE } from '../services/project-lifecycle.service';

const SCOPE = { actorId: 'actor-1', projectId: 'project-1' };

function makeRepository(config = ''): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'portal-project-git-test-'));
  mkdirSync(path.join(workspace, '.git'));
  writeFileSync(path.join(workspace, '.git', 'config'), config || '[core]\n\trepositoryformatversion = 0\n');
  return workspace;
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

describe('isolated project Git runtime', () => {
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

  it('keeps project routes free of direct host Git process execution', () => {
    const source = readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    expect(source).not.toMatch(/execSync\s*\(\s*['"`]git\b/);
    expect(source).not.toMatch(/execFileSync\s*\(\s*['"`]git\b/);
    expect(source).not.toMatch(/spawn\s*\(\s*['"`]git\b/);
  });

  it('keeps the legacy argument builder fail-closed at network none', () => {
    const workspace = makeRepository();
    try {
      const args = buildProjectGitContainerArgs({ ...SCOPE, workspace, args: ['status', '--porcelain'] }, 'git-test');
      expect(args).toEqual(expect.arrayContaining([
        '--user', '1000:1000',
        '--mount', `type=bind,src=${workspace},dst=/workspace/project`,
        '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true',
        '--network', 'none',
        '--env', 'GIT_CONFIG_NOSYSTEM=1',
        '--env', 'GIT_CONFIG_GLOBAL=/dev/null',
        PROJECT_RUNTIME_IMAGE, 'git',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'credential.helper=',
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        'status', '--porcelain',
      ]));
      expect(args.filter((value) => value.startsWith('type=bind,'))).toHaveLength(1);
      expect(args.join(' ')).not.toContain('/root/.ssh');
      expect(args.join(' ')).not.toContain('/var/run/docker.sock');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ['hook path', '[core]\n\thooksPath = hooks\n'],
    ['filter process', '[filter "evil"]\n\tprocess = /workspace/project/steal.sh\n'],
    ['credential helper', '[credential]\n\thelper = !/workspace/project/steal.sh\n'],
    ['diff textconv', '[diff "evil"]\n\ttextconv = /workspace/project/steal.sh\n'],
    ['include', '[include]\n\tpath = /workspace/project/extra.conf\n'],
    ['URL rewrite', '[url "ext::sh -c evil"]\n\tinsteadOf = https://example.com/\n'],
  ])('rejects executable repository configuration: %s', (_label, config) => {
    const workspace = makeRepository(config);
    try {
      expect(() => assertSafeProjectGitRepository(workspace)).toThrow(/Unsafe project Git/);
      expect(prepareWorkloadMock).not.toHaveBeenCalled();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    'ext::sh -c id',
    'file:///etc/passwd',
    'git@github.com:owner/repo.git',
    'http://example.com/repo.git',
    'https://user:secret@example.com/repo.git',
    'https://127.0.0.1/repo.git',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.5/repo.git',
  ])('rejects unsafe or credential-bearing remote %s', (url) => {
    expect(() => assertSafeProjectGitUrl(url)).toThrow();
  });

  it('routes HTTPS Git through a unique Portal-owned workload plane without raw bridge or host pins', async () => {
    const workspace = makeRepository('[remote "origin"]\n\turl = https://github.com/example/repo.git\n');
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    try {
      const job = await spawnProjectGitCommand({ ...SCOPE, workspace, args: ['pull', '--ff-only'], network: true });
      expect(prepareWorkloadMock).toHaveBeenCalledWith(expect.objectContaining({
        identity: expect.objectContaining({ ...SCOPE, consumerKind: 'PORTAL_GIT', workloadId: expect.any(String) }),
        networked: true,
        command: 'git',
      }));
      expect(spawnMock).toHaveBeenCalledWith('/usr/bin/docker', ['container', 'start', '--attach', job.containerName], expect.objectContaining({
        env: __projectGitTest.dockerCliEnvironment(),
      }));
      expect(JSON.stringify(spawnMock.mock.calls)).not.toMatch(/--network|--add-host/);
      child.emit('close', 0, null);
      await expect(job.result).resolves.toBe('');
      await job.cleanup;
      expect(removeWorkloadMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps recursive ownership normalization on ordinary Git mutations', async () => {
    const workspace = makeRepository();
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    try {
      const job = await spawnProjectGitCommand({ ...SCOPE, workspace, args: ['add', '-A'] });
      expect(execFileSyncMock).toHaveBeenCalledWith('/usr/bin/chown', [
        '-R',
        '--no-dereference',
        '1000:1000',
        workspace,
      ], expect.objectContaining({ timeout: 60_000 }));
      child.emit('close', 0, null);
      await expect(job.result).resolves.toBe('');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('skips recursive ownership traversal for a prepared Project Chat checkpoint', async () => {
    const workspace = makeRepository();
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    try {
      const result = runPreparedProjectGitCommand({ ...SCOPE, workspace, args: ['add', '-A'] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(execFileSyncMock).not.toHaveBeenCalled();
      child.emit('close', 0, null);
      await expect(result).resolves.toBe('');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uses distinct runtime identities for concurrent Git jobs and cleans a cancelled job exactly once', async () => {
    const workspace = makeRepository('[remote "origin"]\n\turl = https://example.test/repo.git\n');
    const firstChild = makeChild();
    const secondChild = makeChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const controller = new AbortController();
    try {
      const first = await spawnProjectGitCommand({ ...SCOPE, workspace, args: ['pull', '--ff-only'], network: true, signal: controller.signal });
      const second = await spawnProjectGitCommand({ ...SCOPE, workspace, args: ['pull', '--ff-only'], network: true });
      expect(first.containerName).not.toBe(second.containerName);
      const workloadIds = prepareWorkloadMock.mock.calls.map((call) => call[0].identity.workloadId);
      expect(new Set(workloadIds).size).toBe(2);

      controller.abort();
      firstChild.emit('close', null, 'SIGTERM');
      secondChild.emit('close', 0, null);
      await expect(first.result).rejects.toThrow('cancelled');
      await expect(second.result).resolves.toBe('');
      expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(removeWorkloadMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a .git symlink and arbitrary Git subcommands before workload creation', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'portal-project-git-link-test-'));
    const other = mkdtempSync(path.join(os.tmpdir(), 'portal-other-git-test-'));
    mkdirSync(path.join(other, '.git'));
    symlinkSync(path.join(other, '.git'), path.join(workspace, '.git'));
    try {
      expect(() => assertSafeProjectGitRepository(workspace)).toThrow('.git must be a directory inside the project');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }

    const repository = makeRepository();
    try {
      expect(() => buildProjectGitContainerArgs({ ...SCOPE, workspace: repository, args: ['config', '--local', 'credential.helper', '!evil'] }, 'bad'))
        .toThrow('subcommand is not allowed');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
