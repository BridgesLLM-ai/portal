import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, ChevronDown, ChevronRight, FolderOpen, Loader2, Send, Square, X, ExternalLink, AlertCircle } from 'lucide-react';
import client from '../../api/client';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChatState } from '../../contexts/ChatStateProvider';
import { loadAndApplyDefaultAgentHarness } from '../../api/agentHarnessPreference';
import { parseProjectWorkLink } from '../../utils/projectWorkNavigation';
import type { ExecApprovalRequest } from './useAgentRuntime';
import AskUserQuestionCard from './AskUserQuestionCard';
import { projectsAPI, type ProjectSummary, type GatewayPendingQuestion } from '../../api/endpoints';
import { useAuthStore } from '../../contexts/AuthContext';
import MarkdownRenderer from './MarkdownRenderer';
import ViewportModal from '../ViewportModal';
import ProjectWorkFiles from './ProjectWorkFiles';
import type { RuntimeTurnEvent } from '../../utils/runtimeTurnEvents';
import { projectWorkActivity, type WorkActivity } from './projectWorkActivity';
import ToolGlyph from './ToolGlyph';
import { Bot, GitBranch, Radio, MessageCircle, Check } from 'lucide-react';

export type ProjectWorker = 'CODEX' | 'CLAUDE_CODE' | 'OPENCLAW' | 'GROK' | 'GEMINI' | 'HERMES' | 'OPENCODE' | 'OLLAMA';
export const workerLabels: Record<ProjectWorker, string> = { CODEX: 'Codex', CLAUDE_CODE: 'Claude Code', OPENCLAW: 'OpenClaw', GROK: 'Grok Build', GEMINI: 'Antigravity', HERMES: 'Hermes', OPENCODE: 'OpenCode', OLLAMA: 'Ollama' };
export function projectWorkerLabel(provider: ProjectWorker, originProvider: string, originSessionKey: string) {
  if (provider !== 'OPENCLAW') return workerLabels[provider];
  const id = originProvider === 'OPENCLAW' ? originSessionKey.match(/^agent:([A-Za-z0-9_-]+):/)?.[1] : 'main';
  return `${!id || id === 'main' ? 'Main agent' : id} · OpenClaw`;
}
export interface WorkCard {
  id: string; originProvider: string; originSessionKey: string;
  projectIdentityId: string; projectGeneration: number; provider: ProjectWorker;
  prompt: string; projectName: string; model: string | null; createdAt: string; parentCardId: string | null;
  projectIdentity: { projectName: string; generation: number; lifecycleStatus: string };
  scopeValid: boolean;
  turn: { id: string; status: string } | null;
}
export interface Replay {
  status: string; complete: boolean; active: boolean; text: string; error?: string;
  stateVersion?: number; lineCount: number; uncertain?: boolean; sessionKey?: string; activeToolCall?: string;
  events: RuntimeTurnEvent[]; phase?: 'thinking' | 'tool' | 'streaming'; statusText?: string; runId?: string;
}
const options = { _silent: true, _skipNetworkRetry: true } as any;
const problem = (error: any) => error?.response?.data?.error || error?.message || 'Could not load project work.';
export function mergeProjectWorkTimeline<T extends { createdAt: Date }>(messages: T[], cards: WorkCard[], replays: Record<string, Replay> = {}) {
  return [
    ...messages.map((message) => ({ kind: 'message' as const, message, at: message.createdAt.getTime() })),
    ...cards.flatMap((card) => [
      { kind: 'work' as const, card, at: new Date(card.createdAt).getTime() },
      ...projectWorkActivity(replays[card.id]?.events || [], replays[card.id]?.text || '', card.createdAt)
        .map(activity => ({ kind: 'work-activity' as const, card, activity, at: activity.at })),
    ]),
  ].sort((a, b) => a.at - b.at);
}

