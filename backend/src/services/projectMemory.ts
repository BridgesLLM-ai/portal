import {
  PROJECT_METADATA_MAX_BYTES,
  ProjectFilePolicyError,
  readProjectTextFile,
  writeProjectRuntimeTextFile,
} from './projectSurfacePolicy';

export const PROJECT_MEMORY_FILE = '.agent-memory.md';
export const PROJECT_MEMORY_MAX_BYTES = PROJECT_METADATA_MAX_BYTES;

export type ProjectMemoryAccessCode =
  | 'PROJECT_MEMORY_FILE_UNSAFE'
  | 'PROJECT_MEMORY_FILE_TOO_LARGE'
  | 'PROJECT_MEMORY_UNAVAILABLE';

/**
 * A client-safe Project memory failure. Never retain the underlying filesystem
 * error: repository-controlled paths and content must not leak into responses.
 */
export class ProjectMemoryAccessError extends Error {
  constructor(
    readonly code: ProjectMemoryAccessCode,
    readonly httpStatus: 409 | 413 | 503,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProjectMemoryAccessError';
  }
}

function projectMemoryError(error: unknown): ProjectMemoryAccessError {
  if (error instanceof ProjectMemoryAccessError) return error;
  if (error instanceof ProjectFilePolicyError) {
    if (error.code === 'TOO_LARGE') {
      return new ProjectMemoryAccessError(
        'PROJECT_MEMORY_FILE_TOO_LARGE',
        413,
        'Project memory is too large to load. Reduce .agent-memory.md below 1 MiB and try again.',
        false,
      );
    }
    return new ProjectMemoryAccessError(
      'PROJECT_MEMORY_FILE_UNSAFE',
      409,
      'Project memory must be a regular file inside this Project. Replace .agent-memory.md and try again.',
      false,
    );
  }
  return new ProjectMemoryAccessError(
    'PROJECT_MEMORY_UNAVAILABLE',
    503,
    'Project memory is temporarily unavailable. Try again.',
    true,
  );
}

function readOptionalProjectMemory(projectDir: string): string | null {
  try {
    return readProjectTextFile(projectDir, PROJECT_MEMORY_FILE, {
      optional: true,
      maxBytes: PROJECT_MEMORY_MAX_BYTES,
    });
  } catch (error) {
    throw projectMemoryError(error);
  }
}

export function readProjectMemory(projectDir: string): string {
  return readOptionalProjectMemory(projectDir) ?? '';
}

export function ensureProjectMemory(projectDir: string, projectName: string): string {
  const existing = readOptionalProjectMemory(projectDir);
  if (existing !== null) return existing;

  const safeProjectName = String(projectName)
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 200) || 'Project';
  const content = `# Project Memory — ${safeProjectName}\n\n## Overview\n(Describe what this project does)\n`;
  try {
    writeProjectRuntimeTextFile(projectDir, PROJECT_MEMORY_FILE, content, PROJECT_MEMORY_MAX_BYTES);
    return content;
  } catch (error) {
    throw projectMemoryError(error);
  }
}
