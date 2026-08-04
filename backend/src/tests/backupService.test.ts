import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  ensureBackupLayout,
  findBackupFile,
  listBackupFiles,
  normalizeBackupRoot,
  parseBackupStatus,
  parseOnCalendar,
  parseSystemctlProperties,
} from '../services/backup.service';
import {
  createAttestedBackupRoot,
  createBackupRunnerFixture,
} from './backupRunnerFixture';

const repositoryRoot = path.resolve(__dirname, '../../..');
const backupScript = path.join(repositoryRoot, 'backup-full.sh');
const tempRoots: string[] = [];

describe('backup status contract', () => {
  it('accepts bounded structured progress and rejects contradictory progress', () => {
    const status = {
      id: 'comprehensive-20260804',
      type: 'comprehensive',
      status: 'running',
      startedAt: '2026-08-04T12:00:00.000Z',
      phase: 'database-snapshot',
      phaseLabel: 'Capturing database snapshot',
      phaseIndex: 5,
      phaseTotal: 12,
      failureDetail: 'Database fence was lost before the snapshot completed',
    };
    expect(parseBackupStatus(JSON.stringify(status))).toMatchObject(status);
    expect(parseBackupStatus(JSON.stringify({ ...status, phaseIndex: 13 }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, phaseLabel: 'unsafe\u0000detail' }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, failureDetail: '🧰'.repeat(250) }))).not.toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, failureDetail: '🧰'.repeat(251) }))).toBeNull();
  });
});

function makeTempRoot(prefix: string): string {
  const { cleanupRoot, fixtureRoot } = createAttestedBackupRoot(prefix);
  tempRoots.push(cleanupRoot);
  return fixtureRoot;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for backup test condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processIsGoneOrZombie(pid: number): boolean {
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      .match(/^\d+ \(.+\) ([A-Z]) /u)?.[1];
    return state === 'Z';
  } catch (error: any) {
    return error?.code === 'ENOENT';
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('backup storage containment', () => {
  it('rejects broad, relative, live-data, symlinked, and writable roots', () => {
    expect(() => normalizeBackupRoot('/')).toThrow(/dedicated/);
    expect(() => normalizeBackupRoot('relative/backups')).toThrow(/absolute/);
    expect(() => normalizeBackupRoot('/root/backups\n/root/escape')).toThrow(/unsafe control/);
    expect(() => normalizeBackupRoot('/opt/bridgesllm/portal/backups')).toThrow(/overlap live Portal/);
    expect(() => normalizeBackupRoot('/opt/bridgesllm/apps/backups')).toThrow(/overlap live Portal/);
    expect(() => normalizeBackupRoot('/opt/bridgesllm')).toThrow(/overlap live Portal/);

    const base = makeTempRoot('backup-path');
    const writable = path.join(base, 'writable', 'backups');
    fs.mkdirSync(writable, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(base, 'writable'), 0o777);
    expect(() => ensureBackupLayout(writable, '/opt/bridgesllm/portal')).toThrow(/group\/world writable/);

    const real = path.join(base, 'real');
    const linked = path.join(base, 'linked');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, linked);
    expect(() => ensureBackupLayout(path.join(linked, 'backups'), '/opt/bridgesllm/portal')).toThrow(/symbolic links/);
    expect(fs.existsSync(path.join(real, 'backups'))).toBe(false);
  });

  it('lists only securely contained, type-matching regular archives', () => {
    const root = ensureBackupLayout(path.join(makeTempRoot('backup-list'), 'backups'));
    const archive = path.join(root, 'daily', 'portal-daily-20260718-120000.tar.gz');
    fs.writeFileSync(archive, 'archive', { mode: 0o600 });
    fs.writeFileSync(`${archive}.locked`, 'locked', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'daily', 'unrelated.tar.gz'), 'ignore', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'daily', 'portal-monthly-20260718.tar.gz'), 'wrong type', { mode: 0o600 });
    fs.symlinkSync(archive, path.join(root, 'daily', 'portal-daily-symlink.tar.gz'));

    const files = listBackupFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: path.basename(archive), type: 'daily', locked: true, size: 7 });
    expect(findBackupFile(root, '../portal-daily-20260718-120000.tar.gz')).toBeNull();
  });
});

