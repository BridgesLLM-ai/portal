/**
 * ChatInterface — iMessage-style chat with per-agent contacts.
 *
 * Pass 2 fixes:
 * 1. Real-time message rendering — replaced broken counter-based
 *    ThreadPrimitive.Messages with direct messages.map() rendering
 * 2. Smart scroll-to-bottom button (only shown when scrolled up)
 * 3. Dictation / Speech-to-text button
 * 4. File attachment button with chip previews
 * 5. Thinking display with elapsed timer
 * 6. Tool use as centered iMessage-style system notification pills
 */
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
} from '@assistant-ui/react';
import { useAgentRuntime, type ChatMessage, type ToolCall, type ExecApprovalRequest } from './useAgentRuntime';
import { useChatState } from '../../contexts/ChatStateProvider';
import { useExecApprovals } from './useExecApprovals';
import { ExecApprovalModal } from './ExecApprovalModal';
import MarkdownRenderer from './MarkdownRenderer';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Send, StopCircle, Pencil, Settings, X, ChevronDown,
  Check, RefreshCw, Wrench, Loader2, CheckCircle2, XCircle, ShieldAlert, Radio,
  Sparkles, Copy, RotateCcw, MessageSquare, Code2, Bug, ChevronRight, Clock,
  Paperclip, Mic, PenSquare, ListChecks, Layers3, TerminalSquare, Slash, Settings2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import AgentSelector, { type AgentSelection } from './AgentSelector';
import ImagePickerCropper from '../ImagePickerCropper';
import AiProviderSetup from '../ai-setup/AiProviderSetup';
import { useAuthStore } from '../../contexts/AuthContext';
import { isElevated, isOwner } from '../../utils/authz';
import { agentToolsAPI, AgentTool } from '../../api/agentTools';
import { gatewayAPI } from '../../api/endpoints';
import SlashCommandMenu from './SlashCommandMenu';
import { matchSlashCommands, parseSlashCommand, type SlashCommand } from '../../utils/slashCommands';
import { executeSlashCommand } from '../../utils/slashCommandExecutor';
import client from '../../api/client';
import sounds from '../../utils/sounds';

/* ─── Per-agent identity ────────────────────────────────────────────────── */

interface AgentIdentity {
  name: string;
  initials: string;
  providerName: string;
  color: string;
  bgLight: string;
  borderColor: string;
  avatarBg: string;
  avatarText: string;
  accentRing: string;
  sendBg: string;
  sendHover: string;
  sendShadow: string;
  provenance: string;
}

const AGENTS: AgentIdentity[] = [
  {
    name: 'OpenClaw',
    initials: 'OC',
    providerName: 'OPENCLAW',
    color: 'text-emerald-400',
    bgLight: 'bg-emerald-500/[0.06]',
    borderColor: 'border-emerald-500/15',
    avatarBg: 'bg-emerald-600/20',
    avatarText: 'text-emerald-300',
    accentRing: 'focus:ring-emerald-500/40 focus:border-emerald-500/30',
    sendBg: 'bg-emerald-500',
    sendHover: 'hover:bg-emerald-600',
    sendShadow: 'shadow-emerald-500/20',
    provenance: 'via OpenClaw',
  },
  {
    name: 'Claude',
    initials: 'CL',
    providerName: 'CLAUDE_CODE',
    color: 'text-violet-400',
    bgLight: 'bg-violet-500/[0.06]',
    borderColor: 'border-violet-500/15',
    avatarBg: 'bg-violet-600/20',
    avatarText: 'text-violet-300',
    accentRing: 'focus:ring-violet-500/40 focus:border-violet-500/30',
    sendBg: 'bg-violet-500',
    sendHover: 'hover:bg-violet-600',
    sendShadow: 'shadow-violet-500/20',
    provenance: 'via Claude CLI',
  },
  {
    name: 'Codex',
    initials: 'CX',
    providerName: 'CODEX',
    color: 'text-sky-400',
    bgLight: 'bg-sky-500/[0.06]',
    borderColor: 'border-sky-500/15',
    avatarBg: 'bg-sky-600/20',
    avatarText: 'text-sky-300',
    accentRing: 'focus:ring-sky-500/40 focus:border-sky-500/30',
    sendBg: 'bg-sky-500',
    sendHover: 'hover:bg-sky-600',
    sendShadow: 'shadow-sky-500/20',
    provenance: 'via Codex CLI',
  },
  {
    name: 'Agent Zero',
    initials: 'A0',
    providerName: 'AGENT_ZERO',
    color: 'text-amber-400',
    bgLight: 'bg-amber-500/[0.06]',
    borderColor: 'border-amber-500/15',
    avatarBg: 'bg-amber-600/20',
    avatarText: 'text-amber-300',
    accentRing: 'focus:ring-amber-500/40 focus:border-amber-500/30',
    sendBg: 'bg-amber-500',
    sendHover: 'hover:bg-amber-600',
    sendShadow: 'shadow-amber-500/20',
    provenance: 'via Agent Zero',
  },
  {
    name: 'Gemini',
    initials: 'GM',
    providerName: 'GEMINI',
    color: 'text-cyan-400',
    bgLight: 'bg-cyan-500/[0.06]',
    borderColor: 'border-cyan-500/15',
    avatarBg: 'bg-cyan-600/20',
    avatarText: 'text-cyan-300',
    accentRing: 'focus:ring-cyan-500/40 focus:border-cyan-500/30',
    sendBg: 'bg-cyan-500',
    sendHover: 'hover:bg-cyan-600',
    sendShadow: 'shadow-cyan-500/20',
    provenance: 'via Gemini CLI',
  },
  {
    name: 'Ollama',
    initials: 'OL',
    providerName: 'OLLAMA',
    color: 'text-rose-400',
    bgLight: 'bg-rose-500/[0.06]',
    borderColor: 'border-rose-500/15',
    avatarBg: 'bg-rose-600/20',
    avatarText: 'text-rose-300',
    accentRing: 'focus:ring-rose-500/40 focus:border-rose-500/30',
    sendBg: 'bg-rose-500',
    sendHover: 'hover:bg-rose-600',
    sendShadow: 'shadow-rose-500/20',
    provenance: 'via Ollama',
  },
];

function getAgent(providerName: string): AgentIdentity {
  return AGENTS.find((a) => a.providerName === providerName) || AGENTS[0];
}

/* ─── Provider model catalogs ───────────────────────────────────────────── */

const OPENCLAW_MODEL_FALLBACK = [
  'anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-5',
  'anthropic/claude-haiku-4-5', 'anthropic/claude-opus-4-5',
  'google/gemini-2.5-flash', 'google/gemini-2.5-pro',
  'openai-codex/gpt-5.1', 'openai-codex/gpt-5.2', 'openai-codex/gpt-5.3-codex', 'openai-codex/gpt-5.4',
  'openrouter/moonshotai/kimi-k2', 'openrouter/moonshotai/kimi-k2.5',
  'openrouter/deepseek/deepseek-v3.2', 'openrouter/meta-llama/llama-4-maverick',
];

// Display-friendly names for full model IDs (strips provider prefix)
function modelDisplayName(modelId: string): string {
  // Strip provider prefix for display
  const parts = modelId.split('/');
  if (parts.length >= 3) return parts.slice(1).join('/'); // openrouter/deepseek/v3.2 → deepseek/v3.2
  if (parts.length === 2) return parts[1]; // anthropic/claude-opus-4-6 → claude-opus-4-6
  return modelId;
}

const MODEL_STORAGE_PREFIX = 'agentChats.lastModel.';

const providerModelsCache = new Map<string, {
  models: string[];
  capabilities?: {
    supportsModelSelection?: boolean;
    modelSelectionMode?: string;
    supportsCustomModelInput?: boolean;
    canEnumerateModels?: boolean;
    modelCatalogKind?: string;
  };
}>();

const providerCommandsCache = new Map<string, {
  slashCommands: SlashCommandInfo[];
  capabilities?: ProviderCapabilities;
}>();

interface ProviderCapabilities {
  implemented?: boolean;
  requiresGateway?: boolean;
  adapterFamily?: string;
  adapterKey?: string;
  supportsHistory?: boolean;
  supportsModelSelection?: boolean;
  modelSelectionMode?: string;
  supportsCustomModelInput?: boolean;
  canEnumerateModels?: boolean;
  supportsSessionList?: boolean;
  supportsExecApproval?: boolean;
  modelCatalogKind?: string;
  supportsInTurnSteering?: boolean;
  supportsQueuedFollowUps?: boolean;
  followUpMode?: 'in_turn_inject' | 'queued_follow_up' | string;
}

/* ─── Model Picker Dropdown ─────────────────────────────────────────────── */

/** Mobile-safe dropdown: portal bottom-sheet on mobile, absolute on desktop */
function ModelPickerDropdown({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (!open) return null;

  if (isMobile) {
    return createPortal(
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 z-[9998]"
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, y: 100 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 100 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-0 z-[9999] px-3 pb-3"
        >
          <div className="rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden max-h-[70vh]">
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-white/[0.06]">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Select Model</span>
              <button onClick={onClose} className="p-1 rounded-lg text-slate-500 hover:text-slate-300">
                <X size={14} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-[60vh] overscroll-contain">
              {children}
            </div>
          </div>
        </motion.div>
      </>,
      document.body,
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="absolute top-full right-0 mt-1 w-64 rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-xl shadow-black/40 z-[100]"
    >
      {children}
    </motion.div>
  );
}


function capabilityPillTone(tone: 'violet' | 'sky' | 'emerald' | 'amber' | 'slate' = 'slate') {
  switch (tone) {
    case 'violet': return 'border-violet-500/20 bg-violet-500/10 text-violet-200';
    case 'sky': return 'border-sky-500/20 bg-sky-500/10 text-sky-200';
    case 'emerald': return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200';
    case 'amber': return 'border-amber-500/20 bg-amber-500/10 text-amber-200';
    default: return 'border-white/[0.08] bg-white/[0.04] text-slate-300';
  }
}

function buildProviderCapabilityPills(params: {
  commandCount: number;
  capabilities?: ProviderCapabilities;
  availableModels: string[];
}) {
  const { commandCount, capabilities, availableModels } = params;
  const pills: Array<{ icon: React.ReactNode; label: string; tone?: 'violet' | 'sky' | 'emerald' | 'amber' | 'slate' }> = [];

  pills.push({ icon: <Slash size={11} />, label: `${commandCount} slash command${commandCount === 1 ? '' : 's'}`, tone: commandCount > 0 ? 'emerald' : 'amber' });

  if (capabilities?.supportsModelSelection) {
    const mode = capabilities.modelSelectionMode === 'launch' ? 'per chat' : capabilities.modelSelectionMode === 'session' ? 'live session' : 'manual';
    pills.push({ icon: <Code2 size={11} />, label: `Model switching: ${mode}`, tone: 'violet' });
  }

  if (capabilities?.canEnumerateModels || availableModels.length > 0) {
    const source = capabilities?.modelCatalogKind === 'declared' ? 'declared catalog' : 'live catalog';
    pills.push({ icon: <Layers3 size={11} />, label: `${source}${availableModels.length > 0 ? ` (${availableModels.length})` : ''}`, tone: 'sky' });
  } else if (capabilities?.supportsCustomModelInput !== false) {
    pills.push({ icon: <TerminalSquare size={11} />, label: 'Manual model entry', tone: 'amber' });
  }

  pills.push({ icon: <ListChecks size={11} />, label: capabilities?.supportsSessionList ? 'Session list available' : 'No session list', tone: capabilities?.supportsSessionList ? 'sky' : 'slate' });

  if (capabilities?.supportsInTurnSteering) {
    pills.push({ icon: <MessageSquare size={11} />, label: 'Live FYI / steer while running', tone: 'emerald' });
  } else if (capabilities?.supportsQueuedFollowUps !== false) {
    pills.push({ icon: <Clock size={11} />, label: 'Queued follow-ups while running', tone: 'amber' });
  }

  if (capabilities?.supportsExecApproval) {
    pills.push({ icon: <ShieldAlert size={11} />, label: 'Exec approvals supported', tone: 'amber' });
  }

  pills.push({ icon: <Radio size={11} />, label: capabilities?.requiresGateway ? 'Gateway transport' : 'Native CLI transport', tone: capabilities?.requiresGateway ? 'sky' : 'slate' });

  return pills;
}

function ModelPicker({
  provider,
  value,
  onChange,
  models,
  supportsCustomModelInput = true,
  modelCatalogKind = 'dynamic',
  disabled = false,
}: {
  provider: string;
  value: string;
  onChange: (model: string) => void;
  models: string[];
  supportsCustomModelInput?: boolean;
  modelCatalogKind?: 'none' | 'declared' | 'dynamic';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const isCustomOnlyCatalog = modelCatalogKind === 'none' && models.length === 0;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 639px)').matches;
    if (isMobile) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (models.length === 0 && !supportsCustomModelInput) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { if (!disabled) setOpen(!open); }}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border text-[11px] transition-colors ${disabled ? 'bg-white/[0.03] border-white/[0.05] text-slate-500 cursor-not-allowed opacity-60' : 'bg-white/[0.06] hover:bg-white/[0.10] border-white/[0.08] text-slate-400 hover:text-slate-200'}`}
        title={disabled ? 'Finish or abort the current response before switching models' : (value || 'Default model')}
      >
        {/* Icon-only on mobile, text on desktop */}
        <Code2 size={13} className="sm:hidden flex-shrink-0" />
        <span className="hidden sm:inline truncate max-w-[120px]">{value ? modelDisplayName(value) : 'Default model'}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''} hidden sm:block`} />
      </button>
      <ModelPickerDropdown open={open} onClose={() => { setOpen(false); setCustom(false); }}>
        <div className="p-1 max-h-80 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          {isCustomOnlyCatalog && (
            <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-white/[0.06]">
              This provider does not publish a model catalog here. Enter the exact model ID manually.
            </div>
          )}
          <button
            onClick={() => { onChange(''); setCustom(false); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${
              !value ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'
            }`}
          >
            <span className="flex-1 text-left">Default</span>
            {!value && <Check size={12} className="text-violet-400" />}
          </button>
          {models.map((m) => (
            <button
              key={m}
              onClick={() => { onChange(m); setCustom(false); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${
                value === m ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'
              }`}
            >
              <span className="flex-1 text-left font-mono">{modelDisplayName(m)}</span>
              {value === m && <Check size={12} className="text-violet-400" />}
            </button>
          ))}
          {supportsCustomModelInput && (
          <div className="border-t border-white/[0.06] mt-1 pt-1">
            {custom ? (
              <div className="px-2 py-1">
                <input
                  autoFocus
                  className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40"
                  placeholder="Custom model name"
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpen(false); }}
                />
              </div>
            ) : (
              <button
                onClick={() => setCustom(true)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              >
                Custom model…
              </button>
            )}
          </div>
          )}
        </div>
      </ModelPickerDropdown>
    </div>
  );
}

