import {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentMessage,
  AgentSendResult,
  AgentSessionSummary,
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
} from '../../utils/openclawGatewayRpc';
import { extractTextFromContent as extractSanitizedText } from '../../utils/chatText';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const AGENTS_BASE = path.join(process.env.HOME || '/root', '.openclaw/agents');
const SESSIONS_DIR = path.join(AGENTS_BASE, 'main/sessions');
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

function resolveAgentSessionsDir(sessionKey?: string): string {
  if (!sessionKey) return SESSIONS_DIR;
  const match = sessionKey.match(/^agent:([a-zA-Z0-9_-]+):/);
  if (!match) return SESSIONS_DIR;
  const agentDir = path.join(AGENTS_BASE, match[1], 'sessions');
  return existsSync(agentDir) ? agentDir : SESSIONS_DIR;
}

function extractText(content: unknown): string {
  return extractSanitizedText(content);
}

async function readSessionMessages(sessionFileId: string, limit = 200, sessionsDir = SESSIONS_DIR): Promise<AgentMessage[]> {
  const filePath = path.join(sessionsDir, `${sessionFileId}.jsonl`);
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim());
  const messages: AgentMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || !entry.message) continue;
      const role = entry.message.role as string;
      const content = entry.message.content;

      if (role === 'user') {
        const text = extractText(content);
        if (text) {
          messages.push({
            id: entry.id || '',
            role: 'user',
            content: text,
            timestamp: entry.timestamp || new Date().toISOString(),
          });
        }
      } else if (role === 'assistant') {
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          const toolCalls: any[] = [];
          for (const block of content) {
            if (block.type === 'text' && block.text) textParts.push(block.text);
            else if (block.type === 'toolCall' && block.name) {
              toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
            }
          }
          const text = extractSanitizedText(textParts.join('\n'));
          if (text || toolCalls.length > 0) {
            messages.push({
              id: entry.id || '',
              role: 'assistant',
              content: text,
              timestamp: entry.timestamp || new Date().toISOString(),
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            } as any);
          }
        } else {
          const text = extractText(content);
          if (text) {
            messages.push({
              id: entry.id || '',
              role: 'assistant',
              content: text,
              timestamp: entry.timestamp || new Date().toISOString(),
            });
          }
        }
      } else if (role === 'toolResult') {
        messages.push({
          id: entry.id || '',
          role: 'system' as any,
          content: extractText(content),
          timestamp: entry.timestamp || new Date().toISOString(),
          toolCallId: entry.message.toolCallId,
          toolName: entry.message.toolName,
        } as any);
      } else if (role === 'system') {
        const text = extractText(content);
        if (text) {
          messages.push({
            id: entry.id || '',
            role: 'system',
            content: text,
            timestamp: entry.timestamp || new Date().toISOString(),
          });
        }
      }
    } catch {
      // ignore malformed line
    }
  }

  return messages.slice(-limit);
}

function resolveSessionFileId(sessionKey: string, sessionsDir = SESSIONS_DIR): string | null {
  const sessionsFile = path.join(sessionsDir, 'sessions.json');
  if (!existsSync(sessionsFile)) return null;

  try {
    const data = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
    // data.sessions may be an empty array (truthy in JS), so fall back to top-level dict
    const raw = data.sessions;
    const sessions = (Array.isArray(raw) && raw.length === 0) ? data : (raw || data);

    if (typeof sessions === 'object' && !Array.isArray(sessions)) {
      const entry = sessions[sessionKey];
      return entry?.sessionId || entry?.id || null;
    }
    if (Array.isArray(sessions)) {
      const match = sessions.find((s: any) => s.key === sessionKey || s.id === sessionKey);
      return match?.sessionId || match?.id || null;
    }
  } catch {}

  const directFile = path.join(sessionsDir, `${sessionKey}.jsonl`);
  return existsSync(directFile) ? sessionKey : null;
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
    });

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
      ? `portal-${durableRequestId}`
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
    const sessionsDir = resolveAgentSessionsDir(sessionId);
    const fileId = resolveSessionFileId(sessionId, sessionsDir);
    if (!fileId) return [];
    return readSessionMessages(fileId, 200, sessionsDir);
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
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
    if (ownedKeys.size === 0) return [];

    const agentIds = new Set<string>();
    for (const key of ownedKeys) {
      const match = /^agent:([^:]+):/.exec(key);
      if (match?.[1] && /^[a-zA-Z0-9_-]{1,64}$/.test(match[1])) {
        agentIds.add(match[1]);
      }
    }

    const snapshots = await Promise.all(Array.from(agentIds).map(async (agentId) => {
      const result = await gatewayRpcCall('sessions.list', { agentId });
      return result.ok && Array.isArray(result.data?.sessions)
        ? result.data.sessions as any[]
        : [];
    }));

    return snapshots
      .flat()
      .filter((session: any) => ownedKeys.has(String(session.key || '').trim()))
      .map((s: any) => ({
        sessionId: s.key,
        status: 'active' as const,
        createdAt: s.createdAt || new Date().toISOString(),
        lastActivityAt: s.lastActivityAt || new Date().toISOString(),
        metadata: { model: s.model },
      }));
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
};
