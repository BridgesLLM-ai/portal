import crypto from 'crypto';
import type {
  AgentMessage,
  AgentProvider,
  AgentProviderName,
  AgentSendResult,
  AgentSessionConfig,
  AgentSessionId,
  AgentSessionSummary,
  AttestedProjectRuntimeCleanup,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  ProjectSandboxExecutionContext,
  SenderIdentity,
} from '../../AgentProvider.interface';
import { AgentAbortError } from '../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../executionScope';
import {
  appendNativeMessage,
  clearNativeSessionHistory,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  readAllNativeSessionHistory,
  updateNativeSessionMetadata,
  type NativeSessionData,
} from '../NativeSessionStore';
import {
  openOllamaProjectModelBridge,
  type OllamaProjectChatMessage,
  type OllamaProjectModelBridgeClient,
  type OllamaProjectModelBridgeHandle,
  type OllamaProjectModelBridgeOptions,
  type OllamaProjectToolDefinition,
} from './OllamaProjectModelBridge';
import type { OllamaProjectBackendIdentity } from '../../../services/ollamaProjectModel';
import { withOllamaAuthorityRunLease } from '../../../services/ollamaAuthorityBarrier';
import {
  OLLAMA_PROJECT_RUNTIME,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  OLLAMA_PROJECT_TOOL_NAMES,
  OllamaProjectRuntimeTerminationError,
  OllamaProjectToolRuntime,
  type OllamaProjectToolName,
  type OllamaProjectToolResult,
} from './OllamaProjectToolRuntime';

const MAX_MESSAGE_LENGTH = 200_000;
const MAX_RESPONSE_LENGTH = 4 * 1024 * 1024;
const MAX_THINKING_LENGTH = 4 * 1024 * 1024;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_NODES = 16_384;
const MAX_STREAM_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_RECORDS = 100_000;
const CONTEXT_MESSAGES = 80;
const PROJECT_PROVIDER_METADATA = 'ollama-project-coding-agent';
const MODEL_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STREAM_METRIC_KEYS = Object.freeze([
  'total_duration',
  'load_duration',
  'prompt_eval_count',
  'prompt_eval_duration',
  'eval_count',
  'eval_duration',
] as const);
export const OLLAMA_PROJECT_CAPABILITY_PROBE_TOOL = 'portal_capability_probe';

export interface OllamaProjectToolCall {
  id: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaProjectStreamResult {
  content: string;
  thinking: string;
  toolCalls: OllamaProjectToolCall[];
  doneReason?: string;
  metrics?: Readonly<Record<string, number>>;
}

export interface OllamaProjectModelProof {
  model: string;
  digest: string;
  capabilities: readonly string[];
  backendKind: 'LOCAL' | 'TAILNET';
  backendFingerprint: string;
  backendGeneration: number | null;
  toolProbe: true;
}

type BridgeFactory = (input: {
  context: ProjectSandboxExecutionContext;
  sessionId: string;
  model: string;
  modelDigest: string;
  backend: OllamaProjectBackendIdentity;
  allowedToolNames: readonly string[];
  options?: OllamaProjectModelBridgeOptions;
}) => Promise<OllamaProjectModelBridgeHandle>;

export interface OllamaProjectProviderOptions {
  runtime?: OllamaProjectToolRuntime;
  bridgeFactory?: BridgeFactory;
  bridgeOptions?: OllamaProjectModelBridgeOptions;
  idFactory?: () => string;
}

interface ActiveRun {
  controller: AbortController;
  context: ProjectSandboxExecutionContext;
  bridge: OllamaProjectModelBridgeHandle | null;
  runId: string | null;
  abortPromise: Promise<boolean> | null;
  quarantined: boolean;
  sendSettled: boolean;
}

const PROJECT_TOOLS: readonly OllamaProjectToolDefinition[] = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'project_list',
      description: 'List files and directories inside the current project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative directory; defaults to .' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_read',
      description: 'Read a bounded line range from a UTF-8 project file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          line_count: { type: 'integer', minimum: 1, maximum: 2000 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_write',
      description: 'Atomically create or replace one project file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_edit',
      description: 'Atomically replace one exact, unique text occurrence in a project file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_search',
      description: 'Search bounded project text files with a literal string or regular expression.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          regex: { type: 'boolean' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_exec',
      description: 'Run a bounded shell command or test inside the networkless project container.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 120 },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
]);

const CAPABILITY_TOOL: OllamaProjectToolDefinition = Object.freeze({
  type: 'function',
  function: {
    name: OLLAMA_PROJECT_CAPABILITY_PROBE_TOOL,
    description: 'Return the supplied qualification nonce.',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
      additionalProperties: false,
    },
  },
});

function cleanModel(value: unknown): string {
  const model = String(value || '').trim();
  if (!MODEL_RE.test(model)) throw new Error('Select an exact installed Ollama model for Project Chat.');
  return model;
}

function cleanSessionId(value: unknown): string {
  const sessionId = String(value || '').trim();
  if (!SESSION_RE.test(sessionId)) throw new Error('Ollama Project session identity is invalid.');
  return sessionId;
}

