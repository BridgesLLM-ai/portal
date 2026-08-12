import { prisma } from '../config/database';
import { forgetAppRuntime } from './app-process.service';
import {
  inspectProjectDependencyPromotionStartupEvidence,
  recoverInterruptedProjectLifecycleArtifactPromotions,
  type ProjectDependencyPromotionStartupEvidenceInspection,
  type ProjectDependencyPromotionStartupTarget,
} from './project-lifecycle.service';
import {
  attestProjectDependencyPromotionFenceReleaseState,
} from './projectDependencyPromotionDecision';
import {
  closeProjectDependencyPromotionWriterFence,
  ProjectDependencyPromotionWriterFenceError,
  type ProjectDependencyPromotionWriterFence,
} from './projectDependencyPromotionWriterFence';
import {
  closeGlobalWorkspaceAuthorizationAdmission,
  type WorkspaceAuthorizationFenceController,
} from './workspaceAuthorizationBarrier';
import { projectRuntimeManagement } from './projectRuntimeManagement';
import {
  cleanupProjectRuntime,
  type ProjectRuntimeCleanupResult,
} from './projectRuntimeCleanup';
import { createDefaultProjectRuntimeCleanupAdapters } from './projectRuntimeCleanupAdapters';
import { createProjectAuthorizationEgressCleanupAdapter } from './projectEgressCleanupAdapter';
import { removePortalProjectWorkloadsForProject } from './projectWorkloadRuntime';
import { quiesceProjectDesktopRuntimeForDependencyPromotion } from './projectDesktopRuntime';
import {
  inspectProjectDependencyRepairStartupEvidence,
  attestCompletedProjectDependencyRepairReceipts,
  recoverInterruptedProjectDependencyRepairs,
  verifyProjectDependencyRepairBackupArchive,
  type ProjectDependencyRepairStartupInspection,
  type RecoverProjectDependencyRepairsResult,
} from './projectDependencyRepair';
import {
  acquireBackupMutationLock,
  assertBackupMutationLockLease,
  BackupMutationLockContentionError,
} from './backup.service';

export const PROJECT_DEPENDENCY_PROMOTION_STARTUP_RECOVERY_CODE =
  'PROJECT_DEPENDENCY_PROMOTION_STARTUP_RECOVERY_UNPROVEN';

export class ProjectDependencyPromotionStartupRecoveryError extends Error {
  readonly code = PROJECT_DEPENDENCY_PROMOTION_STARTUP_RECOVERY_CODE;
  readonly fenceRetained = true;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectDependencyPromotionStartupRecoveryError';
  }
}

export type ProjectDependencyPromotionStartupQuiescencePhase = 'pre_drain' | 'post_drain';

export interface ProjectDependencyPromotionStartupTargetQuiescence {
  phase: ProjectDependencyPromotionStartupQuiescencePhase;
  targetCount: number;
  appCount: number;
  desktopRuntimeCount: number;
  workloadCount: number;
  projectRuntimeCleanup: ProjectRuntimeCleanupResult[];
}

export interface ProjectDependencyPromotionStartupRecoveryResult {
  initialInspection: ProjectDependencyPromotionStartupEvidenceInspection;
  initialRepairInspection: ProjectDependencyRepairStartupInspection;
  quiescentInspection: ProjectDependencyPromotionStartupEvidenceInspection;
  quiescentRepairInspection: ProjectDependencyRepairStartupInspection;
  finalInspection: ProjectDependencyPromotionStartupEvidenceInspection;
  finalRepairInspection: ProjectDependencyRepairStartupInspection;
  preDrainTargets: ProjectDependencyPromotionStartupTargetQuiescence;
  postDrainTargets: ProjectDependencyPromotionStartupTargetQuiescence;
  recovery: {
    rolledBack: number;
    committed: number;
    quarantined: number;
    discarded: number;
  };
  repairRecovery: RecoverProjectDependencyRepairsResult;
  releaseState: 'CLEAN' | 'CONTAINED';
}

