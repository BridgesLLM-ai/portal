import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { managedDesktopSystemdRunArgv } from '../utils/desktopEnv';
import {
  REMOTE_DESKTOP_OPEN_MAX_ENTRIES,
  REMOTE_DESKTOP_OPEN_TTL_MS,
  RemoteDesktopOpenPathError,
  cleanupRemoteDesktopOpenPathSnapshots,
  openRemoteDesktopPath,
  selectOpenClawAgentWorkspace,
  type RemoteDesktopAgentAuthority,
  type RemoteDesktopOpenPathOptions,
} from './remoteDesktopOpenPath';

describe('Remote Desktop chat-linked file opening', () => {
  let temporaryRoot: string;
  let workspace: string;
  let projectRoot: string;
  let stagingRoot: string;
  let launch: jest.Mock;
  let projectGeneration: number;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-rd-open-'));
    workspace = path.join(temporaryRoot, 'agent-workspace');
    projectRoot = path.join(temporaryRoot, 'project-root');
    stagingRoot = path.join(temporaryRoot, 'staging');
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(projectRoot, { mode: 0o700 });
    launch = jest.fn();
    projectGeneration = 1;
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function options(overrides: Partial<RemoteDesktopOpenPathOptions> = {}): RemoteDesktopOpenPathOptions {
    return {
      stagingRoot,
      desktopUid: process.getuid?.() ?? 0,
      desktopGid: process.getgid?.() ?? 0,
      launch,
      ...overrides,
    };
  }

  function agentAuthority(
    root = workspace,
    agentId = 'main',
    isCurrent: () => Promise<boolean> = async () => true,
  ): RemoteDesktopAgentAuthority {
    return {
      agentId,
      resolvedWorkspace: fs.realpathSync.native(root),
      isCurrent: jest.fn(isCurrent),
    };
  }

  function mainAgentPath(filePath: unknown) {
    return {
      source: 'agent-workspace' as const,
      agent: 'main',
      path: filePath,
      agentAuthority: agentAuthority(),
    };
  }

  function projectAuthority(root = projectRoot, generation = projectGeneration) {
    const stat = fs.lstatSync(root, { bigint: true });
    return {
      identityId: 'project-identity-id',
      generation,
      canonicalRoot: fs.realpathSync.native(root),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
      isCurrent: jest.fn(async () => projectGeneration === generation),
    };
  }

  function onlySnapshot(): { requestDirectory: string; snapshotPath: string } {
    const requestNames = fs.readdirSync(stagingRoot);
    expect(requestNames).toHaveLength(1);
    const requestDirectory = path.join(stagingRoot, requestNames[0]);
    const entries = fs.readdirSync(requestDirectory);
    expect(entries).toHaveLength(1);
    return { requestDirectory, snapshotPath: path.join(requestDirectory, entries[0]) };
  }

  test('snapshots text with exact modes and launches literal argv with editor location', async () => {
    const sourceName = `report $(); 'quoted' final.md`;
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(sourcePath, 'durable result\n');

    await expect(openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'main',
      path: `${sourcePath}:42:7`,
      agentAuthority: agentAuthority(),
    }, options())).resolves.toEqual({
      ok: true,
      accepted: true,
      mode: 'snapshot',
      targetType: 'file',
    });

    const { requestDirectory, snapshotPath } = onlySnapshot();
    expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('durable result\n');
    expect(path.basename(snapshotPath)).toBe(sourceName);
    expect(fs.lstatSync(stagingRoot).mode & 0o777).toBe(0o710);
    expect(fs.lstatSync(requestDirectory).mode & 0o777).toBe(0o750);
    expect(fs.lstatSync(snapshotPath).mode & 0o777).toBe(0o440);
    expect(launch).toHaveBeenCalledWith(
      '/usr/bin/mousepad',
      ['--disable-server', '--line=42', '--column=7', snapshotPath],
      expect.stringMatching(/^bridgesllm-open-path-[a-f0-9]{32}\.service$/),
    );

    const argv = managedDesktopSystemdRunArgv(
      'bridgesllm-open-path-test.service',
      '/usr/bin/mousepad',
      ['--disable-server', snapshotPath],
    );
    expect(argv.slice(-3)).toEqual(['/usr/bin/mousepad', '--disable-server', snapshotPath]);
    expect(argv).not.toContain('/bin/bash');
    expect(argv).not.toContain('-c');
  });

  test('tries a literal colon filename before treating a suffix as a line number', async () => {
    const literal = path.join(workspace, 'notes:42');
    fs.writeFileSync(literal, 'literal colon');
    await openRemoteDesktopPath(mainAgentPath(literal), options());
    const { snapshotPath } = onlySnapshot();
    expect(path.basename(snapshotPath)).toBe('notes:42');
    expect(launch.mock.calls[0][1]).toEqual([snapshotPath]);
  });

  test('binds a relative Agent link to the exact gateway-materialized workspace', async () => {
    const otherWorkspace = path.join(temporaryRoot, 'other-agent-workspace');
    fs.mkdirSync(otherWorkspace, { mode: 0o700 });
    fs.writeFileSync(path.join(workspace, 'relative.md'), 'main workspace');
    fs.writeFileSync(path.join(otherWorkspace, 'relative.md'), 'other workspace');
    const snapshot = selectOpenClawAgentWorkspace([
      { id: 'main', workspace },
      { id: 'Other', workspace: otherWorkspace },
    ], 'OTHER');
    expect(snapshot).toEqual({
      agentId: 'other',
      resolvedWorkspace: otherWorkspace,
    });

    await openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'other',
      path: 'relative.md',
      agentAuthority: { ...snapshot, isCurrent: jest.fn(async () => true) },
    }, options());
    const { snapshotPath } = onlySnapshot();
    expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('other workspace');

    await expect(openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'other',
      path: path.join(workspace, 'main-only.md'),
      agentAuthority: { ...snapshot, isCurrent: jest.fn(async () => true) },
    }, options({ stagingRoot: path.join(temporaryRoot, 'wrong-agent-staging') })))
      .rejects.toMatchObject({ statusCode: 403, code: 'PATH_OUTSIDE_AUTHORITY' });
  });

  test('fails closed on absent, relative, or ambiguous materialized Agent authority', () => {
    expect(() => selectOpenClawAgentWorkspace([
      { id: 'main', workspace },
    ], 'missing')).toThrow(expect.objectContaining({
      statusCode: 503,
      code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
    }));
    expect(() => selectOpenClawAgentWorkspace([
      { id: 'main', workspace: '.' },
    ], 'main')).toThrow(expect.objectContaining({
      statusCode: 503,
      code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
    }));
    expect(() => selectOpenClawAgentWorkspace([
      { id: 'Other Agent', workspace },
      { id: 'other-agent', workspace },
    ], 'other-agent')).toThrow(expect.objectContaining({
      statusCode: 503,
      code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
    }));
    expect(() => selectOpenClawAgentWorkspace({ main: { workspace } }, 'main'))
      .toThrow(expect.objectContaining({
        statusCode: 503,
        code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
      }));
  });

  test('rejects mismatched or changed Agent authority around the snapshot copy', async () => {
    const sourcePath = path.join(workspace, 'authority.md');
    fs.writeFileSync(sourcePath, 'authority-bound');
    await expect(openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'other',
      path: sourcePath,
      agentAuthority: agentAuthority(workspace, 'main'),
    }, options())).rejects.toMatchObject({ statusCode: 409, code: 'AGENT_AUTHORITY_CHANGED' });

    let current = true;
    const changingAuthority = agentAuthority(workspace, 'main', async () => current);
    await expect(openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'main',
      path: sourcePath,
      agentAuthority: changingAuthority,
    }, options({
      afterSourceAdmission: () => { current = false; },
    }))).rejects.toMatchObject({ statusCode: 409, code: 'AGENT_AUTHORITY_CHANGED' });
    expect(changingAuthority.isCurrent).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
  });

  test('maps the provider project workspace and rejects paths outside that exact root', async () => {
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'answer.ts'), 'export const answer = 42;');
    const authority = projectAuthority();
    await openRemoteDesktopPath({
      source: 'project',
      path: '/workspace/project/src/answer.ts#L8C3',
      projectAuthority: authority,
    }, options());
    const { snapshotPath } = onlySnapshot();
    expect(launch).toHaveBeenCalledWith(
      '/usr/bin/mousepad',
      ['--disable-server', '--line=8', '--column=3', snapshotPath],
      expect.any(String),
    );
    expect(authority.isCurrent).toHaveBeenCalledTimes(3);

    const outside = path.join(temporaryRoot, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    await expect(openRemoteDesktopPath({
      source: 'project',
      path: outside,
      projectAuthority: projectAuthority(),
    }, options({ stagingRoot: path.join(temporaryRoot, 'other-staging') })))
      .rejects.toMatchObject({ statusCode: 403, code: 'PATH_OUTSIDE_AUTHORITY' });
  });

  test('rejects a replaced Project root at the same canonical path', async () => {
    fs.writeFileSync(path.join(projectRoot, 'generation.txt'), 'original');
    const staleAuthority = projectAuthority();
    fs.renameSync(projectRoot, `${projectRoot}.old`);
    fs.mkdirSync(projectRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(projectRoot, 'generation.txt'), 'replacement');

    await expect(openRemoteDesktopPath({
      source: 'project',
      path: 'generation.txt',
      projectAuthority: staleAuthority,
    }, options())).rejects.toMatchObject({ statusCode: 409, code: 'PROJECT_AUTHORITY_CHANGED' });
    expect(launch).not.toHaveBeenCalled();
  });

  test('rejects a newer Project ledger generation on the same root inode', async () => {
    fs.writeFileSync(path.join(projectRoot, 'generation.txt'), 'same filesystem identity');
    const staleAuthority = projectAuthority();
    projectGeneration += 1;

    await expect(openRemoteDesktopPath({
      source: 'project',
      path: 'generation.txt',
      projectAuthority: staleAuthority,
    }, options())).rejects.toMatchObject({ statusCode: 409, code: 'PROJECT_AUTHORITY_CHANGED' });
    expect(staleAuthority.isCurrent).toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  test('rejects unconfigured agent roots, final links, and linked path components', async () => {
    const outsideRoot = path.join(temporaryRoot, 'outside-workspace');
    fs.mkdirSync(outsideRoot);
    const outside = path.join(outsideRoot, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    await expect(openRemoteDesktopPath(mainAgentPath(outside), options()))
      .rejects.toMatchObject({ statusCode: 403, code: 'PATH_OUTSIDE_AUTHORITY' });

    await expect(openRemoteDesktopPath({ source: 'agent-workspace', path: outside }, options()))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_AGENT' });

    const target = path.join(workspace, 'target.txt');
    const finalLink = path.join(workspace, 'final-link.txt');
    fs.writeFileSync(target, 'target');
    fs.symlinkSync(target, finalLink);
    await expect(openRemoteDesktopPath(mainAgentPath(finalLink), options()))
      .rejects.toMatchObject({ statusCode: 422, code: 'SYMLINK_REJECTED' });

    const realDirectory = path.join(workspace, 'real');
    fs.mkdirSync(realDirectory);
    fs.writeFileSync(path.join(realDirectory, 'inside.txt'), 'inside');
    fs.symlinkSync(realDirectory, path.join(workspace, 'linked-dir'), 'dir');
    await expect(openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'main',
      path: path.join(workspace, 'linked-dir', 'inside.txt'),
      agentAuthority: agentAuthority(),
    }, options())).rejects.toMatchObject({ statusCode: 422, code: 'SYMLINK_REJECTED' });
  });

  test('rejects special and oversized files before allocating a snapshot', async () => {
    const fifo = path.join(workspace, 'pipe');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    await expect(openRemoteDesktopPath(mainAgentPath(fifo), options()))
      .rejects.toMatchObject({ statusCode: 422, code: 'NOT_REGULAR_FILE' });

    const oversized = path.join(workspace, 'oversized.bin');
    fs.writeFileSync(oversized, 'x');
    fs.truncateSync(oversized, 256 * 1024 * 1024 + 1);
    await expect(openRemoteDesktopPath(mainAgentPath(oversized), options()))
      .rejects.toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });
    expect(fs.existsSync(stagingRoot)).toBe(false);
  });

  test('rejects control characters introduced by an encoded file URL', async () => {
    await expect(openRemoteDesktopPath({
      source: 'agent-workspace',
      agent: 'main',
      path: `file://${workspace}/unsafe%0Aname.txt`,
      agentAuthority: agentAuthority(),
    }, options())).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PATH' });
    expect(fs.existsSync(stagingRoot)).toBe(false);
  });

  test('detects a pathname swap between admission and O_NOFOLLOW open', async () => {
    const sourcePath = path.join(workspace, 'changing.txt');
    fs.writeFileSync(sourcePath, 'first inode');
    await expect(openRemoteDesktopPath(mainAgentPath(sourcePath), options({
      afterSourceAdmission: () => {
        fs.renameSync(sourcePath, `${sourcePath}.old`);
        fs.writeFileSync(sourcePath, 'replacement inode');
      },
    }))).rejects.toMatchObject({ statusCode: 409, code: 'SOURCE_CHANGED' });
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  test('fails closed when all 32 private handoff entries are occupied', async () => {
    fs.mkdirSync(stagingRoot, { mode: 0o710 });
    fs.chownSync(stagingRoot, 0, process.getgid?.() ?? 0);
    fs.chmodSync(stagingRoot, 0o710);
    for (let index = 0; index < REMOTE_DESKTOP_OPEN_MAX_ENTRIES; index += 1) {
      const directory = path.join(stagingRoot, index.toString(16).padStart(32, '0'));
      fs.mkdirSync(directory, { mode: 0o750 });
      fs.chownSync(directory, 0, process.getgid?.() ?? 0);
      fs.chmodSync(directory, 0o750);
    }
    const sourcePath = path.join(workspace, 'capacity.txt');
    fs.writeFileSync(sourcePath, 'capacity');
    await expect(openRemoteDesktopPath(mainAgentPath(sourcePath), options()))
      .rejects.toMatchObject({ statusCode: 429, code: 'STAGING_CAPACITY' });
  });

  test('startup reconciliation removes expired snapshots and preserves fresh ones', async () => {
    const expiredSource = path.join(workspace, 'expired.txt');
    const freshSource = path.join(workspace, 'fresh.txt');
    fs.writeFileSync(expiredSource, 'expired');
    fs.writeFileSync(freshSource, 'fresh');
    await openRemoteDesktopPath(mainAgentPath(expiredSource), options());
    const expiredDirectory = path.join(stagingRoot, fs.readdirSync(stagingRoot)[0]);
    await openRemoteDesktopPath(mainAgentPath(freshSource), options());
    const freshDirectory = fs.readdirSync(stagingRoot)
      .map((entry) => path.join(stagingRoot, entry))
      .find((entry) => entry !== expiredDirectory)!;
    const expiredAt = new Date(Date.now() - REMOTE_DESKTOP_OPEN_TTL_MS - 5_000);
    fs.utimesSync(expiredDirectory, expiredAt, expiredAt);

    await expect(cleanupRemoteDesktopOpenPathSnapshots(options())).resolves.toMatchObject({
      removed: 1,
      retained: 1,
    });
    expect(fs.existsSync(expiredDirectory)).toBe(false);
    expect(fs.existsSync(freshDirectory)).toBe(true);
  });

  test('cleanup validates the complete managed tree before deleting expired residue', async () => {
    const sourcePath = path.join(workspace, 'preserved-on-drift.txt');
    fs.writeFileSync(sourcePath, 'preserve me');
    await openRemoteDesktopPath(mainAgentPath(sourcePath), options());
    const expiredDirectory = path.join(stagingRoot, fs.readdirSync(stagingRoot)[0]);
    const expiredAt = new Date(Date.now() - REMOTE_DESKTOP_OPEN_TTL_MS - 5_000);
    fs.utimesSync(expiredDirectory, expiredAt, expiredAt);

    fs.writeFileSync(path.join(stagingRoot, 'unknown-entry'), 'drift');
    await expect(cleanupRemoteDesktopOpenPathSnapshots(options()))
      .rejects.toMatchObject({ statusCode: 503, code: 'STAGING_INTEGRITY' });
    expect(fs.existsSync(expiredDirectory)).toBe(true);
    fs.unlinkSync(path.join(stagingRoot, 'unknown-entry'));

    const linkedEntry = path.join(stagingRoot, 'f'.repeat(32));
    fs.symlinkSync(expiredDirectory, linkedEntry, 'dir');
    await expect(cleanupRemoteDesktopOpenPathSnapshots(options()))
      .rejects.toMatchObject({ statusCode: 503, code: 'STAGING_INTEGRITY' });
    expect(fs.existsSync(expiredDirectory)).toBe(true);
  });

  test('errors expose bounded policy details, never source paths', async () => {
    const missing = path.join(workspace, 'private-secret-name.txt');
    let error: unknown;
    try {
      await openRemoteDesktopPath(mainAgentPath(missing), options());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RemoteDesktopOpenPathError);
    expect((error as Error).message).not.toContain('private-secret-name');
    expect(error).toMatchObject({ statusCode: 404, code: 'FILE_NOT_FOUND' });
  });
});
