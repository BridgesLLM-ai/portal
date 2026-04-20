/**
 * AgentSelector — polished dropdown for switching between agent providers
 * and OpenClaw sub-agents. Sessions appear in a separate dropdown button
 * for any provider that supports session listing.
 * Uses real avatar images from /api/settings/public.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Users, Radio, Loader2, History, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import client from '../../api/client';
import { useAuthStore } from '../../contexts/AuthContext';
import { getShortModelLabel } from '../../utils/modelId';

/* ─── Mobile Bottom Sheet wrapper ───────────────────────────────────────── */
/** Renders children in a portal as a bottom-sheet on mobile, inline absolute on desktop */
function DropdownSheet({
  open,
  onClose,
  children,
  desktopClass,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  desktopClass: string;
}) {
  // Detect mobile via matchMedia (< 640px = Tailwind sm breakpoint)
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
    // Portal to body — escapes all overflow:hidden ancestors
    return createPortal(
      <AnimatePresence>
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 z-[9998]"
          onClick={onClose}
        />
        <motion.div
          key="sheet"
          initial={{ opacity: 0, y: 100 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 100 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-0 z-[9999] px-3 pb-3"
        >
          <div className="rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden max-h-[70vh]">
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-white/[0.06]">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Select</span>
              <button onClick={onClose} className="p-1 rounded-lg text-slate-500 hover:text-slate-300">
                <X size={14} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-[60vh] overscroll-contain">
              {children}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>,
      document.body,
    );
  }

  // Desktop — render inline with absolute positioning
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -6, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.97 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className={desktopClass}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface ProviderInfo {
  name: string;
  displayName: string;
  installed?: boolean;
  implemented?: boolean;
  usable?: boolean;
  command?: string;
  version?: string;
  native?: boolean;
  reason?: string;
  nativeAuthStatus?: 'not_applicable' | 'authenticated' | 'needs_login' | 'unknown';
  nativeAuthMessage?: string;
  nativeAuthLoginCommand?: string;
  capabilities?: {
    implemented?: boolean;
    requiresGateway?: boolean;
    supportsHistory?: boolean;
    supportsModelSelection?: boolean;
    supportsSessionList?: boolean;
    supportsExecApproval?: boolean;
  };
}

interface OpenClawAgent {
  id: string;
  name?: string;
  identity?: string;
  model?: string;
  workspace?: string;
  avatarUrl?: string;
}

interface GatewaySession {
  key?: string;
  id?: string;
  sessionId?: string;
  status?: string;
  lastActivityAt?: string;
  createdAt?: string;
  agent?: string;
  channel?: string;
  title?: string;
  preview?: string;
  isMainSession?: boolean;
}

export interface AgentSelection {
  provider: string;
  agentId?: string;
}

interface AgentSelectorProps {
  value: string;
  agentId?: string;
  onChange: (selection: AgentSelection) => void;
  onViewSession?: (sessionKey: string) => void;
  currentSessionKey?: string;
  currentSessionLabel?: string;
  agentAvatars?: Record<string, string>;
  subAgentAvatars?: Record<string, string>;
  assistantName?: string;
  defaultOpenClawAgentId?: string;
}

/* ─── Constants ─────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'agent-chat-provider';
const AGENT_STORAGE_KEY = 'agent-chat-agentId';
const AGENTS_CACHE_KEY = 'agent-chat-agents-cache';

/** Provider-level fallback colors / labels (used when no avatar image exists) */
const PROVIDER_META: Record<string, { emoji: string; color: string; label: string; initials: string; avatarBg: string; avatarText: string }> = {
  OPENCLAW:    { emoji: '🟢', color: 'text-emerald-400', label: 'OpenClaw', initials: 'OC', avatarBg: 'bg-emerald-600/20', avatarText: 'text-emerald-300' },
  CLAUDE_CODE: { emoji: '🟣', color: 'text-violet-400',  label: 'Claude Code', initials: 'CL', avatarBg: 'bg-violet-600/20', avatarText: 'text-violet-300' },
  CODEX:       { emoji: '🔵', color: 'text-sky-400',     label: 'Codex', initials: 'CX', avatarBg: 'bg-sky-600/20', avatarText: 'text-sky-300' },
  AGENT_ZERO:  { emoji: '🟡', color: 'text-amber-400',   label: 'Agent Zero', initials: 'A0', avatarBg: 'bg-amber-600/20', avatarText: 'text-amber-300' },
  GEMINI:      { emoji: '🔷', color: 'text-cyan-400',    label: 'Gemini', initials: 'GM', avatarBg: 'bg-cyan-600/20', avatarText: 'text-cyan-300' },
  OLLAMA:      { emoji: '🔴', color: 'text-rose-400',    label: 'Ollama', initials: 'OL', avatarBg: 'bg-rose-600/20', avatarText: 'text-rose-300' },
};

/** Default identity emojis for well-known agent names */
const AGENT_IDENTITY_FALLBACK: Record<string, string> = {
  main:    '🤖',
  parity:  '🔬',
  kernel:  '🛠️',
  isotype: '🧬',
};

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function getAgentEmoji(agent: OpenClawAgent): string {
  if (agent.identity) return agent.identity;
  return AGENT_IDENTITY_FALLBACK[agent.id] || '🤖';
}

function getAgentLabel(agent: OpenClawAgent, assistantName?: string): string {
  if (agent.id === 'main' && assistantName) return assistantName;
  if (agent.name) return agent.name;
  return agent.id.charAt(0).toUpperCase() + agent.id.slice(1);
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  } catch {
    return '';
  }
}

function getSessionLabel(s: GatewaySession): string {
  const title = typeof (s as any).title === 'string' ? (s as any).title.trim() : '';
  if (title) return title;

  const preview = typeof (s as any).preview === 'string' ? (s as any).preview.trim() : '';
  if (preview && preview.length <= 72) return preview;

  const key = s.key || s.sessionId || s.id || '';
  if (!key) return 'Unknown';

  if (!key.includes(':')) {
    if (key === 'main') return 'Main session';
    if (key.startsWith('new-')) return 'New chat';
    return key.length > 24 ? `${key.slice(0, 24)}…` : key;
  }

  const parts = key.split(':');
  const agentName = parts[1] || 'main';
  const sessionName = parts[parts.length - 1] || 'main';

  if (sessionName === 'main') {
    return agentName === 'main' ? 'Main session' : `${agentName} / main session`;
  }

  return agentName === 'main'
    ? `Session ${sessionName.slice(0, 8)}`
    : `${agentName} / ${sessionName.slice(0, 8)}`;
}

/** Small circular avatar — image or fallback initials/emoji */
function AvatarCircle({
  src,
  fallback,
  size = 'sm',
  bgClass,
  textClass,
}: {
  src?: string;
  fallback: string;
  size?: 'sm' | 'md';
  bgClass?: string;
  textClass?: string;
}) {
  const sizeClass = size === 'md' ? 'w-7 h-7' : 'w-5 h-5';
  const textSize = size === 'md' ? 'text-[10px]' : 'text-[9px]';
  return (
    <div className={`${sizeClass} rounded-full ${bgClass || 'bg-white/[0.08]'} flex items-center justify-center flex-shrink-0 overflow-hidden`}>
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className={`${textSize} font-bold ${textClass || 'text-slate-300'} leading-none`}>{fallback}</span>
      )}
    </div>
  );
}

