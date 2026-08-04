/**
 * ChatInterface — iMessage-style chat with per-agent contacts.
 *
 * Pass 2 fixes:
 * 1. Real-time message rendering — replaced broken counter-based
 *    ThreadPrimitive.Messages with direct messages.map() rendering
 * 2. Smart scroll-to-bottom button (only shown when scrolled up)
 * 3. Dictation / Speech-to-text button
 * 4. File attachment button with chip previews
 * 5. Stream status shown through the shared status rail
 * 6. Tool use as centered iMessage-style system notification pills
 */
import { AskQuestionCard, AskQuestionAnswerProvider, parseAskQuestionPayload, useAskQuestionAnswer } from './AskQuestionCard';
import AskUserQuestionCard from './AskUserQuestionCard';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  ComposerPrimitive,
} from '@assistant-ui/react';
import { useAgentRuntime, type ChatMessage, type ToolCall } from './useAgentRuntime';
import { useChatState, type OpenClawSessionTelemetry, type SessionControlMutationKind } from '../../contexts/ChatStateProvider';
import { useExecApprovals } from './useExecApprovals';
import { ExecApprovalModal } from './ExecApprovalModal';
import MarkdownRenderer, { type HostFileLinkContext } from './MarkdownRenderer';
import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import {
  Send, StopCircle, Pencil, Settings, X, ChevronDown,
  Check, RefreshCw, Wrench, Loader2, CheckCircle2, XCircle, ShieldAlert, Radio,
  Sparkles, Copy, RotateCcw, MessageSquare, Code2, Bug, ChevronRight, Clock,
  Paperclip, Mic, PenSquare, Layers3, Settings2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import AgentSelector, { type AgentSelection } from './AgentSelector';
import ImagePickerCropper from '../ImagePickerCropper';
import AnchoredPopover from '../AnchoredPopover';
import ViewportModal from '../ViewportModal';
import TypedConfirmationDialog from '../TypedConfirmationDialog';
import AiProviderSetup from '../ai-setup/AiProviderSetup';
import { useAuthStore } from '../../contexts/AuthContext';
import { isElevated, isOwner } from '../../utils/authz';
import { workspaceAuthorizedFetch } from '../../utils/workspaceAuthorizedFetch';
import { buildPersistedChatAttachmentText } from '../../utils/chatAttachmentPersistence';
import {
  agentToolsAPI,
  toolInstallConfirmationPhrase,
  waitForToolInstallJob,
  type AgentTool,
} from '../../api/agentTools';
import { gatewayAPI, type CompatibilityHotfixStatus } from '../../api/endpoints';
import SlashCommandMenu from './SlashCommandMenu';
import { matchSlashCommands, type SlashCommand } from '../../utils/slashCommands';
import { mergeExecApprovalQueues } from '../../utils/execApprovalQueue';
import { executeSlashCommand } from '../../utils/slashCommandExecutor';
import {
  createLocalSlashCommandCoordinator,
  type LocalSlashCommandEvent,
} from '../../utils/localSlashCommandClaim';
import client from '../../api/client';
import sounds from '../../utils/sounds';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useUserAvatarUrl } from '../../hooks/useUserAvatarUrl';
import {
  canonicalizePortalModelId,
  getModelDisplayName,
  getModelIdBadge,
  getModelProviderLabel,
  getModelRuntimeLabel,
  getShortModelLabel,
  isKnownOpenClawCatalogModelId,
} from '../../utils/modelId';
import ComposerStatusBadge from './ComposerStatusBadge';
import CompactionNoticeBlock from './CompactionNoticeBlock';
import ToolGlyph from './ToolGlyph';
import { getToolPresentation, getToolSummary, isAskQuestionTool, isCompactionNotice } from '../../utils/toolPresentation';
import { anchoredScrollTop, selectNewestWindow } from '../../utils/timelineWindow';
import { supportsAgentChatStop } from '../../utils/agentChatRunLifecycle';
import {
  isAgentZeroDefaultModelAlias,
  normalizeAgentChatModelCatalog,
  normalizeAgentChatProvider,
  resolveAgentZeroCatalogModel,
} from '../../utils/agentChatModelSelection';
import {
  createAgentChatProviderModelRequestGate,
  getAgentChatProviderModelsCache,
  invalidateAgentChatProviderModelsCache,
  setAgentChatProviderModelsCache,
} from '../../utils/agentChatProviderModelsCache';
import {
  assessAgentChatProviderAvailability,
  formatAgentChatProviderCatalogLoadError,
  isAgentChatSelectedProviderRevalidationPending,
  isAgentChatProviderCatalogAbortError,
  loadAgentChatProviderCatalog,
  reduceAgentChatSelectedProviderRevalidation,
  type AgentChatProviderAvailabilityAssessment,
  type AgentChatProviderCatalogEntry,
  type AgentChatProviderCatalogSnapshotMetadata,
  type AgentChatSelectedProviderRevalidationState,
} from '../../utils/agentChatProviderCatalog';
import { isAgentChatLaunchBoundModelError } from '../../utils/agentChatModelSwitch';
import { reconcileCumulativeFinalTail } from '../../utils/chatStream';

const MESSAGE_WINDOW_SIZE = 80;
const TOOL_WINDOW_SIZE = 40;
const LazyAgentZeroSetupPanel = React.lazy(() => import('../settings/AgentZeroSetupPanel'));

