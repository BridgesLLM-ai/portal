import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import {
  __projectChatWorkspaceOwnershipTest,
  ensureProjectChatWorkspaceOwnership,
} from './projectChatWorkspaceOwnership';

function fixture(): {
  root: string;
  projectDir: string;
  markerRoot: string;
  context: ProjectSandboxExecutionContext;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-ownership-'));
  const projectDir = path.join(root, 'project');
  const markerRoot = path.join(root, 'markers');
  fs.mkdirSync(projectDir);
  const stat = fs.lstatSync(projectDir, { bigint: true });
  return {
    root,
    projectDir,
    markerRoot,
    context: Object.freeze({
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: 'actor-1',
      projectId: 'project-1',
      workspaceOwnerId: 'owner-1',
      projectName: 'Example',
      canonicalRoot: fs.realpathSync.native(projectDir),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
      runtimePolicyVersion: 'policy-v1',
      egressPolicyVersion: 'egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'fingerprint-v1',
    }),
  };
}

describe('Project Chat one-time workspace ownership adoption', () => {
  const roots: string[] = [];

  afterEach(() => {
    __projectChatWorkspaceOwnershipTest.pendingPreparations.clear();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists a private marker and skips recursive preparation on warm reuse', async () => {
    const value = fixture();
    roots.push(value.root);
    const prepare = jest.fn(async () => value.projectDir);

    await ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: prepare,
    });
    await ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: prepare,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    const files = fs.readdirSync(value.markerRoot);
    expect(files).toHaveLength(1);
    expect(fs.lstatSync(path.join(value.markerRoot, files[0])).mode & 0o777).toBe(0o600);
  });

  it('does not mark a failed adoption and retries it later', async () => {
    const value = fixture();
    roots.push(value.root);
    const failed = jest.fn(async () => {
      throw new Error('chown failed');
    });

    await expect(ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: failed,
    })).rejects.toThrow('chown failed');
    expect(fs.readdirSync(value.markerRoot)).toEqual([]);

    const recovered = jest.fn(async () => value.projectDir);
    await ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: recovered,
    });
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent preparation for the same immutable root', async () => {
    const value = fixture();
    roots.push(value.root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prepare = jest.fn(async () => {
      await gate;
      return value.projectDir;
    });

    const first = ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: prepare,
    });
    const second = ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: prepare,
    });
    release();
    await Promise.all([first, second]);

    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects a replaced project root before trusting an existing marker', async () => {
    const value = fixture();
    roots.push(value.root);
    await ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: async () => value.projectDir,
    });
    fs.renameSync(value.projectDir, `${value.projectDir}.old`);
    fs.mkdirSync(value.projectDir);

    await expect(ensureProjectChatWorkspaceOwnership(value.context, value.projectDir, {
      markerRoot: value.markerRoot,
      prepareWorkspace: async () => value.projectDir,
    })).rejects.toThrow('immutable identity');
  });
});
