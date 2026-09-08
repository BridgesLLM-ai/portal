/**
 * AgentSelector — searchable agent directory, with each harness shown as
 * the engine beneath its agent identity. Conversations use a separate history button
 * for any harness that supports session listing.
 * Uses harness avatars from public appearance settings and sub-agent avatars
 * from authenticated operator settings or the authenticated agent catalog.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, Check, Users, Radio, Loader2, History, X, Search } from 'lucide-react';
import client from '../../api/client';
import { useAuthStore } from '../../contexts/AuthContext';
import { getShortModelLabel } from '../../utils/modelId';
import {
  formatAgentChatProviderCatalogLoadError,
  isAgentChatProviderCatalogAbortError,
  loadAgentChatProviderCatalog,
  type AgentChatHarnessCatalogEntry,
} from '../../utils/agentChatProviderCatalog';
import { sanitizeThinkingSubject } from '../../utils/thinkingSubject';
import AnchoredPopover from '../AnchoredPopover';

/* ─── Mobile Bottom Sheet wrapper ───────────────────────────────────────── */
/** Shared viewport-aware popover: anchored on desktop and modal bottom-sheet on mobile. */
function DropdownSheet({
  open,
  onClose,
  children,
  anchorRef,
  width,
  align,
  title,
  ariaLabel,
  closeLabel,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  anchorRef: React.RefObject<HTMLButtonElement>;
  width: number;
  align: 'start' | 'end';
  title: string;
  ariaLabel: string;
  closeLabel: string;
}) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const update = () => setIsMobile((window.visualViewport?.width || window.innerWidth) <= 767);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onDismiss={(reason) => {
        onClose();
        if (reason === 'escape') anchorRef.current?.focus();
      }}
      width={width}
      align={align}
      margin={12}
      mobileBreakpoint={767}
      zIndex={1300}
      ariaLabel={ariaLabel}
      className="max-h-[70dvh] overflow-hidden rounded-xl border border-white/[0.08] bg-[#1A1F3A] shadow-2xl shadow-black/50"
    >
      <div role="dialog" aria-label={ariaLabel} className="flex min-h-0 max-h-full flex-col overflow-hidden">
        {isMobile && (
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 pb-1.5 pt-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</span>
            <button type="button" aria-label={closeLabel} onClick={onClose} className="min-h-[36px] min-w-[36px] rounded-lg text-slate-500 hover:text-slate-300">
              <X size={14} className="mx-auto" />
            </button>
          </div>
        )}
        {children}
      </div>
    </AnchoredPopover>
  );
}

/* ─── Types ─────────────────────────────────────────────────────────────── */

type HarnessInfo = AgentChatHarnessCatalogEntry;

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
  /** Exact host-stream evidence for a currently running turn. */
  runActive?: boolean;
}

export interface AgentSelection {
  provider: string;
  agentId?: string;
}

interface AgentSelectorProps {
  value: string;
  agentId?: string;
  onChange: (selection: AgentSelection) => void;
  disabled?: boolean;
  onViewSession?: (sessionKey: string) => void;
  openConversationsRequest?: number;
  currentSessionKey?: string;
  currentSessionLabel?: string;
  currentSessionActive?: boolean;
  activityTitles?: Readonly<Record<string, string>>;
  agentAvatars?: Record<string, string>;
  subAgentAvatars?: Record<string, string>;
  assistantName?: string;
  defaultOpenClawAgentId?: string;
}

