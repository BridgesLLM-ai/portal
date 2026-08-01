/**
 * Agent Zero provider backed by the authenticated `_a0_connector` HTTP and
 * Socket.IO APIs.
 *
 * Streaming/replay is implemented against the exact Agent Zero v2.5 connector
 * contract. Main Agent Chat host tools are gated through the separately
 * supervised official A0 v2.5 host gateway. Project sandboxing, attachments,
 * execution approvals, and hard abort are still not advertised or emulated.
 */

import {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentMessage,
  AgentSendResult,
  AgentSessionModelResult,
  AgentSessionSummary,
  OnChunkCallback,
  OnStatusCallback,
  OnExecApprovalCallback,
  SenderIdentity,
} from '../AgentProvider.interface';
import {
  assertExecutionContextBinding,
  assertProviderSupportsExecutionScope,
} from '../executionScope';
import { getProviderAvailability } from '../providerAvailability';
import {
  appendNativeMessage,
  clearNativeSessionHistory,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  readAllNativeSessionHistory,
  readNativeSessionHistoryPage,
  readNativeSessionHistoryTail,
  updateNativeSessionMetadata,
  updateNativeSessionModel,
  type NativeSessionData,
} from './NativeSessionStore';
import {
  AgentZeroConnectorClient,
  AgentZeroConnectorClientOptions,
  type AgentZeroCapabilities,
} from './agentZero/AgentZeroConnectorClient';
import type { AgentZeroConnectorEvent } from './agentZero/AgentZeroConnectorStream';
import {
  getDefaultAgentZeroHostGatewayManager,
  type AgentZeroHostGatewayController,
} from './agentZero/AgentZeroHostGateway';
import {
  classifyAgentZeroError,
  safeAgentZeroErrorMessage,
  safeAgentZeroRuntimeEventMessage,
  safeAgentZeroStatusMessage,
} from './agentZero/AgentZeroDiagnostics';
import {
  validateAgentZeroOAuthModelSelection,
  type AgentZeroSelectableOAuthModel,
} from './agentZero/AgentZeroOAuthModelCatalog';
import {
  redactNativeProviderText,
  sanitizeNativeProviderEvent,
} from './native/NativeProviderDiagnostics';

const MAX_CONTEXT_ID_LENGTH = 128;
const MAX_USER_ID_LENGTH = 128;
const MAX_AGENT_PROFILE_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 256 * 1024;
const MAX_RESULT_LENGTH = 1024 * 1024;
const MAX_HISTORY_EVENTS = 1_000;
const HISTORY_PAGE_SIZE = 250;
const MAX_HISTORY_PAGES = Math.ceil(MAX_HISTORY_EVENTS / HISTORY_PAGE_SIZE);
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const LEGACY_HISTORY_IMPORT_TIMEOUT_MS = 8_000;
const LEGACY_HISTORY_IMPORTED_AT_KEY = 'agentZeroLegacyHistoryImportedAt';

export interface AgentZeroHistoryPage {
  messages: AgentMessage[];
  hasMoreBefore: boolean;
  beforeSequence: number | null;
}

export interface AgentZeroProviderOptions extends AgentZeroConnectorClientOptions {
  client?: AgentZeroConnectorClient;
  hostGateway?: AgentZeroHostGatewayController;
  validateModelSelection?: (model: string) => Promise<AgentZeroSelectableOAuthModel>;
}

export interface AgentZeroModelReference {
  provider: string;
  name: string;
  label: string;
  hasApiKey?: boolean;
}

export interface AgentZeroModelPresetSummary {
  name: string;
  scope?: string;
  chat?: AgentZeroModelReference;
  utility?: AgentZeroModelReference;
  embedding?: AgentZeroModelReference;
}

export interface AgentZeroModelMetadata {
  available: boolean;
  allowed: boolean;
  configuredPreset?: string;
  effectivePreset?: string;
  presets: AgentZeroModelPresetSummary[];
  providers: Array<{ value: string; label: string; hasApiKey: boolean }>;
  mainModel?: AgentZeroModelReference;
  utilityModel?: AgentZeroModelReference;
  embeddingModel?: AgentZeroModelReference;
}

export interface AgentZeroControlResult {
  ok: boolean;
  contextId: string;
  status: string;
  message?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function cleanContent(value: unknown, maximum: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maximum);
}

function redactSensitiveText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return redactNativeProviderText(String(value), maximum);
}

function normalizeTimestamp(value: unknown, fallback = FALLBACK_TIMESTAMP): string {
  const text = cleanString(value, 128);
  if (!text) return fallback;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return fallback;
  return new Date(timestamp).toISOString();
}

function summarize(value: unknown, maximum: number): string {
  const text = cleanString(value, maximum * 2).replace(/\s+/g, ' ');
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function validateUserId(userId: string): string {
  const resolved = String(userId || '').trim();
  if (!resolved || resolved.length > MAX_USER_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(resolved)) {
    throw new Error('Invalid Portal user identifier for Agent Zero session.');
  }
  return resolved;
}

function validateContextId(contextId: unknown): string {
  const resolved = cleanString(contextId, MAX_CONTEXT_ID_LENGTH + 1);
  if (
    !resolved
    || resolved.length > MAX_CONTEXT_ID_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resolved)
  ) {
    throw new Error('Agent Zero returned an invalid context identifier.');
  }
  return resolved;
}

function remoteContextIdForSession(session: NativeSessionData): string {
  // New sessions keep their Portal identity immutable and bind the upstream
  // context only as metadata. The fallback preserves pre-4.0 sessions whose
  // Portal ID was historically rekeyed to the Agent Zero context ID.
  return validateContextId(
    session.metadata?.agentZeroRemoteContextId || session.sessionId,
  );
}

function remoteContextAlreadyBound(userId: string, remoteContextId: string): boolean {
  return listNativeSessions('AGENT_ZERO', userId).some((summary) => {
    const existing = loadNativeSession('AGENT_ZERO', summary.sessionId);
    if (!existing) return false;
    try {
      return remoteContextIdForSession(existing) === remoteContextId;
    } catch {
      return false;
    }
  });
}

function validateAgentProfile(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const profile = cleanString(value, MAX_AGENT_PROFILE_LENGTH + 1);
  if (
    !profile
    || profile.length > MAX_AGENT_PROFILE_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(profile)
  ) {
    throw new Error('Invalid Agent Zero agent profile.');
  }
  return profile;
}

function optionalMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
  maximum: number,
): string | undefined {
  const value = cleanString(metadata?.[key], maximum + 1);
  return value && value.length <= maximum ? value : undefined;
}

function modelReference(value: unknown): AgentZeroModelReference | undefined {
  if (!isRecord(value)) return undefined;
  const provider = cleanString(value.provider, 96);
  const name = cleanString(value.name, 256);
  if (!provider && !name) return undefined;
  const label = cleanString(value.label, 384) || [provider, name].filter(Boolean).join('/');
  return {
    provider,
    name,
    label,
    ...(typeof value.has_api_key === 'boolean' ? { hasApiKey: value.has_api_key } : {}),
  };
}

function presetSummary(value: unknown): AgentZeroModelPresetSummary | undefined {
  if (!isRecord(value)) return undefined;
  const name = cleanString(value.name, 128);
  if (!name) return undefined;
  const scope = cleanString(value.scope, 32);
  return {
    name,
    ...(scope ? { scope } : {}),
    ...(modelReference(value.chat) ? { chat: modelReference(value.chat) } : {}),
    ...(modelReference(value.utility) ? { utility: modelReference(value.utility) } : {}),
    ...(modelReference(value.embedding) ? { embedding: modelReference(value.embedding) } : {}),
  };
}

function modelMetadataFromResponse(value: unknown): AgentZeroModelMetadata {
  const data = isRecord(value) ? value : {};
  const presets = Array.isArray(data.presets)
    ? data.presets.slice(0, 200).map(presetSummary).filter((item): item is AgentZeroModelPresetSummary => Boolean(item))
    : [];
  const providers = Array.isArray(data.chat_providers)
    ? data.chat_providers.slice(0, 200).flatMap((item) => {
      if (!isRecord(item)) return [];
      const providerValue = cleanString(item.value, 96);
      if (!providerValue) return [];
      return [{
        value: providerValue,
        label: cleanString(item.label, 160) || providerValue,
        hasApiKey: item.has_api_key === true,
      }];
    })
    : [];

  return {
    available: true,
    allowed: data.allowed === true,
    configuredPreset: cleanString(data.configured_preset, 128) || undefined,
    effectivePreset: cleanString(data.effective_preset, 128) || undefined,
    presets,
    providers,
    mainModel: modelReference(data.main_model),
    utilityModel: modelReference(data.utility_model),
    embeddingModel: modelReference(data.embedding_model),
  };
}

function redactSensitiveObject(value: unknown): unknown {
  // Keep Agent Zero on the same structured-data trust boundary as the other
  // native harnesses. In particular this covers token, access_token,
  // bearerToken, id_token, private_key, and credential-like keys at any level,
  // including connector event metadata.
  return sanitizeNativeProviderEvent(value);
}

function containsAgentZeroDiagnosticMarker(value: string): boolean {
  return /\blitellm\.(?:Authentication|RateLimit|Model|API|APIConnection|BadRequest|ServiceUnavailable|Timeout|ContextWindowExceeded|PermissionDenied|NotFound)Error\b/i.test(value)
    || /\b(?:Authentication|RateLimit|Model|API|APIConnection|BadRequest|ServiceUnavailable|Timeout|ContextWindowExceeded|PermissionDenied|NotFound)Error\b\s*(?::|-)/i.test(value)
    || /\bOpenrouterException\b/i.test(value)
    || /\bNo user or org id found in auth cookie\b/i.test(value)
    || /\bTraceback \(most recent call last\):/i.test(value);
}

function looksLikeAgentZeroDiagnosticText(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:litellm\.)?(?:Authentication|RateLimit|Model|API|APIConnection|BadRequest|ServiceUnavailable|Timeout|ContextWindowExceeded|PermissionDenied|NotFound)Error\b\s*(?::|-)/i.test(trimmed)
    || /^OpenrouterException\b/i.test(trimmed)
    || /^No user or org id found in auth cookie\b/i.test(trimmed)
    || /^Traceback \(most recent call last\):/i.test(trimmed);
}

function isAgentZeroDiagnosticEnvelope(value: UnknownRecord): boolean {
  // An assistant may deliberately return JSON containing an `error` field
  // (for example, an API schema or validation result). Only suppress the
  // serialized object when it contains a provider/runtime diagnostic we
  // recognize. Structural field names alone are not enough evidence.
  const status = cleanString(value.status, 64).toLowerCase();
  const failedStatus = ['error', 'failed', 'failure', 'rejected'].includes(status);
  try {
    if ('error' in value && containsAgentZeroDiagnosticMarker(JSON.stringify(value.error))) return true;
    if (failedStatus && containsAgentZeroDiagnosticMarker(JSON.stringify(value))) return true;
    return ['message', 'detail', 'heading', 'text', 'traceback'].some((key) => (
      typeof value[key] === 'string' && looksLikeAgentZeroDiagnosticText(value[key] as string)
    ));
  } catch {
    return false;
  }
}

function isAgentZeroToolPayload(value: UnknownRecord): boolean {
  const event = cleanString(value.event ?? value.type, 96).toLowerCase();
  const role = cleanString(value.role, 32).toLowerCase();
  if (role === 'tool' || role === 'toolresult' || role === 'tool_result') return true;
  if (/^(?:tool(?:_|-)?(?:call|start(?:ed)?|output|update|result|end(?:ed)?|used|complete(?:d)?|execution)|code(?:_|-)?(?:start(?:ed)?|output|result|end(?:ed)?|execution))$/.test(event)) {
    return true;
  }
  if (Array.isArray(value.tool_calls) || isRecord(value.tool_call) || isRecord(value.function_call)) {
    return true;
  }
  return ('toolName' in value || 'tool_name' in value)
    && ('toolArgs' in value || 'tool_args' in value || 'toolResult' in value || 'tool_result' in value);
}

function serializeAgentZeroAssistantJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(redactSensitiveObject(value), null, 2);
    if (typeof serialized !== 'string') return '';
    const fenceOverhead = '```json\n\n```'.length;
    const maximumBodyLength = Math.max(1, MAX_RESULT_LENGTH - fenceOverhead);
    const body = serialized.length <= maximumBodyLength
      ? serialized
      : `${serialized.slice(0, Math.max(0, maximumBodyLength - 1))}…`;
    return `\`\`\`json\n${body}\n\`\`\``;
  } catch {
    return '';
  }
}

