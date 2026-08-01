import fs from 'fs';
import path from 'path';

export interface RuntimeDirectoryOptions {
  /** Mode used for directories created by this call. */
  mode?: number;
  /** Re-apply mode to the final directory after validation. */
  enforceMode?: boolean;
}

/**
 * Create a trusted runtime directory without following symbolic links.
 *
 * Runtime roots are selected by the server, but they still live on a mutable
 * host. Walking one component at a time keeps an existing symlink or regular
 * file from redirecting Portal writes outside the configured root.
 */
export function ensureRuntimeDirectory(
  directory: string,
  options: RuntimeDirectoryOptions = {},
): string {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new Error('Runtime directory path is invalid');
  }

  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const mode = options.mode ?? 0o755;

  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (!stat) {
      try {
        fs.mkdirSync(current, { mode });
      } catch (error: any) {
        // Another process may have created the entry between lstat and mkdir.
        if (error?.code !== 'EEXIST') throw error;
      }
      stat = fs.lstatSync(current);
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Runtime directory contains an unsafe path component: ${current}`);
    }
  }

  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved) {
    throw new Error(`Runtime directory resolved through an unsafe path: ${resolved}`);
  }
  if (options.enforceMode) fs.chmodSync(canonical, mode);
  return canonical;
}
