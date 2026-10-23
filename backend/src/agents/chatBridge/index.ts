import fs from 'fs';
import path from 'path';
import {
  CHAT_BRIDGE_ENV,
  CHAT_BRIDGE_SERVER_NAME,
  CHAT_BRIDGE_TOOL_NAMES,
  CHAT_BRIDGE_TOOL_TIMEOUT_MS,
  type ChatBridgeToolIdentity,
  type ChatBridgeToolName,
  type ChatBridgeTurn,
  type ChatBridgeTurnBinding,
} from './contract';
import { mintChatBridgeTurn, revokeChatBridgeTurn } from './registry';
import { ensureChatBridgeListener, invokeChatBridgeTool } from './listener';
import { cancelTurnQuestions } from './questions';
import { bindChatBridgeWidget, discardChatBridgeWidgets } from './widgetStore';
import { WIDGET_REFERENCE_SCHEMA } from '../../services/chatWidgetProjection';

export * from './contract';
export { NativeToolCallRecorder, sanitizeNativeToolCalls } from './toolCallRecorder';

const TOOL_SET = new Set<string>(CHAT_BRIDGE_TOOL_NAMES);
const QUALIFIED_NAME = new RegExp(
  `^(?:mcp__${CHAT_BRIDGE_SERVER_NAME}__|${CHAT_BRIDGE_SERVER_NAME}(?:__|[._/:-]|\\s*[:/]\\s*))(${CHAT_BRIDGE_TOOL_NAMES.join('|')})$`,
);

let serverPathOverride: string | null = null;
let listenerOverride: (() => Promise<string>) | null = null;

export function __configureChatBridgeForTests(options: { serverPath?: string | null; listener?: (() => Promise<string>) | null }): void {
  if (options.serverPath !== undefined) serverPathOverride = options.serverPath;
  if (options.listener !== undefined) listenerOverride = options.listener;
}

/** Compiled MCP server shipped beside this module; null when absent (e.g. ts-node). */
export function chatBridgeMcpServerPath(): string | null {
  const candidate = serverPathOverride ?? path.join(__dirname, 'mcpServer.js');
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** Presentation identity only; authority is enforced by the registry. */
export function identifyChatBridgeTool(rawName: unknown, server?: string | null): ChatBridgeToolIdentity | null {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return null;
  if (server !== undefined && server !== null) {
    return server === CHAT_BRIDGE_SERVER_NAME && TOOL_SET.has(name) ? { name: name as ChatBridgeToolName } : null;
  }
  const qualified = QUALIFIED_NAME.exec(name);
  if (qualified) return { name: qualified[1] as ChatBridgeToolName };
  return null;
}

function extractWidgetPayload(rawResult: unknown): { widgetId: string } | null {
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.length <= 16 * 1024) candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 8)) visit(entry, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.widgetId === 'string' && record.bridgesllm === 'widget') {
        candidates.push(JSON.stringify(record));
        return;
      }
      for (const key of ['text', 'content', 'result', 'structured_content', 'structuredContent', 'output']) {
        if (key in record) visit(record[key], depth + 1);
      }
    }
  };
  visit(rawResult, 0);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed?.bridgesllm === 'widget' && typeof parsed.widgetId === 'string') return { widgetId: parsed.widgetId };
    } catch { /* not this candidate */ }
  }
  return null;
}

/**
 * Open the bridge for one native Agent Chat turn. Resolves null when the
 * bridge cannot run here; the turn then proceeds without Portal chat tools.
 */
export async function openChatBridgeTurn(binding: ChatBridgeTurnBinding): Promise<ChatBridgeTurn | null> {
  const serverPath = chatBridgeMcpServerPath();
  if (!serverPath) return null;
  let socketPath: string;
  try {
    socketPath = await (listenerOverride ?? ensureChatBridgeListener)();
  } catch {
    return null;
  }
  const { token, record } = mintChatBridgeTurn(binding);
  const launch = Object.freeze({
    serverName: CHAT_BRIDGE_SERVER_NAME,
    command: process.execPath,
    args: Object.freeze([serverPath]),
    env: Object.freeze({
      [CHAT_BRIDGE_ENV.socket]: socketPath,
      [CHAT_BRIDGE_ENV.token]: token,
    }),
    toolTimeoutMs: CHAT_BRIDGE_TOOL_TIMEOUT_MS,
  });
  return {
    binding: record.binding,
    launch,
    identifyTool: identifyChatBridgeTool,
    bindWidgetResult(toolCallId: string, rawResult: unknown): string | null {
      if (record.revoked || typeof toolCallId !== 'string' || !toolCallId) return null;
      const payload = extractWidgetPayload(rawResult);
      if (!payload) return null;
      const widget = record.widgets.get(payload.widgetId);
      if (!widget) return null;
      if (widget.boundToolCallId && widget.boundToolCallId !== toolCallId) return null;
      try {
        bindChatBridgeWidget({
          provider: record.binding.provider,
          portalSessionId: record.binding.portalSessionId,
          toolCallId,
          widgetId: widget.widgetId,
          title: widget.title,
        });
      } catch {
        return null;
      }
      widget.boundToolCallId = toolCallId;
      return JSON.stringify({ schema: WIDGET_REFERENCE_SCHEMA, toolCallId, title: widget.title, mode: 'inline' });
    },
    async call(name, args, signal) {
      const outcome = await invokeChatBridgeTool(record, name, args, signal ?? new AbortController().signal);
      if (outcome.kind !== 'result') {
        return { text: 'The Portal chat bridge is no longer available for this turn.', isError: true };
      }
      return { text: outcome.result.content.map((part) => part.text).join('\n'), isError: outcome.result.isError === true };
    },
    revoke(): void {
      if (record.revoked) return;
      revokeChatBridgeTurn(record);
      cancelTurnQuestions(record);
      const unbound = [...record.widgets.values()].filter((widget) => !widget.boundToolCallId).map((widget) => widget.widgetId);
      if (unbound.length) discardChatBridgeWidgets(record.binding.provider, record.binding.portalSessionId, unbound);
    },
  };
}
