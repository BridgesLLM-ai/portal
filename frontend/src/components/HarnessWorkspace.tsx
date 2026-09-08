import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Circle, Loader2, MessageSquare, Monitor, RefreshCw, Settings2, Terminal, Workflow } from 'lucide-react';
import { useAuthStore } from '../contexts/AuthContext';
import { loadDefaultAgentHarness, persistSelectedAgentHarness } from '../api/agentHarnessPreference';
import {
  assessAgentChatProviderAvailability,
  formatAgentChatProviderCatalogLoadError,
  isAgentChatProviderCatalogAbortError,
  loadAgentChatProviderCatalog,
  type AgentChatHarnessCatalogEntry,
} from '../utils/agentChatProviderCatalog';

const FEATURE_GROUPS = [
  { title: 'Conversations', features: [
    ['supportsSessionList', 'Session history'],
    ['supportsSessionResume', 'Resume sessions'],
    ['supportsSessionFork', 'Branch a conversation'],
  ] },
  { title: 'Working together', features: [
    ['supportsLiveToolEvents', 'Live tool activity'],
    ['supportsExecApproval', 'Approval controls'],
    ['supportsAskUser', 'Interactive questions'],
  ] },
  { title: 'Stay in control', features: [
    ['supportsAttachments', 'Attachments'],
    ['supportsInTurnSteering', 'Steer a running turn'],
    ['supportsCancellation', 'Stop a turn'],
  ] },
] as const;

const idOf = (entry: AgentChatHarnessCatalogEntry) => entry.harnessId || entry.name;