interface StartupRecoveryDatabase {
  projectIdentity: {
    findUnique(args: unknown): Promise<any | null>;
  };
  app: {
    findMany(args: unknown): Promise<any[]>;
  };
}

interface StartupTargetRuntimeDependencies {
  database: StartupRecoveryDatabase;
  forgetApp: typeof forgetAppRuntime;
  quiesceDesktop: typeof quiesceProjectDesktopRuntimeForDependencyPromotion;
  removeWorkloads: typeof removePortalProjectWorkloadsForProject;
  cleanupProject: typeof cleanupProjectRuntime;
  createCleanupAdapters: typeof createDefaultProjectRuntimeCleanupAdapters;
  createEgressAdapter: typeof createProjectAuthorizationEgressCleanupAdapter;
}

export interface ProjectDependencyPromotionStartupRecoveryDependencies {
  closeAdmission?: () => WorkspaceAuthorizationFenceController;
  closeWriterFence?: typeof closeProjectDependencyPromotionWriterFence;
  inspect?: typeof inspectProjectDependencyPromotionStartupEvidence;
  inspectRepairs?: typeof inspectProjectDependencyRepairStartupEvidence;
  recover?: typeof recoverInterruptedProjectLifecycleArtifactPromotions;
  recoverRepairs?: typeof recoverInterruptedProjectDependencyRepairs;
  reverifyRepairBackup?: typeof verifyProjectDependencyRepairBackupArchive;
  attestCompletedRepairs?: typeof attestCompletedProjectDependencyRepairReceipts;
  acquireRepairMutationLock?: typeof acquireBackupMutationLock;
  assertRepairMutationLock?: typeof assertBackupMutationLockLease;
  quiesceTargets?: (
    targets: readonly ProjectDependencyPromotionStartupTarget[],
    phase: ProjectDependencyPromotionStartupQuiescencePhase,
  ) => Promise<ProjectDependencyPromotionStartupTargetQuiescence>;
  attestQuarantine?: typeof attestProjectDependencyPromotionFenceReleaseState;
  database?: StartupRecoveryDatabase;
  targetRuntimes?: Partial<Omit<StartupTargetRuntimeDependencies, 'database'>>;
}

function exactTargetKey(target: ProjectDependencyPromotionStartupTarget): string {
  return [
    target.projectIdentityId,
    target.projectIdentityGeneration,
    target.workspaceOwnerId,
    target.projectName,
    target.canonicalRoot,
    target.rootDevice,
    target.rootInode,
    target.rootBirthtimeNs,
  ].join('\0');
}

function exactIdentityMatchesTarget(identity: any, target: ProjectDependencyPromotionStartupTarget): boolean {
  return Boolean(
    identity
    && identity.id === target.projectIdentityId
    && Number(identity.generation) === target.projectIdentityGeneration
    && identity.workspaceOwnerId === target.workspaceOwnerId
    && identity.projectName === target.projectName
    && identity.canonicalRoot === target.canonicalRoot
    && identity.rootDevice === target.rootDevice
    && identity.rootInode === target.rootInode
    && identity.rootBirthtimeNs === target.rootBirthtimeNs
    && (
      target.lifecycleStatus
        ? identity.lifecycleStatus === target.lifecycleStatus
        : identity.lifecycleStatus === 'ACTIVE'
    )
  );
}

