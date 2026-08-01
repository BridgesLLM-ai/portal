import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ContainedPathError,
  ensureContainedDirectory,
  isPathContained,
  resolveContainedPath,
  writeContainedFileAtomic,
} from '../services/containedPath';

describe('contained path security', () => {
  let tempRoot: string;
  let baseDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-contained-'));
    baseDir = path.join(tempRoot, 'base');
    fs.mkdirSync(baseDir);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('uses separator-aware lexical containment', () => {
    expect(isPathContained(baseDir, path.join(baseDir, 'nested', 'file.txt'))).toBe(true);
    expect(isPathContained(baseDir, `${baseDir}-sibling/file.txt`)).toBe(false);
  });

  test('rejects traversal, absolute paths, Windows separators, and NULs', () => {
    for (const candidate of ['../outside', '/etc/passwd', 'dir\\..\\outside', 'bad\0name']) {
      expect(() => resolveContainedPath(baseDir, candidate, { mustExist: false })).toThrow(ContainedPathError);
    }
  });

  test('rejects existing parent and final-component symlinks', () => {
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.symlinkSync(outside, path.join(baseDir, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'secret'), path.join(baseDir, 'linked-file'));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(baseDir, 'dangling-link'));

    expect(() => resolveContainedPath(baseDir, 'linked-dir/new.txt', { mustExist: false })).toThrow(/Symbolic links/);
    expect(() => resolveContainedPath(baseDir, 'linked-file', { mustExist: true })).toThrow(/Symbolic links/);
    expect(() => resolveContainedPath(baseDir, 'dangling-link/child.txt', { mustExist: false })).toThrow(/Symbolic links/);
  });

  test('anchors nonexistent targets to the last canonical directory', () => {
    fs.mkdirSync(path.join(baseDir, 'existing'));
    const resolved = resolveContainedPath(baseDir, 'existing/missing/target.txt', { mustExist: false });
    expect(resolved).toBe(path.join(baseDir, 'existing', 'missing', 'target.txt'));
  });

  test('creates directories without following symlinks', () => {
    expect(ensureContainedDirectory(baseDir, 'one/two')).toBe(path.join(baseDir, 'one', 'two'));
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(baseDir, 'link'));
    expect(() => ensureContainedDirectory(baseDir, 'link/child')).toThrow(/symbolic link/i);
  });

  test('atomically writes regular files and replaces a symlink instead of following it', () => {
    const outside = path.join(tempRoot, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(baseDir, 'target.txt'));

    expect(() => writeContainedFileAtomic(baseDir, 'target.txt', 'new')).toThrow(/Symbolic links/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');

    const written = writeContainedFileAtomic(baseDir, 'nested/target.txt', 'safe', { exclusive: true });
    expect(fs.readFileSync(written, 'utf8')).toBe('safe');
    expect(fs.lstatSync(written).isFile()).toBe(true);
  });
});