function projectContext(session: NativeSessionData): ProjectSandboxExecutionContext {
  assertExecutionContextBinding(session.executionContext, session.userId, 'PROJECT_SANDBOX');
  return session.executionContext as ProjectSandboxExecutionContext;
}

function requireProjectSession(
  sessionId: string,
  options: { allowQuarantined?: boolean } = {},
): NativeSessionData {
  const id = cleanSessionId(sessionId);
  const session = loadNativeSession('OLLAMA', id);
  if (!session) throw new Error('Ollama Project session not found: ' + id);
  projectContext(session);
  if (session.metadata?.projectRuntime !== OLLAMA_PROJECT_RUNTIME
    || session.metadata?.projectProvider !== PROJECT_PROVIDER_METADATA) {
    throw new Error('Ollama session is not bound to the confined Project coding adapter.');
  }
  if (session.metadata?.ollamaRuntimeQuarantined === true && !options.allowQuarantined) {
    throw new Error(
      'Ollama Project runtime is quarantined because its last hard-stop could not be verified.',
    );
  }
  return session;
}

function assertJsonSafeToolArguments(value: Record<string, unknown>): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > MAX_TOOL_ARGUMENT_NODES) {
      throw new Error('Ollama tool arguments exceeded the safety limit.');
    }
    if (
      current === null
      || typeof current === 'string'
      || typeof current === 'boolean'
    ) {
      continue;
    }
    if (typeof current === 'number') {
      if (
        !Number.isFinite(current)
        || Math.abs(current) > Number.MAX_SAFE_INTEGER
        || Object.is(current, -0)
      ) {
        throw new Error('Ollama returned unsafe tool arguments.');
      }
      continue;
    }
    if (typeof current !== 'object') {
      throw new Error('Ollama returned unsafe tool arguments.');
    }
    if (
      !Array.isArray(current)
      && Object.getPrototypeOf(current) !== Object.prototype
      && Object.getPrototypeOf(current) !== null
    ) {
      throw new Error('Ollama returned unsafe tool arguments.');
    }
    const values = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    for (const nested of values) {
      if (visited + pending.length >= MAX_TOOL_ARGUMENT_NODES) {
        throw new Error('Ollama tool arguments exceeded the safety limit.');
      }
      pending.push(nested);
    }
  }
}

function cleanToolCalls(value: unknown): OllamaProjectToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error('Ollama returned an invalid tool-call list.');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Ollama returned an invalid tool call.');
    }
    const entry = raw as Record<string, unknown>;
    const fn = entry.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
      throw new Error('Ollama returned an invalid tool call.');
    }
    const functionEntry = fn as Record<string, unknown>;
    const name = typeof functionEntry.name === 'string'
      ? functionEntry.name.trim()
      : '';
    const args = functionEntry.arguments;
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Ollama returned an invalid tool call.');
    }
    assertJsonSafeToolArguments(args as Record<string, unknown>);
    let encodedArguments: string;
    try {
      encodedArguments = JSON.stringify(args);
    } catch {
      throw new Error('Ollama returned an invalid tool call.');
    }
    if (Buffer.byteLength(encodedArguments, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
      throw new Error('Ollama tool arguments exceeded the safety limit.');
    }
    if (entry.id !== undefined && typeof entry.id !== 'string') {
      throw new Error('Ollama returned an invalid tool call.');
    }
    const suppliedId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (
      suppliedId
      && (
        Buffer.byteLength(suppliedId, 'utf8') > 128
        || /[\u0000-\u001f\u007f]/u.test(suppliedId)
      )
    ) {
      throw new Error('Ollama returned an invalid tool call.');
    }
    const id = suppliedId
      ? suppliedId
      : 'ollama-tool-' + index + '-' + crypto.createHash('sha256')
        .update(name)
        .update('\0')
        .update(encodedArguments)
        .digest('hex')
        .slice(0, 20);
    return { id, function: { name, arguments: args as Record<string, unknown> } };
  });
}

function boundedRemoteError(value: string): string | null {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, 2_048);
}

function appendBounded(current: string, chunk: string, maximum: number, label: string): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') > maximum) throw new Error(label + ' exceeded the safety limit.');
  return combined;
}

