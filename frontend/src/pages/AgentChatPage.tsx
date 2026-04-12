/**
 * AgentChatPage — Dedicated page for the Agent Chat UI.
 * Houses the ChatInterface component.
 */
import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';

const LazyChatInterface = lazy(() => import('../components/chat/ChatInterface'));

export default function AgentChatPage() {
  return (
    <div className="h-full">
      <Suspense
        fallback={(
          <div className="h-full flex items-center justify-center bg-[#080B20]">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              <span>Loading chats…</span>
            </div>
          </div>
        )}
      >
        <LazyChatInterface />
      </Suspense>
    </div>
  );
}
