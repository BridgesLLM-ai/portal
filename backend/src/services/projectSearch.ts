import fs from 'fs';
import path from 'path';
import type { FileHandle } from 'fs/promises';

const DEFAULT_RESULT_LIMIT = 24;
const MAX_RESULT_LIMIT = 50;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_VISITED = 20_000;
const DEFAULT_MAX_ENTRIES_PER_DIRECTORY = 2_048;
const DEFAULT_YIELD_EVERY = 64;
const DEFAULT_MAX_CONCURRENT_SEARCHES = 4;

const SAFE_HIDDEN_DIRECTORIES = new Set([
  '.changeset',
  '.circleci',
  '.devcontainer',
  '.github',
  '.husky',
  '.vscode',
]);

const SAFE_HIDDEN_FILES = new Set([
  '.agent-memory.md',
  '.babelrc',
  '.browserslistrc',
  '.clang-format',
  '.clang-tidy',
  '.commitlintrc',
  '.coveragerc',
  '.dockerignore',
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitlab-ci.yml',
  '.gitignore',
  '.lintstagedrc',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  '.python-version',
  '.rubocop.yml',
  '.stylelintrc',
  '.tool-versions',
  '.yarnrc',
]);

const SAFE_HIDDEN_FILE_PREFIXES = [
  '.babelrc.',
  '.commitlintrc.',
  '.eslintrc.',
  '.lintstagedrc.',
  '.prettierrc.',
  '.stylelintrc.',
  '.yarnrc.',
];

const GENERATED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.portal',
  '.pytest_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv',
]);

const SENSITIVE_HIDDEN_FILES = new Set([
  '.env',
  '.netrc',
  '.pypirc',
]);

export type ProjectWorkspaceSearchResult =
  | {
      kind: 'project';
      project: string;
      name: string;
    }
  | {
      kind: 'file';
      project: string;
      name: string;
      path: string;
    };

export interface ProjectWorkspaceSearchResponse {
  query: string;
  results: ProjectWorkspaceSearchResult[];
  truncated: boolean;
  visited: number;
}

export interface ProjectWorkspaceSearchOptions {
  query: string;
  limit?: number;
  maxDepth?: number;
  maxVisited?: number;
  maxEntriesPerDirectory?: number;
  yieldEvery?: number;
  signal?: AbortSignal;
}

export class ProjectSearchCapacityError extends Error {
  constructor() {
    super('Project search capacity is busy');
    this.name = 'ProjectSearchCapacityError';
  }
}

function normalizedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Project search limit is invalid');
  return Math.min(value, maximum);
}

function normalizeSearchQuery(query: string): { display: string; comparison: string } {
  const display = String(query || '').trim();
  if (!display) throw new Error('Project search query is required');
  if (display.length > 200 || /[\u0000-\u001f\u007f]/.test(display)) {
    throw new Error('Project search query is invalid or too long');
  }
  return { display, comparison: display.toLocaleLowerCase() };
}

function directoryFdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

async function openDirectoryNoFollow(directoryPath: string): Promise<FileHandle> {
  const flags = fs.constants.O_RDONLY
    | fs.constants.O_DIRECTORY
    | fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(directoryPath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error('Project search root is not a directory');
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function shouldSkipDirectory(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  if (GENERATED_DIRECTORIES.has(normalized)) return true;
  return name.startsWith('.') && !SAFE_HIDDEN_DIRECTORIES.has(normalized);
}

function isVisibleFile(name: string): boolean {
  if (!name.startsWith('.')) return true;
  const normalized = name.toLocaleLowerCase();
  if (SENSITIVE_HIDDEN_FILES.has(normalized) || normalized.startsWith('.env.')) return false;
  return SAFE_HIDDEN_FILES.has(normalized)
    || SAFE_HIDDEN_FILE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function abortError(): Error {
  const error = new Error('Project search was cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createProjectSearchGate(maxConcurrent = DEFAULT_MAX_CONCURRENT_SEARCHES):
  <T>(operation: () => Promise<T>) => Promise<T> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0 || maxConcurrent > 32) {
    throw new Error('Project search concurrency is invalid');
  }
  let active = 0;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) throw new ProjectSearchCapacityError();
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
    }
  };
}

const runWithinProjectSearchCapacity = createProjectSearchGate();

/**
 * Search one effective Portal workspace. The caller supplies the already
 * actor-scoped project root; this function never leaves that root and never
 * follows a project-created symlink.
 *
 * Every directory is opened with O_NOFOLLOW and iterated incrementally
 * through its anchored descriptor. Per-directory and global entry budgets
 * are applied before another entry is read, and regular event-loop yields
 * keep a large workspace from monopolizing the Portal process.
 */
