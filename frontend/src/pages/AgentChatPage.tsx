/**
 * AgentChatPage — Dedicated page for the Agent Chat UI.
 * Houses the ChatInterface component.
 */
import { Suspense } from 'react';
import { lazyWithRecovery } from '../utils/moduleRecovery';
import { Loader2 } from 'lucide-react';
import TaskConversationNavigation from '../components/chat/TaskConversationNavigation';
import WorkspaceFocusNavigation from '../components/chat/workspace/WorkspaceFocusNavigation';
import { ChatStateProvider } from '../contexts/ChatStateProvider';

const LazyChatInterface = lazyWithRecovery(() => import('../components/chat/ChatInterface'));

export default function AgentChatPage() {
  return (
    <ChatStateProvider>
      <div className="flex h-full min-h-0 flex-col">
        <TaskConversationNavigation />
        <WorkspaceFocusNavigation />
        <div className="min-h-0 flex-1">
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
      </div>
    </ChatStateProvider>
  );
}
