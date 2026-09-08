jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));
jest.mock('../agents/providers/PersistentGatewayWs', () => ({ readPendingUserInput: jest.fn() }));
jest.mock('./projectNativeRunBroker', () => ({
  getProjectNativeRunSnapshot: jest.fn(),
  PROJECT_NATIVE_MAX_RUN_TEXT: 4 * 1024 * 1024,
}));
jest.mock('./projectChatNativeRestartQuiescence', () => {
  const runtimes: Record<string, string> = {
    'claude-code-project-adapter': 'CLAUDE_CODE',
    'codex-project-adapter': 'CODEX',
    'agent-zero-project-sandbox-v4': 'AGENT_ZERO',
    'antigravity-project-adapter': 'GEMINI',
    'ollama-project-coding-agent-v1': 'OLLAMA',
  };
  return {
    nativeProjectRestartRecoveryTargetProvider: (runtime: unknown) => (
      runtimes[String(runtime || '')] || null
    ),
    quiesceNativeProjectOperationAfterRestart: jest.fn(),
  };
});

import {
  attestOpenClawActiveRunFromHistory,
  attestOpenClawPendingQuestionRestartEvidence,
  attestOpenClawRestartRecoveryEvidence,
  attestOpenClawRestartRunEvidence,
  inspectReattachedOpenClawProjectRun,
  reconcileExpiredProjectChatTurnsAfterRestart,
  type ProjectChatRestartRecoveryCandidate,
  type ProjectChatRestartRecoveryDependencies,
} from './projectChatRestartRecovery';
import {
  PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
  type ProjectChatOpenClawRestartLeaseGrant,
} from './projectChatTurnLease';

const NOW = new Date('2026-07-29T18:00:00.000Z');
const SESSION_KEY = 'agent:p4oc-test:portal-project';

function candidate(
  overrides: Partial<ProjectChatRestartRecoveryCandidate> = {},
): ProjectChatRestartRecoveryCandidate {
  return {
    id: 'turn-uuid',
    actorUserId: 'actor-uuid',
    actorAuthorizationVersion: 7,
    projectIdentityId: 'project-uuid',
    provider: 'OPENCLAW',
    runtime: 'openclaw-dedicated-project-agent',
    requestId: 'request-uuid',
    leaseOwner: 'portal-host:101:dead-process-uuid',
    providerSessionId: SESSION_KEY,
    startedAt: new Date(NOW.getTime() - 180_000),
    leaseExpiresAt: new Date(NOW.getTime() - 60_000),
    resultMetadata: {
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
      dispatchMetadataVersion: 1,
    },
    activeTurnId: 'turn-uuid',
    selectedProvider: 'OPENCLAW',
    ...overrides,
  };
}

function restartGrant(
  entry: ProjectChatRestartRecoveryCandidate = candidate(),
): ProjectChatOpenClawRestartLeaseGrant {
  return {
    state: {} as any,
    turn: {
      id: entry.id,
      lastEventSeq: 0,
      leaseOwner: 'portal-host:202:current-process-uuid',
      leaseExpiresAt: new Date(NOW.getTime() + 300_000),
    } as any,
    leaseToken: 'rotated-secret-token',
    idempotentReplay: false,
    expectedHandoffCursor: 4,
    expectedHandoffVersion: 2,
  };
}

function waitObservation(
  entry: ProjectChatRestartRecoveryCandidate,
  payload: Record<string, unknown>,
) {
  return {
    requestedRunId: `portal-${entry.id}`,
    payload,
  };
}

function recoveryDependencies(
  overrides: Partial<ProjectChatRestartRecoveryDependencies> = {},
): ProjectChatRestartRecoveryDependencies {
  return {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue([]),
    leaseOwnerIsInactive: () => true,
    shouldStop: () => false,
    hasActiveProcessLocalRun: () => false,
    readOpenClawPendingInput: jest.fn().mockResolvedValue({ pending: false }),
    readOpenClawRun: jest.fn().mockResolvedValue(null),
    readOpenClawHistory: jest.fn().mockResolvedValue(null),
    reattachOpenClawRun: jest.fn(async (entry) => restartGrant(entry)),
    settleReattachedOpenClawRun: jest.fn().mockResolvedValue(undefined),
    trackReattachedOpenClawRun: jest.fn(),
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recover: jest.fn().mockResolvedValue(undefined),
    recoverNative: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function terminalHistory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: SESSION_KEY,
    sessionInfo: {
      key: SESSION_KEY,
      status: 'done',
      startedAt: NOW.getTime() - 150_000,
      endedAt: NOW.getTime() - 30_000,
      hasActiveRun: false,
      activeRunIds: [],
      ...overrides,
    },
  };
}

