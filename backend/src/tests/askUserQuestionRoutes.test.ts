import {
  deliverNativeAskUserQuestionAnswer,
  deliverNativeAskUserQuestionDismissal,
  syncNativeAskUserQuestionsForActor,
  type NativeAskUserQuestionChannelDependencies,
} from '../services/nativeAskUserQuestionChannel';

const candidate = {
  sessionKey: 'agent:main:portal-owner',
  runId: 'run-1',
  ownerUserId: 'user-1',
  surface: 'agent-chat' as const,
  authorityId: 'host-run-1',
  actorAuthorizationVersion: 7,
  projectIdentityId: null,
};
const proof = { ...candidate, toolCallId: 'native-request-1' };
const record = {
  id: 'askq_123',
  ...proof,
  questions: [{
    id: 'database',
    question: 'Which database?',
    multiSelect: false,
    options: [],
  }],
  createdAt: 1_000,
  expiresAt: 301_000,
  state: 'pending' as const,
  answers: null,
  answeredAt: null,
};

function dependencies(
  overrides: Partial<Record<keyof NativeAskUserQuestionChannelDependencies, jest.Mock>> = {},
): NativeAskUserQuestionChannelDependencies {
  return {
    discoverRuns: jest.fn(async () => [candidate]),
    readPending: jest.fn(async () => ({
      pending: true,
      runId: candidate.runId,
      requestId: proof.toolCallId,
      questions: record.questions,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    })),
    attestRuntimeRequest: jest.fn(async () => proof),
    register: jest.fn(() => record),
    reconcile: jest.fn(),
    list: jest.fn(() => [{
      id: record.id,
      sessionKey: record.sessionKey,
      surface: record.surface,
      questions: record.questions,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      state: record.state,
    }]),
    reattestRecord: jest.fn(async () => record),
    prepareAnswer: jest.fn(() => ({
      recordId: record.id,
      sessionKey: record.sessionKey,
      runId: record.runId,
      toolCallId: record.toolCallId,
      actorUserId: record.ownerUserId,
      answers: Object.assign(Object.create(null), { database: 'PostgreSQL' }),
      text: 'PostgreSQL',
    })),
    reserveDelivery: jest.fn(() => ({
      recordId: record.id,
      actorUserId: record.ownerUserId,
      token: Symbol('delivery'),
    })),
    answerRuntime: jest.fn(async () => ({
      accepted: true as const,
      replayed: false,
      idempotentReplay: false,
      runId: record.runId,
      requestId: record.toolCallId,
    })),
    dismissRuntime: jest.fn(async () => ({
      accepted: true as const,
      replayed: false,
      idempotentReplay: false,
      runId: record.runId,
      requestId: record.toolCallId,
    })),
    commitAnswer: jest.fn(() => ({ ...record, state: 'answered' as const })),
    commitCancellation: jest.fn(() => ({ ...record, state: 'cancelled' as const })),
    releaseDelivery: jest.fn(),
    ...overrides,
  } as unknown as NativeAskUserQuestionChannelDependencies;
}

