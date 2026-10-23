import fs from 'fs';
import os from 'os';
import path from 'path';
import { fingerprintDesktopSource } from './projectDesktopSource';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-source-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
it('detects nested content, target and dependency edits but ignores compiler caches', async () => {
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/main.ts'), 'original');
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'locked');
  const first = await fingerprintDesktopSource(root);
  fs.mkdirSync(path.join(root, 'target')); fs.writeFileSync(path.join(root, 'target/noise'), 'cache');
  expect(await fingerprintDesktopSource(root)).toBe(first);
  fs.writeFileSync(path.join(root, 'src/main.ts'), 'modified'); expect(await fingerprintDesktopSource(root)).not.toBe(first);
  fs.writeFileSync(path.join(root, 'src/main.ts'), 'original'); fs.writeFileSync(path.join(root, 'package-lock.json'), 'new lock');
  expect(await fingerprintDesktopSource(root)).not.toBe(first);
});
it('rejects escaping source links and stops cancelled inspection', async () => {
  fs.symlinkSync('/etc/passwd', path.join(root, 'escape'));
  await expect(fingerprintDesktopSource(root)).rejects.toThrow('escapes');
  fs.unlinkSync(path.join(root, 'escape'));fs.writeFileSync(path.join(root, 'main.py'), 'print(1)');
  await expect(fingerprintDesktopSource(root, AbortSignal.abort())).rejects.toThrow('cancelled');
});
