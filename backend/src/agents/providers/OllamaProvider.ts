import { randomUUID } from 'crypto';
import { TextDecoder } from 'node:util';
import { prisma } from '../../config/database';
import { config as envConfig } from '../../config/env';
import {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentMessage,
  AgentSendResult,
  AgentSessionSummary,
  AgentAbortError,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  SenderIdentity,
} from '../AgentProvider.interface';
import {
  appendNativeMessages,
  buildTranscriptPrompt,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  readAllNativeSessionHistory,
  saveNativeSession,
  type NativeSessionData,
} from './NativeSessionStore';
import { getProviderCapabilities } from '../providerAvailability';
import { assertExecutionContextBinding, assertProviderSupportsExecutionScope } from '../executionScope';
import { OLLAMA_DEFAULT_MODEL_CANDIDATES } from '../../utils/ollamaRecommendations';
import {
  requestResolvedOllamaJson,
  resolveOllamaBackendAuthority,
  streamResolvedOllama,
  type ResolvedOllamaBackendAuthority,
} from '../../services/ollamaBackendAuthority';
import {
  NATIVE_OLLAMA_STREAM_COMPLETE,
} from '../../services/nativeOllamaTransport';

const OLLAMA_HOST_TURN_TIMEOUT_MS = 10 * 60_000;
const OLLAMA_HOST_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const OLLAMA_HOST_MAX_STREAM_LINE_BYTES = 2 * 1024 * 1024;
const OLLAMA_HOST_MAX_STREAM_RECORDS = 100_000;
const OLLAMA_HOST_MAX_TOOL_CALLS = 64;
const OLLAMA_HOST_MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const OLLAMA_HOST_METRIC_KEYS = Object.freeze([
  'total_duration',
  'load_duration',
  'prompt_eval_count',
  'prompt_eval_duration',
  'eval_count',
  'eval_duration',
] as const);

let idCounter = 0;
function nextId(): string {
  return `ollama-msg-${Date.now()}-${++idCounter}`;
}

const OLLAMA_BACKEND_FINGERPRINT_METADATA = 'ollamaBackendFingerprint';
const OLLAMA_BACKEND_GENERATION_METADATA = 'ollamaBackendGeneration';
const OLLAMA_BACKEND_MODEL_DIGEST_METADATA = 'ollamaBackendModelDigest';

async function listInstalledModels(
  resolved: ResolvedOllamaBackendAuthority,
): Promise<string[]> {
  try {
    const { value: payload } = await requestResolvedOllamaJson<{ models?: unknown }>(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: 5_000,
      maxResponseBytes: 8 * 1024 * 1024,
    });
    if (!Array.isArray(payload.models)) return [];
    return Array.from(new Set(payload.models.slice(0, 1_000).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const model = String((entry as Record<string, unknown>).name
        || (entry as Record<string, unknown>).model
        || '').trim();
      return model ? [model] : [];
    })));
  } catch {
    return [];
  }
}

async function resolveDefaultModel(
  resolved: ResolvedOllamaBackendAuthority,
): Promise<string> {
  if (resolved.authority.kind === 'TAILNET') {
    return String(resolved.authority.selectedModel || '');
  }
  const envModel = (process.env.OLLAMA_MODEL || process.env.OLLAMA_DEFAULT_MODEL || '').trim();
  if (envModel) return envModel;

  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'ollama.defaultModel' } });
    if (setting?.value?.trim()) return setting.value.trim();
  } catch {}

  const installedModels = await listInstalledModels(resolved);
  const preferredInstalled = OLLAMA_DEFAULT_MODEL_CANDIDATES.find((candidate) => installedModels.includes(candidate));
  if (preferredInstalled) return preferredInstalled;
  if (installedModels[0]) return installedModels[0];

  return envConfig.ollamaModel;
}

function requireSession(sessionId: AgentSessionId): NativeSessionData {
  const session = loadNativeSession('OLLAMA', sessionId);
  if (session) return session;
  throw new Error(`Ollama session not found: ${sessionId}`);
}

function authorityGeneration(resolved: ResolvedOllamaBackendAuthority): number | null {
  return resolved.authority.generation;
}

