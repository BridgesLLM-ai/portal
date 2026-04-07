import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Timer, BarChart3, Puzzle, ChevronDown, Check, Loader2, Layers, ListTodo } from 'lucide-react';
import client from '../api/client';
import { getShortModelLabel } from '../utils/modelId';

/* ─── Lazy-loaded tab content components ────────────────── */

const AutomationsContent = lazy(() => import('./AutomationsPage').then(m => ({ default: m.AutomationsContent })));
const UsageContent = lazy(() => import('./UsagePage').then(m => ({ default: m.UsageContent })));
const SkillsContent = lazy(() => import('./SkillsPage').then(m => ({ default: m.SkillsContent })));
const TasksContent = lazy(() => import('./TasksPage').then(m => ({ default: m.TasksContent })));

/* ─── Types ─────────────────────────────────────────────── */

type TabKey = 'automations' | 'usage' | 'skills' | 'tasks';

const VALID_TABS: TabKey[] = ['automations', 'usage', 'skills', 'tasks'];

interface OpenClawAgent {
  id: string;
  identity?: string;
  model?: string;
  workspace?: string;
  avatarUrl?: string;
  provider?: string;
  providerDisplayName?: string;
  selectable?: boolean;
  disabledReason?: string;
}

interface ProviderInfo {
  name: string;
  displayName: string;
  installed?: boolean;
  implemented?: boolean;
  usable?: boolean;
  native?: boolean;
  reason?: string;
}

interface TabDef {
  key: TabKey;
  label: string;
  icon: typeof Timer;
}

/* ─── Constants ─────────────────────────────────────────── */

const TABS: TabDef[] = [
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
  if (agent.provider === 'OPENCLAW' && agent.id === 'main' && assistantName) return assistantName;
  if (agent.provider && agent.provider !== 'OPENCLAW' && agent.id === '__provider__') return agent.providerDisplayName || agent.provider;
  return agent.id.charAt(0).toUpperCase() + agent.id.slice(1);
}

function makeSelectorKey(agent: OpenClawAgent): string {
  return `${agent.provider || 'OPENCLAW'}:${agent.id}`;
}

function parseProviderAgent(value: string | null): { provider: string; agentId: string } {
  if (!value) return { provider: 'OPENCLAW', agentId: 'main' };
  const idx = value.indexOf(':');
  if (idx === -1) return { provider: 'OPENCLAW', agentId: value || 'main' };
  return {
    provider: value.slice(0, idx) || 'OPENCLAW',
    agentId: value.slice(idx + 1) || 'main',
  };
}

function parseTab(tab: string | null): TabKey {
  return VALID_TABS.includes(tab as TabKey) ? (tab as TabKey) : 'automations';
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
  providers: ProviderInfo[];
  selected: string;
  onSelect: (agentKey: string) => void;
  loading?: boolean;
  assistantName?: string;
}

