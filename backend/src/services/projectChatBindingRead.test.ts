import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import { CODEX_PROJECT_RUNTIME } from '../agents/providers/native/projectSandbox/CodexProjectSandbox';
import { CLAUDE_CODE_PROJECT_RUNTIME } from '../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox';
import { ANTIGRAVITY_PROJECT_RUNTIME } from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';
import { AGENT_ZERO_PROJECT_RUNTIME } from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import { OLLAMA_PROJECT_RUNTIME } from '../agents/providers/ollama/OllamaProjectToolRuntime';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import { readExistingProjectChatBinding } from './projectChatBindingRead';

function context() {
  return createProjectSandboxExecutionContext({
    userId: 'actor-1',
    projectId: 'project-1',
    workspaceOwnerId: 'actor-1',
    projectName: 'alpha',
    canonicalRoot: '/srv/projects/actor-1/alpha',
    rootDevice: '1',
    rootInode: '2',
    rootBirthtimeNs: '3',
    runtimePolicyVersion: 'portal-project-sandbox-v2',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: `sha256:${'4'.repeat(64)}`,
    policyFingerprint: '5'.repeat(64),
  });
}

function codexBinding() {
  return {
    id: 'binding-1',
    userId: 'actor-1',
    projectId: 'project-1',
    provider: 'CODEX',
    runtime: CODEX_PROJECT_RUNTIME,
    sessionKey: 'codex-session-1',
    externalSessionId: 'codex-session-1',
    model: 'openai/gpt-5.5',
    status: 'active',
    sandboxRoot: '/srv/projects/actor-1/alpha',
    policyFingerprint: '5'.repeat(64),
    handoffCursor: 0,
    handoffVersion: 1,
    lastActivity: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function nativeBinding(provider: Extract<AgentProviderName, 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI'>) {
  return {
    ...codexBinding(),
    provider,
    runtime: provider === 'CLAUDE_CODE'
      ? CLAUDE_CODE_PROJECT_RUNTIME
      : provider === 'AGENT_ZERO' ? AGENT_ZERO_PROJECT_RUNTIME : ANTIGRAVITY_PROJECT_RUNTIME,
    sessionKey: `${provider.toLowerCase()}-portal-session`,
    externalSessionId: `${provider.toLowerCase()}-portal-session`,
    ...(provider === 'AGENT_ZERO' ? { model: 'codex_oauth/gpt-5.2-codex' } : {}),
  };
}

test('read-only lookup scopes every query to the exact actor/project/provider and performs no writes', async () => {
  const binding = codexBinding();
  const findBinding = jest.fn(async () => binding);
  const findSession = jest.fn(async () => null);
  const forbiddenWrite = jest.fn(() => { throw new Error('write attempted'); });
  const loadSession = jest.fn(() => ({
    sessionId: binding.sessionKey,
    provider: 'CODEX' as const,
    userId: 'actor-1',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cwd: '/srv/projects/actor-1/alpha',
    model: 'gpt-5.5',
    messages: [],
    executionContext: context(),
  }));
  const result = await readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: context(),
    requireActive: true,
    requireProviderSession: true,
  }, {
    database: {
      projectChatProviderBinding: {
        findUnique: findBinding,
        upsert: forbiddenWrite,
      },
      projectChatSession: {
        findFirst: findSession,
        update: forbiddenWrite,
      },
    } as any,
    loadSession,
  });

  expect(result.binding).toBe(binding);
  expect(result.providerSessionKey).toBe('codex-session-1');
  expect(findBinding).toHaveBeenCalledWith({
    where: {
      userId_projectId_provider: {
        userId: 'actor-1',
        projectId: 'project-1',
        provider: 'CODEX',
      },
    },
  });
  expect(findSession).toHaveBeenCalledWith(expect.objectContaining({
    where: { userId: 'actor-1', projectId: 'project-1', activeProvider: 'CODEX' },
  }));
  expect(forbiddenWrite).not.toHaveBeenCalled();
});

