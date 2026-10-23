import type { AgentProviderName } from '../AgentProvider.interface';
import { loadNativeSessionMetadata } from '../providers/NativeSessionStore';

const NATIVE_PROVIDERS: readonly AgentProviderName[] = [
  'CLAUDE_CODE', 'CODEX', 'GROK', 'AGENT_ZERO', 'GEMINI', 'OLLAMA', 'HERMES', 'OPENCODE',
];

/**
 * Resolve a Portal native session id to its harness when, and only when, it
 * exists and belongs to `actorUserId`. Native ids are minted as
 * `<provider-lowercase>-<userId>-<ms>-<uuid>`; the prefix only selects which
 * store to read, the stored owner decides.
 */
export function resolveOwnedNativeSession(
  sessionId: unknown,
  actorUserId: string,
): { provider: AgentProviderName; sessionId: string } | null {
  if (typeof sessionId !== 'string' || !actorUserId || sessionId.length > 512) return null;
  const provider = NATIVE_PROVIDERS.find((name) => sessionId.startsWith(`${name.toLowerCase()}-`));
  if (!provider) return null;
  let session: ReturnType<typeof loadNativeSessionMetadata> = null;
  try {
    session = loadNativeSessionMetadata(provider, sessionId);
  } catch {
    return null;
  }
  if (!session || session.userId !== actorUserId || session.sessionId !== sessionId) return null;
  if (session.executionContext && session.executionContext.scope !== 'HOST_OPERATOR') return null;
  return { provider, sessionId };
}
