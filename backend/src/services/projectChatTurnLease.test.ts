import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  AgentProviderType,
  Prisma,
  ProjectChatTurnStatus,
} from '@prisma/client';
import {
  PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
  PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
  PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX,
  acquireProjectChatTurn,
  acquireProjectChatRuntimeAdmission,
  advanceProjectChatBindingHandoff,
  advanceProjectChatBindingHandoffAfterSettlement,
  appendProjectChatTurnEvent,
  confirmProjectChatTurnAbort,
  createProjectChatDispatchPersistenceGate,
  ensureProjectChatState,
  finishProjectChatTurn,
  finishProjectChatRuntimeAdmission,
  isProjectChatRuntimeAdmissionTurn,
  markProjectChatTurnProviderDispatchAccepted,
  promoteProjectChatRuntimeAdmissionToTurn,
  projectChatBindingNeedsHandoff,
  projectChatTurnDispatchStage,
  reconcileLegacyProjectChatTerminalHandoff,
  readProjectChatCoordinationState,
  readProjectChatTurnReplay,
  recoverExpiredProjectChatOperationAfterNativeQuiescence,
  recoverExpiredProjectChatTurnAfterProviderTerminal,
  requestProjectChatTurnAbort,
  switchProjectChatProvider,
  withProjectChatRuntimeAdmission,
  type ProjectChatLeaseDatabase,
} from './projectChatTurnLease';

const ACTOR = 'actor-uuid';
const PROJECT = 'project-identity-uuid';
const NOW = new Date('2026-07-19T12:00:00.000Z');
const AUTHORIZATION_VERSION = 7;

function database(transaction: Record<string, any>): ProjectChatLeaseDatabase {
  const authorizedTransaction = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        authorizationVersion: AUTHORIZATION_VERSION,
        accountStatus: 'ACTIVE',
        isActive: true,
      }),
    },
    projectAuthorizationTransition: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    ...transaction,
  };
  return {
    $transaction: jest.fn(async (operation: (tx: any) => Promise<unknown>) => (
      operation(authorizedTransaction)
    )),
  } as unknown as ProjectChatLeaseDatabase;
}

function prismaTransactionConflict(code: 'P2034' | 'P2002') {
  return new Prisma.PrismaClientKnownRequestError(
    code === 'P2034'
      ? 'Transaction failed due to a write conflict or a deadlock. Please retry your transaction'
      : 'Unique constraint failed',
    { code, clientVersion: 'test' },
  );
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    id: 'state-uuid',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    selectedProvider: AgentProviderType.CODEX,
    version: 7,
    activeTurnId: null,
    transcriptCursor: 10,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-uuid',
    stateId: 'state-uuid',
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    activeProjectKey: PROJECT,
    provider: AgentProviderType.CODEX,
    runtime: 'codex-project-adapter',
    requestId: 'request-uuid',
    status: ProjectChatTurnStatus.RUNNING,
    leaseTokenHash: '1f2e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0',
    leaseOwner: 'portal-process-a',
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    heartbeatAt: NOW,
    providerSessionId: null,
    model: null,
    lastEventSeq: 0,
    resultMetadata: null,
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function userMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'persisted-user-message-id',
    projectId: PROJECT,
    userId: ACTOR,
    sessionKey: 'portal-project-session',
    role: 'user',
    content: 'Build the requested feature',
    timestamp: NOW,
    messageId: 'browser-message-id',
    provider: AgentProviderType.CODEX,
    runtime: 'openclaw-dedicated-project-agent',
    model: null,
    providerSessionId: 'agent:p4oc-test:portal-project',
    turnId: null,
    presentation: null,
    ...overrides,
  };
}

test('migration persists actor/project CAS state, turn leases, replay, and handoff cursors', () => {
  const migration = fs.readFileSync(path.resolve(
    __dirname,
    '../../prisma/migrations/20260719_project_turn_leases/migration.sql',
  ), 'utf8');
  expect(migration).toContain('CREATE TABLE "ProjectChatState"');
  expect(migration).toContain('CREATE TABLE "ProjectChatTurn"');
  expect(migration).toContain('CREATE TABLE "ProjectChatTurnEvent"');
  expect(migration).toContain('ProjectChatState_actorUserId_projectIdentityId_key');
  expect(migration).toContain('ProjectChatTurn_actorUserId_projectIdentityId_requestId_key');
  expect(migration).toContain('ProjectChatTurn_activeProjectKey_key');
  expect(migration).toContain('"handoffCursor" INTEGER NOT NULL DEFAULT 0');
});

test('authorization migration binds Project turns and host jobs to a durable generation fence', () => {
  const migration = fs.readFileSync(path.resolve(
    __dirname,
    '../../prisma/migrations/20260729_project_authorization_transition/migration.sql',
  ), 'utf8');
  expect(migration).toContain('ProjectChatTurn_actorAuthorizationVersion_check');
  expect(migration).toContain('AgentJob_actorAuthorizationVersion_check');
  expect(migration).toContain('CREATE TABLE "ProjectAuthorizationTransition"');
  expect(migration).toContain('ProjectAuthorizationTransition_one_unresolved');
  expect(migration).toContain("WHERE \"phase\" <> 'COMPLETE'");
});

test('initializes state without overwriting a previously selected provider', async () => {
  const upsert = jest.fn().mockResolvedValue(state());
  const db = database({ projectChatState: { upsert } });
  await expect(ensureProjectChatState({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    initialProvider: 'OPENCLAW',
  }, db)).resolves.toMatchObject({ selectedProvider: 'CODEX', version: 7 });
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { actorUserId_projectIdentityId: { actorUserId: ACTOR, projectIdentityId: PROJECT } },
    update: {},
  }));
});

test.each(['P2034', 'P2002'] as const)(
  'retries transient Serializable %s conflicts before surfacing a coordination error',
  async (code) => {
    const upsert = jest.fn().mockResolvedValue(state());
    let attempts = 0;
    const transaction = { projectChatState: { upsert } };
    const db = {
      $transaction: jest.fn(async (operation: (tx: any) => Promise<unknown>) => {
        const result = await operation(transaction);
        attempts += 1;
        if (attempts < 3) throw prismaTransactionConflict(code);
        return result;
      }),
    } as unknown as ProjectChatLeaseDatabase;

    await expect(ensureProjectChatState({
      actorUserId: ACTOR,
      projectIdentityId: PROJECT,
      initialProvider: 'OPENCLAW',
    }, db)).resolves.toMatchObject({ selectedProvider: 'CODEX' });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledTimes(3);
  },
);

test('bounds Serializable retries and translates an exhausted database conflict', async () => {
  const db = {
    $transaction: jest.fn(async () => {
      throw prismaTransactionConflict('P2034');
    }),
  } as unknown as ProjectChatLeaseDatabase;

  await expect(ensureProjectChatState({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    initialProvider: 'OPENCLAW',
  }, db)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409 });
  expect(db.$transaction).toHaveBeenCalledTimes(4);
});

test('holds replay persistence until dispatch acceptance resolves, then drains in order', async () => {
  const gate = createProjectChatDispatchPersistenceGate();
  const persisted: number[] = [];
  let chain = gate.waitUntilAccepted;
  const enqueue = (value: number) => {
    chain = chain.then(async () => {
      persisted.push(value);
    });
  };
  enqueue(1);
  enqueue(2);

  let acceptDispatch!: () => void;
  const acceptance = new Promise<void>((resolve) => {
    acceptDispatch = resolve;
  });
  const accepted = gate.releaseAfter(acceptance);
  await Promise.resolve();
  expect(persisted).toEqual([]);

  acceptDispatch();
  await accepted;
  await chain;
  expect(persisted).toEqual([1, 2]);
});