test('an absent binding returns an honest uninitialized result without creating a session', async () => {
  const forbiddenWrite = jest.fn(() => { throw new Error('write attempted'); });
  const result = await readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: context(),
  }, {
    database: {
      projectChatProviderBinding: { findUnique: jest.fn(async () => null), upsert: forbiddenWrite },
      projectChatSession: { findFirst: jest.fn(async () => null), create: forbiddenWrite },
    } as any,
  });

  expect(result).toMatchObject({ binding: null, providerSessionKey: null, nativeSession: null });
  expect(forbiddenWrite).not.toHaveBeenCalled();
});

test('read-only presentation can recover from sandbox context drift without exposing the stale session', async () => {
  const binding = codexBinding();
  const driftedContext = {
    ...context(),
    policyFingerprint: '6'.repeat(64),
  };
  const loadSession = jest.fn(() => {
    throw new Error('stale native session must not be loaded');
  });
  const result = await readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: driftedContext,
    allowStaleContext: true,
  }, {
    database: {
      projectChatProviderBinding: { findUnique: jest.fn(async () => binding) },
      projectChatSession: { findFirst: jest.fn(async () => null) },
    } as any,
    loadSession,
  });

  expect(result).toMatchObject({
    binding: null,
    staleBinding: binding,
    staleReason: 'CONTEXT_DRIFT',
    providerSessionKey: null,
    nativeSession: null,
  });
  expect(loadSession).not.toHaveBeenCalled();
});

test('sandbox context drift still fails closed for default and provider-session reads', async () => {
  const binding = codexBinding();
  const driftedContext = {
    ...context(),
    policyFingerprint: '6'.repeat(64),
  };
  const database = {
    projectChatProviderBinding: { findUnique: jest.fn(async () => binding) },
    projectChatSession: { findFirst: jest.fn(async () => null) },
  } as any;

  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: driftedContext,
  }, { database })).rejects.toThrow(/immutable sandbox context/i);

  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: driftedContext,
    allowStaleContext: true,
    requireProviderSession: true,
  }, { database })).rejects.toThrow(/immutable sandbox context/i);
});

test('identity drift is never downgraded to a recoverable read-only context mismatch', async () => {
  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: context(),
    allowStaleContext: true,
  }, {
    database: {
      projectChatProviderBinding: {
        findUnique: jest.fn(async () => ({ ...codexBinding(), userId: 'different-actor' })),
      },
      projectChatSession: { findFirst: jest.fn(async () => null) },
    } as any,
  })).rejects.toThrow(/immutable identity/i);
});

test('rejects a native session whose actor or immutable context does not match', async () => {
  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CODEX',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database: {
      projectChatProviderBinding: { findUnique: jest.fn(async () => codexBinding()) },
      projectChatSession: { findFirst: jest.fn(async () => null) },
    } as any,
    loadSession: jest.fn(() => ({
      sessionId: 'codex-session-1',
      provider: 'CODEX',
      userId: 'different-actor',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: '/srv/projects/actor-1/alpha',
      messages: [],
      executionContext: context(),
    })),
  })).rejects.toThrow(/Codex Project session no longer matches/i);
});

test.each<Extract<AgentProviderName, 'CLAUDE_CODE' | 'GEMINI'>>(['CLAUDE_CODE', 'GEMINI'])(
  'reads the exact %s native Project session and preserves its provider-native resume identity',
  async (provider) => {
    const binding = nativeBinding(provider);
    const loadSession = jest.fn(() => ({
      sessionId: binding.sessionKey,
      provider,
      userId: 'actor-1',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: '/srv/projects/actor-1/alpha',
      messages: [],
      executionContext: context(),
      metadata: { nativeSessionId: `${provider.toLowerCase()}-native-resume-id` },
    }));
    const result = await readExistingProjectChatBinding({
      actorUserId: 'actor-1',
      provider,
      executionContext: context(),
      requireActive: true,
      requireProviderSession: true,
    }, {
      database: {
        projectChatProviderBinding: { findUnique: jest.fn(async () => binding) },
        projectChatSession: { findFirst: jest.fn(async () => null) },
      } as any,
      loadSession,
    });

    expect(loadSession).toHaveBeenCalledWith(provider, binding.sessionKey);
    expect(result.nativeSession?.metadata?.nativeSessionId)
      .toBe(`${provider.toLowerCase()}-native-resume-id`);
  },
);

