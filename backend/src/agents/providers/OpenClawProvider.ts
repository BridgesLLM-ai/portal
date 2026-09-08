import {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentMessage,
  AgentSendResult,
  AgentSessionSummary,
  ListOpenClawSessionsOptions,
  OnChunkCallback,
  SenderIdentity,
} from '../AgentProvider.interface';
import {
  sendChatMessage,
  isConnected as isPersistentWsConnected,
} from './PersistentGatewayWs';
import { streamEventBus, type StreamEvent } from '../../services/StreamEventBus';
import { hasGatewayToken } from '../../utils/gatewayToken';
import { getProviderCapabilities } from '../providerAvailability';
import { assertExecutionContextBinding, assertProviderSupportsExecutionScope } from '../executionScope';
import { prisma } from '../../config/database';
import { isHostAdoptableOpenClawSession } from '../openclawSessionOwnership';
import { buildPortalOpenClawIdempotencyKey } from './PortalMessageIdentity';

const DEBUG_GATEWAY_WS = process.env.DEBUG_GATEWAY_WS === '1';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_GATEWAY_WS) console.log('[OpenClawProvider]', ...args);
};

// Exec approval request from gateway
export interface ExecApprovalRequest {
  id: string;
  request: {
    command: string;
    cwd?: string;
    host?: string;
    security?: string;
    ask?: string;
    agentId?: string;
    sessionKey?: string;
    resolvedPath?: string;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

export type OnExecApprovalCallback = (approval: ExecApprovalRequest) => void;

import {
  gatewayRpcCall,
  patchSessionModel,
  deleteSession,
  getSessionHistory,
} from '../../utils/openclawGatewayRpc';
import { extractTextFromContent as extractSanitizedText } from '../../utils/chatText';
import { createHash } from 'crypto';

const OPENCLAW_STREAM_INACTIVITY_TIMEOUT_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.OPENCLAW_STREAM_INACTIVITY_TIMEOUT_MS) || 12 * 60 * 60 * 1000,
);
const OPENCLAW_ABORT_SETTLEMENT_WAIT_MS = 15_000;

function upstreamRunIdForPortalRun(runId: string): string {
  const normalized = runId.trim();
  return normalized.startsWith('portal-') ? normalized : `portal-${normalized}`;
}

function hasAuthoritativeOpenClawTerminalSnapshot(
  payload: unknown,
  expectedRunId: string,
): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const snapshot = payload as Record<string, unknown>;
  if (snapshot.runId !== expectedRunId) return false;
  if (!['ok', 'error', 'timeout'].includes(String(snapshot.status || ''))) return false;
  const endedAt = snapshot.endedAt;
  if (typeof endedAt === 'number') return Number.isFinite(endedAt) && endedAt >= 0;
  if (typeof endedAt === 'string' && endedAt.trim()) {
    return Number.isFinite(new Date(endedAt).getTime());
  }
  return false;
}

async function waitForAuthoritativeOpenClawRunTerminal(runId: string): Promise<boolean> {
  const result = await gatewayRpcCall(
    'agent.wait',
    { runId, timeoutMs: OPENCLAW_ABORT_SETTLEMENT_WAIT_MS },
    OPENCLAW_ABORT_SETTLEMENT_WAIT_MS + 5_000,
  );
  return result.ok && hasAuthoritativeOpenClawTerminalSnapshot(result.data, runId);
}

function extractText(content: unknown): string {
  return extractSanitizedText(content);
}