test('releases replay persistence when dispatch acceptance fails', async () => {
  const gate = createProjectChatDispatchPersistenceGate();
  let persistenceDrained = false;
  const drain = gate.waitUntilAccepted.then(() => {
    persistenceDrained = true;
  });
  let rejectDispatch!: (error: Error) => void;
  const acceptance = new Promise<void>((_resolve, reject) => {
    rejectDispatch = reject;
  });
  const accepted = gate.releaseAfter(acceptance);
  rejectDispatch(new Error('dispatch CAS rejected'));

  await expect(accepted).rejects.toThrow('dispatch CAS rejected');
  await drain;
  expect(persistenceDrained).toBe(true);
  gate.release();
  await expect(gate.waitUntilAccepted).resolves.toBeUndefined();
});

test('acquires one provider-matched turn through a state-version CAS', async () => {
  const leaseToken = 'a'.repeat(43);
  const createdTurn = turn({
    leaseTokenHash: '8'.repeat(64),
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
  });
  const findState = jest.fn()
    .mockResolvedValueOnce(state())
    .mockResolvedValueOnce(state({ version: 8, activeTurnId: createdTurn.id }));
  const createTurn = jest.fn().mockResolvedValue(createdTurn);
  const claimState = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: { findUnique: findState, updateMany: claimState },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create: createTurn },
  });

  const grant = await acquireProjectChatTurn({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    requestId: 'request-uuid',
    leaseOwner: 'portal-process-a',
    expectedVersion: 7,
    leaseToken,
    now: NOW,
  }, db);

  expect(grant).toMatchObject({
    leaseToken,
    idempotentReplay: false,
    state: { version: 8, activeTurnId: 'turn-uuid' },
  });
  expect(claimState).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      version: 7,
      selectedProvider: 'CODEX',
      activeTurnId: null,
    }),
    data: { activeTurnId: 'turn-uuid', version: { increment: 1 } },
  }));
  expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      actorUserId: ACTOR,
      actorAuthorizationVersion: AUTHORIZATION_VERSION,
    }),
  }));
});

test('rejects a stale actor generation before a Project runtime turn is created', async () => {
  const create = jest.fn();
  const db = database({
    user: {
      findUnique: jest.fn().mockResolvedValue({
        authorizationVersion: AUTHORIZATION_VERSION + 1,
        accountStatus: 'ACTIVE',
        isActive: true,
      }),
    },
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state()) },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create },
  });

  await expect(acquireProjectChatTurn({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    requestId: 'stale-authorization',
    leaseOwner: 'portal-process-a',
    expectedVersion: 7,
    leaseToken: 'c'.repeat(43),
    now: NOW,
  }, db)).rejects.toMatchObject({
    code: 'AUTHORIZATION_CHANGED',
    httpStatus: 409,
  });
  expect(create).not.toHaveBeenCalled();
});

test('rejects Project runtime admission while a durable authorization transition is unresolved', async () => {
  const create = jest.fn();
  const db = database({
    projectAuthorizationTransition: {
      findFirst: jest.fn().mockResolvedValue({ id: 'transition-uuid' }),
    },
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state()) },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create },
  });

  await expect(acquireProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    operation: 'send',
    leaseOwner: 'portal-process-a',
    expectedVersion: 7,
    now: NOW,
  }, db)).rejects.toMatchObject({
    code: 'AUTHORIZATION_CHANGED',
    httpStatus: 503,
  });
  expect(create).not.toHaveBeenCalled();
});

test('persists the exact stop-only recovery context in the runtime admission row', async () => {
  const context = Object.freeze({
    scope: 'PROJECT_SANDBOX' as const,
    source: 'PORTAL_SERVER' as const,
    userId: ACTOR,
    projectId: PROJECT,
    workspaceOwnerId: 'workspace-owner',
    projectName: 'demo',
    canonicalRoot: '/portal/projects/workspace-owner/demo',
    rootDevice: '1',
    rootInode: '2',
    rootBirthtimeNs: '3',
    runtimePolicyVersion: 'portal-project-sandbox-v2',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: `sha256:${'9'.repeat(64)}`,
    policyFingerprint: 'a'.repeat(64),
  });
  const createdTurn = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}qualify-codex:uuid`,
  });
  const createTurn = jest.fn().mockResolvedValue(createdTurn);
  const findState = jest.fn()
    .mockResolvedValueOnce(state())
    .mockResolvedValueOnce(state({ version: 8, activeTurnId: createdTurn.id }));
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: {
      findUnique: findState,
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create: createTurn },
  });

  await expect(acquireProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    operation: 'qualify-codex',
    leaseOwner: 'portal-process-a',
    expectedVersion: 7,
    recoveryExecutionContext: context,
    now: NOW,
  }, db)).resolves.toMatchObject({ operation: 'qualify-codex' });
  expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      resultMetadata: {
        runtimeAdmissionMetadataVersion: 1,
        recoveryExecutionContext: context,
      },
    }),
  }));
});

test('rejects provider mismatch before creating a turn', async () => {
  const create = jest.fn();
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state()) },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create },
  });
  await expect(acquireProjectChatTurn({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'openclaw-project',
    requestId: 'request-two',
    leaseOwner: 'portal-process-a',
    expectedVersion: 7,
    leaseToken: 'b'.repeat(43),
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
  expect(create).not.toHaveBeenCalled();
});

test('concurrent runtime-mutating routes do not enter their callback while a user turn is leased', async () => {
  const activeTurn = turn({ requestId: 'leased-user-message' });
  const callback = jest.fn(async () => 'must-not-run');
  const mutateTurn = jest.fn();
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: activeTurn.id })),
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(activeTurn)
        .mockResolvedValueOnce(null),
      updateMany: mutateTurn,
    },
  });

  await expect(withProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    operation: 'ensure-session',
    leaseOwner: 'portal-process-b',
    expectedVersion: 7,
    now: NOW,
  }, callback, db)).rejects.toMatchObject({
    code: 'TURN_ACTIVE',
  });

  expect(callback).not.toHaveBeenCalled();
  expect(mutateTurn).not.toHaveBeenCalled();
});

test('runtime admission fails closed when project deletion has closed lifecycle admission', async () => {
  const create = jest.fn();
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'DELETING' }) },
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state()) },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create },
  });

  await expect(acquireProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    operation: 'send',
    leaseOwner: 'portal-process-b',
    expectedVersion: 7,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'PROJECT_CLOSED' });
  expect(create).not.toHaveBeenCalled();
});

test('promotes runtime admission into the user turn without releasing the active project slot', async () => {
  const leaseToken = 'runtime-admission-token';
  const admission = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:admission-uuid`,
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
  });
  const message = userMessage();
  const promoted = turn({
    ...admission,
    requestId: message.id,
    runtime: 'openclaw-dedicated-project-agent',
    providerSessionId: 'agent:p4oc-test:portal-project',
  });
  const updateTurn = jest.fn().mockResolvedValue({ count: 1 });
  const updateState = jest.fn();
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        selectedProvider: AgentProviderType.CODEX,
        version: 8,
        activeTurnId: admission.id,
      })),
      updateMany: updateState,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(admission)
        .mockResolvedValueOnce(promoted),
      updateMany: updateTurn,
    },
    projectChatMessage: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(message),
    },
  });

  await expect(promoteProjectChatRuntimeAdmissionToTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: admission.id,
    leaseToken,
    runtime: promoted.runtime,
    providerSessionId: promoted.providerSessionId,
    userMessage: {
      sessionKey: message.sessionKey,
      content: message.content,
      messageId: message.messageId,
    },
  }, db)).resolves.toMatchObject({
    state: { activeTurnId: admission.id, version: 8 },
    turn: { requestId: promoted.requestId },
    userMessage: { id: message.id, messageId: message.messageId },
  });
  expect(isProjectChatRuntimeAdmissionTurn(promoted)).toBe(false);
  expect(updateState).not.toHaveBeenCalled();
  expect(updateTurn).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      requestId: promoted.requestId,
      resultMetadata: expect.objectContaining({
        providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
      }),
    }),
  }));
});