export function useProjectWork(originProvider: string, originSessionKey: string, originModel = '') {
  const chat = useChatState();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const [cards, setCards] = useState<WorkCard[]>([]);
  const [replays, setReplays] = useState<Record<string, Replay>>({});
  const [replayErrors, setReplayErrors] = useState<Record<string, string>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const replaysRef = useRef(replays); replaysRef.current = replays;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectSummary | null>(null);
  const [worker, setWorker] = useState<ProjectWorker>('CODEX');
  const [parent, setParent] = useState<string | null>(null);
  const [parentModel, setParentModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phases, setPhases] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const inFlight = useRef(new Set<string>());
  const creatingRef = useRef(false);
  const focusCard = useRef<string | null>(null);
  const scope = `${user?.id || ''}:${user?.authorizationVersion ?? 1}:${originProvider}:${originSessionKey}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const enabled = Boolean(user && ['OWNER', 'SUB_ADMIN'].includes(user.role) && originSessionKey);
  const load = useCallback(async () => {
    if (!enabled) return;
    const target = scope;
    try {
      const { data } = await client.get('/project-work', { ...options, params: { originProvider, originSessionKey } });
      if (scopeRef.current !== target) return;
      setCards(data.cards); setError(null);
    } catch (err) { if (scopeRef.current === target) setError(problem(err)); }
  }, [scope, enabled, originProvider, originSessionKey]);
  const loadProjects = useCallback(async () => {
    try { const actor = useAuthStore.getState().user?.id; const data = await projectsAPI.list(); if (useAuthStore.getState().user?.id === actor) setProjects(data.projects); }
    catch (err) { setError(problem(err)); }
  }, []);
  useEffect(() => {
    setCards([]); setReplays({}); setReplayErrors({}); setFocusedId(null); setWorkspaceOpen(false); setSelected(null); setParent(null); setError(null);
    setWorker(originProvider in workerLabels ? originProvider as ProjectWorker : 'CODEX');
    if (!enabled) return;
    void load(); void loadProjects();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    const projectTimer = window.setInterval(() => { if (!document.hidden) void loadProjects(); }, 10000);
    return () => { window.clearInterval(timer); window.clearInterval(projectTimer); };
  }, [scope, enabled, load, loadProjects, originProvider]);

  const refreshReplay = useCallback(async (card: WorkCard, signal?: AbortSignal) => {
    if (!enabled || !card.scopeValid) return;
    try {
      const { data } = await client.get(`/project-work/${encodeURIComponent(card.id)}/poll`, { ...options, signal });
      if (scopeRef.current !== scope || signal?.aborted) return;
      setReplays(old => JSON.stringify(old[card.id]) === JSON.stringify(data) ? old : { ...old, [card.id]: data });
      setReplayErrors(old => old[card.id] ? { ...old, [card.id]: '' } : old);
    } catch (err) {
      if (scopeRef.current === scope && !signal?.aborted) setReplayErrors(old => ({ ...old, [card.id]: problem(err) }));
    }
  }, [scope, enabled]);
  useEffect(() => {
    const controller = new AbortController(); let running = false;
    const poll = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const pending = cards.filter(card => card.scopeValid && !replaysRef.current[card.id]?.complete);
        // Bound request concurrency; completed turns are fetched once per scope.
        for (let i = 0; i < pending.length && !controller.signal.aborted; i += 4) {
          await Promise.allSettled(pending.slice(i, i + 4).map(card => refreshReplay(card, controller.signal)));
        }
      } finally { running = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 1500);
    document.addEventListener('visibilitychange', poll);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [cards, refreshReplay]);
  const activeCards = cards.filter(card => replays[card.id]?.active || replays[card.id]?.uncertain
    || (!replays[card.id]?.complete && (Boolean(phases[card.id]) || ['RUNNING', 'STARTING', 'UNCERTAIN'].includes(card.turn?.status || ''))));
  const focusedCard = cards.find(card => card.id === focusedId) || activeCards[activeCards.length - 1] || cards[cards.length - 1] || null;
  const activeCard = activeCards[activeCards.length - 1];
  const liveReplay = activeCard ? replays[activeCard.id] : undefined;
  const activity = activeCard ? {
    active: true, phase: liveReplay?.phase || 'thinking' as const,
    toolName: liveReplay?.activeToolCall || null,
    statusText: `${activeCard.projectName} · ${liveReplay?.statusText || (liveReplay?.uncertain ? 'Checking worker status' : 'Working on your project')}`,
  } : null;

  const start = useCallback(async (card: WorkCard) => {
    if (inFlight.current.has(card.id)) return;
    inFlight.current.add(card.id);
    const actor = useAuthStore.getState().user;
    const stamped = { ...options, timeout: 0, _workspaceAuthorizationActorId: actor?.id,
      _workspaceAuthorizationVersion: actor?.authorizationVersion ?? 1 };
    const op = async (action: string, body?: object) => {
      const current = useAuthStore.getState().user;
      if (!actor || current?.id !== actor.id || (current?.authorizationVersion ?? 1) !== (actor.authorizationVersion ?? 1)) {
        throw new Error('Your access changed. Sign in again before continuing.');
      }
      const url = `/project-work/${encodeURIComponent(card.id)}/${action}`;
      const response = action === 'poll'
        ? await client.get(url, stamped) : await client.post(url, body || {}, stamped);
      return response.data;
    };
    const phase = (text: string) => setPhases((old) => ({ ...old, [card.id]: text }));
    setFailures((old) => ({ ...old, [card.id]: '' }));
    try {
      // Recheck before sending. Reload never calls this function.
      const replay = await op('poll') as Replay;
      if (replay.status !== 'not_started') { await load(); return; }
      phase('Starting project work');
      // Normal host execution: no per-project qualification, image build,
      // container preparation or project-provider switching.
      await op('send');
      await load();
    } catch (err) {
      // Failed/ambiguous dispatch stays attached to this request identity. No
      // automatic resend; the next explicit action first reads durable status.
      setFailures((old) => ({ ...old, [card.id]: problem(err) }));
      await load();
    } finally {
      inFlight.current.delete(card.id);
      setPhases((old) => { const next = { ...old }; delete next[card.id]; return next; });
    }
  }, [load]);
  const submit = useCallback(async (prompt: string): Promise<boolean> => {
    if (!selected || !enabled || creatingRef.current || !prompt.trim()) return false;
    creatingRef.current = true;
    const target = scope;
    setCreating(true); setError(null);
    try {
      let conversation = originSessionKey;
      let destination = target;
      const draftConversation = conversation === 'main' || conversation.startsWith('new-')
        || (originProvider === 'OPENCLAW' ? /^agent:[^:]+:(?:main$|new-)/.test(conversation) : conversation.startsWith('agent:'));
      if (!parent && draftConversation) {
        const created = await client.post('/gateway/session-create', { provider: originProvider, session: conversation, model: originModel }, options);
        if (!created.data.ok || typeof created.data.key !== 'string' || !created.data.key) throw new Error('Could not create the project conversation.');
        conversation = created.data.key;
        destination = `${user?.id || ''}:${user?.authorizationVersion ?? 1}:${originProvider}:${conversation}`;
        if (scopeRef.current === target) chat.setSession(conversation);
      }
      const { data } = await client.post('/project-work', {
        id: crypto.randomUUID(), originProvider, originSessionKey: conversation,
        projectIdentityId: selected.identity.id, projectGeneration: selected.identity.generation,
        provider: worker, model: parent ? parentModel : worker === originProvider ? originModel : undefined, parentCardId: parent, prompt: prompt.trim(),
      }, options);
      const card: WorkCard = { ...data, projectIdentity: { projectName: selected.name,
        generation: selected.identity.generation, lifecycleStatus: 'ACTIVE' }, scopeValid: true, turn: null };
      if (scopeRef.current === target || scopeRef.current === destination) {
        focusCard.current = card.id; setFocusedId(card.id);
        setCards((old) => [...old, card]);
        // Do not discard a different project selected while this admission was pending.
        setSelected((current) => current?.identity.id === card.projectIdentityId ? null : current); setParent(null);
      }
      void start(card); return true;
    } catch (err) { if (scopeRef.current === target) setError(problem(err)); return false; }
    finally { creatingRef.current = false; setCreating(false); }
  }, [selected, enabled, creating, scope, originProvider, originSessionKey, worker, parent, parentModel, start, originModel, user?.id, user?.authorizationVersion, chat.setSession]);
  useEffect(() => {
    const target = parseProjectWorkLink(location.search, user ? { actorUserId: user.id, authorizationVersion: user.authorizationVersion ?? 1 } : null);
    if (!target || !user) return;
    let cancelled = false;
    const actor = user;
    void (async () => {
      await loadAndApplyDefaultAgentHarness(actor.id);
      if (cancelled || useAuthStore.getState().user?.id !== actor.id) return;
      if (target.originProvider && target.originSessionKey) {
        const agent = target.originProvider === 'OPENCLAW' ? target.originSessionKey.match(/^agent:([^:]+):/)?.[1] : undefined;
        chat.selectProviderAgent(target.originProvider, agent);
        await chat.selectSession(target.originSessionKey);
      }
      const data = await projectsAPI.list();
      if (cancelled || useAuthStore.getState().user?.id !== actor.id
        || (useAuthStore.getState().user?.authorizationVersion ?? 1) !== (actor.authorizationVersion ?? 1)) return;
      setProjects(data.projects);
      if (target.cardId) focusCard.current = target.cardId;
      else {
        const project = data.projects.find((entry) => entry.identity.id === target.projectIdentityId && entry.identity.generation === target.projectGeneration);
        if (project) { setSelected(project); setParent(null); }
        else setError('This project changed. Select its current version.');
      }
      navigate(location.pathname, { replace: true });
    })().catch((err) => { if (!cancelled) setError(problem(err)); });
    return () => { cancelled = true; };
  }, [location.key, user?.id, user?.authorizationVersion]);
  useEffect(() => {
    if (!focusCard.current || !cards.some((card) => card.id === focusCard.current)) return;
    const id = focusCard.current; focusCard.current = null;
    requestAnimationFrame(() => document.querySelector(`[data-work-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [cards]);
  const continueWork = (card: WorkCard) => {
    const project = projects.find((entry) => entry.identity.id === card.projectIdentityId);
    if (!project || project.identity.generation !== card.projectGeneration) {
      setError('Project changed. Select its current version for new work.'); return;
    }
    setSelected(project); setWorker(card.provider); setParent(card.id); setParentModel(card.model);
    requestAnimationFrame(() => document.querySelector('[data-testid=project-work-composer]')?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  };
  return { openclawWorkerLabel: projectWorkerLabel('OPENCLAW', originProvider, originSessionKey), cards, replays, replayErrors, refreshReplay, activeCards, activity, focusedCard, setFocusedId, workspaceOpen, setWorkspaceOpen, projects, selected, worker, error, phases, failures, creating, enabled, load, loadProjects,
    start, submit, continueWork, setWorker,
    choose: (project: ProjectSummary | null) => { setSelected(project); setParent(null); },
  };
}
export type ProjectWorkController = ReturnType<typeof useProjectWork>;

export function ProjectWorkComposer({ work }: { work: ProjectWorkController }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [prompt, setPrompt] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (work.selected) textarea.current?.focus(); }, [work.selected]);
  if (!work.enabled) return null;
  const send = async () => { if (await work.submit(prompt)) setPrompt(''); };
  return <div className="relative mb-2" data-testid="project-work-composer">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void work.loadProjects(); }}
        className={`inline-flex min-h-9 max-w-full items-center gap-2 rounded-xl border px-3 ${work.selected ? 'border-[var(--accent-border)] bg-[var(--accent-bg)] text-[var(--accent-light)]' : 'border-white/10 text-slate-300 hover:bg-white/5'}`}>
        <FolderOpen size={14} /><span className="truncate">{work.selected?.name || 'Work in a project'}</span><ChevronDown size={13} />
      </button>
      {work.selected && <>
        <ProjectWorkerPicker value={work.worker} onChange={work.setWorker} openclawLabel={work.openclawWorkerLabel} />
        <button type="button" onClick={() => work.choose(null)} aria-label="Return to main agent" title="Return to main agent" className="ml-auto p-2 text-slate-400 hover:text-white"><X size={15} /></button>
      </>}
    </div>
    {open && <div className="absolute bottom-full left-0 z-40 mb-2 w-full max-w-md rounded-2xl border border-white/10 bg-[#11172b] p-2 shadow-xl">
      <input autoFocus aria-label="Find a project" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }} placeholder="Find a project…" className="mb-2 w-full rounded-xl bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[var(--accent-border-hover)]" />
      <div className="max-h-64 overflow-y-auto">
        {work.projects.filter((project) => project.name.toLowerCase().includes(search.toLowerCase())).map((project) => <button key={project.identity.id} type="button" disabled={project.availability?.available === false} onClick={() => { work.choose(project); setOpen(false); }} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/5 disabled:opacity-40"><FolderOpen size={15} /><span className="truncate">{project.name}</span><FolderOpen className="ml-auto shrink-0 text-[var(--accent-light)]" size={14} /></button>)}
        {!work.projects.length && <p className="p-3 text-xs text-slate-400">No projects yet. Create one in Projects, then work on it here.</p>}
      </div>
      <button type="button" onClick={() => setOpen(false)} className="mt-1 w-full p-2 text-xs text-slate-400">Close</button>
    </div>}
    {work.error && <div role="alert" className="mt-2 text-xs text-amber-200">{work.error} <button type="button" onClick={() => void work.load()} className="underline">Refresh</button></div>}
    {work.selected && <div className="mt-2 rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-bg-subtle)] p-2">
      <p className="mb-1 flex items-center gap-1.5 px-2 text-[11px] text-[var(--accent-light)]"><FolderOpen size={12} />Project working folder · Agent Chat permissions</p>
      <div className="flex items-end gap-2">
        <textarea ref={textarea} aria-label={`Project request for ${work.selected.name}`} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { event.preventDefault(); void send(); } }} placeholder={`What should change in ${work.selected.name}?`} rows={2} maxLength={24000} className="max-h-48 min-h-14 min-w-0 flex-1 resize-y bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-slate-500" />
        <button type="button" aria-label="Start project work" onClick={() => void send()} disabled={work.creating || !prompt.trim()} className="mb-1 rounded-xl bg-[var(--accent-light)] p-3 text-slate-950 hover:brightness-110 disabled:opacity-30">{work.creating ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}</button>
      </div>
    </div>}
  </div>;
}

