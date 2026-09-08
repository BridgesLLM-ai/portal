import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import {
  ensureBackupLayout,
  backupReceiptSigningPayload,
  deleteBackupFile,
  findBackupFile,
  listBackupFiles,
  normalizeBackupRoot,
  parseBackupStatus,
  parseOnCalendar,
  parseSystemctlProperties,
} from '../services/backup.service';
import { buildBackupListResponse } from '../routes/backups';
import {
  createAttestedBackupRoot,
  createBackupRunnerFixture,
} from './backupRunnerFixture';

jest.mock('../config/database', () => ({
  prisma: {
    activityLog: { create: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

const repositoryRoot = path.resolve(__dirname, '../../..');
const backupScript = process.env.BACKUP_SCRIPT_UNDER_TEST
  || path.join(repositoryRoot, 'backup-full.sh');
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
      consecutiveFailures: 2,
      failureCode: 'BACKUP_DATABASE_FENCE_FAILED',
      failureDetail: 'Database fence was lost before the snapshot completed',
    };
    expect(parseBackupStatus(JSON.stringify(status))).toMatchObject(status);
    expect(parseBackupStatus(JSON.stringify({
      ...status,
      status: 'degraded',
      completedAt: '2026-08-04T12:10:00.000Z',
      archivePath: '/root/backups/degraded/comprehensive/portal-comprehensive-test.tar.gz',
    }))).toMatchObject({ status: 'degraded', consecutiveFailures: 2 });
    expect(parseBackupStatus(JSON.stringify({ ...status, phaseIndex: 13 }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, phaseLabel: 'unsafe\u0000detail' }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, failureCode: 'backup_private_detail' }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, failureCode: `BACKUP_${'X'.repeat(57)}` }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, failureDetail: '🧰'.repeat(250) }))).not.toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, failureDetail: '🧰'.repeat(251) }))).toBeNull();
    expect(parseBackupStatus(JSON.stringify({ ...status, consecutiveFailures: -1 }))).toBeNull();
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
    expect(files[0]).toMatchObject({
      filename: path.basename(archive),
      type: 'daily',
      locked: true,
      size: 7,
      completeness: 'unknown',
      classificationAuthenticated: false,
    });
    expect(findBackupFile(root, '../portal-daily-20260718-120000.tar.gz')).toBeNull();
  });

  it('authenticates complete and degraded receipts and deletes receipt before archive', () => {
    const fixtureRoot = makeTempRoot('backup-receipt');
    const root = ensureBackupLayout(path.join(fixtureRoot, 'backups'));
    const trustRoot = path.join(fixtureRoot, 'backup-trust');
    fs.mkdirSync(trustRoot, { mode: 0o700 });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(trustRoot, 'archive-hmac.key'), key, { mode: 0o600 });
    const previousTrustRoot = process.env.BRIDGESLLM_BACKUP_TRUST_ROOT;
    process.env.BRIDGESLLM_BACKUP_TRUST_ROOT = trustRoot;

    const writeReceipt = (
      archive: string,
      backupType: 'daily',
      completeness: 'complete' | 'degraded',
      degradedComponents: string[],
    ) => {
      const stat = fs.lstatSync(archive, { bigint: true });
      const input = {
        archive: path.basename(archive),
        backupType,
        completeness,
        archiveSize: Number(stat.size),
        archiveMtimeNs: String(stat.mtimeNs),
        manifestHmac: 'a'.repeat(64),
        degradedComponents,
      };
      fs.writeFileSync(`${archive}.receipt.json`, `${JSON.stringify({
        schema: 'bridgesllm.backup-publication.v1',
        ...input,
        signature: crypto.createHmac('sha256', key)
          .update(backupReceiptSigningPayload(input))
          .digest('hex'),
      })}\n`, { mode: 0o600 });
    };

    try {
      const complete = path.join(root, 'daily', 'portal-daily-20260718-120000.tar.gz');
      const degraded = path.join(root, 'degraded', 'daily', 'portal-daily-20260718-130000.tar.gz');
      fs.writeFileSync(complete, 'complete archive', { mode: 0o600 });
      fs.writeFileSync(degraded, 'degraded archive', { mode: 0o600 });
      writeReceipt(complete, 'daily', 'complete', []);
      writeReceipt(degraded, 'daily', 'degraded', ['projects']);

      const files = listBackupFiles(root);
      expect(files.find((entry) => entry.fullPath === complete)).toMatchObject({
        completeness: 'complete',
        degradedComponents: [],
        classificationAuthenticated: true,
      });
      expect(files.find((entry) => entry.fullPath === degraded)).toMatchObject({
        completeness: 'degraded',
        degradedComponents: ['projects'],
        classificationAuthenticated: true,
      });
      const apiResponse = buildBackupListResponse(root, [...files]);
      expect(apiResponse.summary).toMatchObject({ complete: 1, degraded: 1, unknown: 0 });
      expect(apiResponse.backups).toEqual(expect.arrayContaining([
        expect.objectContaining({
          filename: path.basename(complete),
          completeness: 'complete',
          classificationAuthenticated: true,
        }),
        expect.objectContaining({
          filename: path.basename(degraded),
          completeness: 'degraded',
          degradedComponents: ['projects'],
          classificationAuthenticated: true,
        }),
      ]));
      expect(JSON.stringify(apiResponse.backups)).not.toContain(root);

      const degradedFile = files.find((entry) => entry.fullPath === degraded)!;
      deleteBackupFile(degradedFile);
      expect(fs.existsSync(degraded)).toBe(false);
      expect(fs.existsSync(`${degraded}.receipt.json`)).toBe(false);

      const completeReceipt = JSON.parse(fs.readFileSync(`${complete}.receipt.json`, 'utf8'));
      completeReceipt.signature = '0'.repeat(64);
      fs.writeFileSync(`${complete}.receipt.json`, `${JSON.stringify(completeReceipt)}\n`, { mode: 0o600 });
      expect(listBackupFiles(root).find((entry) => entry.fullPath === complete)).toMatchObject({
        completeness: 'unknown',
        classificationAuthenticated: false,
      });
      expect(buildBackupListResponse(root, listBackupFiles(root)).summary)
        .toMatchObject({ complete: 0, degraded: 0, unknown: 1 });
    } finally {
      if (previousTrustRoot === undefined) delete process.env.BRIDGESLLM_BACKUP_TRUST_ROOT;
      else process.env.BRIDGESLLM_BACKUP_TRUST_ROOT = previousTrustRoot;
    }
  });

  it('refuses hardlinked deletion targets and revalidates after receipt-first removal', () => {
    const root = ensureBackupLayout(path.join(makeTempRoot('backup-delete-race'), 'backups'));
    const archive = path.join(root, 'daily', 'portal-daily-20260718-140000.tar.gz');
    const receipt = `${archive}.receipt.json`;
    fs.writeFileSync(archive, 'original archive', { mode: 0o600 });
    fs.writeFileSync(receipt, '{}\n', { mode: 0o600 });
    const listed = listBackupFiles(root)[0];
    expect(listed).toBeDefined();

    const receiptAlias = path.join(root, 'daily', 'receipt-hardlink');
    fs.linkSync(receipt, receiptAlias);
    expect(() => deleteBackupFile(listed)).toThrow(/receipt is unsafe/i);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(receipt)).toBe(true);
    fs.unlinkSync(receiptAlias);

    const archiveAlias = path.join(root, 'daily', 'archive-hardlink');
    fs.linkSync(archive, archiveAlias);
    expect(() => deleteBackupFile(listed)).toThrow(/changed before deletion/i);
    expect(fs.existsSync(receipt)).toBe(true);
    fs.unlinkSync(archiveAlias);

    const replacement = path.join(root, 'daily', 'replacement.tmp');
    fs.writeFileSync(replacement, 'replacement archive', { mode: 0o600 });
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
      realUnlink(target);
      if (String(target) === receipt) fs.renameSync(replacement, archive);
    }) as typeof fs.unlinkSync);
    try {
      expect(() => deleteBackupFile(listed)).toThrow(/changed while deletion was prepared/i);
    } finally {
      unlink.mockRestore();
    }
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.readFileSync(archive, 'utf8')).toBe('replacement archive');
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
      timeout: 120_000,
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
    fs.writeFileSync(path.join(portalRoot, 'marker.txt'), 'portal data', { mode: 0o600 });
    const requiredSources = fixture.requiredSources;
    const venvBin = path.join(requiredSources.PROJECTS_ROOT, 'python-demo', '.venv', 'bin');
    fs.mkdirSync(venvBin, { recursive: true, mode: 0o700 });
    fs.symlinkSync('/usr/bin/python3', path.join(venvBin, 'python3'));
    fs.symlinkSync('python3', path.join(venvBin, 'python'));
    const lockedArchive = path.join(backupRoot, 'daily', 'portal-daily-20200101-000000.tar.gz');
    const oldUnlockedArchive = path.join(backupRoot, 'daily', 'portal-daily-20200102-000000.tar.gz');
    fs.writeFileSync(lockedArchive, 'locked archive', { mode: 0o600 });
    fs.writeFileSync(`${lockedArchive}.locked`, 'locked', { mode: 0o600 });
    fs.writeFileSync(oldUnlockedArchive, 'old archive', { mode: 0o600 });
    const orphanReceipt = path.join(
      backupRoot,
      'daily',
      'portal-daily-20200103-000000.tar.gz.receipt.json',
    );
    fs.writeFileSync(orphanReceipt, '{}\n', { mode: 0o600 });

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
      timeout: 120_000,
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
      phaseIndex: 11,
      phaseTotal: 11,
    });
    expect(status.archivePath).toMatch(new RegExp(`^${backupRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/daily/portal-daily-`));
    expect(fs.statSync(status.archivePath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${status.archivePath}.receipt.json`)).toBe(true);
    expect(fs.readFileSync(path.join(stateDir, 'current.log'), 'utf8').length).toBeLessThanOrEqual(65536);
    expect(fs.existsSync(path.join(backupRoot, 'daily'))).toBe(true);
    expect(fs.existsSync(lockedArchive)).toBe(true);
    expect(fs.existsSync(`${lockedArchive}.locked`)).toBe(true);
    expect(fs.existsSync(oldUnlockedArchive)).toBe(false);
    expect(fs.existsSync(orphanReceipt)).toBe(false);

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
    expect(recoveryManifest.schema).toBe('bridgesllm.portal-recovery.v3');
    expect(components.has('openclaw-state')).toBe(false);
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
      timeout: 120_000,
    });
    expect(verification.status).toBe(0);
    expect(verification.stdout).toContain('  OK');
  }, 150_000);

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
      timeout: 120_000,
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
      timeout: 120_000,
    });
    expect(verification.status).toBe(0);
  }, 150_000);

  it('excludes all OpenClaw state even when its database and sidecars are unsafe', () => {
    const testRoot = makeTempRoot('backup-openclaw-excluded');
    const fixture = createBackupRunnerFixture(testRoot);
    const openclawRoot = path.join(testRoot, '.openclaw');
    fs.mkdirSync(path.join(openclawRoot, 'state'), { recursive: true, mode: 0o700 });
    const database = path.join(openclawRoot, 'state', 'openclaw.sqlite');
    fs.writeFileSync(database, 'not a SQLite database', { mode: 0o600 });
    fs.symlinkSync('/nonexistent-private-state', `${database}-wal`);
    fs.writeFileSync(path.join(openclawRoot, 'openclaw.json'), '{"sentinel":"must-stay-private"}');
    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, ...fixture.env, OPENCLAW_DIR: openclawRoot },
    });
    if (result.status !== 0) throw new Error(`Portal-only backup failed: ${result.stdout}\n${result.stderr}`);
    const status = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'status.json'), 'utf8'));
    expect(status.status).toBe('completed');
    const manifest = JSON.parse(spawnSync('tar', ['-xOzf', status.archivePath, './RECOVERY-MANIFEST.json'], { encoding: 'utf8' }).stdout);
    expect(manifest.schema).toBe('bridgesllm.portal-recovery.v3');
    expect(manifest.components.some((entry: any) => entry.id === 'openclaw-state')).toBe(false);
    expect(spawnSync('tar', ['-tzf', status.archivePath], { encoding: 'utf8' }).stdout).not.toMatch(/openclaw/i);
    expect(fs.readFileSync(database, 'utf8')).toBe('not a SQLite database');
    expect(fs.readlinkSync(`${database}-wal`)).toBe('/nonexistent-private-state');
  }, 150_000);

  it('keeps peer-fenced dumps credential-free and kills pg_dump with its parent', async () => {
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
    fs.writeFileSync(path.join(fakeBin, 'pg_dump'), [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf "%s\\n" "pg_dump (PostgreSQL) 16.14"; exit 0; fi',
      `python3 -c 'from pathlib import Path; print(next(x.split()[1] for x in Path("/proc/self/status").read_text().splitlines() if x.startswith("PPid:")))' > '${pgDumpPidFile}'`,
      `printf "%s\\n" "$PGPASSFILE" > '${pgpassPathFile}'`,
      '[ -z "${PGPASSFILE:-}" ] && [ -z "${PGPASSWORD:-}" ] || exit 91',
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
    const existingHostTmpStaging = new Set(
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
    let backupStdout = '';
    let backupStderr = '';
    backup.stdout?.on('data', (chunk) => { backupStdout += String(chunk); });
    backup.stderr?.on('data', (chunk) => { backupStderr += String(chunk); });
    let pgDumpPid = 0;
    let pgDumpStart: string | undefined;
    let newStaging: string[] = [];
    try {
      try {
        await waitUntil(() => fs.existsSync(pgDumpPidFile)
          && /^\d+\s*$/u.test(fs.readFileSync(pgDumpPidFile, 'utf8')), 90_000);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}`
          + `\nbackup stdout:\n${backupStdout}\nbackup stderr:\n${backupStderr}`,
        );
      }
      pgDumpPid = Number.parseInt(fs.readFileSync(pgDumpPidFile, 'utf8'), 10);
      expect(Number.isSafeInteger(pgDumpPid) && pgDumpPid > 1).toBe(true);
      let ancestor = pgDumpPid;
      for (let depth = 0; depth < 64 && ancestor > 1 && ancestor !== backup.pid; depth += 1) {
        const fields = fs.readFileSync(`/proc/${ancestor}/stat`, 'utf8').split(') ')[1].split(' ');
        ancestor = Number(fields[1]);
      }
      expect(ancestor).toBe(backup.pid);
      pgDumpStart = fs.readFileSync(`/proc/${pgDumpPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
      await waitUntil(() => fs.existsSync(pgpassPathFile));
      const pgpassPath = fs.readFileSync(pgpassPathFile, 'utf8').trim();
      expect(pgpassPath).toBe('');

      backup.kill('SIGKILL');
      // A minimal test-container PID 1 may not reap an orphaned child. A
      // zombie has already been killed and cannot retain the anonymous memfd;
      // production systemd reaps it immediately.
      await waitUntil(() => processIsGoneOrZombie(pgDumpPid));
      const workRoot = path.join(backupRoot, '.bridgesllm-work-v1');
      newStaging = fs.readdirSync(workRoot)
        .filter((name) => name.startsWith('create-daily-'))
        .map((name) => path.join(workRoot, name));
      // Namespace teardown may remove image-backed staging. Check all named
      // host-visible scratch without requiring private staging to survive.
      const credentialResidue = spawnSync('find',
        [workRoot, '-type', 'f', '-name', '*.pgpass', '-print', '-quit'],
        { encoding: 'utf8' });
      expect(credentialResidue.status).toBe(0);
      expect(credentialResidue.stdout.trim()).toBe('');
      expect(
        new Set(fs.readdirSync('/tmp').filter((name) => name.startsWith('bridgesllm-backup-daily-'))),
      ).toEqual(existingHostTmpStaging);
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
      if (pgDumpStart && pgDumpPid > 1 && fs.existsSync(`/proc/${pgDumpPid}`)) {
        try {
          if (fs.readFileSync(`/proc/${pgDumpPid}/stat`, 'utf8').split(') ')[1].split(' ')[19] === pgDumpStart) {
            process.kill(pgDumpPid, 'SIGKILL');
          }
        } catch {
          // The parent-death contract may win this race.
        }
      }
      for (const staging of newStaging) {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }, 120_000);

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

  it('publishes an honest degraded archive when a required recovery source is missing', () => {
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
    fs.symlinkSync(
      '/usr/bin/python3',
      path.join(requiredSources.PROJECTS_ROOT, 'escaping-python'),
    );
    fs.writeFileSync(path.join(stateDir, 'backup-base-path'), `${backupRoot}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'status.json'), `${JSON.stringify({
      id: 'daily-prior-degraded',
      type: 'daily',
      status: 'degraded',
      startedAt: '2026-08-11T00:00:00.000Z',
      completedAt: '2026-08-11T00:01:00.000Z',
      exitCode: 1,
      consecutiveFailures: 2,
    })}\n`, { mode: 0o600 });
    const priorCompleteArchive = path.join(
      backupRoot,
      'daily',
      'portal-daily-20200102-000000.tar.gz',
    );
    const priorDegradedArchive = path.join(
      backupRoot,
      'degraded',
      'daily',
      'portal-daily-20200103-000000.tar.gz',
    );
    fs.mkdirSync(path.dirname(priorDegradedArchive), { recursive: true, mode: 0o700 });
    fs.writeFileSync(priorCompleteArchive, 'prior complete archive sentinel', { mode: 0o600 });
    fs.writeFileSync(priorDegradedArchive, 'prior degraded archive sentinel', { mode: 0o600 });
    fs.writeFileSync(path.join(portalRoot, 'backend', '.env.production'), [
      'DATABASE_URL=postgresql://portal:test@127.0.0.1:5432/portal',
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
        DAILY_KEEP: '1',
        DEGRADED_KEEP: '1',
        ...fixture.env,
      },
      timeout: 120_000,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'recovery component is degraded: hosted-apps',
    );
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({
      type: 'daily',
      status: 'degraded',
      phase: 'verifying-archive',
      phaseLabel: 'Verifying and publishing archive',
      phaseIndex: 10,
      phaseTotal: 11,
      failureDetail: expect.stringContaining('published in degraded state'),
      consecutiveFailures: 3,
    });
    expect(status.exitCode).not.toBe(0);
    expect(fs.existsSync(status.archivePath)).toBe(true);
    expect(status.archivePath).toContain(`${path.sep}degraded${path.sep}daily${path.sep}`);
    expect(fs.existsSync(`${status.archivePath}.receipt.json`)).toBe(true);
    expect(fs.existsSync(priorCompleteArchive)).toBe(true);
    expect(fs.existsSync(priorDegradedArchive)).toBe(false);

    const recoveryManifest = JSON.parse(
      spawnSync('tar', ['-xOzf', status.archivePath, './RECOVERY-MANIFEST.json'], {
        encoding: 'utf8',
      }).stdout,
    );
    const components = new Map(recoveryManifest.components.map((entry: any) => [entry.id, entry]));
    expect(components.get('hosted-apps')).toMatchObject({
      requirement: 'required',
      status: 'degraded',
      payload: null,
      captureMethod: null,
      reason: expect.stringContaining('Recovery source is missing'),
    });
    expect(components.get('projects')).toMatchObject({
      requirement: 'required',
      status: 'captured',
      payload: 'projects.tar.gz',
    });
    for (const laterComponent of [
      'portal-files',
      'upload-storage',
      'portal-backend-state',
      'portal-state',
      'portal-assets',
      'portal-install',
      'portal-environment',
    ]) {
      expect(components.get(laterComponent)).toMatchObject({
        requirement: 'required',
        status: 'captured',
      });
    }

    const strictVerification = spawnSync(
      'bash',
      [backupScript, '--verify-archive', status.archivePath],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...requiredSources,
          ...fixture.env,
        },
        timeout: 120_000,
      },
    );
    expect(strictVerification.status).not.toBe(0);
    expect(`${strictVerification.stdout}\n${strictVerification.stderr}`).toContain(
      'degraded recovery component is not a complete backup',
    );
  });

  it('rejects an unversioned absolute Project python symlink with a bounded durable diagnostic', () => {
    const testRoot = makeTempRoot('backup-project-hostile-symlink');
    const portalRoot = path.join(testRoot, 'portal');
    const stateDir = path.join(portalRoot, 'backend', '.data', 'backups');
    const backupRoot = path.join(testRoot, 'configured-backups');
    const fixture = createBackupRunnerFixture(testRoot, { backupRoot, portalRoot, stateDir });
    fs.symlinkSync('/usr/bin/python', path.join(fixture.requiredSources.PROJECTS_ROOT, 'host-escape'));

    const result = spawnSync('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        OPENCLAW_DIR: path.join(testRoot, 'missing-openclaw'),
        STALWART_DIR: path.join(testRoot, 'missing-stalwart'),
        STALWART_MAIL_DIR: path.join(testRoot, 'missing-stalwart-mail'),
        STALWART_INSTALL_DIR: path.join(testRoot, 'missing-stalwart-install'),
      },
      timeout: 120_000,
    });
    expect(result.status).not.toBe(0);
    if (!fs.existsSync(path.join(stateDir, 'status.json'))) {
      throw new Error(
        `hostile Project symlink backup failed before durable status (${result.status})\n`
        + `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ type: 'daily', status: 'degraded' });
    expect(status.archivePath).toContain(`${path.sep}degraded${path.sep}daily${path.sep}`);
    const currentLog = fs.readFileSync(path.join(stateDir, 'current.log'), 'utf8');
    expect(currentLog).toContain('recovery source symbolic link escapes its admitted roots');
    expect(currentLog.length).toBeLessThanOrEqual(65_536);
    const manifest = JSON.parse(
      spawnSync('tar', ['-xOzf', status.archivePath, './RECOVERY-MANIFEST.json'], { encoding: 'utf8' }).stdout,
    );
    expect(manifest.components.find((entry: any) => entry.id === 'projects')).toMatchObject({
      requirement: 'required',
      status: 'degraded',
      payload: null,
      reason: expect.stringContaining('symbolic link escapes its admitted roots'),
    });
  }, 150_000);

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
      timeout: 120_000,
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
      timeout: 120_000,
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
      timeout: 120_000,
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
        '\nif command is not None:\n',
        '\nif command is not None:\n'
          + '    if command.strip() == "SELECT 1":\n'
          + '        sys.stderr.write("psql: error: connection to server on socket failed\\n")\n'
          + '        raise SystemExit(2)\n',
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
      timeout: 120_000,
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
      timeout: 120_000,
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