test('persists the provider dispatch acceptance fence for the exact promoted lease', async () => {
  const leaseToken = 'dispatch-acceptance-token';
  const unconfirmed = turn({
    requestId: 'durable-user-message-row',
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
    resultMetadata: {
      dispatchMetadataVersion: 1,
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
    },
  });
  const accepted = turn({
    ...unconfirmed,
    resultMetadata: {
      dispatchMetadataVersion: 1,
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
      providerDispatchAcceptedAt: NOW.toISOString(),
    },
  });
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectIdentity: {
      findUnique: jest.fn().mockResolvedValue({
        lifecycleStatus: 'ACTIVE',
        legacyOpenClawMigrationStatus: 'COMPLETE',
      }),
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: unconfirmed.id })),
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(unconfirmed)
        .mockResolvedValueOnce(accepted),
      updateMany,
    },
  });

  await expect(markProjectChatTurnProviderDispatchAccepted({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: unconfirmed.id,
    leaseToken,
    now: NOW,
  }, db)).resolves.toEqual(accepted);
  expect(projectChatTurnDispatchStage(accepted)).toBe(PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED);
  expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
    data: {
      resultMetadata: expect.objectContaining({
        providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
        providerDispatchAcceptedAt: NOW.toISOString(),
      }),
    },
  }));
});

test('rejects provider dispatch acceptance after the migration fence closes', async () => {
  const leaseToken = 'dispatch-migration-fence-token';
  const unconfirmed = turn({
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
    resultMetadata: {
      dispatchMetadataVersion: 1,
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
    },
  });
  const updateMany = jest.fn();
  const db = database({
    projectIdentity: {
      findUnique: jest.fn().mockResolvedValue({
        lifecycleStatus: 'ACTIVE',
        legacyOpenClawMigrationStatus: 'PENDING',
      }),
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: unconfirmed.id })),
    },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(unconfirmed),
      updateMany,
    },
  });

  await expect(markProjectChatTurnProviderDispatchAccepted({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: unconfirmed.id,
    leaseToken,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'PROJECT_CLOSED' });
  expect(updateMany).not.toHaveBeenCalled();
});

test('rolls back the user row when promotion fails, then commits one reload-safe request on retry', async () => {
  const leaseToken = 'atomic-user-message-promotion-token';
  const admission = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:atomic-admission`,
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
  });
  const message = userMessage({ runtime: admission.runtime });
  let committedMessages: ReturnType<typeof userMessage>[] = [];
  let committedRequestId = admission.requestId;
  let rejectPromotion = true;

  const db = {
    $transaction: jest.fn(async (operation: (transaction: any) => Promise<unknown>) => {
      const pendingMessages = committedMessages.map((entry) => ({ ...entry }));
      let pendingRequestId = committedRequestId;
      const transaction = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            authorizationVersion: AUTHORIZATION_VERSION,
            accountStatus: 'ACTIVE',
            isActive: true,
          }),
        },
        projectAuthorizationTransition: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        projectChatState: {
          findUnique: jest.fn().mockResolvedValue(state({
            activeTurnId: admission.id,
            selectedProvider: admission.provider,
          })),
        },
        projectChatMessage: {
          findFirst: jest.fn(async ({ where }: any) => (
            pendingMessages.find((entry) => (
              entry.userId === where.userId
              && entry.projectId === where.projectId
              && entry.messageId === where.messageId
            )) || null
          )),
          create: jest.fn(async ({ data }: any) => {
            const created = { ...message, ...data };
            pendingMessages.push(created);
            return created;
          }),
        },
        projectChatTurn: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.id === admission.id) return { ...admission, requestId: pendingRequestId };
            const requestId = where.actorUserId_projectIdentityId_requestId?.requestId;
            return requestId && requestId === pendingRequestId
              ? { ...admission, requestId: pendingRequestId }
              : null;
          }),
          updateMany: jest.fn(async ({ data }: any) => {
            if (rejectPromotion) return { count: 0 };
            pendingRequestId = data.requestId;
            return { count: 1 };
          }),
        },
      };
      const result = await operation(transaction);
      committedMessages = pendingMessages;
      committedRequestId = pendingRequestId;
      return result;
    }),
  } as unknown as ProjectChatLeaseDatabase;

  const input = {
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: admission.id,
    leaseToken,
    runtime: admission.runtime,
    providerSessionId: message.providerSessionId,
    userMessage: {
      sessionKey: message.sessionKey,
      content: message.content,
      messageId: message.messageId,
    },
  };

  await expect(promoteProjectChatRuntimeAdmissionToTurn(input, db)).rejects.toMatchObject({
    code: 'VERSION_CONFLICT',
  });
  expect(committedMessages).toEqual([]);
  expect(committedRequestId).toBe(admission.requestId);

  rejectPromotion = false;
  await expect(promoteProjectChatRuntimeAdmissionToTurn(input, db)).resolves.toMatchObject({
    turn: { requestId: message.id },
    userMessage: { id: message.id, messageId: message.messageId },
  });
  expect(committedMessages).toHaveLength(1);
  expect(committedMessages[0]).toMatchObject({
    id: message.id,
    messageId: message.messageId,
    content: message.content,
  });
  expect(committedRequestId).toBe(message.id);

  // A browser reload observes either neither record (the rolled-back attempt)
  // or this exact message/turn pair. Replaying the stable browser message ID
  // therefore attaches to the committed turn instead of creating a duplicate.
  const reloadedMessage = committedMessages.find((entry) => entry.messageId === message.messageId);
  expect(reloadedMessage?.id).toBe(committedRequestId);
});

test('adopts one exact pre-existing user row without duplicating it during promotion recovery', async () => {
  const leaseToken = 'atomic-existing-message-token';
  const admission = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:existing-message-admission`,
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
  });
  const message = userMessage({
    runtime: admission.runtime,
    providerSessionId: 'provider-session-existing',
  });
  const promoted = turn({
    ...admission,
    requestId: message.id,
    providerSessionId: message.providerSessionId,
  });
  const create = jest.fn();
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: admission.id,
        selectedProvider: admission.provider,
      })),
    },
    projectChatMessage: {
      findFirst: jest.fn().mockResolvedValue(message),
      create,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(admission)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(promoted),
      updateMany,
    },
  });

  await expect(promoteProjectChatRuntimeAdmissionToTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: admission.id,
    leaseToken,
    runtime: admission.runtime,
    providerSessionId: message.providerSessionId,
    userMessage: {
      sessionKey: message.sessionKey,
      content: message.content,
      messageId: message.messageId,
    },
  }, db)).resolves.toMatchObject({
    turn: { requestId: message.id },
    userMessage: { id: message.id },
  });
  expect(create).not.toHaveBeenCalled();
  expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ requestId: message.id }),
  }));
});

test('runtime admission completion atomically releases the turn and commits provider selection', async () => {
  const leaseToken = 'runtime-switch-token';
  const admission = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}switch-provider:admission-uuid`,
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
  });
  const completed = turn({ ...admission, status: ProjectChatTurnStatus.COMPLETED, activeProjectKey: null });
  const activeState = state({ activeTurnId: admission.id, version: 8 });
  const switchedState = state({
    activeTurnId: null,
    version: 9,
    selectedProvider: AgentProviderType.OPENCLAW,
  });
  const releaseState = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatState: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(activeState)
        .mockResolvedValueOnce(switchedState),
      updateMany: releaseState,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(admission)
        .mockResolvedValueOnce(completed),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  });

  await expect(finishProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: admission.id,
    leaseToken,
    status: 'COMPLETED',
    requestedProviderAfterSuccess: 'OPENCLAW',
    now: NOW,
  }, db)).resolves.toMatchObject({ state: { selectedProvider: 'OPENCLAW', version: 9 } });
  expect(releaseState).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ activeTurnId: admission.id, selectedProvider: 'CODEX' }),
    data: expect.objectContaining({ activeTurnId: null, selectedProvider: 'OPENCLAW' }),
  }));
});

test.each([
  'STALE_RUNTIME_ADMISSION_RECOVERED',
  'DESTRUCTIVE_RESET_RECOVERED_RUNTIME_ADMISSION',
])('a superseded runtime admission cannot falsely report idempotent success for %s', async (errorCode) => {
  const leaseToken = `superseded-${errorCode}`;
  const superseded = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}ensure-session:old-process`,
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
    status: ProjectChatTurnStatus.ERROR,
    activeProjectKey: null,
    errorCode,
  });
  const db = database({
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(superseded) },
  });

  await expect(finishProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: superseded.id,
    leaseToken,
    status: 'ERROR',
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'TURN_NOT_ACTIVE', httpStatus: 409 });
});

