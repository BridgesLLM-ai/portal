import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __projectDependencyPromotionStartupRecoveryTest,
  ProjectDependencyPromotionStartupRecoveryError,
  runProjectDependencyPromotionStartupRecovery,
  type ProjectDependencyPromotionStartupRecoveryDependencies,
  type ProjectDependencyPromotionStartupTargetQuiescence,
} from './projectDependencyPromotionStartupRecovery';
import {
  inspectProjectDependencyPromotionStartupEvidence,
  type ProjectDependencyPromotionStartupEvidenceInspection,
  type ProjectDependencyPromotionStartupTarget,
} from './project-lifecycle.service';
import {
  ProjectDependencyPromotionWriterFenceError,
  type ProjectDependencyPromotionWriterFence,
} from './projectDependencyPromotionWriterFence';
import type { ProjectDependencyRepairStartupInspection } from './projectDependencyRepair';
import { BackupMutationLockContentionError } from './backup.service';

jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../config/env', () => ({ config: { portalProjectRuntimeImageId: '' } }));

const TARGET = Object.freeze<ProjectDependencyPromotionStartupTarget>({
  projectIdentityId: '11111111-1111-4111-8111-111111111111',
  projectIdentityGeneration: 7,
  workspaceOwnerId: 'owner-1',
  projectName: 'Project',
  canonicalRoot: '/srv/projects/owner-1/Project',
  rootDevice: '10',
  rootInode: '20',
  rootBirthtimeNs: '30',
  lifecycleStatus: 'DEPENDENCY_PROMOTING',
  decisionStatus: 'AUTHORIZED',
  operationIds: ['22222222-2222-4222-8222-222222222222'],
  sources: [
    {
      kind: 'decision',
      operationId: '22222222-2222-4222-8222-222222222222',
      state: 'AUTHORIZED',
      canonicalPath: null,
      contentSha256: 'a'.repeat(64),
    },
    {
      kind: 'lifecycle',
      operationId: '22222222-2222-4222-8222-222222222222',
      state: 'DEPENDENCY_PROMOTING',
      canonicalPath: '/srv/projects/owner-1/Project',
      contentSha256: null,
    },
    {
      kind: 'topology',
      operationId: '22222222-2222-4222-8222-222222222222',
      state: 'AUTHORIZED',
      canonicalPath: '/srv/projects/owner-1/Project',
      contentSha256: 'b'.repeat(64),
    },
  ],
});

function inspection(input: {
  hash: string;
  targets?: ProjectDependencyPromotionStartupTarget[];
  contained?: ProjectDependencyPromotionStartupTarget[];
  uncertain?: boolean;
}): ProjectDependencyPromotionStartupEvidenceInspection {
  const targets = input.targets || [];
  const contained = input.contained || [];
  return {
    schemaVersion: 1,
    snapshotSha256: input.hash.repeat(64).slice(0, 64),
    hasEvidence: targets.length > 0 || Boolean(input.uncertain),
    targets,
    containedQuarantines: contained,
    unboundEvidence: [],
    uncertainEvidence: input.uncertain ? [{
      code: 'UNSAFE',
      workspaceOwnerId: null,
      operationId: null,
      canonicalPath: null,
      evidenceSha256: null,
    }] : [],
  };
}

function targetQuiescence(
  phase: 'pre_drain' | 'post_drain',
  targetCount: number,
): ProjectDependencyPromotionStartupTargetQuiescence {
  return {
    phase,
    targetCount,
    appCount: 0,
    desktopRuntimeCount: 0,
    workloadCount: 0,
    projectRuntimeCleanup: [],
  };
}

const EMPTY_REPAIR_INSPECTION: ProjectDependencyRepairStartupInspection = Object.freeze({
  schemaVersion: 1,
  snapshotSha256: 'e'.repeat(64),
  hasEvidence: false,
  operationIds: [],
  operations: [],
  targets: [],
  unboundEvidence: [],
});

