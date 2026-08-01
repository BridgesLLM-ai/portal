import path from 'path';

export const FILE_LIBRARY_PAGE_SIZE = 100;
export const FILE_LIBRARY_MAX_BATCH_DELETE = 100;
export const FILE_LIBRARY_MAX_SYNC_ENTRIES = 5_000;

export interface NormalizedFileRename {
  storedPath: string;
  displayName: string;
}

/**
 * Turn a user-visible filename into one safe storage name without silently
 * changing or duplicating its extension. The caller still performs the
 * contained-path check against the user's upload root.
 */
export function normalizeFileRename(currentStoredPath: string, requestedName: unknown): NormalizedFileRename {
  if (typeof requestedName !== 'string') throw new Error('newName required');
  const trimmed = requestedName.trim();
  if (!trimmed) throw new Error('newName required');

  const withoutControls = trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
  const sanitized = withoutControls
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
    .replace(/[ .]+$/g, '');

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid file name');
  }

  const currentDirectory = path.dirname(currentStoredPath);
  return {
    storedPath: currentDirectory === '.' ? sanitized : path.join(currentDirectory, sanitized),
    displayName: sanitized,
  };
}
