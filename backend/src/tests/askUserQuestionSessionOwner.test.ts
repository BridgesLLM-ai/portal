import {
  attestAskUserQuestionRuntimeRequest,
  discoverAskUserQuestionRunsForActor,
  reattestAskUserQuestionRunForActor,
  registerOwnedAskUserQuestion,
  resolveAskUserQuestionRunOwner,
  type AskUserQuestionOwnerDatabase,
} from '../services/askUserQuestionSessionOwner';
import {
  __resetAskUserQuestionsForTests,
  listPendingAskUserQuestions,
} from '../services/askUserQuestionBroker';
import { deriveOpenClawProjectSessionKey } from '../services/openclawProjectSandbox';

type Evidence = Partial<Record<keyof AskUserQuestionOwnerDatabase, any[]>>;

function databaseWithEvidence(evidence: Evidence = {}): AskUserQuestionOwnerDatabase {
  const delegate = (name: keyof AskUserQuestionOwnerDatabase) => ({
    findMany: jest.fn(async (args: any) => {
      const rows = evidence[name] || [];
      if (name === 'user' && args?.where?.id) {
        return rows.filter((row) => row.id === args.where.id);
      }
      if (name === 'openClawHostRun') {
        return rows.filter((row) => (
          (!args?.where?.actorUserId || row.actorUserId === args.where.actorUserId)
          && (!args?.where?.sessionKey || row.sessionKey === args.where.sessionKey)
          && (!args?.where?.upstreamRunId || row.upstreamRunId === args.where.upstreamRunId)
          && (!args?.where?.status || row.status === args.where.status)
        ));
      }
      if (name === 'projectChatTurn') {
        return rows.filter((row) => (
          (!args?.where?.id || row.id === args.where.id)
          && (!args?.where?.actorUserId || row.actorUserId === args.where.actorUserId)
          && (!args?.where?.providerSessionId || row.providerSessionId === args.where.providerSessionId)
          && (!args?.where?.status || row.status === args.where.status)
        ));
      }
      if (name === 'agentSession' && args?.where?.externalId) {
        return rows.filter((row) => (
          (row.externalId == null || row.externalId === args.where.externalId)
          && (!args.where.status || row.status === args.where.status)
        ));
      }
      return rows;
    }),
  });
  return {
    agentSession: delegate('agentSession'),
    openClawHostRun: delegate('openClawHostRun'),
    projectAuthorizationTransition: delegate('projectAuthorizationTransition'),
    projectChatProviderBinding: delegate('projectChatProviderBinding'),
    projectChatSession: delegate('projectChatSession'),
    projectChatState: delegate('projectChatState'),
    projectChatTurn: delegate('projectChatTurn'),
    projectIdentity: delegate('projectIdentity'),
    user: delegate('user'),
  };
}

const agentIdentity = {
  sessionKey: 'agent:main:portal-owner',
  runId: 'upstream-run-1',
  toolCallId: 'tool-call-1',
};

function activeUser(id = 'user-1', authorizationVersion = 7) {
  return {
    id,
    role: 'USER',
    accountStatus: 'ACTIVE',
    isActive: true,
    authorizationVersion,
  };
}

function agentEvidence(overrides: Record<string, unknown> = {}): Evidence {
  return {
    openClawHostRun: [{
      id: 'host-run-1',
      actorUserId: 'user-1',
      actorAuthorizationVersion: 7,
      provider: 'OPENCLAW',
      executionScope: 'HOST_OPERATOR',
      sessionKey: agentIdentity.sessionKey,
      status: 'DISPATCHED',
      upstreamRunId: agentIdentity.runId,
      ...overrides,
    }],
    agentSession: [{ userId: 'user-1', status: 'active', externalId: agentIdentity.sessionKey }],
    user: [activeUser()],
  };
}

const projectActor = 'project-user';
const projectId = 'project-identity-1';
const projectTurnId = '11111111-1111-4111-8111-111111111111';
const projectSessionKey = deriveOpenClawProjectSessionKey({
  userId: projectActor,
  projectId,
});
const projectIdentity = {
  sessionKey: projectSessionKey,
  runId: `portal-${projectTurnId}`,
  toolCallId: 'project-tool-call-1',
};