function emptyRepairDependencies(
  events?: string[],
): Pick<ProjectDependencyPromotionStartupRecoveryDependencies,
  'inspectRepairs' | 'recoverRepairs' | 'attestCompletedRepairs'> {
  return {
    inspectRepairs: jest.fn(async () => EMPTY_REPAIR_INSPECTION),
    recoverRepairs: jest.fn(async ({ assertExclusiveLease }) => {
      assertExclusiveLease();
      events?.push('recover-repairs');
      return { resumed: 0, completed: 0, held: 0 };
    }),
    attestCompletedRepairs: jest.fn(async () => {
      events?.push('attest-completed-repairs');
      return { attested: 0 } as any;
    }),
  };
}

function fenceFixture(events: string[]): {
  fence: ProjectDependencyPromotionWriterFence;
  release: jest.Mock;
} {
  const release = jest.fn(async (attest: () => Promise<void>) => {
    events.push('fence-release-begin');
    await attest();
    events.push('fence-release-end');
  });
  return {
    release,
    fence: {
      proveQuiescent: jest.fn(async () => {
        events.push('writer-pre-drain-post');
        return { preDrain: {} as any, postDrain: {} as any };
      }),
      assertHeld: jest.fn(),
      releaseAfterSafeState: release,
      isHeld: () => true,
    },
  };
}