test('attests only an exact terminal Gateway run inside the expired Portal lease', () => {
  expect(attestOpenClawRestartRecoveryEvidence({
    candidate: candidate(),
    historyPayload: terminalHistory(),
    now: NOW,
  })).toEqual({
    terminal: true,
    reason: 'bound-provider-session-terminal-and-quiescent',
    evidence: {
      providerStatus: 'done',
      providerStartedAt: new Date(NOW.getTime() - 150_000),
      providerEndedAt: new Date(NOW.getTime() - 30_000),
    },
  });
});

test('accepts synthetic terminal session evidence for a stranded turn', () => {
  const syntheticCandidate = candidate({
    id: '00000000-1111-4222-8333-444444444444',
    activeTurnId: '00000000-1111-4222-8333-444444444444',
    providerSessionId: 'agent:synthetic-workspace:portal-project',
    startedAt: new Date('2035-01-01T00:00:00.000Z'),
    leaseExpiresAt: new Date('2035-01-01T00:06:00.000Z'),
  });
  expect(attestOpenClawRestartRecoveryEvidence({
    candidate: syntheticCandidate,
    historyPayload: {
      sessionKey: syntheticCandidate.providerSessionId,
      sessionInfo: {
        key: syntheticCandidate.providerSessionId,
        status: 'done',
        startedAt: new Date('2035-01-01T00:01:00.000Z').getTime(),
        endedAt: new Date('2035-01-01T00:03:00.000Z').getTime(),
        hasActiveRun: false,
        activeRunIds: [],
      },
    },
    now: new Date('2035-01-02T00:00:00.000Z'),
  })).toMatchObject({
    terminal: true,
    reason: 'bound-provider-session-terminal-and-quiescent',
  });
});

test.each([
  ['still active', { status: 'running', hasActiveRun: true, activeRunIds: ['run-1'] }],
  ['terminal flag disagrees', { status: 'done', hasActiveRun: true, activeRunIds: ['run-1'] }],
  ['missing active-run proof', { status: 'done', hasActiveRun: undefined, activeRunIds: undefined }],
  ['started before the turn', { startedAt: NOW.getTime() - 240_000 }],
  ['started after the lease', { startedAt: NOW.getTime() - 30_000, endedAt: NOW.getTime() - 10_000 }],
  ['ended in the future', { endedAt: NOW.getTime() + 1 }],
] as const)('keeps the turn quarantined when Gateway evidence is %s', (_label, sessionOverrides) => {
  expect(attestOpenClawRestartRecoveryEvidence({
    candidate: candidate(),
    historyPayload: terminalHistory(sessionOverrides),
    now: NOW,
  }).terminal).toBe(false);
});

test('keeps a different Gateway session quarantined', () => {
  expect(attestOpenClawRestartRecoveryEvidence({
    candidate: candidate(),
    historyPayload: {
      ...terminalHistory(),
      sessionKey: 'agent:p4oc-other:portal-project',
    },
    now: NOW,
  })).toMatchObject({
    terminal: false,
    reason: 'gateway-session-identity-mismatch',
  });
});

