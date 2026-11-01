import type { ChatMessage, ToolCall } from '../../../contexts/ChatStateProvider';
import type { WorkspacePreviewInput } from '../../../stores/agentWorkspaceStore';
import { canonicalToolName } from '../../../utils/toolPresentation';
import { parseWidgetReference } from '../richContent/widgetModel';

export interface ChatArtifact { key: string; messageId: string; kind: WorkspacePreviewInput['kind']; title: string; detail: string; preview: WorkspacePreviewInput }
export interface ChatWidgetEntry {
  key: string;
  /** The newest version with a transcript document, else the newest version. */
  toolCallId: string;
  title: string;
  mode: 'inline' | 'dashboard';
  /** Live widget: every version with this board name collapses into this row. */
  boardName?: string;
  versions: number;
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const LINK = /\[([^\]\n]{1,200})\]\((\/(?:api\/files\/[^\s)]+|files\?[^\s)]+))\)/g;
const CODE_LABEL: Record<string, string> = { js: 'JavaScript', ts: 'TypeScript', py: 'Python', sh: 'Shell', bash: 'Shell', md: 'Markdown', yml: 'YAML' };

function firstLine(text: string): string {
  const line = text.split('\n').map((value) => value.trim()).find((value) => value && !/^(?:graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram(?:-v2)?|gantt|pie|journey|mindmap|timeline)\b/.test(value)) || '';
  return line.replace(/^[#/*\-<!>\s]+/, '').slice(0, 60);
}
const language = (info: string) => (info.trim().split(/\s+/)[0] || '').toLowerCase();

/** Code, diagrams, documents and file links an agent posted, newest first. */
export function collectArtifacts(messages: readonly ChatMessage[]): ChatArtifact[] {
  const out: ChatArtifact[] = [];
  const seen = new Set<string>();
  const add = (artifact: ChatArtifact) => { if (!seen.has(artifact.key)) { seen.add(artifact.key); out.push(artifact); } };
  messages.forEach((message) => {
    if (message.role !== 'assistant' || typeof message.content !== 'string' || !message.content) return;
    const content = message.content;
    for (const match of content.matchAll(FENCE)) {
      const lang = language(match[1]); const body = match[2].replace(/\n$/, '');
      if (!body.trim()) continue;
      if (lang === 'mermaid') {
        add({ key: `mermaid:${body}`, messageId: message.id, kind: 'mermaid', title: firstLine(body) || 'Diagram', detail: 'Mermaid diagram',
          preview: { kind: 'mermaid', title: firstLine(body) || 'Diagram', source: body } });
      } else if (lang === 'md' || lang === 'markdown') {
        add({ key: `md:${body}`, messageId: message.id, kind: 'markdown', title: firstLine(body) || 'Document', detail: 'Markdown',
          preview: { kind: 'markdown', title: firstLine(body) || 'Document', markdown: body } });
      } else if (body.split('\n').length >= 3 || body.length >= 160) {
        const label = CODE_LABEL[lang] || (lang ? lang.toUpperCase() : 'Code');
        add({ key: `code:${lang}:${body}`, messageId: message.id, kind: 'code', title: firstLine(body) || label, detail: `${label} · ${body.split('\n').length} lines`,
          preview: { kind: 'code', title: firstLine(body) || label, language: lang, code: body } });
      }
    }
    for (const match of content.matchAll(LINK)) {
      add({ key: `file:${match[2]}`, messageId: message.id, kind: 'file', title: match[1].trim(), detail: 'File',
        preview: { kind: 'file', title: match[1].trim(), href: match[2] } });
    }
    // A long structured answer is a document worth keeping beside the chat.
    const heading = /^#{1,3}\s+(.{2,80})$/m.exec(content.replace(FENCE, ''));
    if (heading && content.length >= 1200) {
      add({ key: `doc:${message.id}`, messageId: message.id, kind: 'markdown', title: heading[1].trim(), detail: 'Answer',
        preview: { kind: 'markdown', title: heading[1].trim(), markdown: content } });
    }
  });
  return out.reverse();
}

function widgetCalls(messages: readonly ChatMessage[]): ToolCall[] {
  return messages.flatMap((message) => message.toolCalls || []).filter((tool) => tool.name === 'show_widget' && tool.status === 'done');
}

/**
 * Every widget this chat produced, newest first. OpenClaw and the Portal chat
 * bridge both report the canonical show_widget reference; anything else is not
 * a widget. One row per tool call, except a live widget: its versions share a
 * board name and collapse into one row at the newest version's position.
 */
export function collectWidgets(messages: readonly ChatMessage[]): ChatWidgetEntry[] {
  const byKey = new Map<string, ChatWidgetEntry>();
  for (const tool of widgetCalls(messages)) {
    const reference = parseWidgetReference(tool.name, tool.id, tool.result);
    if (!reference || reference.mode === 'unsupported') continue;
    const key = reference.boardName ? `board:${reference.boardName}` : `call:${tool.id}`;
    const previous = byKey.get(key);
    // A pinned-only update has no transcript copy; keep the last version that does.
    const inline = reference.mode === 'inline' || previous?.mode === 'inline';
    const toolCallId = reference.mode === 'inline' || !previous || previous.mode !== 'inline' ? tool.id : previous.toolCallId;
    byKey.delete(key);
    byKey.set(key, { key, toolCallId, title: reference.title, mode: inline ? 'inline' : 'dashboard',
      ...(reference.boardName ? { boardName: reference.boardName } : {}), versions: (previous?.versions || 0) + 1 });
  }
  return [...byKey.values()].reverse();
}

export interface BrowserActivity { toolCallId: string; profile?: string; targetId?: string; running: boolean }

/** The agent's most recent use of OpenClaw's native browser tool: which profile and tab to show. */
export function latestBrowserActivity(messages: readonly ChatMessage[]): BrowserActivity | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const tools = messages[index].toolCalls || [];
    for (let at = tools.length - 1; at >= 0; at--) {
      const tool = tools[at];
      if (canonicalToolName(tool.name) !== 'browser') continue;
      const args = tool.arguments && typeof tool.arguments === 'object' && !Array.isArray(tool.arguments) ? tool.arguments as Record<string, unknown> : {};
      const profile = typeof args.profile === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.profile) ? args.profile : undefined;
      const fromResult = typeof tool.result === 'string' ? /"targetId"\s*:\s*"([A-Za-z0-9._:-]{1,128})"/.exec(tool.result)?.[1] : undefined;
      const targetId = typeof args.targetId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(args.targetId) ? args.targetId : fromResult;
      return { toolCallId: tool.id, profile, targetId, running: tool.status === 'running' };
    }
  }
  return null;
}