describe('Project dependency promotion startup recovery coordinator', () => {
  test('retries expected backup-lock contention instead of entering an irreversible startup hold', async () => {
    jest.useFakeTimers();
    const acquired = { lease: { kind: 'backup-mutation-lock' as const }, release: jest.fn() };
    const acquire = jest.fn()
      .mockRejectedValueOnce(new BackupMutationLockContentionError(72))
      .mockResolvedValueOnce(acquired);
    const pending = __projectDependencyPromotionStartupRecoveryTest
      .acquireStartupRepairMutationLock(acquire);
    await Promise.resolve();
    expect(acquire).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(acquired);
    expect(acquire).toHaveBeenNthCalledWith(1, { timeoutSeconds: 60 });
    expect(acquire).toHaveBeenNthCalledWith(2, { timeoutSeconds: 60 });
    jest.useRealTimers();
  });

  test('holds one global fence across inventory, runtime drain, recovery, and clean release', async () => {
    const events: string[] = [];
    const initial = inspection({ hash: '1', targets: [TARGET] });
    const clean = inspection({ hash: '2' });
    const inspections = [initial, initial, clean, clean];
    const { fence } = fenceFixture(events);
    const result = await runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      ...emptyRepairDependencies(events),
      closeAdmission: jest.fn(() => {
        events.push('close-global-admission');
        return {} as any;
      }),
      closeWriterFence: jest.fn((input) => {
        events.push('close-writer-fence');
        input.closeAdmissionAndSettleInstaller();
        input.releaseProjectLease();
        events.push('startup-has-no-request-or-project-lease');
        return fence;
      }),
      inspect: jest.fn(async () => {
        events.push(`inspect-${5 - inspections.length}`);
        return inspections.shift()!;
      }),
      quiesceTargets: jest.fn(async (targets, phase) => {
        events.push(`targets-${phase}`);
        return targetQuiescence(phase, targets.length);
      }),
      recover: jest.fn(async () => {
        events.push('recover');
        return { rolledBack: 1, committed: 0, quarantined: 0, discarded: 0 };
      }),
      attestQuarantine: jest.fn(),
    });

    expect(result.releaseState).toBe('CLEAN');
    expect(result.recovery.rolledBack).toBe(1);
    expect(events).toEqual([
      'close-writer-fence',
      'close-global-admission',
      'startup-has-no-request-or-project-lease',
      'inspect-1',
      'targets-pre_drain',
      'writer-pre-drain-post',
      'targets-post_drain',
      'inspect-2',
      'recover-repairs',
      'recover',
      'inspect-3',
      'fence-release-begin',
      'attest-completed-repairs',
      'inspect-4',
      'fence-release-end',
    ]);
  });

  test('touching an empty storage root during quiescence still releases CLEAN', async () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-startup-root-'));
    const database: any = {
      $queryRaw: jest.fn(async () => []),
    };
    database.$transaction = jest.fn(async (
      callback: (transaction: any) => Promise<unknown>,
    ) => callback(database));
    const { fence, release } = fenceFixture([]);
    const inspect = jest.fn((root: string) => (
      inspectProjectDependencyPromotionStartupEvidence(root, database)
    ));
    try {
      const result = await runProjectDependencyPromotionStartupRecovery(projectsRoot, {
        ...emptyRepairDependencies(),
        closeWriterFence: jest.fn(() => fence),
        inspect,
        quiesceTargets: jest.fn(async (targets, phase) => {
          if (phase === 'pre_drain') {
            const timestamp = new Date(Date.now() - 60_000);
            fs.utimesSync(projectsRoot, timestamp, timestamp);
          }
          return targetQuiescence(phase, targets.length);
        }),
        recover: jest.fn(async () => ({
          rolledBack: 0,
          committed: 0,
          quarantined: 0,
          discarded: 0,
        })),
      });

      expect(result.releaseState).toBe('CLEAN');
      expect(result.quiescentInspection.snapshotSha256)
        .toBe(result.initialInspection.snapshotSha256);
      expect(inspect).toHaveBeenCalledTimes(4);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
    }
  });

  test('retains the global fence when a tracked writer remains', async () => {
    const initial = inspection({ hash: '1', targets: [TARGET] });
    const recover = jest.fn();
    const releaseAfterSafeState = jest.fn();
    const fence: ProjectDependencyPromotionWriterFence = {
      proveQuiescent: jest.fn(async () => {
        throw new ProjectDependencyPromotionWriterFenceError('residual writer');
      }),
      assertHeld: jest.fn(),
      releaseAfterSafeState,
      isHeld: () => true,
    };
    await expect(runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      ...emptyRepairDependencies(),
      closeWriterFence: jest.fn(() => fence),
      inspect: jest.fn(async () => initial),
      quiesceTargets: jest.fn(async (targets, phase) => targetQuiescence(phase, targets.length)),
      recover,
    })).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      fenceRetained: true,
    });
    expect(recover).not.toHaveBeenCalled();
    expect(releaseAfterSafeState).not.toHaveBeenCalled();
  });

  test('the default exact-target lane retires App, desktop, workload, and provider runtimes', async () => {
    const events: string[] = [];
    const identity = {
      id: TARGET.projectIdentityId,
      generation: TARGET.projectIdentityGeneration,
      workspaceOwnerId: TARGET.workspaceOwnerId,
      projectName: TARGET.projectName,
      canonicalRoot: TARGET.canonicalRoot,
      rootDevice: TARGET.rootDevice,
      rootInode: TARGET.rootInode,
      rootBirthtimeNs: TARGET.rootBirthtimeNs,
      lifecycleStatus: TARGET.lifecycleStatus,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const cleanupResult = {
      projectIdentityId: TARGET.projectIdentityId,
      actorCount: 1,
      bindingCount: 0,
      sessionCount: 0,
      quiescedTurnCount: 0,
      removedResourceCount: 1,
      alreadyClean: false,
    };
    const result = await __projectDependencyPromotionStartupRecoveryTest.defaultQuiesceTargets(
      [TARGET],
      'pre_drain',
      {
        projectIdentity: { findUnique: jest.fn(async () => identity) },
        app: { findMany: jest.fn(async () => [{
          id: 'app-1',
          userId: TARGET.workspaceOwnerId,
          name: TARGET.projectName,
          projectIdentityId: TARGET.projectIdentityId,
          deployType: 'fullstack',
          zipPath: '/srv/apps/owner-1-Project',
          port: 4500,
        }]) },
      },
      {
        forgetApp: jest.fn(async () => { events.push('app'); }),
        quiesceDesktop: jest.fn(() => {
          events.push('desktop');
          return { systemdUnitStopped: true, processCount: 1 };
        }),
        removeWorkloads: jest.fn(async () => {
          events.push('workloads');
          return 2;
        }),
        cleanupProject: jest.fn(async () => {
          events.push('providers');
          return cleanupResult;
        }),
        createCleanupAdapters: jest.fn(() => ({} as any)),
        createEgressAdapter: jest.fn(() => ({} as any)),
      },
    );
    expect(events).toEqual(['app', 'desktop', 'workloads', 'providers']);
    expect(result).toMatchObject({
      phase: 'pre_drain',
      targetCount: 1,
      appCount: 1,
      desktopRuntimeCount: 1,
      workloadCount: 2,
      projectRuntimeCleanup: [cleanupResult],
    });
  });

  test('retains the fence when an exact target desktop writer cannot be stopped', async () => {
    const initial = inspection({ hash: '1', targets: [TARGET] });
    const { fence, release } = fenceFixture([]);
    const proveQuiescent = fence.proveQuiescent as jest.Mock;
    const recover = jest.fn();
    await expect(runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      ...emptyRepairDependencies(),
      closeWriterFence: jest.fn(() => fence),
      inspect: jest.fn(async () => initial),
      database: {
        projectIdentity: { findUnique: jest.fn(async () => ({
          id: TARGET.projectIdentityId,
          generation: TARGET.projectIdentityGeneration,
          workspaceOwnerId: TARGET.workspaceOwnerId,
          projectName: TARGET.projectName,
          canonicalRoot: TARGET.canonicalRoot,
          rootDevice: TARGET.rootDevice,
          rootInode: TARGET.rootInode,
          rootBirthtimeNs: TARGET.rootBirthtimeNs,
          lifecycleStatus: TARGET.lifecycleStatus,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })) },
        app: { findMany: jest.fn(async () => []) },
      },
      targetRuntimes: {
        quiesceDesktop: jest.fn(() => { throw new Error('desktop residual'); }),
      },
      recover,
    })).rejects.toThrow('desktop residual');
    expect(proveQuiescent).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test('does not mutate recovery evidence when the post-drain snapshot changed', async () => {
    const initial = inspection({ hash: '1', targets: [TARGET] });
    const changed = inspection({ hash: '2', targets: [TARGET] });
    const inspect = jest.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    const recover = jest.fn();
    const { fence, release } = fenceFixture([]);
    await expect(runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      ...emptyRepairDependencies(),
      closeWriterFence: jest.fn(() => fence),
      inspect,
      quiesceTargets: jest.fn(async (targets, phase) => targetQuiescence(phase, targets.length)),
      recover,
    })).rejects.toBeInstanceOf(ProjectDependencyPromotionStartupRecoveryError);
    expect(recover).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test('releases only after each exact quarantined Project passes durable DB attestation', async () => {
    const initial = inspection({ hash: '1', targets: [TARGET] });
    const quarantinedTarget: ProjectDependencyPromotionStartupTarget = {
      ...TARGET,
      lifecycleStatus: 'DEPENDENCY_QUARANTINED',
      sources: TARGET.sources.map((source) => (
        source.kind === 'lifecycle'
          ? { ...source, state: 'DEPENDENCY_QUARANTINED' }
          : source
      )),
    };
    const final = inspection({
      hash: '2',
      targets: [quarantinedTarget],
      contained: [quarantinedTarget],
    });
    const inspect = jest.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(final)
      .mockResolvedValueOnce(final);
    const attestQuarantine = jest.fn(async () => undefined);
    const { fence, release } = fenceFixture([]);
    const result = await runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      ...emptyRepairDependencies(),
      closeWriterFence: jest.fn(() => fence),
      inspect,
      quiesceTargets: jest.fn(async (targets, phase) => targetQuiescence(phase, targets.length)),
      recover: jest.fn(async () => ({ rolledBack: 0, committed: 0, quarantined: 1, discarded: 0 })),
      attestQuarantine,
    });
    expect(result.releaseState).toBe('CONTAINED');
    expect(attestQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      operationId: TARGET.operationIds[0],
      manifestDigest: 'a'.repeat(64),
      projectIdentityId: TARGET.projectIdentityId,
      projectIdentityGeneration: TARGET.projectIdentityGeneration,
      expectedState: 'DEPENDENCY_QUARANTINED',
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('retains the fence when final evidence is neither absent nor exactly quarantined', async () => {
    const initial = inspection({ hash: '1', targets: [TARGET] });
    const ambiguous = inspection({ hash: '2', targets: [TARGET], uncertain: true });
    const inspect = jest.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(ambiguous)
      .mockResolvedValueOnce(ambiguous);
    const { fence } = fenceFixture([]);
    await expect(runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      ...emptyRepairDependencies(),
      closeWriterFence: jest.fn(() => fence),
      inspect,
      quiesceTargets: jest.fn(async (targets, phase) => targetQuiescence(phase, targets.length)),
      recover: jest.fn(async () => ({ rolledBack: 0, committed: 0, quarantined: 0, discarded: 0 })),
      attestQuarantine: jest.fn(),
    })).rejects.toBeInstanceOf(ProjectDependencyPromotionStartupRecoveryError);
  });

  test('holds the installer and backup mutation lease through repair replay and release attestation', async () => {
    const events: string[] = [];
    const clean = inspection({ hash: 'c' });
    const repairEvidence: ProjectDependencyRepairStartupInspection = {
      ...EMPTY_REPAIR_INSPECTION,
      snapshotSha256: 'r'.repeat(64),
      hasEvidence: true,
      operationIds: [TARGET.operationIds[0]],
      targets: [TARGET],
    };
    const repairInspections = [
      repairEvidence,
      repairEvidence,
      EMPTY_REPAIR_INSPECTION,
      EMPTY_REPAIR_INSPECTION,
      EMPTY_REPAIR_INSPECTION,
    ];
    const lease = { kind: 'backup-mutation-lock' as const };
    let leaseHeld = true;
    const assertRepairMutationLock = jest.fn((inputLease: typeof lease) => {
      if (inputLease !== lease) throw new Error('unexpected repair mutation lease');
      if (!leaseHeld) throw new Error('repair mutation lease was released early');
      events.push('assert-repair-lease');
    });
    const release = jest.fn(async () => {
      events.push('release-repair-lease');
      leaseHeld = false;
    });
    const { fence } = fenceFixture(events);
    const result = await runProjectDependencyPromotionStartupRecovery('/srv/projects', {
      closeWriterFence: jest.fn(() => fence),
      inspect: jest.fn(async () => clean),
      inspectRepairs: jest.fn(async () => repairInspections.shift()!),
      quiesceTargets: jest.fn(async (targets, phase) => targetQuiescence(phase, targets.length)),
      acquireRepairMutationLock: jest.fn(async () => ({ lease, release })),
      assertRepairMutationLock,
      recoverRepairs: jest.fn(async ({ assertExclusiveLease }) => {
        events.push('recover-repairs-begin');
        assertExclusiveLease();
        events.push('recover-repairs-end');
        return { resumed: 1, completed: 1, held: 0 };
      }),
      recover: jest.fn(async () => {
        assertRepairMutationLock(lease);
        events.push('recover-generic');
        return { rolledBack: 0, committed: 0, quarantined: 0, discarded: 0 };
      }),
      attestCompletedRepairs: jest.fn(async () => {
        assertRepairMutationLock(lease);
        events.push('attest-completed-repairs');
        return { attested: 1 } as any;
      }),
    });
    expect(result.repairRecovery).toEqual({ resumed: 1, completed: 1, held: 0 });
    expect(assertRepairMutationLock).toHaveBeenCalled();
    expect(events.indexOf('release-repair-lease')).toBeGreaterThan(events.indexOf('fence-release-end'));
    expect(leaseHeld).toBe(false);
  });

  test('server invokes the coordinator before runtime restoration or the real listener', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    const coordinator = serverSource.indexOf('await runProjectDependencyPromotionStartupRecovery(');
    expect(coordinator).toBeGreaterThan(serverSource.indexOf("await prisma.$queryRaw`SELECT 1`"));
    expect(coordinator).toBeLessThan(serverSource.indexOf('await initializeTerminalSystemdScopeRuntime();'));
    expect(coordinator).toBeLessThan(serverSource.indexOf('await initializeAppProcessRuntime();'));
    expect(coordinator).toBeLessThan(serverSource.indexOf('httpServer.listen(config.port', coordinator));
    expect(serverSource).not.toContain('await recoverInterruptedProjectLifecycleArtifactPromotions(');
  });
});