test('rejects a native session record whose provider identity was relabeled', async () => {
  const binding = nativeBinding('CLAUDE_CODE');
  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'CLAUDE_CODE',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database: {
      projectChatProviderBinding: { findUnique: jest.fn(async () => binding) },
      projectChatSession: { findFirst: jest.fn(async () => null) },
    } as any,
    loadSession: jest.fn(() => ({
      sessionId: binding.sessionKey,
      provider: 'GEMINI',
      userId: 'actor-1',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: '/srv/projects/actor-1/alpha',
      messages: [],
      executionContext: context(),
    })),
  })).rejects.toThrow(/Claude Code Project session no longer matches/i);
});

test('reads Agent Zero only when its native session preserves the exact OAuth provider/model pair', async () => {
  const binding = nativeBinding('AGENT_ZERO');
  const exactSession = {
    sessionId: binding.sessionKey,
    provider: 'AGENT_ZERO' as const,
    userId: 'actor-1',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cwd: '/srv/projects/actor-1/alpha',
    model: 'gpt-5.2-codex',
    messages: [],
    executionContext: context(),
    metadata: {
      projectRuntime: AGENT_ZERO_PROJECT_RUNTIME,
      agentZeroOAuthProviderId: 'codex_oauth',
      agentZeroModel: 'gpt-5.2-codex',
    },
  };
  const database = {
    projectChatProviderBinding: { findUnique: jest.fn(async () => binding) },
    projectChatSession: { findFirst: jest.fn(async () => null) },
  } as any;
  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'AGENT_ZERO',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database,
    loadSession: jest.fn(() => exactSession),
  })).resolves.toMatchObject({
    providerSessionKey: binding.sessionKey,
    nativeSession: { metadata: { agentZeroOAuthProviderId: 'codex_oauth' } },
  });

  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'AGENT_ZERO',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database,
    loadSession: jest.fn(() => ({
      ...exactSession,
      metadata: { ...exactSession.metadata, agentZeroModel: 'gpt-5.2-codex-mini' },
    })),
  })).rejects.toThrow(/model no longer matches/i);
});

test('reads Ollama only when its native session preserves the exact installed model digest', async () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const binding = {
    ...codexBinding(),
    provider: 'OLLAMA',
    runtime: OLLAMA_PROJECT_RUNTIME,
    sessionKey: 'ollama-project-session',
    externalSessionId: 'ollama-project-session',
    model: `qwen3.5:0.8b@${digest}`,
  };
  const exactSession = {
    sessionId: binding.sessionKey,
    provider: 'OLLAMA' as const,
    userId: 'actor-1',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cwd: '/srv/projects/actor-1/alpha',
    model: 'qwen3.5:0.8b',
    messages: [],
    executionContext: context(),
    metadata: {
      projectRuntime: OLLAMA_PROJECT_RUNTIME,
      ollamaModelDigest: digest,
      ollamaToolQualified: true,
    },
  };
  const database = {
    projectChatProviderBinding: { findUnique: jest.fn(async () => binding) },
    projectChatSession: { findFirst: jest.fn(async () => null) },
  } as any;
  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'OLLAMA',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database,
    loadSession: jest.fn(() => exactSession),
  })).resolves.toMatchObject({
    providerSessionKey: binding.sessionKey,
    nativeSession: { metadata: { ollamaModelDigest: digest } },
  });

  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'OLLAMA',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database,
    loadSession: jest.fn(() => ({
      ...exactSession,
      metadata: { ...exactSession.metadata, ollamaModelDigest: `sha256:${'e'.repeat(64)}` },
    })),
  })).rejects.toThrow(/installed-model binding/i);

  await expect(readExistingProjectChatBinding({
    actorUserId: 'actor-1',
    provider: 'OLLAMA',
    executionContext: context(),
    requireProviderSession: true,
  }, {
    database,
    loadSession: jest.fn(() => ({
      ...exactSession,
      metadata: { ...exactSession.metadata, ollamaRuntimeQuarantined: true },
    })),
  })).rejects.toThrow(/installed-model binding/i);
});
