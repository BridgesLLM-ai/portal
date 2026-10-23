import { getSessionInfo, listGatewayModels } from '../../utils/openclawGatewayRpc';
import { readOpenClawConfig } from '../openclawConfigManager';

export class ChatImageError extends Error {
  constructor(readonly code: string, readonly statusCode = 422) {
    super(`Photo input unavailable (${code}). Choose a model with verified image input or remove the photo.`);
    this.name = 'ChatImageError';
  }
}
/**
 * A native harness provider that proves, from its own advertised metadata
 * (Claude Code's declared catalog, Codex model metadata, ACP
 * promptCapabilities), that a session's effective model accepts images.
 */
export interface NativeChatImageModelGate {
  assertChatImageModel(sessionId: string): Promise<string>;
}
export function hasNativeChatImageModelGate(provider: unknown): provider is NativeChatImageModelGate {
  return Boolean(provider) && typeof (provider as { assertChatImageModel?: unknown }).assertChatImageModel === 'function';
}
export function assertImageInputModality(input: unknown): void {
  // Runtime-advertised input modalities only: never infer vision from a model name.
  if (!Array.isArray(input) || !input.includes('image')) throw new ChatImageError('IMAGE_MODEL_UNSUPPORTED');
}
const modelRef = (id: unknown, provider?: unknown): string => typeof id === 'string' && id.trim()
  ? (id.includes('/') ? id.trim() : typeof provider === 'string' && provider ? `${provider}/${id.trim()}` : id.trim()) : '';

/** Fresh runtime catalog and effective session selection, including configured fallback candidates. */
export async function assertOpenClawImageInput(sessionKey: string, dependencies = {
  session: getSessionInfo, catalog: listGatewayModels, config: readOpenClawConfig,
}): Promise<string> {
  const [described, catalog] = await Promise.all([dependencies.session(sessionKey), dependencies.catalog()]);
  const root = dependencies.config();
  const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1];
  if (!agentId || /^(?:p4oc-|portal-)/.test(agentId)) throw new ChatImageError('IMAGE_SESSION_UNSUPPORTED');
  const agent = root?.agents?.list?.find((entry: any) => entry.id === agentId) || root?.agents?.entries?.[agentId];
  const configured = agent?.model || root?.agents?.defaults?.model;
  const configuredPrimary = typeof configured === 'string' ? configured : configured?.primary;
  if (!described.ok && described.error !== 'Session not found') throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
  const session = described.data;
  const selected = modelRef(session?.model || session?.currentModel?.model || configuredPrimary,
    session?.modelProvider || session?.currentModel?.provider);
  if (!selected || !catalog.ok || !Array.isArray(catalog.models)) throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
  const fallbacks = typeof configured === 'object' ? configured?.fallbacks : [];
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
  for (const candidate of [selected, ...(fallbacks || [])]) {
    const key = modelRef(candidate);
    const entry = catalog.models.find((item: any) => modelRef(item.key || item.id || item.model, item.provider) === key);
    if (!entry || entry.available === false || entry.missing === true) throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
    assertImageInputModality(entry.input);
  }
  return selected;
}
