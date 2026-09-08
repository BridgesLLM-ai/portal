import fs from 'fs';
import path from 'path';
import {
  ADMIN_USER_RETIREMENT_READINESS,
  AdminUserRetirementBusyError,
  AdminUserRetirementIntegrityError,
  AdminUserRetirementRecoveryRequiredError,
  type AdminUserRetirementManifestV1,
  type AdminUserRetirementRecord,
  type AdminUserRetirementRunner,
  type AdminUserRetirementStore,
  canonicalizeAdminUserRetirementManifest,
  createAdminUserRetirementJournal,
  digestAdminUserRetirementManifest,
  assertNoUnfinishedAdminUserRetirementsAtStartup,
  runAdminUserRetirement,
  validateAdminUserRetirementManifest,
} from './adminUserRetirementLedger';

function manifest(): AdminUserRetirementManifestV1 {
  return {
    version: 1,
    target: {
      id: 'user-1',
      role: 'USER',
      authorizationVersion: 7,
      emailDigest: 'a'.repeat(64),
      username: 'alice',
      avatarBasename: 'alice.png',
    },
    requestedByUserId: 'owner-1',
    ownedProjects: [{
      id: 'project-1',
      projectName: 'alpha',
      canonicalRoot: '/portal/projects/user-1/alpha',
      generation: 3,
      lifecycleStatus: 'ACTIVE',
      rootDevice: '2049',
      rootInode: '9981',
      rootBirthtimeNs: '1722000000000000000',
      rootPresent: true,
    }],
    actorRuntimeState: {
      projectIdentityIds: ['project-1', 'shared-project-1'],
      legacyProjectIds: ['legacy-alpha'],
      chatStateIds: ['state-1'],
      turnIds: ['turn-1'],
      resetJournalIds: ['reset-1'],
      providerBindingIds: ['binding-1'],
      providerSessionRowIds: ['provider-session-row-1'],
      providerSessionIds: ['provider-session-1'],
      gatewaySessionKeys: ['agent:p4oc-alpha:portal-project-alpha'],
      messageIds: ['message-1'],
      legacyImportIds: ['import-1'],
      legacyQuarantineIds: ['quarantine-1'],
      legacyClearTombstoneIds: ['clear-1'],
    },
    dependencyEvidence: {
      completeRepairReceiptIds: ['11111111-1111-4111-8111-111111111111'],
      cleanupActors: [{
        projectIdentityId: 'project-1',
        provider: 'OPENCLAW',
        actorUserId: 'user-1',
        sessionId: 'provider-session-1',
      }],
    },
    apps: [{
      id: 'app-1',
      name: 'demo',
      projectIdentityId: 'project-1',
      deployType: 'static',
      processStatus: 'stopped',
      sourcePath: '/portal/apps/user-1-demo',
      deployPath: '/var/www/bridgesllm-apps/user-1-demo',
      port: null,
      shareLinkIds: ['share-1'],
      shareTokenDigests: ['b'.repeat(64)],
    }],
    files: [{
      id: 'file-1',
      path: 'uploads/report.txt',
      cloudinaryId: null,
    }],
    agentJobs: [{
      id: 'job-1',
      status: 'running',
      transcriptPath: '/opt/bridgesllm/portal/.data/jobs/job-1.jsonl',
      metadataDigest: 'd'.repeat(64),
    }],
    agentSessions: [{
      id: 'agent-session-1',
      provider: 'CODEX',
      externalId: 'codex-user-1-abc',
      localAgentId: null,
      localSessionId: null,
      localIdentityDigest: null,
    }],
    authState: {
      sessionIds: ['auth-session-1'],
      emailVerificationCodeIds: ['email-code-1'],
      twoFactorChallengeIds: ['two-factor-1'],
      passwordResetTokenIds: ['password-reset-1'],
    },
    mailboxes: {
      usernames: ['alice'],
    },
    providerAttributions: {
      ollamaBindingIds: ['ollama-1'],
      nativeOllamaBindingIds: ['native-ollama-1'],
    },
    localTargets: {
      managedPaths: [{
        targetUserId: 'user-1',
        root: '/var/portal-files',
        rootIdentity: {
          device: '2049',
          inode: '77',
          birthtimeNs: '1722000000000000000',
          uid: 0,
          gid: 0,
          mode: 448,
        },
        path: '/var/portal-files/user-user-1',
        quarantinePath: `/var/portal-files/.portal-admin-user-retirement-quarantine/${'1'.repeat(64)}`,
        kind: 'DIRECTORY',
        present: true,
        identity: {
          device: '2049',
          inode: '88',
          birthtimeNs: '1722000000000000001',
          uid: 0,
          gid: 0,
          mode: 448,
        },
        size: '4096',
        sha256: 'd'.repeat(64),
      }],
      nativeSessions: [{
        provider: 'CODEX',
        sessionId: 'codex-user-1-abc',
        identityDigest: 'c'.repeat(64),
        executionScope: 'HOST_OPERATOR',
        projectIdentityId: null,
      }],
    },
  };
}