test('send and provider switch cannot both win the same state version', async () => {
  const active = state({ activeTurnId: 'turn-uuid' });
  const db = database({
    projectChatState: { findUnique: jest.fn().mockResolvedValue(active) },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(turn()) },
  });
  await expect(switchProjectChatProvider({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    expectedVersion: 7,
    requestedProvider: 'OPENCLAW',
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
});

test('a stale lease remains quarantined and blocks new admission without provider-stop proof', async () => {
  const staleTurn = turn({ leaseExpiresAt: new Date(NOW.getTime() - 1) });
  const mutateTurn = jest.fn();
  const mutateState = jest.fn();
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: staleTurn.id })),
      updateMany: mutateState,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(staleTurn)
        .mockResolvedValueOnce(null),
      updateMany: mutateTurn,
      create: jest.fn(),
    },
  });

  await expect(acquireProjectChatTurn({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    requestId: 'new-request-after-heartbeat-loss',
    leaseOwner: 'portal-process-after-restart',
    expectedVersion: 7,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
  expect(mutateTurn).not.toHaveBeenCalled();
  expect(mutateState).not.toHaveBeenCalled();
});

test('ordinary coordination reads expose a stale active turn without silently detaching it', async () => {
  const staleTurn = turn({ leaseExpiresAt: new Date(NOW.getTime() - 1) });
  const mutateTurn = jest.fn();
  const mutateState = jest.fn();
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: staleTurn.id })),
      updateMany: mutateState,
    },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(staleTurn),
      updateMany: mutateTurn,
    },
  });

  await expect(readProjectChatCoordinationState({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    now: NOW,
  }, db)).resolves.toMatchObject({
    state: { activeTurnId: staleTurn.id, version: 7 },
    activeTurn: { id: staleTurn.id, status: 'RUNNING' },
  });
  expect(mutateTurn).not.toHaveBeenCalled();
  expect(mutateState).not.toHaveBeenCalled();
});

test('a missing active-turn row is corruption and cannot free the project CAS slot', async () => {
  const mutateState = jest.fn();
  const createTurn = jest.fn();
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: 'missing-turn-row' })),
      updateMany: mutateState,
    },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(null), create: createTurn },
  });

  await expect(acquireProjectChatTurn({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    requestId: 'must-not-claim-corrupt-state',
    leaseOwner: 'portal-process-after-restart',
    expectedVersion: 7,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'STATE_CORRUPT', httpStatus: 500 });
  expect(mutateState).not.toHaveBeenCalled();
  expect(createTurn).not.toHaveBeenCalled();
});

test.each(['qualify-code', 'switch-provider', 'ensure-session', 'send', 'destructive-reset'])(
  'an expired %s runtime admission cannot be automatically replayed by a new process',
  async (operation) => {
    const staleAdmission = turn({
      id: `stale-${operation}`,
      requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}${operation}:old-process`,
      leaseOwner: 'portal-host:101:old-process-uuid',
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    });
    const mutateTurn = jest.fn();
    const mutateState = jest.fn();
    const createTurn = jest.fn();
    const db = database({
      projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
      projectChatState: {
        findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: staleAdmission.id })),
        updateMany: mutateState,
      },
      projectChatTurn: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(staleAdmission)
          .mockResolvedValueOnce(null),
        updateMany: mutateTurn,
        create: createTurn,
      },
    });

    await expect(acquireProjectChatRuntimeAdmission({
      actorUserId: ACTOR,
      actorAuthorizationVersion: AUTHORIZATION_VERSION,
      projectIdentityId: PROJECT,
      provider: 'CODEX',
      runtime: 'codex-project-adapter',
      operation,
      leaseOwner: 'portal-host:202:new-process-uuid',
      expectedVersion: 7,
      now: NOW,
    }, db)).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
    expect(mutateTurn).not.toHaveBeenCalled();
    expect(mutateState).not.toHaveBeenCalled();
    expect(createTurn).not.toHaveBeenCalled();
  },
);

test('an expired runtime admission owned by this process remains quarantined', async () => {
  const sameOwner = 'portal-host:202:same-process-uuid';
  const staleAdmission = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:same-process`,
    leaseOwner: sameOwner,
    leaseExpiresAt: new Date(NOW.getTime() - 1),
  });
  const mutateTurn = jest.fn();
  const mutateState = jest.fn();
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: staleAdmission.id })),
      updateMany: mutateState,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(staleAdmission)
        .mockResolvedValueOnce(null),
      updateMany: mutateTurn,
    },
  });

  await expect(acquireProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    operation: 'send',
    leaseOwner: sameOwner,
    expectedVersion: 7,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
  expect(mutateTurn).not.toHaveBeenCalled();
  expect(mutateState).not.toHaveBeenCalled();
});

