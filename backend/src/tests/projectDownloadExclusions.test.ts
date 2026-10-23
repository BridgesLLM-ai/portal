import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isEnvironmentSecretFileName,
  isProjectDownloadPathExcluded,
  type ProjectDownloadMode,
} from '../services/projectDownloadExclusions';
import { copyProjectDownloadSnapshot } from '../services/projectDownloadSnapshot';

const MODES: ProjectDownloadMode[] = ['full', 'clean', 'stripped'];

describe('Project download exclusions', () => {
  it.each(MODES)('drops credential material at any depth in %s mode', (mode) => {
    for (const secret of [
      '.env',
      'backend/.env',
      'apps/web/.env.local',
      '.env.production',
      'server/.env.production',
      '.env.development.local',
      '.ENV.Production',
      '.envrc',
      '.ssh',
      '.ssh/id_ed25519',
      'deploy/.ssh/known_hosts',
      '.aws/credentials',
      'infra/.aws/config',
      '.azure/accessTokens.json',
      '.gnupg/private-keys-v1.d/key',
      '.kube/config',
      '.netrc',
      '.npmrc',
      'packages/web/.npmrc',
      'tools/.pgpass',
      '.git-credentials',
      '.pypirc',
    ]) {
      expect([secret, isProjectDownloadPathExcluded(secret, mode)]).toEqual([secret, true]);
    }
  });

  it.each(MODES)('keeps templates and ordinary source in %s mode', (mode) => {
    for (const kept of [
      '.env.example',
      'backend/.env.example',
      '.env.production.example',
      '.env.sample',
      'config/.env.template',
      '.npmrc.example',
      'packages/web/.npmrc.example',
      '.gitignore',
      '.gitattributes',
      '.github/workflows/ci.yml',
      'src/environment.ts',
      'env.ts',
      'docs/node_modules.md',
      'src/cache.ts',
      'src/distance.ts',
      'scripts/rebuild.sh',
      'build.rs',
      'src/ssh-client.ts',
      '.portal/notes.md',
      'docs/README.md',
    ]) {
      expect([kept, isProjectDownloadPathExcluded(kept, mode)]).toEqual([kept, false]);
    }
  });

  it.each(MODES)('drops generated and Portal-internal entries at any depth in %s mode', (mode) => {
    for (const generated of [
      '.git',
      '.git/HEAD',
      'vendor/lib/.git/config',
      'node_modules/react/index.js',
      'packages/web/node_modules/vite/bin.js',
      '.venv/bin/python',
      'pkg/__pycache__/mod.cpython-312.pyc',
      'scripts/tool.pyc',
      '.pytest_cache/v/cache',
      '.cache/x',
      '.turbo/log',
      '.assistant-history.json',
      'src/.agent-scratch',
      '.portal/attachments/photo.png',
      '.portal-project.json',
      '.deps-installed',
      'assets/.DS_Store',
      'Thumbs.db',
    ]) {
      expect([generated, isProjectDownloadPathExcluded(generated, mode)]).toEqual([generated, true]);
    }
  });

  it('drops build output and root agent/readme documents only in clean modes', () => {
    for (const cleanOnly of [
      'dist/index.js',
      'packages/web/dist/app.js',
      'build/output.bin',
      '.next/cache',
      '.nuxt/app',
      'coverage/lcov.info',
      '.vscode/settings.json',
      '.idea/workspace.xml',
      'README.md',
      'Agent.md',
    ]) {
      expect([cleanOnly, isProjectDownloadPathExcluded(cleanOnly, 'full')]).toEqual([cleanOnly, false]);
      expect([cleanOnly, isProjectDownloadPathExcluded(cleanOnly, 'clean')]).toEqual([cleanOnly, true]);
      expect([cleanOnly, isProjectDownloadPathExcluded(cleanOnly, 'stripped')]).toEqual([cleanOnly, true]);
    }
  });

  it('recognises every .env variant except value-free templates', () => {
    expect(isEnvironmentSecretFileName('.env')).toBe(true);
    expect(isEnvironmentSecretFileName('.env.staging')).toBe(true);
    expect(isEnvironmentSecretFileName('.env.test.local')).toBe(true);
    expect(isEnvironmentSecretFileName('.env.example')).toBe(false);
    expect(isEnvironmentSecretFileName('.env.local.sample')).toBe(false);
    expect(isEnvironmentSecretFileName('.environment')).toBe(false);
    expect(isEnvironmentSecretFileName('env')).toBe(false);
  });
});

describe('Project download snapshot with exclusions', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-exclusions-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, body = 'x') {
    const target = path.join(root, 'project', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  function listFiles(directory: string, prefix = ''): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relative) : [relative];
    }).sort();
  }

  it.each(MODES)('leaves nested secrets out of the inert snapshot in %s mode', async (mode) => {
    for (const file of [
      'package.json', 'src/index.ts', '.env', '.env.example', 'backend/.env', 'backend/.env.example',
      '.env.production', '.ssh/id_ed25519', 'infra/.aws/credentials', '.github/workflows/ci.yml', '.gitignore',
      '.npmrc', 'packages/web/.npmrc', '.npmrc.example',
    ]) write(file, file.endsWith('.npmrc') ? '//registry.npmjs.org/:_authToken=npm_fixture\n' : 'x');
    const snapshot = path.join(root, 'snapshot');
    await copyProjectDownloadSnapshot(path.join(root, 'project'), snapshot, {
      isExcluded: (relativePath) => isProjectDownloadPathExcluded(relativePath, mode),
    });
    expect(listFiles(snapshot)).toEqual([
      '.env.example',
      '.github/workflows/ci.yml',
      '.gitignore',
      '.npmrc.example',
      'backend/.env.example',
      'package.json',
      'src/index.ts',
    ]);
  });
});