function projectGatewayHistoryMessage(entry: any, index: number): AgentMessage | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rawRole = String(entry.role || '').trim();
  const role: AgentMessage['role'] | null = rawRole === 'user'
    ? 'user'
    : rawRole === 'assistant'
      ? 'assistant'
      : rawRole === 'system' || rawRole === 'toolResult' || rawRole === 'tool'
        ? 'system'
        : null;
  if (!role) return null;

  const content = extractText(entry.content ?? entry.text ?? '');
  const contentToolCalls = Array.isArray(entry.content)
    ? entry.content.flatMap((block: any) => {
        if (!block || typeof block !== 'object') return [];
        if (!['toolCall', 'tool_use'].includes(String(block.type || '')) || !block.name) return [];
        return [{
          id: block.id,
          name: block.name,
          arguments: block.arguments ?? block.input,
        }];
      })
    : [];
  const toolCalls = Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0
    ? entry.toolCalls
    : contentToolCalls;
  if (!content && toolCalls.length === 0 && role !== 'system') return null;

  const timestamp = normalizeSessionTimestamp(entry.timestamp ?? entry.createdAt);
  const projected = {
    id: String(entry.id || entry.__openclaw?.id || createHash('sha256')
      .update(`${index}\0${role}\0${timestamp}\0${content}`)
      .digest('hex')),
    role,
    content,
    timestamp,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
  };
  return projected as AgentMessage;
}

/**
 * Send a message via the persistent WebSocket and wait for completion via StreamEventBus.
 * 
 * This replaces the old per-message WS approach. The persistent WS in PersistentGatewayWs
 * handles all event processing. We just:
 *   1. Subscribe to StreamEventBus for callbacks
 *   2. Send chat.send via the persistent WS
 *   3. Wait for 'done' or 'error' from StreamEventBus
 */
function sendMessageViaPersistentWs(
  sessionId: AgentSessionId,
  message: string,
  idempotencyKey: string,
  routeReservationRunId: string | undefined,
  onProviderDispatchAccepted?: (upstreamRunId: string) => Promise<void>,
  onChunk?: OnChunkCallback,
  onStatus?: (statusEvent: { type: string; content: string; [key: string]: any }) => void,
  onExecApproval?: OnExecApprovalCallback,
  inactivityTimeoutMs = OPENCLAW_STREAM_INACTIVITY_TIMEOUT_MS,
): Promise<AgentSendResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let dispatchAcknowledged = false;
    let pendingTerminal:
      | { kind: 'done'; result: AgentSendResult }
      | { kind: 'error'; error: Error }
      | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubBus: (() => void) | null = null;

    const settleError = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (unsubBus) { unsubBus(); unsubBus = null; }
      // Don't call clearStream here. PersistentGatewayWs owns lifecycle cleanup,
      // and a timeout should not make the frontend lose a stream that may resume.
      reject(err);
    };

    const fail = (err: Error) => {
      if (!dispatchAcknowledged) {
        pendingTerminal = { kind: 'error', error: err };
        return;
      }
      settleError(err);
    };

    const resetInactivityTimer = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        settleError(new Error(`OpenClaw streaming timed out after ${Math.round(inactivityTimeoutMs / 1000)}s of inactivity`));
      }, inactivityTimeoutMs);
    };

    const settleDone = (result: AgentSendResult) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (unsubBus) { unsubBus(); unsubBus = null; }
      resolve(result);
    };

    const done = (result: AgentSendResult) => {
      if (!dispatchAcknowledged) {
        pendingTerminal = { kind: 'done', result };
        return;
      }
      settleDone(result);
    };

    resetInactivityTimer();

    // Subscribe to StreamEventBus BEFORE sending the message.
    // This ensures we don't miss any events if the response is very fast.
    // Note: PersistentGatewayWs.handleAgentEvent() also calls startStream()
    // when the first event arrives. This pre-registration just ensures the
    // subscriber is in place before events can arrive.
    unsubBus = streamEventBus.subscribe(sessionId, (evt: StreamEvent) => {
      if (settled) return;
      // Broker envelopes are this provider's own callbacks re-broadcast for
      // browser relays; consuming them here would loop the event back into
      // the broker forever.
      if (evt.brokerEnvelope) return;
      resetInactivityTimer();

      switch (evt.type) {
        case 'text':
          onChunk?.(evt.content || '');
          break;
        case 'thinking':
          onStatus?.({ ...evt, type: 'thinking', content: evt.content || '' });
          break;
        case 'tool_start':
          onStatus?.({
            ...evt,
            type: 'tool_start',
            content: evt.content || '',
            toolName: evt.toolName,
            toolArgs: evt.toolArgs,
            toolCallId: evt.toolCallId,
          });
          break;
        case 'tool_update':
          onStatus?.({
            ...evt,
            type: 'tool_update',
            content: evt.content || '',
            toolName: evt.toolName,
            toolResult: evt.toolResult,
            toolCallId: evt.toolCallId,
          });
          break;
        case 'tool_end':
          onStatus?.({
            ...evt,
            type: 'tool_end',
            content: evt.content || '',
            toolName: evt.toolName,
            toolResult: evt.toolResult,
            toolCallId: evt.toolCallId,
            status: evt.status,
            exitCode: evt.exitCode,
          });
          break;
        case 'segment_break':
          onStatus?.({ type: 'segment_break', content: '' });
          break;
        case 'status':
          onStatus?.(evt as any);
          break;
        case 'compaction_start':
          onStatus?.({ type: 'compaction_start', content: evt.content || 'Compacting context…' });
          break;
        case 'compaction_end':
          onStatus?.({ type: 'compaction_end', content: evt.content || 'Context compacted' });
          break;
        case 'done':
          done({
            fullText: typeof evt.aggregateContent === 'string'
              ? evt.aggregateContent
              : (evt.content || ''),
            metadata: { runStatus: 'completed' },
          });
          break;
        case 'error':
          fail(new Error(evt.content || 'Agent error'));
          break;
      }
    }, { role: 'provider-waiter' });

    sendChatMessage(
      sessionId,
      message,
      idempotencyKey,
      routeReservationRunId,
      onProviderDispatchAccepted,
    )
      .then(async ({ runId }) => {
        debugLog(`chat.send accepted: sessionKey=${sessionId} runId=${runId}`);
        dispatchAcknowledged = true;
        if (runId) {
          streamEventBus.updateStreamPhase(sessionId, {
            phase: 'thinking',
            runId,
            statusText: 'Thinking…',
          });
          streamEventBus.publish(sessionId, {
            type: 'status',
            content: 'Thinking…',
            runId,
          });
        }
        resetInactivityTimer();
        if (pendingTerminal?.kind === 'done') {
          settleDone(pendingTerminal.result);
        } else if (pendingTerminal?.kind === 'error') {
          settleError(pendingTerminal.error);
        }
        pendingTerminal = null;
      })
      .catch((err) => {
        settleError(new Error(`chat.send failed: ${err.message}`));
      });
  });
}

