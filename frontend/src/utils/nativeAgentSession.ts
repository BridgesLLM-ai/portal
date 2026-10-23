/**
 * Portal-owned Agent Chat session ids for native harnesses.
 *
 * The backend mints them as `<provider-lowercase>-<userId>-<ms>-<uuid>`. The
 * prefix only tells the browser which harness store an id belongs to, so the
 * right Portal route can be asked; ownership is always decided server-side.
 * Portal aliases (`main`, `new-…`) are never native session ids.
 */

const NATIVE_AGENT_CHAT_PROVIDERS: readonly string[] = [
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
  'HERMES',
  'OPENCODE',
];

const MAX_NATIVE_SESSION_ID_LENGTH = 512;

function providerKey(provider: unknown): string {
  return String(provider || '').trim().toUpperCase();
}

/** True for every Agent Chat harness the Portal runs itself (everything but OpenClaw). */
export function isNativeAgentChatProvider(provider: unknown): boolean {
  return NATIVE_AGENT_CHAT_PROVIDERS.includes(providerKey(provider));
}

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

/** The exact native session id when `session` is one for `provider`, else null. */
export function nativeAgentChatSessionId(provider: unknown, session: unknown): string | null {
  const name = providerKey(provider);
  if (!NATIVE_AGENT_CHAT_PROVIDERS.includes(name) || typeof session !== 'string') return null;
  const prefix = `${name.toLowerCase()}-`;
  if (session.length <= prefix.length || session.length > MAX_NATIVE_SESSION_ID_LENGTH) return null;
  if (!session.startsWith(prefix) || hasControlOrSpace(session)) return null;
  return session;
}

/** A native session id for any native harness (provider taken from its prefix). */
export function isAnyNativeAgentChatSessionId(session: unknown): session is string {
  return typeof session === 'string'
    && NATIVE_AGENT_CHAT_PROVIDERS.some((provider) => nativeAgentChatSessionId(provider, session) !== null);
}
