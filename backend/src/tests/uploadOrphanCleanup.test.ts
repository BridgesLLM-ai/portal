import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  cleanupStaleExtractionDirectories,
  cleanupStaleRegularFilesInDirectory,
} from '../services/uploadOrphanCleanup';

describe('upload orphan cleanup', () => {
  let root: string;
  const now = Date.now() + 10_000;
  const maxAge = 1_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-orphans-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeOld(target: string) {
    const old = new Date(now - maxAge - 5_000);
    fs.utimesSync(target, old, old);
  }

  test('removes only stale regular files selected by the caller', () => {
    const stale = path.join(root, '.portal-delete-old.part');
    const fresh = path.join(root, '.portal-delete-fresh.part');
    const unrelated = path.join(root, 'keep.txt');
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(fresh, 'fresh');
    fs.writeFileSync(unrelated, 'keep');
    makeOld(stale);
    makeOld(unrelated);
    const current = new Date(now);
    fs.utimesSync(fresh, current, current);
    fs.symlinkSync(unrelated, path.join(root, '.portal-delete-link.part'));

    const removed = cleanupStaleRegularFilesInDirectory(
      root,
      now,
      maxAge,
      (name) => name.startsWith('.portal-delete-'),
    );
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.lstatSync(path.join(root, '.portal-delete-link.part')).isSymbolicLink()).toBe(true);
  });

  test('removes stale extraction staging but preserves normal and fresh directories', () => {
    const stale = path.join(root, '.project.extract-ABC123');
    const fresh = path.join(root, '.project.extract-XYZ789');
    const normal = path.join(root, 'project');
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.mkdirSync(normal);
    fs.writeFileSync(path.join(stale, 'partial'), 'x');
    makeOld(stale);
    const current = new Date(now);
    fs.utimesSync(fresh, current, current);

    expect(cleanupStaleExtractionDirectories(root, now, maxAge)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(normal)).toBe(true);
  });
});
