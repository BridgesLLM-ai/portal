import { MailboxReconciliationPendingError } from './mailboxReconciliation';
import {
  AdminUserRetirementBusyError,
  AdminUserRetirementIntegrityError,
  type AdminUserRetirementRecord,
  type AdminUserRetirementStore,
} from './adminUserRetirementLedger';
import {
  AdminUserRetirementRequestError,
  createProductionAdminUserRetirementRunner,
  publicAdminUserRetirementFailure,
  recoverAdminUserRetirementsAtStartup,
  retireAdminUserAccount,
} from './adminUserRetirementRuntime';

const MANIFEST_DIGEST = 'a'.repeat(64);
const ADMISSION_DIGEST = 'b'.repeat(64);
const ABSENCE_DIGEST = 'c'.repeat(64);

function record(
  overrides: Partial<AdminUserRetirementRecord> = {},
): AdminUserRetirementRecord {
  return {
    id: 'retirement-1',
    targetUserId: 'target-1',
    requestedByUserId: 'owner-1',
    manifestVersion: 1,
    manifest: {
      version: 1,
      target: {
        id: 'target-1',
        role: 'USER',
        authorizationVersion: 7,
        emailDigest: 'd'.repeat(64),
        username: 'target',
        avatarBasename: null,
      },
      requestedByUserId: 'owner-1',
      ownedProjects: [
        { id: 'project-1' },
        { id: 'project-2' },
      ],
    } as any,
    manifestDigest: MANIFEST_DIGEST,
    targetAuthorizationVersion: 7,
    phase: 'MANIFESTED',
    status: 'PENDING',
    attempts: 0,
    leaseTokenHash: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    authorizationTransitionId: null,
    closedAuthorizationVersion: null,
    admissionEvidenceDigest: null,
    externalAbsenceDigest: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    ...overrides,
  };
}

class RuntimeStore implements AdminUserRetirementStore {
  constructor(public current: AdminUserRetirementRecord | null = record()) {}

  create = jest.fn(async () => {
    if (!this.current) this.current = record();
    return this.current;
  });

  async readByTargetUserId(targetUserId: string) {
    return this.current?.targetUserId === targetUserId ? this.current : null;
  }

  async listUnfinished() {
    return this.current && this.current.status !== 'COMPLETE' ? [this.current] : [];
  }

  async claim(targetUserId: string, leaseOwner: string) {
    if (
      !this.current
      || this.current.targetUserId !== targetUserId
      || this.current.status === 'COMPLETE'
      || this.current.leaseTokenHash
    ) {
      throw new AdminUserRetirementBusyError();
    }
    this.current = {
      ...this.current,
      status: 'RUNNING',
      attempts: this.current.attempts + 1,
      leaseTokenHash: 'e'.repeat(64),
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      lastErrorCode: null,
      lastErrorDetail: null,
    };
    return {
      record: this.current,
      leaseToken: 'f'.repeat(64),
      leaseTokenHash: 'e'.repeat(64),
    };
  }

  async renew(recordId: string, leaseTokenHash: string) {
    if (
      !this.current
      || this.current.id !== recordId
      || this.current.leaseTokenHash !== leaseTokenHash
    ) {
      throw new AdminUserRetirementBusyError();
    }
  }

  async advance(
    recordId: string,
    leaseTokenHash: string,
    expectedPhase: AdminUserRetirementRecord['phase'],
    nextPhase: AdminUserRetirementRecord['phase'],
    evidence: any = {},
  ) {
    if (
      !this.current
      || this.current.id !== recordId
      || this.current.leaseTokenHash !== leaseTokenHash
      || this.current.phase !== expectedPhase
    ) {
      throw new AdminUserRetirementBusyError();
    }
    this.current = {
      ...this.current,
      phase: nextPhase,
      status: nextPhase === 'COMPLETE' ? 'COMPLETE' : 'RUNNING',
      authorizationTransitionId:
        evidence.admission?.transitionId || this.current.authorizationTransitionId,
      closedAuthorizationVersion:
        evidence.admission?.closedAuthorizationVersion
        || this.current.closedAuthorizationVersion,
      admissionEvidenceDigest:
        evidence.admission?.evidenceDigest || this.current.admissionEvidenceDigest,
      externalAbsenceDigest:
        evidence.externalAbsenceDigest || this.current.externalAbsenceDigest,
      ...(nextPhase === 'COMPLETE'
        ? { leaseTokenHash: null, leaseOwner: null, leaseExpiresAt: null }
        : {}),
    };
    return this.current;
  }