async function defaultQuiesceTargets(
  targets: readonly ProjectDependencyPromotionStartupTarget[],
  phase: ProjectDependencyPromotionStartupQuiescencePhase,
  database: StartupRecoveryDatabase = prisma as unknown as StartupRecoveryDatabase,
  overrides: Partial<Omit<StartupTargetRuntimeDependencies, 'database'>> = {},
): Promise<ProjectDependencyPromotionStartupTargetQuiescence> {
  const runtime: StartupTargetRuntimeDependencies = {
    database,
    forgetApp: overrides.forgetApp || forgetAppRuntime,
    quiesceDesktop: overrides.quiesceDesktop
      || quiesceProjectDesktopRuntimeForDependencyPromotion,
    removeWorkloads: overrides.removeWorkloads || removePortalProjectWorkloadsForProject,
    cleanupProject: overrides.cleanupProject || cleanupProjectRuntime,
    createCleanupAdapters: overrides.createCleanupAdapters
      || createDefaultProjectRuntimeCleanupAdapters,
    createEgressAdapter: overrides.createEgressAdapter
      || createProjectAuthorizationEgressCleanupAdapter,
  };
  const ordered = [...targets].sort((left, right) => exactTargetKey(left).localeCompare(exactTargetKey(right)));
  if (new Set(ordered.map(exactTargetKey)).size !== ordered.length) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Startup dependency-promotion inventory contains duplicate exact Project targets.',
    );
  }
  let appCount = 0;
  let desktopRuntimeCount = 0;
  let workloadCount = 0;
  const projectRuntimeCleanup: ProjectRuntimeCleanupResult[] = [];

  for (const target of ordered) {
    const identity = await runtime.database.projectIdentity.findUnique({
      where: { id: target.projectIdentityId },
    });
    if (!exactIdentityMatchesTarget(identity, target)) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'An exact Project identity changed while startup recovery was quiescing runtimes.',
      );
    }
    const apps = await runtime.database.app.findMany({
      where: { projectIdentityId: target.projectIdentityId },
      orderBy: { id: 'asc' },
    });
    if (apps.length > 1) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'More than one App claims an exact dependency-promotion Project identity.',
      );
    }
    const app = apps[0] || null;
    if (app && (app.userId !== target.workspaceOwnerId || app.name !== target.projectName)) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'A Project App changed its immutable owner/name binding during startup recovery.',
      );
    }
    const recordedDesktopDirectories: string[] = [];
    if (app) {
      const management = projectRuntimeManagement(app);
      if (management === 'external-loopback' || management === 'invalid-external-binding') {
        throw new ProjectDependencyPromotionStartupRecoveryError(
          'An operator-managed Project runtime cannot be proven quiescent for dependency recovery.',
        );
      }
      if (management === 'portal-container') {
        const deployId = `${target.workspaceOwnerId}-${target.projectName}`;
        await runtime.forgetApp(app.id, deployId, {
          actorId: target.workspaceOwnerId,
          projectId: target.projectIdentityId,
          deployPath: app.zipPath,
          port: app.port,
        }, { settleStatus: 'stopped' });
        appCount += 1;
      } else if (management === 'desktop-session') {
        recordedDesktopDirectories.push(app.zipPath);
      }
    }

    const desktop = runtime.quiesceDesktop({
      projectIdentityId: target.projectIdentityId,
      projectName: target.projectName,
      recordedRuntimeDirectories: recordedDesktopDirectories,
    });
    if (desktop.systemdUnitStopped || desktop.processCount > 0) desktopRuntimeCount += 1;

    workloadCount += await runtime.removeWorkloads(target.projectIdentityId);
    projectRuntimeCleanup.push(await runtime.cleanupProject({
      authenticatedActorId: target.workspaceOwnerId,
      workspaceOwnerId: target.workspaceOwnerId,
      projectIdentity: identity,
      lifecycleReason: 'dependency_promotion',
    }, {
      adapters: runtime.createCleanupAdapters(),
      egressAdapter: runtime.createEgressAdapter(),
    }));
  }
  return Object.freeze({
    phase,
    targetCount: ordered.length,
    appCount,
    desktopRuntimeCount,
    workloadCount,
    projectRuntimeCleanup,
  });
}

function assertComparableStableInspection(
  initial: ProjectDependencyPromotionStartupEvidenceInspection,
  quiescent: ProjectDependencyPromotionStartupEvidenceInspection,
): void {
  if (
    initial.schemaVersion !== quiescent.schemaVersion
    || initial.snapshotSha256 !== quiescent.snapshotSha256
  ) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Dependency-promotion evidence changed while startup recovery quiesced writers.',
    );
  }
}

