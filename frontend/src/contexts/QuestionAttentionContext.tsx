import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Conversation = { surface: 'agent-chat' | 'project-chat'; sessionKey: string };
type Registration = Conversation & { owner: symbol };
const AttentionContext = createContext<{
  conversations: readonly Conversation[];
  register: (conversation: Conversation) => () => void;
}>({ conversations: [], register: () => () => {} });

/** Presentation only. Question ownership and answer admission stay server-side. */
export function QuestionAttentionProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const register = useCallback((conversation: Conversation) => {
    const owner = Symbol('visible-question-conversation');
    setRegistrations((previous) => [...previous, { ...conversation, owner }]);
    return () => setRegistrations((previous) => previous.filter((entry) => entry.owner !== owner));
  }, []);
  const value = useMemo(() => ({ conversations: registrations, register }), [registrations, register]);
  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useVisibleQuestionConversation(surface: Conversation['surface'], sessionKey: string | null) {
  const { register } = useContext(AttentionContext);
  useEffect(() => {
    if (!sessionKey) return;
    return register({ surface, sessionKey });
  }, [register, surface, sessionKey]);
}

export function useVisibleQuestionConversations() {
  return useContext(AttentionContext).conversations;
}
