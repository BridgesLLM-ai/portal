import type { AdminUserRetirementManifestV1 } from './adminUserRetirementLedger';
import {
  assertAdminUserDatabaseAbsence,
  commitAdminUserDatabaseDeletion,
} from './adminUserRetirementDatabaseCommit';

describe('admin user retirement final database commit', () => {
  let manifest: AdminUserRetirementManifestV1;
  let user: any;
  let actorResidue: number;
  let dependencyResidue: number;
  let apps: any[];
  let shareLinks: any[];
  let files: any[];
  let jobs: any[];
  let agentSessions: any[];
  let database: any;

  beforeEach(() => {
    manifest = {
      version: 1,
      target: {
        id: 'target-user',
        role: 'USER',
        authorizationVersion: 4,
        emailDigest: 'a'.repeat(64),
        username: 'target',
        avatarBasename: null,
      },
      requestedByUserId: 'owner-user',
      ownedProjects: [],
      actorRuntimeState: {
        projectIdentityIds: [],
        legacyProjectIds: [],
        chatStateIds: [],
        turnIds: [],
        resetJournalIds: [],
        providerBindingIds: [],
        providerSessionRowIds: [],
        providerSessionIds: [],
        gatewaySessionKeys: [],
        messageIds: [],
        legacyImportIds: [],
        legacyQuarantineIds: [],
        legacyClearTombstoneIds: [],
      },
      dependencyEvidence: {
        completeRepairReceiptIds: [],
        cleanupActors: [],
      },
      apps: [{
        id: 'app-1',
        name: 'static-app',
        projectIdentityId: null,
        deployType: 'static',
        processStatus: 'stopped',
        sourcePath: '/portal/apps/target-static-app',
        deployPath: '/var/www/bridgesllm-apps/target-static-app',
        port: null,
        shareLinkIds: ['share-1'],
        shareTokenDigests: ['b'.repeat(64)],
      }],
      files: [{
        id: 'file-1',
        path: 'uploads/private.txt',
        cloudinaryId: null,
      }],
      agentJobs: [{
        id: 'job-1',
        status: 'running',
        transcriptPath: null,
        metadataDigest: 'c'.repeat(64),
      }],
      agentSessions: [{
        id: 'agent-session-1',
        provider: 'OPENCLAW',
        externalId: 'agent:portal:host',
        localAgentId: null,
        localSessionId: null,
        localIdentityDigest: null,
      }],
      authState: {
        sessionIds: [],
        emailVerificationCodeIds: [],
        twoFactorChallengeIds: [],
        passwordResetTokenIds: [],
      },
      mailboxes: { usernames: [] },
      providerAttributions: {
        ollamaBindingIds: [],
        nativeOllamaBindingIds: [],
      },
      localTargets: {
        managedPaths: [],
        nativeSessions: [],
      },
    };
    user = {
      id: 'target-user',
      role: 'USER',
      isActive: false,
      accountStatus: 'DISABLED',
      authorizationVersion: 5,
    };
    actorResidue = 0;
    dependencyResidue = 0;
    apps = [{
      id: 'app-1',
      name: 'static-app',
      projectIdentityId: null,
      deployType: 'static',
      zipPath: '/portal/apps/target-static-app',
      port: null,
    }];
    shareLinks = [{ id: 'share-1' }];
    files = [{
      id: 'file-1',
      path: 'uploads/private.txt',
      cloudinaryId: null,
    }];
    jobs = [{
      id: 'job-1',
      transcriptPath: null,
      status: 'killed',
    }];
    agentSessions = [{
      id: 'agent-session-1',
      provider: 'OPENCLAW',
      externalId: 'agent:portal:host',
    }];

    const zeroCount = { count: jest.fn(async () => 0) };
    const actorCount = { count: jest.fn(async () => actorResidue) };
    const dependencyCount = { count: jest.fn(async () => dependencyResidue) };
    database = {
      user: {
        findUnique: jest.fn(async () => user),
        deleteMany: jest.fn(async () => {
          if (!user) return { count: 0 };
          user = null;
          apps = [];
          shareLinks = [];
          files = [];
          jobs = [];
          agentSessions = [];
          return { count: 1 };
        }),
        count: jest.fn(async () => user ? 1 : 0),
      },
      projectIdentity: zeroCount,
      projectChatMessage: actorCount,
      projectChatSession: zeroCount,
      projectChatProviderBinding: zeroCount,
      projectChatState: zeroCount,
      projectChatTurn: zeroCount,
      projectChatDestructiveResetJournal: zeroCount,
      legacyOpenClawProjectImport: zeroCount,
      legacyOpenClawProjectQuarantine: zeroCount,
      legacyOpenClawProjectClearTombstone: zeroCount,
      projectDependencyPromotionDecision: dependencyCount,
      projectDependencyRepairOperation: dependencyCount,
      projectRuntimeCleanupActor: dependencyCount,
      app: {
        findMany: jest.fn(async () => apps),
        count: jest.fn(async () => apps.length),
      },
      appShareLink: {
        findMany: jest.fn(async () => shareLinks),
        count: jest.fn(async () => shareLinks.length),
      },
      file: {
        findMany: jest.fn(async () => files),
        count: jest.fn(async () => files.length),
      },
      agentJob: {
        findMany: jest.fn(async () => jobs),
        count: jest.fn(async () => jobs.length),
      },
      agentSession: {
        findMany: jest.fn(async () => agentSessions),
        count: jest.fn(async () => agentSessions.length),
      },
      session: zeroCount,
      emailVerificationCode: zeroCount,
      twoFactorChallenge: zeroCount,
      passwordResetToken: zeroCount,
      mailboxAccount: zeroCount,
      ollamaBackendBinding: zeroCount,
      nativeOllamaBackendBinding: zeroCount,
    };
    database.$transaction = jest.fn(async (operation: (transaction: any) => Promise<unknown>) => (
      operation(database)
    ));
  });

  const evidence = {
    transitionId: 'transition-1',
    closedAuthorizationVersion: 5,
    evidenceDigest: 'd'.repeat(64),
  };

  test('requires disabled exact-generation admission and zero runtime actor residue before cascade', async () => {
    await expect(commitAdminUserDatabaseDeletion(manifest, evidence, database))
      .resolves.toBeUndefined();
    expect(database.user.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'target-user',
        role: 'USER',
        isActive: false,
        accountStatus: 'DISABLED',
        authorizationVersion: 5,
      },
    });
    await expect(assertAdminUserDatabaseAbsence('target-user', database))
      .resolves.toBeUndefined();

    // Crash/retry after the durable User delete is an idempotent no-op.
    await expect(commitAdminUserDatabaseDeletion(manifest, evidence, database))
      .resolves.toBeUndefined();
  });

  test('rejects an active account, stale admission generation, and shared actor residue', async () => {
    user.isActive = true;
    user.accountStatus = 'ACTIVE';
    await expect(commitAdminUserDatabaseDeletion(manifest, evidence, database))
      .rejects.toThrow(/admission closure changed/i);
    expect(database.user.deleteMany).not.toHaveBeenCalled();

    user.isActive = false;
    user.accountStatus = 'DISABLED';
    await expect(commitAdminUserDatabaseDeletion(manifest, {
      ...evidence,
      closedAuthorizationVersion: 4,
    }, database)).rejects.toThrow(/admission closure evidence is invalid/i);

    actorResidue = 1;
    await expect(commitAdminUserDatabaseDeletion(manifest, evidence, database))
      .rejects.toThrow(/shared-actor state remains/i);
    expect(database.user.deleteMany).not.toHaveBeenCalled();
  });

  test('blocks new cascade-owned rows that were not present in the manifest', async () => {
    files.push({
      id: 'file-new',
      path: 'uploads/new.txt',
      cloudinaryId: null,
    });
    await expect(commitAdminUserDatabaseDeletion(manifest, evidence, database))
      .rejects.toThrow(/Final File inventory contains state created after/i);
    expect(database.user.deleteMany).not.toHaveBeenCalled();
  });

  test('refuses final User deletion while any dependency actor reference remains', async () => {
    dependencyResidue = 1;
    await expect(commitAdminUserDatabaseDeletion(manifest, evidence, database))
      .rejects.toThrow(/shared-actor state remains/i);
    expect(database.user.deleteMany).not.toHaveBeenCalled();
    user = null;
    await expect(assertAdminUserDatabaseAbsence('target-user', database))
      .rejects.toThrow(/not fully absent/i);
  });
});
