export type AgentChatSessionModelPatch = (
  session: string,
  model: string,
  provider: string,
) => Promise<unknown>;

export type AgentChatSessionCreate = (
  session: string,
  provider: string,
) => Promise<unknown>;

export type AgentChatModelSwitchResult = {
  deferred: boolean;
  patchResponse?: unknown;
};

export function isAgentChatLaunchBoundModelError(error: unknown): boolean {
  const candidate = error as any;
  const code = String(
    candidate?.response?.data?.code
    || candidate?.code
    || '',
  ).trim().toUpperCase();
  return code === 'MODEL_REQUIRES_NEW_SESSION';
}

export function hasConcreteAgentChatSession(provider: unknown, session: unknown): boolean {
  const normalizedProvider = String(provider || '').trim().toUpperCase();
  const normalizedSession = String(session || '').trim();
  if (normalizedProvider === 'OPENCLAW') return normalizedSession.startsWith('agent:');
  return Boolean(
    normalizedSession
    && normalizedSession !== 'main'
    && !normalizedSession.startsWith('new-'),
  );
}

/**
 * Apply a model choice to an existing provider session. An empty model is a
 * real reset-to-provider-default request, not a frontend-only state change.
 * New/non-concrete sessions keep the choice locally and defer server work.
 */
export async function applyAgentChatSessionModel(options: {
  provider: unknown;
  session: unknown;
  model: unknown;
  patchSessionModel: AgentChatSessionModelPatch;
  createSession?: AgentChatSessionCreate;
}): Promise<AgentChatModelSwitchResult> {
  const provider = String(options.provider || '').trim().toUpperCase();
  const session = String(options.session || '').trim();
  const model = typeof options.model === 'string' ? options.model.trim() : '';

  if (!hasConcreteAgentChatSession(provider, session)) return { deferred: true };

  try {
    return {
      deferred: false,
      patchResponse: await options.patchSessionModel(session, model, provider),
    };
  } catch (error: any) {
    const status = error?.response?.status;
    const isSyntheticOpenClawSession = provider === 'OPENCLAW' && session.includes(':new-');
    if ((status === 404 || status === 409) && isSyntheticOpenClawSession && options.createSession) {
      await options.createSession(session, provider);
      return {
        deferred: false,
        patchResponse: await options.patchSessionModel(session, model, provider),
      };
    }
    throw error;
  }
}
