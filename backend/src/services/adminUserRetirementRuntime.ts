import { Prisma } from '@prisma/client';
import { MailboxReconciliationPendingError } from './mailboxReconciliation';
import {
  projectAuthorizationTransitionCoordinator,
  type ProjectUserRetirementAdmissionResult,
  type ProjectUserRetirementSealResult,
} from './projectAuthorizationTransition';
import {
  AdminUserRetirementBusyError,
  AdminUserRetirementIntegrityError,
  PrismaAdminUserRetirementStore,
  createAdminUserRetirementJournal,
  recoverUnfinishedAdminUserRetirements,
  runAdminUserRetirement,
  type AdminUserRetirementManifestV1,
  type AdminUserRetirementRecord,
  type AdminUserRetirementRunner,
  type AdminUserRetirementRunnerContext,
  type AdminUserRetirementRecoveryBlock,
  type AdminUserRetirementStore,
} from './adminUserRetirementLedger';
import {
  buildAdminUserRetirementManifestSnapshot,
  digestAdminUserRetirementSnapshot,
} from './adminUserRetirementManifest';
import {
  retireAdminUserSharedActorState,
} from './adminUserRetirementSharedActorState';
import {
  retireAdminUserExternalState,
  verifyAdminUserExternalStateAbsence,
} from './adminUserRetirementExternalState';
import {
  assertAdminUserDatabaseAbsence,
  commitAdminUserDatabaseDeletion,
} from './adminUserRetirementDatabaseCommit';

type RetirementTransitionCoordinator = {
  sealUserRetirementAdmission?(input: {
    initiatedByUserId: string;
    targetUserId: string;
    expectedTargetEmailDigest: string;
  }): Promise<ProjectUserRetirementSealResult>;
  closeUserRetirementAdmission(input: {
    retirementId: string;
    initiatedByUserId: string;
    targetUserId: string;
    manifestDigest: string;
    targetAuthorizationVersion: number;
  }): Promise<ProjectUserRetirementAdmissionResult>;
};

export type AdminUserRetirementRuntimeDependencies = {
  transitionCoordinator?: RetirementTransitionCoordinator;
  buildManifest?(
    targetUserId: string,
    requestedByUserId: string,
  ): Promise<AdminUserRetirementManifestV1>;
  retireOwnedProject?(input: {
    targetUserId: string;
    requestedByOwnerId: string;
    project: AdminUserRetirementManifestV1['ownedProjects'][number];
  }): Promise<void>;
  retireSharedActorState?(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  retireExternalState?(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  verifyExternalAbsence?(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<{ evidenceDigest: string }>;
  commitDatabaseDeletion?(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  verifyDatabaseAbsence?(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
};

export class AdminUserRetirementRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AdminUserRetirementRequestError';
  }
}

export type AdminUserRetirementStartupRecoverySummary = Readonly<{
  recovered: readonly string[];
  blocked: readonly AdminUserRetirementRecoveryBlock[];
  busy: readonly string[];
}>;

let startupRecoverySummary: AdminUserRetirementStartupRecoverySummary = Object.freeze({
  recovered: Object.freeze([]),
  blocked: Object.freeze([]),
  busy: Object.freeze([]),
});

function boundedStartupRecoverySummary(
  value: AdminUserRetirementStartupRecoverySummary,
): AdminUserRetirementStartupRecoverySummary {
  return Object.freeze({
    recovered: Object.freeze(value.recovered.slice(0, 1_000)),
    blocked: Object.freeze(value.blocked.slice(0, 1_000).map((entry) => Object.freeze({
      retirementId: String(entry.retirementId).slice(0, 200),
      targetUserId: String(entry.targetUserId).slice(0, 200),
      errorCode: String(entry.errorCode)
        .replace(/[^A-Za-z0-9_.-]/g, '_')
        .slice(0, 120) || 'RETIREMENT_STEP_FAILED',
    }))),
    busy: Object.freeze(value.busy.slice(0, 1_000).map((targetUserId) => (
      String(targetUserId).replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 200)
    ))),
  });
}

export function getAdminUserRetirementStartupRecoverySummary(
): AdminUserRetirementStartupRecoverySummary {
  return startupRecoverySummary;
}

function exactIdentity(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AdminUserRetirementRequestError(
      'ADMIN_USER_RETIREMENT_INVALID',
      `Invalid ${label}`,
      400,
      false,
    );
  }
  return normalized;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code === 'P2002'
    : Boolean(error && typeof error === 'object' && (error as any).code === 'P2002');
}

function exactEmailDigest(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new AdminUserRetirementRequestError(
      'ADMIN_USER_RETIREMENT_INVALID',
      'The retirement confirmation identity is invalid',
      400,
      false,
    );
  }
  return normalized;
}

