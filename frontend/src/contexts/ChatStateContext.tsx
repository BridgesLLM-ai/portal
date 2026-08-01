/**
 * ChatStateContext — Resilient chat state that survives route navigation.
 *
 * Architecture:
 * - ChatStateProvider wraps only the Agent Chat route
 * - Owns all chat state: messages, streaming phase, WS connection, etc.
 * - Leaving Agent Chat releases browser-side sockets/timers; the server-owned
 *   session continues and history/replay recovers it when the route remounts
 * - useAgentRuntime becomes a thin consumer that wires into assistant-ui
 *
 * The WsManager singleton and event processing logic are lifted here from
 * the original useAgentRuntime hook so they persist across unmounts.
 */
export {
  ChatStateProvider,
  useChatState,
  type ChatMessage,
  type ToolCall,
  type ExecApprovalRequest,
  type StreamingPhase,
  type ChatStateContextValue,
  type WsManager,
} from './ChatStateProvider';