export default function HarnessWorkspace() {
  const userId = useAuthStore((state) => state.user?.id);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedHarness = searchParams.get('harness');
  const [defaultHarness, setDefaultHarness] = useState<{ userId: string; id: string } | null>(null);
  const [catalog, setCatalog] = useState<AgentChatHarnessCatalogEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const savedDefault = defaultHarness && defaultHarness.userId === userId ? defaultHarness.id : null;
  const selectedId = requestedHarness || savedDefault || '';
  const selected = catalog.find((entry) => idOf(entry) === selectedId);

  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    void loadDefaultAgentHarness(userId).then((preference) => {
      if (!cancelled) setDefaultHarness({ userId, id: preference.defaultHarness });
    }).catch(() => { if (!cancelled) setDefaultHarness(null); });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setCatalog([]);
    void loadAgentChatProviderCatalog({
      signal: controller.signal,
      force: true,
      onSnapshot: (entries, metadata) => {
        if (!controller.signal.aborted && metadata.fresh) {
          setCatalog(entries);
          setLoading(false);
        }
      },
    }).then((entries) => {
      if (!controller.signal.aborted) setCatalog(entries);
    }).catch((error) => {
      if (!isAgentChatProviderCatalogAbortError(error) && !controller.signal.aborted) {
        setLoadError(formatAgentChatProviderCatalogLoadError(error));
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [userId, refresh]);

  const availability = assessAgentChatProviderAvailability(selectedId, selected, { loading, loadError });
  const status = availability.canSend ? 'Ready in Portal'
    : availability.status === 'checking' ? 'Checking connection'
      : selected?.nativeAuthStatus === 'needs_login' ? 'Sign-in needed'
        : selected?.installed === false ? 'Not installed' : 'Not ready in Portal';

  const selectHarness = (id: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('harness', id);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <section className="rounded-2xl border border-sky-400/15 bg-gradient-to-br from-sky-500/[0.08] via-white/[0.025] to-violet-500/[0.06] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <p className="text-xs font-medium uppercase tracking-widest text-sky-300">Your workspace</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Work your way</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">Keep everyday conversations in Portal. Open a native workspace when you need its complete set of tools and controls.</p>
            </div>
            <Link to="/settings?tab=agents" className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-slate-200 hover:bg-white/5">
              <Settings2 size={14} /> Change default
            </Link>
          </div>
          <div className="mt-5 flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 sm:max-w-sm">
              <span className="mb-1.5 block text-xs text-slate-300">Harness workspace</span>
              <select aria-label="Harness workspace" value={selectedId} onChange={(event) => selectHarness(event.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-white/15 bg-[#101630] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/60">
                <option value="" disabled>Choose a harness</option>
                {selectedId && !selected && <option value={selectedId}>{selectedId} — unavailable</option>}
                {catalog.map((entry) => <option key={idOf(entry)} value={idOf(entry)}>{entry.displayName}{idOf(entry) === savedDefault ? ' · Your default' : ''}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 px-3 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">
              <RefreshCw size={14} className={loading ? 'motion-safe:animate-spin' : ''} /> Refresh
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">Exploring a workspace does not change your default or move existing sessions.</p>
          {loadError && <p role="alert" className="mt-3 text-sm text-amber-200">{loadError}</p>}
        </section>

        {selected && (
          <section aria-label={`${selected.displayName} workspace`} className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">{selected.displayName}</h2>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                  {selected.version && <span>{selected.version}</span>}
                  {selectedId === savedDefault && <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-200">Your default</span>}
                </div>
              </div>
              <span role="status" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${availability.canSend ? 'bg-emerald-500/10 text-emerald-200' : 'bg-white/5 text-slate-300'}`}>
                {availability.status === 'checking' ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Circle size={8} fill="currentColor" />}
                {status}
              </span>
            </div>
            {availability.message && <p className="mt-3 text-sm text-slate-300">{availability.message}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={!availability.canSend} onClick={() => {
                persistSelectedAgentHarness(selected.name);
                navigate('/agent-chats');
              }} className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-sky-400 px-4 text-sm font-medium text-slate-950 hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-400">
                <MessageSquare size={15} /> Open Agent Chat <ArrowRight size={14} />
              </button>
              <Link to="/settings?tab=ai-providers" className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-white/10 px-4 text-sm text-slate-200 hover:bg-white/5">Connections & models</Link>
            </div>
            <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-slate-400">Available in Portal chat</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              {FEATURE_GROUPS.map((group) => (
                <div key={group.title} className="rounded-xl border border-white/[0.06] p-3">
                  <h4 className="text-sm font-medium text-slate-200">{group.title}</h4>
                  <ul className="mt-3 space-y-2 text-xs">
                    {group.features.map(([key, label]) => {
                      const supported = selected.implemented === true && selected.selectable !== false && selected.capabilities?.[key] === true;
                      return <li key={key} className="flex items-center justify-between gap-2 text-slate-300">
                        <span>{label}</span>
                        {supported ? <Check size={14} aria-label={`${label} supported`} className="text-emerald-300" /> : <span className="text-[10px] text-slate-500">Not exposed</span>}
                      </li>;
                    })}
                  </ul>
                </div>
              ))}
            </div>
            {selectedId === 'OPENCLAW' && (
              <Link to="/agent-tools?tab=tasks" className="mt-5 inline-flex min-h-[36px] items-center gap-2 text-sm text-sky-300 hover:text-sky-200">
                <Workflow size={15} /> Open sub-agent & background activity <ArrowRight size={14} />
              </Link>
            )}
          </section>
        )}

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
          <h2 className="font-semibold text-white">One Portal guide, every harness</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">In Agent Chat, use the book button to add the packaged BridgesLLM guide to your draft. Review it with your task, then send it to your selected harness. No skill manager or extra plugin is required.</p>
        </section>

        <section aria-label="Native workspaces" className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
            <Monitor size={21} className="text-violet-300" />
            <h2 className="mt-3 font-semibold text-white">The native experience</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">Use installed desktop apps, web UIs, and CLI launchers in Remote Desktop. Native sessions stay in their own workspace; Portal does not transfer the current chat.</p>
            <Link to="/desktop" className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-400/10 px-3 text-sm text-violet-200 hover:bg-violet-400/20">Open Remote Desktop <ArrowRight size={14} /></Link>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
            <Terminal size={21} className="text-amber-300" />
            <h2 className="mt-3 font-semibold text-white">Native CLI & extensions</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">Use the terminal for a harness's own commands, skills, and extensions. The Skills, Tasks, Automations, and Usage tabs here manage OpenClaw; other harnesses keep their own controls.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link to="/terminal" className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 text-sm text-amber-200 hover:bg-amber-400/20">Open Terminal <ArrowRight size={14} /></Link>
              <Link to="/agent-tools?tab=tools" className="inline-flex min-h-[40px] items-center text-sm text-slate-300 hover:text-white">Installed tools</Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