export function agentZeroResponseText(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') {
    const rawBytes = Buffer.byteLength(value, 'utf8');
    // Redact the complete value before bounding it. Parsing can fail (or be
    // intentionally skipped for oversized JSON), and truncating first could
    // otherwise separate a credential label from its value.
    const bounded = redactNativeProviderText(value, Math.max(1, rawBytes))
      .slice(0, MAX_RESULT_LENGTH);
    const trimmed = value.trim();
    if (!trimmed) return '';

    // Agent Zero/LiteLLM can serialize a failed provider envelope into the
    // nominal completion field. Treat a complete JSON-looking string as the
    // envelope it represents instead of rendering a wall of diagnostic JSON as
    // assistant prose. Prose answers that merely contain JSON remain intact.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      if (Buffer.byteLength(trimmed, 'utf8') <= MAX_RESULT_LENGTH) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed) || isRecord(parsed)) return agentZeroResponseText(parsed, depth + 1);
          return bounded;
        } catch {
          if (containsAgentZeroDiagnosticMarker(trimmed)) return '';
          // Malformed JSON may still be ordinary assistant content. It has
          // already passed through the structured native secret redactor.
        }
      } else if (containsAgentZeroDiagnosticMarker(trimmed)) {
        return '';
      }
    }
    if (looksLikeAgentZeroDiagnosticText(trimmed)) return '';
    return bounded;
  }
  if (Array.isArray(value)) {
    if (value.some((item) => isRecord(item) && isAgentZeroDiagnosticEnvelope(item))) {
      return '';
    }
    const visible = value.filter((item) => !isRecord(item) || !isAgentZeroToolPayload(item));
    if (visible.length === 0 && value.length > 0) return '';
    const wrapped = visible.filter((item) => (
      isRecord(item) && ['response', 'content', 'text'].some((key) => key in item)
    ));
    if (wrapped.length > 0) {
      return wrapped
        .map((item) => agentZeroResponseText(item, depth + 1))
        .filter(Boolean)
        .join('\n\n')
        .slice(0, MAX_RESULT_LENGTH);
    }
    return serializeAgentZeroAssistantJson(visible);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!isRecord(value)) return '';
  if (isAgentZeroDiagnosticEnvelope(value)) return '';
  if (isAgentZeroToolPayload(value)) return '';
  let sawConnectorWrapper = false;
  for (const key of ['response', 'content', 'text']) {
    if (!(key in value)) continue;
    sawConnectorWrapper = true;
    const text = agentZeroResponseText(value[key], depth + 1);
    if (text) return text;
  }
  if (sawConnectorWrapper) return '';
  return serializeAgentZeroAssistantJson(value);
}

function parseModelSelection(requestedModel: string): { provider: string; name: string } | null {
  const value = cleanString(requestedModel, 384);
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  const provider = value.slice(0, separator).trim().toLowerCase();
  const name = value.slice(separator + 1).trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,95}$/.test(provider) || !name || name.length > 256) {
    throw new Error('Invalid Agent Zero model selection.');
  }
  return { provider, name };
}

function connectorEventMessage(
  contextId: string,
  value: unknown,
  fallbackSequence: number,
): { sequence: number; message: AgentMessage } | null {
  if (!isRecord(value)) return null;
  const event = cleanString(value.event, 64);
  let role: AgentMessage['role'];
  if (event === 'user_message') role = 'user';
  else if (event === 'assistant_message' || event === 'assistant_delta') role = 'assistant';
  else if (event === 'error' || event === 'warning') role = 'system';
  else return null;

  const data = isRecord(value.data) ? value.data : {};
  const content = event === 'error'
    ? safeAgentZeroErrorMessage(data)
    : event === 'warning'
      ? safeAgentZeroStatusMessage({ heading: data.heading, text: data.text }, 2_048)
      : [
        cleanString(data.heading, 512),
        event === 'assistant_message' || event === 'assistant_delta'
          ? agentZeroResponseText(data.text)
          : cleanContent(data.text, MAX_RESULT_LENGTH),
      ].filter(Boolean).join('\n\n').trim();
  if (!content) return null;

  const rawSequence = Number(value.sequence);
  const sequence = Number.isSafeInteger(rawSequence) && rawSequence > 0
    ? rawSequence
    : fallbackSequence;
  return {
    sequence,
    message: {
      id: `a0-${contextId}-${sequence}-${role}`,
      role,
      content,
      timestamp: normalizeTimestamp(value.timestamp),
    },
  };
}

function controlResult(contextId: string, value: unknown): AgentZeroControlResult {
  const data = isRecord(value) ? value : {};
  return {
    ok: data.ok === true,
    contextId,
    status: cleanString(data.status, 64),
    message: cleanString(data.message, 512) || undefined,
  };
}

function connectorEventContent(event: AgentZeroConnectorEvent): string {
  const heading = redactSensitiveText(event.data.heading, 512);
  const text = redactSensitiveText(event.data.text, MAX_RESULT_LENGTH);
  return [heading, text].filter(Boolean).join(heading && text ? '\n\n' : '');
}

function modelProviderState(state: UnknownRecord, providerId: string): UnknownRecord | null {
  const providers = Array.isArray(state.chat_providers) ? state.chat_providers : [];
  return providers.find((item) => (
    isRecord(item)
    && cleanString(item.value, 96).toLowerCase() === providerId.toLowerCase()
  )) as UnknownRecord | undefined || null;
}

function assertAgentZeroModelCredentials(
  state: UnknownRecord,
  model: { provider: string; name: string },
): void {
  const provider = modelProviderState(state, model.provider);
  if (!provider) {
    throw new Error(
      `Agent Zero does not advertise the '${model.provider}' model provider. Choose an available Agent Zero model provider.`,
    );
  }
  if (provider.has_api_key !== true) {
    const label = cleanString(provider.label, 160) || model.provider;
    throw new Error(
      `Agent Zero does not have credentials for ${label}. Connect it in Agent Zero settings before selecting ${model.provider}/${model.name}.`,
    );
  }
}

