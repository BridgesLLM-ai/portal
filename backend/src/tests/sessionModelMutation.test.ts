import type { AgentProvider } from '../agents/AgentProvider.interface';
import {
  NativeSessionModelMutationError,
  setNativeSessionModel,
  type NativeSessionModelMutationDependencies,
} from '../agents/sessionModelMutation';

function provider(setSessionModel?: AgentProvider['setSessionModel']): AgentProvider {
  return {
    displayName: 'Test Provider',
    providerName: 'AGENT_ZERO',
    startSession: jest.fn(),
    sendMessage: jest.fn(),
    getHistory: jest.fn(),
    listSessions: jest.fn(),
    terminateSession: jest.fn(),
    ...(setSessionModel ? { setSessionModel } : {}),
  } as AgentProvider;
}

function dependencies(
  mode: 'none' | 'session' | 'launch',
  agentProvider: AgentProvider,
): NativeSessionModelMutationDependencies {
  return {
    getProviderCapabilities: jest.fn(() => ({
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'agent-zero-connector',
      adapterKey: 'test',
      supportsHistory: true,
      supportsModelSelection: mode !== 'none',
      modelSelectionMode: mode,
      supportsCustomModelInput: false,
      canEnumerateModels: true,
      modelCatalogKind: 'dynamic',
      supportsSessionList: true,
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportedExecutionScopes: ['HOST_OPERATOR'],
    })),
    getProvider: jest.fn(() => agentProvider),
    updateNativeSessionModel: jest.fn(() => null),
  };
}

describe('native session model mutation contract', () => {
  test('delegates runtime-owned session changes instead of writing local metadata first', async () => {
    const setSessionModel = jest.fn(async () => ({
      model: 'codex_oauth/gpt-5.3-codex',
      metadata: { remoteConfirmed: true },
    }));
    const deps = dependencies('session', provider(setSessionModel));

    await expect(setNativeSessionModel(
      'AGENT_ZERO',
      'session-1',
      'codex_oauth/gpt-5.3-codex',
      deps,
    )).resolves.toMatchObject({ model: 'codex_oauth/gpt-5.3-codex' });
    expect(setSessionModel).toHaveBeenCalledWith('session-1', 'codex_oauth/gpt-5.3-codex');
    expect(deps.updateNativeSessionModel).not.toHaveBeenCalled();
  });

  test('rejects in-place changes for launch-bound providers without lying in the local store', async () => {
    const setSessionModel = jest.fn();
    const deps = dependencies('launch', provider(setSessionModel));

    await expect(setNativeSessionModel(
      'GEMINI',
      'session-2',
      'gemini-3.1-pro-high',
      deps,
    )).rejects.toMatchObject<Partial<NativeSessionModelMutationError>>({
      code: 'MODEL_REQUIRES_NEW_SESSION',
      status: 409,
    });
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(deps.updateNativeSessionModel).not.toHaveBeenCalled();
  });

  test('supports an explicit reset for ordinary session-bound native adapters', async () => {
    const deps = dependencies('session', provider());
    jest.mocked(deps.updateNativeSessionModel).mockReturnValue({
      provider: 'CODEX',
      sessionId: 'session-3',
      userId: 'user-3',
      createdAt: '2026-07-20T20:00:00.000Z',
      lastActivityAt: '2026-07-20T20:01:00.000Z',
      cwd: '/tmp',
      executionContext: {
        scope: 'HOST_OPERATOR',
        source: 'PORTAL_SERVER',
        userId: 'user-3',
      },
      messages: [],
    });

    await expect(setNativeSessionModel('CODEX', 'session-3', null, deps)).resolves.toMatchObject({
      model: null,
    });
    expect(deps.updateNativeSessionModel).toHaveBeenCalledWith('CODEX', 'session-3', null);
  });
});
