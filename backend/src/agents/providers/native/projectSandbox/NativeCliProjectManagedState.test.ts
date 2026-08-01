import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../../services/projectEgressPolicy';
import {
  assertNativeCliProjectPathSeparation,
  hasNativeCliProjectManagedStateForIdentity,
  nativeCliProjectStateDirectory,
  readProtectedNativeCliSource,
  removeNativeCliProjectManagedState,
  stageNativeCliProjectManagedFile,
} from './NativeCliProjectManagedState';

function contextFor(projectRoot: string): ProjectSandboxExecutionContext {
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  return Object.freeze({
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: 'actor-id',
    projectId: 'project-id',
    workspaceOwnerId: 'owner-id',
    projectName: 'demo',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: 'portal-claude-code-project-sandbox-v1',
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
    policyFingerprint: 'b'.repeat(64),
  });
}

describe('native CLI protected Project state', () => {
  let root: string;
  let projectRoot: string;
  let stateRoot: string;
  let sourcePath: string;
  let previousStateRoot: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cli-state-test-'));
    projectRoot = path.join(root, 'project');
    stateRoot = path.join(root, 'state');
    sourcePath = path.join(root, 'oauth.json');
    fs.mkdirSync(projectRoot, { mode: 0o700 });
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    fs.writeFileSync(sourcePath, 'credential', { mode: 0o600 });
    previousStateRoot = process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT;
    process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    if (previousStateRoot === undefined) delete process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT;
    else process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT = previousStateRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reads only a protected canonical source outside the Project', () => {
    expect(readProtectedNativeCliSource({
      sourcePath,
      projectRoot,
      label: 'OAuth file',
    }).toString('utf8')).toBe('credential');
    fs.chmodSync(sourcePath, 0o644);
    expect(() => readProtectedNativeCliSource({
      sourcePath,
      projectRoot,
      label: 'OAuth file',
    })).toThrow('0600 or stricter');
  });

  test('stages an atomic, runtime-owned 0400 file in an actor/project/provider-specific directory', () => {
    const context = contextFor(projectRoot);
    const filePath = stageNativeCliProjectManagedFile({
      context,
      provider: 'CLAUDE_CODE',
      fileName: 'oauth.json',
      content: 'first',
      label: 'Managed OAuth file',
    });
    expect(filePath).toBe(path.join(nativeCliProjectStateDirectory({ context, provider: 'CLAUDE_CODE' }), 'oauth.json'));
    expect(fs.readFileSync(filePath, 'utf8')).toBe('first');
    const stat = fs.lstatSync(filePath);
    expect({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }).toEqual({
      uid: 1000,
      gid: 1000,
      mode: 0o400,
    });
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const updated = stageNativeCliProjectManagedFile({
      context,
      provider: 'CLAUDE_CODE',
      fileName: 'oauth.json',
      content: 'second',
      label: 'Managed OAuth file',
    });
    expect(updated).toBe(filePath);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('second');
  });

  test('rejects source and state overlap with the Project', () => {
    const inside = path.join(projectRoot, 'secret');
    fs.writeFileSync(inside, 'secret', { mode: 0o600 });
    expect(() => readProtectedNativeCliSource({
      sourcePath: inside,
      projectRoot,
      label: 'OAuth file',
    })).toThrow('must not be inside');
    expect(() => assertNativeCliProjectPathSeparation({
      projectRoot,
      stateRoot: path.join(projectRoot, '.state'),
    })).toThrow('must not overlap');
  });

  test('rejects a symlink source and an unsafe pre-existing managed target', () => {
    const sourceLink = path.join(root, 'oauth-link');
    fs.symlinkSync(sourcePath, sourceLink);
    expect(() => readProtectedNativeCliSource({
      sourcePath: sourceLink,
      projectRoot,
      label: 'OAuth file',
    })).toThrow('may not be a symbolic link');

    const context = contextFor(projectRoot);
    const stateDir = nativeCliProjectStateDirectory({ context, provider: 'GEMINI' });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(sourcePath, path.join(stateDir, 'oauth.json'));
    expect(() => stageNativeCliProjectManagedFile({
      context,
      provider: 'GEMINI',
      fileName: 'oauth.json',
      content: 'managed',
      label: 'Managed OAuth file',
    })).toThrow('may not be a symbolic link');
  });

  test('removes only the exact attested provider/project state and is idempotent', () => {
    const context = contextFor(projectRoot);
    const filePath = stageNativeCliProjectManagedFile({
      context,
      provider: 'CLAUDE_CODE',
      fileName: 'oauth.json',
      content: 'managed',
      label: 'Managed OAuth file',
    });
    const siblingContext = Object.freeze({ ...context, projectId: 'sibling-project' });
    const siblingPath = stageNativeCliProjectManagedFile({
      context: siblingContext,
      provider: 'CLAUDE_CODE',
      fileName: 'oauth.json',
      content: 'sibling',
      label: 'Managed OAuth file',
    });
    const identity = {
      provider: 'CLAUDE_CODE' as const,
      userId: context.userId,
      projectId: context.projectId,
      projectRoot: context.canonicalRoot,
    };
    expect(hasNativeCliProjectManagedStateForIdentity(identity)).toBe(true);
    removeNativeCliProjectManagedState({ context, provider: 'CLAUDE_CODE' });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(hasNativeCliProjectManagedStateForIdentity(identity)).toBe(false);
    expect(fs.readFileSync(siblingPath, 'utf8')).toBe('sibling');
    expect(() => removeNativeCliProjectManagedState({ context, provider: 'CLAUDE_CODE' })).not.toThrow();
  });
});
