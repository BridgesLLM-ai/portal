/**
 * ChatStateContext — Resilient chat state that survives route navigation.
 *
 * Architecture:
 * - ChatStateProvider wraps the app (inside auth, outside router outlet)
 * - Owns all chat state: messages, streaming phase, WS connection, etc.
 * - WS event handler stays registered regardless of which page is active
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
