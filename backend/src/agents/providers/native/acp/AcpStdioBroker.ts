import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { OnStatusCallback } from '../../../AgentProvider.interface';
import { AgentAbortError } from '../../../AgentProvider.interface';

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const ACP_MAX_TEXT_BYTES = 8 * 1024 * 1024;
export const ACP_MAX_STDERR_BYTES = 1024 * 1024;
export const ACP_MAX_MODELS = 2_000;
export const ACP_MAX_SESSION_ROWS = 1_000;
export const ACP_MAX_QUEUED_MESSAGES = 4_096;
export const ACP_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
export const ACP_MAX_TOOL_STATES = 4_096;
export const ACP_MAX_TOOL_VALUE_BYTES = 64 * 1024;
export const ACP_CONTROL_TIMEOUT_MS = 45_000;
export const ACP_PROMPT_TIMEOUT_MS = 4 * 60 * 60_000;
export const ACP_CANCEL_GRACE_MS = 3_000;
export const ACP_CLOSE_GRACE_MS = 3_000;

type UnknownRecord = Record<string, unknown>;
type JsonRpcId = string | number;

export type AcpPermissionDecision = 'allow-once' | 'allow-always' | 'deny';
export type AcpModelControl = 'none' | 'launch' | 'session-model' | 'config-option';
export type AcpAuthenticationPolicy =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'fixed'; methodId: string }>
  | Readonly<{ kind: 'advertised-agent'; excludedMethodIds: readonly string[] }>;

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  rawInput: unknown;
  options: AcpPermissionOption[];
}

export interface AcpModelDescriptor {
  id: string;
  name: string;
  description?: string;
}

export interface AcpModelState {
  currentModelId: string | null;
  availableModels: AcpModelDescriptor[];
}

export interface AcpSessionStartResult {
  nativeSessionId: string;
  modelState: AcpModelState;
  /** Model reported before this broker applies any requested Portal override. */
  initialModelId: string | null;
  agentName: string;
  agentVersion: string;
  protocolVersion: number;
}

export interface AcpAttestationResult {
  agentName: string;
  agentVersion: string;
  protocolVersion: number;
  authenticationMethodId: string | null;
}

export interface AcpTurnResult extends AcpSessionStartResult {
  fullText: string;
  stopReason: string;
  usage?: UnknownRecord;
}

export interface AcpSessionListResult {
  sessions: UnknownRecord[];
  nextCursor: string | null;
}

export interface AcpHarnessProfile {
  id: string;
  displayName: string;
  /** Optional compatibility label for persisted-session diagnostics. */
  sessionLabel?: string;
  providerTag: string;
  executable: string;
  buildArgs(input: { cwd: string; model: string | null }): string[];
  protocolVersion: number;
  expectedAgentName?: string;
  expectedAgentVersion: string;
  agentVersionSource: 'agent-info' | 'meta-agent-version';
  requiredCapabilities: readonly string[];
  authentication: AcpAuthenticationPolicy;
  sessionIdPattern: RegExp;
  modelControl: AcpModelControl;
  modelConfigOptionId?: string;
  supportsSessionList: boolean;
  supportsSessionClose: boolean;
  normalizeLaunchModel?(model: string): string;
}

