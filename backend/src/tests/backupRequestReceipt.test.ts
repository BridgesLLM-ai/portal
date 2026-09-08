import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  createBackupRequestReceipt,
  removeExactBackupRequestReceipt,
  type BackupType,
  type CreatedBackupRequestReceipt,
} from '../services/backup.service';
import {
  createAttestedBackupRoot,
  createBackupRunnerFixture,
  type BackupRunnerFixture,
} from './backupRunnerFixture';

jest.mock('../config/database', () => ({
  prisma: {
    activityLog: { create: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

const repositoryRoot = path.resolve(__dirname, '../../..');
const backupScript = path.join(repositoryRoot, 'backup-full.sh');
const cleanupRoots: string[] = [];

function fixture(name: string): { root: string; runner: BackupRunnerFixture } {
  const created = createAttestedBackupRoot(`backup-request-${name}`);
  cleanupRoots.push(created.cleanupRoot);
  return {
    root: created.fixtureRoot,
    runner: createBackupRunnerFixture(created.fixtureRoot),
  };
}

function queueRequest(
  runner: BackupRunnerFixture,
  type: BackupType,
): CreatedBackupRequestReceipt {
  const created = createBackupRequestReceipt(type, { stateDirectory: runner.stateDir });
  fs.writeFileSync(
    path.join(runner.stateDir, 'status.json'),
    `${JSON.stringify({
      id: created.receipt.id,
      type,
      status: 'queued',
      startedAt: created.receipt.requestedAt,
    })}\n`,
    { mode: 0o600 },
  );
  return created;
}

function runBackup(runner: BackupRunnerFixture, type: BackupType) {
  return spawnSync('bash', [backupScript, type], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...runner.env },
    timeout: 120_000,
  });
}

function readStatus(runner: BackupRunnerFixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runner.stateDir, 'status.json'), 'utf8'));
}

