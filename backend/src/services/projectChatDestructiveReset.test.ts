import crypto from 'crypto';
import { AgentProviderType, ProjectChatTurnStatus } from '@prisma/client';
import {
  commitProjectChatDestructiveReset,
  markProjectChatDestructiveResetStarted,
  recoverExpiredProjectChatRuntimeAdmissionForDestructiveReset,
  requireConfirmedProjectChatAbortForReset,
  type ProjectChatDestructiveResetDatabase,
} from './projectChatDestructiveReset';
import { PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX } from './projectChatTurnLease';

const ACTOR = 'actor-reset-test';
const PROJECT = 'project-reset-test';
const LEASE = 'reset-admission-lease-token';
const TURN_ID = 'reset-admission-turn';
const NOW = new Date('2026-07-21T12:00:00.000Z');

function fixtures() {
  const state = {
    id: 'state-reset-test',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    selectedProvider: AgentProviderType.CODEX,
    version: 12,
    activeTurnId: TURN_ID,
  };
  const turn = {
    id: TURN_ID,
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    requestId: `${PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX}reset:test`,
    status: ProjectChatTurnStatus.RUNNING,
    leaseTokenHash: crypto.createHash('sha256').update(LEASE).digest('hex'),
  };
  return { state, turn };
}

function database(transaction: Record<string, any>): ProjectChatDestructiveResetDatabase {
  return {
    $transaction: jest.fn(async (operation: (tx: any) => Promise<unknown>) => operation(transaction)),
  } as unknown as ProjectChatDestructiveResetDatabase;
}

function resetTransaction(overrides: Record<string, any> = {}) {
  const { state, turn } = fixtures();
  const resetJournal = {
    id: 'reset-journal-test',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    projectGeneration: 1,
    admissionTurnId: TURN_ID,
    legacyProjectId: null,
    status: 'RESETTING',
  };
  return {
    projectIdentity: {
      findUnique: jest.fn().mockResolvedValue({
        id: PROJECT,
        workspaceOwnerId: ACTOR,
        generation: 1,
        lifecycleStatus: 'ACTIVE',
        legacyOpenClawMigrationStatus: 'COMPLETE',
      }),
    },
    projectChatState: { findUnique: jest.fn().mockResolvedValue(state) },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(turn),
      deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
      count: jest.fn().mockResolvedValue(0),
    },
    projectChatMessage: {
      deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      count: jest.fn().mockResolvedValue(0),
    },
    projectChatSession: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    projectChatProviderBinding: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    projectChatDestructiveResetJournal: {
      findUnique: jest.fn().mockResolvedValue(resetJournal),
      upsert: jest.fn().mockResolvedValue(resetJournal),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    legacyOpenClawProjectImport: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(0),
    },
    legacyOpenClawProjectQuarantine: {
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      count: jest.fn().mockResolvedValue(0),
    },
    legacyOpenClawProjectClearTombstone: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'clear-tombstone-test' }),
    },
    ...overrides,
  };
}

function admission() {
  const { state, turn } = fixtures();
  return {
    state: state as any,
    turn: turn as any,
    leaseToken: LEASE,
    idempotentReplay: false,
    operation: 'reset',
  };
}

test('commits a durable reset tombstone before external provider mutation', async () => {
  const transaction = resetTransaction({
    projectChatDestructiveResetJournal: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'reset-journal-test' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  });
  const db = database(transaction);

  await expect(markProjectChatDestructiveResetStarted({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    legacyProjectId: 'legacy-project-name',
    admission: admission(),
    now: NOW,
  }, db)).resolves.toBeUndefined();

  expect(transaction.projectChatDestructiveResetJournal.upsert).toHaveBeenCalledWith({
    where: { actorUserId_projectIdentityId: { actorUserId: ACTOR, projectIdentityId: PROJECT } },
    update: expect.objectContaining({
      admissionTurnId: TURN_ID,
      projectGeneration: 1,
      legacyProjectId: 'legacy-project-name',
      status: 'RESETTING',
      externalMutationStartedAt: NOW,
      completedAt: null,
    }),
    create: expect.objectContaining({
      actorUserId: ACTOR,
      projectIdentityId: PROJECT,
      projectGeneration: 1,
      admissionTurnId: TURN_ID,
      legacyProjectId: 'legacy-project-name',
      status: 'RESETTING',
      externalMutationStartedAt: NOW,
    }),
  });
});

