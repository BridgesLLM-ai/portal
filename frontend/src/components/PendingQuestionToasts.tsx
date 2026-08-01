import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, HelpCircle, X } from 'lucide-react';
import ViewportOverlay from './ViewportOverlay';
import AskUserQuestionCard from './chat/AskUserQuestionCard';
import type { GatewayPendingQuestion } from '../api/endpoints';
import sounds from '../utils/sounds';

/**
 * . A paused agent run is the one notification that must not depend on
 * which page you are looking at, and must not expire on a timer the way an
 * ordinary toast does. The sidebar badge is accurate but easy to miss with the
 * rail collapsed, so the same pending question also surfaces here and can be
 * answered in place — the answer is delivered by question id, so nothing about
 * this needs the Agent or Project surface to be open.
 *
 * Closing a card here hides the notification only. It never dismisses the
 * question: skipping is a deliberate action that belongs to the card itself,
 * because it cancels what the run was waiting for.
 */

/** More than this on screen at once stops being a notification and becomes a wall. */
const MAX_VISIBLE = 3;

export default function PendingQuestionToasts({
  questions,
  onSettled,
}: {
  questions: GatewayPendingQuestion[];
  onSettled: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<readonly string[]>([]);
  const announcedRef = useRef<readonly string[]>([]);

  const liveIds = useMemo(() => questions.map((question) => question.id), [questions]);

  useEffect(() => {
    const live = new Set(liveIds);
    const arrived = liveIds.filter((id) => !announcedRef.current.includes(id));
    // Retain only ids that are still open so neither list can grow without end.
    announcedRef.current = liveIds;
    if (arrived.length > 0) {
      // The alert is the point; the sound is decoration. A missing or failing
      // audio path must never keep a paused run from surfacing.
      try {
        sounds.question?.();
      } catch {
        // ignore
      }
    }
    setHiddenIds((current) => {
      const retained = current.filter((id) => live.has(id));
      return retained.length === current.length ? current : retained;
    });
    setExpandedId((current) => (current && live.has(current) ? current : null));
  }, [liveIds]);

  const visible = questions
    .filter((question) => !hiddenIds.includes(question.id))
    .slice(0, MAX_VISIBLE);

  const hide = useCallback((id: string) => {
    setHiddenIds((current) => (current.includes(id) ? current : [...current, id]));
    setExpandedId((current) => (current === id ? null : current));
  }, []);

  const settle = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : current));
    onSettled(id);
  }, [onSettled]);

  if (visible.length === 0) return null;

  return (
    <ViewportOverlay
      anchor="top-right"
      zIndex={1250}
      className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto overscroll-contain pr-1"
    >
      {visible.map((question) => {
        const expanded = expandedId === question.id;
        const surface = question.surface === 'project-chat' ? 'Project' : 'Agent';
        const prompt = question.questions[0]?.question || 'The agent needs an answer to continue.';
        return (
          <div
            key={question.id}
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-violet-500/40 bg-[#0b0e24]/95 shadow-lg shadow-black/40 backdrop-blur-xl"
          >
            <div className="flex items-start gap-2 px-4 py-3">
              <HelpCircle size={18} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-violet-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">
                  {surface} chat is waiting on you
                </p>
                {!expanded && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-300">{prompt}</p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : question.id)}
                  aria-expanded={expanded}
                  aria-label={expanded
                    ? 'Collapse the waiting question'
                    : 'Answer the waiting question here'}
                  className="rounded p-1 text-violet-200 transition-opacity hover:opacity-70"
                >
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                <button
                  type="button"
                  onClick={() => hide(question.id)}
                  aria-label="Hide this notification without answering"
                  className="rounded p-1 text-slate-400 transition-opacity hover:opacity-70"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {expanded && (
              <div className="border-t border-white/10 px-4 pb-2">
                <AskUserQuestionCard request={question} onSettled={settle} />
              </div>
            )}
          </div>
        );
      })}
    </ViewportOverlay>
  );
}
