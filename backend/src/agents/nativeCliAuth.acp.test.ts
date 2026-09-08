import fs from 'fs';
import os from 'os';
import path from 'path';
import { getNativeCliAuthStatus } from './nativeCliAuth';

describe('native ACP harness auth isolation', () => {
  const temporaryDirectories: string[] = [];
  const originalHermesHome = process.env.PORTAL_HERMES_HOME;
  const originalOpenCodeHome = process.env.PORTAL_OPENCODE_HOME;

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.PORTAL_HERMES_HOME;
    else process.env.PORTAL_HERMES_HOME = originalHermesHome;
    if (originalOpenCodeHome === undefined) delete process.env.PORTAL_OPENCODE_HOME;
    else process.env.PORTAL_OPENCODE_HOME = originalOpenCodeHome;
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('Hermes requires credentials inside its dedicated profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hermes-auth-'));
    temporaryDirectories.push(root);
    process.env.PORTAL_HERMES_HOME = root;

    expect(getNativeCliAuthStatus('HERMES')).toMatchObject({
      status: 'needs_login',
      loginCommand: 'hermes model',
      requiresSeparateLogin: true,
    });
    fs.writeFileSync(path.join(root, '.env'), 'OPENROUTER_API_KEY=test-only\n', { mode: 0o600 });
    expect(getNativeCliAuthStatus('HERMES')).toMatchObject({
      status: 'authenticated',
      loginCommand: 'hermes model',
    });
  });

  test('OpenCode reads only its dedicated XDG auth store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-opencode-auth-'));
    temporaryDirectories.push(root);
    process.env.PORTAL_OPENCODE_HOME = root;

    expect(getNativeCliAuthStatus('OPENCODE')).toMatchObject({
      status: 'needs_login',
      loginCommand: 'opencode auth login',
      requiresSeparateLogin: true,
    });
    const authDirectory = path.join(root, 'data', 'opencode');
    fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDirectory, 'auth.json'), JSON.stringify({
      anthropic: { type: 'oauth', access: 'test-access-token', refresh: 'test-refresh-token' },
    }), { mode: 0o600 });
    expect(getNativeCliAuthStatus('OPENCODE')).toMatchObject({
      status: 'authenticated',
      loginCommand: 'opencode auth login',
    });
  });
});
