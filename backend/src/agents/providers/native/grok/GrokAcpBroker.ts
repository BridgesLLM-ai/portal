import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';
import type { OnStatusCallback } from '../../../AgentProvider.interface';
import { AgentAbortError } from '../../../AgentProvider.interface';
import { PORTAL_TOOL_VERSIONS } from '../../../../config/toolVersions';

export const GROK_ACP_AGENT_VERSION = PORTAL_TOOL_VERSIONS.grokBuild;
export const GROK_ACP_PROTOCOL_VERSION = 1;
export const GROK_ACP_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const GROK_ACP_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const GROK_ACP_MAX_STDERR_BYTES = 1024 * 1024;
// The CLI performs a cold Node startup plus cached-auth/plugin discovery before
// answering ACP initialize. Twenty seconds proved too short on the test VPS
// under ordinary Portal discovery load, even though the same runtime completed
// successfully once warm. Keep this bounded, but leave enough room for a real
// cold start instead of misreporting a working login as an ACP failure.
const GROK_ACP_CONTROL_TIMEOUT_MS = 45_000;
const GROK_ACP_PROMPT_TIMEOUT_MS = 4 * 60 * 60_000;
const GROK_ACP_CANCEL_GRACE_MS = 3_000;
const GROK_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UnknownRecord = Record<string, unknown>;
type JsonRpcId = string | number;
export type GrokAcpPermissionDecision = 'allow-once' | 'allow-always' | 'deny';

export interface GrokAcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface GrokAcpPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  rawInput: unknown;
  options: GrokAcpPermissionOption[];
}

export interface GrokAcpTurnResult {
  fullText: string;
  nativeSessionId: string;
  stopReason: string;
  usage?: UnknownRecord;
  agentVersion: string;
  protocolVersion: number;
}

export interface GrokAcpBrokerOptions {
  cwd: string;
  model?: string | null;
  nativeSessionId?: string | null;
  onChunk?: (chunk: string) => void;
  onStatus?: OnStatusCallback;
  onPermission: (request: GrokAcpPermissionRequest) => Promise<GrokAcpPermissionDecision>;
  spawnImpl?: SpawnImplementation;
  controlTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
}

export type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ToolState {
  id: string;
  name: string;
  title: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = 16_384): string {
  const raw = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : (() => {
          try { return JSON.stringify(value); } catch { return String(value); }
        })();
  const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function normalizeSessionId(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return GROK_SESSION_ID_PATTERN.test(candidate) ? candidate : null;
}

function normalizeModel(value?: string | null): string | null {
  const model = String(value || '').trim();
  if (!model) return null;
  const lower = model.toLowerCase();
  if (lower.startsWith('xai/') || lower.startsWith('grok/')) {
    return model.split('/').slice(1).join('/') || null;
  }
  return model;
}

function normalizeContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  return typeof value.text === 'string' ? value.text : '';
}

function normalizePermissionOptions(value: unknown): GrokAcpPermissionOption[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  const allowedKinds = new Set<GrokAcpPermissionOption['kind']>([
    'allow_once',
    'allow_always',
    'reject_once',
    'reject_always',
  ]);
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const optionId = boundedString(entry.optionId, 256).trim();
    const name = boundedString(entry.name, 256).trim();
    const kind = boundedString(entry.kind, 64) as GrokAcpPermissionOption['kind'];
    if (!optionId || !name || !allowedKinds.has(kind)) return [];
    return [{ optionId, name, kind }];
  });
}