export async function searchProjectWorkspace(
  workspaceRoot: string,
  options: ProjectWorkspaceSearchOptions,
): Promise<ProjectWorkspaceSearchResponse> {
  const query = normalizeSearchQuery(options.query);
  const limit = normalizedPositiveInteger(options.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT);
  const maxDepth = normalizedPositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 64);
  const maxVisited = normalizedPositiveInteger(options.maxVisited, DEFAULT_MAX_VISITED, 100_000);
  const maxEntriesPerDirectory = normalizedPositiveInteger(
    options.maxEntriesPerDirectory,
    DEFAULT_MAX_ENTRIES_PER_DIRECTORY,
    10_000,
  );
  const yieldEvery = normalizedPositiveInteger(options.yieldEvery, DEFAULT_YIELD_EVERY, 256);
  const results: ProjectWorkspaceSearchResult[] = [];
  let visited = 0;
  let truncated = false;

  const matches = (value: string) => value.toLocaleLowerCase().includes(query.comparison);
  const atCapacity = () => {
    if (results.length < limit) return false;
    truncated = true;
    return true;
  };

  const visitDirectory = async (
    directoryFd: number,
    visitor: (entry: fs.Dirent) => Promise<boolean> | boolean,
  ): Promise<void> => {
    throwIfAborted(options.signal);
    const directory = await fs.promises.opendir(directoryFdPath(directoryFd), { bufferSize: 32 });
    let directoryVisited = 0;
    try {
      while (directoryVisited < maxEntriesPerDirectory && visited < maxVisited) {
        throwIfAborted(options.signal);
        const entry = await directory.read();
        if (!entry) return;
        directoryVisited += 1;
        visited += 1;
        if (!(await visitor(entry))) return;
        if (visited % yieldEvery === 0) await yieldToEventLoop();
      }
      // Reaching either budget is deliberately conservative: the iterator is
      // not allowed an unbudgeted look-ahead read merely to prove exhaustion.
      truncated = true;
    } finally {
      await directory.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
  };

  const walkProject = async (
    directoryFd: number,
    project: string,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    await visitDirectory(directoryFd, async (entry) => {
      if (atCapacity()) return false;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return true;

      if (entry.isFile()) {
        if (isVisibleFile(entry.name) && matches(relativePath)) {
          results.push({
            kind: 'file',
            project,
            name: entry.name,
            path: relativePath,
          });
        }
        return !atCapacity();
      }

      if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) return true;
      if (depth >= maxDepth) {
        truncated = true;
        return true;
      }

      let child: FileHandle | undefined;
      try {
        child = await openDirectoryNoFollow(path.join(directoryFdPath(directoryFd), entry.name));
        await walkProject(child.fd, project, relativePath, depth + 1);
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        // A project can mutate while search runs. Entries that disappear or
        // become links are skipped rather than retried through a weaker path.
      } finally {
        await child?.close().catch(() => undefined);
      }
      return !atCapacity() && visited < maxVisited;
    });
  };

  let workspace: FileHandle | undefined;
  try {
    workspace = await openDirectoryNoFollow(path.resolve(workspaceRoot));
    const projectEntries: fs.Dirent[] = [];
    await visitDirectory(workspace.fd, (entry) => {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')) {
        projectEntries.push(entry);
      }
      return true;
    });
    projectEntries.sort((left, right) => left.name.localeCompare(right.name));

    // Search every bounded project name before walking file trees. A
    // file-heavy early project therefore cannot hide a later name match.
    for (const projectEntry of projectEntries) {
      if (atCapacity()) break;
      if (matches(projectEntry.name)) {
        results.push({ kind: 'project', project: projectEntry.name, name: projectEntry.name });
      }
    }

    for (const projectEntry of projectEntries) {
      if (atCapacity() || visited >= maxVisited) break;
      throwIfAborted(options.signal);
      let project: FileHandle | undefined;
      try {
        project = await openDirectoryNoFollow(path.join(directoryFdPath(workspace.fd), projectEntry.name));
        await walkProject(project.fd, projectEntry.name, '', 0);
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        // Skip removed, inaccessible, or raced project entries.
      } finally {
        await project?.close().catch(() => undefined);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A new actor may search before the Projects page has created its empty
    // workspace. That is a valid empty result, not a server failure.
  } finally {
    await workspace?.close().catch(() => undefined);
  }

  return {
    query: query.display,
    results,
    truncated,
    visited,
  };
}

export function runProjectWorkspaceSearch(
  workspaceRoot: string,
  options: ProjectWorkspaceSearchOptions,
): Promise<ProjectWorkspaceSearchResponse> {
  return runWithinProjectSearchCapacity(() => searchProjectWorkspace(workspaceRoot, options));
}