export async function readOllamaProjectChatStream(
  response: Response,
  callbacks: { onContent?: (chunk: string) => void; onThinking?: (chunk: string) => void } = {},
): Promise<OllamaProjectStreamResult> {
  if (!response.body) throw new Error('Ollama Project chat response did not contain a stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  let buffer = '';
  let content = '';
  let thinking = '';
  let doneReason: string | undefined;
  let metrics: Record<string, number> | undefined;
  let terminal = false;
  let records = 0;
  let streamToolCallCount = 0;
  const toolCalls = new Map<string, OllamaProjectToolCall>();

  const consume = (line: string): boolean => {
    if (!line.trim()) {
      throw new Error('Ollama Project chat returned an invalid NDJSON record.');
    }
    if (terminal) {
      throw new Error('Ollama Project chat returned data after its terminal record.');
    }
    if (records >= MAX_STREAM_RECORDS) {
      throw new Error('Ollama Project chat returned too many stream records.');
    }
    records += 1;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error('Ollama Project chat returned invalid NDJSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Ollama Project chat returned an invalid NDJSON record.');
    }
    const record = parsed as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'error')) {
      if (typeof record.error !== 'string' || !record.error.trim()) {
        throw new Error('Ollama Project chat returned an invalid error record.');
      }
      const remoteError = boundedRemoteError(record.error);
      if (!remoteError) {
        throw new Error('Ollama Project chat returned an invalid error record.');
      }
      throw new Error(
        'Ollama Project model error: ' + remoteError,
      );
    }
    if (typeof record.done !== 'boolean') {
      throw new Error('Ollama Project chat returned a record without a valid done flag.');
    }

    if (
      !record.message
      || typeof record.message !== 'object'
      || Array.isArray(record.message)
    ) {
      throw new Error('Ollama Project chat returned an invalid message record.');
    }
    const message = record.message as Record<string, unknown>;
    if (message.role !== 'assistant') {
      throw new Error('Ollama Project chat returned an invalid message role.');
    }
    if (
      message.thinking !== undefined
      && typeof message.thinking !== 'string'
    ) {
      throw new Error('Ollama Project chat returned invalid thinking content.');
    }
    if (
      message.content !== undefined
      && typeof message.content !== 'string'
    ) {
      throw new Error('Ollama Project chat returned invalid message content.');
    }

    let nextDoneReason: string | undefined;
    if (record.done_reason !== undefined) {
      if (
        typeof record.done_reason !== 'string'
        || !record.done_reason.trim()
        || Buffer.byteLength(record.done_reason, 'utf8') > 128
        || /[\u0000-\u001f\u007f]/u.test(record.done_reason)
      ) {
        throw new Error('Ollama Project chat returned an invalid done reason.');
      }
      nextDoneReason = record.done_reason;
    }
    const nextMetrics: Record<string, number> = {};
    for (const key of STREAM_METRIC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const value = record[key];
      if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < 0
        || Object.is(value, -0)
      ) {
        throw new Error('Ollama Project chat returned invalid final metrics.');
      }
      nextMetrics[key] = value;
    }

    const nextThinking = typeof message.thinking === 'string'
      ? message.thinking
      : '';
    const nextContent = typeof message.content === 'string'
      ? message.content
      : '';
    const nextToolCalls = cleanToolCalls(message.tool_calls);
    const updatedThinking = nextThinking
      ? appendBounded(
        thinking,
        nextThinking,
        MAX_THINKING_LENGTH,
        'Ollama thinking',
      )
      : thinking;
    const updatedContent = nextContent
      ? appendBounded(
        content,
        nextContent,
        MAX_RESPONSE_LENGTH,
        'Ollama response',
      )
      : content;
    if (streamToolCallCount + nextToolCalls.length > MAX_TOOL_CALLS) {
      throw new Error('Ollama Project chat returned too many tool calls.');
    }
    streamToolCallCount += nextToolCalls.length;

    thinking = updatedThinking;
    content = updatedContent;
    if (nextThinking) callbacks.onThinking?.(nextThinking);
    if (nextContent) callbacks.onContent?.(nextContent);
    for (const call of nextToolCalls) toolCalls.set(call.id, call);
    if (record.done) {
      doneReason = nextDoneReason;
      metrics = nextMetrics;
      terminal = true;
    }
    return terminal;
  };

  try {
    stream: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw new Error('Ollama Project chat returned invalid UTF-8.');
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_STREAM_LINE_BYTES) throw new Error('Ollama Project stream frame exceeded the safety limit.');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (consume(line)) {
          if (buffer.length > 0) {
            throw new Error('Ollama Project chat returned data after its terminal record.');
          }
          try {
            if (decoder.decode().length > 0) {
              throw new Error(
                'Ollama Project chat returned data after its terminal record.',
              );
            }
          } catch (error) {
            if (
              error instanceof Error
              && /data after its terminal record/u.test(error.message)
            ) {
              throw error;
            }
            throw new Error('Ollama Project chat returned invalid UTF-8.');
          }
          // This closes only the loopback bridge response associated with this
          // turn. Protocol completion must not be reclassified as user abort.
          void reader.cancel().catch(() => undefined);
          break stream;
        }
      }
    }
    if (!terminal) {
      try {
        buffer += decoder.decode();
      } catch {
        throw new Error('Ollama Project chat returned invalid UTF-8.');
      }
      if (buffer.trim()) consume(buffer);
    }
    if (!terminal) {
      throw new Error(
        'Ollama Project chat ended before its terminal done record.',
      );
    }
  } finally {
    reader.releaseLock();
  }
  return { content, thinking, toolCalls: [...toolCalls.values()], doneReason, metrics };
}

function exactInstalledModel(tags: any, model: string): { digest: string } {
  const models = Array.isArray(tags?.models) ? tags.models : [];
  const matches = models.filter((entry: any) => entry?.name === model || entry?.model === model);
  if (matches.length !== 1) throw new Error('The exact selected Ollama model is not installed: ' + model);
  const digest = String(matches[0]?.digest || '').trim().toLowerCase();
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(digest)) throw new Error('Installed Ollama model digest is unavailable or invalid.');
  return { digest: `sha256:${digest.replace(/^sha256:/, '')}` };
}