test('binds pending-question and active-history evidence to the exact Project run', () => {
  const exact = candidate();
  expect(attestOpenClawPendingQuestionRestartEvidence({
    candidate: exact,
    snapshot: {
      pending: true,
      requestId: 'question-uuid',
      runId: `portal-${exact.id}`,
      questions: [],
      createdAt: NOW.getTime() - 90_000,
      expiresAt: NOW.getTime() + 90_000,
    },
    now: NOW,
  })).toEqual({
    kind: 'pending-question',
    runId: `portal-${exact.id}`,
    requestId: 'question-uuid',
  });
  expect(attestOpenClawPendingQuestionRestartEvidence({
    candidate: exact,
    snapshot: {
      pending: true,
      requestId: 'question-uuid',
      runId: 'portal-another-turn',
      questions: [],
    },
    now: NOW,
  })).toBeNull();

  expect(attestOpenClawActiveRunFromHistory({
    candidate: exact,
    historyPayload: {
      sessionKey: SESSION_KEY,
      sessionInfo: {
        key: SESSION_KEY,
        status: 'running',
        hasActiveRun: true,
        activeRunIds: [`portal-${exact.id}`],
      },
    },
  })).toEqual({ kind: 'active-run', runId: `portal-${exact.id}` });
  expect(attestOpenClawActiveRunFromHistory({
    candidate: exact,
    historyPayload: {
      sessionKey: SESSION_KEY,
      sessionInfo: {
        key: SESSION_KEY,
        status: 'running',
        hasActiveRun: true,
        activeRunIds: ['portal-foreign-turn'],
      },
    },
  })).toBeNull();
});

test('attests an exact agent.wait terminal reply and rejects a foreign run', () => {
  const exact = candidate();
  const terminal = {
    status: 'ok',
    startedAt: NOW.getTime() - 150_000,
    endedAt: NOW.getTime() - 10_000,
    stopReason: 'end_turn',
    terminalReply: { disposition: 'visible', text: 'Recovered answer.' },
  };
  expect(attestOpenClawRestartRunEvidence({
    candidate: exact,
    observation: waitObservation(exact, terminal),
    now: NOW,
  })).toEqual({
    state: 'terminal',
    evidence: {
      source: 'agent-wait',
      providerStatus: 'ok',
      providerStartedAt: new Date(NOW.getTime() - 150_000),
      providerEndedAt: new Date(NOW.getTime() - 10_000),
      terminalReply: { disposition: 'visible', text: 'Recovered answer.' },
      error: null,
      stopReason: 'end_turn',
    },
  });
  expect(attestOpenClawRestartRunEvidence({
    candidate: exact,
    observation: {
      requestedRunId: 'portal-foreign-turn',
      payload: terminal,
    },
    now: NOW,
  })).toEqual({ state: 'indeterminate', reason: 'gateway-run-identity-mismatch' });
});

test('reattaches an expired turn only after the exact pending native question is observed', async () => {
  const exact = candidate();
  const reattachOpenClawRun = jest.fn(async () => restartGrant(exact));
  const trackReattachedOpenClawRun = jest.fn();
  const readOpenClawRun = jest.fn();
  const readOpenClawHistory = jest.fn();
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([exact]),
    readOpenClawPendingInput: jest.fn().mockResolvedValue({
      pending: true,
      requestId: 'question-uuid',
      runId: `portal-${exact.id}`,
      questions: [],
      createdAt: NOW.getTime() - 30_000,
      expiresAt: NOW.getTime() + 60_000,
    }),
    readOpenClawRun,
    readOpenClawHistory,
    reattachOpenClawRun,
    trackReattachedOpenClawRun,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 0,
    reattached: 1,
    quarantined: 0,
  });
  expect(reattachOpenClawRun).toHaveBeenCalledWith(exact, {
    kind: 'pending-question',
    runId: `portal-${exact.id}`,
    requestId: 'question-uuid',
  }, NOW);
  expect(trackReattachedOpenClawRun).toHaveBeenCalledWith(exact, restartGrant(exact));
  expect(readOpenClawRun).not.toHaveBeenCalled();
  expect(readOpenClawHistory).not.toHaveBeenCalled();
});