function bindSessionAuthority(
  session: NativeSessionData,
  resolved: ResolvedOllamaBackendAuthority,
): void {
  const existingFingerprint = typeof session.metadata?.[OLLAMA_BACKEND_FINGERPRINT_METADATA] === 'string'
    ? String(session.metadata[OLLAMA_BACKEND_FINGERPRINT_METADATA])
    : '';
  const existingGeneration = session.metadata?.[OLLAMA_BACKEND_GENERATION_METADATA];
  const existingDigest = typeof session.metadata?.[OLLAMA_BACKEND_MODEL_DIGEST_METADATA] === 'string'
    ? String(session.metadata[OLLAMA_BACKEND_MODEL_DIGEST_METADATA])
    : '';
  if (
    existingFingerprint
    && (
      existingFingerprint !== resolved.authority.bindingFingerprint
      || existingGeneration !== authorityGeneration(resolved)
      || (
        resolved.authority.kind === 'TAILNET'
        && existingDigest !== resolved.authority.selectedModelDigest
      )
    )
  ) {
    throw new Error('The Ollama backend changed after this session was created. Start a new session.');
  }
  if (resolved.authority.kind === 'TAILNET') {
    if (!resolved.authority.selectedModel || session.model !== resolved.authority.selectedModel) {
      throw new Error('The Ollama session model does not match its Tailnet backend binding.');
    }
  }
  if (!existingFingerprint) {
    session.metadata = {
      ...(session.metadata || {}),
      [OLLAMA_BACKEND_FINGERPRINT_METADATA]: resolved.authority.bindingFingerprint,
      [OLLAMA_BACKEND_GENERATION_METADATA]: authorityGeneration(resolved),
      ...(resolved.authority.kind === 'TAILNET'
        ? {
          [OLLAMA_BACKEND_MODEL_DIGEST_METADATA]:
            resolved.authority.selectedModelDigest,
        }
        : {}),
    };
    saveNativeSession(session);
  }
}

interface OllamaHostToolCall {
  readonly id?: string;
  readonly function: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

interface OllamaHostStreamResult {
  readonly fullText: string;
  readonly toolCalls: readonly OllamaHostToolCall[];
  readonly doneReason?: string;
  readonly metrics?: Readonly<Record<string, number>>;
}

function boundedRemoteError(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return 'Ollama returned an unspecified model error.';
  return normalized.slice(0, 2_048);
}

function assertJsonSafeToolArguments(value: Record<string, unknown>): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 16_384) {
      throw new Error('Ollama tool arguments exceeded the safety limit.');
    }
    if (typeof current === 'number') {
      if (
        !Number.isFinite(current)
        || Math.abs(current) > Number.MAX_SAFE_INTEGER
        || Object.is(current, -0)
      ) {
        throw new Error('Ollama returned unsafe tool arguments.');
      }
    } else if (current !== null && typeof current === 'object') {
      pending.push(...Object.values(current as Record<string, unknown>));
    }
  }
}

function cleanHostToolCalls(value: unknown): OllamaHostToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error('Ollama returned an invalid tool-call list.');
  }
  return value.map((raw) => {
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
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name)
      || !args
      || typeof args !== 'object'
      || Array.isArray(args)
    ) {
      throw new Error('Ollama returned an invalid tool call.');
    }
    assertJsonSafeToolArguments(args as Record<string, unknown>);
    let encodedArguments: string;
    try {
      encodedArguments = JSON.stringify(args);
    } catch {
      throw new Error('Ollama returned an invalid tool call.');
    }
    if (
      Buffer.byteLength(encodedArguments, 'utf8')
      > OLLAMA_HOST_MAX_TOOL_ARGUMENT_BYTES
    ) {
      throw new Error('Ollama tool arguments exceeded the safety limit.');
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (
      id
      && (
        Buffer.byteLength(id, 'utf8') > 128
        || /[\u0000-\u001f\u007f]/u.test(id)
      )
    ) {
      throw new Error('Ollama returned an invalid tool call.');
    }
    return Object.freeze({
      ...(id ? { id } : {}),
      function: Object.freeze({
        name,
        arguments: args as Record<string, unknown>,
      }),
    });
  });
}

class OllamaHostChatStreamAccumulator {
  private readonly decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  private readonly pendingParts: Buffer[] = [];
  private readonly contentParts: string[] = [];
  private readonly toolCalls = new Map<string, OllamaHostToolCall>();

  private pendingBytes = 0;
  private contentBytes = 0;
  private records = 0;
  private toolCallCount = 0;
  private done = false;
  private doneReason: string | undefined;
  private metrics: Record<string, number> | undefined;

  push(chunk: Buffer, onContent?: OnChunkCallback): boolean {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('Ollama chat returned an invalid response chunk.');
    }
    if (chunk.byteLength === 0) return this.done;
    if (this.done) {
      throw new Error('Ollama chat returned data after its terminal record.');
    }