function assertComparableStableRepairInspection(
  initial: ProjectDependencyRepairStartupInspection,
  quiescent: ProjectDependencyRepairStartupInspection,
): void {
  if (initial.schemaVersion !== quiescent.schemaVersion
    || initial.snapshotSha256 !== quiescent.snapshotSha256) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Dependency-repair evidence changed while startup recovery quiesced writers.',
    );
  }
}

function combinedStartupTargets(
  promotion: ProjectDependencyPromotionStartupEvidenceInspection,
  repair: ProjectDependencyRepairStartupInspection,
): ProjectDependencyPromotionStartupTarget[] {
  const combined = new Map<string, ProjectDependencyPromotionStartupTarget>();
  for (const target of [...promotion.targets, ...repair.targets]) {
    const key = exactTargetKey(target);
    const prior = combined.get(key);
    if (prior && prior.lifecycleStatus !== target.lifecycleStatus) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'Promotion and repair inventories disagree on the exact Project lifecycle.',
      );
    }
    combined.set(key, prior || target);
  }
  return [...combined.values()].sort((left, right) => exactTargetKey(left).localeCompare(exactTargetKey(right)));
}

async function acquireStartupRepairMutationLock(
  acquire: typeof acquireBackupMutationLock,
): Promise<Awaited<ReturnType<typeof acquireBackupMutationLock>>> {
  for (;;) {
    try {
      // A running backup is expected contention, not evidence corruption.
      // Retry while the bootstrap status listener remains available instead
      // of converting an ordinary >60s backup into an irreversible hold.
      return await acquire({ timeoutSeconds: 60 });
    } catch (error) {
      if (!(error instanceof BackupMutationLockContentionError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

function exactContainedTargets(
  inspection: ProjectDependencyPromotionStartupEvidenceInspection,
): Array<{
  target: ProjectDependencyPromotionStartupTarget;
  operationId: string;
  manifestDigest: string;
}> {
  if (inspection.uncertainEvidence.length > 0 || inspection.unboundEvidence.length > 0) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Dependency-promotion recovery left unbound or uncertain evidence.',
    );
  }
  if (inspection.targets.length !== inspection.containedQuarantines.length) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Dependency-promotion recovery did not converge every exact target to quarantine.',
    );
  }
  if (inspection.targets.length === 0) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'The non-empty dependency-promotion release inventory has no exact targets.',
    );
  }
  return inspection.targets.map((target) => {
    if (target.lifecycleStatus !== 'DEPENDENCY_QUARANTINED') {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'Dependency-promotion recovery left a target outside durable quarantine.',
      );
    }
    const decisions = target.sources.filter((source) => source.kind === 'decision');
    const operationId = String(decisions[0]?.operationId || '');
    const manifestDigest = String(decisions[0]?.contentSha256 || '');
    if (
      decisions.length !== 1
      || !operationId
      || !/^[a-f0-9]{64}$/.test(manifestDigest)
      || !['AUTHORIZED', 'APPLIED'].includes(String(decisions[0].state || ''))
      || target.operationIds.length !== 1
      || target.operationIds[0] !== operationId
    ) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'A quarantined Project lacks one exact durable promotion decision.',
      );
    }
    if (!target.sources.some((source) => (
      source.kind === 'topology'
      && source.operationId === operationId
      && /^[a-f0-9]{64}$/.test(String(source.contentSha256 || ''))
    ))) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'A quarantined Project lacks a current filesystem topology attestation.',
      );
    }
    return {
      target,
      operationId,
      manifestDigest,
    };
  });
}