test('materializes an exact post-restart terminal reply instead of expiring it', async () => {
  const exact = candidate();
  const grant = restartGrant(exact);
  const reattachOpenClawRun = jest.fn().mockResolvedValue(grant);
  const settleReattachedOpenClawRun = jest.fn().mockResolvedValue(undefined);
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([exact]),
    readOpenClawRun: jest.fn().mockResolvedValue(waitObservation(exact, {
      status: 'ok',
      startedAt: NOW.getTime() - 150_000,
      endedAt: NOW.getTime() - 10_000,
      terminalReply: { disposition: 'visible', text: 'Answer after clarification.' },
    })),
    reattachOpenClawRun,
    settleReattachedOpenClawRun,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 1,
    reattached: 0,
    quarantined: 0,
  });
  expect(reattachOpenClawRun).toHaveBeenCalledWith(
    exact,
    expect.objectContaining({
      kind: 'terminal-run',
      runId: `portal-${exact.id}`,
      providerStatus: 'ok',
    }),
    NOW,
  );
  expect(settleReattachedOpenClawRun).toHaveBeenCalledWith(
    exact,
    grant,
    expect.objectContaining({
      terminalReply: { disposition: 'visible', text: 'Answer after clarification.' },
    }),
    NOW,
  );
});

test('projects an exact restarted terminal reply through the real atomic finish adapter', async () => {
  const exact = candidate();
  const grant = restartGrant(exact);
  grant.turn.lastEventSeq = 12;
  const durableTurn: Record<string, any> = {
    id: exact.id,
    actorUserId: exact.actorUserId,
    projectIdentityId: exact.projectIdentityId,
    provider: 'OPENCLAW',
    runtime: exact.runtime,
    model: 'openclaw-project-model',
    status: 'RUNNING',
    leaseTokenHash: 'f260cf074281deff230f77d8bb3108a9945f82918828071877ad0e51fbb1a945',
    providerSessionId: exact.providerSessionId,
    resultMetadata: exact.resultMetadata,
  };
  const durableState: Record<string, any> = {
    id: 'state-uuid',
    actorUserId: exact.actorUserId,
    projectIdentityId: exact.projectIdentityId,
    activeTurnId: exact.id,
    version: 11,
    transcriptCursor: 4,
  };
  const durableBinding: Record<string, any> = {
    id: 'binding-uuid',
    userId: exact.actorUserId,
    projectId: exact.projectIdentityId,
    provider: 'OPENCLAW',
    status: 'bound',
    handoffCursor: grant.expectedHandoffCursor,
    handoffVersion: grant.expectedHandoffVersion,
  };
  const createdProjection: Array<Record<string, unknown>> = [];
  const transaction = {
    projectChatTurn: {
      findUnique: jest.fn(async () => durableTurn),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(durableTurn, data);
        return { count: 1 };
      }),
    },
    projectChatState: {
      findUnique: jest.fn(async () => durableState),
      updateMany: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        durableState.activeTurnId = data.activeTurnId;
        durableState.version += Number(data.version?.increment || 0);
        if (data.transcriptCursor !== undefined) {
          durableState.transcriptCursor = data.transcriptCursor;
        }
        return { count: 1 };
      }),
    },
    projectChatProviderBinding: {
      findUnique: jest.fn(async () => durableBinding),
      updateMany: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        durableBinding.handoffCursor = data.handoffCursor;
        durableBinding.handoffVersion += Number(data.handoffVersion?.increment || 0);
        return { count: 1 };
      }),
    },
    projectChatMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdProjection.push(data);
        return data;
      }),
      count: jest.fn().mockResolvedValue(5),
    },
  };
  const mockedDatabase = jest.requireMock('../config/database') as {
    prisma: { $transaction?: jest.Mock };
  };
  const mockedGateway = jest.requireMock('../utils/openclawGatewayRpc') as {
    gatewayRpcCall: jest.Mock;
  };
  const mockedPendingInput = jest.requireMock('../agents/providers/PersistentGatewayWs') as {
    readPendingUserInput: jest.Mock;
  };
  const previousTransaction = mockedDatabase.prisma.$transaction;
  mockedDatabase.prisma.$transaction = jest.fn(async (operation) => operation(transaction));
  mockedPendingInput.readPendingUserInput.mockResolvedValueOnce({ pending: false });
  mockedGateway.gatewayRpcCall.mockResolvedValueOnce({
    ok: true,
    data: {
      status: 'ok',
      startedAt: NOW.getTime() - 150_000,
      endedAt: NOW.getTime() - 1_000,
      stopReason: 'end_turn',
      terminalReply: {
        disposition: 'visible',
        text: 'Projected through the real adapter.',
      },
    },
  });

  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  try {
    await expect(inspectReattachedOpenClawProjectRun({
      candidate: exact,
      grant,
      nextRenewAt: NOW.getTime() + 30_000,
    })).resolves.toBe('settled');
  } finally {
    jest.useRealTimers();
    mockedDatabase.prisma.$transaction = previousTransaction;
  }

  expect(mockedGateway.gatewayRpcCall).toHaveBeenCalledWith(
    'agent.wait',
    { runId: `portal-${exact.id}`, timeoutMs: 25 },
    2_000,
  );
  expect(createdProjection).toEqual([expect.objectContaining({
    userId: exact.actorUserId,
    projectId: exact.projectIdentityId,
    sessionKey: exact.providerSessionId,
    providerSessionId: exact.providerSessionId,
    role: 'assistant',
    turnId: exact.id,
    messageId: `project-turn:${exact.id}`,
    content: 'Projected through the real adapter.',
  })]);
  expect(durableTurn).toMatchObject({
    status: 'COMPLETED',
    activeProjectKey: null,
    errorCode: null,
    errorMessage: null,
    resultMetadata: expect.objectContaining({
      restartRunRecoveryVersion: 1,
      restartRunRecoverySource: 'agent-wait',
      restartRunId: `portal-${exact.id}`,
      restartRunProviderStatus: 'ok',
      restartRunTerminalReplyDisposition: 'visible',
      durableEventCount: 12,
      atomicSettlementVersion: 2,
      presentationMaterialized: true,
      settledTranscriptCursor: 5,
      settledHandoffCursor: 5,
      settledHandoffVersion: 3,
    }),
  });
  expect(durableState).toMatchObject({
    activeTurnId: null,
    version: 12,
    transcriptCursor: 5,
  });
  expect(durableBinding).toMatchObject({
    handoffCursor: 5,
    handoffVersion: 3,
  });
});

