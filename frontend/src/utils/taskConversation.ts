/** Only OpenClaw-owned conversation keys are accepted; task ids are not sessions. */
export function openClawTaskConversation(value: unknown): { session: string; agentId: string } | null {
  if (typeof value !== 'string' || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  const match = /^agent:([a-z0-9][a-z0-9_-]{0,63}):(.+)$/.exec(value);
  return match ? { session: value, agentId: match[1] } : null;
}

export function taskConversationHref(value: unknown): string | null {
  const target = openClawTaskConversation(value);
  return target ? `/agent-chats?openclawSession=${encodeURIComponent(target.session)}` : null;
}