async function attestReleaseState(input: {
  expected: ProjectDependencyPromotionStartupEvidenceInspection;
  projectsRoot: string;
  inspect: typeof inspectProjectDependencyPromotionStartupEvidence;
  attestQuarantine: typeof attestProjectDependencyPromotionFenceReleaseState;
}): Promise<'CLEAN' | 'CONTAINED'> {
  const immediate = await input.inspect(input.projectsRoot);
  assertComparableStableInspection(input.expected, immediate);
  if (!immediate.hasEvidence) {
    if (
      immediate.targets.length !== 0
      || immediate.containedQuarantines.length !== 0
      || immediate.unboundEvidence.length !== 0
      || immediate.uncertainEvidence.length !== 0
    ) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'The empty dependency-promotion release inventory is internally inconsistent.',
      );
    }
    return 'CLEAN';
  }
  const contained = exactContainedTargets(immediate);
  for (const { target, operationId, manifestDigest } of contained) {
    await input.attestQuarantine({
      operationId,
      manifestDigest,
      projectIdentityId: target.projectIdentityId,
      projectIdentityGeneration: target.projectIdentityGeneration,
      workspaceOwnerId: target.workspaceOwnerId,
      projectName: target.projectName,
      destinationCanonicalRoot: target.canonicalRoot,
      destinationRootDevice: target.rootDevice,
      destinationRootInode: target.rootInode,
      destinationRootBirthtimeNs: target.rootBirthtimeNs,
      expectedState: 'DEPENDENCY_QUARANTINED',
    });
  }
  return 'CONTAINED';
}

/**
 * Startup's sole dependency-promotion reconciliation coordinator. It owns one
 * process-global writer fence from the first DB+filesystem inventory through
 * runtime quiescence, recovery, final inventory and release attestation.
 *
 * Startup is not an admitted HTTP mutation, so it has no request to exclude
 * from the drain. Live dependency installation continues to use the separate
 * closeGlobalWorkspaceAuthorizationAdmissionExcludingRequest path.
 */
