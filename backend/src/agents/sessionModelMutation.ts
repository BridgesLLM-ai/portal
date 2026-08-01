import {
  AgentRegistry,
} from './AgentRegistry';
import type {
  AgentProvider,
  AgentProviderName,
  AgentSessionModelResult,
} from './AgentProvider.interface';
import { getProviderCapabilities } from './providerAvailability';
import { updateNativeSessionModel } from './providers/NativeSessionStore';

export type NativeSessionModelMutationCode =
  | 'MODEL_SELECTION_UNSUPPORTED'
  | 'MODEL_REQUIRES_NEW_SESSION'
  | 'SESSION_NOT_FOUND';

export class NativeSessionModelMutationError extends Error {
  readonly code: NativeSessionModelMutationCode;
  readonly status: number;

  constructor(code: NativeSessionModelMutationCode, message: string, status = 409) {
    super(message);
    this.name = 'NativeSessionModelMutationError';
    this.code = code;
    this.status = status;
  }
}

export interface NativeSessionModelMutationDependencies {
  getProviderCapabilities: typeof getProviderCapabilities;
  getProvider: (providerName: AgentProviderName) => AgentProvider;
  updateNativeSessionModel: typeof updateNativeSessionModel;
}

const DEFAULT_DEPENDENCIES: NativeSessionModelMutationDependencies = {
  getProviderCapabilities,
  getProvider: (providerName) => AgentRegistry.get(providerName),
  updateNativeSessionModel,
};

/**
 * Mutates a live native session only when the adapter can make the runtime and
 * Portal's durable record agree. Launch-bound providers must start a new
 * session; recording a different local value would falsely claim the running
 * process changed models.
 */
export async function setNativeSessionModel(
  providerName: AgentProviderName,
  sessionId: string,
  model: string | null,
  dependencies: NativeSessionModelMutationDependencies = DEFAULT_DEPENDENCIES,
): Promise<AgentSessionModelResult> {
  const capabilities = dependencies.getProviderCapabilities(providerName);
  if (providerName === 'OPENCLAW'
    || !capabilities?.supportsModelSelection
    || capabilities.modelSelectionMode === 'none') {
    throw new NativeSessionModelMutationError(
      'MODEL_SELECTION_UNSUPPORTED',
      `${providerName} does not support session model selection.`,
    );
  }
  if (capabilities.modelSelectionMode === 'launch') {
    throw new NativeSessionModelMutationError(
      'MODEL_REQUIRES_NEW_SESSION',
      'This provider chooses its model when a session starts. Start a new chat to use the selected model.',
    );
  }

  const provider = dependencies.getProvider(providerName);
  if (provider.setSessionModel) {
    return provider.setSessionModel(sessionId, model);
  }

  const updated = dependencies.updateNativeSessionModel(providerName, sessionId, model);
  if (!updated) {
    throw new NativeSessionModelMutationError(
      'SESSION_NOT_FOUND',
      'The selected agent session no longer exists.',
      404,
    );
  }
  return {
    model: updated.model || null,
    metadata: updated.metadata || {},
  };
}
