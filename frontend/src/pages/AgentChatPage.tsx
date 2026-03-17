/**
 * AgentChatPage — Dedicated page for the Agent Chat UI.
 * Houses the ChatInterface component.
 */
import ChatInterface from '../components/chat/ChatInterface';

export default function AgentChatPage() {
  return (
    <div className="h-full">
      <ChatInterface />
    </div>
  );
}
