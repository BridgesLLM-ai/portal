/**
 * ProjectChatPanel — Self-contained chat panel for project agents.
 * 
 * Uses the Portal-owned durable Project turn replay API for every provider.
 * Manages its own message state, replay projection, tool calls, compaction.
 * Replicates the quality of ChatInterface: markdown, tool pills, status bar, file upload.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot, X, Trash2, Send, Loader2, ChevronRight, ChevronDown,
  Wrench, Sparkles, StopCircle, Paperclip, Copy, Check, Code2, Radio,
  Mic, MicOff, XCircle, CheckCircle2, RotateCcw, RefreshCw, MessageSquare
} from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import SlashCommandMenu from './SlashCommandMenu';
import { ExecApprovalModal } from './ExecApprovalModal';
import client from '../../api/client';
import { gatewayAPI, projectsAPI } from '../../api/endpoints';
import { workspaceAuthorizedFetch } from '../../utils/workspaceAuthorizedFetch';
import type {
  ProjectChatHistoryPage,
  ProjectChatPersistedMessage,
  ProjectChatProviderCapability,
  ProjectChatProviderName,
  ProjectChatProviderQualificationStatus,
} from '../../api/endpoints';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  extractThinkingChunk,
  isControlOnlyAssistantContent,
  mergeAssistantStream,
  mergeThinkingStream,
  reconcileCumulativeFinalTail,
  sanitizeAssistantContent,
  sanitizeAssistantChunk,
  stripOpenClawReplyTags,
} from '../../utils/chatStream';
import {
  canonicalizePortalModelId,
  getModelDisplayName,
  getModelIdBadge,
  getModelProviderLabel,
  getModelRuntimeLabel,
  normalizeModelId,
  resolvePortalModelFromCatalog,
} from '../../utils/modelId';
import { matchSlashCommands, parseSlashCommand, type SlashCommand } from '../../utils/slashCommands';
import {
  appendCompletedToolCallIfMissing,
  appendToolCallToMessage,
  buildCompletedToolCall,
  buildRunningToolCall,
  finishMatchingToolCallInMessage,
  getLastRunningToolCall,
  updateRunningToolCallInMessage,
} from '../../utils/liveTurnProjector';
import { normalizePortalStreamEventFromTurnEvent } from '../../utils/runtimeTurnEvents';
import ComposerStatusBadge from './ComposerStatusBadge';
import CompactionNoticeBlock from './CompactionNoticeBlock';
import ToolGlyph from './ToolGlyph';
import ProjectProviderMenu, {
  normalizeProjectQualificationRetryAt,
  projectQualificationAuthRecoveryAction,
  projectQualificationRecoveryAction,
  type ProjectProviderQualificationFailure,
  type ProjectQualificationRecoveryRole,
} from './ProjectProviderMenu';
import AnchoredPopover from '../AnchoredPopover';
import ViewportModal from '../ViewportModal';
import { getRailSafeStatusText, resolveMaintenanceRailStatus } from './maintenanceRailLifecycle';
import { getToolPresentation, getToolStatusText, getToolSummary, isAskQuestionTool, isCompactionNotice, resolveToolName } from '../../utils/toolPresentation';
import {
  pruneExpiredExecApprovals,
  removeExecApproval,
  upsertExecApproval,
} from '../../utils/execApprovalQueue';
import {
  buildUnavailableProjectProviderCapabilities,
  canSendToProjectProvider,
  canSwitchProjectProvider,
  presentProjectProviderQualifications,
  resolveProjectProviderCapabilities,
  type ProjectProviderVerificationState,
} from './projectChatProviderState';
import { selectNewestWindow } from '../../utils/timelineWindow';
import {
  PROJECT_CHAT_MESSAGE_WINDOW_SIZE,
  PROJECT_CHAT_TOOL_WINDOW_SIZE,
  getProjectChatRenderDelay,
  getProjectReplayPollDelay,
} from '../../utils/projectChatPerformance';
import {
  historyConfirmsPendingProjectChatSend,
  inspectProjectChatPendingSend,
  reconcilePendingProjectChatSend,
  runCoordinatedProjectChatSend,
  runCoordinatedProjectChatReset,
  subscribeProjectChatSendState,
  type PendingProjectChatSend,
  ProjectChatPendingStateError,
  type ProjectChatSendScope,
} from '../../utils/projectChatPendingSend';
import { resolveProjectChatPendingMessageStatus } from '../../utils/projectChatMessageStatus';
import { useAuthStore } from '../../contexts/AuthContext';
import { sanitizeThinkingSubject } from '../../utils/thinkingSubject';
import { AskQuestionCard, AskQuestionAnswerProvider, parseAskQuestionPayload, useAskQuestionAnswer } from './AskQuestionCard';
import AskUserQuestionCard from './AskUserQuestionCard';
import type { AskUserQuestionRequest } from './AskUserQuestionCard';
import { isAskUserQuestionNoLongerOpenError } from '../../utils/askUserQuestionError';

import type {
  ToolCall,
  ChatMessage,
  StreamingPhase,
  ExecApprovalRequest,
  SessionControlMutationKind,
} from '../../contexts/ChatStateProvider';

/* ═══ Types ═══ */

export type ProjectChatActivity = Readonly<{
  kind: 'provider-qualification';
  projectName: string;
  provider: 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA';
  token: number;
}> | Readonly<{
  kind: 'session-control';
  projectName: string;
  provider: 'OPENCLAW';
  sessionKey: string;
  control: 'thinking' | 'reasoning' | 'fastMode';
  token: number;
}> | Readonly<{
  kind: 'provider-transition';
  projectName: string;
  provider: ProjectChatProviderName;
  previousProvider: ProjectChatProviderName | null;
  sessionKey: string | null;
  previousModel: string;
  requestedModel: string;
  stateVersion: number;
  token: number;
}> | Readonly<{
  kind: 'model-switch';
  projectName: string;
  provider: ProjectChatProviderName;
  sessionKey: string;
  previousModel: string;
  requestedModel: string;
  stateVersion: number;
  token: number;
}>;

interface ProjectChatPanelProps {
  projectName: string;
  onClose: () => void;
  onProjectPrepared?: (projectName: string) => Promise<void> | void;
  onActivityChange?: (activity: Readonly<ProjectChatActivity>, active: boolean) => boolean;
}

interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  type: 'image' | 'text' | 'other';
  previewUrl?: string;
  textContent?: string;
  projectPath?: string;
  uploadStatus?: 'uploading' | 'done' | 'error';
  uploadError?: string;
}

interface AgentZeroProjectModelOption {
  value: string;
  label: string;
}

type QualifiableProjectProvider = ProjectChatProviderQualificationStatus['provider'];
type ProjectQualificationProgress = Readonly<{
  projectName: string;
  provider: QualifiableProjectProvider;
  label: string;
  stage: 'checking' | 'refreshing';
}>;

const DIRECT_QUALIFICATION_PRIORITY: readonly QualifiableProjectProvider[] = [
  'OPENCLAW',
  'CODEX',
  'CLAUDE_CODE',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
];

const AUTOMATIC_QUALIFICATION_SUPPRESSION_STORAGE_KEY =
  'portal:project-chat:auto-qualification-suppression:v1';
const AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS = 15 * 60_000;
const MAX_AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS = 60 * 60_000;
const MAX_AUTOMATIC_QUALIFICATION_SUPPRESSIONS = 64;
const QUEUED_COMPOSER_DRAFT_STORAGE_PREFIX = 'portal:project-chat:queued-composer:v1';
const MAX_QUEUED_COMPOSER_DRAFT_LENGTH = 256 * 1024;
const QUEUED_COMPOSER_DRAFT_TTL_MS = 30 * 60_000;
type AutomaticQualificationSuppressionDisposition =
  | 'AUTO_ONLY'
  | 'AI_SETTINGS'
  | 'HOST_MAINTENANCE'
  | 'IDENTITY_UNAVAILABLE_NON_RETRYABLE'
  | 'NON_RETRYABLE'
  | 'RATE_LIMITED';

type AutomaticQualificationSuppression = Readonly<{
  key: string;
  expiresAt: number;
  disposition: AutomaticQualificationSuppressionDisposition;
  retryAt: string | null;
}>;

type QueuedComposerDraftScope = Readonly<{
  actorUserId: string;
  projectId: string;
  provider: ProjectChatProviderName;
}>;

function queuedComposerDraftStorageKey(scope: QueuedComposerDraftScope): string | null {
  const actor = scope.actorUserId.trim();
  const project = scope.projectId.trim();
  if (!actor || !project || actor.length > 256 || project.length > 256) return null;
  return `${QUEUED_COMPOSER_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(actor)}:${encodeURIComponent(project)}:${scope.provider}`;
}

function queuedComposerDraftStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readQueuedComposerDraft(scope: QueuedComposerDraftScope): string | null {
  const storage = queuedComposerDraftStorage();
  const key = queuedComposerDraftStorageKey(scope);
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    if (raw.length > MAX_QUEUED_COMPOSER_DRAFT_LENGTH + 1_024) {
      storage.removeItem(key);
      return null;
    }
    const parsed = JSON.parse(raw);
    const value = typeof parsed?.value === 'string' ? parsed.value : '';
    const expiresAt = Number(parsed?.expiresAt);
    if (
      !value.trim()
      || value.length > MAX_QUEUED_COMPOSER_DRAFT_LENGTH
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now()
      || expiresAt > Date.now() + QUEUED_COMPOSER_DRAFT_TTL_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore cleanup failure in a blocked store.
    }
    return null;
  }
}

function writeQueuedComposerDraft(scope: QueuedComposerDraftScope, value: string): void {
  const storage = queuedComposerDraftStorage();
  const key = queuedComposerDraftStorageKey(scope);
  if (!storage || !key) return;
  try {
    if (!value.trim()) {
      storage.removeItem(key);
      return;
    }
    // This is intentionally tab-scoped. Pending-send storage remains
    // fingerprint-only; this short-lived copy exists solely so a queued draft
    // can be returned to the composer after closing and reopening the panel.
    if (value.length <= MAX_QUEUED_COMPOSER_DRAFT_LENGTH) {
      storage.setItem(key, JSON.stringify({
        value,
        expiresAt: Date.now() + QUEUED_COMPOSER_DRAFT_TTL_MS,
      }));
    }
  } catch {
    // A blocked session store must not prevent queueing or sending a message.
  }
}

function clearQueuedComposerDraft(scope: QueuedComposerDraftScope): void {
  const storage = queuedComposerDraftStorage();
  const key = queuedComposerDraftStorageKey(scope);
  if (!storage || !key) return;
  try {
    storage.removeItem(key);
  } catch {
    // A blocked session store must not prevent normal Project Chat cleanup.
  }
}

function projectChatHistoryErrorDetail(error: any): string {
  const detail = String(
    error?.response?.data?.error
    || error?.message
    || 'The saved transcript is temporarily unavailable.',
  ).replace(/\s+/g, ' ').trim();
  return detail.slice(0, 500) || 'The saved transcript is temporarily unavailable.';
}

const automaticQualificationMemorySuppressions = new Map<
  string,
  AutomaticQualificationSuppression
>();

function automaticQualificationSuppressionKey(
  actorUserId: string,
  projectIdentityId: string | null,
  provider: QualifiableProjectProvider,
): string | null {
  const actor = actorUserId.trim();
  const project = projectIdentityId?.trim() || '';
  if (!actor || !project || actor.length > 256 || project.length > 256) return null;
  return JSON.stringify([actor, project, provider]);
}

function qualificationSuppressionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readAutomaticQualificationSuppressions(
  storage: Storage,
  now: number,
): AutomaticQualificationSuppression[] {
  try {
    const raw = storage.getItem(AUTOMATIC_QUALIFICATION_SUPPRESSION_STORAGE_KEY);
    if (!raw) return [];
    if (raw.length > 64 * 1024) {
      storage.removeItem(AUTOMATIC_QUALIFICATION_SUPPRESSION_STORAGE_KEY);
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((entry): AutomaticQualificationSuppression[] => {
        if (
          entry === null
          || typeof entry !== 'object'
          || typeof entry.key !== 'string'
          || entry.key.length > 1_000
          || !Number.isSafeInteger(entry.expiresAt)
          || entry.expiresAt <= now
          || entry.expiresAt > now + MAX_AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS
        ) return [];
        const disposition: AutomaticQualificationSuppressionDisposition = (
          entry.disposition === 'HOST_MAINTENANCE'
          || entry.disposition === 'IDENTITY_UNAVAILABLE_NON_RETRYABLE'
          || entry.disposition === 'NON_RETRYABLE'
          || entry.disposition === 'RATE_LIMITED'
          || entry.disposition === 'AUTO_ONLY'
        )
          ? entry.disposition
          : 'AUTO_ONLY';
        const retryAt = disposition === 'RATE_LIMITED'
          ? normalizeProjectQualificationRetryAt(entry.retryAt, now)
          : null;
        if (disposition === 'RATE_LIMITED' && !retryAt) return [];
        return [{
          key: entry.key,
          expiresAt: entry.expiresAt,
          disposition,
          retryAt,
        }];
      })
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .slice(-MAX_AUTOMATIC_QUALIFICATION_SUPPRESSIONS);
  } catch {
    return [];
  }
}

function writeAutomaticQualificationSuppressions(
  storage: Storage,
  entries: AutomaticQualificationSuppression[],
): void {
  try {
    if (entries.length === 0) {
      storage.removeItem(AUTOMATIC_QUALIFICATION_SUPPRESSION_STORAGE_KEY);
      return;
    }
    storage.setItem(
      AUTOMATIC_QUALIFICATION_SUPPRESSION_STORAGE_KEY,
      JSON.stringify(entries.slice(-MAX_AUTOMATIC_QUALIFICATION_SUPPRESSIONS)),
    );
  } catch {
    // A blocked session store must not prevent explicit provider preparation.
  }
}

function pruneAutomaticQualificationMemorySuppressions(now: number): void {
  for (const [key, entry] of automaticQualificationMemorySuppressions) {
    if (
      !Number.isSafeInteger(entry.expiresAt)
      || entry.expiresAt <= now
      || entry.expiresAt > now + MAX_AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS
    ) {
      automaticQualificationMemorySuppressions.delete(key);
    }
  }
  while (
    automaticQualificationMemorySuppressions.size
    > MAX_AUTOMATIC_QUALIFICATION_SUPPRESSIONS
  ) {
    const oldestKey = automaticQualificationMemorySuppressions.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    automaticQualificationMemorySuppressions.delete(oldestKey);
  }
}

function readAutomaticQualificationSuppression(
  key: string,
  now = Date.now(),
): AutomaticQualificationSuppression | null {
  pruneAutomaticQualificationMemorySuppressions(now);
  const memoryEntry = automaticQualificationMemorySuppressions.get(key);
  if (memoryEntry && memoryEntry.expiresAt > now) return memoryEntry;
  const storage = qualificationSuppressionStorage();
  if (!storage) return null;
  const entries = readAutomaticQualificationSuppressions(storage, now);
  writeAutomaticQualificationSuppressions(storage, entries);
  const storedEntry = entries.find((entry) => entry.key === key) || null;
  if (storedEntry) {
    automaticQualificationMemorySuppressions.delete(key);
    automaticQualificationMemorySuppressions.set(key, storedEntry);
    pruneAutomaticQualificationMemorySuppressions(now);
  }
  return storedEntry;
}

function suppressAutomaticQualification(
  key: string,
  options: Readonly<{
    disposition?: AutomaticQualificationSuppressionDisposition;
    retryAt?: string | null;
  }> = {},
  now = Date.now(),
): AutomaticQualificationSuppression {
  pruneAutomaticQualificationMemorySuppressions(now);
  const disposition = options.disposition || 'AUTO_ONLY';
  const normalizedRetryAt = disposition === 'RATE_LIMITED'
    ? (
        normalizeProjectQualificationRetryAt(options.retryAt, now)
        || new Date(now + AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS).toISOString()
      )
    : null;
  const expiresAt = normalizedRetryAt
    ? Date.parse(normalizedRetryAt)
    : now + AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS;
  const suppression: AutomaticQualificationSuppression = {
    key,
    expiresAt,
    disposition,
    retryAt: normalizedRetryAt,
  };
  automaticQualificationMemorySuppressions.delete(key);
  automaticQualificationMemorySuppressions.set(key, suppression);
  pruneAutomaticQualificationMemorySuppressions(now);
  const storage = qualificationSuppressionStorage();
  if (!storage) return suppression;
  const entries = readAutomaticQualificationSuppressions(storage, now)
    .filter((entry) => entry.key !== key);
  entries.push(suppression);
  writeAutomaticQualificationSuppressions(storage, entries);
  return suppression;
}

function clearAutomaticQualificationSuppression(key: string | null): void {
  if (!key) return;
  automaticQualificationMemorySuppressions.delete(key);
  const storage = qualificationSuppressionStorage();
  if (!storage) return;
  const now = Date.now();
  writeAutomaticQualificationSuppressions(
    storage,
    readAutomaticQualificationSuppressions(storage, now)
      .filter((entry) => entry.key !== key),
  );
}

const SAFE_PROJECT_QUALIFICATION_ERROR_MESSAGES: Readonly<Record<string, (
  label: string,
) => string>> = Object.freeze({
  PROJECT_QUALIFICATION_REQUIRED: (label) => `${label} must be prepared for this project before it can be used.`,
  PROJECT_QUALIFICATION_FAILED: (label) => `Portal could not prepare ${label} for this project. Review the provider setup and try again.`,
  PROJECT_QUALIFICATION_RATE_LIMITED: () => 'Too many Project provider preparation attempts. Wait for the current window to reset.',
  PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE: () => 'Portal could not safely verify this project’s immutable identity for provider preparation.',
  PROJECT_RUNTIME_POLICY_FAILED: () => 'The provider’s confined project runtime did not pass its server security checks. The Portal host must be updated or repaired before retrying.',
  PROJECT_PROVIDER_AUTH_REQUIRED: (label) => `${label} must be reconnected in AI Settings before it can be prepared for this project.`,
  PROJECT_PROVIDER_BACKEND_UNAVAILABLE: (label) => `${label} is unavailable on this Portal host. Check the provider service and try again.`,
  PROJECT_PROVIDER_MODEL_REJECTED: (label) => `${label} rejected the selected project model. Choose an available model and try again.`,
  PROJECT_PROVIDER_RATE_LIMITED: (label) => `${label} is rate limited. Wait a moment and try again.`,
  PROJECT_PROVIDER_TIMED_OUT: (label) => `${label} did not finish its project security check in time. Try again.`,
  // both of these reached the user as the generic "review the provider
  // setup" fallback, which names neither the cause nor the fix. The first is
  // the ordinary outcome of preparing a provider that has no usable model on
  // this host; the second only means the open view is out of date.
  PROJECT_MODEL_SWITCH_REJECTED: (label) => `${label} has no usable model for this project. Choose a different model or provider.`,
  PROJECT_CHAT_VERSION_CONFLICT: () => 'This Project Chat view is out of date. Refresh the project, then try again.',
  AGENT_ZERO_PROJECT_MODEL_INVALID: () => 'Select a currently connected Agent Zero model before preparing this project.',
  ANTIGRAVITY_PROJECT_MODEL_UNAVAILABLE: () => 'The selected Antigravity model is unavailable for this project.',
  CLAUDE_CODE_PROJECT_MODEL_UNAVAILABLE: () => 'The selected Claude Code model is unavailable for this project.',
  CODEX_PROJECT_MODEL_UNAVAILABLE: () => 'The selected Codex model is unavailable for this project.',
  OLLAMA_PROJECT_MODEL_UNAVAILABLE: () => 'The selected Ollama model is unavailable for this project.',
});

function failureFromAutomaticQualificationSuppression(
  suppression: AutomaticQualificationSuppression,
  label: string,
): ProjectProviderQualificationFailure | null {
  if (suppression.disposition === 'HOST_MAINTENANCE') {
    return {
      message: SAFE_PROJECT_QUALIFICATION_ERROR_MESSAGES.PROJECT_RUNTIME_POLICY_FAILED(label),
      code: 'PROJECT_RUNTIME_POLICY_FAILED',
      retryable: false,
      recovery: 'HOST_MAINTENANCE',
      retryAt: null,
      suppressionExpiresAt: new Date(suppression.expiresAt).toISOString(),
    };
  }
  if (suppression.disposition === 'AI_SETTINGS') {
    return {
      message: SAFE_PROJECT_QUALIFICATION_ERROR_MESSAGES.PROJECT_PROVIDER_AUTH_REQUIRED(label),
      code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
      retryable: false,
      recovery: 'AI_SETTINGS',
      retryAt: null,
      suppressionExpiresAt: new Date(suppression.expiresAt).toISOString(),
    };
  }
  if (suppression.disposition === 'IDENTITY_UNAVAILABLE_NON_RETRYABLE') {
    return {
      message: SAFE_PROJECT_QUALIFICATION_ERROR_MESSAGES.PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE(label),
      code: 'PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE',
      retryable: false,
      recovery: null,
      retryAt: null,
      suppressionExpiresAt: new Date(suppression.expiresAt).toISOString(),
    };
  }
  if (suppression.disposition === 'NON_RETRYABLE') {
    return {
      message: `Portal could not safely prepare ${label} for this project. An Owner or Sub Admin must review the Portal host before retrying.`,
      code: 'PROJECT_QUALIFICATION_FAILED',
      retryable: false,
      recovery: null,
      retryAt: null,
      suppressionExpiresAt: new Date(suppression.expiresAt).toISOString(),
    };
  }
  if (suppression.disposition === 'RATE_LIMITED' && suppression.retryAt) {
    return {
      message: SAFE_PROJECT_QUALIFICATION_ERROR_MESSAGES.PROJECT_QUALIFICATION_RATE_LIMITED(label),
      code: 'PROJECT_QUALIFICATION_RATE_LIMITED',
      retryable: true,
      recovery: null,
      retryAt: suppression.retryAt,
      suppressionExpiresAt: new Date(suppression.expiresAt).toISOString(),
    };
  }
  return null;
}

function safeProjectQualificationError(
  error: any,
  label: string,
): ProjectProviderQualificationFailure {
  const payload = error?.response?.data;
  const code = typeof payload?.code === 'string' ? payload.code : '';
  const safeMessage = SAFE_PROJECT_QUALIFICATION_ERROR_MESSAGES[code];
  const safePayload = typeof safeMessage === 'function';
  const runtimePolicyFailure = code === 'PROJECT_RUNTIME_POLICY_FAILED';
  const providerAuthRequired = code === 'PROJECT_PROVIDER_AUTH_REQUIRED';
  const rateLimited = code === 'PROJECT_QUALIFICATION_RATE_LIMITED';
  const explicitRetryable = typeof payload?.retryable === 'boolean'
    ? payload.retryable
    : null;
  const rawDiagnostic = payload?.operatorDiagnostic;
  const diagnosticOperation = rawDiagnostic?.operation === 'config.get'
    || rawDiagnostic?.operation === 'config.patch'
    ? rawDiagnostic.operation
    : null;
  const diagnosticCode = typeof rawDiagnostic?.errorCode === 'string'
    && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(rawDiagnostic.errorCode)
    ? rawDiagnostic.errorCode
    : null;
  const diagnosticMessage = typeof rawDiagnostic?.errorMessage === 'string'
    ? rawDiagnostic.errorMessage.trim()
    : '';
  const containsUnredactedCredential = /\b(?:authorization|cookie|password|passphrase|api[-_ ]?key|secret|(?:access|refresh|auth|gateway|device|session)[-_ ]?token|private[-_ ]?key|jwt)\b\s*[:=]\s*(?!\[redacted\])/i
    .test(diagnosticMessage);
  const operatorDiagnostic = runtimePolicyFailure
    && rawDiagnostic?.source === 'OPENCLAW_GATEWAY'
    && diagnosticOperation
    && diagnosticMessage.length > 0
    && diagnosticMessage.length <= 1_024
    && !/[\u0000-\u001F\u007F]/.test(diagnosticMessage)
    && !containsUnredactedCredential
    ? {
        source: 'OPENCLAW_GATEWAY' as const,
        operation: diagnosticOperation,
        errorCode: diagnosticCode,
        errorMessage: diagnosticMessage,
      }
    : null;
  return {
    message: safePayload
      ? safeMessage(label)
      : `Portal could not prepare ${label} for this project. Review the provider setup and try again.`,
    code: safePayload ? code : 'PROJECT_QUALIFICATION_FAILED',
    retryable: runtimePolicyFailure || providerAuthRequired
      ? false
      : explicitRetryable ?? true,
    recovery: runtimePolicyFailure
      ? 'HOST_MAINTENANCE'
      : providerAuthRequired
        ? 'AI_SETTINGS'
        : null,
    retryAt: rateLimited
      ? (
          normalizeProjectQualificationRetryAt(payload?.retryAt)
          || new Date(Date.now() + AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS).toISOString()
        )
      : null,
    operatorDiagnostic,
  };
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive' | 'max' | 'ultra';
type ReasoningVisibility = 'off' | 'on' | 'stream';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'adaptive', 'high', 'xhigh', 'max', 'ultra'];
type ProjectSessionControlKind = Exclude<SessionControlMutationKind, 'compactionModel'>;
type ProjectSessionControlValue = ThinkingLevel | ReasoningVisibility | boolean;
type ProjectSessionControlMutation = Readonly<{
  generation: number;
  kind: ProjectSessionControlKind;
  provider: ProjectChatProviderName;
  session: string;
  previous: ProjectSessionControlValue;
  requested: ProjectSessionControlValue;
  activity: Extract<ProjectChatActivity, { kind: 'session-control' }>;
}>;
type ProjectProviderTransitionActivity = Extract<ProjectChatActivity, { kind: 'provider-transition' }>;
type ProjectModelSwitchActivity = Extract<ProjectChatActivity, { kind: 'model-switch' }>;
type ProjectTransitionActivity = ProjectProviderTransitionActivity | ProjectModelSwitchActivity;

function readProjectSessionControlValue(payload: any, kind: ProjectSessionControlKind): ProjectSessionControlValue | undefined {
  const session = payload?.session && typeof payload.session === 'object' ? payload.session : payload;
  if (!session || typeof session !== 'object') return undefined;
  if (kind === 'fastMode') {
    const candidate = session.fastMode ?? session.settings?.fastMode;
    return typeof candidate === 'boolean' ? candidate : undefined;
  }
  const candidate = kind === 'thinking'
    ? (session.thinkingLevel ?? session.thinking ?? session.settings?.thinking)
    : (session.reasoningLevel ?? session.reasoning ?? session.settings?.reasoning);
  const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
  if (kind === 'thinking') {
    return THINKING_LEVELS.includes(normalized as ThinkingLevel) ? normalized as ThinkingLevel : undefined;
  }
  return ['off', 'on', 'stream'].includes(normalized) ? normalized as ReasoningVisibility : undefined;
}
const REASONING_VISIBILITY_LABELS: Record<ReasoningVisibility, string> = {
  off: 'Hidden',
  on: 'Visible',
  stream: 'Stream',
};
export const PROJECT_CHAT_HISTORY_PAGE_SIZE = 100;
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

// Fast mode applies to every Codex-backed openai/* model on OpenClaw 2026.7.1.
function supportsOpenClawFastModeModel(model?: string | null): boolean {
  const normalized = String(model || '').trim().toLowerCase();
  return normalized.startsWith('openai/')
    || normalized.startsWith('codex/')
    || normalized.startsWith('openai-codex/');
}

function resolveAvailableModelId(model: string, availableModels: string[]): string {
  return resolvePortalModelFromCatalog(model, availableModels);
}

/* ═══ Durable Project replay contract ═══ */

export class ProjectReplayContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectReplayContractError';
  }
}

export function assertProjectChatHistoryIdentity(
  page: Pick<ProjectChatHistoryPage, 'executionContext'>,
  expectedProjectId: string | null,
): void {
  // projectsAPI validates this field for real HTTP responses. Keep the guard
  // tolerant of older component fixtures while still rejecting any response
  // that claims a different immutable Project or execution scope.
  const context = page?.executionContext as ProjectChatHistoryPage['executionContext'] | undefined;
  if (context === undefined) return;
  const returnedProjectId = typeof context.projectId === 'string'
    ? context.projectId.trim()
    : '';
  if (
    context.scope !== 'PROJECT_SANDBOX'
    || !expectedProjectId
    || returnedProjectId !== expectedProjectId
  ) {
    throw new ProjectReplayContractError(
      'Portal returned saved chat history for a different Project. Refresh Project Chat before retrying.',
    );
  }
}

export function resolveVerifiedProjectModelResponse(
  capability: Pick<ProjectChatProviderCapability, 'displayName' | 'supportsModelSelection'>,
  data: any,
): string {
  if (!capability.supportsModelSelection) return '';
  const model = canonicalizePortalModelId(String(data?.model || ''));
  if (data?.modelValidated !== true || !model) {
    throw new ProjectReplayContractError(
      `Portal did not return a validated ${capability.displayName} Project model.`,
    );
  }
  return model;
}

export interface ProjectReplayBatch {
  events: any[];
  nextCursor: number;
  stateVersion: number;
  sessionKey: string;
}

const PROJECT_PROVIDER_REVERIFICATION_CODES = new Set([
  'PROJECT_PROVIDER_UNSUPPORTED',
  'PROJECT_CHAT_HANDOFF_CONFLICT',
  'PROJECT_CHAT_INVALID_INPUT',
  'PROJECT_CHAT_PROVIDER_MISMATCH',
  'PROJECT_CHAT_REQUEST_REPLAY',
  'PROJECT_CHAT_STATE_CORRUPT',
  'PROJECT_CHAT_STATE_NOT_FOUND',
  'PROJECT_CHAT_TURN_ACTIVE',
  'PROJECT_CHAT_VERSION_CONFLICT',
  'PROJECT_MODEL_VERIFICATION_FAILED',
  'PROJECT_QUALIFICATION_FAILED',
  'PROJECT_QUALIFICATION_REQUIRED',
]);

function isProjectProviderReverificationError(error: any): boolean {
  const code = error?.response?.data?.code;
  return typeof code === 'string' && PROJECT_PROVIDER_REVERIFICATION_CODES.has(code);
}

function isDefinitiveProjectSendRejection(error: any): boolean {
  return error?.response?.data?.admissionStatus === 'never_admitted';
}

export function resolveProjectReplayBatch(
  snapshot: any,
  expected: {
    provider: ProjectChatProviderName;
    sessionKey: string;
    minimumStateVersion: number;
    afterSeq: number;
    turnId?: string | null;
  },
): ProjectReplayBatch {
  if (!Number.isSafeInteger(expected.afterSeq) || expected.afterSeq < 0) {
    throw new ProjectReplayContractError('Project replay requested an invalid cursor.');
  }
  if (!Number.isSafeInteger(expected.minimumStateVersion) || expected.minimumStateVersion < 0) {
    throw new ProjectReplayContractError('Project replay expected an invalid coordination version.');
  }
  if (typeof expected.sessionKey !== 'string' || !expected.sessionKey.trim()) {
    throw new ProjectReplayContractError('Project replay expected an invalid provider session.');
  }
  if (expected.turnId != null && (typeof expected.turnId !== 'string' || !expected.turnId.trim())) {
    throw new ProjectReplayContractError('Project replay expected an invalid active turn.');
  }
  if (snapshot?.provider !== expected.provider) {
    throw new ProjectReplayContractError(
      `Project replay provider mismatch: expected ${expected.provider}, received ${String(snapshot?.provider || 'none')}`,
    );
  }
  if (typeof snapshot?.sessionKey !== 'string' || !snapshot.sessionKey.trim()) {
    throw new ProjectReplayContractError('Project replay did not return a provider session.');
  }
  if (expected.turnId) {
    if (snapshot?.runId !== expected.turnId) {
      throw new ProjectReplayContractError('Project replay did not match the verified active turn.');
    }
  } else if (snapshot.sessionKey !== expected.sessionKey) {
    throw new ProjectReplayContractError('Project replay session did not match the verified provider session.');
  }
  if (!Number.isSafeInteger(snapshot?.stateVersion) || snapshot.stateVersion < expected.minimumStateVersion) {
    throw new ProjectReplayContractError('Project replay coordination version is missing or stale.');
  }
  if (!Number.isSafeInteger(snapshot?.lineCount) || snapshot.lineCount < expected.afterSeq) {
    throw new ProjectReplayContractError('Project replay cursor is missing or moved backwards.');
  }

  const rawEvents = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const bySequence = new Map<number, any>();
  for (const event of rawEvents) {
    const sequence = event?.seq;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > snapshot.lineCount) {
      throw new ProjectReplayContractError('Project replay returned an invalid event sequence.');
    }
    if (sequence > expected.afterSeq && !bySequence.has(sequence)) {
      bySequence.set(sequence, event);
    }
  }
  const events = [...bySequence.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, event]) => event);
  let expectedSequence = expected.afterSeq + 1;
  for (const event of events) {
    if (event.seq !== expectedSequence) {
      throw new ProjectReplayContractError(
        `Project replay returned a sequence gap at ${expectedSequence}.`,
      );
    }
    expectedSequence += 1;
  }
  if (snapshot.lineCount > expected.afterSeq && events.length === 0) {
    throw new ProjectReplayContractError('Project replay omitted events after the requested cursor.');
  }
  const nextCursor = events.reduce(
    (cursor, event) => Math.max(cursor, Number(event.seq)),
    expected.afterSeq,
  );

  return {
    events,
    nextCursor,
    stateVersion: snapshot.stateVersion,
    sessionKey: snapshot.sessionKey,
  };
}

/* ═══ Helpers ═══ */

let msgCounter = 0;
const CHAT_HISTORY_OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';
const HISTORY_ENVELOPE_TIMESTAMP_RE = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,4}\]\s*/;

function nextId() {
  return 'pmsg-' + Date.now() + '-' + (++msgCounter);
}

function stripHistoryEnvelope(text: string): string {
  if (!text) return text;
  const match = text.match(HISTORY_ENVELOPE_TIMESTAMP_RE);
  if (match && match.index !== undefined) {
    const beforeTimestamp = text.substring(0, match.index);
    if (
      beforeTimestamp.includes('Conversation info (untrusted metadata)')
      || beforeTimestamp.includes('Sender (untrusted metadata)')
    ) {
      return text.substring(match.index + match[0].length).trim();
    }
  }
  return text;
}

function sanitizeHistoryMessageText(text: string): string {
  return stripOpenClawReplyTags(stripHistoryEnvelope(text || ''))
    .replace(/\r\n/g, '\n')
    .trim();
}

function isHiddenHistoryArtifactText(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;

  return [
    /^System \(untrusted\):/i,
    /^An async command you ran earlier has completed\./i,
    /^Read HEARTBEAT\.md if it exists/i,
    /^HEARTBEAT_OK$/i,
    /^Heartbeat check complete(?:d)?\.?$/i,
    /^Pre-compaction memory flush\./i,
    /^Memory flush complete(?:d)?\.?$/i,
    /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i,
    /Handle the result internally\./i,
    /Sender \(untrusted metadata\):/i,
    /Conversation info \(untrusted metadata\):/i,
  ].some((pattern) => pattern.test(normalized));
}