test('atomically clears the shared transcript and resets every provider generation', async () => {
  const transaction = resetTransaction();
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    admission: admission(),
    now: NOW,
  }, db)).resolves.toEqual({
    deletedMessages: 7,
    expiredSessions: 2,
    resetBindings: 2,
    deletedPriorTurns: 4,
  });

  expect(transaction.projectChatProviderBinding.updateMany).toHaveBeenCalledWith({
    where: { userId: ACTOR, projectId: PROJECT },
    data: expect.objectContaining({
      status: 'reset',
      sessionKey: null,
      externalSessionId: null,
      handoffCursor: 0,
      handoffVersion: { increment: 1 },
    }),
  });
  expect(transaction.projectChatTurn.deleteMany).toHaveBeenCalledWith({
    where: {
      actorUserId: ACTOR,
      projectIdentityId: PROJECT,
      id: { not: TURN_ID },
    },
  });
  expect(transaction.legacyOpenClawProjectQuarantine.deleteMany).toHaveBeenCalledWith({
    where: { actorUserId: ACTOR, projectIdentityId: PROJECT },
  });
  expect(transaction.legacyOpenClawProjectImport.updateMany).toHaveBeenCalledWith({
    where: { actorUserId: ACTOR, projectIdentityId: PROJECT, sourceStatus: 'RETIRED' },
    data: { sourceStatus: 'CLEARED', clearedAt: NOW },
  });
  expect(transaction.legacyOpenClawProjectClearTombstone.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      actorUserId: ACTOR,
      projectIdentityId: PROJECT,
      projectGeneration: 1,
      admissionTurnId: TURN_ID,
      clearedAt: NOW,
      sourceInventoryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'Serializable',
  });
});

test('retains exact source proofs as CLEARED while deleting quarantined plaintext', async () => {
  const retiredAt = new Date('2026-07-20T12:00:00.000Z');
  const transaction = resetTransaction({
    legacyOpenClawProjectImport: {
      findMany: jest.fn().mockResolvedValue([{
        actorUserId: ACTOR,
        projectIdentityId: PROJECT,
        projectGeneration: 1,
        sourceAgentId: 'portal-reset-test',
        sourceAgentHash: 'a'.repeat(64),
        sourceSessionKey: 'agent:portal-reset-test:main',
        sessionKeyHash: 'b'.repeat(64),
        sourceKind: 'DEDICATED',
        sourceStatus: 'RETIRED',
        providerSessionId: 'provider-session-reset-test',
        providerSessionIdHash: 'c'.repeat(64),
        sourceFingerprint: 'd'.repeat(64),
        agentInventoryFingerprint: 'e'.repeat(64),
        totalMessages: 2,
        importedMessages: 2,
        transcriptDigest: 'f'.repeat(64),
        projectionDigest: '0'.repeat(64),
        completedAt: new Date('2026-07-20T11:00:00.000Z'),
        retiredAt,
      }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
  });
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    admission: admission(),
    now: NOW,
  }, db)).resolves.toBeDefined();

  expect(transaction.legacyOpenClawProjectImport.updateMany).toHaveBeenCalledWith({
    where: { actorUserId: ACTOR, projectIdentityId: PROJECT, sourceStatus: 'RETIRED' },
    data: { sourceStatus: 'CLEARED', clearedAt: NOW },
  });
  expect(transaction.legacyOpenClawProjectQuarantine.deleteMany).toHaveBeenCalledWith({
    where: { actorUserId: ACTOR, projectIdentityId: PROJECT },
  });
  expect(transaction.legacyOpenClawProjectClearTombstone.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      sourceInventoryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  });
});

test('refuses Clear while any legacy source proof is not retired', async () => {
  const transaction = resetTransaction({
    legacyOpenClawProjectImport: {
      findMany: jest.fn().mockResolvedValue([{ sourceStatus: 'COMPLETE' }]),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
  });
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    admission: admission(),
  }, db)).rejects.toMatchObject({ code: 'STATE_CORRUPT', httpStatus: 500 });
  expect(transaction.projectChatMessage.deleteMany).not.toHaveBeenCalled();
  expect(transaction.legacyOpenClawProjectClearTombstone.create).not.toHaveBeenCalled();
});