test.each([
  ['the exact old process is still alive', 'send', false],
  ['the requested operation differs', 'switch-provider', true],
] as const)('an expired runtime admission remains quarantined when %s', async (_label, nextOperation, _ownerInactive) => {
  const staleAdmission = turn({
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:old-process`,
    leaseOwner: 'portal-host:101:old-process',
    leaseExpiresAt: new Date(NOW.getTime() - 1),
  });
  const mutateTurn = jest.fn();
  const mutateState = jest.fn();
  const db = database({
    projectIdentity: { findUnique: jest.fn().mockResolvedValue({ lifecycleStatus: 'ACTIVE' }) },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: staleAdmission.id })),
      updateMany: mutateState,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(staleAdmission)
        .mockResolvedValueOnce(null),
      updateMany: mutateTurn,
    },
  });

  await expect(acquireProjectChatRuntimeAdmission({
    actorUserId: ACTOR,
    actorAuthorizationVersion: AUTHORIZATION_VERSION,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    operation: nextOperation,
    leaseOwner: 'portal-host:202:new-process',
    expectedVersion: 7,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
  expect(mutateTurn).not.toHaveBeenCalled();
  expect(mutateState).not.toHaveBeenCalled();
});

test('abort request is idempotent and never changes a terminal turn', async () => {
  const aborting = turn({ status: ProjectChatTurnStatus.ABORTING });
  const updateMany = jest.fn();
  const db = database({
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: aborting.id })) },
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(aborting), updateMany },
  });
  await expect(requestProjectChatTurnAbort({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: aborting.id,
    expectedProvider: 'CODEX',
  }, db)).resolves.toMatchObject({ status: 'ABORTING' });
  expect(updateMany).not.toHaveBeenCalled();
});

test('provider-confirmed abort is restart-safe and releases the project CAS row', async () => {
  const aborting = turn({
    status: ProjectChatTurnStatus.ABORTING,
    leaseExpiresAt: new Date(NOW.getTime() - 60_000),
    provider: AgentProviderType.OPENCLAW,
    runtime: 'openclaw-project-sandbox',
    providerSessionId: 'agent:portal-project-abcd:project-abcd',
  });
  const aborted = turn({
    ...aborting,
    status: ProjectChatTurnStatus.ABORTED,
    activeProjectKey: null,
    completedAt: NOW,
  });
  const finalize = jest.fn().mockResolvedValue({ count: 1 });
  const detach = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: aborting.id,
        selectedProvider: AgentProviderType.OPENCLAW,
      })),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(aborting)
        .mockResolvedValueOnce(aborted),
      updateMany: finalize,
    },
  });

  await expect(confirmProjectChatTurnAbort({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: aborting.id,
    expectedProvider: 'OPENCLAW',
    providerSessionId: aborting.providerSessionId,
    now: NOW,
  }, db)).resolves.toMatchObject({ status: 'ABORTED', activeProjectKey: null });
  expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: aborting.id, status: 'ABORTING' },
    data: expect.objectContaining({ status: 'ABORTED', activeProjectKey: null }),
  }));
  expect(detach).toHaveBeenCalledWith(expect.objectContaining({
    data: { activeTurnId: null, version: { increment: 1 } },
  }));
});

test('provider-terminal restart recovery expires only the exact dispatched turn and releases its CAS row', async () => {
  const startedAt = new Date(NOW.getTime() - 180_000);
  const leaseExpiresAt = new Date(NOW.getTime() - 60_000);
  const providerStartedAt = new Date(NOW.getTime() - 150_000);
  const providerEndedAt = new Date(NOW.getTime() - 30_000);
  const interrupted = turn({
    provider: AgentProviderType.OPENCLAW,
    runtime: 'openclaw-dedicated-project-agent',
    providerSessionId: 'agent:p4oc-test:portal-project',
    startedAt,
    leaseExpiresAt,
    resultMetadata: {
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
      dispatchMetadataVersion: 1,
    },
  });
  const recovered = turn({
    ...interrupted,
    status: ProjectChatTurnStatus.EXPIRED,
    activeProjectKey: null,
    completedAt: NOW,
    errorCode: 'PORTAL_RESTART_PROVIDER_TERMINAL',
  });
  const finalize = jest.fn().mockResolvedValue({ count: 1 });
  const detach = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: interrupted.id,
        selectedProvider: AgentProviderType.OPENCLAW,
      })),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(recovered),
      updateMany: finalize,
    },
    projectChatProviderBinding: {
      findUnique: jest.fn().mockResolvedValue({
        userId: ACTOR,
        projectId: PROJECT,
        provider: AgentProviderType.OPENCLAW,
        runtime: interrupted.runtime,
        sessionKey: interrupted.providerSessionId,
        externalSessionId: interrupted.providerSessionId,
        status: 'active',
      }),
    },
  });

  await expect(recoverExpiredProjectChatTurnAfterProviderTerminal({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: interrupted.id,
    expectedProvider: 'OPENCLAW',
    expectedRuntime: interrupted.runtime,
    expectedLeaseOwner: interrupted.leaseOwner,
    providerSessionId: interrupted.providerSessionId!,
    providerStatus: 'done',
    providerStartedAt,
    providerEndedAt,
    now: NOW,
  }, db)).resolves.toMatchObject({
    status: 'EXPIRED',
    activeProjectKey: null,
    errorCode: 'PORTAL_RESTART_PROVIDER_TERMINAL',
  });
  expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      id: interrupted.id,
      status: { in: ['RUNNING', 'ABORTING'] },
      provider: 'OPENCLAW',
      runtime: interrupted.runtime,
      leaseOwner: interrupted.leaseOwner,
      providerSessionId: interrupted.providerSessionId,
      leaseExpiresAt: { lte: NOW },
    }),
    data: expect.objectContaining({
      status: 'EXPIRED',
      activeProjectKey: null,
      errorCode: 'PORTAL_RESTART_PROVIDER_TERMINAL',
      resultMetadata: expect.objectContaining({
        providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
        restartRecoveryVersion: 1,
        restartRecoveryProviderStatus: 'done',
        presentationMaterialized: false,
      }),
    }),
  }));
  expect(detach).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      activeTurnId: interrupted.id,
      selectedProvider: 'OPENCLAW',
      version: 7,
    }),
    data: { activeTurnId: null, version: { increment: 1 } },
  }));
});

test('restart recovery keeps an expired turn quarantined when the provider binding changed', async () => {
  const interrupted = turn({
    provider: AgentProviderType.OPENCLAW,
    runtime: 'openclaw-dedicated-project-agent',
    providerSessionId: 'agent:p4oc-test:portal-project',
    startedAt: new Date(NOW.getTime() - 180_000),
    leaseExpiresAt: new Date(NOW.getTime() - 60_000),
    resultMetadata: { providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED },
  });
  const finalize = jest.fn();
  const detach = jest.fn();
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: interrupted.id,
        selectedProvider: AgentProviderType.OPENCLAW,
      })),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(interrupted),
      updateMany: finalize,
    },
    projectChatProviderBinding: {
      findUnique: jest.fn().mockResolvedValue({
        provider: AgentProviderType.OPENCLAW,
        runtime: interrupted.runtime,
        sessionKey: 'agent:p4oc-test:replacement-session',
        externalSessionId: 'agent:p4oc-test:replacement-session',
        status: 'active',
      }),
    },
  });

  await expect(recoverExpiredProjectChatTurnAfterProviderTerminal({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: interrupted.id,
    expectedProvider: 'OPENCLAW',
    expectedRuntime: interrupted.runtime,
    expectedLeaseOwner: interrupted.leaseOwner,
    providerSessionId: interrupted.providerSessionId!,
    providerStatus: 'done',
    providerStartedAt: new Date(NOW.getTime() - 150_000),
    providerEndedAt: new Date(NOW.getTime() - 30_000),
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'STATE_CORRUPT', httpStatus: 500 });
  expect(finalize).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
});

test('native restart recovery expires an exact quiescent turn and releases its CAS row', async () => {
  const interrupted = turn({
    provider: AgentProviderType.CODEX,
    runtime: 'codex-project-adapter',
    providerSessionId: 'codex-native-session',
    startedAt: new Date(NOW.getTime() - 180_000),
    leaseExpiresAt: new Date(NOW.getTime() - 60_000),
    resultMetadata: {
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
      dispatchMetadataVersion: 1,
    },
  });
  const recovered = turn({
    ...interrupted,
    status: ProjectChatTurnStatus.EXPIRED,
    activeProjectKey: null,
    completedAt: NOW,
    errorCode: 'PORTAL_RESTART_NATIVE_TURN_QUIESCENT',
  });
  const finalize = jest.fn().mockResolvedValue({ count: 1 });
  const detach = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: interrupted.id })),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(interrupted)
        .mockResolvedValueOnce(recovered),
      updateMany: finalize,
    },
    projectChatProviderBinding: {
      findUnique: jest.fn().mockResolvedValue({
        userId: ACTOR,
        projectId: PROJECT,
        provider: AgentProviderType.CODEX,
        runtime: interrupted.runtime,
        sessionKey: interrupted.providerSessionId,
        externalSessionId: interrupted.providerSessionId,
        status: 'active',
      }),
    },
  });

  await expect(recoverExpiredProjectChatOperationAfterNativeQuiescence({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: interrupted.id,
    expectedSelectedProvider: 'CODEX',
    expectedRuntime: interrupted.runtime,
    expectedLeaseOwner: interrupted.leaseOwner,
    quiescedProvider: 'CODEX',
    quiescenceBoundary: 'container-stopped',
    quiescenceEvidence: 'a'.repeat(64),
    providerSessionId: interrupted.providerSessionId,
    now: NOW,
  }, db)).resolves.toMatchObject({
    status: 'EXPIRED',
    errorCode: 'PORTAL_RESTART_NATIVE_TURN_QUIESCENT',
  });
  expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      id: interrupted.id,
      provider: 'CODEX',
      runtime: interrupted.runtime,
      providerSessionId: interrupted.providerSessionId,
      leaseExpiresAt: { lte: NOW },
    }),
    data: expect.objectContaining({
      status: 'EXPIRED',
      activeProjectKey: null,
      resultMetadata: expect.objectContaining({
        providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
        restartRecoveryVersion: 2,
        restartRecoveryProvider: 'CODEX',
        restartRecoveryBoundary: 'container-stopped',
        restartRecoveryEvidence: 'a'.repeat(64),
      }),
    }),
  }));
  expect(detach).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ activeTurnId: interrupted.id, selectedProvider: 'CODEX' }),
  }));
});

test('native restart recovery releases a provider-targeted runtime admission only after quiescence', async () => {
  const admission = turn({
    provider: AgentProviderType.OPENCLAW,
    runtime: 'claude-code-project-adapter',
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}qualify-claude:uuid`,
    providerSessionId: null,
    leaseExpiresAt: new Date(NOW.getTime() - 60_000),
  });
  const recovered = turn({
    ...admission,
    status: ProjectChatTurnStatus.ERROR,
    activeProjectKey: null,
    completedAt: NOW,
    errorCode: 'PORTAL_RESTART_NATIVE_RUNTIME_ADMISSION',
  });
  const finalize = jest.fn().mockResolvedValue({ count: 1 });
  const detach = jest.fn().mockResolvedValue({ count: 1 });
  const bindingRead = jest.fn();
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: admission.id,
        selectedProvider: AgentProviderType.OPENCLAW,
      })),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(admission)
        .mockResolvedValueOnce(recovered),
      updateMany: finalize,
    },
    projectChatProviderBinding: { findUnique: bindingRead },
  });

  await expect(recoverExpiredProjectChatOperationAfterNativeQuiescence({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: admission.id,
    expectedSelectedProvider: 'OPENCLAW',
    expectedRuntime: admission.runtime,
    expectedLeaseOwner: admission.leaseOwner,
    quiescedProvider: 'CLAUDE_CODE',
    quiescenceBoundary: 'runtime-absent',
    quiescenceEvidence: 'b'.repeat(64),
    now: NOW,
  }, db)).resolves.toMatchObject({
    status: 'ERROR',
    errorCode: 'PORTAL_RESTART_NATIVE_RUNTIME_ADMISSION',
  });
  expect(bindingRead).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      provider: 'OPENCLAW',
      runtime: admission.runtime,
      requestId: { startsWith: PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX },
    }),
    data: expect.objectContaining({
      status: 'ERROR',
      errorCode: 'PORTAL_RESTART_NATIVE_RUNTIME_ADMISSION',
      resultMetadata: expect.objectContaining({
        restartRecoveryKind: 'runtime-admission',
        restartRecoveryProvider: 'CLAUDE_CODE',
        restartRecoveryBoundary: 'runtime-absent',
      }),
    }),
  }));
});

