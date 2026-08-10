jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));
jest.mock('./projectNativeRunBroker', () => ({ getProjectNativeRunSnapshot: jest.fn() }));
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
  attestOpenClawRestartRecoveryEvidence,
  reconcileExpiredProjectChatTurnsAfterRestart,
  type ProjectChatRestartRecoveryCandidate,
  type ProjectChatRestartRecoveryDependencies,
} from './projectChatRestartRecovery';
import { PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED } from './projectChatTurnLease';

const NOW = new Date('2026-07-29T18:00:00.000Z');
const SESSION_KEY = 'agent:p4oc-test:portal-project';

function candidate(
  overrides: Partial<ProjectChatRestartRecoveryCandidate> = {},
): ProjectChatRestartRecoveryCandidate {
  return {
    id: 'turn-uuid',
    actorUserId: 'actor-uuid',
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
  const dependencies: ProjectChatRestartRecoveryDependencies = {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue([exact, processLocal, unaccepted]),
    leaseOwnerIsInactive: () => true,
    shouldStop: () => false,
    hasActiveProcessLocalRun: (entry) => entry.id === processLocal.id,
    readOpenClawHistory,
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recover,
    recoverNative: jest.fn(),
  };

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 1,
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
  const dependencies: ProjectChatRestartRecoveryDependencies = {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue([candidate()]),
    leaseOwnerIsInactive: () => true,
    shouldStop: () => false,
    hasActiveProcessLocalRun: () => false,
    readOpenClawHistory: jest.fn().mockResolvedValue(null),
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recover,
    recoverNative: jest.fn(),
  };

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 0,
    quarantined: 1,
  });
  expect(recover).not.toHaveBeenCalled();
});

test('a live or malformed lease owner remains quarantined without a Gateway read', async () => {
  const readOpenClawHistory = jest.fn();
  const dependencies: ProjectChatRestartRecoveryDependencies = {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue([
      candidate({ leaseOwner: `portal-host:${process.pid}:current-process` }),
      candidate({
        id: 'malformed-owner-turn',
        activeTurnId: 'malformed-owner-turn',
        leaseOwner: 'malformed',
      }),
    ]),
    leaseOwnerIsInactive: () => false,
    shouldStop: () => false,
    hasActiveProcessLocalRun: () => false,
    readOpenClawHistory,
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recover: jest.fn(),
    recoverNative: jest.fn(),
  };

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 0,
    recovered: 0,
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
  const dependencies: ProjectChatRestartRecoveryDependencies = {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue([first, second]),
    leaseOwnerIsInactive: () => true,
    shouldStop: () => false,
    hasActiveProcessLocalRun: () => false,
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
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recover,
    recoverNative: jest.fn(),
  };

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 2,
    recovered: 1,
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
  const dependencies: ProjectChatRestartRecoveryDependencies = {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue(turns),
    leaseOwnerIsInactive: () => true,
    shouldStop: () => false,
    hasActiveProcessLocalRun: () => false,
    readOpenClawHistory: jest.fn(),
    quiesceNativeOperation,
    recover: jest.fn(),
    recoverNative,
  };

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 10,
    recovered: 10,
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
  const dependencies: ProjectChatRestartRecoveryDependencies = {
    now: () => NOW,
    listCandidates: jest.fn().mockResolvedValue([native]),
    leaseOwnerIsInactive: () => true,
    shouldStop: () => false,
    hasActiveProcessLocalRun: () => false,
    readOpenClawHistory: jest.fn(),
    quiesceNativeOperation: jest.fn().mockResolvedValue(null),
    recover: jest.fn(),
    recoverNative,
  };

  await expect(reconcileExpiredProjectChatTurnsAfterRestart(dependencies)).resolves.toEqual({
    inspected: 1,
    recovered: 0,
    quarantined: 1,
  });
  expect(recoverNative).not.toHaveBeenCalled();
});
