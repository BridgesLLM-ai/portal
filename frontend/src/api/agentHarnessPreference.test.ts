// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('./client', () => ({
  default: {
    get: mocks.get,
    patch: mocks.patch,
  },
}));

import {
  AGENT_HARNESS_SELECTION_EVENT,
  AGENT_HARNESS_PREFERENCE_EVENT,
  loadDefaultAgentHarness,
  loadAndApplyDefaultAgentHarness,
  persistSelectedAgentHarness,
  readSelectedAgentHarness,
  saveAndApplyDefaultAgentHarness,
} from './agentHarnessPreference';

describe('Agent harness preference synchronization', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.get.mockReset();
    mocks.patch.mockReset();
  });

  it('preserves the existing browser selection at migration revision zero', async () => {
    localStorage.setItem('agent-chat-provider', 'CODEX');
    mocks.get.mockResolvedValue({ data: { defaultHarness: 'OPENCLAW', revision: 0 } });

    await expect(loadAndApplyDefaultAgentHarness('user-1')).resolves.toMatchObject({
      defaultHarness: 'OPENCLAW',
      selectedHarness: 'CODEX',
      applied: false,
    });
    expect(readSelectedAgentHarness()).toBe('CODEX');
  });

  it('applies each changed server revision once while preserving later manual choices', async () => {
    localStorage.setItem('agent-chat-provider', 'OPENCLAW');
    mocks.get.mockResolvedValue({ data: { defaultHarness: 'CODEX', revision: 1 } });

    await expect(loadAndApplyDefaultAgentHarness('user-1')).resolves.toMatchObject({
      selectedHarness: 'CODEX',
      applied: true,
    });
    persistSelectedAgentHarness('CLAUDE_CODE');

    await expect(loadAndApplyDefaultAgentHarness('user-1')).resolves.toMatchObject({
      selectedHarness: 'CLAUDE_CODE',
      applied: false,
    });
  });

  it('does not carry another account selection across an authenticated actor change', async () => {
    mocks.get.mockResolvedValueOnce({ data: { defaultHarness: 'CODEX', revision: 0 } });
    await loadAndApplyDefaultAgentHarness('user-1');
    persistSelectedAgentHarness('CLAUDE_CODE');

    mocks.get.mockResolvedValueOnce({ data: { defaultHarness: 'OPENCLAW', revision: 0 } });
    await expect(loadAndApplyDefaultAgentHarness('user-2')).resolves.toMatchObject({
      selectedHarness: 'OPENCLAW',
      applied: true,
    });
  });

  it('PATCHes the stable harness id and immediately publishes the new default selection', async () => {
    const listener = vi.fn();
    window.addEventListener(AGENT_HARNESS_SELECTION_EVENT, listener);
    mocks.patch.mockResolvedValue({ data: { defaultHarness: 'GEMINI', revision: 4 } });

    await expect(saveAndApplyDefaultAgentHarness('user-1', 'gemini')).resolves.toMatchObject({
      defaultHarness: 'GEMINI',
      selectedHarness: 'GEMINI',
      revision: 4,
      applied: true,
    });
    expect(mocks.patch).toHaveBeenCalledWith('/users/me/agent-harness-preference', {
      harnessId: 'GEMINI',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AGENT_HARNESS_SELECTION_EVENT, listener);
  });

  it('fails closed on a malformed preference response', async () => {
    mocks.get.mockResolvedValue({ data: { defaultHarness: 'CODEX', revision: -1 } });
    await expect(loadAndApplyDefaultAgentHarness('user-1')).rejects.toThrow(
      'Default harness preference response is invalid',
    );
    expect(localStorage.getItem('agent-chat-provider')).toBeNull();
  });
  it('reads the persisted default without mutating a temporary chat selection', async () => {
    persistSelectedAgentHarness('CLAUDE_CODE');
    mocks.get.mockResolvedValue({ data: { defaultHarness: 'CODEX', revision: 3 } });
    await expect(loadDefaultAgentHarness('user-1')).resolves.toEqual({ defaultHarness: 'CODEX', revision: 3 });
    expect(readSelectedAgentHarness()).toBe('CLAUDE_CODE');
  });

  it('publishes an account-scoped default event only for a saved preference, not chat switches', async () => {
    const listener = vi.fn();
    window.addEventListener(AGENT_HARNESS_PREFERENCE_EVENT, listener);
    persistSelectedAgentHarness('CLAUDE_CODE');
    expect(listener).not.toHaveBeenCalled();
    mocks.patch.mockResolvedValue({ data: { defaultHarness: 'CODEX', revision: 3 } });
    await saveAndApplyDefaultAgentHarness('user-1', 'CODEX');
    expect(listener.mock.calls[0][0].detail).toEqual({ userId: 'user-1', defaultHarness: 'CODEX', revision: 3 });
    window.removeEventListener(AGENT_HARNESS_PREFERENCE_EVENT, listener);
  });

});