test('the reattached monitor renews only on exact liveness and settles the exact terminal reply', async () => {
  const exact = candidate();
  const grant = restartGrant(exact);
  const monitor = { candidate: exact, grant, nextRenewAt: NOW.getTime() };
  const renew = jest.fn().mockResolvedValue(undefined);
  const settle = jest.fn().mockResolvedValue(undefined);
  const readRun = jest.fn().mockResolvedValue(waitObservation(exact, {
    status: 'pending',
  }));
  const reattach = jest.fn();
  const dependencies = {
    now: () => NOW,
    readPendingInput: jest.fn().mockResolvedValue({ pending: false }),
    readRun,
    readHistory: jest.fn().mockResolvedValue(null),
    reattach,
    renew,
    settle,
  };

  await expect(inspectReattachedOpenClawProjectRun(monitor, dependencies)).resolves.toBe('active');
  expect(renew).toHaveBeenCalledWith(exact, grant, NOW);
  expect(settle).not.toHaveBeenCalled();

  readRun.mockResolvedValueOnce(waitObservation(exact, {
    status: 'ok',
    startedAt: NOW.getTime() - 150_000,
    endedAt: NOW.getTime() - 1_000,
    terminalReply: { disposition: 'visible', text: 'Durably recovered.' },
  }));
  await expect(inspectReattachedOpenClawProjectRun(monitor, dependencies)).resolves.toBe('settled');
  expect(settle).toHaveBeenCalledWith(
    exact,
    grant,
    expect.objectContaining({
      source: 'agent-wait',
      terminalReply: { disposition: 'visible', text: 'Durably recovered.' },
    }),
    NOW,
  );
});

