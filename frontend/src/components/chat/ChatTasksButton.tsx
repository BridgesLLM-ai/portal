import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Circle, ListTodo, Loader2, X, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import AnchoredPopover from '../AnchoredPopover';
import client from '../../api/client';
import type { WorkCard } from './ProjectWork';
import type { ChatMessage } from '../../contexts/ChatStateProvider';
import { latestChatPlan, sessionTasks, taskCounts, type ChatTask } from '../../utils/chatTasks';
import { taskConversationHref } from '../../utils/taskConversation';

export default function ChatTasksButton({ provider, session, messages, projectWork = [] }: {
  provider: string; session: string; messages: ChatMessage[]; isRunning: boolean; projectWork?: WorkCard[];
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  const close = () => { setOpenContext(null); anchor.current?.focus(); };
  const [openContext, setOpenContext] = useState<{ provider: string; session: string } | null>(null);
  // Navigation closes the feed before effects run for the next conversation.
  const open = openContext !== null && openContext.provider === provider && openContext.session === session;
  const [allTasks, setAllTasks] = useState<ChatTask[]>([]);
  const [scope, setScope] = useState<'session' | 'harness'>('session');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const plan = useMemo(() => latestChatPlan(messages), [messages]);
  useEffect(() => { setOpenContext(null); setAllTasks([]); setError(''); setLoading(false); setScope('session'); }, [provider, session]);
  useEffect(() => {
    // The remote feed enumerates every agent's sessions. Keep closed chat
    // controls local so opening a conversation does not trigger that sweep.
    if (provider !== 'OPENCLAW' || !open) return;
    let alive = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (!alive) return;
      if (document.visibilityState === 'hidden') { timer = window.setTimeout(refresh, 15_000); return; }
      controller = new AbortController();
      setLoading(true);
      try {
        const { data } = await client.get('/gateway/tasks', { signal: controller.signal, timeout: 35_000 });
        if (!alive) return;
        if (!Array.isArray(data.tasks)) throw new Error('Task feed unavailable');
        setAllTasks(data.tasks);
        setError(data.stale || data.warning ? 'Task feed may be incomplete. Last reported status is shown.' : '');
      } catch {
        if (alive) setError('Task feed unavailable. Last reported status is shown.');
      } finally {
        if (alive) { setLoading(false); timer = window.setTimeout(refresh, 10_000); }
      }
    };
    void refresh();
    return () => { alive = false; controller?.abort(); window.clearTimeout(timer); };
  }, [provider, session, open]);
  const related = useMemo(() => sessionTasks(allTasks, session), [allTasks, session]);
  const projectTasks: ChatTask[] = projectWork.map((card) => ({ id: `project-work:${card.id}`, name: `${card.projectName} · ${card.prompt}`,
    status: card.turn?.status === 'COMPLETED' ? 'done' : ['RUNNING', 'STARTING'].includes(card.turn?.status || '') ? 'running' : !card.turn ? 'pending' : card.turn.status === 'ABORTED' ? 'cancelled' : 'failed',
    detail: 'Project work in this conversation',
  }));
  const tasks = provider === 'OPENCLAW' ? (scope === 'harness' ? allTasks : [...projectTasks, ...plan, ...related]) : [...projectTasks, ...plan];
  const ownCounts = taskCounts(provider === 'OPENCLAW' ? [...projectTasks, ...plan, ...related] : [...projectTasks, ...plan]);
  const counts = taskCounts(tasks);
  const supportsFeed = ['OPENCLAW', 'CODEX', 'CLAUDE_CODE', 'HERMES', 'OPENCODE', 'GEMINI'].includes(provider) || plan.length > 0 || projectWork.length > 0;
  if (!supportsFeed) return null;
  const complete = ownCounts.total > 0 && ownCounts.done === ownCounts.total;
  const summary = counts.outstanding ? `${counts.outstanding} remaining` : counts.failed ? `${counts.failed} failed` : counts.cancelled ? `${counts.cancelled} stopped` : counts.total && counts.done === counts.total ? 'All complete' : counts.total ? 'Last reported progress' : 'No active tasks';
  return <>
    <button type="button" ref={anchor} aria-label={'Tasks' + (ownCounts.outstanding ? ', ' + ownCounts.outstanding + ' outstanding' : complete ? ', all completed' : '')}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpenContext(open ? null : { provider, session })}
      title="Tasks and plan progress"
      className={'relative flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 ' + (open || ownCounts.outstanding ? 'border-sky-400/20 bg-sky-400/10 text-sky-300' : complete ? 'border-emerald-400/15 bg-emerald-400/5 text-emerald-300' : 'border-transparent text-slate-400 hover:bg-sky-500/10 hover:text-sky-300')}>
      <ListTodo size={16} aria-hidden="true" />
      <span className="hidden min-[900px]:inline">Tasks</span>
      {ownCounts.total > 0 && <span aria-hidden="true" className="text-[10px] font-semibold tabular-nums">{ownCounts.done}/{ownCounts.total}</span>}
      {ownCounts.running > 0 && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sky-300 motion-safe:animate-pulse" />}
    </button>
    <AnchoredPopover open={open} anchorRef={anchor} onDismiss={close} width={384} ariaLabel="Chat tasks" className="overflow-hidden rounded-2xl border border-white/10 bg-[#11182b] shadow-2xl">
      <motion.section role="dialog" aria-label="Chat tasks" className="flex min-h-0 max-h-full flex-col"
        initial={reducedMotion ? false : { opacity: 0, y: -7 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
        <header className="shrink-0 border-b border-white/5 px-4 py-3">
          <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">Tasks & progress</h3><p className="mt-0.5 text-[11px] text-slate-400">{summary}</p></div>
            <button type="button" aria-label="Close chat tasks" onClick={close} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"><X size={16} aria-hidden="true" /></button></div>
          {provider === 'OPENCLAW' && <div className="mt-3 flex gap-1 text-xs" aria-label="Task scope">
            <button type="button" onClick={() => setScope('session')} aria-pressed={scope === 'session'} className={'rounded-md px-2 py-1 ' + (scope === 'session' ? 'bg-sky-400/15 text-sky-300' : 'text-slate-400')}>This chat</button>
            <button type="button" onClick={() => setScope('harness')} aria-pressed={scope === 'harness'} className={'rounded-md px-2 py-1 ' + (scope === 'harness' ? 'bg-sky-400/15 text-sky-300' : 'text-slate-400')}>All OpenClaw</button>
          </div>}
          {counts.total > 0 && <div className="mt-3">
            <div className="mb-1.5 text-[11px] text-slate-400">{counts.done} of {counts.total} completed</div>
            <progress aria-label="Reported task progress" value={counts.done} max={counts.total} className="h-1 w-full overflow-hidden rounded-full accent-sky-400" />
          </div>}
        </header>
        <div className="min-h-0 max-h-80 overflow-y-auto overscroll-contain px-4 py-3">
          {error && <p role="status" className="mb-3 text-xs text-amber-300">{error}</p>}
          {!tasks.length && <p className="py-4 text-center text-xs text-slate-400">{loading ? 'Loading tasks…' : scope === 'harness' ? 'No tasks reported by OpenClaw.' : 'No plan or tasks reported for this chat yet.'}</p>}
          <ul className="space-y-3">{tasks.map(task => {
            const href = taskConversationHref(task.sessionKey);
            const statusLabel = ({ pending: 'Pending', running: 'In progress', done: 'Completed', failed: 'Failed', cancelled: 'Stopped', unknown: 'Status unavailable' })[task.status] || 'Status unavailable';
            const Icon = task.status === 'done' ? CheckCircle2 : task.status === 'running' ? Loader2 : task.status === 'failed' ? XCircle : Circle;
            return <li key={task.id} className="flex gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <Icon aria-label={statusLabel} size={15} className={'mt-0.5 shrink-0 ' + (task.status === 'running' ? 'motion-safe:animate-spin text-sky-300' : task.status === 'done' ? 'text-emerald-400' : task.status === 'failed' ? 'text-rose-400' : 'text-slate-500')} />
              <div className="min-w-0 text-xs leading-relaxed">
                {task.id.startsWith('project-work:') ? <button type="button" className="break-words text-left text-slate-200 hover:text-sky-300" onClick={() => { setOpenContext(null); document.querySelector(`[data-work-id="${CSS.escape(task.id.slice(13))}"]`)?.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' }); }}>{task.name}</button> : href ? <Link to={href} onClick={() => setOpenContext(null)} className="break-words text-slate-200 hover:text-sky-300">{task.name}</Link> : <span className="break-words text-slate-200">{task.name}</span>}
                {task.detail && <p className="mt-1 line-clamp-2 text-slate-500">{task.detail}</p>}
              </div>
            </li>;
          })}</ul>
        </div>
        <footer className="shrink-0 border-t border-white/5 px-4 py-2.5 text-[11px] text-slate-400">
          {provider === 'OPENCLAW' ? <Link to="/tasks" onClick={() => setOpenContext(null)} className="text-sky-300">Open task board →</Link> : 'Plan reported by this harness'}
        </footer>
      </motion.section>
    </AnchoredPopover>
  </>;
}
