import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  acquireMaintenanceActionAdmission,
  MaintenanceAdmissionError,
  verifyMaintenanceBackupArchive,
} from '../routes/system-maintenance';

jest.mock('../config/database', () => ({
  prisma: {
    agentJob: { findFirst: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

const repositoryRoot = path.resolve(__dirname, '../../..');

describe('system maintenance admission gate', () => {
  let tempRoot: string;
  let lockPath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-maintenance-admission-'));
    lockPath = path.join(tempRoot, 'locks', 'maintenance.lock');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('serializes concurrent requests before either can create a job row', async () => {
    const first = await acquireMaintenanceActionAdmission({
      lockPath,
      activeJobLookup: async () => null,
    });

    await expect(acquireMaintenanceActionAdmission({
      lockPath,
      activeJobLookup: async () => null,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAINTENANCE_BUSY',
    });

    first.release();
    const second = await acquireMaintenanceActionAdmission({
      lockPath,
      activeJobLookup: async () => null,
    });
    second.release();
  });

  test('uses the durable running AgentJob ledger after atomic admission', async () => {
    const activeJob = {
      id: 'job-active',
      title: 'Apply security updates',
      startedAt: new Date('2026-07-19T12:00:00.000Z'),
    };

    await expect(acquireMaintenanceActionAdmission({
      lockPath,
      activeJobLookup: async () => activeJob,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAINTENANCE_BUSY',
      activeJob,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('reclaims only an old abandoned admission lock', async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999, token: 'abandoned' })}\n`);
    const old = new Date('2026-07-19T10:00:00.000Z');
    fs.utimesSync(lockPath, old, old);

    const lease = await acquireMaintenanceActionAdmission({
      lockPath,
      nowMs: () => Date.parse('2026-07-19T12:00:00.000Z'),
      activeJobLookup: async () => null,
      processAlive: () => false,
      staleMs: 60_000,
    });
    expect(fs.existsSync(lockPath)).toBe(true);
    lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('fails closed and releases its lock when the durable ledger is unavailable', async () => {
    let caught: unknown;
    try {
      await acquireMaintenanceActionAdmission({
        lockPath,
        activeJobLookup: async () => { throw new Error('database unavailable'); },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaintenanceAdmissionError);
    expect(caught).toMatchObject({
      statusCode: 503,
      code: 'MAINTENANCE_ADMISSION_UNAVAILABLE',
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('uses the recovery verifier and rejects an archive changed during verification', async () => {
    const archivePath = path.join(tempRoot, 'portal-comprehensive-test.tar.gz');
    fs.writeFileSync(archivePath, 'fixture recovery archive');
    const stat = fs.lstatSync(archivePath);
    const statNs = fs.lstatSync(archivePath, { bigint: true });
    const candidate = {
      filename: path.basename(archivePath),
      fullPath: archivePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtimeNs: statNs.mtimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      type: 'comprehensive' as const,
      completeness: 'complete' as const,
      degradedComponents: [],
      classificationAuthenticated: true,
    };
    const runShellImpl = jest.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await expect(verifyMaintenanceBackupArchive(candidate, {
      runShellImpl,
      restoreScriptPath: '/opt/bridgesllm/portal/restore-full.sh',
    })).resolves.toBe(true);
    expect(runShellImpl).toHaveBeenCalledWith(
      "/bin/bash '/opt/bridgesllm/portal/restore-full.sh' --verify-archive '" + archivePath + "'",
      900_000,
    );

    const mutatingVerifier = jest.fn().mockImplementation(async () => {
      fs.appendFileSync(archivePath, 'tamper');
      return { ok: true, stdout: '', stderr: '' };
    });
    await expect(verifyMaintenanceBackupArchive(candidate, {
      runShellImpl: mutatingVerifier,
      restoreScriptPath: '/opt/bridgesllm/portal/restore-full.sh',
    })).resolves.toBe(false);
  });

  test('rejects a checksum-valid database-only archive as incomplete recovery evidence', async () => {
    const staging = path.join(tempRoot, 'database-only-staging');
    fs.mkdirSync(staging);
    const database = '-- database dump\n';
    fs.writeFileSync(path.join(staging, 'database.sql'), database);
    const databaseHash = crypto.createHash('sha256').update(database).digest('hex');
    fs.writeFileSync(
      path.join(staging, 'MANIFEST.txt'),
      `BridgesLLM Portal Backup\n\nChecksums:\n${databaseHash}  ./database.sql\n`,
    );
    const archivePath = path.join(tempRoot, 'portal-comprehensive-database-only.tar.gz');
    execFileSync('tar', ['czf', archivePath, '-C', staging, '.']);
    const stat = fs.lstatSync(archivePath);
    const statNs = fs.lstatSync(archivePath, { bigint: true });
    const candidate = {
      filename: path.basename(archivePath),
      fullPath: archivePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtimeNs: statNs.mtimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      type: 'comprehensive' as const,
      completeness: 'complete' as const,
      degradedComponents: [],
      classificationAuthenticated: true,
    };

    const previousRestoreScriptPath = process.env.RESTORE_SCRIPT_PATH;
    process.env.RESTORE_SCRIPT_PATH = path.join(repositoryRoot, 'restore-full.sh');
    try {
      await expect(verifyMaintenanceBackupArchive(candidate)).resolves.toBe(false);
    } finally {
      if (previousRestoreScriptPath === undefined) delete process.env.RESTORE_SCRIPT_PATH;
      else process.env.RESTORE_SCRIPT_PATH = previousRestoreScriptPath;
    }
  });

  test('rejects daily, degraded, and unauthenticated candidates before invoking a verifier', async () => {
    const archivePath = path.join(tempRoot, 'portal-comprehensive-classification.tar.gz');
    fs.writeFileSync(archivePath, 'fixture');
    const stat = fs.lstatSync(archivePath);
    const statNs = fs.lstatSync(archivePath, { bigint: true });
    const base = {
      filename: path.basename(archivePath),
      fullPath: archivePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtimeNs: statNs.mtimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      type: 'comprehensive' as const,
      completeness: 'complete' as const,
      degradedComponents: [],
      classificationAuthenticated: true,
    };
    const runShellImpl = jest.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await expect(verifyMaintenanceBackupArchive({ ...base, type: 'daily' }, { runShellImpl })).resolves.toBe(false);
    await expect(verifyMaintenanceBackupArchive({ ...base, completeness: 'degraded' }, { runShellImpl })).resolves.toBe(false);
    await expect(verifyMaintenanceBackupArchive({ ...base, classificationAuthenticated: false }, { runShellImpl })).resolves.toBe(false);
    expect(runShellImpl).not.toHaveBeenCalled();
  });
});
