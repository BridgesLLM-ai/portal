import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Circle, ListTodo, Loader2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import AnchoredPopover from '../AnchoredPopover';
import client from '../../api/client';
import type { WorkCard } from './ProjectWork';
import type { ChatMessage } from '../../contexts/ChatStateProvider';
import { latestChatPlan, sessionTasks, taskCounts, type ChatTask } from '../../utils/chatTasks';
import { taskConversationHref } from '../../utils/taskConversation';

export default function ChatTasksButton({ provider, session, messages, isRunning, projectWork = [] }: {
  provider: string; session: string; messages: ChatMessage[]; isRunning: boolean; projectWork?: WorkCard[];
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [allTasks, setAllTasks] = useState<ChatTask[]>([]);
  const [scope, setScope] = useState<'session' | 'harness'>('session');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const plan = useMemo(() => latestChatPlan(messages), [messages]);
  useEffect(() => { setOpen(false); setAllTasks([]); setError(''); setScope('session'); }, [provider, session]);
  useEffect(() => {
    if (provider !== 'OPENCLAW') return;
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
        if (alive) { setLoading(false); timer = window.setTimeout(refresh, open || isRunning ? 10_000 : 30_000); }
      }
    };
    void refresh();
    return () => { alive = false; controller?.abort(); window.clearTimeout(timer); };
  }, [provider, session, open, isRunning]);
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
  return <>
    <button type="button" ref={anchor} aria-label={'Tasks' + (ownCounts.outstanding ? ', ' + ownCounts.outstanding + ' outstanding' : '')}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}
      title="Tasks and plan progress"
      className="relative flex min-h-[32px] items-center gap-1 rounded-lg px-2 text-slate-400 transition-colors hover:bg-sky-500/10 hover:text-sky-300">
      <ListTodo size={17} aria-hidden="true" />
      {ownCounts.outstanding > 0 && <span className="rounded-md bg-sky-400/15 px-1.5 text-[10px] font-semibold tabular-nums text-sky-300">{ownCounts.outstanding}</span>}
    </button>
    <AnchoredPopover open={open} anchorRef={anchor} onDismiss={() => setOpen(false)} width={370} ariaLabel="Chat tasks" className="overflow-hidden rounded-2xl border border-white/10 bg-[#11182b] shadow-2xl">
      <motion.section role="dialog" aria-label="Chat tasks"
        initial={reducedMotion ? false : { opacity: 0, y: -7 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
        <header className="border-b border-white/5 px-4 py-3">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-white">Tasks</h3>
            <span className="text-xs text-slate-400">{counts.outstanding} outstanding</span></div>
          {provider === 'OPENCLAW' && <div className="mt-3 flex gap-1 text-xs" aria-label="Task scope">
            <button type="button" onClick={() => setScope('session')} aria-pressed={scope === 'session'} className={'rounded-md px-2 py-1 ' + (scope === 'session' ? 'bg-sky-400/15 text-sky-300' : 'text-slate-400')}>This chat</button>
            <button type="button" onClick={() => setScope('harness')} aria-pressed={scope === 'harness'} className={'rounded-md px-2 py-1 ' + (scope === 'harness' ? 'bg-sky-400/15 text-sky-300' : 'text-slate-400')}>All OpenClaw</button>
          </div>}
          {counts.total > 0 && <div className="mt-3">
            <div className="mb-1.5 text-[11px] text-slate-400">{counts.done} of {counts.total} completed</div>
            <progress aria-label="Reported task progress" value={counts.done} max={counts.total} className="h-1 w-full overflow-hidden rounded-full accent-sky-400" />
          </div>}
        </header>
        <div className="max-h-80 overflow-y-auto px-4 py-3">
          {error && <p role="status" className="mb-3 text-xs text-amber-300">{error}</p>}
          {!tasks.length && <p className="py-4 text-center text-xs text-slate-400">{loading ? 'Loading tasks…' : 'No tasks reported for this chat.'}</p>}
          <ul className="space-y-3">{tasks.map(task => {
            const href = taskConversationHref(task.sessionKey);
            const Icon = task.status === 'done' ? CheckCircle2 : task.status === 'running' ? Loader2 : task.status === 'failed' ? XCircle : Circle;
            return <li key={task.id} className="flex gap-2.5">
              <Icon aria-label={task.status} size={15} className={'mt-0.5 shrink-0 ' + (task.status === 'running' ? 'motion-safe:animate-spin text-sky-300' : task.status === 'done' ? 'text-emerald-400' : task.status === 'failed' ? 'text-rose-400' : 'text-slate-500')} />
              <div className="min-w-0 text-xs leading-relaxed">
                {task.id.startsWith('project-work:') ? <button type="button" className="break-words text-left text-slate-200 hover:text-sky-300" onClick={() => { setOpen(false); document.querySelector(`[data-work-id="${CSS.escape(task.id.slice(13))}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}>{task.name}</button> : href ? <Link to={href} onClick={() => setOpen(false)} className="break-words text-slate-200 hover:text-sky-300">{task.name}</Link> : <span className="break-words text-slate-200">{task.name}</span>}
                {task.detail && <p className="mt-1 line-clamp-2 text-slate-500">{task.detail}</p>}
              </div>
            </li>;
          })}</ul>
        </div>
        <footer className="border-t border-white/5 px-4 py-2.5 text-[11px] text-slate-500">
          {provider === 'OPENCLAW' ? <Link to="/tasks" onClick={() => setOpen(false)} className="text-sky-300">Open task board →</Link> : 'Plan reported by this harness'}
        </footer>
      </motion.section>
    </AnchoredPopover>
  </>;
}
