import { marked } from 'marked';
import type { ChatMessage, ToolCall } from '../../../contexts/ChatStateProvider';
import { parseWidgetReference } from './widgetModel';

export type WidgetPlacement = { ref: string; height?: number };
export type WidgetPresentation = { refs: ReadonlySet<string>; heights: ReadonlyMap<string, number> };
export const EMPTY_WIDGET_PRESENTATION: WidgetPresentation = { refs: new Set(), heights: new Map() };

function directive(raw: string): WidgetPlacement | null {
  const match = /^\[embed\s+([^\r\n]*?)\s*\/?\]$/.exec(raw.trim());
  if (!match || raw.length > 1024) return null;
  const attrs = new Map<string, string>();
  let rest = match[1].trim();
  while (rest) {
    const attr = /^(ref|title|height)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')(?:\s+|$)/.exec(rest);
    if (!attr || attrs.has(attr[1])) return null;
    attrs.set(attr[1], attr[2] ?? attr[3]); rest = rest.slice(attr[0].length);
  }
  const ref = attrs.get('ref');
  if (!ref || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,256}$/.test(ref)) return null;
  const height = attrs.get('height');
  if (height !== undefined && (!/^\d{1,4}$/.test(height) || Number(height) < 1)) return null;
  if ((attrs.get('title')?.length ?? 0) > 160) return null;
  return { ref, ...(height === undefined ? {} : { height: Math.max(120, Math.min(720, Number(height))) }) };
}

/** Only complete standalone native directives in ordinary prose. Markdown code,
 * links, blockquotes, HTML, indented examples and malformed/unknown markup survive.
 * No directive confers authority, performs a fetch, or becomes HTML. */
export function rewriteWidgetDirectives(text: string, consume: (placement: WidgetPlacement) => boolean): string {
  if (!text.includes('[embed ') || text.length > 1_000_000) return text;
  // marked normalizes CRLF and bare CR before producing token offsets. Map
  // removals back to the original bytes so adjacent prose stays untouched.
  const markdownText = text.replace(/\r\n?/g, '\n');
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  for (const block of marked.lexer(markdownText)) {
    if (block.type === 'paragraph' && 'tokens' in block) {
      let inlineOffset = 0;
      for (const token of block.tokens || []) {
        if (token.type === 'text') {
          const pattern = /(^|\n)( {0,3}\[embed [^\r\n]*\][ \t]*)(?=\r?$|\r?\n)/g;
          for (const match of token.raw.matchAll(pattern)) {
            const start = offset + inlineOffset + match.index! + match[1].length;
            // Token boundaries can occur inside a Markdown construct: require a
            // real source-line boundary, not merely the start of this text token.
            if (start > 0 && markdownText[start - 1] !== '\n') continue;
            const placement = directive(match[2]);
            if (placement && consume(placement)) ranges.push([start, start + match[2].length]);
          }
        }
        inlineOffset += token.raw.length;
      }
    }
    offset += block.raw.length;
  }
  let sourceOffset = 0, normalizedOffset = 0;
  const originalOffset = (offset: number) => {
    while (normalizedOffset < offset) {
      if (text[sourceOffset] === '\r' && text[sourceOffset + 1] === '\n') sourceOffset++;
      sourceOffset++; normalizedOffset++;
    }
    return sourceOffset;
  };
  const originalRanges = ranges.map(([start, end]) => [originalOffset(start), originalOffset(end)]);
  let result = text;
  for (const [start, end] of originalRanges.reverse()) result = result.slice(0, start) + result.slice(end);
  return result;
}

/** Receipts arrive through server projection. Raw assistant/user text never adds a
 * reference; conflicting receipts remain visible and fail closed in the API. */
export function widgetPresentationFor(messages: readonly Pick<ChatMessage, 'role' | 'content' | 'toolCalls' | 'segments'>[],
  liveSegments: readonly { text: string; kind?: string }[] = []): WidgetPresentation {
  const tools = new Map<string, ToolCall>();
  const conflicts = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const tool of message.toolCalls || []) {
      const ref = parseWidgetReference(tool.name, tool.id, tool.result);
      if (tool.status !== 'done' || ref?.mode !== 'inline' || !ref.presentationRef) continue;
      if (tools.has(ref.presentationRef) && tools.get(ref.presentationRef)!.id !== tool.id) conflicts.add(ref.presentationRef);
      else tools.set(ref.presentationRef, tool);
    }
  }
  for (const ref of conflicts) tools.delete(ref);
  const heights = new Map<string, number>();
  const inspect = (text: string) => rewriteWidgetDirectives(text, placement => {
    const tool = tools.get(placement.ref);
    if (tool && placement.height !== undefined && !heights.has(tool.id)) heights.set(tool.id, placement.height);
    return false;
  });
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const segment of message.segments || []) if (segment.kind !== 'thinking') inspect(segment.text);
    inspect(message.content);
  }
  for (const segment of liveSegments) if (segment.kind !== 'thinking') inspect(segment.text);
  return { refs: new Set(tools.keys()), heights };
}
