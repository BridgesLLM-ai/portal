import fs from 'fs';
import os from 'os';
import path from 'path';
import { sandboxReadableModules, sharpClosure } from './rasterModules';

const write = (file: string, body: string, mode = 0o600) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { mode });
};
const pkg = (dir: string, name: string, version: string, extra: object = {}) =>
  write(path.join(dir, name, 'package.json'), JSON.stringify({ name, version, ...extra }));
const tighten = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { fs.chmodSync(target, 0o700); tighten(target); } else fs.chmodSync(target, 0o600);
  }
  fs.chmodSync(dir, 0o700);
};

describe('sandbox-readable sharp modules', () => {
  let root: string, modules: string, cache: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-modules-'));
    modules = path.join(root, 'node_modules'); cache = path.join(root, 'cache');
    pkg(modules, 'sharp', '0.35.5', { dependencies: { '@img/colour': '^1', 'detect-libc': '^2' }, optionalDependencies: { '@img/sharp-linux-x64': '0.35.5', '@img/sharp-darwin-arm64': '0.35.5' } });
    write(path.join(modules, 'sharp/lib/index.js'), 'module.exports = 1;');
    pkg(modules, '@img/colour', '1.1.0');
    pkg(modules, 'detect-libc', '2.1.2');
    pkg(modules, '@img/sharp-linux-x64', '0.35.5', { optionalDependencies: { '@img/sharp-libvips-linux-x64': '1.3.4' } });
    pkg(modules, '@img/sharp-libvips-linux-x64', '1.3.4');
    write(path.join(modules, '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8'), 'ELF');
    fs.symlinkSync('libvips-cpp.so.8', path.join(modules, '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so'));
    pkg(modules, 'unrelated-secret', '9.9.9');
    tighten(modules);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('walks dependencies and installed optional dependencies only', () => {
    expect(sharpClosure(modules).map(row => row.relative)).toEqual([
      '@img/colour', '@img/sharp-libvips-linux-x64', '@img/sharp-linux-x64', 'detect-libc', 'sharp']);
  });

  it('uses a tree nobody can already read without copying', () => {
    fs.chmodSync(modules, 0o755); fs.chmodSync(path.join(modules, 'sharp'), 0o755); fs.chmodSync(path.join(modules, 'sharp/package.json'), 0o644);
    expect(sandboxReadableModules(modules, cache)).toBe(modules);
    expect(fs.existsSync(cache)).toBe(false);
  });

  it('copies only the closure of a root-only tree with readable modes and verbatim symlinks', () => {
    const ready = sandboxReadableModules(modules, cache);
    expect(path.dirname(path.dirname(ready))).toBe(cache);
    expect(fs.readdirSync(ready).sort()).toEqual(['@img', 'detect-libc', 'sharp']);
    expect(fs.existsSync(path.join(ready, 'unrelated-secret'))).toBe(false);
    expect(fs.statSync(ready).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(ready, 'sharp/lib/index.js')).mode & 0o777).toBe(0o644);
    expect(fs.readlinkSync(path.join(ready, '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so'))).toBe('libvips-cpp.so.8');
    expect(fs.statSync(cache).mode & 0o777).toBe(0o755);
  });

  it('reuses a complete copy and drops stale versions', () => {
    const first = sandboxReadableModules(modules, cache);
    const inode = fs.statSync(path.join(first, 'sharp/package.json')).ino;
    expect(sandboxReadableModules(modules, cache)).toBe(first);
    expect(fs.statSync(path.join(first, 'sharp/package.json')).ino).toBe(inode);
    fs.chmodSync(path.join(modules, 'detect-libc/package.json'), 0o600);
    fs.writeFileSync(path.join(modules, 'detect-libc/package.json'), JSON.stringify({ name: 'detect-libc', version: '2.2.0' }));
    const second = sandboxReadableModules(modules, cache);
    expect(second).not.toBe(first);
    expect(fs.readdirSync(cache)).toEqual([path.basename(path.dirname(second))]);
  });

  it('refuses a symlinked cache root', () => {
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), cache);
    expect(() => sandboxReadableModules(modules, cache)).toThrow('raster module cache root');
  });
});
