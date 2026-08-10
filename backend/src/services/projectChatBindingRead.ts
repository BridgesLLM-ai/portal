import type { AgentProviderName, ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import { executionContextsMatch } from '../agents/executionScope';
import { loadNativeSession, type NativeSessionData } from '../agents/providers/NativeSessionStore';
import { prisma } from '../config/database';
import { parseAgentZeroProjectModelBinding } from './agentZeroProjectModel';
import { parseOllamaProjectModelBinding } from './ollamaProjectModel';
import { deriveOpenClawProjectSessionKey } from './openclawProjectSandbox';
import {
  getProjectChatProviderRuntimeDescriptor,
  isNativeProjectProvider,
  isQualifiableProjectProvider,
} from './projectChatProviderRegistry';

type BindingReadDatabase = Pick<typeof prisma, 'projectChatProviderBinding' | 'projectChatSession'>;

export class ProjectChatBindingReadError extends Error {
  readonly code = 'PROJECT_BINDING_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ProjectChatBindingReadError';
  }
}

function expectedRuntime(provider: AgentProviderName): string {
  if (isQualifiableProjectProvider(provider)) {
    return getProjectChatProviderRuntimeDescriptor(provider).runtime;
  }
  throw new ProjectChatBindingReadError('The selected provider has no readable Project binding contract.');
}