test('atomically retires the actor-scoped 3.x name namespace so migration cannot resurrect it', async () => {
  const transaction = resetTransaction({
    projectChatDestructiveResetJournal: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'reset-journal-test',
        actorUserId: ACTOR,
        projectIdentityId: PROJECT,
        projectGeneration: 1,
        admissionTurnId: TURN_ID,
        legacyProjectId: 'legacy-project-name',
        status: 'RESETTING',
      }),
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  });
  transaction.projectChatMessage.deleteMany
    .mockResolvedValueOnce({ count: 7 })
    .mockResolvedValueOnce({ count: 3 });
  transaction.projectChatSession.deleteMany.mockResolvedValueOnce({ count: 1 });
  transaction.projectChatProviderBinding.deleteMany.mockResolvedValueOnce({ count: 1 });
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    legacyProjectId: 'legacy-project-name',
    admission: admission(),
    now: NOW,
  }, db)).resolves.toEqual({
    deletedMessages: 10,
    expiredSessions: 3,
    resetBindings: 3,
    deletedPriorTurns: 4,
  });

  expect(transaction.projectChatMessage.deleteMany).toHaveBeenNthCalledWith(2, {
    where: { userId: ACTOR, projectId: 'legacy-project-name' },
  });
  expect(transaction.projectChatSession.deleteMany).toHaveBeenCalledWith({
    where: { userId: ACTOR, projectId: 'legacy-project-name' },
  });
  expect(transaction.projectChatProviderBinding.deleteMany).toHaveBeenCalledWith({
    where: { userId: ACTOR, projectId: 'legacy-project-name' },
  });
  expect(transaction.projectChatMessage.count).toHaveBeenCalledWith({
    where: { userId: ACTOR, projectId: 'legacy-project-name' },
  });
  expect(transaction.projectChatSession.count).toHaveBeenCalledWith({
    where: { userId: ACTOR, projectId: 'legacy-project-name' },
  });
  expect(transaction.projectChatProviderBinding.count).toHaveBeenCalledWith({
    where: { userId: ACTOR, projectId: 'legacy-project-name' },
  });
  expect(transaction.projectChatDestructiveResetJournal.deleteMany).toHaveBeenCalledWith({
    where: expect.objectContaining({
      id: 'reset-journal-test',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT,
      projectGeneration: 1,
      admissionTurnId: TURN_ID,
      status: 'RESETTING',
    }),
  });
});

test('fails before deletion when the runtime admission no longer owns the state CAS', async () => {
  const transaction = resetTransaction({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue({
        ...fixtures().state,
        activeTurnId: 'newer-turn',
      }),
    },
  });
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    admission: admission(),
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409 });
  expect(transaction.projectChatMessage.deleteMany).not.toHaveBeenCalled();
  expect(transaction.projectChatProviderBinding.updateMany).not.toHaveBeenCalled();
  expect(transaction.projectChatTurn.deleteMany).not.toHaveBeenCalled();
});

test('rolls back when any provider binding or prior turn survives reset readback', async () => {
  const transaction = resetTransaction({
    projectChatProviderBinding: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(1),
    },
  });
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    admission: admission(),
  }, db)).rejects.toMatchObject({ code: 'STATE_CORRUPT', httpStatus: 500 });
  expect(transaction.projectChatDestructiveResetJournal.deleteMany).not.toHaveBeenCalled();
});

test('refuses to clear SQL history without the durable external-mutation tombstone', async () => {
  const transaction = resetTransaction({
    projectChatDestructiveResetJournal: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  });
  const db = database(transaction);

  await expect(commitProjectChatDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    admission: admission(),
  }, db)).rejects.toMatchObject({ code: 'STATE_CORRUPT', httpStatus: 500 });
  expect(transaction.projectChatMessage.deleteMany).not.toHaveBeenCalled();
  expect(transaction.projectChatDestructiveResetJournal.deleteMany).not.toHaveBeenCalled();
});