test('native restart recovery rejects admission evidence from a provider that does not own the runtime', async () => {
  const db = database({});

  await expect(recoverExpiredProjectChatOperationAfterNativeQuiescence({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: 'admission-turn',
    expectedSelectedProvider: 'OPENCLAW',
    expectedRuntime: 'claude-code-project-adapter',
    expectedLeaseOwner: 'portal-process-a',
    quiescedProvider: 'CODEX',
    quiescenceBoundary: 'runtime-absent',
    quiescenceEvidence: 'b'.repeat(64),
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
  expect(db.$transaction).not.toHaveBeenCalled();
});

test('native restart recovery refuses a user turn attested for another provider', async () => {
  const interrupted = turn({
    provider: AgentProviderType.CODEX,
    runtime: 'codex-project-adapter',
    providerSessionId: 'codex-native-session',
    leaseExpiresAt: new Date(NOW.getTime() - 60_000),
  });
  const finalize = jest.fn();
  const db = database({
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(interrupted),
      updateMany: finalize,
    },
  });

  await expect(recoverExpiredProjectChatOperationAfterNativeQuiescence({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: interrupted.id,
    expectedSelectedProvider: 'CODEX',
    expectedRuntime: interrupted.runtime,
    expectedLeaseOwner: interrupted.leaseOwner,
    quiescedProvider: 'GEMINI',
    quiescenceBoundary: 'container-stopped',
    quiescenceEvidence: 'c'.repeat(64),
    providerSessionId: interrupted.providerSessionId,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
  expect(finalize).not.toHaveBeenCalled();
});

test('completion is monotonic and a repeated callback returns the durable terminal row', async () => {
  const token = 'completion-token';
  const digest = require('crypto').createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest });
  const completed = turn({
    leaseTokenHash: digest,
    status: ProjectChatTurnStatus.COMPLETED,
    completedAt: NOW,
  });
  const firstDb = database({
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(completed),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: running.id })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  });
  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    transcriptCursor: 11,
    now: NOW,
  }, firstDb)).resolves.toMatchObject({ status: 'COMPLETED' });

  const restartedDb = database({
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(completed) },
  });
  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    transcriptCursor: 11,
    now: NOW,
  }, restartedDb)).resolves.toMatchObject({ status: 'COMPLETED' });
});

test('completion advances provider handoff before detaching the turn in one transaction', async () => {
  const token = 'atomic-settlement-token';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest });
  const completed = turn({
    leaseTokenHash: digest,
    status: ProjectChatTurnStatus.COMPLETED,
    completedAt: NOW,
  });
  const advanceHandoff = jest.fn().mockResolvedValue({ count: 1 });
  const detachState = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(completed),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: running.id })),
      updateMany: detachState,
    },
    projectChatProviderBinding: {
      updateMany: advanceHandoff,
      findUnique: jest.fn()
        .mockResolvedValueOnce({
          status: 'active',
          handoffCursor: 0,
          handoffVersion: 1,
        })
        .mockResolvedValueOnce({
          status: 'active',
          handoffCursor: 11,
          handoffVersion: 2,
        }),
    },
  });

  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    transcriptCursor: 11,
    handoff: {
      provider: 'CODEX',
      expectedHandoffVersion: 1,
      expectedCursor: 0,
      nextCursor: 11,
    },
    now: NOW,
  }, db)).resolves.toMatchObject({ status: 'COMPLETED' });

  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect(advanceHandoff).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ handoffVersion: 1, handoffCursor: 0 }),
    data: expect.objectContaining({ handoffCursor: 11 }),
  }));
  expect(advanceHandoff.mock.invocationCallOrder[0]).toBeLessThan(
    detachState.mock.invocationCallOrder[0],
  );
});

test('assistant projection, completed handoff, turn finalization, and state detach share one transaction', async () => {
  const token = 'atomic-projection-token';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest, providerSessionId: 'codex-session' });
  const completed = turn({
    leaseTokenHash: digest,
    providerSessionId: 'codex-session',
    status: ProjectChatTurnStatus.COMPLETED,
    completedAt: NOW,
  });
  const createProjection = jest.fn().mockResolvedValue({ id: 'assistant-row' });
  const advanceHandoff = jest.fn().mockResolvedValue({ count: 1 });
  const finalizeTurn = jest.fn().mockResolvedValue({ count: 1 });
  const detachState = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(completed),
      updateMany: finalizeTurn,
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: running.id,
        transcriptCursor: 10,
      })),
      updateMany: detachState,
    },
    projectChatProviderBinding: {
      findUnique: jest.fn()
        .mockResolvedValueOnce({ status: 'active', handoffCursor: 10, handoffVersion: 4 })
        .mockResolvedValueOnce({ status: 'active', handoffCursor: 11, handoffVersion: 5 }),
      updateMany: advanceHandoff,
    },
    projectChatMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: createProjection,
      count: jest.fn().mockResolvedValue(11),
    },
  });

  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    providerSessionId: 'codex-session',
    assistantProjection: {
      sessionKey: 'portal-session',
      content: 'Atomic assistant result',
      presentation: { version: 2, terminalStatus: 'completed' },
    },
    resultMetadata: { durableEventCount: 3 },
    handoff: {
      provider: 'CODEX',
      expectedHandoffVersion: 4,
      expectedCursor: 10,
    },
    now: NOW,
  }, db)).resolves.toMatchObject({ status: 'COMPLETED' });

  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect(createProjection).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      turnId: running.id,
      messageId: `project-turn:${running.id}`,
      content: 'Atomic assistant result',
    }),
  }));
  expect(finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      status: 'COMPLETED',
      resultMetadata: expect.objectContaining({
        atomicSettlementVersion: 2,
        presentationMaterialized: true,
        settledTranscriptCursor: 11,
        settledHandoffCursor: 11,
        settledHandoffVersion: 5,
      }),
    }),
  }));
  expect(createProjection.mock.invocationCallOrder[0]).toBeLessThan(finalizeTurn.mock.invocationCallOrder[0]);
  expect(advanceHandoff.mock.invocationCallOrder[0]).toBeLessThan(finalizeTurn.mock.invocationCallOrder[0]);
  expect(finalizeTurn.mock.invocationCallOrder[0]).toBeLessThan(detachState.mock.invocationCallOrder[0]);
});