describe('native ask-user route channel', () => {
  test('discovers server-owned runs, reads the real native request, then syncs the broker', async () => {
    const deps = dependencies();
    await expect(syncNativeAskUserQuestionsForActor({
      actorUserId: 'user-1',
      actorAuthorizationVersion: 7,
      sessionKey: candidate.sessionKey,
    }, deps)).resolves.toEqual([
      expect.objectContaining({ id: record.id, surface: 'agent-chat' }),
    ]);
    expect(deps.discoverRuns).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      actorAuthorizationVersion: 7,
      sessionKey: candidate.sessionKey,
    });
    expect(deps.readPending).toHaveBeenCalledWith(candidate.sessionKey, candidate.runId);
    expect(deps.attestRuntimeRequest).toHaveBeenCalledWith(candidate, proof.toolCallId);
    expect(deps.register).toHaveBeenCalledWith(expect.objectContaining({
      runId: candidate.runId,
      toolCallId: proof.toolCallId,
      ownerUserId: 'user-1',
      questions: record.questions,
    }));
    expect(deps.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      activeCalls: [{
        sessionKey: candidate.sessionKey,
        runId: candidate.runId,
        toolCallId: proof.toolCallId,
      }],
    }));
  });

  test('a no-pending runtime snapshot removes stale broker cards', async () => {
    const deps = dependencies({
      readPending: jest.fn(async () => ({ pending: false })),
      list: jest.fn(() => []),
    });
    await expect(syncNativeAskUserQuestionsForActor({
      actorUserId: 'user-1',
      actorAuthorizationVersion: 7,
      sessionKey: candidate.sessionKey,
    }, deps)).resolves.toEqual([]);
    expect(deps.attestRuntimeRequest).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.reconcile).toHaveBeenCalledWith(expect.objectContaining({ activeCalls: [] }));
  });

  test('an older unresolved journal row cannot hide the live question on the same session', async () => {
    const stale = {
      ...candidate,
      runId: 'older-unresolved-run',
      authorityId: 'older-host-run',
    };
    const deps = dependencies({
      discoverRuns: jest.fn(async () => [stale, candidate]),
      readPending: jest.fn(async (_sessionKey: string, runId: string) => (
        runId === candidate.runId
          ? {
              pending: true as const,
              runId: candidate.runId,
              requestId: proof.toolCallId,
              questions: record.questions,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
            }
          : { pending: false as const }
      )),
    });

    await expect(syncNativeAskUserQuestionsForActor({
      actorUserId: 'user-1',
      actorAuthorizationVersion: 7,
      sessionKey: candidate.sessionKey,
    }, deps)).resolves.toEqual([
      expect.objectContaining({ id: record.id, surface: 'agent-chat' }),
    ]);
    expect(deps.readPending).toHaveBeenCalledWith(stale.sessionKey, stale.runId);
    expect(deps.readPending).toHaveBeenCalledWith(candidate.sessionKey, candidate.runId);
    expect(deps.attestRuntimeRequest).toHaveBeenCalledTimes(1);
    expect(deps.attestRuntimeRequest).toHaveBeenCalledWith(candidate, proof.toolCallId);
    expect(deps.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      activeCalls: [{
        sessionKey: candidate.sessionKey,
        runId: candidate.runId,
        toolCallId: proof.toolCallId,
      }],
    }));
  });

  test('delivers the exact runtime pair before committing broker state', async () => {
    let accept!: (value: any) => void;
    const runtimeAcceptance = new Promise((resolve) => { accept = resolve; });
    const deps = dependencies({
      answerRuntime: jest.fn(() => runtimeAcceptance),
    });
    const pending = deliverNativeAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: 'PostgreSQL' },
    }, deps);
    await Promise.resolve();
    expect((deps.reattestRecord as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((deps.answerRuntime as jest.Mock).mock.invocationCallOrder[0]);
    expect(deps.answerRuntime).toHaveBeenCalledWith(
      record.sessionKey,
      record.runId,
      record.toolCallId,
      'PostgreSQL',
    );
    expect(deps.commitAnswer).not.toHaveBeenCalled();
    accept({
      accepted: true,
      replayed: false,
      idempotentReplay: false,
      runId: record.runId,
      requestId: record.toolCallId,
    });
    await expect(pending).resolves.toMatchObject({ idempotentReplay: false });
    expect(deps.commitAnswer).toHaveBeenCalledTimes(1);
    expect(deps.releaseDelivery).toHaveBeenCalledTimes(1);
  });

  test('runtime rejection leaves broker state uncommitted and releases the delivery slot', async () => {
    const deps = dependencies({
      answerRuntime: jest.fn(async () => { throw new Error('rejected'); }),
    });
    await expect(deliverNativeAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: 'PostgreSQL' },
    }, deps)).rejects.toThrow('rejected');
    expect(deps.commitAnswer).not.toHaveBeenCalled();
    expect(deps.releaseDelivery).toHaveBeenCalledTimes(1);
  });

  test('dismissal also reaches the exact runtime request before cancellation commit', async () => {
    const deps = dependencies();
    await expect(deliverNativeAskUserQuestionDismissal({
      id: record.id,
      actorUserId: 'user-1',
    }, deps)).resolves.toMatchObject({ idempotentReplay: false });
    expect(deps.dismissRuntime).toHaveBeenCalledWith(
      record.sessionKey,
      record.runId,
      record.toolCallId,
    );
    expect((deps.dismissRuntime as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((deps.commitCancellation as jest.Mock).mock.invocationCallOrder[0]);
    expect(deps.releaseDelivery).toHaveBeenCalledTimes(1);
  });
});