function initialRecord(value = manifest()): AdminUserRetirementRecord {
  return {
    id: 'retirement-1',
    targetUserId: value.target.id,
    requestedByUserId: value.requestedByUserId,
    manifestVersion: value.version,
    manifest: value,
    manifestDigest: digestAdminUserRetirementManifest(value),
    targetAuthorizationVersion: value.target.authorizationVersion,
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
  };
}

class MemoryStore implements AdminUserRetirementStore {
  record: AdminUserRetirementRecord | null;
  private claimed = false;

  constructor(record: AdminUserRetirementRecord | null = initialRecord()) {
    this.record = record;
  }

  async create(
    value: AdminUserRetirementManifestV1,
    digest: string,
  ): Promise<AdminUserRetirementRecord> {
    if (this.record) throw new Error('duplicate');
    this.record = {
      ...initialRecord(value),
      manifestDigest: digest,
    };
    return this.record;
  }

  async readByTargetUserId(targetUserId: string): Promise<AdminUserRetirementRecord | null> {
    return this.record?.targetUserId === targetUserId ? this.record : null;
  }

  async listUnfinished(): Promise<AdminUserRetirementRecord[]> {
    return this.record && this.record.status !== 'COMPLETE' ? [this.record] : [];
  }

  async claim(): Promise<any> {
    if (!this.record || this.record.status === 'COMPLETE' || this.claimed) {
      throw new AdminUserRetirementBusyError();
    }
    this.claimed = true;
    this.record = {
      ...this.record,
      status: 'RUNNING',
      attempts: this.record.attempts + 1,
      leaseTokenHash: 'd'.repeat(64),
      leaseOwner: 'test',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      lastErrorCode: null,
      lastErrorDetail: null,
    };
    return {
      record: this.record,
      leaseToken: 'e'.repeat(64),
      leaseTokenHash: 'd'.repeat(64),
    };
  }

  async advance(
    recordId: string,
    leaseTokenHash: string,
    expectedPhase: AdminUserRetirementRecord['phase'],
    nextPhase: AdminUserRetirementRecord['phase'],
    evidence: {
      admission?: {
        transitionId: string;
        closedAuthorizationVersion: number;
        evidenceDigest: string;
      };
      externalAbsenceDigest?: string;
    } = {},
  ): Promise<AdminUserRetirementRecord> {
    if (
      !this.record
      || this.record.id !== recordId
      || this.record.phase !== expectedPhase
      || this.record.leaseTokenHash !== leaseTokenHash
    ) {
      throw new AdminUserRetirementBusyError();
    }
    this.record = {
      ...this.record,
      phase: nextPhase,
      status: nextPhase === 'COMPLETE' ? 'COMPLETE' : 'RUNNING',
      authorizationTransitionId:
        evidence.admission?.transitionId || this.record.authorizationTransitionId,
      closedAuthorizationVersion:
        evidence.admission?.closedAuthorizationVersion || this.record.closedAuthorizationVersion,
      admissionEvidenceDigest:
        evidence.admission?.evidenceDigest || this.record.admissionEvidenceDigest,
      externalAbsenceDigest: evidence.externalAbsenceDigest || this.record.externalAbsenceDigest,
      ...(nextPhase === 'COMPLETE'
        ? { leaseTokenHash: null, leaseOwner: null, leaseExpiresAt: null }
        : {}),
    };
    if (nextPhase === 'COMPLETE') this.claimed = false;
    return this.record;
  }