function assertRecordRequester(
  record: AdminUserRetirementRecord,
  requestedByUserId: string,
): void {
  if (record.requestedByUserId !== requestedByUserId) {
    throw new AdminUserRetirementRequestError(
      'ADMIN_USER_RETIREMENT_REQUESTER_CHANGED',
      'This retirement belongs to a different Owner request',
      409,
      false,
    );
  }
}

export function createProductionAdminUserRetirementRunner(
  overrides: AdminUserRetirementRuntimeDependencies = {},
): AdminUserRetirementRunner {
  const transitionCoordinator = overrides.transitionCoordinator
    || projectAuthorizationTransitionCoordinator;
  const retireOwnedProject = overrides.retireOwnedProject
    || (async (input) => {
      // projects.ts owns the already-qualified destructive lifecycle adapter,
      // but importing that route module while Admin routes are being assembled
      // creates a route-module cycle. Resolve it only after retirement has
      // durably closed admission and is ready to execute this exact phase.
      const projects = await import('../routes/projects');
      await projects.retireOwnedProjectForAdminUserRetirement(input);
    });
  const retireSharedActorState = overrides.retireSharedActorState
    || retireAdminUserSharedActorState;
  const retireExternalState = overrides.retireExternalState
    || retireAdminUserExternalState;
  const verifyExternalAbsence = overrides.verifyExternalAbsence
    || verifyAdminUserExternalStateAbsence;
  const commitDatabaseDeletion = overrides.commitDatabaseDeletion
    || (async (
      manifest: AdminUserRetirementManifestV1,
      context: AdminUserRetirementRunnerContext,
    ) => commitAdminUserDatabaseDeletion(manifest, context.readAdmissionEvidence()));
  const verifyDatabaseAbsence = overrides.verifyDatabaseAbsence
    || (async (manifest: AdminUserRetirementManifestV1) => (
      assertAdminUserDatabaseAbsence(manifest.target.id)
    ));

  return Object.freeze({
    async closeAdmission(manifest, context) {
      await context.assertHeld();
      const result = await transitionCoordinator.closeUserRetirementAdmission({
        retirementId: context.retirementId,
        initiatedByUserId: manifest.requestedByUserId,
        targetUserId: manifest.target.id,
        manifestDigest: context.manifestDigest,
        targetAuthorizationVersion: manifest.target.authorizationVersion,
      });
      await context.assertHeld();
      return {
        transitionId: result.transitionId,
        closedAuthorizationVersion: result.closedAuthorizationVersion,
        evidenceDigest: result.evidenceDigest,
      };
    },

    async retireOwnedProjects(manifest, context) {
      for (const project of manifest.ownedProjects) {
        await context.assertHeld();
        await retireOwnedProject({
          targetUserId: manifest.target.id,
          requestedByOwnerId: manifest.requestedByUserId,
          project,
        });
        await context.assertHeld();
      }
    },

    retireSharedActorState,
    retireExternalState,
    verifyExternalAbsence,
    commitDatabaseDeletion,
    verifyDatabaseAbsence,
  });
}

export async function readAdminUserRetirement(
  targetUserId: string,
  store: AdminUserRetirementStore = new PrismaAdminUserRetirementStore(),
): Promise<AdminUserRetirementRecord | null> {
  return store.readByTargetUserId(exactIdentity(targetUserId, 'retirement target'));
}

