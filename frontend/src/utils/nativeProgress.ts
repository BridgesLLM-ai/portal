import { canonicalToolName } from './toolPresentation';
import { displayBlock, displayText } from '../components/chat/toolCards/safeDisplay';
import type { ChatMessage } from '../contexts/ChatStateProvider';

export interface NativeProgress {
  note: string;
  measure: { label: string; value: number; max: number } | null;
}

/** Extract the one native progress element as data. Never inject tool HTML. */
export function parseNativeProgress(markdown: unknown): NativeProgress {
  const source = typeof markdown === 'string' ? markdown.slice(0, 8192) : '';
  let measure: NativeProgress['measure'] = null;
  const note = source.replace(/<progress\b([^>]{0,2048})>\s*<\/progress\s*>/gi, (_tag, attributes: string) => {
    const attrs: Record<string, string> = {};
    for (const match of attributes.matchAll(/(?:^|\s)(aria-label|value|max)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    }
    const value = Number(attrs.value); const max = Number(attrs.max);
    const label = displayText(attrs['aria-label'] || '', 180);
    if (!measure && label && attrs.value?.trim() && attrs.max?.trim()
      && Number.isFinite(value) && Number.isFinite(max) && value >= 0 && max > 0 && value <= max) {
      measure = { label, value, max };
    }
    return '';
  });
  return { note: displayBlock(note.trim(), 8192, 100).text, measure };
}

/** progress_card replaces the whole native surface; failures/partial calls do not. */
export function latestNativeProgress(messages: ChatMessage[]): NativeProgress | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const tools = messages[m].toolCalls || [];
    for (let t = tools.length - 1; t >= 0; t--) {
      const call = tools[t];
      if (call.status !== 'done' || canonicalToolName(call.name) !== 'progress_card') continue;
      let args: unknown = call.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      return parseNativeProgress((args as Record<string, unknown>).markdown);
    }
  }
  return null;
}