function permissionOutcome(
  decision: GrokAcpPermissionDecision,
  options: GrokAcpPermissionOption[],
): UnknownRecord {
  const preferredKinds = decision === 'allow-always'
    ? ['allow_always', 'allow_once']
    : decision === 'allow-once'
      ? ['allow_once']
      : ['reject_once', 'reject_always'];
  for (const kind of preferredKinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

function safeToolName(kind: unknown, title: unknown): string {
  const normalized = boundedString(kind, 128).trim();
  if (normalized) return normalized === 'execute' ? 'shell' : normalized;
  return boundedString(title, 128).trim() || 'grok-tool';
}

function jsonRpcError(code: number, message: string): UnknownRecord {
  return { code, message };
}

/**
 * Strict JSON-RPC/ACP client for the pinned Grok Build release
 * (PORTAL_TOOL_VERSIONS.grokBuild).
 *
 * A broker process lives for one Portal turn. Grok's persisted session id is
 * loaded by the next broker, so a browser reconnect can continue future turns
 * without pretending a failed, side-effecting prompt is safe to replay.
 */
export class GrokAcpBroker {
  private readonly options: GrokAcpBrokerOptions;
  private readonly spawnImpl: SpawnImplementation;
  private readonly controlTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderr = '';
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly tools = new Map<string, ToolState>();
  private readonly seenEventIds = new Set<string>();
  private nativeSessionId: string | null;
  private initialized = false;
  private promptActive = false;
  private aborted = false;
  private protocolFailed = false;
  private fullText = '';
  private fullTextBytes = 0;
  private agentVersion = '';
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GrokAcpBrokerOptions) {
    this.options = options;
    const requestedSessionId = typeof options.nativeSessionId === 'string'
      ? options.nativeSessionId.trim()
      : '';
    this.nativeSessionId = normalizeSessionId(requestedSessionId);
    if (requestedSessionId && !this.nativeSessionId) {
      throw new Error('Stored Grok ACP session id is invalid');
    }
    this.spawnImpl = options.spawnImpl || ((command, args, spawnOptions) => (
      spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams
    ));
    this.controlTimeoutMs = Math.max(1_000, Math.min(options.controlTimeoutMs || GROK_ACP_CONTROL_TIMEOUT_MS, 60_000));
    this.promptTimeoutMs = Math.max(10_000, Math.min(options.promptTimeoutMs || GROK_ACP_PROMPT_TIMEOUT_MS, GROK_ACP_PROMPT_TIMEOUT_MS));
    this.cancelGraceMs = Math.max(100, Math.min(options.cancelGraceMs || GROK_ACP_CANCEL_GRACE_MS, 10_000));
  }

  get sessionId(): string | null {
    return this.nativeSessionId;
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  async start(): Promise<string> {
    if (this.initialized) {
      if (!this.nativeSessionId) throw new Error('Grok ACP session is missing after initialization');
      return this.nativeSessionId;
    }

    const model = normalizeModel(this.options.model);
    const args = ['--no-auto-update', 'agent'];
    if (model) args.push('--model', model);
    args.push('stdio');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl('grok', args, {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          GROK_DISABLE_AUTOUPDATER: '1',
        },
      });
    } catch (error: any) {
      throw new Error(`Failed to spawn Grok Build ACP: ${error?.message || error}`);
    }
    this.child = child;
    child.stdout.on('data', this.onStdoutData);
    child.stderr.on('data', this.onStderrData);
    child.once('error', this.onProcessError);
    child.once('close', this.onProcessClose);

    const initializeResult = await this.request('initialize', {
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'bridgesllm-portal',
        title: 'BridgesLLM Portal',
        version: '4.0',
      },
    }, this.controlTimeoutMs);
    this.validateInitialize(initializeResult);

    if (this.nativeSessionId) {
      await this.request('session/load', {
        sessionId: this.nativeSessionId,
        cwd: this.options.cwd,
        mcpServers: [],
      }, this.controlTimeoutMs);
    } else {
      const result = await this.request('session/new', {
        cwd: this.options.cwd,
        mcpServers: [],
      }, this.controlTimeoutMs);
      const createdSessionId = isRecord(result) ? normalizeSessionId(result.sessionId) : null;
      if (!createdSessionId) {
        throw new Error('Grok ACP session/new did not return a valid persisted session id');
      }
      this.nativeSessionId = createdSessionId;
    }

    this.initialized = true;
    return this.nativeSessionId;
  }

  async prompt(message: string): Promise<GrokAcpTurnResult> {
    const sessionId = await this.start();
    if (this.promptActive) throw new Error('A Grok ACP prompt is already active');
    if (!String(message || '').trim()) throw new Error('Grok ACP prompt cannot be empty');

    this.fullText = '';
    this.fullTextBytes = 0;
    this.tools.clear();
    this.seenEventIds.clear();
    this.promptActive = true;
    let result: unknown;
    try {
      result = await this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: message }],
      }, this.promptTimeoutMs);
    } finally {
      this.promptActive = false;
    }

    if (this.aborted) throw new AgentAbortError();
    if (!isRecord(result)) throw new Error('Grok ACP session/prompt returned an invalid response');
    const stopReason = boundedString(result.stopReason, 128).trim();
    if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(stopReason)) {
      throw new Error('Grok ACP session/prompt returned an unsupported stop reason');
    }
    if (stopReason === 'cancelled') throw new AgentAbortError();

    return {
      fullText: this.fullText.trim(),
      nativeSessionId: sessionId,
      stopReason,
      usage: isRecord(result.usage) ? result.usage : undefined,
      agentVersion: this.agentVersion,
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
    };
  }

  abort(): boolean {
    if (!this.child) return false;
    if (this.aborted) return true;
    this.aborted = true;
    if (!this.promptActive || !this.nativeSessionId) {
      this.rejectPending(new AgentAbortError());
      try { this.child.kill('SIGTERM'); } catch {}
      return true;
    }
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.nativeSessionId } });
    this.options.onStatus?.({ type: 'status', content: 'Cancelling Grok Build…', provider: 'grok-build' });
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => {
      try { this.child?.kill('SIGTERM'); } catch {}
      this.killTimer = setTimeout(() => {
        try { this.child?.kill('SIGKILL'); } catch {}
      }, 1_000);
      this.killTimer.unref?.();
    }, this.cancelGraceMs);
    this.cancelTimer.unref?.();
    return true;
  }

  close(): void {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.cancelTimer = null;
    this.killTimer = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdout.off('data', this.onStdoutData);
    child.stderr.off('data', this.onStderrData);
    child.off('error', this.onProcessError);
    child.off('close', this.onProcessClose);
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }

  private validateInitialize(value: unknown): void {
    if (!isRecord(value)) throw new Error('Grok ACP initialize returned an invalid response');
    if (value.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) {
      throw new Error(`Grok ACP protocol mismatch: expected ${GROK_ACP_PROTOCOL_VERSION}`);
    }
    const meta = isRecord(value._meta) ? value._meta : {};
    const agentVersion = boundedString(meta.agentVersion, 128).trim();
    if (agentVersion !== GROK_ACP_AGENT_VERSION) {
      throw new Error(`Grok ACP agent mismatch: expected ${GROK_ACP_AGENT_VERSION}, received ${agentVersion || 'unknown'}`);
    }
    const capabilities = isRecord(value.agentCapabilities) ? value.agentCapabilities : {};
    if (capabilities.loadSession !== true) {
      throw new Error('Grok ACP does not advertise required persisted-session loading');
    }
    this.agentVersion = agentVersion;
  }

  private request(method: string, params: UnknownRecord, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.protocolFailed) return Promise.reject(new Error('Grok ACP process is not available'));
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Grok ACP ${method} timed out`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(String(id), { method, resolve, reject, timeout });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error: any) {
        clearTimeout(timeout);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(payload: UnknownRecord): void {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error('Grok ACP stdin is unavailable');
    }
    const line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line, 'utf8') > GROK_ACP_MAX_LINE_BYTES) {
      throw new Error('Grok ACP outbound message exceeded the protocol bound');
    }
    this.child.stdin.write(line);
  }

  private readonly onStdoutData = (data: Buffer | string): void => {
    if (this.protocolFailed) return;
    this.stdoutBuffer += data.toString();
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > GROK_ACP_MAX_LINE_BYTES) {
      this.failProtocol(new Error('Grok ACP emitted an oversized JSON-RPC line'));
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) {
        try {
          const payload = JSON.parse(line);
          if (!isRecord(payload)) throw new Error('message is not an object');
          void this.handleMessage(payload).catch((error: any) => {
            this.failProtocol(error instanceof Error ? error : new Error(String(error)));
          });
        } catch (error: any) {
          this.failProtocol(new Error(`Grok ACP emitted invalid JSON-RPC: ${error?.message || error}`));
          return;
        }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  };

  private readonly onStderrData = (data: Buffer | string): void => {
    if (Buffer.byteLength(this.stderr, 'utf8') >= GROK_ACP_MAX_STDERR_BYTES) return;
    const remaining = GROK_ACP_MAX_STDERR_BYTES - Buffer.byteLength(this.stderr, 'utf8');
    this.stderr += data.toString().slice(0, remaining);
  };

  private readonly onProcessError = (error: Error): void => {
    this.failProtocol(new Error(`Grok ACP process error: ${error.message}`));
  };

  private readonly onProcessClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!this.child) return;
    this.child = null;
    if (this.pending.size === 0) return;
    const suffix = this.stderr.trim() ? `: ${boundedString(this.stderr.trim(), 2_048)}` : '';
    const error = this.aborted
      ? new AgentAbortError()
      : new Error(`Grok ACP process exited before the request completed (code ${code ?? 'null'}, signal ${signal || 'none'})${suffix}`);
    this.rejectPending(error);
  };

  private async handleMessage(payload: UnknownRecord): Promise<void> {
    if (payload.jsonrpc !== '2.0') {
      this.failProtocol(new Error('Grok ACP emitted a message without jsonrpc 2.0'));
      return;
    }
    const hasId = typeof payload.id === 'string' || typeof payload.id === 'number';
    const method = typeof payload.method === 'string' ? payload.method : '';
    if (hasId && method) {
      await this.handleAgentRequest(payload.id as JsonRpcId, method, payload.params);
      return;
    }
    if (hasId) {
      const pending = this.pending.get(String(payload.id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(String(payload.id));
      if (isRecord(payload.error)) {
        pending.reject(new Error(`Grok ACP ${pending.method} failed: ${boundedString(payload.error.message || payload.error)}`));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }
    if (method) this.handleNotification(method, payload.params);
  }

  private async handleAgentRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (method !== 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id, error: jsonRpcError(-32601, 'Method not found') });
      return;
    }
    const activeSessionId = this.nativeSessionId;
    if (!this.promptActive || !activeSessionId || !isRecord(params) || params.sessionId !== activeSessionId) {
      this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const options = normalizePermissionOptions(params.options);
    const toolCallId = boundedString(toolCall.toolCallId, 256).trim();
    if (!toolCallId || options.length === 0) {
      this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    let decision: GrokAcpPermissionDecision = 'deny';
    try {
      decision = await this.options.onPermission({
        sessionId: activeSessionId,
        toolCallId,
        title: boundedString(toolCall.title, 512).trim() || 'Grok Build tool request',
        kind: boundedString(toolCall.kind, 128).trim() || 'tool',
        rawInput: toolCall.rawInput,
        options,
      });
    } catch {
      decision = 'deny';
    }
    if (!this.child) return;
    this.write({ jsonrpc: '2.0', id, result: permissionOutcome(decision, options) });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' && method !== 'x.ai/session/update') return;
    if (!this.promptActive || !isRecord(params) || params.sessionId !== this.nativeSessionId) return;
    const meta = isRecord(params._meta) ? params._meta : {};
    const eventId = boundedString(meta.eventId, 512).trim();
    if (eventId) {
      if (this.seenEventIds.has(eventId)) return;
      if (this.seenEventIds.size >= 20_000) this.seenEventIds.clear();
      this.seenEventIds.add(eventId);
    }
    const update = isRecord(params.update) ? params.update : null;
    if (!update) return;
    this.handleSessionUpdate(update);
  }

  private handleSessionUpdate(update: UnknownRecord): void {
    const type = boundedString(update.sessionUpdate, 128).trim();
    if (type === 'agent_message_chunk') {
      const chunk = normalizeContentText(update.content);
      if (!chunk) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (this.fullTextBytes + chunkBytes > GROK_ACP_MAX_TEXT_BYTES) {
        this.failProtocol(new Error('Grok ACP assistant text exceeded the response bound'));
        return;
      }
      this.fullText += chunk;
      this.fullTextBytes += chunkBytes;
      this.options.onChunk?.(chunk);
      return;
    }
    if (type === 'agent_thought_chunk') {
      const thought = normalizeContentText(update.content);
      if (thought) this.options.onStatus?.({ type: 'thinking', content: thought, provider: 'grok-build' });
      return;
    }
    if (type === 'tool_call') {
      this.handleToolCall(update, false);
      return;
    }
    if (type === 'tool_call_update') {
      this.handleToolCall(update, true);
      return;
    }
    if (type === 'plan' || type === 'plan_update' || type === 'plan_removed') {
      this.options.onStatus?.({
        type: 'status',
        content: type === 'plan_removed' ? 'Grok Build cleared its plan.' : 'Grok Build updated its plan.',
        provider: 'grok-build',
        plan: update.entries || update.plan || null,
      });
    }
  }

  private handleToolCall(update: UnknownRecord, isUpdate: boolean): void {
    const id = boundedString(update.toolCallId, 256).trim();
    if (!id) return;
    const existing = this.tools.get(id);
    const next: ToolState = {
      id,
      name: safeToolName(update.kind ?? existing?.name, update.title ?? existing?.title),
      title: boundedString(update.title ?? existing?.title, 512).trim() || existing?.title || 'Grok Build tool',
      rawInput: update.rawInput !== undefined ? update.rawInput : existing?.rawInput,
      rawOutput: update.rawOutput !== undefined
        ? update.rawOutput
        : update.content !== undefined
          ? update.content
          : existing?.rawOutput,
      status: boundedString(update.status ?? existing?.status, 64).trim() || existing?.status,
    };
    this.tools.set(id, next);
    const terminal = ['completed', 'failed', 'cancelled'].includes(String(next.status || '').toLowerCase());
    if (terminal) {
      this.options.onStatus?.({
        type: 'tool_end',
        content: boundedString(next.rawOutput) || next.title,
        toolCallId: id,
        toolName: next.name,
        toolResult: boundedString(next.rawOutput),
        status: next.status,
        provider: 'grok-build',
      });
      return;
    }
    this.options.onStatus?.({
      type: isUpdate || existing ? 'tool_update' : 'tool_start',
      content: next.title,
      toolCallId: id,
      toolName: next.name,
      toolArgs: next.rawInput,
      status: next.status || 'pending',
      provider: 'grok-build',
    });
  }

  private failProtocol(error: Error): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.rejectPending(error);
    try { this.child?.kill('SIGTERM'); } catch {}
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
