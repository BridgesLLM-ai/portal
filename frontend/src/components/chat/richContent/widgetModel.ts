import { nativeAgentChatSessionId } from '../../../utils/nativeAgentSession';

export const WIDGET_CHANNEL = 'bridgesllm.widget.v1';
export const WIDGET_REFERENCE_SCHEMA = 'bridgesllm.widget-ref.v1';
export const MAX_WIDGET_HTML_BYTES = 10 * 1024 * 1024;
export interface WidgetReference {
  schema: typeof WIDGET_REFERENCE_SCHEMA;
  toolCallId: string;
  title: string;
  mode: 'inline' | 'dashboard' | 'unsupported';
  /** Correlation only. Document fetches still use the attested tool-call route. */
  presentationRef?: string;
  /** Board name of a live (pinned) widget: newer versions keep it. Present only while the Gateway offers live widgets. */
  boardName?: string;
}
export const BOARD_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function parseWidgetReference(name: string, toolCallId: string, result: unknown): WidgetReference | null {
  if (name !== 'show_widget' || typeof result !== 'string' || result.length > 2048) return null;
  try {
    const value = JSON.parse(result);
    if (!value || value.schema !== WIDGET_REFERENCE_SCHEMA || value.toolCallId !== toolCallId
      || typeof value.title !== 'string' || value.title.length > 160
      || !['inline', 'dashboard', 'unsupported'].includes(value.mode)
      || (value.presentationRef !== undefined && (value.mode !== 'inline'
        || typeof value.presentationRef !== 'string' || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,256}$/.test(value.presentationRef)))
      || (value.boardName !== undefined && (value.mode === 'unsupported' || typeof value.boardName !== 'string' || !BOARD_NAME.test(value.boardName)))
      || Object.keys(value).sort().join(',') !== ['mode', 'schema', 'title', 'toolCallId',
        ...(value.presentationRef === undefined ? [] : ['presentationRef']),
        ...(value.boardName === undefined ? [] : ['boardName'])].sort().join(',')) return null;
    return value;
  } catch { return null; }
}
export type WidgetMessage = { channel: typeof WIDGET_CHANNEL; instance: string; type: 'ready' | 'rendered' | 'size' | 'error'; height?: number };
export function acceptWidgetMessage(event: MessageEvent, source: Window | null, instance: string): WidgetMessage | null {
  if (!source || event.source !== source || event.origin !== 'null') return null;
  const value = event.data;
  if (!value || typeof value !== 'object' || value.channel !== WIDGET_CHANNEL || value.instance !== instance
    || !['ready', 'rendered', 'size', 'error'].includes(value.type)) return null;
  // Never stringify arbitrary message objects or adopt transferred ports.
  const keys = Object.keys(value);
  if (keys.length > 6 || keys.some(key => !['channel', 'instance', 'type', 'height', 'message'].includes(key))) return null;
  if (value.type === 'size') {
    if (typeof value.height !== 'number' || !Number.isFinite(value.height)) return null;
    return { channel: WIDGET_CHANNEL, instance, type: 'size', height: Math.max(120, Math.min(720, Math.ceil(value.height))) };
  }
  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 500)) return null;
  return { channel: WIDGET_CHANNEL, instance, type: value.type };
}
/**
 * Owner-checked document route for one widget tool call. OpenClaw widgets are
 * read from its session; every other harness's widgets come from the Portal
 * Chat Bridge store of the exact native session. Null when the conversation has
 * no saved native session yet, so nothing is fetched under an alias.
 */
export function widgetDocumentPath(session: string, toolCallId: string, provider = 'OPENCLAW'): string | null {
  const tool = encodeURIComponent(toolCallId);
  if (String(provider || '').trim().toUpperCase() === 'OPENCLAW') {
    return `/chat-widgets/sessions/${encodeURIComponent(session)}/tools/${tool}/document`;
  }
  const nativeSession = nativeAgentChatSessionId(provider, session);
  return nativeSession ? `/chat-widgets/native/sessions/${encodeURIComponent(nativeSession)}/tools/${tool}/document` : null;
}

/**
 * Owner-checked route for the newest version of a live widget (OpenClaw only):
 * the same owner check and attested read, looked up by board name.
 */
export function liveWidgetDocumentPath(session: string, boardName: string, provider = 'OPENCLAW'): string | null {
  if (String(provider || '').trim().toUpperCase() !== 'OPENCLAW' || !BOARD_NAME.test(boardName)) return null;
  return `/chat-widgets/sessions/${encodeURIComponent(session)}/boards/${encodeURIComponent(boardName)}/document`;
}