/* ─── Constants ─────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'agent-chat-provider';
const AGENT_STORAGE_KEY = 'agent-chat-agentId';
const AGENTS_CACHE_KEY = 'agent-chat-agents-cache';

/** Harness-level fallback colors / labels (used when no avatar image exists). */
const HARNESS_META: Record<string, { emoji: string; color: string; label: string; initials: string; avatarBg: string; avatarText: string }> = {
  OPENCLAW:    { emoji: '🟢', color: 'text-emerald-400', label: 'OpenClaw', initials: 'OC', avatarBg: 'bg-emerald-600/20', avatarText: 'text-emerald-300' },
  CLAUDE_CODE: { emoji: '🟣', color: 'text-violet-400',  label: 'Claude Code', initials: 'CL', avatarBg: 'bg-violet-600/20', avatarText: 'text-violet-300' },
  CODEX:       { emoji: '🔵', color: 'text-sky-400',     label: 'Codex', initials: 'CX', avatarBg: 'bg-sky-600/20', avatarText: 'text-sky-300' },
  GROK:        { emoji: '⚫', color: 'text-orange-300',  label: 'Grok Build', initials: 'GR', avatarBg: 'bg-orange-600/20', avatarText: 'text-orange-300' },
  AGENT_ZERO:  { emoji: '🟡', color: 'text-amber-400',   label: 'Agent Zero', initials: 'A0', avatarBg: 'bg-amber-600/20', avatarText: 'text-amber-300' },
  GEMINI:      { emoji: '🔷', color: 'text-cyan-400',    label: 'Antigravity', initials: 'AG', avatarBg: 'bg-cyan-600/20', avatarText: 'text-cyan-300' },
  OLLAMA:      { emoji: '🔴', color: 'text-rose-400',    label: 'Ollama', initials: 'OL', avatarBg: 'bg-rose-600/20', avatarText: 'text-rose-300' },
  HERMES:      { emoji: '🟠', color: 'text-amber-300',   label: 'Hermes', initials: 'HE', avatarBg: 'bg-amber-600/20', avatarText: 'text-amber-200' },
  OPENCODE:    { emoji: '🟦', color: 'text-indigo-300',  label: 'OpenCode', initials: 'OP', avatarBg: 'bg-indigo-600/20', avatarText: 'text-indigo-200' },
  DEEPSEEK_HARNESS: { emoji: '🔷', color: 'text-blue-300', label: 'DeepSeek Harness', initials: 'DS', avatarBg: 'bg-blue-600/20', avatarText: 'text-blue-200' },
};

/** Default identity emojis for well-known agent names */
const AGENT_IDENTITY_FALLBACK: Record<string, string> = {
  main:    '🤖',
  parity:  '🔬',
  kernel:  '🛠️',
  isotype: '🧬',
};

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/** The agent Agent Chat shows when no sub-agent is selected. */
const DEFAULT_OPENCLAW_AGENT_ID = 'main';

function normalizeOpenClawAgentId(rawAgentId?: string | null): string | undefined {
  const value = String(rawAgentId || '').trim();
  return value && value !== 'main' ? value : undefined;
}

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

function getHarnessSummary(harness: HarnessInfo): string {
  if (harness.releaseStage === 'developer-preview' || harness.releaseStage === 'planned') {
    return 'Preview — not available for chat in this release.';
  }
  if (harness.checking || harness.availabilityState === 'checking') return 'Checking your connection…';
  if (harness.nativeAuthStatus === 'needs_login') return `Connect your ${harness.displayName} account in Model Providers.`;
  if (harness.installed === false) return 'Set up this harness in Agent Tools to get started.';
  if (harness.usable) {
    if ((harness.harnessId || harness.name) === 'OPENCLAW') return 'Your agents, tools, and conversations through OpenClaw.';
    if ((harness.harnessId || harness.name) === 'OLLAMA') return 'Chat with a model running on your own hardware.';
    return 'Connected and available in Portal.';
  }
  return 'Connection unavailable. Check Model Providers for details.';
}

function getHarnessStatusLabel(harness: HarnessInfo): string {
  if (harness.releaseStage === 'developer-preview') return 'Developer Preview';
  if (harness.releaseStage === 'planned' && harness.selectable === false) return 'Planned';
  if (harness.availabilityState === 'checking') return 'Checking';
  if (harness.availabilityState === 'stale') {
    return harness.checking ? 'Rechecking' : 'Stale';
  }
  if (harness.availabilityState === 'error') return 'Unavailable';
  if (harness.selectable === false) return 'Unavailable';
  if (!harness.implemented) return 'Not implemented';
  if (!harness.installed) return 'Not installed';
  if (harness.native && harness.nativeAuthStatus === 'needs_login') return 'Needs login';
  if (harness.usable && (harness.harnessId || harness.name) === 'OPENCLAW') return 'Gateway online';
  return harness.usable ? 'Ready' : 'Unavailable';
}

