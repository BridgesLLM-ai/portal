import {
  OpenClawProjectModelVerificationError,
  availableModelsFromOpenClawAgentStatus,
  clearOpenClawProjectModelRuntimeEligibility,
  ensureVerifiedOpenClawProjectModel,
  readVerifiedOpenClawProjectExecutionBinding,
  readVerifiedOpenClawSessionModel,
  registerOpenClawProjectModelRuntimeEligibility,
  resolveAllowedOpenClawProjectModel,
  verifyThenPersistOpenClawProjectModel,
  type OpenClawProjectModelDependencies,
} from './openclawProjectModel';
import { withOpenClawSessionMutation } from '../utils/openclawGatewayRpc';

const SESSION_KEY = 'agent:project:session';

beforeEach(() => clearOpenClawProjectModelRuntimeEligibility(SESSION_KEY));

function qualifyRuntime(model: string, executionProviderId = model.split('/')[0]) {
  const revoke = jest.fn();
  registerOpenClawProjectModelRuntimeEligibility({
    sessionKey: SESSION_KEY,
    projectIdentityId: 'project-id',
    model,
    executionProviderId,
    executionRuntimeKind: 'openclaw-embedded',
    evidenceFingerprint: 'e'.repeat(64),
    revoke,
  });
  return revoke;
}

