import type {
  AdminUserRetirementManifestV1,
  AdminUserRetirementRunnerContext,
} from './adminUserRetirementLedger';
import {
  assertAdminUserSharedActorStateAbsent,
  retireAdminUserSharedActorState,
} from './adminUserRetirementSharedActorState';

function manifest(): AdminUserRetirementManifestV1 {
  return {
    version: 1,
    target: {
      id: 'target-user',
      role: 'USER',
      authorizationVersion: 7,
      emailDigest: 'a'.repeat(64),
      username: 'target',
      avatarBasename: null,
    },
    requestedByUserId: 'owner-user',
    ownedProjects: [],
    actorRuntimeState: {
      projectIdentityIds: ['project-shared'],
      legacyProjectIds: ['legacy-project'],
      chatStateIds: ['state-1'],
      turnIds: ['turn-1'],
      resetJournalIds: ['reset-1'],
      providerBindingIds: ['binding-1'],
      providerSessionRowIds: ['session-row-1'],
      providerSessionIds: ['provider-session-1'],
      gatewaySessionKeys: ['agent:portal:shared'],
      messageIds: ['message-1'],
      legacyImportIds: ['import-1'],
      legacyQuarantineIds: ['quarantine-1'],
      legacyClearTombstoneIds: ['clear-1'],
    },
    dependencyEvidence: {
      completeRepairReceiptIds: ['repair-1'],
      cleanupActors: [{
        projectIdentityId: 'project-shared',
        provider: 'OPENCLAW',
        actorUserId: 'target-user',
        sessionId: 'provider-session-1',
      }],
    },
    apps: [],
    files: [],
    agentJobs: [],
    agentSessions: [],
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
}

function delegate(initialRows: any[]) {
  let rows = initialRows.map((row) => ({ ...row }));
  return {
    findMany: jest.fn(async () => rows.map((row) => ({ ...row }))),
    deleteMany: jest.fn(async (args: any) => {
      const ids = new Set(args?.where?.id?.in || []);
      const repairIds = new Set(args?.where?.repairId?.in || []);
      const compounds = args?.where?.OR || [];
      const before = rows.length;
      rows = rows.filter((row) => !(
        ids.has(row.id)
        || repairIds.has(row.repairId)
        || compounds.some((key: any) => (
          row.projectIdentityId === key.projectIdentityId
          && row.provider === key.provider
          && row.actorUserId === key.actorUserId
          && row.sessionId === key.sessionId
        ))
      ));
      return { count: before - rows.length };
    }),
    rows: () => rows,
  };
}

function database(overrides: Record<string, any> = {}) {
  const value: any = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'target-user',
        role: 'USER',
        isActive: false,
        accountStatus: 'DISABLED',
        authorizationVersion: 8,
      })),
    },
    projectChatState: delegate([{
      id: 'state-1',
      projectIdentityId: 'project-shared',
    }]),
    projectChatTurn: delegate([{
      id: 'turn-1',
      projectIdentityId: 'project-shared',
      providerSessionId: 'provider-session-1',
      status: 'COMPLETED',
    }]),
    projectChatDestructiveResetJournal: delegate([{
      id: 'reset-1',
      projectIdentityId: 'project-shared',
      legacyProjectId: 'legacy-project',
    }]),
    projectChatProviderBinding: delegate([{
      id: 'binding-1',
      projectId: 'project-shared',
      sessionKey: 'agent:portal:shared',
      externalSessionId: 'provider-session-1',
    }]),
    projectChatSession: delegate([{
      id: 'session-row-1',
      projectId: 'project-shared',
      sessionKey: 'agent:portal:shared',
    }]),
    projectChatMessage: delegate([{
      id: 'message-1',
      projectId: 'project-shared',
      sessionKey: 'agent:portal:shared',
      providerSessionId: 'provider-session-1',
    }]),
    legacyOpenClawProjectImport: delegate([{
      id: 'import-1',
      projectIdentityId: 'project-shared',
      sourceSessionKey: 'agent:portal:shared',
      providerSessionId: 'provider-session-1',
    }]),
    legacyOpenClawProjectQuarantine: delegate([{
      id: 'quarantine-1',
      projectIdentityId: 'project-shared',
      originalProjectId: 'legacy-project',
      sessionKey: 'agent:portal:shared',
      providerSessionId: 'provider-session-1',
    }]),
    legacyOpenClawProjectClearTombstone: delegate([{
      id: 'clear-1',
      projectIdentityId: 'project-shared',
    }]),
    projectDependencyRepairOperation: delegate([{
      repairId: 'repair-1',
      actorUserId: 'target-user',
      status: 'APPLIED',
      phase: 'COMPLETE',
    }]),
    projectRuntimeCleanupActor: delegate([{
      projectIdentityId: 'project-shared',
      provider: 'OPENCLAW',
      actorUserId: 'target-user',
      sessionId: 'provider-session-1',
    }]),
    ...overrides,
  };
  value.$transaction = jest.fn(async (operation: (transaction: any) => Promise<unknown>) => (
    operation(value)
  ));
  return value;
}