test('projection failure prevents terminal turn and state mutation', async () => {
  const token = 'projection-failure-token';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest });
  const finalizeTurn = jest.fn();
  const advanceHandoff = jest.fn();
  const detachState = jest.fn();
  const db = database({
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(running),
      updateMany: finalizeTurn,
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: running.id })),
      updateMany: detachState,
    },
    projectChatProviderBinding: {
      findUnique: jest.fn().mockResolvedValue({ status: 'active', handoffCursor: 10, handoffVersion: 4 }),
      updateMany: advanceHandoff,
    },
    projectChatMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue(new Error('projection unavailable')),
    },
  });

  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    assistantProjection: { sessionKey: 'portal-session', content: 'Assistant result' },
    handoff: { provider: 'CODEX', expectedHandoffVersion: 4, expectedCursor: 10 },
  }, db)).rejects.toThrow('projection unavailable');
  expect(finalizeTurn).not.toHaveBeenCalled();
  expect(advanceHandoff).not.toHaveBeenCalled();
  expect(detachState).not.toHaveBeenCalled();
});

test('changed provider generation is rejected before assistant projection', async () => {
  const token = 'generation-fence-token';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest });
  const createProjection = jest.fn();
  const finalizeTurn = jest.fn();
  const db = database({
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(running), updateMany: finalizeTurn },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: running.id })),
      updateMany: jest.fn(),
    },
    projectChatProviderBinding: {
      findUnique: jest.fn().mockResolvedValue({
        status: 'active',
        handoffCursor: 0,
        handoffVersion: 9,
      }),
      updateMany: jest.fn(),
    },
    projectChatMessage: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: createProjection,
    },
  });

  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    assistantProjection: { sessionKey: 'portal-session', content: 'Must not publish' },
    handoff: { provider: 'CODEX', expectedHandoffVersion: 4, expectedCursor: 0 },
  }, db)).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  expect(createProjection).not.toHaveBeenCalled();
  expect(finalizeTurn).not.toHaveBeenCalled();
});

test('an expired detached turn is a terminal fence and cannot project a late callback', async () => {
  const token = 'expired-callback-token';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const expired = turn({
    leaseTokenHash: digest,
    status: ProjectChatTurnStatus.EXPIRED,
    activeProjectKey: null,
    completedAt: NOW,
  });
  const readState = jest.fn();
  const createProjection = jest.fn();
  const db = database({
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(expired) },
    projectChatState: { findUnique: readState },
    projectChatMessage: { create: createProjection },
  });

  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: expired.id,
    leaseToken: token,
    status: 'COMPLETED',
    assistantProjection: { sessionKey: 'portal-session', content: 'Late callback' },
    handoff: { provider: 'CODEX', expectedHandoffVersion: 4, expectedCursor: 0 },
  }, db)).resolves.toMatchObject({ status: 'EXPIRED' });
  expect(readState).not.toHaveBeenCalled();
  expect(createProjection).not.toHaveBeenCalled();
});

test('admission-owned legacy reconciliation advances only through the old session terminal row', async () => {
  const leaseToken = 'legacy-repair-admission-token';
  const digest = crypto.createHash('sha256').update(leaseToken).digest('hex');
  const admissionTurn = turn({
    id: 'legacy-repair-admission',
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:legacy-repair`,
    leaseTokenHash: digest,
    status: ProjectChatTurnStatus.RUNNING,
  });
  const admissionState = state({
    activeTurnId: admissionTurn.id,
    version: 8,
    transcriptCursor: 3,
  });
  const binding = {
    id: 'binding-legacy-repair',
    userId: ACTOR,
    projectId: PROJECT,
    provider: AgentProviderType.CODEX,
    status: 'active',
    sessionKey: 'codex-old-session',
    externalSessionId: 'codex-old-session',
    handoffCursor: 0,
    handoffVersion: 4,
  };
  const repairedBinding = { ...binding, handoffCursor: 2, handoffVersion: 5 };
  const advance = jest.fn().mockResolvedValue({ count: 1 });
  const findLegacyTurns = jest.fn().mockResolvedValue([
    turn({
      id: 'legacy-terminal-turn',
      providerSessionId: 'codex-old-session',
      status: ProjectChatTurnStatus.COMPLETED,
      resultMetadata: { presentationMaterialized: true },
    }),
  ]);
  const db = database({
    projectChatState: { findUnique: jest.fn().mockResolvedValue(admissionState) },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(admissionTurn),
      findMany: findLegacyTurns,
    },
    projectChatProviderBinding: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(binding)
        .mockResolvedValueOnce(repairedBinding),
      updateMany: advance,
    },
    projectChatMessage: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'user-before', turnId: null },
        { id: 'assistant-legacy', turnId: 'legacy-terminal-turn' },
        { id: 'newer-cross-provider-user', turnId: null },
      ]),
    },
  });

  await expect(reconcileLegacyProjectChatTerminalHandoff({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    admission: {
      state: admissionState as any,
      turn: admissionTurn as any,
      leaseToken,
      idempotentReplay: false,
      operation: 'send',
    },
    now: NOW,
  }, db)).resolves.toMatchObject({ handoffCursor: 2, handoffVersion: 5 });
  expect(advance).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      id: binding.id,
      handoffCursor: 0,
      handoffVersion: 4,
    }),
    data: expect.objectContaining({ handoffCursor: 2 }),
  }));
  expect(findLegacyTurns).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ status: ProjectChatTurnStatus.COMPLETED }),
  }));
});

test.each([
  ProjectChatTurnStatus.ERROR,
  ProjectChatTurnStatus.ABORTED,
  ProjectChatTurnStatus.EXPIRED,
])('legacy %s turns never advance provider handoff', async (terminalStatus) => {
  const leaseToken = `legacy-${terminalStatus.toLowerCase()}-token`;
  const admissionTurn = turn({
    id: `legacy-${terminalStatus.toLowerCase()}-admission`,
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}send:legacy-${terminalStatus.toLowerCase()}`,
    leaseTokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'),
  });
  const admissionState = state({ activeTurnId: admissionTurn.id, version: 8 });
  const binding = {
    id: 'binding-noncompleted-legacy',
    userId: ACTOR,
    projectId: PROJECT,
    provider: AgentProviderType.CODEX,
    status: 'active',
    sessionKey: 'codex-old-session',
    externalSessionId: 'codex-old-session',
    handoffCursor: 0,
    handoffVersion: 4,
  };
  const readTranscript = jest.fn();
  const advance = jest.fn();
  const db = database({
    projectChatState: { findUnique: jest.fn().mockResolvedValue(admissionState) },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(admissionTurn),
      // Defensive filtering must hold even if a database test double returns
      // a row that contradicts the COMPLETED query predicate.
      findMany: jest.fn().mockResolvedValue([
        turn({
          id: `legacy-${terminalStatus.toLowerCase()}-turn`,
          providerSessionId: 'codex-old-session',
          status: terminalStatus,
        }),
      ]),
    },
    projectChatProviderBinding: {
      findUnique: jest.fn().mockResolvedValue(binding),
      updateMany: advance,
    },
    projectChatMessage: { findMany: readTranscript },
  });

  await expect(reconcileLegacyProjectChatTerminalHandoff({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    admission: {
      state: admissionState as any,
      turn: admissionTurn as any,
      leaseToken,
      idempotentReplay: false,
      operation: 'send',
    },
    now: NOW,
  }, db)).resolves.toEqual(binding);
  expect(readTranscript).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});