function exactModelDigest(value: unknown): `sha256:${string}` {
  const match = String(value || '').trim().match(/^(?:sha256:)?([a-f0-9]{64})$/iu);
  if (!match) {
    throw new Error(
      'Ollama Project model digest is missing or invalid; qualify the model again.',
    );
  }
  return `sha256:${match[1].toLowerCase()}`;
}

function modelCapabilities(show: any): string[] {
  const capabilities: string[] = Array.isArray(show?.capabilities)
    ? show.capabilities.map((value: unknown) => String(value || '').trim()).filter((value: string) => Boolean(value))
    : [];
  return [...new Set(capabilities)].sort();
}

function requireBackendIdentity(
  value: Record<string, unknown> | null | undefined,
): OllamaProjectBackendIdentity {
  const backendKind = value?.ollamaBackendKind;
  const backendFingerprint = String(value?.ollamaBackendFingerprint || '').trim();
  const backendGeneration = value?.ollamaBackendGeneration;
  if (
    backendKind === undefined
    && !backendFingerprint
    && backendGeneration === undefined
  ) {
    return Object.freeze({
      backendKind: 'LOCAL' as const,
      backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      backendGeneration: null,
    });
  }
  if (
    (backendKind !== 'LOCAL' && backendKind !== 'TAILNET')
    || !/^[^\u0000-\u001f\u007f]{1,256}$/.test(backendFingerprint)
    || (backendKind === 'LOCAL' && backendGeneration !== null)
    || (
      backendKind === 'TAILNET'
      && (
        !Number.isSafeInteger(backendGeneration)
        || Number(backendGeneration) < 1
      )
    )
  ) {
    throw new Error('Ollama Project backend identity is missing or invalid; qualify the model again.');
  }
  return Object.freeze({
    backendKind,
    backendFingerprint,
    backendGeneration: backendGeneration as number | null,
  });
}

export async function proveOllamaProjectModel(input: {
  client: OllamaProjectModelBridgeClient;
  model: string;
  signal?: AbortSignal;
  nonceFactory?: () => string;
}): Promise<OllamaProjectModelProof> {
  const model = cleanModel(input.model);
  const tags = await input.client.listModels(input.signal);
  const installed = exactInstalledModel(tags, model);
  const show = await input.client.showModel(input.signal);
  const capabilities = modelCapabilities(show);
  if (!capabilities.includes('tools')) throw new Error('Selected Ollama model does not advertise native tool calling: ' + model);

  const nonce = input.nonceFactory?.() || crypto.randomBytes(16).toString('hex');
  const probeResponse = await input.client.chat({
    model,
    stream: true,
    think: false,
    messages: [
      { role: 'system', content: 'You are a capability probe. Call the requested tool exactly once and do not answer in text.' },
      { role: 'user', content: 'Call portal_capability_probe with nonce ' + nonce + '.' },
    ],
    tools: [CAPABILITY_TOOL],
    options: { temperature: 0 },
  }, input.signal);
  const probe = await readOllamaProjectChatStream(probeResponse);
  const calls = probe.toolCalls.filter((call) => call.function.name === OLLAMA_PROJECT_CAPABILITY_PROBE_TOOL);
  if (calls.length !== 1 || calls[0].function.arguments.nonce !== nonce) {
    throw new Error('Selected Ollama model did not prove native tool-call capability.');
  }
  return Object.freeze({
    model,
    digest: installed.digest,
    capabilities: Object.freeze(capabilities),
    backendKind: input.client.backendKind,
    backendFingerprint: input.client.backendFingerprint,
    backendGeneration: input.client.backendGeneration,
    toolProbe: true as const,
  });
}

function systemPrompt(): string {
  return [
    'You are a coding agent confined to one project workspace.',
    'Use the provided project tools to inspect and modify the code; never claim a change without using tools.',
    'Run relevant tests after edits. All paths must be project-relative.',
    'The execution tool is networkless and cannot reach the host, private networks, metadata services, or the public internet.',
    'Keep tool calls focused and finish with a concise summary of changes and tests.',
  ].join(' ');
}

function transcriptMessages(session: NativeSessionData): OllamaProjectChatMessage[] {
  const history = session.messages.slice(-CONTEXT_MESSAGES).map((message): OllamaProjectChatMessage => ({
    role: message.role === 'system' ? 'system' : message.role,
    content: message.content,
  }));
  return [{ role: 'system', content: systemPrompt() }, ...history];
}

function toolResultMessage(name: string, result: OllamaProjectToolResult): OllamaProjectChatMessage {
  return {
    role: 'tool',
    tool_name: name,
    content: JSON.stringify({ ok: result.ok, output: result.output, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }) }),
  };
}

