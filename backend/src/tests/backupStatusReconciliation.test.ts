import fs from 'fs';
import path from 'path';
import { spawn as spawnChild, type ChildProcess } from 'child_process';
import { createAttestedBackupRoot, createBackupRunnerFixture } from './backupRunnerFixture';

const mockExecFile = jest.fn();
const mockExecFileSync = jest.fn();

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

const attestedRoot = createAttestedBackupRoot('backup-status');
const testRoot = attestedRoot.fixtureRoot;
const portalRoot = path.join(testRoot, 'portal');
const stateDirectory = path.join(portalRoot, 'backend', '.data', 'backups');
const backupRoot = path.join(testRoot, 'configured-backups');
fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(backupRoot, { mode: 0o700 });
const runner = createBackupRunnerFixture(testRoot, {
  backupRoot,
  portalRoot,
  stateDir: stateDirectory,
});
process.env.PORTAL_ROOT = portalRoot;
process.env.BACKUP_STATE_DIR = stateDirectory;
process.env.BACKUP_CONFIG_FILE = path.join(stateDirectory, 'backup-base-path');
process.env.PORTAL_OPERATION_LOCK_FILE = path.join(testRoot, 'portal-operation.lock');

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: {
      findUnique: jest.fn(async () => ({ value: backupRoot })),
    },
  },
}));

// Require after the path authority above is fixed because backup.service binds
// its state files once at module initialization.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backup = require('../services/backup.service') as typeof import('../services/backup.service');

function resetState(): void {
  fs.rmSync(stateDirectory, { recursive: true, force: true });
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mockExecFile.mockReset();
  mockExecFileSync.mockReset();
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, '', '');
    return undefined;
  });
}

function queueOldRequest(): { id: string; fullPath: string; rawStatus: string } {
  const requestedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const created = backup.createBackupRequestReceipt('daily', { requestedAt });
  backup.writeBackupStatus({
    id: created.receipt.id,
    type: 'daily',
    status: 'queued',
    startedAt: requestedAt,
  });
  return {
    id: created.receipt.id,
    fullPath: created.fullPath,
    rawStatus: fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8'),
  };
}

function requestEntries(): string[] {
  const requestDirectory = path.join(stateDirectory, 'requests');
  return fs.existsSync(requestDirectory) ? fs.readdirSync(requestDirectory).sort() : [];
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for backup fixture state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, stderr };
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolve(exitCode));
  });
  return { code, stderr };
}

