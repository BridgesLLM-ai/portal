import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChatState } from '../../../contexts/ChatStateProvider';
import { loadAndApplyDefaultAgentHarness } from '../../../api/agentHarnessPreference';
import { useAuthStore } from '../../../contexts/AuthContext';
import { openClawTaskConversation } from '../../../utils/taskConversation';
import { WORKSPACE_FOCUS_STATE_KEY, type WorkspaceFocusRequest } from '../../workspace/FloatingWidgetLayer';

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Accept only the exact shape a floating window puts in in-app navigation state. */
export function parseWorkspaceFocusRequest(state: unknown): WorkspaceFocusRequest | null {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[WORKSPACE_FOCUS_STATE_KEY] : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { provider, session, toolCallId } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(provider)) return null;
  if (typeof session !== 'string' || !session || session.length > 512 || CONTROL.test(session)) return null;
  if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 256 || CONTROL.test(toolCallId)) return null;
  if (provider === 'OPENCLAW' && !openClawTaskConversation(session)) return null;
  return { provider, session, toolCallId };
}

/** Bring a widget's card into view once its conversation has rendered. */
export function revealChatWidget(toolCallId: string, deadline = Date.now() + 8000): void {
  const element = document.getElementById(`chat-widget-${toolCallId}`);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('ring-2', 'ring-violet-400/60');
    window.setTimeout(() => element.classList.remove('ring-2', 'ring-violet-400/60'), 1800);
    return;
  }
  if (Date.now() < deadline) window.setTimeout(() => revealChatWidget(toolCallId, deadline), 250);
}

/**
 * "Back to chat" from a floating widget: the click on that window is the
 * explicit choice, carried only in router state. Opening a conversation reads
 * history through the normal owner-checked routes; it sends nothing.
 */
export default function WorkspaceFocusNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.user?.id || '');
  const { provider, session, selectProviderAgent, selectSession } = useChatState();
  const request = parseWorkspaceFocusRequest(location.state);
  const handled = useRef<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!request || !userId) return;
    const key = `${location.key}:${request.provider}:${request.session}:${request.toolCallId}`;
    if (handled.current === key) return;
    handled.current = key;
    setError(false);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    void (async () => {
      try {
        if (provider !== request.provider || session !== request.session) {
          await loadAndApplyDefaultAgentHarness(userId);
          selectProviderAgent(request.provider, request.provider === 'OPENCLAW' ? openClawTaskConversation(request.session)?.agentId : undefined);
          await selectSession(request.session);
        }
        revealChatWidget(request.toolCallId);
      } catch { setError(true); }
    })();
  }, [request, userId, location.key, location.pathname, location.search, navigate, provider, session, selectProviderAgent, selectSession]);
  if (!error) return null;
  return <p role="alert" className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">The widget’s conversation could not be opened. Select it from the chat list.</p>;
}