function sameModelProof(
  session: NativeSessionData,
  proof: {
    model: string;
    digest: string;
    capabilities: readonly string[];
    backendKind: 'LOCAL' | 'TAILNET';
    backendFingerprint: string;
    backendGeneration: number | null;
  },
): void {
  const expectedBackend = requireBackendIdentity(session.metadata);
  if (
    cleanModel(session.model) !== proof.model
    || session.metadata?.ollamaModelDigest !== proof.digest
    || session.metadata?.ollamaToolQualified !== true
    || expectedBackend.backendKind !== proof.backendKind
    || expectedBackend.backendFingerprint !== proof.backendFingerprint
    || expectedBackend.backendGeneration !== proof.backendGeneration
    || !proof.capabilities.includes('tools')
  ) {
    throw new Error('Ollama Project model identity or tool qualification changed; start a new qualified session.');
  }
}

export class OllamaProjectProvider implements AgentProvider {
  readonly displayName = 'Ollama (Project Coding Sandbox)';
  readonly providerName: AgentProviderName = 'OLLAMA';

  private readonly runtime: OllamaProjectToolRuntime;
  private readonly bridgeFactory: BridgeFactory;
  private readonly bridgeOptions?: OllamaProjectModelBridgeOptions;
  private readonly idFactory: () => string;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeProjects = new Map<string, string>();
  private readonly quarantinedProjects = new Map<string, string>();

  constructor(options: OllamaProjectProviderOptions = {}) {
    this.runtime = options.runtime || new OllamaProjectToolRuntime();
    this.bridgeFactory = options.bridgeFactory || openOllamaProjectModelBridge;
    this.bridgeOptions = options.bridgeOptions;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
  }

  private projectRunKey(context: ProjectSandboxExecutionContext): string {
    return crypto.createHash('sha256').update(JSON.stringify({ actor: context.userId, project: context.projectId })).digest('hex');
  }

  private releaseActiveRun(sessionId: string, active: ActiveRun): void {
    if (this.activeRuns.get(sessionId) === active) this.activeRuns.delete(sessionId);
    const projectKey = this.projectRunKey(active.context);
    if (this.activeProjects.get(projectKey) === sessionId) this.activeProjects.delete(projectKey);
  }

  private markQuarantined(session: NativeSessionData, reason: string): void {
    const context = projectContext(session);
    const projectKey = this.projectRunKey(context);
    this.quarantinedProjects.set(projectKey, session.sessionId);
    updateNativeSessionMetadata('OLLAMA', session.sessionId, {
      ollamaRuntimeQuarantined: true,
      ollamaQuarantineReason: reason,
      ollamaQuarantinedAt: new Date().toISOString(),
    });
  }

  private clearQuarantine(session: NativeSessionData): void {
    const projectKey = this.projectRunKey(projectContext(session));
    if (this.quarantinedProjects.get(projectKey) === session.sessionId) {
      this.quarantinedProjects.delete(projectKey);
    }
    updateNativeSessionMetadata('OLLAMA', session.sessionId, {
      ollamaRuntimeQuarantined: false,
      ollamaQuarantineReason: null,
      ollamaQuarantinedAt: null,
    });
  }

  private async recoverDurableQuarantine(
    userId: string,
    context: ProjectSandboxExecutionContext,
  ): Promise<void> {
    const projectKey = this.projectRunKey(context);
    if (this.activeProjects.has(projectKey)) {
      throw new Error('This project already has an active or quarantined Ollama coding turn.');
    }
    const quarantined = listNativeSessions('OLLAMA', userId)
      .map((summary) => loadNativeSession('OLLAMA', summary.sessionId))
      .filter((session): session is NativeSessionData => {
        if (!session || session.metadata?.ollamaRuntimeQuarantined !== true || !session.executionContext) {
          return false;
        }
        try {
          return this.projectRunKey(projectContext(session)) === projectKey;
        } catch {
          return false;
        }
      });
    if (quarantined.length === 0 && !this.quarantinedProjects.has(projectKey)) return;
    let stopped = false;
    try {
      stopped = await this.runtime.terminate(context) === true;
    } catch {
      stopped = false;
    }
    if (!stopped) {
      throw new Error(
        'Ollama Project runtime remains quarantined because exact termination could not be verified.',
      );
    }
    for (const session of quarantined) deleteNativeSession('OLLAMA', session.sessionId);
    this.quarantinedProjects.delete(projectKey);
  }

  private async openBridge(
    context: ProjectSandboxExecutionContext,
    sessionId: string,
    model: string,
    modelDigest: string,
    backend: OllamaProjectBackendIdentity,
  ): Promise<OllamaProjectModelBridgeHandle> {
    return this.bridgeFactory({
      context,
      sessionId,
      model,
      modelDigest: exactModelDigest(modelDigest),
      backend,
      allowedToolNames: [...OLLAMA_PROJECT_TOOL_NAMES, OLLAMA_PROJECT_CAPABILITY_PROBE_TOOL],
      options: this.bridgeOptions,
    });
  }