export function ProjectWorkCard({ card, work }: { card: WorkCard; work: ProjectWorkController }) {
  const replay = work.replays[card.id] || null;
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const reducedMotion = useReducedMotion();
  const reload = useCallback(() => work.refreshReplay(card), [card, work.refreshReplay]);
  const status = replay?.status || card.turn?.status.toLowerCase() || 'not_started';
  const phase = work.phases[card.id];
  const active = Boolean(replay?.active || (!replay && ['RUNNING', 'STARTING'].includes(card.turn?.status || '')));
  const done = status === 'completed';
  const label = !card.scopeValid ? 'Project changed' : (done ? 'Agent finished' : status === 'starting' ? 'Starting worker' : active ? 'Working' : phase ? phase : status === 'not_started' ? 'Ready to start' : status === 'aborted' ? 'Stopped' : 'Needs attention');
  const failure = error || work.replayErrors[card.id] || work.failures[card.id] || replay?.error;
  const stop = async () => {
    setStopping(true);
    try { const { data } = await client.post(`/project-work/${card.id}/stop`, {}, options); if (data.ok !== true) throw new Error('The worker did not confirm a stop. Its status has been refreshed.'); await reload(); }
    catch (err) { setError(problem(err)); }
    finally { setStopping(false); }
  };
  const project = work.projects.find((item) => item.identity.id === card.projectIdentityId);
  return <motion.article initial={reducedMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} data-testid="project-work-card" data-work-id={card.id} className="mx-auto my-4 w-[calc(100%-1.5rem)] max-w-[46rem] overflow-hidden rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-bg-subtle)] shadow-sm">
    <header className="flex items-start gap-3 border-b border-white/[0.05] px-4 py-3">
      <span className="rounded-xl bg-[var(--accent-bg)] p-2 text-[var(--accent-light)]"><FolderOpen size={17} /></span>
      <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold text-white">{card.projectName}</h3><p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400"><FolderOpen size={11} />Project workspace <span className="px-1">·</span>{projectWorkerLabel(card.provider, card.originProvider, card.originSessionKey)}</p></div>
      <span role="status" className={`flex max-w-[45%] items-center gap-1.5 text-xs ${done ? 'text-emerald-300' : active || phase ? 'text-[var(--accent-light)]' : 'text-slate-400'}`}>{(phase && !done) || active ? <Loader2 size={13} className="shrink-0 animate-spin" /> : done ? <CheckCircle2 size={13} className="shrink-0" /> : <AlertCircle size={13} className="shrink-0" />}{label}</span>
    </header>
    <div className="px-4 py-3"><p className="whitespace-pre-wrap break-words text-sm text-slate-200">{card.prompt}</p>
      {failure && <div role="alert" className="mt-3 rounded-xl border border-amber-400/15 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200">{failure}<button type="button" className="ml-2 underline" onClick={() => void reload()}>Check status</button></div>}
      {!card.scopeValid && <p className="mt-2 text-xs text-amber-200">This card is pinned to an earlier project identity. It will not act on its replacement.</p>}
      {phase && !active && !done && <p className="mt-2 text-xs text-slate-400">You can keep chatting while the worker starts.</p>}
    </div>
    <footer className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs">
      {card.scopeValid && !phase && status === 'not_started' && <button type="button" onClick={() => void work.start(card)} className="rounded-lg bg-[var(--accent-bg)] px-3 py-2 font-medium text-[var(--accent-light)]">Start work</button>}
      {(active || replay?.uncertain) && <button type="button" disabled={stopping} onClick={() => void stop()} className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-3 py-2 text-slate-200"><Square size={11} />{stopping ? 'Stopping…' : 'Stop'}</button>}
      {card.scopeValid && !active && !phase && replay?.complete && status !== 'not_started' && <button type="button" onClick={() => work.continueWork(card)} className="rounded-lg bg-[var(--accent-bg)] px-3 py-2 font-medium text-[var(--accent-light)]">Continue this work</button>}
      <button type="button" disabled={!card.scopeValid} onClick={() => { work.setFocusedId(card.id); work.setWorkspaceOpen(true); }} className="rounded-lg px-3 py-2 text-slate-300 hover:bg-white/5 disabled:opacity-40">Open workspace</button>
      {project?.deployedUrl && card.scopeValid && <a href={project.deployedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-slate-300 hover:bg-white/5">Preview<ExternalLink size={11} /></a>}

    </footer>

  </motion.article>;
}

/** Questions and approvals stay beside the composer, not at the old request card. */
export function ProjectWorkAttention({ card, active }: { card: WorkCard; active: boolean }) {
  const [questions, setQuestions] = useState<GatewayPendingQuestion[]>([]);
  const [approvals, setApprovals] = useState<ExecApprovalRequest[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!card.scopeValid || !active) { setQuestions([]); setApprovals([]); return; }
    const abort = new AbortController(); let busy = false;
    const fetch = async () => {
      if (busy || document.hidden) return; busy = true;
      try {
        const [pending, queue] = await Promise.all([
          client.get(`/project-work/${card.id}/questions`, { ...options, signal: abort.signal }),
          client.get(`/project-work/${card.id}/approvals`, { ...options, signal: abort.signal }),
        ]);
        if (!abort.signal.aborted) { setQuestions(pending.data.questions || []); setApprovals(queue.data.approvals || []); setError(null); }
      } catch (err) { if (!abort.signal.aborted) setError(problem(err)); }
      finally { busy = false; }
    };
    void fetch(); const timer = window.setInterval(() => { void fetch(); }, 2500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [card.id, card.scopeValid, active]);
  if (!card.scopeValid || !active || (!questions.length && !approvals.length && !error)) return null;
  return <section aria-label={`${card.projectName} needs your input`} className="mb-3 max-h-[40vh] overflow-auto rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-bg-subtle)] pt-3">
    <p className="mb-3 px-4 text-xs font-medium text-[var(--accent-light)]">{projectWorkerLabel(card.provider, card.originProvider, card.originSessionKey)} · {card.projectName}</p>
    {error && <p role="alert" className="mb-3 px-4 text-xs text-amber-200">{error}</p>}
    {approvals.map((approval) => <div key={approval.id} className="mx-4 mb-3 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs">
      <p className="font-medium text-amber-200">Command needs approval in {card.projectName}</p>
      <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-slate-300">{approval.request.command}</pre>
      <p className="mb-2 break-all text-slate-400">{approval.request.cwd}</p>
      <div className="flex gap-2">{(['allow-once', 'deny'] as const).map((decision) => <button type="button" key={decision} disabled={approvalBusy} className="rounded-lg border border-white/10 px-3 py-2 text-slate-200" onClick={async () => {
        setApprovalBusy(true);
        try { await client.post('/gateway/exec-approval/resolve', { approvalId: approval.id, decision }, options); setApprovals((old) => old.filter((entry) => entry.id !== approval.id)); }
        catch (err) { setError(problem(err)); } finally { setApprovalBusy(false); }
      }}>{decision === 'allow-once' ? 'Allow once' : 'Deny'}</button>)}</div>
    </div>)}
    {questions.length > 0 && <div className="px-4 pb-3">{questions.map((request) => <AskUserQuestionCard key={request.id} request={request} onSettled={(id) => setQuestions((old) => old.filter((entry) => entry.id !== id))} />)}</div>}
  </section>;
}

function ProjectWorkerPicker({ value, onChange, openclawLabel }: { value: ProjectWorker; onChange: (value: ProjectWorker) => void; openclawLabel: string }) {
  const labels = { ...workerLabels, OPENCLAW: openclawLabel };
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label="Project worker" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)] px-3 text-xs text-slate-200 transition hover:bg-[var(--accent-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-light)]">
      <Bot size={15} className="text-[var(--accent-light)]" />{labels[value]}<ChevronDown size={13} />
    </button>
    <ViewportModal open={open} onDismiss={() => setOpen(false)} className="flex items-center justify-center p-3">
      <section role="dialog" aria-modal="true" aria-label="Choose project worker" className="w-full max-w-md overflow-hidden rounded-3xl border border-[var(--accent-border)] bg-[#101425] shadow-2xl shadow-black/50">
        <header className="flex items-start gap-3 border-b border-white/5 bg-[var(--accent-bg-subtle)] p-5"><span className="rounded-2xl bg-[var(--accent-bg)] p-3 text-[var(--accent-light)]"><Bot size={23}/></span><div className="flex-1"><h3 className="text-base font-semibold tracking-tight text-white">Who’s working with you?</h3><p className="mt-1 text-xs leading-5 text-slate-400">Choose the assistant for this project’s work.</p></div><button type="button" aria-label="Close worker picker" onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5"><X size={17}/></button></header>
        <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-auto p-3">{Object.entries(labels).map(([key, label]) => <button key={key} type="button" aria-pressed={value === key} onClick={() => { onChange(key as ProjectWorker); setOpen(false); }} className={`group flex min-h-20 items-center gap-3 rounded-2xl border p-3 text-left transition ${value === key ? 'border-[var(--accent-border-hover)] bg-[var(--accent-bg)]' : 'border-white/5 bg-white/[0.02] hover:border-white/15 hover:bg-white/5'}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-xs font-semibold text-[var(--accent-light)]">{label.slice(0,2)}</span><span className="min-w-0 flex-1 text-xs font-medium text-slate-200">{label}</span>{value === key && <Check size={13} className="text-[var(--accent-light)]"/>}</button>)}</div>
      </section>
    </ViewportModal>
  </>;
}