function context(): AdminUserRetirementRunnerContext {
  return {
    retirementId: 'retirement-1',
    manifestDigest: 'f'.repeat(64),
    assertHeld: jest.fn(async () => undefined),
    renewLease: jest.fn(async () => undefined),
    readAdmissionEvidence: () => ({
      transitionId: 'transition-1',
      closedAuthorizationVersion: 8,
      evidenceDigest: 'b'.repeat(64),
    }),
  };
}

describe('admin user shared Project actor retirement', () => {
  test('deletes only the immutable actor inventory and proves database absence', async () => {
    const db = database();
    const lease = context();

    await retireAdminUserSharedActorState(manifest(), lease, db);
    await assertAdminUserSharedActorStateAbsent('target-user', db);

    expect(lease.assertHeld).toHaveBeenCalledTimes(2);
    for (const [key, value] of Object.entries(db)) {
      if (key === 'user' || key === '$transaction') continue;
      expect((value as ReturnType<typeof delegate>).rows()).toEqual([]);
    }
  });

  test('rejects a replacement provider-session row before any deletion', async () => {
    const replacement = delegate([{
      id: 'replacement-row',
      projectId: 'project-shared',
      sessionKey: 'agent:portal:shared',
    }]);
    const db = database({ projectChatSession: replacement });

    await expect(retireAdminUserSharedActorState(manifest(), context(), db))
      .rejects.toThrow(/session-row inventory changed/i);
    expect(db.projectChatState.deleteMany).not.toHaveBeenCalled();
    expect(replacement.rows()).toHaveLength(1);
  });

  test('refuses to delete database authority while a turn is still active', async () => {
    const activeTurns = delegate([{
      id: 'turn-1',
      projectIdentityId: 'project-shared',
      providerSessionId: 'provider-session-1',
      status: 'RUNNING',
    }]);
    const db = database({ projectChatTurn: activeTurns });

    await expect(retireAdminUserSharedActorState(manifest(), context(), db))
      .rejects.toThrow(/turn remains active/i);
    expect(activeTurns.deleteMany).not.toHaveBeenCalled();
  });

  test('never deletes a live repair operation or an unmanifested cleanup actor', async () => {
    const liveRepair = delegate([{
      repairId: 'repair-live',
      actorUserId: 'target-user',
      status: 'PROMOTING',
      phase: 'ALL_NEW',
    }]);
    const dbWithLiveRepair = database({
      projectDependencyRepairOperation: liveRepair,
    });
    await expect(retireAdminUserSharedActorState(
      manifest(),
      context(),
      dbWithLiveRepair,
    )).rejects.toThrow(/repair receipt inventory changed/i);
    expect(liveRepair.deleteMany).not.toHaveBeenCalled();
    expect(liveRepair.rows()).toHaveLength(1);

    const replacementCleanupActor = delegate([{
      projectIdentityId: 'project-shared',
      provider: 'CODEX',
      actorUserId: 'target-user',
      sessionId: 'replacement',
    }]);
    const dbWithCleanupActor = database({
      projectRuntimeCleanupActor: replacementCleanupActor,
    });
    await expect(retireAdminUserSharedActorState(
      manifest(),
      context(),
      dbWithCleanupActor,
    )).rejects.toThrow(/cleanup actor inventory changed/i);
    expect(replacementCleanupActor.deleteMany).not.toHaveBeenCalled();
  });
});