  async convergeAttestedProjectCleanup(input: AttestedProjectRuntimeCleanup): Promise<void> {
    const sessionIds = new Set(input.sessionIds.map((sessionId) => cleanSessionId(sessionId)));
    const projectKey = this.projectRunKey({
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: input.userId,
      projectId: input.projectId,
      workspaceOwnerId: '',
      projectName: '',
      canonicalRoot: input.canonicalRoot,
      rootDevice: input.rootDevice,
      rootInode: input.rootInode,
      rootBirthtimeNs: input.rootBirthtimeNs,
      runtimePolicyVersion: '',
      egressPolicyVersion: '',
      runtimeImageDigest: '',
      policyFingerprint: '',
    });
    for (const [sessionId, active] of this.activeRuns) {
      if (this.projectRunKey(active.context) !== projectKey) continue;
      if (
        !sessionIds.has(sessionId)
        || active.context.userId !== input.userId
        || active.context.projectId !== input.projectId
        || active.context.canonicalRoot !== input.canonicalRoot
        || active.context.rootDevice !== input.rootDevice
        || active.context.rootInode !== input.rootInode
        || active.context.rootBirthtimeNs !== input.rootBirthtimeNs
      ) {
        throw new Error('Ollama Project cleanup encountered a newer or differently-bound active run');
      }
      active.quarantined = true;
      active.controller.abort();
      await active.bridge?.close().catch(() => undefined);
      active.bridge = null;
      this.activeRuns.delete(sessionId);
    }
    for (const reservations of [this.activeProjects, this.quarantinedProjects]) {
      const sessionId = reservations.get(projectKey);
      if (!sessionId) continue;
      if (!sessionIds.has(sessionId)) {
        throw new Error('Ollama Project cleanup encountered a newer in-memory reservation');
      }
      reservations.delete(projectKey);
    }
  }

  async startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId> {
    return withOllamaAuthorityRunLease(
      () => this.startSessionWithAuthorityLease(userId, config),
    );
  }

  private async startSessionWithAuthorityLease(
    userId: string,
    config: AgentSessionConfig,
  ): Promise<AgentSessionId> {
    assertExecutionContextBinding(config.executionContext, userId, 'PROJECT_SANDBOX');
    const context = config.executionContext as ProjectSandboxExecutionContext;
    if (context.runtimePolicyVersion !== OLLAMA_PROJECT_RUNTIME_POLICY_VERSION) {
      throw new Error('Ollama Project execution context is not qualified for this runtime.');
    }
    await this.recoverDurableQuarantine(userId, context);
    const model = cleanModel(config.model);
    const modelDigest = exactModelDigest(config.metadata?.ollamaModelDigest);
    const backend = requireBackendIdentity(config.metadata);
    const session = createNativeSession('OLLAMA', userId, {
      ...config,
      model,
      metadata: {
        ...(config.metadata || {}),
        projectRuntime: OLLAMA_PROJECT_RUNTIME,
        projectProvider: PROJECT_PROVIDER_METADATA,
        ollamaBackendKind: backend.backendKind,
        ollamaBackendFingerprint: backend.backendFingerprint,
        ollamaBackendGeneration: backend.backendGeneration,
      },
    });
    let bridge: OllamaProjectModelBridgeHandle | null = null;
    try {
      const runtime = await this.runtime.ensure(context);
      bridge = await this.openBridge(
        context,
        session.sessionId,
        model,
        modelDigest,
        backend,
      );
      const proof = await proveOllamaProjectModel({ client: bridge.client, model });
      updateNativeSessionMetadata('OLLAMA', session.sessionId, {
        projectRuntime: OLLAMA_PROJECT_RUNTIME,
        projectProvider: PROJECT_PROVIDER_METADATA,
        projectRuntimeFingerprint: runtime.runtimeFingerprint,
        projectRuntimeImage: runtime.runtimeImage,
        ollamaModelDigest: proof.digest,
        ollamaCapabilities: proof.capabilities,
        ollamaToolQualified: true,
        ollamaBackendKind: proof.backendKind,
        ollamaBackendFingerprint: proof.backendFingerprint,
        ollamaBackendGeneration: proof.backendGeneration,
      });
      return session.sessionId;
    } catch (error) {
      let stopped = false;
      try {
        stopped = await this.runtime.terminate(context) === true;
      } catch {
        stopped = false;
      }
      if (stopped) {
        deleteNativeSession('OLLAMA', session.sessionId);
        throw error;
      }
      this.markQuarantined(session, 'SESSION_MODEL_PROOF_CLEANUP_UNCONFIRMED');
      throw new Error(
        'Ollama Project session qualification failed and runtime cleanup could not be verified; the project is quarantined.',
      );
    } finally {
      await bridge?.close().catch(() => undefined);
    }
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    _onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    return withOllamaAuthorityRunLease(
      () => this.sendMessageWithAuthorityLease(
        sessionId,
        message,
        onChunk,
        onStatus,
        _onExecApproval,
        sender,
      ),
    );
  }