test('an exact run returning after an outage past lease expiry is reattached with a new grant', async () => {
  const exact = candidate();
  const expiredGrant = restartGrant(exact);
  expiredGrant.turn.leaseExpiresAt = new Date(NOW.getTime() - 1);
  const replacementGrant = restartGrant(exact);
  replacementGrant.turn.leaseOwner = 'portal-host:202:replacement-process-uuid';
  replacementGrant.leaseToken = 'second-rotated-secret-token';
  const monitor = {
    candidate: exact,
    grant: expiredGrant,
    nextRenewAt: NOW.getTime() - 1,
  };
  const readRun = jest.fn().mockResolvedValue(null);
  const reattach = jest.fn().mockResolvedValue(replacementGrant);
  const renew = jest.fn();
  const settle = jest.fn();
  const dependencies = {
    now: () => NOW,
    readPendingInput: jest.fn().mockResolvedValue({ pending: false }),
    readRun,
    readHistory: jest.fn().mockResolvedValue(null),
    reattach,
    renew,
    settle,
  };

  await expect(inspectReattachedOpenClawProjectRun(monitor, dependencies))
    .resolves.toBe('indeterminate');
  expect(reattach).not.toHaveBeenCalled();
  expect(renew).not.toHaveBeenCalled();

  readRun.mockResolvedValueOnce(waitObservation(exact, { status: 'pending' }));
  await expect(inspectReattachedOpenClawProjectRun(monitor, dependencies))
    .resolves.toBe('active');
  expect(reattach).toHaveBeenCalledWith(
    exact,
    expiredGrant,
    { kind: 'active-run', runId: `portal-${exact.id}` },
    NOW,
  );
  expect(monitor.grant).toBe(replacementGrant);
  expect(monitor.nextRenewAt).toBe(NOW.getTime() + 30_000);
  expect(renew).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test('an exact terminal run returning after lease expiry is reattached before materialization', async () => {
  const exact = candidate();
  const expiredGrant = restartGrant(exact);
  expiredGrant.turn.leaseExpiresAt = new Date(NOW.getTime() - 1);
  const replacementGrant = restartGrant(exact);
  replacementGrant.turn.leaseOwner = 'portal-host:202:terminal-replacement-uuid';
  replacementGrant.leaseToken = 'terminal-rotated-secret-token';
  const monitor = {
    candidate: exact,
    grant: expiredGrant,
    nextRenewAt: NOW.getTime() - 1,
  };
  const reattach = jest.fn().mockResolvedValue(replacementGrant);
  const settle = jest.fn().mockResolvedValue(undefined);

  await expect(inspectReattachedOpenClawProjectRun(monitor, {
    now: () => NOW,
    readPendingInput: jest.fn().mockResolvedValue({ pending: false }),
    readRun: jest.fn().mockResolvedValue(waitObservation(exact, {
      status: 'ok',
      startedAt: NOW.getTime() - 150_000,
      endedAt: NOW.getTime() - 1_000,
      terminalReply: { disposition: 'visible', text: 'Recovered after outage.' },
    })),
    readHistory: jest.fn().mockResolvedValue(null),
    reattach,
    renew: jest.fn(),
    settle,
  })).resolves.toBe('settled');
  expect(reattach).toHaveBeenCalledWith(
    exact,
    expiredGrant,
    {
      kind: 'terminal-run',
      runId: `portal-${exact.id}`,
      providerStatus: 'ok',
      providerStartedAt: new Date(NOW.getTime() - 150_000),
      providerEndedAt: new Date(NOW.getTime() - 1_000),
    },
    NOW,
  );
  expect(settle).toHaveBeenCalledWith(
    exact,
    replacementGrant,
    expect.objectContaining({
      source: 'agent-wait',
      terminalReply: { disposition: 'visible', text: 'Recovered after outage.' },
    }),
    NOW,
  );
  expect(monitor.grant).toBe(replacementGrant);
});

test('terminal session evidence after lease expiry rotates only into retry-required settlement', async () => {
  const exact = candidate();
  const expiredGrant = restartGrant(exact);
  expiredGrant.turn.leaseExpiresAt = new Date(NOW.getTime() - 1);
  const replacementGrant = restartGrant(exact);
  replacementGrant.turn.leaseOwner = 'portal-host:202:session-terminal-replacement-uuid';
  replacementGrant.leaseToken = 'session-terminal-rotated-secret-token';
  const monitor = {
    candidate: exact,
    grant: expiredGrant,
    nextRenewAt: NOW.getTime() - 1,
  };
  const reattach = jest.fn().mockResolvedValue(replacementGrant);
  const settle = jest.fn().mockResolvedValue(undefined);

  await expect(inspectReattachedOpenClawProjectRun(monitor, {
    now: () => NOW,
    readPendingInput: jest.fn().mockResolvedValue({ pending: false }),
    readRun: jest.fn().mockResolvedValue(null),
    readHistory: jest.fn().mockResolvedValue(terminalHistory()),
    reattach,
    renew: jest.fn(),
    settle,
  })).resolves.toBe('settled');
  expect(reattach).toHaveBeenCalledWith(
    exact,
    expiredGrant,
    {
      kind: 'terminal-session',
      runId: `portal-${exact.id}`,
      providerStatus: 'done',
      providerStartedAt: new Date(NOW.getTime() - 150_000),
      providerEndedAt: new Date(NOW.getTime() - 30_000),
    },
    NOW,
  );
  expect(settle).toHaveBeenCalledWith(
    exact,
    replacementGrant,
    expect.objectContaining({
      source: 'session-terminal',
      providerStatus: 'session-terminal',
      terminalReply: null,
    }),
    NOW,
  );
  expect(monitor.grant).toBe(replacementGrant);
});

test('the reattached monitor never settles or renews from a foreign run', async () => {
  const exact = candidate();
  const grant = restartGrant(exact);
  grant.turn.leaseExpiresAt = new Date(NOW.getTime() - 1);
  const renew = jest.fn();
  const settle = jest.fn();
  const reattach = jest.fn();
  await expect(inspectReattachedOpenClawProjectRun({
    candidate: exact,
    grant,
    nextRenewAt: NOW.getTime(),
  }, {
    now: () => NOW,
    readPendingInput: jest.fn().mockResolvedValue({ pending: false }),
    readRun: jest.fn().mockResolvedValue({
      requestedRunId: 'portal-foreign-turn',
      payload: {
        status: 'ok',
        startedAt: NOW.getTime() - 150_000,
        endedAt: NOW.getTime() - 1_000,
        terminalReply: { disposition: 'visible', text: 'Foreign answer.' },
      },
    }),
    readHistory: jest.fn().mockResolvedValue(null),
    reattach,
    renew,
    settle,
  })).resolves.toBe('indeterminate');
  expect(renew).not.toHaveBeenCalled();
  expect(reattach).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test('one reconciliation pass recovers only an accepted, brokerless, exact terminal turn', async () => {
  const exact = candidate();
  const processLocal = candidate({ id: 'live-turn', activeTurnId: 'live-turn' });
  const unaccepted = candidate({
    id: 'unaccepted-turn',
    activeTurnId: 'unaccepted-turn',
    resultMetadata: { providerDispatchStage: 'DISPATCH_UNCONFIRMED' },
  });
  const recover = jest.fn().mockResolvedValue(undefined);
  const readOpenClawHistory = jest.fn(async (sessionKey: string) => (
    sessionKey === SESSION_KEY ? terminalHistory() : null
  ));
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([exact, processLocal, unaccepted]),
    hasActiveProcessLocalRun: (entry) => entry.id === processLocal.id,
    readOpenClawHistory,
    recover,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 1,
    reattached: 0,
    quarantined: 2,
  });
  expect(readOpenClawHistory).toHaveBeenCalledTimes(1);
  expect(recover).toHaveBeenCalledWith(
    exact,
    expect.objectContaining({
      providerStatus: 'done',
      providerStartedAt: expect.any(Date),
      providerEndedAt: expect.any(Date),
    }),
    NOW,
  );
});

test('an indeterminate Gateway response never invokes durable recovery', async () => {
  const recover = jest.fn();
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([candidate()]),
    readOpenClawHistory: jest.fn().mockResolvedValue(null),
    recover,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 0,
    reattached: 0,
    quarantined: 1,
  });
  expect(recover).not.toHaveBeenCalled();
});

