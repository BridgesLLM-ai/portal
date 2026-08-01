export const WORKSPACE_NAVIGATION_STORAGE_KEY = 'portal:workspace-navigation:v1';
const WORKSPACE_NAVIGATION_VERSION = 1;
const WORKSPACE_NAVIGATION_MAX_ENTRIES = 32;
const WORKSPACE_NAVIGATION_TTL_MS = 30 * 60 * 1000;
const WORKSPACE_NAVIGATION_MAX_TARGET_BYTES = 4096;
const OPAQUE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export interface WorkspaceNavigationBinding {
  actorUserId: string;
  authorizationVersion: number;
}

type WorkspaceNavigationKind = 'project' | 'file';

interface StoredWorkspaceNavigationEntry {
  token: string;
  kind: WorkspaceNavigationKind;
  actorUserId: string;
  authorizationVersion: number;
  createdAt: number;
  target: unknown;
}

interface StoredWorkspaceNavigationRegistry {
  version: typeof WORKSPACE_NAVIGATION_VERSION;
  entries: StoredWorkspaceNavigationEntry[];
}

export interface FileDeepLinkTarget {
  fileId?: string;
  path?: string;
}

function isValidBinding(binding: WorkspaceNavigationBinding | null | undefined): binding is WorkspaceNavigationBinding {
  return Boolean(
    binding
    && binding.actorUserId
    && binding.actorUserId.length <= 255
    && Number.isSafeInteger(binding.authorizationVersion)
    && binding.authorizationVersion >= 1,
  );
}

function isStoredEntry(value: unknown): value is StoredWorkspaceNavigationEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredWorkspaceNavigationEntry>;
  return typeof entry.token === 'string'
    && OPAQUE_TOKEN_PATTERN.test(entry.token)
    && (entry.kind === 'project' || entry.kind === 'file')
    && typeof entry.actorUserId === 'string'
    && entry.actorUserId.length > 0
    && entry.actorUserId.length <= 255
    && Number.isSafeInteger(entry.authorizationVersion)
    && Number(entry.authorizationVersion) >= 1
    && Number.isSafeInteger(entry.createdAt)
    && Number(entry.createdAt) >= 0
    && Object.prototype.hasOwnProperty.call(entry, 'target');
}

function readRegistry(storage: Storage): StoredWorkspaceNavigationRegistry {
  const raw = storage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY);
  if (raw === null) {
    return { version: WORKSPACE_NAVIGATION_VERSION, entries: [] };
  }
  const parsed = JSON.parse(raw) as Partial<StoredWorkspaceNavigationRegistry>;
  if (
    parsed.version !== WORKSPACE_NAVIGATION_VERSION
    || !Array.isArray(parsed.entries)
    || parsed.entries.length > WORKSPACE_NAVIGATION_MAX_ENTRIES
    || !parsed.entries.every(isStoredEntry)
  ) {
    throw new Error('Invalid workspace navigation registry');
  }
  return {
    version: WORKSPACE_NAVIGATION_VERSION,
    entries: parsed.entries,
  };
}

function createOpaqueToken(entries: StoredWorkspaceNavigationEntry[]): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('Secure randomness is unavailable');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!entries.some((entry) => entry.token === token)) return token;
  }
  throw new Error('Unable to allocate an opaque workspace navigation token');
}

function storeWorkspaceNavigationTarget(
  kind: WorkspaceNavigationKind,
  target: unknown,
  binding: WorkspaceNavigationBinding,
): string | null {
  if (!isValidBinding(binding) || typeof window === 'undefined') return null;
  try {
    const serializedTarget = JSON.stringify(target);
    if (!serializedTarget || serializedTarget.length > WORKSPACE_NAVIGATION_MAX_TARGET_BYTES) return null;
    const storage = window.sessionStorage;
    const now = Date.now();
    const registry = readRegistry(storage);
    const liveEntries = registry.entries.filter((entry) => (
      entry.createdAt + WORKSPACE_NAVIGATION_TTL_MS > now
    ));
    const token = createOpaqueToken(liveEntries);
    const entries = [
      ...liveEntries,
      {
        token,
        kind,
        actorUserId: binding.actorUserId,
        authorizationVersion: binding.authorizationVersion,
        createdAt: now,
        target,
      },
    ].slice(-WORKSPACE_NAVIGATION_MAX_ENTRIES);
    storage.setItem(WORKSPACE_NAVIGATION_STORAGE_KEY, JSON.stringify({
      version: WORKSPACE_NAVIGATION_VERSION,
      entries,
    } satisfies StoredWorkspaceNavigationRegistry));
    return token;
  } catch {
    return null;
  }
}