export interface AcpStdioBrokerOptions {
  profile: AcpHarnessProfile;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  model?: string | null;
  nativeSessionId?: string | null;
  onChunk?: (chunk: string) => void;
  onStatus?: OnStatusCallback;
  onPermission?: (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>;
  spawnImpl?: SpawnImplementation;
  controlTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  closeGraceMs?: number;
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

function cleanString(value: unknown, maxBytes = 16_384): string {
  const raw = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : (() => {
          try { return JSON.stringify(value); } catch { return String(value); }
        })();
  const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= maxBytes) return clean;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 3)).toString('utf8').replace(/\uFFFD$/u, '')}…`;
}

function safeModelId(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || !/^[A-Za-z0-9][A-Za-z0-9._:/+@=-]{0,511}$/u.test(candidate)) return null;
  return candidate;
}

function normalizeContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  return typeof value.text === 'string' ? value.text : '';
}

function boundedStructuredValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') <= ACP_MAX_TOOL_VALUE_BYTES) return value;
    return cleanString(serialized, ACP_MAX_TOOL_VALUE_BYTES);
  } catch {
    return cleanString(value, ACP_MAX_TOOL_VALUE_BYTES);
  }
}

function normalizePermissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  const allowedKinds = new Set<AcpPermissionOption['kind']>([
    'allow_once',
    'allow_always',
    'reject_once',
    'reject_always',
  ]);
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const optionId = cleanString(entry.optionId, 256).trim();
    const name = cleanString(entry.name, 256).trim();
    const kind = cleanString(entry.kind, 64) as AcpPermissionOption['kind'];
    if (!optionId || !name || !allowedKinds.has(kind)) return [];
    return [{ optionId, name, kind }];
  });
}

function permissionOutcome(
  decision: AcpPermissionDecision,
  options: AcpPermissionOption[],
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

function safeToolName(kind: unknown, title: unknown, fallback: string): string {
  const normalized = cleanString(kind, 128).trim();
  if (normalized) return normalized === 'execute' ? 'shell' : normalized;
  return cleanString(title, 128).trim() || fallback;
}

function jsonRpcError(code: number, message: string): UnknownRecord {
  return { code, message };
}

function capabilityAtPath(capabilities: UnknownRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => (
    isRecord(value) ? value[part] : undefined
  ), capabilities);
}

function capabilityIsAdvertised(value: unknown): boolean {
  return value === true || isRecord(value);
}

function safeAuthMethodId(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)) return null;
  return candidate;
}

function parseModelState(value: unknown, profile: AcpHarnessProfile): AcpModelState {
  if (!isRecord(value)) return { currentModelId: null, availableModels: [] };
  if (profile.modelControl === 'session-model') {
    const models = isRecord(value.models) ? value.models : {};
    const available = Array.isArray(models.availableModels) ? models.availableModels : [];
    const normalized = available.slice(0, ACP_MAX_MODELS).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = safeModelId(entry.modelId ?? entry.id);
      if (!id) return [];
      const name = cleanString(entry.name, 512).trim() || id;
      const description = cleanString(entry.description, 2_048).trim();
      return [{ id, name, ...(description ? { description } : {}) }];
    });
    return {
      currentModelId: safeModelId(models.currentModelId),
      availableModels: dedupeModels(normalized),
    };
  }
  if (profile.modelControl === 'config-option') {
    const configOptions = Array.isArray(value.configOptions) ? value.configOptions : [];
    const modelOption = configOptions.find((entry) => (
      isRecord(entry)
      && entry.type === 'select'
      && entry.id === (profile.modelConfigOptionId || 'model')
    ));
    if (!isRecord(modelOption)) return { currentModelId: null, availableModels: [] };
    const options = Array.isArray(modelOption.options) ? modelOption.options : [];
    const normalized = options.slice(0, ACP_MAX_MODELS).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = safeModelId(entry.value ?? entry.id);
      if (!id) return [];
      const name = cleanString(entry.name, 512).trim() || id;
      const description = cleanString(entry.description, 2_048).trim();
      return [{ id, name, ...(description ? { description } : {}) }];
    });
    return {
      currentModelId: safeModelId(modelOption.currentValue),
      availableModels: dedupeModels(normalized),
    };
  }
  return { currentModelId: null, availableModels: [] };
}

function dedupeModels(models: AcpModelDescriptor[]): AcpModelDescriptor[] {
  const deduped = new Map<string, AcpModelDescriptor>();
  for (const model of models) {
    if (!deduped.has(model.id)) deduped.set(model.id, model);
  }
  return [...deduped.values()];
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (typeof child.pid === 'number' && child.pid > 0) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try { child.kill(signal); } catch {}
  }
}

/**
 * Bounded, fail-closed ACP/JSON-RPC stdio transport shared by pinned native
 * harnesses. One process owns one Portal operation. Persisted upstream session
 * ids are loaded by later processes; a failed side-effecting prompt is never
 * replayed automatically.
 */
export class AcpStdioBroker {
  private readonly options: AcpStdioBrokerOptions;
  private readonly profile: AcpHarnessProfile;
  private readonly spawnImpl: SpawnImplementation;
  private readonly controlTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly closeGraceMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private stderr = Buffer.alloc(0);
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly tools = new Map<string, ToolState>();
  private readonly seenEventIds = new Set<string>();
  private nativeSessionId: string | null;
  private protocolInitialized = false;
  private initialized = false;
  private promptActive = false;
  private aborted = false;
  private protocolFailed = false;
  private fullText = '';
  private fullTextBytes = 0;
  private agentName = '';
  private agentVersion = '';
  private authenticationMethodId: string | null = null;
  private modelState: AcpModelState = { currentModelId: null, availableModels: [] };
  private initialModelId: string | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private inboundChain: Promise<void> = Promise.resolve();
  private queuedInboundMessages = 0;
  private queuedInboundBytes = 0;
  private closePromise: Promise<void> | null = null;

  constructor(options: AcpStdioBrokerOptions) {
    this.options = options;
    this.profile = options.profile;
    const requestedSessionId = typeof options.nativeSessionId === 'string'
      ? options.nativeSessionId.trim()
      : '';
    this.nativeSessionId = this.normalizeSessionId(requestedSessionId);
    if (requestedSessionId && !this.nativeSessionId) {
      throw new Error(`Stored ${this.profile.sessionLabel || this.profile.displayName} ACP session id is invalid`);
    }
    const requestedModel = String(options.model || '').trim();
    if (requestedModel && !safeModelId(requestedModel)) {
      throw new Error(`${this.profile.displayName} model id is invalid`);
    }
    this.spawnImpl = options.spawnImpl || ((command, args, spawnOptions) => (
      spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams
    ));
    this.controlTimeoutMs = Math.max(1_000, Math.min(
      options.controlTimeoutMs || ACP_CONTROL_TIMEOUT_MS,
      60_000,
    ));
    this.promptTimeoutMs = Math.max(10_000, Math.min(
      options.promptTimeoutMs || ACP_PROMPT_TIMEOUT_MS,
      ACP_PROMPT_TIMEOUT_MS,
    ));
    this.cancelGraceMs = Math.max(100, Math.min(
      options.cancelGraceMs || ACP_CANCEL_GRACE_MS,
      10_000,
    ));
    this.closeGraceMs = Math.max(100, Math.min(
      options.closeGraceMs || ACP_CLOSE_GRACE_MS,
      10_000,
    ));
  }

  get sessionId(): string | null {
    return this.nativeSessionId;
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  get currentModelState(): AcpModelState {
    return {
      currentModelId: this.modelState.currentModelId,
      availableModels: this.modelState.availableModels.map((model) => ({ ...model })),
    };
  }

  /**
   * Starts the exact harness, verifies its ACP identity/capabilities, and
   * completes its advertised authentication handshake without creating a
   * session. Readiness probes use this non-billable path.
   */
  async attest(): Promise<AcpAttestationResult> {
    await this.initializeProtocol();
    return {
      agentName: this.agentName,
      agentVersion: this.agentVersion,
      protocolVersion: this.profile.protocolVersion,
      authenticationMethodId: this.authenticationMethodId,
    };
  }

  async start(): Promise<AcpSessionStartResult> {
    if (this.initialized) return this.startResult();

    const requestedModel = safeModelId(this.options.model);
    try {
      await this.initializeProtocol();

      let sessionResult: unknown;
      if (this.nativeSessionId) {
        sessionResult = await this.request('session/load', {
          sessionId: this.nativeSessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }, this.controlTimeoutMs);
      } else {
        sessionResult = await this.request('session/new', {
          cwd: this.options.cwd,
          mcpServers: [],
        }, this.controlTimeoutMs);
        const createdSessionId = isRecord(sessionResult)
          ? this.normalizeSessionId(sessionResult.sessionId)
          : null;
        if (!createdSessionId) {
          throw new Error(`${this.profile.displayName} ACP session/new did not return a valid persisted session id`);
        }
        this.nativeSessionId = createdSessionId;
      }

      this.modelState = parseModelState(sessionResult, this.profile);
      this.initialModelId = this.modelState.currentModelId;
      this.initialized = true;
      if (requestedModel && this.profile.modelControl !== 'launch') {
        await this.setModel(requestedModel);
      }
      return this.startResult();
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async initializeProtocol(): Promise<void> {
    if (this.protocolInitialized) return;
    if (this.protocolFailed || this.closePromise) {
      throw new Error(`${this.profile.displayName} ACP process is not available`);
    }

    const requestedModel = safeModelId(this.options.model);
    const launchModel = this.profile.modelControl === 'launch' && requestedModel
      ? this.profile.normalizeLaunchModel?.(requestedModel) || requestedModel
      : null;
    const args = this.profile.buildArgs({ cwd: this.options.cwd, model: launchModel });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(this.profile.executable, args, {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...this.options.environment },
        detached: true,
      });
    } catch (error: any) {
      throw new Error(`Failed to spawn ${this.profile.displayName} ACP: ${error?.message || error}`);
    }
    this.child = child;
    child.stdin.on('error', this.onStdinError);
    child.stdout.on('data', this.onStdoutData);
    child.stderr.on('data', this.onStderrData);
    child.once('error', this.onProcessError);
    child.once('close', this.onProcessClose);

    try {
      const initializeResult = await this.request('initialize', {
        protocolVersion: this.profile.protocolVersion,
        clientCapabilities: {
          terminal: false,
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: {
          name: 'bridgesllm-portal',
          title: 'BridgesLLM Portal',
          version: '4.1',
        },
      }, this.controlTimeoutMs);
      this.validateInitialize(initializeResult);
      this.authenticationMethodId = this.resolveAuthenticationMethod(initializeResult);
      if (this.authenticationMethodId) {
        const authenticated = await this.request('authenticate', {
          methodId: this.authenticationMethodId,
        }, this.controlTimeoutMs);
        if (!isRecord(authenticated)) {
          throw new Error(`${this.profile.displayName} ACP did not confirm its advertised authentication method`);
        }
      }
      this.protocolInitialized = true;
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async prompt(message: string): Promise<AcpTurnResult> {
    const start = await this.start();
    if (this.promptActive) throw new Error(`A ${this.profile.displayName} ACP prompt is already active`);
    if (!String(message || '').trim()) throw new Error(`${this.profile.displayName} ACP prompt cannot be empty`);

    this.fullText = '';
    this.fullTextBytes = 0;
    this.tools.clear();
    this.seenEventIds.clear();
    this.promptActive = true;
    let result: unknown;
    try {
      result = await this.request('session/prompt', {
        sessionId: start.nativeSessionId,
        prompt: [{ type: 'text', text: message }],
      }, this.promptTimeoutMs);
    } finally {
      this.promptActive = false;
    }

    if (this.aborted) throw new AgentAbortError();
    if (!isRecord(result)) throw new Error(`${this.profile.displayName} ACP session/prompt returned an invalid response`);
    const stopReason = cleanString(result.stopReason, 128).trim();
    if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(stopReason)) {
      throw new Error(`${this.profile.displayName} ACP session/prompt returned an unsupported stop reason`);
    }
    if (stopReason === 'cancelled') throw new AgentAbortError();

    return {
      ...this.startResult(),
      fullText: this.fullText.trim(),
      stopReason,
      usage: isRecord(result.usage) ? result.usage : undefined,
    };
  }

  async setModel(model: string): Promise<AcpModelState> {
    const requested = safeModelId(model);
    if (!requested) throw new Error(`${this.profile.displayName} model id is invalid`);
    await this.start();
    const sessionId = this.requireSessionId();
    if (this.promptActive) throw new Error(`Cannot change the ${this.profile.displayName} model during an active prompt`);
    if (this.profile.modelControl === 'none' || this.profile.modelControl === 'launch') {
      throw new Error(`${this.profile.displayName} does not support live session model changes`);
    }
    if (this.modelState.availableModels.length > 0
      && !this.modelState.availableModels.some((entry) => entry.id === requested)) {
      throw new Error(`${this.profile.displayName} did not advertise model ${requested}`);
    }

    let result: unknown;
    if (this.profile.modelControl === 'session-model') {
      result = await this.request('session/set_model', {
        sessionId,
        modelId: requested,
      }, this.controlTimeoutMs);
    } else {
      result = await this.request('session/set_config_option', {
        sessionId,
        configId: this.profile.modelConfigOptionId || 'model',
        value: requested,
      }, this.controlTimeoutMs);
    }

    let readback = parseModelState(result, this.profile);
    if (readback.currentModelId !== requested) {
      const loaded = await this.request('session/load', {
        sessionId,
        cwd: this.options.cwd,
        mcpServers: [],
      }, this.controlTimeoutMs);
      readback = parseModelState(loaded, this.profile);
    }
    if (readback.currentModelId !== requested) {
      throw new Error(`${this.profile.displayName} did not confirm model ${requested}`);
    }
    this.modelState = readback;
    return this.currentModelState;
  }

  async listSessions(cursor?: string | null): Promise<AcpSessionListResult> {
    await this.start();
    if (!this.profile.supportsSessionList) {
      throw new Error(`${this.profile.displayName} does not support ACP session listing`);
    }
    const normalizedCursor = typeof cursor === 'string' && cursor.trim()
      ? cleanString(cursor, 2_048).trim()
      : null;
    const result = await this.request('session/list', {
      cwd: this.options.cwd,
      ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
    }, this.controlTimeoutMs);
    if (!isRecord(result)) throw new Error(`${this.profile.displayName} ACP session/list returned an invalid response`);
    const sessions = Array.isArray(result.sessions)
      ? result.sessions.slice(0, ACP_MAX_SESSION_ROWS).filter(isRecord)
      : [];
    return {
      sessions,
      nextCursor: typeof result.nextCursor === 'string'
        ? cleanString(result.nextCursor, 2_048).trim() || null
        : null,
    };
  }

  async closeSession(): Promise<void> {
    await this.start();
    if (!this.profile.supportsSessionClose) {
      throw new Error(`${this.profile.displayName} does not support ACP session close`);
    }
    await this.request('session/close', {
      sessionId: this.requireSessionId(),
    }, this.controlTimeoutMs);
  }

  abort(): boolean {
    if (!this.child) return false;
    if (this.aborted) return true;
    this.aborted = true;
    if (!this.promptActive || !this.nativeSessionId) {
      this.rejectPending(new AgentAbortError());
      signalProcessGroup(this.child, 'SIGTERM');
      return true;
    }
    try {
      this.write({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this.nativeSessionId },
      });
    } catch {
      // A disappearing stdin is already an abort condition. Keep cancellation
      // non-throwing and terminate the entire detached process group.
      this.rejectPending(new AgentAbortError());
      signalProcessGroup(this.child, 'SIGTERM');
      return true;
    }
    this.options.onStatus?.({
      type: 'status',
      content: `Cancelling ${this.profile.displayName}…`,
      provider: this.profile.providerTag,
    });
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => {
      if (this.child) signalProcessGroup(this.child, 'SIGTERM');
      this.killTimer = setTimeout(() => {
        if (this.child) signalProcessGroup(this.child, 'SIGKILL');
      }, 1_000);
      this.killTimer.unref?.();
    }, this.cancelGraceMs);
    this.cancelTimer.unref?.();
    return true;
  }

  async dispose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.disposeOnce();
    return this.closePromise;
  }

  private async disposeOnce(): Promise<void> {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.cancelTimer = null;
    this.killTimer = null;
    const child = this.child;
    if (!child) return;
    try { child.stdin.end(); } catch {}

    await new Promise<void>((resolve) => {
      let settled = false;
      let termTimer: ReturnType<typeof setTimeout>;
      let killTimer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        child.off('close', finish);
        resolve();
      };
      child.once('close', finish);
      termTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), this.closeGraceMs);
      killTimer = setTimeout(finish, this.closeGraceMs + 1_000);
      termTimer.unref?.();
      killTimer.unref?.();
      signalProcessGroup(child, 'SIGTERM');
    });
    if (this.child === child) this.child = null;
    child.stdin.off('error', this.onStdinError);
    child.stdout.off('data', this.onStdoutData);
    child.stderr.off('data', this.onStderrData);
    child.off('error', this.onProcessError);
    child.off('close', this.onProcessClose);
  }

  private startResult(): AcpSessionStartResult {
    return {
      nativeSessionId: this.requireSessionId(),
      modelState: this.currentModelState,
      initialModelId: this.initialModelId,
      agentName: this.agentName,
      agentVersion: this.agentVersion,
      protocolVersion: this.profile.protocolVersion,
    };
  }

  private requireSessionId(): string {
    if (!this.nativeSessionId) throw new Error(`${this.profile.displayName} ACP session is missing after initialization`);
    return this.nativeSessionId;
  }

  private normalizeSessionId(value: unknown): string | null {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return candidate && this.profile.sessionIdPattern.test(candidate) ? candidate : null;
  }

  private validateInitialize(value: unknown): void {
    if (!isRecord(value)) throw new Error(`${this.profile.displayName} ACP initialize returned an invalid response`);
    if (value.protocolVersion !== this.profile.protocolVersion) {
      throw new Error(`${this.profile.displayName} ACP protocol mismatch: expected ${this.profile.protocolVersion}`);
    }
    const agentInfo = isRecord(value.agentInfo) ? value.agentInfo : {};
    const meta = isRecord(value._meta) ? value._meta : {};
    const agentName = this.profile.agentVersionSource === 'agent-info'
      ? cleanString(agentInfo.name, 128).trim()
      : this.profile.expectedAgentName || '';
    const agentVersion = this.profile.agentVersionSource === 'agent-info'
      ? cleanString(agentInfo.version, 128).trim()
      : cleanString(meta.agentVersion, 128).trim();
    if (this.profile.expectedAgentName && agentName !== this.profile.expectedAgentName) {
      throw new Error(`${this.profile.displayName} ACP agent mismatch: expected ${this.profile.expectedAgentName}, received ${agentName || 'unknown'}`);
    }
    if (agentVersion !== this.profile.expectedAgentVersion) {
      throw new Error(`${this.profile.displayName} ACP agent mismatch: expected ${this.profile.expectedAgentVersion}, received ${agentVersion || 'unknown'}`);
    }
    const capabilities = isRecord(value.agentCapabilities) ? value.agentCapabilities : {};
    for (const capability of this.profile.requiredCapabilities) {
      if (!capabilityIsAdvertised(capabilityAtPath(capabilities, capability))) {
        if (capability === 'loadSession') {
          throw new Error(`${this.profile.displayName} ACP does not advertise required persisted-session loading`);
        }
        throw new Error(`${this.profile.displayName} ACP does not advertise required capability ${capability}`);
      }
    }
    this.agentName = agentName || this.profile.displayName;
    this.agentVersion = agentVersion;
  }

  private resolveAuthenticationMethod(value: unknown): string | null {
    const policy = this.profile.authentication;
    if (policy.kind === 'none') return null;
    const methods = isRecord(value) && Array.isArray(value.authMethods)
      ? value.authMethods.slice(0, 64).filter(isRecord)
      : [];
    if (policy.kind === 'fixed') {
      const advertised = methods.some((method) => safeAuthMethodId(method.id) === policy.methodId);
      if (!advertised) {
        throw new Error(`${this.profile.displayName} ACP did not advertise required authentication method ${policy.methodId}`);
      }
      return policy.methodId;
    }

    const excluded = new Set(policy.excludedMethodIds);
    for (const method of methods) {
      const methodId = safeAuthMethodId(method.id);
      if (!methodId || excluded.has(methodId) || method.type === 'terminal') continue;
      const meta = isRecord(method._meta) ? method._meta : {};
      if (isRecord(meta['terminal-auth'])) continue;
      return methodId;
    }
    throw new Error(`${this.profile.displayName} ACP did not advertise an authenticated runtime method`);
  }

  private request(method: string, params: UnknownRecord, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.protocolFailed) {
      return Promise.reject(new Error(`${this.profile.displayName} ACP process is not available`));
    }
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${this.profile.displayName} ACP ${method} timed out`));
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
      throw new Error(`${this.profile.displayName} ACP stdin is unavailable`);
    }
    const line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line, 'utf8') > ACP_MAX_LINE_BYTES) {
      throw new Error(`${this.profile.displayName} ACP outbound message exceeded the protocol bound`);
    }
    this.child.stdin.write(line);
  }

  private readonly onStdoutData = (data: Buffer | string): void => {
    if (this.protocolFailed) return;
    this.stdoutBuffer += typeof data === 'string' ? data : this.stdoutDecoder.write(data);
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > ACP_MAX_LINE_BYTES) {
        this.failProtocol(new Error(`${this.profile.displayName} ACP emitted an oversized JSON-RPC line`));
        return;
      }
      if (line.trim()) {
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (this.queuedInboundMessages >= ACP_MAX_QUEUED_MESSAGES
          || this.queuedInboundBytes + lineBytes > ACP_MAX_QUEUED_BYTES) {
          this.failProtocol(new Error(`${this.profile.displayName} ACP exceeded the inbound queue bound`));
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(line);
          if (!isRecord(payload)) throw new Error('message is not an object');
        } catch (error: any) {
          this.failProtocol(new Error(`${this.profile.displayName} ACP emitted invalid JSON-RPC: ${error?.message || error}`));
          return;
        }
        this.queuedInboundMessages += 1;
        this.queuedInboundBytes += lineBytes;
        this.inboundChain = this.inboundChain
          .then(() => this.handleMessage(payload as UnknownRecord))
          .catch((error: any) => {
            this.failProtocol(error instanceof Error ? error : new Error(String(error)));
          })
          .finally(() => {
            this.queuedInboundMessages = Math.max(0, this.queuedInboundMessages - 1);
            this.queuedInboundBytes = Math.max(0, this.queuedInboundBytes - lineBytes);
          });
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > ACP_MAX_LINE_BYTES) {
      this.failProtocol(new Error(`${this.profile.displayName} ACP emitted an oversized JSON-RPC line`));
    }
  };

  private readonly onStderrData = (data: Buffer | string): void => {
    if (this.stderr.length >= ACP_MAX_STDERR_BYTES) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.stderr = Buffer.concat([
      this.stderr,
      bytes.subarray(0, ACP_MAX_STDERR_BYTES - this.stderr.length),
    ]);
  };

  private readonly onProcessError = (error: Error): void => {
    this.failProtocol(new Error(`${this.profile.displayName} ACP process error: ${error.message}`));
  };

  private readonly onStdinError = (error: Error): void => {
    // Writable-stream failures (most commonly EPIPE after an upstream crash)
    // do not necessarily surface through ChildProcess#error. Owning the
    // stream error keeps Node from treating it as an uncaught exception and
    // rejects every outstanding JSON-RPC request immediately.
    if (this.closePromise) return;
    this.failProtocol(new Error(`${this.profile.displayName} ACP stdin error: ${error.message}`));
  };

  private readonly onProcessClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!this.child) return;
    this.child = null;
    if (this.pending.size === 0) return;
    const stderr = this.stderr.toString('utf8').trim();
    const suffix = stderr ? `: ${cleanString(stderr, 2_048)}` : '';
    const error = this.aborted
      ? new AgentAbortError()
      : new Error(`${this.profile.displayName} ACP process exited before the request completed (code ${code ?? 'null'}, signal ${signal || 'none'})${suffix}`);
    this.rejectPending(error);
  };

  private async handleMessage(payload: UnknownRecord): Promise<void> {
    if (payload.jsonrpc !== '2.0') {
      throw new Error(`${this.profile.displayName} ACP emitted a message without jsonrpc 2.0`);
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
        pending.reject(new Error(`${this.profile.displayName} ACP ${pending.method} failed: ${cleanString(payload.error.message || payload.error)}`));
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
    const toolCallId = cleanString(toolCall.toolCallId, 256).trim();
    if (!toolCallId || options.length === 0 || !this.options.onPermission) {
      this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    let decision: AcpPermissionDecision = 'deny';
    try {
      decision = await this.options.onPermission({
        sessionId: activeSessionId,
        toolCallId,
        title: cleanString(toolCall.title, 512).trim() || `${this.profile.displayName} tool request`,
        kind: cleanString(toolCall.kind, 128).trim() || 'tool',
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
    const eventId = cleanString(meta.eventId, 512).trim();
    if (eventId) {
      if (this.seenEventIds.has(eventId)) return;
      if (this.seenEventIds.size >= 20_000) this.seenEventIds.clear();
      this.seenEventIds.add(eventId);
    }
    const update = isRecord(params.update) ? params.update : null;
    if (update) this.handleSessionUpdate(update);
  }

  private handleSessionUpdate(update: UnknownRecord): void {
    const type = cleanString(update.sessionUpdate, 128).trim();
    if (type === 'agent_message_chunk') {
      const chunk = normalizeContentText(update.content);
      if (!chunk) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (this.fullTextBytes + chunkBytes > ACP_MAX_TEXT_BYTES) {
        this.failProtocol(new Error(`${this.profile.displayName} ACP assistant text exceeded the response bound`));
        return;
      }
      this.fullText += chunk;
      this.fullTextBytes += chunkBytes;
      this.options.onChunk?.(chunk);
      return;
    }
    if (type === 'agent_thought_chunk') {
      const thought = normalizeContentText(update.content);
      if (thought) this.options.onStatus?.({
        type: 'thinking',
        content: thought,
        provider: this.profile.providerTag,
      });
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
      const plan = type === 'plan_removed' ? [] : boundedStructuredValue(update.entries || update.plan || []);
      const planId = 'acp-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      // Project the harness's own plan into the shared, structured tool lane.
      this.options.onStatus?.({ type: 'tool_start', content: 'Updated task plan',
        toolCallId: planId, toolName: 'update_plan', toolArgs: { plan }, provider: this.profile.providerTag });
      this.options.onStatus?.({ type: 'tool_end', content: 'Task plan updated',
        toolCallId: planId, toolName: 'update_plan', status: 'completed', provider: this.profile.providerTag });
    }
  }

  private handleToolCall(update: UnknownRecord, isUpdate: boolean): void {
    const id = cleanString(update.toolCallId, 256).trim();
    if (!id) return;
    const existing = this.tools.get(id);
    if (!existing && this.tools.size >= ACP_MAX_TOOL_STATES) {
      this.failProtocol(new Error(`${this.profile.displayName} ACP exceeded the tool-state bound`));
      return;
    }
    const next: ToolState = {
      id,
      name: safeToolName(update.kind ?? existing?.name, update.title ?? existing?.title, `${this.profile.providerTag}-tool`),
      title: cleanString(update.title ?? existing?.title, 512).trim()
        || existing?.title
        || `${this.profile.displayName} tool`,
      rawInput: update.rawInput !== undefined
        ? boundedStructuredValue(update.rawInput)
        : existing?.rawInput,
      rawOutput: update.rawOutput !== undefined
        ? boundedStructuredValue(update.rawOutput)
        : update.content !== undefined
          ? boundedStructuredValue(update.content)
          : existing?.rawOutput,
      status: cleanString(update.status ?? existing?.status, 64).trim() || existing?.status,
    };
    this.tools.set(id, next);
    const terminal = ['completed', 'failed', 'cancelled'].includes(String(next.status || '').toLowerCase());
    if (terminal) {
      this.options.onStatus?.({
        type: 'tool_end',
        content: cleanString(next.rawOutput) || next.title,
        toolCallId: id,
        toolName: next.name,
        toolResult: cleanString(next.rawOutput),
        status: next.status,
        provider: this.profile.providerTag,
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
      provider: this.profile.providerTag,
    });
  }

  private failProtocol(error: Error): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.rejectPending(error);
    if (this.child) signalProcessGroup(this.child, 'SIGTERM');
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
