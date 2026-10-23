import fs from 'fs';
import http from 'http';
import path from 'path';
import {
  CHAT_BRIDGE_RUNTIME_ROOT,
  CHAT_BRIDGE_SOCKET_NAME,
  CHAT_BRIDGE_WIDGET_MAX_BYTES,
  CHAT_BRIDGE_WIDGET_TITLE_MAX,
  CHAT_BRIDGE_WIDGETS_PER_TURN_MAX,
  type ChatBridgeTurnBinding,
} from './contract';
import { resolveChatBridgeToken, type ChatBridgeTurnRecord } from './registry';
import { askThroughBridge } from './questions';
import { newChatBridgeWidgetId, storeChatBridgeWidget } from './widgetStore';
import { describeGoalForAgent, settleGoalFromAgent } from '../../services/nativeSessionWork';

/**
 * Backend half of the Portal Chat Bridge: HTTP over a root-only Unix socket.
 * There is deliberately no TCP listener. Every request carries the per-turn
 * bearer token; the actor's current authorization is re-checked on each call.
 */

const MAX_BODY_BYTES = CHAT_BRIDGE_WIDGET_MAX_BYTES + 256 * 1024;

export type ChatBridgeActorVerifier = (binding: ChatBridgeTurnBinding) => Promise<boolean>;

async function defaultActorVerifier(binding: ChatBridgeTurnBinding): Promise<boolean> {
  const { prisma } = await import('../../config/database');
  const actor = await prisma.user.findUnique({
    where: { id: binding.userId },
    select: { isActive: true, accountStatus: true, role: true, authorizationVersion: true },
  });
  return Boolean(actor?.isActive
    && actor.accountStatus === 'ACTIVE'
    && ['OWNER', 'SUB_ADMIN'].includes(actor.role)
    && actor.authorizationVersion === binding.authorizationVersion);
}

let actorVerifier: ChatBridgeActorVerifier = defaultActorVerifier;
let runtimeRoot = CHAT_BRIDGE_RUNTIME_ROOT;
let server: http.Server | null = null;
let listening: Promise<string> | null = null;

export function __configureChatBridgeListenerForTests(options: { runtimeRoot?: string; verifyActor?: ChatBridgeActorVerifier }): void {
  if (options.runtimeRoot) runtimeRoot = options.runtimeRoot;
  if (options.verifyActor) actorVerifier = options.verifyActor;
}

export function chatBridgeSocketPath(): string {
  return path.join(runtimeRoot, CHAT_BRIDGE_SOCKET_NAME);
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function toolResult(textValue: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: textValue }], ...(isError ? { isError: true } : {}) };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function showWidget(turn: ChatBridgeTurnRecord, args: any): Promise<ToolResult> {
  const title = typeof args?.title === 'string'
    ? args.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_BRIDGE_WIDGET_TITLE_MAX)
    : '';
  const html = typeof args?.widget_code === 'string' ? args.widget_code
    : typeof args?.html === 'string' ? args.html : '';
  if (!title || !html.trim()) {
    return toolResult('show_widget needs a non-empty "title" and "widget_code" (an HTML fragment).', true);
  }
  if (Buffer.byteLength(html, 'utf8') > CHAT_BRIDGE_WIDGET_MAX_BYTES) {
    return toolResult(`widget_code is larger than ${CHAT_BRIDGE_WIDGET_MAX_BYTES} bytes. Simplify the widget.`, true);
  }
  if (turn.widgets.size >= CHAT_BRIDGE_WIDGETS_PER_TURN_MAX) {
    return toolResult(`This turn already rendered ${CHAT_BRIDGE_WIDGETS_PER_TURN_MAX} widgets. Combine views into one widget.`, true);
  }
  const widgetId = newChatBridgeWidgetId();
  try {
    storeChatBridgeWidget({ provider: turn.binding.provider, portalSessionId: turn.binding.portalSessionId, widgetId, html });
  } catch (error: any) {
    return toolResult(`The widget could not be stored: ${String(error?.message || 'storage error')}`, true);
  }
  turn.widgets.set(widgetId, { widgetId, title, boundToolCallId: null });
  return toolResult(JSON.stringify({
    bridgesllm: 'widget',
    widgetId,
    title,
    status: 'rendered',
    note: 'The widget is shown inline in the chat. Do not repeat its HTML in your reply.',
  }));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/v1/tools/call') {
    send(res, 404, { error: 'not_found' });
    return;
  }
  const auth = String(req.headers.authorization || '');
  const turn = resolveChatBridgeToken(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
  if (!turn) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  let body: any;
  try {
    body = await readBody(req);
  } catch (error: any) {
    send(res, error?.status || 400, { error: 'invalid_request' });
    return;
  }
  if (turn.revoked) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  const name = typeof body?.name === 'string' ? body.name : '';
  const args = body?.arguments && typeof body.arguments === 'object' ? body.arguments : {};
  const requestAbort = new AbortController();
  // A harness that cancels its MCP call (or dies) closes the connection.
  res.on('close', () => { if (!res.writableEnded) requestAbort.abort(); });
  const outcome = await invokeChatBridgeTool(turn, name, args, requestAbort.signal);
  if (outcome.kind === 'unauthorized') send(res, 403, { error: 'authorization_changed' });
  else if (outcome.kind === 'unknown') send(res, 404, { error: 'unknown_tool' });
  else send(res, 200, outcome.result);
}

