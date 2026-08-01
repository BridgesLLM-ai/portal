import {
  acquireProjectDeletionLock,
  projectDeletionLockKey,
} from './projectDeletionLock';

describe('Project deletion serialization', () => {
  test('queues the same project while allowing a different project to proceed', async () => {
    const alpha = projectDeletionLockKey('owner', 'alpha');
    const beta = projectDeletionLockKey('owner', 'beta');
    const releaseFirst = await acquireProjectDeletionLock(alpha);
    let secondAcquired = false;
    const second = acquireProjectDeletionLock(alpha).then((release) => {
      secondAcquired = true;
      return release;
    });

    const releaseOther = await acquireProjectDeletionLock(beta);
    expect(secondAcquired).toBe(false);
    releaseOther();
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  test('release is idempotent and the key can be acquired again', async () => {
    const key = projectDeletionLockKey('owner', 'project');
    const release = await acquireProjectDeletionLock(key);
    release();
    release();
    const next = await acquireProjectDeletionLock(key);
    next();
  });

  test('serializes every project-name claimant behind a rename target reservation', async () => {
    const target = projectDeletionLockKey('owner', 'rename target #1');
    const releaseRenameTarget = await acquireProjectDeletionLock(target);
    const acquired: string[] = [];
    const waiters = ['template', 'clone', 'upload-zip', 'create-from-upload'].map(async (claimant) => {
      const release = await acquireProjectDeletionLock(target);
      acquired.push(claimant);
      release();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquired).toEqual([]);
    releaseRenameTarget();
    await Promise.all(waiters);
    expect(acquired).toEqual(['template', 'clone', 'upload-zip', 'create-from-upload']);
  });

  test('rejects empty and NUL-bearing identities', async () => {
    expect(() => projectDeletionLockKey('', 'project')).toThrow(/invalid/i);
    await expect(acquireProjectDeletionLock('owner\0project')).rejects.toThrow(/invalid/i);
  });
});
