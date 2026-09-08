import { readProjectTextFile, statProjectRegularFile } from './projectSurfacePolicy';

export interface ProjectLineChanges {
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/** NUL framing keeps tabs, newlines and quoted filenames unambiguous. */
export function parseProjectNumstat(raw: string): Map<string, ProjectLineChanges> {
  const changes = new Map<string, ProjectLineChanges>();
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    let name = match[3];
    if (!name) { i++; name = fields[++i]; } // --numstat -z rename: old NUL new
    if (!name) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const added = binary ? null : Number(match[1]);
    const removed = binary ? null : Number(match[2]);
    if (!binary && (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed))) continue;
    changes.set(name, { added, removed, binary });
  }
  return changes;
}

export function projectFileDetails(
  root: string,
  name: string,
  change: ProjectLineChanges | undefined,
  isNew: boolean,
  budget: { bytes: number },
) {
  let size: number | null = null;
  let modifiedAt: string | null = null;
  let unavailable = false;
  try {
    const stat = statProjectRegularFile(root, name, { optional: true });
    if (stat) { size = stat.size; modifiedAt = stat.mtime.toISOString(); }
    // Git omits untracked files. Count only bounded regular text files using
    // the existing race-safe reader, never follow a repository symlink.
    if (isNew && stat && stat.size <= Math.min(1024 * 1024, budget.bytes)) {
      budget.bytes -= stat.size;
      const text = readProjectTextFile(root, name, { maxBytes: 1024 * 1024 });
      if (text !== null) {
        const binary = text.includes('\0') || text.includes('\uFFFD');
        const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
        change = { added: binary ? null : lines, removed: binary ? null : 0, binary };
      }
    }
  } catch { unavailable = true; }
  return { size, modifiedAt, ...(change || {}), ...(unavailable ? { unavailable: true } : {}) };
}