export async function retireAdminUserAccount(
  input: {
    targetUserId: string;
    requestedByUserId: string;
    expectedTargetEmailDigest?: string;
  },
  options: {
    store?: AdminUserRetirementStore;
    runner?: AdminUserRetirementRunner;
    dependencies?: AdminUserRetirementRuntimeDependencies;
    leaseOwner?: string;
    leaseDurationMs?: number;
  } = {},
): Promise<AdminUserRetirementRecord> {
  const targetUserId = exactIdentity(input.targetUserId, 'retirement target');
  const requestedByUserId = exactIdentity(input.requestedByUserId, 'retirement requester');
  if (targetUserId === requestedByUserId) {
    throw new AdminUserRetirementRequestError(
      'ADMIN_USER_RETIREMENT_SELF_PROTECTED',
      'Cannot delete your own account',
      400,
      false,
    );
  }
  const transitionCoordinator = options.dependencies?.transitionCoordinator
    || projectAuthorizationTransitionCoordinator;
  const store = options.store || new PrismaAdminUserRetirementStore();
  let record = await store.readByTargetUserId(targetUserId);
  if (record) {
    assertRecordRequester(record, requestedByUserId);
    if (record.status === 'COMPLETE') return record;
  } else {
    const expectedEmailDigest = exactEmailDigest(input.expectedTargetEmailDigest);
    const useAtomicProductionSeal = options.runner === undefined
      && options.dependencies?.buildManifest === undefined
      && typeof transitionCoordinator.sealUserRetirementAdmission === 'function'
      && (
        options.store === undefined
        || options.dependencies?.transitionCoordinator !== undefined
      );
    if (useAtomicProductionSeal) {
      const sealed = await transitionCoordinator.sealUserRetirementAdmission!({
        initiatedByUserId: requestedByUserId,
        targetUserId,
        expectedTargetEmailDigest: expectedEmailDigest,
      });
      record = await store.readByTargetUserId(targetUserId);
      if (
        !record
        || record.id !== sealed.retirementId
        || record.requestedByUserId !== requestedByUserId
        || record.manifestDigest !== sealed.manifestDigest
        || record.targetAuthorizationVersion !== sealed.targetAuthorizationVersion
      ) {
        throw new AdminUserRetirementIntegrityError(
          'Atomically sealed user-retirement journal could not be read back',
        );
      }
    } else {
      // Explicit store/runner/build-manifest overrides are test seams. The
      // production path above is the only path used with the Prisma store.
      const buildManifest = options.dependencies?.buildManifest
        || buildAdminUserRetirementManifestSnapshot;
      const manifest = await buildManifest(targetUserId, requestedByUserId);
      if (manifest.target.emailDigest !== expectedEmailDigest) {
        throw new AdminUserRetirementRequestError(
          'ADMIN_USER_RETIREMENT_TARGET_CHANGED',
          'The target account changed after deletion was confirmed',
          409,
          false,
        );
      }
      try {
        record = await createAdminUserRetirementJournal(manifest, store);
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        record = await store.readByTargetUserId(targetUserId);
        if (!record) throw error;
        assertRecordRequester(record, requestedByUserId);
      }
    }
  }
  const runner = options.runner
    || createProductionAdminUserRetirementRunner({
      ...(options.dependencies || {}),
      transitionCoordinator,
    });
  return runAdminUserRetirement(targetUserId, runner, {
    store,
    leaseOwner: options.leaseOwner,
    leaseDurationMs: options.leaseDurationMs,
  });
}

export async function recoverAdminUserRetirementsAtStartup(
  options: {
    store?: AdminUserRetirementStore;
    runner?: AdminUserRetirementRunner;
    dependencies?: AdminUserRetirementRuntimeDependencies;
    leaseOwner?: string;
    leaseDurationMs?: number;
  } = {},
): Promise<AdminUserRetirementStartupRecoverySummary> {
  const store = options.store || new PrismaAdminUserRetirementStore();
  const runner = options.runner
    || createProductionAdminUserRetirementRunner(options.dependencies);
  const recovery = await recoverUnfinishedAdminUserRetirements(runner, {
    store,
    leaseOwner: options.leaseOwner,
    leaseDurationMs: options.leaseDurationMs,
  });
  startupRecoverySummary = boundedStartupRecoverySummary({
    recovered: recovery.recovered,
    blocked: recovery.blocked,
    busy: recovery.busy,
  });
  return startupRecoverySummary;
}

export function publicAdminUserRetirementFailure(error: unknown): {
  statusCode: number;
  body: { error: string; code: string; retryable: boolean };
} | null {
  if (error instanceof AdminUserRetirementRequestError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      },
    };
  }
  if (error instanceof MailboxReconciliationPendingError) {
    const blocked = error.state === 'blocked';
    return {
      statusCode: blocked ? 409 : 503,
      body: {
        error: blocked
          ? 'Account access is disabled, but mailbox cleanup needs attention. Check Mail service health, then retry deletion.'
          : 'Account access is disabled. Deletion is waiting for the Mail service; retry when Mail is available.',
        code: 'ADMIN_USER_RETIREMENT_MAIL_PENDING',
        retryable: !blocked,
      },
    };
  }
  if (error instanceof AdminUserRetirementBusyError) {
    return {
      statusCode: 409,
      body: {
        error: 'User retirement is already running. Retry to reconcile its result.',
        code: error.code,
        retryable: true,
      },
    };
  }
  if (error instanceof AdminUserRetirementIntegrityError) {
    return {
      statusCode: 409,
      body: {
        error: 'User retirement stopped because its sealed identity inventory changed.',
        code: error.code,
        retryable: false,
      },
    };
  }
  if (
    (
      error instanceof Prisma.PrismaClientKnownRequestError
      || Boolean(error && typeof error === 'object')
    )
    && (error as any).code === 'P2034'
  ) {
    return {
      statusCode: 409,
      body: {
        error: 'User retirement conflicted with another transaction. Retry the exact request.',
        code: 'ADMIN_USER_RETIREMENT_TRANSACTION_CONFLICT',
        retryable: true,
      },
    };
  }
  return null;
}

export function emailDigestForAdminUserRetirement(email: string): string {
  return digestAdminUserRetirementSnapshot(String(email || '').trim().toLowerCase());
}