function summarizeHiddenHistoryArtifactText(text: string): string | null {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  if (/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i.test(normalized) && /\[Internal task completion event\]/i.test(normalized)) {
    const sourceMatch = normalized.match(/^source:\s*(.+)$/im);
    const source = sourceMatch?.[1]?.trim().toLowerCase() || '';
    if (source === 'subagent') return 'Delegated task completed';
    if (source) return 'Background task completed';
    return 'Background work completed';
  }

  if (/^An async command you ran earlier has completed\./i.test(normalized)) {
    return 'Earlier async command completed';
  }

  if (/^Read HEARTBEAT\.md if it exists/i.test(normalized)) {
    return 'Heartbeat check started';
  }

  if (/^HEARTBEAT_OK$/i.test(normalized) || /^Heartbeat check complete(?:d)?\.?$/i.test(normalized)) {
    return 'Heartbeat check completed';
  }

  if (/^Pre-compaction memory flush\./i.test(normalized)) {
    return 'Memory flush started';
  }

  if (/^Memory flush complete(?:d)?\.?$/i.test(normalized)) {
    return 'Memory flush completed';
  }

  return null;
}

function isStandaloneMaintenanceNoticeContent(text: string): boolean {
  const normalized = sanitizeHistoryMessageText(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || !isCompactionNotice(normalized)) return false;

  const marker = normalized.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return [
    /^context compacted\.?$/i,
    /^context maintenance (?:in progress|finished|complete(?:d)?)\.?$/i,
    /^compacting context[.…]*$/i,
    /^preparing (?:context maintenance|compaction)[.…]*$/i,
    /^memory flush(?: started| complete(?:d)?| in progress)?[.…]*$/i,
    /^heartbeat check (?:started|complete(?:d)?)[.…]*$/i,
    /^compacted\s*\([^)]{1,80}\)(?:\s*[•-]\s*context\b.*)?$/i,
    /^compaction (?:complete(?:d)?|finished|in progress|started|incomplete|did not complete)\.?$/i,
    /^compaction skipped(?::.*)?$/i,
  ].some((pattern) => pattern.test(marker));
}

function isControlOrMaintenanceAssistantContent(text: string): boolean {
  return isControlOnlyAssistantContent(text || '') || isStandaloneMaintenanceNoticeContent(text || '');
}

function parseHistoryMessage(m: any): ChatMessage | null {
  const rawContent = typeof m.content === 'string' ? m.content : '';
  const sanitizedHistoryText = sanitizeHistoryMessageText(rawContent);
  const rawThinkingContent = typeof m.thinkingContent === 'string' ? sanitizeAssistantContent(m.thinkingContent) : '';
  const rawThinkingSubject = sanitizeThinkingSubject(m.thinkingSubject);
  const isTruncationPlaceholder = m.role === 'assistant' && rawContent === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  if (m.role === 'assistant' && !isTruncationPlaceholder && isControlOrMaintenanceAssistantContent(rawContent) && !rawThinkingContent && !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0)) {
    return null;
  }
  if (!isTruncationPlaceholder && isHiddenHistoryArtifactText(sanitizedHistoryText) && !rawThinkingContent && !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0)) {
    const summary = summarizeHiddenHistoryArtifactText(sanitizedHistoryText);
    if (!summary) return null;
    return {
      id: m.id || nextId(),
      role: 'system',
      content: summary,
      createdAt: new Date(m.timestamp || Date.now()),
      provenance: 'hidden-history-artifact',
    };
  }

  const msg: ChatMessage = {
    id: m.id || nextId(),
    role: isTruncationPlaceholder ? 'system' : m.role,
    content: isTruncationPlaceholder
      ? 'Earlier assistant output was omitted from history because the message was too large.'
      : (m.role === 'assistant' ? sanitizeAssistantContent(rawContent) : sanitizedHistoryText),
    createdAt: new Date(m.timestamp || Date.now()),
    provenance: m.provenance || ((m.__openclaw?.kind === 'compaction' || isCompactionNotice(sanitizedHistoryText)) ? 'compaction' : undefined),
    model: typeof m.model === 'string' ? m.model : undefined,
    thinkingContent: rawThinkingContent || undefined,
    thinkingSubject: rawThinkingSubject || undefined,
  };
  if (m.toolCalls) {
    msg.toolCalls = m.toolCalls.map((tc: any) => ({
      id: tc.id || nextId(),
      name: tc.name,
      arguments: tc.arguments,
      result: typeof tc.result === 'string' ? tc.result : undefined,
      startedAt: Number.isFinite(tc.startedAt) ? tc.startedAt : Date.now(),
      endedAt: Number.isFinite(tc.endedAt) ? tc.endedAt : undefined,
      // Durable history is not proof that a tool is still executing. Exact
      // active-turn replay will project a running tool again when warranted;
      // without that authority, a stranded historical status must be settled.
      status: tc.status === 'error' ? 'error' : 'done' as const,
      order: Number.isSafeInteger(tc.order) ? tc.order : undefined,
    }));
  }
  if (Array.isArray(m.segments)) {
    msg.segments = m.segments.flatMap((segment: any) => {
      const text = typeof segment?.text === 'string' ? sanitizeAssistantContent(segment.text) : '';
      const kind = segment.kind === 'thinking' ? 'thinking' as const : 'text' as const;
      const subject = kind === 'thinking' ? sanitizeThinkingSubject(segment?.subject) : '';
      if (!text.trim() && !subject) return [];
      return [{
        text,
        ...(subject ? { subject } : {}),
        position: segment.position === 'before' || segment.position === 'between' ? segment.position : 'after',
        kind,
        ts: Number.isFinite(segment.ts) ? segment.ts : undefined,
        order: Number.isSafeInteger(segment.order) ? segment.order : undefined,
      }];
    });
  }
  if (m.role === 'toolResult') {
    msg.toolCallId = m.toolCallId;
    msg.toolName = m.toolName;
  }
  return msg;
}

const HISTORY_REPLAY_DUPLICATE_WINDOW_MS = 5_000;
const PROJECT_STREAM_TIMEOUT_MS = 10 * 60_000;

function normalizeHistoryReplayContent(content: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

function isEquivalentCompactionNotice(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  if (!previous || previous.role !== 'system' || next.role !== 'system') return false;
  if (!(previous.provenance === 'compaction' || next.provenance === 'compaction')) return false;
  if (!isCompactionNotice(previous.content) || !isCompactionNotice(next.content)) return false;

  const previousContent = normalizeHistoryReplayContent(previous.content);
  const nextContent = normalizeHistoryReplayContent(next.content);
  if (!previousContent || previousContent !== nextContent) return false;

  const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
  const nextTs = next.createdAt instanceof Date ? next.createdAt.getTime() : NaN;
  return Number.isFinite(previousTs) && Number.isFinite(nextTs) && Math.abs(nextTs - previousTs) <= 30_000;
}

function dedupeHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const deduped: ChatMessage[] = [];
  for (const msg of messages) {
    const previous = deduped[deduped.length - 1];
    if (!previous || previous.role !== 'user' || msg.role !== 'user') {
      if (isEquivalentCompactionNotice(previous, msg)) continue;
      deduped.push(msg);
      continue;
    }

    const previousContent = normalizeHistoryReplayContent(previous.content);
    const nextContent = normalizeHistoryReplayContent(msg.content);
    const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
    const nextTs = msg.createdAt instanceof Date ? msg.createdAt.getTime() : NaN;

    const isReplayDuplicate = Boolean(previousContent)
      && previousContent === nextContent
      && Number.isFinite(previousTs)
      && Number.isFinite(nextTs)
      && nextTs >= previousTs
      && (nextTs - previousTs) <= HISTORY_REPLAY_DUPLICATE_WINDOW_MS;

    if (!isReplayDuplicate) deduped.push(msg);
  }
  return deduped;
}

function parseProjectChatHistoryMessages(
  messages: ProjectChatPersistedMessage[],
  provider: ProjectChatProviderName,
  runtime: string,
): ChatMessage[] {
  return dedupeHistoryMessages(messages
    .map((message) => parseHistoryMessage({
      ...message,
      provenance: `${getProjectProviderLabel(message.provider || provider)} • ${message.runtime || runtime}`,
    }))
    .filter(Boolean) as ChatMessage[]);
}

export function mergeProjectChatHistoryPages(
  olderMessages: ChatMessage[],
  currentMessages: ChatMessage[],
): ChatMessage[] {
  const currentIds = new Set(currentMessages.map((message) => message.id).filter(Boolean));
  return dedupeHistoryMessages([
    ...olderMessages.filter((message) => !currentIds.has(message.id)),
    ...currentMessages,
  ]);
}