export function ProjectWorkActivity({ card, activity, active }: { card: WorkCard; activity: WorkActivity; active: boolean }) {
  const identity = projectWorkerLabel(card.provider, card.originProvider, card.originSessionKey);
  return <article data-testid="project-work-activity" data-project-activity={card.id} className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-3">
    <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-bg)] text-[var(--accent-light)]"><Bot size={15}/></span>
    <div className="min-w-0 flex-1">
      <p className="mb-2 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500"><span className="font-medium text-slate-300">{identity}</span><span>·</span><span>{card.projectName}</span></p>
      {activity.kind === 'tool' ? <details className="group rounded-xl border border-white/[0.07] bg-white/[0.025] open:bg-white/[0.04]">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs text-slate-300"><ToolGlyph toolName={activity.tool?.name || 'tool'} size={14}/><span className="min-w-0 flex-1 break-words">{activity.tool?.name}</span><span className="text-[10px] text-slate-500">{activity.tool?.status === 'running' && !active ? 'Last reported running' : activity.tool?.status}</span>{activity.tool?.status === 'running' && active ? <Loader2 size={12} className="animate-spin text-[var(--accent-light)]"/> : <ChevronDown size={12}/>}</summary>
        {activity.tool?.arguments != null && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-white/5 p-3 text-[11px] text-slate-400">{typeof activity.tool.arguments === 'string' ? activity.tool.arguments : JSON.stringify(activity.tool.arguments, null, 2)}</pre>}
        {activity.tool?.result != null && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-white/5 p-3 text-xs text-slate-300">{typeof activity.tool.result === 'string' ? activity.tool.result : JSON.stringify(activity.tool.result, null, 2)}</pre>}
      </details> : <div className={activity.kind === 'reasoning' ? 'border-l-2 border-[var(--accent-border)] pl-4 text-sm leading-6 text-slate-400' : 'rounded-2xl rounded-tl-sm border border-white/[0.07] bg-white/[0.035] px-4 py-3 text-sm leading-6 text-slate-200'}>
        {activity.kind === 'reasoning' && <p className="mb-2 text-[11px] font-medium text-[var(--accent-light)]">{activity.subject || 'Working notes'}</p>}
        <MarkdownRenderer content={activity.content} isStreaming={false} hostFileContext={{ source: 'project', project: card.projectName }}/>
      </div>}
    </div>
  </article>;
}

/** Lives outside the scrolling transcript; one project, many conversational turns. */
export function ProjectWorkDock({ work }: { work: ProjectWorkController }) {
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const card = work.focusedCard;
  if (!card) return null;
  const project = work.projects.find(p => p.identity.id === card.projectIdentityId);
  const replay = work.replays[card.id];
  const active = work.activeCards.some(c => c.id === card.id);
  const choices = work.cards.filter((item, index, all) => !all.slice(index + 1).some(other => other.projectIdentityId === item.projectIdentityId));
  const stop = async () => {
    setStoppingId(card.id); setFailure(null);
    try {
      const { data } = await client.post(`/project-work/${card.id}/stop`, {}, options);
      if (data.ok !== true) throw new Error('The worker has not confirmed a stop.');
      await work.refreshReplay(card);
    } catch (error) { setFailure({ id: card.id, message: problem(error) }); }
    finally { setStoppingId(null); }
  };
  const status = !card.scopeValid ? 'Project changed' : replay?.uncertain ? 'Checking worker' : active ? 'In progress' : replay?.status === 'completed' ? 'Work completed' : replay?.status === 'aborted' ? 'Stopped' : replay?.complete ? 'Needs attention' : 'Project workspace';
  return <section aria-label="Project workspace dock" data-testid="project-work-dock" className="z-10 shrink-0 border-b border-[var(--accent-border)] bg-gradient-to-r from-[var(--accent-bg-subtle)] to-[#101427]">
    <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
      <button type="button" disabled={!card.scopeValid} aria-expanded={work.workspaceOpen} onClick={() => work.setWorkspaceOpen(!work.workspaceOpen)} className="group flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"><span className="rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-bg)] p-2.5 text-[var(--accent-light)]"><FolderOpen size={20}/></span><span className="min-w-0"><span className="block truncate text-sm font-semibold tracking-tight text-slate-100">{card.projectName}</span><span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">{active && <Loader2 size={11} className="animate-spin"/>}{status}<ChevronDown size={12} className={work.workspaceOpen ? 'rotate-180' : ''}/></span></span></button>
      {project?.hasGit && <span className="hidden items-center gap-1.5 text-xs text-slate-400 sm:inline-flex"><GitBranch size={13}/>{project.currentBranch}</span>}
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${project?.deployment?.isActive ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-white/10 text-slate-400'}`}><Radio size={11}/>{project?.deployment ? project.deployment.processStatus : 'Not deployed'}</span>
      {card.scopeValid && active && <button type="button" aria-label="Stop project work" disabled={stoppingId === card.id} onClick={() => void stop()} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50"><Square size={11}/>{stoppingId === card.id ? 'Stopping…' : 'Stop'}</button>}
      {card.scopeValid && !active && replay?.complete && <button type="button" onClick={() => work.continueWork(card)} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[var(--accent-bg)] px-3 text-xs text-[var(--accent-light)] hover:bg-[var(--accent-bg-hover)]">Continue<MessageCircle size={12}/></button>}
      {project?.deployedUrl && card.scopeValid && <a href={project.deployedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl px-2 py-2 text-xs text-[var(--accent-light)] hover:bg-white/5">Preview<ExternalLink size={13}/></a>}
      <button type="button" onClick={() => { document.querySelector(`[data-work-id="${CSS.escape(card.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} className="rounded-xl p-2 text-slate-400 hover:bg-white/5" aria-label="Jump to project conversation"><MessageCircle size={16}/></button>
    </div>
    {failure?.id === card.id && <p role="alert" className="mx-auto max-w-5xl px-4 pb-2 text-xs text-amber-200">{failure.message}</p>}
    {choices.length > 1 && <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 pb-2">{choices.map(item => <button type="button" key={item.id} aria-pressed={item.projectIdentityId === card.projectIdentityId} onClick={() => work.setFocusedId(item.id)} className={`shrink-0 rounded-full px-3 py-1 text-[11px] ${item.projectIdentityId === card.projectIdentityId ? 'bg-[var(--accent-bg)] text-[var(--accent-light)]' : 'text-slate-500 hover:bg-white/5'}`}>{item.projectName}</button>)}</div>}
    {work.workspaceOpen && <div className="max-h-[45vh] overflow-auto border-t border-white/5 bg-[#0e1322]">
      <div className="mx-auto max-w-5xl"><header className="flex items-center justify-between px-4 pt-3 text-xs"><span className="text-slate-400">Workspace · current state</span><button type="button" onClick={() => work.setWorkspaceOpen(false)} aria-label="Close project workspace" className="rounded-lg p-2 text-slate-400 hover:bg-white/5"><X size={15}/></button></header>
        {card.scopeValid ? <ProjectWorkFiles key={`${card.id}:${card.projectGeneration}`} card={card} active={active} hasGit={project?.hasGit}/> : <p className="p-4 text-sm text-amber-200">This project identity changed. Select its current version to view files.</p>}
      </div>
    </div>}
  </section>;
}