    let offset = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.append(chunk.subarray(offset, index));
      this.consumeLine(onContent);
      offset = index + 1;
      if (this.done && offset < chunk.byteLength) {
        throw new Error('Ollama chat returned data after its terminal record.');
      }
    }
    if (offset < chunk.byteLength) {
      if (this.done) {
        throw new Error('Ollama chat returned data after its terminal record.');
      }
      this.append(chunk.subarray(offset));
    }
    return this.done;
  }

  finish(onContent?: OnChunkCallback): OllamaHostStreamResult {
    if (this.pendingBytes > 0) this.consumeLine(onContent);
    if (!this.done) {
      throw new Error('Ollama chat ended before its terminal done record.');
    }
    return Object.freeze({
      fullText: this.contentParts.join(''),
      toolCalls: Object.freeze([...this.toolCalls.values()]),
      ...(this.doneReason ? { doneReason: this.doneReason } : {}),
      ...(this.metrics && Object.keys(this.metrics).length > 0
        ? { metrics: Object.freeze({ ...this.metrics }) }
        : {}),
    });
  }

  private append(segment: Buffer): void {
    if (segment.byteLength === 0) return;
    const nextBytes = this.pendingBytes + segment.byteLength;
    if (nextBytes > OLLAMA_HOST_MAX_STREAM_LINE_BYTES + 1) {
      throw new Error('Ollama chat stream frame exceeded the safety limit.');
    }
    if (
      nextBytes === OLLAMA_HOST_MAX_STREAM_LINE_BYTES + 1
      && segment[segment.byteLength - 1] !== 0x0d
    ) {
      throw new Error('Ollama chat stream frame exceeded the safety limit.');
    }
    this.pendingParts.push(Buffer.from(segment));
    this.pendingBytes = nextBytes;
  }

  private consumeLine(onContent?: OnChunkCallback): void {
    const parts = this.pendingParts.splice(0);
    const line = Buffer.concat(parts, this.pendingBytes);
    this.pendingBytes = 0;
    for (const part of parts) part.fill(0);
    try {
      let content = line;
      if (content.byteLength > 0 && content[content.byteLength - 1] === 0x0d) {
        content = content.subarray(0, content.byteLength - 1);
      }
      if (
        content.byteLength === 0
        || content.byteLength > OLLAMA_HOST_MAX_STREAM_LINE_BYTES
      ) {
        throw new Error('Ollama chat returned an invalid NDJSON record.');
      }
      if (this.records >= OLLAMA_HOST_MAX_STREAM_RECORDS) {
        throw new Error('Ollama chat returned too many stream records.');
      }
      this.records += 1;

      let decoded: string;
      try {
        decoded = this.decoder.decode(content);
      } catch {
        throw new Error('Ollama chat returned invalid UTF-8.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded) as unknown;
      } catch {
        throw new Error('Ollama chat returned invalid NDJSON.');
      }
      if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
      ) {
        throw new Error('Ollama chat returned an invalid NDJSON record.');
      }
      const record = parsed as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, 'error')) {
        if (typeof record.error !== 'string' || !record.error.trim()) {
          throw new Error('Ollama chat returned an invalid error record.');
        }
        throw new Error(`Ollama model error: ${boundedRemoteError(record.error)}`);
      }
      if (typeof record.done !== 'boolean') {
        throw new Error('Ollama chat returned a record without a valid done flag.');
      }

      let delta = '';
      let calls: OllamaHostToolCall[] = [];
      if (record.message !== undefined) {
        if (
          !record.message
          || typeof record.message !== 'object'
          || Array.isArray(record.message)
        ) {
          throw new Error('Ollama chat returned an invalid message record.');
        }
        const message = record.message as Record<string, unknown>;
        if (
          message.role !== undefined
          && message.role !== 'assistant'
        ) {
          throw new Error('Ollama chat returned an invalid message role.');
        }
        if (
          message.content !== undefined
          && typeof message.content !== 'string'
        ) {
          throw new Error('Ollama chat returned invalid message content.');
        }
        delta = typeof message.content === 'string' ? message.content : '';
        calls = cleanHostToolCalls(message.tool_calls);
      }

      let nextDoneReason: string | undefined;
      const nextMetrics: Record<string, number> = {};
      if (record.done_reason !== undefined) {
        if (
          typeof record.done_reason !== 'string'
          || !record.done_reason.trim()
          || Buffer.byteLength(record.done_reason, 'utf8') > 128
          || /[\u0000-\u001f\u007f]/u.test(record.done_reason)
        ) {
          throw new Error('Ollama chat returned an invalid done reason.');
        }
        nextDoneReason = record.done_reason;
      }
      for (const key of OLLAMA_HOST_METRIC_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const value = record[key];
        if (
          typeof value !== 'number'
          || !Number.isSafeInteger(value)
          || value < 0
          || Object.is(value, -0)
        ) {
          throw new Error('Ollama chat returned invalid final metrics.');
        }
        nextMetrics[key] = value;
      }

      const deltaBytes = Buffer.byteLength(delta, 'utf8');
      if (
        this.contentBytes + deltaBytes
        > OLLAMA_HOST_MAX_RESPONSE_BYTES
      ) {
        throw new Error('Ollama chat response exceeded the safety limit.');
      }
      if (this.toolCallCount + calls.length > OLLAMA_HOST_MAX_TOOL_CALLS) {
        throw new Error('Ollama chat returned too many tool calls.');
      }
      this.toolCallCount += calls.length;

      if (delta) {
        this.contentParts.push(delta);
        this.contentBytes += deltaBytes;
        onContent?.(delta);
      }
      for (const call of calls) {
        const key = call.id
          ? `id:${call.id}`
          : `value:${JSON.stringify(call)}`;
        this.toolCalls.set(key, call);
      }
      if (record.done) {
        this.done = true;
        this.doneReason = nextDoneReason;
        this.metrics = nextMetrics;
      }
    } finally {
      line.fill(0);
    }
  }
}