  private async sendMessageWithAuthorityLease(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    _onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const session = requireProjectSession(sessionId);
    if (sender && sender.userId !== session.userId) throw new Error('Ollama Project session does not belong to the authenticated sender.');
    const content = String(message || '').trim();
    if (!content) throw new Error('Ollama Project message cannot be empty.');
    if (content.length > MAX_MESSAGE_LENGTH) throw new Error('Ollama Project message exceeded the safety limit.');
    if (this.activeRuns.has(sessionId)) throw new Error('Ollama Project session already has an active turn.');

    const context = projectContext(session);
    const projectKey = this.projectRunKey(context);
    if (this.quarantinedProjects.has(projectKey)) {
      throw new Error('This project has a quarantined Ollama coding runtime.');
    }
    const activeProjectSession = this.activeProjects.get(projectKey);
    if (activeProjectSession && activeProjectSession !== sessionId) {
      throw new Error('This project already has an active Ollama coding turn.');
    }
    const model = cleanModel(session.model);
    const backend = requireBackendIdentity(session.metadata);
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      context,
      bridge: null,
      runId: typeof sender?.requestId === 'string' && sender.requestId.trim()
        ? sender.requestId.trim()
        : null,
      abortPromise: null,
      quarantined: false,
      sendSettled: false,
    };
    this.activeRuns.set(sessionId, active);
    this.activeProjects.set(projectKey, sessionId);
    appendNativeMessage(session, { id: this.idFactory(), role: 'user', content, timestamp: new Date().toISOString() });

