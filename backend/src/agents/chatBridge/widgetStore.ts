import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AgentProviderName } from '../AgentProvider.interface';
import { nativeChatBridgeWidgetDirectory } from '../providers/NativeSessionStore';
import {
  CHAT_BRIDGE_WIDGET_MAX_BYTES,
  CHAT_BRIDGE_WIDGETS_PER_SESSION_MAX,
} from './contract';

/**
 * Root-only storage for bridge widget documents. Each native session owns one
 * directory: `<widgetId>.html` documents plus `index.json`, the server-side
 * binding from the harness's own tool-call id to the widget it rendered. The
 * index is written only by the bridge, so provider session saves can never
 * clobber it.
 */

const WIDGET_ID_PATTERN = /^w_[a-f0-9]{32}$/;
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,255}$/;
const INDEX_NAME = 'index.json';
const INDEX_MAX_BYTES = 256 * 1024;

export interface ChatBridgeWidgetBinding {
  readonly widgetId: string;
  readonly title: string;
  readonly boundAt: number;
}

interface WidgetIndex {
  v: 1;
  bindings: Record<string, ChatBridgeWidgetBinding>;
}

export function newChatBridgeWidgetId(): string {
  return `w_${crypto.randomBytes(16).toString('hex')}`;
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode is filtered by umask and ignored for existing parents.
  for (let current = directory, depth = 0; depth < 3; depth += 1, current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Widget storage path is not a directory');
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(current, 0o700);
  }
}

function atomicWrite(filePath: string, content: string | Buffer): void {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readIndex(directory: string): WidgetIndex {
  const file = path.join(directory, INDEX_NAME);
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > INDEX_MAX_BYTES) return { v: 1, bindings: {} };
    raw = fs.readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { v: 1, bindings: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== 1 || !parsed.bindings || typeof parsed.bindings !== 'object') return { v: 1, bindings: {} };
    const bindings: Record<string, ChatBridgeWidgetBinding> = Object.create(null);
    for (const [toolCallId, value] of Object.entries(parsed.bindings as Record<string, any>)) {
      if (!TOOL_CALL_ID_PATTERN.test(toolCallId) || !WIDGET_ID_PATTERN.test(value?.widgetId)) continue;
      bindings[toolCallId] = {
        widgetId: value.widgetId,
        title: typeof value.title === 'string' ? value.title.slice(0, 160) : 'Widget',
        boundAt: Number.isSafeInteger(value.boundAt) ? value.boundAt : 0,
      };
    }
    return { v: 1, bindings };
  } catch {
    return { v: 1, bindings: {} };
  }
}

export function storeChatBridgeWidget(input: {
  provider: AgentProviderName;
  portalSessionId: string;
  widgetId: string;
  html: string;
}): void {
  if (!WIDGET_ID_PATTERN.test(input.widgetId)) throw new Error('Widget identity is invalid');
  const bytes = Buffer.from(input.html, 'utf8');
  if (bytes.length < 1 || bytes.length > CHAT_BRIDGE_WIDGET_MAX_BYTES) throw new Error('Widget document size is invalid');
  const directory = nativeChatBridgeWidgetDirectory(input.provider, input.portalSessionId);
  ensurePrivateDirectory(directory);
  const documents = fs.readdirSync(directory).filter((name) => name.endsWith('.html'));
  if (documents.length >= CHAT_BRIDGE_WIDGETS_PER_SESSION_MAX) {
    throw new Error('This conversation already holds the maximum number of widgets');
  }
  atomicWrite(path.join(directory, `${input.widgetId}.html`), bytes);
}

export function bindChatBridgeWidget(input: {
  provider: AgentProviderName;
  portalSessionId: string;
  toolCallId: string;
  widgetId: string;
  title: string;
}): void {
  if (!TOOL_CALL_ID_PATTERN.test(input.toolCallId) || !WIDGET_ID_PATTERN.test(input.widgetId)) {
    throw new Error('Widget binding is invalid');
  }
  const directory = nativeChatBridgeWidgetDirectory(input.provider, input.portalSessionId);
  ensurePrivateDirectory(directory);
  const index = readIndex(directory);
  const existing = index.bindings[input.toolCallId];
  if (existing && existing.widgetId !== input.widgetId) throw new Error('Tool call is already bound to another widget');
  index.bindings[input.toolCallId] = { widgetId: input.widgetId, title: input.title.slice(0, 160), boundAt: Date.now() };
  atomicWrite(path.join(directory, INDEX_NAME), `${JSON.stringify(index)}\n`);
}

export function readChatBridgeWidgetDocument(input: {
  provider: AgentProviderName;
  portalSessionId: string;
  toolCallId: string;
}): { title: string; html: string } | null {
  if (!TOOL_CALL_ID_PATTERN.test(input.toolCallId)) return null;
  const directory = nativeChatBridgeWidgetDirectory(input.provider, input.portalSessionId);
  const binding = readIndex(directory).bindings[input.toolCallId];
  if (!binding) return null;
  const file = path.join(directory, `${binding.widgetId}.html`);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > CHAT_BRIDGE_WIDGET_MAX_BYTES) return null;
    return { title: binding.title, html: fs.readFileSync(file, 'utf8') };
  } catch {
    return null;
  }
}

/** Remove documents a revoked turn minted but its own stream never bound. */
export function discardChatBridgeWidgets(provider: AgentProviderName, portalSessionId: string, widgetIds: Iterable<string>): void {
  let directory: string;
  try {
    directory = nativeChatBridgeWidgetDirectory(provider, portalSessionId);
  } catch {
    return;
  }
  for (const widgetId of widgetIds) {
    if (!WIDGET_ID_PATTERN.test(widgetId)) continue;
    try { fs.unlinkSync(path.join(directory, `${widgetId}.html`)); } catch { /* already absent */ }
  }
}