export async function runProjectDependencyPromotionStartupRecovery(
  projectsRoot: string,
  dependencies: ProjectDependencyPromotionStartupRecoveryDependencies = {},
): Promise<ProjectDependencyPromotionStartupRecoveryResult> {
  const inspect = dependencies.inspect || inspectProjectDependencyPromotionStartupEvidence;
  const inspectRepairs = dependencies.inspectRepairs
    || inspectProjectDependencyRepairStartupEvidence;
  const recover = dependencies.recover || recoverInterruptedProjectLifecycleArtifactPromotions;
  const recoverRepairs = dependencies.recoverRepairs
    || recoverInterruptedProjectDependencyRepairs;
  const reverifyRepairBackup = dependencies.reverifyRepairBackup
    || verifyProjectDependencyRepairBackupArchive;
  const attestCompletedRepairs = dependencies.attestCompletedRepairs
    || attestCompletedProjectDependencyRepairReceipts;
  const acquireRepairMutationLock = dependencies.acquireRepairMutationLock
    || acquireBackupMutationLock;
  const assertRepairMutationLock = dependencies.assertRepairMutationLock
    || assertBackupMutationLockLease;
  const attestQuarantine = dependencies.attestQuarantine
    || attestProjectDependencyPromotionFenceReleaseState;
  const quiesceTargets = dependencies.quiesceTargets
    || ((targets, phase) => defaultQuiesceTargets(
      targets,
      phase,
      dependencies.database,
      dependencies.targetRuntimes,
    ));
  const closeAdmission = dependencies.closeAdmission || closeGlobalWorkspaceAuthorizationAdmission;
  const closeWriterFence = dependencies.closeWriterFence
    || closeProjectDependencyPromotionWriterFence;
  let fence: ProjectDependencyPromotionWriterFence;
  try {
    fence = closeWriterFence({
      closeAdmissionAndSettleInstaller: closeAdmission,
      // Startup has no exact Project lease and no admitted request. This no-op
      // is deliberate; only the live installer releases a handoff lease here.
      releaseProjectLease: () => undefined,
    });
  } catch (error) {
    if (error instanceof ProjectDependencyPromotionWriterFenceError) throw error;
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Global Project mutation admission could not be closed for startup recovery.',
    );
  }

  const [initialInspection, initialRepairInspection] = await Promise.all([
    inspect(projectsRoot),
    inspectRepairs({ projectsRoot, database: dependencies.database as any }),
  ]);
  const initialTargets = combinedStartupTargets(initialInspection, initialRepairInspection);
  const preDrainTargets = await quiesceTargets(initialTargets, 'pre_drain');
  await fence.proveQuiescent();
  const postDrainTargets = await quiesceTargets(initialTargets, 'post_drain');
  const [quiescentInspection, quiescentRepairInspection] = await Promise.all([
    inspect(projectsRoot),
    inspectRepairs({ projectsRoot, database: dependencies.database as any }),
  ]);
  assertComparableStableInspection(initialInspection, quiescentInspection);
  assertComparableStableRepairInspection(initialRepairInspection, quiescentRepairInspection);
  if (quiescentInspection.uncertainEvidence.length > 0) {
    throw new ProjectDependencyPromotionStartupRecoveryError(
      'Startup dependency-promotion inventory is uncertain; recovery remains globally held.',
    );
  }

  const repairMutationLock = quiescentRepairInspection.hasEvidence
    ? await acquireStartupRepairMutationLock(acquireRepairMutationLock)
    : null;
  try {
    const assertRepairMutationLease = repairMutationLock
      ? () => assertRepairMutationLock(repairMutationLock.lease)
      : () => undefined;
    assertRepairMutationLease();
    const repairRecovery = await recoverRepairs({
      expectedInspection: quiescentRepairInspection,
      reverifyBackup: reverifyRepairBackup,
      assertExclusiveLease: assertRepairMutationLease,
      database: dependencies.database as any,
    });
    assertRepairMutationLease();
    const postRepairInspection = await inspectRepairs({
      projectsRoot,
      database: dependencies.database as any,
    });
    if (postRepairInspection.hasEvidence) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'Startup dependency repair did not converge every durable repair receipt.',
      );
    }
    // Repair-owned decisions are removed only after exact all-new verification.
    // Therefore any decision still visible here is necessarily generic recovery
    // work and cannot be reinterpreted while a non-complete repair owns it.
    const recovery = await recover(projectsRoot, dependencies.database as any, {
      protectedRepairOperationIds: quiescentRepairInspection.operationIds,
    });
    const [finalInspection, finalRepairInspection] = await Promise.all([
      inspect(projectsRoot),
      inspectRepairs({ projectsRoot, database: dependencies.database as any }),
    ]);
    if (finalRepairInspection.hasEvidence) {
      throw new ProjectDependencyPromotionStartupRecoveryError(
        'Dependency repair evidence reappeared before startup fence release.',
      );
    }
    let releaseState: 'CLEAN' | 'CONTAINED' = 'CLEAN';
    await fence.releaseAfterSafeState(async () => {
      assertRepairMutationLease();
      const immediateRepair = await inspectRepairs({
        projectsRoot,
        database: dependencies.database as any,
      });
      assertComparableStableRepairInspection(finalRepairInspection, immediateRepair);
      if (immediateRepair.hasEvidence) {
        throw new ProjectDependencyPromotionStartupRecoveryError(
          'Dependency repair evidence changed before startup fence release.',
        );
      }
      await attestCompletedRepairs({
        expected: initialRepairInspection.operations,
        database: dependencies.database as any,
      });
      releaseState = await attestReleaseState({
        expected: finalInspection,
        projectsRoot,
        inspect,
        attestQuarantine,
      });
    });
    return Object.freeze({
      initialInspection,
      initialRepairInspection,
      quiescentInspection,
      quiescentRepairInspection,
      finalInspection,
      finalRepairInspection,
      preDrainTargets,
      postDrainTargets,
      recovery,
      repairRecovery,
      releaseState,
    });
  } finally {
    await repairMutationLock?.release();
  }
}

export const __projectDependencyPromotionStartupRecoveryTest = {
  assertComparableStableInspection,
  assertComparableStableRepairInspection,
  combinedStartupTargets,
  defaultQuiesceTargets,
  exactContainedTargets,
  acquireStartupRepairMutationLock,
};
