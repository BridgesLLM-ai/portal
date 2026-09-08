const PORTAL_STREAM_BUS_PROVIDERS = new Set([
  'OPENCLAW',
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
  'HERMES',
  'OPENCODE',
]);

export function providerUsesPortalStreamBus(provider: unknown): boolean {
  return PORTAL_STREAM_BUS_PROVIDERS.has(String(provider || '').trim().toUpperCase());
}