function AgentSelectorDropdown({ agents, providers, selected, onSelect, loading, assistantName }: AgentSelectorProps) {
  const [open, setOpen] = useState(false);

  const selectedAgent = agents.find(a => makeSelectorKey(a) === selected) || { id: parseProviderAgent(selected).agentId, provider: parseProviderAgent(selected).provider, identity: AGENT_IDENTITY_FALLBACK[parseProviderAgent(selected).agentId] };

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-agent-selector]')) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="relative" data-agent-selector>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-sm text-slate-300 transition-colors min-w-[160px]"
      >
        <div className="w-6 h-6 rounded-lg bg-emerald-500/15 flex items-center justify-center text-sm flex-shrink-0">
          {getAgentEmoji(selectedAgent)}
        </div>
        <span className="flex-1 text-left truncate font-medium">
          {getAgentLabel(selectedAgent, assistantName)}
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

      {open && (
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.15 }}
          className="absolute top-full left-0 mt-1.5 w-56 rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden z-50"
        >
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              <Layers size={10} />
              Provider / Agent
            </div>
          </div>

          <div className="max-h-[340px] overflow-y-auto">
            {providers.map((provider) => {
              const providerAgents = agents.filter(agent => (agent.provider || 'OPENCLAW') === provider.name);
              const providerDisabled = provider.name !== 'OPENCLAW';
              return (
                <div key={provider.name} className="pb-1">
                  <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 border-t border-white/[0.04] first:border-t-0">
                    {provider.displayName}
                  </div>
                  {providerAgents.map((agent) => {
                    const key = makeSelectorKey(agent);
                    const isSelected = key === selected;
                    const disabled = providerDisabled || agent.selectable === false;
                    return (
                      <button
                        key={key}
                        onClick={() => { if (!disabled) { onSelect(key); setOpen(false); } }}
                        disabled={disabled}
                        className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                          isSelected
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : disabled
                              ? 'text-slate-500 cursor-not-allowed'
                              : 'text-slate-300 hover:bg-white/[0.04] hover:text-white'
                        }`}
                        title={disabled ? (agent.disabledReason || provider.reason || `${provider.displayName} support coming soon`) : undefined}
                      >
                        <div className="w-6 h-6 rounded-lg bg-white/[0.06] flex items-center justify-center text-sm flex-shrink-0">
                          {getAgentEmoji(agent)}
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                          <div className="truncate">{getAgentLabel(agent, assistantName)}</div>
                          {(provider.name !== 'OPENCLAW' || agent.disabledReason) && (
                            <div className="truncate text-[10px] text-slate-500 mt-0.5">{agent.disabledReason || provider.reason || 'Provider integration pending for Agent Tools tabs'}</div>
                          )}
                        </div>
                        {agent.model && (
                          <span className="text-[10px] text-slate-600 font-mono truncate max-w-[60px]">
                            {getShortModelLabel(agent.model)}
                          </span>
                        )}
                        {isSelected && <Check size={14} className="text-emerald-400 flex-shrink-0" />}
                      </button>
                    );
                  })}
                  {!providerAgents.length && (
                    <div className="px-4 py-2.5 text-xs text-slate-600">No entries</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="h-1" />
        </motion.div>
      )}
    </div>
  );
}

/* ─── Main Page Component ───────────────────────────────── */

export default function AgentToolsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = parseTab(searchParams.get('tab'));
  const requestedAgent = parseAgent(searchParams.get('agent'));
  const requestedProvider = (searchParams.get('provider') || 'OPENCLAW').toUpperCase();
  const [activeTab, setActiveTab] = useState<TabKey>(() => requestedTab);
  const [providers, setProviders] = useState<ProviderInfo[]>([{ name: 'OPENCLAW', displayName: 'OpenClaw', usable: true, installed: true, implemented: true }]);
  const [agents, setAgents] = useState<OpenClawAgent[]>([{ id: 'main', provider: 'OPENCLAW', identity: '🤖' }]);
  const [selectedAgent, setSelectedAgent] = useState(() => `${requestedProvider}:${requestedAgent}`);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [assistantName, setAssistantName] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function fetchAgents() {
      try {
        const [agentsResp, providersResp] = await Promise.all([
          client.get('/gateway/agents'),
          client.get('/gateway/providers'),
        ]);
        if (cancelled) return;

        const providerList: ProviderInfo[] = Array.isArray(providersResp.data?.providers)
          ? providersResp.data.providers
          : [{ name: 'OPENCLAW', displayName: 'OpenClaw', usable: true, installed: true, implemented: true }];
        setProviders(providerList);

        const openclawAgents: OpenClawAgent[] = agentsResp.data?.agents?.length
          ? agentsResp.data.agents.map((agent: OpenClawAgent) => ({ ...agent, provider: 'OPENCLAW', selectable: true }))
          : [{ id: 'main', provider: 'OPENCLAW', identity: '🤖', selectable: true }];

        const placeholderProviders = providerList
          .filter((provider) => provider.name !== 'OPENCLAW')
          .map((provider) => ({
            id: '__provider__',
            provider: provider.name,
            providerDisplayName: provider.displayName,
            identity: '🧩',
            selectable: false,
            disabledReason: provider.reason || 'Provider integration pending for Agent Tools tabs',
          } satisfies OpenClawAgent));

        const nextAgents: OpenClawAgent[] = [...openclawAgents, ...placeholderProviders];
        setAgents(nextAgents);

        if (!nextAgents.some((agent) => makeSelectorKey(agent) === `${requestedProvider}:${requestedAgent}`)) {
          setSelectedAgent(makeSelectorKey(openclawAgents[0] || { id: 'main', provider: 'OPENCLAW' } as OpenClawAgent));
        }
      } catch {
        // Keep default main agent
      } finally {
        if (!cancelled) setAgentsLoading(false);
      }
    }

    fetchAgents();
    return () => { cancelled = true; };
  }, [requestedProvider, requestedAgent]);

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
    const requestedKey = `${requestedProvider}:${requestedAgent}`;
    setSelectedAgent((current) => (current === requestedKey ? current : requestedKey));
  }, [requestedTab, requestedProvider, requestedAgent]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    let changed = false;

    if (params.get('tab') !== activeTab) {
      params.set('tab', activeTab);
      changed = true;
    }

    if (selectedProvider !== 'OPENCLAW') {
      if (params.get('provider') !== selectedProvider) {
        params.set('provider', selectedProvider);
        changed = true;
      }
    } else if (params.has('provider')) {
      params.delete('provider');
      changed = true;
    }

    if (selectedAgentId === 'main' && selectedProvider === 'OPENCLAW') {
      if (params.has('agent')) {
        params.delete('agent');
        changed = true;
      }
    } else if (params.get('agent') !== selectedAgentId) {
      params.set('agent', selectedAgentId);
      changed = true;
    }

    if (changed) {
      setSearchParams(params, { replace: true });
    }
  }, [activeTab, selectedAgent, setSearchParams]);

  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
  }, []);

  const handleAgentSelect = useCallback((agentKey: string) => {
    setSelectedAgent(agentKey);
  }, []);

  const selectedProvider = parseProviderAgent(selectedAgent).provider;
  const selectedAgentId = parseProviderAgent(selectedAgent).agentId;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#0A0E27]">
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-4 border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-white">Agent Tools</h1>
              <p className="text-slate-400 text-sm mt-0.5">Automations, usage stats, and skills management</p>
            </div>

            <AgentSelectorDropdown
              agents={agents}
              providers={providers}
              selected={selectedAgent}
              onSelect={handleAgentSelect}
              loading={agentsLoading}
              assistantName={assistantName}
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none pb-0.5 -mb-px">
            {TABS.map(({ key, label, icon: Icon }) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  onClick={() => handleTabChange(key)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-t-xl text-sm font-medium transition-all whitespace-nowrap ${
                    isActive
                      ? 'bg-white/[0.06] text-emerald-400 border-b-2 border-emerald-400'
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
        {selectedProvider !== 'OPENCLAW' ? (
          <div className="h-full overflow-auto p-6 md:p-8">
            <div className="max-w-4xl mx-auto rounded-3xl border border-amber-500/20 bg-amber-500/10 p-6 text-amber-100">
              <div className="text-lg font-semibold">{providers.find((p) => p.name === selectedProvider)?.displayName || selectedProvider} support is not wired into Agent Tools yet</div>
              <div className="mt-2 text-sm text-amber-100/80">
                The selector is now provider-aware so we can add Agent Zero, Codex, Claude Code, Gemini, and Ollama cleanly without another rewrite. Today, these tabs still operate on OpenClaw-backed agents only.
              </div>
            </div>
          </div>
        ) : (
          <Suspense fallback={<TabFallback />}>
            {activeTab === 'automations' && <AutomationsContent agentId={selectedAgentId} />}
            {activeTab === 'usage' && <UsageContent agentId={selectedAgentId} />}
            {activeTab === 'skills' && <SkillsContent agentId={selectedAgentId} />}
            {activeTab === 'tasks' && <TasksContent agentId={selectedAgentId} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}