describe('backup queued-request reconciliation', () => {
  beforeEach(resetState);

  afterAll(() => {
    fs.rmSync(attestedRoot.cleanupRoot, { recursive: true, force: true });
  });

  it('keeps failed unit history advisory and redispatches the exact receipt after a pre-dispatch crash', async () => {
    const old = queueOldRequest();
    const originalReceipt = fs.lstatSync(old.fullPath, { bigint: true });
    mockExecFileSync.mockReturnValue([
      'LoadState=loaded',
      'ActiveState=failed',
      'SubState=failed',
      'Result=exit-code',
      'ExecMainStatus=23',
      '',
    ].join('\n'));

    expect(backup.readBackupStatus()).toMatchObject({
      id: old.id,
      status: 'queued',
      failureCode: 'BACKUP_SERVICE_EXITED_BEFORE_CLAIM',
      failureDetail: expect.stringContaining('result=exit-code, status=23'),
    });
    expect(fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8')).toBe(old.rawStatus);
    expect(fs.existsSync(old.fullPath)).toBe(true);

    const redispatched = await backup.startBackupUnit('daily');
    expect(redispatched).toMatchObject({
      id: old.id,
      type: 'daily',
      status: 'queued',
    });
    const redispatchedReceipt = fs.lstatSync(old.fullPath, { bigint: true });
    expect(redispatchedReceipt.dev).toBe(originalReceipt.dev);
    expect(redispatchedReceipt.ino).toBe(originalReceipt.ino);
    const requests = fs.readdirSync(path.join(stateDirectory, 'requests'));
    expect(requests).toEqual([path.basename(old.fullPath)]);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'bridgesllm-backup@daily.service'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('does not retire or redispatch while the old unit remains active or indeterminate', async () => {
    const old = queueOldRequest();
    mockExecFileSync.mockReturnValue([
      'LoadState=loaded',
      'ActiveState=activating',
      'SubState=start',
      'Result=success',
      'ExecMainStatus=0',
      '',
    ].join('\n'));

    await expect(backup.startBackupUnit('daily')).rejects.toMatchObject({ code: 'EBUSY' });
    expect(fs.existsSync(old.fullPath)).toBe(true);
    expect(fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8')).toBe(old.rawStatus);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(backup.readBackupStatus()).toMatchObject({
      id: old.id,
      status: 'queued',
      failureCode: 'BACKUP_REQUEST_CLAIM_DELAYED',
    });
  });

  it('keeps a stale queued read queued when unit inspection is unavailable', () => {
    const old = queueOldRequest();
    mockExecFileSync.mockImplementation(() => { throw new Error('private host failure'); });

    expect(backup.readBackupStatus()).toMatchObject({
      id: old.id,
      status: 'queued',
      failureCode: 'BACKUP_SERVICE_STATE_UNAVAILABLE',
    });
    expect(fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8')).toBe(old.rawStatus);
    expect(fs.existsSync(old.fullPath)).toBe(true);
  });

  it('durably exposes a bounded code and retires the exact receipt on a definite start rejection', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      const error = new Error('private systemd diagnostic') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      callback(error);
      return undefined;
    });

    await expect(backup.startBackupUnit('weekly')).rejects.toMatchObject({
      code: 'BACKUP_SERVICE_START_FAILED',
      message: 'The installed backup service rejected the backup request before it started',
    });
    expect(backup.readBackupStatus()).toMatchObject({
      type: 'weekly',
      status: 'failed',
      failureCode: 'BACKUP_SERVICE_START_FAILED',
      failureDetail: 'The installed backup service rejected the backup request before it started',
    });
    expect(JSON.stringify(backup.readBackupStatus())).not.toContain('private systemd diagnostic');
    expect(fs.readdirSync(path.join(stateDirectory, 'requests'))).toEqual([]);
  });

  it('adopts a sole durable receipt after a receipt-before-status crash and dispatches its exact identity', async () => {
    const requestedAt = new Date().toISOString();
    const orphan = backup.createBackupRequestReceipt('monthly', { requestedAt });

    const status = await backup.startBackupUnit('daily');

    expect(status).toMatchObject({
      id: orphan.receipt.id,
      type: 'monthly',
      status: 'queued',
      startedAt: requestedAt,
    });
    expect(requestEntries()).toEqual([path.basename(orphan.fullPath)]);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'bridgesllm-backup@monthly.service'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('fails closed before dispatch for multiple or unsafe request authorities', async () => {
    const first = backup.createBackupRequestReceipt('daily');
    backup.createBackupRequestReceipt('weekly');

    await expect(backup.startBackupUnit('daily')).rejects.toMatchObject({
      code: 'BACKUP_REQUEST_RECOVERY_REQUIRED',
    });
    expect(requestEntries()).toHaveLength(2);
    expect(fs.existsSync(first.fullPath)).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();

    resetState();
    const requests = path.join(stateDirectory, 'requests');
    fs.mkdirSync(requests, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(requests, 'foreign'), 'unsafe\n', { mode: 0o600 });
    await expect(backup.startBackupUnit('daily')).rejects.toMatchObject({
      code: 'BACKUP_REQUEST_RECOVERY_REQUIRED',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('reconciles only a proven stale timer owner and preserves active or indeterminate timers', async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const timerStatus = {
      id: 'timer-daily-20260821T010203-987654',
      type: 'daily' as const,
      status: 'queued' as const,
      startedAt,
    };
    backup.writeBackupStatus(timerStatus);
    mockExecFileSync.mockReturnValue([
      'LoadState=loaded',
      'ActiveState=inactive',
      'SubState=dead',
      'Result=success',
      'ExecMainStatus=0',
      '',
    ].join('\n'));

    const replacement = await backup.startBackupUnit('weekly');
    expect(replacement).toMatchObject({ type: 'weekly', status: 'queued' });
    expect(replacement?.id).not.toBe(timerStatus.id);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    resetState();
    backup.writeBackupStatus(timerStatus);
    const original = fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8');
    mockExecFileSync.mockReturnValue([
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'Result=success',
      'ExecMainStatus=0',
      '',
    ].join('\n'));
    await expect(backup.startBackupUnit('weekly')).rejects.toMatchObject({ code: 'EBUSY' });
    expect(fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8')).toBe(original);
    expect(mockExecFile).not.toHaveBeenCalled();

    mockExecFileSync.mockImplementation(() => { throw new Error('unavailable'); });
    await expect(backup.startBackupUnit('weekly')).rejects.toMatchObject({ code: 'EBUSY' });
    expect(fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8')).toBe(original);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('preserves exact authority when dispatch outcome is indeterminate', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      const error = new Error('private timeout') as NodeJS.ErrnoException & { killed: boolean };
      error.code = 'ETIMEDOUT';
      error.killed = true;
      callback(error);
      return undefined;
    });

    await expect(backup.startBackupUnit('daily')).rejects.toMatchObject({
      code: 'BACKUP_SERVICE_DISPATCH_INDETERMINATE',
    });
    const entries = requestEntries();
    expect(entries).toHaveLength(1);
    const receiptRaw = fs.readFileSync(path.join(stateDirectory, 'requests', entries[0]), 'utf8');
    const statusRaw = fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8');
    expect(backup.readBackupStatus()).toMatchObject({ status: 'queued' });
    expect(fs.readFileSync(path.join(stateDirectory, 'requests', entries[0]), 'utf8')).toBe(receiptRaw);
    expect(fs.readFileSync(path.join(stateDirectory, 'status.json'), 'utf8')).toBe(statusRaw);
  });

  it('does not terminalize a definite rejection after the shell has claimed authority', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const requestDirectory = path.join(stateDirectory, 'requests');
      const pending = fs.readdirSync(requestDirectory).find((entry) => entry.endsWith('.pending.json'))!;
      fs.renameSync(
        path.join(requestDirectory, pending),
        path.join(requestDirectory, pending.replace('.pending.json', '.claimed.json')),
      );
      const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      const error = new Error('private rejection after claim') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      callback(error);
      return undefined;
    });

    await expect(backup.startBackupUnit('daily')).rejects.toMatchObject({
      code: 'BACKUP_SERVICE_DISPATCH_INDETERMINATE',
    });
    expect(requestEntries()).toHaveLength(1);
    expect(requestEntries()[0]).toMatch(/\.claimed\.json$/u);
    expect(backup.readBackupStatus()).toMatchObject({ status: 'queued' });
  });

  it('recovers a claimed dead request exactly and admits the next manual retry', async () => {
    const requestedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const created = backup.createBackupRequestReceipt('daily', { requestedAt });
    const claimedPath = created.fullPath.replace('.pending.json', '.claimed.json');
    fs.renameSync(created.fullPath, claimedPath);
    backup.writeBackupStatus({
      id: created.receipt.id,
      type: 'daily',
      status: 'running',
      startedAt: requestedAt,
      pid: 99_999_999,
    });
    const claimBefore = fs.lstatSync(claimedPath, { bigint: true });
    const claimBytes = fs.readFileSync(claimedPath);
    let observedAtDispatch: {
      oldClaimExists: boolean;
      requests: string[];
      status: ReturnType<typeof backup.readBackupStatus>;
    } | null = null;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      observedAtDispatch = {
        oldClaimExists: fs.existsSync(claimedPath),
        requests: requestEntries(),
        status: backup.readBackupStatus(),
      };
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, '', '');
      return undefined;
    });

    const retry = await backup.startBackupUnit('weekly');

    expect(claimBefore.nlink).toBe(1n);
    expect(claimBytes.toString('utf8')).toContain(created.receipt.id);
    expect(fs.existsSync(claimedPath)).toBe(false);
    expect(observedAtDispatch).toMatchObject({
      oldClaimExists: false,
      requests: [expect.stringMatching(/^weekly\.request-.*\.pending\.json$/u)],
      status: {
        type: 'weekly',
        status: 'queued',
      },
    });
    expect(retry).toMatchObject({ type: 'weekly', status: 'queued' });
    expect(retry?.id).not.toBe(created.receipt.id);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'bridgesllm-backup@weekly.service'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('releases both backend locks before the real shell claims and completes the exact request once', async () => {
    const release = path.join(testRoot, 'release-real-shell');
    const claimed = path.join(testRoot, 'real-shell-claimed');
    const originalPsql = `${runner.commands.psql}.real`;
    fs.copyFileSync(runner.commands.psql, originalPsql);
    fs.chmodSync(originalPsql, 0o700);
    fs.writeFileSync(runner.commands.psql, [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
      `  : > '${claimed}'`,
      `  while [ ! -e '${release}' ]; do sleep 0.02; done`,
      'fi',
      `exec '${originalPsql}' "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });

    let shell: ChildProcess | undefined;
    let shellStderr = '';
    mockExecFile.mockImplementation((...args: unknown[]) => {
      shell = spawnChild('bash', [path.join(__dirname, '../../..', 'backup-full.sh'), 'daily'], {
        cwd: path.join(__dirname, '../../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...runner.env },
      });
      shell.stderr?.setEncoding('utf8');
      shell.stderr?.on('data', (chunk) => { shellStderr += chunk; });
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, '', '');
      return shell;
    });

    const start = backup.startBackupUnit('daily');
    try {
      await waitUntil(() => {
        if (shell && (shell.exitCode !== null || shell.signalCode !== null)) {
          throw new Error(`Real backup shell exited before claim: ${shellStderr}`);
        }
        return fs.existsSync(claimed) && requestEntries().some(
          (entry) => entry.endsWith('.claimed.json'),
        );
      });
      const inFlight = backup.readBackupStatus();
      expect(inFlight).toMatchObject({ type: 'daily', status: 'running' });
      const exactId = inFlight!.id;
      expect(requestEntries()).toEqual([
        expect.stringMatching(new RegExp(`^daily\\.${exactId}\\.claimed\\.json$`, 'u')),
      ]);
      fs.writeFileSync(release, 'continue\n', { mode: 0o600 });
      await start;
      const completion = await waitForChild(shell!);
      expect(completion).toMatchObject({ code: 0 });
      expect(completion.stderr).not.toContain('Could not acquire');
      expect(backup.readBackupStatus()).toMatchObject({
        id: exactId,
        type: 'daily',
        status: expect.stringMatching(/^(?:completed|degraded)$/u),
      });
      expect(requestEntries()).toEqual([]);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    } finally {
      if (!fs.existsSync(release)) fs.writeFileSync(release, 'continue\n', { mode: 0o600 });
      if (shell && shell.exitCode === null && shell.signalCode === null) shell.kill('SIGKILL');
    }
  }, 150_000);

  it('maps untrusted systemd result text to a bounded enum', () => {
    expect(backup.queuedBackupFailureFromSystemdProperties({
      LoadState: 'loaded',
      ActiveState: 'failed',
      Result: 'secret\nvalue',
      ExecMainStatus: '999999999999999999',
    })).toEqual({
      failureCode: 'BACKUP_SERVICE_EXITED_BEFORE_CLAIM',
      failureDetail: 'The backup service exited before claiming its request (result=unknown, status=unknown)',
    });
  });
});