test('a live or malformed lease owner remains quarantined without a Gateway read', async () => {
  const readOpenClawHistory = jest.fn();
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([
      candidate({ leaseOwner: `portal-host:${process.pid}:current-process` }),
      candidate({
        id: 'malformed-owner-turn',
        activeTurnId: 'malformed-owner-turn',
        leaseOwner: 'malformed',
      }),
    ]),
    leaseOwnerIsInactive: () => false,
    readOpenClawHistory,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 0,
    recovered: 0,
    reattached: 0,
    quarantined: 2,
  });
  expect(readOpenClawHistory).not.toHaveBeenCalled();
});

test('one racing recovery failure does not starve a later terminal candidate', async () => {
  const first = candidate();
  const secondSession = 'agent:p4oc-second:portal-project';
  const second = candidate({
    id: 'second-turn',
    activeTurnId: 'second-turn',
    providerSessionId: secondSession,
  });
  const recover = jest.fn()
    .mockRejectedValueOnce(new Error('binding changed'))
    .mockResolvedValueOnce(undefined);
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([first, second]),
    readOpenClawHistory: jest.fn(async (sessionKey) => ({
      sessionKey,
      sessionInfo: {
        key: sessionKey,
        status: 'done',
        startedAt: NOW.getTime() - 150_000,
        endedAt: NOW.getTime() - 30_000,
        hasActiveRun: false,
        activeRunIds: [],
      },
    })),
    recover,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 2,
    recovered: 1,
    reattached: 0,
    quarantined: 1,
  });
  expect(recover).toHaveBeenCalledTimes(2);
  expect(recover.mock.calls[1]?.[0]).toBe(second);
});

