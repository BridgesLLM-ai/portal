/**
 * The raster worker runs as nobody (see chatImageSandbox), but installed Portals keep
 * backend/node_modules root-only (0700 dirs, 0600 files). Give the sandbox a root-owned,
 * read-only-to-everyone copy of just sharp's dependency closure instead of loosening
 * node_modules itself. Development trees that nobody can already read are used as-is.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureRuntimeDirectory } from '../../utils/runtimeDirectory';

export const RASTER_MODULES_CACHE_ROOT = '/run/bridgesllm/chat-image-raster';
const ENTRY = 'sharp';

type Closure = { relative: string; version: string }[];

function readPackage(dir: string): { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** Node's lookup from `from` upwards, confined to `modulesDir`. */
function packageDir(modulesDir: string, name: string, from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir === modulesDir ? dir : path.join(dir, 'node_modules'), name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === modulesDir || !dir.startsWith(modulesDir + path.sep)) return null;
  }
}

/** sharp plus every dependency and installed optional dependency, relative to modulesDir. */
export function sharpClosure(modulesDir: string): Closure {
  const seen = new Map<string, string>();
  const visit = (name: string, from: string) => {
    const dir = packageDir(modulesDir, name, from);
    if (!dir || seen.has(dir)) return;
    const pkg = readPackage(dir);
    seen.set(dir, String(pkg.version || ''));
    for (const dependency of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) visit(dependency, dir);
  };
  visit(ENTRY, modulesDir);
  if (!seen.size) throw new Error('sharp is not installed');
  return [...seen].map(([dir, version]) => ({ relative: path.relative(modulesDir, dir), version }))
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

const othersMay = (target: string, bits: number) => (fs.statSync(target).mode & bits) === bits;

function ensureRootDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('raster module cache root is not a private directory');
  }
  if ((stat.mode & 0o777) !== 0o755) fs.chmodSync(dir, 0o755);
}

function makeReadable(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { fs.chmodSync(target, 0o755); makeReadable(target); }
    else if (entry.isFile()) fs.chmodSync(target, 0o644);
  }
}

/**
 * Directory to bind at /mnt/modules for the nobody-owned raster worker. Returns
 * `modulesDir` unchanged when nobody can already read it; otherwise a cached copy
 * keyed by the exact closure versions. Stale copies from earlier versions are removed.
 */
export function sandboxReadableModules(modulesDir: string, cacheRoot = RASTER_MODULES_CACHE_ROOT): string {
  if (othersMay(modulesDir, 0o005) && othersMay(path.join(modulesDir, ENTRY), 0o005)
    && othersMay(path.join(modulesDir, ENTRY, 'package.json'), 0o004)) return modulesDir;
  const closure = sharpClosure(modulesDir);
  const key = crypto.createHash('sha256').update(JSON.stringify(closure)).digest('hex').slice(0, 32);
  const target = path.join(cacheRoot, key);
  const ready = path.join(target, 'node_modules');
  // The readable module leaf must not create the shared runtime parent as 0755
  // when a photo is the first request after boot. Only enforce the product-owned
  // default parent; a caller-supplied cache must not chmod an unrelated ancestor.
  if (cacheRoot === RASTER_MODULES_CACHE_ROOT) {
    ensureRuntimeDirectory(path.dirname(RASTER_MODULES_CACHE_ROOT), { mode: 0o700, enforceMode: true });
  }
  ensureRootDirectory(cacheRoot);
  if (!fs.existsSync(path.join(target, '.complete'))) {
    const staging = path.join(cacheRoot, `.staging-${key}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      for (const { relative } of closure) {
        fs.cpSync(path.join(modulesDir, relative), path.join(staging, 'node_modules', relative),
          { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      }
      makeReadable(staging);
      fs.chmodSync(staging, 0o755);
      fs.writeFileSync(path.join(staging, '.complete'), JSON.stringify(closure) + '\n', { mode: 0o644 });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(cacheRoot)) {
    if (entry !== key) fs.rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
  }
  return ready;
}
