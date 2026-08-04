import path from 'path';
import { isPathContained } from './containedPath';

export interface OwnedFileDeepLinkRoots {
  canonicalUploadsRoot: string;
  mediaMirrorUploadsRoot: string;
  legacyOwnerRoot: string;
}

/**
 * Convert a Files deep-link path into the exact actor-owned path stored in the
 * File row. Physical paths are accepted only beneath one of that actor's
 * attested storage roots. A basename fallback is intentionally forbidden:
 * duplicate names must never make a deep link select a different file.
 */
export function normalizeOwnedFileDeepLinkPath(
  rawPath: string,
  roots: OwnedFileDeepLinkRoots,
): string | null {
  let normalizedInput = rawPath.trim().replace(/\\/g, '/');
  if (
    !normalizedInput
    || normalizedInput.length > 2048
    || /[\u0000-\u001f\u007f]/.test(normalizedInput)
  ) return null;

  const validateRelativePath = (candidate: string): string | null => {
    const parts = candidate.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) return null;
    return parts.join('/');
  };

  // Older agents emitted the media mirror through a logical home alias rather
  // than the configured absolute OPENCLAW_STATE_DIR. Preserve those links by
  // mapping only the exact current actor subtree onto its attested mirror root.
  // A different user's subtree never degrades into basename matching.
  const mirrorRoot = path.resolve(roots.mediaMirrorUploadsRoot);
  const mirrorOwner = path.basename(path.dirname(mirrorRoot));
  const mirrorLeaf = path.basename(mirrorRoot);
  const actorMirrorSuffix = `${mirrorOwner}/${mirrorLeaf}/`;
  for (const logicalPrefix of [
    '~/.openclaw/media/portal-files/',
    '.openclaw/media/portal-files/',
    '/.openclaw/media/portal-files/',
  ]) {
    if (!normalizedInput.startsWith(logicalPrefix)) continue;
    const logicalRemainder = normalizedInput.slice(logicalPrefix.length);
    if (!logicalRemainder.startsWith(actorMirrorSuffix)) return null;
    return validateRelativePath(logicalRemainder.slice(actorMirrorSuffix.length));
  }

  // Markdown sometimes omits the leading slash from the default /root path.
  // Treat it as that absolute path; configured-root containment below remains
  // authoritative, so it does not become an alias on custom state roots.
  if (normalizedInput.startsWith('root/.openclaw/media/portal-files/')) {
    normalizedInput = `/${normalizedInput}`;
  }

  if (!path.posix.isAbsolute(normalizedInput)) {
    return validateRelativePath(normalizedInput);
  }

  for (const configuredRoot of [
    roots.canonicalUploadsRoot,
    roots.mediaMirrorUploadsRoot,
    roots.legacyOwnerRoot,
  ]) {
    const root = path.resolve(configuredRoot);
    const candidate = path.resolve(normalizedInput);
    if (!isPathContained(root, candidate) || candidate === root) continue;
    const relative = path.relative(root, candidate);
    if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) continue;
    return validateRelativePath(relative.split(path.sep).join('/'));
  }

  return null;
}