function getProjectProviderLabel(provider: ProjectChatProviderName): string {
  if (provider === 'OPENCLAW') return 'OpenClaw';
  if (provider === 'CLAUDE_CODE') return 'Claude Code';
  if (provider === 'AGENT_ZERO') return 'Agent Zero';
  if (provider === 'GROK') return 'Grok Build';
  if (provider === 'GEMINI') return 'Antigravity';
  return provider
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/* ═══ Sub-components ═══ */

const ToolCallPill = React.memo(function ToolCallPill({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const onAnswerQuestion = useAskQuestionAnswer();
  const askPayload = useMemo(
    () => (isAskQuestionTool(tool.name) ? parseAskQuestionPayload(tool.arguments) : null),
    [tool.name, tool.arguments],
  );
  // The exact-run pending card beside the composer owns live answers. Keep the
  // streamed tool call non-interactive until it has a result so Project Chat
  // never presents two forms for one runtime request.
  if (askPayload && onAnswerQuestion && tool.result) {
    return (
      <div className="px-3">
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
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-2 py-0.5"
    >
      <div className="flex flex-col items-center max-w-sm w-full">
        <button
          onClick={() => hasDetails && setExpanded(!expanded)}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors text-[10px] text-slate-400 ${presentation.surfaceClass}`}
        >
          <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${presentation.iconBadgeClass}`}>
            <ToolGlyph toolName={tool.name} size={10} className={presentation.iconClass} />
          </span>
          <span className="text-slate-200">{summary}</span>
          {tool.status === 'running' ? (
            <Loader2 aria-label="Tool turn running" size={9} className={`animate-spin ${presentation.iconClass}`} />
          ) : null}
          {duration && <span className="text-slate-500">· {duration}s</span>}
          {hasDetails && (
            <ChevronRight size={9} className={`text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
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
                <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-slate-800/40 border border-white/[0.04] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[100px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[9px] block mb-0.5">Args:</span>
                  {typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}
                </div>
              )}
              {tool.result && (
                <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-black/20 border border-white/[0.04] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[100px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[9px] block mb-0.5">Result:</span>
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

const BoundedProjectToolCalls = React.memo(function BoundedProjectToolCalls({
  tools,
  messageKey,
}: {
  tools: readonly ToolCall[];
  messageKey: string;
}) {
  const [revealedEarlier, setRevealedEarlier] = useState(0);
  useEffect(() => setRevealedEarlier(0), [messageKey]);
  const windowed = useMemo(
    () => selectNewestWindow(tools, PROJECT_CHAT_TOOL_WINDOW_SIZE, revealedEarlier),
    [revealedEarlier, tools],
  );

  if (tools.length === 0) return null;

  return (
    <div className="mb-1">
      {windowed.hiddenCount > 0 ? (
        <div className="flex justify-center px-2 py-1">
          <button
            type="button"
            onClick={() => setRevealedEarlier((current) => current + PROJECT_CHAT_TOOL_WINDOW_SIZE)}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200"
          >
            Show earlier tools · {windowed.hiddenCount} hidden
          </button>
        </div>
      ) : null}
      {windowed.items.map((tool) => <ToolCallPill key={tool.id} tool={tool} />)}
    </div>
  );
});

export function reconcileProjectPresentationSegments(
  rawSegments: NonNullable<ChatMessage['segments']>,
  rawCanonicalContent: string,
  rawTools: readonly ToolCall[] = [],
): NonNullable<ChatMessage['segments']> {
  const canonicalContent = String(rawCanonicalContent || '').trim();
  const segments = rawSegments.map((segment) => ({ ...segment }));
  if (!canonicalContent) return segments;

  const textIndexes = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.kind !== 'thinking' && Boolean(segment.text?.trim()));
  if (textIndexes.some(({ segment }) => segment.text.trim() === canonicalContent)) {
    return segments;
  }

  const canonicalComparable = canonicalContent.replace(/\s+/g, ' ');
  const combinedComparable = textIndexes
    .map(({ segment }) => segment.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ');
  if (combinedComparable === canonicalComparable) {
    return segments;
  }

  const finalTail = reconcileCumulativeFinalTail(
    textIndexes.map(({ segment }) => segment.text),
    canonicalContent,
  ).trim();
  if (!finalTail) return segments;

  const latestToolOrder = rawTools.reduce(
    (current, tool) => (
      typeof tool.order === 'number' && Number.isFinite(tool.order)
        ? Math.max(current, tool.order)
        : current
    ),
    -1,
  );
  const latestToolTimestamp = rawTools.reduce(
    (current, tool) => Math.max(
      current,
      Number.isFinite(tool.endedAt) ? Number(tool.endedAt) : Number(tool.startedAt) || 0,
    ),
    0,
  );
  const lastTextEntry = textIndexes[textIndexes.length - 1];
  const lastTextOrder = typeof lastTextEntry?.segment.order === 'number'
    ? lastTextEntry.segment.order
    : null;
  const lastTextTimestamp = typeof lastTextEntry?.segment.ts === 'number'
    ? lastTextEntry.segment.ts
    : 0;
  const toolFollowsLastText = lastTextEntry
    ? (
        lastTextOrder != null && latestToolOrder >= 0
          ? latestToolOrder > lastTextOrder
          : latestToolTimestamp > lastTextTimestamp
      )
    : false;
  const consumedGraduatedText = finalTail !== canonicalContent;

  // A lone prefix at the end of the timeline is merely a lagging snapshot;
  // replace it. If a tool follows, preserve that prefix where it occurred and
  // append only the new residual tail after the tool.
  if (
    consumedGraduatedText
    && textIndexes.length === 1
    && lastTextEntry
    && !toolFollowsLastText
  ) {
    segments[lastTextEntry.index] = {
      ...lastTextEntry.segment,
      text: canonicalContent,
    };
    return segments;
  }

  const appendedText = consumedGraduatedText ? finalTail : canonicalContent;
  if (!appendedText) return segments;

  const maxOrder = [...segments, ...rawTools].reduce(
    (current, segment) => (
      typeof segment.order === 'number' && Number.isFinite(segment.order)
        ? Math.max(current, segment.order)
        : current
    ),
    -1,
  );
  const maxTimestamp = Math.max(Date.now(), ...segments.map(
    (segment) => (
      typeof segment.ts === 'number' && Number.isFinite(segment.ts)
        ? segment.ts
        : 0
    ),
  ), ...rawTools.map(
    (tool) => (
      Number.isFinite(tool.endedAt)
        ? Number(tool.endedAt)
        : Number.isFinite(tool.startedAt) ? Number(tool.startedAt) : 0
    ),
  ));
  segments.push({
    text: appendedText,
    kind: 'text',
    position: 'after',
    order: maxOrder + 1,
    ts: maxTimestamp + 1,
  });
  return segments;
}

const ProjectActivityTimeline = React.memo(function ProjectActivityTimeline({
  messageId,
  projectName,
  segments,
  tools,
}: {
  messageId: string;
  projectName: string;
  segments: NonNullable<ChatMessage['segments']>;
  tools: readonly ToolCall[];
}) {
  const timeline = useMemo(() => [
    ...segments.map((segment, index) => ({
      kind: 'segment' as const,
      segment,
      order: typeof segment.order === 'number' ? segment.order : null,
      ts: typeof segment.ts === 'number' ? segment.ts : index,
      key: `segment-${index}`,
    })),
    ...tools.map((tool, index) => ({
      kind: 'tool' as const,
      tool,
      order: typeof tool.order === 'number' ? tool.order : null,
      ts: Number.isFinite(tool.startedAt) ? tool.startedAt : segments.length + index,
      key: `tool-${tool.id}-${index}`,
    })),
  ].sort((left, right) => {
    // Durable replay sequence is authoritative. Provider timestamps can be
    // skewed or sampled on different clocks, so use them only for legacy
    // records that do not carry a sequence/order value.
    if (left.order != null && right.order != null) {
      return (left.order - right.order) || (left.ts - right.ts);
    }
    return (left.ts - right.ts) || ((left.order ?? 0) - (right.order ?? 0));
  }), [segments, tools]);
  const [revealedEarlier, setRevealedEarlier] = useState(0);
  useEffect(() => setRevealedEarlier(0), [messageId]);
  const windowed = useMemo(
    () => selectNewestWindow(timeline, 80, revealedEarlier),
    [revealedEarlier, timeline],
  );
  return (
    <div className="space-y-1">
      {windowed.hiddenCount > 0 ? (
        <div className="flex justify-center px-2 py-1">
          <button
            type="button"
            onClick={() => setRevealedEarlier((current) => current + 80)}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] text-slate-400"
          >
            Show earlier activity · {windowed.hiddenCount} hidden
          </button>
        </div>
      ) : null}
      {windowed.items.map((item) => item.kind === 'tool' ? (
        <ToolCallPill key={`${messageId}-${item.key}`} tool={item.tool} />
      ) : (
        <div key={`${messageId}-${item.key}`} className="flex gap-2 items-start px-3 py-1">
          <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[8px] font-bold ${item.segment.kind === 'thinking' ? 'bg-violet-500/20 text-violet-300' : 'bg-emerald-500/20 text-emerald-400'}`}>
            {item.segment.kind === 'thinking' ? <Sparkles size={10} /> : 'AI'}
          </div>
          <div className={`flex-1 min-w-0 max-w-[90%] rounded-2xl rounded-bl-sm border px-3 py-2 ${item.segment.kind === 'thinking' ? 'border-violet-400/15 bg-violet-500/[0.08]' : 'border-white/[0.08] bg-white/[0.06]'}`}>
            {item.segment.kind === 'thinking' ? (
              <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-violet-200/75">
                thinking{item.segment.subject ? ` · ${item.segment.subject}` : ''}
              </div>
            ) : null}
            {item.segment.text ? (
              <div className="text-[11px] leading-relaxed">
                <MarkdownRenderer
                  content={item.segment.text}
                  isStreaming={false}
                  hostFileContext={{ source: 'project', project: projectName }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
});

function ToolResultPill({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = message.toolName || 'unknown';
  const content = message.content || '';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-2 py-0.5"
    >
      <div className="flex flex-col items-center max-w-sm w-full">
        <button
          onClick={() => content && setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/[0.06] border border-emerald-500/[0.10] hover:bg-emerald-500/[0.10] transition-colors text-[10px] text-slate-400"
        >
          <CheckCircle2 size={10} className="text-emerald-400" />
          <span className="text-slate-300">Result: <span className="font-mono">{toolName}</span></span>
          {content && <ChevronRight size={9} className={`text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />}
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
              <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/[0.04] border border-emerald-500/[0.06] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[150px] overflow-y-auto text-left">
                {content}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [text]);

  return (
    <button onClick={handleCopy} className={`p-0.5 rounded transition-all ${copied ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`} title={copied ? 'Copied!' : 'Copy'}>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const isUploading = attachment.uploadStatus === 'uploading';
  const hasError = attachment.uploadStatus === 'error';
  const visibleLabel = hasError
    ? `${attachment.name}: ${attachment.uploadError || 'Upload failed'}`
    : attachment.name;
  return (
    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] ${
      hasError ? 'bg-red-500/10 border border-red-500/20 text-red-300' :
      isUploading ? 'bg-amber-500/[0.06] border border-amber-500/15 text-slate-300' :
      'bg-white/[0.06] border border-white/[0.08] text-slate-300'
    }`}>
      {isUploading ? <Loader2 size={10} className="animate-spin text-amber-400" /> : <Paperclip size={10} className="text-slate-400" />}
      <span className="max-w-[180px] truncate" title={visibleLabel}>{visibleLabel}</span>
      {isUploading ? <span className="text-amber-400/60 text-[8px]">…</span> : null}
      {hasError ? (
        <button
          type="button"
          aria-label={`Retry attachment ${attachment.name}`}
          onClick={onRetry}
          className="ml-0.5 rounded p-0.5 text-red-200 transition-colors hover:bg-red-500/20 hover:text-white"
        >
          <RotateCcw size={9} />
        </button>
      ) : null}
      <button aria-label={`Remove attachment ${attachment.name}`} onClick={onRemove} className="ml-0.5 text-slate-500 hover:text-slate-200"><X size={9} /></button>
    </div>
  );
}

/* ═══ Model options ═══ */

function modelDisplayName(modelId: string): string {
  return getModelDisplayName(modelId, 'Default model');
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

function ModelPickerDropdown({
  open,
  onClose,
  anchorRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      width={288}
      mobileBreakpoint={767}
      onDismiss={(reason) => {
        onClose();
        if (reason === 'escape') anchorRef.current?.focus();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        role="dialog"
        aria-label="Select model"
        className="flex min-h-0 max-h-full w-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#1A1F3A] shadow-2xl shadow-black/50"
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 pb-1.5 pt-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Select Model</span>
          <button type="button" aria-label="Close model selector" onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:text-slate-300">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </motion.div>
    </AnchoredPopover>
  );
}

function ProjectModelPicker({
  value,
  onChange,
  models,
  loading = false,
  error = null,
  disabled = false,
  exactCatalogOnly = false,
  onRetry,
}: {
  value: string;
  onChange: (model: string) => void;
  models: string[];
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  exactCatalogOnly?: boolean;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState(value);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
    if (!disabled) return;
    close();
  }, [close, disabled]);

  // Native providers can accept an exact model id even when they do not
  // publish a catalog. Exact-catalog providers stay visible on loading/error
  // so the operator can retry instead of losing the only recovery control.
  if (models.length === 0 && exactCatalogOnly && !loading && !error) return null;

  const emptySelectionLabel = exactCatalogOnly ? 'Select model' : 'Default model';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={loading}
        aria-label="Select project chat model"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-[11px] text-slate-400 hover:text-slate-200 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title={disabled
          ? 'Model selection is unavailable while the project runtime is changing'
          : error || value || emptySelectionLabel}
      >
        {loading
          ? <Loader2 size={13} className="sm:hidden flex-shrink-0 animate-spin" />
          : error
            ? <XCircle size={13} className="flex-shrink-0 text-red-300" />
            : <Code2 size={13} className="sm:hidden flex-shrink-0" />}
        <div className="hidden sm:flex items-center gap-1.5 min-w-0 max-w-[220px]">
          {loading ? <Loader2 size={12} className="flex-shrink-0 animate-spin text-violet-300" /> : null}
          {error
            ? <span className="truncate max-w-[140px] text-red-300">Models unavailable</span>
            : value
              ? <ModelMeta modelId={value} compact />
              : <span className="truncate max-w-[140px]">{emptySelectionLabel}</span>}
        </div>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''} hidden sm:block`} />
      </button>
      <ModelPickerDropdown open={open} anchorRef={triggerRef} onClose={close}>
        <div className="p-1 scrollbar-thin scrollbar-thumb-white/10">
          {loading && (
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-[11px] text-slate-400">
              <Loader2 size={12} className="animate-spin text-violet-300" />
              Loading models…
            </div>
          )}
          {error && (
            <div role="alert" className="border-b border-red-500/15 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-200">
              <div className="flex items-start gap-2">
                <XCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{error}</span>
              </div>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={loading}
                  className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-red-400/20 bg-red-500/10 px-2.5 text-[11px] text-red-100 disabled:opacity-50"
                >
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                  Retry model catalog
                </button>
              )}
            </div>
          )}
          {!loading && !error && models.length === 0 && !exactCatalogOnly && (
            <div role="status" className="border-b border-white/[0.06] px-3 py-2 text-[11px] text-slate-500">
              This provider does not publish a model catalog here. Enter the exact model ID manually.
            </div>
          )}
          {!loading && !error && models.length === 0 && exactCatalogOnly && (
            <div role="status" className="border-b border-amber-500/15 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-100">
              No verified models are available for this Project provider.
            </div>
          )}
          {!exactCatalogOnly && <button type="button" onClick={() => { onChange(''); close(); }} className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${!value ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'}`}>
            <span className="flex-1 text-left">Default</span>
            {!value && <Check size={12} className="text-violet-400" />}
          </button>}
          {models.map((m) => (
            <button type="button" key={m} aria-label={`Select model ${m}`} onClick={() => { onChange(m); close(); }} className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${value === m ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'}`}>
              <ModelMeta modelId={m} />
              {value === m && <Check size={12} className="text-violet-400 flex-shrink-0" />}
            </button>
          ))}
          {!exactCatalogOnly && <div className="border-t border-white/[0.06] mt-1 pt-1">
            {custom ? (
              <div className="px-2 py-1">
                <input
                  aria-label="Custom model name"
                  autoFocus
                  className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40"
                  placeholder="Custom model name"
                  value={customDraft}
                  onChange={(event) => setCustomDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitCustomModel();
                    if (event.key === 'Escape') close();
                  }}
                />
                <button
                  type="button"
                  onClick={submitCustomModel}
                  disabled={!customDraft.trim()}
                  className="mt-2 inline-flex min-h-[36px] w-full items-center justify-center rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 text-xs font-medium text-violet-100 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Apply model
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => { setCustomDraft(value); setCustom(true); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-400 hover:bg-white/[0.04] hover:text-slate-200">
                Custom model…
              </button>
            )}
          </div>}
        </div>
      </ModelPickerDropdown>
    </div>
  );
}

/* ═══ Main Component ═══ */

export default function ProjectChatPanel({ projectName, onClose, onProjectPrepared, onActivityChange }: ProjectChatPanelProps) {
  const isMobile = useIsMobile();
  const actorUserId = useAuthStore((state) => state.user?.id || '');
  const actorRole = useAuthStore((state) => state.user?.role || '');
  const hostRecoveryRole: ProjectQualificationRecoveryRole = actorRole === 'OWNER'
    ? 'OWNER'
    : actorRole === 'SUB_ADMIN'
      ? 'SUB_ADMIN'
      : 'USER';
  const hostRecoveryAction = projectQualificationRecoveryAction(hostRecoveryRole);
  const authRecoveryAction = projectQualificationAuthRecoveryAction(hostRecoveryRole);

  // Session state
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProjectChatProviderName>('OPENCLAW');
  const [serverSelectedProvider, setServerSelectedProvider] = useState<ProjectChatProviderName | null>(null);
  const [projectIdentityId, setProjectIdentityId] = useState<string | null>(null);
  const [projectChatStateVersion, setProjectChatStateVersion] = useState<number | null>(null);
  const [providerVerificationState, setProviderVerificationState] = useState<ProjectProviderVerificationState>('unknown');
  const [providerTransitionPending, setProviderTransitionPending] = useState(true);
  const [selectedRuntime, setSelectedRuntime] = useState('unverified-project-runtime');
  const [providerCapabilities, setProviderCapabilities] = useState<ProjectChatProviderCapability[]>(() => (
    buildUnavailableProjectProviderCapabilities(
      'Project provider verification has not completed. No provider can be selected or used yet.',
    )
  ));
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    canonicalizePortalModelId(
      localStorage.getItem(`agent-model-${projectName}-OPENCLAW`)
      || localStorage.getItem(`agent-model-${projectName}`)
      || '',
    )
  );
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const sessionReadyRef = useRef(false);
  const [sessionReady, setSessionReadyState] = useState(false);
  const setSessionReady = useCallback((ready: boolean) => {
    // Session-control mutations use this synchronous mirror to fail closed if
    // provider verification changes while a gateway PATCH is still in flight.
    sessionReadyRef.current = ready;
    setSessionReadyState(ready);
  }, []);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionRecoveryPending, setSessionRecoveryPending] = useState(false);
  const [projectMoveNotice, setProjectMoveNotice] = useState<{
    projectId: string;
    title: string;
    message: string;
  } | null>(null);
  const [projectMigrationPending, setProjectMigrationPending] = useState(false);
  const [projectMigrationError, setProjectMigrationError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [boundProviders, setBoundProviders] = useState<string[]>([]);
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<ProjectChatProviderName | null>(null);
  const [providerReviewRequest, setProviderReviewRequest] = useState<{
    provider: ProjectChatProviderName;
    token: number;
  } | null>(null);
  const selectedProviderCapability = useMemo(
    () => providerCapabilities.find((entry) => entry.provider === selectedProvider) || null,
    [providerCapabilities, selectedProvider],
  );
  const providerSupportsAttachments = selectedProviderCapability?.supportsAttachments === true;
  const providerSupportsModelSelection = selectedProviderCapability?.supportsModelSelection === true;
  const providerSupportsAbort = selectedProviderCapability?.supportsAbort === true;
  const providerSupportsReset = selectedProviderCapability?.supportsReset === true;

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [terminalHistoryPending, setTerminalHistoryPending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);
  const [isExportingChat, setIsExportingChat] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetryPending, setHistoryRetryPending] = useState(false);
  const [olderHistoryError, setOlderHistoryError] = useState<string | null>(null);
  const [historyPagination, setHistoryPagination] = useState<{
    hasMore: boolean;
    nextCursor: string | null;
  }>({ hasMore: false, nextCursor: null });
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<PendingProjectChatSend | null>(null);
  const [queuedComposerMessage, setQueuedComposerMessage] = useState<string | null>(null);
  const queuedComposerMessageRef = useRef<string | null>(null);
  const preservedQueuedComposerDraftScopeRef = useRef<QueuedComposerDraftScope | null>(null);
  const [composerPreparationPrompt, setComposerPreparationPrompt] = useState<QualifiableProjectProvider | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestionRequest[]>([]);
  const [pendingQuestionAnswerPending, setPendingQuestionAnswerPending] = useState(false);
  const [pendingSendStorageError, setPendingSendStorageError] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
  const thinkingContentRef = useRef('');
  const [thinkingSubject, setThinkingSubject] = useState<string>('');
  const thinkingSubjectRef = useRef('');
  const [pendingApprovals, setPendingApprovals] = useState<ExecApprovalRequest[]>([]);
  const pendingApproval = pendingApprovals[0] || null;
  const [compactionPhase, setCompactionPhase] = useState<'idle' | 'compacting' | 'compacted'>('idle');
  const compactionPhaseRef = useRef<'idle' | 'compacting' | 'compacted'>('idle');
  const [transportConnected, setTransportConnected] = useState(false);
  // "Connection lost, reconnecting…" is only true after a stream actually
  // existed; a cold open that is still connecting for the first time must
  // render as connecting, not as a loss.
  const hasEverConnectedRef = useRef(false);
  const [replayRetryNonce, setReplayRetryNonce] = useState(0);
  const [providerRefreshNonce, setProviderRefreshNonce] = useState(0);
  const [providerQualifications, setProviderQualifications] = useState<Partial<Record<ProjectChatProviderName, ProjectChatProviderQualificationStatus>>>({});
  // Last preparation failure per provider so the menu drawer keeps the
  // actionable explanation (sign-in needed, backend offline) after the
  // transient alert banner clears.
  const [providerQualificationFailures, setProviderQualificationFailures] = useState<Partial<
    Record<ProjectChatProviderName, ProjectProviderQualificationFailure>
  >>({});
  const [qualificationRetryClock, setQualificationRetryClock] = useState(() => Date.now());
  const [qualificationPending, setQualificationPending] = useState(false);
  const [qualificationProgress, setQualificationProgress] = useState<ProjectQualificationProgress | null>(null);

  useEffect(() => {
    if (!actorUserId || !projectIdentityId) return;
    const restoredFailures: Partial<
      Record<ProjectChatProviderName, ProjectProviderQualificationFailure>
    > = {};
    const verifiedProviders: ProjectChatProviderName[] = [];
    for (const provider of DIRECT_QUALIFICATION_PRIORITY) {
      const key = automaticQualificationSuppressionKey(
        actorUserId,
        projectIdentityId,
        provider,
      );
      if (!key) continue;
      const qualification = providerQualifications[provider];
      if (qualification?.status === 'QUALIFIED') {
        clearAutomaticQualificationSuppression(key);
        verifiedProviders.push(provider);
        continue;
      }
      const suppression = readAutomaticQualificationSuppression(key);
      if (!suppression) continue;
      const failure = failureFromAutomaticQualificationSuppression(
        suppression,
        getProjectProviderLabel(provider),
      );
      if (failure) restoredFailures[provider] = failure;
    }
    if (verifiedProviders.length === 0 && Object.keys(restoredFailures).length === 0) return;
    setProviderQualificationFailures((current) => {
      const next = { ...current };
      for (const provider of verifiedProviders) delete next[provider];
      for (const [provider, failure] of Object.entries(restoredFailures)) {
        const typedProvider = provider as ProjectChatProviderName;
        if (!next[typedProvider] && failure) next[typedProvider] = failure;
      }
      return next;
    });
  }, [actorUserId, projectIdentityId, providerQualifications]);

  useEffect(() => {
    if (transportConnected) hasEverConnectedRef.current = true;
  }, [transportConnected]);
  useEffect(() => {
    const now = Date.now();
    const retryDeadlines = Object.values(providerQualificationFailures)
      .map((failure) => normalizeProjectQualificationRetryAt(failure?.retryAt, now))
      .filter((retryAt): retryAt is string => retryAt !== null)
      .map((retryAt) => Date.parse(retryAt));
    const suppressionDeadlines = Object.values(providerQualificationFailures)
      .map((failure) => {
        const value = failure?.suppressionExpiresAt;
        if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp)
          && timestamp <= now + MAX_AUTOMATIC_QUALIFICATION_SUPPRESSION_TTL_MS
          ? timestamp
          : null;
      })
      .filter((timestamp): timestamp is number => timestamp !== null);
    const nextDeadline = [...retryDeadlines, ...suppressionDeadlines]
      .sort((left, right) => left - right)[0];
    if (!Number.isFinite(nextDeadline)) return undefined;
    const timeout = window.setTimeout(
      () => {
        const firedAt = Date.now();
        const expiredProviders = Object.entries(providerQualificationFailures)
          .filter(([, failure]) => {
            const expiresAt = Date.parse(failure?.suppressionExpiresAt || '');
            return Number.isFinite(expiresAt) && expiresAt <= firedAt;
          })
          .map(([provider]) => provider as ProjectChatProviderName);
        for (const provider of expiredProviders) {
          clearAutomaticQualificationSuppression(
            automaticQualificationSuppressionKey(
              actorUserId,
              projectIdentityId,
              provider as QualifiableProjectProvider,
            ),
          );
        }
        if (expiredProviders.length > 0) {
          setProviderQualificationFailures((current) => {
            const next = { ...current };
            for (const provider of expiredProviders) delete next[provider];
            return next;
          });
        }
        setQualificationRetryClock(firedAt);
      },
      Math.max(25, nextDeadline - now + 25),
    );
    return () => window.clearTimeout(timeout);
  }, [
    actorUserId,
    projectIdentityId,
    providerQualificationFailures,
    qualificationRetryClock,
  ]);
  useEffect(() => {
    hasEverConnectedRef.current = false;
  }, [projectName]);
  const qualificationLeaseRef = useRef<Readonly<ProjectChatActivity> | null>(null);
  const qualificationTokenRef = useRef(0);
  const [projectTransitionActivity, setProjectTransitionActivity] = useState<ProjectTransitionActivity | null>(null);
  const projectTransitionActivityRef = useRef<ProjectTransitionActivity | null>(null);
  const projectTransitionActivityTokenRef = useRef(0);
  const onActivityChangeRef = useRef(onActivityChange);
  onActivityChangeRef.current = onActivityChange;
  const [agentZeroQualificationModel, setAgentZeroQualificationModel] = useState(() => (
    canonicalizePortalModelId(localStorage.getItem(`agent-model-${projectName}-AGENT_ZERO`) || '')
  ));
  const [agentZeroProjectModels, setAgentZeroProjectModels] = useState<AgentZeroProjectModelOption[]>([]);
  const [agentZeroModelsLoading, setAgentZeroModelsLoading] = useState(false);
  const [agentZeroModelsError, setAgentZeroModelsError] = useState<string | null>(null);

  useEffect(() => {
    setQualificationProgress(null);
    queuedComposerMessageRef.current = null;
    setQueuedComposerMessage(null);
    preservedQueuedComposerDraftScopeRef.current = null;
    setComposerPreparationPrompt(null);
    setProjectMigrationPending(false);
    setProjectMigrationError(null);
  }, [projectName]);

  const directQualificationProvider = useMemo<QualifiableProjectProvider | null>(() => {
    // Provider discovery and immutable-identity verification own their own
    // retry state. Never manufacture a preparation target from an empty or
    // failed capability response.
    if (providerVerificationState !== 'ready') return null;
    const selectedQualification = selectedProvider === 'GROK'
      ? null
      : providerQualifications[selectedProvider];
    if (
      selectedQualification
      && selectedQualification.status !== 'QUALIFIED'
      && selectedQualification.status !== 'UNAVAILABLE'
    ) {
      return selectedProvider as QualifiableProjectProvider;
    }
    for (const provider of DIRECT_QUALIFICATION_PRIORITY) {
      const qualification = providerQualifications[provider];
      if (!qualification) continue;
      if (qualification.status !== 'QUALIFIED' && qualification.status !== 'UNAVAILABLE') return provider;
    }
    return null;
  }, [providerQualifications, providerVerificationState, selectedProvider]);

  useEffect(() => {
    setComposerPreparationPrompt(null);
  }, [projectName, selectedProvider, sessionReady]);

  // Input state
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const slashMenuId = React.useId();
  const [showSessionControls, setShowSessionControls] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('high');
  const [reasoningVisibility, setReasoningVisibility] = useState<ReasoningVisibility>('stream');
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [sessionControlMutation, setSessionControlMutation] = useState<ProjectSessionControlKind | null>(null);
  const [sessionControlError, setSessionControlError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionControlsTriggerRef = useRef<HTMLButtonElement>(null);
  const slashMenuBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs
  const streamingAssistantIdRef = useRef<string | null>(null);
  const assembledRef = useRef('');
  const lastSegmentStartRef = useRef(0);
  const lastRawTextLenRef = useRef(0); // Track raw gateway text length for accurate graduation
  const resumeSeededContentRef = useRef(false);
  const suppressLiveBubbleContentRef = useRef(false);
  const isStreamActiveRef = useRef(false);
  const toolCounterRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const providerRef = useRef<ProjectChatProviderName>(selectedProvider);
  const thinkingLevelRef = useRef<ThinkingLevel>(thinkingLevel);
  const reasoningVisibilityRef = useRef<ReasoningVisibility>(reasoningVisibility);
  const fastModeEnabledRef = useRef(fastModeEnabled);
  const sessionControlMutationRef = useRef<ProjectSessionControlMutation | null>(null);
  const sessionControlGenerationRef = useRef(0);
  const sessionControlActivityTokenRef = useRef(0);
  const runtimeRef = useRef(selectedRuntime);
  const historyGenRef = useRef(0);
  const olderHistoryLoadInFlightRef = useRef(false);
  const loadOlderHistoryRef = useRef<() => void>(() => {});
  const modelRef = useRef(selectedModel);
  const sendPendingRef = useRef(false);
  const pendingQuestionsRef = useRef<AskUserQuestionRequest[]>([]);
  const pendingQuestionsReadyRef = useRef(false);
  const pendingQuestionPollGenerationRef = useRef(0);
  const pendingQuestionComposerAnswerRef = useRef<{
    id: string;
    text: string;
    inFlight: boolean;
  } | null>(null);
  const pendingActiveSteerRef = useRef<{
    requestId: string;
    text: string;
    turnId: string;
    sessionKey: string;
    inFlight: boolean;
  } | null>(null);
  const pendingSendRef = useRef<PendingProjectChatSend | null>(null);
  const replayCursorRef = useRef(0);
  const activeReplayTurnIdRef = useRef<string | null>(null);
  const serverSelectedProviderRef = useRef<ProjectChatProviderName | null>(null);
  const projectChatStateVersionRef = useRef<number | null>(null);
  const projectIdentityIdRef = useRef<string | null>(null);
  const providerVerificationStateRef = useRef<ProjectProviderVerificationState>('unknown');
  const providerTransitionPendingRef = useRef(true);
  const providerCapabilitiesRef = useRef(providerCapabilities);
  const pendingTextRenderRef = useRef<{
    assistantId: string;
    content: string;
    generation: number;
  } | null>(null);
  const pendingThinkingRenderRef = useRef<{
    assistantId: string | null;
    content: string;
    generation: number;
  } | null>(null);

  const replacePendingQuestions = useCallback((questions: AskUserQuestionRequest[]) => {
    pendingQuestionsRef.current = questions;
    const pendingAnswer = pendingQuestionComposerAnswerRef.current;
    if (pendingAnswer && !questions.some((entry) => entry.id === pendingAnswer.id)) {
      pendingQuestionComposerAnswerRef.current = null;
      setPendingQuestionAnswerPending(false);
    }
    setPendingQuestions(questions);
  }, []);

  const settlePendingQuestion = useCallback((id: string) => {
    replacePendingQuestions(pendingQuestionsRef.current.filter((entry) => entry.id !== id));
  }, [replacePendingQuestions]);

  const refreshPendingQuestions = useCallback(async () => {
    const requestedSession = sessionKeyRef.current;
    if (
      !requestedSession
      || providerRef.current !== 'OPENCLAW'
      || serverSelectedProviderRef.current !== 'OPENCLAW'
      || !isStreamActiveRef.current
    ) return;
    const generation = pendingQuestionPollGenerationRef.current;
    const data = await gatewayAPI.pendingQuestions(requestedSession);
    if (
      generation !== pendingQuestionPollGenerationRef.current
      || sessionKeyRef.current !== requestedSession
      || providerRef.current !== 'OPENCLAW'
      || serverSelectedProviderRef.current !== 'OPENCLAW'
      || !isStreamActiveRef.current
    ) return;
    const now = Date.now();
    replacePendingQuestions((Array.isArray(data?.questions) ? data.questions : []).filter((entry) => (
      entry?.sessionKey === requestedSession
      && entry.state === 'pending'
      && entry.expiresAt > now
      && entry.surface === 'project-chat'
    )));
    pendingQuestionsReadyRef.current = true;
  }, [replacePendingQuestions]);

  const claimProjectTransitionActivity = useCallback((activity: ProjectTransitionActivity) => {
    if (
      projectTransitionActivityRef.current
      || qualificationLeaseRef.current
      || sessionControlMutationRef.current
    ) return false;
    projectTransitionActivityRef.current = activity;
    if (onActivityChangeRef.current?.(activity, true) === false) {
      projectTransitionActivityRef.current = null;
      return false;
    }
    setProjectTransitionActivity(activity);
    return true;
  }, []);

  useEffect(() => {
    if (providerTransitionPending) return;
    const activity = projectTransitionActivityRef.current;
    if (!activity) return;
    projectTransitionActivityRef.current = null;
    onActivityChangeRef.current?.(activity, false);
    setProjectTransitionActivity(null);
  }, [providerTransitionPending]);
  const textRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (slashMenuBlurTimerRef.current) {
      clearTimeout(slashMenuBlurTimerRef.current);
      slashMenuBlurTimerRef.current = null;
    }
  }, []);

  const rememberPendingSend = useCallback((pending: PendingProjectChatSend | null) => {
    pendingSendRef.current = pending;
    setPendingSend(pending);
  }, []);

  const pendingSendScope = useMemo<ProjectChatSendScope | null>(() => (
    actorUserId && projectIdentityId
      ? { actorUserId, projectId: projectIdentityId, provider: selectedProvider }
      : null
  ), [actorUserId, projectIdentityId, selectedProvider]);

  const queuedComposerDraftScope = useMemo<QueuedComposerDraftScope | null>(() => (
    actorUserId && projectIdentityId
      ? { actorUserId, projectId: projectIdentityId, provider: selectedProvider }
      : null
  ), [actorUserId, projectIdentityId, selectedProvider]);

  const clearPreservedQueuedComposerDraft = useCallback(() => {
    const scope = preservedQueuedComposerDraftScopeRef.current;
    if (scope) clearQueuedComposerDraft(scope);
    preservedQueuedComposerDraftScopeRef.current = null;
  }, []);

  const restoreQueuedComposerDraft = useCallback(() => {
    const queued = queuedComposerMessageRef.current;
    if (!queued) return false;
    queuedComposerMessageRef.current = null;
    setQueuedComposerMessage(null);
    setInput((current) => current || queued);
    setConnectionNotice(null);
    return true;
  }, []);

  useEffect(() => {
    if (!queuedComposerDraftScope || queuedComposerMessageRef.current) return;
    const restored = readQueuedComposerDraft(queuedComposerDraftScope);
    if (!restored) return;
    preservedQueuedComposerDraftScopeRef.current = queuedComposerDraftScope;
    setInput((current) => current || restored);
  }, [queuedComposerDraftScope]);

  const refreshPendingSendState = useCallback((scope: ProjectChatSendScope) => {
    try {
      const inspected = inspectProjectChatPendingSend(scope);
      if (inspected.status === 'corrupt') {
        rememberPendingSend(null);
        setPendingSendStorageError(
          `${inspected.reason} Clear Project Chat to restore a safe delivery state.`,
        );
        return inspected;
      }
      setPendingSendStorageError(null);
      rememberPendingSend(inspected.pending);
      return inspected;
    } catch (error: any) {
      rememberPendingSend(null);
      setPendingSendStorageError(
        error?.message || 'Project Chat could not read its preserved delivery state.',
      );
      return { status: 'corrupt' as const, pending: null, reason: String(error?.message || error) };
    }
  }, [rememberPendingSend]);

  useEffect(() => {
    if (!pendingSendScope) {
      rememberPendingSend(null);
      setPendingSendStorageError(null);
      return undefined;
    }
    refreshPendingSendState(pendingSendScope);
    return subscribeProjectChatSendState(
      pendingSendScope,
      () => { refreshPendingSendState(pendingSendScope); },
    );
  }, [pendingSendScope, refreshPendingSendState, rememberPendingSend]);

  const confirmPendingSend = useCallback(async (messageId: string) => {
    const pending = pendingSendRef.current;
    const immutableProjectId = projectIdentityIdRef.current;
    if (!pending || pending.messageId !== messageId || !actorUserId || !immutableProjectId) return false;
    const scope: ProjectChatSendScope = {
      actorUserId,
      projectId: immutableProjectId,
      provider: pending.provider,
    };
    try {
      await reconcilePendingProjectChatSend({
        scope,
        resolve: async (current) => (
          current.messageId === messageId ? 'confirmed' : 'ambiguous'
        ),
      });
      refreshPendingSendState(scope);
      return true;
    } catch {
      return false;
    }
  }, [actorUserId, refreshPendingSendState]);

  const pendingSendMessageId = pendingSend?.messageId || null;
  useEffect(() => {
    const pending = pendingSendRef.current;
    const immutableProjectId = projectIdentityId;
    if (
      !pending
      || pending.messageId !== pendingSendMessageId
      || !immutableProjectId
      || pendingSendStorageError
      || sendPendingRef.current
    ) return undefined;
    const scope: ProjectChatSendScope = {
      actorUserId,
      projectId: immutableProjectId,
      provider: pending.provider,
    };
    let cancelled = false;
    void reconcilePendingProjectChatSend({
      scope,
      resolve: async (current) => resolveProjectChatPendingMessageStatus({
        scope,
        pending: current,
        probe: () => projectsAPI.agentMessageStatus(projectName, {
          provider: current.provider,
          messageId: current.messageId,
          messageFingerprint: current.payloadFingerprint,
        }),
      }),
    }).then(() => {
      if (!cancelled) refreshPendingSendState(scope);
    }).catch((error: any) => {
      if (cancelled) return;
      if (Number(error?.response?.status) === 409) {
        setPendingSendStorageError(
          error?.response?.data?.error
          || 'Project Chat could not safely reconcile this preserved delivery ID. Clear Project Chat before retrying.',
        );
      }
    });
    return () => { cancelled = true; };
  }, [
    actorUserId,
    pendingSendMessageId,
    pendingSendStorageError,
    projectIdentityId,
    projectName,
    refreshPendingSendState,
  ]);

  thinkingLevelRef.current = thinkingLevel;
  reasoningVisibilityRef.current = reasoningVisibility;
  fastModeEnabledRef.current = fastModeEnabled;

  const flushPendingTextRender = useCallback(() => {
    if (textRenderTimerRef.current) {
      clearTimeout(textRenderTimerRef.current);
      textRenderTimerRef.current = null;
    }
    const pending = pendingTextRenderRef.current;
    pendingTextRenderRef.current = null;
    if (!pending || pending.generation !== historyGenRef.current) return;
    setMessages((prev) => prev.map((message) => (
      message.id === pending.assistantId
        ? { ...message, content: pending.content }
        : message
    )));
  }, []);

  const flushPendingThinkingRender = useCallback(() => {
    if (thinkingRenderTimerRef.current) {
      clearTimeout(thinkingRenderTimerRef.current);
      thinkingRenderTimerRef.current = null;
    }
    const pending = pendingThinkingRenderRef.current;
    pendingThinkingRenderRef.current = null;
    if (!pending || pending.generation !== historyGenRef.current) return;
    setThinkingContent(pending.content);
    if (!pending.assistantId) return;
    setMessages((prev) => prev.map((message) => (
      message.id === pending.assistantId
        ? { ...message, thinkingContent: pending.content || undefined }
        : message
    )));
  }, []);

  const flushPendingLiveRenders = useCallback(() => {
    flushPendingTextRender();
    flushPendingThinkingRender();
  }, [flushPendingTextRender, flushPendingThinkingRender]);

  const clearPendingLiveRenders = useCallback(() => {
    if (textRenderTimerRef.current) clearTimeout(textRenderTimerRef.current);
    if (thinkingRenderTimerRef.current) clearTimeout(thinkingRenderTimerRef.current);
    textRenderTimerRef.current = null;
    thinkingRenderTimerRef.current = null;
    pendingTextRenderRef.current = null;
    pendingThinkingRenderRef.current = null;
  }, []);

  const scheduleTextRender = useCallback((assistantId: string | null, content: string) => {
    if (!assistantId) return;
    pendingTextRenderRef.current = {
      assistantId,
      content,
      generation: historyGenRef.current,
    };
    if (textRenderTimerRef.current) return;
    textRenderTimerRef.current = setTimeout(
      flushPendingTextRender,
      getProjectChatRenderDelay(document.visibilityState),
    );
  }, [flushPendingTextRender]);

  const scheduleThinkingRender = useCallback((assistantId: string | null, content: string) => {
    pendingThinkingRenderRef.current = {
      assistantId,
      content,
      generation: historyGenRef.current,
    };
    if (thinkingRenderTimerRef.current) return;
    thinkingRenderTimerRef.current = setTimeout(
      flushPendingThinkingRender,
      getProjectChatRenderDelay(document.visibilityState),
    );
  }, [flushPendingThinkingRender]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') flushPendingLiveRenders();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [flushPendingLiveRenders]);

  useEffect(() => () => clearPendingLiveRenders(), [clearPendingLiveRenders]);

  const providerTurnActive = isRunning || isStreamActiveRef.current;
  const providerSwitchAllowed = canSwitchProjectProvider({
    verificationState: providerVerificationState,
    serverSelectedProvider,
    turnActive: providerTurnActive,
    transitionPending: providerTransitionPending,
  });
  const requiresExactModelCatalog = selectedProvider === 'OPENCLAW'
    || selectedProvider === 'AGENT_ZERO';
  const selectedModelIsAvailable = availableModels.includes(
    canonicalizePortalModelId(selectedModel),
  );
  const providerSendAllowed = canSendToProjectProvider({
    verificationState: providerVerificationState,
    serverSelectedProvider,
    renderedProvider: selectedProvider,
    selectedCapability: selectedProviderCapability,
    sessionReady,
    turnActive: providerTurnActive,
    transitionPending: providerTransitionPending,
  }) && (
    !requiresExactModelCatalog || selectedModelIsAvailable
  ) && Boolean(projectIdentityId) && !pendingSendStorageError;
  const providerModelSelectionAllowed = providerVerificationState === 'ready'
    && serverSelectedProvider === selectedProvider
    && selectedProviderCapability?.selectable === true
    && selectedProviderCapability.executionScope === 'PROJECT_SANDBOX'
    && sessionReady
    && !providerTurnActive
    && !providerTransitionPending
    && Boolean(projectIdentityId);
  const modelCatalogBlocksInput = requiresExactModelCatalog
    && Boolean(modelCatalogError)
    && providerVerificationState === 'ready'
    && !qualificationPending;
  const providerAcceptsActiveInput = isRunning
    && selectedProvider === 'OPENCLAW'
    && serverSelectedProvider === 'OPENCLAW'
    && providerVerificationState === 'ready'
    && !providerTransitionPending
    && selectedProviderCapability?.selectable === true
    && selectedProviderCapability.executionScope === 'PROJECT_SANDBOX'
    && Boolean(sessionKey)
    && Boolean(activeReplayTurnIdRef.current);
  const composerAcceptsInput = providerAcceptsActiveInput
    ? !pendingQuestionAnswerPending
    : !isRunning
      && !queuedComposerMessage
      && !pendingSendStorageError;
  const hasVerifiedProjectConnection = providerVerificationState === 'ready'
    && !providerTransitionPending
    && sessionReady
    && serverSelectedProvider === selectedProvider
    && selectedProviderCapability?.selectable === true
    && selectedProviderCapability.executionScope === 'PROJECT_SANDBOX'
    && Boolean(sessionKey)
    && Boolean(projectIdentityId)
    && (!requiresExactModelCatalog || selectedModelIsAvailable);
  const projectSessionMutationControlsAllowed = hasVerifiedProjectConnection
    && selectedProvider === 'OPENCLAW';
  // While a preparation is actively running, the progress panel owns the
  // truth; rendering this failure banner beside it told the operator the
  // check "did not complete" during its very first attempt.
  const showUnavailableProviderBanner = (
    providerVerificationState === 'failed'
    || (
      providerVerificationState === 'ready'
      && selectedProviderCapability?.selectable !== true
    )
  ) && !qualificationPending && qualificationProgress === null;
  const directQualificationFailure = directQualificationProvider
    ? providerQualificationFailures[directQualificationProvider]
    : undefined;
  const directAgentZeroNeedsModelReview = directQualificationProvider === 'AGENT_ZERO'
    && !agentZeroProjectModels.some((option) => option.value === agentZeroQualificationModel);
  const unavailableProviderIsFailure = providerVerificationState === 'failed'
    || Boolean(directQualificationFailure);
  const unavailableProviderDetail = providerVerificationState === 'failed'
    ? sessionError || 'Project Chat could not verify this project’s providers.'
    : composerPreparationPrompt
      ? `Prepare ${getProjectProviderLabel(composerPreparationPrompt)} before sending. Your draft is still in the composer.`
      : directQualificationFailure?.message
        || 'This provider has not been prepared for this project yet.';
  const directQualificationRetryAt = normalizeProjectQualificationRetryAt(
    directQualificationFailure?.retryAt,
    qualificationRetryClock,
  );
  const directQualificationRetryDeferred = directQualificationRetryAt !== null;
  const directQualificationRetryBlocked = directQualificationFailure?.retryable === false
    || directQualificationRetryDeferred;
  const idleProjectConnectionStatus = hasVerifiedProjectConnection && !isRunning
    ? `${selectedProviderCapability?.displayName || getProjectProviderLabel(selectedProvider)} Project agent verified and ready`
    : null;

  useEffect(() => {
    const activeAssistantId = streamingAssistantIdRef.current;
    if (!activeAssistantId || streamingPhase !== 'tool') return;
    const activeMessage = messages.find((message) => message.id === activeAssistantId);
    const runningToolCall = getLastRunningToolCall(activeMessage?.toolCalls);
    if (runningToolCall?.name) {
      const runningToolName = resolveToolName(runningToolCall.name);
      if (runningToolName && runningToolName !== activeToolName) {
        setActiveToolName(runningToolName);
      }
    }
  }, [messages, streamingPhase, activeToolName]);

  const appendSystemNotice = useCallback((content: string, provenance?: string) => {
    const now = Date.now();
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'system' && last.content === content && now - last.createdAt.getTime() < 4000) {
        return prev;
      }
      return [...prev, { id: nextId(), role: 'system', content, createdAt: new Date(now), provenance }];
    });
  }, []);

  const applyMaintenanceState = useCallback((update: {
    phase: 'start' | 'end';
    content?: string | null;
    completed?: boolean;
    maintenanceKind?: 'compaction' | 'maintenance';
  }) => {
    const content = String(update.content || '').trim();
    const completed = update.completed !== false;
    const maintenanceKind = update.maintenanceKind || 'maintenance';

    if (update.phase === 'start') {
      clearPendingLiveRenders();
      const noticeText = content || (maintenanceKind === 'compaction' ? 'Compacting context…' : 'Context maintenance in progress…');
      if (compactionTimerRef.current) {
        clearTimeout(compactionTimerRef.current);
        compactionTimerRef.current = null;
      }
      compactionPhaseRef.current = 'compacting';
      setCompactionPhase('compacting');
      setStatusText(noticeText);
      thinkingContentRef.current = '';
      setThinkingContent('');
      return;
    }

    if (completed && maintenanceKind === 'compaction') {
      const noticeText = content || 'Context compacted';
      compactionPhaseRef.current = 'compacted';
      setCompactionPhase('compacted');
      setStatusText(noticeText);
      appendSystemNotice(noticeText, 'compaction');
      if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
      compactionTimerRef.current = setTimeout(() => {
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        setStatusText((prev) => (prev === noticeText ? null : prev));
        compactionTimerRef.current = null;
      }, 3000);
      return;
    }

    const noticeText = content || 'Context maintenance finished.';
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    setStatusText(noticeText);
    appendSystemNotice(noticeText, 'hidden-history-artifact');
    if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    compactionTimerRef.current = setTimeout(() => {
      setStatusText((prev) => (prev === noticeText ? null : prev));
      compactionTimerRef.current = null;
    }, 3000);
  }, [appendSystemNotice, clearPendingLiveRenders]);

  const applyCompactionSnapshotState = useCallback((phase?: unknown) => {
    if (phase !== 'idle' && phase !== 'compacting' && phase !== 'compacted') return;
    if (compactionTimerRef.current) {
      clearTimeout(compactionTimerRef.current);
      compactionTimerRef.current = null;
    }
    compactionPhaseRef.current = phase;
    setCompactionPhase(phase);
    if (phase === 'compacting') {
      setStatusText('Compacting context…');
    }
    if (phase === 'compacted') {
      const noticeText = 'Context compacted';
      setStatusText(noticeText);
      compactionTimerRef.current = setTimeout(() => {
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        setStatusText((prev) => (prev === noticeText ? null : prev));
        compactionTimerRef.current = null;
      }, 3000);
    }
  }, []);

  // Scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [revealedEarlierMessages, setRevealedEarlierMessages] = useState(0);
  const messageWindow = useMemo(
    () => selectNewestWindow(messages, PROJECT_CHAT_MESSAGE_WINDOW_SIZE, revealedEarlierMessages),
    [messages, revealedEarlierMessages],
  );
  const visibleMessageStartIndex = messages.length - messageWindow.items.length;
  const messageRevealAnchorRef = useRef<{
    sessionKey: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageWindowSessionKey = `${projectName}:${selectedProvider}:${sessionKey || ''}`;

  useEffect(() => {
    messageRevealAnchorRef.current = null;
    setRevealedEarlierMessages(0);
  }, [messageWindowSessionKey]);

  useLayoutEffect(() => {
    const anchor = messageRevealAnchorRef.current;
    if (!anchor) return;
    messageRevealAnchorRef.current = null;
    if (anchor.sessionKey !== messageWindowSessionKey) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = anchor.scrollTop + Math.max(0, container.scrollHeight - anchor.scrollHeight);
  }, [messageWindowSessionKey, revealedEarlierMessages]);

  const revealEarlierMessages = useCallback(() => {
    const container = scrollRef.current;
    if (container) {
      messageRevealAnchorRef.current = {
        sessionKey: messageWindowSessionKey,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }
    setRevealedEarlierMessages((current) => current + PROJECT_CHAT_MESSAGE_WINDOW_SIZE);
  }, [messageWindowSessionKey]);

  useEffect(() => {
    sessionKeyRef.current = sessionKey;
    providerRef.current = selectedProvider;
    sessionControlGenerationRef.current += 1;
    // A parent-owned session mutation must keep its navigation lease until
    // the PATCH plus canonical readback settles. If the scope changes despite
    // that guard, invalidate its response generation without silently
    // releasing the immutable operation owner.
    if (!sessionControlMutationRef.current) {
      setSessionControlMutation(null);
      setSessionControlError(null);
    }
  }, [selectedProvider, sessionKey]);
  useEffect(() => { runtimeRef.current = selectedRuntime; }, [selectedRuntime]);
  useEffect(() => { modelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { serverSelectedProviderRef.current = serverSelectedProvider; }, [serverSelectedProvider]);
  useEffect(() => { projectChatStateVersionRef.current = projectChatStateVersion; }, [projectChatStateVersion]);
  useEffect(() => { providerVerificationStateRef.current = providerVerificationState; }, [providerVerificationState]);
  useEffect(() => { providerTransitionPendingRef.current = providerTransitionPending; }, [providerTransitionPending]);
  useEffect(() => { providerCapabilitiesRef.current = providerCapabilities; }, [providerCapabilities]);

  useEffect(() => {
    pendingQuestionPollGenerationRef.current += 1;
    pendingQuestionComposerAnswerRef.current = null;
    pendingActiveSteerRef.current = null;
    pendingQuestionsReadyRef.current = false;
    setPendingQuestionAnswerPending(false);
    replacePendingQuestions([]);
    if (
      !isRunning
      || selectedProvider !== 'OPENCLAW'
      || serverSelectedProvider !== 'OPENCLAW'
      || !sessionKey
    ) return undefined;

    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refreshPendingQuestions();
      } catch {
        // Keep the last confirmed card mounted. The next bounded poll retries.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (!cancelled) void poll();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      pendingQuestionPollGenerationRef.current += 1;
    };
  }, [
    isRunning,
    projectName,
    refreshPendingQuestions,
    replacePendingQuestions,
    selectedProvider,
    serverSelectedProvider,
    sessionKey,
  ]);

  useEffect(() => {
    let cancelled = false;
    const expectedSession = sessionKey;
    const expectedProvider = selectedProvider;
    const expectedGeneration = sessionControlGenerationRef.current;
    if (!expectedSession || selectedProvider !== 'OPENCLAW') {
      thinkingLevelRef.current = 'high';
      setThinkingLevel('high');
      reasoningVisibilityRef.current = 'off';
      setReasoningVisibility('off');
      fastModeEnabledRef.current = false;
      setFastModeEnabled(false);
      return;
    }

    const isCurrent = () => (
      !cancelled
      && !sessionControlMutationRef.current
      && sessionControlGenerationRef.current === expectedGeneration
      && sessionKeyRef.current === expectedSession
      && providerRef.current === expectedProvider
    );
    gatewayAPI.sessionInfo(sessionKey, { silent: true })
      .then((data) => {
        if (
          !isCurrent()
        ) return;
        const actualModel = normalizeModelId(
          {
            provider: data?.session?.modelProvider || data?.session?.currentModel?.provider,
            model: data?.session?.model || data?.session?.currentModel?.model,
          }
        ) || canonicalizePortalModelId(String(
          data?.resolved?.model
          || modelRef.current
          || ''
        ));
        const rawThinking = String(
          data?.session?.thinkingLevel
          || data?.session?.thinking
          || data?.session?.settings?.thinking
          || ''
        ).toLowerCase();
        if (actualModel) {
          setSelectedModel((prev) => prev === actualModel ? prev : actualModel);
        }
        if (THINKING_LEVELS.includes(rawThinking as ThinkingLevel)) {
          thinkingLevelRef.current = rawThinking as ThinkingLevel;
          setThinkingLevel(rawThinking as ThinkingLevel);
        } else {
          const modelStr = String(actualModel || '').toLowerCase();
          const adaptiveDefault = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(modelStr);
          thinkingLevelRef.current = adaptiveDefault ? 'adaptive' : 'high';
          setThinkingLevel(adaptiveDefault ? 'adaptive' : 'high');
        }
        const rawReasoning = String(
          data?.session?.reasoningLevel
          || data?.session?.reasoning
          || data?.session?.settings?.reasoning
          || '',
        ).toLowerCase();
        if (['off', 'on', 'stream'].includes(rawReasoning)) {
          const nextReasoning = rawReasoning as ReasoningVisibility;
          reasoningVisibilityRef.current = nextReasoning;
          setReasoningVisibility(nextReasoning);
        } else {
          // Creation defaults are a server-owned, atomic invariant. Never
          // race a user's explicit upstream choice with a client-side patch.
          reasoningVisibilityRef.current = 'off';
          setReasoningVisibility('off');
        }
        const nextFastMode = Boolean(
          data?.session?.fastMode
          ?? data?.session?.settings?.fastMode
          ?? false,
        );
        fastModeEnabledRef.current = nextFastMode;
        setFastModeEnabled(nextFastMode);
      })
      .catch(() => {
        if (!isCurrent()) return;
        thinkingLevelRef.current = 'high';
        setThinkingLevel('high');
        reasoningVisibilityRef.current = 'off';
        setReasoningVisibility('off');
        fastModeEnabledRef.current = false;
        setFastModeEnabled(false);
        setSessionControlError(
          'Could not read this Project session’s reasoning setting. Its existing value was left unchanged.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [sessionKey, selectedProvider]);

  // Persist model selection
  useEffect(() => {
    if (selectedProviderCapability?.supportsModelSelection !== true) return;
    const normalized = canonicalizePortalModelId(selectedModel);
    localStorage.setItem(`agent-model-${projectName}-${selectedProvider}`, normalized);
    if (selectedProvider === 'OPENCLAW') {
      localStorage.setItem(`agent-model-${projectName}`, normalized);
    }
  }, [selectedModel, selectedProvider, selectedProviderCapability, projectName]);

  const loadAgentZeroProjectModels = useCallback(async (): Promise<string[]> => {
    setAgentZeroModelsLoading(true);
    setAgentZeroModelsError(null);
    try {
      const catalog = await projectsAPI.agentZeroProjectModels(projectName);
      const options = (Array.isArray(catalog?.providers) ? catalog.providers : [])
        .filter((provider) => provider.connectionState === 'connected')
        .flatMap((provider) => (Array.isArray(provider.models) ? provider.models : []).map((model) => ({
          value: `${provider.providerId}/${String(model.id || '').trim()}`,
          label: `${provider.displayName} · ${String(model.displayName || model.id || '').trim()}`,
        })))
        .filter((option) => option.value.split('/').slice(1).join('/').trim().length > 0);
      const uniqueOptions = Array.from(
        new Map(options.map((option) => [option.value, option])).values(),
      );
      setAgentZeroProjectModels(uniqueOptions);
      setAgentZeroQualificationModel((current) => {
        const stored = canonicalizePortalModelId(
          localStorage.getItem(`agent-model-${projectName}-AGENT_ZERO`) || '',
        );
        const candidate = canonicalizePortalModelId(current || stored);
        return uniqueOptions.some((option) => option.value === candidate) ? candidate : '';
      });
      if (uniqueOptions.length === 0) {
        setAgentZeroModelsError(
          'Connect an Agent Zero account and verify its live model catalog before using it in this project.',
        );
      }
      return uniqueOptions.map((option) => option.value);
    } catch (error: any) {
      setAgentZeroProjectModels([]);
      setAgentZeroModelsError(
        error?.response?.data?.error
        || error?.message
        || 'Agent Zero OAuth models could not be verified.',
      );
      throw error;
    } finally {
      setAgentZeroModelsLoading(false);
    }
  }, [projectName]);

  const reviewAgentZeroProjectModels = useCallback(() => {
    void loadAgentZeroProjectModels().catch(() => undefined);
  }, [loadAgentZeroProjectModels]);

  useEffect(() => {
    if (!agentZeroQualificationModel) return;
    localStorage.setItem(
      `agent-model-${projectName}-AGENT_ZERO`,
      agentZeroQualificationModel,
    );
  }, [agentZeroQualificationModel, projectName]);

  const loadAvailableModels = useCallback(async () => {
    const requestedProvider = selectedProvider;
    const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === requestedProvider);
    if (capability?.supportsModelSelection !== true) {
      setAvailableModels([]);
      setModelCatalogLoading(false);
      setModelCatalogError(null);
      return [];
    }
    if (
      (requestedProvider === 'OPENCLAW'
        && providerQualifications.OPENCLAW?.status !== 'QUALIFIED')
      || (requestedProvider === 'AGENT_ZERO'
        && providerQualifications.AGENT_ZERO?.status !== 'QUALIFIED')
    ) {
      setAvailableModels([]);
      setModelCatalogLoading(false);
      setModelCatalogError(null);
      return [];
    }
    setModelCatalogLoading(true);
    setModelCatalogError(null);
    setAvailableModels([]);
    try {
      const models: string[] = requestedProvider === 'AGENT_ZERO'
        ? await loadAgentZeroProjectModels()
        : [];
      if (requestedProvider !== 'AGENT_ZERO') {
        const data = requestedProvider === 'OPENCLAW'
          ? await projectsAPI.projectChatModels(projectName)
          : await gatewayAPI.models(requestedProvider, { silent: true });
        models.push(...(
          Array.isArray(data?.models)
            ? Array.from(new Set(data.models.map((m: any) => canonicalizePortalModelId(String(m?.id || '').trim())).filter(Boolean))) as string[]
            : []
        ));
      }
      if (providerRef.current !== requestedProvider) return [];
      setAvailableModels(models);
      setModelCatalogError(
        requestedProvider === 'OPENCLAW' && models.length === 0
          ? 'No authenticated embedded model is available for this OpenClaw Project agent. Reconnect a supported provider, then retry.'
          : requestedProvider === 'AGENT_ZERO' && models.length === 0
            ? 'Connect an Agent Zero account and verify its live model catalog before using it in this project.'
            : null,
      );
      if (
        models.length === 0
        && (requestedProvider === 'OPENCLAW' || requestedProvider === 'AGENT_ZERO')
      ) {
        restoreQueuedComposerDraft();
      }
      // Preserve a verified native model if its provider publishes no catalog;
      // the manual model path remains usable. Exact-catalog providers instead
      // clear stale choices that the current Project agent cannot attest.
      setSelectedModel(prev => {
        if (models.length === 0 && requestedProvider !== 'AGENT_ZERO') {
          return prev;
        }
        if (requestedProvider === 'AGENT_ZERO') {
          const exact = canonicalizePortalModelId(prev);
          return models.includes(exact) ? exact : '';
        }
        const resolved = resolveAvailableModelId(prev, models);
        // Catalog discovery is read-only. Do not silently present its first
        // entry as selected before the Project session validates that change.
        return resolved || prev;
      });
      return models;
    } catch (error: any) {
      if (providerRef.current === requestedProvider) {
        setAvailableModels([]);
        setModelCatalogError(
          requestedProvider === 'OPENCLAW'
            ? 'Portal could not verify an authenticated embedded model for this OpenClaw Project agent. Reconnect a supported provider, then retry.'
            : requestedProvider === 'AGENT_ZERO'
              ? 'Agent Zero’s connected model catalog could not be loaded. Retry after checking its provider connection.'
              : `${getProjectProviderLabel(requestedProvider)} models could not be loaded. Retry the catalog or enter an exact model ID.`,
        );
        restoreQueuedComposerDraft();
      }
      throw error;
    } finally {
      if (providerRef.current === requestedProvider) setModelCatalogLoading(false);
    }
  }, [loadAgentZeroProjectModels, projectName, providerQualifications.AGENT_ZERO?.status, providerQualifications.OPENCLAW?.status, restoreQueuedComposerDraft, selectedProvider]);

  useEffect(() => {
    if (!providerSupportsModelSelection) {
      setAvailableModels([]);
      setModelCatalogLoading(false);
      setModelCatalogError(null);
      return;
    }
    if (
      (selectedProvider === 'OPENCLAW'
        && providerQualifications.OPENCLAW?.status !== 'QUALIFIED')
      || (selectedProvider === 'AGENT_ZERO'
        && providerQualifications.AGENT_ZERO?.status !== 'QUALIFIED')
    ) {
      setAvailableModels([]);
      setModelCatalogLoading(false);
      setModelCatalogError(null);
      return;
    }
    let cancelled = false;
    setModelCatalogLoading(true);
    const timer = window.setTimeout(() => {
      loadAvailableModels().catch((err) => {
        if (!cancelled) {
          console.error('[ProjectChatPanel] Failed to load models:', err);
        }
      });
    }, selectedProvider === 'OPENCLAW' ? 0 : 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadAvailableModels, providerQualifications.AGENT_ZERO?.status, providerQualifications.OPENCLAW?.status, providerSupportsModelSelection, selectedProvider]);

  // Mark session as active for auto-restore
  useEffect(() => {
    localStorage.setItem(`agent-active-${projectName}`, 'true');
    return () => {}; // Don't clear on unmount — closeAgentChat handles that
  }, [projectName]);

  // ── Scroll helpers ──
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const up = dist > 80;
    setShowScrollBtn(up);
    isScrolledUp.current = up;
    if (el.scrollTop <= 48 && !isLoadingHistory && !isLoadingOlderHistory) {
      if (messageWindow.hiddenCount > 0) {
        revealEarlierMessages();
      } else if (historyPagination.hasMore) {
        loadOlderHistoryRef.current();
      }
    }
  }, [
    historyPagination.hasMore,
    isLoadingHistory,
    isLoadingOlderHistory,
    messageWindow.hiddenCount,
    revealEarlierMessages,
  ]);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!isScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom(true));
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isRunning && !isScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom(false));
    }
  }, [isRunning, scrollToBottom]);

  // ── Watchdog ──
  // The durable poll loop resets this while Portal still reports an active
  // turn. It therefore measures loss of the Portal replay transport, not gaps
  // between provider text/tool/thinking events. Transport silence must never
  // invent a terminal event: the durable replay cursor remains authoritative.
  const resetWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    if (!isStreamActiveRef.current) return;
    const arm = () => {
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        if (!isStreamActiveRef.current) return;
        // Browsers can suspend hidden tabs for hours. Keep the durable turn
        // alive without causing background-only render churn or a false error.
        if (document.visibilityState !== 'hidden') {
          setTransportConnected(false);
          setConnectionNotice('Durable replay is delayed — reconnecting…');
          setStatusText('Waiting for durable replay…');
        }
        arm();
      }, PROJECT_STREAM_TIMEOUT_MS);
    };
    arm();
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const ensureStreamingAssistant = useCallback((content?: string) => {
    const currentId = streamingAssistantIdRef.current ?? ('stream-resume-' + Date.now());
    streamingAssistantIdRef.current = currentId;
    setMessages(prev => {
      const exists = prev.some(m => m.id === currentId);
      if (!exists) {
        return [...prev, {
          id: currentId,
          role: 'assistant' as const,
          content: typeof content === 'string' ? content : '',
          createdAt: new Date(),
          toolCalls: [],
        }];
      }
      if (typeof content !== 'string') return prev;
      return prev.map(m => m.id === currentId ? { ...m, content } : m);
    });
    return currentId;
  }, []);

  const isStaleSessionLoad = useCallback((expectedSession: string, expectedGen: number) => {
    // Before the provider handshake assigns a session key, transcript preload
    // intentionally uses an empty sentinel. Treat the ref's initial null as
    // the same state or every cold open discards its immediate history read
    // and waits for a second request after admission.
    return (sessionKeyRef.current || '') !== expectedSession || historyGenRef.current !== expectedGen;
  }, []);

  const applyActiveStreamSnapshot = useCallback((
    snapshot: any,
    expectedSession: string,
    expectedGen: number,
  ) => {
    if (!snapshot?.active || isStaleSessionLoad(expectedSession, expectedGen)) return false;

    const resumePhase = snapshot.phase === 'tool' ? 'tool' : snapshot.phase === 'streaming' ? 'streaming' : 'thinking';
    const snapshotContent = typeof snapshot.content === 'string' && !isControlOrMaintenanceAssistantContent(snapshot.content)
      ? sanitizeAssistantContent(snapshot.content)
      : '';
    const snapshotToolCalls: ToolCall[] = Array.isArray(snapshot.toolCalls)
      ? snapshot.toolCalls.map((toolCall: any) => ({
          id: toolCall.id || nextId(),
          name: toolCall.name,
          arguments: toolCall.arguments,
          startedAt: typeof toolCall.startedAt === 'number' ? toolCall.startedAt : Date.now(),
          endedAt: typeof toolCall.endedAt === 'number' ? toolCall.endedAt : undefined,
          status: toolCall.status === 'running' || toolCall.status === 'error' ? toolCall.status : 'done',
        }))
      : [];
    const runningToolCall = getLastRunningToolCall(snapshotToolCalls);
    const snapshotToolNameCandidate = snapshot.toolName || snapshot.name || runningToolCall?.name || null;
    const snapshotToolName = snapshotToolNameCandidate ? resolveToolName(snapshotToolNameCandidate) : null;
    const rawStatusText = getRailSafeStatusText(typeof snapshot.statusText === 'string' ? snapshot.statusText.trim() : '');
    const isMaintenanceStatusOnly = Boolean(rawStatusText && isControlOrMaintenanceAssistantContent(rawStatusText));
    const hasStatusSignal = Boolean(rawStatusText && !isMaintenanceStatusOnly);
    const hasMaintenanceSignal = isMaintenanceStatusOnly
      || snapshot.compactionPhase === 'compacting'
      || snapshot.compactionPhase === 'compacted';
    const hasLiveSnapshotSignal = Boolean(snapshotContent)
      || Boolean(snapshotToolName)
      || snapshotToolCalls.length > 0
      || hasStatusSignal;
    if (!hasLiveSnapshotSignal && hasMaintenanceSignal) {
      applyCompactionSnapshotState(snapshot.compactionPhase);
      return true;
    }
    const shouldHydrateLiveState = hasLiveSnapshotSignal
      || Boolean(streamingAssistantIdRef.current);
    if (!shouldHydrateLiveState) {
      return false;
    }
    const shouldMaterializeBubble = Boolean(snapshotContent) || Boolean(snapshotToolName) || Boolean(streamingAssistantIdRef.current);

    isStreamActiveRef.current = true;
    suppressLiveBubbleContentRef.current = true;
    setIsRunning(true);
    setStreamingPhase(resumePhase);
    setActiveToolName(snapshotToolName || null);
    const liveStatusText = isMaintenanceStatusOnly ? '' : (rawStatusText || '');
    const compactionStatusText = hasLiveSnapshotSignal && snapshot.compactionPhase === 'compacting'
      ? (liveStatusText || 'Compacting context…')
      : hasLiveSnapshotSignal && snapshot.compactionPhase === 'compacted'
        ? (liveStatusText || 'Context compacted')
        : '';
    setStatusText(snapshotToolName
      ? getToolStatusText(snapshotToolName)
      : (liveStatusText || compactionStatusText || 'Reconnecting to stream…'));
    setConnectionNotice(null);

    applyCompactionSnapshotState(snapshot.compactionPhase);

    const assistantId = shouldMaterializeBubble ? ensureStreamingAssistant(snapshotContent || undefined) : null;
    resumeSeededContentRef.current = shouldMaterializeBubble && resumePhase === 'streaming' && snapshotContent.length > 0;
    assembledRef.current = snapshotContent;
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = snapshotContent.length;

    if (assistantId && (snapshot.model || snapshot.provenance || snapshotToolCalls.length > 0)) {
      const normalizedModel = canonicalizePortalModelId(String(snapshot.model || ''));
      const normalizedProvenance = typeof snapshot.provenance === 'string' ? snapshot.provenance : undefined;
      setMessages(prev => prev.map(m => (
        m.id === assistantId
          ? {
              ...m,
              model: normalizedModel || m.model,
              provenance: normalizedProvenance || m.provenance,
              toolCalls: snapshotToolCalls.length > 0 ? snapshotToolCalls : (m.toolCalls || []),
            }
          : m
      )));
    }

    resetWatchdog();
    return true;
  }, [applyCompactionSnapshotState, ensureStreamingAssistant, isStaleSessionLoad, resetWatchdog]);

  const loadHistorySnapshot = useCallback(async (
    session: string,
    options: { expectedGen?: number } = {},
  ) => {
    const expectedGen = options.expectedGen ?? historyGenRef.current;
    const provider = providerRef.current;
    const expectedProjectId = projectIdentityIdRef.current;
    const portalData = await projectsAPI.chatHistory(projectName, provider, {
      limit: PROJECT_CHAT_HISTORY_PAGE_SIZE,
    });

    if (
      isStaleSessionLoad(session, expectedGen)
      || providerRef.current !== provider
      || projectIdentityIdRef.current !== expectedProjectId
    ) return null;
    assertProjectChatHistoryIdentity(portalData, expectedProjectId);

    const portalMessages = Array.isArray(portalData?.messages) ? portalData.messages : [];
    const pending = pendingSendRef.current;
    if (pending && await historyConfirmsPendingProjectChatSend(pending, portalMessages)) {
      await confirmPendingSend(pending.messageId);
    }
    const loaded = parseProjectChatHistoryMessages(
      portalMessages,
      provider,
      runtimeRef.current,
    );
    const pagination = portalData?.pagination;
    setHistoryPagination({
      hasMore: pagination?.hasMore === true && typeof pagination?.nextCursor === 'string',
      nextCursor: typeof pagination?.nextCursor === 'string' ? pagination.nextCursor : null,
    });
    setOlderHistoryError(null);
    setMessages(prev => {
      const next = loaded;

      const historyUserContent = new Set(
        next
          .filter(message => message.role === 'user')
          .map(message => String(message.content || '').trim())
          .filter(Boolean)
      );
      const liveAssistantId = streamingAssistantIdRef.current;
      const activeLocalMessages = prev.filter(message => {
        if (isStreamActiveRef.current && liveAssistantId && message.id === liveAssistantId) return true;
        if (message.role !== 'user') return false;
        const content = String(message.content || '').trim();
        return Boolean(content) && !historyUserContent.has(content);
      });

      return activeLocalMessages.length > 0 ? dedupeHistoryMessages([...next, ...activeLocalMessages]) : next;
    });
    setHistoryError(null);
    setSessionError(null);

    return { messages: loaded };
  }, [confirmPendingSend, isStaleSessionLoad, projectName]);

  const retryHistorySnapshot = useCallback(async () => {
    const expectedGen = historyGenRef.current;
    const expectedSession = sessionKeyRef.current || '';
    setHistoryRetryPending(true);
    setIsLoadingHistory(true);
    try {
      await loadHistorySnapshot(expectedSession, { expectedGen });
    } catch (error: any) {
      if (
        historyGenRef.current === expectedGen
        && (sessionKeyRef.current || '') === expectedSession
      ) {
        setHistoryError(projectChatHistoryErrorDetail(error));
      }
    } finally {
      if (historyGenRef.current === expectedGen) {
        setHistoryRetryPending(false);
        setIsLoadingHistory(false);
      }
    }
  }, [loadHistorySnapshot]);

  const loadOlderHistory = useCallback(async () => {
    if (
      olderHistoryLoadInFlightRef.current
      || !historyPagination.hasMore
      || !historyPagination.nextCursor
    ) return;

    const expectedGen = historyGenRef.current;
    const expectedSession = sessionKeyRef.current || '';
    const expectedProvider = providerRef.current;
    const expectedProjectId = projectIdentityIdRef.current;
    const cursor = historyPagination.nextCursor;
    const container = scrollRef.current;
    if (container) {
      messageRevealAnchorRef.current = {
        sessionKey: messageWindowSessionKey,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }

    olderHistoryLoadInFlightRef.current = true;
    setIsLoadingOlderHistory(true);
    setOlderHistoryError(null);
    try {
      const page = await projectsAPI.chatHistory(projectName, expectedProvider, {
        limit: PROJECT_CHAT_HISTORY_PAGE_SIZE,
        before: cursor,
      });
      if (
        historyGenRef.current !== expectedGen
        || (sessionKeyRef.current || '') !== expectedSession
        || providerRef.current !== expectedProvider
        || projectIdentityIdRef.current !== expectedProjectId
      ) return;
      assertProjectChatHistoryIdentity(page, expectedProjectId);

      const olderPortalMessages = Array.isArray(page?.messages) ? page.messages : [];
      const pending = pendingSendRef.current;
      if (pending && await historyConfirmsPendingProjectChatSend(pending, olderPortalMessages)) {
        await confirmPendingSend(pending.messageId);
      }
      const older = parseProjectChatHistoryMessages(
        olderPortalMessages,
        expectedProvider,
        runtimeRef.current,
      );
      setMessages((current) => mergeProjectChatHistoryPages(older, current));
      if (older.length > 0) {
        setRevealedEarlierMessages((current) => current + older.length);
      } else {
        messageRevealAnchorRef.current = null;
      }
      setHistoryPagination({
        hasMore: page?.pagination?.hasMore === true
          && typeof page?.pagination?.nextCursor === 'string',
        nextCursor: typeof page?.pagination?.nextCursor === 'string'
          ? page.pagination.nextCursor
          : null,
      });
    } catch (error: any) {
      messageRevealAnchorRef.current = null;
      setOlderHistoryError(
        String(error?.response?.data?.error || error?.message || 'Earlier Project Chat history could not be loaded.'),
      );
    } finally {
      olderHistoryLoadInFlightRef.current = false;
      if (
        historyGenRef.current === expectedGen
        && (sessionKeyRef.current || '') === expectedSession
        && providerRef.current === expectedProvider
        && projectIdentityIdRef.current === expectedProjectId
      ) {
        setIsLoadingOlderHistory(false);
      }
    }
  }, [
    historyPagination.hasMore,
    historyPagination.nextCursor,
    messageWindowSessionKey,
    confirmPendingSend,
    projectName,
  ]);

  useEffect(() => {
    loadOlderHistoryRef.current = () => { void loadOlderHistory(); };
  }, [loadOlderHistory]);

  const clearResumeSeededContent = useCallback((assistantId?: string | null) => {
    if (!resumeSeededContentRef.current) return;
    flushPendingLiveRenders();
    resumeSeededContentRef.current = false;
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    const cid = assistantId || streamingAssistantIdRef.current;
    if (cid) {
      setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: '' } : m));
    }
  }, [flushPendingLiveRenders]);

  const finalizeStreamingAssistant = useCallback(() => {
    flushPendingLiveRenders();
    const cid = streamingAssistantIdRef.current;
    const finalContent = assembledRef.current.substring(lastSegmentStartRef.current) || assembledRef.current || '';
    if (cid) {
      if (finalContent) {
        setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: finalContent } : m));
      } else {
        setMessages(prev => prev.filter(m => m.id !== cid));
      }
    }
    setStatusText(null);
    setStreamingPhase('idle');
    setActiveToolName(null);
    setIsRunning(false);
    if (compactionPhaseRef.current === 'compacting') {
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      if (compactionTimerRef.current) {
        clearTimeout(compactionTimerRef.current);
        compactionTimerRef.current = null;
      }
    }
    isStreamActiveRef.current = false;
    thinkingContentRef.current = '';
    setThinkingContent('');
    thinkingSubjectRef.current = '';
    setThinkingSubject('');
    resumeSeededContentRef.current = false;
    suppressLiveBubbleContentRef.current = false;
    streamingAssistantIdRef.current = null;
  }, [flushPendingLiveRenders]);

  const appendThinkingChunk = useCallback((assistantId: string | null, chunk: string, opts?: { replace?: boolean }) => {
    if (!chunk) return;
    const nextThinking = mergeThinkingStream(thinkingContentRef.current, chunk, opts);
    thinkingContentRef.current = nextThinking;
    scheduleThinkingRender(assistantId, nextThinking);
  }, [scheduleThinkingRender]);

  const graduateLiveThinkingPhase = useCallback((assistantId?: string | null) => {
    flushPendingLiveRenders();
    const text = thinkingContentRef.current;
    const subject = thinkingSubjectRef.current;
    if (!text.trim() && !subject) return false;
    const targetId = assistantId || streamingAssistantIdRef.current;
    if (targetId) {
      const ts = Date.now();
      setMessages((previous) => previous.map((message) => (
        message.id === targetId
          ? {
              ...message,
              segments: [
                ...(message.segments || []),
                {
                  text,
                  ...(subject ? { subject } : {}),
                  kind: 'thinking',
                  position: 'after',
                  ts,
                },
              ],
            }
          : message
      )));
    }
    thinkingContentRef.current = '';
    setThinkingContent('');
    thinkingSubjectRef.current = '';
    setThinkingSubject('');
    return true;
  }, [flushPendingLiveRenders]);

  const applyLiveThinkingSubject = useCallback((
    assistantId: string | null,
    rawSubject: unknown,
  ) => {
    const subject = sanitizeThinkingSubject(rawSubject);
    if (!subject) return '';
    if (
      subject !== thinkingSubjectRef.current
      && (thinkingContentRef.current.trim() || thinkingSubjectRef.current)
    ) {
      graduateLiveThinkingPhase(assistantId);
    }
    thinkingSubjectRef.current = subject;
    setThinkingSubject(subject);
    if (assistantId) {
      setMessages((previous) => previous.map((message) => (
        message.id === assistantId
          ? { ...message, thinkingSubject: subject }
          : message
      )));
    }
    return subject;
  }, [graduateLiveThinkingPhase]);

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'allow-once' | 'deny' | 'allow-always',
  ) => {
    try {
      const response = await client.post('/gateway/exec-approval/resolve', { approvalId, decision });
      if (response.data?.ok) {
        setPendingApprovals((prev) => removeExecApproval(prev, approvalId));
        setStatusText(decision === 'deny' ? '❌ Command denied' : '✅ Command approved');
        setTimeout(() => setStatusText(null), 2000);
        return;
      }
      setStatusText('⚠️ Approval did not complete');
      setTimeout(() => setStatusText(null), 3000);
      throw new Error('Approval did not complete');
    } catch (err: any) {
      console.error('[ProjectChatPanel] Failed to resolve approval:', err);
      setStatusText(`⚠️ Approval failed${err?.response?.data?.error ? `: ${err.response.data.error}` : ''}`);
      setTimeout(() => setStatusText(null), 4000);
      throw err;
    }
  }, []);

  const dismissApproval = useCallback((approvalId?: string) => {
    setPendingApprovals((prev) => {
      if (!prev.length) return prev;
      return approvalId ? removeExecApproval(prev, approvalId) : prev.slice(1);
    });
  }, []);

  useEffect(() => {
    if (!pendingApprovals.length) return;

    const pruneExpired = () => {
      setPendingApprovals((prev) => pruneExpiredExecApprovals(prev));
    };

    pruneExpired();
    const interval = setInterval(pruneExpired, 500);
    return () => clearInterval(interval);
  }, [pendingApprovals.length]);

  // ── Durable replay event handler ──
  const handleReplayEvent = useCallback((rawData: any) => {
    const data = normalizePortalStreamEventFromTurnEvent(rawData);
    setTransportConnected(true);
    setConnectionNotice(null);
    const passthrough = ['connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_status', 'stream_ended', 'run_resumed', 'exec_approval', 'exec_approval_resolved'];
    const autoCreateBubbleTypes = ['text', 'thinking', 'tool_start', 'tool_update', 'tool_end', 'tool_used', 'toolCall', 'toolResult', 'segment_break'];
    const waitForVisibleStreamTypes = ['status', 'thinking', 'done', 'error'];
    if (!streamingAssistantIdRef.current && data.type === 'text' && typeof data.content === 'string' && isControlOrMaintenanceAssistantContent(data.content)) {
      return;
    }
    if (!streamingAssistantIdRef.current && !passthrough.includes(data.type)) {
      if (autoCreateBubbleTypes.includes(data.type)) {
        ensureStreamingAssistant();
        isStreamActiveRef.current = true;
        setIsRunning(true);
      } else if (!waitForVisibleStreamTypes.includes(data.type)) {
        return;
      }
    }
    const assistantId = streamingAssistantIdRef.current;
    if (assistantId || isStreamActiveRef.current) resetWatchdog();

    switch (data.type) {
      case 'session': {
        const normalizedModel = canonicalizePortalModelId(String(data.model || ''));
        const normalizedProvenance = typeof data.provenance === 'string' ? data.provenance : undefined;
        if (normalizedModel) {
          setSelectedModel(prev => prev === normalizedModel ? prev : normalizedModel);
        }
        if (assistantId && (normalizedModel || normalizedProvenance)) {
          setMessages(prev => prev.map(m => (
            m.id === assistantId
              ? {
                  ...m,
                  model: normalizedModel || m.model,
                  provenance: normalizedProvenance || m.provenance,
                }
              : m
          )));
        }
        break;
      }
      case 'status': {
        const maintenanceRail = resolveMaintenanceRailStatus(data);
        if (maintenanceRail.update) {
          applyMaintenanceState(maintenanceRail.update);
        }

        if (!assistantId && !isStreamActiveRef.current) break;
        clearResumeSeededContent(assistantId);
        setStatusText(maintenanceRail.displayStatusText);
        if (activeToolName) setStreamingPhase('tool');
        else if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'thinking': {
        if (!assistantId && !isStreamActiveRef.current) break;
        clearResumeSeededContent(assistantId);
        applyLiveThinkingSubject(assistantId, data.subject);
        appendThinkingChunk(
          assistantId,
          extractThinkingChunk('thinking', data.content, assembledRef.current.length > 0),
          { replace: data.replace === true },
        );
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'compaction_start': {
        applyMaintenanceState({
          phase: 'start',
          content: typeof data.content === 'string' ? data.content : null,
          maintenanceKind: 'compaction',
        });
        break;
      }
      case 'compaction_end': {
        const completed = data.completed !== false;
        const noticeText = typeof data.content === 'string' && data.content.trim()
          ? data.content
          : (completed ? 'Context compacted' : 'Context maintenance finished.');
        if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
        if (completed) {
          compactionPhaseRef.current = 'compacted';
          setCompactionPhase('compacted');
          appendSystemNotice(noticeText, 'compaction');
        } else {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
        }
        setStatusText(noticeText);
        compactionTimerRef.current = setTimeout(() => {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          setStatusText((prev) => (prev === noticeText ? null : prev));
          compactionTimerRef.current = null;
        }, 3000);
        break;
      }
      case 'tool_start': {
        clearResumeSeededContent(assistantId);
        hasRealToolEventsRef.current = true;
        graduateLiveThinkingPhase(assistantId);
        const toolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          lastSegmentStartRef.current = lastRawTextLenRef.current;
        }
        setStatusText(getToolStatusText(toolName));
        setStreamingPhase('tool');
        setActiveToolName(toolName);
        const toolId = typeof data.toolCallId === 'string' && data.toolCallId.trim()
          ? data.toolCallId.trim()
          : `tool-${String(data.runId || activeReplayTurnIdRef.current || 'run')}-${String(data.seq || ++toolCounterRef.current)}`;
        const toolArgs = data.toolArgs || undefined;
        setMessages(prev => appendToolCallToMessage(prev, assistantId, buildRunningToolCall({
          id: toolId,
          name: toolName,
          arguments: toolArgs,
        })).messages as ChatMessage[]);
        break;
      }
      case 'tool_update': {
        const toolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        const toolResult = data.toolResult || data.content || '';
        hasRealToolEventsRef.current = true;
        setStreamingPhase('tool');
        setActiveToolName(toolName);
        setStatusText(getToolStatusText(toolName));
        setMessages(prev => updateRunningToolCallInMessage(prev, assistantId, {
          toolCallId: data.toolCallId,
          toolName,
          result: typeof toolResult === 'string' ? toolResult : String(toolResult),
        }).messages as ChatMessage[]);
        break;
      }
      case 'tool_end': {
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        const toolResult = data.toolResult || data.content || 'Completed';
        let nextRunningToolName: string | null = null;
        setMessages(prev => {
          const projection = finishMatchingToolCallInMessage(prev, assistantId, {
            toolCallId: data.toolCallId,
            toolName: resolveToolName(data.toolName, data.name, data.content, 'tool'),
            result: String(toolResult),
            status: data.status,
          });
          nextRunningToolName = projection.nextRunningToolName ? resolveToolName(projection.nextRunningToolName) : null;
          return projection.messages as ChatMessage[];
        });
        if (nextRunningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(nextRunningToolName);
          setStatusText(getToolStatusText(nextRunningToolName));
        } else {
          setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
          setStatusText(null);
          setActiveToolName(null);
        }
        break;
      }
      case 'tool_used': {
        if (hasRealToolEventsRef.current) break;
        const tn = resolveToolName(data.toolName, data.name, data.content, 'tool');
        setMessages(prev => {
          const tid = 'tool-' + (++toolCounterRef.current);
          const now = Date.now();
          return appendCompletedToolCallIfMissing(prev, assistantId, buildCompletedToolCall({
            id: tid,
            name: tn,
            startedAt: now - 1000,
            endedAt: now,
          }), { now }).messages as ChatMessage[];
        });
        setStreamingPhase('tool');
        setActiveToolName(tn);
        setStatusText(getToolStatusText(tn));
        break;
      }
      case 'toolCall': {
        clearResumeSeededContent(assistantId);
        const tid = 'tool-' + (++toolCounterRef.current);
        setStreamingPhase('tool');
        const toolName = resolveToolName(data.toolName, data.name, 'tool');
        setActiveToolName(toolName);
        setStatusText(getToolStatusText(toolName));
        setMessages(prev => appendToolCallToMessage(prev, assistantId, buildRunningToolCall({
          id: data.id || tid,
          name: toolName,
          arguments: data.arguments,
        })).messages as ChatMessage[]);
        break;
      }
      case 'toolResult': {
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        const resolvedToolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        let nextRunningToolName: string | null = null;
        setMessages(prev => {
          const projection = finishMatchingToolCallInMessage(prev, assistantId, {
            toolCallId: data.toolCallId,
            toolName: resolvedToolName,
            result: typeof data.content === 'string' ? data.content : undefined,
            status: data.status,
          });
          nextRunningToolName = projection.nextRunningToolName ? resolveToolName(projection.nextRunningToolName) : null;
          return projection.messages as ChatMessage[];
        });
        if (nextRunningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(nextRunningToolName);
          setStatusText(getToolStatusText(nextRunningToolName));
        } else {
          setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
          setStatusText(null);
          setActiveToolName(null);
        }
        break;
      }
      case 'segment_break': {
        flushPendingLiveRenders();
        const ct = assembledRef.current.substring(lastSegmentStartRef.current);
        if (ct.trim()) {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: ct } : m));
        }
        const newId = nextId();
        streamingAssistantIdRef.current = newId;
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        setMessages(prev => [...prev, { id: newId, role: 'assistant' as const, content: '', createdAt: new Date() }]);
        break;
      }
      case 'text': {
        const rawChunk = typeof data.content === 'string' ? data.content : '';
        if (rawChunk && isControlOrMaintenanceAssistantContent(rawChunk)) {
          break;
        }
        const safeChunk = typeof data.content === 'string'
          ? (data.replace === true ? sanitizeAssistantContent(data.content) : sanitizeAssistantChunk(data.content))
          : '';
        const fullText = mergeAssistantStream(assembledRef.current, safeChunk, { replace: data.replace === true });
        lastRawTextLenRef.current = fullText.length;
        const st = fullText.substring(lastSegmentStartRef.current);

        resumeSeededContentRef.current = false;
        suppressLiveBubbleContentRef.current = false;
        assembledRef.current = fullText;
        setStatusText(null);
        setStreamingPhase('streaming');
        setActiveToolName(null);
        const cid = streamingAssistantIdRef.current;
        scheduleTextRender(cid, st);
        break;
      }
      case 'done': {
        clearWatchdog();
        flushPendingLiveRenders();
        const hadLiveThinking = graduateLiveThinkingPhase(assistantId);
        const fst = assembledRef.current.substring(lastSegmentStartRef.current);
        const rawFinal = typeof data.content === 'string' ? data.content : '';
        const hasFinal = rawFinal.length > 0 && !isControlOrMaintenanceAssistantContent(rawFinal);
        const finalText = hasFinal ? sanitizeAssistantContent(rawFinal) : fst;
        const fc = finalText || '';
        const prov = data.provenance || null;
        const model = canonicalizePortalModelId(
          typeof data?.metadata?.model === 'string'
            ? data.metadata.model
            : (typeof data?.model === 'string' ? data.model : '')
        );
        const cid = streamingAssistantIdRef.current;
        const shouldHideTurn = !fc.trim()
          && !hasRealToolEventsRef.current
          && !hadLiveThinking;
        setStatusText(null);
        setStreamingPhase('idle');
        setIsRunning(false);
        // Execution is terminal, but the durable assistant row may still be
        // committing. Keep a separate hydration retry alive after the live
        // poll state becomes idle.
        setTerminalHistoryPending(true);
        thinkingContentRef.current = '';
        setThinkingContent('');
        thinkingSubjectRef.current = '';
        setThinkingSubject('');
        setPendingApprovals([]);
        if (compactionPhaseRef.current === 'compacting') {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        }
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        resumeSeededContentRef.current = false;
        suppressLiveBubbleContentRef.current = false;
        if (cid) {
          if (shouldHideTurn) {
            setMessages(prev => prev.filter(m => m.id !== cid));
          } else {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: fc, provenance: prov || undefined, model: model || m.model } : m
            ));
          }
        }
        break;
      }
      case 'error': {
        flushPendingLiveRenders();
        graduateLiveThinkingPhase(assistantId);
        if (assistantId) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '⚠️ ' + (data.content || 'Unknown error') } : m
          ));
        }
        setStatusText(null);
        setStreamingPhase('idle');
        thinkingContentRef.current = '';
        setThinkingContent('');
        thinkingSubjectRef.current = '';
        setThinkingSubject('');
        setIsRunning(false);
        setTerminalHistoryPending(true);
        setPendingApprovals([]);
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        resumeSeededContentRef.current = false;
        suppressLiveBubbleContentRef.current = false;
        break;
      }
      case 'exec_approval': {
        const approval = data.approval as ExecApprovalRequest;
        if (approval?.id) {
          setPendingApprovals((prev) => upsertExecApproval(prev, approval));
          setStatusText('⏳ Waiting for command approval…');
        }
        break;
      }
      case 'exec_approval_resolved': {
        const resolved = data.resolved;
        if (resolved?.id) {
          setPendingApprovals((prev) => removeExecApproval(prev, resolved.id));
        }
        break;
      }
      case 'stream_resume': {
        suppressLiveBubbleContentRef.current = true;
        const resumePhase = data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking';
        const resumeContent = typeof data.content === 'string' && !isControlOrMaintenanceAssistantContent(data.content)
          ? sanitizeAssistantContent(data.content)
          : '';
        const resumeToolName = resolveToolName(data.toolName, data.name, data.content);
        const shouldMaterializeBubble = Boolean(streamingAssistantIdRef.current) || Boolean(resumeToolName) || Boolean(resumeContent);
        if (!shouldMaterializeBubble) {
          break;
        }
        if (!streamingAssistantIdRef.current) {
          const resumeId = 'stream-resume-' + Date.now();
          streamingAssistantIdRef.current = resumeId;
          assembledRef.current = '';
          setMessages(prev => [...prev, { id: resumeId, role: 'assistant' as const, content: '', createdAt: new Date(), toolCalls: [] }]);
        }
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase(resumePhase);
        setActiveToolName(resumeToolName || null);
        setStatusText(resumeToolName ? getToolStatusText(resumeToolName) : null);
        if (resumePhase === 'streaming' && typeof data.content === 'string' && !isControlOrMaintenanceAssistantContent(data.content)) {
          resumeSeededContentRef.current = true;
          const safeChunk = sanitizeAssistantContent(data.content);
          const fullText = mergeAssistantStream(assembledRef.current, safeChunk, { replace: true });
          lastRawTextLenRef.current = fullText.length;
          const st = fullText.substring(lastSegmentStartRef.current);
          assembledRef.current = fullText;
          const cid = streamingAssistantIdRef.current;
          scheduleTextRender(cid, st);
        } else {
          resumeSeededContentRef.current = false;
        }
        break;
      }
      case 'connected':
        setTransportConnected(true);
        setConnectionNotice(null);
        break;
      case 'run_resumed': {
        if (!streamingAssistantIdRef.current) {
          break;
        }
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase(activeToolName ? 'tool' : 'thinking');
        setStatusText(activeToolName ? getToolStatusText(activeToolName) : '🧠 Agent is thinking…');
        resetWatchdog();
        break;
      }
      case 'stream_ended':
        setPendingApprovals([]);
        clearWatchdog();
        finalizeStreamingAssistant();
        break;
      case 'stream_status':
        if (data.active) {
          applyActiveStreamSnapshot(data, sessionKeyRef.current || '', historyGenRef.current);
          break;
        }
        if (isStreamActiveRef.current && (data.safeToClear === true || data.inactiveReason === 'terminal' || data.inactiveReason === 'stale')) {
          clearWatchdog();
          isStreamActiveRef.current = false;
          setIsRunning(false);
          setStreamingPhase('idle');
          setStatusText(null);
          thinkingContentRef.current = '';
          setThinkingContent('');
          thinkingSubjectRef.current = '';
          setThinkingSubject('');
          setPendingApprovals([]);
          setActiveToolName(null);
          streamingAssistantIdRef.current = null;
          resumeSeededContentRef.current = false;
          suppressLiveBubbleContentRef.current = false;
        }
        break;
      case 'keepalive':
        break;
    }
  }, [activeToolName, appendSystemNotice, applyActiveStreamSnapshot, applyLiveThinkingSubject, applyMaintenanceState, clearResumeSeededContent, resetWatchdog, clearWatchdog, appendThinkingChunk, ensureStreamingAssistant, finalizeStreamingAssistant, flushPendingLiveRenders, graduateLiveThinkingPhase, scheduleTextRender]);

  const handleReplayEventRef = useRef(handleReplayEvent);
  useEffect(() => { handleReplayEventRef.current = handleReplayEvent; }, [handleReplayEvent]);

  // ── Verify the provider session and restore its durable replay on mount ──
  useEffect(() => {
    let cancelled = false;
    clearPendingLiveRenders();
    thinkingContentRef.current = '';
    setThinkingContent('');
    const myGen = ++historyGenRef.current;
    olderHistoryLoadInFlightRef.current = false;
    messageRevealAnchorRef.current = null;
    setIsLoadingOlderHistory(false);
    setOlderHistoryError(null);
    setHistoryError(null);
    setHistoryRetryPending(false);
    setHistoryPagination({ hasMore: false, nextCursor: null });

    async function init() {
      let resolvedProviderState: ReturnType<typeof resolveProjectProviderCapabilities> | null = null;
      let sessionHandshakeCompleted = false;
      let initialHistoryLoad: Promise<{
        result: { messages: ChatMessage[] } | null;
        failed: boolean;
      }> | null = null;
      try {
        projectIdentityIdRef.current = null;
        setProjectIdentityId(null);
        providerVerificationStateRef.current = 'verifying';
        setProviderVerificationState('verifying');
        providerTransitionPendingRef.current = true;
        setProviderTransitionPending(true);
        serverSelectedProviderRef.current = null;
        setServerSelectedProvider(null);
        const pendingCapabilities = buildUnavailableProjectProviderCapabilities(
          'Project provider verification is in progress. No provider can be selected or used yet.',
        );
        providerCapabilitiesRef.current = pendingCapabilities;
        setProviderCapabilities(pendingCapabilities);
        setIsLoadingHistory(true);
        setSessionReady(false);
        setSessionError(null);
        setProjectMoveNotice(null);
        setTransportConnected(false);
        setConnectionNotice('Checking Project Chat providers…');

        let capabilityData = await projectsAPI.projectChatProviders(projectName);
        if (capabilityData?.migration?.required === true) {
          const { projectId, title, message } = capabilityData.migration;
          if (!projectId?.trim() || !title?.trim() || !message?.trim()) {
            throw new Error('Portal returned an incomplete project move instruction.');
          }
          if (cancelled || historyGenRef.current !== myGen) return;
          setProjectMoveNotice({ projectId, title, message });
          providerVerificationStateRef.current = 'failed';
          setProviderVerificationState('failed');
          providerTransitionPendingRef.current = false;
          setProviderTransitionPending(false);
          setConnectionNotice(null);
          setIsLoadingHistory(false);
          return;
        }
        const runtimeTransitionDeadline = Date.now() + (5 * 60_000);
        let runtimeTransitionAttempt = 0;
        while (
          capabilityData?.coordination?.runtimeTransitionActive === true
          && !capabilityData?.coordination?.activeTurn
        ) {
          if (cancelled || historyGenRef.current !== myGen) return;
          setConnectionNotice('Another tab is preparing the project runtime — waiting for it to finish…');
          if (Date.now() >= runtimeTransitionDeadline) {
            throw new Error('The project runtime transition did not finish before its admission lease expired.');
          }
          const retryDelay = Math.min(1_000, 100 + (runtimeTransitionAttempt * 100));
          runtimeTransitionAttempt += 1;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          if (cancelled || historyGenRef.current !== myGen) return;
          capabilityData = await projectsAPI.projectChatProviders(projectName);
        }
        if (cancelled || historyGenRef.current !== myGen) return;
        const verifiedProjectId = typeof capabilityData?.executionContext?.projectId === 'string'
          ? capabilityData.executionContext.projectId.trim()
          : '';
        if (
          capabilityData?.executionContext?.scope !== 'PROJECT_SANDBOX'
          || !verifiedProjectId
        ) {
          throw new Error('Portal did not return a verified immutable Project Chat identity.');
        }
        projectIdentityIdRef.current = verifiedProjectId;
        setProjectIdentityId(verifiedProjectId);
        setProviderQualifications(presentProjectProviderQualifications(capabilityData?.qualifications));
        setBoundProviders(
          Array.isArray(capabilityData?.bindings)
            ? capabilityData.bindings.map((entry: any) => String(entry?.provider || '')).filter(Boolean)
            : [],
        );
        const stateVersion = capabilityData?.coordination?.stateVersion;
        if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) {
          throw new Error('Portal did not return a valid Project Chat coordination version.');
        }
        projectChatStateVersionRef.current = stateVersion;
        setProjectChatStateVersion(stateVersion);
        resolvedProviderState = resolveProjectProviderCapabilities(capabilityData);
        providerCapabilitiesRef.current = resolvedProviderState.providers;
        setProviderCapabilities(resolvedProviderState.providers);
        if (!resolvedProviderState.activeProvider || !resolvedProviderState.activeCapability) {
          throw new Error(resolvedProviderState.error || 'Project provider verification failed');
        }
        const provider = resolvedProviderState.activeProvider;
        const providerCapability = resolvedProviderState.activeCapability;
        const activeTurn = capabilityData?.coordination?.activeTurn || null;
        if (
          activeTurn
          && (
            typeof activeTurn.id !== 'string'
            || !activeTurn.id.trim()
            || activeTurn.provider !== provider
          )
        ) {
          throw new Error('Portal returned an invalid active Project provider turn.');
        }
        activeReplayTurnIdRef.current = activeTurn?.id || null;
        serverSelectedProviderRef.current = provider;
        setServerSelectedProvider(provider);
        providerRef.current = provider;
        runtimeRef.current = providerCapability.runtime;
        setSelectedRuntime(providerCapability.runtime);
        // Adopting the provider selected by the server is presentation state,
        // not a request to start a second bootstrap. Provider transitions
        // explicitly advance providerRefreshNonce after the server accepts
        // them, so this effect must not depend on its own rendered provider.
        setSelectedProvider(provider);
        const providerModel = providerCapability.supportsModelSelection
          ? canonicalizePortalModelId(
              capabilityData?.qualifiedModels?.[provider as Exclude<ProjectChatProviderName, 'GROK'>]
              || capabilityData?.bindings?.find((entry) => entry.provider === provider)?.model
              || (
                provider !== 'OPENCLAW'
                  ? localStorage.getItem(`agent-model-${projectName}-${provider}`)
                  : ''
              ),
            )
          : '';
        if (providerModel) {
          modelRef.current = providerModel;
          setSelectedModel(providerModel);
        }
        // Render the Portal-owned transcript immediately: switching between
        // projects must feel instant. Reading is actor/project scoped and must
        // not depend on whether the selected runtime is currently qualified.
        // The sandbox handshake below gates only sending.
        initialHistoryLoad = loadHistorySnapshot(sessionKeyRef.current || '', { expectedGen: myGen })
          .then((result) => {
            if (!cancelled && historyGenRef.current === myGen) setIsLoadingHistory(false);
            return { result, failed: false };
          })
          .catch((error) => {
            if (!cancelled && historyGenRef.current === myGen) {
              setHistoryError(projectChatHistoryErrorDetail(error));
              setIsLoadingHistory(false);
            }
            return { result: null, failed: true };
          });

        if (resolvedProviderState.error) {
          providerVerificationStateRef.current = 'ready';
          setProviderVerificationState('ready');
          providerTransitionPendingRef.current = false;
          setProviderTransitionPending(false);
          setConnectionNotice(null);
          setQualificationProgress(null);
          // An unqualified lane is expected discovery state. Keep it read-only,
          // load its existing transcript, and leave preparation explicit.
          await initialHistoryLoad;
          if (cancelled || historyGenRef.current !== myGen) return;
          setSessionError(null);
          setIsLoadingHistory(false);
          return;
        }

        setConnectionNotice(`Connecting to ${providerCapability.displayName} project runtime…`);

        const { data } = activeTurn
          ? await client.get(`/projects/${encodeURIComponent(projectName)}/assistant/resume-session`, {
              params: { provider, turnId: activeTurn.id },
              _silent: true,
            } as any)
          : await client.post(
              `/projects/${encodeURIComponent(projectName)}/assistant/ensure-session`,
              {
                provider,
                stateVersion,
                // Automatic OpenClaw handshakes let the server reconcile its
                // exact-agent binding against the live catalog. Browser state
                // is never authoritative model-admission evidence.
                ...(provider !== 'OPENCLAW' && providerModel ? { model: providerModel } : {}),
              },
              { _silent: true } as any,
            );
        if (cancelled || historyGenRef.current !== myGen) return;
        if (data?.provider !== provider) {
          throw new Error(`Project session provider mismatch: expected ${provider}, received ${String(data?.provider || 'none')}`);
        }
        const verifiedResponseModel = resolveVerifiedProjectModelResponse(providerCapability, data);
        // A fresh ensure legitimately advances the coordination version. An
        // active-turn resume is read-only and returns that turn's unchanged
        // version. Either path may never regress.
        if (!Number.isSafeInteger(data?.stateVersion) || data.stateVersion < stateVersion) {
          throw new Error('Project Chat coordination changed while the provider session was being verified.');
        }
        projectChatStateVersionRef.current = data.stateVersion;
        setProjectChatStateVersion(data.stateVersion);
        sessionHandshakeCompleted = true;
        providerVerificationStateRef.current = 'ready';
        setProviderVerificationState('ready');

        const { sessionKey: sk, agentId: aid } = data;
        if (typeof sk !== 'string' || !sk.trim()) {
          throw new Error('Portal did not return the verified Project provider session.');
        }
        sessionKeyRef.current = sk;
        setSessionKey(sk);
        setAgentId(aid);
        if (data?.provider) {
          providerRef.current = data.provider;
          setSelectedProvider(data.provider);
        }
        if (data?.runtime) {
          runtimeRef.current = data.runtime;
          setSelectedRuntime(data.runtime);
        }
        if (verifiedResponseModel) {
          modelRef.current = verifiedResponseModel;
          setSelectedModel(verifiedResponseModel);
        }

        replayCursorRef.current = 0;
        const preloadedHistory = initialHistoryLoad
          ? await initialHistoryLoad
          : { result: null, failed: false };
        if (!preloadedHistory.result && !preloadedHistory.failed) {
          setIsLoadingHistory(true);
          try {
            await loadHistorySnapshot(sk, { expectedGen: myGen });
          } catch (error: any) {
            if (!cancelled && historyGenRef.current === myGen) {
              setHistoryError(projectChatHistoryErrorDetail(error));
              setIsLoadingHistory(false);
            }
          }
        }
        if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) return;

        const replaySnapshot = await projectsAPI.agentPoll(
          projectName,
          0,
          0,
          provider,
          activeReplayTurnIdRef.current,
        );
        if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) return;
        const replayBatch = resolveProjectReplayBatch(replaySnapshot, {
          provider,
          sessionKey: sk,
          minimumStateVersion: data.stateVersion,
          afterSeq: 0,
          turnId: activeReplayTurnIdRef.current,
        });
        if (replayBatch.sessionKey !== sk) {
          sessionKeyRef.current = replayBatch.sessionKey;
          setSessionKey(replayBatch.sessionKey);
        }
        // Replay reads may observe a version legitimately advanced by any
        // interim admission; only a REGRESSION is a contract violation.
        if (!activeReplayTurnIdRef.current && replayBatch.stateVersion < data.stateVersion) {
          throw new ProjectReplayContractError('Project Chat coordination changed while replay was being restored.');
        }
        projectChatStateVersionRef.current = replayBatch.stateVersion;
        setProjectChatStateVersion(replayBatch.stateVersion);

        const replayActive = Boolean(replaySnapshot?.active || replaySnapshot?.isProcessing);
        const terminalEvent = replayBatch.events.find(
          (event) => event?.type === 'done' || event?.type === 'error',
        );
        if (terminalEvent && terminalEvent.seq !== replaySnapshot.lineCount) {
          throw new ProjectReplayContractError('Project replay returned events after a terminal event.');
        }
        const deferredTerminal = replayActive ? terminalEvent : undefined;
        const replayEvents = deferredTerminal
          ? replayBatch.events.filter((event) => event.seq < deferredTerminal.seq)
          : replayBatch.events;
        const projectedCursor = deferredTerminal
          ? deferredTerminal.seq - 1
          : replayBatch.nextCursor;
        if (replayActive) {
          ensureStreamingAssistant();
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase('thinking');
          for (const event of replayEvents) {
            handleReplayEventRef.current({ ...event, sessionKey: replayBatch.sessionKey });
          }
          replayCursorRef.current = projectedCursor;
          const replayCaughtUp = projectedCursor === replaySnapshot.lineCount;
          if (replayCaughtUp && !assembledRef.current && typeof replaySnapshot?.text === 'string' && replaySnapshot.text) {
            handleReplayEventRef.current({
              type: 'text',
              content: replaySnapshot.text,
              replace: true,
              sessionKey: replayBatch.sessionKey,
            });
          }
          if (isStreamActiveRef.current) resetWatchdog();
        } else if (replaySnapshot?.complete) {
          replayCursorRef.current = projectedCursor;
          setTerminalHistoryPending(true);
          await loadHistorySnapshot(sk, { expectedGen: myGen });
          if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) return;
          setTerminalHistoryPending(false);
        } else {
          replayCursorRef.current = projectedCursor;
        }

        setTransportConnected(true);
        setConnectionNotice(null);
        setSessionReady(true);
        setQualificationProgress(null);
        providerTransitionPendingRef.current = false;
        setProviderTransitionPending(false);
        setIsLoadingHistory(false);
      } catch (err: any) {
        if (!cancelled && historyGenRef.current === myGen) {
          const reason = String(err?.response?.data?.error || err?.message || 'Failed to initialize session');
          const providerDiscoveryFailure = (
            !resolvedProviderState
            || !resolvedProviderState.activeProvider
          );
          const readinessFailure = (
            err instanceof ProjectReplayContractError
            || isProjectProviderReverificationError(err)
            || providerDiscoveryFailure
          );
          const displayReason = providerDiscoveryFailure
            ? reason
            : readinessFailure
              ? 'Project Chat could not prepare its current provider. Retry preparation for this project.'
              : reason;
          if (readinessFailure) {
            activeReplayTurnIdRef.current = null;
            const failedCapabilities = buildUnavailableProjectProviderCapabilities(
              'Project provider preparation did not complete.',
            );
            providerCapabilitiesRef.current = failedCapabilities;
            setProviderCapabilities(failedCapabilities);
            serverSelectedProviderRef.current = null;
            setServerSelectedProvider(null);
            providerVerificationStateRef.current = 'failed';
            setProviderVerificationState('failed');
          } else if (!sessionHandshakeCompleted && resolvedProviderState?.activeProvider) {
            const failedCapabilities = resolvedProviderState!.providers.map((capability) => (
              capability.provider === resolvedProviderState!.activeProvider
                ? {
                    ...capability,
                    selectable: false,
                    executionScope: null,
                    reason: `Session verification failed: ${displayReason}`,
                  } as ProjectChatProviderCapability
                : capability
            ));
            providerCapabilitiesRef.current = failedCapabilities;
            setProviderCapabilities(failedCapabilities);
            providerVerificationStateRef.current = 'ready';
            setProviderVerificationState('ready');
          }
          providerTransitionPendingRef.current = false;
          setProviderTransitionPending(false);
          setConnectionNotice(null);
          setQualificationProgress(null);
          setSessionError(displayReason);
          setIsLoadingHistory(false);
          restoreQueuedComposerDraft();
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      clearPendingLiveRenders();
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    };
  }, [clearPendingLiveRenders, ensureStreamingAssistant, loadHistorySnapshot, projectName, providerRefreshNonce, resetWatchdog, restoreQueuedComposerDraft, setSessionReady]);

  // Every qualified Project provider replays through the Portal-owned broker.
  // The cursor advances only through events actually projected, so bounded
  // replay pages remain gap-free across long turns and browser refreshes.
  useEffect(() => {
    if (!sessionReady || (!isRunning && !terminalHistoryPending)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollInFlight = false;
    let wakeRequested = false;
    let pollBlockedUntil = 0;
    const provider = serverSelectedProviderRef.current;
    const initialVerifiedSession = sessionKeyRef.current;
    const expectedTurnId = activeReplayTurnIdRef.current;
    const expectedGen = historyGenRef.current;

    const failClosed = (reason: string) => {
      if (cancelled || historyGenRef.current !== expectedGen) return;
      const failedCapabilities = buildUnavailableProjectProviderCapabilities(
        `Project provider selection must be re-verified: ${reason}`,
      );
      providerCapabilitiesRef.current = failedCapabilities;
      setProviderCapabilities(failedCapabilities);
      serverSelectedProviderRef.current = null;
      setServerSelectedProvider(null);
      providerVerificationStateRef.current = 'failed';
      setProviderVerificationState('failed');
      providerTransitionPendingRef.current = false;
      setProviderTransitionPending(false);
      setSessionReady(false);
      setTransportConnected(false);
      setConnectionNotice(null);
      setSessionError(reason);
      clearWatchdog();
      activeReplayTurnIdRef.current = null;
      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setActiveToolName(null);
      setPendingApprovals([]);
    };

    if (
      !provider
      || provider !== selectedProvider
      || providerRef.current !== provider
      || providerVerificationStateRef.current !== 'ready'
      || typeof initialVerifiedSession !== 'string'
      || !initialVerifiedSession.trim()
    ) {
      failClosed('The active Project provider session is no longer verified.');
      return;
    }
    let verifiedSession = initialVerifiedSession;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      const effectiveDelay = Math.max(0, delay, pollBlockedUntil - Date.now());
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, effectiveDelay);
    };

    const requestImmediatePoll = () => {
      if (cancelled) return;
      if (pollInFlight) {
        wakeRequested = true;
        return;
      }
      schedule(0);
    };

    const poll = async () => {
      if (cancelled) return;
      if (pollInFlight) {
        wakeRequested = true;
        return;
      }
      pollInFlight = true;
      try {
        const afterSeq = replayCursorRef.current;
        const minimumStateVersion = projectChatStateVersionRef.current;
        if (typeof minimumStateVersion !== 'number' || !Number.isSafeInteger(minimumStateVersion) || minimumStateVersion < 0) {
          throw new ProjectReplayContractError('Project replay coordination state is no longer verified.');
        }
        const snapshot = await projectsAPI.agentPoll(
          projectName,
          afterSeq,
          0,
          provider,
          expectedTurnId,
        );
        pollBlockedUntil = 0;
        if (
          cancelled
          || historyGenRef.current !== expectedGen
          || providerRef.current !== provider
          || serverSelectedProviderRef.current !== provider
          || sessionKeyRef.current !== verifiedSession
          || activeReplayTurnIdRef.current !== expectedTurnId
        ) return;

        const replayBatch = resolveProjectReplayBatch(snapshot, {
          provider,
          sessionKey: verifiedSession,
          minimumStateVersion,
          afterSeq,
          turnId: expectedTurnId,
        });
        const replayActive = Boolean(snapshot?.active || snapshot?.isProcessing);
        if (replayActive && !expectedTurnId) {
          throw new ProjectReplayContractError('Project replay returned an unverified active turn.');
        }
        if (replayBatch.sessionKey !== verifiedSession) {
          verifiedSession = replayBatch.sessionKey;
          sessionKeyRef.current = verifiedSession;
          setSessionKey(verifiedSession);
        }
        const terminalEvent = replayBatch.events.find(
          (event: any) => event?.type === 'done' || event?.type === 'error',
        );
        if (terminalEvent && terminalEvent.seq !== snapshot.lineCount) {
          throw new ProjectReplayContractError('Project replay returned events after a terminal event.');
        }
        const deferredTerminal = replayActive ? terminalEvent : undefined;
        const replayEvents = deferredTerminal
          ? replayBatch.events.filter((event: any) => event.seq < deferredTerminal.seq)
          : replayBatch.events;
        const projectedCursor = deferredTerminal
          ? deferredTerminal.seq - 1
          : replayBatch.nextCursor;

        projectChatStateVersionRef.current = replayBatch.stateVersion;
        setProjectChatStateVersion(replayBatch.stateVersion);
        if (snapshot?.runtime) {
          runtimeRef.current = snapshot.runtime;
          setSelectedRuntime(snapshot.runtime);
        }

        if (replayActive && !streamingAssistantIdRef.current) {
          ensureStreamingAssistant();
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase('thinking');
        }
        for (const event of replayEvents) {
          handleReplayEventRef.current({ ...event, sessionKey: verifiedSession });
        }
        replayCursorRef.current = projectedCursor;

        setTransportConnected(true);
        setConnectionNotice(null);
        const replayCaughtUp = projectedCursor === snapshot.lineCount;
        if (replayActive) {
          if (replayCaughtUp && !assembledRef.current && typeof snapshot?.text === 'string' && snapshot.text) {
            handleReplayEventRef.current({
              type: 'text',
              content: snapshot.text,
              replace: true,
              sessionKey: verifiedSession,
            });
          }
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
          resetWatchdog();
          schedule(getProjectReplayPollDelay({
            visibility: document.visibilityState,
            replayCaughtUp,
            active: true,
            deferredTerminal: Boolean(deferredTerminal),
          }));
          return;
        }

        if (!replayCaughtUp) {
          schedule(getProjectReplayPollDelay({
            visibility: document.visibilityState,
            replayCaughtUp: false,
          }));
          return;
        }

        if (snapshot?.complete && !terminalEvent && isStreamActiveRef.current) {
          handleReplayEventRef.current({
            type: snapshot?.status === 'error' ? 'error' : 'done',
            content: snapshot?.error || snapshot?.text || '',
            sessionKey: verifiedSession,
          });
        }

        if (snapshot?.complete) {
          await loadHistorySnapshot(verifiedSession, { expectedGen });
          if (!cancelled && historyGenRef.current === expectedGen) {
            // Finalize the turn locally and stay ready for the next message —
            // like Agent Chat. A completed turn does NOT invalidate the
            // verified provider/session, so DON'T tear down and re-verify
            // (that dropped the connection after every single message).
            activeReplayTurnIdRef.current = null;
            isStreamActiveRef.current = false;
            setIsRunning(false);
            setStreamingPhase('idle');
            setStatusText(null);
            setActiveToolName(null);
            clearWatchdog();
            setTransportConnected(true);
            setConnectionNotice(null);
            setTerminalHistoryPending(false);
          }
          return;
        }

        schedule(getProjectReplayPollDelay({
          visibility: document.visibilityState,
          replayCaughtUp: true,
          active: false,
        }));
      } catch (error: any) {
        if (cancelled) return;
        const reason = error?.response?.data?.error || error?.message || 'Project replay verification failed';
        // A deleted project is a terminal, quiet state — not an error storm.
        if (error?.response?.status === 404 && /project not found/i.test(String(reason))) {
          setTransportConnected(false);
          setConnectionNotice(null);
          setSessionReady(false);
          setSessionError('This project was deleted.');
          return;
        }
        if (error instanceof ProjectReplayContractError || isProjectProviderReverificationError(error)) {
          failClosed(reason);
          return;
        }
        console.warn('[ProjectChat] Project replay poll failed:', error);
        setTransportConnected(false);
        const retryAfter = typeof error?.response?.headers?.get === 'function'
          ? error.response.headers.get('retry-after')
          : error?.response?.headers?.['retry-after'];
        const retryDelay = getProjectReplayPollDelay({
          visibility: document.visibilityState,
          failed: true,
          retryAfter,
        });
        if (error?.response?.status === 429) {
          pollBlockedUntil = Math.max(pollBlockedUntil, Date.now() + retryDelay);
          setConnectionNotice('Portal replay is rate limited — retrying when the polling window resets…');
        } else {
          setConnectionNotice('Portal replay connection interrupted — retrying…');
        }
        schedule(retryDelay);
      } finally {
        pollInFlight = false;
        if (wakeRequested && !cancelled) {
          wakeRequested = false;
          schedule(0);
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestImmediatePoll();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timer) clearTimeout(timer);
    };
  }, [clearWatchdog, ensureStreamingAssistant, isRunning, loadHistorySnapshot, projectName, replayRetryNonce, resetWatchdog, selectedProvider, sessionReady, setSessionReady, terminalHistoryPending]);

  // ── Send message ──
  const sendMessage = useCallback(async (text: string, draftText: string = text) => {
    const sk = sessionKeyRef.current;
    const provider = serverSelectedProviderRef.current;
    const requestStateVersion = projectChatStateVersionRef.current;
    const selectedCapability = provider
      ? providerCapabilitiesRef.current.find((entry) => entry.provider === provider) || null
      : null;
    if (
      !sk
      || !provider
      || providerVerificationStateRef.current !== 'ready'
      || providerTransitionPendingRef.current
      || providerRef.current !== provider
      || typeof requestStateVersion !== 'number'
      || !Number.isSafeInteger(requestStateVersion)
      || requestStateVersion < 0
      || selectedCapability?.selectable !== true
      || selectedCapability.executionScope !== 'PROJECT_SANDBOX'
      || isStreamActiveRef.current
      || sendPendingRef.current
    ) return false;

    const immutableProjectId = projectIdentityIdRef.current;
    if (!actorUserId || !immutableProjectId || pendingSendStorageError) return false;
    pendingQuestionComposerAnswerRef.current = null;
    pendingActiveSteerRef.current = null;
    pendingQuestionsReadyRef.current = false;
    setPendingQuestionAnswerPending(false);
    replacePendingQuestions([]);
    const scope: ProjectChatSendScope = {
      actorUserId,
      projectId: immutableProjectId,
      provider,
    };
    const requestModel = selectedCapability.supportsModelSelection
      ? resolveAvailableModelId(modelRef.current, availableModels)
      : '';
    sendPendingRef.current = true;
    setSessionReady(false);
    let verificationFailure = false;
    let stagedSend: PendingProjectChatSend | null = null;
    let acceptedData: any = null;
    let acceptedTurnId = '';
    let verifiedResponseModel = '';
    try {
      const coordinated = await runCoordinatedProjectChatSend({
        scope,
        draftText,
        payloadText: text,
        model: requestModel,
        classifyError: (error) => (
          isDefinitiveProjectSendRejection(error) ? 'never-admitted' : 'ambiguous'
        ),
        onStaged: (staged) => {
          const persistedPending: PendingProjectChatSend = {
            schema: staged.schema,
            actorUserId: staged.actorUserId,
            projectId: staged.projectId,
            provider: staged.provider,
            messageId: staged.messageId,
            draftFingerprint: staged.draftFingerprint,
            payloadFingerprint: staged.payloadFingerprint,
            model: staged.model,
            attemptStartedAt: staged.attemptStartedAt,
            createdAt: staged.createdAt,
          };
          stagedSend = persistedPending;
          rememberPendingSend(persistedPending);
        },
        dispatch: async (staged) => {
          const { data } = await client.post(
            `/projects/${encodeURIComponent(projectName)}/assistant/send`,
            {
              provider,
              stateVersion: requestStateVersion,
              message: staged.payloadText,
              messageId: staged.messageId,
              ...(selectedCapability.supportsModelSelection ? { model: staged.model } : {}),
            },
            { _silent: true } as any,
          );
          if (data?.provider !== provider) {
            throw new ProjectReplayContractError(
              `Project send provider mismatch: expected ${provider}, received ${String(data?.provider || 'none')}`,
            );
          }
          const responseProjectId = typeof data?.executionContext?.projectId === 'string'
            ? data.executionContext.projectId.trim()
            : '';
          if (responseProjectId !== immutableProjectId) {
            throw new ProjectReplayContractError('Project send returned a mismatched immutable project identity.');
          }
          const responseModel = resolveVerifiedProjectModelResponse(selectedCapability, data);
          if (
            !Number.isSafeInteger(data?.stateVersion)
            || data.stateVersion < requestStateVersion
          ) {
            throw new ProjectReplayContractError('Project send returned a missing or stale coordination version.');
          }
          const turnId = typeof data?.turnId === 'string' && data.turnId.trim()
            ? data.turnId
            : typeof data?.runId === 'string' && data.runId.trim()
              ? data.runId
              : '';
          if (!turnId) {
            throw new ProjectReplayContractError('Project send did not return a durable turn.');
          }
          if (typeof data?.sessionKey !== 'string' || !data.sessionKey.trim()) {
            throw new ProjectReplayContractError('Project send did not return a provider session.');
          }
          if (
            serverSelectedProviderRef.current !== provider
            || providerRef.current !== provider
            || sessionKeyRef.current !== sk
            || projectIdentityIdRef.current !== immutableProjectId
          ) {
            throw new ProjectReplayContractError('Project provider verification changed while the message was being sent.');
          }
          return { data, turnId, responseModel };
        },
      });
      stagedSend = coordinated.staged;
      if (coordinated.confirmedBeforeDispatch) {
        refreshPendingSendState(scope);
        sendPendingRef.current = false;
        setSessionReady(true);
        setSessionError(null);
        await loadHistorySnapshot(sk);
        return true;
      }
      acceptedData = coordinated.value.data;
      acceptedTurnId = coordinated.value.turnId;
      verifiedResponseModel = coordinated.value.responseModel;
      refreshPendingSendState(scope);
      if (acceptedData?.runtime) {
        runtimeRef.current = acceptedData.runtime;
        setSelectedRuntime(acceptedData.runtime);
      }
      if (verifiedResponseModel) {
        modelRef.current = verifiedResponseModel;
        setSelectedModel(verifiedResponseModel);
      }
      projectChatStateVersionRef.current = acceptedData.stateVersion;
      setProjectChatStateVersion(acceptedData.stateVersion);
      activeReplayTurnIdRef.current = acceptedTurnId;
      if (acceptedData.sessionKey !== sk) {
        sessionKeyRef.current = acceptedData.sessionKey;
        setSessionKey(acceptedData.sessionKey);
      }
      replayCursorRef.current = 0;
    } catch (error: any) {
      const reason = error?.response?.data?.error || error?.message || 'Failed to send project message';
      refreshPendingSendState(scope);
      verificationFailure = error instanceof ProjectReplayContractError
        || isProjectProviderReverificationError(error);
      if (verificationFailure) {
        activeReplayTurnIdRef.current = null;
        const failedCapabilities = buildUnavailableProjectProviderCapabilities(
          `Project provider selection must be re-verified: ${reason}`,
        );
        providerCapabilitiesRef.current = failedCapabilities;
        setProviderCapabilities(failedCapabilities);
        serverSelectedProviderRef.current = null;
        setServerSelectedProvider(null);
        providerVerificationStateRef.current = 'failed';
        setProviderVerificationState('failed');
        providerTransitionPendingRef.current = false;
        setProviderTransitionPending(false);
        setTransportConnected(false);
      }
      setSessionError(reason);
      sendPendingRef.current = false;
      setSessionReady(!verificationFailure);
      return false;
    }
    if (!stagedSend) {
      sendPendingRef.current = false;
      setSessionReady(false);
      setSessionError('Project Chat did not preserve a delivery identity.');
      return false;
    }
    const userMsg: ChatMessage = {
      id: stagedSend.messageId,
      role: 'user',
      content: text,
      createdAt: new Date(),
    };
    sendPendingRef.current = false;
    setSessionReady(true);
    setSessionError(null);

    setMessages(prev => [...prev, userMsg]);

    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    resumeSeededContentRef.current = false;
    suppressLiveBubbleContentRef.current = false;
    clearPendingLiveRenders();
    thinkingContentRef.current = '';
    setThinkingContent('');
    thinkingSubjectRef.current = '';
    setThinkingSubject('');
    setStatusText(null);
    setStreamingPhase('thinking');
    setActiveToolName(null);

    const assistantMsgId = nextId();
    streamingAssistantIdRef.current = assistantMsgId;
    setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant' as const, content: '', createdAt: new Date() }]);
    setIsRunning(true);
    isStreamActiveRef.current = true;
    resetWatchdog();
    setTransportConnected(true);
    setConnectionNotice(null);
    return true;
  }, [
    actorUserId,
    availableModels,
    clearPendingLiveRenders,
    loadHistorySnapshot,
    pendingSendStorageError,
    projectName,
    refreshPendingSendState,
    replacePendingQuestions,
    rememberPendingSend,
    resetWatchdog,
    setSessionReady,
  ]);

  const answerPendingProjectQuestion = useCallback(async (rawText: string) => {
    const text = String(rawText || '').trim();
    const session = sessionKeyRef.current;
    const turnId = activeReplayTurnIdRef.current;
    if (
      !text
      || !session
      || !turnId
      || serverSelectedProviderRef.current !== 'OPENCLAW'
      || providerRef.current !== 'OPENCLAW'
      || providerVerificationStateRef.current !== 'ready'
      || providerTransitionPendingRef.current
      || !isStreamActiveRef.current
    ) return false;

    if (!pendingQuestionsReadyRef.current) {
      try {
        await refreshPendingQuestions();
      } catch {
        setSessionError('Portal could not verify whether this Project turn is waiting on a question. Retry in a moment.');
        return false;
      }
    }
    const requests = pendingQuestionsRef.current.filter((entry) => (
      entry.sessionKey === session
      && entry.state === 'pending'
      && entry.expiresAt > Date.now()
    ));
    if (requests.length === 0) {
      const stateVersion = projectChatStateVersionRef.current;
      if (!Number.isSafeInteger(stateVersion)) {
        setSessionError('Project coordination changed before Portal could steer this turn.');
        return false;
      }
      let existingSteer = pendingActiveSteerRef.current;
      if (
        existingSteer
        && (existingSteer.sessionKey !== session || existingSteer.turnId !== turnId)
      ) {
        pendingActiveSteerRef.current = null;
        existingSteer = null;
      }
      if (existingSteer?.inFlight) return false;
      if (existingSteer && existingSteer.text !== text) {
        setSessionError('The previous steering message has an unknown outcome. Retry it unchanged.');
        return false;
      }
      const steer = existingSteer || {
        requestId: nextId(),
        text,
        turnId,
        sessionKey: session,
        inFlight: false,
      };
      steer.inFlight = true;
      pendingActiveSteerRef.current = steer;
      setPendingQuestionAnswerPending(true);
      setSessionError(null);
      try {
        const { data } = await client.post(
          `/projects/${encodeURIComponent(projectName)}/assistant/answer-input`,
          {
            provider: 'OPENCLAW',
            stateVersion,
            turnId,
            requestId: steer.requestId,
            message: text,
          },
          { _silent: true } as any,
        );
        if (
          data?.accepted !== true
          || data?.provider !== 'OPENCLAW'
          || data?.turnId !== turnId
          || data?.sessionKey !== session
          || data?.requestId !== steer.requestId
        ) {
          throw new ProjectReplayContractError(
            'Portal did not confirm steering for this exact active Project turn.',
          );
        }
        pendingActiveSteerRef.current = null;
        setPendingQuestionAnswerPending(false);
        if (
          activeReplayTurnIdRef.current === turnId
          && sessionKeyRef.current === session
          && providerRef.current === 'OPENCLAW'
        ) {
          const localMessageId = `active-steer:${steer.requestId}`;
          setMessages((previous) => previous.some((entry) => entry.id === localMessageId)
            ? previous
            : [...previous, {
                id: localMessageId,
                role: 'user' as const,
                content: text,
                createdAt: new Date(),
              }]);
          setSessionError(null);
        }
        return true;
      } catch (error: any) {
        steer.inFlight = false;
        pendingActiveSteerRef.current = steer;
        setPendingQuestionAnswerPending(false);
        setSessionError(
          error?.response?.data?.error
            || error?.message
            || 'Steering delivery is unconfirmed. Retry the same text.',
        );
        if ([400, 404, 409].includes(Number(error?.response?.status))) {
          pendingActiveSteerRef.current = null;
        }
        return false;
      }
    }
    if (requests.length !== 1) {
      setSessionError('More than one question is waiting. Use the inline cards so each answer reaches the correct prompt.');
      return false;
    }
    const request = requests[0];
    if (request.questions.length !== 1) {
      setSessionError('This prompt needs more than one answer. Use its inline card so every field is preserved.');
      return false;
    }
    const question = request.questions[0];
    if (question.isSecret === true) {
      setSessionError('This prompt expects a secret. Use its protected inline field instead of the chat composer.');
      return false;
    }
    if (question.options.length > 0 && question.isOther !== true) {
      setSessionError('This prompt accepts only its listed choices. Use the inline card to select one.');
      return false;
    }

    let existing = pendingQuestionComposerAnswerRef.current;
    if (existing && existing.id !== request.id) {
      pendingQuestionComposerAnswerRef.current = null;
      existing = null;
    }
    if (existing?.inFlight) return false;
    if (existing && existing.text !== text) {
      setSessionError(
        'The previous answer has an unknown outcome. Retry it unchanged or use the inline question card.',
      );
      return false;
    }
    const pending = existing || {
      id: request.id,
      text,
      inFlight: false,
    };
    pending.inFlight = true;
    pendingQuestionComposerAnswerRef.current = pending;
    setPendingQuestionAnswerPending(true);
    setSessionError(null);
    try {
      const answers = Object.create(null) as Record<string, string>;
      answers[question.id] = text;
      const receipt = await gatewayAPI.answerQuestion(request.id, answers);
      if (receipt?.ok !== true || receipt?.id !== request.id || receipt?.state !== 'answered') {
        throw new Error('Portal did not confirm this exact answer.');
      }
      pendingQuestionComposerAnswerRef.current = null;
      setPendingQuestionAnswerPending(false);
      if (
        activeReplayTurnIdRef.current === turnId
        && sessionKeyRef.current === session
        && providerRef.current === 'OPENCLAW'
      ) {
        settlePendingQuestion(request.id);
        const localMessageId = `ask-user-answer:${request.id}`;
        setMessages((previous) => previous.some((entry) => entry.id === localMessageId)
          ? previous
          : [...previous, {
              id: localMessageId,
              role: 'user' as const,
              content: text,
              createdAt: new Date(),
            }]);
        setSessionError(null);
      }
      return true;
    } catch (error: any) {
      if (isAskUserQuestionNoLongerOpenError(error)) {
        pendingQuestionComposerAnswerRef.current = null;
        setPendingQuestionAnswerPending(false);
        settlePendingQuestion(request.id);
        setSessionError(null);
        void refreshPendingQuestions().catch(() => undefined);
        return false;
      }
      pending.inFlight = false;
      pendingQuestionComposerAnswerRef.current = pending;
      setPendingQuestionAnswerPending(false);
      setSessionError(
        error?.response?.data?.error
          || error?.message
          || 'Answer delivery is unconfirmed. Retry the same text or use the inline card.',
      );
      if ([404, 409].includes(Number(error?.response?.status))) {
        pendingQuestionComposerAnswerRef.current = null;
        void refreshPendingQuestions().catch(() => undefined);
      }
      return false;
    }
  }, [projectName, refreshPendingQuestions, settlePendingQuestion]);

  const submitAskQuestionAnswer = useCallback((answerText: string) => {
    const trimmed = (answerText || '').trim();
    if (!trimmed) return;
    if (isStreamActiveRef.current && providerRef.current === 'OPENCLAW') {
      void answerPendingProjectQuestion(trimmed);
      return;
    }
    void sendMessage(trimmed);
  }, [answerPendingProjectQuestion, sendMessage]);

  // ── Cancel stream ──

  const cancelStream = useCallback(async (): Promise<boolean> => {
    const provider = serverSelectedProviderRef.current;
    const stateVersion = projectChatStateVersionRef.current;
    const expectedTurnId = activeReplayTurnIdRef.current;
    const failClosed = (reason: string) => {
      const failedCapabilities = buildUnavailableProjectProviderCapabilities(
        `Project provider selection must be re-verified: ${reason}`,
      );
      providerCapabilitiesRef.current = failedCapabilities;
      setProviderCapabilities(failedCapabilities);
      serverSelectedProviderRef.current = null;
      setServerSelectedProvider(null);
      providerVerificationStateRef.current = 'failed';
      setProviderVerificationState('failed');
      providerTransitionPendingRef.current = false;
      setProviderTransitionPending(false);
      setSessionReady(false);
      setTransportConnected(false);
      setConnectionNotice(null);
      setSessionError(reason);
      clearWatchdog();
      activeReplayTurnIdRef.current = null;
      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setActiveToolName(null);
      setPendingApprovals([]);
    };

    if (
      !provider
      || !expectedTurnId
      || providerRef.current !== provider
      || providerVerificationStateRef.current !== 'ready'
      || typeof stateVersion !== 'number'
      || !Number.isSafeInteger(stateVersion)
      || stateVersion < 0
    ) {
      failClosed('The active Project provider coordination state is no longer verified.');
      return false;
    }
    const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === provider);
    if (capability?.supportsAbort !== true) {
      failClosed(`${capability?.displayName || provider} does not expose a verified abort capability.`);
      return false;
    }

    setStatusText('Stopping current response…');
    try {
      const result = await projectsAPI.agentAbort(projectName, provider, stateVersion);
      if (result?.provider !== provider) {
        throw new ProjectReplayContractError(
          `Project abort provider mismatch: expected ${provider}, received ${String(result?.provider || 'none')}`,
        );
      }
      if (!Number.isSafeInteger(result?.stateVersion) || result.stateVersion < stateVersion) {
        throw new ProjectReplayContractError('Project abort returned a missing or stale coordination version.');
      }
      if (result?.aborted === true && result?.turnId !== expectedTurnId) {
        throw new ProjectReplayContractError('Project abort did not match the verified active turn.');
      }
      if (serverSelectedProviderRef.current !== provider || providerRef.current !== provider) {
        throw new ProjectReplayContractError('Project provider verification changed while cancellation was pending.');
      }
      projectChatStateVersionRef.current = result.stateVersion;
      setProjectChatStateVersion(result.stateVersion);
      if (result?.runtime) {
        runtimeRef.current = result.runtime;
        setSelectedRuntime(result.runtime);
      }
      if (result?.aborted !== true) {
        setStatusText('Response already finished — refreshing replay…');
        setReplayRetryNonce((value) => value + 1);
        return false;
      }
      activeReplayTurnIdRef.current = null;
    } catch (error: any) {
      const reason = error?.response?.data?.error || error?.message || 'Failed to stop the Project response';
      if (error instanceof ProjectReplayContractError || isProjectProviderReverificationError(error)) {
        failClosed(reason);
      } else {
        console.warn('[ProjectChat] Project turn abort failed:', error);
        setSessionError(reason);
        setStatusText('Stop was not confirmed; the response remains active.');
      }
      return false;
    }

    clearWatchdog();
    flushPendingLiveRenders();
    isStreamActiveRef.current = false;
    setIsRunning(false);
    setStreamingPhase('idle');
    setStatusText(null);
    setPendingApprovals([]);
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
    const cid = streamingAssistantIdRef.current;
    if (cid) {
      const ft = assembledRef.current.substring(lastSegmentStartRef.current);
      if (ft) setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: ft + '\n\n*(cancelled)*' } : m));
      streamingAssistantIdRef.current = null;
    }
    return true;
  }, [clearWatchdog, flushPendingLiveRenders, projectName, setSessionReady]);

  // ── Clear chat ──
  const clearChat = useCallback(async () => {
    if (sessionControlMutationRef.current || projectTransitionActivityRef.current) return;
    try {
      if (isStreamActiveRef.current && !(await cancelStream())) return;

      const provider = serverSelectedProviderRef.current;
      const stateVersion = projectChatStateVersionRef.current;
      const immutableProjectId = projectIdentityIdRef.current;
      if (
        !provider
        || !immutableProjectId
        || providerRef.current !== provider
        || typeof stateVersion !== 'number'
        || !Number.isSafeInteger(stateVersion)
        || stateVersion < 0
      ) {
        throw new ProjectReplayContractError('Project provider verification is required before clearing chat.');
      }
      const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === provider);
      if (capability?.supportsReset !== true) {
        throw new ProjectReplayContractError(
          `${capability?.displayName || provider} does not expose a verified reset capability.`,
        );
      }
      providerTransitionPendingRef.current = true;
      setProviderTransitionPending(true);
      setSessionReady(false);
      await runCoordinatedProjectChatReset({
        actorUserId,
        projectId: immutableProjectId,
        reset: async () => {
          const { data } = await client.post(
            `/projects/${encodeURIComponent(projectName)}/assistant/reset`,
            { provider, stateVersion },
            { _silent: true } as any,
          );
          if (data?.provider !== provider) {
            throw new ProjectReplayContractError(
              `Project reset provider mismatch: expected ${provider}, received ${String(data?.provider || 'none')}`,
            );
          }
          if (
            data?.success !== true
            || !Number.isSafeInteger(data?.stateVersion)
            || data.stateVersion < stateVersion
          ) {
            throw new ProjectReplayContractError('Project reset did not return an authoritative completion state.');
          }
          return data;
        },
      });
      activeReplayTurnIdRef.current = null;
      setPendingSendStorageError(null);
      rememberPendingSend(null);
      clearPreservedQueuedComposerDraft();
      queuedComposerMessageRef.current = null;
      setQueuedComposerMessage(null);
      clearPendingLiveRenders();
      setMessages([]);
      setStatusText(null);
      thinkingContentRef.current = '';
      setThinkingContent('');
      thinkingSubjectRef.current = '';
      setThinkingSubject('');
      setStreamingPhase('idle');
      setIsRunning(false);
      setPendingApprovals([]);
      isStreamActiveRef.current = false;
      streamingAssistantIdRef.current = null;
      assembledRef.current = '';
      lastSegmentStartRef.current = 0;
      lastRawTextLenRef.current = 0;
      sessionKeyRef.current = null;
      setSessionKey(null);
      setAgentId(null);
      setSessionReady(false);
      setTransportConnected(false);
      setProviderRefreshNonce((value) => value + 1);
    } catch (err: any) {
      console.error('[ProjectChat] Clear error:', err);
      const reason = err?.response?.data?.error || err?.message || 'Failed to clear Project Chat';
      if (err instanceof ProjectChatPendingStateError) {
        setPendingSendStorageError(reason);
      }
      if (
        err instanceof ProjectReplayContractError
        || err instanceof ProjectChatPendingStateError
        || isProjectProviderReverificationError(err)
      ) {
        const failedCapabilities = buildUnavailableProjectProviderCapabilities(
          `Project provider selection must be re-verified: ${reason}`,
        );
        providerCapabilitiesRef.current = failedCapabilities;
        setProviderCapabilities(failedCapabilities);
        serverSelectedProviderRef.current = null;
        setServerSelectedProvider(null);
        providerVerificationStateRef.current = 'failed';
        setProviderVerificationState('failed');
        setTransportConnected(false);
      } else {
        setSessionReady(true);
      }
      providerTransitionPendingRef.current = false;
      setProviderTransitionPending(false);
      setSessionError(reason);
    }
  }, [actorUserId, cancelStream, clearPendingLiveRenders, clearPreservedQueuedComposerDraft, projectName, rememberPendingSend, setSessionReady]);

  // ── File upload ──
  const uploadFile = useCallback(async (file: File, attachId: string) => {
    setPendingAttachments(prev => prev.map(a => a.id === attachId ? {
      ...a,
      projectPath: undefined,
      uploadStatus: 'uploading' as const,
      uploadError: undefined,
    } : a));
    const formData = new FormData();
    formData.append('file', file);
    const provider = serverSelectedProviderRef.current;
    const stateVersion = projectChatStateVersionRef.current;
    if (
      !provider
      || providerRef.current !== provider
      || providerVerificationStateRef.current !== 'ready'
      || !Number.isSafeInteger(stateVersion)
      || stateVersion == null
      || stateVersion < 0
    ) {
      setPendingAttachments(prev => prev.map(a => a.id === attachId ? {
        ...a,
        uploadStatus: 'error' as const,
        uploadError: 'Project provider verification is required before attaching files.',
      } : a));
      return;
    }
    const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === provider);
    if (capability?.supportsAttachments !== true) {
      setPendingAttachments(prev => prev.map(a => a.id === attachId ? {
        ...a,
        uploadStatus: 'error' as const,
        uploadError: `${capability?.displayName || provider} does not expose a verified attachment capability.`,
      } : a));
      return;
    }
    formData.append('provider', provider);
    formData.append('stateVersion', String(stateVersion));
    try {
      const resp = await workspaceAuthorizedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/assistant/attachments`,
        { method: 'POST', credentials: 'include', body: formData },
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || `Upload failed: ${resp.status}`);
      if (data?.provider !== provider || data?.stateVersion !== stateVersion) {
        throw new Error('Project attachment response did not match the verified provider state.');
      }
      const projectPath = typeof data?.projectPath === 'string' ? data.projectPath.trim() : '';
      const projectPathSegments = projectPath.split('/');
      if (
        !projectPath
        || projectPath.startsWith('/')
        || projectPath.includes('\\')
        || projectPath.includes('\0')
        || projectPath.includes(':')
        || projectPathSegments.some((segment: string) => !segment || segment === '.' || segment === '..')
      ) {
        throw new Error('Project attachment response did not contain a safe project-relative path.');
      }
      setPendingAttachments(prev => prev.map(a => a.id === attachId ? {
        ...a,
        projectPath,
        uploadStatus: 'done' as const,
      } : a));
    } catch (err: any) {
      setPendingAttachments(prev => prev.map(a => a.id === attachId ? { ...a, uploadStatus: 'error' as const, uploadError: err.message } : a));
    }
  }, [projectName]);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === providerRef.current);
    if (capability?.supportsAttachments !== true) {
      appendSystemNotice(
        `${capability?.displayName || getProjectProviderLabel(providerRef.current)} does not expose a verified Project attachment capability.`,
      );
      return;
    }
    const newAttachments: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const id = `pattach-${Date.now()}-${Math.random()}`;
      const isImage = file.type.startsWith('image/');
      const isText = file.type.startsWith('text/') || /\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|css|html|json|yaml|yml|md|sh|bash|toml|ini|env)$/i.test(file.name);
      const att: PendingAttachment = {
        id,
        file,
        name: file.name,
        size: file.size,
        type: isImage ? 'image' : isText ? 'text' : 'other',
        uploadStatus: 'uploading',
      };
      if (isImage) att.previewUrl = URL.createObjectURL(file);
      if (isText && file.size < 100 * 1024) { try { att.textContent = await file.text(); } catch {} }
      newAttachments.push(att);
    }
    setPendingAttachments(prev => [...prev, ...newAttachments]);
    for (const att of newAttachments) {
      void uploadFile(att.file, att.id);
    }
  }, [appendSystemNotice, uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      const removed = prev.find(a => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, []);

  // Build attachment text
  const buildAttachmentText = useCallback(() => {
    if (pendingAttachments.length === 0) return '';
    const parts: string[] = [];
    for (const att of pendingAttachments) {
      if (att.uploadStatus !== 'done' || !att.projectPath) continue;
      const projectPathLine = `- project_path: ${att.projectPath}`;
      if (att.type === 'text' && att.textContent) {
        parts.push([
          `Attached text file: ${att.name}`,
          projectPathLine,
          'The project_path is relative to the current project workspace. Do not use a host path or Portal URL.',
          'The file content is inlined below.',
          `\`\`\`${att.name}\n${att.textContent}\n\`\`\``,
        ].filter(Boolean).join('\n'));
        continue;
      }
      const typeHint = att.type === 'image'
        ? [
            'This is an image attachment.',
            `Open ${att.projectPath} from the current project workspace using project-local file access.`,
            'Do not use a host path or Portal URL.',
            'Do not say you cannot access the image unless the project-local tool itself returns an error.',
          ].join(' ')
        : /\.pdf$/i.test(att.name)
          ? [
              'This is a PDF attachment.',
              `Open ${att.projectPath} from the current project workspace using project-local file access.`,
              'Do not use a host path or Portal URL.',
              'Do not say you cannot access the PDF unless the project-local tool itself returns an error.',
            ].join(' ')
          : 'This file is available only at project_path inside the current project workspace.';
      parts.push([
        `Attached file: ${att.name}`,
        `- kind: ${att.type}`,
        `- size: ${att.size} bytes`,
        projectPathLine,
        typeHint,
      ].filter(Boolean).join('\n'));
    }
    return parts.join('\n\n') + '\n\n';
  }, [pendingAttachments]);

  // ── Form submit ──
  const appendSystemMessage = useCallback((content: string) => {
    setMessages(prev => ([...prev, {
      id: nextId(),
      role: 'system',
      content,
      createdAt: new Date(),
    }]));
  }, []);

  const refreshSlashAutocomplete = useCallback((value: string, caret = value.length) => {
    const activeText = value.slice(0, caret);
    const tokenMatch = activeText.match(/(?:^|\s)(\/[^\s]*)$/);
    if (!tokenMatch) {
      setShowSlashMenu(false);
      setSlashCommands([]);
      setSelectedSlashIndex(0);
      return;
    }
    const matches = matchSlashCommands(tokenMatch[1]);
    setSlashCommands(matches);
    setSelectedSlashIndex(0);
    setShowSlashMenu(matches.length > 0);
  }, []);

  const insertSlashCommand = useCallback((command: SlashCommand) => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const nextValue = `${command.command}${command.argsHint ? ' ' : ''}`;
    setInput(nextValue);
    setShowSlashMenu(false);
    setSlashCommands([]);
    setSelectedSlashIndex(0);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = nextValue.length;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
    });
  }, []);

  const exportChatMarkdown = useCallback(async () => {
    if (isExportingChat) return;
    const expectedGen = historyGenRef.current;
    const provider = providerRef.current;
    setIsExportingChat(true);
    try {
      const exported: ProjectChatPersistedMessage[] = [];
      const seenMessageIds = new Set<string>();
      const seenCursors = new Set<string>();
      let before: string | null = null;

      while (true) {
        const page = await projectsAPI.chatHistory(projectName, provider, {
          limit: PROJECT_CHAT_HISTORY_PAGE_SIZE,
          before,
        });
        if (historyGenRef.current !== expectedGen || providerRef.current !== provider) {
          throw new Error('Project Chat changed while the transcript was being exported.');
        }
        const pageMessages = Array.isArray(page?.messages) ? page.messages : [];
        for (const message of pageMessages) {
          const id = String(message.id || '');
          if (id && seenMessageIds.has(id)) continue;
          if (id) seenMessageIds.add(id);
          exported.push(message);
        }

        const nextCursor = typeof page?.pagination?.nextCursor === 'string'
          ? page.pagination.nextCursor
          : null;
        if (page?.pagination?.hasMore !== true || !nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          throw new Error('Project Chat export received a repeated history cursor.');
        }
        seenCursors.add(nextCursor);
        before = nextCursor;
      }

      exported.sort((left, right) => {
        const time = Date.parse(String(left.timestamp || '')) - Date.parse(String(right.timestamp || ''));
        if (Number.isFinite(time) && time !== 0) return time;
        return String(left.id || '').localeCompare(String(right.id || ''));
      });
      const lines = exported.map((msg) => {
        const heading = msg.role === 'user'
        ? '## User'
        : msg.role === 'assistant'
          ? '## Assistant'
          : msg.role === 'system'
            ? '## System'
            : '## Tool';
        return `${heading}\n\n${msg.content || ''}`;
      });
      const blob = new Blob([`# ${projectName} Project Chat\n\n${lines.join('\n\n---\n\n')}\n`], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${projectName}-project-chat.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      appendSystemMessage(`Exported ${exported.length} transcript messages as markdown.`);
    } catch (error: any) {
      appendSystemMessage(
        String(error?.response?.data?.error || error?.message || 'Project Chat export failed.'),
      );
    } finally {
      setIsExportingChat(false);
    }
  }, [appendSystemMessage, isExportingChat, projectName]);

  const showSessionStatus = useCallback(async () => {
    try {
      const [statusRes, modelRes] = await Promise.allSettled([
        client.get(`/projects/${encodeURIComponent(projectName)}/chat/session-status`, {
          params: { provider: providerRef.current },
          _silent: true,
        } as any),
        client.get(`/projects/${encodeURIComponent(projectName)}/assistant/active-model`, {
          params: { provider: providerRef.current },
          _silent: true,
        } as any),
      ]);
      const statusData = statusRes.status === 'fulfilled' ? statusRes.value.data : null;
      const modelData = modelRes.status === 'fulfilled' ? modelRes.value.data : null;
      const verifiedActiveModel = modelData?.verified === true
        ? canonicalizePortalModelId(String(modelData.activeModel || ''))
        : '';
      const activeTurnRunning = isRunning && Boolean(activeReplayTurnIdRef.current);
      const lines = [
        `Project: ${projectName}`,
        `Provider: ${getProjectProviderLabel(providerRef.current)}`,
        `Runtime: ${runtimeRef.current}`,
        'Execution scope: PROJECT_SANDBOX',
        `Provider session: ${statusData?.active ? 'verified' : 'unavailable'}`,
        `Active turn: ${activeTurnRunning ? 'running' : 'idle'}`,
        `Portal transport: ${transportConnected ? 'connected' : 'disconnected'}`,
        `Session key: ${sessionKeyRef.current || 'not ready'}`,
        `Configured model: ${selectedModel || 'not set'}`,
        `Active model: ${verifiedActiveModel || 'unverified'}`,
      ];
      if (statusData?.dbStatus) lines.push(`DB status: ${statusData.dbStatus}`);
      appendSystemMessage(lines.join('\n'));
    } catch (err: any) {
      appendSystemMessage(`Failed to load session status: ${err?.response?.data?.error || err?.message || 'Unknown error'}`);
    }
  }, [appendSystemMessage, isRunning, projectName, selectedModel, transportConnected]);

  const ensureVerifiedProjectModel = useCallback(async (model: string) => {
    const provider = serverSelectedProviderRef.current;
    const stateVersion = projectChatStateVersionRef.current;
    const verifiedSession = sessionKeyRef.current;
    if (
      !provider
      || providerRef.current !== provider
      || typeof verifiedSession !== 'string'
      || !verifiedSession.trim()
      || typeof stateVersion !== 'number'
      || !Number.isSafeInteger(stateVersion)
      || stateVersion < 0
    ) {
      throw new ProjectReplayContractError('Project provider verification is required before changing models.');
    }
    const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === provider);
    if (capability?.supportsModelSelection !== true) {
      throw new ProjectReplayContractError(
        `${capability?.displayName || provider} does not expose a verified model-selection capability.`,
      );
    }
    let admittedStateVersion = stateVersion;
    if (provider === 'AGENT_ZERO') {
      const qualified = await projectsAPI.qualifyProjectChatProvider(
        projectName,
        'AGENT_ZERO',
        canonicalizePortalModelId(model),
      );
      if (qualified?.provider !== 'AGENT_ZERO'
        || qualified?.qualification?.status !== 'QUALIFIED'
        || !Number.isSafeInteger(qualified?.stateVersion)
        || qualified.stateVersion < admittedStateVersion) {
        throw new ProjectReplayContractError(
          'Portal did not prove the selected Agent Zero OAuth model before changing the session.',
        );
      }
      admittedStateVersion = qualified.stateVersion;
      projectChatStateVersionRef.current = admittedStateVersion;
      setProjectChatStateVersion(admittedStateVersion);
      setProviderQualifications((current) => ({
        ...current,
        AGENT_ZERO: qualified.qualification,
      }));
    }
    const { data } = await client.post(
      `/projects/${encodeURIComponent(projectName)}/assistant/ensure-session`,
      {
        provider,
        stateVersion: admittedStateVersion,
        model,
      },
      { _silent: true } as any,
    );
    if (data?.provider !== provider) {
      throw new ProjectReplayContractError(
        `Project model provider mismatch: expected ${provider}, received ${String(data?.provider || 'none')}`,
      );
    }
    const verifiedModel = resolveVerifiedProjectModelResponse(capability, data);
    if (data?.sessionKey !== verifiedSession) {
      throw new ProjectReplayContractError('Project model change did not retain the verified provider session.');
    }
    // Runtime admission bumps the coordination version on every ensure; the
    // returned version is proof our change committed. Genuine interleaving is
    // rejected server-side with a 409.
    if (!Number.isSafeInteger(data?.stateVersion) || data.stateVersion < admittedStateVersion) {
      throw new ProjectReplayContractError('Project coordination changed while the model was being updated.');
    }
    projectChatStateVersionRef.current = data.stateVersion;
    setProjectChatStateVersion(data.stateVersion);
    if (
      serverSelectedProviderRef.current !== provider
      || providerRef.current !== provider
      || sessionKeyRef.current !== verifiedSession
    ) {
      throw new ProjectReplayContractError('Project provider verification changed while the model was being updated.');
    }
    if (data?.runtime) {
      runtimeRef.current = data.runtime;
      setSelectedRuntime(data.runtime);
    }
    return { ...data, model: verifiedModel };
  }, [projectName]);

  const maybeExecuteSlashCommand = useCallback(async () => {
    const parsed = parseSlashCommand(input);
    if (!parsed) return false;

    const rawArg = parsed.args?.trim() || '';
    switch (parsed.command.command) {
      case '/help':
        appendSystemMessage('Available project chat commands: /new, /stop, /models, /model <id>, /status, /clear, /export, /help');
        setShowSessionControls(true);
        return true;
      case '/new':
      case '/clear':
        if (providerCapabilitiesRef.current.find((entry) => entry.provider === providerRef.current)?.supportsReset !== true) {
          appendSystemMessage('This Project provider does not expose a verified reset capability.');
          return true;
        }
        await clearChat();
        return true;
      case '/stop':
        if (isRunning) {
          if (providerCapabilitiesRef.current.find((entry) => entry.provider === providerRef.current)?.supportsAbort !== true) {
            appendSystemMessage('This Project provider does not expose a verified abort capability.');
            return true;
          }
          void cancelStream();
          appendSystemMessage('Stopping current response…');
        } else {
          appendSystemMessage('No active response to stop.');
        }
        return true;
      case '/models': {
        if (providerCapabilitiesRef.current.find((entry) => entry.provider === providerRef.current)?.supportsModelSelection !== true) {
          appendSystemMessage('This Project provider does not expose model selection.');
          return true;
        }
        const models = availableModels.length > 0 ? availableModels : await loadAvailableModels();
        const list = models.length > 0 ? models.join('\n') : 'No models available';
        appendSystemMessage(`Available models:\n${list}`);
        return true;
      }
      case '/model': {
        if (providerCapabilitiesRef.current.find((entry) => entry.provider === providerRef.current)?.supportsModelSelection !== true) {
          appendSystemMessage('This Project provider does not expose model selection.');
          return true;
        }
        if (!rawArg) {
          appendSystemMessage('Usage: /model <model-id>');
          return true;
        }
        const nextModel = canonicalizePortalModelId(rawArg);
        const provider = serverSelectedProviderRef.current;
        const verifiedSession = sessionKeyRef.current;
        const stateVersion = projectChatStateVersionRef.current;
        if (
          !provider
          || !verifiedSession
          || !Number.isSafeInteger(stateVersion)
          || stateVersion == null
          || stateVersion < 0
        ) {
          appendSystemMessage('Project provider verification is required before changing models.');
          return true;
        }
        if (
          (provider === 'OPENCLAW' || provider === 'AGENT_ZERO')
          && !availableModels.includes(nextModel)
        ) {
          appendSystemMessage(`${nextModel} is not available to this exact Project agent.`);
          return true;
        }
        const activity: ProjectModelSwitchActivity = Object.freeze({
          kind: 'model-switch' as const,
          projectName,
          provider,
          sessionKey: verifiedSession,
          previousModel: modelRef.current,
          requestedModel: nextModel,
          stateVersion,
          token: ++projectTransitionActivityTokenRef.current,
        });
        if (!claimProjectTransitionActivity(activity)) {
          appendSystemMessage('Another project operation is still running. Wait for it to finish before changing models.');
          return true;
        }
        providerTransitionPendingRef.current = true;
        setProviderTransitionPending(true);
        setSessionReady(false);
        setConnectionNotice(`Switching this project session to ${nextModel}…`);
        try {
          const data = await ensureVerifiedProjectModel(nextModel);
          if (projectTransitionActivityRef.current !== activity) {
            throw new ProjectReplayContractError('Project model-switch ownership changed before the server response settled.');
          }
          const resolvedModel = canonicalizePortalModelId(String(data?.model || nextModel));
          setSelectedModel(resolvedModel);
          modelRef.current = resolvedModel;
          localStorage.setItem(`agent-model-${projectName}`, resolvedModel);
          appendSystemMessage(data?.modelWarning || `Model switched to ${resolvedModel}`);
        } catch (err: any) {
          const reason = err?.response?.data?.error || err?.message || 'Unknown error';
          appendSystemMessage(`Failed to switch model to ${nextModel}: ${reason}`);
          if (providerRef.current === 'AGENT_ZERO'
            || err instanceof ProjectReplayContractError
            || isProjectProviderReverificationError(err)) {
            const failedCapabilities = buildUnavailableProjectProviderCapabilities(
              `Project provider selection must be re-verified: ${reason}`,
            );
            providerCapabilitiesRef.current = failedCapabilities;
            setProviderCapabilities(failedCapabilities);
            serverSelectedProviderRef.current = null;
            setServerSelectedProvider(null);
            providerVerificationStateRef.current = 'failed';
            setProviderVerificationState('failed');
            setTransportConnected(false);
          } else {
            setSessionReady(true);
          }
          return true;
        } finally {
          if (projectTransitionActivityRef.current === activity) {
            providerTransitionPendingRef.current = false;
            setProviderTransitionPending(false);
            setConnectionNotice(null);
          }
        }
        return true;
      }
      case '/status':
        await showSessionStatus();
        return true;
      case '/export':
        void exportChatMarkdown();
        return true;
      default:
        return false;
    }
  }, [appendSystemMessage, availableModels, cancelStream, claimProjectTransitionActivity, clearChat, ensureVerifiedProjectModel, exportChatMarkdown, input, isRunning, loadAvailableModels, projectName, setSessionReady, showSessionStatus]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    if (isRunning) {
      if (!providerAcceptsActiveInput) {
        setSessionError('This Project provider does not accept input during an active turn.');
        return;
      }
      if (pendingAttachments.length > 0) {
        setSessionError('Attachments cannot be added while answering an active OpenClaw turn.');
        return;
      }
      if (await maybeExecuteSlashCommand()) {
        clearPreservedQueuedComposerDraft();
        setInput('');
        setShowSlashMenu(false);
        setSlashCommands([]);
        setSelectedSlashIndex(0);
        return;
      }
      const sent = await answerPendingProjectQuestion(input);
      if (sent) {
        clearPreservedQueuedComposerDraft();
        setInput('');
        setShowSlashMenu(false);
        setSlashCommands([]);
        setSelectedSlashIndex(0);
      }
      return;
    }
    if (!providerSendAllowed) {
      if (modelCatalogError && providerVerificationStateRef.current === 'ready') {
        setSessionError(modelCatalogError);
        return;
      }
      if (pendingAttachments.length > 0) {
        setSessionError('Wait for the project agent to be ready before sending attachments.');
        return;
      }
      if (
        directQualificationProvider
        || serverSelectedProviderRef.current !== selectedProvider
        || selectedProviderCapability?.selectable !== true
        || selectedProviderCapability.executionScope !== 'PROJECT_SANDBOX'
      ) {
        // Explicit preparation owns this transition. Keep the user's draft in
        // the editable composer and point at the real action; do not imply that
        // a request started or silently dispatch it later. Preserve the same
        // actor/project/provider-scoped draft before returning so the panel's
        // "continue in the background" dismissal cannot erase it.
        if (queuedComposerDraftScope) {
          preservedQueuedComposerDraftScopeRef.current = queuedComposerDraftScope;
          writeQueuedComposerDraft(queuedComposerDraftScope, input);
        }
        if (directQualificationProvider) {
          setComposerPreparationPrompt(directQualificationProvider);
          setConnectionNotice(null);
        }
        return;
      }
      const queued = input.trim();
      queuedComposerMessageRef.current = queued;
      setQueuedComposerMessage(queued);
      if (queuedComposerDraftScope) {
        preservedQueuedComposerDraftScopeRef.current = queuedComposerDraftScope;
        writeQueuedComposerDraft(queuedComposerDraftScope, queued);
      }
      setInput('');
      setConnectionNotice('Connecting to the verified project runtime…');
      return;
    }
    const attachmentsReady = pendingAttachments.every(a => a.uploadStatus === 'done' && Boolean(a.projectPath));
    if (!attachmentsReady) return;
    if (await maybeExecuteSlashCommand()) {
      clearPreservedQueuedComposerDraft();
      setInput('');
      setShowSlashMenu(false);
      setSlashCommands([]);
      setSelectedSlashIndex(0);
      return;
    }
    const draftText = input.trim();
    const attachText = buildAttachmentText();
    const fullMessage = attachText + draftText;
    const sent = await sendMessage(fullMessage, draftText);
    if (sent) {
      clearPreservedQueuedComposerDraft();
      setInput('');
      setPendingAttachments([]);
      setShowSlashMenu(false);
      setSlashCommands([]);
      setSelectedSlashIndex(0);
    }
  }, [
    buildAttachmentText,
    clearPreservedQueuedComposerDraft,
    input,
    isRunning,
    maybeExecuteSlashCommand,
    modelCatalogError,
    pendingAttachments,
    providerAcceptsActiveInput,
    directQualificationProvider,
    providerSendAllowed,
    queuedComposerDraftScope,
    selectedProvider,
    selectedProviderCapability,
    answerPendingProjectQuestion,
    sendMessage,
  ]);

  useEffect(() => {
    const queued = queuedComposerMessageRef.current;
    if (!queued || !providerSendAllowed) return;
    queuedComposerMessageRef.current = null;
    setQueuedComposerMessage(null);
    void sendMessage(queued, queued).then((sent) => {
      if (sent) {
        clearPreservedQueuedComposerDraft();
        return;
      }
      // A definitive send failure must return ownership of the draft to the
      // user. Re-queueing here disabled the restored composer forever because
      // this effect only runs when provider readiness changes.
      setInput((current) => current || queued);
    });
  }, [clearPreservedQueuedComposerDraft, providerSendAllowed, sendMessage]);

  const handleProviderChange = useCallback(async (
    nextProvider: ProjectChatProviderName,
    options: { confirmed?: boolean } = {},
  ) => {
    if (sessionControlMutationRef.current || projectTransitionActivityRef.current) return;
    const currentServerProvider = serverSelectedProviderRef.current;
    if (
      !canSwitchProjectProvider({
        verificationState: providerVerificationStateRef.current,
        serverSelectedProvider: currentServerProvider,
        turnActive: isStreamActiveRef.current,
        transitionPending: providerTransitionPendingRef.current,
      })
      || nextProvider === currentServerProvider
    ) return;
    if (pendingAttachments.length > 0) {
      appendSystemNotice('Remove pending attachments before switching Project Chat providers.');
      return;
    }
    const capability = providerCapabilitiesRef.current.find((entry) => entry.provider === nextProvider);
    if (!capability?.selectable || capability.executionScope !== 'PROJECT_SANDBOX') {
      appendSystemNotice(capability?.reason || `${getProjectProviderLabel(nextProvider)} is not available for Projects.`);
      return;
    }
    // Switching to a provider this project has never used starts a fresh
    // agent. The shared project transcript is preserved, but the new agent
    // does not inherit the previous agent's working memory — that deserves
    // one explicit confirmation, and only the first time.
    if (!options.confirmed && !boundProviders.includes(nextProvider)) {
      setPendingProviderSwitch(nextProvider);
      return;
    }
    setPendingProviderSwitch(null);

    const storedModel = canonicalizePortalModelId(
      capability.supportsModelSelection
        ? localStorage.getItem(`agent-model-${projectName}-${nextProvider}`) || ''
        : '',
    );
    const stateVersion = projectChatStateVersionRef.current;
    if (!Number.isSafeInteger(stateVersion) || stateVersion == null || stateVersion < 0) {
      setSessionError('Project Chat coordination state must be refreshed before switching providers.');
      return;
    }
    const previousProvider = currentServerProvider;
    const previousSession = sessionKeyRef.current;
    const activity: ProjectProviderTransitionActivity = Object.freeze({
      kind: 'provider-transition' as const,
      projectName,
      provider: nextProvider,
      previousProvider,
      sessionKey: previousSession,
      previousModel: modelRef.current,
      requestedModel: storedModel,
      stateVersion,
      token: ++projectTransitionActivityTokenRef.current,
    });
    if (!claimProjectTransitionActivity(activity)) {
      setSessionError('Another project operation is still running. Wait for it to finish before switching providers.');
      return;
    }

    try {
      providerTransitionPendingRef.current = true;
      setProviderTransitionPending(true);
      setSessionReady(false);
      setSessionError(null);
      setConnectionNotice(`Switching to ${capability.displayName}…`);
      const result = await projectsAPI.selectProjectChatProvider(
        projectName,
        nextProvider,
        stateVersion,
        capability.supportsModelSelection ? storedModel : undefined,
      );
      if (
        projectTransitionActivityRef.current !== activity
        || serverSelectedProviderRef.current !== previousProvider
        || sessionKeyRef.current !== previousSession
      ) {
        throw new Error('Project provider-switch ownership changed before the server response settled.');
      }
      if (result?.provider !== nextProvider) {
        throw new Error(`Project provider switch mismatch: expected ${nextProvider}, received ${String(result?.provider || 'none')}`);
      }
      const verifiedSwitchedModel = resolveVerifiedProjectModelResponse(capability, result);
      if (!Number.isSafeInteger(result?.stateVersion) || result.stateVersion < 0) {
        throw new Error('Portal did not confirm the Project Chat provider switch version.');
      }
      if (typeof result?.sessionKey !== 'string' || !result.sessionKey.trim()) {
        throw new Error('Portal did not return the switched Project provider session.');
      }
      serverSelectedProviderRef.current = nextProvider;
      activeReplayTurnIdRef.current = null;
      setServerSelectedProvider(nextProvider);
      setBoundProviders((prev) => (prev.includes(nextProvider) ? prev : [...prev, nextProvider]));
      providerRef.current = nextProvider;
      runtimeRef.current = result.runtime || capability.runtime;
      const switchedModel = verifiedSwitchedModel
        || canonicalizePortalModelId(String(storedModel || ''));
      modelRef.current = switchedModel;
      setAvailableModels([]);
      setModelCatalogError(null);
      setSelectedModel(switchedModel);
      setSelectedRuntime(runtimeRef.current);
      setSelectedProvider(nextProvider);
      sessionKeyRef.current = result.sessionKey;
      setSessionKey(result.sessionKey);
      if (result.agentId) setAgentId(result.agentId);
      projectChatStateVersionRef.current = result.stateVersion;
      setProjectChatStateVersion(result.stateVersion);
      appendSystemNotice(
        `${result.resumed ? 'Resumed' : 'Created'} ${capability.displayName} project binding. Portal transcript preserved.`,
      );
      providerVerificationStateRef.current = 'ready';
      setProviderVerificationState('ready');
      setTransportConnected(true);
      setSessionReady(true);
      providerTransitionPendingRef.current = false;
      setProviderTransitionPending(false);
      setConnectionNotice(null);
    } catch (error: any) {
      const reason = error?.response?.data?.error || error?.message || 'Provider switch failed';
      const failedCapabilities = buildUnavailableProjectProviderCapabilities(
        `Project provider selection must be re-verified after the failed switch: ${reason}`,
      );
      providerCapabilitiesRef.current = failedCapabilities;
      setProviderCapabilities(failedCapabilities);
      serverSelectedProviderRef.current = null;
      setServerSelectedProvider(null);
      providerVerificationStateRef.current = 'failed';
      setProviderVerificationState('failed');
      providerTransitionPendingRef.current = false;
      setProviderTransitionPending(false);
      setSessionReady(false);
      setConnectionNotice(null);
      setSessionError(reason);
    }
  }, [appendSystemNotice, boundProviders, claimProjectTransitionActivity, pendingAttachments.length, projectName, setSessionReady]);

  const handleProviderQualification = useCallback(async (
    provider: 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA',
  ) => {
    if (
      qualificationLeaseRef.current
      || sessionControlMutationRef.current
      || projectTransitionActivityRef.current
      || isStreamActiveRef.current
      || providerTransitionPendingRef.current
    ) return;
    const label = getProjectProviderLabel(provider);
    setComposerPreparationPrompt(null);
    const exactAgentZeroModel = canonicalizePortalModelId(agentZeroQualificationModel);
    if (provider === 'AGENT_ZERO'
      && !agentZeroProjectModels.some((option) => option.value === exactAgentZeroModel)) {
      setSessionError('Select a model from a currently connected Agent Zero OAuth provider before qualification.');
      return;
    }
    const lease = Object.freeze({
      kind: 'provider-qualification' as const,
      projectName,
      provider,
      token: ++qualificationTokenRef.current,
    });
    qualificationLeaseRef.current = lease;
    if (onActivityChangeRef.current?.(lease, true) === false) {
      qualificationLeaseRef.current = null;
      setSessionError('Another project operation is still running. Wait for it to finish before preparing a provider.');
      return;
    }
    const suppressionKey = automaticQualificationSuppressionKey(
      actorUserId,
      projectIdentityIdRef.current,
      provider,
    );
    // The durable disposition records a *failed* explicit attempt, so write it
    // only after the request returns a verdict. A preparation can take 27-90s
    // on a new project; persisting a failure before that request settles would
    // turn ordinary navigation into a false auth/maintenance state.
    setQualificationPending(true);
    setQualificationProgress({
      projectName,
      provider,
      label,
      stage: 'checking',
    });
    setSessionError(null);
    setConnectionNotice(null);
    try {
      const qualificationModel = provider === 'AGENT_ZERO'
        ? exactAgentZeroModel
        : provider === 'OLLAMA' && providerRef.current === 'OLLAMA'
          ? resolveAvailableModelId(modelRef.current, availableModels)
          : '';
      const result = qualificationModel
        ? await projectsAPI.qualifyProjectChatProvider(projectName, provider, qualificationModel)
        : await projectsAPI.qualifyProjectChatProvider(projectName, provider);
      if (qualificationLeaseRef.current !== lease || lease.projectName !== projectName) return;
      if (result?.provider !== provider || result?.qualification?.status !== 'QUALIFIED') {
        throw new Error(`Portal could not prepare ${label} for this project.`);
      }
      const presentedQualification = presentProjectProviderQualifications({
        [provider]: result.qualification,
      })[provider];
      setProviderQualifications((current) => ({
        ...current,
        ...(presentedQualification ? { [provider]: presentedQualification } : {}),
      }));
      clearAutomaticQualificationSuppression(suppressionKey);
      setProviderQualificationFailures((current) => {
        if (!(provider in current)) return current;
        const next = { ...current };
        delete next[provider];
        return next;
      });
      setQualificationProgress({
        projectName,
        provider,
        label,
        stage: 'refreshing',
      });
      // The provider refresh below replaces the pre-qualification capability
      // snapshot. Model discovery is tied to that refreshed capability so it
      // cannot race ahead with stale admission evidence or run twice.
      setProviderRefreshNonce((value) => value + 1);
    } catch (error: any) {
      if (qualificationLeaseRef.current !== lease) return;
      setConnectionNotice(null);
      setQualificationProgress(null);
      const presentedError = safeProjectQualificationError(error, label);
      let suppression: AutomaticQualificationSuppression | null = null;
      if (suppressionKey) {
        suppression = suppressAutomaticQualification(
          suppressionKey,
          presentedError.recovery === 'HOST_MAINTENANCE' && presentedError.retryable === false
            ? { disposition: 'HOST_MAINTENANCE' }
            : presentedError.recovery === 'AI_SETTINGS'
              ? { disposition: 'AI_SETTINGS' }
              : presentedError.code === 'PROJECT_QUALIFICATION_RATE_LIMITED'
                ? { disposition: 'RATE_LIMITED', retryAt: presentedError.retryAt }
                : presentedError.retryable === false
                  ? {
                      disposition: presentedError.code === 'PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE'
                        ? 'IDENTITY_UNAVAILABLE_NON_RETRYABLE'
                        : 'NON_RETRYABLE',
                    }
                  : { disposition: 'AUTO_ONLY' },
        );
      }
      const presentedFailure = suppression && (
        presentedError.retryable === false
        || presentedError.code === 'PROJECT_QUALIFICATION_RATE_LIMITED'
      )
        ? {
            ...presentedError,
            suppressionExpiresAt: new Date(suppression.expiresAt).toISOString(),
          }
        : presentedError;
      setSessionError(presentedFailure.message);
      setProviderQualificationFailures((current) => ({
        ...current,
        [provider]: presentedFailure,
      }));
      // Preparing a provider from the picker is intentionally one click. If
      // that provider fails before it becomes the active binding, keep the
      // failure attached to the row the user chose and reopen that row after
      // the qualification lease releases. Otherwise the picker disappears
      // and the still-active provider's banner hides the actual failure.
      if (provider !== providerRef.current) {
        setProviderReviewRequest((current) => ({
          provider,
          token: (current?.token || 0) + 1,
        }));
      }
    } finally {
      if (qualificationLeaseRef.current === lease) {
        qualificationLeaseRef.current = null;
        onActivityChangeRef.current?.(lease, false);
        setQualificationPending(false);
      }
    }
  }, [
    agentZeroProjectModels,
    agentZeroQualificationModel,
    actorUserId,
    availableModels,
    projectName,
  ]);

  useEffect(() => () => {
    const lease = qualificationLeaseRef.current;
    if (!lease) return;
    qualificationLeaseRef.current = null;
    onActivityChangeRef.current?.(lease, false);
  }, []);

  const dismissProjectChat = useCallback(() => {
    if (sessionControlMutationRef.current || projectTransitionActivityRef.current) return;
    const qualificationLease = qualificationLeaseRef.current;
    if (qualificationLease) {
      const released = onActivityChangeRef.current?.(qualificationLease, false);
      if (released === false) return;
      qualificationLeaseRef.current = null;
      setQualificationPending(false);
      setQualificationProgress(null);
    }
    onClose();
  }, [onClose]);

  // ── Model change ──
  const handleModelChange = useCallback(async (newModel: string) => {
    if (
      sessionControlMutationRef.current
      || projectTransitionActivityRef.current
      || !sessionReady
      || isStreamActiveRef.current
      || sendPendingRef.current
      || providerCapabilitiesRef.current.find((entry) => entry.provider === providerRef.current)?.supportsModelSelection !== true
    ) return;
    const normalizedModel = canonicalizePortalModelId(newModel);
    if (normalizedModel === modelRef.current) return;
    const previousModel = modelRef.current;
    const provider = serverSelectedProviderRef.current;
    const verifiedSession = sessionKeyRef.current;
    const stateVersion = projectChatStateVersionRef.current;
    if (
      !provider
      || !verifiedSession
      || !Number.isSafeInteger(stateVersion)
      || stateVersion == null
      || stateVersion < 0
    ) {
      setSessionError('Project provider verification is required before changing models.');
      return;
    }
    if (
      (provider === 'OPENCLAW' || provider === 'AGENT_ZERO')
      && !availableModels.includes(normalizedModel)
    ) {
      setSessionError(`${normalizedModel} is not available to this exact Project agent.`);
      return;
    }
    const activity: ProjectModelSwitchActivity = Object.freeze({
      kind: 'model-switch' as const,
      projectName,
      provider,
      sessionKey: verifiedSession,
      previousModel,
      requestedModel: normalizedModel,
      stateVersion,
      token: ++projectTransitionActivityTokenRef.current,
    });
    if (!claimProjectTransitionActivity(activity)) {
      setSessionError('Another project operation is still running. Wait for it to finish before changing models.');
      return;
    }
    setSelectedModel(normalizedModel);
    modelRef.current = normalizedModel;
    providerTransitionPendingRef.current = true;
    setProviderTransitionPending(true);
    setSessionReady(false);
    setSessionError(null);
    setConnectionNotice(`Switching this project session to ${normalizedModel}…`);
    // Patch the session model only for an actual user-initiated model change.
    if (sessionKeyRef.current) {
      try {
        const data = await ensureVerifiedProjectModel(normalizedModel);
        if (projectTransitionActivityRef.current !== activity) {
          throw new ProjectReplayContractError('Project model-switch ownership changed before the server response settled.');
        }
        const resolvedModel = canonicalizePortalModelId(String(data?.model || normalizedModel));
        setSelectedModel(resolvedModel);
        modelRef.current = resolvedModel;
        // A server-verified manual model is sufficient for native Project
        // providers even if their optional catalog request failed.
        setModelCatalogError(null);
        setSessionReady(true);
      } catch (error: any) {
        setSelectedModel(previousModel);
        modelRef.current = previousModel;
        const message = error?.response?.data?.error || error?.message || 'Model change failed';
        setSessionError(message);
        appendSystemNotice(`Model change failed: ${message}`);
        if (providerRef.current === 'AGENT_ZERO'
          || error instanceof ProjectReplayContractError
          || isProjectProviderReverificationError(error)) {
          const failedCapabilities = buildUnavailableProjectProviderCapabilities(
            `Project provider selection must be re-verified: ${message}`,
          );
          providerCapabilitiesRef.current = failedCapabilities;
          setProviderCapabilities(failedCapabilities);
          serverSelectedProviderRef.current = null;
          setServerSelectedProvider(null);
          providerVerificationStateRef.current = 'failed';
          setProviderVerificationState('failed');
          setTransportConnected(false);
        } else {
          setSessionReady(true);
        }
      }
    } else {
      setSessionReady(true);
    }
    if (projectTransitionActivityRef.current === activity) {
      providerTransitionPendingRef.current = false;
      setProviderTransitionPending(false);
      setConnectionNotice(null);
    }
  }, [appendSystemNotice, availableModels, claimProjectTransitionActivity, ensureVerifiedProjectModel, projectName, sessionReady, setSessionReady]);

  const applyProjectSessionControlValue = useCallback((
    kind: ProjectSessionControlKind,
    value: ProjectSessionControlValue,
  ) => {
    if (kind === 'thinking') {
      const next = value as ThinkingLevel;
      thinkingLevelRef.current = next;
      setThinkingLevel(next);
      return;
    }
    if (kind === 'reasoning') {
      const next = value as ReasoningVisibility;
      reasoningVisibilityRef.current = next;
      setReasoningVisibility(next);
      return;
    }
    const next = Boolean(value);
    fastModeEnabledRef.current = next;
    setFastModeEnabled(next);
  }, []);

  const isVerifiedProjectSessionControlTarget = useCallback((
    provider: ProjectChatProviderName,
    session: string,
  ) => {
    const capability = providerCapabilitiesRef.current.find(
      (entry) => entry.provider === provider,
    );
    return provider === 'OPENCLAW'
      && sessionReadyRef.current
      && providerVerificationStateRef.current === 'ready'
      && !providerTransitionPendingRef.current
      && serverSelectedProviderRef.current === provider
      && providerRef.current === provider
      && sessionKeyRef.current === session
      && capability?.selectable === true
      && capability.executionScope === 'PROJECT_SANDBOX'
      && Boolean(projectIdentityIdRef.current);
  }, []);

  const mutateProjectSessionControl = useCallback(async (
    kind: ProjectSessionControlKind,
    requested: ProjectSessionControlValue,
    previous: ProjectSessionControlValue,
  ) => {
    const mutationSession = sessionKeyRef.current;
    const mutationProvider = providerRef.current;
    if (
      !mutationSession
      || mutationProvider !== 'OPENCLAW'
      || projectTransitionActivityRef.current
      || !isVerifiedProjectSessionControlTarget(mutationProvider, mutationSession)
    ) {
      setSessionControlError('Project provider verification is required before changing session controls.');
      return;
    }

    const active = sessionControlMutationRef.current;
    if (active && active.session === mutationSession && active.provider === mutationProvider) return;
    const activity = Object.freeze({
      kind: 'session-control' as const,
      projectName,
      provider: 'OPENCLAW' as const,
      sessionKey: mutationSession,
      control: kind,
      token: ++sessionControlActivityTokenRef.current,
    });
    if (onActivityChangeRef.current?.(activity, true) === false) {
      setSessionControlError('Another project operation is still running. Wait for it to finish before changing session controls.');
      return;
    }
    const snapshot: ProjectSessionControlMutation = Object.freeze({
      generation: ++sessionControlGenerationRef.current,
      kind,
      provider: mutationProvider,
      session: mutationSession,
      previous,
      requested,
      activity,
    });
    sessionControlMutationRef.current = snapshot;
    setSessionControlMutation(kind);
    setSessionControlError(null);
    applyProjectSessionControlValue(kind, requested);

    const ownsCurrentTarget = () => (
      sessionControlMutationRef.current === snapshot
      && sessionControlGenerationRef.current === snapshot.generation
      && sessionKeyRef.current === snapshot.session
      && providerRef.current === snapshot.provider
    );
    const isCurrent = () => (
      ownsCurrentTarget()
      && isVerifiedProjectSessionControlTarget(snapshot.provider, snapshot.session)
    );
    const failClosedAfterVerificationChange = () => {
      if (!ownsCurrentTarget()) return false;
      // The provider/readiness surface already owns the recovery message.
      // Revert the optimistic control without creating a second error banner.
      applyProjectSessionControlValue(snapshot.kind, snapshot.previous);
      return true;
    };
    const setting = kind === 'thinking'
      ? { thinking: requested }
      : kind === 'reasoning'
        ? { reasoning: requested }
        : { fastMode: requested };

    try {
      const patchResult = await gatewayAPI.patchSession(snapshot.session, setting, snapshot.provider);
      if (!isCurrent()) {
        failClosedAfterVerificationChange();
        return;
      }
      let canonical = readProjectSessionControlValue(patchResult, kind);
      if (canonical === undefined) {
        const fresh = await gatewayAPI.sessionInfo(snapshot.session, { silent: true });
        if (!isCurrent()) {
          failClosedAfterVerificationChange();
          return;
        }
        canonical = readProjectSessionControlValue(fresh, kind);
      }
      if (canonical === undefined) throw new Error('The server did not confirm the updated session setting.');
      applyProjectSessionControlValue(kind, canonical);
    } catch (error: any) {
      if (!isCurrent()) {
        failClosedAfterVerificationChange();
        return;
      }
      let canonical = snapshot.previous;
      try {
        const fresh = await gatewayAPI.sessionInfo(snapshot.session, { silent: true });
        if (!isCurrent()) return;
        canonical = readProjectSessionControlValue(fresh, kind) ?? snapshot.previous;
      } catch {
        // Fall back to the last confirmed value after an ambiguous failure.
      }
      applyProjectSessionControlValue(kind, canonical);
      if (canonical !== snapshot.requested) {
        const detail = error?.response?.data?.detail
          || error?.response?.data?.error
          || error?.message
          || `Failed to update ${kind === 'fastMode' ? 'fast mode' : kind}.`;
        setSessionControlError(String(detail));
      }
      console.error(`[ProjectChatPanel] Failed to patch ${kind}:`, error);
    } finally {
      if (sessionControlMutationRef.current === snapshot) {
        sessionControlMutationRef.current = null;
        onActivityChangeRef.current?.(snapshot.activity, false);
        setSessionControlMutation(null);
      }
    }
  }, [applyProjectSessionControlValue, isVerifiedProjectSessionControlTarget, projectName]);

  const handleThinkingLevelChange = useCallback(async (nextLevel: ThinkingLevel) => {
    await mutateProjectSessionControl('thinking', nextLevel, thinkingLevelRef.current);
  }, [mutateProjectSessionControl]);

  const handleReasoningVisibilityChange = useCallback(async (nextLevel: ReasoningVisibility) => {
    await mutateProjectSessionControl('reasoning', nextLevel, reasoningVisibilityRef.current);
  }, [mutateProjectSessionControl]);

  const handleFastModeToggle = useCallback(async () => {
    const previous = fastModeEnabledRef.current;
    await mutateProjectSessionControl('fastMode', !previous, previous);
  }, [mutateProjectSessionControl]);

  // ── Speech recognition ──
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const SpeechRecognition = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const speechSupported = !!SpeechRecognition;

  const toggleMic = useCallback(() => {
    if (!SpeechRecognition) return;
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results).map((r: any) => r[0].transcript).join('');
        setInput(transcript);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
    }
  }, [SpeechRecognition, isListening]);

  // Cleanup recognition on unmount
  useEffect(() => {
    return () => { recognitionRef.current?.stop(); };
  }, []);

  // ── Drag & drop ──
  const [dragOver, setDragOver] = useState(false);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  const handleProjectMigration = useCallback(async () => {
    if (projectMigrationPending) return;
    setProjectMigrationPending(true);
    setProjectMigrationError(null);
    try {
      const result = await projectsAPI.migrateLegacyProjectInPlace(projectName);
      if (
        result?.migrated !== true
        || !result.projectId
        || !result.projectName
        || result.projectName === projectName
        || result.sourceProjectId !== projectMoveNotice?.projectId
        || result.sourceProjectName !== projectName
        || !Number.isSafeInteger(result.generation)
        || !result.integrity?.manifestSha256
      ) {
        throw new Error('Portal could not confirm the project migration.');
      }
      setProjectMoveNotice(null);
      await onProjectPrepared?.(result.projectName);
      setConnectionNotice('Checking Project Chat providers…');
      setProviderRefreshNonce((value) => value + 1);
    } catch (error: any) {
      setProjectMigrationError(
        String(
          error?.response?.data?.error
          || 'Portal could not finish preparing this project. Its original files remain unchanged.',
        ),
      );
    } finally {
      setProjectMigrationPending(false);
    }
  }, [onProjectPrepared, projectMigrationPending, projectMoveNotice?.projectId, projectName]);

  const recoverProjectChatError = useCallback(async () => {
    if (!sessionError || sessionRecoveryPending) return;
    if (sessionError === 'This project was deleted.') {
      dismissProjectChat();
      return;
    }

    setSessionRecoveryPending(true);
    setConnectionNotice('Refreshing Project Chat state…');
    try {
      if (modelCatalogError && sessionError === modelCatalogError) {
        await loadAvailableModels();
        setSessionError(null);
        return;
      }

      if (
        providerVerificationStateRef.current !== 'ready'
        || !serverSelectedProviderRef.current
      ) {
        // The provider discovery request is itself the safe recovery path: it
        // re-reads immutable identity, coordination, qualifications, runtime
        // availability, and any recoverable expired lease before the panel can
        // send again.
        setSessionError(null);
        setProviderRefreshNonce((value) => value + 1);
        return;
      }

      const currentSession = sessionKeyRef.current || '';
      await loadHistorySnapshot(currentSession);
      await refreshPendingQuestions();
      if (activeReplayTurnIdRef.current || isStreamActiveRef.current) {
        setReplayRetryNonce((value) => value + 1);
      } else {
        setProviderRefreshNonce((value) => value + 1);
      }
      setSessionError(null);
    } catch (error: any) {
      setSessionError(
        error?.response?.data?.error
          || error?.message
          || 'Project Chat recovery did not complete. Try again.',
      );
    } finally {
      setConnectionNotice(null);
      setSessionRecoveryPending(false);
    }
  }, [
    dismissProjectChat,
    loadAvailableModels,
    loadHistorySnapshot,
    modelCatalogError,
    refreshPendingQuestions,
    sessionError,
    sessionRecoveryPending,
  ]);

  const sessionRecoveryLabel = sessionError === 'This project was deleted.'
    ? 'Close Project Chat'
    : modelCatalogError && sessionError === modelCatalogError
      ? 'Retry model catalog'
      : pendingSend
        ? 'Check delivery state'
        : isRunning
          ? 'Reconnect active turn'
          : providerVerificationState !== 'ready'
            ? 'Recheck Project Chat provider'
            : 'Refresh Project Chat state';

  // ── Render ──
  const projectMovePanel = projectMoveNotice ? (
    <motion.div
      role={isMobile ? 'dialog' : 'region'}
      aria-modal={isMobile ? 'true' : undefined}
      aria-label={`Project Chat for ${projectName}`}
      initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      animate={isMobile ? { opacity: 1, x: 0 } : { width: 448, opacity: 1 }}
      exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={isMobile
        ? 'flex h-full w-full flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
        : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/95 backdrop-blur-sm'}
    >
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bot size={14} className="flex-shrink-0 text-emerald-400" />
          <span className="text-xs font-medium text-white">Project Chat</span>
          <span className="truncate text-[10px] text-slate-500" title={projectName}>{projectName}</span>
        </div>
        <button
          type="button"
          aria-label="Close project chat"
          onClick={onClose}
          className="rounded p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto p-5">
        <section
          aria-labelledby="project-chat-move-title"
          className="w-full max-w-sm rounded-2xl border border-amber-400/20 bg-amber-500/[0.07] p-5 shadow-xl shadow-black/20"
        >
          <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-amber-400/10 text-amber-200">
            <Bot size={20} />
          </div>
          <h2 id="project-chat-move-title" className="text-sm font-semibold text-white">
            {projectMoveNotice.title}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-300">
            {projectMoveNotice.message}
          </p>
          {projectMigrationError && (
            <p role="alert" className="mt-3 rounded-lg border border-red-400/25 bg-red-500/10 p-2 text-[11px] leading-relaxed text-red-100">
              {projectMigrationError}
            </p>
          )}
          <button
            type="button"
            onClick={() => { void handleProjectMigration(); }}
            disabled={projectMigrationPending}
            data-contrast-check="legacy-migration-primary"
            className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 py-2 text-xs font-semibold text-slate-950 transition-opacity disabled:cursor-wait disabled:opacity-70"
          >
            {projectMigrationPending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Checking project safety…
              </>
            ) : (
              <>
                Check and prepare project
                <ChevronRight size={14} />
              </>
            )}
          </button>
          <a
            href={`/api/projects/${encodeURIComponent(projectName)}/download?mode=full`}
            className="mt-3 inline-flex min-h-[36px] w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
          >
            Download a backup (optional)
          </a>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
            Portal creates a manifest-verified Project Chat copy with a new name. The legacy source, its share links, hosted apps, deployment, and older agent state stay untouched.
          </p>
        </section>
      </div>
    </motion.div>
  ) : null;

  const panel = (
    <motion.div
      role={isMobile ? 'dialog' : undefined}
      aria-modal={isMobile ? 'true' : undefined}
      aria-label={isMobile ? `Project Chat for ${projectName}` : undefined}
      initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      animate={isMobile ? { opacity: 1, x: 0 } : { width: 448, opacity: 1 }}
      exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={isMobile
        ? 'flex h-full w-full flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
        : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/95 backdrop-blur-sm'}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Bot size={14} className="text-emerald-400 flex-shrink-0" />
          <span className="text-xs font-medium text-white flex-shrink-0">Agent</span>
          <span className="text-[10px] text-slate-500 truncate" title={projectName}>{projectName}</span>
          <span
            aria-label={`Project transport ${transportConnected ? 'connected' : 'disconnected'}`}
            title={`Project transport ${transportConnected ? 'connected' : 'disconnected'}`}
            className={`text-[8px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${transportConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}
          >
            {transportConnected ? '●' : '○'}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 relative">
          <ProjectProviderMenu
            providers={providerCapabilities}
            qualifications={providerQualifications}
            qualificationFailures={providerQualificationFailures}
            hostRecoveryRole={hostRecoveryRole}
            qualificationRetryNow={qualificationRetryClock}
            selectedProvider={selectedProvider}
            disabled={!providerSwitchAllowed || qualificationPending || sessionControlMutation !== null || projectTransitionActivity !== null}
            qualificationPending={qualificationPending}
            onSelect={(provider) => { void handleProviderChange(provider); }}
            onQualify={(provider) => {
              if (provider !== 'GROK') void handleProviderQualification(provider);
            }}
            onReviewAgentZero={reviewAgentZeroProjectModels}
            agentZeroModel={agentZeroQualificationModel}
            agentZeroModels={agentZeroProjectModels}
            agentZeroModelsLoading={agentZeroModelsLoading}
            agentZeroModelsError={agentZeroModelsError}
            onAgentZeroModelChange={setAgentZeroQualificationModel}
            reviewRequest={providerReviewRequest}
          />
          {/* Model selector */}
          {providerSupportsModelSelection && (
            <ProjectModelPicker
              value={selectedModel}
              onChange={handleModelChange}
              models={availableModels}
              loading={modelCatalogLoading}
              error={modelCatalogError}
              disabled={!providerModelSelectionAllowed || sessionControlMutation !== null || projectTransitionActivity !== null}
              exactCatalogOnly={selectedProvider === 'OPENCLAW' || selectedProvider === 'AGENT_ZERO'}
              onRetry={() => { void loadAvailableModels().catch(() => undefined); }}
            />
          )}
          <button
            ref={sessionControlsTriggerRef}
            type="button"
            aria-label="Session controls"
            aria-haspopup="dialog"
            aria-expanded={showSessionControls}
            onClick={() => {
              if (
                showSessionControls
                && (sessionControlMutationRef.current || projectTransitionActivityRef.current)
              ) return;
              setShowSessionControls(v => !v);
            }}
            className={`p-1 rounded transition-colors ${showSessionControls ? 'bg-cyan-500/15 text-cyan-300' : 'hover:bg-white/5 text-slate-500 hover:text-cyan-300'}`}
            title="Session Controls"
          >
            <Wrench size={12} />
          </button>
          <AnchoredPopover
            open={showSessionControls}
            anchorRef={sessionControlsTriggerRef}
            width={288}
            mobileBreakpoint={767}
            onDismiss={(reason) => {
              if (sessionControlMutationRef.current) return;
              setShowSessionControls(false);
              if (reason === 'escape') sessionControlsTriggerRef.current?.focus();
            }}
          >
            <div role="dialog" aria-label="Session controls" aria-busy={sessionControlMutation !== null} className="min-h-0 max-h-full w-full overflow-y-auto overscroll-contain rounded-xl border border-theme-border bg-theme-surface p-3 shadow-2xl backdrop-blur-xl">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-xs font-medium text-white">Session Controls</div>
                  <div className="text-[10px] text-slate-500">Provider-bound controls for this isolated project workspace.</div>
                </div>
                <button
                  type="button"
                  aria-label="Close session controls"
                  disabled={sessionControlMutation !== null}
                  onClick={() => {
                    if (!sessionControlMutationRef.current) setShowSessionControls(false);
                  }}
                  className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white disabled:cursor-wait disabled:opacity-40"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="space-y-1.5 text-[11px] text-slate-300 mb-3">
                <div><span className="text-slate-500">Provider:</span> <span className="text-slate-200">{selectedProviderCapability?.displayName || getProjectProviderLabel(selectedProvider)}</span></div>
                <div><span className="text-slate-500">Runtime:</span> <span className="text-slate-200 break-all">{selectedRuntime}</span></div>
                <div><span className="text-slate-500">Scope:</span> <span className="text-emerald-300">PROJECT_SANDBOX</span></div>
                <div><span className="text-slate-500">Agent:</span> <span className="text-slate-200 break-all">{agentId || 'starting…'}</span></div>
                <div><span className="text-slate-500">Session:</span> <span className="text-slate-200 break-all">{sessionKey || 'starting…'}</span></div>
                <div><span className="text-slate-500">Model:</span> <span className="text-slate-200">{providerSupportsModelSelection ? selectedModel || 'not set' : 'provider-managed'}</span></div>
                <div><span className="text-slate-500">Authentication:</span> <span className={selectedProviderCapability?.requiresOAuth ? 'text-cyan-300' : 'text-slate-300'}>{selectedProviderCapability?.requiresOAuth ? 'OAuth required' : 'Portal-managed'}</span></div>
                <div><span className="text-slate-500">Connection:</span> <span className={transportConnected ? 'text-emerald-300' : 'text-amber-300'}>{transportConnected ? 'connected' : 'disconnected'}</span></div>
                <div><span className="text-slate-500">Attachments:</span> <span className={providerSupportsAttachments ? 'text-emerald-300' : 'text-amber-300'}>{providerSupportsAttachments ? 'available' : 'not supported'}</span></div>
              </div>
              {sessionControlMutation && (
                <div role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-2 text-[10px] text-cyan-100">
                  <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                  {sessionControlMutation === 'thinking'
                    ? 'Saving thinking level…'
                    : sessionControlMutation === 'reasoning'
                      ? 'Saving reasoning visibility…'
                      : 'Saving fast mode…'}
                </div>
              )}
              {sessionControlError && (
                <div role="alert" className="mb-3 rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-2 text-[10px] leading-relaxed text-red-200">
                  {sessionControlError}
                </div>
              )}
              {providerCapabilities.some((entry) => !entry.selectable) && (
                <details className="mb-3 rounded-lg border border-amber-500/10 bg-amber-500/[0.04] px-2 py-2 text-[10px] leading-relaxed text-slate-400">
                  <summary className="cursor-pointer text-amber-200/80">Why other providers are unavailable</summary>
                  <div className="mt-2 space-y-2">
                    {providerCapabilities.filter((entry) => !entry.selectable).map((entry) => (
                      <div key={entry.provider}>
                        <span className="font-medium text-slate-200">{entry.displayName}:</span> {entry.reason}
                      </div>
                    ))}
                    <div>Host-operator Agent Chat access is never inherited by a Project Chat provider.</div>
                  </div>
                </details>
              )}
              {selectedProvider === 'OPENCLAW' && <>
              <div className="mb-3 rounded-lg border border-white/6 bg-black/20 px-2 py-2">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles size={12} className={thinkingLevel !== 'off' ? 'text-violet-300' : 'text-slate-500'} />
                  <div>
                    <div className="text-[11px] font-medium text-white">Thinking Level</div>
                    <div className="text-[10px] text-slate-500">Controls reasoning depth for this project agent session.</div>
                  </div>
                </div>
                <input
                  aria-label="Thinking level"
                  type="range"
                  min={0}
                  max={THINKING_LEVELS.length - 1}
                  step={1}
                  value={Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel))}
                  disabled={!projectSessionMutationControlsAllowed || sessionControlMutation !== null}
                  onChange={(e) => {
                    const next = THINKING_LEVELS[Number(e.target.value)] || 'off';
                    void handleThinkingLevelChange(next);
                  }}
                  className="w-full accent-violet-400"
                />
                <div className="mt-1 text-[10px] text-slate-400">
                  Current: <span className={`font-semibold uppercase ${thinkingLevel === 'adaptive' ? 'text-cyan-300' : 'text-violet-300'}`}>{THINKING_LEVEL_LABELS[thinkingLevel]}</span>
                </div>
              </div>
              <div className="mb-3 rounded-lg border border-white/6 bg-black/20 px-2 py-2">
                <div className="flex items-center gap-2 mb-2">
                  <MessageSquare size={12} className={reasoningVisibility !== 'off' ? 'text-cyan-300' : 'text-slate-500'} />
                  <div>
                    <div className="text-[11px] font-medium text-white">Reasoning Visibility</div>
                    <div className="text-[10px] text-slate-500">Shows readable OpenClaw reasoning summaries when the provider exposes them.</div>
                  </div>
                </div>
                <select
                  aria-label="Reasoning visibility"
                  value={reasoningVisibility}
                  onChange={(e) => { void handleReasoningVisibilityChange(e.target.value as ReasoningVisibility); }}
                  disabled={!projectSessionMutationControlsAllowed || sessionControlMutation !== null}
                  className="w-full rounded-lg border border-white/10 bg-[#111735] px-2 py-1.5 text-[11px] text-slate-200 disabled:opacity-50"
                >
                  <option value="off">Hidden</option>
                  <option value="on">Visible / persistent</option>
                  <option value="stream">Stream when supported</option>
                </select>
                <div className="mt-1 text-[10px] text-slate-400">
                  Current: <span className="font-semibold uppercase text-cyan-300">{REASONING_VISIBILITY_LABELS[reasoningVisibility]}</span>
                </div>
              </div>

              {(supportsOpenClawFastModeModel(selectedModel) || fastModeEnabled) && (
                <div className="mb-3 rounded-lg border border-white/6 bg-black/20 px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Radio size={12} className={fastModeEnabled ? 'text-amber-300' : 'text-slate-500'} />
                      <div>
                        <div className="text-[11px] font-medium text-white">Codex Fast Mode</div>
                        <div className="text-[10px] text-slate-500">Native OpenClaw fast mode for Codex project sessions.</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Toggle Codex fast mode"
                      aria-pressed={fastModeEnabled}
                      onClick={() => { void handleFastModeToggle(); }}
                      disabled={!projectSessionMutationControlsAllowed || sessionControlMutation !== null}
                      className={`relative h-5 w-10 rounded-full transition-colors ${fastModeEnabled ? 'bg-amber-500' : 'bg-white/10'} disabled:opacity-50`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${fastModeEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                      />
                    </button>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    Current: <span className="text-slate-200">{fastModeEnabled ? 'enabled' : 'disabled'}</span> for <span className="font-mono text-slate-300">{selectedModel || 'default'}</span>
                  </div>
                </div>
              )}
              </>}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button onClick={() => { void showSessionStatus(); setShowSessionControls(false); }} disabled={sessionControlMutation !== null} className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-200 disabled:cursor-wait disabled:opacity-50">Status</button>
                <button
                  onClick={() => { void exportChatMarkdown(); setShowSessionControls(false); }}
                  disabled={isExportingChat || sessionControlMutation !== null}
                  className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-200 disabled:cursor-wait disabled:opacity-50"
                >
                  {isExportingChat ? 'Exporting…' : 'Export'}
                </button>
                <button onClick={() => { if (isRunning) void cancelStream(); setShowSessionControls(false); }} className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-200 disabled:opacity-50" disabled={!isRunning || !providerSupportsAbort || sessionControlMutation !== null}>Stop</button>
                <button onClick={() => { void clearChat(); setShowSessionControls(false); }} disabled={!hasVerifiedProjectConnection || !providerSupportsReset || sessionControlMutation !== null} className="px-2 py-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-xs text-amber-200 disabled:opacity-50">New Session</button>
              </div>
              <div className="rounded-lg border border-white/6 bg-black/20 px-2 py-2 text-[10px] text-slate-400 leading-relaxed">
                Slash commands: <span className="text-slate-200">/new</span>, <span className="text-slate-200">/stop</span>, <span className="text-slate-200">/status</span>, <span className="text-slate-200">/models</span>, <span className="text-slate-200">/model &lt;id&gt;</span>, <span className="text-slate-200">/clear</span>, <span className="text-slate-200">/export</span>
              </div>
            </div>
          </AnchoredPopover>
          {/* Clear chat */}
          {messages.length > 0 && providerSupportsReset && (
            <button onClick={clearChat} disabled={!hasVerifiedProjectConnection || sessionControlMutation !== null} className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-amber-400 transition-colors disabled:cursor-wait disabled:opacity-40" title="Clear chat">
              <Trash2 size={11} />
            </button>
          )}
          {/* Close */}
          <button
            aria-label="Close project chat"
            disabled={sessionControlMutation !== null || projectTransitionActivity !== null}
            onClick={dismissProjectChat}
            className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white transition-colors disabled:cursor-wait disabled:opacity-40"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Drag overlay */}
      <AnimatePresence>
        {dragOver && providerSupportsAttachments && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-violet-500/10 backdrop-blur-sm border-2 border-dashed border-violet-500/40 rounded-lg"
          >
            <div className="text-sm text-violet-300 font-medium">Drop files here</div>
          </motion.div>
        )}
      </AnimatePresence>

      {historyError && (
        <div role="alert" className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          <MessageSquare size={12} className="flex-shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Project chat history could not be loaded.</div>
            <div className="mt-0.5 break-words text-amber-200/80">{historyError}</div>
          </div>
          <button
            type="button"
            aria-label="Retry project chat history"
            disabled={historyRetryPending}
            onClick={() => { void retryHistorySnapshot(); }}
            className="flex-shrink-0 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 font-medium text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-50"
          >
            {historyRetryPending ? 'Retrying…' : 'Retry history'}
          </button>
        </div>
      )}

      {/* Session error */}
      {sessionError && !showUnavailableProviderBanner && (
        <div role="alert" className="px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-400 flex items-center gap-2">
          <XCircle size={12} className="flex-shrink-0" />
          <span className="min-w-0 flex-1 break-words">{sessionError}</span>
          <button
            type="button"
            aria-label={sessionRecoveryLabel}
            disabled={sessionRecoveryPending}
            onClick={() => { void recoverProjectChatError(); }}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-red-400/25 bg-red-500/10 px-2 py-1 font-medium text-red-100 transition-colors hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-50"
          >
            {sessionRecoveryPending ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            {sessionRecoveryPending ? 'Recovering…' : sessionRecoveryLabel}
          </button>
        </div>
      )}

      {pendingSendStorageError && (
        <div role="alert" className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          <XCircle size={12} className="flex-shrink-0" />
          <span className="min-w-0 flex-1 break-words">{pendingSendStorageError}</span>
          <button
            type="button"
            aria-label="Clear Project Chat and start over"
            disabled={!hasVerifiedProjectConnection || !providerSupportsReset || sessionControlMutation !== null}
            onClick={() => { void clearChat(); }}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-red-400/25 bg-red-500/10 px-2 py-1 font-medium text-red-100 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={11} />
            Clear and start over
          </button>
        </div>
      )}

      {pendingSend && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
        >
          <RotateCcw size={12} className="flex-shrink-0" />
          <span className="min-w-0 flex-1">
            Delivery confirmation is pending. Project Chat is checking the durable message ID and will unlock automatically when status or any history page confirms it. Do not send a different message; use Clear Chat only if you intend to abandon this delivery.
          </span>
        </div>
      )}

      {showUnavailableProviderBanner && (
        <div
          role={unavailableProviderIsFailure ? 'alert' : 'status'}
          className={`flex items-center gap-2 border-b px-3 py-2 text-[10px] text-theme-text-muted ${
            unavailableProviderIsFailure
              ? 'border-red-500/15 bg-red-500/[0.04]'
              : 'border-amber-500/15 bg-amber-500/[0.04]'
          }`}
        >
          {unavailableProviderIsFailure ? (
            <XCircle size={12} className="flex-shrink-0 text-red-300" />
          ) : (
            <Radio size={12} className="flex-shrink-0 text-amber-300" />
          )}
          <div className="min-w-0 flex-1">
            <div className={`font-medium ${unavailableProviderIsFailure ? 'text-red-300' : 'text-amber-200'}`}>
              {providerVerificationState === 'failed'
                ? 'Project Chat could not open'
                : directQualificationFailure
                  ? 'Provider preparation needs attention'
                  : 'Prepare a provider to start chatting'}
            </div>
            <div className="mt-0.5 truncate">{unavailableProviderDetail}</div>
            {hostRecoveryRole !== 'USER' && directQualificationFailure?.operatorDiagnostic && (
              <div className="mt-1 whitespace-pre-wrap break-words text-amber-200">
                OpenClaw gateway{' '}
                <code>
                  {directQualificationFailure.operatorDiagnostic.operation}
                  {directQualificationFailure.operatorDiagnostic.errorCode
                    ? ` ${directQualificationFailure.operatorDiagnostic.errorCode}`
                    : ''}
                </code>
                {' — '}{directQualificationFailure.operatorDiagnostic.errorMessage}
              </div>
            )}
          </div>
          {directQualificationProvider && !directQualificationRetryBlocked && (
            <button
              type="button"
              aria-label={directAgentZeroNeedsModelReview
                ? 'Review Agent Zero connected models'
                : `Prepare ${getProjectProviderLabel(directQualificationProvider)} for this project`}
              disabled={qualificationPending || projectTransitionActivity !== null || sessionControlMutation !== null}
              onClick={() => {
                if (directAgentZeroNeedsModelReview) {
                  setProviderReviewRequest((current) => ({
                    provider: 'AGENT_ZERO',
                    token: (current?.token || 0) + 1,
                  }));
                  return;
                }
                void handleProviderQualification(directQualificationProvider);
              }}
              className="flex-shrink-0 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 font-medium text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-50"
            >
              {directAgentZeroNeedsModelReview
                ? 'Review Agent Zero models'
                : `Prepare ${getProjectProviderLabel(directQualificationProvider)}`}
            </button>
          )}
          {directQualificationRetryBlocked ? (
            directQualificationRetryDeferred && directQualificationRetryAt ? (
              <span className="flex-shrink-0 font-medium text-amber-200">
                Try again after{' '}
                <time dateTime={directQualificationRetryAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  }).format(new Date(directQualificationRetryAt))}
                </time>
              </span>
            ) : directQualificationProvider
              && directQualificationFailure?.recovery === 'HOST_MAINTENANCE' ? (
              <div className="flex flex-shrink-0 items-center gap-2">
                {hostRecoveryAction ? (
                  <a
                    href={hostRecoveryAction.href}
                    className="rounded-md border border-violet-400/25 bg-violet-500/10 px-2 py-1 font-medium text-violet-100 transition-colors hover:bg-violet-500/20"
                  >
                    {hostRecoveryAction.label}
                  </a>
                ) : (
                  <span className="font-medium text-amber-200">
                    Contact an Owner or Sub Admin
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Recheck ${getProjectProviderLabel(directQualificationProvider)} after host repair`}
                  disabled={qualificationPending || projectTransitionActivity !== null || sessionControlMutation !== null}
                  onClick={() => { void handleProviderQualification(directQualificationProvider); }}
                  className="rounded-md border border-theme-border bg-theme-surface px-2 py-1 font-medium text-theme-text transition-colors hover:bg-theme-bg disabled:cursor-wait disabled:opacity-50"
                >
                  Recheck after repair
                </button>
              </div>
            ) : directQualificationProvider
              && directQualificationFailure?.recovery === 'AI_SETTINGS' ? (
              <div className="flex flex-shrink-0 items-center gap-2">
                {authRecoveryAction ? (
                  <a
                    href={authRecoveryAction.href}
                    className="rounded-md border border-violet-400/25 bg-violet-500/10 px-2 py-1 font-medium text-violet-100 transition-colors hover:bg-violet-500/20"
                  >
                    {authRecoveryAction.label}
                  </a>
                ) : (
                  <span className="font-medium text-amber-200">
                    Contact an Owner or Sub Admin
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Recheck ${getProjectProviderLabel(directQualificationProvider)} after reconnecting`}
                  disabled={qualificationPending || projectTransitionActivity !== null || sessionControlMutation !== null}
                  onClick={() => { void handleProviderQualification(directQualificationProvider); }}
                  className="rounded-md border border-theme-border bg-theme-surface px-2 py-1 font-medium text-theme-text transition-colors hover:bg-theme-bg disabled:cursor-wait disabled:opacity-50"
                >
                  Recheck after reconnecting
                </button>
              </div>
            ) : (
              <span className="flex-shrink-0 font-medium text-amber-200">
                Provider review required
              </span>
            )
          ) : directQualificationProvider ? null : (
            <button
              type="button"
              onClick={() => setProviderRefreshNonce((value) => value + 1)}
              className="flex-shrink-0 rounded-md border border-theme-border bg-theme-surface px-2 py-1 font-medium text-theme-text hover:bg-theme-bg"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {pendingProviderSwitch && (
        <div className="px-3 py-2.5 bg-cyan-500/10 border-b border-cyan-500/20 text-[11px] text-cyan-100 flex items-center gap-3">
          <span className="flex-1 min-w-0">
            Switch to {getProjectProviderLabel(pendingProviderSwitch)}? This starts a fresh {getProjectProviderLabel(pendingProviderSwitch)} agent for this project.
            Your project conversation stays, but the new agent does not inherit the current agent's working memory.
          </span>
          <button
            onClick={() => { const target = pendingProviderSwitch; setPendingProviderSwitch(null); if (target) void handleProviderChange(target, { confirmed: true }); }}
            className="px-2.5 py-1 rounded-md bg-cyan-500/20 border border-cyan-400/30 hover:bg-cyan-500/30 transition-colors text-[10px] font-semibold text-cyan-100"
          >
            Switch provider
          </button>
          <button
            onClick={() => setPendingProviderSwitch(null)}
            className="px-2.5 py-1 rounded-md border border-white/10 hover:bg-white/5 transition-colors text-[10px] font-medium text-slate-300"
          >
            Cancel
          </button>
        </div>
      )}

      {qualificationProgress?.projectName === projectName && (
        <div
          role="status"
          aria-label={`${qualificationProgress.label} preparation progress`}
          aria-live="polite"
          aria-atomic="true"
          className="border-b border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[10px]"
        >
          <div className="mb-1.5 font-medium text-amber-100">
            Preparing {qualificationProgress.label} for this project
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {[
              { label: 'Request accepted', state: 'done' as const },
              {
                label: 'Preparing sandbox',
                state: qualificationProgress.stage === 'checking' ? 'active' as const : 'done' as const,
              },
              {
                label: 'Connecting agent',
                state: qualificationProgress.stage === 'refreshing' ? 'active' as const : 'pending' as const,
              },
            ].map((step) => (
              <span key={step.label} className="flex items-center gap-1.5">
                {step.state === 'done' ? (
                  <span aria-hidden="true" className="flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500/25 text-[8px] leading-none text-emerald-300">✓</span>
                ) : step.state === 'active' ? (
                  <Loader2 aria-hidden="true" size={12} className="animate-spin text-amber-300" />
                ) : (
                  <span aria-hidden="true" className="h-3 w-3 rounded-full border border-white/15" />
                )}
                <span className={step.state === 'pending' ? 'text-slate-500' : 'text-slate-200'}>{step.label}</span>
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-amber-200/75">
            You can close this panel. Preparation will continue in the background; reopen Project Chat to check the result.
          </p>
        </div>
      )}

      {connectionNotice && !sessionError && !qualificationProgress && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300 flex items-center gap-2"
        >
          <RotateCcw size={12} className={!transportConnected ? 'animate-spin' : ''} />
          <span className="flex-1 min-w-0">{connectionNotice}</span>
          {!transportConnected && (
            <button
              onClick={() => {
                if (sessionReady) {
                  setConnectionNotice('Retrying Portal replay…');
                  setReplayRetryNonce((value) => value + 1);
                } else {
                  setConnectionNotice('Retrying Project Chat provider check…');
                  setProviderRefreshNonce((value) => value + 1);
                }
              }}
              className="px-2 py-0.5 rounded-md border border-amber-500/20 hover:bg-amber-500/10 transition-colors text-[10px] font-medium"
            >
              Retry now
            </button>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        {isLoadingHistory && messages.length > 0 && (
          <div className="sticky top-0 z-[5] flex justify-center pt-2 px-3 pointer-events-none">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.06] border border-white/[0.08] text-[10px] text-slate-400 backdrop-blur-sm">
              <Loader2 size={10} className="animate-spin" />
              <span>Refreshing chat…</span>
            </div>
          </div>
        )}
        {isLoadingHistory && messages.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-slate-500" />
            <span className="ml-2 text-xs text-slate-500">Loading history…</span>
          </div>
        ) : messages.length === 0 && !isRunning ? (
          <div className="text-center py-12 px-4">
            <Bot size={28} className="mx-auto mb-2 text-emerald-400/30" />
            <p className="text-xs text-slate-500 mb-1">Ask Agent about <strong className="text-slate-400">{projectName}</strong></p>
            <p className="text-[10px] text-slate-600">Durable replay • Tool calls • File uploads</p>
          </div>
        ) : (
          <div className="py-2 space-y-0.5">
            {messageWindow.hiddenCount > 0 || historyPagination.hasMore || olderHistoryError ? (
              <div className="flex justify-center px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    if (messageWindow.hiddenCount > 0) revealEarlierMessages();
                    else loadOlderHistoryRef.current();
                  }}
                  disabled={isLoadingOlderHistory}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200 disabled:cursor-wait disabled:opacity-60"
                >
                  {isLoadingOlderHistory ? <Loader2 size={11} className="animate-spin" /> : null}
                  {isLoadingOlderHistory
                    ? 'Loading earlier messages…'
                    : olderHistoryError
                      ? 'Retry earlier messages'
                      : messageWindow.hiddenCount > 0
                        ? `Show earlier messages · ${messageWindow.hiddenCount} loaded`
                        : 'Load earlier messages'}
                </button>
                {olderHistoryError ? (
                  <span className="ml-2 max-w-[55%] self-center truncate text-[10px] text-amber-300" title={olderHistoryError}>
                    {olderHistoryError}
                  </span>
                ) : null}
              </div>
            ) : null}
            {messageWindow.items.map((msg, visibleIdx) => {
              const idx = visibleMessageStartIndex + visibleIdx;
              const isLast = idx === messages.length - 1;
              const isCurrentlyStreaming = isLast && isRunning && msg.role === 'assistant';

              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className="flex justify-end px-3 py-1.5 group">
                    <div className="max-w-[85%]">
                      <div className="rounded-2xl rounded-br-sm bg-blue-600/90 px-3 py-2 shadow-lg shadow-blue-600/10">
                        <p className="text-[11px] text-white leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
                      </div>
                    </div>
                  </div>
                );
              }

              if (msg.role === 'system') {
                return isCompactionNotice(msg.content) ? (
                  <CompactionNoticeBlock key={msg.id} content={msg.content} size="compact" />
                ) : (
                  <div key={msg.id} className="px-3 py-1.5">
                    <div className="mx-auto max-w-[90%] rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[10px] tracking-wide text-slate-400">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              if (msg.role === 'toolResult') {
                return <ToolResultPill key={msg.id} message={msg} />;
              }

              if (msg.role === 'assistant') {
                const toolCalls = msg.toolCalls || [];
                const rawOrderedSegments = Array.isArray(msg.segments)
                  ? msg.segments.filter((segment) => Boolean(segment?.text?.trim() || segment?.subject))
                  : [];
                const orderedSegments = rawOrderedSegments.length > 0
                  ? (
                      isCurrentlyStreaming
                        ? rawOrderedSegments
                        : reconcileProjectPresentationSegments(rawOrderedSegments, msg.content || '', toolCalls)
                    )
                  : rawOrderedSegments;
                const hasOrderedTimeline = orderedSegments.length > 0;
                const hasRunningTool = toolCalls.some(tc => tc.status === 'running');
                const suppressCurrentBubbleText = isCurrentlyStreaming && (
                  streamingPhase !== 'streaming'
                  || suppressLiveBubbleContentRef.current
                  || hasRunningTool
                  || !!activeToolName
                  || !!statusText
                );
                const canonicalContent = String(msg.content || '').trim();
                const rawVisibleContent = suppressCurrentBubbleText
                  || (!isCurrentlyStreaming && hasOrderedTimeline && Boolean(canonicalContent))
                  ? ''
                  : msg.content;
                const visibleThinkingContent = (isCurrentlyStreaming && thinkingContent.trim())
                  ? thinkingContent
                  : hasOrderedTimeline
                    ? ''
                  : (msg.thinkingContent || '');
                const visibleThinkingSubject = isCurrentlyStreaming
                  ? thinkingSubject
                  : hasOrderedTimeline ? '' : (msg.thinkingSubject || '');
                const hasThinkingContent = !!visibleThinkingContent.trim();
                const hasThinkingPresentation = hasThinkingContent || Boolean(visibleThinkingSubject);
                const liveStatusPlaceholder = isCurrentlyStreaming && !rawVisibleContent.trim() && !hasThinkingPresentation
                  ? String(statusText || (activeToolName ? getToolStatusText(activeToolName) : '') || '').trim()
                  : '';
                const visibleContent = rawVisibleContent || liveStatusPlaceholder;
                const hasContent = !!visibleContent.trim();
                const hasAssistantContent = !!rawVisibleContent.trim();
                const modelLabel = msg.model ? modelDisplayName(msg.model) : '';
                const timeLabel = msg.createdAt ? msg.createdAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
                const showMessageBubble = hasContent || (isCurrentlyStreaming && !hasThinkingPresentation);
                const showMeta = hasThinkingPresentation || hasAssistantContent || toolCalls.length > 0;

                return (
                  <div key={msg.id} className="px-3 py-1.5 group">

                    {hasOrderedTimeline ? (
                      <ProjectActivityTimeline
                        messageId={msg.id}
                        projectName={projectName}
                        segments={orderedSegments}
                        tools={toolCalls}
                      />
                    ) : (
                      <BoundedProjectToolCalls tools={toolCalls} messageKey={msg.id} />
                    )}

                    {(hasThinkingPresentation || showMessageBubble) && (
                      <div className="flex gap-2 items-start">
                        <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5 text-[8px] font-bold text-emerald-400">
                          AI
                        </div>
                        <div className="flex-1 min-w-0 max-w-[90%]">
                          {hasThinkingPresentation && (
                            <div className="mb-1.5 rounded-2xl rounded-bl-sm border border-violet-400/15 bg-violet-500/[0.08] px-3 py-2 shadow-lg shadow-black/10">
                              <div className="mb-1 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-wide text-violet-200/75">
                                <Sparkles size={10} className="text-violet-300/75" />
                                <span>thinking{visibleThinkingSubject ? ` · ${visibleThinkingSubject}` : ''}</span>
                                {isCurrentlyStreaming && !hasContent ? <span className="h-1 w-1 rounded-full bg-violet-300/70 animate-pulse" /> : null}
                              </div>
                              {hasThinkingContent ? (
                                <div className={`text-[11px] leading-relaxed ${isCurrentlyStreaming && !hasContent ? 'streaming-cursor' : ''}`}>
                                  <MarkdownRenderer
                                    content={visibleThinkingContent}
                                    isStreaming={isCurrentlyStreaming && !hasContent}
                                    hostFileContext={{ source: 'project', project: projectName }}
                                  />
                                </div>
                              ) : null}
                            </div>
                          )}

                          {showMessageBubble && (
                            <div
                              className={`rounded-2xl rounded-bl-sm px-3 py-2 transition-all duration-500 ${
                                rawVisibleContent && visibleContent.startsWith('⚠️')
                                  ? 'bg-red-500/10 border border-red-500/20'
                                  : isCurrentlyStreaming
                                    ? 'border border-dashed bg-[var(--accent-bg-subtle)]'
                                    : 'bg-white/[0.06] border border-solid border-white/[0.08]'
                              }`}
                              style={isCurrentlyStreaming && !(rawVisibleContent && visibleContent.startsWith('⚠️'))
                                ? { borderColor: 'var(--accent-border-hover)', boxShadow: '0 0 12px var(--accent-shadow), inset 0 0 0 1px var(--accent-bg)' }
                                : undefined
                              }
                            >
                              {rawVisibleContent && visibleContent.startsWith('⚠️') ? (
                                <div className="flex items-start gap-1.5">
                                  <XCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
                                  <div className="text-[11px] text-red-300">{visibleContent.replace(/^⚠️\s*/, '')}</div>
                                </div>
                              ) : (
                                <div className={`text-[11px] leading-relaxed ${isCurrentlyStreaming ? 'streaming-cursor' : ''}`}>
                                  <MarkdownRenderer
                                    content={visibleContent}
                                    isStreaming={isCurrentlyStreaming}
                                    hostFileContext={{ source: 'project', project: projectName }}
                                  />
                                </div>
                              )}
                            </div>
                          )}

                          {showMeta && (
                            <div className="flex items-center gap-2 mt-1 ml-1 min-h-[16px]">
                              {msg.provenance ? <span className="text-[10px] text-slate-500 italic truncate">{msg.provenance}</span> : null}
                              {modelLabel ? <span className="text-[10px] text-slate-500 truncate">• {modelLabel}</span> : null}
                              {timeLabel ? <span className="text-[10px] text-slate-600 truncate">• {timeLabel}</span> : null}
                              <div className="flex items-center gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                                {rawVisibleContent && <CopyButton text={msg.content} />}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return null;
            })}
            <div className="h-2" />
          </div>
        )}
      </div>

      {/* Scroll to bottom */}
      <AnimatePresence>
        {showScrollBtn && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute right-3 bottom-[118px] z-20"
          >
            <button
              onClick={() => { isScrolledUp.current = false; scrollToBottom(true); }}
              className="flex h-8 items-center gap-1 rounded-full bg-[#1A1F3A]/95 border border-white/[0.12] px-2.5 text-[10px] text-slate-300 hover:text-white hover:bg-[#252B4A] transition-colors shadow-lg backdrop-blur"
            >
              <ChevronDown size={12} />
              <span className="hidden sm:inline">Scroll down</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Project runtime status rail. Keep the verified idle state mounted so
          completion does not look like the provider disconnected. */}
      <div className={providerVerificationState === 'ready' ? 'min-h-[40px]' : undefined}>
        <AnimatePresence initial={false}>
          {(Boolean(idleProjectConnectionStatus) || isRunning || compactionPhase !== 'idle' || Boolean(statusText) || (!transportConnected && Boolean(connectionNotice))) && (
            <ComposerStatusBadge
              phase={isRunning ? streamingPhase : 'idle'}
              toolName={activeToolName}
              statusText={statusText}
              showConnectionLost={hasEverConnectedRef.current && !transportConnected && Boolean(connectionNotice)}
              compactionPhase={compactionPhase}
              contextSummary={idleProjectConnectionStatus ? {
                text: 'text-emerald-300/85',
                dot: 'bg-emerald-400',
                label: idleProjectConnectionStatus,
                detail: 'Durable replay ready',
              } : null}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Composer */}
      {selectedProvider === 'OPENCLAW' && pendingApproval && (
        <ExecApprovalModal
          key={pendingApproval.id}
          approval={pendingApproval}
          queueCount={pendingApprovals.length}
          onResolve={resolveApproval}
          onDismiss={dismissApproval}
        />
      )}

      <div className={`border-t transition-colors duration-300 flex-shrink-0 ${
        isRunning ? 'border-amber-500/20 bg-[#0a0a14]/50' : 'border-white/5 bg-[#0a0a14]/30'
      }`}>
        <div className="px-3 pt-2 pb-3">
          {pendingQuestions.map((request) => (
            <AskUserQuestionCard
              key={request.id}
              request={request}
              onSettled={settlePendingQuestion}
            />
          ))}

          {/* Attachment chips */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
          {pendingAttachments.map(att => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
                onRetry={() => { void uploadFile(att.file, att.id); }}
              />
            ))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex items-end gap-1.5">
            {/* Attach button */}
            {!isRunning && providerSendAllowed && providerSupportsAttachments && (
              <button
                type="button"
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
                className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors"
                title="Attach file"
              >
                <Paperclip size={14} />
              </button>
            )}
            <input
              aria-label="Choose files to attach"
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => handleFileSelect(e.target.files)}
            />

            {/* Text input */}
            <div className="relative flex-1">
              <textarea
                aria-label="Message project agent"
                ref={inputRef}
                value={input}
                onChange={e => {
                  const nextValue = e.target.value;
                  const preservedScope = preservedQueuedComposerDraftScopeRef.current;
                  if (preservedScope) {
                    if (nextValue.trim()) {
                      writeQueuedComposerDraft(preservedScope, nextValue);
                    } else {
                      clearPreservedQueuedComposerDraft();
                    }
                  }
                  setInput(nextValue);
                  refreshSlashAutocomplete(nextValue, e.target.selectionStart ?? nextValue.length);
                }}
                onKeyDown={e => {
                  if (showSlashMenu && slashCommands.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSelectedSlashIndex(prev => (prev + 1) % slashCommands.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSelectedSlashIndex(prev => (prev - 1 + slashCommands.length) % slashCommands.length);
                      return;
                    }
                    if (e.key === 'Tab' || e.key === 'Enter') {
                      e.preventDefault();
                      insertSlashCommand(slashCommands[selectedSlashIndex] || slashCommands[0]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowSlashMenu(false);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit(e as any);
                  }
                }}
                placeholder={providerAcceptsActiveInput
                  ? pendingQuestions.length > 0
                    ? 'Answer the waiting question…'
                    : 'Guide this active turn…'
                  : isRunning
                    ? 'Agent is responding…'
                  : queuedComposerMessage
                    ? 'Message queued while the sandbox is prepared…'
                  : providerVerificationState === 'ready'
                    ? directQualificationProvider
                      ? 'Draft a message, then prepare the provider to send…'
                      : 'Message Agent…'
                    : providerVerificationState === 'failed'
                      ? 'Keep your draft here, then retry the provider check…'
                      : 'Draft a message while Portal checks providers…'}
                aria-haspopup="listbox"
                aria-controls={showSlashMenu && slashCommands.length > 0 && providerSendAllowed ? slashMenuId : undefined}
                aria-activedescendant={showSlashMenu && slashCommands.length > 0 && providerSendAllowed ? `${slashMenuId}-option-${selectedSlashIndex}` : undefined}
                disabled={!composerAcceptsInput}
                className={`w-full resize-none rounded-xl px-3 py-2 text-[11px] placeholder-slate-600 focus:outline-none transition-all min-h-[36px] max-h-[120px] overflow-y-auto ${
                  isRunning
                    ? providerAcceptsActiveInput
                      ? 'bg-violet-500/[0.04] border border-violet-500/20 text-white focus:ring-1 focus:ring-violet-500/30'
                      : 'bg-amber-500/[0.04] border border-amber-500/15 text-slate-500 cursor-not-allowed'
                    : 'bg-white/[0.06] border border-white/[0.08] text-white focus:ring-1 focus:ring-emerald-500/30'
                }`}
                rows={1}
                onBlur={(event) => {
                  if (slashMenuBlurTimerRef.current) {
                    clearTimeout(slashMenuBlurTimerRef.current);
                  }
                  const ownerDocument = event.currentTarget.ownerDocument;
                  const htmlElement = ownerDocument.defaultView?.HTMLElement;
                  slashMenuBlurTimerRef.current = setTimeout(() => {
                    slashMenuBlurTimerRef.current = null;
                    const activeElement = ownerDocument.activeElement;
                    const focusInsideMenu = activeElement !== null
                      && htmlElement !== undefined
                      && activeElement instanceof htmlElement
                      && Boolean(activeElement.closest('[data-slash-command-menu="true"]'));
                    if (inputRef.current !== activeElement && !focusInsideMenu) {
                      setShowSlashMenu(false);
                    }
                  }, 100);
                }}
                onInput={e => {
                  const t = e.currentTarget;
                  t.style.height = 'auto';
                  t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
                }}
              />
              {showSlashMenu && slashCommands.length > 0 && providerSendAllowed && (
                <SlashCommandMenu
                  id={slashMenuId}
                  open
                  anchorRef={inputRef}
                  commands={slashCommands}
                  selectedIndex={selectedSlashIndex}
                  onNavigate={setSelectedSlashIndex}
                  onSelect={insertSlashCommand}
                  onDismiss={() => setShowSlashMenu(false)}
                />
              )}
            </div>

            {/* Mic button */}
            {speechSupported && (
              <button
                type="button"
                aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
                onClick={toggleMic}
                className={`flex-shrink-0 p-2 rounded-lg transition-all ${
                  isListening ? 'bg-red-500/20 text-red-400 animate-pulse' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.06]'
                }`}
                title={isListening ? 'Stop recording' : 'Dictate'}
              >
                {isListening ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
            )}

            {/* Send / Stop button */}
            {isRunning ? (
              <div className="flex flex-shrink-0 items-center gap-1">
                {providerAcceptsActiveInput && (
                  <button
                    type="submit"
                    aria-label={pendingQuestions.length > 0
                      ? 'Answer the waiting project question'
                      : 'Guide the active project turn'}
                    disabled={!input.trim() || pendingQuestionAnswerPending}
                    className="p-2 rounded-lg bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-violet-500/20"
                  >
                    <Send size={14} />
                  </button>
                )}
                {providerSupportsAbort && (
                  <button
                    type="button"
                    aria-label="Stop project agent response"
                    onClick={() => { void cancelStream(); }}
                    className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors border border-red-500/20"
                  >
                    <StopCircle size={14} />
                  </button>
                )}
              </div>
            ) : (
              <button
                type="submit"
                aria-label="Send message to project agent"
                disabled={!input.trim() || !composerAcceptsInput || modelCatalogBlocksInput || pendingAttachments.some(a => a.uploadStatus !== 'done' || !a.projectPath)}
                className="flex-shrink-0 p-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={14} />
              </button>
            )}
          </form>
        </div>
      </div>
    </motion.div>
  );

  const renderedPanel = projectMovePanel || panel;
  const renderedPanelWithAnswerProvider = (
    <AskQuestionAnswerProvider value={submitAskQuestionAnswer}>
      {renderedPanel}
    </AskQuestionAnswerProvider>
  );

  if (!isMobile) return renderedPanelWithAnswerProvider;

  return (
    <ViewportModal
      open
      onDismiss={dismissProjectChat}
      dismissible={sessionControlMutation === null && projectTransitionActivity === null}
      className="items-stretch justify-stretch bg-[#080B20]/98 backdrop-blur-sm"
    >
      {renderedPanelWithAnswerProvider}
    </ViewportModal>
  );
}
