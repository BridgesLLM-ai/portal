import { createContext, useContext } from 'react';

/** Present only inside Agent Chat: enables "open beside the chat" and pop-out controls for this chat. */
export interface AgentWorkspaceTarget { provider: string; session: string }
export const AgentWorkspaceContext = createContext<AgentWorkspaceTarget | null>(null);
export const useAgentWorkspaceTarget = () => useContext(AgentWorkspaceContext);
