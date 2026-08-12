import fs from 'fs';
import os from 'os';
import path from 'path';

const mockReadProjectDependencyPromotionLifecycleByProject = jest.fn<
  Promise<{ lifecycleStatus: string } | null>,
  []
>(async () => null);

jest.mock('../config/env', () => ({ config: { portalProjectRuntimeImageId: '' } }));
jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('./projectDependencyPromotionDecision', () => ({
  findProjectDependencyPromotionDecisionByDestination: jest.fn(async () => null),
  readProjectDependencyPromotionLifecycleByProject:
    mockReadProjectDependencyPromotionLifecycleByProject,
}));

import {
  acquireProjectDeletionLock,
  assertHeldExpectedPreparedProjectPromotionLock,
  createExpectedPreparedProjectPromotionLockHandoff,
  projectDeletionLockKey,
  reacquireExpectedPreparedProjectPromotionLock,
  withProjectDeletionLock,
} from './projectDeletionLock';
import { writeProjectRuntimeOwnedFileAtomic } from './projectRuntimeOwnership';

describe('Project deletion serialization', () => {
  beforeEach(() => {
    mockReadProjectDependencyPromotionLifecycleByProject.mockReset();
    mockReadProjectDependencyPromotionLifecycleByProject.mockResolvedValue(null);
  });

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

  test('queues an atomic package-lock write behind the dependency install lifecycle lock', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-file-mutation-lock-'));
    let releaseInstall: (() => void) | null = null;
    try {
      fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{"lockfileVersion":2}');
      const workspaceOwnerId = 'dependency-install-owner';
      const projectName = 'dependency-install-project';
      releaseInstall = await acquireProjectDeletionLock(
        projectDeletionLockKey(workspaceOwnerId, projectName),
      );
      let writeStarted = false;
      const queuedWrite = withProjectDeletionLock({ workspaceOwnerId, projectName }, async () => {
        writeStarted = true;
        writeProjectRuntimeOwnedFileAtomic(
          projectRoot,
          'package-lock.json',
          '{"lockfileVersion":3}',
        );
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writeStarted).toBe(false);
      expect(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
        .toBe('{"lockfileVersion":2}');

      releaseInstall();
      releaseInstall = null;
      await queuedWrite;
      expect(writeStarted).toBe(true);
      expect(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
        .toBe('{"lockfileVersion":3}');
    } finally {
      releaseInstall?.();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('reuses an already-held exact lease without recursively queueing', async () => {
    const workspaceOwnerId = 'held-owner';
    const projectName = 'held-project';
    const lifecycleLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(workspaceOwnerId, projectName),
    );
    try {
      let callbackLease: unknown;
      await withProjectDeletionLock({
        workspaceOwnerId,
        projectName,
        lifecycleLock,
      }, async (heldLease) => {
        callbackLease = heldLease;
      });
      expect(callbackLease).toBe(lifecycleLock);
      expect(lifecycleLock.isHeld()).toBe(true);
    } finally {
      lifecycleLock();
    }
  });

  test('rejects an already-held lease from a different Project', async () => {
    const lifecycleLock = await acquireProjectDeletionLock(
      projectDeletionLockKey('held-owner', 'project-a'),
    );
    try {
      await expect(withProjectDeletionLock({
        workspaceOwnerId: 'held-owner',
        projectName: 'project-b',
        lifecycleLock,
      }, async () => undefined)).rejects.toThrow(/exact Project lifecycle lock/i);
      expect(lifecycleLock.isHeld()).toBe(true);
    } finally {
      lifecycleLock();
    }
  });

  test('lets an older queued mutation settle before one exact prepared-operation reacquire', async () => {
    const key = projectDeletionLockKey('handoff-owner', 'handoff-project');
    const original = await acquireProjectDeletionLock(key);
    const handoff = createExpectedPreparedProjectPromotionLockHandoff({
      lifecycleLock: original,
      operationId: '00000000-0000-4000-8000-000000000001',
      manifestDigest: 'a'.repeat(64),
    });
    let queuedAcquired = false;
    const queued = acquireProjectDeletionLock(key).then((lease) => {
      queuedAcquired = true;
      return lease;
    });

    original();
    const reacquiredPromise = reacquireExpectedPreparedProjectPromotionLock(handoff);
    const queuedLease = await queued;
    expect(queuedAcquired).toBe(true);
    let promotionReacquired = false;
    void reacquiredPromise.then(() => { promotionReacquired = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(promotionReacquired).toBe(false);

    queuedLease();
    const reacquired = await reacquiredPromise;
    assertHeldExpectedPreparedProjectPromotionLock(
      reacquired,
      handoff.operationId,
      handoff.manifestDigest,
    );
    expect(() => assertHeldExpectedPreparedProjectPromotionLock(
      reacquired,
      handoff.operationId,
      'b'.repeat(64),
    )).toThrow(/exact prepared/i);
    await expect(reacquireExpectedPreparedProjectPromotionLock(handoff))
      .rejects.toThrow(/not available/i);
    reacquired.lifecycleLock();
  });

  test.each(['DEPENDENCY_PROMOTING', 'DEPENDENCY_QUARANTINED'])(
    'rejects a copy-style mutation from lifecycle-only %s containment without filesystem evidence',
    async (lifecycleStatus) => {
      const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-lifecycle-only-'));
      const priorProjectsRoot = process.env.PORTAL_PROJECTS_ROOT;
      process.env.PORTAL_PROJECTS_ROOT = projectsRoot;
      mockReadProjectDependencyPromotionLifecycleByProject.mockResolvedValue({
        lifecycleStatus,
      });
      let mutationStarted = false;
      try {
        await expect(withProjectDeletionLock({
          workspaceOwnerId: 'missing-owner',
          projectName: 'contained-project',
        }, async () => {
          mutationStarted = true;
        })).rejects.toMatchObject({
          code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED',
          scope: 'project',
        });
        expect(mutationStarted).toBe(false);
        expect(fs.existsSync(path.join(projectsRoot, 'missing-owner'))).toBe(false);
        expect(mockReadProjectDependencyPromotionLifecycleByProject).toHaveBeenCalledWith({
          workspaceOwnerId: 'missing-owner',
          projectName: 'contained-project',
        });
      } finally {
        if (priorProjectsRoot === undefined) delete process.env.PORTAL_PROJECTS_ROOT;
        else process.env.PORTAL_PROJECTS_ROOT = priorProjectsRoot;
        fs.rmSync(projectsRoot, { recursive: true, force: true });
      }
    },
  );
});