function downloadChatMarkdown(messages: ChatMessage[]) {
  const markdown = messages
    .map((message) => `## ${message.role}\n\n${message.content || ''}`)
    .join('\n\n');
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `chat-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

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
    name: 'Grok Build',
    initials: 'GR',
    providerName: 'GROK',
    color: 'text-orange-300',
    bgLight: 'bg-orange-500/[0.06]',
    borderColor: 'border-orange-500/15',
    avatarBg: 'bg-orange-600/20',
    avatarText: 'text-orange-300',
    accentRing: 'focus:ring-orange-500/40 focus:border-orange-500/30',
    sendBg: 'bg-orange-500',
    sendHover: 'hover:bg-orange-600',
    sendShadow: 'shadow-orange-500/20',
    provenance: 'via Grok Build CLI',
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
    name: 'Antigravity',
    initials: 'AG',
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
    provenance: 'via Antigravity',
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

function normalizeOpenClawAgentSelection(providerName: string, rawAgentId?: string | null): string | undefined {
  if (providerName !== 'OPENCLAW') return undefined;
  const agentId = String(rawAgentId || '').trim();
  return agentId && agentId !== 'main' ? agentId : undefined;
}

export function planAgentChatSelection(
  currentProvider: string,
  currentAgentId: string | undefined,
  selection: AgentSelection,
) {
  const providerChanged = selection.provider !== currentProvider;
  const nextAgentId = normalizeOpenClawAgentSelection(selection.provider, selection.agentId);
  const currentNormalizedAgentId = normalizeOpenClawAgentSelection(currentProvider, currentAgentId);
  const agentChanged = nextAgentId !== currentNormalizedAgentId;
  return {
    changed: providerChanged || agentChanged,
    providerChanged,
    nextAgentId,
  };
}

/* ─── Provider model catalogs ───────────────────────────────────────────── */

const OPENCLAW_MODEL_FALLBACK = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'anthropic/claude-fable-5',
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-haiku-4-5',
];

function isKnownOpenClawCatalogModel(modelId: string): boolean {
  return isKnownOpenClawCatalogModelId(modelId);
}

function modelDisplayName(modelId: string): string {
  return getModelDisplayName(modelId, modelId || 'Default model');
}

function modelSelectionErrorMessage(error: any, fallback: string): string {
  const extractText = (value: unknown, depth = 0): string => {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object' || depth > 3) return '';
    const record = value as Record<string, unknown>;
    for (const key of ['userMessage', 'message', 'detail', 'error', 'reason']) {
      const nested = extractText(record[key], depth + 1);
      if (nested) return nested;
    }
    return '';
  };
  const raw = (
    extractText(error?.response?.data)
    || extractText(error)
    || fallback
  ).replace(/\s+/g, ' ').trim();
  return raw.length > 280 ? `${raw.slice(0, 277)}…` : raw;
}

function ModelMeta({ modelId, compact = false }: { modelId: string; compact?: boolean }) {
  const provider = getModelProviderLabel(modelId);
  const runtime = getModelRuntimeLabel(modelId);
  const canonicalId = getModelIdBadge(modelId);

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`${compact ? 'text-[11px]' : 'text-xs'} font-medium text-left truncate`}>{modelDisplayName(modelId)}</span>
        {!compact && provider ? <span className="px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300 text-[9px] uppercase tracking-wide">{provider}</span> : null}
        {!compact && runtime ? <span className="px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-300 text-[9px] uppercase tracking-wide">{runtime}</span> : null}
      </div>
      {!compact && canonicalId ? <div className="mt-0.5 text-[10px] text-slate-500 font-mono truncate">{canonicalId}</div> : null}
    </div>
  );
}

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
  followUpMode?: 'interrupt_and_send' | 'queued_follow_up' | string;
}

export function ProviderAvailabilityBarrier({
  assessment,
  loading = false,
  onRetry,
}: {
  assessment: AgentChatProviderAvailabilityAssessment;
  loading?: boolean;
  onRetry?: () => void;
}) {
  if (assessment.canSend || !assessment.message) return null;
  const checking = assessment.status === 'checking' && !assessment.retryable;
  return (
    <div
      id="agent-chat-provider-availability"
      role={checking ? 'status' : 'alert'}
      aria-live={checking ? 'polite' : 'assertive'}
      className="flex items-center gap-2 border-b border-amber-500/15 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-100"
    >
      {checking || loading ? (
        <Loader2 size={14} className="shrink-0 animate-spin text-amber-300" aria-hidden="true" />
      ) : (
        <ShieldAlert size={14} className="shrink-0 text-amber-300" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">{assessment.message}</span>
      {assessment.retryable && onRetry && !loading && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[32px] rounded-lg border border-amber-300/20 px-2.5 font-medium text-amber-50 hover:bg-amber-500/10"
        >
          Retry provider availability
        </button>
      )}
    </div>
  );
}

export function BlockedAgentChatSendButton({
  title,
  describedBy,
  className,
  children,
}: {
  title: string;
  describedBy?: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      aria-label={title}
      aria-describedby={describedBy}
      className={className}
      title={title}
    >
      {children}
    </button>
  );
}

export function StreamReconnectButton({
  visible,
  onReconnect,
}: {
  visible: boolean;
  onReconnect: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onReconnect}
      aria-label="Reconnect live stream"
      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/15 hover:text-amber-200"
      title="Reconnect live stream"
    >
      <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
      <span className="hidden sm:inline">Reconnect</span>
    </button>
  );
}

/* ─── Model Picker Dropdown ─────────────────────────────────────────────── */

/** Shared viewport-aware popover: anchored on desktop and modal bottom-sheet on mobile. */
function ModelPickerDropdown({
  open,
  onClose,
  children,
  anchorRef,
  id,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  anchorRef: React.RefObject<HTMLButtonElement>;
  id: string;
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
      width={256}
      align="end"
      margin={12}
      mobileBreakpoint={767}
      zIndex={1300}
      ariaLabel="Available chat models"
      className="max-h-[70dvh] overflow-hidden rounded-xl border border-white/[0.08] bg-[#1A1F3A] shadow-2xl shadow-black/50"
    >
      <div id={id} role="dialog" aria-label="Available chat models" className="flex min-h-0 max-h-full flex-col overflow-hidden">
        {isMobile && (
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 pb-1.5 pt-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Select Model</span>
            <button type="button" aria-label="Close model selector" onClick={onClose} className="min-h-[36px] min-w-[36px] rounded-lg text-slate-500 hover:text-slate-300">
              <X size={14} className="mx-auto" />
            </button>
          </div>
        )}
        {children}
      </div>
    </AnchoredPopover>
  );
}


export function ModelPicker({
  value,
  onChange,
  models,
  loading = false,
  error = null,
  supportsCustomModelInput = true,
  modelCatalogKind = 'dynamic',
  disabled = false,
  allowDefaultModel = true,
  required = false,
  emptyMessage = 'No selectable models are available.',
  unavailableModelIds = [],
  onOpen,
  onRetry,
}: {
  value: string;
  onChange: (model: string) => void;
  models: string[];
  loading?: boolean;
  error?: string | null;
  supportsCustomModelInput?: boolean;
  modelCatalogKind?: 'none' | 'declared' | 'dynamic';
  disabled?: boolean;
  allowDefaultModel?: boolean;
  required?: boolean;
  emptyMessage?: string;
  /**
   * Models the catalog knows about but cannot run right now, usually because
   * their provider is not connected. They used to be dropped silently, so a
   * model the operator expected simply was not there.
   */
  unavailableModelIds?: string[];
  onOpen?: () => void;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState(value);
  const isCustomOnlyCatalog = modelCatalogKind === 'none' && models.length === 0;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownId = React.useId();

  const close = useCallback(() => {
    setOpen(false);
    setCustom(false);
    setCustomDraft(value);
  }, [value]);

  const submitCustomModel = useCallback(() => {
    const nextModel = customDraft.trim();
    if (!nextModel) return;
    onChange(nextModel);
    close();
  }, [close, customDraft, onChange]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (models.length === 0 && !supportsCustomModelInput && !loading && !error && !required) return null;

  const emptySelectionLabel = required ? 'Select model' : 'Default model';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Chat model"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dropdownId : undefined}
        aria-busy={loading}
        onClick={() => {
          if (disabled) return;
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border text-[11px] transition-colors ${disabled ? 'bg-white/[0.03] border-white/[0.05] text-slate-500 cursor-not-allowed opacity-60' : 'bg-white/[0.06] hover:bg-white/[0.10] border-white/[0.08] text-slate-400 hover:text-slate-200'}`}
        title={disabled ? 'Finish or abort the current response before switching models' : (error || value || emptySelectionLabel)}
      >
        {/* Icon-only on mobile, text on desktop */}
        {loading
          ? <Loader2 size={13} className="sm:hidden flex-shrink-0 animate-spin" />
          : error
            ? <XCircle size={13} className="flex-shrink-0 text-red-300" />
            : <Code2 size={13} className="sm:hidden flex-shrink-0" />}
        <div className="hidden sm:flex items-center gap-1.5 min-w-0 max-w-[220px]">
          {loading ? <Loader2 size={12} className="flex-shrink-0 animate-spin text-violet-300" /> : null}
          {value ? <ModelMeta modelId={value} compact /> : <span className="truncate max-w-[120px]">{emptySelectionLabel}</span>}
        </div>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''} hidden sm:block`} />
      </button>
      <ModelPickerDropdown open={open} onClose={close} anchorRef={triggerRef} id={dropdownId}>
        <div className="min-h-0 max-h-80 overflow-y-auto overscroll-contain p-1 scrollbar-thin scrollbar-thumb-white/10">
          {loading && (
            <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-white/[0.06] flex items-center gap-2">
              <Loader2 size={12} className="animate-spin text-violet-300" />
              Loading models…
            </div>
          )}
          {error && (
            <div className="border-b border-red-500/15 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-200" role="alert">
              <div className="flex items-start gap-2">
                <XCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{error}</span>
              </div>
              {onRetry && (
                <button type="button" onClick={onRetry} disabled={loading} className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-red-400/20 bg-red-500/10 px-2.5 text-[11px] text-red-100 disabled:opacity-50">
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Retry model catalog
                </button>
              )}
            </div>
          )}
          {isCustomOnlyCatalog && (
            <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-white/[0.06]">
              This provider does not publish a model catalog here. Enter the exact model ID manually.
            </div>
          )}
          {!loading && !error && models.length === 0 && required && (
            <div className="border-b border-amber-500/15 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-100" role="status">
              {emptyMessage}
            </div>
          )}
          {allowDefaultModel && (
            <button
              type="button"
              onClick={() => { onChange(''); setCustom(false); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${
                !value ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'
              }`}
            >
              <span className="flex-1 text-left">Default</span>
              {!value && <Check size={12} className="text-violet-400" />}
            </button>
          )}
          {models.map((m) => (
            <button
              type="button"
              key={m}
              aria-label={`Select model ${m}`}
              onClick={() => { onChange(m); setCustom(false); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${
                value === m ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'
              }`}
            >
              <ModelMeta modelId={m} />
              {value === m && <Check size={12} className="text-violet-400 flex-shrink-0" />}
            </button>
          ))}
          {unavailableModelIds.length > 0 && (
            <div className="border-t border-white/[0.06] mt-1 pt-2 px-3 pb-1">
              <p className="text-[11px] leading-4 text-slate-500">
                {unavailableModelIds.length} model{unavailableModelIds.length === 1 ? '' : 's'} hidden
                because their provider is not connected
                {unavailableModelIds.length <= 4 ? ` — ${unavailableModelIds.join(', ')}` : ''}.
                Connect it in Settings → AI Providers.
              </p>
            </div>
          )}
          {supportsCustomModelInput && (
          <div className="border-t border-white/[0.06] mt-1 pt-1">
            {custom ? (
              <div className="px-2 py-1">
                <input
                  aria-label="Custom model name"
                  autoFocus
                  className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40"
                  placeholder="Custom model name"
                  value={customDraft}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitCustomModel();
                    if (e.key === 'Escape') close();
                  }}
                />
                <button type="button" onClick={submitCustomModel} disabled={!customDraft.trim()} className="mt-2 inline-flex min-h-[36px] w-full items-center justify-center rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 text-xs font-medium text-violet-100 disabled:cursor-not-allowed disabled:opacity-45">
                  Apply model
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setCustomDraft(value); setCustom(true); }}
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

export function AgentZeroRecoveryCard({
  message,
  retrying = false,
  onRetry,
  onRepair,
}: {
  message: string;
  retrying?: boolean;
  onRetry: () => void;
  onRepair?: () => void;
}) {
  return (
    <div
      role="alert"
      className="mx-auto w-full max-w-xl rounded-2xl border border-amber-400/25 bg-amber-500/[0.08] px-4 py-4 text-left shadow-lg shadow-black/10"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-amber-100">Agent Zero needs attention</div>
          <div className="mt-1 text-xs leading-5 text-amber-100/80">{message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-amber-300/25 bg-amber-400/10 px-3 text-xs font-medium text-amber-50 transition-colors hover:bg-amber-400/20 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw size={13} className={retrying ? 'animate-spin' : ''} />
              {retrying ? 'Retrying…' : 'Retry Agent Zero'}
            </button>
            {onRepair ? (
              <button
                type="button"
                onClick={onRepair}
                disabled={retrying}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/[0.10] bg-white/[0.05] px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.09] disabled:cursor-wait disabled:opacity-60"
              >
                <Wrench size={13} /> Repair managed runtime
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Session Controls (real OpenClaw thinking + native OpenClaw fast mode) ───────────────────── */

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive' | 'max' | 'ultra';
type ReasoningVisibility = 'off' | 'on' | 'stream';
// Canonical OpenClaw 2026.7.1 ladder ordering (adaptive sits between medium
// and high, matching the gateway's own per-model profile ordering).
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'adaptive', 'high', 'xhigh', 'max', 'ultra'];
const REASONING_VISIBILITY_LABELS: Record<ReasoningVisibility, string> = {
  off: 'Hidden',
  on: 'Visible',
  stream: 'Stream',
};
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  adaptive: 'Adaptive',
  max: 'Max',
  ultra: 'Ultra',
};

// OpenClaw 2026.7.1 maps fast mode to service_tier=priority for every
// Codex-backed openai/* model (legacy codex/openai-codex refs included), so
// gate by provider family rather than a hardcoded model list.
function supportsOpenClawFastModeModel(model?: string | null): boolean {
  const normalized = String(model || '').trim().toLowerCase();
  return normalized.startsWith('openai/')
    || normalized.startsWith('codex/')
    || normalized.startsWith('openai-codex/');
}

type HeartbeatModelMutationSnapshot = Readonly<{
  generation: number;
  sessionKey: string;
  previous: string;
  requested: string;
}>;

type HeartbeatModelLoadSnapshot = Readonly<{
  generation: number;
  sessionKey: string;
}>;

function readHeartbeatModelValue(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'value')) {
    return undefined;
  }
  if (payload.value === null) return '';
  return typeof payload.value === 'string' ? payload.value.trim() : undefined;
}

function heartbeatModelMutationError(error: any, fallback: string): string {
  return String(
    error?.response?.data?.detail
    || error?.response?.data?.error
    || error?.message
    || fallback,
  );
}

/**
 * Owns the global heartbeat-model setting from one concrete Agent Chat session.
 *
 * A ref-backed lease closes the same-render admission window, while the request
 * generation and session snapshot prevent an older load/save from repainting a
 * newly selected session. A successful PATCH is never treated as canonical:
 * only a fresh config-path readback may update the visible value.
 */
export function useAgentChatHeartbeatModel({
  enabled,
  sessionKey,
}: {
  enabled: boolean;
  sessionKey: string;
}) {
  const [heartbeatModel, setHeartbeatModel] = useState('');
  const [heartbeatModelLoading, setHeartbeatModelLoading] = useState(false);
  const [heartbeatModelMutating, setHeartbeatModelMutating] = useState(false);
  const [heartbeatModelError, setHeartbeatModelError] = useState<string | null>(null);
  const heartbeatModelRef = useRef('');
  const scopeRef = useRef({ enabled, sessionKey });
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const loadRef = useRef<HeartbeatModelLoadSnapshot | null>(null);
  const mutationRef = useRef<HeartbeatModelMutationSnapshot | null>(null);

  scopeRef.current = { enabled, sessionKey };
  heartbeatModelRef.current = heartbeatModel;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    generationRef.current += 1;
    loadRef.current = null;
    setHeartbeatModelError(null);
    if (!enabled) {
      heartbeatModelRef.current = '';
      setHeartbeatModel('');
      if (!mutationRef.current) setHeartbeatModelLoading(false);
    }
  }, [enabled, sessionKey]);

  const isCurrentScope = useCallback((targetSessionKey: string) => (
    mountedRef.current
    && scopeRef.current.enabled
    && scopeRef.current.sessionKey === targetSessionKey
  ), []);

  const loadHeartbeatModel = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope.enabled || mutationRef.current) return;
    const activeLoad = loadRef.current;
    if (activeLoad?.sessionKey === scope.sessionKey) return;

    const snapshot = Object.freeze({
      generation: ++generationRef.current,
      sessionKey: scope.sessionKey,
    });
    loadRef.current = snapshot;
    setHeartbeatModelLoading(true);
    setHeartbeatModelError(null);
    try {
      const data = await gatewayAPI.getConfigPath('agents.defaults.heartbeat.model');
      if (
        loadRef.current !== snapshot
        || generationRef.current !== snapshot.generation
        || !isCurrentScope(snapshot.sessionKey)
      ) return;
      const value = readHeartbeatModelValue(data);
      if (value === undefined) throw new Error('The server did not return a heartbeat model value.');
      heartbeatModelRef.current = value;
      setHeartbeatModel(value);
    } catch (error) {
      if (
        loadRef.current !== snapshot
        || generationRef.current !== snapshot.generation
        || !isCurrentScope(snapshot.sessionKey)
      ) return;
      console.error('[ChatInterface] Failed to load heartbeat model:', error);
      setHeartbeatModelError('Could not load the heartbeat model right now.');
    } finally {
      if (loadRef.current === snapshot) loadRef.current = null;
      if (
        generationRef.current === snapshot.generation
        && isCurrentScope(snapshot.sessionKey)
        && mutationRef.current === null
      ) {
        setHeartbeatModelLoading(false);
      }
    }
  }, [isCurrentScope]);

  const setHeartbeatModelValue = useCallback((nextModel: string): boolean => {
    const scope = scopeRef.current;
    // The path is global, so an accepted mutation owns admission across session
    // changes until its PATCH and canonical readback both settle.
    if (!scope.enabled || mutationRef.current) return false;

    const snapshot = Object.freeze({
      generation: ++generationRef.current,
      sessionKey: scope.sessionKey,
      previous: heartbeatModelRef.current,
      requested: String(nextModel || '').trim(),
    });
    mutationRef.current = snapshot;
    loadRef.current = null;
    setHeartbeatModelMutating(true);
    setHeartbeatModelLoading(true);
    setHeartbeatModelError(null);

    void (async () => {
      let patchAccepted = false;
      try {
        await gatewayAPI.patchConfigPath(
          'agents.defaults.heartbeat.model',
          snapshot.requested || null,
        );
        patchAccepted = true;

        const fresh = await gatewayAPI.getConfigPath('agents.defaults.heartbeat.model');
        if (
          mutationRef.current !== snapshot
          || generationRef.current !== snapshot.generation
          || !isCurrentScope(snapshot.sessionKey)
        ) return;
        const canonical = readHeartbeatModelValue(fresh);
        if (canonical === undefined) {
          throw new Error('The server did not confirm the saved heartbeat model.');
        }
        heartbeatModelRef.current = canonical;
        setHeartbeatModel(canonical);
        if (canonical !== snapshot.requested) {
          setHeartbeatModelError('The server kept a different heartbeat model. Its confirmed value is shown.');
        } else {
          setHeartbeatModelError(null);
        }
      } catch (error) {
        if (
          mutationRef.current !== snapshot
          || generationRef.current !== snapshot.generation
          || !isCurrentScope(snapshot.sessionKey)
        ) return;
        console.error('[ChatInterface] Failed to update heartbeat model:', error);
        heartbeatModelRef.current = snapshot.previous;
        setHeartbeatModel(snapshot.previous);
        setHeartbeatModelError(patchAccepted
          ? 'The heartbeat model update was accepted, but its saved value could not be verified. The previous confirmed value remains shown; retry after checking the live setting.'
          : heartbeatModelMutationError(error, 'Could not update the heartbeat model.'));
      } finally {
        if (mutationRef.current === snapshot) mutationRef.current = null;
        if (mountedRef.current && mutationRef.current === null) {
          setHeartbeatModelMutating(false);
          setHeartbeatModelLoading(false);
        }
      }
    })();
    return true;
  }, [isCurrentScope]);

  return {
    heartbeatModel,
    heartbeatModelLoading,
    heartbeatModelMutating,
    heartbeatModelError,
    loadHeartbeatModel,
    setHeartbeatModel: setHeartbeatModelValue,
    isHeartbeatModelMutationActive: () => mutationRef.current !== null,
  };
}

interface SessionControlsProps {
  loading?: boolean;
  thinkingLevel: ThinkingLevel;
  /** Per-model thinking level ids declared by the gateway for the resolved model. */
  thinkingOptions?: string[];
  reasoningVisibility: ReasoningVisibility;
  fastModeEnabled: boolean;
  compactionModelOverride: string;
  heartbeatModel: string;
  heartbeatModelLoading?: boolean;
  heartbeatModelError?: string | null;
  showHeartbeatModel?: boolean;
  showCompatibilityHotfix?: boolean;
  compatibilityHotfixStatus?: CompatibilityHotfixStatus | null;
  compatibilityHotfixLoading?: boolean;
  compatibilityHotfixApplying?: boolean;
  compatibilityHotfixMessage?: string | null;
  onRefreshCompatibilityHotfix?: () => void;
  onApplyCompatibilityHotfix?: () => void;
  onSetThinkingLevel: (level: ThinkingLevel) => void;
  onSetReasoningVisibility: (level: ReasoningVisibility) => void;
  onToggleFastMode: () => void;
  onSetCompactionModelOverride: (model: string) => void;
  onSetHeartbeatModel: (model: string) => boolean | void;
  availableModels: string[];
  compactionAvailableModels?: string[];
  compactionModelLoading?: boolean;
  compactionModelError?: string | null;
  compactionModelOptionsLoading?: boolean;
  sessionControlMutation?: SessionControlMutationKind | null;
  sessionControlsError?: string | null;
  sessionControlsSupported: boolean;
  onPanelOpen?: () => void;
  disabled?: boolean;
  currentModel?: string;
  sessionKey?: string;
}

export function SessionControls({
  loading = false,
  thinkingLevel,
  thinkingOptions = [],
  reasoningVisibility,
  fastModeEnabled,
  compactionModelOverride,
  heartbeatModel,
  heartbeatModelLoading = false,
  heartbeatModelError = null,
  showHeartbeatModel = false,
  showCompatibilityHotfix = false,
  compatibilityHotfixStatus = null,
  compatibilityHotfixLoading = false,
  compatibilityHotfixApplying = false,
  compatibilityHotfixMessage = null,
  onRefreshCompatibilityHotfix,
  onApplyCompatibilityHotfix,
  onSetThinkingLevel,
  onSetReasoningVisibility,
  onToggleFastMode,
  onSetCompactionModelOverride,
  onSetHeartbeatModel,
  availableModels,
  compactionAvailableModels = [],
  compactionModelLoading = false,
  compactionModelError = null,
  compactionModelOptionsLoading = false,
  sessionControlMutation = null,
  sessionControlsError = null,
  sessionControlsSupported,
  onPanelOpen,
  disabled,
  currentModel,
  sessionKey,
}: SessionControlsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localThinking, setLocalThinking] = useState(thinkingLevel);
  const [thinkingDebouncePending, setThinkingDebouncePending] = useState(false);
  const [heartbeatAdmissionPending, setHeartbeatAdmissionPending] = useState(false);
  const localThinkingRef = useRef<number | null>(null);
  const heartbeatAdmissionRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const controlsBusy = sessionControlMutation !== null
    || thinkingDebouncePending
    || heartbeatModelLoading
    || heartbeatAdmissionPending;
  const isControlsBusy = () => controlsBusy || heartbeatAdmissionRef.current;
  // Sync local thinking with the last server-confirmed/optimistic parent value.
  // Including mutation ownership also rolls back a debounced slider value when
  // another control claimed the session before its timer fired.
  useEffect(() => {
    if (localThinkingRef.current) {
      window.clearTimeout(localThinkingRef.current);
      localThinkingRef.current = null;
    }
    setThinkingDebouncePending(false);
    setLocalThinking(thinkingLevel);
  }, [thinkingLevel, sessionControlMutation, sessionKey]);
  useEffect(() => () => {
    if (localThinkingRef.current) window.clearTimeout(localThinkingRef.current);
  }, []);
  useEffect(() => {
    heartbeatAdmissionRef.current = heartbeatModelLoading;
    if (!heartbeatModelLoading) setHeartbeatAdmissionPending(false);
  }, [heartbeatModelLoading, sessionKey]);

  const handleHeartbeatModelSelection = (nextModel: string) => {
    if (isControlsBusy()) return;
    // Claim the surface before React can publish the parent's loading state so
    // a second DOM event in this render cannot submit or close the popover.
    heartbeatAdmissionRef.current = true;
    let accepted: boolean | void;
    try {
      accepted = onSetHeartbeatModel(nextModel);
    } catch (error) {
      heartbeatAdmissionRef.current = false;
      throw error;
    }
    if (accepted === true) {
      setHeartbeatAdmissionPending(true);
      return;
    }
    heartbeatAdmissionRef.current = false;
  };

  const blockHeartbeatOwnedInteraction = (event: React.SyntheticEvent) => {
    if (!heartbeatAdmissionRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const effectiveCompactionModels = Array.from(new Set([
    ...compactionAvailableModels,
    ...(compactionModelOverride && !compactionAvailableModels.includes(compactionModelOverride) ? [compactionModelOverride] : []),
  ]));
  const effectiveHeartbeatModels = Array.from(new Set([
    ...availableModels,
    ...(heartbeatModel && !availableModels.includes(heartbeatModel) ? [heartbeatModel] : []),
  ]));
  const currentModelLower = String(currentModel || '').toLowerCase();
  const fastModeSupported = supportsOpenClawFastModeModel(currentModel) || fastModeEnabled;
  // Prefer the gateway-declared per-model level set (OpenClaw 2026.7.1 exposes
  // it on the session row: ultra for GPT-5.6 Sol/Terra, adaptive for Claude,
  // etc.). Fall back to the legacy heuristic only when no profile is loaded.
  const profileLevels = THINKING_LEVELS.filter((level) => thinkingOptions.includes(level));
  const legacyAdaptiveSupported = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(currentModelLower);
  const adaptiveSupported = profileLevels.length > 0
    ? profileLevels.includes('adaptive')
    : legacyAdaptiveSupported;
  const visibleThinkingLevels = profileLevels.length > 0
    ? profileLevels
    : THINKING_LEVELS.filter((level) => {
        if (level === 'max' || level === 'ultra') return thinkingLevel === level;
        return level !== 'adaptive' || legacyAdaptiveSupported || thinkingLevel === 'adaptive';
      });
  const effectiveThinking = visibleThinkingLevels.includes(localThinking)
    ? localThinking
    : (visibleThinkingLevels.includes('high') ? 'high' : (visibleThinkingLevels[0] || 'off'));
  const thinkingIndex = Math.max(0, visibleThinkingLevels.indexOf(effectiveThinking));

  // Extract short model name for display
  const shortModel = getShortModelLabel(currentModel, 'default');

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen && isControlsBusy()) return;
          if (!isOpen) onPanelOpen?.();
          setIsOpen(!isOpen);
        }}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={`p-1.5 rounded-lg transition-colors ${
          (thinkingLevel !== 'off') || reasoningVisibility !== 'off' || fastModeEnabled
            ? 'text-emerald-400 bg-emerald-500/[0.12] hover:bg-emerald-500/[0.2]'
            : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
        } disabled:opacity-50`}
        title="Session Controls"
      >
        <Settings2 size={16} />
      </button>

      <AnchoredPopover
        open={isOpen}
        anchorRef={triggerRef}
        onDismiss={(reason) => {
          if (isControlsBusy()) return;
          setIsOpen(false);
          if (reason === 'escape') triggerRef.current?.focus();
        }}
        width={320}
        align="end"
        margin={12}
        mobileBreakpoint={767}
        zIndex={1300}
        ariaLabel="Session controls"
        className="max-h-[70dvh] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0D1130] shadow-2xl shadow-black/50"
      >
          <div
            role="dialog"
            aria-label="Session controls"
            aria-busy={controlsBusy}
            onPointerDownCapture={blockHeartbeatOwnedInteraction}
            onClickCapture={blockHeartbeatOwnedInteraction}
            onChangeCapture={blockHeartbeatOwnedInteraction}
            className="flex min-h-0 max-h-full flex-col overflow-hidden"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.06] px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-xs font-medium text-white">Session Controls</div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                  {sessionKey ? sessionKey.split(':').slice(-1)[0] : 'No session'}
                </div>
              </div>
              <button
                type="button"
                aria-label="Close session controls"
                disabled={controlsBusy}
                onClick={() => {
                  if (isControlsBusy()) return;
                  setIsOpen(false);
                  triggerRef.current?.focus();
                }}
                className="grid min-h-[36px] min-w-[36px] place-items-center rounded-lg text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-200 disabled:cursor-wait disabled:opacity-40"
              >
                <X size={14} />
              </button>
            </div>

            <div className="min-h-0 space-y-2 overflow-y-auto overscroll-contain p-2.5">
              {loading && (
                <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-[11px] text-slate-300">
                  <Loader2 size={12} className="animate-spin text-violet-300" />
                  Loading live session controls…
                </div>
              )}

              {(sessionControlMutation || thinkingDebouncePending || heartbeatModelLoading || heartbeatAdmissionPending) && (
                <div role="status" className="flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-2 text-[11px] text-cyan-100">
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  {heartbeatAdmissionPending
                    ? 'Saving heartbeat model…'
                    : heartbeatModelLoading
                      ? 'Loading heartbeat model…'
                    : sessionControlMutation === 'thinking' || thinkingDebouncePending
                    ? 'Saving thinking level…'
                    : sessionControlMutation === 'reasoning'
                      ? 'Saving reasoning visibility…'
                      : sessionControlMutation === 'fastMode'
                        ? 'Saving fast mode…'
                        : 'Saving compaction model…'}
                </div>
              )}

              {sessionControlsError && (
                <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-red-200">
                  {sessionControlsError}
                </div>
              )}

              <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                <div className="flex items-center gap-2">
                  <Sparkles size={14} className={localThinking !== 'off' ? 'text-violet-400' : 'text-slate-500'} />
                  <div>
                    <div className="text-xs font-medium text-white">Thinking Level</div>
                    <div className="text-[10px] text-slate-500">
                      {profileLevels.length > 0
                        ? `Levels supported by ${shortModel}: ${profileLevels.map((level) => THINKING_LEVEL_LABELS[level] || level).join(' · ')}`
                        : 'Controls reasoning depth. Levels adjust to what the selected model supports.'}
                    </div>
                  </div>
                </div>
                <input
                  aria-label="Thinking level"
                  type="range"
                  min={0}
                  max={visibleThinkingLevels.length - 1}
                  step={1}
                  value={Math.max(0, thinkingIndex)}
                  disabled={disabled || loading || controlsBusy || !sessionControlsSupported}
                  onChange={(e) => {
                    // Update visual position immediately (local state via parent)
                    const idx = Number(e.target.value);
                    const next = visibleThinkingLevels[idx] || 'off';
                    if (localThinkingRef.current) clearTimeout(localThinkingRef.current);
                    setThinkingDebouncePending(true);
                    localThinkingRef.current = window.setTimeout(() => {
                      localThinkingRef.current = null;
                      setThinkingDebouncePending(false);
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
                  {localThinking === 'ultra' && (
                    <span className="ml-1 text-[9px] text-fuchsia-300/80">(max reasoning + proactive sub-agents)</span>
                  )}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                <div className="flex items-center gap-2">
                  <MessageSquare size={14} className={reasoningVisibility !== 'off' ? 'text-cyan-400' : 'text-slate-500'} />
                  <div>
                    <div className="text-xs font-medium text-white">Reasoning Visibility</div>
                    <div className="text-[10px] text-slate-500">Controls whether OpenClaw exposes readable reasoning summaries when the provider emits them.</div>
                  </div>
                </div>
                <select
                  aria-label="Reasoning visibility"
                  value={reasoningVisibility}
                  onChange={(e) => onSetReasoningVisibility(e.target.value as ReasoningVisibility)}
                  disabled={disabled || loading || controlsBusy || !sessionControlsSupported}
                  className="w-full rounded-lg border border-white/[0.08] bg-[#141A43] px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                >
                  <option value="off">Hidden</option>
                  <option value="on">Visible / persistent</option>
                  <option value="stream">Stream when supported</option>
                </select>
                <div className="text-[10px] text-slate-400">
                  Current: <span className="font-semibold uppercase text-cyan-300">{REASONING_VISIBILITY_LABELS[reasoningVisibility]}</span>
                </div>
              </div>

              {fastModeSupported && (
                <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Radio size={14} className={fastModeEnabled ? 'text-amber-400' : 'text-slate-500'} />
                      <div>
                        <div className="text-xs font-medium text-white">Codex Fast Mode</div>
                        <div className="text-[10px] text-slate-500">Priority processing for GPT (openai/*) Codex-runtime models.</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Toggle Codex fast mode"
                      aria-pressed={fastModeEnabled}
                      onClick={() => {
                        onToggleFastMode();
                      }}
                      disabled={disabled || loading || controlsBusy || !sessionControlsSupported}
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
                  <div className="text-[10px] text-slate-400">
                    Current: {fastModeEnabled ? 'enabled' : 'disabled'} for {shortModel}
                  </div>
                </div>
              )}

              {showHeartbeatModel && (
                <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                  <div className="flex items-center gap-2">
                    <Clock size={14} className={heartbeatModel ? 'text-cyan-400' : 'text-slate-500'} />
                    <div>
                      <div className="text-xs font-medium text-white">Heartbeat Model</div>
                      <div className="text-[10px] text-slate-500">Default OpenClaw heartbeat model for the main agent.</div>
                    </div>
                  </div>
                  <select
                    aria-label="Heartbeat model"
                    value={heartbeatModel}
                    onChange={(e) => handleHeartbeatModelSelection(e.target.value)}
                    disabled={disabled || loading || controlsBusy || heartbeatModelLoading || effectiveHeartbeatModels.length === 0}
                    className="w-full rounded-lg border border-white/[0.08] bg-[#141A43] px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                  >
                    <option value="">Default</option>
                    {effectiveHeartbeatModels.map((modelId) => (
                      <option key={`heartbeat-${modelId}`} value={modelId}>
                        {modelDisplayName(modelId)}
                      </option>
                    ))}
                  </select>
                  {heartbeatModelError && (
                    <div role="alert" className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-200">
                      {heartbeatModelError}
                    </div>
                  )}
                </div>
              )}

              <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                <div className="flex items-center gap-2">
                  <Layers3 size={14} className={compactionModelOverride ? 'text-sky-400' : 'text-slate-500'} />
                  <div>
                    <div className="text-xs font-medium text-white">Compaction Model</div>
                    <div className="text-[10px] text-slate-500">Model used for context compaction (cheaper = lower cost)</div>
                  </div>
                </div>
                <select
                  aria-label="Compaction model"
                  value={compactionModelOverride}
                  onChange={(e) => onSetCompactionModelOverride(e.target.value)}
                  disabled={disabled || loading || controlsBusy || compactionModelLoading || compactionModelOptionsLoading || effectiveCompactionModels.length === 0}
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

              {showCompatibilityHotfix && (
                <div className="p-2 rounded-lg bg-white/[0.02] space-y-2">
                  <div className="flex items-start gap-2">
                    <Wrench size={14} className={compatibilityHotfixStatus?.applied ? 'text-emerald-400' : 'text-amber-400'} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-white">Compatibility Hotfix</div>
                      <div className="text-[10px] text-slate-500">Installer/update usually auto-applies this OpenClaw relay and Gemini compatibility patch. Use this fallback after a separate OpenClaw upgrade or if the expected markers are missing. Applying it restarts the gateway.</div>
                    </div>
                  </div>
                  <div className={`rounded border px-2 py-1 text-[10px] leading-relaxed ${compatibilityHotfixStatus?.applied ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/20 bg-amber-500/10 text-amber-200'}`}>
                    {compatibilityHotfixLoading
                      ? 'Checking current hotfix status…'
                      : compatibilityHotfixStatus?.applied
                        ? 'Compatibility patches already present in the installed OpenClaw bundle.'
                        : compatibilityHotfixStatus?.supported
                          ? 'Compatibility patches not applied on this install.'
                          : (compatibilityHotfixStatus?.issues?.[0] || 'This install does not expose the expected OpenClaw bundle layout.')}
                  </div>
                  {compatibilityHotfixMessage && (
                    <div className="rounded border border-white/[0.08] bg-black/20 px-2 py-1 text-[10px] leading-relaxed text-slate-300">
                      {compatibilityHotfixMessage}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => onRefreshCompatibilityHotfix?.()}
                      disabled={disabled || controlsBusy || compatibilityHotfixLoading || compatibilityHotfixApplying}
                      className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white disabled:opacity-50"
                    >
                      <RefreshCw size={11} /> Refresh
                    </button>
                    <button
                      onClick={() => {
                        setIsOpen(false);
                        onApplyCompatibilityHotfix?.();
                      }}
                      disabled={disabled || controlsBusy || compatibilityHotfixApplying || compatibilityHotfixLoading || !compatibilityHotfixStatus?.supported || !onApplyCompatibilityHotfix}
                      className="inline-flex min-h-[32px] items-center justify-center rounded-md border border-amber-200/70 bg-gradient-to-r from-amber-300 via-amber-400 to-amber-500 px-2.5 py-1 text-[10px] font-semibold text-slate-950 shadow-[0_8px_20px_rgba(245,158,11,0.24)] transition-all hover:-translate-y-0.5 hover:from-amber-200 hover:via-amber-300 hover:to-amber-400 hover:shadow-[0_12px_24px_rgba(245,158,11,0.3)] disabled:translate-y-0 disabled:cursor-not-allowed disabled:border-white/[0.08] disabled:bg-white/[0.08] disabled:bg-none disabled:text-slate-200 disabled:shadow-none"
                    >
                      {compatibilityHotfixApplying ? 'Applying…' : compatibilityHotfixStatus?.applied ? 'Reapply + restart' : 'Apply + restart'}
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-2 border-t border-white/[0.06] space-y-1">
                <div className="text-[10px] text-slate-500">
                  Model: <span className="text-slate-400 font-mono">{shortModel}</span>
                </div>
                <div className="text-[10px] text-slate-600 leading-relaxed">
                  {!sessionControlsSupported ? 'Thinking and fast-mode controls activate once a concrete OpenClaw session is selected.' : 'Fast mode writes the native OpenClaw session fastMode override.'}
                </div>
              </div>

            </div>
          </div>
      </AnchoredPopover>
    </div>
  );
}

export function CompatibilityHotfixConfirmationDialog({
  open,
  status,
  onClose,
  onVerified,
  onBusyChange,
}: {
  open: boolean;
  status: CompatibilityHotfixStatus | null;
  onClose: () => void;
  onVerified: (status: CompatibilityHotfixStatus, message: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const attemptRef = useRef<Readonly<{ confirmation: string }> | null>(null);

  useEffect(() => {
    if (open) setApplyError(null);
  }, [open]);

  const setBusy = useCallback((busy: boolean) => {
    setApplying(busy);
    onBusyChange?.(busy);
  }, [onBusyChange]);

  const apply = useCallback(async (confirmation: string) => {
    if (attemptRef.current) return;
    const snapshot = Object.freeze({ confirmation: String(confirmation || '').trim() });
    attemptRef.current = snapshot;
    setApplyError(null);
    setBusy(true);
    try {
      const result = await gatewayAPI.applyCompatibilityHotfix(snapshot.confirmation);
      if (attemptRef.current !== snapshot) return;
      if (result?.ok !== true || result?.status?.applied !== true) {
        throw new Error(result?.message || 'The gateway restart completed without verifying the compatibility hotfix.');
      }
      onVerified(result.status, result.message || 'Compatibility hotfix applied.');
      onClose();
    } catch (error: any) {
      if (attemptRef.current !== snapshot) return;
      const detail = error?.response?.data?.detail
        || error?.response?.data?.error
        || error?.message
        || 'Failed to apply compatibility hotfix.';
      setApplyError(String(detail));
    } finally {
      if (attemptRef.current === snapshot) {
        attemptRef.current = null;
        setBusy(false);
      }
    }
  }, [onClose, onVerified, setBusy]);

  return (
    <TypedConfirmationDialog
      open={open}
      title="Apply OpenClaw compatibility hotfix?"
      description="This updates the installed OpenClaw compatibility bundle and restarts the gateway. Active agent turns may be interrupted."
      confirmationPhrase={status?.confirmationPhrase || null}
      confirmLabel="Apply hotfix + restart"
      busyLabel="Applying hotfix + restarting…"
      busy={applying}
      tone="warning"
      details={applyError ? (
        <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {applyError}
        </div>
      ) : null}
      onCancel={() => {
        if (!attemptRef.current) onClose();
      }}
      onConfirm={(confirmation) => { void apply(confirmation); }}
    />
  );
}

/* ─── Agent Settings Drawer (providers + tools) ───────────────────────── */

export function AgentSettingsDrawer({ open, onClose, onAiProviderSetupComplete, onNativeModelSelected }: { open: boolean; onClose: () => void; onAiProviderSetupComplete?: () => void; onNativeModelSelected?: (provider: 'GEMINI', model: string) => Promise<boolean | void> | boolean | void }) {
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);
  const owner = isOwner(user);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, 'running' | 'success' | 'error'>>({});
  const [pendingToolInstall, setPendingToolInstall] = useState<AgentTool | null>(null);
  const installAdmissionRef = useRef<{ toolId: string } | null>(null);
  const [toolInstallError, setToolInstallError] = useState<string | null>(null);
  const drawerTitleId = React.useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const loadTools = useCallback(async (refresh = false) => {
    setToolsLoading(true);
    try {
      const data = await agentToolsAPI.list(refresh);
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

  const handleInstall = async (tool: AgentTool, confirmation: string) => {
    if (!isAdmin || installAdmissionRef.current) return;
    const toolId = tool.id;
    const admission = { toolId };
    installAdmissionRef.current = admission;
    setInstalling(toolId);
    setToolInstallError(null);
    setInstallStatus((prev) => ({ ...prev, [toolId]: 'running' }));
    try {
      const started = await agentToolsAPI.install(toolId, confirmation);
      setPendingToolInstall(null);
      await waitForToolInstallJob(started.jobId);
      setInstallStatus((prev) => ({ ...prev, [toolId]: 'success' }));
      await loadTools(true);
    } catch (error: any) {
      setInstallStatus((prev) => ({ ...prev, [toolId]: 'error' }));
      if (pendingToolInstall?.id === toolId) {
        setToolInstallError(error?.response?.data?.error || error?.message || `${tool.name} failed. Inspect Tasks for retained output.`);
      }
    } finally {
      if (installAdmissionRef.current === admission) installAdmissionRef.current = null;
      setInstalling(null);
    }
  };

  return (
    <>
      <ViewportModal
        open={open}
        onDismiss={onClose}
        dismissible={!installing}
        initialFocusRef={closeButtonRef}
        className="bg-black/60 backdrop-blur-[2px]"
      >
        <div className="flex h-full w-full justify-end">
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={drawerTitleId}
            className="flex h-full w-[360px] max-w-[90vw] flex-col border-l border-slate-700/50 bg-slate-900 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
              <div className="min-w-0">
                <h2 id={drawerTitleId} className="text-sm font-semibold text-white">Agent settings</h2>
                {toolsLoading ? (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sky-300" role="status">
                    <Loader2 size={10} className="animate-spin" />
                    Loading settings…
                  </div>
                ) : null}
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Close agent settings"
                aria-busy={Boolean(installing)}
                disabled={Boolean(installing)}
                onClick={onClose}
                className="grid min-h-[40px] min-w-[40px] place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-wait disabled:opacity-50"
              >
                {installing ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
              {!isAdmin && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
                  <ShieldAlert size={14} />
                  Admin access required.
                </div>
              )}

              {isAdmin && (
                <AiProviderSetup
                  mode="settings"
                  apiBase="/ai-setup"
                  compact
                  onComplete={onAiProviderSetupComplete}
                  onNativeModelSelected={onNativeModelSelected}
                  additionalProviderCards={owner ? (
                    <React.Suspense fallback={<div role="status" className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" />Loading Agent Zero…</div>}>
                      <LazyAgentZeroSetupPanel
                        view="providers"
                        compact
                        onProviderConnectionsChanged={onAiProviderSetupComplete}
                      />
                    </React.Suspense>
                  ) : null}
                />
              )}

              <details className="group">
                <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-400">
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
                                <span className="truncate text-xs font-medium text-white">{tool.name}</span>
                                {installed ? <CheckCircle2 size={10} className="shrink-0 text-emerald-400" /> : null}
                              </div>
                              {installed && tool.status.version && <div className="mt-0.5 font-mono text-[10px] text-slate-500">v{tool.status.version}</div>}
                              {status === 'success' && <div role="status" className="mt-0.5 text-[10px] text-emerald-400">Install verified</div>}
                              {status === 'error' && <div role="alert" className="mt-0.5 text-[10px] text-red-400">Install failed — inspect Tasks</div>}
                            </div>
                            {isAdmin && tool.install.length > 0 && (
                              <button
                                type="button"
                                aria-label={`${installed ? 'Update' : 'Install'} ${tool.name}`}
                                onClick={() => {
                                  if (installAdmissionRef.current) return;
                                  setToolInstallError(null);
                                  setPendingToolInstall(tool);
                                }}
                                disabled={installing !== null}
                                aria-busy={status === 'running'}
                                className="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-white disabled:opacity-50"
                              >
                                {status === 'running' ? <span className="inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" />{installed ? 'Updating…' : 'Installing…'}</span> : installed ? 'Update' : 'Install'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => { void loadTools(true); }}
                        disabled={toolsLoading || Boolean(installing)}
                        className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-slate-800 px-2 py-1.5 text-[10px] text-slate-500 transition-colors hover:border-slate-700 hover:text-slate-300 disabled:cursor-wait disabled:opacity-50"
                      >
                        <RefreshCw size={10} /> Refresh
                      </button>
                    </>
                  )}
                </div>
              </details>
            </div>
          </motion.div>
        </div>
      </ViewportModal>
      <TypedConfirmationDialog
        open={pendingToolInstall !== null}
        title={`${pendingToolInstall?.status?.installed ? 'Update' : 'Install'} ${pendingToolInstall?.name || 'tool'}`}
        description="This starts a bounded, auditable host job and may replace a server-wide command-line tool. Existing Portal sessions remain available while the job runs."
        confirmationPhrase={pendingToolInstall ? toolInstallConfirmationPhrase(pendingToolInstall.id) : null}
        confirmLabel={pendingToolInstall?.status?.installed ? 'Start update' : 'Start install'}
        busyLabel={pendingToolInstall?.status?.installed ? 'Starting update…' : 'Starting install…'}
        busy={Boolean(pendingToolInstall && installing === pendingToolInstall.id)}
        onCancel={() => {
          if (installAdmissionRef.current) return;
          setToolInstallError(null);
          setPendingToolInstall(null);
        }}
        onConfirm={(confirmation) => {
          if (pendingToolInstall) void handleInstall(pendingToolInstall, confirmation);
        }}
        details={pendingToolInstall ? (
          <>
            <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
              Portal will run only the reviewed install recipe for <strong>{pendingToolInstall.name}</strong>. Progress and failures are retained under Agent Tools → Tasks.
            </div>
            {toolInstallError ? (
              <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
                {toolInstallError}
              </div>
            ) : null}
          </>
        ) : null}
      />
    </>
  );
}

/* ─── Fix #6: Tool Call as centered iMessage system notification pill ───── */

const ToolCallBlock = React.memo(function ToolCallBlock({ tool }: { tool: ToolCall }) {
  const onAnswerQuestion = useAskQuestionAnswer();
  const askPayload = useMemo(
    () => (isAskQuestionTool(tool.name) ? parseAskQuestionPayload(tool.arguments) : null),
    [tool.name, tool.arguments],
  );
  // Tool arguments can become valid partway through a stream. Keep every hook
  // above the conditional return so that transition cannot change hook order.
  const [expanded, setExpanded] = useState(false);
  // The owner-scoped pending card beside the composer is the only answer
  // surface while the tool is running. Rendering the streamed arguments as a
  // second live form creates two competing submissions with different answer
  // encodings. Once settled, retain the compact answered transcript card.
  if (askPayload && onAnswerQuestion && tool.result) {
    return (
      <div className="px-4">
        <AskQuestionCard
          payload={askPayload}
          answered={tool.result || undefined}
          onSubmit={onAnswerQuestion}
        />
      </div>
    );
  }
  const duration = tool.endedAt ? ((tool.endedAt - tool.startedAt) / 1000).toFixed(1) : null;
  const hasDetails = !!(tool.result || tool.arguments);
  const summary = getToolSummary(tool);
  const presentation = getToolPresentation(tool.name);

  return (
    <motion.div
      data-tool-call-block
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-4 py-1"
    >
      <div className="flex flex-col items-center max-w-md w-full">
        <button
          onClick={() => hasDetails && setExpanded(!expanded)}
          className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border transition-colors text-[11px] text-slate-400 ${presentation.surfaceClass}`}
        >
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${presentation.iconBadgeClass}`}>
            <ToolGlyph toolName={tool.name} size={11} className={presentation.iconClass} />
          </span>
          <span className="text-slate-200">
            {summary}
          </span>
          {tool.status === 'running' ? (
            <Loader2 size={10} className={`animate-spin ${presentation.iconClass}`} />
          ) : null}
          {duration && (
            <span className="text-slate-500">· {duration}s</span>
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
});

const BoundedToolCallList = React.memo(function BoundedToolCallList({
  tools,
  messageKey,
  className = '',
  renderAfterFirst,
}: {
  tools: readonly ToolCall[];
  messageKey: string;
  className?: string;
  renderAfterFirst?: React.ReactNode;
}) {
  const [revealedEarlier, setRevealedEarlier] = useState(0);
  useEffect(() => setRevealedEarlier(0), [messageKey]);
  const windowed = useMemo(
    () => selectNewestWindow(tools, TOOL_WINDOW_SIZE, revealedEarlier),
    [revealedEarlier, tools],
  );

  if (tools.length === 0) return null;

  return (
    <div className={className}>
      {windowed.hiddenCount > 0 ? (
        <div className="flex justify-center px-4 py-1">
          <button
            type="button"
            onClick={() => setRevealedEarlier((current) => current + TOOL_WINDOW_SIZE)}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200"
          >
            Show earlier tools · {windowed.hiddenCount} hidden
          </button>
        </div>
      ) : null}
      {windowed.items.map((tool, index) => (
        <React.Fragment key={`${messageKey}-${tool.id}`}>
          <ToolCallBlock tool={tool} />
          {index === 0 ? renderAfterFirst : null}
        </React.Fragment>
      ))}
    </div>
  );
});

/* ─── Composer Status Badge ─────────────────────────────────────────────── */

function formatTokenCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(value));
}

function getOpenClawContextSummary({
  telemetry,
  isRunning,
  compactionPhase,
  statusText,
}: {
  telemetry: OpenClawSessionTelemetry | null;
  isRunning: boolean;
  compactionPhase?: 'idle' | 'compacting' | 'compacted';
  statusText?: string | null;
}) {
  if (!telemetry || telemetry.contextTokens == null || telemetry.totalTokens == null || telemetry.contextTokens <= 0) {
    return null;
  }

  const ratio = telemetry.pressureRatio ?? Math.max(0, Math.min(1, telemetry.totalTokens / telemetry.contextTokens));
  if (!Number.isFinite(ratio) || ratio <= 0) return null;

  const rawStatus = String(statusText || '').trim();
  const normalizedStatus = rawStatus.toLowerCase();
  const statusLooksLikeMaintenance = !rawStatus || isCompactionNotice(rawStatus) || /^(?:memory flush|context maintenance|preparing context maintenance|heartbeat check)\b/i.test(rawStatus);
  const effectiveCompactionPhase = statusLooksLikeMaintenance ? compactionPhase : 'idle';
  const hasPressureSignal = /context (?:budget|limit|window|maintenance|compaction|flush)|memory flush|heartbeat check|running out of context|near(?:ing)? context/i.test(normalizedStatus);
  const percent = Math.round(ratio * 100);
  const remainingTokens = Math.max(0, telemetry.contextTokens - telemetry.totalTokens);
  const detailParts = [
    `${formatTokenCompact(telemetry.totalTokens)} / ${formatTokenCompact(telemetry.contextTokens)} tokens`,
    `${formatTokenCompact(remainingTokens)} headroom`,
  ];
  if (telemetry.compactionCount != null && telemetry.compactionCount > 0) {
    detailParts.push(`${telemetry.compactionCount} auto-compaction${telemetry.compactionCount === 1 ? '' : 's'}`);
  }

  if (!isRunning && (effectiveCompactionPhase === 'compacting' || effectiveCompactionPhase === 'compacted')) {
    return {
      text: 'text-[rgba(191,219,254,0.92)]',
      dot: 'bg-[#60a5fa]',
      label: effectiveCompactionPhase === 'compacting' ? `Context maintenance active (${percent}%)` : `Context maintenance finished (${percent}%)`,
      detail: detailParts.join(' • '),
    };
  }

  if (ratio >= 0.97) {
    return {
      text: 'text-[rgba(254,205,211,0.92)]',
      dot: 'bg-[#fb7185]',
      label: `Context critical ${percent}% • compaction likely next turn`,
      detail: detailParts.join(' • '),
    };
  }

  if (ratio >= 0.9 || hasPressureSignal) {
    return {
      text: 'text-[rgba(253,230,138,0.92)]',
      dot: 'bg-[#fbbf24]',
      label: `Context pressure ${percent}% • compaction likely soon`,
      detail: detailParts.join(' • '),
    };
  }

  if (ratio >= 0.75 || (isRunning && ratio >= 0.6)) {
    return {
      text: 'text-[rgba(191,219,254,0.92)]',
      dot: 'bg-[#60a5fa]',
      label: `Context ${percent}% used`,
      detail: detailParts.join(' • '),
    };
  }

  return {
    text: 'text-slate-300/85',
    dot: 'bg-slate-300',
    label: `Context ${percent}% used`,
    detail: detailParts.join(' • '),
  };
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
  fileId?: string;
  /** Server-side path after upload (when the backend exposes one) */
  serverPath?: string;
  /** Signed direct URL for cross-host tool access */
  toolUrl?: string;
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
        aria-label={`Remove attachment ${attachment.name}`}
        onClick={onRemove}
        className="ml-0.5 text-slate-500 hover:text-slate-200 transition-colors"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/* ─── User Message Bubble ───────────────────────────────────────────────── */

const UserBubble = React.memo(function UserBubble({
  message,
  avatarUrl,
  username,
  hostFileContext,
  onRemoveQueued,
}: {
  message: ChatMessage;
  avatarUrl?: string | null;
  username?: string;
  hostFileContext: HostFileLinkContext;
  onRemoveQueued?: () => void;
}) {
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
          <MarkdownRenderer
            content={message.content}
            hostFileContext={hostFileContext}
            className="text-white [&_p]:text-white [&_li]:text-white/95 [&_strong]:text-white [&_em]:text-white/95 [&_code]:text-blue-50 [&_pre]:bg-blue-950/40 [&_pre]:border-white/10 [&_blockquote]:text-blue-100/85 [&_blockquote]:border-blue-200/30 [&_a]:text-cyan-100 [&_a]:decoration-cyan-200/40 hover:[&_a]:text-white hover:[&_a]:decoration-cyan-100/70"
          />
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

export const AssistantThinkingBubble = React.memo(function AssistantThinkingBubble({
  content,
  subject,
  isStreaming,
  hostFileContext,
}: {
  content: string;
  subject?: string;
  isStreaming: boolean;
  hostFileContext?: HostFileLinkContext;
}) {
  if (!content.trim() && !subject) return null;

  return (
    <div className="mb-2 rounded-2xl rounded-bl-sm border border-violet-400/15 bg-violet-500/[0.08] px-4 py-2.5 shadow-lg shadow-black/10">
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium tracking-wide text-violet-200/75">
        <Sparkles size={11} className="text-violet-300/75" />
        <span className="uppercase">thinking</span>
        {subject ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate normal-case" title={subject}>{subject}</span>
          </>
        ) : null}
        {isStreaming ? <span className="h-1 w-1 rounded-full bg-violet-300/70 animate-pulse" /> : null}
      </div>
      {content.trim() ? (
        <div className={isStreaming ? 'streaming-cursor text-slate-300/95' : 'text-slate-300/95'}>
          <MarkdownRenderer content={content} isStreaming={isStreaming} hostFileContext={hostFileContext} />
        </div>
      ) : null}
    </div>
  );
});

const AssistantBubble = React.memo(function AssistantBubble({
  agent,
  message,
  avatarUrl,
  isLast,
  isStreaming,
  liveThinkingContent,
  liveThinkingSubject,
  liveStatusText,
  hostFileContext,
  onRetry,
}: {
  agent: AgentIdentity;
  message: ChatMessage;
  avatarUrl?: string;
  isLast: boolean;
  isStreaming: boolean;
  liveThinkingContent?: string;
  liveThinkingSubject?: string;
  liveStatusText?: string | null;
  hostFileContext?: HostFileLinkContext;
  onRetry?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const provenance = message.provenance || agent.provenance;
  const modelLabel = message.model ? getShortModelLabel(message.model) : '';
  const toolCalls = message.toolCalls || [];
  const isCurrentlyStreaming = isLast && isStreaming;
  const hasContent = !!message.content;
  const visibleThinkingContent = (typeof liveThinkingContent === 'string' && liveThinkingContent.trim())
    ? liveThinkingContent
    : (message.thinkingContent || '');
  const visibleThinkingSubject = (typeof liveThinkingSubject === 'string' && liveThinkingSubject.trim())
    ? liveThinkingSubject.trim()
    : (message.thinkingSubject || '');
  const hasThinkingPresentation = Boolean(visibleThinkingContent.trim() || visibleThinkingSubject);
  const liveStatusPlaceholder = isCurrentlyStreaming && !hasContent && !hasThinkingPresentation
    ? String(liveStatusText || '').trim()
    : '';
  const visibleMessageContent = hasContent ? message.content : liveStatusPlaceholder;
  const hasVisibleMessageContent = !!visibleMessageContent.trim();

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
        {hasThinkingPresentation && (
          <AssistantThinkingBubble
            content={visibleThinkingContent}
            subject={visibleThinkingSubject}
            isStreaming={isCurrentlyStreaming && !hasContent}
            hostFileContext={hostFileContext}
          />
        )}

        {/* Tool call pills — centered system notifications */}
        {toolCalls.length > 0 && (
          <BoundedToolCallList
            tools={toolCalls}
            messageKey={message.id}
            className="mb-2 -ml-3 -mr-3"
          />
        )}

        {/* Message content */}
        {(hasVisibleMessageContent || (isCurrentlyStreaming && !hasThinkingPresentation)) && (
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
              <div className={isCurrentlyStreaming ? 'streaming-cursor text-slate-300/95' : undefined}>
                <MarkdownRenderer
                  content={visibleMessageContent}
                  isStreaming={isCurrentlyStreaming}
                  hostFileContext={hostFileContext}
                />
              </div>
            )}
          </div>
        )}

        {/* Footer: provenance + actions + timestamp */}
        <div className="flex items-center gap-2 mt-1 ml-1">
          <span className="text-[10px] text-slate-500 italic">{provenance}</span>
          {modelLabel ? <span className="text-[10px] text-slate-500">• {modelLabel}</span> : null}

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

/* ─── Long-run activity timeline ───────────────────────────────────────── */

const TIMELINE_WINDOW_SIZE = 160;

interface TimelineSegmentLike {
  text: string;
  subject?: string;
  ts?: number;
  order?: number;
  kind?: 'text' | 'thinking';
}

type TimelineActivity =
  | {
      kind: 'segment';
      segment: TimelineSegmentLike;
      segmentIndex: number;
      ts: number;
      order: number | null;
      fallbackOrder: number;
    }
  | {
      kind: 'tool';
      tool: ToolCall;
      ts: number;
      order: number | null;
      fallbackOrder: number;
    };

export function compareActivityTimelineItems(
  left: Pick<TimelineActivity, 'order' | 'ts' | 'fallbackOrder'>,
  right: Pick<TimelineActivity, 'order' | 'ts' | 'fallbackOrder'>,
): number {
  // Durable replay order is authoritative when both records carry it.
  // Provider timestamps can be skewed across tool and model processes.
  if (left.order != null && right.order != null) {
    return (left.order - right.order)
      || (left.ts - right.ts)
      || (left.fallbackOrder - right.fallbackOrder);
  }
  return (left.ts - right.ts) || (left.fallbackOrder - right.fallbackOrder);
}

export function isAssistantContentRepresentedByTimeline(
  rawContent: string,
  segments: readonly TimelineSegmentLike[],
): boolean {
  const content = String(rawContent || '').trim();
  if (!content) return false;
  const representedText = segments
    .filter((segment) => segment.kind !== 'thinking')
    .map((segment) => String(segment.text || '').trim())
    .filter(Boolean);
  if (representedText.length === 0) return false;
  if (representedText.some((segment) => segment === content)) return true;
  return !reconcileCumulativeFinalTail(representedText, content).trim();
}

const TimelineSegmentBubble = React.memo(function TimelineSegmentBubble({
  segment,
  segmentIndex,
  timestamp,
  messageId,
  agent,
  avatarUrl,
  hostFileContext,
}: {
  segment: TimelineSegmentLike;
  segmentIndex: number;
  timestamp: number;
  messageId: string;
  agent: AgentIdentity;
  avatarUrl?: string;
  hostFileContext?: HostFileLinkContext;
}) {
  const isThinking = segment.kind === 'thinking';
  const message = useMemo<ChatMessage>(() => ({
    id: `timeline-segment-${messageId}-${segmentIndex}`,
    role: 'assistant',
    content: isThinking ? '' : segment.text,
    thinkingContent: isThinking ? segment.text : undefined,
    thinkingSubject: isThinking ? segment.subject : undefined,
    createdAt: new Date(timestamp),
  }), [isThinking, messageId, segment.subject, segment.text, segmentIndex, timestamp]);

  return (
    <AssistantBubble
      message={message}
      agent={agent}
      avatarUrl={avatarUrl}
      isLast={false}
      isStreaming={false}
      hostFileContext={hostFileContext}
    />
  );
});

const ActivityTimeline = React.memo(function ActivityTimeline({
  messageId,
  segments,
  toolCalls,
  fallbackTimestamp,
  agent,
  avatarUrl,
  hostFileContext,
}: {
  messageId: string;
  segments: readonly TimelineSegmentLike[];
  toolCalls: readonly ToolCall[];
  fallbackTimestamp: number;
  agent: AgentIdentity;
  avatarUrl?: string;
  hostFileContext?: HostFileLinkContext;
}) {
  const [revealedEarlier, setRevealedEarlier] = useState(0);
  const timeline = useMemo<TimelineActivity[]>(() => {
    const segmentItems: TimelineActivity[] = segments.map((segment, segmentIndex) => ({
      kind: 'segment',
      segment,
      segmentIndex,
      ts: typeof segment.ts === 'number' && Number.isFinite(segment.ts)
        ? segment.ts
        : fallbackTimestamp + segmentIndex,
      order: typeof segment.order === 'number' && Number.isFinite(segment.order)
        ? segment.order
        : null,
      fallbackOrder: segmentIndex,
    }));
    const toolItems: TimelineActivity[] = toolCalls.map((tool, toolIndex) => ({
      kind: 'tool',
      tool,
      ts: typeof tool.startedAt === 'number' && Number.isFinite(tool.startedAt)
        ? tool.startedAt
        : fallbackTimestamp + segments.length + toolIndex,
      order: typeof tool.order === 'number' && Number.isFinite(tool.order)
        ? tool.order
        : null,
      fallbackOrder: segments.length + toolIndex,
    }));

    return [...segmentItems, ...toolItems]
      .sort(compareActivityTimelineItems);
  }, [fallbackTimestamp, segments, toolCalls]);
  const windowed = useMemo(
    () => selectNewestWindow(timeline, TIMELINE_WINDOW_SIZE, revealedEarlier),
    [revealedEarlier, timeline],
  );

  return (
    <>
      {windowed.hiddenCount > 0 ? (
        <div className="mx-auto flex max-w-3xl justify-center px-4 py-2">
          <button
            type="button"
            onClick={() => setRevealedEarlier((current) => current + TIMELINE_WINDOW_SIZE)}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200"
          >
            Show earlier activity · {windowed.hiddenCount} hidden
          </button>
        </div>
      ) : null}
      {windowed.items.map((item) => (
        item.kind === 'segment' ? (
          <TimelineSegmentBubble
            key={`timeline-segment-${messageId}-${item.segmentIndex}-${item.ts}`}
            segment={item.segment}
            segmentIndex={item.segmentIndex}
            timestamp={item.ts}
            messageId={messageId}
            agent={agent}
            avatarUrl={avatarUrl}
            hostFileContext={hostFileContext}
          />
        ) : (
          <ToolCallBlock key={`timeline-tool-${messageId}-${item.tool.id}`} tool={item.tool} />
        )
      ))}
    </>
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

function normalizeSlashCategory(raw?: string | null): SlashCommand['category'] {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'session') return 'Session';
  if (value === 'model') return 'Model';
  if (value === 'export') return 'Export';
  return 'Debug';
}

export default function ChatInterface({ defaultProvider }: ChatInterfaceProps) {
  const chatState = useChatState();
  // Use context for persistent state (survives route navigation)
  const provider = chatState.provider;
  const setProvider = chatState.setProvider;
  const selectProviderAgent = chatState.selectProviderAgent;
  const agentId = chatState.agentId;
  const agentHostFileContext = useMemo<HostFileLinkContext>(() => ({
    source: 'agent-workspace',
    agent: agentId || 'main',
  }), [agentId]);
  const session = chatState.session;
  const selectedModel = chatState.selectedModel;
  const setSelectedModel = chatState.setSelectedModel;
  const switchModel = chatState.switchModel;
  const refreshChat = chatState.refreshChat;
  const historyError = chatState.historyError;
  const hasOlderHistory = chatState.hasOlderHistory;
  const isLoadingOlderHistory = chatState.isLoadingOlderHistory;
  const olderHistoryError = chatState.olderHistoryError;
  const loadOlderHistory = chatState.loadOlderHistory;
  const removeQueuedMessage = chatState.removeQueuedMessage;
  const wsConnected = chatState.wsConnected;
  const reconnectSocket = chatState.reconnectSocket;
  const pendingUserQuestions = chatState.pendingUserQuestions;
  const settlePendingUserQuestion = chatState.settlePendingUserQuestion;
  // Session controls
  const thinkingLevel = chatState.thinkingLevel;
  const sessionThinkingOptions = chatState.sessionThinkingOptions;
  const setThinkingLevel = chatState.setThinkingLevel;
  const reasoningVisibility = chatState.reasoningVisibility;
  const setReasoningVisibility = chatState.setReasoningVisibility;
  const fastModeEnabled = chatState.fastModeEnabled;
  const toggleFastMode = chatState.toggleFastMode;
  const compactionModelOverride = chatState.compactionModelOverride;
  const setCompactionModelOverride = chatState.setCompactionModelOverride;
  const compactionModelLoading = chatState.compactionModelLoading;
  const compactionModelError = chatState.compactionModelError;
  const sessionControlMutation = chatState.sessionControlMutation;
  const isSessionControlMutationActive = chatState.isSessionControlMutationActive;
  const sessionControlsError = chatState.sessionControlsError;
  const sessionControlsSupported = chatState.sessionControlsSupported;
  const ensureSessionControlsMetadataLoaded = chatState.ensureSessionControlsMetadataLoaded;
  const sessionTelemetry = chatState.sessionTelemetry;
  const sessionAvailability = chatState.sessionAvailability;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [agentZeroRecoveryPending, setAgentZeroRecoveryPending] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({ OPENCLAW: OPENCLAW_MODEL_FALLBACK });
  const [providerModelsLoading, setProviderModelsLoading] = useState<Record<string, boolean>>({});
  // catalog-known models whose provider is not connected, per provider.
  const [providerUnavailableModels, setProviderUnavailableModels] = useState<Record<string, string[]>>({});
  const [providerModelsError, setProviderModelsError] = useState<Record<string, string | null>>({});
  const [providerModelsValidated, setProviderModelsValidated] = useState<Record<string, boolean>>({});
  const [modelSwitching, setModelSwitching] = useState(false);
  const [modelSelectionError, setModelSelectionError] = useState<string | null>(null);
  const [modelSelectionNotice, setModelSelectionNotice] = useState<string | null>(null);
  const [newSessionPending, setNewSessionPending] = useState(false);
  const modelSwitchInFlightRef = useRef(false);
  const modelSwitchGenerationRef = useRef(0);
  const newSessionLeaseRef = useRef<Readonly<{
    generation: number;
    provider: string;
    agentId?: string;
    originSession: string;
  }> | null>(null);
  const newSessionTargetRef = useRef<string | null>(null);
  const newSessionGenerationRef = useRef(0);
  const providerModelRequestGateRef = useRef<ReturnType<typeof createAgentChatProviderModelRequestGate> | null>(null);
  if (!providerModelRequestGateRef.current) {
    providerModelRequestGateRef.current = createAgentChatProviderModelRequestGate();
  }
  const providerRef = useRef(provider);
  const sessionRef = useRef(session);
  const agentIdRef = useRef(agentId);
  providerRef.current = provider;
  sessionRef.current = session;
  agentIdRef.current = agentId;
  const agentZeroAutoSelectionAttemptRef = useRef<string | null>(null);
  const [compactionAvailableModels, setCompactionAvailableModels] = useState<string[]>(OPENCLAW_MODEL_FALLBACK);
  const [compactionModelOptionsLoading, setCompactionModelOptionsLoading] = useState(false);
  const [providerCatalog, setProviderCatalog] = useState<Record<string, Partial<AgentChatProviderCatalogEntry> & {
    capabilities?: ProviderCapabilities;
    slashCommands?: SlashCommandInfo[];
    slashCommandsLoaded?: boolean;
    slashCommandsLoading?: boolean;
  }>>({});
  const [providerCatalogRevalidation, setProviderCatalogRevalidation] = useState<
    AgentChatSelectedProviderRevalidationState | null
  >(null);
  const [providerCatalogRefreshNonce, setProviderCatalogRefreshNonce] = useState(0);
  const providerCatalogGenerationRef = useRef(0);
  const lastProviderCatalogRetryRef = useRef(0);
  const [deferGatewayMetadata, setDeferGatewayMetadata] = useState(true);
  const initialHistoryLoadStartedRef = useRef(false);

  // Apply defaultProvider on first mount if provided
  useEffect(() => {
    if (defaultProvider && defaultProvider !== provider) {
      setProvider(defaultProvider);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);
  const [compatibilityHotfixStatus, setCompatibilityHotfixStatus] = useState<CompatibilityHotfixStatus | null>(null);
  const [compatibilityHotfixLoading, setCompatibilityHotfixLoading] = useState(false);
  const [compatibilityHotfixApplying, setCompatibilityHotfixApplying] = useState(false);
  const [compatibilityHotfixMessage, setCompatibilityHotfixMessage] = useState<string | null>(null);
  const [compatibilityHotfixConfirmationOpen, setCompatibilityHotfixConfirmationOpen] = useState(false);
  const [sessionControlsLoading, setSessionControlsLoading] = useState(false);

  useEffect(() => {
    const targetProvider = normalizeAgentChatProvider(provider);
    const requestGeneration = ++providerCatalogGenerationRef.current;
    setProviderCatalogRevalidation((current) => reduceAgentChatSelectedProviderRevalidation(
      current,
      {
        type: 'begin',
        provider: targetProvider,
        generation: requestGeneration,
        requestVersion: providerCatalogRefreshNonce,
      },
    ));
    if (provider === 'OPENCLAW') {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const force = providerCatalogRefreshNonce > lastProviderCatalogRetryRef.current;
    if (force) lastProviderCatalogRetryRef.current = providerCatalogRefreshNonce;
    const applySnapshot = (
      providers: AgentChatProviderCatalogEntry[],
      metadata: AgentChatProviderCatalogSnapshotMetadata,
    ) => {
      if (cancelled) return;
      setProviderCatalog((current) => {
        const next = { ...current };
        for (const entry of providers) {
          const key = normalizeAgentChatProvider(entry?.name);
          if (!key) continue;
          next[key] = {
            ...(current[key] || {}),
            ...entry,
            capabilities: {
              ...(current[key]?.capabilities || {}),
              ...(entry?.capabilities || {}),
            },
          };
        }
        return next;
      });
      setProviderCatalogRevalidation((current) => reduceAgentChatSelectedProviderRevalidation(
        current,
        {
          type: 'snapshot',
          provider: targetProvider,
          generation: requestGeneration,
          providers,
          metadata,
        },
      ));
    };
    loadAgentChatProviderCatalog({
      force,
      signal: controller.signal,
      onSnapshot: applySnapshot,
    })
      .then(() => {
        if (cancelled) return;
        setProviderCatalogRevalidation((current) => reduceAgentChatSelectedProviderRevalidation(
          current,
          {
            type: 'failure',
            provider: targetProvider,
            generation: requestGeneration,
            error: `${targetProvider} availability was not returned by the provider catalog. Retry to check again.`,
          },
        ));
      })
      .catch((error) => {
        if (!cancelled && !isAgentChatProviderCatalogAbortError(error)) {
          setProviderCatalogRevalidation((current) => reduceAgentChatSelectedProviderRevalidation(
            current,
            {
              type: 'failure',
              provider: targetProvider,
              generation: requestGeneration,
              error: formatAgentChatProviderCatalogLoadError(error),
            },
          ));
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [provider, providerCatalogRefreshNonce]);

  const showHeartbeatModel = provider === 'OPENCLAW' && isAdmin && (!agentId || agentId === 'main');
  const showCompatibilityHotfix = provider === 'OPENCLAW' && isAdmin;
  const canApplyCompatibilityHotfix = provider === 'OPENCLAW' && isOwner(user);
  const {
    heartbeatModel,
    heartbeatModelLoading,
    heartbeatModelMutating,
    heartbeatModelError,
    loadHeartbeatModel,
    setHeartbeatModel: handleHeartbeatModelChange,
    isHeartbeatModelMutationActive,
  } = useAgentChatHeartbeatModel({
    enabled: showHeartbeatModel,
    sessionKey: session,
  });

  const sessionSettingNavigationBusy = sessionControlMutation !== null || heartbeatModelMutating;
  const blockForChatContextMutation = useCallback((action: string): boolean => {
    const sessionSettingActive = isSessionControlMutationActive() || isHeartbeatModelMutationActive();
    if (!sessionSettingActive && !newSessionLeaseRef.current) return false;
    setModelSelectionError(sessionSettingActive
      ? `Wait for the current session setting to finish before ${action}.`
      : `Wait for the new chat to finish starting before ${action}.`);
    return true;
  }, [isHeartbeatModelMutationActive, isSessionControlMutationActive]);

  useEffect(() => {
    const lease = newSessionLeaseRef.current;
    const target = newSessionTargetRef.current;
    if (!lease || !target || session !== target) return;
    newSessionLeaseRef.current = null;
    newSessionTargetRef.current = null;
    setNewSessionPending(false);
  }, [session]);

  const loadCompatibilityHotfixStatus = useCallback(async () => {
    if (!showCompatibilityHotfix) {
      setCompatibilityHotfixStatus(null);
      setCompatibilityHotfixMessage(null);
      return;
    }
    setCompatibilityHotfixLoading(true);
    try {
      const status = await gatewayAPI.getCompatibilityHotfixStatus();
      setCompatibilityHotfixStatus(status);
    } catch (err) {
      console.error('[ChatInterface] Failed to load compatibility hotfix status:', err);
      setCompatibilityHotfixStatus(null);
      setCompatibilityHotfixMessage('Could not load hotfix status right now.');
    } finally {
      setCompatibilityHotfixLoading(false);
    }
  }, [showCompatibilityHotfix]);

  useEffect(() => {
    if (!showCompatibilityHotfix) {
      setCompatibilityHotfixStatus(null);
      setCompatibilityHotfixLoading(false);
      setCompatibilityHotfixApplying(false);
      setCompatibilityHotfixMessage(null);
    }
  }, [showCompatibilityHotfix]);

  const _loadProviderCommands = useCallback(async (targetProvider: string, options?: { force?: boolean }) => {
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

  const ensureProviderModelsLoaded = useCallback(async (rawProvider: string, options?: { force?: boolean }) => {
    const targetProvider = normalizeAgentChatProvider(rawProvider);
    if (!targetProvider) return [];
    const requestGate = providerModelRequestGateRef.current!;
    const requestGeneration = requestGate.begin(targetProvider);
    const isCurrentRequest = () => requestGate.isCurrent(targetProvider, requestGeneration);
    if (options?.force) invalidateAgentChatProviderModelsCache(targetProvider);
    // Agent Zero's catalog is the authority for whether a persisted model may
    // become active. Revalidate it on every provider entry instead of allowing
    // a process-local cache from an earlier visit to reactivate a stale model.
    const cachedModels = targetProvider === 'AGENT_ZERO'
      ? null
      : getAgentChatProviderModelsCache(targetProvider);
    if (cachedModels) {
      setProviderModelsLoading((prev) => ({ ...prev, [targetProvider]: false }));
      setProviderModelsError((prev) => ({ ...prev, [targetProvider]: null }));
      setProviderModels((prev) => ({
        ...prev,
        [targetProvider]: cachedModels.models,
      }));
      if (cachedModels.capabilities) {
        setProviderCatalog((prev) => ({
          ...prev,
          [targetProvider]: {
            ...(prev[targetProvider] || {}),
            capabilities: {
              ...(prev[targetProvider]?.capabilities || {}),
              ...cachedModels.capabilities,
            },
          },
        }));
      }
      return cachedModels.models;
    }

    if (targetProvider === 'AGENT_ZERO') {
      setProviderModelsValidated((prev) => ({ ...prev, [targetProvider]: false }));
      setProviderModels((prev) => ({ ...prev, [targetProvider]: [] }));
    }
    setProviderModelsLoading((prev) => ({ ...prev, [targetProvider]: true }));
    setProviderModelsError((prev) => ({ ...prev, [targetProvider]: null }));

    try {
      const { provider: providerName, models, capabilities, unavailableModelIds } = await gatewayAPI.models(targetProvider);
      setProviderUnavailableModels((prev) => ({
        ...prev,
        [targetProvider]: Array.isArray(unavailableModelIds) ? unavailableModelIds : [],
      }));
      const responseProvider = normalizeAgentChatProvider(providerName) || targetProvider;
      const normalizedModels = normalizeAgentChatModelCatalog(targetProvider, (models || []).map((model) => model.id));
      if (!isCurrentRequest()) return [];
      const cached = { models: normalizedModels, capabilities };
      setAgentChatProviderModelsCache(targetProvider, cached);
      if (responseProvider !== targetProvider) setAgentChatProviderModelsCache(responseProvider, cached);
      setProviderModels((prev) => ({
        ...prev,
        [targetProvider]: normalizedModels,
        ...(responseProvider !== targetProvider ? { [responseProvider]: normalizedModels } : {}),
      }));
      if (targetProvider === 'AGENT_ZERO') {
        setProviderModelsValidated((prev) => ({ ...prev, [targetProvider]: true }));
      }
      if (capabilities) {
        setProviderCatalog((prev) => ({
          ...prev,
          [targetProvider]: {
            ...(prev[targetProvider] || {}),
            capabilities: {
              ...(prev[targetProvider]?.capabilities || {}),
              ...capabilities,
            },
          },
        }));
      }
      return normalizedModels;
    } catch (error: any) {
      if (!isCurrentRequest()) return [];
      const message = modelSelectionErrorMessage(
        error,
        `Could not load ${getAgent(targetProvider).name} models.`,
      );
      setProviderModelsError((prev) => ({ ...prev, [targetProvider]: message }));
      if (targetProvider === 'AGENT_ZERO') {
        setProviderModelsValidated((prev) => ({ ...prev, [targetProvider]: false }));
        setProviderModels((prev) => ({ ...prev, [targetProvider]: [] }));
      }
      if (targetProvider === 'OPENCLAW') {
        setProviderModels((prev) => ({ ...prev, OPENCLAW: OPENCLAW_MODEL_FALLBACK }));
        return OPENCLAW_MODEL_FALLBACK;
      }
      throw error;
    } finally {
      if (isCurrentRequest()) {
        setProviderModelsLoading((prev) => ({ ...prev, [targetProvider]: false }));
      }
    }
  }, []);

  const handleAiProviderSetupComplete = useCallback(() => {
    invalidateAgentChatProviderModelsCache();
    providerCommandsCache.clear();
    agentZeroAutoSelectionAttemptRef.current = null;
    for (const providerName of new Set(['OPENCLAW', 'GEMINI', provider])) {
      void ensureProviderModelsLoaded(providerName, { force: true }).catch(() => undefined);
    }
  }, [ensureProviderModelsLoaded, provider]);

  useEffect(() => {
    if (deferGatewayMetadata) return;
    void ensureProviderModelsLoaded(provider).catch(() => undefined);
  }, [deferGatewayMetadata, ensureProviderModelsLoaded, provider]);

  useEffect(() => {
    modelSwitchGenerationRef.current += 1;
    modelSwitchInFlightRef.current = false;
    agentZeroAutoSelectionAttemptRef.current = null;
    setModelSwitching(false);
    setModelSelectionError(null);
    setModelSelectionNotice(null);
    if (provider === 'AGENT_ZERO') {
      setProviderModelsValidated((prev) => ({ ...prev, AGENT_ZERO: false }));
      setProviderModels((prev) => ({ ...prev, AGENT_ZERO: [] }));
    }
  }, [provider]);

  useEffect(() => {
    if (provider === 'AGENT_ZERO') return;
    const cachedModels = getAgentChatProviderModelsCache(provider);
    if (!cachedModels) return;
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
  }, [provider]);

  useEffect(() => {
    if (deferGatewayMetadata || !settingsOpen) return;
    let cancelled = false;
    const cached = getAgentChatProviderModelsCache('OPENCLAW');
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
        const normalizedModels = Array.from(new Set((models || []).map((m) => canonicalizePortalModelId(m.id)).filter(Boolean)));
        setAgentChatProviderModelsCache(providerName, { models: normalizedModels, capabilities });
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
  }, [deferGatewayMetadata, settingsOpen]);

  const providerMeta = providerCatalog[provider] || (provider === 'OPENCLAW'
    ? {
        capabilities: {
          supportsModelSelection: true,
          supportsCustomModelInput: true,
          modelCatalogKind: 'dynamic' as const,
          supportsInTurnSteering: true,
        },
      }
    : {});
  const availableModels = useMemo(
    () => providerModels[provider] || [],
    [provider, providerModels],
  );
  const currentProviderModelsLoading = providerModelsLoading[provider] === true;
  const currentProviderModelsError = providerModelsError[provider] || null;
  const currentProviderModelsValidated = providerModelsValidated[provider] === true;
  const canSelectModel = providerMeta.capabilities?.supportsModelSelection === true;
  const supportsCustomModelInput = providerMeta.capabilities?.supportsCustomModelInput !== false;
  const modelCatalogKind = (providerMeta.capabilities?.modelCatalogKind === 'declared' || providerMeta.capabilities?.modelCatalogKind === 'none' || providerMeta.capabilities?.modelCatalogKind === 'dynamic')
    ? providerMeta.capabilities.modelCatalogKind
    : (availableModels.length > 0 ? 'dynamic' : 'none');
  const providerLabel = getAgent(provider).name;
  const providerCatalogCandidate = providerCatalog[provider];
  const currentProviderCatalogEntry = providerCatalogCandidate?.name && providerCatalogCandidate.displayName
    ? providerCatalogCandidate as AgentChatProviderCatalogEntry
    : undefined;
  const providerCatalogLoading = isAgentChatSelectedProviderRevalidationPending(
    provider,
    providerCatalogRevalidation,
    providerCatalogRefreshNonce,
  );
  const providerCatalogLoadError = providerCatalogRevalidation?.provider === normalizeAgentChatProvider(provider)
    && providerCatalogRevalidation.requestVersion === providerCatalogRefreshNonce
    ? providerCatalogRevalidation.loadError
    : null;
  const currentProviderAvailability = assessAgentChatProviderAvailability(
    provider,
    currentProviderCatalogEntry,
    {
      loading: providerCatalogLoading,
      loadError: providerCatalogLoadError,
    },
  );
  const agentZeroStoredModelCandidate = provider === 'AGENT_ZERO' && typeof window !== 'undefined'
    ? String(localStorage.getItem('agentChats.lastModel.AGENT_ZERO') || '').trim()
    : '';
  const agentZeroCatalogSelection = provider === 'AGENT_ZERO'
    ? resolveAgentZeroCatalogModel(selectedModel || agentZeroStoredModelCandidate, availableModels)
    : '';
  const agentZeroSelectedModelVerified = provider === 'AGENT_ZERO'
    && currentProviderModelsValidated
    && Boolean(selectedModel)
    && availableModels.includes(selectedModel);
  const agentZeroModelReady = provider !== 'AGENT_ZERO' || (
    agentZeroSelectedModelVerified
    && selectedModel === agentZeroCatalogSelection
    && !currentProviderModelsLoading
    && !currentProviderModelsError
    && !modelSwitching
  );
  const agentZeroModelBlockedReason = provider !== 'AGENT_ZERO' || agentZeroModelReady
    ? null
    : currentProviderModelsError
      ? 'Agent Zero’s connected model catalog could not be loaded. Retry it before sending.'
      : currentProviderModelsLoading || modelSwitching
        ? 'Agent Zero is loading and applying a connected model. Wait a moment before sending.'
        : availableModels.length === 0
          ? 'Connect an Agent Zero model account in AI Providers before sending.'
          : 'Choose one of Agent Zero’s connected models before sending.';
  const providerAvailabilityBlockedReason = currentProviderAvailability.canSend
    ? null
    : currentProviderAvailability.message;
  const sendBlockedReason = providerAvailabilityBlockedReason || agentZeroModelBlockedReason;
  const chatSendReady = currentProviderAvailability.canSend && agentZeroModelReady;
  const agentZeroRecoveryError = provider === 'AGENT_ZERO'
    ? historyError || currentProviderModelsError || modelSelectionError
    : null;
  const retryAgentZeroRecovery = useCallback(async () => {
    if (agentZeroRecoveryPending) return;
    setAgentZeroRecoveryPending(true);
    setModelSelectionError(null);
    // A failed automatic model apply records a dedupe key so ordinary renders
    // do not hammer the session endpoint. An explicit Retry is new user intent:
    // clear that key so a freshly verified catalog can apply Terra again.
    agentZeroAutoSelectionAttemptRef.current = null;
    try {
      const attempts: Promise<unknown>[] = [
        ensureProviderModelsLoaded('AGENT_ZERO', { force: true }),
      ];
      if (historyError) attempts.push(refreshChat());
      await Promise.allSettled(attempts);
    } finally {
      setAgentZeroRecoveryPending(false);
    }
  }, [agentZeroRecoveryPending, ensureProviderModelsLoaded, historyError, refreshChat]);
  const reportBlockedSend = useCallback(() => {
    // Provider availability has its own persistent barrier and retry control.
    // Model errors remain in the model-selection channel so the two readiness
    // contracts never collapse into one ambiguous failure.
    if (!providerAvailabilityBlockedReason && agentZeroModelBlockedReason) {
      setModelSelectionError(agentZeroModelBlockedReason);
    }
  }, [agentZeroModelBlockedReason, providerAvailabilityBlockedReason]);
  const liveSteerEnabled = providerMeta.capabilities?.supportsInTurnSteering === true;
  const runningComposerPlaceholder = pendingUserQuestions.length > 0
    ? 'Answer the waiting question…'
    : liveSteerEnabled
      ? 'OpenClaw is working, send a steering message for this turn…'
      : 'Agent is working, queue a follow-up message…';
  const providerCommandCount = providerMeta.slashCommands?.length || 0;
  const providerCommandStatus = providerMeta.slashCommandsLoaded
    ? `${providerCommandCount} provider command${providerCommandCount === 1 ? '' : 's'}`
    : providerMeta.slashCommandsLoading
      ? 'Loading provider commands…'
      : 'Provider commands on demand';

  useEffect(() => {
    if (provider !== 'OPENCLAW' || !selectedModel || !availableModels.length) return;
    const normalized = canonicalizePortalModelId(selectedModel);
    if (normalized && isKnownOpenClawCatalogModel(normalized) && !availableModels.includes(normalized)) {
      setSelectedModel('');
    }
  }, [availableModels, provider, selectedModel, setSelectedModel]);

  const publicSettings = usePublicSettings();
  const userAvatarUrl = useUserAvatarUrl();
  const [agentAvatars, setAgentAvatars] = useState<Record<string, string>>({});
  const [subAgentAvatars, setSubAgentAvatars] = useState<Record<string, string>>({});
  const [assistantName, setAssistantName] = useState<string>('');
  const [defaultOpenClawAgentId, setDefaultOpenClawAgentId] = useState<string>('main');
  const [avatarEditorProvider, setAvatarEditorProvider] = useState<string | null>(null);

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
  const slashMenuId = React.useId();

  const uploadFileToServer = useCallback(async (file: File, attachId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await workspaceAuthorizedFetch('/api/files/', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data = await resp.json();
      const fileId = typeof data?.id === 'string' ? data.id : undefined;
      const serverPath = typeof data?.diskPath === 'string' ? data.diskPath : undefined;
      const toolUrl = typeof data?.toolUrl === 'string' ? data.toolUrl : undefined;
      setPendingAttachments(prev => prev.map(a =>
        a.id === attachId ? { ...a, fileId, serverPath, toolUrl, uploadStatus: 'done' as const } : a
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
    pendingApprovals: streamPendingApprovals,
    resolveApproval: streamResolveApproval,
    dismissApproval: streamDismissApproval,
    compactionPhase,
    thinkingContent,
    thinkingSubject,
    streamSegments,
    activityTitles,
  } = useAgentRuntime({
    provider,
    session,
    model: selectedModel || undefined,
    agentId,
    canSend: chatSendReady,
    onSendBlocked: reportBlockedSend,
    onSessionResolved: handleSessionResolved,
  });

  const [revealedEarlierMessages, setRevealedEarlierMessages] = useState(0);
  const messageWindow = useMemo(
    () => selectNewestWindow(messages, MESSAGE_WINDOW_SIZE, revealedEarlierMessages),
    [messages, revealedEarlierMessages],
  );
  const visibleMessageStartIndex = messages.length - messageWindow.items.length;
  const messageRevealAnchorRef = useRef<{
    sessionKey: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageWindowSessionKey = `${provider}:${session}`;

  useEffect(() => {
    messageRevealAnchorRef.current = null;
    setRevealedEarlierMessages(0);
  }, [messageWindowSessionKey]);

  useLayoutEffect(() => {
    const anchor = messageRevealAnchorRef.current;
    if (!anchor) return;
    if (isLoadingOlderHistory) return;
    messageRevealAnchorRef.current = null;
    if (anchor.sessionKey !== messageWindowSessionKey) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = anchoredScrollTop(anchor, container.scrollHeight);
  }, [isLoadingOlderHistory, messageWindow.items.length, messageWindowSessionKey, revealedEarlierMessages]);

  const revealEarlierMessages = useCallback(() => {
    const container = scrollRef.current;
    if (container) {
      messageRevealAnchorRef.current = {
        sessionKey: messageWindowSessionKey,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }
    setRevealedEarlierMessages((current) => current + MESSAGE_WINDOW_SIZE);
  }, [messageWindowSessionKey]);

  const loadEarlierMessages = useCallback(async () => {
    if (isLoadingOlderHistory || isLoadingHistory) return;
    if (messageWindow.hiddenCount > 0) {
      revealEarlierMessages();
      return;
    }
    if (!hasOlderHistory) return;

    const container = scrollRef.current;
    if (container) {
      messageRevealAnchorRef.current = {
        sessionKey: messageWindowSessionKey,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }
    const added = await loadOlderHistory();
    if (added > 0) {
      // Keep every page the user deliberately loaded mounted. The server keeps
      // initial state bounded; this grows only as the user asks for older rows.
      setRevealedEarlierMessages((current) => current + added);
    }
  }, [hasOlderHistory, isLoadingHistory, isLoadingOlderHistory, loadOlderHistory, messageWindow.hiddenCount, messageWindowSessionKey, revealEarlierMessages]);

  const handleChatScroll = useCallback(() => {
    handleScroll();
    const container = scrollRef.current;
    if (!container || container.scrollTop > 72) return;
    if (olderHistoryError || isLoadingOlderHistory || isLoadingHistory) return;
    if (messageWindow.hiddenCount > 0 || hasOlderHistory) {
      void loadEarlierMessages();
    }
  }, [handleScroll, hasOlderHistory, isLoadingHistory, isLoadingOlderHistory, loadEarlierMessages, messageWindow.hiddenCount, olderHistoryError]);

  useEffect(() => {
    initialHistoryLoadStartedRef.current = false;
    setDeferGatewayMetadata(true);
  }, [session, provider]);

  useEffect(() => {
    if (isLoadingHistory) {
      initialHistoryLoadStartedRef.current = true;
    }
  }, [isLoadingHistory]);

  useEffect(() => {
    if (!deferGatewayMetadata) return;
    if (messages.length > 0) {
      setDeferGatewayMetadata(false);
      return;
    }
    if (initialHistoryLoadStartedRef.current && !isLoadingHistory) {
      setDeferGatewayMetadata(false);
    }
  }, [deferGatewayMetadata, isLoadingHistory, messages.length]);

  const sendButtonTitle = sendBlockedReason
    || (isRunning
      ? (liveSteerEnabled ? 'Interrupt and steer the running turn' : 'Queue follow-up after current turn')
      : `Send message to ${providerLabel}`);
  const sendButtonDescriptionId = providerAvailabilityBlockedReason
    ? 'agent-chat-provider-availability'
    : agentZeroModelBlockedReason
      ? 'agent-zero-model-requirement'
      : undefined;

  // Global exec approval listener (works even when no chat stream is active)
  const {
    pendingApprovals: globalPendingApprovals,
    resolveApproval: globalResolveApproval,
    dismissApproval: globalDismissApproval,
  } = useExecApprovals({ enabled: !deferGatewayMetadata });

  const pendingApprovals = useMemo(
    () => mergeExecApprovalQueues(streamPendingApprovals, globalPendingApprovals),
    [streamPendingApprovals, globalPendingApprovals],
  );
  const pendingApproval = pendingApprovals[0] || null;

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'allow-once' | 'deny' | 'allow-always',
  ) => {
    if (streamPendingApprovals.some((approval) => approval.id === approvalId)) {
      await streamResolveApproval(approvalId, decision);
      return;
    }
    await globalResolveApproval(approvalId, decision);
  }, [globalResolveApproval, streamPendingApprovals, streamResolveApproval]);

  const dismissApproval = useCallback((approvalId?: string) => {
    if (!approvalId) {
      streamDismissApproval();
      globalDismissApproval();
      return;
    }
    if (streamPendingApprovals.some((approval) => approval.id === approvalId)) {
      streamDismissApproval(approvalId);
    }
    if (globalPendingApprovals.some((approval) => approval.id === approvalId)) {
      globalDismissApproval(approvalId);
    }
  }, [globalDismissApproval, globalPendingApprovals, streamDismissApproval, streamPendingApprovals]);

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
  const localSlashCommandCoordinator = useMemo(createLocalSlashCommandCoordinator, []);
  const agent = getAgent(provider);
  const sendButtonClassName = `flex-shrink-0 p-2.5 sm:p-3 rounded-xl ${agent.sendBg} ${agent.sendHover} text-white transition-all duration-200 shadow-lg ${agent.sendShadow} hover:scale-105 active:scale-95 touch-target disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100 disabled:active:scale-100`;
  const providerSlashCommands = useMemo(
    () => providerMeta.slashCommands || [],
    [providerMeta.slashCommands],
  );
  const providerSlashSuggestions = useMemo<SlashCommand[]>(() => providerSlashCommands.map((command) => ({
    command: command.command,
    description: command.description,
    category: normalizeSlashCategory(command.category),
    argsHint: command.argsHint,
    executeLocal: false,
  })), [providerSlashCommands]);
  const streamIsStale = isRunning && !wsConnected;
  const showConnectionLost = streamIsStale;
  const idleConnectionStatus = provider === 'OPENCLAW' && !isRunning && queueCount === 0 && sessionAvailability === 'present'
    ? (wsConnected ? 'Connected' : 'Disconnected')
    : null;
  const contextSummary = useMemo(() => (
    provider === 'OPENCLAW'
      ? getOpenClawContextSummary({
          telemetry: sessionTelemetry,
          isRunning,
          compactionPhase,
          statusText: statusText || idleConnectionStatus,
        })
      : null
  ), [provider, sessionTelemetry, isRunning, compactionPhase, statusText, idleConnectionStatus]);

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

  const buildNewSessionKey = useCallback((targetProvider: string, requestedAgentId?: string) => {
    if (targetProvider === 'OPENCLAW' && isOwner(user)) {
      const targetAgentId = (requestedAgentId && requestedAgentId.trim()) ? requestedAgentId.trim() : 'main';
      return `agent:${targetAgentId}:new-${Date.now()}`;
    }
    return `new-${Date.now()}`;
  }, [user]);

  const refreshSlashAutocomplete = useCallback((value: string) => {
    const localMatches = matchSlashCommands(value);
    const lower = value.trim().toLowerCase();
    const providerMatches = !lower.startsWith('/')
      ? []
      : providerSlashSuggestions.filter((command) => command.command.toLowerCase().startsWith(lower));
    const seen = new Set<string>();
    const matches = [...localMatches, ...providerMatches].filter((command) => {
      const key = command.command.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setSlashMatch({
      isOpen: value.trim().startsWith('/') && matches.length > 0,
      query: value.trim(),
      selectedIndex: 0,
      matches,
    });
  }, [providerSlashSuggestions]);

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

  const startNewSession = useCallback(async (options?: { cancelRunning?: boolean }): Promise<boolean> => {
    if (blockForChatContextMutation('starting a new chat')) return false;
    if (newSessionLeaseRef.current) return false;
    const snapshot = Object.freeze({
      generation: ++newSessionGenerationRef.current,
      provider: providerRef.current,
      agentId: agentIdRef.current,
      originSession: sessionRef.current,
    });
    newSessionLeaseRef.current = snapshot;
    newSessionTargetRef.current = null;
    setNewSessionPending(true);
    setModelSelectionError(null);
    const isCurrent = () => (
      newSessionLeaseRef.current === snapshot
      && providerRef.current === snapshot.provider
      && agentIdRef.current === snapshot.agentId
      && sessionRef.current === snapshot.originSession
    );
    const nextSession = buildNewSessionKey(snapshot.provider, snapshot.agentId);
    let resolvedSessionKey = nextSession;
    let sessionCommitted = false;
    try {
      if (options?.cancelRunning) await chatState.cancelStream();
      if (!isCurrent()) return false;

      if (snapshot.provider === 'OPENCLAW') {
        try {
          const created = await gatewayAPI.createSession(nextSession, snapshot.provider);
          if (!isCurrent()) return false;
          const createdKey = typeof created?.key === 'string' ? created.key.trim() : '';
          if (createdKey) resolvedSessionKey = createdKey;
        } catch (err) {
          console.warn('[ChatInterface] Failed to pre-create OpenClaw session:', err);
          if (!isCurrent()) return false;
        }
      }

      chatState.clearMessages();
      resolvedSessionRef.current = null;
      newSessionTargetRef.current = resolvedSessionKey;
      chatState.setSession(resolvedSessionKey);
      setPendingAttachments([]);
      sessionCommitted = true;
      return true;
    } finally {
      if (!sessionCommitted && newSessionLeaseRef.current === snapshot) {
        newSessionLeaseRef.current = null;
        newSessionTargetRef.current = null;
        setNewSessionPending(false);
      }
    }
  }, [blockForChatContextMutation, buildNewSessionKey, chatState]);

  // Model change handler — context handles localStorage persistence. Return a
  // success bit so both the picker and `/model` command use the same rollback,
  // launch-bound handoff, and visible error path without reporting a false
  // success message.
  const handleModelChange = useCallback(
    async (model: string): Promise<boolean> => {
      if (blockForChatContextMutation('changing models')) return false;
      if (isAgentZeroDefaultModelAlias(provider, model)) {
        setModelSelectionNotice(null);
        setModelSelectionError('Agent Zero requires an exact model from a connected OAuth provider. Choose one of its available models instead of Default or reset.');
        return false;
      }
      if (modelSwitchInFlightRef.current) return false;
      const operationProvider = provider;
      const operationSession = session;
      const operationGeneration = modelSwitchGenerationRef.current + 1;
      modelSwitchGenerationRef.current = operationGeneration;
      const isCurrentHarness = () => (
        modelSwitchGenerationRef.current === operationGeneration
        && providerRef.current === operationProvider
      );
      const isCurrentSession = () => (
        isCurrentHarness() && sessionRef.current === operationSession
      );
      const previousModel = selectedModel;
      modelSwitchInFlightRef.current = true;
      setModelSwitching(true);
      setModelSelectionError(null);
      setModelSelectionNotice(null);
      try {
        await switchModel(model);
        if (!isCurrentSession()) return false;
        return true;
      } catch (err: any) {
        console.error('Failed to switch model for current session:', err);
        if (!isCurrentSession()) return false;
        if (isAgentChatLaunchBoundModelError(err)) {
          await startNewSession();
          if (!isCurrentHarness()) return false;
          const nextLabel = model ? modelDisplayName(model) : 'the provider default';
          setModelSelectionNotice(`${providerLabel} applies model changes when a session starts. A clean new chat is ready with ${nextLabel}.`);
          return true;
        }
        setSelectedModel(previousModel);
        setModelSelectionError(modelSelectionErrorMessage(
          err,
          `Could not switch ${providerLabel} to that model.`,
        ));
        return false;
      } finally {
        if (modelSwitchGenerationRef.current === operationGeneration) {
          modelSwitchInFlightRef.current = false;
          setModelSwitching(false);
        }
      }
    },
    [blockForChatContextMutation, provider, providerLabel, selectedModel, session, setSelectedModel, startNewSession, switchModel],
  );

  const handleNativeSetupModelSelected = useCallback(async (nativeProvider: 'GEMINI', model: string): Promise<boolean> => {
    if (nativeProvider === 'GEMINI' && provider === 'GEMINI') {
      return handleModelChange(model);
    }
    return true;
  }, [handleModelChange, provider]);

  // This intentionally returns a boolean synchronously. Submit events cannot
  // be cancelled after awaiting history/model work: by then the composer has
  // already sent the slash command to the provider.
  const maybeExecuteSlashCommand = useCallback((event: LocalSlashCommandEvent) => {
    const textarea = composerInputRef.current;
    if (!textarea) return false;

    return localSlashCommandCoordinator.claim({
      rawValue: textarea.value,
      provider,
      providerSlashCommands,
      event,
      clearComposer: () => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(textarea, '');
        } else {
          textarea.value = '';
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
        textarea.style.height = 'auto';
      },
      execute: async (parsed) => {
        if (parsed.command.command === '/export') {
          try {
            const completeHistory = await chatState.getCompleteHistory();
            downloadChatMarkdown(completeHistory);
            chatState.setMessages((current) => [...current, {
              id: `local-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: 'system',
              content: `Exported the complete chat as markdown (${completeHistory.length} messages).`,
              createdAt: new Date(),
            }]);
          } catch (err: any) {
            chatState.setMessages((current) => [...current, {
              id: `local-export-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: 'system',
              content: `Couldn’t export the complete chat: ${String(err?.message || err || 'Unknown error')}`,
              createdAt: new Date(),
            }]);
          }
        } else {
          await executeSlashCommand(parsed.command, parsed.args, chatState, {
            onNewSession: async () => {
              const started = await startNewSession();
              if (!started) throw new Error('A new chat is already starting.');
            },
            onModelChange: handleModelChange,
          });
        }
      },
      onError: (err) => {
        console.error('[ChatInterface] Failed to execute local slash command:', err);
      },
    });
  }, [chatState, handleModelChange, localSlashCommandCoordinator, provider, providerSlashCommands, startNewSession]);

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

  useEffect(() => {
    if (provider !== 'AGENT_ZERO') {
      agentZeroAutoSelectionAttemptRef.current = null;
      return;
    }
    if (currentProviderModelsLoading || currentProviderModelsError || modelSwitching) return;
    if (!currentProviderModelsValidated) return;

    const nextModel = resolveAgentZeroCatalogModel(
      selectedModel || agentZeroStoredModelCandidate,
      availableModels,
    );
    if (!nextModel || nextModel === selectedModel) {
      agentZeroAutoSelectionAttemptRef.current = null;
      return;
    }

    const attemptKey = `${session}\u0000${selectedModel}\u0000${availableModels.join('\u0000')}`;
    if (agentZeroAutoSelectionAttemptRef.current === attemptKey) return;
    agentZeroAutoSelectionAttemptRef.current = attemptKey;
    void handleModelChange(nextModel);
  }, [
    availableModels,
    agentZeroStoredModelCandidate,
    currentProviderModelsError,
    currentProviderModelsLoading,
    currentProviderModelsValidated,
    handleModelChange,
    modelSwitching,
    provider,
    selectedModel,
    session,
  ]);

  const handleViewGatewaySession = useCallback(
    (sessionKey: string) => {
      if (!sessionKey) return;
      if (blockForChatContextMutation('opening another session')) return;
      if (modelSwitchInFlightRef.current) {
        setModelSelectionError('Wait for the current model change to finish before opening another session.');
        return;
      }
      resolvedSessionRef.current = null;
      chatState.selectSession(sessionKey);
    },
    [blockForChatContextMutation, chatState],
  );

  useEffect(() => {
    if (publicSettings?.agentAvatars) setAgentAvatars(publicSettings.agentAvatars);
    if (publicSettings?.assistantName) setAssistantName(publicSettings.assistantName);
  }, [publicSettings]);

  useEffect(() => {
    let cancelled = false;

    async function loadClientSettings() {
      try {
        const { data } = await client.get('/settings/client');
        if (!cancelled) {
          if (data?.defaultOpenClawAgentId) {
            setDefaultOpenClawAgentId(data.defaultOpenClawAgentId);
          }
          if (data?.subAgentAvatars && typeof data.subAgentAvatars === 'object' && !Array.isArray(data.subAgentAvatars)) {
            setSubAgentAvatars(data.subAgentAvatars);
          }
        }
      } catch {
        // Keep the main-agent and no-avatar fallbacks when authenticated settings
        // are unavailable. The lazy /gateway/agents response can still supply an
        // avatar for each verified selector entry.
      }
    }

    loadClientSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectAgent = useCallback(
    async (selection: AgentSelection) => {
      if (blockForChatContextMutation('switching providers')) return;
      if (modelSwitchInFlightRef.current) {
        setModelSelectionError('Wait for the current model change to finish before switching providers.');
        return;
      }
      const selectionPlan = planAgentChatSelection(provider, agentId, selection);
      if (!selectionPlan.changed) return;
      // Detach the visible chat from the active stream without aborting it.
      // Switching agents/providers is navigation, not an implicit Stop click.
      // Fix: Clear messages FIRST to prevent stale history from showing.
      // The sequence must be: clear → update state atomically → load new history.
      // clearMessages() increments historyGenRef which invalidates any in-flight loads.
      clearMessages();
      // One context-owned transition keeps provider, OpenClaw agent identity,
      // and the matching last session coherent in the same browser event.
      selectProviderAgent(selection.provider, selectionPlan.nextAgentId);
    },
    [blockForChatContextMutation, provider, agentId, clearMessages, selectProviderAgent],
  );

  const handleNewChat = useCallback(() => {
    if (blockForChatContextMutation('starting a new chat')) return;
    sounds.click();
    void startNewSession({ cancelRunning: isRunning });
  }, [blockForChatContextMutation, isRunning, startNewSession]);

  // Build attachment text to prepend to message
  const buildAttachmentText = useCallback(
    () => buildPersistedChatAttachmentText(pendingAttachments),
    [pendingAttachments],
  );

  // Intercept send to prepend attachments
  const handleSendWithAttachments = useCallback((options?: { submit?: boolean }) => {
    if (pendingAttachments.length === 0) return false;
    // Block send while any file is still uploading
    const stillUploading = pendingAttachments.some(a => a.uploadStatus === 'uploading');
    if (stillUploading) return false;
    const attachText = buildAttachmentText();
    if (!composerInputRef.current) return false;
    const current = composerInputRef.current.value;
    const combined = attachText + current;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(composerInputRef.current, combined);
    composerInputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    if (options?.submit) {
      requestAnimationFrame(() => composerInputRef.current?.form?.requestSubmit());
    }
    setPendingAttachments([]);
    return true;
  }, [pendingAttachments, buildAttachmentText]);

  /**
   * Submit a streamed ask-question card through the composer. If the run is
   * paused, ChatStateProvider will only accept the text when exactly one
   * broker-owned single-question prompt is waiting.
   */
  const submitAskQuestionAnswer = useCallback((answerText: string) => {
    const trimmed = (answerText || '').trim();
    if (!trimmed || !composerInputRef.current) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(composerInputRef.current, trimmed);
    composerInputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(() => composerInputRef.current?.form?.requestSubmit());
  }, []);

  return (
    <AskQuestionAnswerProvider value={submitAskQuestionAnswer}>
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
                disabled={modelSwitching || sessionSettingNavigationBusy || newSessionPending}
                onChange={handleSelectAgent}
                onViewSession={handleViewGatewaySession}
                currentSessionKey={session}
                currentSessionActive={isRunning}
                activityTitles={activityTitles}
                agentAvatars={agentAvatars}
                subAgentAvatars={subAgentAvatars}
                assistantName={assistantName}
                defaultOpenClawAgentId={defaultOpenClawAgentId}
              />
            </div>

            <div className="flex items-center gap-1 sm:gap-2 ml-auto">
              {(canSelectModel || provider === 'AGENT_ZERO' || currentProviderModelsLoading || Boolean(currentProviderModelsError)) && (
                <ModelPicker
                  value={provider === 'AGENT_ZERO' && !agentZeroSelectedModelVerified ? '' : selectedModel}
                  onChange={handleModelChange}
                  models={availableModels}
                  loading={currentProviderModelsLoading || modelSwitching}
                  error={modelSelectionError || currentProviderModelsError}
                  supportsCustomModelInput={provider === 'AGENT_ZERO' ? false : supportsCustomModelInput}
                  modelCatalogKind={provider === 'AGENT_ZERO' ? 'dynamic' : modelCatalogKind}
                  disabled={isRunning || modelSwitching || sessionSettingNavigationBusy || newSessionPending}
                  allowDefaultModel={provider !== 'AGENT_ZERO'}
                  required={provider === 'AGENT_ZERO'}
                  emptyMessage="Connect an Agent Zero OAuth account in AI Providers to load selectable models."
                  unavailableModelIds={providerUnavailableModels[provider] || []}
                  onOpen={() => { void ensureProviderModelsLoaded(provider).catch(() => undefined); }}
                  onRetry={currentProviderModelsError
                    ? () => { void ensureProviderModelsLoaded(provider, { force: true }).catch(() => undefined); }
                    : undefined}
                />
              )}
              <SessionControls
                loading={sessionControlsLoading || currentProviderModelsLoading}
                thinkingLevel={thinkingLevel}
                thinkingOptions={sessionThinkingOptions}
                reasoningVisibility={reasoningVisibility}
                fastModeEnabled={fastModeEnabled}
                compactionModelOverride={compactionModelOverride}
                heartbeatModel={heartbeatModel}
                heartbeatModelLoading={heartbeatModelLoading}
                heartbeatModelError={heartbeatModelError}
                showHeartbeatModel={showHeartbeatModel}
                showCompatibilityHotfix={showCompatibilityHotfix}
                compatibilityHotfixStatus={compatibilityHotfixStatus}
                compatibilityHotfixLoading={compatibilityHotfixLoading}
                compatibilityHotfixApplying={compatibilityHotfixApplying}
                compatibilityHotfixMessage={compatibilityHotfixMessage}
                onRefreshCompatibilityHotfix={() => { void loadCompatibilityHotfixStatus(); }}
                onApplyCompatibilityHotfix={canApplyCompatibilityHotfix ? () => setCompatibilityHotfixConfirmationOpen(true) : undefined}
                onSetThinkingLevel={(level) => {
                  if (newSessionLeaseRef.current) return setModelSelectionError('Wait for the new chat to finish starting before changing session settings.');
                  void setThinkingLevel(level);
                }}
                onSetReasoningVisibility={(level) => {
                  if (newSessionLeaseRef.current) return setModelSelectionError('Wait for the new chat to finish starting before changing session settings.');
                  void setReasoningVisibility(level);
                }}
                onToggleFastMode={() => {
                  if (newSessionLeaseRef.current) return setModelSelectionError('Wait for the new chat to finish starting before changing session settings.');
                  void toggleFastMode();
                }}
                onSetCompactionModelOverride={(model) => {
                  if (newSessionLeaseRef.current) return setModelSelectionError('Wait for the new chat to finish starting before changing session settings.');
                  void setCompactionModelOverride(model);
                }}
                onSetHeartbeatModel={(model) => {
                  if (newSessionLeaseRef.current) return setModelSelectionError('Wait for the new chat to finish starting before changing session settings.');
                  void handleHeartbeatModelChange(model);
                }}
                availableModels={availableModels}
                compactionAvailableModels={compactionAvailableModels}
                compactionModelLoading={compactionModelLoading}
                compactionModelError={compactionModelError}
                compactionModelOptionsLoading={compactionModelOptionsLoading}
                sessionControlMutation={sessionControlMutation}
                sessionControlsError={sessionControlsError}
                sessionControlsSupported={sessionControlsSupported}
                onPanelOpen={() => {
                  if (newSessionLeaseRef.current) return;
                  setSessionControlsLoading(true);
                  void ensureSessionControlsMetadataLoaded({ force: true }).finally(() => setSessionControlsLoading(false));
                  void ensureProviderModelsLoaded(provider).catch(() => undefined);
                  void loadHeartbeatModel();
                  void loadCompatibilityHotfixStatus();
                }}
                disabled={newSessionPending || modelSwitching || isRunning}
                currentModel={selectedModel}
                sessionKey={session}
              />
              <button
                onClick={handleNewChat}
                disabled={sessionSettingNavigationBusy || newSessionPending}
                aria-busy={newSessionPending}
                aria-label={newSessionPending ? 'Starting new chat' : 'New chat'}
                className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/[0.08] transition-colors disabled:cursor-wait disabled:opacity-40"
                title={newSessionPending ? 'Starting new chat…' : 'New chat'}
              >
                {newSessionPending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <PenSquare size={16} />}
              </button>
              <StreamReconnectButton
                visible={showConnectionLost}
                onReconnect={reconnectSocket}
              />
              <button
                onClick={async () => {
                  if (isRefreshing) return;
                  setIsRefreshing(true);
                  try { await refreshChat(); } finally {
                    setTimeout(() => setIsRefreshing(false), 600);
                  }
                }}
                disabled={isRefreshing || newSessionPending}
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

          <ProviderAvailabilityBarrier
            assessment={currentProviderAvailability}
            loading={providerCatalogLoading}
            onRetry={() => setProviderCatalogRefreshNonce((nonce) => nonce + 1)}
          />

          {modelSelectionError && provider !== 'AGENT_ZERO' && (
            <div className="flex items-center gap-2 border-b border-red-500/15 bg-red-500/[0.07] px-3 py-2 text-xs text-red-200" role="alert" aria-live="assertive">
              <XCircle size={14} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{modelSelectionError}</span>
              <button type="button" onClick={() => setModelSelectionError(null)} className="min-h-[32px] rounded-lg px-2 text-red-100 hover:bg-red-500/10" aria-label="Dismiss model switch error">Dismiss</button>
            </div>
          )}

          {modelSelectionNotice && (
            <div className="flex items-center gap-2 border-b border-sky-500/15 bg-sky-500/[0.07] px-3 py-2 text-xs text-sky-100" role="status" aria-live="polite">
              <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{modelSelectionNotice}</span>
              <button type="button" onClick={() => setModelSelectionNotice(null)} className="min-h-[32px] rounded-lg px-2 text-sky-100 hover:bg-sky-500/10" aria-label="Dismiss model switch notice">Dismiss</button>
            </div>
          )}


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
              data-chat-scroll-container
              className="flex-1 overflow-y-auto"
              onScroll={handleChatScroll}
            >
              {isLoadingHistory && messages.length === 0 ? (
                /* Initial loading skeleton */
                <LoadingSkeletonList />
              ) : (historyError || agentZeroRecoveryError) && messages.length === 0 && !isSwitchingSession ? (
                <div className="flex h-full items-center justify-center px-5 py-12">
                  {provider === 'AGENT_ZERO' && agentZeroRecoveryError ? (
                    <AgentZeroRecoveryCard
                      message={agentZeroRecoveryError}
                      retrying={agentZeroRecoveryPending}
                      onRetry={() => { void retryAgentZeroRecovery(); }}
                      onRepair={isOwner(user) ? () => setSettingsOpen(true) : undefined}
                    />
                  ) : (
                    <div role="alert" className="w-full max-w-lg rounded-2xl border border-amber-400/20 bg-amber-500/[0.08] px-4 py-4 text-left">
                      <div className="text-sm font-semibold text-amber-100">Chat history is unavailable</div>
                      <div className="mt-1 text-xs leading-5 text-amber-100/80">{historyError}</div>
                      <button
                        type="button"
                        onClick={() => { void refreshChat(); }}
                        className="mt-3 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-amber-300/25 bg-amber-400/10 px-3 text-xs font-medium text-amber-50 hover:bg-amber-400/20"
                      >
                        <RefreshCw size={13} /> Retry chat history
                      </button>
                    </div>
                  )}
                </div>
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
                  {provider === 'AGENT_ZERO' && agentZeroRecoveryError && (
                    <div className="px-4 pt-4">
                      <AgentZeroRecoveryCard
                        message={agentZeroRecoveryError}
                        retrying={agentZeroRecoveryPending}
                        onRetry={() => { void retryAgentZeroRecovery(); }}
                        onRepair={isOwner(user) ? () => setSettingsOpen(true) : undefined}
                      />
                    </div>
                  )}
                  {provider !== 'AGENT_ZERO' && historyError && (
                    <div role="alert" className="mx-auto mt-4 flex w-[calc(100%-2rem)] max-w-xl items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-100">
                      <span className="min-w-0 flex-1">{historyError}</span>
                      <button type="button" onClick={() => { void refreshChat(); }} className="min-h-[34px] rounded-lg border border-amber-300/20 px-2.5 font-medium">Retry</button>
                    </div>
                  )}
                  {/* Direct message rendering — no counters, fully reactive */}
                  <div className="py-2">
                  <div className="mx-auto flex min-h-10 max-w-3xl items-center justify-center px-4 py-3" aria-live="polite">
                    {olderHistoryError ? (
                      <div className="flex flex-col items-center gap-2 text-center">
                        <span className="text-[11px] text-rose-300">Couldn’t load earlier messages: {olderHistoryError}</span>
                        <button
                          type="button"
                          onClick={() => void loadEarlierMessages()}
                          className="rounded-full border border-rose-300/20 bg-rose-400/10 px-3 py-1.5 text-[11px] text-rose-200 transition-colors hover:bg-rose-400/15"
                        >
                          Try again
                        </button>
                      </div>
                    ) : isLoadingOlderHistory ? (
                      <span className="inline-flex items-center gap-2 text-[11px] text-slate-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading earlier messages…
                      </span>
                    ) : messageWindow.hiddenCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => void loadEarlierMessages()}
                        className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200"
                      >
                        Show earlier messages · {messageWindow.hiddenCount} hidden
                      </button>
                    ) : hasOlderHistory ? (
                      <button
                        type="button"
                        onClick={() => void loadEarlierMessages()}
                        className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200"
                      >
                        Load earlier messages
                      </button>
                    ) : (
                      <span className="text-[10px] uppercase tracking-[0.18em] text-slate-600">Beginning of chat</span>
                    )}
                  </div>
                  {messageWindow.items.map((msg, visibleIdx) => {
                    const idx = visibleMessageStartIndex + visibleIdx;
                    const prevMsg = idx > 0 ? messages[idx - 1] : null;
                    const showDate =
                      visibleIdx === 0 || !prevMsg ||
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
                            hostFileContext={agentHostFileContext}
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
                              const hasHistorySegments = !isLiveTimeline && msg.segments && msg.segments.length > 0;
                              
                              if (!isLiveTimeline && !hasHistorySegments) return null;

                              // Mid-turn reloads can persist a partial snapshot of a thought that the
                              // live/resumed stream then carries in grown form. Drop history thinking
                              // segments that are strict prefixes of the current live thinking so the
                              // same thought never renders twice.
                              const liveThinkingForDedupe = idx === messages.length - 1 ? (thinkingContent || '').trim() : '';
                              const dropStalePartialThoughts = (segs: NonNullable<typeof msg.segments>) => (
                                liveThinkingForDedupe
                                  ? segs.filter((seg) => !(
                                      seg.kind === 'thinking'
                                      && seg.text.trim()
                                      && seg.text.trim() !== liveThinkingForDedupe
                                      && liveThinkingForDedupe.startsWith(seg.text.trim())
                                    ))
                                  : segs
                              );
                              
                              if (isLiveTimeline) {
                                return (
                                  <ActivityTimeline
                                    key={`live-activity-${msg.id}`}
                                    messageId={msg.id}
                                    segments={streamSegments}
                                    toolCalls={toolCalls}
                                    fallbackTimestamp={msg.createdAt.getTime()}
                                    agent={agent}
                                    avatarUrl={agentAvatars[agent.providerName]}
                                    hostFileContext={agentHostFileContext}
                                  />
                                );
                              } else {
                                // History/finalized turn: prefer timestamped segments from the live stream,
                                // then fall back to position-based reconstruction from durable history.
                                const segments = dropStalePartialThoughts(msg.segments || []);
                                const hasTimestampedSegments = segments.some((seg) => typeof seg.ts === 'number' && Number.isFinite(seg.ts));

                                if (hasTimestampedSegments) {
                                  return (
                                    <ActivityTimeline
                                      key={`history-activity-${msg.id}`}
                                      messageId={msg.id}
                                      segments={segments}
                                      toolCalls={toolCalls}
                                      fallbackTimestamp={msg.createdAt.getTime()}
                                      agent={agent}
                                      avatarUrl={agentAvatars[agent.providerName]}
                                      hostFileContext={agentHostFileContext}
                                    />
                                  );
                                }

                                const beforeSegs = segments.filter(s => s.position === 'before');
                                const betweenSegs = segments.filter(s => s.position === 'between');
                                return (
                                  <>
                                    {beforeSegs.map((seg, i) => (
                                      <AssistantBubble
                                        key={`hist-before-${msg.id}-${i}`}
                                        message={{
                                          id: `hist-before-${msg.id}-${i}`,
                                          role: 'assistant' as const,
                                          content: seg.kind === 'thinking' ? '' : seg.text,
                                          thinkingContent: seg.kind === 'thinking' ? seg.text : undefined,
                                          thinkingSubject: seg.kind === 'thinking' ? seg.subject : undefined,
                                          createdAt: msg.createdAt,
                                        }}
                                        agent={agent}
                                        avatarUrl={agentAvatars[agent.providerName]}
                                        isLast={false}
                                        isStreaming={false}
                                        hostFileContext={agentHostFileContext}
                                      />
                                    ))}
                                    <BoundedToolCallList
                                      tools={toolCalls}
                                      messageKey={`history-${msg.id}`}
                                      renderAfterFirst={toolCalls.length > 1 && betweenSegs.length > 0 ? betweenSegs.map((seg, i) => (
                                        <AssistantBubble
                                          key={`hist-between-${msg.id}-${i}`}
                                          message={{
                                            id: `hist-between-${msg.id}-${i}`,
                                            role: 'assistant' as const,
                                            content: seg.kind === 'thinking' ? '' : seg.text,
                                            thinkingContent: seg.kind === 'thinking' ? seg.text : undefined,
                                            thinkingSubject: seg.kind === 'thinking' ? seg.subject : undefined,
                                            createdAt: msg.createdAt,
                                          }}
                                          agent={agent}
                                          avatarUrl={agentAvatars[agent.providerName]}
                                          isLast={false}
                                          isStreaming={false}
                                          hostFileContext={agentHostFileContext}
                                        />
                                      )) : undefined}
                                    />
                                    {/* Text after tool calls (main response) — rendered by the AssistantBubble below */}
                                  </>
                                );
                              }
                            })()}
                            {/* Current/final bubble — shows live text OR historical content after tools */}
                            {(() => {
                              const isLiveTimeline = idx === messages.length - 1 && streamSegments.length > 0;
                              const hasHistorySegments = !isLiveTimeline && msg.segments && msg.segments.length > 0;
                              const renderedBeforeSegments = isLiveTimeline
                                ? streamSegments
                                : ((msg.segments || []).some((segment) => typeof segment.ts === 'number' && Number.isFinite(segment.ts))
                                    ? (msg.segments || [])
                                    : (msg.segments || []).filter((segment) => segment.position === 'before'));
                              const bubbleMessage = (isLiveTimeline || hasHistorySegments)
                                ? { ...msg, toolCalls: undefined, segments: undefined }
                                : msg;
                              const bubbleContent = bubbleMessage.content?.trim() || '';
                              const bubbleThinking = bubbleMessage.thinkingContent?.trim() || '';
                              const bubbleThinkingSubject = bubbleMessage.thinkingSubject?.trim() || '';
                              const lastRenderedThinkingSegment = [...renderedBeforeSegments]
                                .reverse()
                                .find((segment) => (
                                  segment.kind === 'thinking'
                                  && (segment.text.trim() || segment.subject)
                                ));
                              const bubbleContentDuplicatesTimeline = isAssistantContentRepresentedByTimeline(
                                bubbleContent,
                                renderedBeforeSegments,
                              );
                              // A thought grows as cumulative snapshots. A mid-turn reload can leave a
                              // partially flushed copy in durable history while the live/resumed stream
                              // carries the grown version of the SAME thought — treat prefix matches in
                              // either direction as the same thought, not two bubbles.
                              const isSameGrowingThought = (a: string, b: string) => Boolean(a) && Boolean(b)
                                && (a === b || a.startsWith(b) || b.startsWith(a));
                              const lastRenderedThinkingText = lastRenderedThinkingSegment?.text.trim() || '';
                              const lastRenderedThinkingSubject = lastRenderedThinkingSegment?.subject?.trim() || '';
                              const bubbleThinkingDuplicatesTimeline = Boolean(bubbleThinking || bubbleThinkingSubject)
                                && Boolean(lastRenderedThinkingSegment)
                                && (!bubbleThinking || isSameGrowingThought(lastRenderedThinkingText, bubbleThinking))
                                && (!bubbleThinkingSubject || lastRenderedThinkingSubject === bubbleThinkingSubject);
                              const liveThinkingValue = idx === messages.length - 1 ? thinkingContent : undefined;
                              const liveThinkingSubjectValue = idx === messages.length - 1 ? thinkingSubject : undefined;
                              const liveThinkingText = liveThinkingValue?.trim() || '';
                              const liveThinkingSubjectText = liveThinkingSubjectValue?.trim() || '';
                              const liveThinkingAlreadyRendered = Boolean(liveThinkingText || liveThinkingSubjectText)
                                && Boolean(lastRenderedThinkingSegment)
                                && (!liveThinkingText || isSameGrowingThought(lastRenderedThinkingText, liveThinkingText))
                                && (!liveThinkingSubjectText || lastRenderedThinkingSubject === liveThinkingSubjectText);
                              const effectiveBubbleMessage = (bubbleContentDuplicatesTimeline || bubbleThinkingDuplicatesTimeline)
                                ? {
                                    ...bubbleMessage,
                                    content: bubbleContentDuplicatesTimeline ? '' : bubbleMessage.content,
                                    thinkingContent: bubbleThinkingDuplicatesTimeline ? undefined : bubbleMessage.thinkingContent,
                                    thinkingSubject: bubbleThinkingDuplicatesTimeline ? undefined : bubbleMessage.thinkingSubject,
                                  }
                                : bubbleMessage;
                              const effectiveLiveThinkingContent = liveThinkingAlreadyRendered ? undefined : liveThinkingValue;
                              const effectiveLiveThinkingSubject = liveThinkingAlreadyRendered ? undefined : liveThinkingSubjectValue;
                              const effectiveLiveStatusText = idx === messages.length - 1 && isRunning
                                ? String(statusText || '').trim()
                                : '';
                              const hasVisibleBubble = Boolean(
                                effectiveBubbleMessage.content?.trim()
                                || effectiveBubbleMessage.thinkingContent?.trim()
                                || effectiveBubbleMessage.thinkingSubject
                                || effectiveLiveThinkingContent?.trim()
                                || effectiveLiveThinkingSubject
                                || effectiveLiveStatusText
                                || (effectiveBubbleMessage.toolCalls || []).length > 0,
                              );
                              if (!hasVisibleBubble && (isLiveTimeline || hasHistorySegments)) {
                                return null;
                              }
                              return (
                                <AssistantBubble
                                  message={effectiveBubbleMessage}
                                  agent={agent}
                                  avatarUrl={agentAvatars[agent.providerName]}
                                  isLast={idx === messages.length - 1}
                                  isStreaming={isRunning}
                                  liveThinkingContent={effectiveLiveThinkingContent}
                                  liveThinkingSubject={effectiveLiveThinkingSubject}
                                  liveStatusText={effectiveLiveStatusText}
                                  hostFileContext={agentHostFileContext}
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
                              );
                            })()}
                          </>
) : msg.role === 'system' ? (
                          isCompactionNotice(msg.content) ? (
                            <CompactionNoticeBlock key={msg.id} content={msg.content} size="default" />
                          ) : (
                            <div className="flex justify-center px-4 py-2 max-w-3xl mx-auto w-full">
                              <div className="max-w-xl rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-[12px] text-slate-300 whitespace-pre-wrap">
                                {msg.content}
                              </div>
                            </div>
                          )
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
                  className="absolute right-3 sm:right-5 bottom-[132px] z-20"
                >
                  <button
                    onClick={() => {
                      isUserScrolledUp.current = false;
                      scrollToBottom(true);
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-full bg-[#1A1F3A]/95 border border-white/[0.12] px-2.5 sm:px-3.5 text-xs text-slate-300 hover:text-white hover:bg-[#252B4A] transition-colors shadow-lg shadow-black/40 backdrop-blur"
                  >
                    <ChevronDown size={14} />
                    <span className="hidden sm:inline">Scroll to bottom</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Compaction indicator */}
            <div className={provider === 'OPENCLAW' ? 'min-h-[40px]' : undefined}>
              <AnimatePresence initial={false}>
                {(provider === 'OPENCLAW' || showConnectionLost || compactionPhase !== 'idle' || isRunning || queueCount > 0 || Boolean(contextSummary)) && (
                  <ComposerStatusBadge
                    phase={isRunning ? streamingPhase : 'idle'}
                    toolName={activeToolName}
                    statusText={statusText || idleConnectionStatus}
                    showConnectionLost={showConnectionLost}
                    compactionPhase={compactionPhase}
                    queueCount={queueCount}
                    onClearQueue={queueCount > 0 ? clearQueue : undefined}
                    contextSummary={contextSummary}
                  />
                )}
              </AnimatePresence>
            </div>

            {/* Composer */}
            <div className={`border-t transition-colors duration-300 ${
              isRunning
                ? 'border-amber-500/20 bg-[#0D1130]/50'
                : 'border-white/[0.06] bg-[#0D1130]/30'
            } backdrop-blur-sm`}>
              <div className="px-2 sm:px-4 pt-2 pb-3 pb-safe max-w-3xl mx-auto">
                {pendingUserQuestions.map((request) => (
                  <AskUserQuestionCard
                    key={request.id}
                    request={request}
                    onSettled={settlePendingUserQuestion}
                  />
                ))}

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
                <div className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] ${isRunning ? 'text-violet-300/80' : 'text-slate-500'}`}>
                  <span className="inline-flex items-center gap-1"><kbd className="px-1 py-0.5 rounded bg-white/[0.05] text-[10px] font-mono text-slate-400">/</kbd> {providerCommandStatus}</span>
                  <span>{provider === 'AGENT_ZERO' ? 'Connected model required' : (canSelectModel ? 'Model switching available' : 'Fixed provider defaults')}</span>
                  <span>{modelCatalogKind === 'none' ? 'Manual model ids may be required' : `Model catalog: ${availableModels.length || 'live'}`}</span>
                  <span className="text-slate-600">Try <span className="font-mono text-slate-400">/help</span> or <span className="font-mono text-slate-400">/status</span></span>
                  {provider !== 'OPENCLAW' && (
                    <span className={currentProviderAvailability.canSend ? 'text-emerald-300/80' : 'font-medium text-amber-200'}>
                      Provider availability: {currentProviderAvailability.status}
                    </span>
                  )}
                  {currentProviderAvailability.canSend && agentZeroModelBlockedReason && (
                    <span id="agent-zero-model-requirement" role="status" className="basis-full font-medium text-amber-200">
                      {agentZeroModelBlockedReason}
                    </span>
                  )}
                </div>
                <ComposerPrimitive.Root className="relative flex items-end gap-1.5 sm:gap-2">
                  {/* Fix #4: Attachment button (hidden during streaming) */}
                  {!isRunning && (
                  <button
                    type="button"
                    aria-label="Attach files"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-shrink-0 p-2 sm:p-2.5 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors mb-0.5 touch-target"
                    title="Attach file"
                  >
                    <Paperclip size={18} className="sm:w-[18px] sm:h-[18px] w-4 h-4" />
                  </button>
                  )}
                  <input
                    aria-label="Choose files to attach"
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,text/*,.txt,.log,.csv,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.json,.yaml,.yml,.md,.sh,.bash,.toml,.ini,.env,.pdf,.xml,.sql,.conf,.cfg"
                    className="hidden"
                    onChange={(e) => handleFileSelect(e.target.files)}
                  />
                  <SlashCommandMenu
                    id={slashMenuId}
                    open={slashMatch.isOpen}
                    anchorRef={composerInputRef}
                    commands={slashMatch.matches}
                    selectedIndex={slashMatch.selectedIndex}
                    onNavigate={(selectedIndex) => {
                      setSlashMatch((current) => ({ ...current, selectedIndex }));
                    }}
                    onSelect={applySlashCommand}
                    onDismiss={() => {
                      setSlashMatch({ isOpen: false, query: '', selectedIndex: 0, matches: [] });
                    }}
                  />

                  <ComposerPrimitive.Input
                    ref={composerInputRef}
                    autoFocus
                    placeholder={isRunning ? runningComposerPlaceholder : `Message ${agent.name}…`}
                    aria-label={`Message ${agent.name}`}
                    aria-haspopup="listbox"
                    aria-expanded={slashMatch.isOpen}
                    aria-controls={slashMatch.isOpen ? slashMenuId : undefined}
                    aria-activedescendant={slashMatch.isOpen ? `${slashMenuId}-option-${slashMatch.selectedIndex}` : undefined}
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
                      // Desktop options keep composer focus; narrow-screen
                      // sheets move focus into the portaled listbox. Dismiss
                      // only when focus leaves both surfaces.
                      setTimeout(() => {
                        const activeElement = document.activeElement;
                        const focusInsideMenu = activeElement instanceof HTMLElement
                          && Boolean(activeElement.closest('[data-slash-command-menu="true"]'));
                        if (composerInputRef.current !== activeElement && !focusInsideMenu) {
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
                        if (maybeExecuteSlashCommand(e)) {
                          return;
                        }
                        if (!chatSendReady) {
                          e.preventDefault();
                          e.stopPropagation();
                          reportBlockedSend();
                          return;
                        }
                        // Let ComposerPrimitive handle the submit (via submitMode="enter")
                        // But if attachments exist, force the mutation first and then submit.
                        if (pendingAttachments.length > 0) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleSendWithAttachments({ submit: true });
                          return;
                        }
                      }
                    }}
                  />

                  {/* Fix #3: Dictation / mic button */}
                  {speechSupported && (
                    <button
                      type="button"
                      aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
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
                  {chatSendReady ? (
                    <ComposerPrimitive.Send asChild>
                      <button
                        onClick={(e) => {
                          if (maybeExecuteSlashCommand(e)) {
                            return;
                          }
                          if (!chatSendReady) {
                            e.preventDefault();
                            e.stopPropagation();
                            reportBlockedSend();
                            return;
                          }
                          if (pendingAttachments.length > 0) {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSendWithAttachments({ submit: true });
                            return;
                          }
                        }}
                        aria-describedby={sendButtonDescriptionId}
                        className={sendButtonClassName}
                        title={sendButtonTitle}
                      >
                        <Send size={16} className="sm:w-4 sm:h-4 w-3.5 h-3.5" />
                      </button>
                    </ComposerPrimitive.Send>
                  ) : (
                    <BlockedAgentChatSendButton
                      title={sendButtonTitle}
                      describedBy={sendButtonDescriptionId}
                      className={sendButtonClassName}
                    >
                      <Send size={16} className="sm:w-4 sm:h-4 w-3.5 h-3.5" />
                    </BlockedAgentChatSendButton>
                  )}
                  {/* Stop button — driven by our own isRunning, not assistant-ui runtime
                      (runtime.isRunning is always false to keep Send enabled for FYI queue) */}
                  {isRunning && supportsAgentChatStop(provider) && (
                    <button
                      type="button"
                      aria-label="Stop response"
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

        <CompatibilityHotfixConfirmationDialog
          open={compatibilityHotfixConfirmationOpen}
          status={compatibilityHotfixStatus}
          onClose={() => setCompatibilityHotfixConfirmationOpen(false)}
          onBusyChange={setCompatibilityHotfixApplying}
          onVerified={(verifiedStatus, message) => {
            setCompatibilityHotfixStatus(verifiedStatus);
            setCompatibilityHotfixMessage(message);
          }}
        />

        <AgentSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} onAiProviderSetupComplete={handleAiProviderSetupComplete} onNativeModelSelected={handleNativeSetupModelSelected} />

        {/* Exec Approval Modal — keyed per approval so isResolving/isClosing
            state can never leak from one queued approval into the next. */}
        {pendingApproval && (
          <ExecApprovalModal
            key={pendingApproval.id}
            approval={pendingApproval}
            queueCount={pendingApprovals.length}
            onResolve={resolveApproval}
            onDismiss={dismissApproval}
          />
        )}
      </div>
    </AssistantRuntimeProvider>
    </AskQuestionAnswerProvider>
  );
}