function formatNewSessionSlug(slug: string): string | null {
  const match = slug.match(/^(?:portal-)?new-(\d{13,})$/i);
  if (!match) return null;
  const timestamp = Number(match[1]);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'New chat';
  return `New chat · ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function getSessionKey(s: GatewaySession): string {
  return s.key || s.sessionId || s.id || '';
}

function getSessionLabel(s: GatewaySession, rawActivityTitle?: unknown): string {
  const activityTitle = sanitizeThinkingSubject(rawActivityTitle);
  if (activityTitle) return activityTitle;

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

  const newSessionLabel = formatNewSessionSlug(sessionName);
  if (newSessionLabel) {
    return agentName === 'main' ? newSessionLabel : `${agentName} / ${newSessionLabel}`;
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
  error = null,
  onRetry,
  open,
  onOpenChange,
  onViewSession,
  providerLabel,
  currentSessionKey,
  currentSessionLabel,
  currentSessionActive,
  activityTitles = {},
  disabled = false,
}: {
  sessions: GatewaySession[];
  loading?: boolean;
  hasLoaded?: boolean;
  error?: string | null;
  onRetry?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewSession: (sessionKey: string) => void;
  providerLabel: string;
  currentSessionKey?: string;
  currentSessionLabel?: string;
  currentSessionActive?: boolean;
  activityTitles?: Readonly<Record<string, string>>;
  disabled?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);

  useEffect(() => { setVisibleCount(20); }, [query, runningOnly]);

  const sessionHasActiveRun = (session: GatewaySession): boolean => {
    const key = getSessionKey(session);
    if (key && key === currentSessionKey && typeof currentSessionActive === 'boolean') {
      return currentSessionActive;
    }
    return session.runActive === true || Boolean(key && activityTitles[key]);
  };
  const runningSessions = sessions.filter(sessionHasActiveRun);
  const otherSessions = sessions.filter((session) => !sessionHasActiveRun(session));
  const search = query.trim().toLocaleLowerCase();
  const matchingSessions = [...runningSessions, ...(runningOnly ? [] : otherSessions)]
    .filter((session) => {
      const key = getSessionKey(session);
      return key && (!search || [
        getSessionLabel(session, activityTitles[key]), session.title,
        session.preview, key, session.channel,
      ].some((value) => typeof value === 'string' && value.toLocaleLowerCase().includes(search)));
    });
  const visibleSessions = matchingSessions.slice(0, visibleCount);
  const hasActiveRun = currentSessionActive === true || runningSessions.length > 0;
  const countLabel = loading && sessions.length === 0 ? '…' : hasLoaded ? String(sessions.length) : '—';
  const matchedCurrentSession = currentSessionKey
    ? sessions.find((session) => getSessionKey(session) === currentSessionKey)
    : null;
  const currentActivityTitle = currentSessionKey
    ? activityTitles[currentSessionKey]
    : undefined;
  const fallbackCurrentLabel = currentSessionKey
    ? getSessionLabel({ key: currentSessionKey }, currentActivityTitle)
    : '';
  const headerLabel = currentActivityTitle
    ? getSessionLabel(matchedCurrentSession || { key: currentSessionKey }, currentActivityTitle)
    : typeof currentSessionLabel === 'string' && currentSessionLabel.trim()
      ? currentSessionLabel.trim()
      : matchedCurrentSession
        ? getSessionLabel(matchedCurrentSession)
      : (fallbackCurrentLabel || (hasLoaded ? 'History' : 'Chat history'));

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => { if (!disabled) onOpenChange(!open); }}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-slate-500 hover:text-slate-300 transition-colors min-w-0 max-w-[180px] disabled:cursor-wait disabled:opacity-50"
        title={`${providerLabel} sessions`}
      >
        <History size={12} />
        <span className="inline truncate max-w-[160px] sm:max-w-none">{headerLabel}</span>
        {(loading || hasLoaded) && (
          <span className="hidden sm:inline-flex items-center gap-1 tabular-nums rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
            {loading ? <Loader2 size={9} className="animate-spin text-sky-400" /> : null}
            {countLabel}
          </span>
        )}
        {hasActiveRun && (
          <span
            aria-label={`${providerLabel} has an active turn`}
            title={`${providerLabel} has an active turn`}
            className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"
          />
        )}
        <ChevronDown
          size={11}
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''} hidden sm:block`}
        />
      </button>

      <DropdownSheet
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        width={384}
        align="end"
        title="Conversations"
        ariaLabel={`${providerLabel} sessions`}
        closeLabel="Close session selector"
      >
        <div className="border-b border-white/[0.06] p-3 space-y-2">
          <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-slate-400">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search sessions"
              placeholder="Search titles, messages, or session IDs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-slate-500 outline-none"
            />
          </label>
          <div className="flex items-center justify-between gap-2 text-xs">
            <button type="button" aria-pressed={runningOnly} onClick={() => setRunningOnly((value) => !value)}
              className={`min-h-[32px] rounded-lg border px-2.5 ${runningOnly ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' : 'border-white/10 text-slate-400 hover:text-white'}`}>
              Running only
            </button>
            <span className="text-slate-400" aria-live="polite">
              {hasLoaded ? `${matchingSessions.length} matching session${matchingSessions.length === 1 ? '' : 's'}` : 'History not loaded'}
            </span>
          </div>
        </div>
        <div className="min-h-0 max-h-[380px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              <Radio size={10} className="text-emerald-400" />
              {providerLabel} Conversations
              <span className="ml-auto text-[9px] bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded-full font-medium tabular-nums">
                {countLabel}
              </span>
            </div>
          </div>

          {loading && (
            <div className="mx-3 mb-2 rounded-lg border border-sky-400/15 bg-sky-500/10 px-3 py-2 text-xs text-sky-100 flex items-center gap-2">
              <Loader2 size={12} className="animate-spin text-sky-300" />
              <span>{sessions.length === 0 ? 'Loading session history…' : 'Refreshing session history…'}</span>
            </div>
          )}

          {!loading && error && (
            <div className="mx-3 mb-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100" role="alert">
              <div>{error}</div>
              {onRetry && (
                <button type="button" onClick={onRetry} className="mt-2 min-h-[34px] rounded-lg border border-amber-300/20 bg-amber-500/10 px-2.5 text-[11px] font-medium text-amber-50 hover:bg-amber-500/20">
                  Retry session history
                </button>
              )}
            </div>
          )}

          {!loading && !error && sessions.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-500">
              No recent sessions yet.
            </div>
          )}

          {!loading && !error && sessions.length > 0 && matchingSessions.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-400">
              {search ? 'No sessions match your search.' : 'No running sessions.'}
            </div>
          )}

          {visibleSessions.map((session) => {
            const key = getSessionKey(session);
            const label = getSessionLabel(session, activityTitles[key]);
            const running = sessionHasActiveRun(session);
            const selected = key === currentSessionKey;
            return (
              <button
                type="button"
                key={key}
                aria-current={selected ? 'page' : undefined}
                title={label}
                onClick={() => { onViewSession(key); onOpenChange(false); }}
                className={`w-full flex items-center gap-2.5 px-4 py-3 text-sm transition-colors ${selected ? 'bg-sky-500/10 text-sky-100' : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'}`}
              >
                <span
                  aria-label={running ? `${label} has an active turn` : undefined}
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${running ? 'bg-emerald-400 motion-safe:animate-pulse' : 'bg-slate-600'}`}
                />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium">{label}</span>
                  {session.preview && session.preview !== label && (
                    <span className="block truncate mt-0.5 text-[11px] text-slate-400">{session.preview}</span>
                  )}
                  {session.channel && <span className="block text-[10px] text-slate-500">{session.channel}</span>}
                </span>
                <span className="text-[10px] text-slate-400 flex-shrink-0">
                  {formatTime(session.lastActivityAt || session.createdAt)}
                </span>
                {selected && <Check size={12} aria-label="Current session" />}
              </button>
            );
          })}

          {matchingSessions.length > visibleCount && (
            <button type="button" onClick={() => setVisibleCount((count) => count + 20)}
              className="w-full min-h-[40px] border-t border-white/[0.06] text-xs text-sky-300 hover:bg-white/[0.04]">
              Show more sessions ({matchingSessions.length - visibleCount} remaining)
            </button>
          )}

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
  currentSessionActive,
  activityTitles = {},
  agentAvatars = {},
  subAgentAvatars = {},
  assistantName,
  disabled = false,
  openConversationsRequest = 0,
}: AgentSelectorProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [providers, setProviders] = useState<HarnessInfo[]>([]);
  const [agents, setAgents] = useState<OpenClawAgent[]>([]);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [open, setOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState('');
  useEffect(() => { if (!open) setAgentQuery(''); }, [open]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsLoadError, setSessionsLoadError] = useState<string | null>(null);
  const [sessionsRefreshNonce, setSessionsRefreshNonce] = useState(0);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [providerRefreshNonce, setProviderRefreshNonce] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sessionCacheRef = useRef(new Map<string, GatewaySession[]>());
  const lastProviderRetryRef = useRef(0);
  const selectedProviderSessionCapability = value === 'OPENCLAW'
    ? true
    : providers.find((harness) => harness.harnessId === value || harness.name === value)?.capabilities?.supportsSessionList;
  // The catalog is advisory while absent, loading, or failed. Only an explicit
  // false suppresses history; otherwise the sessions endpoint is authoritative.
  const canAttemptSessionList = selectedProviderSessionCapability !== false;

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setSessionsOpen(false);
  }, [disabled]);

  const lastConversationsRequestRef = useRef(openConversationsRequest);
  useEffect(() => {
    if (lastConversationsRequestRef.current === openConversationsRequest) return;
    lastConversationsRequestRef.current = openConversationsRequest;
    if (disabled || !canAttemptSessionList) return;
    setOpen(false);
    setSessionsOpen(true);
  }, [openConversationsRequest, disabled, canAttemptSessionList]);

  // Fetch harnesses when the selector opens. A selected native harness also
  // needs its capability row on first paint so session history is not hidden
  // until the user happens to open the unrelated harness selector.
  useEffect(() => {
    const needsSelectedProviderCapabilities = Boolean(onViewSession) && value !== 'OPENCLAW';
    if ((!open && !needsSelectedProviderCapabilities) || disabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const force = providerRefreshNonce > lastProviderRetryRef.current;
    if (force) lastProviderRetryRef.current = providerRefreshNonce;
    setLoading(true);
    async function fetchProviders() {
      try {
        const providerRows = await loadAgentChatProviderCatalog({
          force,
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            if (!cancelled) {
              setProviders(snapshot);
              setProviderLoadError(null);
            }
          },
        });
        if (!cancelled) {
          setProviders(providerRows);
        }
      } catch (error) {
        if (!cancelled && !isAgentChatProviderCatalogAbortError(error)) {
          setProviderLoadError(formatAgentChatProviderCatalogLoadError(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchProviders();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [disabled, open, onViewSession, providerRefreshNonce, value]);

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
    if (!open || disabled) return () => { cancelled = true; };

    void fetchAgents();
    return () => { cancelled = true; };
  }, [disabled, open]);

  // Fetch session lists only when the session picker is opened.
  // The chat header stays usable without this metadata, so we avoid paying
  // for hidden session-list requests on every Agent Chat page open.
  useEffect(() => {
    if (!canAttemptSessionList || !isAuthenticated) {
      setSessions([]);
      setSessionsLoading(false);
      setSessionsLoaded(false);
      setSessionsLoadError(null);
      return;
    }
    const shouldFetchSessions = sessionsOpen || Boolean(currentSessionKey);
    if (!shouldFetchSessions) return;
    let cancelled = false;
    const scopeKey = value === 'OPENCLAW'
      ? `OPENCLAW:${normalizeOpenClawAgentId(agentId) || DEFAULT_OPENCLAW_AGENT_ID}`
      : value;
    const cached = sessionCacheRef.current.get(scopeKey);
    setSessions(cached || []);
    setSessionsLoaded(Boolean(cached));
    setSessionsLoadError(null);
    async function fetchSessions() {
      if (!cancelled) setSessionsLoading(true);
      try {
        const params: Record<string, string> = {};
        if (value === 'OPENCLAW') {
          // Always name the agent, including the default one. Omitting it
          // asked the server for every agent's sessions at once, so going
          // back to the main agent replaced its history with a mixed list
          // that other agents' chats leaked into.
          params.agentId = normalizeOpenClawAgentId(agentId) || DEFAULT_OPENCLAW_AGENT_ID;
        } else {
          params.provider = value;
        }
        const { data } = await client.get('/gateway/sessions', {
          params,
          _silent: true,
        } as any);
        const list = data.sessions || [];
        if (!cancelled) {
          const normalized = (Array.isArray(list) ? list : Object.values(list)) as GatewaySession[];
          sessionCacheRef.current.set(scopeKey, normalized);
          setSessions(normalized);
          setSessionsLoaded(true);
          setSessionsLoadError(null);
        }
      } catch {
        if (!cancelled) {
          setSessionsLoaded(true);
          setSessionsLoadError('Session history could not be refreshed. Previously loaded sessions remain available.');
        }
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    }
    void fetchSessions();
    const interval = setInterval(fetchSessions, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [value, agentId, canAttemptSessionList, sessionsOpen, currentSessionKey, isAuthenticated, sessionsRefreshNonce]);

  const handleSelect = useCallback((provider: string, selectedAgentId?: string) => {
    if (disabled) return;
    const normalizedAgentId = provider === 'OPENCLAW'
      ? normalizeOpenClawAgentId(selectedAgentId)
      : undefined;
    onChange({ provider, agentId: normalizedAgentId });
    localStorage.setItem(STORAGE_KEY, provider);
    if (normalizedAgentId) {
      localStorage.setItem(AGENT_STORAGE_KEY, normalizedAgentId);
    } else {
      localStorage.removeItem(AGENT_STORAGE_KEY);
    }
    setOpen(false);
  }, [disabled, onChange]);

  const handleSessionClick = useCallback((sessionKey: string) => {
    if (disabled) return;
    if (onViewSession) {
      onViewSession(sessionKey);
    }
  }, [disabled, onViewSession]);

  // Resolve avatar URL for a given agent
  function getSubAgentAvatarUrl(agent: OpenClawAgent): string | undefined {
    if (agent.avatarUrl) return agent.avatarUrl;
    return subAgentAvatars[agent.id] || undefined;
  }

  // Determine display for current selection
  const currentMeta = HARNESS_META[value] || { emoji: '🤖', color: 'text-slate-400', label: value, initials: '??', avatarBg: 'bg-slate-600/20', avatarText: 'text-slate-300' };

  let displayLabel: string;
  let displayAvatarUrl: string | undefined;
  let displayFallback: string;
  let displayBg: string;
  let displayTextClass: string;

  const effectiveAgentId = value === 'OPENCLAW' ? normalizeOpenClawAgentId(agentId) : undefined;
  const openClawAgents = agents.filter((agent) => agent.id !== 'main');
  const hasOpenClawProvider = providers.some((harness) => (
    harness.harnessId === 'OPENCLAW' || harness.name === 'OPENCLAW'
  ));

  if (value === 'OPENCLAW' && effectiveAgentId) {
    const matchedAgent = agents.find(a => a.id === effectiveAgentId);
    displayLabel = matchedAgent ? getAgentLabel(matchedAgent, assistantName) : (effectiveAgentId.charAt(0).toUpperCase() + effectiveAgentId.slice(1));
    displayAvatarUrl = matchedAgent ? getSubAgentAvatarUrl(matchedAgent) : subAgentAvatars[effectiveAgentId];
    displayFallback = matchedAgent ? getAgentEmoji(matchedAgent) : (AGENT_IDENTITY_FALLBACK[effectiveAgentId] || '🤖');
    displayBg = currentMeta.avatarBg;
    displayTextClass = currentMeta.avatarText;
  } else {
    displayLabel = value === 'OPENCLAW' && assistantName ? assistantName : currentMeta.label;
    displayAvatarUrl = agentAvatars[value] || undefined;
    displayFallback = displayAvatarUrl ? '' : currentMeta.initials;
    displayBg = currentMeta.avatarBg;
    displayTextClass = currentMeta.avatarText;
  }

  const renderProvider = (p: HarnessInfo) => {
              const harnessId = p.harnessId || p.name;
              const meta = HARNESS_META[harnessId] || { emoji: '🤖', color: 'text-slate-400', label: p.displayName, initials: '??', avatarBg: 'bg-slate-600/20', avatarText: 'text-slate-300' };
              const isOpenClaw = harnessId === 'OPENCLAW';
              const isSelectedProvider = harnessId === value || p.name === value;
              const providerAvatarUrl = agentAvatars[harnessId] || agentAvatars[p.name] || undefined;
              const availabilityUnsettled = p.checking === true
                || p.stale === true
                || p.availabilityState === 'checking'
                || p.availabilityState === 'stale'
                || p.availabilityState === 'error';
              const catalogSelectable = p.selectable !== false && p.implemented !== false;
              const isUsable = catalogSelectable && !providerLoadError && !availabilityUnsettled && p.usable === true;
              // Moving between OpenClaw sub-agents does not select a different
              // harness. Keep that path available during a transient recheck,
              // but never override an explicit non-selectable catalog row.
              const canSelect = isUsable || (isOpenClaw && value === 'OPENCLAW' && catalogSelectable);
              const statusLabel = getHarnessStatusLabel(p);
              const detailLabel = getHarnessSummary(p);

              return (
                <div key={harnessId}>
                  {isOpenClaw ? (
                    // The default agent stays selectable whenever its own
                    // sub-agents are, which is any time the selector is not
                    // disabled. Gating this row on availability alone made
                    // returning from a sub-agent to the main agent silently
                    // do nothing while a routine availability recheck was in
                    // flight, because the sub-agent rows below never had
                    // that gate. The status pill still reports the state.
                    <button
                      onClick={() => canSelect && handleSelect('OPENCLAW', undefined)}
                      disabled={disabled || !canSelect}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                        isSelectedProvider && !effectiveAgentId
                          ? 'accent-active'
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
                        <div className="text-[10px] text-slate-500 truncate">{meta.label} · {isOpenClaw ? 'Main agent' : 'Default assistant'}</div>{detailLabel && <div className="text-[10px] text-slate-500 truncate">{detailLabel}</div>}
                      </div>
                      {agentsLoading && (
                        <Loader2 size={11} className="text-slate-600 animate-spin ml-auto flex-shrink-0" />
                      )}
                      {isSelectedProvider && !effectiveAgentId && (
                        <Check size={14} className="accent-text flex-shrink-0" />
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => canSelect && handleSelect(harnessId)}
                      disabled={disabled || !canSelect}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                        !isUsable
                          ? 'text-slate-500 cursor-not-allowed opacity-60'
                          : isSelectedProvider && !effectiveAgentId
                            ? 'accent-active'
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
                        <div className="text-[10px] text-slate-500 truncate">{meta.label} · {isOpenClaw ? 'Main agent' : 'Default assistant'}</div>{detailLabel && <div className="text-[10px] text-slate-500 truncate">{detailLabel}</div>}
                      </div>
                      {isSelectedProvider && !effectiveAgentId && isUsable && (
                        <Check size={14} className="accent-text" />
                      )}
                    </button>
                  )}

                </div>
              );
  };

  const openClawProvider = providers.find((entry) => (entry.harnessId || entry.name) === 'OPENCLAW');
  const canSelectOpenClawAgent = Boolean(openClawProvider && openClawProvider.selectable !== false
    && openClawProvider.implemented !== false && (value === 'OPENCLAW' || (!providerLoadError
      && openClawProvider.usable === true && !openClawProvider.checking && !openClawProvider.stale
      && !['checking', 'stale', 'error'].includes(openClawProvider.availabilityState || ''))));
  const directory = [
    ...providers.map((entry) => {
      const harness = entry.harnessId || entry.name;
      const label = harness === 'OPENCLAW' ? assistantName || 'OpenClaw' : HARNESS_META[harness]?.label || entry.displayName;
      return { key: harness, label, search: `${label} ${harness} ${entry.displayName}`, render: () => renderProvider(entry) };
    }),
    ...(hasOpenClawProvider ? openClawAgents.map((agent) => ({
      key: `OPENCLAW:${agent.id}`, label: getAgentLabel(agent, assistantName),
      search: `${getAgentLabel(agent, assistantName)} ${agent.id} OpenClaw ${agent.model || ''}`,
      render: () => <button key={agent.id} type="button" disabled={disabled || !canSelectOpenClawAgent}
        onClick={() => handleSelect('OPENCLAW', agent.id)}
        className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-sm transition-colors disabled:opacity-50 ${value === 'OPENCLAW' && effectiveAgentId === agent.id ? 'accent-active' : 'text-slate-300 hover:bg-white/[0.04]'}`}>
        <AvatarCircle src={getSubAgentAvatarUrl(agent)} fallback={getAgentEmoji(agent)} size="sm" bgClass="bg-white/[0.06]" textClass="text-slate-300" />
        <span className="min-w-0 flex-1 text-left"><span className="block truncate font-medium">{getAgentLabel(agent, assistantName)}</span>
          <span className="block truncate text-[10px] text-slate-500">OpenClaw · Configured agent{agent.model ? ` · ${getShortModelLabel(agent.model)}` : ''}</span></span>
        {value === 'OPENCLAW' && effectiveAgentId === agent.id && <Check size={13} className="accent-text shrink-0" />}
      </button>,
    })) : []),
  ].filter((entry) => entry.search.toLowerCase().includes(agentQuery.trim().toLowerCase()))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex items-center gap-1.5">
      {/* ── Agent Dropdown ──────────────────────────────────────── */}
      <div className="relative">
        <button
          ref={triggerRef}
          onClick={() => { if (!disabled) setOpen(!open); }}
          disabled={disabled}
          aria-label="Choose agent"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-sm text-slate-300 transition-colors disabled:cursor-wait disabled:opacity-50"
        >
          <AvatarCircle
            src={displayAvatarUrl}
            fallback={displayFallback}
            size="sm"
            bgClass={displayBg}
            textClass={displayTextClass}
          />
          <span className="min-w-0 max-w-[100px] text-left sm:max-w-[160px]"><span className="block truncate">{displayLabel}</span><span className="block truncate text-[9px] leading-tight text-slate-500">{currentMeta.label}</span></span>
          {loading ? (
            <Loader2 size={13} className="animate-spin text-sky-400" />
          ) : (
            <ChevronDown
              size={14}
              className={`text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            />
          )}
        </button>

        {/* ── Dropdown Panel ──────────────────────────────────────── */}
        <DropdownSheet
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          width={336}
          align="start"
          title="Talk to…"
          ariaLabel="Choose an agent"
          closeLabel="Close agent picker"
        >
          <div className="shrink-0 border-b border-white/10 p-3">
            <p className="mb-2 text-sm font-medium text-white">Talk to…</p>
            <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-slate-400">
              <Search size={14} /><input type="search" aria-label="Find an agent" placeholder="Search agents or harnesses…" value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none" />
            </label>
          </div>
          <div className="min-h-0 max-h-[420px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
            {/* ── HARNESSES Section ────────────────────────────────── */}
            <div className="px-3 pt-3 pb-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                <Users size={10} />
                Agents & assistants
              </div>
            </div>

            {loading && (
              <div className="mx-3 mb-2 rounded-lg border border-sky-400/15 bg-sky-500/10 px-3 py-2 text-xs text-sky-100 flex items-center gap-2">
                <Loader2 size={12} className="animate-spin text-sky-300" />
                <span>Loading available harnesses and agents…</span>
              </div>
            )}

            {!loading && providerLoadError && (
              <div
                role="alert"
                className="mx-3 mb-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
              >
                <div>
                  {providers.length > 0
                    ? `Couldn’t refresh harnesses. Showing the last available list. ${providerLoadError}`
                    : `Couldn’t load harnesses. Your current selection is unchanged. ${providerLoadError}`}
                </div>
                <button
                  type="button"
                  onClick={() => setProviderRefreshNonce((nonce) => nonce + 1)}
                  disabled={disabled}
                  className="mt-2 rounded-md border border-amber-300/30 bg-amber-400/10 px-2 py-1 font-medium text-amber-100 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Retry loading harnesses
                </button>
              </div>
            )}

            {!loading && !providerLoadError && providers.length === 0 && (
              <div className="px-4 py-4 text-xs text-slate-500">
                No harnesses returned yet. Try refresh if this stays empty.
              </div>
            )}

            {directory.map((entry) => <div key={entry.key}>{entry.render()}</div>)}
            {!loading && !providerLoadError && providers.length > 0 && directory.length === 0 && <p className="px-4 py-6 text-xs text-slate-400">No agents match this search.</p>}


            <div className="h-1.5" />
          </div>
        </DropdownSheet>
      </div>

      {/* ── Sessions Dropdown (harnesses with session history) ───── */}
      {canAttemptSessionList && onViewSession && (
        <SessionDropdown
          key={`${value}:${agentId || DEFAULT_OPENCLAW_AGENT_ID}`}
          sessions={sessions}
          loading={sessionsLoading}
          hasLoaded={sessionsLoaded}
          error={sessionsLoadError}
          onRetry={() => setSessionsRefreshNonce((current) => current + 1)}
          open={sessionsOpen}
          onOpenChange={setSessionsOpen}
          onViewSession={handleSessionClick}
          providerLabel={displayLabel}
          currentSessionKey={currentSessionKey}
          currentSessionLabel={currentSessionLabel}
          currentSessionActive={currentSessionActive}
          activityTitles={activityTitles}
          disabled={disabled}
        />
      )}
    </div>
  );
}