function presetChatModel(preset: UnknownRecord): { provider: string; name: string } | null {
  const chat = isRecord(preset.chat) ? preset.chat : {};
  const provider = cleanString(chat.provider, 96).toLowerCase();
  const name = cleanString(chat.name, 256);
  return provider && name ? { provider, name } : null;
}

interface AppliedAgentZeroModelSelection {
  model: string | null;
  previousOverride: unknown;
  metadata: AgentZeroModelMetadata;
}

function assistantAggregate(
  segments: Map<string, { sequence: number; event: string; text: string }>,
): string {
  const ordered = [...segments.values()].sort((left, right) => left.sequence - right.sequence);
  const messages = ordered.filter((entry) => entry.event === 'assistant_message' && entry.text);
  if (messages.length > 0) return messages.map((entry) => entry.text).join('\n\n').slice(0, MAX_RESULT_LENGTH);
  return ordered
    .filter((entry) => entry.event === 'assistant_delta' && entry.text)
    .map((entry) => entry.text)
    .join('')
    .slice(0, MAX_RESULT_LENGTH);
}

export class AgentZeroProvider implements AgentProvider {
  readonly displayName = 'Agent Zero';
  readonly providerName: AgentProviderName = 'AGENT_ZERO';
  readonly supportsAbort = false;

  private readonly client: AgentZeroConnectorClient;
  private readonly hostGateway: AgentZeroHostGatewayController;
  private readonly validateModelSelection: (model: string) => Promise<AgentZeroSelectableOAuthModel>;
  private readonly activeRuns = new Map<AgentSessionId, symbol>();
  private readonly legacyHistoryImports = new Map<AgentSessionId, Promise<void>>();
  private messageIdCounter = 0;

  constructor(options: AgentZeroProviderOptions = {}) {
    this.client = options.client || new AgentZeroConnectorClient(options);
    this.hostGateway = options.hostGateway || getDefaultAgentZeroHostGatewayManager();
    this.validateModelSelection = options.validateModelSelection || validateAgentZeroOAuthModelSelection;
  }

  async getCapabilities(forceRefresh = false): Promise<AgentZeroCapabilities> {
    return this.client.getCapabilities(forceRefresh);
  }