function resolveWorkspaceNavigationTarget<T>(
  kind: WorkspaceNavigationKind,
  search: string,
  binding: WorkspaceNavigationBinding | null | undefined,
): T | null {
  if (!isValidBinding(binding) || typeof window === 'undefined') return null;
  const params = new URLSearchParams(search);
  const tokens = params.getAll('open');
  if (tokens.length !== 1 || !OPAQUE_TOKEN_PATTERN.test(tokens[0])) return null;
  try {
    const registry = readRegistry(window.sessionStorage);
    const entry = registry.entries.find((candidate) => candidate.token === tokens[0]);
    if (
      !entry
      || entry.kind !== kind
      || entry.actorUserId !== binding.actorUserId
      || entry.authorizationVersion !== binding.authorizationVersion
      || entry.createdAt + WORKSPACE_NAVIGATION_TTL_MS <= Date.now()
    ) {
      return null;
    }
    return entry.target as T;
  } catch {
    return null;
  }
}

function buildWorkspaceNavigationUrl(
  route: '/projects' | '/files',
  kind: WorkspaceNavigationKind,
  target: unknown,
  binding: WorkspaceNavigationBinding,
): string {
  const token = storeWorkspaceNavigationTarget(kind, target, binding);
  return token ? `${route}?open=${token}` : route;
}

function isValidFileId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidFilePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 2048
    && value === value.trim()
    && !value.includes('\0');
}

export function hasFileDeepLinkParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('open') || params.has('file') || params.has('path');
}

export function buildFileDeepLink(
  fileId: string | undefined,
  path: string | undefined,
  binding: WorkspaceNavigationBinding,
): string {
  if (
    (fileId === undefined && path === undefined)
    || (fileId !== undefined && !isValidFileId(fileId))
    || (path !== undefined && !isValidFilePath(path))
  ) {
    throw new Error('Invalid Files deep link');
  }
  return buildWorkspaceNavigationUrl('/files', 'file', {
    ...(fileId ? { fileId } : {}),
    ...(path ? { path } : {}),
  }, binding);
}

/**
 * Stable attachment reference for persisted chat text. The renderer recognizes
 * this API route and mints a per-tab opaque Files target only on an ordinary
 * same-tab click. Paths deliberately do not belong in this URL.
 */
export function buildDeferredFileReference(fileId: string): string {
  if (!isValidFileId(fileId)) throw new Error('Invalid deferred file reference');
  return `/api/files/${encodeURIComponent(fileId)}`;
}

export function parseFileDeepLink(
  search: string,
  binding: WorkspaceNavigationBinding | null | undefined,
): FileDeepLinkTarget | null {
  const params = new URLSearchParams(search);
  // Sensitive legacy parameters are detection-only so the page can replace
  // the URL. They must never regain resolution semantics.
  if (params.has('file') || params.has('path')) return null;
  const target = resolveWorkspaceNavigationTarget<Partial<FileDeepLinkTarget>>('file', search, binding);
  if (!target || (target.fileId === undefined && target.path === undefined)) return null;
  if (target.fileId !== undefined && !isValidFileId(target.fileId)) return null;
  if (target.path !== undefined && !isValidFilePath(target.path)) return null;
  return {
    ...(target.fileId ? { fileId: target.fileId } : {}),
    ...(target.path ? { path: target.path } : {}),
  };
}

export const workspaceNavigationInternals = {
  buildWorkspaceNavigationUrl,
  resolveWorkspaceNavigationTarget,
};
