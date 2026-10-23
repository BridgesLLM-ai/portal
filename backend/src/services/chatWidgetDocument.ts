import { findOwnedWidgetBinding, MAX_WIDGET_HTML_BYTES } from './chatWidgetProjection';
export interface WidgetReadDependencies {
  authorize(): Promise<void>;
  history(offset: number): Promise<{ ok: boolean; data?: any }>;
  view(docId: string): Promise<{ ok: boolean; data?: any }>;
}
export class WidgetReadError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** Rebuild binding from native history on every read; no client document IDs or durable capability cache. */
export async function readOwnedWidgetDocument(toolCallId: string, deps: WidgetReadDependencies) {
  await deps.authorize();
  const messages: any[] = [];
  let workBytes = 0;
  let sessionId: string | undefined;
  const offsets: number[] = [];
  for (let page = 0, offset = 0; page < 8; page++) {
    offsets.push(offset);
    const result = await deps.history(offset);
    if (!result.ok || !Array.isArray(result.data?.messages)) throw new WidgetReadError(502, 'WIDGET_HISTORY_UNAVAILABLE');
    workBytes += Buffer.byteLength(JSON.stringify(result.data.messages));
    if (workBytes > 16 * 1024 * 1024) throw new WidgetReadError(413, 'WIDGET_HISTORY_LIMIT');
    if (page === 0) sessionId = result.data.sessionId;
    if (!sessionId || result.data.sessionId !== sessionId) throw new WidgetReadError(409, 'WIDGET_SESSION_CHANGED');
    messages.push(...result.data.messages);
    const binding = findOwnedWidgetBinding(messages, toolCallId);
    if (binding) {
      if (binding.ref.mode !== 'inline' || !binding.docId) throw new WidgetReadError(409, 'WIDGET_NOT_INLINE');
      const document = await deps.view(binding.docId);
      await deps.authorize();
      // Re-check exact generation/binding after the document read (including reset/deletion).
      const freshMessages: any[] = [];
      for (const readOffset of offsets) {
        const fresh = await deps.history(readOffset);
        if (!fresh.ok || fresh.data?.sessionId !== sessionId || !Array.isArray(fresh.data?.messages))
          throw new WidgetReadError(409, 'WIDGET_SESSION_CHANGED');
        workBytes += Buffer.byteLength(JSON.stringify(fresh.data.messages));
        if (workBytes > 32 * 1024 * 1024) throw new WidgetReadError(413, 'WIDGET_HISTORY_LIMIT');
        freshMessages.push(...fresh.data.messages);
      }
      const latestBinding = findOwnedWidgetBinding(freshMessages, toolCallId);
      if (!latestBinding || latestBinding.docId !== binding.docId) throw new WidgetReadError(409, 'WIDGET_SESSION_CHANGED');
      await deps.authorize();
      if (!document.ok || typeof document.data?.html !== 'string') throw new WidgetReadError(410, 'WIDGET_EXPIRED');
      if (Buffer.byteLength(document.data.html) > MAX_WIDGET_HTML_BYTES) throw new WidgetReadError(413, 'WIDGET_DOCUMENT_LIMIT');
      return { v: 1, reference: binding.ref, html: document.data.html };
    }
    if (!result.data.hasMore) break;
    if (!Number.isSafeInteger(result.data.nextOffset) || result.data.nextOffset <= offset)
      throw new WidgetReadError(502, 'WIDGET_HISTORY_UNAVAILABLE');
    offset = result.data.nextOffset;
  }
  throw new WidgetReadError(404, 'WIDGET_NOT_FOUND');
}
