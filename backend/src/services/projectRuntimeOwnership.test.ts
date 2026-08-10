import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assignProjectRuntimeOwnership,
  ensureProjectRuntimeOwnedDirectory,
  ProjectRuntimeOwnershipError,
  writeProjectRuntimeOwnedFileAtomic,
} from './projectRuntimeOwnership';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from './projectRuntimeIdentity';

const rootOnlyTest = typeof process.getuid === 'function' && process.getuid() === 0
  ? test
  : test.skip;

describe('Project runtime mutation ownership', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-runtime-owner-'));
    projectRoot = path.join(tempRoot, 'project');
    fs.mkdirSync(projectRoot, { mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  rootOnlyTest('owns only the exact created directory chain and file as the provider identity', () => {
    const nested = ensureProjectRuntimeOwnedDirectory(projectRoot, 'uploads/nested');
    const written = writeProjectRuntimeOwnedFileAtomic(
      projectRoot,
      'uploads/nested/file.txt',
      'provider-writable',
    );

    for (const target of [path.join(projectRoot, 'uploads'), nested, written]) {
      const stat = fs.lstatSync(target);
      expect(stat.uid).toBe(PROJECT_RUNTIME_UID);
      expect(stat.gid).toBe(PROJECT_RUNTIME_GID);
    }
    expect(fs.lstatSync(projectRoot).uid).toBe(0);
  });

  rootOnlyTest('adopts a copied regular file without traversing sibling entries', () => {
    fs.mkdirSync(path.join(projectRoot, 'target'));
    fs.writeFileSync(path.join(projectRoot, 'target', 'copied.bin'), 'copy');
    fs.writeFileSync(path.join(projectRoot, 'untouched.bin'), 'sibling');

    assignProjectRuntimeOwnership(projectRoot, path.join(projectRoot, 'target', 'copied.bin'));

    expect(fs.lstatSync(path.join(projectRoot, 'target', 'copied.bin')).uid).toBe(PROJECT_RUNTIME_UID);
    expect(fs.lstatSync(path.join(projectRoot, 'target')).uid).toBe(PROJECT_RUNTIME_UID);
    expect(fs.lstatSync(path.join(projectRoot, 'untouched.bin')).uid).toBe(0);
  });

  rootOnlyTest('rejects symlink targets without changing the outside inode', () => {
    const outside = path.join(tempRoot, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(projectRoot, 'link.txt'));

    expect(() => assignProjectRuntimeOwnership(projectRoot, 'link.txt'))
      .toThrow(ProjectRuntimeOwnershipError);
    expect(fs.lstatSync(outside).uid).toBe(0);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });

  test('rejects absolute ownership targets outside the Project root', () => {
    const outside = path.join(tempRoot, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    expect(() => assignProjectRuntimeOwnership(projectRoot, outside))
      .toThrow(ProjectRuntimeOwnershipError);
  });
});
