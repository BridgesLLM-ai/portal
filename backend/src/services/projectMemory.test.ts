import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROJECT_MEMORY_FILE,
  PROJECT_MEMORY_MAX_BYTES,
  ProjectMemoryAccessError,
  ensureProjectMemory,
  readProjectMemory,
} from './projectMemory';
import { PROJECT_RUNTIME_GID, PROJECT_RUNTIME_UID } from './projectRuntimeIdentity';

describe('Project memory filesystem policy', () => {
  let projectDir = '';
  let outsidePath = '';

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-memory-'));
    outsidePath = path.join(os.tmpdir(), `portal-project-memory-outside-${process.pid}-${Date.now()}.md`);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  });

  function expectMemoryError(
    operation: () => unknown,
    code: ProjectMemoryAccessError['code'],
    httpStatus: ProjectMemoryAccessError['httpStatus'],
    retryable = false,
  ): ProjectMemoryAccessError {
    try {
      operation();
      throw new Error('Expected Project memory access to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectMemoryAccessError);
      expect(error).toMatchObject({ code, httpStatus, retryable });
      return error as ProjectMemoryAccessError;
    }
  }

  it('atomically creates a bounded regular memory file and reads it back', () => {
    const created = ensureProjectMemory(projectDir, 'Safe Project');

    expect(created).toContain('# Project Memory — Safe Project');
    expect(readProjectMemory(projectDir)).toBe(created);
    const entry = fs.lstatSync(path.join(projectDir, PROJECT_MEMORY_FILE));
    expect(entry.isFile()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect(entry.uid).toBe(PROJECT_RUNTIME_UID);
      expect(entry.gid).toBe(PROJECT_RUNTIME_GID);
    }
    expect(
      fs.readdirSync(projectDir).filter((name) => name.includes('.portal-')),
    ).toEqual([]);
  });

  it('rejects a symlink read without returning host contents', () => {
    fs.writeFileSync(outsidePath, 'host secret');
    fs.symlinkSync(outsidePath, path.join(projectDir, PROJECT_MEMORY_FILE));

    const error = expectMemoryError(
      () => readProjectMemory(projectDir),
      'PROJECT_MEMORY_FILE_UNSAFE',
      409,
    );
    expect(error.message).not.toContain(outsidePath);
    expect(error.message).not.toContain('host secret');
  });

  it.each([
    ['existing', true],
    ['dangling', false],
  ])('rejects an %s symlink during creation without writing outside the Project', (_kind, createTarget) => {
    if (createTarget) fs.writeFileSync(outsidePath, 'unchanged');
    fs.symlinkSync(outsidePath, path.join(projectDir, PROJECT_MEMORY_FILE));

    expectMemoryError(
      () => ensureProjectMemory(projectDir, 'Unsafe Project'),
      'PROJECT_MEMORY_FILE_UNSAFE',
      409,
    );
    expect(fs.existsSync(outsidePath)).toBe(createTarget);
    if (createTarget) expect(fs.readFileSync(outsidePath, 'utf8')).toBe('unchanged');
  });

  it('rejects oversized memory before reading it into the Portal process', () => {
    fs.writeFileSync(
      path.join(projectDir, PROJECT_MEMORY_FILE),
      Buffer.alloc(PROJECT_MEMORY_MAX_BYTES + 1, 0x61),
    );

    expectMemoryError(
      () => readProjectMemory(projectDir),
      'PROJECT_MEMORY_FILE_TOO_LARGE',
      413,
    );
  });

  it('returns an empty provider-owned view when memory has not been initialized', () => {
    expect(readProjectMemory(projectDir)).toBe('');
  });
});