function projectEvidence(overrides: Record<string, unknown> = {}): Evidence {
  const leaseExpiresAt = new Date('2030-01-01T00:00:00.000Z');
  return {
    projectChatTurn: [{
      id: projectTurnId,
      stateId: 'project-state-1',
      actorUserId: projectActor,
      actorAuthorizationVersion: 9,
      projectIdentityId: projectId,
      activeProjectKey: projectId,
      provider: 'OPENCLAW',
      status: 'RUNNING',
      providerSessionId: projectSessionKey,
      leaseExpiresAt,
      resultMetadata: { providerDispatchStage: 'DISPATCH_ACCEPTED' },
      ...overrides,
    }],
    projectChatState: [{
      id: 'project-state-1',
      actorUserId: projectActor,
      projectIdentityId: projectId,
      selectedProvider: 'OPENCLAW',
      activeTurnId: projectTurnId,
    }],
    projectChatProviderBinding: [{
      userId: projectActor,
      projectId,
      provider: 'OPENCLAW',
      status: 'active',
      sessionKey: projectSessionKey,
      externalSessionId: projectSessionKey,
    }],
    projectChatSession: [{
      userId: projectActor,
      projectId,
      sessionKey: projectSessionKey,
      status: 'active',
      activeProvider: 'OPENCLAW',
    }],
    projectIdentity: [{
      id: projectId,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: 'CURRENT',
    }],
    user: [activeUser(projectActor, 9)],
  };
}