test.each([
  ['false result', async () => false],
  ['provider error', async () => { throw new Error('abort transport failed'); }],
] as const)('never treats an unconfirmed %s as permission to clear an active turn', async (_label, abortProvider) => {
  await expect(requireConfirmedProjectChatAbortForReset({
    hasExactBrokerRun: false,
    abortBroker: async () => false,
    waitForBrokerSettlement: async () => true,
    abortProvider,
    isTurnStillActive: async () => true,
  })).rejects.toMatchObject({ code: 'TURN_ACTIVE', httpStatus: 409 });
});

test('accepts an ambiguous abort only when durable coordination already proves the turn settled', async () => {
  await expect(requireConfirmedProjectChatAbortForReset({
    hasExactBrokerRun: false,
    abortBroker: async () => false,
    waitForBrokerSettlement: async () => false,
    abortProvider: async () => false,
    isTurnStillActive: async () => false,
  })).resolves.toBeUndefined();
});

test('a restart without broker callbacks accepts only an exact provider stop acknowledgement', async () => {
  await expect(requireConfirmedProjectChatAbortForReset({
    hasExactBrokerRun: false,
    abortBroker: async () => false,
    waitForBrokerSettlement: async () => false,
    abortProvider: async () => true,
    isTurnStillActive: async () => true,
  })).resolves.toBeUndefined();
});

test('provider abort acknowledgement cannot outrun delayed broker terminal callbacks', async () => {
  let releaseSettlement!: () => void;
  const settlement = new Promise<boolean>((resolve) => {
    releaseSettlement = () => resolve(true);
  });
  let resolved = false;
  const abortBoundary = requireConfirmedProjectChatAbortForReset({
    hasExactBrokerRun: true,
    abortBroker: async () => false,
    waitForBrokerSettlement: () => settlement,
    abortProvider: async () => true,
    isTurnStillActive: async () => true,
  }).then(() => { resolved = true; });

  await new Promise((resolve) => setImmediate(resolve));
  expect(resolved).toBe(false);
  releaseSettlement();
  await expect(abortBoundary).resolves.toBeUndefined();
});

test('an exact broker run remains quarantined when terminal callbacks do not settle', async () => {
  await expect(requireConfirmedProjectChatAbortForReset({
    hasExactBrokerRun: true,
    abortBroker: async () => true,
    waitForBrokerSettlement: async () => false,
    abortProvider: async () => true,
    isTurnStillActive: async () => true,
  })).rejects.toMatchObject({ code: 'TURN_ACTIVE', httpStatus: 409 });
});

test('destructive reset retires an exact expired management admission after provider termination', async () => {
  const expiredAdmission = {
    ...fixtures().turn,
    leaseExpiresAt: new Date(NOW.getTime() - 1),
    activeProjectKey: PROJECT,
    leaseOwner: 'restored-host:400:old-process',
  };
  const finalize = jest.fn().mockResolvedValue({ count: 1 });
  const detach = jest.fn().mockResolvedValue({ count: 1 });
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(fixtures().state),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(expiredAdmission),
      updateMany: finalize,
    },
  });

  await expect(recoverExpiredProjectChatRuntimeAdmissionForDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: TURN_ID,
    expectedVersion: fixtures().state.version,
    now: NOW,
  }, db)).resolves.toBeUndefined();
  expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ id: TURN_ID, leaseExpiresAt: { lte: NOW } }),
    data: expect.objectContaining({
      status: ProjectChatTurnStatus.ERROR,
      errorCode: 'DESTRUCTIVE_RESET_RECOVERED_RUNTIME_ADMISSION',
    }),
  }));
  expect(detach).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ activeTurnId: TURN_ID, version: fixtures().state.version }),
  }));
});

test('destructive reset cannot retire a non-expired management admission', async () => {
  const liveAdmission = {
    ...fixtures().turn,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  };
  const finalize = jest.fn();
  const detach = jest.fn();
  const db = database({
    projectChatState: {
      findUnique: jest.fn().mockResolvedValue(fixtures().state),
      updateMany: detach,
    },
    projectChatTurn: {
      findUnique: jest.fn().mockResolvedValue(liveAdmission),
      updateMany: finalize,
    },
  });

  await expect(recoverExpiredProjectChatRuntimeAdmissionForDestructiveReset({
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    turnId: TURN_ID,
    expectedVersion: fixtures().state.version,
    now: NOW,
  }, db)).rejects.toMatchObject({ code: 'TURN_ACTIVE', httpStatus: 409 });
  expect(finalize).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
});
