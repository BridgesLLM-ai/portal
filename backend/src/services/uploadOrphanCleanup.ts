import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const THUMBNAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface UploadCleanupRoots {
  tempFileRoots: string[];
  projectsRoot: string;
  appsRoot: string;
  filesRoot: string;
}

export function resolveUploadCleanupRoots(): UploadCleanupRoots {
  const portalRoot = path.resolve(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal');
  return {
    tempFileRoots: [
      path.resolve(process.env.PORTAL_UPLOAD_TEMP_ROOT || path.join(portalRoot, 'upload-temp')),
      path.resolve(process.env.PORTAL_PROJECT_ZIPS_ROOT || path.join(portalRoot, 'project-zips')),
      path.resolve(process.env.PORTAL_APP_ZIPS_ROOT || path.join(portalRoot, 'app-zips')),
    ],
    projectsRoot: path.resolve(process.env.PORTAL_PROJECTS_ROOT || path.join(portalRoot, 'projects')),
    appsRoot: path.resolve(process.env.PORTAL_APPS_ROOT || path.join(portalRoot, 'apps')),
    filesRoot: path.resolve(process.env.PORTAL_FILES_ROOT || '/var/portal-files'),
  };
}

function olderThan(stat: fs.Stats, now: number, maxAgeMs: number): boolean {
  return now - Math.max(stat.mtimeMs, stat.ctimeMs) > maxAgeMs;
}

export function cleanupStaleRegularFilesInDirectory(
  directory: string,
  now: number,
  maxAgeMs: number,
  predicate: (name: string) => boolean = () => true,
): number {
  if (!fs.existsSync(directory)) return 0;
  const rootStat = fs.lstatSync(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !predicate(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || !olderThan(stat, now, maxAgeMs)) continue;
    try { fs.unlinkSync(target); removed++; } catch {}
  }
  return removed;
}

export function cleanupStaleExtractionDirectories(parent: string, now: number, maxAgeMs: number): number {
  if (!fs.existsSync(parent)) return 0;
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\..+\.extract-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const target = path.join(parent, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !olderThan(stat, now, maxAgeMs)) continue;
    try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

export function cleanupStaleUploadArtifacts(
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  roots: UploadCleanupRoots = resolveUploadCleanupRoots(),
): number {
  let removed = 0;
  for (const root of roots.tempFileRoots) {
    removed += cleanupStaleRegularFilesInDirectory(root, now, maxAgeMs);
  }
  removed += cleanupStaleExtractionDirectories(roots.appsRoot, now, maxAgeMs);

  if (fs.existsSync(roots.projectsRoot) && fs.lstatSync(roots.projectsRoot).isDirectory()) {
    for (const owner of fs.readdirSync(roots.projectsRoot, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
      removed += cleanupStaleExtractionDirectories(path.join(roots.projectsRoot, owner.name), now, maxAgeMs);
    }
  }

  if (fs.existsSync(roots.filesRoot) && fs.lstatSync(roots.filesRoot).isDirectory()) {
    for (const owner of fs.readdirSync(roots.filesRoot, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.isSymbolicLink() || !owner.name.startsWith('user-')) continue;
      const uploads = path.join(roots.filesRoot, owner.name, 'uploads');
      removed += cleanupStaleRegularFilesInDirectory(uploads, now, maxAgeMs, (name) => /^\.portal-(delete|move|import)-.+\.part$/.test(name));
      removed += cleanupStaleRegularFilesInDirectory(
        path.join(uploads, '.thumbnails'),
        now,
        Math.max(maxAgeMs, THUMBNAIL_MAX_AGE_MS),
        (name) => /^[a-f0-9]{64}\.webp$/.test(name),
      );
    }
  }
  return removed;
}

let cleanupTimer: NodeJS.Timeout | undefined;

export function startUploadOrphanCleanup(): void {
  cleanupStaleUploadArtifacts();
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => cleanupStaleUploadArtifacts(), 30 * 60 * 1000);
  cleanupTimer.unref();
}

export function stopUploadOrphanCleanup(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = undefined;
}