describe('persistent backup runner', () => {
  it('does not report successful verification when no recovery archive exists', () => {
    const testRoot = makeTempRoot('backup-empty-verify');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });

    const verification = spawnSync('bash', [backupScript, '--verify'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
      },
      timeout: 30_000,
    });
    expect(verification.status).not.toBe(0);
    expect(verification.stdout).toContain('no Portal backup archives were found');
  });

  it('uses the configured root and writes bounded persistent completion state', () => {
    const testRoot = makeTempRoot('backup-runner');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    const fakeBin = fixture.commandsRoot;
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(fakeBin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'pg_dump'), [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf "%s\\n" "pg_dump (PostgreSQL) 16.14"; exit 0; fi',
      'case " $* " in *"--dbname=postgresql://test%3Aowner@[fe80::1%25eth0]:6543/test%2Ddb?sslmode=verify-full&sslrootcert=%2Fetc%2Fportal%20tls%2Froot.pem&options=-c%20statement_timeout%3D5000"*) ;; *) exit 91 ;; esac',
      '[ -z "${DATABASE_URL:-}" ] || exit 92',
      '[ -z "${PGDATABASE:-}" ] || exit 97',
      '[ -n "${PGPASSFILE:-}" ] && [ -r "${PGPASSFILE}" ] || exit 93',
      '[ "$(stat -Lc %a "${PGPASSFILE}")" = "600" ] || exit 94',
      "grep -Fx 'fe80\\:\\:1%eth0:6543:test-db:test\\:owner:p@ss\\:word\\\\tail' \"${PGPASSFILE}\" >/dev/null || exit 95",
      "! env | grep '^PG' | grep -v '^PGPASSFILE=' >/dev/null || exit 96",
      'printf "%s\\n" "PGDMPBRIDGESLLM-TEST-V1"',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(
      path.join(portalRoot, 'backend', '.env.production'),
      'DATABASE_URL=postgresql://test%3Aowner:p%40ss%3Aword%5Ctail@[fe80::1%25eth0]:6543/test%2Ddb?schema=tenant&sslmode=verify-full&sslrootcert=%2Fetc%2Fportal%20tls%2Froot.pem&options=-c%20statement_timeout%3D5000\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(portalRoot, 'marker.txt'), 'portal data', { mode: 0o600 });
    const requiredSources = fixture.requiredSources;
    const lockedArchive = path.join(backupRoot, 'daily', 'portal-daily-20200101-000000.tar.gz');
    const oldUnlockedArchive = path.join(backupRoot, 'daily', 'portal-daily-20200102-000000.tar.gz');
    fs.writeFileSync(lockedArchive, 'locked archive', { mode: 0o600 });
    fs.writeFileSync(`${lockedArchive}.locked`, 'locked', { mode: 0o600 });
    fs.writeFileSync(oldUnlockedArchive, 'old archive', { mode: 0o600 });

    const runnerEnv = {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      PGPASSWORD: 'ambient-password-must-not-survive',
      PGSERVICE: 'ambient-service-must-not-survive',
      PORTAL_ROOT: portalRoot,
      BACKUP_STATE_DIR: stateDir,
      BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
      PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
      ...requiredSources,
      LEGACY_APP_FILES_DIR: path.join(testRoot, 'missing-legacy-apps'),
      RUNTIME_ROOT: path.join(testRoot, 'missing-runtime'),
      OPENCLAW_DIR: path.join(testRoot, 'missing-openclaw'),
      STALWART_DIR: path.join(testRoot, 'missing-stalwart'),
      STALWART_MAIL_DIR: path.join(testRoot, 'missing-stalwart-mail'),
      STALWART_INSTALL_DIR: path.join(testRoot, 'missing-stalwart-install'),
      SYSTEMD_DIR: path.join(testRoot, 'missing-systemd'),
      CADDY_CONF: path.join(testRoot, 'missing-Caddyfile'),
      DAILY_KEEP: '1',
      ...fixture.env,
    };
    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: runnerEnv,
      timeout: 30_000,
    });

    if (result.status !== 0) {
      throw new Error(`backup runner failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({
      type: 'daily',
      status: 'completed',
      exitCode: 0,
      phase: 'completed',
      phaseLabel: 'Backup completed',
      phaseIndex: 8,
      phaseTotal: 8,
    });
    expect(status.archivePath).toMatch(new RegExp(`^${backupRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/daily/portal-daily-`));
    expect(fs.statSync(status.archivePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(stateDir, 'current.log'), 'utf8').length).toBeLessThanOrEqual(65536);
    expect(fs.existsSync(path.join(backupRoot, 'daily'))).toBe(true);
    expect(fs.existsSync(lockedArchive)).toBe(true);
    expect(fs.existsSync(`${lockedArchive}.locked`)).toBe(true);
    expect(fs.existsSync(oldUnlockedArchive)).toBe(false);

    const recoveryManifest = JSON.parse(
      spawnSync('tar', ['-xOzf', status.archivePath, './RECOVERY-MANIFEST.json'], { encoding: 'utf8' }).stdout,
    );
    const components = new Map(recoveryManifest.components.map((entry: any) => [entry.id, entry]));
    for (const id of [
      'database',
      'portal-install',
      'portal-environment',
      'hosted-apps',
      'portal-files',
      'upload-storage',
      'projects',
      'portal-backend-state',
      'portal-state',
      'portal-assets',
    ]) {
      expect(components.get(id)).toMatchObject({ requirement: 'required', status: 'captured' });
    }
    expect(components.get('openclaw-state')).toMatchObject({
      requirement: 'optional',
      status: 'not-configured',
    });
    for (const id of ['stalwart-data', 'stalwart-mail-data', 'stalwart-install']) {
      expect(components.get(id)).toMatchObject({
        requirement: 'optional',
        status: 'not-configured',
      });
    }

    const verification = spawnSync('bash', [backupScript, '--verify'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: runnerEnv,
      timeout: 30_000,
    });
    expect(verification.status).toBe(0);
    expect(verification.stdout).toContain('  OK');
  }, 35_000);

  it('backs up an older supported server patch with the security-floor client toolchain', () => {
    const testRoot = makeTempRoot('backup-older-server-patch');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      postgresServerVersion: '16.13',
      stateDir,
    });

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
      },
      timeout: 30_000,
    });

    if (result.status !== 0) {
      throw new Error(`older-server backup failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ type: 'daily', status: 'completed', exitCode: 0 });
    const verification = spawnSync('bash', [backupScript, '--verify-archive', status.archivePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
      },
      timeout: 30_000,
    });
    expect(verification.status).toBe(0);
  }, 35_000);

  it('captures durable OpenClaw state without its reproducible npm runtime', () => {
    const testRoot = makeTempRoot('backup-openclaw-state');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const openclawRoot = path.join(testRoot, '.openclaw');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.mkdirSync(path.join(openclawRoot, 'state'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(openclawRoot, 'extensions', 'custom-plugin'), {
      recursive: true,
      mode: 0o700,
    });
    fs.mkdirSync(path.join(openclawRoot, 'npm', 'projects', 'managed-plugin'), {
      recursive: true,
      mode: 0o700,
    });
    const codexHome = path.join(openclawRoot, 'agents', 'main', 'agent', 'codex-home');
    for (const relative of ['.tmp', 'sessions', 'cache', 'shell_snapshots']) {
      fs.mkdirSync(path.join(codexHome, relative), { recursive: true, mode: 0o700 });
    }
    fs.mkdirSync(path.join(openclawRoot, 'logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(openclawRoot, 'openclaw.json'), '{"plugins":{}}\n', { mode: 0o600 });
    // Keep a committed row in an open WAL while the backup runs. Copying only
    // the live main file would miss it; SQLite's online backup must fold it
    // into the standalone snapshot stored in the archive.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const liveDatabasePath = path.join(openclawRoot, 'state', 'openclaw.sqlite');
    const liveDatabase = new DatabaseSync(liveDatabasePath);
    liveDatabase.prepare('PRAGMA journal_mode=WAL').get();
    liveDatabase.exec(`
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE durable_state (value TEXT NOT NULL);
      CREATE TABLE delivery_queue_entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
    liveDatabase.prepare('INSERT INTO durable_state (value) VALUES (?)').run('committed in wal');
    liveDatabase.prepare(
      'INSERT INTO delivery_queue_entries (id, payload) VALUES (?, ?)',
    ).run('stale-delivery', 'must not replay after restore');
    fs.chmodSync(liveDatabasePath, 0o600);
    expect(fs.existsSync(`${liveDatabasePath}-wal`)).toBe(true);
    fs.writeFileSync(
      path.join(openclawRoot, 'extensions', 'custom-plugin', 'index.js'),
      'export default {};\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(openclawRoot, 'npm', 'projects', 'managed-plugin', 'package.json'),
      '{"private":true}\n',
      { mode: 0o600 },
    );
    for (const [relative, contents] of [
      ['config.toml', 'model = "openai/gpt-5.6-sol"\n'],
      ['.tmp/plugin-cache', 'regenerable checkout\n'],
      ['sessions/rollout.jsonl', 'volatile rollout\n'],
      ['cache/models.json', 'regenerable cache\n'],
      ['shell_snapshots/command.sh', 'volatile shell snapshot\n'],
      ['models_cache.json', '{}\n'],
      ['state_5.sqlite', 'volatile codex state\n'],
      ['state_5.sqlite-wal', 'volatile codex state wal\n'],
      ['logs_2.sqlite', 'volatile codex logs\n'],
    ] as const) {
      fs.writeFileSync(path.join(codexHome, relative), contents, { mode: 0o600 });
    }
    const codexDatabaseFixtures = [
      ['memories_1.sqlite', 'durable memory committed in wal'],
      ['goals_1.sqlite', 'durable goal committed in wal'],
    ] as const;
    const liveCodexDatabases = codexDatabaseFixtures.map(([filename, value]) => {
      const databasePath = path.join(codexHome, filename);
      const database = new DatabaseSync(databasePath);
      database.prepare('PRAGMA journal_mode=WAL').get();
      database.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE durable_record (value TEXT NOT NULL);');
      database.prepare('INSERT INTO durable_record (value) VALUES (?)').run(value);
      fs.chmodSync(databasePath, 0o600);
      expect(fs.existsSync(`${databasePath}-wal`)).toBe(true);
      return database;
    });
    fs.writeFileSync(path.join(openclawRoot, 'logs', 'gateway.log'), 'operational log\n', { mode: 0o600 });

    let result;
    try {
      result = spawnSync('bash', [backupScript, 'daily'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...fixture.env,
          OPENCLAW_BACKUP_POLICY: 'required',
          OPENCLAW_DIR: openclawRoot,
        },
        timeout: 30_000,
      });
    } finally {
      liveDatabase.close();
      for (const database of liveCodexDatabases) database.close();
    }
    if (result.status !== 0) {
      throw new Error(`OpenClaw-state backup failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }

    const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
    const extractionRoot = path.join(testRoot, 'extracted');
    fs.mkdirSync(extractionRoot, { mode: 0o700 });
    const outerExtraction = spawnSync(
      'tar',
      ['-xzf', status.archivePath, '-C', extractionRoot, './openclaw-state.tar.gz'],
      { encoding: 'utf8' },
    );
    expect(outerExtraction.status).toBe(0);
    const listing = spawnSync(
      'tar',
      ['-tzf', path.join(extractionRoot, 'openclaw-state.tar.gz')],
      { encoding: 'utf8' },
    );
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain('.openclaw/state/openclaw.sqlite');
    expect(listing.stdout).not.toContain('.openclaw/state/openclaw.sqlite-wal');
    expect(listing.stdout).not.toContain('.openclaw/state/openclaw.sqlite-shm');
    expect(listing.stdout).toContain('.openclaw/extensions/custom-plugin/index.js');
    expect(listing.stdout).toContain('.openclaw/agents/main/agent/codex-home/config.toml');
    expect(listing.stdout).toContain('.openclaw/agents/main/agent/codex-home/memories_1.sqlite');
    expect(listing.stdout).toContain('.openclaw/agents/main/agent/codex-home/goals_1.sqlite');
    const listingMembers = new Set(listing.stdout.trim().split('\n'));
    for (const database of ['memories_1.sqlite', 'goals_1.sqlite']) {
      expect(listingMembers.has(`.openclaw/agents/main/agent/codex-home/${database}`)).toBe(true);
      expect(listingMembers.has(`.openclaw/agents/main/agent/codex-home/${database}-wal`)).toBe(false);
      expect(listingMembers.has(`.openclaw/agents/main/agent/codex-home/${database}-shm`)).toBe(false);
      expect(listingMembers.has(`.openclaw/agents/main/agent/codex-home/${database}-journal`)).toBe(false);
    }
    for (const excludedMember of [
      '.openclaw/agents/main/agent/codex-home/.tmp/plugin-cache',
      '.openclaw/agents/main/agent/codex-home/sessions/rollout.jsonl',
      '.openclaw/agents/main/agent/codex-home/cache/models.json',
      '.openclaw/agents/main/agent/codex-home/shell_snapshots/command.sh',
      '.openclaw/agents/main/agent/codex-home/models_cache.json',
      '.openclaw/agents/main/agent/codex-home/state_5.sqlite',
      '.openclaw/agents/main/agent/codex-home/state_5.sqlite-wal',
      '.openclaw/agents/main/agent/codex-home/logs_2.sqlite',
      '.openclaw/logs/gateway.log',
    ]) {
      expect(listing.stdout).not.toContain(excludedMember);
    }
    const npmMembers = listing.stdout
      .split('\n')
      .filter((member) => member.startsWith('.openclaw/npm'));
    expect(npmMembers).toEqual(['.openclaw/npm/']);

    const openclawExtractionRoot = path.join(testRoot, 'openclaw-extracted');
    fs.mkdirSync(openclawExtractionRoot, { mode: 0o700 });
    const sqliteExtraction = spawnSync(
      'tar',
      [
        '-xzf', path.join(extractionRoot, 'openclaw-state.tar.gz'),
        '-C', openclawExtractionRoot,
        '.openclaw/state/openclaw.sqlite',
        '.openclaw/agents/main/agent/codex-home/memories_1.sqlite',
        '.openclaw/agents/main/agent/codex-home/goals_1.sqlite',
      ],
      { encoding: 'utf8' },
    );
    expect(sqliteExtraction.status).toBe(0);
    const restoredDatabase = new DatabaseSync(
      path.join(openclawExtractionRoot, '.openclaw', 'state', 'openclaw.sqlite'),
      { readOnly: true },
    );
    try {
      expect(restoredDatabase.prepare('SELECT value FROM durable_state').get())
        .toEqual({ value: 'committed in wal' });
      expect(restoredDatabase.prepare('SELECT COUNT(*) AS count FROM delivery_queue_entries').get())
        .toEqual({ count: 0 });
      expect(restoredDatabase.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    } finally {
      restoredDatabase.close();
    }
    for (const [filename, value] of codexDatabaseFixtures) {
      const restoredCodexDatabase = new DatabaseSync(
        path.join(openclawExtractionRoot, '.openclaw', 'agents', 'main', 'agent', 'codex-home', filename),
        { readOnly: true },
      );
      try {
        expect(restoredCodexDatabase.prepare('SELECT value FROM durable_record').get()).toEqual({ value });
        expect(restoredCodexDatabase.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      } finally {
        restoredCodexDatabase.close();
      }
    }

    const recoveryManifest = JSON.parse(
      spawnSync('tar', ['-xOzf', status.archivePath, './RECOVERY-MANIFEST.json'], { encoding: 'utf8' }).stdout,
    );
    const openclawComponent = recoveryManifest.components.find((entry: any) => entry.id === 'openclaw-state');
    expect(openclawComponent).toMatchObject({ requirement: 'required', status: 'captured' });
  }, 35_000);

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a %s SQLite sidecar before opening the live OpenClaw database',
    (sidecarType) => {
      const testRoot = makeTempRoot(`backup-openclaw-${sidecarType}-sidecar`);
      const portalRoot = path.join(testRoot, 'portal');
      const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
      const backupRoot = path.join(testRoot, 'configured-backups');
      const openclawRoot = path.join(testRoot, '.openclaw');
      const openclawState = path.join(openclawRoot, 'state');
      const fixture = createBackupRunnerFixture(testRoot, {
        backupRoot,
        portalRoot,
        stateDir,
      });
      fs.mkdirSync(openclawState, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(openclawRoot, 'openclaw.json'), '{}\n', { mode: 0o600 });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      const databasePath = path.join(openclawState, 'openclaw.sqlite');
      const database = new DatabaseSync(databasePath);
      database.exec('CREATE TABLE durable_state (value TEXT NOT NULL);');
      database.close();
      fs.chmodSync(databasePath, 0o600);
      const outside = path.join(testRoot, `${sidecarType}-outside`);
      fs.writeFileSync(outside, 'not a trusted SQLite sidecar', { mode: 0o600 });
      const sidecar = `${databasePath}-${sidecarType === 'symlink' ? 'shm' : 'wal'}`;
      if (sidecarType === 'symlink') fs.symlinkSync(outside, sidecar);
      else fs.linkSync(outside, sidecar);

      const result = spawnSync('bash', [backupScript, 'daily'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...fixture.env,
          OPENCLAW_BACKUP_POLICY: 'required',
          OPENCLAW_DIR: openclawRoot,
        },
        timeout: 30_000,
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'Required recovery source or SQLite snapshot could not be archived',
      );
    },
    40_000,
  );

  it('keeps backup database credentials anonymous and kills pg_dump with its parent', async () => {
    const testRoot = makeTempRoot('backup-pgpass-sigkill');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const pgDumpPidFile = path.join(testRoot, 'pg-dump.pid');
    const pgpassPathFile = path.join(testRoot, 'pgpass.path');
    const databasePassword = 'sigkill-residue-secret';
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      databaseUrl: `postgresql://portal:${databasePassword}@127.0.0.1:5432/portal`,
      portalRoot,
      stateDir,
    });
    const fakeBin = fixture.commandsRoot;
    fs.writeFileSync(
      path.join(stateDir, 'backup-base-path'),
      `${backupRoot}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(fakeBin, 'docker'), '#!/bin/sh\nexit 1\n', {
      mode: 0o700,
    });
    fs.writeFileSync(path.join(fakeBin, 'pg_dump'), [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf "%s\\n" "pg_dump (PostgreSQL) 16.14"; exit 0; fi',
      `printf "%s\\n" "$$" > '${pgDumpPidFile}'`,
      `printf "%s\\n" "$PGPASSFILE" > '${pgpassPathFile}'`,
      '[ -n "$PGPASSFILE" ] && [ -r "$PGPASSFILE" ] || exit 91',
      `grep -F '${databasePassword}' "$PGPASSFILE" >/dev/null || exit 92`,
      "trap '' TERM HUP INT",
      'while :; do :; done',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(
      path.join(portalRoot, 'backend', '.env.production'),
      `DATABASE_URL=postgresql://portal:${databasePassword}@127.0.0.1:5432/portal\n`,
      { mode: 0o600 },
    );
    const requiredSources = fixture.requiredSources;
    const existingStaging = new Set(
      fs.readdirSync('/tmp').filter((name) => name.startsWith('bridgesllm-backup-daily-')),
    );
    const backup = spawn('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...requiredSources,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        BACKUP_TEST_DUMP_PID_FILE: pgDumpPidFile,
        BACKUP_TEST_PGPASS_PATH_FILE: pgpassPathFile,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
        LEGACY_APP_FILES_DIR: path.join(testRoot, 'missing-legacy-apps'),
        RUNTIME_ROOT: path.join(testRoot, 'missing-runtime'),
        OPENCLAW_DIR: path.join(testRoot, 'missing-openclaw'),
        STALWART_DIR: path.join(testRoot, 'missing-stalwart'),
        STALWART_MAIL_DIR: path.join(testRoot, 'missing-stalwart-mail'),
        STALWART_INSTALL_DIR: path.join(testRoot, 'missing-stalwart-install'),
        SYSTEMD_DIR: path.join(testRoot, 'missing-systemd'),
        CADDY_CONF: path.join(testRoot, 'missing-Caddyfile'),
        ...fixture.env,
      },
    });
    let pgDumpPid = 0;
    let newStaging: string[] = [];
    try {
      await waitUntil(() => fs.existsSync(pgDumpPidFile));
      pgDumpPid = Number.parseInt(fs.readFileSync(pgDumpPidFile, 'utf8'), 10);
      expect(Number.isSafeInteger(pgDumpPid) && pgDumpPid > 1).toBe(true);
      await waitUntil(() => fs.existsSync(pgpassPathFile));
      const pgpassPath = fs.readFileSync(pgpassPathFile, 'utf8').trim();
      expect(pgpassPath).toMatch(/^\/proc\/self\/fd\/[0-9]+$/u);
      const inheritedPath = pgpassPath.replace('/proc/self/', `/proc/${pgDumpPid}/`);
      expect(fs.readlinkSync(inheritedPath)).toContain('memfd:bridgesllm-backup-pgpass');

      backup.kill('SIGKILL');
      // A minimal test-container PID 1 may not reap an orphaned child. A
      // zombie has already been killed and cannot retain the anonymous memfd;
      // production systemd reaps it immediately.
      await waitUntil(() => processIsGoneOrZombie(pgDumpPid));
      newStaging = fs.readdirSync('/tmp')
        .filter((name) => (
          name.startsWith('bridgesllm-backup-daily-')
          && !existingStaging.has(name)
        ))
        .map((name) => path.join('/tmp', name));
      expect(newStaging.length).toBeGreaterThan(0);
      for (const staging of newStaging) {
        const namedCredential = spawnSync(
          'find',
          [staging, '-type', 'f', '-name', '*.pgpass', '-print', '-quit'],
          { encoding: 'utf8' },
        );
        expect(namedCredential.stdout.trim()).toBe('');
      }
    } finally {
      if (backup.exitCode === null && backup.signalCode === null) {
        backup.kill('SIGKILL');
      }
      if (pgDumpPid > 1 && fs.existsSync(`/proc/${pgDumpPid}`)) {
        try {
          process.kill(pgDumpPid, 'SIGKILL');
        } catch {
          // The parent-death contract may win this race.
        }
      }
      for (const staging of newStaging) {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it('rejects query-string credential overrides before pg_dump can observe them', () => {
    const testRoot = makeTempRoot('backup-query-credential');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const pgDumpCalled = path.join(testRoot, 'pg-dump-called');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      databaseUrl: 'postgresql://portal:userinfo-secret@db.example.test/portal?sslmode=require&pass%77ord=query-secret',
      portalRoot,
      stateDir,
    });
    const fakeBin = fixture.commandsRoot;
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(portalRoot, 'backend', '.env.production'), [
      'DATABASE_URL=postgresql://portal:userinfo-secret@db.example.test/portal?sslmode=require&pass%77ord=query-secret',
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(fakeBin, 'pg_dump'), [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf "%s\\n" "pg_dump (PostgreSQL) 16.14"; exit 0; fi',
      ': > "$BACKUP_TEST_DUMP_CALLED"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        BACKUP_TEST_DUMP_CALLED: pgDumpCalled,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
        ...fixture.env,
      },
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(pgDumpCalled)).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'PostgreSQL server major or client security floor admission failed',
    );
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))).toMatchObject({
      type: 'daily',
      status: 'failed',
    });
    expect(fs.readdirSync(path.join(backupRoot, 'daily')).filter((name) => name.endsWith('.tar.gz'))).toEqual([]);
  });

  it('fails closed when a required recovery source is missing', () => {
    const testRoot = makeTempRoot('backup-missing-source');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    const requiredSources = fixture.requiredSources;
    fs.rmSync(requiredSources.APPS_ROOT, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(portalRoot, 'backend', '.env.production'), [
      'DATABASE_URL=postgresql://test:test@127.0.0.1/test',
      'INSTALL_PROFILE=custom',
      '',
    ].join('\n'), { mode: 0o600 });

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...requiredSources,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
        OPENCLAW_DIR: path.join(testRoot, 'missing-openclaw'),
        STALWART_DIR: path.join(testRoot, 'missing-stalwart'),
        STALWART_MAIL_DIR: path.join(testRoot, 'missing-stalwart-mail'),
        STALWART_INSTALL_DIR: path.join(testRoot, 'missing-stalwart-install'),
        SYSTEMD_DIR: path.join(testRoot, 'missing-systemd'),
        ...fixture.env,
      },
      timeout: 30_000,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Required recovery source is missing');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))).toMatchObject({
      type: 'daily',
      status: 'failed',
      phase: 'portal-data',
      phaseLabel: 'Archiving Portal data',
      phaseIndex: 3,
      phaseTotal: 8,
      failureDetail: expect.stringContaining('Required recovery source is missing'),
    });
    expect(fs.readdirSync(path.join(backupRoot, 'daily')).filter((name) => name.endsWith('.tar.gz'))).toEqual([]);
  });

  it('rejects an archive whose payload no longer matches its manifest', () => {
    const testRoot = makeTempRoot('backup-tamper');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const staging = path.join(testRoot, 'staging');
    const dailyDir = path.join(backupRoot, 'daily');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'database.sql'), '-- database\n', { mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'files.tar.gz'), 'original payload', { mode: 0o600 });

    const checksum = (file: string) => spawnSync('sha256sum', [file], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
    fs.writeFileSync(path.join(staging, 'MANIFEST.txt'), [
      'BridgesLLM Portal Backup',
      'Checksums:',
      `${checksum(path.join(staging, 'database.sql'))}  ./database.sql`,
      `${checksum(path.join(staging, 'files.tar.gz'))}  ./files.tar.gz`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'files.tar.gz'), 'tampered payload', { mode: 0o600 });
    const archive = path.join(dailyDir, 'portal-daily-20260719-120000.tar.gz');
    expect(spawnSync('tar', ['czf', archive, '-C', staging, '.']).status).toBe(0);

    const verification = spawnSync('bash', [backupScript, '--verify'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
      },
      timeout: 30_000,
    });
    expect(verification.status).not.toBe(0);
    expect(verification.stdout).toContain('manifest checksum validation failed');
  });

  it('rejects archive link members before extracting them for verification', () => {
    const testRoot = makeTempRoot('backup-link-member');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const staging = path.join(testRoot, 'staging');
    const dailyDir = path.join(backupRoot, 'daily');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'database.sql'), '-- database\n', { mode: 0o600 });
    const databaseHash = spawnSync('sha256sum', [path.join(staging, 'database.sql')], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
    fs.writeFileSync(path.join(staging, 'MANIFEST.txt'), [
      'BridgesLLM Portal Backup',
      'Checksums:',
      `${databaseHash}  ./database.sql`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.symlinkSync('/etc/passwd', path.join(staging, 'escape-link'));
    const archive = path.join(dailyDir, 'portal-daily-20260719-120001.tar.gz');
    expect(spawnSync('tar', ['czf', archive, '-C', staging, '.']).status).toBe(0);

    const verification = spawnSync('bash', [backupScript, '--verify'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
      },
      timeout: 30_000,
    });
    expect(verification.status).not.toBe(0);
    expect(verification.stdout).toContain('manifest checksum validation failed');
  });

  it('fails closed when another backup holds the global lock without replacing state', () => {
    const testRoot = makeTempRoot('backup-lock');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    const originalState = '{"id":"existing","type":"daily","status":"running","startedAt":"2026-07-18T12:00:00Z","pid":2}\n';
    fs.writeFileSync(path.join(stateDir, 'status.json'), originalState, { mode: 0o600 });

    const holder = spawnSync('flock', [path.join(stateDir, 'backup.lock'), 'bash', backupScript, 'comprehensive'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
      },
      timeout: 5_000,
    });

    expect(holder.status).toBe(75);
    expect(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8')).toBe(originalState);
  });

  it('does not start a backup while install, update, or uninstall owns the host operation lock', () => {
    const testRoot = makeTempRoot('backup-operation-lock');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const operationLock = path.join(testRoot, 'portal-operation.lock');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    const originalState = '{"id":"existing","type":"daily","status":"completed","startedAt":"2026-07-18T12:00:00Z"}\n';
    fs.writeFileSync(path.join(stateDir, 'status.json'), originalState, { mode: 0o600 });

    const holder = spawnSync('flock', [operationLock, 'bash', backupScript, 'comprehensive'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: operationLock,
      },
      timeout: 5_000,
    });

    expect(holder.status).toBe(75);
    expect(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8')).toBe(originalState);
  });

  it('rejects a symbolic-link host operation lock without touching its target or backup state', () => {
    const testRoot = makeTempRoot('backup-operation-lock-symlink');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const operationLock = path.join(testRoot, 'portal-operation.lock');
    const sentinel = path.join(testRoot, 'sentinel');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    const originalState = '{"id":"existing","type":"daily","status":"completed","startedAt":"2026-07-18T12:00:00Z"}\n';
    fs.writeFileSync(path.join(stateDir, 'status.json'), originalState, { mode: 0o600 });
    fs.writeFileSync(sentinel, 'do-not-touch\n', { mode: 0o600 });
    fs.symlinkSync(sentinel, operationLock);

    const result = spawnSync('bash', [backupScript, 'comprehensive'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: operationLock,
      },
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do-not-touch\n');
    expect(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8')).toBe(originalState);
  });

  it('does not publish a successful archive when the database cannot be dumped', () => {
    const testRoot = makeTempRoot('backup-database');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(
      fixture.commands.pgDump,
      '#!/bin/sh\n'
        + 'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n'
        + '  printf "%s\\n" "pg_dump (PostgreSQL) 16.14"\n'
        + '  exit 0\n'
        + 'fi\n'
        + 'exit 1\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(fixture.commands.docker, '#!/bin/sh\nexit 1\n', { mode: 0o700 });

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
      },
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))).toMatchObject({
      type: 'daily',
      status: 'failed',
    });
    expect(fs.readdirSync(path.join(backupRoot, 'daily')).filter((name) => name.endsWith('.tar.gz'))).toEqual([]);
  });

  it('archives Portal Files when an upload is hard linked outside the component', () => {
    const testRoot = makeTempRoot('backup-external-hardlink');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(fixture.commands.docker, '#!/bin/sh\nexit 1\n', { mode: 0o700 });

    // OpenClaw hard links its media directory to Portal Files uploads, so the
    // inode is reachable from a tree that is not part of this component and the
    // link count exceeds the links found inside portal-files.
    const uploads = path.join(fixture.requiredSources.PORTAL_FILES_DIR, 'user-1', 'uploads');
    fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
    const upload = path.join(uploads, 'shared-media.bin');
    fs.writeFileSync(upload, 'shared payload', { mode: 0o600 });
    const externalRoot = path.join(testRoot, 'openclaw-media');
    fs.mkdirSync(externalRoot, { recursive: true, mode: 0o700 });
    fs.linkSync(upload, path.join(externalRoot, 'shared-media.bin'));
    expect(fs.statSync(upload).nlink).toBe(2);

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
      },
      timeout: 60_000,
    });

    if (result.status !== 0) {
      throw new Error(
        `backup runner failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))).toMatchObject({
      type: 'daily',
      status: 'completed',
      exitCode: 0,
    });
  });

  it('refuses a comprehensive backup without stopping anything when the database peer connection fails', () => {
    const testRoot = makeTempRoot('backup-peer-admission');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const systemctlLog = path.join(testRoot, 'systemctl-calls.log');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });

    // Record every unit action so the assertion can prove the refusal came
    // before quiescence rather than after it.
    fs.writeFileSync(
      fixture.commands.systemctl,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> '
        + `'${systemctlLog}'\n`
        + 'exit 1\n',
      { mode: 0o700 },
    );

    // Deriving the peer authority still succeeds; only opening the peer
    // connection fails. That is the case a derive-only admission cannot see,
    // and it is what a TCP-only database (a container, or a remote server)
    // looks like once every derived value checks out.
    const psqlSource = fs.readFileSync(fixture.commands.psql, 'utf8');
    fs.writeFileSync(
      fixture.commands.psql,
      psqlSource.replace(
        'if command is not None:',
        'if command is not None:\n'
          + '    if command.strip() == "SELECT 1":\n'
          + '        sys.stderr.write("psql: error: connection to server on socket failed\\n")\n'
          + '        raise SystemExit(2)',
      ),
      { mode: 0o700 },
    );

    const result = spawnSync('bash', [backupScript, 'comprehensive'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
        PORTAL_OPERATION_LOCK_FILE: path.join(testRoot, 'portal-operation.lock'),
      },
      timeout: 30_000,
    });

    expect(result.status).not.toBe(0);
    // The refusal has to name the cause and promise the host was left alone.
    expect(`${result.stdout}${result.stderr}`).toContain('No services were stopped');
    // Nothing may have been stopped for an archive that could never be taken.
    const unitActions = fs.existsSync(systemctlLog)
      ? fs.readFileSync(systemctlLog, 'utf8')
      : '';
    expect(unitActions).not.toMatch(/\bstop\b/u);
    expect(fs.readdirSync(path.join(backupRoot, 'comprehensive'))
      .filter((name) => name.endsWith('.tar.gz'))).toEqual([]);
  });

  it('never falls back to a legacy container after a configured database dump fails', () => {
    const testRoot = makeTempRoot('backup-custom-database');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const dockerCalled = path.join(testRoot, 'docker-called');
    const fixture = createBackupRunnerFixture(testRoot, {
      backupRoot,
      portalRoot,
      stateDir,
    });
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(portalRoot, 'backend', '.env.production'), [
      'DATABASE_URL=postgresql://custom:encoded%40password@db.example:6543/portal?sslmode=require&schema=public',
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(
      fixture.commands.pgDump,
      '#!/bin/sh\n'
        + 'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n'
        + '  printf "%s\\n" "pg_dump (PostgreSQL) 16.14"\n'
        + '  exit 0\n'
        + 'fi\n'
        + 'exit 42\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      fixture.commands.docker,
      '#!/bin/sh\n: > "$DOCKER_CALLED"\nexit 0\n',
      { mode: 0o700 },
    );

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        DOCKER_CALLED: dockerCalled,
        PORTAL_ROOT: portalRoot,
        BACKUP_STATE_DIR: stateDir,
        BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
      },
      timeout: 30_000,
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(dockerCalled)).toBe(false);
    expect(fs.readdirSync(path.join(backupRoot, 'daily')).filter((name) => name.endsWith('.tar.gz'))).toEqual([]);
  });
});

describe('systemd schedule parsing', () => {
  it('extracts the effective OnCalendar expression and runtime fields', () => {
    const properties = parseSystemctlProperties([
      'TimersCalendar={ OnCalendar=Sun *-*-* 03:00:00 ; next_elapse=Sun 2026-07-19 03:00:00 EDT }',
      'NextElapseUSecRealtime=Sun 2026-07-19 03:00:00 EDT',
      'LastTriggerUSec=n/a',
      'ActiveState=active',
    ].join('\n'));
    expect(parseOnCalendar(properties.TimersCalendar)).toBe('Sun *-*-* 03:00:00');
    expect(properties.NextElapseUSecRealtime).toContain('2026-07-19');
  });

  it('keeps the installer service, state file, configured root, and timers on one contract', () => {
    const installer = fs.readFileSync(path.join(repositoryRoot, 'installer', 'install.sh'), 'utf8');
    expect(installer).toContain('Environment=BACKUP_CONFIG_FILE=${backup_config_file}');
    expect(installer).toContain('Environment=BACKUP_STATE_DIR=${backup_state_dir}');
    expect(installer).not.toContain('Environment=BACKUP_BASE=/root/backups');
    expect(installer).toContain('TimeoutStartSec=6h');
    expect(installer).toContain('OnCalendar=*-*-* 02:00:00');
    expect(installer).toContain('OnCalendar=Sun *-*-* 03:00:00');
    expect(installer).toContain('OnCalendar=*-*-01 04:00:00');
  });
});