/* ─── Agent Tools Settings Drawer (sessions panel moved to AgentSelector) ── */

// GatewaySession interface still needed by handleViewGatewaySession
interface GatewaySession {
  key?: string;
  id?: string;
  sessionId?: string;
  status?: string;
  lastActivityAt?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  agent?: string;
  channel?: string;
  title?: string;
  preview?: string;
  isMainSession?: boolean;
}

function GatewaySessionsPanel({ onViewSession }: { onViewSession: (sessionKey: string) => void }) {
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const initialLoadDone = useRef(false);

  const fetchSessions = useCallback(async () => {
    if (!initialLoadDone.current) setLoading(true);
    try {
      const { data } = await client.get('/gateway/sessions');
      const list = data.sessions || [];
      setSessions(Array.isArray(list) ? list : Object.values(list));
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 30000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const getSessionKey = (s: GatewaySession) => s.key || s.sessionId || s.id || '';

  const formatTime = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      return `${Math.floor(diffHr / 24)}d ago`;
    } catch { return ''; }
  };

  const getSessionLabel = (s: GatewaySession) => {
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (title) return title;

    const preview = typeof s.preview === 'string' ? s.preview.trim() : '';
    if (preview && preview.length <= 72) return preview;

    const key = getSessionKey(s);
    if (!key) return 'Unknown';

    const parts = key.split(':');
    const agentName = parts[1] || 'main';
    const sessionName = parts[parts.length - 1] || 'main';
    const normalizedName = sessionName
      .replace(/^portal-[a-f0-9]{8}-/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();

    if (sessionName === 'main') {
      return agentName === 'main' ? 'Main session' : `${agentName} / main session`;
    }

    if (normalizedName && !/^[a-f0-9-]{24,}$/i.test(normalizedName)) {
      return agentName === 'main' ? normalizedName : `${agentName} / ${normalizedName}`;
    }

    return agentName === 'main'
      ? `Session ${sessionName.slice(0, 8)}`
      : `${agentName} / ${sessionName.slice(0, 8)}`;
  };

  return (
    <div className="px-3 pb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full px-2 py-1.5 group"
      >
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
          <Radio size={10} className="text-emerald-400" />
          Gateway Sessions
        </span>
        <div className="flex items-center gap-1">
          {sessions.length > 0 && (
            <span className="text-[9px] bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded-full font-medium">
              {sessions.length}
            </span>
          )}
          <ChevronDown size={12} className={`text-slate-500 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            {loading ? (
              <div className="flex items-center justify-center py-4 text-slate-500 text-xs">
                <Loader2 size={12} className="animate-spin mr-1.5" />
                Loading…
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-3 text-slate-600 text-[11px]">
                No active gateway sessions
              </div>
            ) : (
              <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
                {sessions.map((s, idx) => {
                  const key = getSessionKey(s);
                  return (
                    <button
                      key={key || idx}
                      onClick={() => onViewSession(key)}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-xs text-slate-400 hover:text-slate-200 hover:bg-white/[0.03] transition-all"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        s.status === 'active' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium text-[11px]">{getSessionLabel(s)}</div>
                        <div className="text-[10px] text-slate-500/70 mt-0.5 flex items-center gap-1">
                          {s.channel && <span>{s.channel}</span>}
                          {(s.channel && (s.lastActivityAt || s.createdAt)) && <span>·</span>}
                          <span>{formatTime(s.lastActivityAt || s.createdAt)}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Session Controls (real OpenClaw thinking + portal fast-model override) ───────────────────── */

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'];
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  adaptive: 'Adaptive',
};

interface SessionControlsProps {
  thinkingLevel: ThinkingLevel;
  fastModeEnabled: boolean;
  fastModeModel: string;
  compactionModelOverride: string;
  onSetThinkingLevel: (level: ThinkingLevel) => void;
  onToggleFastMode: () => void;
  onSetFastModeModel: (model: string) => void;
  onSetCompactionModelOverride: (model: string) => void;
  providerLabel: string;
  providerCommandCount: number;
  providerCommandStatus: string;
  providerCapabilities?: {
    requiresGateway?: boolean;
    supportsHistory?: boolean;
    supportsModelSelection?: boolean;
    modelSelectionMode?: string;
    supportsCustomModelInput?: boolean;
    canEnumerateModels?: boolean;
    supportsSessionList?: boolean;
    supportsExecApproval?: boolean;
    modelCatalogKind?: string;
  };
  availableModels: string[];
  compactionAvailableModels?: string[];
  compactionModelLoading?: boolean;
  compactionModelError?: string | null;
  compactionModelOptionsLoading?: boolean;
  sessionControlsSupported: boolean;
  onPanelOpen?: () => void;
  disabled?: boolean;
  currentModel?: string;
  sessionKey?: string;
}

function SessionControls({
  thinkingLevel,
  fastModeEnabled,
  fastModeModel,
  compactionModelOverride,
  onSetThinkingLevel,
  onToggleFastMode,
  onSetFastModeModel,
  onSetCompactionModelOverride,
  providerLabel,
  providerCommandCount,
  providerCommandStatus,
  providerCapabilities,
  availableModels,
  compactionAvailableModels = [],
  compactionModelLoading = false,
  compactionModelError = null,
  compactionModelOptionsLoading = false,
  sessionControlsSupported,
  onPanelOpen,
  disabled,
  currentModel,
  sessionKey,
}: SessionControlsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [providerInfoOpen, setProviderInfoOpen] = useState(false);
  const [localThinking, setLocalThinking] = useState(thinkingLevel);
  const localThinkingRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Sync local thinking with prop when it changes (e.g., after API confirms)
  useEffect(() => { setLocalThinking(thinkingLevel); }, [thinkingLevel]);
  const providerPills = buildProviderCapabilityPills({
    commandCount: providerCommandCount,
    capabilities: providerCapabilities,
    availableModels,
  });
  const effectiveCompactionModels = Array.from(new Set([
    ...compactionAvailableModels,
    ...(compactionModelOverride && !compactionAvailableModels.includes(compactionModelOverride) ? [compactionModelOverride] : []),
  ]));
  const currentModelLower = String(currentModel || '').toLowerCase();
  const adaptiveSupported = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(currentModelLower);
  const visibleThinkingLevels = THINKING_LEVELS.filter((level) => level !== 'adaptive' || adaptiveSupported || thinkingLevel === 'adaptive');
  const effectiveThinking = (!adaptiveSupported && localThinking === 'adaptive') ? 'medium' : localThinking;
  const thinkingIndex = Math.max(0, visibleThinkingLevels.indexOf(effectiveThinking));

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Extract short model name for display
  const shortModel = currentModel?.split('/').pop() || 'default';

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => {
          if (!isOpen) onPanelOpen?.();
          setIsOpen(!isOpen);
        }}
        disabled={disabled}
        className={`p-1.5 rounded-lg transition-colors ${
          (thinkingLevel !== 'off') || fastModeEnabled
            ? 'text-emerald-400 bg-emerald-500/[0.12] hover:bg-emerald-500/[0.2]'
            : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
        } disabled:opacity-50`}
        title="Session Controls"
      >
        <Settings2 size={16} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-white/[0.08] bg-[#0D1130] shadow-xl z-50 overflow-hidden"
          >
            <div className="px-3 py-2.5 border-b border-white/[0.06]">
              <div className="text-xs font-medium text-white">Session Controls</div>
              <div className="text-[10px] text-slate-500 mt-0.5 font-mono truncate">
                {sessionKey ? sessionKey.split(':').slice(-1)[0] : 'No session'}
              </div>
            </div>

            <div className="p-2.5 space-y-2">
              <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                <div className="flex items-center gap-2">
                  <Sparkles size={14} className={localThinking !== 'off' ? 'text-violet-400' : 'text-slate-500'} />
                  <div>
                    <div className="text-xs font-medium text-white">Thinking Level</div>
                    <div className="text-[10px] text-slate-500">Controls reasoning depth. Adaptive is only shown for supported Claude/Opus-style models.</div>
                  </div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={visibleThinkingLevels.length - 1}
                  step={1}
                  value={Math.max(0, thinkingIndex)}
                  disabled={disabled || !sessionControlsSupported}
                  onChange={(e) => {
                    // Update visual position immediately (local state via parent)
                    const idx = Number(e.target.value);
                    const next = visibleThinkingLevels[idx] || 'off';
                    if (localThinkingRef.current) clearTimeout(localThinkingRef.current);
                    localThinkingRef.current = window.setTimeout(() => {
                      onSetThinkingLevel(next);
                    }, 400);
                    // Optimistic visual update without API call
                    setLocalThinking(next);
                  }}
                  className="w-full accent-violet-400"
                />
                <div className="text-[10px] text-slate-400">
                  Current: <span className={`font-semibold uppercase ${localThinking === 'adaptive' ? 'text-cyan-300' : 'text-violet-300'}`}>{THINKING_LEVEL_LABELS[localThinking] || localThinking}</span>
                  {localThinking === 'adaptive' && adaptiveSupported && (
                    <span className="ml-1 text-[9px] text-cyan-400/70">(provider-managed budget)</span>
                  )}
                  {localThinking === 'adaptive' && !adaptiveSupported && (
                    <span className="ml-1 text-[9px] text-amber-400/80">(unsupported for current model)</span>
                  )}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Radio size={14} className={fastModeEnabled ? 'text-amber-400' : 'text-slate-500'} />
                    <div>
                      <div className="text-xs font-medium text-white">Quick-Reply Model</div>
                      <div className="text-[10px] text-slate-500">Enable to run this session on the selected faster model.</div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      onToggleFastMode();
                    }}
                    disabled={disabled || !sessionControlsSupported}
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      fastModeEnabled ? 'bg-amber-500' : 'bg-white/[0.12]'
                    } disabled:opacity-50`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        fastModeEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                <select
                  value={fastModeModel}
                  onChange={(e) => onSetFastModeModel(e.target.value)}
                  disabled={disabled || !sessionControlsSupported || availableModels.length === 0}
                  className="w-full rounded-lg border border-white/[0.08] bg-[#141A43] px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                >
                  {availableModels.map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {modelDisplayName(modelId)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                <div className="flex items-center gap-2">
                  <Layers3 size={14} className={compactionModelOverride ? 'text-sky-400' : 'text-slate-500'} />
                  <div>
                    <div className="text-xs font-medium text-white">Compaction Model</div>
                    <div className="text-[10px] text-slate-500">Model used for context compaction (cheaper = lower cost)</div>
                  </div>
                </div>
                <select
                  value={compactionModelOverride}
                  onChange={(e) => onSetCompactionModelOverride(e.target.value)}
                  disabled={disabled || compactionModelLoading || compactionModelOptionsLoading || effectiveCompactionModels.length === 0}
                  className="w-full rounded-lg border border-white/[0.08] bg-[#141A43] px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                >
                  <option value="">{compactionModelOptionsLoading ? 'Loading models…' : 'Default'}</option>
                  {effectiveCompactionModels.map((modelId) => (
                    <option key={`compaction-${modelId}`} value={modelId}>
                      {modelDisplayName(modelId)}
                    </option>
                  ))}
                </select>
                {compactionModelError && (
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-200">
                    {compactionModelError}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-white/[0.06] space-y-1">
                <div className="text-[10px] text-slate-500">
                  Model: <span className="text-slate-400 font-mono">{shortModel}</span>
                </div>
                <div className="text-[10px] text-slate-600 leading-relaxed">
                  {!sessionControlsSupported ? 'Thinking and quick-reply controls activate once a concrete OpenClaw session is selected.' : 'Quick-reply override is a portal behavior, not a native provider mode.'}
                </div>
              </div>

              <div className="pt-2 border-t border-white/[0.06]">
                <button
                  onClick={() => setProviderInfoOpen((prev) => !prev)}
                  className="w-full flex items-center justify-between text-left rounded-lg px-2 py-1.5 hover:bg-white/[0.03] transition-colors"
                >
                  <div>
                    <div className="text-xs font-medium text-white">Provider Info</div>
                    <div className="text-[10px] text-slate-500">{providerLabel} runtime capabilities</div>
                  </div>
                  <ChevronDown size={13} className={`text-slate-400 transition-transform ${providerInfoOpen ? 'rotate-180' : ''}`} />
                </button>
                <AnimatePresence initial={false}>
                  {providerInfoOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-2 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Commands</div>
                            <div className="mt-1 text-sm font-semibold text-white">{providerCommandCount}</div>
                            <div className="text-[10px] text-slate-500 mt-1">{providerCommandStatus}</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Models</div>
                            <div className="mt-1 text-sm font-semibold text-white">{availableModels.length || '—'}</div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {providerPills.map((pill, idx) => (
                            <span
                              key={`${pill.label}-${idx}`}
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${capabilityPillTone(pill.tone)}`}
                              title={`${providerLabel}: ${pill.label}`}
                            >
                              {pill.icon}
                              <span>{pill.label}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Agent Settings Drawer (providers + tools) ───────────────────────── */

function AgentSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, 'running' | 'success' | 'error'>>({});

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    try {
      const data = await agentToolsAPI.list();
      setTools(data.tools || []);
    } catch {
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadTools();
  }, [open, loadTools]);

  const handleInstall = async (toolId: string) => {
    if (!isAdmin) return;
    setInstalling(toolId);
    setInstallStatus((prev) => ({ ...prev, [toolId]: 'running' }));
    try {
      await agentToolsAPI.install(toolId);
      setInstallStatus((prev) => ({ ...prev, [toolId]: 'success' }));
      loadTools();
    } catch {
      setInstallStatus((prev) => ({ ...prev, [toolId]: 'error' }));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-[2px] z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-[360px] max-w-[90vw] bg-slate-900 border-l border-slate-700/50 z-50 flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
              <h2 className="text-sm font-semibold text-white">Settings</h2>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
              {!isAdmin && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-amber-200 text-xs flex items-center gap-2">
                  <ShieldAlert size={14} />
                  Admin access required.
                </div>
              )}

              {/* ─── AI Providers ─── */}
              {isAdmin && (
                <AiProviderSetup mode="settings" apiBase="/ai-setup" compact />
              )}

              {/* ─── Coding Tools (collapsed) ─── */}
              <details className="group">
                <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider hover:text-slate-400 transition-colors select-none">
                  <Wrench className="h-3 w-3" />
                  Coding Tools
                </summary>
                <div className="mt-3 space-y-1.5">
                  {toolsLoading ? (
                    <div className="flex items-center justify-center py-3">
                      <Loader2 size={14} className="animate-spin text-slate-600" />
                    </div>
                  ) : (
                    <>
                      {tools.map((tool) => {
                        const installed = tool.status?.installed;
                        const status = installStatus[tool.id];
                        return (
                          <div key={tool.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-white truncate">{tool.name}</span>
                                {installed ? (
                                  <CheckCircle2 size={10} className="shrink-0 text-emerald-400" />
                                ) : null}
                              </div>
                              {installed && tool.status.version && (
                                <div className="text-[10px] text-slate-500 font-mono mt-0.5">v{tool.status.version}</div>
                              )}
                            </div>
                            {isAdmin && tool.install.length > 0 && (
                              <button
                                onClick={() => handleInstall(tool.id)}
                                disabled={installing === tool.id}
                                className="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-50 transition-colors"
                              >
                                {status === 'running' ? (
                                  <Loader2 size={10} className="animate-spin" />
                                ) : (
                                  installed ? 'Update' : 'Install'
                                )}
                              </button>
                            )}
                          </div>
                        );
                      })}
                      <button
                        onClick={loadTools}
                        className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-slate-800 px-2 py-1.5 text-[10px] text-slate-500 hover:text-slate-300 hover:border-slate-700 transition-colors"
                      >
                        <RefreshCw size={10} /> Refresh
                      </button>
                    </>
                  )}
                </div>
              </details>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ─── Fix #5: Thinking Block with elapsed timer ─────────────────────────── */

function ThinkingBlock({ content, isActive, activeLabel }: { content?: string; isActive: boolean; activeLabel?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isActive) {
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current !== null) {
          setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      startTimeRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive]);

  if (!isActive && !content) return null;

  // Allow expansion when there's content (even during streaming)
  const canExpand = !!content;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="mb-3"
    >
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        className={`flex items-center gap-2.5 px-4 py-2 rounded-xl bg-violet-500/[0.08] border border-violet-500/[0.15] transition-colors w-full text-left ${canExpand ? 'hover:bg-violet-500/[0.12] cursor-pointer' : 'cursor-default'}`}
      >
        <div className={isActive ? 'animate-thinking-pulse' : ''}>
          <Sparkles size={14} className="text-violet-400" />
        </div>
        <span className="text-xs text-violet-300 font-medium flex-1">
          {isActive ? (activeLabel || 'Thinking…') : 'Thought process'}
        </span>
        {isActive && (
          <>
            <span className="text-[11px] text-violet-400/60 font-mono tabular-nums">
              {elapsedSeconds}s
            </span>
            {!expanded && (
              <span className="flex gap-0.5 ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </>
        )}
        {canExpand && (
          <ChevronRight size={12} className={`text-violet-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        )}
      </button>
      <AnimatePresence>
        {expanded && content && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="mt-1 px-3 py-2.5 rounded-lg bg-violet-500/[0.04] border border-violet-500/[0.08] text-[11px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] max-w-full min-w-0 max-h-[200px] overflow-auto">
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ─── Fix #6: Tool Call as centered iMessage system notification pill ───── */

/** Build a human-readable summary of what a tool call is doing */
function getToolSummary(tool: ToolCall): string {
  const args = tool.arguments;
  if (!args) return tool.name;

  const name = tool.name.toLowerCase();

  // File operations
  if (name === 'read' || name === 'read_file') {
    const p = args.path || args.file_path || args.filePath;
    if (p) {
      const short = String(p).split('/').slice(-2).join('/');
      return `Read ${short}`;
    }
  }
  if (name === 'write' || name === 'write_file') {
    const p = args.path || args.file_path || args.filePath;
    if (p) {
      const short = String(p).split('/').slice(-2).join('/');
      return `Write ${short}`;
    }
  }
  if (name === 'edit' || name === 'edit_file') {
    const p = args.path || args.file_path || args.filePath;
    if (p) {
      const short = String(p).split('/').slice(-2).join('/');
      return `Edit ${short}`;
    }
  }

  // Shell
  if (name === 'exec' || name === 'execute' || name === 'bash' || name === 'shell') {
    const cmd = args.command || args.cmd;
    if (cmd) {
      const short = String(cmd).length > 60 ? String(cmd).substring(0, 57) + '…' : String(cmd);
      return `Run \`${short}\``;
    }
  }

  // Search
  if (name === 'web_search' || name === 'search') {
    const q = args.query;
    if (q) return `Search "${String(q).substring(0, 50)}"`;
  }
  if (name === 'web_fetch' || name === 'fetch') {
    const u = args.url;
    if (u) {
      try { return `Fetch ${new URL(String(u)).hostname}`; } catch { return `Fetch URL`; }
    }
  }

  // Memory
  if (name === 'memory_search') {
    const q = args.query;
    if (q) return `Search memory: "${String(q).substring(0, 40)}"`;
  }
  if (name === 'memory_get') {
    const p = args.path;
    if (p) return `Read memory: ${String(p).split('/').pop()}`;
  }

  // Browser
  if (name === 'browser') {
    const a = args.action;
    if (a) return `Browser: ${a}`;
  }

  // Image analysis
  if (name === 'image') {
    return 'Analyze image';
  }

  // Sessions / sub-agents
  if (name === 'sessions_spawn') {
    const agent = args.agentId;
    return agent ? `Spawn ${agent}` : 'Spawn sub-agent';
  }
  if (name === 'sessions_send') {
    return 'Message sub-agent';
  }

  // TTS
  if (name === 'tts') return 'Generate speech';

  // Message
  if (name === 'message') {
    const a = args.action;
    return a ? `Message: ${a}` : 'Send message';
  }

  // Fallback: tool name
  return tool.name;
}

function ToolCallBlock({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const duration = tool.endedAt ? ((tool.endedAt - tool.startedAt) / 1000).toFixed(1) : null;
  const hasDetails = !!(tool.result || tool.arguments);
  const summary = getToolSummary(tool);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-4 py-1"
    >
      <div className="flex flex-col items-center max-w-md w-full">
        <button
          onClick={() => hasDetails && setExpanded(!expanded)}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.07] transition-colors text-[11px] text-slate-400"
        >
          {tool.status === 'running' ? (
            <Loader2 size={11} className="text-amber-400 animate-spin" />
          ) : (
            <Wrench size={11} className="text-emerald-400" />
          )}
          <span className="text-slate-300">
            {summary}
          </span>
          {duration && (
            <span className="text-slate-600">· {duration}s</span>
          )}
          {hasDetails && (
            <ChevronRight size={10} className={`text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          )}
        </button>
        <AnimatePresence>
          {expanded && hasDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden w-full"
            >
              {tool.arguments && (
                <div className="mt-1.5 px-3 py-2 rounded-xl bg-slate-800/40 border border-white/[0.04] text-[11px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[120px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[10px] block mb-1">Arguments:</span>
                  {typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}
                </div>
              )}
              {tool.result && (
                <div className="mt-1.5 px-3 py-2 rounded-xl bg-black/20 border border-white/[0.04] text-[11px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[120px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[10px] block mb-1">Result:</span>
                  {tool.result}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/* ─── Tool Result Block (from history) ──────────────────────────────────── */

function ToolResultBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = message.toolName || 'unknown';
  const content = message.content || '';
  const truncatedContent = content.length > 200 ? content.substring(0, 200) + '…' : content;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-4 py-1"
    >
      <div className="flex flex-col items-center max-w-md w-full">
        <button
          onClick={() => content && setExpanded(!expanded)}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-500/[0.06] border border-emerald-500/[0.10] hover:bg-emerald-500/[0.10] transition-colors text-[11px] text-slate-400"
        >
          <CheckCircle2 size={11} className="text-emerald-400" />
          <span className="text-slate-300">
            Result: <span className="font-mono">{toolName}</span>
          </span>
          {content && (
            <ChevronRight size={10} className={`text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          )}
        </button>
        <AnimatePresence>
          {expanded && content && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden w-full"
            >
              <div className="mt-1.5 px-3 py-2 rounded-xl bg-emerald-500/[0.04] border border-emerald-500/[0.06] text-[11px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto text-left">
                {content}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/* ─── Composer Status Badge ─────────────────────────────────────────────── */

function ComposerStatusBadge({
  phase,
  toolName,
  statusText,
  showConnectionLost,
  compactionPhase,
  queueCount,
  onClearQueue,
}: {
  phase: 'idle' | 'thinking' | 'tool' | 'streaming';
  toolName: string | null;
  statusText?: string | null;
  showConnectionLost?: boolean;
  compactionPhase?: 'idle' | 'compacting' | 'compacted';
  queueCount?: number;
  onClearQueue?: () => void;
}) {
  const rawStatus = (statusText || '').trim();
  const normalizedStatus = rawStatus.toLowerCase();

  let tone = {
    bg: 'bg-violet-500/[0.06] border-violet-500/[0.12]',
    text: 'text-violet-300/80',
    dot: 'bg-violet-400',
    icon: null as React.ReactNode,
    label: rawStatus || (phase === 'tool' ? `Using ${toolName || 'tool'}…` : phase === 'streaming' ? 'Responding…' : 'Thinking…'),
    bounce: true,
  };

  if (showConnectionLost) {
    tone = {
      bg: 'bg-amber-500/[0.08] border-amber-500/20',
      text: 'text-amber-300/85',
      dot: 'bg-amber-400',
      icon: <RefreshCw size={12} className="text-amber-300 animate-spin" />,
      label: 'Reconnecting…',
      bounce: false,
    };
  } else if (/\b(connected|reconnected|recovered)\b/.test(normalizedStatus)) {
    tone = {
      bg: 'bg-emerald-500/[0.08] border-emerald-500/20',
      text: 'text-emerald-300/85',
      dot: 'bg-emerald-400',
      icon: <CheckCircle2 size={12} className="text-emerald-300" />,
      label: rawStatus || 'Connected',
      bounce: false,
    };
  } else if (compactionPhase === 'compacting' || /compact(ing|ion)/.test(normalizedStatus)) {
    tone = {
      bg: 'bg-blue-500/[0.08] border-blue-500/20',
      text: 'text-blue-300/85',
      dot: 'bg-blue-400',
      icon: <Loader2 size={12} className="text-blue-300 animate-spin" />,
      label: rawStatus || 'Compacting context… this may take a moment',
      bounce: false,
    };
  } else if (compactionPhase === 'compacted' || /context compacted/.test(normalizedStatus)) {
    tone = {
      bg: 'bg-blue-500/[0.08] border-blue-500/20',
      text: 'text-blue-300/85',
      dot: 'bg-blue-400',
      icon: <CheckCircle2 size={12} className="text-blue-300" />,
      label: rawStatus || 'Context compacted',
      bounce: false,
    };
  } else if (/approval|waiting for command approval/.test(normalizedStatus) || /reconnecting|queued|waiting/.test(normalizedStatus)) {
    tone = {
      bg: 'bg-amber-500/[0.08] border-amber-500/20',
      text: 'text-amber-300/85',
      dot: 'bg-amber-400',
      icon: /approval/.test(normalizedStatus)
        ? <Clock size={12} className="text-amber-300" />
        : <RefreshCw size={12} className="text-amber-300 animate-spin" />,
      label: rawStatus || `${queueCount} queued follow-up${queueCount === 1 ? '' : 's'}`,
      bounce: false,
    };
  } else if (/denied|failed|error|disconnected/.test(normalizedStatus)) {
    tone = {
      bg: 'bg-rose-500/[0.08] border-rose-500/20',
      text: 'text-rose-300/85',
      dot: 'bg-rose-400',
      icon: <Loader2 size={12} className="text-rose-300" />,
      label: rawStatus,
      bounce: false,
    };
  } else if (phase === 'idle' && queueCount && queueCount > 0) {
    tone = {
      bg: 'bg-amber-500/[0.08] border-amber-500/20',
      text: 'text-amber-300/85',
      dot: 'bg-amber-400',
      icon: <Clock size={12} className="text-amber-300" />,
      label: `${queueCount} queued follow-up${queueCount === 1 ? '' : 's'}`,
      bounce: false,
    };
  } else if (phase === 'idle') {
    return null;
  }

  const showQueueMeta = queueCount && queueCount > 0 && !(phase === 'idle' && !showConnectionLost && compactionPhase === 'idle' && !/\b(connected|reconnected|recovered)\b/.test(normalizedStatus));

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className={`flex items-center justify-center gap-2.5 px-4 py-1.5 border-t ${tone.bg}`}>
        {tone.bounce ? (
          <div className="flex gap-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot} animate-bounce`} style={{ animationDelay: '0ms' }} />
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot} animate-bounce`} style={{ animationDelay: '150ms' }} />
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot} animate-bounce`} style={{ animationDelay: '300ms' }} />
          </div>
        ) : (
          <>
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
            {tone.icon}
          </>
        )}
        <span className={`text-xs font-medium ${tone.text}`}>{tone.label}</span>
        {showQueueMeta ? (
          <>
            <span className={`text-xs ${tone.text}`}>•</span>
            <span className={`text-[11px] ${tone.text}`}>{queueCount} queued</span>
            {onClearQueue ? (
              <button
                onClick={onClearQueue}
                className={`rounded-md px-1.5 py-0.5 text-[10px] ${tone.text} hover:bg-white/[0.06] hover:text-white`}
                title="Clear queued messages"
              >
                clear
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </motion.div>
  );
}

/* ─── Loading Skeleton ──────────────────────────────────────────────────── */

function MessageSkeleton({ isUser = false }: { isUser?: boolean }) {
  return (
    <div className={`flex gap-3 px-4 py-3 max-w-3xl mx-auto w-full ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-white/[0.06] flex-shrink-0 animate-pulse" />
      )}
      <div className={`${isUser ? 'max-w-[60%]' : 'flex-1 max-w-[70%]'}`}>
        <div className={`rounded-2xl px-4 py-3 space-y-2 ${isUser ? 'bg-blue-600/20 rounded-br-md' : 'bg-white/[0.04] rounded-bl-md'}`}>
          <div className="h-3 bg-white/[0.06] rounded animate-pulse" style={{ width: '85%' }} />
          <div className="h-3 bg-white/[0.06] rounded animate-pulse" style={{ width: '65%' }} />
          {!isUser && <div className="h-3 bg-white/[0.06] rounded animate-pulse" style={{ width: '40%' }} />}
        </div>
      </div>
    </div>
  );
}

function LoadingSkeletonList() {
  return (
    <div className="py-4 space-y-2">
      <MessageSkeleton isUser />
      <MessageSkeleton />
      <MessageSkeleton isUser />
      <MessageSkeleton />
    </div>
  );
}

/* ─── Quick Start Cards ─────────────────────────────────────────────────── */

const QUICK_START_PROMPTS = [
  {
    icon: <MessageSquare size={18} />,
    title: 'Ask me anything',
    description: 'Get answers, explanations, or ideas',
    prompt: 'Hello! What can you help me with?',
  },
  {
    icon: <Code2 size={18} />,
    title: 'Help me code',
    description: 'Write, review, or debug code',
    prompt: 'Help me write a function that ',
  },
  {
    icon: <Bug size={18} />,
    title: 'Debug an issue',
    description: 'Troubleshoot errors and problems',
    prompt: "I'm running into an issue where ",
  },
  {
    icon: <Sparkles size={18} />,
    title: 'Brainstorm ideas',
    description: 'Explore concepts and possibilities',
    prompt: 'Help me brainstorm ideas for ',
  },
];

/* ─── Message Timestamp ─────────────────────────────────────────────────── */

const MessageTimestamp = React.memo(function MessageTimestamp({ date }: { date: Date }) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  return (
    <span className="text-[10px] text-slate-500 font-normal">
      {formatted}
    </span>
  );
});

const DateSeparator = React.memo(function DateSeparator({ date }: { date: Date }) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  let label: string;
  if (date.toDateString() === today.toDateString()) {
    label = 'Today';
  } else if (date.toDateString() === yesterday.toDateString()) {
    label = 'Yesterday';
  } else {
    label = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(date);
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 max-w-3xl mx-auto w-full">
      <div className="flex-1 border-t border-white/[0.06]" />
      <span className="text-[10px] text-slate-500 font-medium">{label}</span>
      <div className="flex-1 border-t border-white/[0.06]" />
    </div>
  );
});

/* ─── Copy Button ───────────────────────────────────────────────────────── */

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      sounds.click();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      sounds.click();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded-md transition-all duration-200 ${
        copied 
          ? 'text-emerald-400 bg-emerald-500/10 scale-110' 
          : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.06]'
      }`}
      title={copied ? 'Copied!' : 'Copy message'}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/* ─── Fix #3: Speech Recognition hook with proper cleanup ─────────────── */

interface SpeechRecognitionHook {
  isListening: boolean;
  transcript: string;
  isSupported: boolean;
  startListening: () => void;
  stopListening: () => void;
}

function useSpeechRecognition(onTranscript: (text: string) => void): SpeechRecognitionHook {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef<any>(null);
  const onTranscriptRef = useRef(onTranscript);
  // Track whether the user explicitly stopped vs browser auto-ended on silence
  const intentionalStopRef = useRef(false);
  // Accumulate finalized transcript across recognition restarts
  const accumulatedRef = useRef('');

  // Keep callback ref updated to avoid stale closures
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const SpeechRecognition =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;
  const isSupported = !!SpeechRecognition;

  const startListening = useCallback(() => {
    if (!SpeechRecognition) return;
    
    intentionalStopRef.current = false;
    accumulatedRef.current = '';
    
    // Clean up any existing recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }

    function createRecognition() {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        // When we get finalized text, accumulate it
        if (finalTranscript) {
          accumulatedRef.current += (accumulatedRef.current ? ' ' : '') + finalTranscript;
        }
        // Show accumulated + current interim
        const fullText = accumulatedRef.current + (interimTranscript ? (accumulatedRef.current ? ' ' : '') + interimTranscript : '');
        setTranscript(fullText);
        onTranscriptRef.current(fullText);
      };

      recognition.onend = () => {
        // Chrome fires onend after silence even in continuous mode.
        // Auto-restart unless the user explicitly clicked stop.
        if (!intentionalStopRef.current) {
          try {
            const newRecognition = createRecognition();
            newRecognition.start();
            recognitionRef.current = newRecognition;
          } catch {
            // If restart fails, give up gracefully
            setIsListening(false);
          }
        } else {
          setIsListening(false);
        }
      };

      recognition.onerror = (event: any) => {
        // 'no-speech' is normal during silence — don't stop
        if (event.error === 'no-speech') return;
        // 'aborted' happens during restart — don't stop
        if (event.error === 'aborted') return;
        setIsListening(false);
        intentionalStopRef.current = true;
      };

      return recognition;
    }

    const recognition = createRecognition();
    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
  }, [SpeechRecognition]);

  const stopListening = useCallback(() => {
    intentionalStopRef.current = true;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
    setIsListening(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  return { isListening, transcript, isSupported, startListening, stopListening };
}

/* ─── Fix #4: Attachment types ─────────────────────────────────────────── */

interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  type: 'image' | 'text' | 'other';
  previewUrl?: string;
  textContent?: string;
  /** Server-side path after upload (for non-text files) */
  serverPath?: string;
  /** Upload status */
  uploadStatus?: 'uploading' | 'done' | 'error';
  uploadError?: string;
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const isUploading = attachment.uploadStatus === 'uploading';
  const hasError = attachment.uploadStatus === 'error';
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs ${
      hasError ? 'bg-red-500/10 border border-red-500/20 text-red-300' :
      isUploading ? 'bg-amber-500/[0.06] border border-amber-500/15 text-slate-300' :
      'bg-white/[0.06] border border-white/[0.08] text-slate-300'
    }`}>
      {isUploading ? (
        <svg className="w-3 h-3 animate-spin text-amber-400" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
        </svg>
      ) : attachment.type === 'image' && attachment.previewUrl ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.name}
          className="w-5 h-5 rounded object-cover"
        />
      ) : hasError ? (
        <X size={12} className="text-red-400" />
      ) : (
        <Paperclip size={12} className="text-slate-400" />
      )}
      <span className="max-w-[120px] truncate">{attachment.name}</span>
      {isUploading ? (
        <span className="text-amber-400/60 text-[10px]">uploading…</span>
      ) : hasError ? (
        <span className="text-red-400/80 text-[10px]" title={attachment.uploadError}>failed</span>
      ) : (
        <span className="text-slate-500 text-[10px]">
          {attachment.size < 1024
            ? `${attachment.size}B`
            : attachment.size < 1024 * 1024
            ? `${(attachment.size / 1024).toFixed(1)}KB`
            : `${(attachment.size / 1024 / 1024).toFixed(1)}MB`}
        </span>
      )}
      <button
        onClick={onRemove}
        className="ml-0.5 text-slate-500 hover:text-slate-200 transition-colors"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/* ─── User Message Bubble ───────────────────────────────────────────────── */

const UserBubble = React.memo(function UserBubble({ message, avatarUrl, username, onRemoveQueued }: { message: ChatMessage; avatarUrl?: string | null; username?: string; onRemoveQueued?: () => void }) {
  const [hovered, setHovered] = useState(false);
  const initial = (username || 'U')[0].toUpperCase();

  return (
    <div
      className="flex gap-3 px-4 py-3 max-w-3xl mx-auto w-full group animate-user-in items-end"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex-1 min-w-0" />
      <div className="max-w-[78%]">
        <div className={`rounded-2xl rounded-br-sm px-4 py-2.5 shadow-lg shadow-blue-600/15 transition-opacity ${message.queued ? 'bg-blue-600/65 opacity-85' : 'bg-blue-600/90'}`}>
          <p className="text-sm text-white leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
        {message.queued && (
          <div className="mt-1 mr-1 flex justify-end gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
              <Clock size={9} />
              Queued follow-up
            </span>
            {onRemoveQueued && (
              <button
                onClick={onRemoveQueued}
                className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
                title="Remove queued message"
              >
                <X size={9} />
                Remove
              </button>
            )}
          </div>
        )}
        <AnimatePresence>
          {hovered && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex justify-end mt-1 mr-1"
            >
              <span className="text-[10px] text-slate-500 flex items-center gap-1">
                <Clock size={9} />
                <MessageTimestamp date={message.createdAt} />
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="w-7 h-7 rounded-full bg-blue-600/20 flex items-center justify-center flex-shrink-0 mb-0.5 text-[10px] font-bold text-blue-300 overflow-hidden ring-1 ring-blue-500/20">
        {avatarUrl ? (
          <img src={avatarUrl} alt={username || 'You'} className="w-full h-full object-cover" />
        ) : (
          initial
        )}
      </div>
    </div>
  );
});

/* ─── Assistant Message Bubble ──────────────────────────────────────────── */

const AssistantBubble = React.memo(function AssistantBubble({
  agent,
  message,
  avatarUrl,
  isLast,
  isStreaming,
  liveThinkingContent,
  streamingPhase,
  onRetry,
}: {
  agent: AgentIdentity;
  message: ChatMessage;
  avatarUrl?: string;
  isLast: boolean;
  isStreaming: boolean;
  /** Live thinking content from context state — used for the streaming message */
  liveThinkingContent?: string;
  /** Current streaming phase — controls thinking bubble visibility */
  streamingPhase?: string;
  onRetry?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const provenance = message.provenance || agent.provenance;
  const toolCalls = message.toolCalls || [];
  // For the streaming message, prefer live thinking content from context;
  // otherwise fall back to persisted content on the message object
  const isCurrentlyStreaming = isLast && isStreaming;
  // During streaming: show thinking ONLY during the 'thinking' phase.
  // Once streamingPhase moves to 'streaming' or 'tool', the thinking is done.
  // After streaming completes, show persisted thinking for history (expandable).
  const thinkingContent = isCurrentlyStreaming
    ? (streamingPhase === 'thinking' ? (liveThinkingContent || '') : '')
    : message.thinkingContent;
  const hasContent = !!message.content;

  return (
    <div
      className="flex gap-3 px-4 py-3 max-w-3xl mx-auto w-full animate-fade-in items-end"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`w-7 h-7 rounded-full ${agent.avatarBg} flex items-center justify-center flex-shrink-0 mb-0.5 text-[10px] font-bold ${agent.avatarText} overflow-hidden`}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={agent.name} className="w-full h-full object-cover" />
        ) : (
          agent.initials
        )}
      </div>
      <div className="flex-1 min-w-0 max-w-[80%]">
        {/* Thinking block — shows both during streaming (collapsible disclosure) and
            after streaming completes (expandable historical content).
            During streaming: shows as a collapsible block so user can peek at thoughts.
            After streaming: shows as expandable historical content. */}
        <AnimatePresence>
          {thinkingContent && (
            <ThinkingBlock
              content={thinkingContent}
              isActive={isCurrentlyStreaming}
              activeLabel={isCurrentlyStreaming ? 'Internal monologue' : undefined}
            />
          )}
        </AnimatePresence>

        {/* Tool call pills — centered system notifications */}
        {toolCalls.length > 0 && (
          <div className="mb-2 -ml-3 -mr-3">
            {toolCalls.map((tool) => (
              <ToolCallBlock key={tool.id} tool={tool} />
            ))}
          </div>
        )}

        {/* Message content */}
        {(hasContent || isCurrentlyStreaming) && (
          <div
            className={`rounded-2xl rounded-bl-sm px-4 py-2.5 transition-all duration-500 ${
              hasContent && message.content.startsWith('⚠️')
                ? 'bg-red-500/10 border border-red-500/20'
                : isCurrentlyStreaming
                  ? 'border border-dashed bg-[var(--accent-bg-subtle)]'
                  : 'bg-white/[0.06] border border-solid border-white/[0.08] shadow-lg shadow-black/10'
            }`}
            style={isCurrentlyStreaming && !(hasContent && message.content.startsWith('⚠️'))
              ? { borderColor: 'var(--accent-border-hover)', boxShadow: '0 0 12px var(--accent-shadow), inset 0 0 0 1px var(--accent-bg)' }
              : undefined
            }
          >
            {hasContent && message.content.startsWith('⚠️') ? (
              <div className="flex items-start gap-2">
                <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-red-300">{message.content.replace(/^⚠️\s*/, '')}</div>
              </div>
            ) : (
              <>
                <div
                  className={`flex items-center gap-1.5 mb-1.5 transition-all duration-300 overflow-hidden ${
                    isCurrentlyStreaming ? 'max-h-6 opacity-100' : 'max-h-0 opacity-0 pointer-events-none'
                  }`}
                  aria-hidden={!isCurrentlyStreaming}
                >
                  <span className="text-[10px] font-medium tracking-wide uppercase" style={{ color: 'var(--accent-light)', opacity: 0.7 }}>thinking</span>
                  <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: 'var(--accent-light)', opacity: 0.5 }} />
                </div>
                <div className={isCurrentlyStreaming ? 'streaming-cursor text-slate-300/95' : undefined}>
                  <MarkdownRenderer content={message.content} isStreaming={isCurrentlyStreaming} />
                </div>
              </>
            )}
          </div>
        )}

        {/* Footer: provenance + actions + timestamp */}
        <div className="flex items-center gap-2 mt-1 ml-1">
          <span className="text-[10px] text-slate-500 italic">{provenance}</span>

          <AnimatePresence>
            {hovered && hasContent && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className="flex items-center gap-0.5 ml-auto"
              >
                <CopyMessageButton text={message.content} />
                {isLast && onRetry && (
                  <button
                    onClick={onRetry}
                    className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-white/[0.06] transition-colors"
                    title="Retry"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {hovered && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <span className="text-[10px] text-slate-500 flex items-center gap-1">
                  <Clock size={9} />
                  <MessageTimestamp date={message.createdAt} />
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});

/* ─── Main Component ────────────────────────────────────────────────────── */

interface ChatInterfaceProps {
  defaultProvider?: string;
}

interface SlashCommandOption {
  value: string;
  description?: string;
}

interface SlashCommandArgument {
  name: string;
  required?: boolean;
  repeatable?: boolean;
  values?: SlashCommandOption[];
}

interface SlashCommandInfo {
  command: string;
  description: string;
  argsHint?: string;
  example?: string;
  keywords?: string[];
  category?: string;
  arguments?: SlashCommandArgument[];
}

interface SlashMatchState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  matches: SlashCommand[];
}

const CATEGORY_ICONS: Record<string, string> = {
  Session: '📋',
  Model: '🧠',
  Runtime: '⚙️',
  Agents: '🤖',
  Info: 'ℹ️',
};
const CATEGORY_ORDER = ['Session', 'Model', 'Runtime', 'Agents', 'Info'];

function detectLeadingSlashToken(text: string, caret: number) {
  const prefix = text.slice(0, caret);
  const match = prefix.match(/^(\s*)(\/[^\n]*)$/);
  if (!match) return null;
  const leading = match[1] || '';
  const token = match[2] || '';
  const tokenStart = leading.length;
  const tokenEnd = caret;
  if (!token.startsWith('/')) return null;
  const body = token.slice(1);
  const parts = body.split(/\s+/);
  const commandQuery = (parts[0] || '').toLowerCase();
  const hasTrailingSpace = /\s$/.test(token);
  const argumentIndex = hasTrailingSpace ? Math.max(parts.length - 1, 0) : Math.max(parts.length - 2, -1);
  const argumentQuery = hasTrailingSpace ? '' : (parts.length > 1 ? parts[parts.length - 1] : '');
  return {
    tokenStart,
    tokenEnd,
    query: commandQuery,
    raw: token,
    commandQuery,
    argumentIndex,
    argumentQuery: argumentQuery.toLowerCase(),
    hasArguments: parts.length > 1 || hasTrailingSpace,
  };
}

function filterSlashCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, 32);

  const starts: SlashCommandInfo[] = [];
  const contains: SlashCommandInfo[] = [];
  for (const cmd of commands) {
    const base = cmd.command.startsWith('/') ? cmd.command.slice(1).toLowerCase() : cmd.command.toLowerCase();
    const keywords = (cmd.keywords || []).map((k) => k.toLowerCase());
    if (base.startsWith(q)) {
      starts.push(cmd);
      continue;
    }
    if (base.includes(q) || keywords.some((k) => k.includes(q)) || cmd.description.toLowerCase().includes(q)) {
      contains.push(cmd);
    }
  }
  return [...starts, ...contains].slice(0, 32);
}

function filterSlashArgumentValues(command: SlashCommandInfo | undefined, argumentIndex: number, query: string): SlashCommandInfo[] {
  if (!command || argumentIndex < 0) return [];
  const argument = command.arguments?.[argumentIndex];
  const values = argument?.values || [];
  const q = query.trim().toLowerCase();
  return values
    .filter((option) => !q || option.value.toLowerCase().includes(q) || (option.description || '').toLowerCase().includes(q))
    .slice(0, 32)
    .map((option) => ({
      command: `${command.command} ${option.value}`,
      description: option.description || `Use ${option.value} for ${argument?.name || 'argument'}`,
      argsHint: command.argsHint,
      example: command.example,
      keywords: command.keywords,
      category: command.category,
      arguments: command.arguments,
    }));
}

/** Group commands by category, preserving category order. */
function groupByCategory(commands: SlashCommandInfo[]): { category: string; icon: string; items: SlashCommandInfo[] }[] {
  const map = new Map<string, SlashCommandInfo[]>();
  for (const cmd of commands) {
    const cat = cmd.category || 'Other';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(cmd);
  }
  const ordered = CATEGORY_ORDER.filter((c) => map.has(c));
  // Append any categories not in the predefined order
  for (const key of map.keys()) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return ordered.map((cat) => ({
    category: cat,
    icon: CATEGORY_ICONS[cat] || '📦',
    items: map.get(cat) || [],
  }));
}

export default function ChatInterface({ defaultProvider }: ChatInterfaceProps) {
  const chatState = useChatState();
  // Use context for persistent state (survives route navigation)
  const provider = chatState.provider;
  const setProvider = chatState.setProvider;
  const agentId = chatState.agentId;
  const setAgentId = chatState.setAgentId;
  const session = chatState.session;
  const setSession = chatState.setSession;
  const selectedModel = chatState.selectedModel;
  const setSelectedModel = chatState.setSelectedModel;
  const switchModel = chatState.switchModel;
  const refreshChat = chatState.refreshChat;
  const removeQueuedMessage = chatState.removeQueuedMessage;
  const wsConnected = chatState.wsConnected;
  const reconnectSocket = chatState.reconnectSocket;
  // Session controls
  const thinkingLevel = chatState.thinkingLevel;
  const setThinkingLevel = chatState.setThinkingLevel;
  const fastModeEnabled = chatState.fastModeEnabled;
  const fastModeModel = chatState.fastModeModel;
  const setFastModeModel = chatState.setFastModeModel;
  const toggleFastMode = chatState.toggleFastMode;
  const compactionModelOverride = chatState.compactionModelOverride;
  const setCompactionModelOverride = chatState.setCompactionModelOverride;
  const compactionModelLoading = chatState.compactionModelLoading;
  const compactionModelError = chatState.compactionModelError;
  const sessionControlsSupported = chatState.sessionControlsSupported;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({ OPENCLAW: OPENCLAW_MODEL_FALLBACK });
  const [compactionAvailableModels, setCompactionAvailableModels] = useState<string[]>(OPENCLAW_MODEL_FALLBACK);
  const [compactionModelOptionsLoading, setCompactionModelOptionsLoading] = useState(false);
  const [providerCatalog, setProviderCatalog] = useState<Record<string, {
    usable?: boolean;
    capabilities?: ProviderCapabilities;
    slashCommands?: SlashCommandInfo[];
    slashCommandsLoaded?: boolean;
    slashCommandsLoading?: boolean;
  }>>({});

  // Apply defaultProvider on first mount if provided
  useEffect(() => {
    if (defaultProvider && defaultProvider !== provider) {
      setProvider(defaultProvider);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);

  useEffect(() => {
    let cancelled = false;
    client.get('/gateway/providers')
      .then(({ data }) => {
        if (cancelled) return;
        const catalog = Object.fromEntries(((data?.providers || []) as Array<any>).map((p) => [p.name, p]));
        setProviderCatalog(catalog);
      })
      .catch(() => {
        if (!cancelled) setProviderCatalog({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadProviderCommands = useCallback(async (targetProvider: string, options?: { force?: boolean }) => {
    const cached = !options?.force ? providerCommandsCache.get(targetProvider) : undefined;
    if (cached) {
      setProviderCatalog((prev) => ({
        ...prev,
        [targetProvider]: {
          ...(prev[targetProvider] || {}),
          capabilities: {
            ...(prev[targetProvider]?.capabilities || {}),
            ...(cached.capabilities || {}),
          },
          slashCommands: cached.slashCommands,
          slashCommandsLoaded: true,
          slashCommandsLoading: false,
        },
      }));
      return cached.slashCommands;
    }

    setProviderCatalog((prev) => ({
      ...prev,
      [targetProvider]: {
        ...(prev[targetProvider] || {}),
        slashCommandsLoading: true,
      },
    }));

    try {
      const { data } = await client.get('/gateway/commands', { params: { provider: targetProvider } });
      const providerName = data?.provider || targetProvider;
      const slashCommands = Array.isArray(data?.commands) ? data.commands : [];
      const capabilities = data?.capabilities || {};
      providerCommandsCache.set(providerName, { slashCommands, capabilities });
      setProviderCatalog((prev) => ({
        ...prev,
        [providerName]: {
          ...(prev[providerName] || {}),
          capabilities: {
            ...(prev[providerName]?.capabilities || {}),
            ...capabilities,
          },
          slashCommands,
          slashCommandsLoaded: true,
          slashCommandsLoading: false,
        },
      }));
      return slashCommands;
    } catch (error) {
      setProviderCatalog((prev) => ({
        ...prev,
        [targetProvider]: {
          ...(prev[targetProvider] || {}),
          slashCommandsLoading: false,
        },
      }));
      throw error;
    }
  }, []);

  useEffect(() => {
    loadProviderCommands(provider).catch(() => {
      // Keep existing provider metadata if command discovery fails.
    });
  }, [provider, loadProviderCommands]);

  useEffect(() => {
    let cancelled = false;
    const cachedModels = providerModelsCache.get(provider);

    if (cachedModels) {
      setProviderModels((prev) => ({
        ...prev,
        [provider]: cachedModels.models,
      }));
      if (cachedModels.capabilities) {
        setProviderCatalog((prev) => ({
          ...prev,
          [provider]: {
            ...(prev[provider] || {}),
            capabilities: {
              ...(prev[provider]?.capabilities || {}),
              ...cachedModels.capabilities,
            },
          },
        }));
      }
      return () => {
        cancelled = true;
      };
    }

    gatewayAPI.models(provider)
      .then(({ provider: providerName, models, capabilities }) => {
        if (cancelled) return;
        const normalizedModels = (models || []).map((m) => m.id).filter(Boolean);
        providerModelsCache.set(providerName, { models: normalizedModels, capabilities });
        setProviderModels((prev) => ({
          ...prev,
          [providerName]: normalizedModels,
        }));
        if (capabilities) {
          setProviderCatalog((prev) => ({
            ...prev,
            [providerName]: {
              ...(prev[providerName] || {}),
              capabilities: {
                ...(prev[providerName]?.capabilities || {}),
                ...capabilities,
              },
            },
          }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (provider === 'OPENCLAW') {
          setProviderModels((prev) => ({ ...prev, OPENCLAW: OPENCLAW_MODEL_FALLBACK }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    const cached = providerModelsCache.get('OPENCLAW');
    if (cached?.models?.length) {
      setCompactionAvailableModels(cached.models);
      return () => {
        cancelled = true;
      };
    }

    setCompactionModelOptionsLoading(true);
    gatewayAPI.models('OPENCLAW')
      .then(({ provider: providerName, models, capabilities }) => {
        if (cancelled) return;
        const normalizedModels = (models || []).map((m) => m.id).filter(Boolean);
        providerModelsCache.set(providerName, { models: normalizedModels, capabilities });
        setProviderModels((prev) => ({ ...prev, [providerName]: normalizedModels }));
        setCompactionAvailableModels(normalizedModels.length ? normalizedModels : OPENCLAW_MODEL_FALLBACK);
      })
      .catch(() => {
        if (!cancelled) setCompactionAvailableModels(OPENCLAW_MODEL_FALLBACK);
      })
      .finally(() => {
        if (!cancelled) setCompactionModelOptionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const providerMeta = providerCatalog[provider] || {};
  const availableModels = providerModels[provider] || [];
  const canSelectModel = providerMeta.capabilities?.supportsModelSelection === true;
  const supportsCustomModelInput = providerMeta.capabilities?.supportsCustomModelInput !== false;
  const modelCatalogKind = (providerMeta.capabilities?.modelCatalogKind === 'declared' || providerMeta.capabilities?.modelCatalogKind === 'none' || providerMeta.capabilities?.modelCatalogKind === 'dynamic')
    ? providerMeta.capabilities.modelCatalogKind
    : (availableModels.length > 0 ? 'dynamic' : 'none');
  const sessionListProvider = provider === 'OPENCLAW' ? undefined : provider;
  const providerLabel = getAgent(provider).name;
  const liveSteerEnabled = providerMeta.capabilities?.supportsInTurnSteering === true;
  const runningComposerPlaceholder = liveSteerEnabled
    ? 'OpenClaw is working — send FYI / steer for this turn…'
    : 'Agent is working — queue a follow-up message…';
  const providerCommandCount = providerMeta.slashCommands?.length || 0;
  const providerCommandStatus = providerMeta.slashCommandsLoaded
    ? `${providerCommandCount} provider command${providerCommandCount === 1 ? '' : 's'}`
    : providerMeta.slashCommandsLoading
      ? 'Loading provider commands…'
      : 'Provider commands on demand';

  const [agentAvatars, setAgentAvatars] = useState<Record<string, string>>({});
  const [subAgentAvatars, setSubAgentAvatars] = useState<Record<string, string>>({});
  const [assistantName, setAssistantName] = useState<string>('');
  const [defaultOpenClawAgentId, setDefaultOpenClawAgentId] = useState<string>('main');
  const [avatarEditorProvider, setAvatarEditorProvider] = useState<string | null>(null);
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);

  // Fix #2: Scroll tracking
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isUserScrolledUp = useRef(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distFromBottom > 100;
    setShowScrollButton(scrolledUp);
    isUserScrolledUp.current = scrolledUp;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Fix #4: File attachments
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [slashMatch, setSlashMatch] = useState<SlashMatchState>({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    matches: [],
  });

  const uploadFileToServer = useCallback(async (file: File, attachId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch('/api/files/', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data = await resp.json();
      // data has { id, path, originalName, size, mimeType }
      // path is relative filename within user's upload dir
      // The full server path is /var/portal-files/user-{userId}/uploads/{path}
      // But we don't know userId here — ask backend. For now use the returned serverPath if present,
      // otherwise construct from the response.
      const serverPath = data.diskPath || `/var/portal-files/uploads/${data.path}`;
      setPendingAttachments(prev => prev.map(a =>
        a.id === attachId ? { ...a, serverPath, uploadStatus: 'done' as const } : a
      ));
    } catch (err: any) {
      setPendingAttachments(prev => prev.map(a =>
        a.id === attachId ? { ...a, uploadStatus: 'error' as const, uploadError: err.message } : a
      ));
    }
  }, []);

  const handleFileSelect = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);
    const newAttachments: PendingAttachment[] = [];
    for (const file of fileList) {
      const id = `attach-${Date.now()}-${Math.random()}`;
      const isImage = file.type.startsWith('image/');
      const isText =
        file.type.startsWith('text/') ||
        /\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|css|html|json|yaml|yml|md|sh|bash|zsh|fish|toml|ini|env)$/i.test(
          file.name,
        );

      const attachment: PendingAttachment = {
        id,
        file,
        name: file.name,
        size: file.size,
        type: isImage ? 'image' : isText ? 'text' : 'other',
      };

      if (isImage) {
        attachment.previewUrl = URL.createObjectURL(file);
        // Upload images too — agent needs server path for image analysis
        attachment.uploadStatus = 'uploading';
      }

      if (isText && file.size < 100 * 1024) {
        try {
          attachment.textContent = await file.text();
        } catch {
          // ignore
        }
        // Text files inlined — no upload needed
      } else if (!isText) {
        // Non-text files (PDFs, images, binaries) need server upload
        attachment.uploadStatus = 'uploading';
      }

      newAttachments.push(attachment);
    }
    setPendingAttachments((prev) => [...prev, ...newAttachments]);
    // Trigger uploads for non-text files
    for (const att of newAttachments) {
      if (att.uploadStatus === 'uploading') {
        uploadFileToServer(att.file, att.id);
      }
    }
  }, [uploadFileToServer]);

  const handlePasteAttachments = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file instanceof File)
      .filter((file) => file.type.startsWith('image/'));

    if (files.length === 0) return;
    e.preventDefault();
    void handleFileSelect(files);
  }, [handleFileSelect]);

  const isFileDrag = useCallback((event: { dataTransfer?: DataTransfer | null }) => {
    const types = event.dataTransfer?.types;
    return Boolean(types && Array.from(types).includes('Files'));
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    setIsDraggingFiles(true);
  }, [isFileDrag]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDraggingFiles) setIsDraggingFiles(true);
  }, [isDraggingFiles, isFileDrag]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDraggingFiles(false);
  }, [isFileDrag]);

  const handleDropFiles = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingFiles(false);
    void handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect, isFileDrag]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      pendingAttachments.forEach((att) => {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track resolved session IDs from the server
  const resolvedSessionRef = useRef<string | null>(null);
  const handleSessionResolved = useCallback((resolvedId: string) => {
    resolvedSessionRef.current = resolvedId;
    // Session is already synced via context; this just tracks for local ref
  }, []);

  const {
    runtime,
    messages,
    clearMessages,
    clearQueue,
    queueCount,
    streamingPhase,
    activeToolName,
    statusText,
    isRunning,
    isLoadingHistory,
    isSwitchingSession,
    pendingApproval: streamPendingApproval,
    resolveApproval: streamResolveApproval,
    dismissApproval: streamDismissApproval,
    compactionPhase,
    thinkingContent,
    streamSegments,
  } = useAgentRuntime({
    provider,
    session,
    model: selectedModel || undefined,
    agentId,
    onSessionResolved: handleSessionResolved,
  });

  const sendButtonTitle = isRunning
    ? (liveSteerEnabled ? 'Send live steer to running turn' : 'Queue follow-up after current turn')
    : `Send message to ${providerLabel}`;

  // Global exec approval listener (works even when no chat stream is active)
  const {
    pendingApproval: globalPendingApproval,
    resolveApproval: globalResolveApproval,
    dismissApproval: globalDismissApproval,
  } = useExecApprovals();

  // Merge approval sources: prefer stream-based if both exist, otherwise use global
  // The stream-based approval comes from the active chat SSE, while global comes
  // from the persistent WebSocket SSE. We prioritize stream-based since it's
  // tied to the current user's active chat.
  const pendingApproval = streamPendingApproval || globalPendingApproval;
  const resolveApproval = streamPendingApproval ? streamResolveApproval : globalResolveApproval;
  const dismissApproval = streamPendingApproval ? streamDismissApproval : globalDismissApproval;

  const prevWsConnectedRef = useRef(wsConnected);
  useEffect(() => {
    prevWsConnectedRef.current = wsConnected;
  }, [wsConnected]);

  // Fix #1: Auto-scroll on new messages (unless user scrolled up)
  useEffect(() => {
    if (!isUserScrolledUp.current) {
      // Use requestAnimationFrame to scroll after DOM update
      requestAnimationFrame(() => scrollToBottom(true));
    }
  }, [messages, scrollToBottom]);

  // Also scroll to bottom when streaming starts
  useEffect(() => {
    if (isRunning && !isUserScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom(false));
    }
  }, [isRunning, scrollToBottom]);

  const lastUserMessage = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return undefined;
  }, [messages]);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const agent = getAgent(provider);
  const providerSlashCommands = providerMeta.slashCommands || [];
  const streamIsStale = isRunning && !wsConnected;
  // B20: Only show connection-lost UI when stream is active and WS dropped,
  // not during idle disconnects (which auto-reconnect silently)
  const showConnectionLost = streamIsStale;

  // Mobile detection for keyboard behavior (Return key on mobile should insert newline, not submit)
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  useEffect(() => {
    // Detect mobile via user agent (more reliable than media query for keyboard behavior)
    const ua = navigator.userAgent || '';
    const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    // Also check if it's a touch device with on-screen keyboard
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    setIsMobileDevice(isMobile || (isTouchDevice && window.innerWidth < 768));

    // Listen for resize to handle orientation changes
    const handleResize = () => {
      setIsMobileDevice(isMobile || (isTouchDevice && window.innerWidth < 768));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
  }, [provider]);

  const refreshSlashAutocomplete = useCallback((value: string) => {
    const matches = matchSlashCommands(value);
    setSlashMatch({
      isOpen: value.trim().startsWith('/') && matches.length > 0,
      query: value.trim(),
      selectedIndex: 0,
      matches,
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    const textarea = composerInputRef.current;
    if (!textarea) return;
    const nextValue = `${command.command}${command.argsHint ? ' ' : ''}`;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(textarea, nextValue);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    // Close the slash match menu so the next Enter executes the command
    setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextValue.length, nextValue.length);
    });
  }, []);

  const maybeExecuteSlashCommand = useCallback(async () => {
    const textarea = composerInputRef.current;
    if (!textarea) return false;
    const parsed = parseSlashCommand(textarea.value);
    if (!parsed || !parsed.command.executeLocal) return false;
    await executeSlashCommand(parsed.command, parsed.args, chatState, {
      onNewSession: async () => {
        chatState.clearMessages();
        chatState.setSession(`new-${Date.now()}`);
        setPendingAttachments([]);
      },
    });
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
    textarea.style.height = 'auto';
    return true;
  }, [chatState]);

  // Fix #3: Speech recognition
  const handleTranscript = useCallback((text: string) => {
    if (!composerInputRef.current) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(composerInputRef.current, text);
    composerInputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
  }, []);

  const { isListening, isSupported: speechSupported, startListening, stopListening } =
    useSpeechRecognition(handleTranscript);

  const handleMicToggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Model change handler — context handles localStorage persistence
  const handleModelChange = useCallback(
    async (model: string) => {
      const previousModel = selectedModel;
      try {
        await switchModel(model);
      } catch (err) {
        console.error('Failed to switch model for current session:', err);
        setSelectedModel(previousModel);
      }
    },
    [selectedModel, setSelectedModel, switchModel],
  );

  const handleViewGatewaySession = useCallback(
    (sessionKey: string) => {
      if (!sessionKey) return;
      resolvedSessionRef.current = null;
      chatState.selectSession(sessionKey);
    },
    [chatState],
  );

  useEffect(() => {
    fetch('/api/settings/public')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.agentAvatars) setAgentAvatars(data.agentAvatars);
        if (data?.subAgentAvatars) setSubAgentAvatars(data.subAgentAvatars);
        if (data?.assistantName) setAssistantName(data.assistantName);
        if (data?.defaultOpenClawAgentId) setDefaultOpenClawAgentId(data.defaultOpenClawAgentId);
      })
      .catch(() => {});

    // Fetch user avatar (try cache first, then API)
    const cachedAvatar = sessionStorage.getItem('cached_userAvatar');
    if (cachedAvatar) setUserAvatarUrl(cachedAvatar);
    fetch('/api/users/me/avatar', { headers: {} })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.avatarUrl) {
            const url = data.avatarUrl + '?t=' + Date.now();
            setUserAvatarUrl(url);
            sessionStorage.setItem('cached_userAvatar', url);
          }
        })
        .catch(() => {});
  }, []);

  const handleSelectAgent = useCallback(
    async (selection: AgentSelection) => {
      const providerChanged = selection.provider !== provider;
      const agentChanged = selection.agentId !== agentId;
      if (!providerChanged && !agentChanged) return;
      if (isRunning) {
        await chatState.cancelStream();
      }
      // Fix: Clear messages FIRST to prevent stale history from showing.
      // The sequence must be: clear → update state atomically → load new history.
      // clearMessages() increments historyGenRef which invalidates any in-flight loads.
      clearMessages();
      // Context setters handle localStorage persistence
      setProvider(selection.provider);
      setAgentId(selection.agentId);
      setSession('main');
    },
    [provider, agentId, isRunning, chatState, clearMessages, setProvider, setAgentId, setSession],
  );

  const handleNewChat = useCallback(async () => {
    sounds.click();
    if (isRunning) {
      await chatState.cancelStream();
    }
    clearMessages();
    resolvedSessionRef.current = null;

    const shouldReuseCanonicalMain = provider === 'OPENCLAW'
      && (!agentId || agentId === 'main')
      && isOwner(user);

    setSession(shouldReuseCanonicalMain ? 'main' : 'new-' + Date.now());
    setPendingAttachments([]);
  }, [isRunning, chatState, clearMessages, setSession, provider, agentId, user]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      resolvedSessionRef.current = null;
      // Use selectSession which resets stale stream state and force-loads history,
      // bypassing the isStreamActive guard that would otherwise block history load.
      chatState.selectSession(sessionId);
    },
    [chatState],
  );

  // Build attachment text to prepend to message
  const buildAttachmentText = useCallback(() => {
    if (pendingAttachments.length === 0) return '';
    const parts: string[] = [];
    for (const att of pendingAttachments) {
      if (att.type === 'image' && att.serverPath) {
        parts.push(`[Image attached: ${att.name} (${(att.size / 1024 / 1024).toFixed(1)}MB, server path: ${att.serverPath})]`);
      } else if (att.type === 'image') {
        parts.push(`[Image attached: ${att.name}]`);
      } else if (att.type === 'text' && att.textContent) {
        parts.push(`\`\`\`${att.name}\n${att.textContent}\n\`\`\``);
      } else if (att.serverPath) {
        parts.push(`[File attached: ${att.name} (${(att.size / 1024 / 1024).toFixed(1)}MB, server path: ${att.serverPath})]`);
      } else if (att.uploadStatus === 'error') {
        parts.push(`[File attached: ${att.name} (upload failed: ${att.uploadError || 'unknown error'})]`);
      } else {
        parts.push(`[File attached: ${att.name} (${att.size} bytes)]`);
      }
    }
    return parts.join('\n\n') + '\n\n';
  }, [pendingAttachments]);

  // Intercept send to prepend attachments
  const handleSendWithAttachments = useCallback(() => {
    if (pendingAttachments.length === 0) return;
    // Block send while any file is still uploading
    const stillUploading = pendingAttachments.some(a => a.uploadStatus === 'uploading');
    if (stillUploading) return;
    const attachText = buildAttachmentText();
    if (!composerInputRef.current) return;
    const current = composerInputRef.current.value;
    const combined = attachText + current;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(composerInputRef.current, combined);
    composerInputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    setPendingAttachments([]);
  }, [pendingAttachments, buildAttachmentText]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full overflow-hidden bg-[#0A0E27]">
        {/* ── Main Chat Area ───────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-2 sm:py-2.5 border-b border-white/[0.06] bg-[#0D1130]/40 backdrop-blur-sm flex-shrink-0 relative z-20">
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <div
                className={`w-9 h-9 rounded-full ${agent.avatarBg} flex items-center justify-center text-xs font-bold ${agent.avatarText} overflow-hidden relative group`}
              >
                {agentAvatars[agent.providerName] ? (
                  <img src={agentAvatars[agent.providerName]} alt={agent.name} className="w-full h-full object-cover" />
                ) : (
                  agent.initials
                )}
                {isAdmin && (
                  <button
                    onClick={() => setAvatarEditorProvider(agent.providerName)}
                    title="Edit avatar"
                    className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-black/70 border border-white/10 text-slate-200 hover:text-white hover:bg-black/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil size={11} />
                  </button>
                )}
              </div>
              <AgentSelector
                value={provider}
                agentId={agentId}
                onChange={handleSelectAgent}
                onViewSession={handleViewGatewaySession}
                agentAvatars={agentAvatars}
                subAgentAvatars={subAgentAvatars}
                assistantName={assistantName}
                defaultOpenClawAgentId={defaultOpenClawAgentId}
              />
            </div>

            <div className="flex items-center gap-1 sm:gap-2 ml-auto">
              {canSelectModel && (
                <ModelPicker provider={provider} value={selectedModel} onChange={handleModelChange} models={availableModels} supportsCustomModelInput={supportsCustomModelInput} modelCatalogKind={modelCatalogKind} disabled={isRunning} />
              )}
              <SessionControls
                thinkingLevel={thinkingLevel}
                fastModeEnabled={fastModeEnabled}
                fastModeModel={fastModeModel}
                compactionModelOverride={compactionModelOverride}
                onSetThinkingLevel={(level) => { void setThinkingLevel(level); }}
                onToggleFastMode={() => { void toggleFastMode(); }}
                onSetFastModeModel={(model) => { void setFastModeModel(model); }}
                onSetCompactionModelOverride={(model) => { void setCompactionModelOverride(model); }}
                providerLabel={providerLabel}
                providerCommandCount={providerCommandCount}
                providerCommandStatus={providerCommandStatus}
                providerCapabilities={providerMeta.capabilities}
                availableModels={availableModels}
                compactionAvailableModels={compactionAvailableModels}
                compactionModelLoading={compactionModelLoading}
                compactionModelError={compactionModelError}
                compactionModelOptionsLoading={compactionModelOptionsLoading}
                sessionControlsSupported={sessionControlsSupported}
                onPanelOpen={() => { void loadProviderCommands(provider, { force: true }); }}
                disabled={false}
                currentModel={selectedModel}
                sessionKey={session}
              />
              <button
                onClick={handleNewChat}
                className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/[0.08] transition-colors"
                title="New chat"
              >
                <PenSquare size={16} />
              </button>
              {showConnectionLost && (
                <button
                  onClick={reconnectSocket}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/15 hover:text-amber-200"
                  title="Reconnect live stream"
                >
                  <RefreshCw size={14} className="animate-spin" />
                  <span className="hidden sm:inline">Reconnect</span>
                </button>
              )}
              <button
                onClick={async () => {
                  if (isRefreshing) return;
                  setIsRefreshing(true);
                  try { await refreshChat(); } finally {
                    setTimeout(() => setIsRefreshing(false), 600);
                  }
                }}
                disabled={isRefreshing}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                title="Refresh chat — reload history & reconnect stream"
              >
                <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                title="Agent Settings"
              >
                <Settings size={18} />
              </button>
            </div>
          </div>


          {/* Fix #1: Direct message rendering (no counters) + Fix #2: Smart scroll */}
          <ThreadPrimitive.Root
            className="flex-1 flex flex-col overflow-hidden relative"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDropFiles}
          >
            <AnimatePresence>
              {isDraggingFiles && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-emerald-400/50 bg-slate-950/80 backdrop-blur-sm pointer-events-none"
                >
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-5 py-4 text-center shadow-2xl shadow-black/40">
                    <div className="text-sm font-semibold text-emerald-200">Drop files here</div>
                    <div className="mt-1 text-xs text-emerald-200/70">They’ll be added as chat attachments.</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>


            {/* Message list — rendered directly from messages state */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto"
              onScroll={handleScroll}
            >
              {isLoadingHistory && messages.length === 0 ? (
                /* Initial loading skeleton */
                <LoadingSkeletonList />
              ) : messages.length === 0 && !isSwitchingSession ? (
                /* Empty state */
                <div className="flex flex-col items-center justify-center h-full text-center px-8 py-16">
                  <div
                    className={`w-16 h-16 rounded-2xl ${agent.avatarBg} flex items-center justify-center mb-6 overflow-hidden`}
                  >
                    {agentAvatars[agent.providerName] ? (
                      <img
                        src={agentAvatars[agent.providerName]}
                        alt={agent.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className={`text-xl font-bold ${agent.avatarText}`}>{agent.initials}</span>
                    )}
                  </div>
                  <h2 className="text-xl font-semibold text-white mb-1">{agent.name}</h2>
                  <p className="text-sm text-slate-400 max-w-md mb-8">How can I help you today?</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 max-w-lg w-full px-4 sm:px-0">
                    {QUICK_START_PROMPTS.map((card, idx) => (
                      <motion.button
                        key={idx}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05, duration: 0.2 }}
                        onClick={() => {
                          if (composerInputRef.current) {
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                              window.HTMLTextAreaElement.prototype,
                              'value',
                            )?.set;
                            nativeInputValueSetter?.call(composerInputRef.current, card.prompt);
                            composerInputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
                            composerInputRef.current.focus();
                          }
                        }}
                        className="flex flex-col items-start gap-2 p-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.12] transition-all text-left group"
                      >
                        <div className={`p-2 rounded-xl ${agent.bgLight} ${agent.color} transition-colors`}>
                          {card.icon}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-slate-200 group-hover:text-white transition-colors">
                            {card.title}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{card.description}</div>
                        </div>
                      </motion.button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {isSwitchingSession && (
                    <div className="sticky top-0 z-10 px-4 pt-4 pointer-events-none">
                      <div className="mx-auto max-w-md rounded-2xl border border-white/[0.08] bg-slate-950/80 backdrop-blur px-4 py-3 text-center shadow-lg">
                        <div className="text-sm font-medium text-white">Loading selected chat…</div>
                        <div className="text-xs text-slate-400 mt-1">Keeping the current transcript visible until history finishes loading.</div>
                      </div>
                    </div>
                  )}
                  {/* Direct message rendering — no counters, fully reactive */}
                  <div className="py-2">
                  {messages.map((msg, idx) => {
                    const prevMsg = idx > 0 ? messages[idx - 1] : null;
                    const showDate =
                      !prevMsg ||
                      msg.createdAt.toDateString() !== prevMsg.createdAt.toDateString();
                    const isQueuedUserMessage = msg.role === 'user' && chatState.messageQueue.some((queued) => queued.id === msg.id);

                    return (
                      <React.Fragment key={msg.id}>
                        {showDate && <DateSeparator date={msg.createdAt} />}
                        {msg.role === 'user' ? (
                          <UserBubble
                            message={isQueuedUserMessage ? { ...msg, queued: true } : msg}
                            avatarUrl={userAvatarUrl}
                            username={user?.username}
                            onRemoveQueued={isQueuedUserMessage ? () => removeQueuedMessage(msg.id) : undefined}
                          />
                        ) : msg.role === 'assistant' ? (
                          <>
                            {/* Interleaved timeline: graduated segments + tool calls in chronological order.
                                For streaming: use live streamSegments with timestamps.
                                For history: use msg.segments with position info to reconstruct the timeline. */}
                            {(() => {
                              const toolCalls = msg.toolCalls || [];
                              const isLiveTimeline = idx === messages.length - 1 && streamSegments.length > 0;
                              const hasHistorySegments = !isLiveTimeline && msg.segments && msg.segments.length > 0 && toolCalls.length > 0;
                              
                              if (!isLiveTimeline && !hasHistorySegments) return null;
                              
                              if (isLiveTimeline) {
                                // Live streaming: use timestamps to interleave
                                type TimelineItem =
                                  | { kind: 'segment'; seg: typeof streamSegments[0]; segIdx: number; ts: number }
                                  | { kind: 'tool'; tool: ToolCall; ts: number };
                                const timeline: TimelineItem[] = [
                                  ...streamSegments.map((seg, segIdx) => ({ kind: 'segment' as const, seg, segIdx, ts: seg.ts })),
                                  ...toolCalls.map(tool => ({ kind: 'tool' as const, tool, ts: tool.startedAt })),
                                ];
                                timeline.sort((a, b) => a.ts - b.ts);

                                return timeline.map((item) =>
                                  item.kind === 'segment' ? (
                                    <AssistantBubble
                                      key={`stream-seg-${item.segIdx}-${item.ts}`}
                                      message={{
                                        id: `seg-${item.segIdx}`,
                                        role: 'assistant' as const,
                                        content: item.seg.text,
                                        createdAt: new Date(item.ts),
                                      }}
                                      agent={agent}
                                      avatarUrl={agentAvatars[agent.providerName]}
                                      isLast={false}
                                      isStreaming={false}
                                    />
                                  ) : (
                                    <ToolCallBlock key={`timeline-tool-${item.tool.id}`} tool={item.tool} />
                                  )
                                );
                              } else {
                                // History: reconstruct from position-based segments
                                // Render: before segments, then tools, then after segments
                                const segments = msg.segments || [];
                                const beforeSegs = segments.filter(s => s.position === 'before');
                                const afterSegs = segments.filter(s => s.position === 'after');
                                
                                return (
                                  <>
                                    {/* Narration before tool calls */}
                                    {beforeSegs.map((seg, i) => (
                                      <AssistantBubble
                                        key={`hist-before-${msg.id}-${i}`}
                                        message={{
                                          id: `hist-before-${msg.id}-${i}`,
                                          role: 'assistant' as const,
                                          content: seg.text,
                                          createdAt: msg.createdAt,
                                        }}
                                        agent={agent}
                                        avatarUrl={agentAvatars[agent.providerName]}
                                        isLast={false}
                                        isStreaming={false}
                                      />
                                    ))}
                                    {/* Tool calls */}
                                    {toolCalls.map(tool => (
                                      <ToolCallBlock key={`hist-tool-${tool.id}`} tool={tool} />
                                    ))}
                                    {/* Text after tool calls (main response) — rendered by the AssistantBubble below */}
                                  </>
                                );
                              }
                            })()}
                            {/* Current/final bubble — shows live text OR historical content after tools */}
                            <AssistantBubble
                              message={(() => {
                                const isLiveTimeline = idx === messages.length - 1 && streamSegments.length > 0;
                                const hasHistorySegments = !isLiveTimeline && msg.segments && msg.segments.length > 0 && (msg.toolCalls || []).length > 0;
                                if (isLiveTimeline || hasHistorySegments) {
                                  // Tools already rendered in timeline above
                                  return { ...msg, toolCalls: undefined, segments: undefined };
                                }
                                return msg;
                              })()}
                              agent={agent}
                              avatarUrl={agentAvatars[agent.providerName]}
                              isLast={idx === messages.length - 1}
                              isStreaming={isRunning}
                              liveThinkingContent={idx === messages.length - 1 ? thinkingContent : undefined}
                              streamingPhase={idx === messages.length - 1 ? streamingPhase : undefined}
                              onRetry={
                                idx === messages.length - 1 && lastUserMessage
                                  ? () => {
                                      if (composerInputRef.current) {
                                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                                          window.HTMLTextAreaElement.prototype,
                                          'value',
                                        )?.set;
                                        nativeInputValueSetter?.call(
                                          composerInputRef.current,
                                          lastUserMessage.content,
                                        );
                                        composerInputRef.current.dispatchEvent(
                                          new Event('input', { bubbles: true }),
                                        );
                                        composerInputRef.current.focus();
                                      }
                                    }
                                  : undefined
                              }
                            />
                          </>
) : msg.role === 'system' ? (
                          <div className="flex justify-center px-4 py-2 max-w-3xl mx-auto w-full">
                            <div className="max-w-xl rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-[12px] text-slate-300 whitespace-pre-wrap">
                              {msg.content}
                            </div>
                          </div>
                        ) : null /* toolResult messages are rendered inline in the preceding assistant bubble's ToolCallBlock pills */}
                      </React.Fragment>
                    );
                  })}
                  {/* Spacer so last message isn't flush against composer */}
                  <div className="h-4" />
                </div>
                </>
              )}
            </div>

            {/* Fix #2: Scroll-to-bottom button — only visible when scrolled up */}
            <AnimatePresence>
              {showScrollButton && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.15 }}
                  className="absolute bottom-[90px] left-1/2 -translate-x-1/2 z-10"
                >
                  <button
                    onClick={() => {
                      isUserScrolledUp.current = false;
                      scrollToBottom(true);
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[#1A1F3A] border border-white/[0.10] text-xs text-slate-300 hover:text-white hover:bg-[#252B4A] transition-colors shadow-lg shadow-black/40"
                  >
                    <ChevronDown size={14} />
                    Scroll to bottom
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Compaction indicator */}
            <AnimatePresence>
              {(showConnectionLost || compactionPhase !== 'idle' || isRunning || queueCount > 0) && (
                <ComposerStatusBadge
                  phase={isRunning ? streamingPhase : 'idle'}
                  toolName={activeToolName}
                  statusText={statusText}
                  showConnectionLost={showConnectionLost}
                  compactionPhase={compactionPhase}
                  queueCount={queueCount}
                  onClearQueue={queueCount > 0 ? clearQueue : undefined}
                />
              )}
            </AnimatePresence>

            {/* Composer */}
            <div className={`border-t transition-colors duration-300 ${
              isRunning
                ? 'border-amber-500/20 bg-[#0D1130]/50'
                : 'border-white/[0.06] bg-[#0D1130]/30'
            } backdrop-blur-sm`}>
              <div className="px-2 sm:px-4 pt-2 pb-3 pb-safe max-w-3xl mx-auto">
                {/* Fix #4: Attachment chips row */}
                {pendingAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {pendingAttachments.map((att) => (
                      <AttachmentChip
                        key={att.id}
                        attachment={att}
                        onRemove={() => removeAttachment(att.id)}
                      />
                    ))}
                  </div>
                )}

                {/* Composer row: [paperclip] [textarea] [mic] [send] */}
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1"><kbd className="px-1 py-0.5 rounded bg-white/[0.05] text-[10px] font-mono text-slate-400">/</kbd> {providerCommandStatus}</span>
                  <span>{canSelectModel ? 'Model switching available' : 'Fixed provider defaults'}</span>
                  <span>{modelCatalogKind === 'none' ? 'Manual model ids may be required' : `Model catalog: ${availableModels.length || 'live'}`}</span>
                  <span className="text-slate-600">Try <span className="font-mono text-slate-400">/help</span> or <span className="font-mono text-slate-400">/status</span></span>
                </div>
                <ComposerPrimitive.Root className="relative flex items-end gap-1.5 sm:gap-2">
                  {/* Fix #4: Attachment button (hidden during streaming) */}
                  {!isRunning && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-shrink-0 p-2 sm:p-2.5 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors mb-0.5 touch-target"
                    title="Attach file"
                  >
                    <Paperclip size={18} className="sm:w-[18px] sm:h-[18px] w-4 h-4" />
                  </button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,text/*,.txt,.log,.csv,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.json,.yaml,.yml,.md,.sh,.bash,.toml,.ini,.env,.pdf,.xml,.sql,.conf,.cfg"
                    className="hidden"
                    onChange={(e) => handleFileSelect(e.target.files)}
                  />
                  <SlashCommandMenu
                    commands={slashMatch.matches}
                    selectedIndex={slashMatch.selectedIndex}
                    onSelect={applySlashCommand}
                  />

                  <ComposerPrimitive.Input
                    ref={composerInputRef}
                    autoFocus
                    placeholder={isRunning ? runningComposerPlaceholder : `Message ${agent.name}…`}
                    className={`flex-1 resize-none rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm placeholder-slate-500 focus:outline-none transition-all duration-300 min-h-[44px] max-h-[200px] overflow-y-auto ${
                      isRunning
                        ? 'bg-violet-500/[0.04] border border-violet-500/15 text-white'
                        : `bg-white/[0.06] border border-white/[0.08] text-white focus:ring-1 ${agent.accentRing}`
                    }`}
                    rows={1}
                    // On mobile: use "none" submit mode (Enter inserts newline, user must tap Send button)
                    // On desktop: use "enter" mode (Enter submits, Shift+Enter for newline)
                    submitMode={isMobileDevice ? 'none' : 'enter'}
                    onInput={(e: React.FormEvent<HTMLTextAreaElement>) => {
                      const textarea = e.currentTarget;
                      // Auto-resize: reset height, then set to scrollHeight
                      textarea.style.height = 'auto';
                      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
                      refreshSlashAutocomplete(textarea.value);
                    }}
                    onClick={(e: React.MouseEvent<HTMLTextAreaElement>) => {
                      const textarea = e.currentTarget;
                      refreshSlashAutocomplete(textarea.value);
                    }}
                    onSelect={(e: React.SyntheticEvent<HTMLTextAreaElement>) => {
                      const textarea = e.currentTarget;
                      refreshSlashAutocomplete(textarea.value);
                    }}
                    onPaste={handlePasteAttachments}
                    onBlur={() => {
                      // Dismiss autocomplete when focus leaves the composer.
                      // (mouseDown on popup items calls preventDefault, keeping focus)
                      setTimeout(() => {
                        if (composerInputRef.current !== document.activeElement) {
                          setSlashMatch((prev) => prev.isOpen ? { isOpen: false, query: '', selectedIndex: 0, matches: [] } : prev);
                        }
                      }, 100);
                    }}
                    onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                      if (slashMatch.isOpen) {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setSlashMatch((prev) => ({
                            ...prev,
                            selectedIndex: prev.matches.length === 0
                              ? 0
                              : (prev.selectedIndex + 1) % prev.matches.length,
                          }));
                          return;
                        }
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSlashMatch((prev) => ({
                            ...prev,
                            selectedIndex: prev.matches.length === 0
                              ? 0
                              : (prev.selectedIndex - 1 + prev.matches.length) % prev.matches.length,
                          }));
                          return;
                        }
                        if ((e.key === 'Tab') && slashMatch.matches.length > 0) {
                          e.preventDefault();
                          const selected = slashMatch.matches[slashMatch.selectedIndex] || slashMatch.matches[0];
                          applySlashCommand(selected);
                          return;
                        }
                        if (e.key === 'Enter' && slashMatch.matches.length > 0) {
                          // Close the menu and let Enter fall through to normal submit
                          setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
                          return;
                        }
                      }

                      // On mobile: Enter always inserts newline (submitMode="none" handles this)
                      // On desktop: Shift+Enter inserts newline, plain Enter submits
                      if (!isMobileDevice && e.key === 'Enter' && !e.shiftKey) {
                        // Let ComposerPrimitive handle the submit (via submitMode="enter")
                        // But first prepend attachments if any
                        if (pendingAttachments.length > 0) {
                          handleSendWithAttachments();
                        }
                        // Slash commands are sent as messages to the agent (not executed locally)
                      }
                    }}
                  />

                  {/* Fix #3: Dictation / mic button */}
                  {speechSupported && (
                    <button
                      type="button"
                      onClick={handleMicToggle}
                      className={`flex-shrink-0 p-2 sm:p-2.5 rounded-xl transition-all duration-200 mb-0.5 touch-target ${
                        isListening
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30 scale-110 shadow-lg shadow-red-500/20'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.06]'
                      }`}
                      title={isListening ? 'Stop recording' : 'Dictate message'}
                    >
                      <Mic size={18} className={`sm:w-[18px] sm:h-[18px] w-4 h-4 ${isListening ? 'animate-pulse' : ''}`} />
                    </button>
                  )}

                  {/* Send button stays active during runs. OpenClaw uses live inject/steer; native CLIs queue the follow-up for the next turn. */}
                  <ComposerPrimitive.Send asChild>
                    <button
                      onClick={async (e) => {
                        handleSendWithAttachments();
                        if (await maybeExecuteSlashCommand()) {
                          e.preventDefault();
                          e.stopPropagation();
                        }
                      }}
                      className={`flex-shrink-0 p-2.5 sm:p-3 rounded-xl ${agent.sendBg} ${agent.sendHover} text-white transition-all duration-200 shadow-lg ${agent.sendShadow} hover:scale-105 active:scale-95 touch-target`}
                      title={sendButtonTitle}
                    >
                      <Send size={16} className="sm:w-4 sm:h-4 w-3.5 h-3.5" />
                    </button>
                  </ComposerPrimitive.Send>
                  {/* Stop button — driven by our own isRunning, not assistant-ui runtime
                      (runtime.isRunning is always false to keep Send enabled for FYI queue) */}
                  {isRunning && (
                    <button
                      onClick={() => chatState.cancelStream()}
                      className="flex-shrink-0 p-2.5 sm:p-3 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-all duration-200 border border-red-500/20 hover:scale-105 active:scale-95 touch-target"
                    >
                      <StopCircle size={16} className="sm:w-4 sm:h-4 w-3.5 h-3.5" />
                    </button>
                  )}
                </ComposerPrimitive.Root>
              </div>
            </div>
          </ThreadPrimitive.Root>
        </div>

        {avatarEditorProvider && (
          <ImagePickerCropper
            isOpen={Boolean(avatarEditorProvider)}
            onClose={() => setAvatarEditorProvider(null)}
            onSaved={(url) => {
              // Keep cache-buster for immediate display, store clean for next load
              setAgentAvatars((prev) => ({ ...prev, [avatarEditorProvider]: url || '' }));
            }}
            currentImageUrl={agentAvatars[avatarEditorProvider] || null}
            uploadEndpoint={`/admin/appearance/agent-avatar/${avatarEditorProvider}`}
            deleteEndpoint={`/admin/appearance/agent-avatar/${avatarEditorProvider}`}
            fieldName="image"
            title={`Edit ${avatarEditorProvider} Avatar`}
            shape="circle"
            responseKey="avatarUrl"
          />
        )}

        <AgentSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

        {/* Exec Approval Modal */}
        {pendingApproval && (
          <ExecApprovalModal
            approval={pendingApproval}
            onResolve={resolveApproval}
            onDismiss={dismissApproval}
          />
        )}
      </div>
    </AssistantRuntimeProvider>
  );
}