    let fullText = '';
    let toolCallCount = 0;
    let bridge: OllamaProjectModelBridgeHandle | null = null;
    try {
      onStatus?.({ type: 'status', content: 'Starting the confined Ollama project runtime…' });
      if (controller.signal.aborted) throw new AgentAbortError();
      const runtime = await this.runtime.ensure(context);
      // Runtime ensure and abort are serialized by the project runtime. This
      // post-admission check prevents a cancelled send from opening a model
      // bridge after abort has queued exact container removal.
      if (controller.signal.aborted) throw new AgentAbortError();
      bridge = await this.openBridge(
        context,
        sessionId,
        model,
        exactModelDigest(session.metadata?.ollamaModelDigest),
        backend,
      );
      active.bridge = bridge;
      const tags = await bridge.client.listModels(controller.signal);
      const installed = exactInstalledModel(tags, model);
      const show = await bridge.client.showModel(controller.signal);
      const capabilities = modelCapabilities(show);
      sameModelProof(session, {
        model,
        digest: installed.digest,
        capabilities,
        backendKind: bridge.client.backendKind,
        backendFingerprint: bridge.client.backendFingerprint,
        backendGeneration: bridge.client.backendGeneration,
      });
      const messages = transcriptMessages(session);
      let finalMetrics: Record<string, unknown> | undefined;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (controller.signal.aborted) throw new AgentAbortError();
        onStatus?.({ type: 'status', content: round === 0 ? 'Ollama is analyzing the project…' : 'Ollama is continuing after tool results…' });
        const response = await bridge.client.chat({
          model,
          messages,
          tools: [...PROJECT_TOOLS],
          stream: true,
          think: true,
        }, controller.signal);
        const streamed = await readOllamaProjectChatStream(response, {
          onThinking: (chunk) => onStatus?.({ type: 'thinking', content: chunk }),
          onContent: (chunk) => {
            fullText = appendBounded(fullText, chunk, MAX_RESPONSE_LENGTH, 'Ollama response');
            onChunk?.(chunk);
          },
        });
        finalMetrics = streamed.metrics;
        messages.push({
          role: 'assistant',
          content: streamed.content,
          ...(streamed.thinking ? { thinking: streamed.thinking } : {}),
          ...(streamed.toolCalls.length ? { tool_calls: streamed.toolCalls } : {}),
        });
        if (streamed.toolCalls.length === 0) {
          if (!fullText.trim()) throw new Error('Ollama completed without a final response.');
          appendNativeMessage(session, { id: this.idFactory(), role: 'assistant', content: fullText.trim(), timestamp: new Date().toISOString() });
          updateNativeSessionMetadata('OLLAMA', sessionId, {
            projectRuntimeFingerprint: runtime.runtimeFingerprint,
            ollamaLastCompletedAt: new Date().toISOString(),
            ollamaLastToolCalls: toolCallCount,
          });
          return {
            fullText: fullText.trim(),
            metadata: {
              provider: 'ollama',
              executionScope: 'PROJECT_SANDBOX',
              projectRuntime: OLLAMA_PROJECT_RUNTIME,
              runtimeFingerprint: runtime.runtimeFingerprint,
              model,
              modelDigest: installed.digest,
              ollamaBackendKind: bridge.client.backendKind,
              ollamaBackendFingerprint: bridge.client.backendFingerprint,
              ollamaBackendGeneration: bridge.client.backendGeneration,
              toolCalls: toolCallCount,
              supportsAbort: true,
              ...(finalMetrics || {}),
            },
          };
        }

        toolCallCount += streamed.toolCalls.length;
        if (toolCallCount > MAX_TOOL_CALLS) throw new Error('Ollama Project exceeded the bounded tool-call limit.');
        for (const call of streamed.toolCalls) {
          if (controller.signal.aborted) throw new AgentAbortError();
          const name = call.function.name as OllamaProjectToolName;
          let result: OllamaProjectToolResult;
          onStatus?.({
            type: 'tool_start',
            content: 'Running ' + name + '…',
            toolCallId: call.id,
            toolName: name,
            toolArgs: call.function.arguments,
          });
          if (!OLLAMA_PROJECT_TOOL_NAMES.includes(name)) {
            result = { ok: false, output: 'Tool is not allowed by the Ollama Project runtime.' };
          } else {
            try {
              result = await this.runtime.runTool(context, name, call.function.arguments, controller.signal);
            } catch (error: any) {
              if (controller.signal.aborted) throw new AgentAbortError();
              if (error instanceof OllamaProjectRuntimeTerminationError) {
                active.quarantined = true;
                try {
                  this.markQuarantined(session, 'TOOL_RUNTIME_TERMINATION_UNCONFIRMED');
                } catch {
                  // Retain the in-memory actor/project lock even when durable
                  // quarantine persistence is temporarily unavailable.
                }
                throw error;
              }
              result = { ok: false, output: String(error?.message || error).slice(0, 524_288) };
            }
          }
          onStatus?.({
            type: 'tool_update',
            content: result.output,
            toolCallId: call.id,
            toolName: name,
            toolResult: result.output,
          });
          onStatus?.({
            type: 'tool_end',
            content: result.ok ? name + ' completed.' : name + ' failed.',
            toolCallId: call.id,
            toolName: name,
            toolResult: result.output,
            status: result.ok ? 'done' : 'error',
          });
          messages.push(toolResultMessage(name, result));
        }
      }
      throw new Error('Ollama Project exceeded the bounded tool-loop limit.');
    } catch (error: any) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error instanceof AgentAbortError) throw new AgentAbortError();
      throw error;
    } finally {
      active.bridge = null;
      await bridge?.close().catch(() => undefined);
      active.sendSettled = true;
      if (!active.quarantined) this.releaseActiveRun(sessionId, active);
      onStatus?.({ type: 'status', content: '' });
    }
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    requireProjectSession(sessionId);
    return readAllNativeSessionHistory('OLLAMA', sessionId);
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('OLLAMA', userId).filter((summary) => {
      try { requireProjectSession(summary.sessionId); return true; } catch { return false; }
    });
  }

  async abortActiveRun(sessionId: AgentSessionId, runId?: string): Promise<boolean> {
    const session = requireProjectSession(sessionId, { allowQuarantined: true });
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;
    if (runId && active.runId !== runId) return false;
    if (active.abortPromise) return active.abortPromise;
    // Quarantine before aborting the model stream. Closing the bridge can make
    // sendMessage settle immediately; its finally block must not release the
    // actor/project lock until the hard-stop result is known.
    active.quarantined = true;
    try {
      this.markQuarantined(session, 'ACTIVE_RUN_ABORT_PENDING');
    } catch {
      // The in-memory quarantine remains authoritative for this process. A
      // failed metadata write must not prevent the hard-stop attempt.
    }
    const attempt = (async () => {
      active.controller.abort();
      await active.bridge?.close().catch(() => undefined);
      active.bridge = null;
      let stopped = false;
      try {
        stopped = await this.runtime.abort(projectContext(session)) === true;
      } catch {
        stopped = false;
      }
      if (!stopped) return false;
      active.quarantined = false;
      try { this.clearQuarantine(session); } catch { /* durable recovery remains fail-closed */ }
      if (active.sendSettled) this.releaseActiveRun(sessionId, active);
      return true;
    })();
    active.abortPromise = attempt;
    const stopped = await attempt;
    if (!stopped && this.activeRuns.get(sessionId) === active) active.abortPromise = null;
    return stopped;
  }

  async resetSession(sessionId: AgentSessionId): Promise<void> {
    const session = requireProjectSession(sessionId, { allowQuarantined: true });
    if (this.activeRuns.has(sessionId)) throw new Error('Abort the active Ollama Project turn before reset.');
    let stopped = false;
    try { stopped = await this.runtime.terminate(projectContext(session)) === true; } catch { stopped = false; }
    if (!stopped) {
      this.markQuarantined(session, 'SESSION_RESET_CLEANUP_UNCONFIRMED');
      throw new Error('Ollama Project reset could not verify runtime termination.');
    }
    clearNativeSessionHistory(session);
    this.clearQuarantine(session);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    const session = requireProjectSession(sessionId, { allowQuarantined: true });
    const active = this.activeRuns.get(sessionId);
    if (active && !await this.abortActiveRun(sessionId, active.runId || undefined)) {
      throw new Error('Ollama Project session abort could not verify runtime termination.');
    }
    let stopped = false;
    try { stopped = await this.runtime.terminate(projectContext(session)) === true; } catch { stopped = false; }
    if (!stopped) {
      this.markQuarantined(session, 'SESSION_TERMINATION_UNCONFIRMED');
      throw new Error('Ollama Project session termination could not be verified.');
    }
    if (active) this.releaseActiveRun(sessionId, active);
    const projectKey = this.projectRunKey(projectContext(session));
    if (this.activeProjects.get(projectKey) === sessionId) this.activeProjects.delete(projectKey);
    this.quarantinedProjects.delete(projectKey);
    deleteNativeSession('OLLAMA', sessionId);
  }
}

export const __ollamaProjectProviderTest = {
  PROJECT_TOOLS,
  CAPABILITY_TOOL,
  exactInstalledModel,
  modelCapabilities,
  cleanToolCalls,
  transcriptMessages,
};
