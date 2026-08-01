import path from 'path';
import os from 'os';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import {
  escapeHtml,
  isBlockedAppStaticPath,
  isPathWithin,
  resolveExistingAppDirectory,
  resolveExistingPathWithin,
} from '../utils/appFileSecurity';

describe('app file security helpers', () => {
  test('uses path-aware containment instead of unsafe prefix matching', () => {
    const base = '/var/www/bridgesllm-apps/app';

    expect(isPathWithin(base, path.join(base, 'dist/index.html'))).toBe(true);
    expect(isPathWithin(base, base)).toBe(true);
    expect(isPathWithin(base, '/var/www/bridgesllm-apps/app-evil/secret.txt')).toBe(false);
    expect(isPathWithin(base, '/var/www/bridgesllm-apps/app/../app-evil/secret.txt')).toBe(false);
  });

  test('blocks server and runtime artifacts from shared or hosted static routes', () => {
    const blocked = [
      'server.js',
      'dist/server.js',
      '.env',
      '.rate-tool-data/users.json',
      'config/secrets.json',
      'cache/session-cache.json',
      'auth/private-token',
      'package.json',
      'package-lock.json',
      'users.json',
      'assets/app.js.map',
      'achievements/achievement-atlas.gif.bak-basic',
      'data/prod.sqlite',
      'keys/private.pem',
      'src/main.tsx',
    ];

    for (const requestPath of blocked) {
      expect(isBlockedAppStaticPath(requestPath)).toBe(true);
    }
  });

  test('allows normal static app assets', () => {
    const allowed = [
      '',
      'index.html',
      'app.js',
      'assets/main.css',
      'assets/logo.svg',
      'us-cities-lite.json',
      'assets/vendor.wasm',
    ];

    for (const requestPath of allowed) {
      expect(isBlockedAppStaticPath(requestPath)).toBe(false);
    }
  });

  test('escapes names rendered into the share password landing page', () => {
    expect(escapeHtml('A&B <script>"x"</script>')).toBe('A&amp;B &lt;script&gt;&quot;x&quot;&lt;/script&gt;');
  });

  test('rejects files and app directories that escape through symlinks', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'portal-app-file-security-'));
    const root = path.join(fixture, 'apps');
    const appDir = path.join(root, 'app-1');
    const outside = path.join(fixture, 'outside');
    mkdirSync(appDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(appDir, 'index.html'), 'safe');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(appDir, 'leak.txt'));
    symlinkSync(outside, path.join(root, 'app-evil'));

    try {
      expect(resolveExistingPathWithin(appDir, path.join(appDir, 'index.html'))).toBe(path.join(appDir, 'index.html'));
      expect(resolveExistingPathWithin(appDir, path.join(appDir, 'leak.txt'))).toBeNull();
      expect(resolveExistingAppDirectory(path.join(root, 'app-evil'), [root])).toBeNull();
      expect(resolveExistingAppDirectory(appDir, [root])).toBe(appDir);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
