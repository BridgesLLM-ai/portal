import {
  useState,
  useEffect,
  useCallback,
  useId,
  useRef,
  lazy,
  Suspense,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Timer, BarChart3, Puzzle, ChevronDown, Check, Loader2, Layers, ListTodo, Wrench } from 'lucide-react';
import client from '../api/client';
import { getShortModelLabel } from '../utils/modelId';
import AnchoredPopover from '../components/AnchoredPopover';

/* ─── Lazy-loaded tab content components ────────────────── */

const AutomationsContent = lazy(() => import('./AutomationsPage').then(m => ({ default: m.AutomationsContent })));
const UsageContent = lazy(() => import('./UsagePage').then(m => ({ default: m.UsageContent })));
const SkillsContent = lazy(() => import('./SkillsPage').then(m => ({ default: m.SkillsContent })));
const TasksContent = lazy(() => import('./TasksPage').then(m => ({ default: m.TasksContent })));
const ToolsContent = lazy(() => import('./ToolsPage').then(m => ({ default: m.ToolsContent })));

/* ─── Types ─────────────────────────────────────────────── */

type TabKey = 'tools' | 'automations' | 'usage' | 'skills' | 'tasks';

const VALID_TABS: TabKey[] = ['tools', 'automations', 'usage', 'skills', 'tasks'];

interface OpenClawAgent {
  id: string;
  identity?: string;
  model?: string;
  workspace?: string;
  avatarUrl?: string;
}

interface TabDef {
  key: TabKey;
  label: string;
  icon: typeof Timer;
}

/* ─── Constants ─────────────────────────────────────────── */

const TABS: TabDef[] = [
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'automations', label: 'Automations', icon: Timer },
  { key: 'usage', label: 'Usage', icon: BarChart3 },
  { key: 'skills', label: 'Skills', icon: Puzzle },
  { key: 'tasks', label: 'Tasks', icon: ListTodo },
];

const AGENT_IDENTITY_FALLBACK: Record<string, string> = {
  main: '🤖',
  parity: '🔬',
  kernel: '🛠️',
  isotype: '🧬',
};

/* ─── Helpers ───────────────────────────────────────────── */

function getAgentEmoji(agent: OpenClawAgent): string {
  if (agent.identity) return agent.identity;
  return AGENT_IDENTITY_FALLBACK[agent.id] || '🤖';
}

function getAgentLabel(agent: OpenClawAgent, assistantName?: string): string {
  if (agent.id === 'main' && assistantName) return assistantName;
  return agent.id.charAt(0).toUpperCase() + agent.id.slice(1);
}

function parseTab(tab: string | null): TabKey {
  return VALID_TABS.includes(tab as TabKey) ? (tab as TabKey) : 'tools';
}

function parseAgent(agent: string | null): string {
  return agent || 'main';
}

/* ─── Tab Fallback ──────────────────────────────────────── */

function TabFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 size={32} className="text-slate-400 animate-spin" />
    </div>
  );
}

/* ─── Agent Selector Dropdown ───────────────────────────── */

interface AgentSelectorProps {
  agents: OpenClawAgent[];
  selected: string;
  onSelect: (agentId: string) => void;
  loading?: boolean;
  assistantName?: string;
}