test('completion treats a post-reset message count as a stale observation without moving the cursor backwards', async () => {
  const token = 'post-reset-completion-token';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest });
  const completed = turn({
    leaseTokenHash: digest,
    status: ProjectChatTurnStatus.COMPLETED,
    completedAt: NOW,
  });
  const detach = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatTurn: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(completed),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(state({
        activeTurnId: running.id,
        transcriptCursor: 24,
      })),
      updateMany: detach,
    },
  });

  await expect(finishProjectChatTurn({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    status: 'COMPLETED',
    transcriptCursor: 2,
    now: NOW,
  }, db)).resolves.toMatchObject({ status: 'COMPLETED' });
  expect(detach).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ transcriptCursor: 24, version: 7 }),
    data: expect.objectContaining({ transcriptCursor: 24 }),
  }));
});

test('replay events and snapshots are read from durable delegates, not process memory', async () => {
  const token = 'replay-token';
  const digest = require('crypto').createHash('sha256').update(token).digest('hex');
  const running = turn({ leaseTokenHash: digest, lastEventSeq: 0 });
  const persistedEvent = {
    id: 'event-id', turnId: running.id, seq: 1, eventType: 'thinking',
    payload: { content: 'Planning' }, createdAt: NOW,
  };
  const appendDb = database({
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state({ activeTurnId: running.id })) },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(running),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    projectChatTurnEvent: { create: jest.fn().mockResolvedValue(persistedEvent) },
  });
  await expect(appendProjectChatTurnEvent({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    leaseToken: token,
    expectedSeq: 0,
    eventType: 'thinking',
    payload: { content: 'Planning' },
  }, appendDb)).resolves.toMatchObject({ seq: 1 });

  const restartedDb = database({
    projectChatTurn: { findUnique: jest.fn().mockResolvedValue(turn({ lastEventSeq: 1 })) },
    projectChatTurnEvent: { findMany: jest.fn().mockResolvedValue([persistedEvent]) },
  });
  await expect(readProjectChatTurnReplay({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: running.id,
    afterSeq: 0,
  }, restartedDb)).resolves.toMatchObject({
    turn: { lastEventSeq: 1 },
    events: [{ seq: 1, eventType: 'thinking' }],
  });
});

test('provider handoff cursor advances through an independent CAS', async () => {
  const binding = { handoffCursor: 14, handoffVersion: 4 };
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatProviderBinding: {
      updateMany,
      findUnique: jest.fn().mockResolvedValue(binding),
    },
  });
  await expect(advanceProjectChatBindingHandoff({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    expectedHandoffVersion: 3,
    expectedCursor: 10,
    nextCursor: 14,
  }, db)).resolves.toEqual(binding);
  expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      userId: ACTOR,
      projectId: PROJECT,
      provider: 'CODEX',
      handoffVersion: 3,
      handoffCursor: 10,
    }),
  }));
});

test('a failed first provider turn retains bootstrap handoff for retry', async () => {
  const updateMany = jest.fn();
  const db = database({
    projectChatProviderBinding: { updateMany },
  });
  expect(projectChatBindingNeedsHandoff({ handoffCursor: 0, handoffVersion: 1 }, 1)).toBe(true);
  await expect(advanceProjectChatBindingHandoffAfterSettlement({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CLAUDE_CODE',
    settlementStatus: 'ERROR',
    expectedHandoffVersion: 1,
    expectedCursor: 0,
    nextCursor: 1,
  }, db)).resolves.toBeNull();
  expect(updateMany).not.toHaveBeenCalled();
});

test('a completed durable settlement advances handoff exactly once through CAS', async () => {
  const binding = { handoffCursor: 2, handoffVersion: 2 };
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatProviderBinding: {
      updateMany,
      findUnique: jest.fn().mockResolvedValue(binding),
    },
  });
  await expect(advanceProjectChatBindingHandoffAfterSettlement({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CLAUDE_CODE',
    settlementStatus: 'COMPLETED',
    expectedHandoffVersion: 1,
    expectedCursor: 0,
    nextCursor: 2,
  }, db)).resolves.toEqual(binding);
  expect(updateMany).toHaveBeenCalledTimes(1);
  expect(projectChatBindingNeedsHandoff(binding, 2)).toBe(false);
});

test('a repeated completed settlement accepts the already-advanced handoff as idempotent', async () => {
  const binding = { handoffCursor: 2, handoffVersion: 2 };
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const db = database({
    projectChatProviderBinding: {
      updateMany,
      findUnique: jest.fn().mockResolvedValue(binding),
    },
  });

  await expect(advanceProjectChatBindingHandoffAfterSettlement({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CLAUDE_CODE',
    settlementStatus: 'COMPLETED',
    expectedHandoffVersion: 1,
    expectedCursor: 0,
    nextCursor: 2,
  }, db)).resolves.toEqual(binding);
  expect(updateMany).toHaveBeenCalledTimes(1);
});

test('stale pre-atomic settlements converge forward once without losing either transcript boundary', async () => {
  const binding = { handoffCursor: 0, handoffVersion: 1 };
  const updateMany = jest.fn(async ({ where, data }: any) => {
    if (
      where.handoffVersion !== binding.handoffVersion
      || where.handoffCursor !== binding.handoffCursor
    ) {
      return { count: 0 };
    }
    binding.handoffCursor = data.handoffCursor;
    binding.handoffVersion += 1;
    return { count: 1 };
  });
  const db = database({
    projectChatProviderBinding: {
      updateMany,
      findUnique: jest.fn(async () => ({ ...binding })),
    },
  });
  const firstSettlement = {
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CLAUDE_CODE' as const,
    settlementStatus: 'COMPLETED' as const,
    expectedHandoffVersion: 1,
    expectedCursor: 0,
    nextCursor: 2,
  };
  const staleSecondSettlement = { ...firstSettlement, nextCursor: 4 };

  await expect(advanceProjectChatBindingHandoffAfterSettlement(
    firstSettlement,
    db,
  )).resolves.toMatchObject({ handoffCursor: 2, handoffVersion: 2 });
  await expect(advanceProjectChatBindingHandoffAfterSettlement(
    staleSecondSettlement,
    db,
  )).resolves.toMatchObject({ handoffCursor: 4, handoffVersion: 3 });
  await expect(advanceProjectChatBindingHandoffAfterSettlement(
    staleSecondSettlement,
    db,
  )).resolves.toMatchObject({ handoffCursor: 4, handoffVersion: 3 });

  expect(binding).toEqual({ handoffCursor: 4, handoffVersion: 3 });
  expect(updateMany).toHaveBeenCalledTimes(4);
});

test('a superseded completed settlement never revives a cursor reset by a newer binding version', async () => {
  const resetBinding = { handoffCursor: 0, handoffVersion: 3 };
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const db = database({
    projectChatProviderBinding: {
      updateMany,
      findUnique: jest.fn().mockResolvedValue(resetBinding),
    },
  });

  await expect(advanceProjectChatBindingHandoffAfterSettlement({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CLAUDE_CODE',
    settlementStatus: 'COMPLETED',
    expectedHandoffVersion: 1,
    expectedCursor: 0,
    nextCursor: 2,
  }, db)).resolves.toEqual(resetBinding);
  expect(resetBinding.handoffCursor).toBe(0);
});

test('a reset binding cursor requires a new provider transcript handoff', () => {
  expect(projectChatBindingNeedsHandoff({ handoffCursor: 0, handoffVersion: 9 }, 0)).toBe(true);
});

test('a preserved provider session receives handoff for transcript written while another provider was active', () => {
  expect(projectChatBindingNeedsHandoff({ handoffCursor: 8, handoffVersion: 3 }, 12)).toBe(true);
  expect(projectChatBindingNeedsHandoff({ handoffCursor: 12, handoffVersion: 4 }, 12)).toBe(false);
});
