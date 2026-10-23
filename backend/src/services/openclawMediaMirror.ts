import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Root of the Portal's OpenClaw tool mirror of Files uploads. Every upload is
 * hard-linked (or copied across devices) to `<root>/user-<id>/uploads/<name>`
 * so OpenClaw tools can read it; see ensureToolMirror in routes/files.ts.
 */
export function resolveOpenClawMediaMirrorBase(): string {
  const candidates = [
    process.env.OPENCLAW_STATE_DIR?.trim(),
    path.join(os.homedir(), '.openclaw'),
    '/root/.openclaw',
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (fs.existsSync(normalized)) {
      return path.join(normalized, 'media', 'portal-files');
    }
  }

  return path.join(path.join(os.homedir(), '.openclaw'), 'media', 'portal-files');
}

export const OPENCLAW_MEDIA_MIRROR_BASE = path.resolve(
  process.env.PORTAL_OPENCLAW_MEDIA_MIRROR_ROOT || resolveOpenClawMediaMirrorBase(),
);
