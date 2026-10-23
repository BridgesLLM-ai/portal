import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Content identity of the editable source, not a Git HEAD or build artifact.
 * Async, bounded and cache-independent so status reads cannot hash a Cargo target tree. */
export async function fingerprintDesktopSource(root: string, signal?: AbortSignal): Promise<string> {
  const base = await fs.promises.realpath(root), hash = crypto.createHash('sha256');
  const omitted = new Set(['.git', 'node_modules', '.venv', 'target', 'build', 'dist', '__pycache__', '.portal-build-cache', '.desktop-out', '.portal-desktop-build.json']);
  let entries = 0, bytes = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 30) throw new Error('Desktop source nesting exceeds its limit');
    const children = (await fs.promises.readdir(path.join(base, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      if (signal?.aborted) throw new Error('Desktop source inspection cancelled');
      if (omitted.has(child.name)) continue;
      if (++entries > 20_000) throw new Error('Desktop source exceeds its file limit');
      const name = relative ? relative + '/' + child.name : child.name, absolute = path.join(base, name);
      if (child.isDirectory()) { hash.update(name + '\0directory\0'); await walk(name, depth + 1); }
      else if (child.isSymbolicLink()) {
        const destination = await fs.promises.realpath(absolute);
        if (!destination.startsWith(base + path.sep)) throw new Error('Desktop source link escapes its Project');
        hash.update(name + '\0link\0' + await fs.promises.readlink(absolute) + '\0');
      } else if (child.isFile()) {
        const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat(); bytes += stat.size;
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error('Desktop source exceeds its byte limit');
          hash.update(name + '\0file\0' + (stat.mode & 0o111 ? 'executable' : 'data') + '\0' + stat.size + '\0');
          const buffer = Buffer.allocUnsafe(256 * 1024); let offset = 0;
          for (;;) {
            if (signal?.aborted) throw new Error('Desktop source inspection cancelled');
            const read = await handle.read(buffer, 0, buffer.length, offset); if (!read.bytesRead) break;
            offset += read.bytesRead; if (offset > stat.size) throw new Error('Desktop source changed during inspection');
            hash.update(buffer.subarray(0, read.bytesRead));
          }
          if (offset !== stat.size) throw new Error('Desktop source changed during inspection');
          hash.update('\0');
        } finally { await handle.close(); }
      } else throw new Error('Desktop source contains a non-regular file');
    }
  }
  await walk('', 0); return hash.digest('hex');
}
