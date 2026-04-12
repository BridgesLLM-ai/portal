/**
 * useAgentRuntime — thin wrapper that bridges assistant-ui's ExternalStoreAdapter
 * to the ChatStateContext (which owns all chat state and WS handling).
 *
 * Previously this hook (~1000 lines) owned all state, WS connection, history
 * loading, and streaming logic. That has been lifted to ChatStateProvider so
 * state survives route navigation. This hook now:
 *
 *   1. Consumes ChatStateContext
 *   2. Syncs provider/session/model/agentId options into the context
 *   3. Converts ChatMessage[] → ThreadMessageLike[] for assistant-ui
 *   4. Returns the same interface it always did (no breaking changes)
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type ExternalStoreAdapter,
  type AppendMessage,
} from '@assistant-ui/react';
import {
  useChatState,
  type ChatMessage,
  type ToolCall,
  type ExecApprovalRequest,
  type StreamingPhase,
} from '../../contexts/ChatStateProvider';
import sounds from '../../utils/sounds';

// Re-export types for consumers that import from this file
export type { ChatMessage, ToolCall, ExecApprovalRequest, StreamingPhase };

function toThreadMessage(msg: ChatMessage): ThreadMessageLike {
  return {
    id: msg.id,
    role: msg.role === 'toolResult' ? 'system' : msg.role,
    content: msg.role === 'toolResult'
      ? 'Tool result (' + (msg.toolName || 'unknown') + '): ' + msg.content.substring(0, 200) + (msg.content.length > 200 ? '\u2026' : '')
      : msg.content,
    createdAt: msg.createdAt,
  };
}

function extractTextFromAppendMessage(msg: AppendMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as readonly { type: string; text?: string }[])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('\n');
  }
  return '';
}

/* ─── Hook ─────────────────────────────────────────────────────────────── */

export function useAgentRuntime(options: {
  provider?: string;
  session?: string;
  model?: string;
  agentId?: string;
  onSessionResolved?: (resolvedId: string) => void;
}) {
  const ctx = useChatState();
  const prevSessionRef = useRef<string | undefined>();
  const onSessionResolvedRef = useRef(options.onSessionResolved);
  onSessionResolvedRef.current = options.onSessionResolved;

  // Sync options into context when they change
  useEffect(() => {
    if (options.provider && options.provider !== ctx.provider) {
      ctx.setProvider(options.provider);
    }
  }, [options.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (options.session && options.session !== ctx.session) {
      ctx.setSession(options.session);
    }
    prevSessionRef.current = options.session;
  }, [options.session]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (options.model && options.model !== ctx.selectedModel) {
      ctx.setSelectedModel(options.model);
    }
  }, [options.model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (options.agentId !== ctx.agentId) {
      ctx.setAgentId(options.agentId);
    }
  }, [options.agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch for session changes from the context (resolved by WS 'session' event)
  // and notify the consumer via onSessionResolved callback
  useEffect(() => {
    if (ctx.session && ctx.session !== prevSessionRef.current && onSessionResolvedRef.current) {
      onSessionResolvedRef.current(ctx.session);
      prevSessionRef.current = ctx.session;
    }
  }, [ctx.session]);

  // assistant-ui onNew callback
  const onNew = useCallback(
    async (appendMsg: AppendMessage) => {
      const text = extractTextFromAppendMessage(appendMsg);
      if (!text.trim()) return;
      // Play send sound
      try { sounds.click(); } catch {}
      await ctx.sendMessage(text);
    },
    [ctx.sendMessage],
  );

  // assistant-ui onCancel callback
  const onCancel = useCallback(async () => {
    await ctx.cancelStream();
  }, [ctx.cancelStream]);

  const store: ExternalStoreAdapter<ChatMessage> = {
    // Always tell assistant-ui the thread is "not running" so the Send button
    // stays enabled during streaming (FYI / message-queue mode). Our sendMessage()
    // queues follow-up messages when a stream is active and drains them on done.
    // Visual streaming indicators (status rail, stop button) are
    // driven by ctx.isRunning independently.
    isRunning: false,
    messages: ctx.messages,
    convertMessage: toThreadMessage,
    onNew,
    onCancel,
  };

  const runtime = useExternalStoreRuntime(store);

  return {
    runtime,
    messages: ctx.messages,
    isRunning: ctx.isRunning,
    isLoadingHistory: ctx.isLoadingHistory,
    isSwitchingSession: ctx.isSwitchingSession,
    statusText: ctx.statusText,
    lastProvenance: ctx.lastProvenance,
    clearMessages: ctx.clearMessages,
    clearQueue: ctx.clearQueue,
    queueCount: ctx.queueCount,
    switchModel: ctx.switchModel,
    streamingPhase: ctx.streamingPhase,
    activeToolName: ctx.activeToolName,
    thinkingContent: ctx.thinkingContent,
    streamSegments: ctx.streamSegments,
    pendingApproval: ctx.pendingApproval,
    pendingApprovals: ctx.pendingApprovals,
    pendingApprovalCount: ctx.pendingApprovalCount,
    resolveApproval: ctx.resolveApproval,
    dismissApproval: ctx.dismissApproval,
    wsConnected: ctx.wsConnected,
    compactionPhase: ctx.compactionPhase,
  };
}
