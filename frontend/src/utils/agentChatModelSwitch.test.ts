import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentChatSessionModel,
  hasConcreteAgentChatSession,
  isAgentChatLaunchBoundModelError,
} from './agentChatModelSwitch';

describe('Agent Chat session model switching', () => {
  it('sends an empty model to a concrete native session as a real default reset', async () => {
    const patchSessionModel = vi.fn().mockResolvedValue({ ok: true, reset: true });

    const result = await applyAgentChatSessionModel({
      provider: 'CODEX',
      session: 'native-session-1',
      model: '',
      patchSessionModel,
    });

    expect(result).toEqual({
      deferred: false,
      patchResponse: { ok: true, reset: true },
    });
    expect(patchSessionModel).toHaveBeenCalledWith('native-session-1', '', 'CODEX');
  });

  it('sends an empty model to a concrete OpenClaw session', async () => {
    const patchSessionModel = vi.fn().mockResolvedValue({ ok: true });

    await applyAgentChatSessionModel({
      provider: 'OPENCLAW',
      session: 'agent:main:main',
      model: '   ',
      patchSessionModel,
    });

    expect(patchSessionModel).toHaveBeenCalledWith('agent:main:main', '', 'OPENCLAW');
  });

  it('defers blank reset selections until a concrete session exists', async () => {
    const patchSessionModel = vi.fn();

    await expect(applyAgentChatSessionModel({
      provider: 'CODEX',
      session: 'new-123',
      model: '',
      patchSessionModel,
    })).resolves.toEqual({ deferred: true });
    await expect(applyAgentChatSessionModel({
      provider: 'OPENCLAW',
      session: 'main',
      model: '',
      patchSessionModel,
    })).resolves.toEqual({ deferred: true });

    expect(patchSessionModel).not.toHaveBeenCalled();
    expect(hasConcreteAgentChatSession('OPENCLAW', 'agent:main:main')).toBe(true);
  });

  it('preserves synthetic OpenClaw create-and-retry behavior for reset requests', async () => {
    const missing = Object.assign(new Error('missing'), { response: { status: 404 } });
    const patchSessionModel = vi.fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ ok: true, reset: true });
    const createSession = vi.fn().mockResolvedValue({ ok: true });

    await expect(applyAgentChatSessionModel({
      provider: 'OPENCLAW',
      session: 'agent:main:new-123',
      model: '',
      patchSessionModel,
      createSession,
    })).resolves.toEqual({
      deferred: false,
      patchResponse: { ok: true, reset: true },
    });

    expect(createSession).toHaveBeenCalledWith('agent:main:new-123', 'OPENCLAW');
    expect(patchSessionModel).toHaveBeenCalledTimes(2);
  });

  it('recognizes only the typed launch-bound model transition code', () => {
    expect(isAgentChatLaunchBoundModelError({
      response: { data: { code: 'MODEL_REQUIRES_NEW_SESSION' } },
    })).toBe(true);
    expect(isAgentChatLaunchBoundModelError({ code: 'model_requires_new_session' })).toBe(true);
    expect(isAgentChatLaunchBoundModelError({
      response: { data: { message: 'MODEL_REQUIRES_NEW_SESSION' } },
    })).toBe(false);
    expect(isAgentChatLaunchBoundModelError({
      response: { data: { code: 'MODEL_NOT_ALLOWED' } },
    })).toBe(false);
  });
});