type OllamaHostRunOutcome = 'running' | 'completed' | 'aborted' | 'failed';

interface OllamaHostActiveRun {
  readonly runId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  abortPromise: Promise<boolean> | null;
  outcome: OllamaHostRunOutcome;
}

function exactRunId(sender?: SenderIdentity): string {
  const supplied = typeof sender?.requestId === 'string' ? sender.requestId.trim() : '';
  if (supplied && (supplied.length > 512 || /[\u0000-\u001f\u007f]/.test(supplied))) {
    throw new Error('Ollama run identity is invalid');
  }
  return supplied || randomUUID();
}

export class OllamaProvider implements AgentProvider {
  readonly displayName = 'Ollama';
  readonly providerName: AgentProviderName = 'OLLAMA';
  private readonly activeRuns = new Map<AgentSessionId, OllamaHostActiveRun>();

  async startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId> {
    assertExecutionContextBinding(config.executionContext, userId);
    assertProviderSupportsExecutionScope(
      this.providerName,
      getProviderCapabilities(this.providerName)?.supportedExecutionScopes,
      config.executionContext,
    );
    const resolved = await resolveOllamaBackendAuthority();
    const requestedModel = typeof config.model === 'string'
      ? config.model.trim()
      : '';
    if (
      resolved.authority.kind === 'TAILNET'
      && requestedModel
      && requestedModel !== resolved.authority.selectedModel
    ) {
      throw new Error(
        'The requested Ollama model is not the active Remote GPU model. Select it in Settings before starting a session.',
      );
    }
    const model = resolved.authority.kind === 'TAILNET'
      ? String(resolved.authority.selectedModel || '')
      : config.model || await resolveDefaultModel(resolved);
    if (!model) {
      throw new Error(
        'Remote GPU is connected, but no model is selected. Download and select a model in Settings > AI Providers.',
      );
    }
    const session = createNativeSession('OLLAMA', userId, {
      ...config,
      model,
      metadata: {
        ...(config.metadata || {}),
        [OLLAMA_BACKEND_FINGERPRINT_METADATA]: resolved.authority.bindingFingerprint,
        [OLLAMA_BACKEND_GENERATION_METADATA]: authorityGeneration(resolved),
        ...(resolved.authority.kind === 'TAILNET'
          ? {
            [OLLAMA_BACKEND_MODEL_DIGEST_METADATA]:
              resolved.authority.selectedModelDigest,
          }
          : {}),
      },
    });
    return session.sessionId;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    _onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const session = requireSession(sessionId);
    assertExecutionContextBinding(session.executionContext, session.userId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error('Ollama session already has an active turn.');
    }
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const active: OllamaHostActiveRun = {
      runId: exactRunId(sender),
      controller: new AbortController(),
      completion,
      resolveCompletion,
      abortPromise: null,
      outcome: 'running',
    };
    // Reserve the logical run before the first await. Two calls entering in the
    // same event-loop turn therefore cannot both reach model resolution/fetch.
    this.activeRuns.set(sessionId, active);
    const runTimeout = setTimeout(() => active.controller.abort(), OLLAMA_HOST_TURN_TIMEOUT_MS);
    runTimeout.unref?.();
    let protocolComplete = false;

    try {
      const resolved = await resolveOllamaBackendAuthority();
      if (!session.model) {
        session.model = await resolveDefaultModel(resolved);
        if (active.controller.signal.aborted) throw new AgentAbortError();
        if (!session.model) {
          throw new Error(
            'Remote GPU is connected, but no model is selected. Download and select a model in Settings > AI Providers.',
          );
        }
        saveNativeSession(session);
      }
      bindSessionAuthority(session, resolved);

      onStatus?.({ type: 'status', content: `Running Ollama (${session.model})...` });
      if (active.controller.signal.aborted) throw new AgentAbortError();

      // Keep the turn provisional until Ollama reaches a valid terminal frame.
      // Cancellation, malformed NDJSON, and upstream failures must not leave a
      // durable one-sided user turn behind.
      const prompt = buildTranscriptPrompt(session.messages, message);
      const stream = new OllamaHostChatStreamAccumulator();
      await streamResolvedOllama(resolved, {
        path: '/api/chat',
        method: 'POST',
        json: {
          model: session.model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          think: false,
        },
        timeoutMs: OLLAMA_HOST_TURN_TIMEOUT_MS,
        maxResponseBytes: OLLAMA_HOST_MAX_RESPONSE_BYTES,
        ...(resolved.authority.selectedModelDigest
          ? { expectedModelDigest: resolved.authority.selectedModelDigest }
          : {}),
        signal: active.controller.signal,
      }, (chunk) => {
        if (active.controller.signal.aborted) throw new AgentAbortError();
        return stream.push(chunk, onChunk)
          ? NATIVE_OLLAMA_STREAM_COMPLETE
          : undefined;
      });

      const streamed = stream.finish(onChunk);
      protocolComplete = true;
      const fullText = streamed.fullText;
      const completedAt = new Date().toISOString();
      appendNativeMessages(session, [
        {
          id: nextId(),
          role: 'user',
          content: message,
          timestamp: completedAt,
        },
        {
          id: nextId(),
          role: 'assistant',
          content: fullText,
          timestamp: completedAt,
        },
      ]);
      active.outcome = 'completed';

      return {
        fullText,
        metadata: {
          provider: 'ollama',
          model: session.model,
          backend: resolved.authority.kind.toLowerCase(),
          backendGeneration: resolved.authority.generation,
          ...(streamed.doneReason ? { doneReason: streamed.doneReason } : {}),
          ...(streamed.metrics ? { metrics: streamed.metrics } : {}),
          ...(streamed.toolCalls.length > 0 ? { toolCalls: streamed.toolCalls } : {}),
        },
      };
    } catch (error: any) {
      if (
        !protocolComplete
        && (
          active.controller.signal.aborted
          || error?.name === 'AbortError'
          || error instanceof AgentAbortError
        )
      ) {
        active.outcome = 'aborted';
        throw new AgentAbortError();
      }
      active.outcome = 'failed';
      throw error;
    } finally {
      clearTimeout(runTimeout);
      try {
        onStatus?.({ type: 'status', content: '' });
      } catch {
        // A UI callback cannot replace the provider's terminal result or keep
        // the logical reservation from settling.
      } finally {
        if (this.activeRuns.get(sessionId) === active) this.activeRuns.delete(sessionId);
        active.resolveCompletion();
      }
    }
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    requireSession(sessionId);
    return readAllNativeSessionHistory('OLLAMA', sessionId);
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions('OLLAMA', userId);
  }

  async abortActiveRun(sessionId: AgentSessionId, expectedRunId?: string): Promise<boolean> {
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;
    if (expectedRunId && expectedRunId !== active.runId) return false;
    if (active.abortPromise) return active.abortPromise;

    const attempt = (async () => {
      active.controller.abort();
      await active.completion;
      return active.outcome === 'aborted';
    })();
    active.abortPromise = attempt;
    return attempt;
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    requireSession(sessionId);
    const active = this.activeRuns.get(sessionId);
    if (active) {
      const aborted = await this.abortActiveRun(sessionId, active.runId);
      if (!aborted) throw new Error('Ollama could not confirm termination of the active turn.');
    }
    deleteNativeSession('OLLAMA', sessionId);
  }
}
