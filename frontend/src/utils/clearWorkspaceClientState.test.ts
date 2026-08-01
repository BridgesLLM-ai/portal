// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWorkspaceClientState } from './clearWorkspaceClientState';
import { WORKSPACE_NAVIGATION_STORAGE_KEY } from './workspaceNavigation';

describe('workspace client-state scrub', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('removes workspace identities and pending content while preserving global preferences', () => {
    localStorage.setItem('projects-last-selected', 'owner-secret-project');
    localStorage.setItem('portal:project-rename-attempt:owner-1', '{}');
    localStorage.setItem('project-chat-pending-send:v2:user:project:provider', '{"message":"secret"}');
    localStorage.setItem('project-chat-confirmed-send:v1:user:project:provider', '{"message":"secret"}');
    localStorage.setItem('agent-active-owner-secret-project', 'true');
    localStorage.setItem('agent-model-owner-secret-project-OPENCLAW', 'model');
    localStorage.setItem('agentChats.lastModel.OPENCLAW', 'global-model');
    localStorage.setItem('theme', 'dark');
    sessionStorage.setItem(WORKSPACE_NAVIGATION_STORAGE_KEY, '{"entries":[{"target":"secret"}]}');
    sessionStorage.setItem('portal:terminal-state:v1', '{"tabs":[{"label":"owner shell"}]}');
    sessionStorage.setItem('mail-active-account', 'owner@example.com');
    sessionStorage.setItem('bridgesllm.setup.session.v1', 'setup-credential');
    sessionStorage.setItem('cached_userAvatar', '/private/avatar.png');
    sessionStorage.setItem('cached_assistantAvatar', '/private/assistant.png');
    sessionStorage.setItem('portal-module-reload:FilesPage', '1');
    sessionStorage.setItem('cached_publicSettings', '{"portalName":"Portal"}');
    sessionStorage.setItem(
      'bridgesllm.agentTools.indeterminateInstall.v1',
      '{"toolId":"tool-1"}',
    );

    clearWorkspaceClientState();

    expect(localStorage.getItem('projects-last-selected')).toBeNull();
    expect(localStorage.getItem('portal:project-rename-attempt:owner-1')).toBeNull();
    expect(localStorage.getItem('project-chat-pending-send:v2:user:project:provider')).toBeNull();
    expect(localStorage.getItem('project-chat-confirmed-send:v1:user:project:provider')).toBeNull();
    expect(localStorage.getItem('agent-active-owner-secret-project')).toBeNull();
    expect(localStorage.getItem('agent-model-owner-secret-project-OPENCLAW')).toBeNull();
    expect(localStorage.getItem('agentChats.lastModel.OPENCLAW')).toBe('global-model');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('portal:terminal-state:v1')).toBeNull();
    expect(sessionStorage.getItem('mail-active-account')).toBeNull();
    expect(sessionStorage.getItem('bridgesllm.setup.session.v1')).toBeNull();
    expect(sessionStorage.getItem('cached_userAvatar')).toBeNull();
    expect(sessionStorage.getItem('cached_assistantAvatar')).toBeNull();
    expect(sessionStorage.getItem('portal-module-reload:FilesPage')).toBe('1');
    expect(sessionStorage.getItem('cached_publicSettings')).toBe('{"portalName":"Portal"}');
    expect(sessionStorage.getItem('bridgesllm.agentTools.indeterminateInstall.v1'))
      .toBe('{"toolId":"tool-1"}');
  });

  it('continues the transient scrub when persistent storage access throws', () => {
    const blockedStorage = {
      get length(): number {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
      key: () => null,
      removeItem: () => undefined,
    };
    const transientStorage = {
      length: 2,
      key: (index: number) => (
        ['portal:terminal-state:v1', 'portal-module-reload:FilesPage'][index] || null
      ),
      removeItem: vi.fn(),
    };

    expect(() => clearWorkspaceClientState(blockedStorage, transientStorage)).not.toThrow();
    expect(transientStorage.removeItem).toHaveBeenCalledTimes(1);
    expect(transientStorage.removeItem).toHaveBeenCalledWith('portal:terminal-state:v1');
  });
});