export type ChatBridgeInvocation =
  | { kind: 'result'; result: ToolResult }
  | { kind: 'unauthorized' }
  | { kind: 'unknown' };

/** Shared by the socket listener and in-process harness tool loops (Ollama). */
export async function invokeChatBridgeTool(
  turn: ChatBridgeTurnRecord,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ChatBridgeInvocation> {
  if (turn.revoked) return { kind: 'unauthorized' };
  let verified = false;
  try { verified = await actorVerifier(turn.binding); } catch { verified = false; }
  if (!verified || turn.revoked) return { kind: 'unauthorized' };
  if (name === 'show_widget') return { kind: 'result', result: await showWidget(turn, args) };
  if (name === 'ask_user') {
    const answer = await askThroughBridge(turn, args, signal);
    return { kind: 'result', result: toolResult(answer.text, answer.isError) };
  }
  if (name === 'get_goal') {
    const goal = describeGoalForAgent(turn.binding.provider, turn.binding.portalSessionId);
    return { kind: 'result', result: toolResult(goal.text, goal.isError) };
  }
  if (name === 'update_goal') {
    const settled = settleGoalFromAgent(turn.binding.provider, turn.binding.portalSessionId, args);
    return { kind: 'result', result: toolResult(settled.text, settled.isError) };
  }
  return { kind: 'unknown' };
}

function prepareRuntimeRoot(): void {
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(runtimeRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Chat bridge runtime root is not a directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Chat bridge runtime root has an unexpected owner');
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(runtimeRoot, 0o700);
  const socket = chatBridgeSocketPath();
  try {
    const existing = fs.lstatSync(socket);
    if (!existing.isSocket()) throw new Error('Chat bridge socket path is occupied');
    fs.unlinkSync(socket);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** Start (once) and resolve the socket path. Rejects if the bridge cannot listen. */
export function ensureChatBridgeListener(): Promise<string> {
  if (listening) return listening;
  listening = new Promise<string>((resolve, reject) => {
    try {
      prepareRuntimeRoot();
    } catch (error) {
      reject(error);
      return;
    }
    const socket = chatBridgeSocketPath();
    const instance = http.createServer((req, res) => {
      handle(req, res).catch(() => send(res, 500, { error: 'bridge_error' }));
    });
    // Questions legitimately hold a request open for minutes.
    instance.requestTimeout = 0;
    instance.headersTimeout = 30_000;
    instance.keepAliveTimeout = 5_000;
    instance.once('error', (error) => {
      listening = null;
      reject(error);
    });
    instance.listen(socket, () => {
      try {
        fs.chmodSync(socket, 0o600);
      } catch (error) {
        instance.close();
        listening = null;
        reject(error);
        return;
      }
      server = instance;
      resolve(socket);
    });
  });
  return listening;
}

export async function closeChatBridgeListener(): Promise<void> {
  const current = server;
  server = null;
  listening = null;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
  current.closeAllConnections?.();
}
