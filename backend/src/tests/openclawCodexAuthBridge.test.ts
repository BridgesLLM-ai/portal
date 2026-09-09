import fs from 'fs';
import os from 'os';
import path from 'path';

describe('OpenClaw legacy Codex plugin state', () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-auth-'));
    process.env.HOME = path.join(tempDir, 'home');
    process.env.OPENCLAW_HOME = path.join(tempDir, 'openclaw');
    delete process.env.CODEX_HOME;
    fs.mkdirSync(process.env.HOME, { recursive: true });
    fs.mkdirSync(process.env.OPENCLAW_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('removes stale legacy Codex plugin state without touching current project installs', () => {
    const openclawHome = process.env.OPENCLAW_HOME as string;
    const installsPath = path.join(openclawHome, 'plugins', 'installs.json');
    const staleGlobalPluginDir = path.join(openclawHome, 'npm', 'node_modules', '@openclaw', 'codex');
    const currentProjectPluginSource = path.join(
      openclawHome,
      'npm',
      'projects',
      'openclaw-codex-current',
      'node_modules',
      '@openclaw',
      'codex',
      'dist',
      'index.js',
    );

    fs.mkdirSync(path.dirname(installsPath), { recursive: true });
    fs.mkdirSync(staleGlobalPluginDir, { recursive: true });
    fs.writeFileSync(path.join(staleGlobalPluginDir, 'package.json'), JSON.stringify({
      name: '@openclaw/codex',
      version: '2026.5.27',
    }, null, 2));
    fs.writeFileSync(installsPath, JSON.stringify({
      installRecords: {
        codex: {
          pluginId: 'codex',
          packageName: '@openclaw/codex',
          packageVersion: '2026.5.27',
          source: path.join(staleGlobalPluginDir, 'dist', 'index.js'),
        },
      },
      plugins: [
        {
          pluginId: 'codex',
          packageName: '@openclaw/codex',
          packageVersion: '2026.5.27',
          source: path.join(staleGlobalPluginDir, 'dist', 'index.js'),
        },
        {
          pluginId: 'codex',
          packageName: '@openclaw/codex',
          packageVersion: '2026.6.8',
          source: currentProjectPluginSource,
        },
        {
          pluginId: 'other',
          source: '/tmp/other-plugin/dist/index.js',
        },
      ],
    }, null, 2));

    const manager = require('../services/openclawConfigManager');
    const result = manager.repairOpenClawCodexPluginInstallState('2026.6.8');
    const installs = JSON.parse(fs.readFileSync(installsPath, 'utf8'));

    expect(result).toMatchObject({
      expectedVersion: '2026.6.8',
      removedLegacyInstallRecord: true,
      removedLegacyPluginEntries: 1,
      globalPluginVersion: '2026.5.27',
    });
    expect(result.quarantinedGlobalPluginDir).toContain('plugin-backups');
    expect(installs.installRecords).not.toHaveProperty('codex');
    expect(installs.plugins).toEqual([
      expect.objectContaining({
        pluginId: 'codex',
        packageVersion: '2026.6.8',
        source: currentProjectPluginSource,
      }),
      expect.objectContaining({ pluginId: 'other' }),
    ]);
    expect(fs.existsSync(staleGlobalPluginDir)).toBe(false);
    expect(fs.existsSync(result.quarantinedGlobalPluginDir)).toBe(true);
  });
});
