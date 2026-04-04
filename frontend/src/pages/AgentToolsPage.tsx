import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Timer,
  BarChart3,
  Puzzle,
  ChevronDown,
  Check,
  Loader2,
  Layers,
  ListTodo,
  Shield,
  ShieldAlert,
  Link2,
  Brain,
  Sparkles,
  Terminal,
  ArrowUpRight,
  CheckCircle2,
  CircleOff,
  Clock3,
  Bot,
  Copy,
  RefreshCw,
} from 'lucide-react';
import client from '../api/client';
import { gatewayAPI } from '../api/endpoints';

/* ─── Lazy-loaded tab content components ────────────────── */

const AutomationsContent = lazy(() => import('./AutomationsPage').then(m => ({ default: m.AutomationsContent })));
const UsageContent = lazy(() => import('./UsagePage').then(m => ({ default: m.UsageContent })));
const SkillsContent = lazy(() => import('./SkillsPage').then(m => ({ default: m.SkillsContent })));
const TasksContent = lazy(() => import('./TasksPage').then(m => ({ default: m.TasksContent })));

/* ─── Types ─────────────────────────────────────────────── */

type TabKey = 'automations' | 'usage' | 'skills' | 'tasks';
type NativePermissionLevel = 'sandboxed' | 'elevated';

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

interface ProviderCapabilitySummary {
  implemented?: boolean;
  requiresGateway?: boolean;
  adapterFamily?: string;
  adapterKey?: string;
  supportsHistory?: boolean;
  supportsModelSelection?: boolean;
  modelSelectionMode?: string;
  supportsCustomModelInput?: boolean;
  canEnumerateModels?: boolean;
  modelCatalogKind?: string;
  supportsSessionList?: boolean;
  supportsExecApproval?: boolean;
  supportsInTurnSteering?: boolean;
  supportsQueuedFollowUps?: boolean;
  followUpMode?: string;
}

interface ProviderInfo {
  name: string;
  displayName: string;
  installed?: boolean;
  implemented?: boolean;
  usable?: boolean;
  native?: boolean;
  version?: string;
  command?: string;
  reason?: string;
  nativeAuthStatus?: string;
  nativeAuthMessage?: string;
  nativeAuthLoginCommand?: string;
  requiresSeparateNativeLogin?: boolean;
  capabilities?: ProviderCapabilitySummary;
}

interface ProviderModelDescriptor {
  id: string;
  alias?: string | null;
  provider: string;
  displayName: string;
  source?: string;
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

const PROVIDER_IDENTITY: Record<string, string> = {
  CLAUDE_CODE: '🧠',
  CODEX: '⚡',
  GEMINI: '✨',
  OLLAMA: '🦙',
  AGENT_ZERO: '🤖',
};

const PORTAL_ROOT_PATHS = [
  '/opt/bridgesllm/portal',
  '/opt/bridgesllm/portal/backend',
  '/opt/bridgesllm/portal/frontend',
];

/* ─── Helpers ───────────────────────────────────────────── */

function getAgentEmoji(agent: OpenClawAgent): string {
  if (agent.identity) return agent.identity;
  if (agent.provider && PROVIDER_IDENTITY[agent.provider]) return PROVIDER_IDENTITY[agent.provider];
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

function capabilityLabel(value?: boolean, positive = 'Yes', negative = 'No') {
  return value ? positive : negative;
}

function statusTone(provider: ProviderInfo): 'good' | 'warn' | 'bad' {
  if (provider.usable) return 'good';
  if (provider.installed) return 'warn';
  return 'bad';
}

function toneClasses(tone: 'good' | 'warn' | 'bad') {
  if (tone === 'good') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  if (tone === 'warn') return 'border-amber-500/30 bg-amber-500/10 text-amber-100';
  return 'border-rose-500/30 bg-rose-500/10 text-rose-100';
}

function prettifyCapability(value?: string | null) {
  if (!value) return '—';
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function copyText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Ignore clipboard failures
  }
}

/* ─── Tab Fallback ──────────────────────────────────────── */

function TabFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 size={32} className="text-slate-400 animate-spin" />
    </div>
  );
}