function AgentSelectorDropdown({ agents, selected, onSelect, loading, assistantName }: AgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [listboxElement, setListboxElement] = useState<HTMLDivElement | null>(null);
  const listboxId = useId();
  const selectedAgent = agents.find((agent) => agent.id === selected) || {
    id: selected,
    identity: AGENT_IDENTITY_FALLBACK[selected],
  };

  useEffect(() => {
    if (!open) return;
    Array.from(
      listboxElement?.querySelectorAll<HTMLButtonElement>('[data-openclaw-agent]') || [],
    ).find((option) => option.dataset.openclawAgent === selected)?.focus();
  }, [listboxElement, open, selected]);

  const handleListboxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(
      listboxElement?.querySelectorAll<HTMLButtonElement>('[data-openclaw-agent]') || [],
    );
    if (options.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label="Select OpenClaw agent"
        className="flex min-w-[190px] items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/[0.10]"
      >
        <div className="w-6 h-6 rounded-lg bg-emerald-500/15 flex items-center justify-center text-sm flex-shrink-0">
          {getAgentEmoji(selectedAgent)}
        </div>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-medium text-white">
            {getAgentLabel(selectedAgent, assistantName)}
          </span>
          <span className="block text-[10px] leading-3 text-slate-500">OpenClaw agent</span>
        </span>
        {loading ? (
          <Loader2 size={14} className="text-slate-500 animate-spin" />
        ) : (
          <ChevronDown
            size={14}
            className={`text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={(reason) => {
          setOpen(false);
          if (reason === 'escape') triggerRef.current?.focus();
        }}
        width={304}
        align="end"
        mobileBreakpoint={639}
        ariaLabel="OpenClaw agent options"
      >
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.15 }}
          ref={setListboxElement}
          id={listboxId}
          role="listbox"
          aria-label="OpenClaw agents"
          onKeyDown={handleListboxKeyDown}
          className="flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#1A1F3A] shadow-2xl shadow-black/50"
        >
          <div className="border-b border-white/[0.06] px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <Layers size={10} />
              OpenClaw agent scope
            </div>
            <div className="mt-1 text-[10px] leading-4 text-slate-400">
              Agent Tools is OpenClaw-scoped. Agent Chat providers are selected in Agent Chat.
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {agents.map((agent) => {
              const isSelected = agent.id === selected;
              return (
                <button
                  type="button"
                  key={agent.id}
                  data-openclaw-agent={agent.id}
                  onClick={() => {
                    onSelect(agent.id);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  role="option"
                  aria-selected={isSelected}
                  className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                    isSelected
                      ? 'accent-active'
                      : 'text-slate-300 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <div className="w-6 h-6 rounded-lg bg-white/[0.06] flex items-center justify-center text-sm flex-shrink-0">
                    {getAgentEmoji(agent)}
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <div className="truncate">{getAgentLabel(agent, assistantName)}</div>
                  </div>
                  {agent.model && (
                    <span className="max-w-[90px] truncate font-mono text-[10px] text-slate-600">
                      {getShortModelLabel(agent.model)}
                    </span>
                  )}
                  {isSelected && <Check size={14} className="flex-shrink-0 accent-text" />}
                </button>
              );
            })}
          </div>
        </motion.div>
      </AnchoredPopover>
    </div>
  );
}

/* ─── Main Page Component ───────────────────────────────── */

export default function AgentToolsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = parseTab(searchParams.get('tab'));
  const requestedAgent = parseAgent(searchParams.get('agent'));
  const [activeTab, setActiveTab] = useState<TabKey>(() => requestedTab);
  const [agents, setAgents] = useState<OpenClawAgent[]>([{ id: 'main', identity: '🤖' }]);
  const [selectedAgent, setSelectedAgent] = useState(() => requestedAgent);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [assistantName, setAssistantName] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function fetchAgents() {
      try {
        const agentsResp = await client.get('/gateway/agents');
        if (cancelled) return;

        const openclawAgents: OpenClawAgent[] = agentsResp.data?.agents?.length
          ? agentsResp.data.agents
          : [{ id: 'main', identity: '🤖' }];

        setAgents(openclawAgents);

        if (!openclawAgents.some((agent) => agent.id === requestedAgent)) {
          setSelectedAgent(openclawAgents[0]?.id || 'main');
        }
      } catch {
        // Keep default main agent
      } finally {
        if (!cancelled) setAgentsLoading(false);
      }
    }

    fetchAgents();
    return () => { cancelled = true; };
  }, [requestedAgent]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSettings() {
      try {
        const { data } = await client.get('/settings/public');
        if (!cancelled && data.assistantName) {
          setAssistantName(data.assistantName);
        }
      } catch {
        // Ignore
      }
    }

    fetchSettings();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setActiveTab((current) => (current === requestedTab ? current : requestedTab));
    setSelectedAgent((current) => (current === requestedAgent ? current : requestedAgent));
  }, [requestedTab, requestedAgent]);

  const selectedAgentId = selectedAgent;

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    let changed = false;

    if (params.get('tab') !== activeTab) {
      params.set('tab', activeTab);
      changed = true;
    }

    if (params.has('provider')) {
      params.delete('provider');
      changed = true;
    }

    if (activeTab === 'tools' || activeTab === 'skills' || activeTab === 'tasks') {
      if (params.has('agent')) {
        params.delete('agent');
        changed = true;
      }
    } else {
      if (params.get('agent') !== selectedAgentId) {
        params.set('agent', selectedAgentId);
        changed = true;
      }
    }

    if (changed) {
      setSearchParams(params, { replace: true });
    }
  }, [activeTab, searchParams, selectedAgentId, setSearchParams]);

  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
  }, []);

  const handleAgentSelect = useCallback((agentKey: string) => {
    setSelectedAgent(agentKey);
  }, []);

  const isSharedScopeTab = activeTab === 'tools' || activeTab === 'skills' || activeTab === 'tasks';
  const sharedScopeCard = activeTab === 'tools'
    ? {
        title: 'Shared host tool inventory',
        description: 'Verified command-line runtimes for Owner and Sub Admin host operations.',
      }
    : activeTab === 'skills'
    ? {
        title: 'Shared skill inventory',
        description: 'Skills and plugins are managed instance-wide across OpenClaw.',
      }
    : {
        title: 'Shared task activity',
        description: 'Tasks are shown across all OpenClaw agents.',
      };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#0A0E27]">
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-4 border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-white">Agent Tools</h1>
              <p className="text-slate-400 text-sm mt-0.5">Host tools, automations, usage, extensions, and background work</p>
            </div>

            {!isSharedScopeTab ? (
              <AgentSelectorDropdown
                agents={agents}
                selected={selectedAgent}
                onSelect={handleAgentSelect}
                loading={agentsLoading}
                assistantName={assistantName}
              />
            ) : (
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-left sm:text-right">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Scope</div>
                <div className="mt-0.5 text-sm font-medium text-white">{sharedScopeCard.title}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{sharedScopeCard.description}</div>
              </div>
            )}
          </div>

          <div role="tablist" aria-label="Agent Tools sections" className="flex items-center gap-1 overflow-x-auto scrollbar-none pb-0.5 -mb-px">
            {TABS.map(({ key, label, icon: Icon }) => {
              const isActive = activeTab === key;
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => handleTabChange(key)}
                  id={`agent-tools-tab-${key}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`agent-tools-panel-${key}`}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-t-xl text-sm font-medium transition-all whitespace-nowrap ${
                    isActive
                      ? 'accent-active border-b-2'
                      : 'text-slate-400 hover:text-white hover:bg-white/[0.03]'
                  }`}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          id={`agent-tools-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`agent-tools-tab-${activeTab}`}
          className="h-full"
        >
          <Suspense fallback={<TabFallback />}>
            {activeTab === 'automations' && <AutomationsContent agentId={selectedAgentId} />}
            {activeTab === 'usage' && <UsageContent agentId={selectedAgentId} />}
            {activeTab === 'tools' && <ToolsContent />}
            {activeTab === 'skills' && <SkillsContent />}
            {activeTab === 'tasks' && <TasksContent />}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
