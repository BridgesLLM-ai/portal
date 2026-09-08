import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildAcpHarnessEnvironment,
  resolveAcpHarnessCredentialPaths,
  resolveAcpHarnessReadinessPaths,
} from './AcpHarnessEnvironment';

describe('ACP harness environment isolation', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('gives Hermes a private home without leaking Portal/OpenClaw credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hermes-'));
    temporaryDirectories.push(root);
    const env = buildAcpHarnessEnvironment('HERMES', {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      PORTAL_HERMES_HOME: root,
      DATABASE_URL: 'must-not-leak',
      JWT_SECRET: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HERMES_HOME: fs.realpathSync(root),
      HOME: fs.realpathSync(path.join(root, 'home')),
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      HERMES_ACP_SKIP_CONFIGURED_MCP: '1',
      NO_COLOR: '1',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(resolveAcpHarnessCredentialPaths('HERMES', {
      PORTAL_HERMES_HOME: root,
    })).toEqual([path.join(root, 'auth.json'), path.join(root, '.env'), path.join(root, 'config.yaml')]);
    expect(resolveAcpHarnessReadinessPaths('HERMES', {
      PORTAL_HERMES_HOME: root,
    })).toEqual([path.join(root, 'auth.json'), path.join(root, '.env'), path.join(root, 'config.yaml')]);
  });

  test('gives OpenCode dedicated XDG state and disables network-facing extras', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-opencode-'));
    temporaryDirectories.push(root);
    const env = buildAcpHarnessEnvironment('OPENCODE', {
      PATH: '/usr/local/bin',
      PORTAL_OPENCODE_HOME: root,
      OPENCLAW_GATEWAY_TOKEN: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
    });

    expect(env).toMatchObject({
      PATH: '/usr/local/bin',
      HOME: fs.realpathSync(path.join(root, 'home')),
      XDG_CONFIG_HOME: fs.realpathSync(path.join(root, 'config')),
      XDG_CACHE_HOME: fs.realpathSync(path.join(root, 'cache')),
      XDG_DATA_HOME: fs.realpathSync(path.join(root, 'data')),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_SHARE: '1',
      NO_COLOR: '1',
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolveAcpHarnessCredentialPaths('OPENCODE', {
      PORTAL_OPENCODE_HOME: root,
    })).toEqual([path.join(root, 'data', 'opencode', 'auth.json')]);
    expect(resolveAcpHarnessReadinessPaths('OPENCODE', {
      PORTAL_OPENCODE_HOME: root,
    })).toEqual([
      path.join(root, 'data', 'opencode', 'auth.json'),
      path.join(root, 'config', 'opencode', 'opencode.json'),
      path.join(root, 'config', 'opencode', 'opencode.jsonc'),
    ]);
  });

  test('rejects relative state roots', () => {
    expect(() => buildAcpHarnessEnvironment('HERMES', {
      PORTAL_HERMES_HOME: 'relative/hermes',
    })).toThrow(/absolute path/i);
  });
});