/* ─── Reusable Native Provider UI ───────────────────────── */

function SectionCard({ title, icon: Icon, children, right }: { title: string; icon: typeof Brain; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-white/[0.08] bg-white/[0.04] p-5 md:p-6 shadow-[0_20px_60px_-35px_rgba(0,0,0,0.65)]">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-2xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-slate-200">
            <Icon size={17} />
          </div>
          <div>
            <div className="text-white font-semibold">{title}</div>
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function DetailPill({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      <div className={`text-sm text-slate-200 ${mono ? 'font-mono break-all' : ''}`}>{value}</div>
    </div>
  );
}

function ModelChip({ model }: { model: ProviderModelDescriptor }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 min-w-0">
      <div className="text-sm text-white truncate">{model.alias || model.displayName}</div>
      <div className="text-[11px] text-slate-400 font-mono truncate mt-0.5">{model.id}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-600 mt-1">{model.source || 'declared'}</div>
    </div>
  );
}

function NativeProviderToolsPanel({ provider, activeTab }: { provider: ProviderInfo; activeTab: TabKey }) {
  const [models, setModels] = useState<ProviderModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [permission, setPermission] = useState<NativePermissionLevel>('sandboxed');
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionError, setPermissionError] = useState<string>('');
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setModelsLoading(true);
      try {
        const requests: Promise<any>[] = [gatewayAPI.models(provider.name)];
        if (provider.native) requests.push(client.get('/gateway/native-permissions'));
        const [modelsResp, permissionsResp] = await Promise.all(requests);
        if (cancelled) return;
        setModels(Array.isArray(modelsResp?.models) ? modelsResp.models : []);
        if (provider.native && permissionsResp?.data?.permissions) {
          const next = permissionsResp.data.permissions?.[provider.name];
          if (next === 'sandboxed' || next === 'elevated') setPermission(next);
        }
      } catch (err: any) {
        if (!cancelled) {
          setModels([]);
          setPermissionError(err?.response?.data?.error || err?.message || 'Failed to load provider tooling');
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [provider.name, provider.native, refreshTick]);

  const togglePermission = useCallback(async () => {
    const next: NativePermissionLevel = permission === 'elevated' ? 'sandboxed' : 'elevated';
    setPermissionError('');
    setPermissionLoading(true);
    try {
      await client.put('/gateway/native-permissions', { provider: provider.name, level: next });
      setPermission(next);
    } catch (err: any) {
      setPermissionError(err?.response?.data?.error || err?.message || 'Failed to update permission level');
    } finally {
      setPermissionLoading(false);
    }
  }, [permission, provider.name]);

  const tone = statusTone(provider);
  const capability = provider.capabilities || {};
  const activeTabLabel = TABS.find((tab) => tab.key === activeTab)?.label || 'Tools';
  const supportsPermissionToggle = provider.native && ['CLAUDE_CODE', 'CODEX', 'GEMINI'].includes(provider.name);

  return (
    <div className="h-full overflow-auto p-6 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className={`rounded-3xl border p-6 md:p-7 ${toneClasses(tone)}`}>
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5">
            <div>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-black/20 border border-white/10 flex items-center justify-center text-2xl">
                  {PROVIDER_IDENTITY[provider.name] || '🧩'}
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-white">{provider.displayName}</h2>
                  <p className="text-sm text-slate-200/80 mt-0.5">
                    Native-provider tools panel for {activeTabLabel.toLowerCase()} workflows.
                  </p>
                </div>
              </div>
              <p className="mt-4 text-sm text-slate-200/80 max-w-3xl">
                This provider doesn’t use OpenClaw’s automations/skills/task ledger the same way the gateway does. Instead of blocking the selector,
                this panel surfaces the runtime, auth, model catalog, permissions, and portal-specific guidance you actually need.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <a
                href={`/agent-chats?provider=${encodeURIComponent(provider.name)}`}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-sm border border-white/10 transition-colors"
              >
                <ArrowUpRight size={14} />
                Open Agent Chats
              </a>
              <button
                onClick={() => setRefreshTick((v) => v + 1)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-black/20 hover:bg-black/30 text-white text-sm border border-white/10 transition-colors"
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            </div>
          </div>
        </div>

        {(provider.reason || provider.nativeAuthMessage || permissionError) && (
          <div className="rounded-3xl border border-amber-500/20 bg-amber-500/10 p-5 text-amber-100">
            {provider.reason && <div className="text-sm"><strong className="font-semibold">Runtime:</strong> {provider.reason}</div>}
            {provider.nativeAuthMessage && <div className="text-sm mt-2"><strong className="font-semibold">Auth:</strong> {provider.nativeAuthMessage}</div>}
            {permissionError && <div className="text-sm mt-2"><strong className="font-semibold">Permissions:</strong> {permissionError}</div>}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <SectionCard title="Runtime Status" icon={Bot}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <DetailPill label="Installed" value={capabilityLabel(provider.installed, 'Yes', 'No')} />
              <DetailPill label="Usable" value={capabilityLabel(provider.usable, 'Ready', 'Needs attention')} />
              <DetailPill label="Version" value={provider.version || 'Unknown'} mono />
              <DetailPill label="Command" value={provider.command || 'Not detected'} mono />
              <DetailPill label="Adapter family" value={prettifyCapability(capability.adapterFamily)} />
              <DetailPill label="Adapter key" value={capability.adapterKey || '—'} mono />
            </div>
          </SectionCard>

          <SectionCard title="Capabilities" icon={Sparkles}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <DetailPill label="History" value={capabilityLabel(capability.supportsHistory)} />
              <DetailPill label="Session list" value={capabilityLabel(capability.supportsSessionList)} />
              <DetailPill label="Model selection" value={capabilityLabel(capability.supportsModelSelection)} />
              <DetailPill label="Custom model input" value={capabilityLabel(capability.supportsCustomModelInput)} />
              <DetailPill label="Steering" value={capabilityLabel(capability.supportsInTurnSteering, 'In-turn', 'Not supported')} />
              <DetailPill label="Follow-up mode" value={prettifyCapability(capability.followUpMode)} />
            </div>
          </SectionCard>

          <SectionCard
            title="Native Permissions"
            icon={permission === 'elevated' ? ShieldAlert : Shield}
            right={supportsPermissionToggle ? (
              <button
                onClick={togglePermission}
                disabled={permissionLoading}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm border transition-colors ${permission === 'elevated' ? 'bg-rose-500/15 border-rose-500/30 text-rose-100 hover:bg-rose-500/20' : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-100 hover:bg-emerald-500/20'} ${permissionLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                {permissionLoading ? <Loader2 size={14} className="animate-spin" /> : permission === 'elevated' ? <ShieldAlert size={14} /> : <Shield size={14} />}
                {permission === 'elevated' ? 'Switch to sandboxed' : 'Allow elevated mode'}
              </button>
            ) : undefined}
          >
            <div className="space-y-3">
              <div className={`rounded-2xl border px-4 py-3 ${permission === 'elevated' ? 'border-rose-500/25 bg-rose-500/10 text-rose-100' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'}`}>
                <div className="font-semibold text-sm">Current level: {permission}</div>
                <div className="text-xs mt-1 opacity-90">
                  {permission === 'elevated'
                    ? 'Claude Code can run with broader filesystem reach and auto mode. Use this for trusted coding sessions only.'
                    : 'Sandboxed keeps Claude Code in accept-edits mode with a tighter permission posture.'}
                </div>
              </div>
              <div className="text-xs text-slate-400">
                Stored in portal settings as <span className="font-mono text-slate-300">agents.nativePermission.{provider.name}</span>.
              </div>
            </div>
          </SectionCard>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-6">
          <SectionCard title="Model Catalog" icon={Brain} right={modelsLoading ? <Loader2 size={16} className="animate-spin text-slate-400" /> : <div className="text-xs text-slate-500">{models.length} models</div>}>
            {modelsLoading && models.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 size={14} className="animate-spin" />
                Loading provider model catalog…
              </div>
            ) : models.length ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {models.map((model) => <ModelChip key={model.id} model={model} />)}
              </div>
            ) : (
              <div className="text-sm text-slate-400">No model catalog returned for this provider yet.</div>
            )}
          </SectionCard>

          <SectionCard title="Quick Commands" icon={Terminal}>
            <div className="space-y-3">
              <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Launch</div>
                <div className="font-mono text-sm text-slate-200 break-all">{provider.name === 'CLAUDE_CODE' ? 'claude --model sonnet' : provider.name === 'CODEX' ? 'codex --model gpt-5.4' : `${(provider.command || provider.displayName).toLowerCase()} --help`}</div>
                <button onClick={() => copyText(provider.name === 'CLAUDE_CODE' ? 'claude --model sonnet' : provider.name === 'CODEX' ? 'codex --model gpt-5.4' : `${(provider.command || provider.displayName).toLowerCase()} --help`)} className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
                  <Copy size={12} /> Copy
                </button>
              </div>
              {provider.nativeAuthLoginCommand && (
                <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Login / refresh auth</div>
                  <div className="font-mono text-sm text-slate-200 break-all">{provider.nativeAuthLoginCommand}</div>
                  <button onClick={() => copyText(provider.nativeAuthLoginCommand || '')} className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
                    <Copy size={12} /> Copy
                  </button>
                </div>
              )}
              <div className="text-xs text-slate-400">
                Native providers keep their own CLI auth and session state. The portal is orchestrating them; it is not proxying the actual Anthropic account.
              </div>
            </div>
          </SectionCard>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_1fr] gap-6">
          <SectionCard title="Portal Context for Coding" icon={Link2}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {PORTAL_ROOT_PATHS.map((entry) => (
                <DetailPill key={entry} label="Path" value={entry} mono />
              ))}
              <DetailPill label="Service" value="bridgesllm-product.service" mono />
              <DetailPill label="Portal API" value="http://127.0.0.1:4001" mono />
              <DetailPill label="OpenClaw Gateway" value="http://127.0.0.1:18789" mono />
            </div>
            <div className="mt-4 text-sm text-slate-300/90 space-y-2">
              <div>Use Claude Code sessions from <span className="font-mono text-slate-200">/opt/bridgesllm/portal</span> when you want it to understand the repo layout and existing scripts.</div>
              <div>For portal work, the most common loop is: edit source → <span className="font-mono text-slate-200">backend: npx tsc</span> → <span className="font-mono text-slate-200">frontend: npx tsc --noEmit && npx vite build</span> → restart service.</div>
            </div>
          </SectionCard>

          <SectionCard title="What Works Today" icon={CheckCircle2}>
            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2 text-emerald-200"><CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" /> Session history and resume support</div>
              <div className="flex items-start gap-2 text-emerald-200"><CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" /> Model selection via the provider model picker</div>
              <div className="flex items-start gap-2 text-emerald-200"><CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" /> Native auth + version visibility in the portal</div>
              <div className="flex items-start gap-2 text-emerald-200"><CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" /> Permission level management for trusted coding sessions</div>
              <div className="flex items-start gap-2 text-slate-400"><Clock3 size={16} className="mt-0.5 flex-shrink-0" /> OpenClaw automations / skills tabs remain gateway-native, not Claude-native</div>
              <div className="flex items-start gap-2 text-slate-400"><CircleOff size={16} className="mt-0.5 flex-shrink-0" /> In-turn steering is not available here; follow-ups are queued instead</div>
            </div>
          </SectionCard>
        </div>
      </div>
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
          className="absolute top-full left-0 mt-1.5 w-64 rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden z-50"
        >
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              <Layers size={10} />
              Provider / Agent
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {providers.map((provider) => {
              const providerAgents = agents.filter(agent => (agent.provider || 'OPENCLAW') === provider.name);
              return (
                <div key={provider.name} className="pb-1">
                  <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 border-t border-white/[0.04] first:border-t-0">
                    {provider.displayName}
                  </div>
                  {providerAgents.map((agent) => {
                    const key = makeSelectorKey(agent);
                    const isSelected = key === selected;
                    const disabled = agent.selectable === false;
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
                        title={disabled ? (agent.disabledReason || provider.reason || `${provider.displayName} support unavailable`) : undefined}
                      >
                        <div className="w-6 h-6 rounded-lg bg-white/[0.06] flex items-center justify-center text-sm flex-shrink-0">
                          {getAgentEmoji(agent)}
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                          <div className="truncate">{getAgentLabel(agent, assistantName)}</div>
                          {(agent.disabledReason || provider.reason) && (
                            <div className="truncate text-[10px] text-slate-500 mt-0.5">{agent.disabledReason || provider.reason}</div>
                          )}
                        </div>
                        {typeof agent.model === "string" && agent.model && (
                          <span className="text-[10px] text-slate-600 font-mono truncate max-w-[60px]">
                            {agent.model.split('/').pop()}
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
        const [agentsResp, providersResp] = await Promise.allSettled([
          client.get('/gateway/agents'),
          client.get('/gateway/providers?all=true'),
        ]);
        if (cancelled) return;

        const providerList: ProviderInfo[] = providersResp.status === 'fulfilled' && Array.isArray(providersResp.value.data?.providers)
          ? providersResp.value.data.providers
          : [{ name: 'OPENCLAW', displayName: 'OpenClaw', usable: true, installed: true, implemented: true }];
        setProviders(providerList);

        const openclawAgents: OpenClawAgent[] = agentsResp.status === 'fulfilled' && agentsResp.value.data?.agents?.length
          ? agentsResp.value.data.agents.map((agent: OpenClawAgent) => ({ ...agent, provider: 'OPENCLAW', selectable: true }))
          : [{ id: 'main', provider: 'OPENCLAW', identity: '🤖', selectable: true }];

        const placeholderProviders = providerList
          .filter((provider) => provider.name !== 'OPENCLAW')
          .map((provider) => ({
            id: '__provider__',
            provider: provider.name,
            providerDisplayName: provider.displayName,
            identity: PROVIDER_IDENTITY[provider.name] || '🧩',
            selectable: true,
            disabledReason: undefined,
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

  const selectedProvider = parseProviderAgent(selectedAgent).provider;
  const selectedAgentId = parseProviderAgent(selectedAgent).agentId;

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
  }, [activeTab, searchParams, selectedAgent, selectedAgentId, selectedProvider, setSearchParams]);

  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
  }, []);

  const handleAgentSelect = useCallback((agentKey: string) => {
    setSelectedAgent(agentKey);
  }, []);

  const selectedProviderInfo = providers.find((p) => p.name === selectedProvider);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#0A0E27]">
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-4 border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-white">Agent Tools</h1>
              <p className="text-slate-400 text-sm mt-0.5">Automations, usage stats, skills, and native provider controls</p>
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

      <div className="flex-1 overflow-hidden">
        {selectedProvider !== 'OPENCLAW' ? (
          selectedProviderInfo ? (
            <NativeProviderToolsPanel provider={selectedProviderInfo} activeTab={activeTab} />
          ) : (
            <div className="h-full flex items-center justify-center p-6">
              <div className="rounded-3xl border border-white/[0.08] bg-white/[0.04] px-6 py-5 text-slate-300 flex items-center gap-3">
                <Loader2 size={18} className="animate-spin text-slate-400" />
                Loading {selectedProvider} tooling…
              </div>
            </div>
          )
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
