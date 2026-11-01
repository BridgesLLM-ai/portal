import { getOpenClawCapabilities } from './openClawCompatibility';

/** stable2026.9.9 show_widget projection. Never infer handles from arbitrary tool text. */
export const WIDGET_REFERENCE_SCHEMA = 'bridgesllm.widget-ref.v1';
/** Native session-board name of a pinned widget, as OpenClaw resolves it. */
export const BOARD_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_WIDGET_HTML_BYTES = 10 * 1024 * 1024;
const validId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(value);
export interface ChatWidgetReference {
  schema: typeof WIDGET_REFERENCE_SCHEMA;
  toolCallId: string;
  title: string;
  mode: 'inline' | 'dashboard' | 'unsupported';
  /** Display-only correlation with native assistant markup; never a document access key. */
  presentationRef?: string;
  /**
   * Board name of a pinned widget: the identity its newer versions keep. Set
   * only while the Gateway offers live widgets; never a document access key.
   */
  boardName?: string;
}
function liveBoardName(value: unknown): { boardName: string } | Record<string, never> {
  return typeof value === 'string' && BOARD_NAME_PATTERN.test(value) && getOpenClawCapabilities().liveWidgets
    ? { boardName: value } : {};
}
function resultObject(raw: any): any {
  if (!raw || raw.isError === true) return null;
  if (raw.details && typeof raw.details === 'object') return raw.details;
  if (raw.kind || raw.status) return raw;
  const content = Array.isArray(raw.content) ? raw.content : typeof raw === 'string' ? [{ type: 'text', text: raw }] : [];
  if (content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string'
    || Buffer.byteLength(content[0].text) > 16384) return null;
  try { return JSON.parse(content[0].text); } catch { return null; }
}
export function nativeWidgetBinding(toolName: unknown, toolCallId: unknown, raw: unknown) {
  if (toolName !== 'show_widget' || typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 256) return null;
  const value = resultObject(raw);
  if (!value || typeof value !== 'object') return null;
  const title = typeof value.presentation?.title === 'string' ? value.presentation.title.slice(0, 160) : 'Widget';
  const ref: ChatWidgetReference = { schema: WIDGET_REFERENCE_SCHEMA, toolCallId, title, mode: 'unsupported' };
  if (value.kind === 'canvas' && value.presentation?.target === 'assistant_message'
    && value.presentation?.sandbox === 'scripts' && validId(value.view?.id)
    && value.view.url === `/__openclaw__/canvas/documents/${value.view.id}/index.html`) {
    return { ref: { ...ref, mode: 'inline' as const, presentationRef: value.view.id as string, ...liveBoardName(value.view.boardWidgetName) },
      docId: value.view.id as string };
  }
  if (['pinned', 'pending', 'rejected', 'partial'].includes(value.status) && typeof value.boardWidgetName === 'string')
    return { ref: { ...ref, mode: 'dashboard' as const, ...liveBoardName(value.boardWidgetName) } };
  return { ref };
}
export function projectWidgetToolResult(toolName: unknown, toolCallId: unknown, raw: unknown): string | undefined {
  const binding = nativeWidgetBinding(toolName, toolCallId, raw);
  return binding ? JSON.stringify(binding.ref) : undefined;
}
/** Expand only the native9.9 nested-tool envelope, never JSON pasted into a message.
 * Deferred tool_call/exec calls are stored as custom rows, not top-level results.
 * Bind both nested halves to their real parent and run before exposing either.
 */
export function expandNativeNestedToolHistory(messages: any[]): any[] {
  return messages.flatMap(message => {
    if (message?.role !== 'custom' || message.customType !== 'openclaw.nested-tool.v1') return [message];
    if (message.display !== true || message.excludeFromContext !== true || !Array.isArray(message.content)) return [];
    const calls = message.content.filter((block: any) => block?.type === 'toolCall');
    const results = message.content.filter((block: any) => block?.type === 'toolResult' && block.role === 'toolResult');
    if (calls.length !== 1 || results.length !== 1) return [];
    const call = calls[0], result = results[0];
    const runId = message.__openclaw?.runId;
    const parentId = call.parentToolCallId;
    if (typeof runId !== 'string' || !runId || message.runId !== runId
      || call.runId !== runId || result.runId !== runId
      || typeof call.id !== 'string' || !call.id || result.toolCallId !== call.id
      || typeof call.name !== 'string' || !call.name || result.toolName !== call.name
      || typeof parentId !== 'string' || !parentId || result.parentToolCallId !== parentId) return [];
    const parents = messages.filter(parent => parent?.role === 'assistant' && parent.__openclaw?.runId === runId
      && parent.__openclaw?.id === result.afterEntryId && Array.isArray(parent.content)
      && parent.content.filter((block: any) => block?.type === 'toolCall' && block.id === parentId).length === 1);
    if (parents.length !== 1) return [];
    const baseId = message.__openclaw?.id;
    return [{ ...message, role: 'assistant', id: `${baseId}:call`,
      content: [{ ...call, ...(call.name === 'show_widget' ? { arguments: { title: String(call.arguments?.title || 'Widget').slice(0, 160) } } : {}) }] },
      { ...message, ...result, role: 'toolResult', id: `${baseId}:result`, content: result.content }];
  });
}
/** Only native toolResult rows with an exact assistant toolCall pairing confer document access. */
export function findOwnedWidgetBinding(messages: any[], toolCallId: string) {
  messages = expandNativeNestedToolHistory(messages);
  const calls = messages.flatMap(message => message?.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter((block: any) => block.type === 'toolCall' && block.id === toolCallId && block.name === 'show_widget') : []);
  const results = messages.filter(message => message?.role === 'toolResult' && message.toolCallId === toolCallId
    && message.toolName === 'show_widget' && message.isError !== true);
  // Conflicting/reused IDs fail closed instead of choosing an arbitrary history row.
  if (calls.length !== 1 || results.length !== 1) return null;
  return nativeWidgetBinding('show_widget', toolCallId, results[0]);
}