export async function readExistingProjectChatBinding(input: {
  actorUserId: string;
  provider: AgentProviderName;
  executionContext: ProjectSandboxExecutionContext;
  requireActive?: boolean;
  requireProviderSession?: boolean;
  /**
   * Read-only transcript/status callers may need to present recovery UI after
   * an installer or policy update changes the immutable sandbox context.  This
   * never authorizes use of the old provider session: stale session identities
   * are withheld and mutating/active-session reads still fail closed.
   */
  allowStaleContext?: boolean;
}, dependencies: {
  database?: BindingReadDatabase;
  loadSession?: typeof loadNativeSession;
} = {}) {
  const database = dependencies.database || prisma;
  const loadSession = dependencies.loadSession || loadNativeSession;
  const binding = await database.projectChatProviderBinding.findUnique({
    where: {
      userId_projectId_provider: {
        userId: input.actorUserId,
        projectId: input.executionContext.projectId,
        provider: input.provider,
      },
    },
  });
  const portalSession = await database.projectChatSession.findFirst({
    where: {
      userId: input.actorUserId,
      projectId: input.executionContext.projectId,
      activeProvider: input.provider,
    },
    orderBy: { lastActivity: 'desc' },
  });
  if (!binding) {
    return {
      binding: null,
      staleBinding: null,
      staleReason: null,
      portalSession,
      providerSessionKey: null,
      nativeSession: null as NativeSessionData | null,
    };
  }
  if (
    binding.userId !== input.actorUserId
    || binding.projectId !== input.executionContext.projectId
    || binding.provider !== input.provider
  ) {
    throw new ProjectChatBindingReadError('The Project provider binding no longer matches its immutable identity.');
  }
  if (
    binding.runtime !== expectedRuntime(input.provider)
    || binding.sandboxRoot !== input.executionContext.canonicalRoot
    || binding.policyFingerprint !== input.executionContext.policyFingerprint
  ) {
    if (
      input.allowStaleContext
      && !input.requireActive
      && !input.requireProviderSession
    ) {
      return {
        binding: null,
        staleBinding: binding,
        staleReason: 'CONTEXT_DRIFT' as const,
        portalSession,
        providerSessionKey: null,
        nativeSession: null as NativeSessionData | null,
      };
    }
    throw new ProjectChatBindingReadError('The Project provider binding no longer matches its immutable sandbox context.');
  }
  if (input.requireActive && binding.status !== 'active') {
    throw new ProjectChatBindingReadError('The Project provider binding is not active.');
  }

  const sessionCandidates = [binding.sessionKey, binding.externalSessionId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const providerSessionKey = sessionCandidates[0] || null;
  if (input.requireProviderSession && !providerSessionKey) {
    throw new ProjectChatBindingReadError('The Project provider binding has no existing session.');
  }

  let nativeSession: NativeSessionData | null = null;
  if (input.provider === 'OPENCLAW') {
    const expectedSession = deriveOpenClawProjectSessionKey(input.executionContext);
    if (providerSessionKey && !sessionCandidates.includes(expectedSession)) {
      throw new ProjectChatBindingReadError('The OpenClaw Project session does not match its immutable binding.');
    }
  } else if (isNativeProjectProvider(input.provider) && providerSessionKey) {
    nativeSession = loadSession(input.provider, providerSessionKey);
    if (
      !nativeSession
      || nativeSession.provider !== input.provider
      || nativeSession.sessionId !== providerSessionKey
      || nativeSession.userId !== input.actorUserId
      || !nativeSession.executionContext
      || !executionContextsMatch(nativeSession.executionContext, input.executionContext)
    ) {
      if (input.requireProviderSession) {
        throw new ProjectChatBindingReadError(
          `The ${getProjectChatProviderRuntimeDescriptor(input.provider).displayName} Project session no longer matches its immutable binding.`,
        );
      }
      nativeSession = null;
    }
    if (input.provider === 'AGENT_ZERO' && nativeSession) {
      let selection;
      try {
        selection = parseAgentZeroProjectModelBinding(binding.model);
      } catch {
        throw new ProjectChatBindingReadError(
          'The Agent Zero Project binding has no verified OAuth provider/model identity.',
        );
      }
      if (
        nativeSession.metadata?.agentZeroOAuthProviderId !== selection.providerId
        || nativeSession.metadata?.agentZeroModel !== selection.model
        || nativeSession.model !== selection.model
      ) {
        throw new ProjectChatBindingReadError(
          'The Agent Zero Project session model no longer matches its exact OAuth binding.',
        );
      }
    } else if (input.provider === 'OLLAMA' && nativeSession) {
      let selection;
      try {
        selection = parseOllamaProjectModelBinding(binding.model);
      } catch {
        throw new ProjectChatBindingReadError(
          'The Ollama Project binding has no verified installed model digest.',
        );
      }
      const metadataHasBackendIdentity = (
        nativeSession.metadata?.ollamaBackendKind !== undefined
        || nativeSession.metadata?.ollamaBackendFingerprint !== undefined
        || nativeSession.metadata?.ollamaBackendGeneration !== undefined
      );
      const sessionBackendKind = metadataHasBackendIdentity
        ? nativeSession.metadata?.ollamaBackendKind
        : 'LOCAL';
      const sessionBackendFingerprint = metadataHasBackendIdentity
        ? nativeSession.metadata?.ollamaBackendFingerprint
        : 'local-ollama-v1:127.0.0.1:11434';
      const sessionBackendGeneration = metadataHasBackendIdentity
        ? nativeSession.metadata?.ollamaBackendGeneration
        : null;
      if (
        nativeSession.metadata?.projectRuntime !== getProjectChatProviderRuntimeDescriptor('OLLAMA').runtime
        || nativeSession.metadata?.ollamaModelDigest !== selection.digest
        || nativeSession.metadata?.ollamaRuntimeQuarantined === true
        || nativeSession.model !== selection.model
        || sessionBackendKind !== selection.backendKind
        || sessionBackendFingerprint !== selection.backendFingerprint
        || sessionBackendGeneration !== selection.backendGeneration
      ) {
        throw new ProjectChatBindingReadError(
          'The Ollama Project session backend or model no longer matches its exact installed-model binding.',
        );
      }
    }
  }

  return {
    binding,
    staleBinding: null,
    staleReason: null,
    portalSession,
    providerSessionKey,
    nativeSession,
  };
}