function requestEntries(runner: BackupRunnerFixture): string[] {
  const requestRoot = path.join(runner.stateDir, 'requests');
  return fs.existsSync(requestRoot) ? fs.readdirSync(requestRoot).sort() : [];
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for backup request state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('manual backup request receipt handshake', () => {
  it('publishes an exact O_EXCL root-bounded receipt', () => {
    const { root, runner } = fixture('exclusive');
    const id = 'request-12345678-1234-4123-8123-1234567890ab';
    const requestedAt = new Date().toISOString();
    const created = createBackupRequestReceipt('daily', {
      id,
      requestedAt,
      stateDirectory: runner.stateDir,
    });
    expect(path.dirname(created.fullPath)).toBe(path.join(runner.stateDir, 'requests'));
    expect(fs.statSync(created.fullPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(created.fullPath, 'utf8'))).toEqual({
      schema: 'bridgesllm.backup-request.v1',
      id,
      type: 'daily',
      requestedAt,
    });
    expect(() => createBackupRequestReceipt('daily', {
      id,
      requestedAt,
      stateDirectory: runner.stateDir,
    })).toThrow(/EEXIST|exist/iu);

    const outside = path.join(root, 'outside-requests');
    fs.mkdirSync(outside, { mode: 0o755 });
    const requestRoot = path.join(runner.stateDir, 'requests');
    fs.unlinkSync(created.fullPath);
    fs.rmdirSync(requestRoot);
    fs.symlinkSync(outside, requestRoot);
    expect(() => createBackupRequestReceipt('daily', {
      stateDirectory: runner.stateDir,
    })).toThrow(/unsafe/iu);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
  });

  it.each([
    {
      name: 'backup-root validation',
      arrange: ({ runner }: { root: string; runner: BackupRunnerFixture }) => {
        fs.chmodSync(runner.backupRoot, 0o777);
      },
      message: 'Backup path validation failed',
    },
    {
      name: 'interrupted recovery',
      arrange: ({ runner }: { root: string; runner: BackupRunnerFixture }) => {
        const recoveryRoot = runner.env.BRIDGESLLM_BACKUP_RECOVERY_STATE_DIR;
        fs.writeFileSync(path.join(recoveryRoot, 'quiescence.json'), '{not-json}\n', { mode: 0o600 });
      },
      message: 'prior interrupted backup could not restore',
    },
    {
      name: 'stale-artifact sweep',
      arrange: ({ runner }: { root: string; runner: BackupRunnerFixture }) => {
        const workRoot = path.join(runner.backupRoot, '.bridgesllm-work-v1');
        fs.mkdirSync(workRoot, { mode: 0o700 });
        fs.symlinkSync('/etc/passwd', path.join(workRoot, 'create-daily-aaaaaaaaaaaaaaaa'));
      },
      message: 'Configured backup storage cannot safely host private backup workspaces',
    },
    {
      name: 'archive trust',
      arrange: ({ runner }: { root: string; runner: BackupRunnerFixture }) => {
        fs.chmodSync(runner.env.BRIDGESLLM_BACKUP_TRUST_ROOT, 0o777);
      },
      message: 'authentication trust key or control directory is unsafe',
    },
  ])('records an exact terminal preflight failure for $name', ({ name, arrange, message }) => {
    const test = fixture(`fault-${message.split(' ')[0]}`);
    const request = queueRequest(test.runner, 'daily');
    arrange(test);

    const result = runBackup(test.runner, 'daily');
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
    expect(readStatus(test.runner)).toMatchObject({
      id: request.receipt.id,
      type: 'daily',
      status: 'failed',
      phase: name === 'interrupted recovery' ? 'restoring-services' : 'preflight',
      phaseIndex: name === 'interrupted recovery' ? 11 : 1,
      failureDetail: expect.stringContaining(message),
    });
    if (name === 'stale-artifact sweep') {
      expect(readStatus(test.runner)).toMatchObject({
        failureCode: 'BACKUP_WORK_ROOT_UNAVAILABLE',
      });
    }
    expect(requestEntries(test.runner)).toEqual([]);
  });

  it('preserves exact queued authority on lock contention, then claims and completes it once', () => {
    const { runner } = fixture('lock');
    const request = queueRequest(runner, 'daily');
    const originalStatus = fs.readFileSync(path.join(runner.stateDir, 'status.json'));
    const originalReceipt = fs.readFileSync(request.fullPath);
    const originalIdentity = fs.lstatSync(request.fullPath, { bigint: true });
    const result = spawnSync(
      'flock',
      [path.join(runner.stateDir, 'backup.lock'), 'bash', backupScript, 'daily'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, ...runner.env },
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(75);
    expect(fs.readFileSync(path.join(runner.stateDir, 'status.json'))).toEqual(originalStatus);
    expect(fs.readFileSync(request.fullPath)).toEqual(originalReceipt);
    const afterContention = fs.lstatSync(request.fullPath, { bigint: true });
    expect(afterContention.dev).toBe(originalIdentity.dev);
    expect(afterContention.ino).toBe(originalIdentity.ino);
    expect(requestEntries(runner)).toEqual([path.basename(request.fullPath)]);

    const retried = runBackup(runner, 'daily');
    expect(retried.status).toBe(0);
    expect(readStatus(runner)).toMatchObject({
      id: request.receipt.id,
      type: 'daily',
      status: expect.stringMatching(/^(?:completed|degraded)$/u),
    });
    expect(requestEntries(runner)).toEqual([]);
  });

  it('does not clobber a status identity replaced before claim', () => {
    const { runner } = fixture('replaced-id');
    const request = queueRequest(runner, 'daily');
    const replacement = `${JSON.stringify({
      id: 'timer-daily-replacement',
      type: 'daily',
      status: 'completed',
      startedAt: '2026-08-20T00:00:00.000Z',
      completedAt: '2026-08-20T00:01:00.000Z',
    })}\n`;
    fs.writeFileSync(path.join(runner.stateDir, 'status.json'), replacement, { mode: 0o600 });

    const result = runBackup(runner, 'daily');
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(runner.stateDir, 'status.json'), 'utf8')).toBe(replacement);
    expect(requestEntries(runner)).toEqual([
      path.basename(request.fullPath).replace('.pending.json', '.claimed.json'),
    ]);
  });

  it('keeps a foreign-type manual request queued when a timer races it', () => {
    const { runner } = fixture('timer-race');
    const request = queueRequest(runner, 'comprehensive');
    const original = fs.readFileSync(path.join(runner.stateDir, 'status.json'), 'utf8');

    const result = runBackup(runner, 'daily');
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Another queued or running backup owns the status channel',
    );
    expect(fs.readFileSync(path.join(runner.stateDir, 'status.json'), 'utf8')).toBe(original);
    expect(requestEntries(runner)).toEqual([path.basename(request.fullPath)]);
    expect(removeExactBackupRequestReceipt(request)).toBe(true);
  });

  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('records %s against the claimed request and consumes it', async (signal, exitCode) => {
    const { root, runner } = fixture(`signal-${signal.toLowerCase()}`);
    const request = queueRequest(runner, 'daily');
    const marker = path.join(root, 'slow-version-check');
    fs.writeFileSync(runner.commands.psql, [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
      `  : > '${marker}'`,
      '  sleep 30',
      '  printf "%s\\n" "psql (PostgreSQL) 16.14"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o700 });

    const child = spawn('bash', [backupScript, 'daily'], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...runner.env },
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    try {
      await waitUntil(() => {
        if (!fs.existsSync(marker)) return false;
        const status = readStatus(runner);
        return status.id === request.receipt.id && status.status === 'running';
      });
      process.kill(-(child.pid as number), signal);
      const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      );
      if (!(completion.code === exitCode || completion.signal === signal)) {
        const state = readStatus(runner);
        throw new Error(JSON.stringify({ completion, phase: state.phase, exitCode: state.exitCode, failureDetail: state.failureDetail, stderr: stderr.slice(-2000) }));
      }
      expect(readStatus(runner)).toMatchObject({
        id: request.receipt.id,
        status: 'failed',
        phase: 'preflight',
        exitCode,
      });
      expect(requestEntries(runner)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }
    expect(stderr).not.toContain('request status ownership changed');
  }, 20_000);
});
