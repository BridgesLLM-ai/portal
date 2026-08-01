import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('./client', () => ({ default: clientMocks }));

import { projectsAPI } from './endpoints';

describe('Projects API route contract', () => {
  beforeEach(() => {
    Object.values(clientMocks).forEach((mock) => mock.mockReset());
    clientMocks.get.mockResolvedValue({ data: {} });
    clientMocks.post.mockResolvedValue({ data: {} });
    clientMocks.put.mockResolvedValue({ data: {} });
    clientMocks.patch.mockResolvedValue({ data: {} });
    clientMocks.delete.mockResolvedValue({ data: {} });
  });

  it('encodes project and share identifiers as individual path segments', async () => {
    await projectsAPI.readFile('Project name?#', 'src/main.ts');
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/Project%20name%3F%23/file',
      { params: { path: 'src/main.ts' } },
    );

    await projectsAPI.updateShare('Project name?#', 'link/id?#', { isActive: false });
    expect(clientMocks.patch).toHaveBeenLastCalledWith(
      '/projects/Project%20name%3F%23/share/link%2Fid%3F%23',
      { isActive: false },
    );
  });

  it('keeps upload destinations in query parameters instead of path text', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await projectsAPI.uploadFiles('alpha beta', [file], 'nested folder');
    expect(clientMocks.post.mock.calls[0][0]).toBe('/projects/alpha%20beta/upload?path=nested%20folder');
    expect(clientMocks.post.mock.calls[0][1]).toBeInstanceOf(FormData);
  });

  it('requires immutable identity proof on project inventory and validates the full tree schema', async () => {
    const identity = { id: '1fcd90ba-8d89-4dc9-b996-62f794779c76', generation: 4 };
    clientMocks.get
      .mockResolvedValueOnce({
        data: {
          projects: [{
            name: 'alpha',
            hasGit: true,
            currentBranch: 'main',
            deployedUrl: '',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
            identity,
            destructiveActions: { allowed: true, reason: null },
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          tree: [{ name: 'src', type: 'directory', path: 'src' }],
          currentPath: '',
          identity,
        },
      });

    await expect(projectsAPI.list()).resolves.toEqual({
      projects: [expect.objectContaining({
        name: 'alpha',
        identity,
        destructiveActions: { allowed: true, reason: null },
      })],
    });
    await expect(projectsAPI.getTree('alpha')).resolves.toEqual({
      tree: [{ name: 'src', type: 'directory', path: 'src' }],
      currentPath: '',
      identity,
    });
  });

  it.each([
    [{ tree: [], currentPath: '' }, 'missing identity'],
    [{ tree: [{ name: 'src', type: 'folder', path: 'src' }], currentPath: '', identity: { id: 'id', generation: 1 } }, 'invalid entry type'],
    [{ tree: 'not-an-array', currentPath: '', identity: { id: 'id', generation: 1 } }, 'invalid tree container'],
  ])('rejects a malformed project tree readback: %s (%s)', async (data, _label) => {
    clientMocks.get.mockResolvedValueOnce({ data });
    await expect(projectsAPI.getTree('alpha')).rejects.toThrow(/Project (tree|identity proof).*malformed/i);
  });

  it('binds rename admission and response verification to one attempt and immutable identity', async () => {
    const identity = { id: '1fcd90ba-8d89-4dc9-b996-62f794779c76', generation: 4 };
    const renamedIdentity = { ...identity, generation: identity.generation + 1 };
    clientMocks.patch.mockResolvedValueOnce({
      data: {
        name: 'beta',
        attemptId: 'rename_attempt_123456',
        status: 'committed',
        identity: renamedIdentity,
      },
    });

    await expect(projectsAPI.rename('alpha', 'beta', {
      attemptId: 'rename_attempt_123456',
      identity,
    })).resolves.toMatchObject({ name: 'beta', status: 'committed', identity: renamedIdentity });
    expect(clientMocks.patch).toHaveBeenCalledWith('/projects/alpha/rename', {
      newName: 'beta',
      attemptId: 'rename_attempt_123456',
      projectIdentityId: identity.id,
      projectGeneration: identity.generation,
    });

    clientMocks.patch.mockResolvedValueOnce({
      data: {
        name: 'beta',
        attemptId: 'different_attempt_123456',
        status: 'committed',
        identity: renamedIdentity,
      },
    });
    await expect(projectsAPI.rename('alpha', 'beta', {
      attemptId: 'rename_attempt_123456',
      identity,
    })).rejects.toThrow(/does not match the admitted attempt/i);
  });

  it('keeps Project Chat history paging in bounded query parameters', async () => {
    await projectsAPI.chatHistory('alpha beta', 'CODEX', {
      limit: 80,
      before: 'message-cursor',
    });

    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/history',
      {
        params: {
          provider: 'CODEX',
          limit: 80,
          before: 'message-cursor',
        },
      },
    );
  });

  it('binds destructive Project Chat history clearing to the current state version', async () => {
    await projectsAPI.chatClearHistory('alpha beta', 'CODEX', 17);
    expect(clientMocks.delete).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/history',
      { params: { provider: 'CODEX', stateVersion: 17 } },
    );
    await expect(projectsAPI.chatClearHistory('alpha beta', 'CODEX', -1)).rejects.toThrow(
      'current Project Chat state version',
    );
  });

  it.each([
    ['OPENCLAW', 'openclaw'],
    ['CODEX', 'codex'],
    ['CLAUDE_CODE', 'claude-code'],
    ['AGENT_ZERO', 'agent-zero'],
    ['GEMINI', 'antigravity'],
    ['OLLAMA', 'ollama'],
  ] as const)('maps %s qualification to its explicit provider route', async (provider, slug) => {
    await projectsAPI.qualifyProjectChatProvider('alpha beta', provider);

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      `/projects/alpha%20beta/chat/providers/${slug}/qualify`,
      {},
      expect.objectContaining({ _skipNetworkRetry: true }),
    );
  });

  it('starts legacy project adoption in place without uploading or minting a new project', async () => {
    await projectsAPI.migrateLegacyProjectInPlace('alpha beta');
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/migrate-legacy',
      {},
    );
  });

  it('binds an explicit Ollama qualification request to the selected local model', async () => {
    await projectsAPI.qualifyProjectChatProvider('alpha beta', 'OLLAMA', 'qwen3.5:0.8b');

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/ollama/qualify',
      { model: 'qwen3.5:0.8b' },
      expect.objectContaining({ _skipNetworkRetry: true }),
    );
  });

  it('binds Agent Zero qualification to one exact connected OAuth provider/model pair', async () => {
    await projectsAPI.qualifyProjectChatProvider(
      'alpha beta',
      'AGENT_ZERO',
      'codex_oauth/gpt-5.5',
    );

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/agent-zero/qualify',
      { model: 'codex_oauth/gpt-5.5' },
      expect.objectContaining({ _skipNetworkRetry: true }),
    );
  });

  it('loads Agent Zero model choices through the actor-scoped Project route', async () => {
    await projectsAPI.agentZeroProjectModels('alpha beta');

    // _silent: hosts without a connected Agent Zero account fail this probe
    // on every healthy Project Chat open; the menu renders that state inline
    // and the global error badge must not light for it.
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/agent-zero/models',
      expect.objectContaining({ _silent: true }),
    );
  });

  it('encodes renamed project names across the complete assistant lifecycle', async () => {
    const projectName = 'alpha #1';

    await projectsAPI.agentPoll(projectName, 6, 20, 'OPENCLAW', 'turn-1');
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/poll',
      expect.objectContaining({
        params: {
          after: 6,
          lastSize: 20,
          provider: 'OPENCLAW',
          turnId: 'turn-1',
        },
      }),
    );

    await projectsAPI.agentSend(projectName, {
      provider: 'OPENCLAW',
      stateVersion: 8,
      message: 'hello',
      messageId: 'project-chat-stable-message-id',
      model: 'openai/gpt-5.5',
    });
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/send',
      {
        provider: 'OPENCLAW',
        stateVersion: 8,
        message: 'hello',
        model: 'openai/gpt-5.5',
        messageId: 'project-chat-stable-message-id',
      },
    );

    await projectsAPI.agentMessageStatus(projectName, {
      provider: 'OPENCLAW',
      messageId: 'project-chat-stable-message-id',
      messageFingerprint: 'a'.repeat(64),
    });
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/message-status',
      {
        provider: 'OPENCLAW',
        messageId: 'project-chat-stable-message-id',
        messageFingerprint: 'a'.repeat(64),
      },
      expect.objectContaining({ _skipNetworkRetry: true, _silent: true }),
    );

    await projectsAPI.agentGetMemory(projectName);
    expect(clientMocks.get).toHaveBeenLastCalledWith('/projects/alpha%20%231/assistant/memory');

    await projectsAPI.agentResetSession(projectName, 'OPENCLAW', 9);
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/reset',
      { provider: 'OPENCLAW', stateVersion: 9 },
    );

    await projectsAPI.agentGetActiveModel(projectName);
    expect(clientMocks.get).toHaveBeenLastCalledWith('/projects/alpha%20%231/assistant/active-model');
  });

  it('requires coordination and preserves a caller-owned message ID across retries', async () => {
    const request = {
      provider: 'CODEX' as const,
      stateVersion: 12,
      message: 'retry me',
      messageId: 'stable-message-id',
      model: 'openai/gpt-5.5',
    };
    await projectsAPI.agentSend('alpha', request);
    await projectsAPI.agentSend('alpha', request);

    const requests = clientMocks.post.mock.calls.filter(([url]) => (
      url === '/projects/alpha/assistant/send'
    ));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.[1]).toEqual(request);
    expect(requests[1]?.[1]).toEqual(request);
    await expect(projectsAPI.agentSend('alpha', { ...request, stateVersion: -1 })).rejects.toThrow(
      'current Project Chat state version',
    );
    await expect(projectsAPI.agentSend('alpha', { ...request, messageId: '' })).rejects.toThrow(
      'stable Project Chat message ID',
    );
  });

  it('does not expose retired browser-owned Project Chat write helpers', () => {
    expect(projectsAPI).not.toHaveProperty('chatSaveMessage');
    expect(projectsAPI).not.toHaveProperty('chatSaveMessages');
    expect(projectsAPI).not.toHaveProperty('agentSaveMemory');
  });
});
