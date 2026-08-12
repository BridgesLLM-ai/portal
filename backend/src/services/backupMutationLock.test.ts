import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  __backupMutationLockTest,
  acquireBackupMutationLock,
  assertBackupMutationLockLease,
  withBackupMutationLock,
  type BackupMutationLockLease,
} from './backup.service';

jest.mock('../config/database', () => ({ prisma: {} }));

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('backup mutation kernel-lock ownership', () => {
  let root = '';
  let options: { operationLockPath: string; stateDirectory: string; timeoutSeconds: number };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-mutation-lock-'));
    fs.chmodSync(root, 0o700);
    options = {
      operationLockPath: path.join(root, 'operation.lock'),
      stateDirectory: path.join(root, 'state'),
      timeoutSeconds: 2,
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('unexpected holder death retains kernel exclusion until explicit release', async () => {
    const acquired = await acquireBackupMutationLock(options);
    assertBackupMutationLockLease(acquired.lease);
    for (const lockPath of [options.operationLockPath, path.join(options.stateDirectory, 'backup.lock')]) {
      const blocked = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, '/bin/true']);
      expect(blocked.status).not.toBe(0);
    }
    expect(fs.existsSync(path.join(process.cwd(), '3'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), '4'))).toBe(false);
    // Kill the helper externally without pre-mutating its JS lease state, then
    // block the event loop with synchronous competitors. This reproduces the
    // real seam where the kernel has reaped the child but Node has not yet
    // delivered the exit event.
    __backupMutationLockTest.terminateHolderExternally(acquired.lease);
    for (const lockPath of [options.operationLockPath, path.join(options.stateDirectory, 'backup.lock')]) {
      const stillBlocked = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, '/bin/true']);
      expect(stillBlocked.status).not.toBe(0);
    }
    await eventually(() => {
      try { assertBackupMutationLockLease(acquired.lease); return false; } catch { return true; }
    });
    expect(() => assertBackupMutationLockLease(acquired.lease)).toThrow('not held');
    for (const lockPath of [options.operationLockPath, path.join(options.stateDirectory, 'backup.lock')]) {
      const retainedUntilRelease = spawnSync(
        '/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, '/bin/true'],
      );
      expect(retainedUntilRelease.status).not.toBe(0);
    }
    await acquired.release();
    for (const lockPath of [options.operationLockPath, path.join(options.stateDirectory, 'backup.lock')]) {
      const available = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, '/bin/true']);
      expect(available.status).toBe(0);
    }
  }, 15_000);

  test('an awaited callback cannot report success after its holder dies', async () => {
    let lease: BackupMutationLockLease | null = null;
    let releasePause!: () => void;
    const pause = new Promise<void>((resolve) => { releasePause = resolve; });
    const operation = withBackupMutationLock(async (currentLease) => {
      lease = currentLease;
      await pause;
      return 'must-not-succeed';
    }, options);
    await eventually(() => lease !== null);
    __backupMutationLockTest.terminateHolderExternally(lease!);
    await eventually(() => {
      try { assertBackupMutationLockLease(lease!); return false; } catch { return true; }
    });
    releasePause();
    await expect(operation).rejects.toThrow('not held');
  }, 15_000);
});
