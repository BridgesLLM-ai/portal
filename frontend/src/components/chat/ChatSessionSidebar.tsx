/**
 * ChatSessionSidebar — session thread list for the currently selected agent.
 *
 * Shows human-friendly names: "Chat 1", "Chat 2", or date-stamped.
 * New Chat button per agent.
 */
import { useState, useEffect } from 'react';
import { Plus, MessageSquare, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import client from '../../api/client';

interface SessionInfo {
  key?: string;
  id?: string;
  sessionId?: string;
  createdAt?: string;
  lastActivityAt?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  preview?: string;
}

interface ChatSessionSidebarProps {
  currentSession: string;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  provider?: string;
}

/** Turn a raw session key into something human-readable. */
function getSessionTitle(session: SessionInfo, index: number): string {
  if (session.title) return session.title;
  if (session.preview && session.preview.length <= 72) return session.preview;
  const raw = session.key || session.sessionId || session.id || '';
  const normalized = raw
    .split(':')
    .slice(2)
    .join(':')
    .replace(/^portal-[a-f0-9]{8}-/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (normalized && !/^[a-f0-9-]{24,}$/i.test(normalized)) {
    return normalized;
  }

  // Try to extract a timestamp from the session ID for a date label
  const tsMatch = raw.match(/(\d{13,})/);
  if (tsMatch) {
    try {
      const d = new Date(parseInt(tsMatch[1]));
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    } catch {
      // fall through
    }
  }

  // For "main" sessions
  if (raw === 'main' || raw.endsWith(':main')) return 'Main Chat';

  // Number the rest
  return `Chat ${index + 1}`;
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  } catch {
    return '';
  }
}

export default function ChatSessionSidebar({
  currentSession,
  onSelectSession,
  onNewChat,
  provider,
}: ChatSessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (provider) params.provider = provider;
      const { data } = await client.get('/gateway/sessions', { params });
      const list = data.sessions || [];
      setSessions(Array.isArray(list) ? list : Object.values(list));
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const getSessionId = (s: SessionInfo) => s.key || s.sessionId || s.id || '';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
          Sessions
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchSessions}
            className="p-1 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={onNewChat}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:text-white hover:bg-white/[0.10] text-[11px] font-medium transition-colors"
          >
            <Plus size={11} />
            New
          </button>
        </div>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-slate-500 text-xs">
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-slate-500 text-xs gap-2">
            <MessageSquare size={16} className="opacity-30" />
            <span>No threads yet</span>
          </div>
        ) : (
          sessions.map((session, idx) => {
            const id = getSessionId(session);
            const isActive = id === currentSession;
            return (
              <motion.button
                key={id}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.03 }}
                onClick={() => onSelectSession(id)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-xs transition-all ${
                  isActive
                    ? 'bg-white/[0.08] text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                }`}
              >
                <MessageSquare size={12} className="flex-shrink-0 opacity-40" />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">
                    {getSessionTitle(session, idx)}
                  </div>
                  <div className="text-[10px] text-slate-500/70 mt-0.5">
                    {formatTime(session.lastActivityAt || session.createdAt)}
                  </div>
                </div>
              </motion.button>
            );
          })
        )}
      </div>
    </div>
  );
}