function dependencies(overrides: Partial<OpenClawProjectModelDependencies> = {}): OpenClawProjectModelDependencies {
  return {
    getSessionInfo: jest.fn(async () => ({
      ok: true,
      data: { modelProvider: 'openai', model: 'gpt-5.5' },
    })),
    patchSessionModel: jest.fn(async () => ({
      ok: true,
      resolved: { modelProvider: 'anthropic', model: 'claude-fable-5' },
    })),
    wait: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('verified OpenClaw Project model activation', () => {
  test('an explicit off mutation queued after missing-session defaults remains authoritative', async () => {
    type RuntimeState = {
      modelProvider: string;
      model: string;
      thinkingLevel?: string;
      reasoningLevel?: string;
    };
    let state: RuntimeState | null = null;
    let releaseInspection!: () => void;
    let markInspectionStarted!: () => void;
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const inspectionStarted = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
    let firstInspection = true;
    const patchSessionModel = jest.fn(async (
      _sessionKey: string,
      model: string,
      defaults?: { thinkingLevel?: string; reasoningLevel?: string },
    ) => {
      const [modelProvider, runtimeModel] = model.split('/');
      state = {
        ...(state || {}),
        modelProvider,
        model: runtimeModel,
        ...(defaults || {}),
      };
      return { ok: true, resolved: state };
    });
    const deps = dependencies({
      getSessionInfo: jest.fn(async () => {
        if (firstInspection) {
          firstInspection = false;
          markInspectionStarted();
          await inspectionGate;
        }
        return state
          ? { ok: true, data: { ...state } }
          : { ok: false, error: 'Session not found' };
      }),
      patchSessionModel,
    });

    const defaults = ensureVerifiedOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'anthropic/claude-fable-5',
    }, deps);
    await inspectionStarted;
    const explicitOff = withOpenClawSessionMutation(SESSION_KEY, async () => {
      state = {
        ...(state || { modelProvider: 'openai', model: 'gpt-5.5' }),
        thinkingLevel: 'off',
        reasoningLevel: 'off',
      };
    });
    releaseInspection();
    await Promise.all([defaults, explicitOff]);

    expect(patchSessionModel).toHaveBeenCalledWith(
      SESSION_KEY,
      'anthropic/claude-fable-5',
      { thinkingLevel: 'high', reasoningLevel: 'stream' },
    );
    expect(state).toMatchObject({
      modelProvider: 'anthropic',
      model: 'claude-fable-5',
      thinkingLevel: 'off',
      reasoningLevel: 'off',
    });
  });

  test('missing-session defaults queued after explicit off do not overwrite that choice', async () => {
    type RuntimeState = {
      modelProvider: string;
      model: string;
      thinkingLevel?: string;
      reasoningLevel?: string;
    };
    let state: RuntimeState | null = null;
    let releaseExplicitOff!: () => void;
    let markExplicitOffStarted!: () => void;
    const explicitOffGate = new Promise<void>((resolve) => { releaseExplicitOff = resolve; });
    const explicitOffStarted = new Promise<void>((resolve) => { markExplicitOffStarted = resolve; });
    const patchSessionModel = jest.fn(async (
      _sessionKey: string,
      model: string,
      defaults?: { thinkingLevel?: string; reasoningLevel?: string },
    ) => {
      const [modelProvider, runtimeModel] = model.split('/');
      state = {
        ...(state || {}),
        modelProvider,
        model: runtimeModel,
        ...(defaults || {}),
      };
      return { ok: true, resolved: state };
    });
    const deps = dependencies({
      getSessionInfo: jest.fn(async () => (
        state
          ? { ok: true, data: { ...state } }
          : { ok: false, error: 'Session not found' }
      )),
      patchSessionModel,
    });

    const explicitOff = withOpenClawSessionMutation(SESSION_KEY, async () => {
      markExplicitOffStarted();
      await explicitOffGate;
      state = {
        modelProvider: 'openai',
        model: 'gpt-5.5',
        thinkingLevel: 'off',
        reasoningLevel: 'off',
      };
    });
    await explicitOffStarted;
    const defaults = ensureVerifiedOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'anthropic/claude-fable-5',
    }, deps);
    releaseExplicitOff();
    await Promise.all([explicitOff, defaults]);

    expect(patchSessionModel).toHaveBeenCalledWith(
      SESSION_KEY,
      'anthropic/claude-fable-5',
    );
    expect(patchSessionModel).not.toHaveBeenCalledWith(
      SESSION_KEY,
      'anthropic/claude-fable-5',
      expect.objectContaining({ reasoningLevel: 'stream' }),
    );
    expect(state).toMatchObject({
      modelProvider: 'anthropic',
      model: 'claude-fable-5',
      thinkingLevel: 'off',
      reasoningLevel: 'off',
    });
  });

  test('rejects a failed patch without claiming the requested model', async () => {
    const deps = dependencies({
      patchSessionModel: jest.fn(async () => ({ ok: false, error: 'model not allowed' })),
    });

    await expect(ensureVerifiedOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_PATCH_REJECTED',
    });

    expect(deps.patchSessionModel).toHaveBeenCalledWith(
      'agent:project:session',
      'anthropic/claude-fable-5',
    );
    expect(deps.getSessionInfo).toHaveBeenCalledTimes(1);
  });

  test('does not invoke binding persistence when runtime activation is rejected', async () => {
    qualifyRuntime('anthropic/claude-fable-5');
    const persistVerifiedModel = jest.fn(async (model: string) => ({ model }));
    const deps = dependencies({
      getSessionInfo: jest.fn(async () => ({ ok: false, error: 'Session not found' })),
      patchSessionModel: jest.fn(async () => ({ ok: false, error: 'subscription expired' })),
    });

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
      persistVerifiedModel,
    }, deps)).rejects.toMatchObject({ code: 'MODEL_PATCH_REJECTED' });

    expect(persistVerifiedModel).not.toHaveBeenCalled();
  });

  test('persists only the authoritative readback model after a successful switch', async () => {
    qualifyRuntime('anthropic/claude-fable-5');
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: false, error: 'Session not found' })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'anthropic', model: 'claude-fable-5' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'anthropic', model: 'claude-fable-5' } });
    const patchSessionModel = jest.fn(async () => ({
      ok: true,
      resolved: { modelProvider: 'anthropic', model: 'claude-fable-5' },
    }));
    const persistVerifiedModel = jest.fn(async (model: string) => ({ model, saved: true }));

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
      persistVerifiedModel,
    }, dependencies({ getSessionInfo, patchSessionModel }))).resolves.toMatchObject({
      verified: { model: 'anthropic/claude-fable-5', patched: true },
      persisted: { model: 'anthropic/claude-fable-5', saved: true },
    });

    expect(patchSessionModel).toHaveBeenCalledWith(
      'agent:project:session',
      'anthropic/claude-fable-5',
      { thinkingLevel: 'high', reasoningLevel: 'stream' },
    );
    expect(persistVerifiedModel).toHaveBeenCalledTimes(1);
    expect(persistVerifiedModel).toHaveBeenCalledWith('anthropic/claude-fable-5');
  });

  test('fails provider state closed when persistence fails after creating a missing qualified session', async () => {
    qualifyRuntime('anthropic/claude-fable-5');
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: false, error: 'Session not found' })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'anthropic', model: 'claude-fable-5' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'anthropic', model: 'claude-fable-5' } });
    const patchSessionModel = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        resolved: { modelProvider: 'anthropic', model: 'claude-fable-5' },
      });
    const persistVerifiedModel = jest.fn(async () => {
      throw new Error('database transaction rejected');
    });
    const failProviderClosed = jest.fn(async () => undefined);

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
      persistVerifiedModel,
      failProviderClosed,
    }, dependencies({ getSessionInfo, patchSessionModel }))).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_PERSISTENCE_FAILED',
      rollbackStatus: 'NOT_AVAILABLE',
      message: expect.stringMatching(/re-verification is required/i),
    });

    expect(persistVerifiedModel).toHaveBeenCalledTimes(1);
    expect(patchSessionModel).toHaveBeenNthCalledWith(
      1,
      'agent:project:session',
      'anthropic/claude-fable-5',
      { thinkingLevel: 'high', reasoningLevel: 'stream' },
    );
    expect(patchSessionModel).toHaveBeenCalledTimes(1);
    expect(failProviderClosed).toHaveBeenCalledWith(expect.objectContaining({ rollbackStatus: 'NOT_AVAILABLE' }));
  });

  test('rejects an external CLI runtime before patch, persistence, or dispatch eligibility', async () => {
    const revoke = qualifyRuntime('google/gemini-3.1-pro-preview', 'google');
    const deps = dependencies({
      getSessionInfo: jest.fn(async () => ({
        ok: true,
        data: { modelProvider: 'google-gemini-cli', model: 'gemini-3.1-pro-preview' },
      })),
    });
    const persistVerifiedModel = jest.fn();

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'google/gemini-3.1-pro-preview',
      persistVerifiedModel,
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_RUNTIME_UNSAFE',
    });

    expect(deps.patchSessionModel).not.toHaveBeenCalled();
    expect(persistVerifiedModel).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  test('switches models within the qualified embedded provider without revoking evidence', async () => {
    const revoke = qualifyRuntime('openai/gpt-5.5');
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.5' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.6-terra' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.6-terra' } });
    const persistVerifiedModel = jest.fn(async (model: string) => ({ model }));
    const deps = dependencies({
      getSessionInfo,
      patchSessionModel: jest.fn(async () => ({
        ok: true,
        resolved: { modelProvider: 'openai', model: 'gpt-5.6-terra' },
      })),
    });

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'openai/gpt-5.6-terra',
      persistVerifiedModel,
    }, deps)).resolves.toMatchObject({
      verified: { model: 'openai/gpt-5.6-terra', patched: true },
      persisted: { model: 'openai/gpt-5.6-terra' },
    });

    expect(deps.patchSessionModel).toHaveBeenCalledWith(SESSION_KEY, 'openai/gpt-5.6-terra');
    expect(persistVerifiedModel).toHaveBeenCalledWith('openai/gpt-5.6-terra');
    expect(revoke).not.toHaveBeenCalled();
  });

  test('retains provider qualification when persisted evidence names the prior same-provider model', async () => {
    const revoke = qualifyRuntime('openai/gpt-5.5');
    const getSessionInfo = jest.fn(async () => ({
      ok: true,
      data: { modelProvider: 'openai', model: 'gpt-5.6-terra' },
    }));
    const persistVerifiedModel = jest.fn(async (model: string) => ({ model }));
    const deps = dependencies({ getSessionInfo });

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'openai/gpt-5.6-terra',
      persistVerifiedModel,
    }, deps)).resolves.toMatchObject({
      verified: { model: 'openai/gpt-5.6-terra', patched: false },
      persisted: { model: 'openai/gpt-5.6-terra' },
    });

    expect(deps.patchSessionModel).not.toHaveBeenCalled();
    expect(persistVerifiedModel).toHaveBeenCalledWith('openai/gpt-5.6-terra');
    expect(revoke).not.toHaveBeenCalled();
  });

  test('switches back to the evidenced model when the live same-provider binding has moved', async () => {
    const revoke = qualifyRuntime('openai/gpt-5.5');
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.6-terra' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.5' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.5' } });
    const persistVerifiedModel = jest.fn(async (model: string) => ({ model }));
    const deps = dependencies({
      getSessionInfo,
      patchSessionModel: jest.fn(async () => ({
        ok: true,
        resolved: { modelProvider: 'openai', model: 'gpt-5.5' },
      })),
    });

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'openai/gpt-5.5',
      persistVerifiedModel,
    }, deps)).resolves.toMatchObject({
      verified: { model: 'openai/gpt-5.5', patched: true },
    });

    expect(deps.patchSessionModel).toHaveBeenCalledWith(SESSION_KEY, 'openai/gpt-5.5');
    expect(revoke).not.toHaveBeenCalled();
  });

  test('rejects a cross-provider model change without disturbing qualified evidence', async () => {
    const revoke = qualifyRuntime('openai/gpt-5.5');
    const persistVerifiedModel = jest.fn();
    const deps = dependencies();

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'anthropic/claude-fable-5',
      persistVerifiedModel,
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_RUNTIME_UNSAFE',
    });

    expect(deps.getSessionInfo).not.toHaveBeenCalled();
    expect(deps.patchSessionModel).not.toHaveBeenCalled();
    expect(persistVerifiedModel).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  test('rolls back and retains qualification when post-patch runtime provider is unsafe', async () => {
    const revoke = qualifyRuntime('openai/gpt-5.5');
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.5' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.6-terra' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'codex-cli', model: 'gpt-5.6-terra' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.5' } });
    const patchSessionModel = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        resolved: { modelProvider: 'openai', model: 'gpt-5.6-terra' },
      })
      .mockResolvedValueOnce({
        ok: true,
        resolved: { modelProvider: 'openai', model: 'gpt-5.5' },
      });
    const persistVerifiedModel = jest.fn();

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: SESSION_KEY,
      desiredModel: 'openai/gpt-5.6-terra',
      persistVerifiedModel,
    }, dependencies({ getSessionInfo, patchSessionModel }))).rejects.toMatchObject<
      Partial<OpenClawProjectModelVerificationError>
    >({
      code: 'MODEL_RUNTIME_UNSAFE',
      rollbackStatus: 'CONFIRMED',
    });

    expect(patchSessionModel).toHaveBeenNthCalledWith(2, SESSION_KEY, 'openai/gpt-5.5');
    expect(persistVerifiedModel).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  test('does not mutate or close the runtime when persistence fails for an already-active model', async () => {
    qualifyRuntime('openai/gpt-5.5');
    const failProviderClosed = jest.fn(async () => undefined);
    const deps = dependencies();

    await expect(verifyThenPersistOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'openai/gpt-5.5',
      persistVerifiedModel: async () => {
        throw new Error('database unavailable');
      },
      failProviderClosed,
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_PERSISTENCE_FAILED',
      rollbackStatus: 'NOT_REQUIRED',
    });

    expect(deps.patchSessionModel).not.toHaveBeenCalled();
    expect(failProviderClosed).not.toHaveBeenCalled();
  });

  test('returns only the model confirmed by a live post-patch session readback', async () => {
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'xai', model: 'grok-4.5' } })
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'anthropic', model: 'claude-fable-5' } });
    const deps = dependencies({ getSessionInfo });

    await expect(ensureVerifiedOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
    }, deps)).resolves.toEqual({
      model: 'anthropic/claude-fable-5',
      runtimeModel: 'anthropic/claude-fable-5',
      patched: true,
      patchResolvedModel: 'anthropic/claude-fable-5',
    });

    expect(deps.patchSessionModel).toHaveBeenCalledTimes(1);
    expect(getSessionInfo).toHaveBeenCalledTimes(2);
  });

  test('rejects an ok patch whose authoritative readback remains on another model', async () => {
    const getSessionInfo = jest.fn(async () => ({
      ok: true,
      data: { modelProvider: 'xai', model: 'grok-4.5' },
    }));
    const deps = dependencies({ getSessionInfo });

    await expect(ensureVerifiedOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_READBACK_MISMATCH',
      rollbackStatus: 'CONFIRMED',
    });

    expect(getSessionInfo).toHaveBeenCalledTimes(5);
    expect(deps.patchSessionModel).toHaveBeenNthCalledWith(
      2,
      'agent:project:session',
      'xai/grok-4.5',
    );
    expect(deps.wait).toHaveBeenCalledTimes(2);
  });

  test('reports an uncertain runtime when a mismatched patch cannot be rolled back', async () => {
    const getSessionInfo = jest.fn()
      .mockResolvedValueOnce({ ok: true, data: { modelProvider: 'xai', model: 'grok-4.5' } })
      .mockResolvedValue({ ok: true, data: { modelProvider: 'openai', model: 'gpt-5.5' } });
    const patchSessionModel = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        resolved: { modelProvider: 'anthropic', model: 'claude-fable-5' },
      })
      .mockResolvedValueOnce({ ok: false, error: 'gateway rejected rollback' });
    const deps = dependencies({ getSessionInfo, patchSessionModel });

    await expect(ensureVerifiedOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_READBACK_MISMATCH',
      rollbackStatus: 'FAILED',
      message: expect.stringMatching(/re-verification is required/i),
    });

    expect(patchSessionModel).toHaveBeenNthCalledWith(2, 'agent:project:session', 'xai/grok-4.5');
  });

  test('accepts an already-active exact canonical model without patching', async () => {
    const deps = dependencies();

    await expect(ensureVerifiedOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'codex/gpt-5.5',
    }, deps)).resolves.toMatchObject({
      model: 'openai/gpt-5.5',
      patched: false,
    });

    expect(deps.patchSessionModel).not.toHaveBeenCalled();
  });

  test('never accepts stale local session metadata as model proof', async () => {
    const deps = dependencies({
      getSessionInfo: jest.fn(async () => ({
        ok: true,
        data: {
          modelProvider: 'anthropic',
          model: 'claude-fable-5',
          stale: true,
          staleReason: 'gateway timeout',
        },
      })),
    });

    await expect(ensureVerifiedOpenClawProjectModel({
      sessionKey: 'agent:project:session',
      desiredModel: 'anthropic/claude-fable-5',
    }, deps)).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'SESSION_INSPECTION_STALE',
    });
  });

  test('canonicalizes provider aliases from live session metadata', () => {
    expect(readVerifiedOpenClawSessionModel({ modelProvider: 'openai-codex', model: 'gpt-5.5' }))
      .toBe('openai/gpt-5.5');
    expect(readVerifiedOpenClawSessionModel({ modelProvider: 'google-gemini-cli', model: 'gemini-3.1-pro-preview' }))
      .toBe('google/gemini-3.1-pro-preview');
  });

  test('derives availability only from the exact agent status auth evidence', () => {
    const baseStatus = {
      allowed: [
        'openai/gpt-5.6-sol',
        'xai/grok-4.20-beta-latest-reasoning',
      ],
      auth: {
        providers: [{
          provider: 'xai',
          profiles: { count: 1, oauth: 1, token: 0, apiKey: 0 },
        }],
        oauth: {
          providers: [{
            provider: 'xai',
            status: 'ok',
            effectiveProfiles: [{
              profileId: 'xai:project',
              type: 'oauth',
              status: 'ok',
              source: 'store',
            }],
          }],
        },
        runtimeAuthRoutes: [],
        unusableProfiles: [],
      },
    };
    const baseCatalog = {
      models: [
        { key: 'openai/gpt-5.6-sol' },
        { key: 'xai/grok-4.20-beta-latest-reasoning' },
      ],
    };
    expect(availableModelsFromOpenClawAgentStatus(baseStatus, baseCatalog)).toEqual([
      'xai/grok-4.20-beta-latest-reasoning',
    ]);
    expect(availableModelsFromOpenClawAgentStatus({
      ...baseStatus,
      auth: {
        ...baseStatus.auth,
        oauth: {
          providers: [{
            provider: 'xai',
            status: 'expired',
            effectiveProfiles: [{
              profileId: 'xai:project',
              type: 'oauth',
              status: 'expired',
              source: 'store',
            }],
          }],
        },
      },
    }, baseCatalog)).toEqual([]);
  });

  test('accepts direct effective auth while rejecting external CLI routes and profile counts', () => {
    expect(availableModelsFromOpenClawAgentStatus({
      allowed: [
        'openai/gpt-5.5',
        'anthropic/claude-fable-5',
        'google/gemini-3.1-pro-preview',
        'xai/grok-4.20-beta-latest-reasoning',
      ],
      auth: {
        providers: [
          {
            provider: 'openai',
            effective: { kind: 'profiles' },
            profiles: { count: 1, oauth: 1, token: 0, apiKey: 0 },
          },
          {
            provider: 'anthropic',
            effective: { kind: 'profiles' },
            profiles: { count: 1, oauth: 0, token: 0, apiKey: 1 },
          },
          {
            provider: 'google',
            effective: { kind: 'profiles' },
            profiles: { count: 1, oauth: 0, token: 0, apiKey: 1 },
          },
          {
            provider: 'xai',
            effective: { kind: 'env' },
            profiles: { count: 0, oauth: 0, token: 0, apiKey: 0 },
          },
        ],
        oauth: {
          providers: [
            {
              provider: 'openai',
              status: 'ok',
              effectiveProfiles: [{
                profileId: 'openai:codex-cli',
                type: 'oauth',
                status: 'ok',
                source: 'store',
              }],
            },
            {
              provider: 'google',
              status: 'static',
              effectiveProfiles: [{
                profileId: 'google:default',
                type: 'api_key',
                status: 'static',
                source: 'store',
              }],
            },
          ],
        },
        runtimeAuthRoutes: [
          {
            provider: 'openai',
            runtime: 'codex',
            status: 'usable',
          },
          {
            provider: 'anthropic',
            runtime: 'claude-cli',
            status: 'usable',
          },
        ],
        unusableProfiles: [],
      },
    }, {
      models: [
        { key: 'openai/gpt-5.5' },
        { key: 'anthropic/claude-fable-5' },
        { key: 'google/gemini-3.1-pro-preview' },
        { key: 'xai/grok-4.20-beta-latest-reasoning' },
      ],
    })).toEqual([
      'google/gemini-3.1-pro-preview',
      'xai/grok-4.20-beta-latest-reasoning',
    ]);
  });

  test('accepts an independent direct profile even when the provider also exposes a CLI route', () => {
    expect(availableModelsFromOpenClawAgentStatus({
      allowed: ['openai/gpt-5.5'],
      auth: {
        providers: [{
          provider: 'openai',
          effective: { kind: 'profiles' },
          profiles: { count: 2, oauth: 2, token: 0, apiKey: 0 },
        }],
        oauth: {
          providers: [{
            provider: 'openai',
            status: 'ok',
            effectiveProfiles: [
              {
                profileId: 'openai:codex-cli',
                type: 'oauth',
                status: 'ok',
                source: 'store',
              },
              {
                profileId: 'openai:project-api',
                type: 'oauth',
                status: 'ok',
                source: 'store',
              },
            ],
          }],
        },
        runtimeAuthRoutes: [{
          provider: 'openai',
          runtime: 'codex',
          status: 'usable',
        }],
      },
    }, {
      models: [{ key: 'openai/gpt-5.5' }],
    })).toEqual(['openai/gpt-5.5']);
  });

  test('does not treat an OAuth marker in models.json as direct embedded auth', () => {
    expect(availableModelsFromOpenClawAgentStatus({
      allowed: ['xai/grok-4.20-beta-latest-reasoning'],
      auth: {
        providers: [{
          provider: 'xai',
          effective: {
            kind: 'models.json',
            detail: 'marker(xai-oauth)',
          },
          profiles: { count: 0, oauth: 0, token: 0, apiKey: 0 },
        }],
        oauth: { providers: [] },
        runtimeAuthRoutes: [],
      },
    }, {
      models: [{ key: 'xai/grok-4.20-beta-latest-reasoning' }],
    })).toEqual([]);
  });

  test('uses a bounded real-ID catalog when the exact-agent allowlist is empty', () => {
    expect(availableModelsFromOpenClawAgentStatus({
      allowed: [],
      defaultModel: 'xai/grok-default',
      fallbacks: ['xai/grok-fallback'],
      auth: {
        providers: [{
          provider: 'xai',
          effective: { kind: 'env', detail: 'XAI_API_KEY' },
        }],
        oauth: { providers: [] },
        runtimeAuthRoutes: [],
      },
    }, {
      models: [
        { key: 'xai/grok-default' },
        { key: 'xai/grok-fallback' },
        { key: 'xai/grok-catalog' },
        { key: 'xai/*' },
        { key: 'claude-cli/claude-opus-4-8' },
      ],
    })).toEqual([
      'xai/grok-default',
      'xai/grok-fallback',
      'xai/grok-catalog',
    ]);
  });

  test('does not let a stale configured model outrank a live catalog model', () => {
    expect(availableModelsFromOpenClawAgentStatus({
      allowed: [
        'openai/gpt-stale',
        'xai/grok-4.20-beta-latest-reasoning',
      ],
      defaultModel: 'openai/gpt-stale',
      auth: {
        providers: [
          { provider: 'openai', effective: { kind: 'env', detail: 'OPENAI_API_KEY' } },
          { provider: 'xai', effective: { kind: 'env', detail: 'XAI_API_KEY' } },
        ],
        oauth: { providers: [] },
        runtimeAuthRoutes: [],
      },
    }, {
      models: [{ key: 'xai/grok-4.20-beta-latest-reasoning' }],
    })).toEqual(['xai/grok-4.20-beta-latest-reasoning']);
  });

  test('expands only anchored provider wildcards and never returns a wildcard model', () => {
    expect(availableModelsFromOpenClawAgentStatus({
      allowed: ['xai/*', 'xai/grok*', 'openai/gpt-5.5'],
      auth: {
        providers: [
          { provider: 'xai', effective: { kind: 'env', detail: 'XAI_API_KEY' } },
          { provider: 'openai', effective: { kind: 'env', detail: 'OPENAI_API_KEY' } },
        ],
        oauth: { providers: [] },
        runtimeAuthRoutes: [],
      },
    }, {
      models: [
        { key: 'xai/grok-alpha' },
        { key: 'xai/grok-beta' },
        { key: 'xai/*' },
        { key: 'openai/gpt-5.5' },
      ],
    })).toEqual([
      'xai/grok-alpha',
      'xai/grok-beta',
      'openai/gpt-5.5',
    ]);
  });

  test('binds embedded execution to the exact provider/model and rejects an unknown harness', () => {
    expect(readVerifiedOpenClawProjectExecutionBinding({
      modelProvider: 'openai',
      model: 'gpt-5.5',
      agentHarnessId: null,
    })).toEqual({
      model: 'openai/gpt-5.5',
      executionProviderId: 'openai',
      executionRuntimeKind: 'openclaw-embedded',
    });
    expect(() => readVerifiedOpenClawProjectExecutionBinding({
      modelProvider: 'openai',
      model: 'gpt-5.5',
      agentHarnessId: 'codex',
    })).toThrow(expect.objectContaining({ code: 'MODEL_RUNTIME_UNSAFE' }));
  });

  test('rejects an explicit model missing from the live catalog instead of substituting a fallback', async () => {
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      ['anthropic/claude-fable-5', 'openai/gpt-5.5'],
      'anthropic/claude-fable-5',
      {
        listAgentModels: jest.fn(async () => ({
          ok: true,
          models: [{ provider: 'openai', model: 'gpt-5.5' }],
        })),
      },
    )).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_UNAVAILABLE',
    });
  });

  test.each([
    [{ key: 'xai/grok-4.5', available: true }],
    [{ provider: 'xai', model: 'grok-4.5', available: true }],
  ])('skips unavailable and missing rows while preserving an available canonical catalog ID: %p', async (availableModel) => {
    const listAgentModels = jest.fn(async () => ({
      ok: true,
      models: [
        { key: 'openai/gpt-5.6-sol', available: false },
        { provider: 'anthropic', model: 'claude-fable-5', missing: true },
        availableModel,
      ],
    }));
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5'],
      '',
      { listAgentModels },
    )).resolves.toEqual({ model: 'xai/grok-4.5' });
    expect(listAgentModels).toHaveBeenCalledWith('p4oc-test');
  });

  test.each([
    [{ key: 'openai/gpt-5.6-sol', available: false }],
    [{ provider: 'openai', model: 'gpt-5.6-sol', missing: true }],
  ])('rejects an explicitly requested unavailable catalog row: %p', async (unavailableModel) => {
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      ['openai/gpt-5.6-sol'],
      'openai/gpt-5.6-sol',
      {
        listAgentModels: jest.fn(async () => ({
          ok: true,
          models: [unavailableModel],
        })),
      },
    )).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_UNAVAILABLE',
    });
  });

  test('rejects an explicit model when the live catalog cannot verify availability', async () => {
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      ['anthropic/claude-fable-5'],
      'anthropic/claude-fable-5',
      {
        listAgentModels: jest.fn(async () => ({ ok: false, error: 'gateway offline' })),
      },
    )).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_CATALOG_UNAVAILABLE',
    });
  });

  test.each([
    ['failed', { ok: false, error: 'gateway offline' }, 'MODEL_CATALOG_UNAVAILABLE'],
    ['empty', { ok: true, models: [] }, 'MODEL_UNAVAILABLE'],
  ] as Array<[
    string,
    { ok: boolean; models?: any[]; error?: string },
    'MODEL_CATALOG_UNAVAILABLE' | 'MODEL_UNAVAILABLE',
  ]>)('fails closed for a non-explicit %s dedicated-agent catalog', async (_label, result, code) => {
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      ['openai/gpt-5.6-sol'],
      '',
      { listAgentModels: jest.fn(async () => result) },
    )).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code,
    });
  });

  test('rejects a catalog model from an execution provider family that cannot be pinned embedded', async () => {
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      [],
      'custom-runtime/model-1',
      {
        listAgentModels: jest.fn(async () => ({
          ok: true,
          models: [{ provider: 'custom-runtime', model: 'model-1' }],
        })),
      },
    )).rejects.toMatchObject<Partial<OpenClawProjectModelVerificationError>>({
      code: 'MODEL_RUNTIME_UNSAFE',
    });
  });

  test('accepts a canonical alias only when the live catalog contains the exact model identity', async () => {
    await expect(resolveAllowedOpenClawProjectModel(
      'p4oc-test',
      ['openai-codex/gpt-5.5'],
      'openai-codex/gpt-5.5',
      {
        listAgentModels: jest.fn(async () => ({
          ok: true,
          models: [{ provider: 'openai', model: 'gpt-5.5' }],
        })),
      },
    )).resolves.toEqual({ model: 'openai/gpt-5.5' });
  });
});
