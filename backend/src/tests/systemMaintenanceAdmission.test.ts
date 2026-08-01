import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import {
  acquireMaintenanceActionAdmission,
  MaintenanceAdmissionError,
  verifyMaintenanceBackupArchive,
} from '../routes/system-maintenance';
import {
  createAttestedBackupRoot,
  createBackupRunnerFixture,
} from './backupRunnerFixture';

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

  test('verifies gzip integrity and required recovery evidence without a TOCTOU swap', async () => {
    const { cleanupRoot, fixtureRoot } = createAttestedBackupRoot(
      'maintenance-archive',
    );
    try {
      const fixture = createBackupRunnerFixture(fixtureRoot);
      const backup = spawnSync('bash', [
        path.join(repositoryRoot, 'backup-full.sh'),
        'daily',
      ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...fixture.env,
        },
        timeout: 30_000,
      });
      if (backup.status !== 0) {
        throw new Error(
          `fixture backup failed (${backup.status})\n`
          + `stdout:\n${backup.stdout}\nstderr:\n${backup.stderr}`,
        );
      }
      const backupStatus = JSON.parse(
        fs.readFileSync(path.join(fixture.stateDir, 'status.json'), 'utf8'),
      );
      const archivePath = backupStatus.archivePath as string;
      const stat = fs.lstatSync(archivePath);
      const candidate = {
        filename: path.basename(archivePath),
        fullPath: archivePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      };

      const overrides = {
        ...fixture.env,
        BACKUP_SCRIPT_PATH: path.join(repositoryRoot, 'backup-full.sh'),
      };
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      try {
        await expect(verifyMaintenanceBackupArchive(candidate)).resolves.toBe(true);
        fs.appendFileSync(archivePath, 'tamper');
        await expect(verifyMaintenanceBackupArchive(candidate)).resolves.toBe(false);
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    } finally {
      fs.rmSync(cleanupRoot, { recursive: true, force: true });
    }
  }, 40_000);

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
    const archivePath = path.join(tempRoot, 'portal-daily-database-only.tar.gz');
    execFileSync('tar', ['czf', archivePath, '-C', staging, '.']);
    const stat = fs.lstatSync(archivePath);
    const candidate = {
      filename: path.basename(archivePath),
      fullPath: archivePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
    };

    const previousBackupScriptPath = process.env.BACKUP_SCRIPT_PATH;
    process.env.BACKUP_SCRIPT_PATH = path.join(repositoryRoot, 'backup-full.sh');
    try {
      await expect(verifyMaintenanceBackupArchive(candidate)).resolves.toBe(false);
    } finally {
      if (previousBackupScriptPath === undefined) delete process.env.BACKUP_SCRIPT_PATH;
      else process.env.BACKUP_SCRIPT_PATH = previousBackupScriptPath;
    }
  });
});