test('recovers the full native provider matrix, including provider-targeted runtime admissions', async () => {
  const providers = [
    ['CLAUDE_CODE', 'claude-code-project-adapter'],
    ['CODEX', 'codex-project-adapter'],
    ['AGENT_ZERO', 'agent-zero-project-sandbox-v4'],
    ['GEMINI', 'antigravity-project-adapter'],
    ['OLLAMA', 'ollama-project-coding-agent-v1'],
  ] as const;
  const turns = providers.flatMap(([provider, runtime], index) => [
    candidate({
      id: `native-turn-${index}`,
      activeTurnId: `native-turn-${index}`,
      provider,
      selectedProvider: provider,
      runtime,
      providerSessionId: `native-session-${index}`,
    }),
    candidate({
      id: `native-admission-${index}`,
      activeTurnId: `native-admission-${index}`,
      provider: 'OPENCLAW',
      selectedProvider: 'OPENCLAW',
      runtime,
      requestId: `portal-runtime-admission:qualify-${provider.toLowerCase()}:uuid`,
      providerSessionId: null,
      resultMetadata: null,
    }),
  ]);
  const quiesceNativeOperation = jest.fn(async (entry: ProjectChatRestartRecoveryCandidate) => ({
    provider: providers.find(([, runtime]) => runtime === entry.runtime)![0],
    boundary: 'container-stopped' as const,
    evidence: 'a'.repeat(64),
  }));
  const recoverNative = jest.fn().mockResolvedValue(undefined);
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue(turns),
    readOpenClawHistory: jest.fn(),
    quiesceNativeOperation,
    recoverNative,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 10,
    recovered: 10,
    reattached: 0,
    quarantined: 0,
  });
  expect(quiesceNativeOperation).toHaveBeenCalledTimes(10);
  expect(recoverNative).toHaveBeenCalledTimes(10);
  for (const [provider, runtime] of providers) {
    expect(recoverNative).toHaveBeenCalledWith(
      expect.objectContaining({ runtime }),
      expect.objectContaining({ provider }),
      NOW,
    );
  }
});

test('keeps a native operation quarantined when exact runtime quiescence is indeterminate', async () => {
  const native = candidate({
    provider: 'CODEX',
    selectedProvider: 'CODEX',
    runtime: 'codex-project-adapter',
    providerSessionId: 'native-session',
  });
  const recoverNative = jest.fn();
  const dependencies = recoveryDependencies({
    listCandidates: jest.fn().mockResolvedValue([native]),
    readOpenClawHistory: jest.fn(),
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recoverNative,
  });

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 0,
    reattached: 0,
    quarantined: 1,
  });
  expect(recoverNative).not.toHaveBeenCalled();
});
