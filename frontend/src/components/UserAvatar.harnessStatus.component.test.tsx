// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import '../test/setup';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  loadCatalog: vi.fn(),
  authUser: {
    current: { id: 'owner-1', role: 'OWNER', username: 'owner' } as any,
  },
}));

vi.mock('../api/client', () => ({
  default: { get: mocks.get },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    isAuthenticated: true,
    user: mocks.authUser.current,
  }),
}));
vi.mock('../hooks/useUserAvatarUrl', () => ({
  useUserAvatarUrl: () => null,
  setCachedUserAvatarUrl: vi.fn(),
}));
vi.mock('../utils/agentChatProviderCatalog', async () => {
  const actual = await vi.importActual<any>('../utils/agentChatProviderCatalog');
  return { ...actual, loadAgentChatProviderCatalog: mocks.loadCatalog };
});

import UserAvatar, { resolveAssistantHarnessIndicator } from './UserAvatar';
import { AGENT_HARNESS_PREFERENCE_EVENT, agentHarnessPreferenceStorageKey, persistSelectedAgentHarness } from '../api/agentHarnessPreference';

function harness(id: string, overrides: Record<string, unknown> = {}) {
  return {
    harnessId: id,
    name: id,
    displayName: id === 'CODEX' ? 'Codex' : id === 'OPENCODE' ? 'OpenCode' : 'OpenClaw',
    implemented: true,
    selectable: true,
    installed: true,
    usable: true,
    availabilityState: 'ready',
    ...overrides,
  };
}

describe('Assistant harness status provenance', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.get.mockReset();
    mocks.loadCatalog.mockReset();
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', username: 'owner' };
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/users/me/agent-harness-preference') {
        return { data: { defaultHarness: 'OPENCLAW', revision: 0 } };
      }
      if (url === '/users/assistant-avatar') return { data: { avatarUrl: null } };
      if (url === '/gateway/health') return { data: { wsConnected: true } };
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it('derives native readiness from the harness catalog', () => {
    expect(resolveAssistantHarnessIndicator('CODEX', harness('CODEX') as any)).toEqual({
      state: 'ready',
      label: 'Codex: Ready',
    });
    expect(resolveAssistantHarnessIndicator('OPENCODE', harness('OPENCODE', {
      implemented: false,
      selectable: false,
      usable: false,
      unavailableReason: 'Planned adapter',
    }) as any)).toEqual({
      state: 'unavailable',
      label: 'OpenCode: Planned adapter',
    });
  });

  it('uses the saved native default, not the current OpenClaw chat', async () => {
    localStorage.setItem('agent-chat-provider', 'OPENCLAW');
    mocks.get.mockImplementation(async (url: string) => ({ data: url === '/users/me/agent-harness-preference' ? { defaultHarness: 'CODEX', revision: 1 } : { avatarUrl: null } }));
    mocks.loadCatalog.mockResolvedValue([harness('CODEX')]);

    render(<UserAvatar assistant editable={false} />);

    expect(await screen.findByLabelText('Codex: Ready')).toBeInTheDocument();
    expect(mocks.get.mock.calls.some(([url]) => url === '/gateway/health')).toBe(false);
  });

  it('requires authenticated Gateway WebSocket health for OpenClaw', async () => {
    localStorage.setItem('agent-chat-provider', 'OPENCLAW');
    mocks.loadCatalog.mockResolvedValue([harness('OPENCLAW')]);

    render(<UserAvatar assistant editable={false} />);

    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/gateway/health', expect.anything()));
    expect(await screen.findByLabelText('OpenClaw Gateway: Connected')).toBeInTheDocument();
  });

  it('does not show OpenClaw ready when its catalog readiness fails closed', () => {
    expect(resolveAssistantHarnessIndicator('OPENCLAW', harness('OPENCLAW', {
      usable: false,
      reason: 'Gateway authorization is unavailable.',
    }) as any, true)).toEqual({
      state: 'unavailable',
      label: 'OpenClaw: Gateway authorization is unavailable.',
    });
  });

  it('does not fetch or render host-operator harness readiness for an ordinary Project-only user', async () => {
    mocks.authUser.current = { id: 'user-1', role: 'USER', username: 'member' };
    localStorage.setItem('agent-chat-provider', 'HERMES');

    render(<UserAvatar assistant editable={false} />);

    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(
      '/users/me/agent-harness-preference',
      expect.anything(),
    ));
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Hermes:|OpenClaw Gateway:|Assistant harness:/i)).not.toBeInTheDocument();
  });
  it('ignores temporary chat selection and other accounts when tracking the saved default', async () => {
    mocks.loadCatalog.mockResolvedValue([harness('OPENCLAW'), harness('CODEX')]);
    render(<UserAvatar assistant editable={false} />);
    expect(await screen.findByLabelText('OpenClaw Gateway: Connected')).toBeInTheDocument();
    act(() => {
      persistSelectedAgentHarness('CODEX');
      window.dispatchEvent(new CustomEvent(AGENT_HARNESS_PREFERENCE_EVENT, {
        detail: { userId: 'someone-else', defaultHarness: 'CODEX', revision: 2 },
      }));
    });
    expect(screen.getByLabelText('OpenClaw Gateway: Connected')).toBeInTheDocument();
    expect(screen.queryByLabelText('Codex: Ready')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent(AGENT_HARNESS_PREFERENCE_EVENT, {
      detail: { userId: 'owner-1', defaultHarness: 'CODEX', revision: 2 },
    })));
    expect(await screen.findByLabelText('Codex: Ready')).toBeInTheDocument();
  });

  it('refreshes saved defaults across tabs, but ignores another tab changing chats', async () => {
    mocks.loadCatalog.mockResolvedValue([harness('OPENCLAW'), harness('CODEX')]);
    render(<UserAvatar assistant editable={false} />);
    expect(await screen.findByLabelText('OpenClaw Gateway: Connected')).toBeInTheDocument();
    const reads = mocks.get.mock.calls.filter(([url]) => url === '/users/me/agent-harness-preference').length;
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'agent-chat-provider', newValue: 'CODEX' })));
    expect(mocks.get.mock.calls.filter(([url]) => url === '/users/me/agent-harness-preference')).toHaveLength(reads);
    mocks.get.mockImplementation(async (url: string) => ({ data: url === '/users/me/agent-harness-preference' ? { defaultHarness: 'CODEX', revision: 2 } : { avatarUrl: null } }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: agentHarnessPreferenceStorageKey('owner-1'), newValue: 'changed' })));
    expect(await screen.findByLabelText('Codex: Ready')).toBeInTheDocument();
  });

  it('does not infer a preferred harness from chat storage when the preference read fails', async () => {
    localStorage.setItem('agent-chat-provider', 'CODEX');
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/users/me/agent-harness-preference') throw new Error('offline');
      return { data: { avatarUrl: null } };
    });
    render(<UserAvatar assistant editable={false} />);
    expect(await screen.findByLabelText('Default Assistant harness could not be verified')).toBeInTheDocument();
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

});