  async renew(recordId: string, leaseTokenHash: string): Promise<void> {
    if (
      !this.record
      || this.record.id !== recordId
      || this.record.leaseTokenHash !== leaseTokenHash
    ) {
      throw new AdminUserRetirementBusyError();
    }
    this.record = {
      ...this.record,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
  }

  async block(
    recordId: string,
    leaseTokenHash: string,
    errorCode: string,
    errorDetail: string,
  ): Promise<void> {
    if (
      !this.record
      || this.record.id !== recordId
      || this.record.leaseTokenHash !== leaseTokenHash
    ) {
      throw new AdminUserRetirementBusyError();
    }
    this.record = {
      ...this.record,
      status: 'BLOCKED',
      leaseTokenHash: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
      lastErrorDetail: errorDetail,
    };
    this.claimed = false;
  }
}

function runner(
  events: string[],
  overrides: Partial<AdminUserRetirementRunner> = {},
): AdminUserRetirementRunner {
  return {
    closeAdmission: async () => {
      events.push('close-admission');
      return {
        transitionId: 'transition-1',
        closedAuthorizationVersion: 8,
        evidenceDigest: '9'.repeat(64),
      };
    },
    retireOwnedProjects: async () => { events.push('owned-projects'); },
    retireSharedActorState: async () => { events.push('shared-actor'); },
    retireExternalState: async () => { events.push('external-state'); },
    verifyExternalAbsence: async () => {
      events.push('verify-external-absence');
      return { evidenceDigest: 'f'.repeat(64) };
    },
    commitDatabaseDeletion: async () => { events.push('delete-user-row'); },
    verifyDatabaseAbsence: async () => { events.push('verify-user-absence'); },
    ...overrides,
  };
}

describe('durable admin user retirement authority', () => {
  test('canonicalizes equivalent immutable manifests to one digest', () => {
    const first = manifest();
    const reordered = {
      ...first,
      target: {
        username: first.target.username,
        emailDigest: first.target.emailDigest,
        role: first.target.role,
        id: first.target.id,
        authorizationVersion: first.target.authorizationVersion,
        avatarBasename: first.target.avatarBasename,
      },
    } as AdminUserRetirementManifestV1;

    expect(canonicalizeAdminUserRetirementManifest(first))
      .toBe(canonicalizeAdminUserRetirementManifest(reordered));
    expect(digestAdminUserRetirementManifest(first))
      .toBe(digestAdminUserRetirementManifest(reordered));
  });

  test('rejects owner/self retirement and non-attested local paths', () => {
    expect(() => validateAdminUserRetirementManifest({
      ...manifest(),
      requestedByUserId: 'user-1',
    })).toThrow(AdminUserRetirementIntegrityError);
    expect(() => validateAdminUserRetirementManifest({
      ...manifest(),
      target: { ...manifest().target, role: 'OWNER' },
    })).toThrow(AdminUserRetirementIntegrityError);
    expect(() => validateAdminUserRetirementManifest({
      ...manifest(),
      localTargets: {
        ...manifest().localTargets,
        managedPaths: [{
          ...manifest().localTargets.managedPaths[0],
          path: '../outside',
        }],
      },
    })).toThrow('absolute normalized path');
    expect(() => validateAdminUserRetirementManifest({
      ...manifest(),
      target: {
        ...manifest().target,
        password: 'must-not-enter-the-journal',
      },
    } as AdminUserRetirementManifestV1)).toThrow('unknown or missing property');
  });

  test('requires bounded, strictly ordered dependency evidence with exact cleanup keys', () => {
    const value = manifest();
    expect(() => validateAdminUserRetirementManifest({
      ...value,
      dependencyEvidence: {
        ...value.dependencyEvidence,
        completeRepairReceiptIds: ['repair-z', 'repair-a'],
      },
    })).toThrow(/completeRepairReceiptIds is not strictly ordered/i);
    expect(() => validateAdminUserRetirementManifest({
      ...value,
      dependencyEvidence: {
        completeRepairReceiptIds: [],
        cleanupActors: [
          {
            projectIdentityId: 'project-z',
            provider: 'OPENCLAW',
            actorUserId: 'user-1',
            sessionId: '',
          },
          {
            projectIdentityId: 'project-a',
            provider: 'OPENCLAW',
            actorUserId: 'user-1',
            sessionId: '',
          },
        ],
      },
    })).toThrow(/cleanupActors is not strictly ordered/i);
    expect(() => validateAdminUserRetirementManifest({
      ...value,
      dependencyEvidence: {
        completeRepairReceiptIds: [],
        cleanupActors: [{
          projectIdentityId: 'project-a',
          provider: 'OPENCLAW',
          actorUserId: 'another-user',
          sessionId: '',
          unexpected: true,
        } as any],
      },
    })).toThrow(/unknown or missing property/i);
    expect(() => validateAdminUserRetirementManifest({
      ...value,
      dependencyEvidence: {
        completeRepairReceiptIds: [123 as any],
        cleanupActors: [],
      },
    })).toThrow(/completeRepairReceiptIds\[0\] is invalid/i);
    expect(() => validateAdminUserRetirementManifest({
      ...value,
      dependencyEvidence: {
        completeRepairReceiptIds: [],
        cleanupActors: [{
          projectIdentityId: 'project-a',
          provider: 'OPENCLAW',
          actorUserId: 'user-1',
          sessionId: 123 as any,
        }],
      },
    })).toThrow(/cleanupActors\[0\]\.sessionId is invalid/i);
  });

  test('persists exact inventory digest before any runner is admitted', async () => {
    const store = new MemoryStore(null);
    const created = await createAdminUserRetirementJournal(manifest(), store);
    expect(created.phase).toBe('MANIFESTED');
    expect(created.status).toBe('PENDING');
    expect(created.manifestDigest).toBe(digestAdminUserRetirementManifest(manifest()));
  });

  test('runs external absence verification before the final User row deletion', async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    const completed = await runAdminUserRetirement('user-1', runner(events), {
      store,
      leaseOwner: 'test-worker',
      leaseDurationMs: 60_000,
    });

    expect(events).toEqual([
      'close-admission',
      'owned-projects',
      'shared-actor',
      'external-state',
      'verify-external-absence',
      'delete-user-row',
      'verify-user-absence',
      'verify-external-absence',
      'verify-user-absence',
      'verify-external-absence',
    ]);
    expect(completed.phase).toBe('COMPLETE');
    expect(completed.status).toBe('COMPLETE');
    expect(completed).toMatchObject({
      authorizationTransitionId: 'transition-1',
      closedAuthorizationVersion: 8,
      admissionEvidenceDigest: '9'.repeat(64),
    });
    expect(completed.externalAbsenceDigest).toBe('f'.repeat(64));
  });

  test('continuously renews its lease while one adapter operation is still running', async () => {
    const store = new MemoryStore();
    const originalRenew = store.renew.bind(store);
    let insideAdmission = false;
    let renewalsDuringAdmission = 0;
    store.renew = async (...args: Parameters<MemoryStore['renew']>) => {
      if (insideAdmission) renewalsDuringAdmission += 1;
      await originalRenew(...args);
    };

    await runAdminUserRetirement('user-1', runner([], {
      closeAdmission: async () => {
        insideAdmission = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        insideAdmission = false;
        return {
          transitionId: 'transition-renewed',
          closedAuthorizationVersion: 8,
          evidenceDigest: '7'.repeat(64),
        };
      },
    }), {
      store,
      leaseOwner: 'continuous-renewal-worker',
      leaseDurationMs: 30,
    });

    expect(renewalsDuringAdmission).toBeGreaterThan(0);
  });

  test('does not persist a phase after its continuous lease guard loses ownership', async () => {
    const store = new MemoryStore();
    const originalRenew = store.renew.bind(store);
    let insideAdmission = false;
    store.renew = async (...args: Parameters<MemoryStore['renew']>) => {
      if (insideAdmission) throw new AdminUserRetirementBusyError('simulated lease theft');
      await originalRenew(...args);
    };

    await expect(runAdminUserRetirement('user-1', runner([], {
      closeAdmission: async () => {
        insideAdmission = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        insideAdmission = false;
        return {
          transitionId: 'transition-lost',
          closedAuthorizationVersion: 8,
          evidenceDigest: '6'.repeat(64),
        };
      },
    }), {
      store,
      leaseOwner: 'losing-worker',
      leaseDurationMs: 30,
    })).rejects.toThrow(/lease was lost/i);

    expect(store.record).toMatchObject({
      phase: 'MANIFESTED',
      status: 'BLOCKED',
      authorizationTransitionId: null,
    });
  });

  test('records a failed phase and resumes idempotently after restart', async () => {
    const firstEvents: string[] = [];
    const store = new MemoryStore();
    const failure = new Error('provider runtime could not prove absence');
    await expect(runAdminUserRetirement('user-1', runner(firstEvents, {
      retireSharedActorState: async () => {
        firstEvents.push('shared-actor-failed');
        throw failure;
      },
    }), {
      store,
      leaseOwner: 'worker-before-crash',
      leaseDurationMs: 60_000,
    })).rejects.toBe(failure);

    expect(firstEvents).toEqual([
      'close-admission',
      'owned-projects',
      'shared-actor-failed',
    ]);
    expect(store.record).toMatchObject({
      phase: 'OWNED_PROJECTS_RETIRED',
      status: 'BLOCKED',
    });

    const resumedEvents: string[] = [];
    const completed = await runAdminUserRetirement('user-1', runner(resumedEvents), {
      store,
      leaseOwner: 'worker-after-restart',
      leaseDurationMs: 60_000,
    });
    expect(resumedEvents).toEqual([
      'shared-actor',
      'external-state',
      'verify-external-absence',
      'delete-user-row',
      'verify-user-absence',
      'verify-external-absence',
      'verify-user-absence',
      'verify-external-absence',
    ]);
    expect(completed.status).toBe('COMPLETE');
    expect(completed.attempts).toBe(2);
  });

  test('reconciles a crash after User deletion without replaying earlier destructive phases', async () => {
    const store = new MemoryStore();
    const firstEvents: string[] = [];
    let absenceReads = 0;
    await expect(runAdminUserRetirement('user-1', runner(firstEvents, {
      verifyExternalAbsence: async () => {
        firstEvents.push('verify-external-absence');
        absenceReads += 1;
        if (absenceReads === 2) throw new Error('simulated crash after database commit');
        return { evidenceDigest: 'f'.repeat(64) };
      },
    }), {
      store,
      leaseOwner: 'worker-before-database-crash',
      leaseDurationMs: 60_000,
    })).rejects.toThrow('simulated crash after database commit');

    expect(store.record).toMatchObject({
      phase: 'EXTERNAL_ABSENCE_VERIFIED',
      status: 'BLOCKED',
      externalAbsenceDigest: 'f'.repeat(64),
    });
    expect(firstEvents).toContain('delete-user-row');

    const resumedEvents: string[] = [];
    const completed = await runAdminUserRetirement('user-1', runner(resumedEvents), {
      store,
      leaseOwner: 'worker-after-database-crash',
      leaseDurationMs: 60_000,
    });
    expect(resumedEvents).toEqual([
      'delete-user-row',
      'verify-user-absence',
      'verify-external-absence',
      'verify-user-absence',
      'verify-external-absence',
    ]);
    expect(completed).toMatchObject({
      phase: 'COMPLETE',
      status: 'COMPLETE',
      attempts: 2,
    });
  });

  test('blocks startup rather than admitting traffic over unfinished authority', async () => {
    await expect(
      assertNoUnfinishedAdminUserRetirementsAtStartup(new MemoryStore()),
    ).rejects.toBeInstanceOf(AdminUserRetirementRecoveryRequiredError);
    await expect(
      assertNoUnfinishedAdminUserRetirementsAtStartup(new MemoryStore(null)),
    ).resolves.toBeUndefined();
  });

  test('refuses to advance admission without a newer durable authorization generation', async () => {
    const store = new MemoryStore();
    await expect(runAdminUserRetirement('user-1', runner([], {
      closeAdmission: async () => ({
        transitionId: 'transition-stale',
        closedAuthorizationVersion: 7,
        evidenceDigest: '8'.repeat(64),
      }),
    }), {
      store,
      leaseOwner: 'stale-transition-worker',
      leaseDurationMs: 60_000,
    })).rejects.toThrow(/authorization generation is invalid/i);
    expect(store.record).toMatchObject({
      phase: 'MANIFESTED',
      status: 'BLOCKED',
      authorizationTransitionId: null,
      closedAuthorizationVersion: null,
    });
  });

  test('reports the fully wired crash-resumable production retirement contract', () => {
    expect(ADMIN_USER_RETIREMENT_READINESS).toMatchObject({
      ready: true,
      durableJournal: true,
      immutableManifest: true,
      restartStateMachine: true,
      externalAbsenceBeforeUserDelete: true,
      productionAdapters: {
        admissionClosure: true,
        ownedProjectLifecycle: true,
        sharedActorRuntimeRetirement: true,
        dependencyEvidenceRetirement: true,
        appFileJobMailProviderRetirement: true,
        externalAbsenceVerification: true,
      },
    });
  });

  test('migration constrains phases and prevents manifest authority rewrites', () => {
    const migration = fs.readFileSync(path.join(
      __dirname,
      '../../prisma/migrations/20260820_user_retirement_durable/migration.sql',
    ), 'utf8');
    expect(migration).toContain('CREATE TABLE "AdminUserRetirement"');
    expect(migration).toContain('"AdminUserRetirement_phase_check"');
    expect(migration).toContain("'EXTERNAL_ABSENCE_VERIFIED'");
    expect(migration).toContain('"AdminUserRetirement_preserve_manifest_trigger"');
    expect(migration).toContain('"AdminUserRetirement_validate_insert_trigger"');
    expect(migration).toContain('"AdminUserRetirement_prevent_delete_trigger"');
    expect(migration).toContain('new_phase_rank > old_phase_rank + 1');
    expect(migration).toContain('target_authorization_version');
    expect(migration).toContain('"authorizationTransitionId"');
    expect(migration).toContain('"closedAuthorizationVersion"');
    expect(migration).toContain('"admissionEvidenceDigest"');
    expect(migration).toContain("requester_role <> 'OWNER'");
    expect(migration).toContain('NEW."manifest" IS DISTINCT FROM OLD."manifest"');
    expect(migration).toContain('"ProjectRuntimeCleanupActor_actorUserId_fkey"');
    expect(migration).toContain('"ProjectRuntimeCleanupActor_attest_actor_trigger"');
    expect(migration).not.toMatch(/FOREIGN KEY[^\n]+"targetUserId"/);
  });
});