  async startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId> {
    const ownerId = validateUserId(userId);
    assertExecutionContextBinding(config?.executionContext, ownerId);
    assertProviderSupportsExecutionScope(
      this.providerName,
      getProviderAvailability(this.providerName).capabilities.supportedExecutionScopes,
      config.executionContext,
    );
    await this.hostGateway.ensureReady();
    const agentProfile = validateAgentProfile(
      config?.metadata?.agentProfile ?? config?.metadata?.agent_profile,
    );
    const title = optionalMetadataString(config?.metadata, 'title', 128);
    let requestedModel = cleanString(config?.model, 384) || undefined;

    const capabilities = await this.client.getCapabilities();
    if (capabilities.features.includes('model_switcher') && !requestedModel) {
      throw new Error(
        'Choose a model from a connected Agent Zero OAuth provider before starting the chat.',
      );
    }
    if (requestedModel && !capabilities.features.includes('model_switcher')) {
      throw new Error('Agent Zero does not expose per-chat model selection on this connector.');
    }
    if (requestedModel && !capabilities.features.includes('chat_delete')) {
      throw new Error('Agent Zero cannot create a model-bound chat without verified context cleanup support.');
    }
    if (requestedModel) {
      requestedModel = (await this.validateModelSelection(requestedModel)).id;
    }

    let contextId: string | null = null;
    let localSessionId: string | null = null;
    let mayDeleteRemote = true;
    try {
      const raw = await this.client.call<unknown>('chat_create', {
        ...(agentProfile ? { agent_profile: agentProfile } : {}),
      });
      if (!isRecord(raw)) throw new Error('Agent Zero returned an invalid chat_create response.');
      contextId = validateContextId(raw.context_id);

      if (loadNativeSession('AGENT_ZERO', contextId)
        || remoteContextAlreadyBound(ownerId, contextId)) {
        mayDeleteRemote = false;
        throw new Error('Agent Zero returned a context identifier already bound in Portal.');
      }

      const local = createNativeSession('AGENT_ZERO', ownerId, {
        executionContext: config.executionContext,
        metadata: {
          ...(title ? { title } : {}),
          connectorProtocol: capabilities.protocol,
          agentZeroRemoteContextId: contextId,
          ...(agentProfile ? { agentProfile } : {}),
        },
      });
      localSessionId = local.sessionId;

      if (requestedModel) {
        const applied = await this.applyModelSelection(contextId, requestedModel);
        if (!updateNativeSessionModel('AGENT_ZERO', local.sessionId, applied.model)) {
          throw new Error('Portal could not persist the Agent Zero model selection.');
        }
      }
      return local.sessionId;
    } catch (error) {
      if (localSessionId) deleteNativeSession('AGENT_ZERO', localSessionId);
      if (contextId && mayDeleteRemote && capabilities.features.includes('chat_delete')) {
        try {
          await this.client.call('chat_delete', { context_id: contextId });
        } catch {
          throw new Error(
            'Agent Zero could not apply the selected model, and the failed remote context cleanup could not be confirmed.',
          );
        }
      }
      throw error;
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
    const session = this.requireSession(sessionId);
    if (sender && sender.userId !== session.userId) {
      throw new Error('Agent Zero session does not belong to the authenticated sender.');
    }
    const content = String(message || '').trim();
    if (!content) throw new Error('Agent Zero message cannot be empty.');
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Agent Zero message exceeds the ${MAX_MESSAGE_LENGTH}-character limit.`);
    }
    if (this.activeRuns.has(sessionId)) throw new Error('Agent Zero already has an active run for this session.');

    // An async function executes synchronously only until its first await.
    // Reserve this exact logical turn before gateway/readiness I/O so two
    // callers in the same tick cannot both pass the active-run guard.
    const runToken = Symbol('agent-zero-host-run');
    this.activeRuns.set(sessionId, runToken);

    try {
      // Re-prove the official Launcher gateway on every turn. A context can
      // outlive the bridge process, and silently falling back to container-local
      // tools would violate Main Agent Chat's full-host operator contract.
      await this.hostGateway.ensureReady();

      const remoteContextId = remoteContextIdForSession(session);
      const fromSequence = await this.assertRemoteIdle(remoteContextId, 'send another message');
      appendNativeMessage(session, {
        id: this.nextMessageId('user'),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });
      onStatus?.({ type: 'status', content: 'Connecting to Agent Zero stream…' });

      const assistantSegments = new Map<string, { sequence: number; event: string; text: string }>();
      let emittedText = '';
      const emitTextAggregate = () => {
        const aggregate = assistantAggregate(assistantSegments);
        if (!aggregate || aggregate === emittedText) return;
        if (aggregate.startsWith(emittedText)) {
          const delta = aggregate.slice(emittedText.length);
          emittedText = aggregate;
          if (delta) onChunk?.(delta);
          return;
        }
        if (emittedText.startsWith(aggregate)) return;
        emittedText = aggregate;
        onStatus?.({ type: 'text', content: aggregate, replace: true });
      };

      const stream = await this.client.streamMessage({
        contextId: remoteContextId,
        message: content,
        fromSequence,
        onTransportStatus: (status) => {
          if (status === 'reconnecting') onStatus?.({ type: 'status', content: 'Reconnecting to Agent Zero stream…' });
          else if (status === 'replayed') onStatus?.({ type: 'status', content: 'Replaying missed Agent Zero events…' });
          else onStatus?.({ type: 'status', content: 'Agent Zero stream connected.' });
        },
        onEvent: (event) => {
          const eventContent = connectorEventContent(event);
          const metadata = redactSensitiveObject(event.data.meta);
          if (event.event === 'assistant_message' || event.event === 'assistant_delta') {
            const assistantText = agentZeroResponseText(event.data.text);
            if (event.data.text?.trim() && !assistantText) {
              throw classifyAgentZeroError({
                heading: event.data.heading,
                text: event.data.text,
                meta: event.data.meta,
              });
            }
            assistantSegments.set(`${event.sequence}:${event.event}`, {
              sequence: event.sequence,
              event: event.event,
              text: assistantText,
            });
            emitTextAggregate();
            return;
          }
          if (event.event === 'tool_start') {
            onStatus?.({
              type: 'tool_start',
              content: eventContent,
              toolName: cleanString(event.data.heading, 160) || 'Agent Zero tool',
              toolArgs: metadata,
              sequence: event.sequence,
            });
            return;
          }
          if (event.event === 'tool_output') {
            onStatus?.({
              type: 'tool_update',
              content: eventContent,
              toolName: cleanString(event.data.heading, 160) || 'Agent Zero tool',
              toolResult: metadata,
              sequence: event.sequence,
            });
            return;
          }
          if (event.event === 'tool_end') {
            onStatus?.({
              type: 'tool_end',
              content: eventContent,
              toolName: cleanString(event.data.heading, 160) || 'Agent Zero tool',
              toolResult: metadata,
              sequence: event.sequence,
            });
            return;
          }
          if (event.event === 'code_start' || event.event === 'code_output') {
            onStatus?.({
              type: event.event === 'code_start' ? 'tool_start' : 'tool_update',
              content: eventContent,
              toolName: cleanString(event.data.heading, 160) || 'Agent Zero code execution',
              ...(event.event === 'code_start' ? { toolArgs: metadata } : { toolResult: metadata }),
              sequence: event.sequence,
            });
            return;
          }
          if (event.event === 'util_message') {
            onStatus?.({
              type: 'thinking',
              content: safeAgentZeroRuntimeEventMessage({
                heading: event.data.heading,
                text: event.data.text,
                meta: event.data.meta,
              }, 2_048),
              sequence: event.sequence,
            });
            return;
          }
          const diagnostic = event.event === 'error'
            ? classifyAgentZeroError({
              heading: event.data.heading,
              text: event.data.text,
              meta: event.data.meta,
            })
            : null;
          const severity = diagnostic
            ? 'error'
            : event.event === 'warning'
              ? 'warning'
              : 'info';
          onStatus?.({
            // Context log errors are not the connector's terminal settlement
            // signal. Only streamMessage rejection is route-authoritative.
            type: 'status',
            content: diagnostic?.message
              || safeAgentZeroRuntimeEventMessage({
                heading: event.data.heading,
                text: event.data.text,
                meta: event.data.meta,
              }, 2_048),
            severity,
            terminal: false,
            providerEvent: event.event,
            sequence: event.sequence,
            ...(diagnostic ? { diagnosticCode: diagnostic.code } : {}),
          });
        },
      });

      const streamedText = assistantAggregate(assistantSegments);
      const completedText = agentZeroResponseText(stream.response);
      if (stream.response !== undefined && stream.response !== null && !completedText) {
        // A0/LiteLLM may put a serialized provider failure only in the terminal
        // completion payload. Never turn that into a successful empty answer,
        // even when no assistant event was emitted first.
        throw classifyAgentZeroError(stream.response);
      }
      const fullText = completedText || streamedText;
      if (!fullText) {
        throw classifyAgentZeroError('Agent Zero completed without a usable assistant response.');
      }
      if (fullText && fullText !== emittedText) {
        if (fullText.startsWith(emittedText)) onChunk?.(fullText.slice(emittedText.length));
        else onStatus?.({ type: 'text', content: fullText, replace: true });
      }
      appendNativeMessage(session, {
        id: this.nextMessageId('assistant'),
        role: 'assistant',
        content: fullText,
        timestamp: new Date().toISOString(),
      });
      return {
        fullText,
        metadata: {
          provider: 'agent-zero',
          protocol: 'a0-connector.v1',
          contextId: sessionId,
          status: cleanString(stream.status, 64) || 'completed',
          streaming: true,
          replay: true,
          reconnects: stream.reconnects,
          eventsProcessed: stream.eventsProcessed,
          lastSequence: stream.lastSequence,
          supportsAbort: false,
          model: session.model || null,
        },
      };
    } finally {
      if (this.activeRuns.get(sessionId) === runToken) this.activeRuns.delete(sessionId);
      onStatus?.({ type: 'status', content: '' });
    }
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    await this.prepareHistory(sessionId);
    return readAllNativeSessionHistory('AGENT_ZERO', sessionId);
  }

  /**
   * Portal's append-only native sidecar is the authoritative transcript. The
   * connector is consulted only once for a pre-sidecar session whose local
   * transcript is still empty. A failed import is surfaced so the UI can show
   * Retry/Repair instead of falsely presenting an empty welcome screen.
   */
  async prepareHistory(sessionId: AgentSessionId): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.metadata?.[LEGACY_HISTORY_IMPORTED_AT_KEY]
      || readNativeSessionHistoryTail('AGENT_ZERO', sessionId, 1).messages.length > 0) {
      return;
    }
    const existing = this.legacyHistoryImports.get(sessionId);
    if (existing) return existing;

    const pending = this.importLegacyHistory(sessionId);
    this.legacyHistoryImports.set(sessionId, pending);
    try {
      await pending;
    } finally {
      if (this.legacyHistoryImports.get(sessionId) === pending) {
        this.legacyHistoryImports.delete(sessionId);
      }
    }
  }

  private async importLegacyHistory(sessionId: AgentSessionId): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.metadata?.[LEGACY_HISTORY_IMPORTED_AT_KEY]
      || readNativeSessionHistoryTail('AGENT_ZERO', sessionId, 1).messages.length > 0) {
      return;
    }
    const messages = await this.readRemoteLegacyHistory(session);
    const current = this.requireSession(sessionId);
    if (current.metadata?.[LEGACY_HISTORY_IMPORTED_AT_KEY]) return;
    // A send may have committed while the connector import was in flight. In
    // that case the sidecar wins; never append old remote rows after new local
    // turns and scramble the durable pagination order.
    if (readNativeSessionHistoryTail('AGENT_ZERO', sessionId, 1).messages.length > 0) return;
    for (const message of messages) appendNativeMessage(current, message);
    updateNativeSessionMetadata('AGENT_ZERO', sessionId, {
      [LEGACY_HISTORY_IMPORTED_AT_KEY]: new Date().toISOString(),
      agentZeroLegacyHistoryImportedMessages: messages.length,
    });
  }

  private async readRemoteLegacyHistory(session: NativeSessionData): Promise<AgentMessage[]> {
    const remoteContextId = remoteContextIdForSession(session);
    const chat = await this.client.call<unknown>(
      'chat_get',
      { context_id: remoteContextId },
      LEGACY_HISTORY_IMPORT_TIMEOUT_MS,
    );
    const chatData = isRecord(chat) ? chat : {};
    const returnedContext = validateContextId(chatData.context_id ?? chatData.id);
    if (returnedContext !== remoteContextId) {
      throw new Error('Agent Zero returned history metadata for a different context.');
    }
    const rawLastSequence = Number(chatData.last_sequence);
    const lastSequence = Number.isSafeInteger(rawLastSequence) && rawLastSequence > 0
      ? rawLastSequence
      : 0;
    let cursor = Math.max(0, lastSequence - MAX_HISTORY_EVENTS);
    let eventsRead = 0;
    const messages = new Map<string, { sequence: number; message: AgentMessage }>();

    for (let page = 0; page < MAX_HISTORY_PAGES && eventsRead < MAX_HISTORY_EVENTS; page += 1) {
      const limit = Math.min(HISTORY_PAGE_SIZE, MAX_HISTORY_EVENTS - eventsRead);
      const raw = await this.client.call<unknown>(
        'log_tail',
        {
          context_id: remoteContextId,
          after: cursor,
          limit,
        },
        LEGACY_HISTORY_IMPORT_TIMEOUT_MS,
      );
      if (!isRecord(raw)) throw new Error('Agent Zero returned an invalid history snapshot.');
      const events = Array.isArray(raw.events) ? raw.events.slice(0, limit) : [];
      for (let index = 0; index < events.length; index += 1) {
        const mapped = connectorEventMessage(session.sessionId, events[index], cursor + index + 1);
        if (mapped) messages.set(mapped.message.id, mapped);
      }

      eventsRead += events.length;
      cursor += events.length;
      if (events.length === 0 || raw.has_more !== true) break;
    }

    return [...messages.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.message);
  }

  async getHistoryPage(
    sessionId: AgentSessionId,
    limit: number,
    beforeSequence?: number,
  ): Promise<AgentZeroHistoryPage> {
    this.requireSession(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Agent Zero history page limit is invalid.');
    }
    if (beforeSequence === undefined) await this.prepareHistory(sessionId);
    const page = readNativeSessionHistoryPage(
      'AGENT_ZERO',
      sessionId,
      limit,
      beforeSequence,
    );
    return {
      messages: page.messages,
      hasMoreBefore: page.hasMore,
      beforeSequence: page.beforeOffset,
    };
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    const ownerId = validateUserId(userId);
    const localSessions = listNativeSessions('AGENT_ZERO', ownerId);
    for (const session of localSessions) this.requireSession(session.sessionId);
    return localSessions.map((local) => ({
      ...local,
      metadata: {
        ...(local.metadata || {}),
        provider: 'agent-zero',
        protocol: 'portal-native-history.v1',
        supportsAbort: false,
      },
    }));
  }

  async getSession(sessionId: AgentSessionId): Promise<AgentSessionSummary> {
    const local = this.requireSession(sessionId);
    const remoteContextId = remoteContextIdForSession(local);
    const raw = await this.client.call<unknown>('chat_get', { context_id: remoteContextId });
    if (!isRecord(raw)) throw new Error('Agent Zero returned an invalid chat_get response.');
    const returnedContext = validateContextId(raw.context_id ?? raw.id);
    if (returnedContext !== remoteContextId) {
      throw new Error('Agent Zero returned details for a different context.');
    }
    const localSummary = listNativeSessions('AGENT_ZERO', local.userId)
      .find((summary) => summary.sessionId === sessionId);
    if (!localSummary) throw new Error(`Agent Zero session not found: ${sessionId}`);
    return this.mapSessionSummary(localSummary, raw);
  }

  async resetSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.requireSession(sessionId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error('Agent Zero cannot reset a context while a streamed run is active.');
    }
    const remoteContextId = remoteContextIdForSession(session);
    await this.assertRemoteIdle(remoteContextId, 'reset the context');
    await this.client.call('chat_reset', { context_id: remoteContextId });
    clearNativeSessionHistory(session);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.requireSession(sessionId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error('Agent Zero cannot delete a context while a streamed run is active; hard abort is unsupported.');
    }
    const remoteContextId = remoteContextIdForSession(session);
    try {
      await this.assertRemoteIdle(remoteContextId, 'delete the context');
      await this.client.call('chat_delete', { context_id: remoteContextId });
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }
    deleteNativeSession('AGENT_ZERO', sessionId);
  }

  async pauseSession(sessionId: AgentSessionId): Promise<AgentZeroControlResult> {
    const session = this.requireSession(sessionId);
    const raw = await this.client.call<unknown>('pause', {
      context_id: remoteContextIdForSession(session),
      paused: true,
    });
    return controlResult(sessionId, raw);
  }

  async resumeSession(sessionId: AgentSessionId): Promise<AgentZeroControlResult> {
    const session = this.requireSession(sessionId);
    const raw = await this.client.call<unknown>('pause', {
      context_id: remoteContextIdForSession(session),
      paused: false,
    });
    return controlResult(sessionId, raw);
  }

  async nudgeSession(sessionId: AgentSessionId): Promise<AgentZeroControlResult> {
    const session = this.requireSession(sessionId);
    const raw = await this.client.call<unknown>('nudge', {
      context_id: remoteContextIdForSession(session),
    });
    return controlResult(sessionId, raw);
  }

  async abortActiveRun(_sessionId: AgentSessionId): Promise<boolean> {
    return false;
  }

  async getModelMetadata(sessionId?: AgentSessionId): Promise<AgentZeroModelMetadata> {
    const session = sessionId ? this.requireSession(sessionId) : null;
    const capabilities = await this.client.getCapabilities();
    if (capabilities.features.includes('model_switcher')) {
      const raw = await this.client.call<unknown>('model_switcher', {
        action: 'get',
        ...(session ? { context_id: remoteContextIdForSession(session) } : {}),
      });
      return modelMetadataFromResponse(raw);
    }
    if (capabilities.features.includes('model_presets')) {
      const raw = await this.client.call<unknown>('model_presets', { action: 'get' });
      return modelMetadataFromResponse(raw);
    }
    return {
      available: false,
      allowed: false,
      presets: [],
      providers: [],
    };
  }

  async setSessionModel(
    sessionId: AgentSessionId,
    model: string | null,
  ): Promise<AgentSessionModelResult> {
    const session = this.requireSession(sessionId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error('Agent Zero cannot change models while a streamed run is active.');
    }
    const capabilities = await this.client.getCapabilities();
    if (!capabilities.features.includes('model_switcher')) {
      throw new Error('Agent Zero does not expose per-chat model selection on this connector.');
    }
    const selectedModel = model === null
      ? null
      : (await this.validateModelSelection(model)).id;

    const remoteContextId = remoteContextIdForSession(session);
    await this.assertRemoteIdle(remoteContextId, 'change the model');
    const applied = await this.applyModelSelection(remoteContextId, selectedModel);
    const persisted = updateNativeSessionModel('AGENT_ZERO', sessionId, applied.model);
    if (!persisted) {
      try {
        await this.restoreModelSelection(remoteContextId, applied.previousOverride);
      } catch {
        throw new Error(
          'Agent Zero changed the remote model, but Portal could not persist or restore one consistent session model.',
        );
      }
      throw new Error('Portal could not persist the Agent Zero model selection. The prior remote selection was restored.');
    }
    return {
      model: applied.model,
      metadata: {
        provider: 'agent-zero',
        effectivePreset: applied.metadata.effectivePreset || null,
        mainModel: applied.metadata.mainModel || null,
      },
    };
  }

  private requireSession(sessionId: AgentSessionId): NativeSessionData {
    const contextId = validateContextId(sessionId);
    const session = loadNativeSession('AGENT_ZERO', contextId);
    if (session) {
      assertExecutionContextBinding(session.executionContext, session.userId, 'HOST_OPERATOR');
      assertProviderSupportsExecutionScope(
        this.providerName,
        getProviderAvailability(this.providerName).capabilities.supportedExecutionScopes,
        session.executionContext,
      );
      remoteContextIdForSession(session);
      return session;
    }
    throw new Error(`Agent Zero session not found: ${contextId}`);
  }

  private async applyModelSelection(
    contextId: string,
    requestedModel: string | null,
  ): Promise<AppliedAgentZeroModelSelection> {
    const rawState = await this.client.call<unknown>('model_switcher', {
      action: 'get',
      context_id: contextId,
    });
    const state = isRecord(rawState) ? rawState : {};
    if (state.allowed !== true) {
      throw new Error('Agent Zero per-chat model overrides are disabled.');
    }
    const previousOverride = state.override;

    if (requestedModel === null) {
      const rawCleared = await this.mutateModelSelection(
        contextId,
        previousOverride,
        { action: 'clear', context_id: contextId },
        (value) => Object.prototype.hasOwnProperty.call(value, 'override')
          && value.override === null,
        'Agent Zero did not confirm that the per-chat model override was cleared.',
      );
      return {
        model: null,
        previousOverride,
        metadata: modelMetadataFromResponse(rawCleared),
      };
    }

    const normalizedRequestedModel = cleanString(requestedModel, 384);
    if (!normalizedRequestedModel) {
      throw new Error('Choose an Agent Zero model before applying the selection.');
    }

    const presets = Array.isArray(state.presets) ? state.presets : [];
    const matchingPreset = presets.find((item) => (
      isRecord(item)
      && cleanString(item.name, 128).toLowerCase() === normalizedRequestedModel.toLowerCase()
    ));
    if (isRecord(matchingPreset)) {
      const presetName = cleanString(matchingPreset.name, 128);
      const chatModel = presetChatModel(matchingPreset);
      if (!chatModel) throw new Error(`Agent Zero preset '${presetName}' has no valid chat model.`);
      assertAgentZeroModelCredentials(state, chatModel);
      const rawApplied = await this.mutateModelSelection(
        contextId,
        previousOverride,
        {
          action: 'set_preset',
          context_id: contextId,
          preset_name: presetName,
        },
        (value) => cleanString(value.effective_preset, 128).toLowerCase() === presetName.toLowerCase(),
        'Agent Zero did not confirm the requested model preset.',
      );
      return {
        model: presetName,
        previousOverride,
        metadata: modelMetadataFromResponse(rawApplied),
      };
    }

    const model = parseModelSelection(normalizedRequestedModel);
    if (!model) {
      throw new Error(
        `Unknown Agent Zero preset '${normalizedRequestedModel}'. Use a preset name or provider/model identifier.`,
      );
    }
    assertAgentZeroModelCredentials(state, model);
    const appliedState = await this.mutateModelSelection(
      contextId,
      previousOverride,
      {
        action: 'set_override',
        context_id: contextId,
        main_model: model,
      },
      (value) => {
        const appliedMainModel = modelReference(value.main_model);
        return Boolean(appliedMainModel
          && appliedMainModel.provider.toLowerCase() === model.provider
          && appliedMainModel.name === model.name);
      },
      'Agent Zero did not confirm the requested per-chat model override.',
    );
    return {
      model: `${model.provider}/${model.name}`,
      previousOverride,
      metadata: modelMetadataFromResponse(appliedState),
    };
  }

  private async mutateModelSelection(
    contextId: string,
    previousOverride: unknown,
    payload: Record<string, unknown>,
    verify: (value: UnknownRecord) => boolean,
    failureMessage: string,
  ): Promise<UnknownRecord> {
    try {
      const raw = await this.client.call<unknown>('model_switcher', payload);
      if (!isRecord(raw) || !verify(raw)) throw new Error(failureMessage);
      return raw;
    } catch (error) {
      try {
        await this.restoreModelSelection(contextId, previousOverride);
      } catch {
        throw new Error(
          'Agent Zero could not prove or restore one consistent per-chat model after the model change failed.',
        );
      }
      throw error;
    }
  }

  private async restoreModelSelection(contextId: string, previousOverride: unknown): Promise<void> {
    if (!isRecord(previousOverride)) {
      const raw = await this.client.call<unknown>('model_switcher', {
        action: 'clear',
        context_id: contextId,
      });
      if (!isRecord(raw)
        || !Object.prototype.hasOwnProperty.call(raw, 'override')
        || raw.override !== null) {
        throw new Error('Agent Zero did not confirm the restored default model state.');
      }
      return;
    }

    const presetName = cleanString(
      previousOverride.preset_name ?? previousOverride.preset,
      128,
    );
    if (presetName) {
      const raw = await this.client.call<unknown>('model_switcher', {
        action: 'set_preset',
        context_id: contextId,
        preset_name: presetName,
      });
      if (!isRecord(raw)
        || cleanString(raw.effective_preset, 128).toLowerCase() !== presetName.toLowerCase()) {
        throw new Error('Agent Zero did not confirm the restored model preset.');
      }
      return;
    }

    const mainModel = modelReference(previousOverride.main_model ?? previousOverride.chat);
    if (!mainModel?.provider || !mainModel.name) {
      const raw = await this.client.call<unknown>('model_switcher', {
        action: 'clear',
        context_id: contextId,
      });
      if (!isRecord(raw)
        || !Object.prototype.hasOwnProperty.call(raw, 'override')
        || raw.override !== null) {
        throw new Error('Agent Zero did not confirm the restored default model state.');
      }
      return;
    }
    const utilityModel = modelReference(previousOverride.utility_model ?? previousOverride.utility);
    const embeddingModel = modelReference(previousOverride.embedding_model ?? previousOverride.embedding);
    const raw = await this.client.call<unknown>('model_switcher', {
      action: 'set_override',
      context_id: contextId,
      main_model: { provider: mainModel.provider, name: mainModel.name },
      ...(utilityModel?.provider && utilityModel.name
        ? { utility_model: { provider: utilityModel.provider, name: utilityModel.name } }
        : {}),
      ...(embeddingModel?.provider && embeddingModel.name
        ? { embedding_model: { provider: embeddingModel.provider, name: embeddingModel.name } }
        : {}),
    });
    if (!isRecord(raw)) {
      throw new Error('Agent Zero returned an invalid restored model state.');
    }
    const restoredMain = modelReference(raw.main_model);
    const restoredUtility = utilityModel ? modelReference(raw.utility_model) : null;
    const restoredEmbedding = embeddingModel ? modelReference(raw.embedding_model) : null;
    const matches = restoredMain?.provider === mainModel.provider
      && restoredMain.name === mainModel.name
      && (!utilityModel || (
        restoredUtility?.provider === utilityModel.provider
        && restoredUtility.name === utilityModel.name
      ))
      && (!embeddingModel || (
        restoredEmbedding?.provider === embeddingModel.provider
        && restoredEmbedding.name === embeddingModel.name
      ));
    if (!matches) {
      throw new Error('Agent Zero did not confirm the restored per-chat model override.');
    }
  }

  private async assertRemoteIdle(contextId: string, action: string): Promise<number> {
    const raw = await this.client.call<unknown>('chat_get', { context_id: contextId });
    if (!isRecord(raw)) throw new Error('Agent Zero returned an invalid chat_get response.');
    const returnedContext = validateContextId(raw.context_id ?? raw.id);
    if (returnedContext !== contextId) {
      throw new Error('Agent Zero returned state for a different context.');
    }
    if (raw.running === true) {
      throw new Error(
        `Agent Zero is still running and cannot ${action}; hard abort is unsupported by connector v1.`,
      );
    }
    const cursor = Number(raw.last_sequence);
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  }

  private mapSessionSummary(
    local: AgentSessionSummary,
    remote?: UnknownRecord,
  ): AgentSessionSummary {
    if (!remote) {
      return {
        ...local,
        status: 'terminated',
        metadata: {
          ...(local.metadata || {}),
          provider: 'agent-zero',
          protocol: 'a0-connector.v1',
          supportsAbort: false,
          remotePresent: false,
        },
      };
    }

    const createdAt = normalizeTimestamp(remote.created_at, local.createdAt);
    const lastActivityAt = normalizeTimestamp(remote.last_message, local.lastActivityAt);
    const name = summarize(remote.name, 72);
    return {
      ...local,
      status: 'active',
      createdAt,
      lastActivityAt,
      title: name || local.title,
      metadata: {
        ...(local.metadata || {}),
        provider: 'agent-zero',
        protocol: 'a0-connector.v1',
        supportsAbort: false,
        remotePresent: true,
        running: remote.running === true,
        agentProfile: cleanString(remote.agent_profile, MAX_AGENT_PROFILE_LENGTH) || undefined,
        projectName: cleanString(remote.project_name, 256) || undefined,
      },
    };
  }

  private nextMessageId(role: AgentMessage['role']): string {
    this.messageIdCounter += 1;
    return `agent-zero-${role}-${Date.now()}-${this.messageIdCounter}`;
  }
}