const SESSION_TITLE_MAX_LENGTH = 120;
const LEGACY_PORTAL_SESSION_DISPLAY_NAME = 'Portal Backend RPC';

/**
 * Plain-text title for a session, as OpenClaw itself named it.
 *
 * `displayName` is an operator-set label and wins; `derivedTitle` is the one
 * OpenClaw generates from the conversation. Both arrive with markdown emphasis
 * intact (`**Portal update triage**`) because they are written for a markdown
 * surface, and the session picker renders text — so strip it here rather than
 * teaching every consumer to.
 */
function openClawSessionTitle(session: { displayName?: unknown; derivedTitle?: unknown }): string {
  const raw = String(session?.displayName || session?.derivedTitle || '').trim();
  if (!raw) return '';
  const plain = raw
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  return plain.length > SESSION_TITLE_MAX_LENGTH
    ? `${plain.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : plain;
}

function legacyPortalSessionDisplayLabel(session: {
  key?: unknown;
  displayName?: unknown;
  derivedTitle?: unknown;
}): string | null {
  if (String(session.displayName || '').trim() !== LEGACY_PORTAL_SESSION_DISPLAY_NAME) return null;
  const derived = openClawSessionTitle({ derivedTitle: session.derivedTitle });
  if (derived && derived !== LEGACY_PORTAL_SESSION_DISPLAY_NAME) return derived;
  const key = String(session.key || '').trim();
  if (!key) return null;
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 6);
  return `Portal chat · ${suffix}`;
}

/**
 * The gateway reports activity as epoch milliseconds; AgentSessionSummary is
 * declared as ISO strings and the frontend sorts on it. Passing the raw value
 * through produced a mix of numbers and strings in one list.
 */
function normalizeSessionTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export class OpenClawProvider implements AgentProvider {
  readonly displayName = 'OpenClaw';
  readonly providerName: AgentProviderName = 'OPENCLAW';

  async startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId> {
    assertExecutionContextBinding(config.executionContext, userId);
    assertProviderSupportsExecutionScope(
      this.providerName,
      getProviderCapabilities(this.providerName)?.supportedExecutionScopes,
      config.executionContext,
    );
    const agentId = String(config?.metadata?.agentId || 'main').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      throw new Error('Invalid OpenClaw agent');
    }
    const actorUserId = String(userId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorUserId)) {
      throw new Error('Invalid Portal actor identity');
    }
    const slug = String(config?.metadata?.sessionSlug || '').trim();
    const actorPrefix = `portal-${actorUserId}`;
    if (
      slug.startsWith(actorPrefix)
      && slug !== actorPrefix
      && !slug.startsWith(`${actorPrefix}-`)
    ) {
      throw new Error('Invalid OpenClaw session slug');
    }
    const requestedSuffix = slug === actorPrefix
      ? ''
      : slug.startsWith(`${actorPrefix}-`)
        ? slug.slice(actorPrefix.length + 1)
        : slug;
    const safeSlug = requestedSuffix
      .replace(/^portal-new-/, 'new-')
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96);
    const resolvedSlug = `${actorPrefix}${safeSlug && safeSlug !== 'main' ? `-${safeSlug}` : ''}`;
    const sessionKey = `agent:${agentId}:${resolvedSlug}`;

    if (config?.model) {
      await patchSessionModel(sessionKey, config.model);
    }
    return sessionKey;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: (statusEvent: { type: string; content: string; [key: string]: any }) => void,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const durableRequestId = typeof sender?.requestId === 'string' && sender.requestId.trim()
      ? sender.requestId.trim()
      : '';
    const idempotencyKey = durableRequestId
      ? buildPortalOpenClawIdempotencyKey(durableRequestId, sender?.clientMessageId)
      : `portal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    debugLog(`sendMessage: sessionId=${sessionId} idempotencyKey=${idempotencyKey} sender=${sender?.label || 'anonymous'}`);

    if (!isPersistentWsConnected()) {
      // Try one reconnect before giving up
      const { reconnectNow } = await import('./PersistentGatewayWs');
      reconnectNow();
      // Wait up to 15s for connection because OpenClaw reloads can briefly
      // drop the gateway websocket before it comes back.
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (isPersistentWsConnected()) break;
      }
      if (!isPersistentWsConnected()) {
        if (!hasGatewayToken()) {
          throw new Error('OpenClaw gateway is not configured. No gateway token found in environment or openclaw.json. Run "openclaw onboard" to configure.');
        }
        throw new Error('Cannot connect to OpenClaw gateway. Check that the openclaw-gateway service is running and the gateway token matches.');
      }
    }

    return sendMessageViaPersistentWs(
      sessionId,
      message,
      idempotencyKey,
      durableRequestId || undefined,
      sender?.onProviderDispatchAccepted,
      onChunk,
      onStatus,
      onExecApproval,
      OPENCLAW_STREAM_INACTIVITY_TIMEOUT_MS,
    );
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    const history = await getSessionHistory(sessionId, { limit: 200 });
    if (!history.ok || !history.data) {
      throw new Error(history.error || 'OpenClaw chat.history failed');
    }
    return history.data.messages
      .map(projectGatewayHistoryMessage)
      .filter((message): message is AgentMessage => Boolean(message));
  }

  async listSessions(
    userId: string,
    options: ListOpenClawSessionsOptions = {},
  ): Promise<AgentSessionSummary[]> {
    const claims = await prisma.agentSession.findMany({
      where: {
        userId,
        provider: 'OPENCLAW',
      },
      select: { externalId: true },
    });
    const ownedKeys = new Set(
      claims
        .map((claim) => String(claim.externalId || '').trim())
        .filter(Boolean),
    );

    const agentIds = new Set<string>();
    for (const key of ownedKeys) {
      const match = /^agent:([^:]+):/.exec(key);
      if (match?.[1] && /^[a-zA-Z0-9_-]{1,64}$/.test(match[1])) {
        agentIds.add(match[1]);
      }
    }
    // The host operator's own sessions usually have no claim row yet — they
    // were created outside the Portal — so the claim set cannot be the only
    // source of agents to sweep.
    if (options.includeHostSessions) {
      for (const rawAgentId of options.hostAgentIds || []) {
        const agentId = String(rawAgentId || '').trim();
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) agentIds.add(agentId);
      }
    }
    if (agentIds.size === 0) return [];

    const snapshots = await Promise.all(Array.from(agentIds).map(async (agentId) => {
      const result = await gatewayRpcCall('sessions.list', { agentId });
      return result.ok && Array.isArray(result.data?.sessions)
        ? result.data.sessions as any[]
        : [];
    }));

    const seen = new Set<string>();
    const visibleSessions = snapshots
      .flat()
      .filter((session: any) => {
        const key = String(session.key || '').trim();
        if (!key || seen.has(key)) return false;
        const visible = ownedKeys.has(key)
          || (options.includeHostSessions && isHostAdoptableOpenClawSession(session, userId));
        if (!visible) return false;
        seen.add(key);
        return true;
      });
    return visibleSessions
      .map((s: any) => {
        // OpenClaw already names every conversation from its own content and
        // reports it as displayName/derivedTitle. Dropping those was why Agent
        // Chat could only ever show `Session 0b3a4512` for a real chat.
        // Historical gateway-client fallback names are presentation debris.
        // Correct them locally, but never mutate from this polled read path:
        // sessions.patch has no compare-and-set guard and could overwrite an
        // operator rename made after the sessions.list snapshot was captured.
        const title = legacyPortalSessionDisplayLabel(s) || openClawSessionTitle(s);
        return {
          sessionId: s.key,
          status: 'active' as const,
          createdAt: normalizeSessionTimestamp(s.createdAt ?? s.startedAt ?? s.updatedAt),
          // `updatedAt` is the field the gateway actually reports; without it
          // every session claimed to have been touched at list time, so the
          // list could not be ordered by recency.
          lastActivityAt: normalizeSessionTimestamp(s.lastActivityAt ?? s.updatedAt),
          ...(title ? { title } : {}),
          metadata: { model: s.model },
        };
      });
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    await deleteSession(sessionId);
  }

  async abortActiveRun(sessionId: AgentSessionId, expectedRunId?: string): Promise<boolean> {
    const requestedRunId = typeof expectedRunId === 'string' && expectedRunId.trim()
      ? upstreamRunIdForPortalRun(expectedRunId)
      : '';
    const result = await gatewayRpcCall(
      'chat.abort',
      {
        sessionKey: sessionId,
        ...(requestedRunId ? { runId: requestedRunId } : {}),
      },
      15_000,
    );
    if (requestedRunId) {
      // chat.abort is a run-bound cancellation request, not a settlement
      // barrier. agent.wait is the Gateway's authoritative terminal snapshot;
      // it also closes the race where the run completed just before abort.
      return waitForAuthoritativeOpenClawRunTerminal(requestedRunId);
    }
    if (!result.ok || result.data?.aborted === false) return false;
    const abortedRunIds = Array.isArray(result.data?.runIds)
      ? result.data.runIds.filter(
          (runId: unknown): runId is string => typeof runId === 'string' && !!runId.trim(),
        )
      : [];
    if (abortedRunIds.length === 0) return false;
    const terminal = await Promise.all(
      abortedRunIds.map((runId: string) => waitForAuthoritativeOpenClawRunTerminal(runId)),
    );
    return terminal.every(Boolean);
  }
}

/**
 * Resolve an exec approval request via the persistent WebSocket.
 */
export async function resolveExecApproval(
  approvalId: string,
  decision: 'allow-once' | 'deny' | 'allow-always',
): Promise<{ ok: boolean; error?: string }> {
  // Import sendApprovalDecision from PersistentGatewayWs
  const { sendApprovalDecision } = await import('./PersistentGatewayWs');
  return sendApprovalDecision(approvalId, decision);
}

export function getPendingApprovalsCount(): number {
  return 0; // No per-message WS connections to track anymore
}

export const __openClawProviderTest = {
  upstreamRunIdForPortalRun,
  hasAuthoritativeOpenClawTerminalSnapshot,
  legacyPortalSessionDisplayLabel,
};