describe('ask-user exact active-run ownership', () => {
  afterEach(() => __resetAskUserQuestionsForTests());

  test('binds an Agent Chat question only to its exact dispatched upstream run', async () => {
    const database = databaseWithEvidence(agentEvidence());
    await expect(resolveAskUserQuestionRunOwner(agentIdentity, database)).resolves.toEqual({
      ...agentIdentity,
      ownerUserId: 'user-1',
      surface: 'agent-chat',
      authorityId: 'host-run-1',
      actorAuthorizationVersion: 7,
      projectIdentityId: null,
    });
    expect(database.openClawHostRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'DISPATCHED',
        sessionKey: agentIdentity.sessionKey,
        upstreamRunId: agentIdentity.runId,
      }),
    }));
  });

  test('discovers the actor run without accepting a browser run or request identity', async () => {
    const database = databaseWithEvidence(agentEvidence());
    await expect(discoverAskUserQuestionRunsForActor({
      actorUserId: 'user-1',
      actorAuthorizationVersion: 7,
      sessionKey: agentIdentity.sessionKey,
    }, database)).resolves.toEqual([{
      sessionKey: agentIdentity.sessionKey,
      runId: agentIdentity.runId,
      ownerUserId: 'user-1',
      surface: 'agent-chat',
      authorityId: 'host-run-1',
      actorAuthorizationVersion: 7,
      projectIdentityId: null,
    }]);
    const discoveryQuery = (database.openClawHostRun.findMany as jest.Mock).mock.calls[0][0];
    expect(discoveryQuery.where).not.toHaveProperty('upstreamRunId');
  });

  test('re-attests the real runtime request against the discovered run', async () => {
    const database = databaseWithEvidence(agentEvidence());
    const [candidate] = await discoverAskUserQuestionRunsForActor({
      actorUserId: 'user-1',
      sessionKey: agentIdentity.sessionKey,
    }, database);
    await expect(attestAskUserQuestionRuntimeRequest(
      candidate,
      'native-request-9',
      database,
    )).resolves.toMatchObject({
      ...candidate,
      toolCallId: 'native-request-9',
    });
  });

  test('fails closed when one actor/session has two dispatched run claims', async () => {
    const evidence = agentEvidence();
    evidence.openClawHostRun = [
      ...(evidence.openClawHostRun || []),
      {
        ...(evidence.openClawHostRun || [])[0],
        id: 'host-run-2',
        upstreamRunId: 'upstream-run-2',
      },
    ];
    await expect(discoverAskUserQuestionRunsForActor({
      actorUserId: 'user-1',
      sessionKey: agentIdentity.sessionKey,
    }, databaseWithEvidence(evidence))).rejects.toMatchObject({
      code: 'ASK_USER_RUN_AMBIGUOUS',
      statusCode: 409,
    });
  });

  test('binds a Project Chat question only to its active turn and durable project authority', async () => {
    const database = databaseWithEvidence(projectEvidence());
    await expect(resolveAskUserQuestionRunOwner(
      projectIdentity,
      database,
      new Date('2029-01-01T00:00:00.000Z'),
    )).resolves.toEqual({
      ...projectIdentity,
      ownerUserId: projectActor,
      surface: 'project-chat',
      authorityId: projectTurnId,
      actorAuthorizationVersion: 9,
      projectIdentityId: projectId,
    });
  });

  test.each([
    ['terminal host run', agentEvidence({ status: 'VISIBLE_DONE' })],
    ['mismatched upstream run', agentEvidence({ upstreamRunId: 'another-run' })],
    ['authorization generation changed', {
      ...agentEvidence(),
      user: [activeUser('user-1', 8)],
    }],
  ])('rejects %s without creating a question', async (_label, evidence) => {
    await expect(resolveAskUserQuestionRunOwner(
      agentIdentity,
      databaseWithEvidence(evidence as Evidence),
    )).rejects.toMatchObject({ code: 'ASK_USER_RUN_UNOWNED', statusCode: 403 });
    expect(listPendingAskUserQuestions({ actorUserId: 'user-1' })).toEqual([]);
  });

  test('rejects registration during an authorization transition', async () => {
    await expect(resolveAskUserQuestionRunOwner(
      agentIdentity,
      databaseWithEvidence({
        ...agentEvidence(),
        projectAuthorizationTransition: [{ id: 'transition-1' }],
      }),
    )).rejects.toMatchObject({
      code: 'ASK_USER_AUTHORIZATION_TRANSITION',
      statusCode: 503,
    });
  });

  test('rejects two complete ownership surfaces even when both claim the same actor', async () => {
    const overlappingProject = projectEvidence();
    await expect(resolveAskUserQuestionRunOwner(
      projectIdentity,
      databaseWithEvidence({
        ...overlappingProject,
        openClawHostRun: [{
          id: 'host-run-overlap',
          actorUserId: 'user-1',
          actorAuthorizationVersion: 7,
          provider: 'OPENCLAW',
          executionScope: 'HOST_OPERATOR',
          sessionKey: projectIdentity.sessionKey,
          status: 'DISPATCHED',
          upstreamRunId: projectIdentity.runId,
        }],
        agentSession: [{ userId: 'user-1', status: 'active' }],
        user: [activeUser('user-1', 7), activeUser(projectActor, 9)],
      }),
      new Date('2029-01-01T00:00:00.000Z'),
    )).rejects.toMatchObject({ code: 'ASK_USER_RUN_AMBIGUOUS', statusCode: 409 });
  });

  test('registration ignores a spoofed body owner and re-attests before settlement', async () => {
    const database = databaseWithEvidence(agentEvidence());
    const record = await registerOwnedAskUserQuestion({
      ...agentIdentity,
      questions: [{ id: 'ship', question: 'Ship it?', options: [{ label: 'Yes' }] }],
      ownerUserId: 'attacker',
    } as any, database);

    expect(record.ownerUserId).toBe('user-1');
    expect(listPendingAskUserQuestions({ actorUserId: 'attacker' })).toEqual([]);
    await expect(reattestAskUserQuestionRunForActor(
      record.id,
      'user-1',
      database,
    )).resolves.toBe(record);

    (database.openClawHostRun.findMany as jest.Mock).mockResolvedValue([]);
    await expect(reattestAskUserQuestionRunForActor(
      record.id,
      'user-1',
      database,
    )).rejects.toMatchObject({ code: 'ASK_USER_RUN_UNOWNED' });
    await expect(reattestAskUserQuestionRunForActor(
      record.id,
      'attacker',
      database,
    )).rejects.toMatchObject({ code: 'ASK_USER_NOT_FOUND', statusCode: 404 });
  });
});