/* ─── Session Dropdown (separate from agent dropdown) ───────────────────── */

function SessionDropdown({
  sessions,
  loading = false,
  hasLoaded = false,
  open,
  onOpenChange,
  onViewSession,
  providerLabel,
  currentSessionKey,
  currentSessionLabel,
}: {
  sessions: GatewaySession[];
  loading?: boolean;
  hasLoaded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewSession: (sessionKey: string) => void;
  providerLabel: string;
  currentSessionKey?: string;
  currentSessionLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // On mobile, portal renders to document.body — click-outside would
    // immediately close the dropdown. Backdrop onClick handles dismissal instead.
    const isMobile = window.matchMedia('(max-width: 639px)').matches;
    if (isMobile) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onOpenChange]);

  const activeSessions = sessions.filter(s => s.status === 'active');
  const otherSessions = sessions.filter(s => s.status !== 'active');
  const countLabel = loading && sessions.length === 0 ? '…' : hasLoaded ? String(sessions.length) : '—';
  const matchedCurrentSession = currentSessionKey
    ? sessions.find((session) => (session.key || session.sessionId || session.id || '') === currentSessionKey)
    : null;
  const fallbackCurrentLabel = currentSessionKey
    ? getSessionLabel({ key: currentSessionKey })
    : '';
  const headerLabel = typeof currentSessionLabel === 'string' && currentSessionLabel.trim()
    ? currentSessionLabel.trim()
    : matchedCurrentSession
      ? getSessionLabel(matchedCurrentSession)
      : (fallbackCurrentLabel || (hasLoaded ? 'History' : 'Chat history'));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-slate-500 hover:text-slate-300 transition-colors min-w-0 max-w-[180px]"
        title={`${providerLabel} sessions`}
      >
        <History size={12} />
        <span className="hidden sm:inline truncate">{headerLabel}</span>
        {hasLoaded && (
          <span className="hidden sm:inline tabular-nums rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
            {countLabel}
          </span>
        )}
        {activeSessions.length > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        )}
        <ChevronDown
          size={11}
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''} hidden sm:block`}
        />
      </button>

      <DropdownSheet
        open={open}
        onClose={() => onOpenChange(false)}
        desktopClass="absolute top-full right-0 mt-1.5 w-64 rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden z-50"
      >
        <div className="max-h-[320px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              <Radio size={10} className="text-emerald-400" />
              {providerLabel} Sessions
              <span className="ml-auto text-[9px] bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded-full font-medium tabular-nums">
                {countLabel}
              </span>
            </div>
          </div>

          {loading && sessions.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-500 flex items-center gap-2">
              <Loader2 size={12} className="animate-spin text-slate-500" />
              <span>Loading sessions…</span>
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-500">
              No recent sessions yet.
            </div>
          )}

          {activeSessions.length > 0 && (
            <div>
              {activeSessions.map((s, idx) => {
                const key = s.key || s.sessionId || s.id || '';
                return (
                  <button
                    key={key || `active-${idx}`}
                    onClick={() => { onViewSession(key); onOpenChange(false); }}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                    <span className="flex-1 text-left truncate text-[12px] font-medium">
                      {getSessionLabel(s)}
                    </span>
                    <span className="text-[10px] text-slate-600 flex-shrink-0">
                      {formatTime(s.lastActivityAt || s.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {activeSessions.length > 0 && otherSessions.length > 0 && (
            <div className="mx-3 border-t border-white/[0.05] my-1" />
          )}

          {otherSessions.slice(0, 10).map((s, idx) => {
            const key = s.key || s.sessionId || s.id || '';
            return (
              <button
                key={key || `other-${idx}`}
                onClick={() => { onViewSession(key); onOpenChange(false); }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0" />
                <span className="flex-1 text-left truncate text-[12px]">
                  {getSessionLabel(s)}
                </span>
                <span className="text-[10px] text-slate-600 flex-shrink-0">
                  {formatTime(s.lastActivityAt || s.createdAt)}
                </span>
              </button>
            );
          })}

          <div className="h-1" />
        </div>
      </DropdownSheet>
    </div>
  );
}

/* ─── Main Component ────────────────────────────────────────────────────── */

export default function AgentSelector({
  value,
  agentId,
  onChange,
  onViewSession,
  currentSessionKey,
  currentSessionLabel,
  agentAvatars = {},
  subAgentAvatars = {},
  assistantName,
  defaultOpenClawAgentId,
}: AgentSelectorProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [agents, setAgents] = useState<OpenClawAgent[]>([]);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [open, setOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch providers lazily when the selector opens. The current provider/agent is
  // already known from parent state, so Agent Chats should not spend startup budget
  // populating dropdown options before the user asks for them.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    async function fetchProviders() {
      try {
        const { data } = await client.get('/gateway/providers');
        if (!cancelled && data.providers) {
          setProviders(data.providers);
          const saved = localStorage.getItem(STORAGE_KEY);
          const savedAgent = localStorage.getItem(AGENT_STORAGE_KEY);
          const preferredOpenClawAgent = (savedAgent && savedAgent !== 'main')
            ? savedAgent
            : (defaultOpenClawAgentId || savedAgent || 'main');
          const usableProviders = data.providers.filter((p: ProviderInfo) => p.usable !== false);
          if (saved && usableProviders.some((p: ProviderInfo) => p.name === saved)) {
            onChange({ provider: saved, agentId: saved === 'OPENCLAW' ? preferredOpenClawAgent : undefined });
          } else if (usableProviders.length > 0) {
            const fallback = usableProviders[0].name;
            if (!value || !usableProviders.some((p: ProviderInfo) => p.name === value)) {
              onChange({ provider: fallback, agentId: fallback === 'OPENCLAW' ? preferredOpenClawAgent : undefined });
            }
          }
        }
      } catch {
        if (!cancelled) setProviders([{ name: 'OPENCLAW', displayName: 'OpenClaw' }]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchProviders();
    return () => { cancelled = true; };
  }, [open, defaultOpenClawAgentId, onChange, value]);

  useEffect(() => {
    if (value !== 'OPENCLAW' || !defaultOpenClawAgentId || !agents.length) return;
    const savedAgent = localStorage.getItem(AGENT_STORAGE_KEY);
    const shouldPromoteDefault = !savedAgent || savedAgent === 'main';
    if (!shouldPromoteDefault) return;
    if ((agentId || 'main') !== 'main') return;
    if (!agents.some((agent) => agent.id === defaultOpenClawAgentId)) return;
    onChange({ provider: 'OPENCLAW', agentId: defaultOpenClawAgentId });
    localStorage.setItem(AGENT_STORAGE_KEY, defaultOpenClawAgentId);
  }, [value, agentId, agents, defaultOpenClawAgentId, onChange]);

  // Fetch OpenClaw sub-agents lazily when the selector opens. Cache still seeds the
  // UI immediately, but we do not spend first-load bandwidth on hidden dropdown data.
  useEffect(() => {
    let cancelled = false;

    function loadCachedAgents(): OpenClawAgent[] | null {
      try {
        const raw = localStorage.getItem(AGENTS_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
      return null;
    }

    function saveCachedAgents(list: OpenClawAgent[]) {
      try {
        localStorage.setItem(AGENTS_CACHE_KEY, JSON.stringify(list));
      } catch {}
    }

    async function fetchAgents(attempt = 1): Promise<void> {
      if (attempt === 1) setAgentsLoading(true);
      try {
        const { data } = await client.get('/gateway/agents');
        if (!cancelled && data.agents) {
          setAgents(data.agents);
          saveCachedAgents(data.agents);
        }
        if (!cancelled) setAgentsLoading(false);
      } catch {
        if (!cancelled) {
          if (attempt < 2) {
            setTimeout(() => { if (!cancelled) fetchAgents(attempt + 1); }, 1500);
            return;
          }
          const cached = loadCachedAgents();
          setAgents(cached || [{ id: 'main', identity: '🤖' }]);
          setAgentsLoading(false);
        }
      }
    }

    const cached = loadCachedAgents();
    if (cached) setAgents(cached);
    if (!open) return () => { cancelled = true; };

    void fetchAgents();
    return () => { cancelled = true; };
  }, [open]);

  // Fetch session lists only when the session picker is opened.
  // The chat header stays usable without this metadata, so we avoid paying
  // for hidden session-list requests on every Agent Chat page open.
  useEffect(() => {
    const selectedProvider = providers.find((p) => p.name === value);
    const supportsSessionList = value === 'OPENCLAW' || selectedProvider?.capabilities?.supportsSessionList === true;
    if (!supportsSessionList || !isAuthenticated) {
      setSessions([]);
      setSessionsLoading(false);
      setSessionsLoaded(false);
      return;
    }
    const shouldFetchSessions = sessionsOpen || Boolean(currentSessionKey);
    if (!shouldFetchSessions) return;
    let cancelled = false;
    async function fetchSessions() {
      if (!cancelled) setSessionsLoading(true);
      try {
        const params: Record<string, string> = {};
        if (value === 'OPENCLAW') {
          if (agentId) params.agentId = agentId;
        } else {
          params.provider = value;
        }
        const { data } = await client.get('/gateway/sessions', {
          params,
          _silent: true,
        } as any);
        const list = data.sessions || [];
        if (!cancelled) {
          setSessions(Array.isArray(list) ? list : Object.values(list));
          setSessionsLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setSessions([]);
          setSessionsLoaded(true);
        }
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    }
    void fetchSessions();
    const interval = setInterval(fetchSessions, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [value, agentId, providers, sessionsOpen, currentSessionKey, isAuthenticated]);

  // Close on click outside (desktop only — mobile uses backdrop onClick)
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

  const handleSelect = useCallback((provider: string, selectedAgentId?: string) => {
    onChange({ provider, agentId: selectedAgentId });
    localStorage.setItem(STORAGE_KEY, provider);
    if (selectedAgentId) {
      localStorage.setItem(AGENT_STORAGE_KEY, selectedAgentId);
    } else {
      localStorage.removeItem(AGENT_STORAGE_KEY);
    }
    setOpen(false);
  }, [onChange]);

  const handleSessionClick = useCallback((sessionKey: string) => {
    if (onViewSession) {
      onViewSession(sessionKey);
    }
  }, [onViewSession]);

  // Resolve avatar URL for a given agent
  function getSubAgentAvatarUrl(agent: OpenClawAgent): string | undefined {
    if (agent.avatarUrl) return agent.avatarUrl;
    return subAgentAvatars[agent.id] || undefined;
  }

  // Determine display for current selection
  const currentMeta = PROVIDER_META[value] || { emoji: '🤖', color: 'text-slate-400', label: value, initials: '??', avatarBg: 'bg-slate-600/20', avatarText: 'text-slate-300' };

  let displayLabel: string;
  let displayAvatarUrl: string | undefined;
  let displayFallback: string;
  let displayBg: string;
  let displayTextClass: string;

  if (value === 'OPENCLAW' && agentId) {
    const matchedAgent = agents.find(a => a.id === agentId);
    displayLabel = matchedAgent ? getAgentLabel(matchedAgent, assistantName) : (agentId.charAt(0).toUpperCase() + agentId.slice(1));
    displayAvatarUrl = matchedAgent ? getSubAgentAvatarUrl(matchedAgent) : subAgentAvatars[agentId];
    if (agentId === 'main' && !displayAvatarUrl) {
      displayAvatarUrl = agentAvatars.OPENCLAW || undefined;
    }
    displayFallback = matchedAgent ? getAgentEmoji(matchedAgent) : (AGENT_IDENTITY_FALLBACK[agentId] || '🤖');
    displayBg = currentMeta.avatarBg;
    displayTextClass = currentMeta.avatarText;
  } else {
    displayLabel = value === 'OPENCLAW' && assistantName ? assistantName : currentMeta.label;
    displayAvatarUrl = agentAvatars[value] || undefined;
    displayFallback = displayAvatarUrl ? '' : currentMeta.initials;
    displayBg = currentMeta.avatarBg;
    displayTextClass = currentMeta.avatarText;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] text-slate-500 text-sm">
        <Loader2 size={14} className="animate-spin" />
        <span>Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* ── Agent Dropdown ──────────────────────────────────────── */}
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-sm text-slate-300 transition-colors"
        >
          <AvatarCircle
            src={displayAvatarUrl}
            fallback={displayFallback}
            size="sm"
            bgClass={displayBg}
            textClass={displayTextClass}
          />
          <span className="truncate max-w-[80px] sm:max-w-[160px]">{displayLabel}</span>
          <ChevronDown
            size={14}
            className={`text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {/* ── Dropdown Panel ──────────────────────────────────────── */}
        <DropdownSheet
          open={open}
          onClose={() => setOpen(false)}
          desktopClass="absolute top-full left-0 mt-1.5 w-72 rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden z-50"
        >
          <div className="max-h-[420px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
            {/* ── AGENTS Section ────────────────────────────────── */}
            <div className="px-3 pt-3 pb-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                <Users size={10} />
                Agents
              </div>
            </div>

            {providers.map((p) => {
              const meta = PROVIDER_META[p.name] || { emoji: '🤖', color: 'text-slate-400', label: p.displayName, initials: '??', avatarBg: 'bg-slate-600/20', avatarText: 'text-slate-300' };
              const isOpenClaw = p.name === 'OPENCLAW';
              const isSelectedProvider = p.name === value;
              const providerAvatarUrl = agentAvatars[p.name] || undefined;
              const isUsable = p.usable !== false;
              const statusLabel = !p.implemented
                ? 'Not implemented'
                : !p.installed
                  ? 'Not installed'
                  : p.native && p.nativeAuthStatus === 'needs_login'
                    ? 'Needs login'
                    : p.native
                      ? 'Native'
                      : 'Gateway';
              const detailLabel = p.nativeAuthMessage || p.reason || (p.version ? `Detected ${p.version}` : undefined);

              return (
                <div key={p.name}>
                  {isOpenClaw ? (
                    <button
                      onClick={() => isUsable && handleSelect('OPENCLAW', undefined)}
                      disabled={!isUsable}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                        !isUsable
                          ? 'text-slate-500 cursor-not-allowed opacity-60'
                          : isSelectedProvider && !agentId
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : 'text-slate-300 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <AvatarCircle
                        src={providerAvatarUrl}
                        fallback={meta.initials}
                        size="sm"
                        bgClass={meta.avatarBg}
                        textClass={meta.avatarText}
                      />
                      <div className="min-w-0 flex-1 text-left">
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${meta.color}`}>{assistantName || meta.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${isUsable ? 'border-emerald-500/30 text-emerald-300' : 'border-amber-500/30 text-amber-300'}`}>{statusLabel}</span>
                        </div>
                        {detailLabel && <div className="text-[10px] text-slate-500 truncate">{detailLabel}</div>}
                      </div>
                      {agentsLoading && (
                        <Loader2 size={11} className="text-slate-600 animate-spin ml-auto flex-shrink-0" />
                      )}
                      {isSelectedProvider && !agentId && isUsable && (
                        <Check size={14} className="text-emerald-400 flex-shrink-0" />
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => isUsable && handleSelect(p.name)}
                      disabled={!isUsable}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                        !isUsable
                          ? 'text-slate-500 cursor-not-allowed opacity-60'
                          : isSelectedProvider && !agentId
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : 'text-slate-300 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <AvatarCircle
                        src={providerAvatarUrl}
                        fallback={meta.initials}
                        size="sm"
                        bgClass={meta.avatarBg}
                        textClass={meta.avatarText}
                      />
                      <div className="flex-1 min-w-0 text-left">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{meta.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${isUsable ? 'border-sky-500/30 text-sky-300' : 'border-amber-500/30 text-amber-300'}`}>{statusLabel}</span>
                        </div>
                        {detailLabel && <div className="text-[10px] text-slate-500 truncate">{detailLabel}</div>}
                      </div>
                      {isSelectedProvider && !agentId && isUsable && (
                        <Check size={14} className="text-emerald-400" />
                      )}
                    </button>
                  )}

                  {isOpenClaw && agents.filter(a => a.id !== 'main').length > 0 && (
                    <div className="pb-1">
                      {agents.filter(a => a.id !== 'main').map((agent) => {
                        const isSelected = value === 'OPENCLAW' && agentId === agent.id;
                        const agentAvUrl = getSubAgentAvatarUrl(agent);
                        const resolvedAvUrl = agent.id === 'main' ? (agentAvUrl || agentAvatars.OPENCLAW || undefined) : agentAvUrl;
                        return (
                          <button
                            key={agent.id}
                            onClick={() => handleSelect('OPENCLAW', agent.id)}
                            className={`w-full flex items-center gap-2.5 pl-9 pr-4 py-2.5 text-sm transition-colors ${
                              isSelected
                                ? 'bg-emerald-500/10 text-emerald-300'
                                : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                            }`}
                          >
                            <AvatarCircle
                              src={resolvedAvUrl}
                              fallback={getAgentEmoji(agent)}
                              size="sm"
                              bgClass="bg-white/[0.06]"
                              textClass="text-slate-300"
                            />
                            <span className="flex-1 text-left">{getAgentLabel(agent, assistantName)}</span>
                            {agent.model && (
                              <span className="text-[10px] text-slate-600 font-mono truncate max-w-[80px]">
                                {getShortModelLabel(agent.model)}
                              </span>
                            )}
                            {isSelected && (
                              <Check size={13} className="text-emerald-400 flex-shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="h-1.5" />
          </div>
        </DropdownSheet>
      </div>

      {/* ── Sessions Dropdown (providers with session history) ───── */}
      {(value === 'OPENCLAW' || providers.find((p) => p.name === value)?.capabilities?.supportsSessionList) && onViewSession && (
        <SessionDropdown
          sessions={sessions}
          loading={sessionsLoading}
          hasLoaded={sessionsLoaded}
          open={sessionsOpen}
          onOpenChange={setSessionsOpen}
          onViewSession={handleSessionClick}
          providerLabel={displayLabel}
          currentSessionKey={currentSessionKey}
          currentSessionLabel={currentSessionLabel}
        />
      )}
    </div>
  );
}
