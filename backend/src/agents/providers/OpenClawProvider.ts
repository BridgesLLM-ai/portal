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
const OPENCLAW_STREAM_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

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
  onChunk?: OnChunkCallback,
  onStatus?: (statusEvent: { type: string; content: string; [key: string]: any }) => void,
  onExecApproval?: OnExecApprovalCallback,
  inactivityTimeoutMs = OPENCLAW_STREAM_INACTIVITY_TIMEOUT_MS,
): Promise<AgentSendResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubBus: (() => void) | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (unsubBus) { unsubBus(); unsubBus = null; }
      // Don't call clearStream here. PersistentGatewayWs owns lifecycle cleanup,
      // and a timeout should not make the frontend lose a stream that may resume.
      reject(err);
    };

    const resetInactivityTimer = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fail(new Error(`OpenClaw streaming timed out after ${Math.round(inactivityTimeoutMs / 1000)}s of inactivity`));
      }, inactivityTimeoutMs);
    };

    const done = (result: AgentSendResult) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (unsubBus) { unsubBus(); unsubBus = null; }
      resolve(result);
    };

    resetInactivityTimer();

    // Subscribe to StreamEventBus BEFORE sending the message.
    // This ensures we don't miss any events if the response is very fast.
    // Note: PersistentGatewayWs.handleAgentEvent() also calls startStream()
    // when the first event arrives. This pre-registration just ensures the
    // subscriber is in place before events can arrive.
    unsubBus = streamEventBus.subscribe(sessionId, (evt: StreamEvent) => {
      if (settled) return;
      resetInactivityTimer();

      switch (evt.type) {
        case 'text':
          onChunk?.(evt.content || '');
          break;
        case 'thinking':
          onStatus?.({ type: 'thinking', content: evt.content || '' });
          break;
        case 'tool_start':
          onStatus?.({ type: 'tool_start', content: evt.content || '', toolName: evt.toolName, toolArgs: evt.toolArgs });
          break;
        case 'tool_end':
          onStatus?.({ type: 'tool_end', content: evt.content || '', toolName: evt.toolName, toolResult: evt.toolResult });
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
          done({ fullText: evt.content || '', metadata: { runStatus: 'completed' } });
          break;
        case 'error':
          fail(new Error(evt.content || 'Agent error'));
          break;
      }
    });

    sendChatMessage(sessionId, message, idempotencyKey)
      .then(({ runId }) => {
        debugLog(`chat.send accepted: sessionKey=${sessionId} runId=${runId}`);
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
      })
      .catch((err) => {
        fail(new Error(`chat.send failed: ${err.message}`));
      });
  });
}

export class OpenClawProvider implements AgentProvider {
  readonly displayName = 'OpenClaw';
  readonly providerName: AgentProviderName = 'OPENCLAW';

  async startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId> {
    const slug = String(config?.metadata?.sessionSlug || '').trim();
    const resolvedSlug = slug
      ? (slug.startsWith('portal-') ? slug : `portal-${slug}`)
      : `portal-${userId}`;
    const sessionKey = `agent:main:${resolvedSlug}`;

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
    const idempotencyKey = `portal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
    const result = await gatewayRpcCall('sessions.list', { agentId: 'main' });
    if (!result.ok || !result.data?.sessions) return [];

    const prefix = `agent:main:portal-${userId}`;
    return (result.data.sessions as any[])
      .filter((s: any) => {
        const key = String(s.key || '');
        return key.startsWith(prefix) && !key.endsWith('-codex') && !key.endsWith('-claude');
      })
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