  async block(
    recordId: string,
    leaseTokenHash: string,
    errorCode: string,
    errorDetail: string,
  ) {
    if (
      this.current
      && this.current.id === recordId
      && this.current.leaseTokenHash === leaseTokenHash
    ) {
      this.current = {
        ...this.current,
        status: 'BLOCKED',
        leaseTokenHash: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
        lastErrorDetail: errorDetail,
      };
    }
  }
}

describe('production admin user retirement runtime', () => {
  test('uses the atomic coordinator sealer before the production retirement driver claims a new journal', async () => {
    const events: string[] = [];
    const store = new RuntimeStore(null);
    const transitionCoordinator = {
      sealUserRetirementAdmission: jest.fn(async () => {
        events.push('seal');
        store.current = record();
        return {
          transitionId: 'transition-1',
          retirementId: 'retirement-1',
          targetUserId: 'target-1',
          manifestDigest: MANIFEST_DIGEST,
          targetAuthorizationVersion: 7,
        };
      }),
      closeUserRetirementAdmission: jest.fn(async () => {
        events.push('admission');
        return {
          transitionId: 'transition-1',
          retirementId: 'retirement-1',
          targetUserId: 'target-1',
          manifestDigest: MANIFEST_DIGEST,
          closedAuthorizationVersion: 8,
          evidenceDigest: ADMISSION_DIGEST,
        };
      }),
    };

    await expect(retireAdminUserAccount({
      targetUserId: 'target-1',
      requestedByUserId: 'owner-1',
      expectedTargetEmailDigest: 'd'.repeat(64),
    }, {
      store,
      dependencies: {
        transitionCoordinator,
        retireOwnedProject: async () => undefined,
        retireSharedActorState: async () => undefined,
        retireExternalState: async () => undefined,
        verifyExternalAbsence: async () => ({ evidenceDigest: ABSENCE_DIGEST }),
        commitDatabaseDeletion: async () => undefined,
        verifyDatabaseAbsence: async () => undefined,
      },
      leaseOwner: 'atomic-runtime-test',
      leaseDurationMs: 60_000,
    })).resolves.toMatchObject({
      status: 'COMPLETE',
      authorizationTransitionId: 'transition-1',
    });

    expect(events.slice(0, 2)).toEqual(['seal', 'admission']);
    expect(transitionCoordinator.sealUserRetirementAdmission).toHaveBeenCalledWith({
      initiatedByUserId: 'owner-1',
      targetUserId: 'target-1',
      expectedTargetEmailDigest: 'd'.repeat(64),
    });
    expect(store.create).not.toHaveBeenCalled();
  });

  test('closes exact durable admission before invoking any destructive production adapter', async () => {
    const events: string[] = [];
    const transitionCoordinator = {
      closeUserRetirementAdmission: jest.fn(async () => {
        events.push('admission');
        return {
          transitionId: 'transition-1',
          retirementId: 'retirement-1',
          targetUserId: 'target-1',
          manifestDigest: MANIFEST_DIGEST,
          closedAuthorizationVersion: 8,
          evidenceDigest: ADMISSION_DIGEST,
        };
      }),
    };
    const runner = createProductionAdminUserRetirementRunner({
      transitionCoordinator,
      retireOwnedProject: async ({ project }) => {
        events.push(`project:${project.id}`);
      },
      retireSharedActorState: async () => {
        events.push('shared');
      },
      retireExternalState: async () => {
        events.push('external');
      },
      verifyExternalAbsence: async () => {
        events.push('external-absence');
        return { evidenceDigest: ABSENCE_DIGEST };
      },
      commitDatabaseDeletion: async () => {
        events.push('database-delete');
      },
      verifyDatabaseAbsence: async () => {
        events.push('database-absence');
      },
    });
    const store = new RuntimeStore();

    const completed = await retireAdminUserAccount({
      targetUserId: 'target-1',
      requestedByUserId: 'owner-1',
    }, {
      store,
      runner,
      leaseOwner: 'runtime-test',
      leaseDurationMs: 60_000,
    });

    expect(events[0]).toBe('admission');
    expect(events).toEqual([
      'admission',
      'project:project-1',
      'project:project-2',
      'shared',
      'external',
      'external-absence',
      'database-delete',
      'database-absence',
      'external-absence',
      'database-absence',
      'external-absence',
    ]);
    expect(transitionCoordinator.closeUserRetirementAdmission).toHaveBeenCalledWith({
      retirementId: 'retirement-1',
      initiatedByUserId: 'owner-1',
      targetUserId: 'target-1',
      manifestDigest: MANIFEST_DIGEST,
      targetAuthorizationVersion: 7,
    });
    expect(completed).toMatchObject({
      phase: 'COMPLETE',
      status: 'COMPLETE',
      authorizationTransitionId: 'transition-1',
      closedAuthorizationVersion: 8,
      admissionEvidenceDigest: ADMISSION_DIGEST,
      externalAbsenceDigest: ABSENCE_DIGEST,
    });
  });

  test('does not create a journal when typed-confirmation identity no longer matches', async () => {
    const store = {
      readByTargetUserId: jest.fn(async () => null),
      create: jest.fn(),
    } as unknown as AdminUserRetirementStore;
    const buildManifest = jest.fn(async () => record().manifest);

    await expect(retireAdminUserAccount({
      targetUserId: 'target-1',
      requestedByUserId: 'owner-1',
      expectedTargetEmailDigest: '9'.repeat(64),
    }, {
      store,
      dependencies: { buildManifest },
    })).rejects.toMatchObject({
      code: 'ADMIN_USER_RETIREMENT_TARGET_CHANGED',
      retryable: false,
    });
    expect(buildManifest).toHaveBeenCalledWith('target-1', 'owner-1');
    expect(store.create).not.toHaveBeenCalled();
  });

  test('returns an already-complete exact journal without rebuilding identity state', async () => {
    const completed = record({ phase: 'COMPLETE', status: 'COMPLETE' });
    const store = {
      readByTargetUserId: jest.fn(async () => completed),
    } as unknown as AdminUserRetirementStore;
    const buildManifest = jest.fn();

    await expect(retireAdminUserAccount({
      targetUserId: 'target-1',
      requestedByUserId: 'owner-1',
    }, {
      store,
      dependencies: { buildManifest },
    })).resolves.toBe(completed);
    expect(buildManifest).not.toHaveBeenCalled();
  });

  test('startup recovery resumes a durable phase and reports a claimed lease without stopping startup', async () => {
    const resumedStore = new RuntimeStore(record({
      phase: 'DATABASE_COMMITTED',
      status: 'BLOCKED',
      authorizationTransitionId: 'transition-1',
      closedAuthorizationVersion: 8,
      admissionEvidenceDigest: ADMISSION_DIGEST,
      externalAbsenceDigest: ABSENCE_DIGEST,
      lastErrorCode: 'PREVIOUS_FAILURE',
      lastErrorDetail: 'previous bounded failure',
    }));
    const runner = {
      closeAdmission: jest.fn(),
      retireOwnedProjects: jest.fn(),
      retireSharedActorState: jest.fn(),
      retireExternalState: jest.fn(),
      verifyExternalAbsence: jest.fn(async () => ({ evidenceDigest: ABSENCE_DIGEST })),
      commitDatabaseDeletion: jest.fn(),
      verifyDatabaseAbsence: jest.fn(async () => undefined),
    };
    await expect(recoverAdminUserRetirementsAtStartup({
      store: resumedStore,
      runner,
      leaseOwner: 'startup-test',
      leaseDurationMs: 60_000,
    })).resolves.toEqual({ recovered: ['target-1'], blocked: [], busy: [] });
    expect(runner.closeAdmission).not.toHaveBeenCalled();
    expect(runner.commitDatabaseDeletion).not.toHaveBeenCalled();
    expect(runner.verifyDatabaseAbsence).toHaveBeenCalledTimes(1);

    const busyStore = new RuntimeStore();
    busyStore.claim = jest.fn(async () => {
      throw new AdminUserRetirementBusyError();
    });
    await expect(recoverAdminUserRetirementsAtStartup({
      store: busyStore,
      runner,
    })).resolves.toEqual({
      recovered: [],
      blocked: [],
      busy: ['target-1'],
    });
  });

  test('a BLOCKED retirement does not stop startup and the exact Owner retry remains possible', async () => {
    const store = new RuntimeStore(record({
      phase: 'DATABASE_COMMITTED',
      status: 'BLOCKED',
      authorizationTransitionId: 'transition-1',
      closedAuthorizationVersion: 8,
      admissionEvidenceDigest: ADMISSION_DIGEST,
      externalAbsenceDigest: ABSENCE_DIGEST,
      lastErrorCode: 'PREVIOUS_FAILURE',
      lastErrorDetail: 'private prior detail',
    }));
    let failOnce = true;
    const runner = {
      closeAdmission: jest.fn(),
      retireOwnedProjects: jest.fn(),
      retireSharedActorState: jest.fn(),
      retireExternalState: jest.fn(),
      verifyExternalAbsence: jest.fn(async () => {
        if (failOnce) {
          failOnce = false;
          const error = new Error('private filesystem detail');
          (error as Error & { code: string }).code = 'EXACT_RETRY_REQUIRED';
          throw error;
        }
        return { evidenceDigest: ABSENCE_DIGEST };
      }),
      commitDatabaseDeletion: jest.fn(),
      verifyDatabaseAbsence: jest.fn(async () => undefined),
    };

    await expect(recoverAdminUserRetirementsAtStartup({
      store,
      runner,
      leaseOwner: 'startup-test',
      leaseDurationMs: 60_000,
    })).resolves.toEqual({
      recovered: [],
      blocked: [{
        retirementId: 'retirement-1',
        targetUserId: 'target-1',
        errorCode: 'EXACT_RETRY_REQUIRED',
      }],
      busy: [],
    });
    expect(store.current).toMatchObject({
      phase: 'DATABASE_COMMITTED',
      status: 'BLOCKED',
      lastErrorCode: 'EXACT_RETRY_REQUIRED',
    });

    await expect(retireAdminUserAccount({
      targetUserId: 'target-1',
      requestedByUserId: 'owner-1',
    }, {
      store,
      runner,
      leaseOwner: 'manual-retry-test',
      leaseDurationMs: 60_000,
    })).resolves.toMatchObject({ phase: 'COMPLETE', status: 'COMPLETE' });
    expect(runner.verifyDatabaseAbsence).toHaveBeenCalledTimes(2);
  });

  test('does not launder a ledger claim failure into a safely blocked startup summary', async () => {
    const store = new RuntimeStore();
    store.claim = jest.fn(async () => {
      throw new Error('ledger database read failed');
    });
    await expect(recoverAdminUserRetirementsAtStartup({
      store,
      runner: {
        closeAdmission: jest.fn(),
        retireOwnedProjects: jest.fn(),
        retireSharedActorState: jest.fn(),
        retireExternalState: jest.fn(),
        verifyExternalAbsence: jest.fn(),
        commitDatabaseDeletion: jest.fn(),
        verifyDatabaseAbsence: jest.fn(),
      },
    })).rejects.toThrow(/ledger database read failed/i);
  });

  test('maps transaction conflicts and integrity failures to bounded non-disclosing responses', () => {
    expect(publicAdminUserRetirementFailure({
      code: 'P2034',
      message: 'database secret and internal transaction detail',
    })).toEqual({
      statusCode: 409,
      body: {
        error: 'User retirement conflicted with another transaction. Retry the exact request.',
        code: 'ADMIN_USER_RETIREMENT_TRANSACTION_CONFLICT',
        retryable: true,
      },
    });
    const integrity = publicAdminUserRetirementFailure(
      new AdminUserRetirementIntegrityError('/root/private/secret-token'),
    );
    expect(integrity).toEqual({
      statusCode: 409,
      body: {
        error: 'User retirement stopped because its sealed identity inventory changed.',
        code: 'ADMIN_USER_RETIREMENT_INTEGRITY',
        retryable: false,
      },
    });
    expect(JSON.stringify(integrity)).not.toMatch(/private|secret-token/);
  });

  test.each(['retry_scheduled', 'blocked'] as const)('explains pending mailbox cleanup (%s) without claiming deletion or exposing details', (state) => {
    const response = publicAdminUserRetirementFailure(
      new MailboxReconciliationPendingError('private-mailbox', state, 'private-upstream-detail'),
    );
    expect(response).toMatchObject({
      statusCode: state === 'blocked' ? 409 : 503,
      body: {
        code: 'ADMIN_USER_RETIREMENT_MAIL_PENDING',
        retryable: state !== 'blocked',
      },
    });
    expect(response?.body.error).toContain('Account access is disabled');
    expect(response?.body.error).toMatch(/retry/i);
    expect(JSON.stringify(response)).not.toMatch(/private-mailbox|private-upstream-detail/);
  });

  test('bounds request errors without laundering unknown failures', () => {
    expect(publicAdminUserRetirementFailure(
      new AdminUserRetirementRequestError(
        'ADMIN_USER_RETIREMENT_INVALID',
        'Invalid retirement target',
        400,
        false,
      ),
    )).toEqual({
      statusCode: 400,
      body: {
        error: 'Invalid retirement target',
        code: 'ADMIN_USER_RETIREMENT_INVALID',
        retryable: false,
      },
    });
    expect(publicAdminUserRetirementFailure(new Error('internal secret'))).toBeNull();
  });
});
