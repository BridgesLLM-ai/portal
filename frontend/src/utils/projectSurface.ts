import {
  type WorkspaceNavigationBinding,
  workspaceNavigationInternals,
} from './workspaceNavigation';

export const PROJECT_ZIP_MAX_BYTES = 200 * 1024 * 1024;

export const REMOTE_DESKTOP_RUNTIME_WARNING =
  'This project type demos on the Remote Desktop, which requires Admin privileges. Ask an Owner or Sub-Admin to run the demo.';

export function canLaunchProjectRuntimeDemo(role?: string | null): boolean {
  return role === 'OWNER' || role === 'SUB_ADMIN';
}

export interface ProjectFileWrite {
  projectName: string;
  filePath: string;
  content: string;
  revision: number;
}

export function projectDocumentKey(projectName: string, filePath: string): string {
  return `${projectName}\u0000${filePath}`;
}

/**
 * Serialize writes per project document. Autosave and an explicit Cmd/Ctrl+S
 * can otherwise reach the server out of order and let an older response win.
 */
export class ProjectFileWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(write: ProjectFileWrite, persist: (write: ProjectFileWrite) => Promise<void>): Promise<void> {
    const key = projectDocumentKey(write.projectName, write.filePath);
    const previous = this.tails.get(key) || Promise.resolve();
    const result = previous.catch(() => undefined).then(() => persist(write));
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    return result.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  async waitFor(projectName: string, filePath: string): Promise<void> {
    await (this.tails.get(projectDocumentKey(projectName, filePath)) || Promise.resolve());
  }
}

export function isSameProjectDocument(
  currentProject: string | null,
  currentPath: string | null | undefined,
  write: Pick<ProjectFileWrite, 'projectName' | 'filePath'>,
): boolean {
  return currentProject === write.projectName && currentPath === write.filePath;
}

export function isValidProjectRelativePath(value: string): boolean {
  if (!value || value.length > 1024 || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export interface ProjectDeepLinkTarget {
  project: string;
  file?: string;
}

function isValidProjectDeepLinkName(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && !/[\u0000-\u001f\u007f/\\]/.test(value);
}

export function hasProjectDeepLinkParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('open') || params.has('project') || params.has('file') || params.has('path');
}

export function parseProjectDeepLink(
  search: string,
  binding: WorkspaceNavigationBinding | null | undefined,
): ProjectDeepLinkTarget | null {
  const params = new URLSearchParams(search);
  // Legacy query strings exposed project and file names in browser history.
  // Keep recognizing them only so the page can scrub the URL.
  if (params.has('project') || params.has('file') || params.has('path')) return null;
  const target = workspaceNavigationInternals.resolveWorkspaceNavigationTarget<Partial<ProjectDeepLinkTarget>>(
    'project',
    search,
    binding,
  );
  if (!target?.project || !isValidProjectDeepLinkName(target.project)) return null;
  if (target.file !== undefined && !isValidProjectRelativePath(target.file)) return null;
  return target.file === undefined
    ? { project: target.project }
    : { project: target.project, file: target.file };
}

export function buildProjectDeepLink(
  project: string,
  binding: WorkspaceNavigationBinding,
): string;
export function buildProjectDeepLink(
  project: string,
  file: string,
  binding: WorkspaceNavigationBinding,
): string;
export function buildProjectDeepLink(
  project: string,
  fileOrBinding: string | WorkspaceNavigationBinding,
  maybeBinding?: WorkspaceNavigationBinding,
): string {
  const file = typeof fileOrBinding === 'string' ? fileOrBinding : undefined;
  const binding = typeof fileOrBinding === 'string' ? maybeBinding : fileOrBinding;
  if (!isValidProjectDeepLinkName(project)
    || (file !== undefined && !isValidProjectRelativePath(file))) {
    throw new Error('Invalid Project deep link');
  }
  if (!binding) return '/projects';
  return workspaceNavigationInternals.buildWorkspaceNavigationUrl(
    '/projects',
    'project',
    { project, ...(file ? { file } : {}) },
    binding,
  );
}

export function contentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = header.trim().match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
