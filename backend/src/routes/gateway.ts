import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import path from 'path';
import { AgentRegistry, AgentProviderName } from '../agents';
import {
  AgentAbortError,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentSendResult,
  type HostOperatorExecutionContext,
  type SenderIdentity,
} from '../agents/AgentProvider.interface';
import {
  assertExecutionContextBinding,
  assertProviderSupportsExecutionScope,
  createHostOperatorExecutionContext,
} from '../agents/executionScope';
import { readLastOpenClawUnavailableModelIds, listProviderModels } from '../agents/providerModels';
import {
  AskUserQuestionError,
} from '../services/askUserQuestionBroker';
import {
  resolveAskUserQuestionRunOwner,
} from '../services/askUserQuestionSessionOwner';
import {
  deliverAskUserQuestionAnswer,
  deliverAskUserQuestionDismissal,
  syncAskUserQuestionsForActor,
} from '../services/nativeAskUserQuestionChannel';
import { getProviderCapabilities } from '../agents/providerAvailability';
import {
  NativeSessionModelMutationError,
  setNativeSessionModel,
} from '../agents/sessionModelMutation';
import { getProviderCommandCatalog } from '../agents/providerCommandCatalog';
import { ExecApprovalRequest } from '../agents/providers/OpenClawProvider';
import {
  appendNativeMessage,
  ensureNativeSessionExecutionContext,
  loadNativeSession,
  loadNativeSessionMetadata,
  readNativeSessionHistoryPage,
  readNativeSessionHistoryTail,
} from '../agents/providers/NativeSessionStore';
import {
  AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE,
  AgentZeroOAuthModelCatalogError,
  validateAgentZeroOAuthModelSelection,
} from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';
import { safeAgentZeroErrorMessage } from '../agents/providers/agentZero/AgentZeroDiagnostics';
import {
  gatewayRpcCall,
  patchSessionModel,
  getSessionInfo,
  isGatewayTransportError,
  createSession,
  listGatewayModels,
  readLocalSessionRegistryEntry,
  withOpenClawSessionMutation,
} from '../utils/openclawGatewayRpc';
import {
  sendApprovalDecision,
  answerPendingUserInput,
  PendingUserInputAnswerError,
  injectChatMessage,
  steerSessionMessage,
  onApprovalRequest,
  onApprovalResolved,
  subscribeGatewaySessionMessages,
  reserveLogicalRun,
  acknowledgeRunReservation,
  failPendingRunReservation,
  parkUnconfirmedRunReservation,
  registerRun,
  clearRun,
  isConnected as isPersistentWsConnected,
  reconnectNow as reconnectPersistentWs,
  type ExecApprovalRequest as PersistentApprovalRequest,
  type ExecApprovalResolved,
} from '../agents/providers/PersistentGatewayWs';
import {
  onNativeCliApprovalRequest,
  onNativeCliApprovalResolved,
  resolveNativeCliApproval,
  listPendingNativeCliApprovals,
  type NativeCliApprovalDecision,
} from '../agents/nativeCliApprovals';
import {
  redactNativeProviderText,
  sanitizeNativeProviderEvent,
} from '../agents/providers/native/NativeProviderDiagnostics';
import { streamEventBus, type StreamEvent, type StreamInfo } from '../services/StreamEventBus';
import { readRuntimeTurnEvents } from '../services/RuntimeTurnEventHistory';
import type { RuntimeTurnEvent } from '../services/RuntimeTurnEvents';
import { verifyAccessToken, JwtPayload } from '../utils/jwt';
import { buildSignedDevice, getOrCreateDeviceKeys } from '../utils/deviceIdentity';
import { prisma } from '../config/database';
import { getOpenClawApiUrl } from '../config/openclaw';
import { shouldIsolateUser } from '../utils/workspaceScope';
import {
  extractTextFromContent as extractSanitizedText,
  isControlOnlyAssistantText,
  stripEnvelope,
  stripOpenClawReplyTags,
} from '../utils/chatText';
import { canUseDirectGateway, canUseInteractivePortal, isElevatedRole, isOwnerRole } from '../utils/authz';
import {
  openClawSessionActorId,
  isOpenClawSessionActorScopedTo,
} from '../agents/openclawSessionOwnership';
import { hasGatewayToken, getGatewayToken } from '../utils/gatewayToken';
import { getOpenClawWsUrl } from '../config/openclaw';
import { isAllowedWebSocketOrigin } from '../utils/websocketOrigin';
import { buildOpenClawCliEnv, canonicalizeProviderModelId, modelForOpenClawSessionPatch, normalizePortalModelId, resolvePortalModelFromCatalog } from '../utils/openclawCli';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { config } from '../config/env';
import { PRIVILEGED_CONFIRMATION, isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import { parseSafeCookieHeader } from '../utils/safeCookies';
import { sanitizeThinkingSubject } from '../utils/thinkingSubject';
import { subscribeToAuthorizationChanges } from '../services/authorizationChangeBus';
import {
  acquireWorkspaceAuthorizationMutationLease,
  settleWorkspaceAuthorizationRequest,
  subscribeToGlobalWorkspaceAuthorizationFence,
} from '../services/workspaceAuthorizationBarrier';
import { OPENCLAW_CODEX_PLUGIN_VERSION } from '../services/openclawConfigManager';
import {
  getOpenClawSetupReadiness,
  TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
  TESTED_OPENCLAW_RUNTIME_VERSION,
  matchesTestedRuntime,
} from '../services/openclawSetupReadiness';
import {
  buildUsageStatsPayload,
  isValidUsageAgentFilter,
  type UsageStatsPayload,
} from '../services/usageStats';
import { loadUsageStatsSources } from '../services/usageStatsSources';
import {
  beginOpenClawHostRun,
  markOpenClawHostRunDispatchAccepted,
  markOpenClawHostRunVisibleSettled,
  quarantineOpenClawHostRun,
  type OpenClawHostRunHandle,
} from '../services/openClawHostRunJournal';
import {
  assertOpenClawGatewayAuthorizationFenceReleased,
} from '../services/openClawGatewayAuthorizationFence';
import {
  buildPortalOpenClawIdempotencyKey,
  normalizePortalClientMessageId,
  portalClientMessageIdFromIdempotencyKey,
} from '../agents/providers/PortalMessageIdentity';

const DEBUG_GATEWAY_WS = process.env.DEBUG_GATEWAY_WS === '1';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_GATEWAY_WS) console.log('[gateway]', ...args);
};

type HostOperatorProviderSend = {
  provider: AgentProvider;
  sessionId: string;
  message: string;
  onChunk?: Parameters<AgentProvider['sendMessage']>[2];
  onStatus?: Parameters<AgentProvider['sendMessage']>[3];
  onExecApproval?: Parameters<AgentProvider['sendMessage']>[4];
  sender?: SenderIdentity;
  onQuarantinePersistenceFailure?(): void;
};

class OpenClawHostRunQuarantinePersistenceError extends Error {
  constructor() {
    super('OpenClaw host-run ambiguity could not be durably quarantined');
    this.name = 'OpenClawHostRunQuarantinePersistenceError';
  }
}

async function sendHostOperatorProviderMessage(
  input: HostOperatorProviderSend,
): Promise<AgentSendResult> {
  if (input.provider.providerName !== 'OPENCLAW') {
    return input.provider.sendMessage(
      input.sessionId,
      input.message,
      input.onChunk,
      input.onStatus,
      input.onExecApproval,
      input.sender,
    );
  }

  const actorUserId = String(input.sender?.userId || '').trim();
  const actorAuthorizationVersion = Number(input.sender?.authorizationVersion);
  const requestId = String(input.sender?.requestId || '').trim();
  if (
    !actorUserId
    || !requestId
    || !Number.isSafeInteger(actorAuthorizationVersion)
    || actorAuthorizationVersion < 1
  ) {
    throw new Error('OpenClaw host-run sender identity is incomplete');
  }

  const handle: OpenClawHostRunHandle = {
    id: requestId,
    actorUserId,
    actorAuthorizationVersion,
    provider: 'OPENCLAW',
    executionScope: 'HOST_OPERATOR',
    sessionKey: input.sessionId,
  };
  await beginOpenClawHostRun(handle);

  let dispatchAccepted = false;
  const sender: SenderIdentity = {
    ...input.sender!,
    onProviderDispatchAccepted: async (upstreamRunId: string) => {
      await markOpenClawHostRunDispatchAccepted(handle, upstreamRunId);
      dispatchAccepted = true;
    },
  };

  try {
    const result = await input.provider.sendMessage(
      input.sessionId,
      input.message,
      input.onChunk,
      input.onStatus,
      input.onExecApproval,
      sender,
    );
    if (!dispatchAccepted) {
      throw new Error('OpenClaw provider settled without durable dispatch acceptance');
    }
    await markOpenClawHostRunVisibleSettled(handle, 'completed');
    return result;
  } catch (error) {
    try {
      await quarantineOpenClawHostRun(handle, error);
    } catch {
      input.onQuarantinePersistenceFailure?.();
      throw new OpenClawHostRunQuarantinePersistenceError();
    }
    throw error;
  }
}

const router = Router();

// Allow WebSocket upgrade paths to bypass REST auth middleware.
// These paths are authenticated via cookies in the httpServer 'upgrade' handler.
router.get('/ws', (_req, res) => {
  // If we reach here, the request wasn't upgraded to WebSocket.
  // This happens with plain HTTP GET (not WS upgrade).
  res.status(426).json({ error: 'WebSocket upgrade required' });
});

router.get('/direct', (_req, res) => {
  res.status(426).json({ error: 'WebSocket upgrade required' });
});

router.use(authenticateToken, requireApproved);
const AGENTS_BASE = path.join(process.env.HOME || '/root', '.openclaw/agents');
const SESSIONS_DIR = path.join(AGENTS_BASE, 'main/sessions');
const GATEWAY_URL = getOpenClawApiUrl();
const FALLBACK_OPENCLAW_PACKAGE_DIR = '/usr/lib/node_modules/openclaw';
const PORTAL_ROOT = path.resolve(__dirname, '../../..');
const OPENCLAW_COMPAT_HOTFIX_SCRIPT = path.join(PORTAL_ROOT, 'scripts', 'patch-openclaw-long-run-relay-hotfix.sh');
const GEMINI_CLI_TMP_DIR = path.join(process.env.HOME || '/root', '.gemini', 'tmp');
const GEMINI_CLI_PROVIDER = 'google-gemini-cli';
const GEMINI_CLI_TRANSCRIPT_INDEX_TTL_MS = 30000;
const MAINTENANCE_HISTORY_DIR = path.join(PORTAL_ROOT, 'backend', '.data', 'maintenance-history');
const MAINTENANCE_HISTORY_DEDUP_WINDOW_MS = 4000;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_CURSOR_LENGTH = 2048;
const MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES = 50_000;
const HISTORY_CURSOR_PURPOSE = 'gateway-history-before-v1';
const DIRECT_GATEWAY_CHAT_SEND_TIMEOUT_MS = 30_000;
const maintenanceHistoryDedup = new Map<string, number>();

type HistoryCursorAnchor = {
  id: string;
  timestamp: string;
  role: string;
  digest: string;
};

type HistoryCursorPayload = {
  v: 1;
  scope: string;
  anchor: HistoryCursorAnchor;
  source?:
    | {
        kind: 'native-jsonl-v1';
        beforeOffset: number;
        fileIdentity: string;
      }
    | {
        kind: 'agent-zero-sequence-v1';
        beforeSequence: number;
      };
};

type HistoryPageResult = {
  messages: any[];
  beforeCursor: string | null;
  hasMoreBefore: boolean;
};

type NativeHistoryTailResult = {
  messages: any[];
  hasMore: boolean;
};

class HistoryCursorError extends Error {}

function historyCursorSecret(): string {
  return config.jwtSecret;
}

function historyCursorScope(userId: string, providerName: string, sessionId: string): string {
  return createHmac('sha256', historyCursorSecret())
    .update(`${HISTORY_CURSOR_PURPOSE}\0${userId}\0${providerName}\0${sessionId}`, 'utf8')
    .digest('base64url');
}

function historyMessageAnchor(message: any): HistoryCursorAnchor {
  const id = typeof message?.id === 'string' ? message.id.trim() : '';
  const timestamp = typeof message?.timestamp === 'string'
    ? message.timestamp
    : (typeof message?.createdAt === 'string' ? message.createdAt : '');
  const role = typeof message?.role === 'string' ? message.role : '';
  const digest = createHash('sha256')
    .update(JSON.stringify({ id, timestamp, role, content: String(message?.content || '') }), 'utf8')
    .digest('base64url');
  return { id, timestamp, role, digest };
}

function encodeHistoryCursor(
  scope: string,
  message: any,
  source?: HistoryCursorPayload['source'],
): string {
  const payload: HistoryCursorPayload = { v: 1, scope, anchor: historyMessageAnchor(message), source };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', historyCursorSecret())
    .update(`${HISTORY_CURSOR_PURPOSE}.${encoded}`, 'utf8')
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function decodeHistoryCursorPayload(rawCursor: unknown, expectedScope: string): HistoryCursorPayload {
  const cursor = typeof rawCursor === 'string' ? rawCursor.trim() : '';
  if (!cursor || cursor.length > MAX_HISTORY_CURSOR_LENGTH) throw new HistoryCursorError('Invalid history cursor');
  const [encoded, suppliedSignature, ...rest] = cursor.split('.');
  if (!encoded || !suppliedSignature || rest.length > 0) throw new HistoryCursorError('Invalid history cursor');

  const expectedSignature = createHmac('sha256', historyCursorSecret())
    .update(`${HISTORY_CURSOR_PURPOSE}.${encoded}`, 'utf8')
    .digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new HistoryCursorError('Invalid history cursor');
  }

  let payload: HistoryCursorPayload;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('non-canonical cursor');
    payload = JSON.parse(decoded.toString('utf8')) as HistoryCursorPayload;
  } catch {
    throw new HistoryCursorError('Invalid history cursor');
  }
  if (
    payload?.v !== 1
    || payload.scope !== expectedScope
    || !payload.anchor
    || typeof payload.anchor.id !== 'string'
    || typeof payload.anchor.timestamp !== 'string'
    || typeof payload.anchor.role !== 'string'
    || typeof payload.anchor.digest !== 'string'
  ) {
    throw new HistoryCursorError('History cursor does not belong to this chat');
  }
  if (payload.source !== undefined) {
    const validNative = payload.source?.kind === 'native-jsonl-v1'
      && Number.isSafeInteger(payload.source.beforeOffset)
      && payload.source.beforeOffset >= 0
      && typeof payload.source.fileIdentity === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(payload.source.fileIdentity);
    const validAgentZero = payload.source?.kind === 'agent-zero-sequence-v1'
      && Number.isSafeInteger(payload.source.beforeSequence)
      && payload.source.beforeSequence >= 1;
    if (!validNative && !validAgentZero) {
      throw new HistoryCursorError('Invalid history cursor');
    }
  }
  return payload;
}

function decodeHistoryCursor(rawCursor: unknown, expectedScope: string): HistoryCursorAnchor {
  return decodeHistoryCursorPayload(rawCursor, expectedScope).anchor;
}

function historyAnchorMatches(message: any, anchor: HistoryCursorAnchor): boolean {
  const candidate = historyMessageAnchor(message);
  return candidate.digest === anchor.digest
    && candidate.id === anchor.id
    && candidate.timestamp === anchor.timestamp
    && candidate.role === anchor.role;
}

function findHistoryAnchorIndex(messages: any[], anchor: HistoryCursorAnchor): number {
  const exact = messages.findIndex((message) => historyAnchorMatches(message, anchor));
  if (exact >= 0) return exact;

  // A live assistant row can gain its final text/tool metadata after a cursor
  // is issued. Durable identity and timestamp stay fixed, so tolerate only
  // that exact enrichment — never drift to an unrelated newer row.
  if (!anchor.id) return -1;
  return messages.findIndex((message) => {
    const candidate = historyMessageAnchor(message);
    return candidate.id === anchor.id
      && candidate.timestamp === anchor.timestamp
      && candidate.role === anchor.role;
  });
}

function buildHistoryPage(
  messages: any[],
  limit: number,
  scope: string,
  anchor?: HistoryCursorAnchor,
  sourceComplete = true,
): HistoryPageResult {
  const end = anchor ? findHistoryAnchorIndex(messages, anchor) : messages.length;
  if (anchor && end < 0) throw new HistoryCursorError('History cursor is no longer available');
  const start = Math.max(0, end - limit);
  const pageMessages = messages.slice(start, end);
  const hasMoreBefore = start > 0 || (!sourceComplete && end <= limit);
  return {
    messages: pageMessages,
    hasMoreBefore,
    beforeCursor: hasMoreBefore && pageMessages.length > 0
      ? encodeHistoryCursor(scope, pageMessages[0])
      : null,
  };
}

function parseHistoryLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_HISTORY_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HistoryCursorError('History limit must be a positive integer');
  return Math.min(parsed, MAX_HISTORY_PAGE_SIZE);
}

function readNativeHistoryPage(params: {
  providerName: AgentProviderName;
  sessionId: string;
  limit: number;
  scope: string;
  beforeCursor?: unknown;
  readTail?: (limit: number) => NativeHistoryTailResult;
  readPage?: (
    limit: number,
    beforeOffset?: number,
    expectedFileIdentity?: string,
  ) => {
    messages: any[];
    hasMore: boolean;
    beforeOffset: number | null;
    fileIdentity: string;
  };
}): HistoryPageResult {
  const decodedCursor = params.beforeCursor
    ? decodeHistoryCursorPayload(params.beforeCursor, params.scope)
    : undefined;
  const anchor = decodedCursor?.anchor;

  // Native session transcripts are append-only JSONL. New cursors carry a
  // signed byte boundary, so every older page is one bounded backwards read
  // instead of rescanning an ever-growing tail (which becomes quadratic over
  // multi-day exports). The durable anchor remains in the cursor as an
  // integrity/debugging identity; file identity rejects replacement/reset.
  const directPageReader = params.readPage || (!params.readTail
    ? ((limit: number, beforeOffset?: number, expectedFileIdentity?: string) => (
        readNativeSessionHistoryPage(
          params.providerName,
          params.sessionId,
          limit,
          beforeOffset,
          expectedFileIdentity,
        )
      ))
    : undefined);
  if (directPageReader) {
    const source = decodedCursor?.source?.kind === 'native-jsonl-v1'
      ? decodedCursor.source
      : undefined;
    if (decodedCursor && !source) {
      // Backward compatibility for a cursor minted before byte-positioned
      // native paging shipped. Fall through to the adaptive anchor reader.
    } else {
      let page;
      try {
        page = directPageReader(
          params.limit,
          source?.beforeOffset,
          source?.fileIdentity,
        );
      } catch (error: any) {
        throw new HistoryCursorError(String(error?.message || 'History cursor is no longer available'));
      }
      return {
        messages: page.messages,
        hasMoreBefore: page.hasMore,
        beforeCursor: page.hasMore && page.messages.length > 0 && page.beforeOffset !== null
          ? encodeHistoryCursor(params.scope, page.messages[0], {
              kind: 'native-jsonl-v1',
              beforeOffset: page.beforeOffset,
              fileIdentity: page.fileIdentity,
            })
          : null,
      };
    }
  }
  const readTail = params.readTail || ((limit: number) => (
    readNativeSessionHistoryTail(params.providerName, params.sessionId, limit)
  ));
  // Initial history is one bounded tail read. Older pages grow only far enough
  // to locate their signed durable anchor; the lifetime transcript is never
  // deserialized merely to paint the latest browser window.
  let scanLimit = anchor
    ? Math.min(Math.max(params.limit * 2, 200), MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES)
    : params.limit + 1;

  while (true) {
    const tail = readTail(scanLimit);
    const sourceComplete = !tail.hasMore;
    if (!anchor) {
      return buildHistoryPage(tail.messages, params.limit, params.scope, undefined, sourceComplete);
    }

    const anchorIndex = findHistoryAnchorIndex(tail.messages, anchor);
    if (anchorIndex >= params.limit || (anchorIndex >= 0 && sourceComplete)) {
      return buildHistoryPage(tail.messages, params.limit, params.scope, anchor, sourceComplete);
    }
    if (sourceComplete) throw new HistoryCursorError('History cursor is no longer available');
    if (scanLimit >= MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES) {
      throw new HistoryCursorError('History cursor is outside the retained pagination window');
    }
    scanLimit = Math.min(scanLimit * 2, MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES);
  }
}

async function readAgentZeroHistoryPage(params: {
  provider: unknown;
  sessionId: string;
  limit: number;
  scope: string;
  beforeCursor?: unknown;
}): Promise<HistoryPageResult> {
  const provider = params.provider as {
    getHistoryPage?: (
      sessionId: string,
      limit: number,
      beforeSequence?: number,
    ) => Promise<{
      messages: any[];
      hasMoreBefore: boolean;
      beforeSequence: number | null;
    }>;
  };
  if (typeof provider.getHistoryPage !== 'function') {
    throw new Error('Agent Zero history paging is unavailable');
  }
  const decoded = params.beforeCursor
    ? decodeHistoryCursorPayload(params.beforeCursor, params.scope)
    : undefined;
  if (decoded && decoded.source?.kind !== 'agent-zero-sequence-v1') {
    throw new HistoryCursorError('History cursor does not belong to this provider history');
  }
  const page = await provider.getHistoryPage(
    params.sessionId,
    params.limit,
    decoded?.source?.kind === 'agent-zero-sequence-v1'
      ? decoded.source.beforeSequence
      : undefined,
  );
  const anchorMessage = page.messages[0] || {
    id: `agent-zero-sequence-${page.beforeSequence || 0}`,
    role: 'system',
    content: '',
    timestamp: '',
  };
  return {
    messages: page.messages,
    hasMoreBefore: page.hasMoreBefore,
    beforeCursor: page.hasMoreBefore && page.beforeSequence !== null
      ? encodeHistoryCursor(params.scope, anchorMessage, {
          kind: 'agent-zero-sequence-v1',
          beforeSequence: page.beforeSequence,
        })
      : null,
  };
}

type OpenClawCliResult = { ok: boolean; stdout: string; stderr: string; error?: string };

function runOpenClawCli(args: string[], timeoutMs = 8000, extraEnv: NodeJS.ProcessEnv = {}): Promise<OpenClawCliResult> {
  return new Promise((resolve) => {
    execFile('openclaw', args, { env: { ...buildOpenClawCliEnv(), ...extraEnv }, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? (error as any)?.message || String(error) : undefined,
      });
    });
  });
}

function parseJsonLoose(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}

interface OpenClawPackageMetadata {
  packageDir: string;
  version: string;
  mtimeMs: number;
}

let openClawPackageMetadataCache: { checkedAtMs: number; metadata: OpenClawPackageMetadata | null } | null = null;

function getOpenClawPackageMetadata(): OpenClawPackageMetadata | null {
  const now = Date.now();
  if (openClawPackageMetadataCache && now - openClawPackageMetadataCache.checkedAtMs < 5000) {
    return openClawPackageMetadataCache.metadata;
  }
  const packageDirs = new Set<string>();
  if (process.env.PORTAL_OPENCLAW_PACKAGE_DIR) {
    packageDirs.add(path.resolve(process.env.PORTAL_OPENCLAW_PACKAGE_DIR));
  }
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], {
      env: buildOpenClawCliEnv(),
      timeout: 2500,
      encoding: 'utf8',
    }).trim();
    if (npmRoot) packageDirs.add(path.join(npmRoot, 'openclaw'));
  } catch {
    // Fall through to common global npm layouts.
  }
  packageDirs.add('/usr/lib/node_modules/openclaw');
  packageDirs.add('/usr/local/lib/node_modules/openclaw');

  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, 'package.json');
    try {
      if (!existsSync(packageJsonPath)) continue;
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (manifest?.name !== 'openclaw' || typeof manifest?.version !== 'string') continue;
      const metadata = {
        packageDir,
        version: manifest.version,
        mtimeMs: statSync(packageJsonPath).mtimeMs,
      };
      openClawPackageMetadataCache = { checkedAtMs: now, metadata };
      return metadata;
    } catch {}
  }
  openClawPackageMetadataCache = { checkedAtMs: now, metadata: null };
  return null;
}

function getOpenClawDistDir(): string {
  return path.join(getOpenClawPackageMetadata()?.packageDir || FALLBACK_OPENCLAW_PACKAGE_DIR, 'dist');
}

async function waitForGatewayVersionClear(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    last = await getOpenClawVersionStatus({ force: true, refreshReadiness: true }).catch((err: any) => ({
      installedVersion: null,
      installedPackageVersion: null,
      runningVersion: null,
      codexPluginVersion: null,
      codexPluginInstallSpec: null,
      latestVersion: null,
      updateChannel: null,
      testedCorePackageVersion: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
      testedRuntimeVersion: TESTED_OPENCLAW_RUNTIME_VERSION,
      testedCodexPluginVersion: OPENCLAW_CODEX_PLUGIN_VERSION,
      testedPairReady: false,
      testedPairReason: err?.message || 'Tested OpenClaw pair verification failed while waiting for gateway restart',
      mismatch: false,
      restartRecommended: false,
      reason: null,
      listenerPid: null,
      listenerStartedAt: null,
      installedPackageMtime: null,
      probeOk: false,
      probeError: err?.message || 'Version status check failed while waiting for gateway restart',
    }));
    if (last?.probeOk && !last?.restartRecommended) return last;
  }
  return last;
}

function getGatewayListenerProcess(): { pid: number | null; startedAt: string | null; startedAtMs: number | null } {
  try {
    const output = execFileSync('bash', ['-lc', "ss -ltnp 'sport = :18789' 2>/dev/null | tail -n +2 | head -n 1"], {
      env: buildOpenClawCliEnv(),
      timeout: 2500,
      encoding: 'utf8',
    }).trim();
    const pid = Number(output.match(/pid=(\d+)/)?.[1] || 0) || null;
    if (!pid) return { pid: null, startedAt: null, startedAtMs: null };

    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const bootTimeRaw = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m)?.[1];
    const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = Number(afterCommand[19]); // proc stat field 22 after removing pid+comm
    const bootSeconds = Number(bootTimeRaw || 0);
    const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { timeout: 1000, encoding: 'utf8' }).trim()) || 100;
    const startedAtMs = bootSeconds && Number.isFinite(startTicks) ? Math.round((bootSeconds + startTicks / ticksPerSecond) * 1000) : null;
    return {
      pid,
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      startedAtMs,
    };
  } catch {
    return { pid: null, startedAt: null, startedAtMs: null };
  }
}

interface OpenClawVersionStatus {
  installedVersion: string | null;
  installedPackageVersion: string | null;
  runningVersion: string | null;
  codexPluginVersion: string | null;
  codexPluginInstallSpec: string | null;
  latestVersion: string | null;
  updateChannel: string | null;
  testedCorePackageVersion: string;
  testedRuntimeVersion: string;
  testedCodexPluginVersion: string;
  testedPairReady: boolean | null;
  testedPairReason: string | null;
  mismatch: boolean;
  restartRecommended: boolean;
  reason: string | null;
  listenerPid: number | null;
  listenerStartedAt: string | null;
  installedPackageMtime: string | null;
  probeOk: boolean;
  probeError: string | null;
  checkedAt?: string;
  cached?: boolean;
  lightweight?: boolean;
}

const OPENCLAW_VERSION_STATUS_TTL_MS = Number(process.env.PORTAL_OPENCLAW_VERSION_STATUS_TTL_MS || 5 * 60 * 1000);
// A cold shared readiness pass has five individually bounded CLI checks
// (49 seconds total), two package-discovery lookups (2.5 seconds each), the
// version-status update lookup (9 seconds), listener inspection (3.5 seconds),
// and the wait loop's initial delay. Keep margin around the 67.5-second bound.
const OPENCLAW_VERSION_STATUS_COLD_PROBE_BUDGET_MS = 75_000;
const OPENCLAW_UPDATE_STATUS_TIMEOUT_MS = 9_000;
let openClawVersionStatusCache: { status: OpenClawVersionStatus; checkedAtMs: number } | null = null;
let openClawVersionStatusProbe: Promise<OpenClawVersionStatus> | null = null;

function getLightweightOpenClawVersionStatus(reason: string | null = null): OpenClawVersionStatus {
  const listener = getGatewayListenerProcess();
  return {
    installedVersion: null,
    installedPackageVersion: null,
    runningVersion: null,
    codexPluginVersion: null,
    codexPluginInstallSpec: null,
    latestVersion: null,
    updateChannel: null,
    testedCorePackageVersion: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    testedRuntimeVersion: TESTED_OPENCLAW_RUNTIME_VERSION,
    testedCodexPluginVersion: OPENCLAW_CODEX_PLUGIN_VERSION,
    testedPairReady: null,
    testedPairReason: null,
    mismatch: false,
    restartRecommended: false,
    reason,
    listenerPid: listener.pid,
    listenerStartedAt: listener.startedAt,
    installedPackageMtime: null,
    probeOk: true,
    probeError: null,
    checkedAt: new Date().toISOString(),
    lightweight: true,
  };
}

async function probeOpenClawVersionStatus(forceReadiness = false): Promise<OpenClawVersionStatus> {
  return probeOpenClawVersionStatusWithDependencies({}, forceReadiness);
}

interface OpenClawVersionProbeDependencies {
  runCli: typeof runOpenClawCli;
  getSetupReadiness: typeof getOpenClawSetupReadiness;
  getPackageMetadata: typeof getOpenClawPackageMetadata;
  getListenerProcess: typeof getGatewayListenerProcess;
}

async function probeOpenClawVersionStatusWithDependencies(
  dependencies: Partial<OpenClawVersionProbeDependencies> = {},
  forceReadiness = false,
): Promise<OpenClawVersionStatus> {
  const runCli = dependencies.runCli || runOpenClawCli;
  const readiness = await (dependencies.getSetupReadiness || getOpenClawSetupReadiness)(
    {},
    { force: forceReadiness },
  );

  // Readiness owns the shared, in-flight-deduplicated OpenClaw CLI sequence
  // used by maintenance and setup routes. Run update discovery only after that
  // sequence settles so the Dashboard never starts a competing CLI process.
  const updateStatusResult = await runCli(
    ['update', 'status', '--json', '--timeout', '3'],
    OPENCLAW_UPDATE_STATUS_TIMEOUT_MS,
  );

  const installedVersion = readiness.version;
  const packageMetadata = (dependencies.getPackageMetadata || getOpenClawPackageMetadata)();
  const installedPackageVersion = readiness.corePackageVersion;
  const updateStatus = parseJsonLoose(updateStatusResult.stdout);
  const codexPluginVersion = readiness.codexPluginVersion;
  const codexPluginInstallSpec = readiness.codexPluginInstallSpec;
  const runningVersion = readiness.runningVersion;
  const listener = (dependencies.getListenerProcess || getGatewayListenerProcess)();
  const installedPackageMtimeMs = packageMetadata?.mtimeMs || null;
  const installedPackageMtime = installedPackageMtimeMs ? new Date(installedPackageMtimeMs).toISOString() : null;
  const probeError = readiness.gatewayProbeError;

  const expectedCodexPluginSpec = `@openclaw/codex@${OPENCLAW_CODEX_PLUGIN_VERSION}`;
  const testedPairReady = readiness.testedPairReady;
  const testedPairBlocker = readiness.blockers.find((blocker) => [
    'not-installed',
    'core-package-mismatch',
    'cli-runtime-mismatch',
    'gateway-rpc-unavailable',
    'gateway-runtime-mismatch',
    'codex-plugin-mismatch',
  ].includes(blocker.code));
  const testedPairReason = testedPairReady
    ? null
    : installedPackageVersion !== TESTED_OPENCLAW_CORE_PACKAGE_VERSION
    ? `OpenClaw package ${installedPackageVersion || 'unknown'} is installed; Portal 4.0 is tested with ${TESTED_OPENCLAW_CORE_PACKAGE_VERSION}.`
    : !matchesTestedRuntime(installedVersion)
      ? `OpenClaw CLI runtime ${installedVersion || 'unknown'} does not match tested runtime ${TESTED_OPENCLAW_RUNTIME_VERSION}.`
      : !matchesTestedRuntime(runningVersion)
        ? `OpenClaw gateway runtime ${runningVersion || 'unknown'} does not match tested runtime ${TESTED_OPENCLAW_RUNTIME_VERSION}.`
        : readiness.blockers.some((blocker) => blocker.code === 'codex-plugin-mismatch')
          ? `OpenClaw Codex plugin must be the pinned npm install ${expectedCodexPluginSpec}; detected ${codexPluginInstallSpec || codexPluginVersion || 'unknown'}.`
          : !readiness.gatewayProbeOk
            ? testedPairBlocker?.message || 'OpenClaw gateway RPC probe did not validate the tested runtime pair.'
            : testedPairBlocker?.message || 'OpenClaw did not validate the tested runtime pair.';

  const exactVersionMismatch = Boolean(installedVersion && runningVersion && installedVersion !== runningVersion);
  const listenerOlderThanInstall = Boolean(
    listener.startedAtMs
    && installedPackageMtimeMs
    && listener.startedAtMs + 5000 < installedPackageMtimeMs
  );
  const protocolMismatch = String(probeError || '').toLowerCase().includes('protocol mismatch');
  const mismatch = exactVersionMismatch || (!runningVersion && listenerOlderThanInstall) || protocolMismatch;
  const reason = exactVersionMismatch
    ? `OpenClaw gateway is running ${runningVersion}, but ${installedVersion} is installed.`
    : protocolMismatch
      ? 'OpenClaw gateway protocol does not match the installed CLI; the gateway is probably still an older detached process.'
      : listenerOlderThanInstall
        ? 'OpenClaw gateway listener started before the installed package was updated.'
        : null;

  return {
    installedVersion,
    installedPackageVersion,
    runningVersion,
    codexPluginVersion,
    codexPluginInstallSpec,
    latestVersion: updateStatus?.availability?.latestVersion || updateStatus?.update?.registry?.latestVersion || null,
    updateChannel: updateStatus?.channel?.value || null,
    testedCorePackageVersion: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    testedRuntimeVersion: TESTED_OPENCLAW_RUNTIME_VERSION,
    testedCodexPluginVersion: OPENCLAW_CODEX_PLUGIN_VERSION,
    testedPairReady,
    testedPairReason,
    mismatch,
    restartRecommended: mismatch,
    reason,
    listenerPid: listener.pid,
    listenerStartedAt: listener.startedAt,
    installedPackageMtime,
    probeOk: readiness.gatewayProbeOk,
    probeError,
    checkedAt: new Date().toISOString(),
  };
}

async function getOpenClawVersionStatus(
  options: { force?: boolean; refreshReadiness?: boolean } = {},
): Promise<OpenClawVersionStatus> {
  const now = Date.now();
  const force = options.force === true;
  const cacheFresh = openClawVersionStatusCache && now - openClawVersionStatusCache.checkedAtMs < OPENCLAW_VERSION_STATUS_TTL_MS;

  if (!force && cacheFresh) {
    return { ...openClawVersionStatusCache!.status, cached: true };
  }

  // Operator kill-switch: dashboard health stays cheap, but explicit admin
  // actions can still force a probe/restart path when they need ground truth.
  if (!force && process.env.PORTAL_DISABLE_OPENCLAW_CLI_STATUS === '1') {
    return getLightweightOpenClawVersionStatus('OpenClaw CLI status probe disabled by PORTAL_DISABLE_OPENCLAW_CLI_STATUS=1.');
  }

  if (openClawVersionStatusProbe) {
    if (force) return openClawVersionStatusProbe;
    return openClawVersionStatusCache
      ? { ...openClawVersionStatusCache.status, cached: true }
      : getLightweightOpenClawVersionStatus('OpenClaw version probe already running.');
  }

  openClawVersionStatusProbe = probeOpenClawVersionStatus(options.refreshReadiness === true)
    .then(status => {
      openClawVersionStatusCache = { status, checkedAtMs: Date.now() };
      return status;
    })
    .finally(() => {
      openClawVersionStatusProbe = null;
    });

  if (force) return openClawVersionStatusProbe;

  // Do not make /api/gateway/health wait on OpenClaw CLI/update probes. The
  // Dashboard polls this route, and previous synchronous probes were enough to
  // saturate small VPSes when OpenClaw was already unhealthy.
  return openClawVersionStatusCache
    ? { ...openClawVersionStatusCache.status, cached: true }
    : getLightweightOpenClawVersionStatus('OpenClaw version probe scheduled.');
}

let geminiCliTranscriptIndexCache: { at: number; index: Map<string, string> } | null = null;

function resolveOpenClawDistBundle(prefix: string | string[]): string | null {
  try {
    const openClawDistDir = getOpenClawDistDir();
    if (!existsSync(openClawDistDir)) return null;
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    const matches = readdirSync(openClawDistDir)
      .filter((name) => name.endsWith('.js') && prefixes.some((candidate) => name.startsWith(candidate)))
      .map((name) => path.join(openClawDistDir, name))
      .sort((a, b) => {
        const sizeDiff = statSync(b).size - statSync(a).size;
        return sizeDiff !== 0 ? sizeDiff : path.basename(a).localeCompare(path.basename(b));
      });
    return matches[0] || null;
  } catch {
    return null;
  }
}

function resolveOpenClawDistBundleWithMarkers(prefix: string, markers: string[]): string | null {
  try {
    const openClawDistDir = getOpenClawDistDir();
    if (!existsSync(openClawDistDir)) return null;
    const matches = readdirSync(openClawDistDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.js'))
      .map((name) => path.join(openClawDistDir, name))
      .filter((candidate) => {
        const text = readFileSync(candidate, 'utf8');
        return markers.every((marker) => text.includes(marker));
      })
      .sort((a, b) => {
        const sizeDiff = statSync(b).size - statSync(a).size;
        return sizeDiff !== 0 ? sizeDiff : path.basename(a).localeCompare(path.basename(b));
      });
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

function resolveOpenClawExtensionImportedBundle(extensionRelativePath: string, prefix: string | string[]): string | null {
  try {
    const openClawDistDir = getOpenClawDistDir();
    const extensionPath = path.join(openClawDistDir, extensionRelativePath);
    if (!existsSync(extensionPath)) return null;
    const text = readFileSync(extensionPath, 'utf8');
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    for (const candidate of prefixes) {
      const match = text.match(new RegExp(`${candidate}[^"']+\\.js`));
      if (!match) continue;
      const resolved = path.join(openClawDistDir, path.basename(match[0]));
      if (existsSync(resolved)) return resolved;
    }
  } catch {
    // ignore wrapper parse failures
  }
  return null;
}

function getOpenClawCompatibilityHotfixStatus() {
  const openClawDistDir = getOpenClawDistDir();
  const heartbeatEventsFilterPath = resolveOpenClawDistBundle('heartbeat-events-filter-');
  const heartbeatRunnerPath = resolveOpenClawDistBundle('heartbeat-runner-');
  const replyBundlePath = resolveOpenClawDistBundle(['get-reply-', 'reply-']);
  const claudeLiveSessionPath = resolveOpenClawDistBundle('claude-live-session-');
  const executeRuntimePath = resolveOpenClawDistBundle('execute.runtime-');
  const claudeCliSharedPath = resolveOpenClawDistBundleWithMarkers('cli-shared-', [
    'const CLAUDE_DISALLOWED_TOOLS_ARG = "--disallowedTools";',
    'function resolveClaudePermissionMode(context) {',
    'function normalizeClaudeBackendConfig(config, context) {',
  ]);
  const geminiCliBackendPath = resolveOpenClawExtensionImportedBundle('extensions/google/cli-backend.js', 'cli-backend-')
    || resolveOpenClawDistBundle('cli-backend-')
    || (existsSync(path.join(openClawDistDir, 'extensions/google/cli-backend.js'))
      ? path.join(openClawDistDir, 'extensions/google/cli-backend.js')
      : null);
  const scriptExists = existsSync(OPENCLAW_COMPAT_HOTFIX_SCRIPT);
  const issues: string[] = [];

  const heartbeatDetectorPath = heartbeatEventsFilterPath || heartbeatRunnerPath;
  const heartbeatDetectorText = heartbeatDetectorPath && existsSync(heartbeatDetectorPath)
    ? readFileSync(heartbeatDetectorPath, 'utf8')
    : '';
  const heartbeatRunnerText = heartbeatRunnerPath && existsSync(heartbeatRunnerPath)
    ? readFileSync(heartbeatRunnerPath, 'utf8')
    : '';
  const replyText = replyBundlePath && existsSync(replyBundlePath)
    ? readFileSync(replyBundlePath, 'utf8')
    : '';
  const claudeLiveSessionText = claudeLiveSessionPath && existsSync(claudeLiveSessionPath)
    ? readFileSync(claudeLiveSessionPath, 'utf8')
    : '';
  const executeRuntimeText = executeRuntimePath && existsSync(executeRuntimePath)
    ? readFileSync(executeRuntimePath, 'utf8')
    : '';
  const claudeCliSharedText = claudeCliSharedPath && existsSync(claudeCliSharedPath)
    ? readFileSync(claudeCliSharedPath, 'utf8')
    : '';
  const geminiCliBackendText = geminiCliBackendPath && existsSync(geminiCliBackendPath)
    ? readFileSync(geminiCliBackendPath, 'utf8')
    : '';

  const detectorPatched = heartbeatDetectorText.includes('return lower.includes("exec finished") || lower.includes("exec completed");')
    || heartbeatDetectorText.includes('return normalizeLowercaseStringOrEmpty(evt).includes("exec finished") || normalizeLowercaseStringOrEmpty(evt).includes("exec completed");')
    || heartbeatDetectorText.includes('return /^exec finished(?::|\\s*\\()/.test(normalized) || /^exec (completed|failed) \\([a-z0-9_-]{1,64}, (code -?\\d+|signal [^)]+)\\)( :: .*)?$/.test(normalized);')
    || (heartbeatDetectorText.includes('STRUCTURED_EXEC_COMPLETION_EVENT_RE')
      && heartbeatDetectorText.includes('^exec finished(?::|\\s*\\()'));
  const relayPatched = heartbeatRunnerText.includes('const isDirectWebchatSession =')
    && heartbeatRunnerText.includes('delivery.channel === "none" && isDirectWebchatSession');
  const replyPatched = replyText.includes('normalizedIncomingTo === "heartbeat" && params.persistedLastTo');
  const geminiCliPatched = geminiCliBackendText.includes('jsonlDialect: "gemini-stream-json"')
    && geminiCliBackendText.includes('"stream-json"');
  const geminiCliYoloPatched = geminiCliBackendText.includes('"--yolo",');
  const geminiParserText = claudeLiveSessionText || executeRuntimeText;
  const geminiParserPatched = geminiParserText.includes('function isGeminiCliProvider(providerId) {')
    && geminiParserText.includes('function parseGeminiCliStreamingDelta(params) {')
    && geminiParserText.includes('function dispatchGeminiCliStreamingToolEvent(params) {');
  const executeRuntimeNativeToolWiring = executeRuntimeText.includes('onToolUseStart: emitCliToolUseStart')
    && executeRuntimeText.includes('onToolResult: emitCliToolResult');
  const executeRuntimeWiringPatched = executeRuntimeNativeToolWiring
    || executeRuntimeText.includes('onToolEvent: (event) => {');
  const geminiRuntimePatched = geminiParserPatched && executeRuntimeWiringPatched;
  const claudeAskUserSupported = Boolean(claudeCliSharedPath);
  const claudeAskUserPatched = claudeCliSharedText.includes('bridgesllm-openclaw-claude-ask-user-route-v2')
    && claudeCliSharedText.includes('function ensureClaudeDisallowedTool(args, toolName) {')
    && claudeCliSharedText.includes('\tif (!args) return args;')
    && claudeCliSharedText.includes('args: ensureClaudeDisallowedTool(')
    && claudeCliSharedText.includes('resumeArgs: ensureClaudeDisallowedTool(');
  let claudeAskUserBridgeReady = false;
  let claudeAskUserTimeoutsReady = false;
  let askUserPluginVersionReady = false;
  try {
    const stateRoot = path.join(process.env.HOME || '/root', '.openclaw');
    const config = JSON.parse(readFileSync(path.join(stateRoot, 'openclaw.json'), 'utf8'));
    const pluginEntry = config?.plugins?.entries?.['bridgesllm-ask-user'];
    const allow = config?.plugins?.allow;
    const claudeBackend = config?.agents?.defaults?.cliBackends?.['claude-cli'];
    const claudeEnv = claudeBackend?.env;
    claudeAskUserTimeoutsReady = typeof claudeBackend?.command === 'string'
      && claudeBackend.command.trim().length > 0
      && claudeEnv?.MCP_TOOL_TIMEOUT === '660000'
      && claudeEnv?.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT === '660000';
    const bundledPackage = JSON.parse(readFileSync(
      path.join(PORTAL_ROOT, 'installer/openclaw-ask-user-plugin/package.json'),
      'utf8',
    ));
    const installedPackage = JSON.parse(readFileSync(
      path.join(stateRoot, 'extensions/bridgesllm-ask-user/package.json'),
      'utf8',
    ));
    askUserPluginVersionReady = typeof bundledPackage?.version === 'string'
      && bundledPackage.version.length > 0
      && installedPackage?.version === bundledPackage.version;
    claudeAskUserBridgeReady = config?.plugins?.enabled !== false
      && pluginEntry?.enabled === true
      && (allow === undefined || (Array.isArray(allow) && allow.includes('bridgesllm-ask-user')))
      && askUserPluginVersionReady
      && claudeAskUserTimeoutsReady;
  } catch {
    claudeAskUserBridgeReady = false;
  }
  const relaySupported = Boolean(heartbeatRunnerPath) && Boolean(replyBundlePath);
  const geminiSupported = Boolean(executeRuntimePath) && Boolean(geminiCliBackendPath);

  if (!scriptExists) issues.push('Portal hotfix script is not installed.');
  if (!relaySupported && !geminiSupported) issues.push('Could not locate the OpenClaw runtime bundles targeted by the compatibility hotfix.');
  if ((heartbeatRunnerPath || replyBundlePath) && !relaySupported) issues.push('Could not locate both relay hotfix bundles (heartbeat runner and get-reply).');
  if ((claudeLiveSessionPath || executeRuntimePath || geminiCliBackendPath) && !geminiSupported) issues.push('Could not locate the Gemini CLI hotfix targets (execute runtime and google cli backend).');
  if (!claudeAskUserSupported) issues.push('Could not locate exactly one Claude CLI normalization bundle for ask-user routing.');
  if (!claudeAskUserBridgeReady) issues.push('The Portal ask-user plugin and both 11-minute Claude MCP timeout settings must be installed before patching native Claude question routing.');

  const supported = scriptExists
    && issues.length === 0
    && (relaySupported || geminiSupported)
    && claudeAskUserSupported
    && claudeAskUserBridgeReady;
  const applied = supported
    && (relaySupported ? detectorPatched && relayPatched && replyPatched : true)
    && (geminiSupported ? geminiCliPatched && geminiCliYoloPatched && geminiRuntimePatched : true)
    && claudeAskUserPatched;

  return {
    scriptExists,
    supported,
    applied,
    relaySupported,
    geminiSupported,
    detectorPatched,
    relayPatched,
    replyPatched,
    geminiCliPatched,
    geminiCliYoloPatched,
    geminiRuntimePatched,
    claudeAskUserSupported,
    claudeAskUserPatched,
    claudeAskUserBridgeReady,
    claudeAskUserTimeoutsReady,
    askUserPluginVersionReady,
    executeRuntimeNativeToolWiring,
    heartbeatRunner: heartbeatRunnerPath ? path.basename(heartbeatRunnerPath) : null,
    replyBundle: replyBundlePath ? path.basename(replyBundlePath) : null,
    executeRuntime: executeRuntimePath ? path.basename(executeRuntimePath) : null,
    claudeCliShared: claudeCliSharedPath ? path.basename(claudeCliSharedPath) : null,
    geminiCliBackend: geminiCliBackendPath ? path.relative(openClawDistDir, geminiCliBackendPath) : null,
    issues,
  };
}

interface OpenClawAskUserRuntimeReadiness {
  ready: boolean;
  pluginLoaded: boolean;
  toolExecutionCallable: boolean;
  pendingMethodCallable: boolean;
  answerMethodCallable: boolean;
  dismissMethodCallable: boolean;
  steerMethodCallable: boolean;
  issue?: string;
}

interface OpenClawAskUserRuntimeReadinessDependencies {
  runCli: typeof runOpenClawCli;
  callGatewayRpc: typeof gatewayRpcCall;
  readBundledVersion: () => string;
  resolveRealPath: (target: string) => string;
  stateRoot: string;
}

const REQUIRED_ASK_USER_GATEWAY_METHODS = new Set([
  'bridgesllm.ask_user.probe',
  'bridgesllm.ask_user.pending',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.dismiss',
  'bridgesllm.ask_user.steer',
]);

function askUserRuntimeReportIsReady(params: {
  report: any;
  expectedVersion: string;
  expectedRoot: string;
  expectedSource: string;
  resolveRealPath: (target: string) => string;
}): boolean {
  const { report, expectedVersion, expectedRoot, expectedSource, resolveRealPath } = params;
  const plugin = report?.plugin;
  const toolNames = plugin?.toolNames;
  const typedHooks = report?.typedHooks;
  const gatewayMethods = report?.gatewayMethods;
  const diagnostics = report?.diagnostics;
  let pluginPathsReady = false;
  try {
    pluginPathsReady = typeof plugin?.rootDir === 'string'
      && typeof plugin?.source === 'string'
      && resolveRealPath(plugin.rootDir) === resolveRealPath(expectedRoot)
      && resolveRealPath(plugin.source) === resolveRealPath(expectedSource);
  } catch {
    pluginPathsReady = false;
  }
  return Boolean(
    expectedVersion
    && plugin?.id === 'bridgesllm-ask-user'
    && plugin?.version === expectedVersion
    && plugin?.status === 'loaded'
    && plugin?.enabled === true
    && plugin?.activated === true
    && !plugin?.error
    && pluginPathsReady
    && Array.isArray(toolNames)
    && toolNames.includes('ask_user_question')
    && plugin?.hookCount === 1
    && Array.isArray(typedHooks)
    && typedHooks.some((item: any) => item?.name === 'before_tool_call')
    && Array.isArray(gatewayMethods)
    && [...REQUIRED_ASK_USER_GATEWAY_METHODS].every((method) => gatewayMethods.includes(method))
    && Array.isArray(diagnostics)
    && !diagnostics.some((item: any) => item?.level === 'error')
  );
}

async function getOpenClawAskUserRuntimeReadiness(
  dependencyOverrides: Partial<OpenClawAskUserRuntimeReadinessDependencies> = {},
): Promise<OpenClawAskUserRuntimeReadiness> {
  const defaultStateRoot = path.join(process.env.HOME || '/root', '.openclaw');
  const dependencies: OpenClawAskUserRuntimeReadinessDependencies = {
    runCli: runOpenClawCli,
    callGatewayRpc: gatewayRpcCall,
    readBundledVersion: () => {
      const bundledPackage = JSON.parse(readFileSync(
        path.join(PORTAL_ROOT, 'installer/openclaw-ask-user-plugin/package.json'),
        'utf8',
      ));
      return typeof bundledPackage?.version === 'string' ? bundledPackage.version : '';
    },
    resolveRealPath: (target) => realpathSync(target),
    stateRoot: defaultStateRoot,
    ...dependencyOverrides,
  };
  let expectedVersion = '';
  try {
    expectedVersion = dependencies.readBundledVersion();
  } catch {
    return {
      ready: false,
      pluginLoaded: false,
      toolExecutionCallable: false,
      pendingMethodCallable: false,
      answerMethodCallable: false,
      dismissMethodCallable: false,
      steerMethodCallable: false,
      issue: 'Could not read the bundled ask-user plugin version.',
    };
  }

  const inspection = await dependencies.runCli(
    ['plugins', 'inspect', 'bridgesllm-ask-user', '--json', '--runtime'],
    12_000,
  );
  const report = inspection.ok ? parseJsonLoose(inspection.stdout) : null;
  const expectedRoot = path.join(
    dependencies.stateRoot,
    'extensions/bridgesllm-ask-user',
  );
  const pluginLoaded = askUserRuntimeReportIsReady({
    report,
    expectedVersion,
    expectedRoot,
    expectedSource: path.join(expectedRoot, 'index.js'),
    resolveRealPath: dependencies.resolveRealPath,
  });
  if (!pluginLoaded) {
    return {
      ready: false,
      pluginLoaded: false,
      toolExecutionCallable: false,
      pendingMethodCallable: false,
      answerMethodCallable: false,
      dismissMethodCallable: false,
      steerMethodCallable: false,
      issue: inspection.ok
        ? 'The ask-user plugin is installed but its runtime tool, hook, or gateway methods are not fully active.'
        : `OpenClaw could not inspect the ask-user plugin runtime: ${inspection.stderr || inspection.error || 'unknown error'}`,
    };
  }

  const nonce = randomUUID();
  const sessionKey = `agent:main:bridgesllm-ask-user-readiness-${nonce}`;
  const expectedRunId = `readiness-${nonce}`;
  const requestId = `readiness-request-${nonce}`;
  const semanticProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.probe', {
    nonce,
  }, 10_000);
  const toolExecutionCallable = semanticProbe.ok
    && semanticProbe.data?.ok === true
    && semanticProbe.data?.code === 'SEMANTIC_PROBE_OK'
    && semanticProbe.data?.toolName === 'ask_user_question'
    && semanticProbe.data?.answer === true
    && semanticProbe.data?.dismiss === true
    && semanticProbe.data?.steer === true;

  const pendingProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.pending', {
    sessionKey,
    expectedRunId,
  }, 10_000);
  const pendingMethodCallable = pendingProbe.ok
    && pendingProbe.data?.pending === false
    && pendingProbe.data?.code === 'NO_ACTIVE_RUN';

  const answerProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.answer', {
    sessionKey,
    expectedRunId,
    requestId,
    text: 'BridgesLLM readiness probe.',
  }, 10_000);
  const answerMethodCallable = answerProbe.ok
    && answerProbe.data?.accepted === false
    && answerProbe.data?.code === 'NO_ACTIVE_RUN'
    && answerProbe.data?.requestId === requestId;

  const dismissProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.dismiss', {
    sessionKey,
    expectedRunId,
    requestId,
  }, 10_000);
  const dismissMethodCallable = dismissProbe.ok
    && dismissProbe.data?.accepted === false
    && dismissProbe.data?.code === 'NO_ACTIVE_RUN'
    && dismissProbe.data?.requestId === requestId;

  const steerProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.steer', {
    sessionKey,
    expectedRunId,
    requestId,
    text: 'BridgesLLM readiness probe.',
  }, 10_000);
  const steerMethodCallable = steerProbe.ok
    && steerProbe.data?.accepted === false
    && steerProbe.data?.code === 'NO_ACTIVE_RUN'
    && steerProbe.data?.requestId === requestId;
  const ready = toolExecutionCallable
    && pendingMethodCallable
    && answerMethodCallable
    && dismissMethodCallable
    && steerMethodCallable;
  const failedProbe = !toolExecutionCallable
    ? ['tool execution', semanticProbe]
    : !pendingMethodCallable
      ? ['pending', pendingProbe]
      : !answerMethodCallable
        ? ['answer', answerProbe]
        : !dismissMethodCallable
          ? ['dismiss', dismissProbe]
          : !steerMethodCallable
            ? ['steer', steerProbe]
            : null;
  return {
    ready,
    pluginLoaded: true,
    toolExecutionCallable,
    pendingMethodCallable,
    answerMethodCallable,
    dismissMethodCallable,
    steerMethodCallable,
    ...(ready ? {} : {
      issue: `The ask-user plugin loaded, but its ${failedProbe?.[0]} semantic probe failed: ${(failedProbe?.[1] as any)?.errorMessage || (failedProbe?.[1] as any)?.error || 'unexpected response'}`,
    }),
  };
}

async function restartOpenClawGatewayBySystemService(): Promise<string> {
  await assertOpenClawGatewayAuthorizationFenceReleased();
  if (
    !existsSync('/run/systemd/system')
    || !existsSync('/usr/bin/systemctl')
    || !existsSync('/etc/systemd/system/openclaw-gateway.service')
  ) {
    throw new Error('The installer-owned OpenClaw gateway system service is unavailable.');
  }
  const restartRun = await execFileText(
    '/usr/bin/systemctl',
    ['restart', 'openclaw-gateway.service'],
    45_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const output = [restartRun.stdout, restartRun.stderr].filter(Boolean).join('\n').trim();
  return output || 'Restarted openclaw-gateway via systemd system service.';
}

async function restartOpenClawGateway(): Promise<string> {
  return await restartOpenClawGatewayBySystemService();
}

async function execFileText(
  command: string,
  args: string[],
  timeout: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout,
      encoding: 'utf8',
      env: { ...buildOpenClawCliEnv(), ...extraEnv },
      maxBuffer: 1024 * 1024 * 4,
    }, (error, stdout, stderr) => {
      const normalizedStdout = String(stdout || '').trim();
      const normalizedStderr = String(stderr || '').trim();
      if (error) {
        const detail = normalizedStderr || normalizedStdout || error.message || `${command} failed`;
        reject(new Error(detail));
        return;
      }
      resolve({ stdout: normalizedStdout, stderr: normalizedStderr });
    });
  });
}

/**
 * Resolve sessions directory for a given session key.
 * Session keys follow the pattern `agent:<agentId>:...`
 * Falls back to main agent if pattern doesn't match.
 */
function resolveSessionsDir(sessionKey?: string): string {
  if (!sessionKey) return SESSIONS_DIR;
  const match = sessionKey.match(/^agent:([a-zA-Z0-9_-]+):/);
  if (!match) return SESSIONS_DIR;
  const agentId = match[1];
  const agentDir = path.join(AGENTS_BASE, agentId, 'sessions');
  if (existsSync(agentDir)) return agentDir;
  return SESSIONS_DIR;
}

function normalizePortalNewSessionAlias(rawSession: unknown): string {
  const session = typeof rawSession === 'string' ? rawSession.trim() : '';
  if (!session) return '';
  if (session.startsWith('portal-new-')) return session.replace(/^portal-/, '');
  if (!session.startsWith('agent:')) return session;

  const parts = session.split(':');
  if (parts.length < 3) return session;

  const agentId = parts[1]?.trim() || 'main';
  const sessionName = parts.slice(2).join(':').trim();
  if (!sessionName.startsWith('portal-new-')) return session;
  return `agent:${agentId}:${sessionName.replace(/^portal-/, '')}`;
}

function openClawAgentChatSessionKey(
  rawUserId: string,
  rawAgentId = 'main',
  rawSessionName = '',
): string {
  const userId = String(rawUserId || '').trim();
  const agentId = String(rawAgentId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('Admin access required');
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) throw new Error('Invalid OpenClaw agent');

  const requestedName = String(rawSessionName || '').trim();
  const safeName = requestedName
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const suffix = safeName && safeName !== 'main'
    ? `-${safeName}`
    : '';
  return `agent:${agentId}:portal-${userId}${suffix}`;
}

const NEW_PORTAL_CHAT_LABEL_PREFIX = 'New Portal chat';

function isPortalAgentChatSessionKeyForUser(
  sessionKey: string,
  user: Pick<JwtPayload, 'userId'>,
): boolean {
  const match = /^agent:([^:]+):portal-([0-9a-f-]{36})(?:-|$)/i.exec(String(sessionKey || '').trim());
  return Boolean(match && match[2].toLowerCase() === String(user.userId || '').toLowerCase());
}

function buildPortalAgentChatLabel(sessionKey: string, message?: unknown): string {
  const key = String(sessionKey || '').trim();
  const keySuffix = createHash('sha256').update(key).digest('hex').slice(0, 6);
  const prompt = typeof message === 'string'
    ? message.replace(/\s+/g, ' ').trim()
    : '';
  if (prompt) {
    const summary = prompt.length > 88
      ? `${prompt.slice(0, 87).trimEnd()}…`
      : prompt;
    return `Portal · ${summary} · ${keySuffix}`;
  }
  const agentId = /^agent:([^:]+):/.exec(key)?.[1] || 'main';
  return `${NEW_PORTAL_CHAT_LABEL_PREFIX} · ${agentId} · ${keySuffix}`;
}

/**
 * A session is ours to name when its key is in this user's Portal namespace, or
 * when Portal's own record says this user owns it.
 *
 * The namespace test alone missed every chat that was created outside Portal and
 * later adopted — `agent:main:new-<ts>` never matches `portal-<uuid>`. Those are
 * exactly the sessions that end up displaying the gateway client name, because
 * OpenClaw falls back to the connecting client's displayName when a session has
 * no label of its own, and Portal connects as "Portal Backend RPC". So the chats
 * most in need of a name were the ones the guard refused to touch.
 */
async function canNamePortalAgentChatSession(
  sessionKey: string,
  user: Pick<JwtPayload, 'userId'>,
): Promise<boolean> {
  if (isPortalAgentChatSessionKeyForUser(sessionKey, user)) return true;
  const userId = String(user.userId || '').trim();
  if (!userId) return false;
  try {
    return (await findOpenClawAgentSessionOwner(sessionKey)) === userId;
  } catch {
    // Naming is cosmetic; never let a lookup failure break the send path.
    return false;
  }
}

async function ensurePortalAgentChatLabel(
  sessionKey: string,
  user: Pick<JwtPayload, 'userId'>,
  message?: unknown,
): Promise<void> {
  if (!(await canNamePortalAgentChatSession(sessionKey, user))) return;
  const info = await getSessionInfo(sessionKey);
  if (!info.ok || !info.data) return;
  const current = String(info.data.displayName || info.data.label || '').trim();
  const replaceable = !current
    || current === 'Portal Backend RPC'
    || current.startsWith(`${NEW_PORTAL_CHAT_LABEL_PREFIX} ·`);
  if (!replaceable) return;
  const label = buildPortalAgentChatLabel(sessionKey, message);
  if (label === current) return;
  const patched = await gatewayRpcCall('sessions.patch', { key: sessionKey, label });
  if (!patched.ok) {
    console.warn(`[Gateway RPC] Could not label Portal session ${sessionKey}: ${patched.error || 'unknown error'}`);
  }
}

/** Agent that Agent Chat lists when the client has not selected one. */
const DEFAULT_HOST_AGENT_ID = 'main';


async function resolveOpenClawSessionKey(
  rawSession: unknown,
  user?: Pick<JwtPayload, 'role' | 'userId'> | null,
  database: ProjectActivityScopeDatabase = prisma,
): Promise<string> {
  const session = normalizePortalNewSessionAlias(rawSession);
  if (!user || !isElevatedRole(user.role)) return session;

  const qualified = /^agent:([^:]+):(.+)$/.exec(session);
  if (qualified) {
    const [, agentId, sessionName] = qualified;
    if (sessionName === 'main') {
      const owner = await findOpenClawAgentSessionOwner(session, database);
      if (owner === user.userId) return session;
      return openClawAgentChatSessionKey(user.userId, agentId);
    }
    if (sessionName.startsWith('new-')) {
      // `new-<ts>` is the Portal's own alias for "start a chat", so it normally
      // resolves into this user's namespace. But OpenClaw names host-created
      // chats the same way, and those are real sessions with real transcripts.
      // Redirecting an owned, already-existing key would silently open an empty
      // room instead of the conversation the user asked for.
      const owner = await findOpenClawAgentSessionOwner(session, database);
      if (owner === user.userId) return session;
      return openClawAgentChatSessionKey(user.userId, agentId, sessionName);
    }
    return session;
  }

  if (!session || session === 'main') {
    const canonicalMain = 'agent:main:main';
    const owner = await findOpenClawAgentSessionOwner(canonicalMain, database);
    if (owner === user.userId) return canonicalMain;
    return openClawAgentChatSessionKey(user.userId);
  }
  if (session.startsWith('new-')) {
    const canonical = `agent:${DEFAULT_HOST_AGENT_ID}:${session}`;
    const owner = await findOpenClawAgentSessionOwner(canonical, database);
    if (owner === user.userId) return canonical;
    return openClawAgentChatSessionKey(user.userId, DEFAULT_HOST_AGENT_ID, session);
  }
  return session;
}

async function resolveOpenClawTurnSessionKey(
  rawSession: unknown,
  rawAgentId: unknown,
  user: Pick<JwtPayload, 'role' | 'userId'>,
  database: ProjectActivityScopeDatabase = prisma,
): Promise<string> {
  const session = normalizePortalNewSessionAlias(rawSession);
  if (session.startsWith('agent:')) {
    return resolveOpenClawSessionKey(session, user, database);
  }

  const requestedAgentId = typeof rawAgentId === 'string' && rawAgentId.trim()
    ? rawAgentId.trim()
    : 'main';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requestedAgentId)) {
    throw new Error('Invalid OpenClaw agent');
  }
  return resolveOpenClawSessionKey(
    `agent:${requestedAgentId}:${session || 'main'}`,
    user,
    database,
  );
}

function normalizeOpenClawAgentList(rawAgents: unknown): any[] {
  if (Array.isArray(rawAgents)) return rawAgents;
  if (rawAgents && typeof rawAgents === 'object') {
    return Object.entries(rawAgents as Record<string, any>).map(([id, value]) => ({
      id,
      ...(value && typeof value === 'object' ? value : {}),
    }));
  }
  return [];
}

function normalizeGatewayModelId(rawModel: unknown): string | undefined {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    return trimmed || undefined;
  }

  if (!rawModel) return undefined;

  if (Array.isArray(rawModel)) {
    for (const entry of rawModel) {
      const normalized = normalizeGatewayModelId(entry);
      if (normalized) return normalized;
    }
    return undefined;
  }

  if (typeof rawModel !== 'object') return undefined;

  const record = rawModel as Record<string, any>;
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const directModel = normalizeGatewayModelId(record.model);
  if (provider && directModel && !directModel.includes('/')) {
    return `${provider}/${directModel}`;
  }

  const candidates = [
    record.primary,
    record.currentModel,
    record.defaultModel,
    record.id,
    record.name,
    record.fallbacks,
    directModel,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeGatewayModelId(candidate);
    if (normalized) return normalized;
  }

  return undefined;
}

function normalizeGatewayModelCatalogIds(rawModels: unknown): string[] {
  if (!Array.isArray(rawModels)) return [];
  const ids = new Set<string>();
  for (const model of rawModels) {
    const direct = normalizeGatewayModelId(model);
    const provider = model && typeof model === 'object' && typeof (model as any).provider === 'string'
      ? (model as any).provider.trim()
      : '';
    const rawId = model && typeof model === 'object'
      ? String((model as any).id || (model as any).name || (model as any).model || '').trim()
      : String(model || '').trim();
    const canonical = canonicalizeProviderModelId(provider, rawId || direct || '');
    const normalizedDirect = normalizePortalModelId(direct || rawId);
    if (canonical) ids.add(canonical);
    if (normalizedDirect) ids.add(normalizedDirect);
  }
  return Array.from(ids);
}

async function resolveOpenClawPatchModel(rawModel: string): Promise<string> {
  const normalized = normalizePortalModelId(rawModel);
  if (!normalized) return '';
  try {
    const live = await listGatewayModels();
    if (live.ok) {
      const resolved = resolvePortalModelFromCatalog(normalized, normalizeGatewayModelCatalogIds(live.models));
      if (resolved) return resolved;
    }
  } catch {
    // If the live catalog is unavailable, fall back to the normalized request.
  }
  return normalized;
}

function isSandboxProjectAgentIdForUser(agentId: string, user: JwtPayload): boolean {
  const normalized = String(agentId || '').trim();
  if (!normalized) return false;
  return normalized.startsWith(`portal-${user.userId.slice(0, 8)}-`);
}

function isSandboxProjectSessionKeyForUser(sessionKey: string, user: JwtPayload): boolean {
  const normalized = String(sessionKey || '').trim();
  if (!normalized || !shouldIsolateUser(user)) return false;

  const match = normalized.match(/^agent:([^:]+):(portal-[^:]+)$/);
  if (!match) return false;

  const [, agentId, sessionId] = match;
  if (!isSandboxProjectAgentIdForUser(agentId, user)) return false;
  return sessionId.startsWith(`portal-${user.userId}-`);
}

async function assertGatewaySessionAccess(
  sessionKey: string,
  user: JwtPayload,
  options?: {
    providerName?: AgentProviderName | string | undefined;
    database?: ProjectActivityScopeDatabase;
  },
): Promise<void> {
  const providerName = String(options?.providerName || 'OPENCLAW').trim().toUpperCase();
  if (providerName !== 'OPENCLAW') {
    if (isElevatedRole(user.role)) return;
    throw new Error('Admin access required');
  }

  if (isSandboxProjectSessionKeyForUser(sessionKey, user)) return;
  if (!isElevatedRole(user.role)) throw new Error('Admin access required');

  const database = options?.database || prisma;
  if (await isProjectChatActivitySession(sessionKey, database, user.userId)) {
    throw new Error('Admin access required');
  }
  await claimOpenClawAgentSession(sessionKey, user.userId, database, user.role);
}

/**
 * Read-only OpenClaw session authorization.
 *
 * Long-lived WebSocket delivery paths must never converge ownership or touch
 * lastActivityAt: those writes could begin under an old authorization
 * generation and settle after a transition commits. Session creation remains
 * on the Portal broker, where request/host-run admission owns the mutation
 * lease.
 */
async function assertExistingGatewaySessionAccess(
  sessionKey: string,
  user: JwtPayload,
  options?: {
    providerName?: AgentProviderName | string | undefined;
    database?: ProjectActivityScopeDatabase;
  },
): Promise<void> {
  const providerName = String(options?.providerName || 'OPENCLAW').trim().toUpperCase();
  if (providerName !== 'OPENCLAW') {
    if (isElevatedRole(user.role)) return;
    throw new Error('Admin access required');
  }

  if (isSandboxProjectSessionKeyForUser(sessionKey, user)) return;
  if (!isElevatedRole(user.role)) throw new Error('Admin access required');

  const database = options?.database || prisma;
  if (await isProjectChatActivitySession(sessionKey, database, user.userId)) {
    throw new Error('Admin access required');
  }
  const ownerUserId = await findOpenClawAgentSessionOwner(sessionKey, database);
  if (ownerUserId !== user.userId) throw new Error('Admin access required');
}

const NATIVE_AGENT_SESSION_PROVIDERS: readonly AgentProviderName[] = Object.freeze([
  'CLAUDE_CODE',
  'CODEX',
  'GEMINI',
  'GROK',
  'AGENT_ZERO',
  'OLLAMA',
]);

function findNativeAgentSessionOwner(sessionId: string): string | null {
  const owners = new Set<string>();
  for (const providerName of NATIVE_AGENT_SESSION_PROVIDERS) {
    try {
      const session = loadNativeSession(providerName, sessionId);
      if (session?.userId) owners.add(session.userId);
    } catch {
      // A malformed/unreadable provider store is not ownership evidence.
    }
  }
  return owners.size === 1 ? [...owners][0] : null;
}

async function assertAgentStreamSessionAccess(
  sessionKey: string,
  user: JwtPayload,
): Promise<void> {
  if (sessionKey.startsWith('agent:')) {
    await assertExistingGatewaySessionAccess(sessionKey, user);
    return;
  }
  if (!isElevatedRole(user.role) || findNativeAgentSessionOwner(sessionKey) !== user.userId) {
    throw new Error('Admin access required');
  }
}

type ProjectActivityScopeDatabase = Pick<typeof prisma,
  | 'agentSession'
  | 'projectChatProviderBinding'
  | 'projectChatSession'
  | 'projectChatMessage'
  | 'projectChatTurn'
  | 'legacyOpenClawProjectImport'
  | 'legacyOpenClawProjectQuarantine'
>;

async function findOpenClawAgentSessionOwner(
  rawSessionKey: string,
  database: ProjectActivityScopeDatabase = prisma,
): Promise<string | null> {
  const sessionKey = String(rawSessionKey || '').trim();
  if (!sessionKey) return null;
  const existing = await database.agentSession.findFirst({
    where: {
      provider: 'OPENCLAW',
      externalId: sessionKey,
    },
    select: { userId: true },
  });
  return existing?.userId || null;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as any).code === 'P2002');
}

async function claimOpenClawAgentSession(
  rawSessionKey: string,
  rawActorUserId: string,
  database: ProjectActivityScopeDatabase = prisma,
  actorRole?: string | null,
): Promise<void> {
  const sessionKey = String(rawSessionKey || '').trim();
  const actorUserId = String(rawActorUserId || '').trim();
  if (!sessionKey || !actorUserId) throw new Error('Admin access required');

  const embeddedActorId = openClawSessionActorId(sessionKey);
  if (embeddedActorId && embeddedActorId !== actorUserId.toLowerCase()) {
    throw new Error('Admin access required');
  }
  // The OWNER is the host operator: sessions they created through the OpenClaw
  // web UI or CLI carry no Portal scope, but they are still theirs. Keys scoped
  // to another Portal user were already rejected above, for every role.
  const actorScopedToCurrentUser = isOpenClawSessionActorScopedTo(sessionKey, actorUserId)
    || isOwnerRole(actorRole);

  const touchOwned = async (row: { id: string; userId: string } | null): Promise<boolean> => {
    if (!row) return false;
    if (row.userId !== actorUserId) throw new Error('Admin access required');
    await database.agentSession.update({
      where: { id: row.id },
      data: { status: 'active', lastActivityAt: new Date() },
    });
    return true;
  };

  const existing = await database.agentSession.findFirst({
    where: {
      provider: 'OPENCLAW',
      externalId: sessionKey,
    },
    select: { id: true, userId: true },
  });
  if (await touchOwned(existing)) return;

  if (!actorScopedToCurrentUser) {
    // Legacy/unscoped keys are usable only after an earlier durable claim.
    // This prevents role elevation or ownership transfer from adopting an
    // existing OpenClaw transcript merely by knowing its key.
    throw new Error('Admin access required');
  }

  try {
    await database.agentSession.create({
      data: {
        userId: actorUserId,
        provider: 'OPENCLAW',
        externalId: sessionKey,
        status: 'active',
      },
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
    const winner = await database.agentSession.findFirst({
      where: {
        provider: 'OPENCLAW',
        externalId: sessionKey,
      },
      select: { id: true, userId: true },
    });
    if (!(await touchOwned(winner))) throw error;
  }
}

const LEGACY_PROJECT_USER_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LEGACY_PROJECT_SLUG_PATTERN = '[a-z0-9][a-z0-9_-]{0,95}';
const RESERVED_LEGACY_PROJECT_SESSION_PATTERNS = [
  new RegExp(`^portal-${LEGACY_PROJECT_USER_ID_PATTERN}-${LEGACY_PROJECT_SLUG_PATTERN}$`, 'i'),
  new RegExp(`^agent:portal:portal-${LEGACY_PROJECT_USER_ID_PATTERN}-${LEGACY_PROJECT_SLUG_PATTERN}$`, 'i'),
  // Early 3.x Project agents commonly persisted their canonical OpenClaw lane
  // as `:main`, before Portal also began recording the actor-derived session
  // id. The `portal-<actor8>-` agent namespace is reserved for those runtimes.
  new RegExp(`^agent:portal-[0-9a-f]{8}-${LEGACY_PROJECT_SLUG_PATTERN}:main$`, 'i'),
  new RegExp(
    `^agent:portal-[0-9a-f]{8}-${LEGACY_PROJECT_SLUG_PATTERN}:portal-${LEGACY_PROJECT_USER_ID_PATTERN}-${LEGACY_PROJECT_SLUG_PATTERN}$`,
    'i',
  ),
] as const;

function isReservedLegacyProjectSessionKey(rawSessionKey: string): boolean {
  const sessionKey = String(rawSessionKey || '').trim();
  return Boolean(sessionKey) && RESERVED_LEGACY_PROJECT_SESSION_PATTERNS.some((pattern) => pattern.test(sessionKey));
}

function isActorDerivedLegacyProjectSessionKey(
  rawSessionKey: string,
  rawActorUserId: string,
): boolean {
  const sessionKey = String(rawSessionKey || '').trim();
  const actorUserId = String(rawActorUserId || '').trim();
  if (!sessionKey) return false;
  // Reserved legacy aliases are Project evidence independent of the current
  // browser actor. Otherwise an elevated actor could open another user's
  // config-only 3.x key and bootstrap it into their own AgentSession row.
  if (isReservedLegacyProjectSessionKey(sessionKey)) return true;
  if (!actorUserId) return false;

  const legacySessionPrefix = `portal-${actorUserId}-`;
  if (sessionKey.startsWith(legacySessionPrefix)) return true;

  const match = /^agent:([^:]+):(.+)$/.exec(sessionKey);
  if (!match) return false;
  const [, agentId, legacySessionId] = match;
  if (!legacySessionId.startsWith(legacySessionPrefix)) return false;
  const stableSlug = legacySessionId.slice(legacySessionPrefix.length);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stableSlug)) return false;

  const dedicatedAgentId = `portal-${actorUserId.slice(0, 8)}-${stableSlug}`.slice(0, 64);
  return agentId === dedicatedAgentId || agentId === 'portal';
}

async function attestAgentChatActivitySession(
  rawSessionKey: string,
  rawActorUserId: string,
  database: ProjectActivityScopeDatabase = prisma,
  actorRole?: string | null,
): Promise<void> {
  const sessionKey = String(rawSessionKey || '').trim();
  const actorUserId = String(rawActorUserId || '').trim();
  if (!sessionKey || !actorUserId) return;
  // Registration is positive Agent-surface evidence, but it must never turn
  // an existing/current/legacy Project identity into an Agent title source.
  if (await isProjectChatActivitySession(sessionKey, database, actorUserId)) return;
  await claimOpenClawAgentSession(sessionKey, actorUserId, database, actorRole);
}

async function isProjectChatActivitySession(
  rawSessionKey: string,
  database: ProjectActivityScopeDatabase = prisma,
  actorUserId = '',
): Promise<boolean> {
  const sessionKey = String(rawSessionKey || '').trim();
  if (!sessionKey) return true;
  // Old 3.x Project identities can survive only in OpenClaw config/session
  // inventory. Derive their reserved aliases from the authenticated actor on
  // the server; the browser never guesses scope from this pattern.
  if (isActorDerivedLegacyProjectSessionKey(sessionKey, actorUserId)) return true;

  const [binding, session, message, turn, legacyImport, legacyQuarantine] = await Promise.all([
    database.projectChatProviderBinding.findFirst({
      where: {
        OR: [{ sessionKey }, { externalSessionId: sessionKey }],
      },
      select: { id: true },
    }),
    database.projectChatSession.findFirst({
      where: { sessionKey },
      select: { id: true },
    }),
    database.projectChatMessage.findFirst({
      where: { OR: [{ sessionKey }, { providerSessionId: sessionKey }] },
      select: { id: true },
    }),
    database.projectChatTurn.findFirst({
      where: { providerSessionId: sessionKey },
      select: { id: true },
    }),
    database.legacyOpenClawProjectImport.findFirst({
      where: {
        OR: [{ sourceSessionKey: sessionKey }, { providerSessionId: sessionKey }],
      },
      select: { id: true },
    }),
    database.legacyOpenClawProjectQuarantine.findFirst({
      where: { OR: [{ sessionKey }, { providerSessionId: sessionKey }] },
      select: { id: true },
    }),
  ]);

  return Boolean(binding || session || message || turn || legacyImport || legacyQuarantine);
}

const AGENT_ACTIVITY_SCOPE_CACHE_MAX_ENTRIES = 2_048;
const agentActivityScopePending = new Map<string, Promise<boolean>>();

async function isAgentChatActivitySession(
  rawSessionKey: string,
  rawActorUserId: string,
  database: ProjectActivityScopeDatabase = prisma,
): Promise<boolean> {
  const sessionKey = String(rawSessionKey || '').trim();
  const actorUserId = String(rawActorUserId || '').trim();
  if (!sessionKey || !actorUserId) return false;
  const pendingKey = `${actorUserId}\u0000${sessionKey}`;
  const inflight = agentActivityScopePending.get(pendingKey);
  if (inflight) return inflight;

  // Coalesce only concurrent checks. A positive Agent classification is never
  // cached across events because the same external key can later acquire an
  // authoritative current or legacy Project binding.
  let pending!: Promise<boolean>;
  pending = Promise.all([
    database.agentSession.findFirst({
      where: {
        userId: actorUserId,
        provider: 'OPENCLAW',
        externalId: sessionKey,
        status: 'active',
      },
      select: { id: true },
    }),
    isProjectChatActivitySession(sessionKey, database, actorUserId),
  ])
    .then(([agentSession, isProject]) => Boolean(agentSession) && !isProject)
    // Activity titles are optional presentation metadata. If authoritative
    // scope attestation is unavailable, fail closed and emit no title.
    .catch(() => false)
    .finally(() => {
      if (agentActivityScopePending.get(pendingKey) === pending) {
        agentActivityScopePending.delete(pendingKey);
      }
    });
  while (agentActivityScopePending.size >= AGENT_ACTIVITY_SCOPE_CACHE_MAX_ENTRIES) {
    const oldest = agentActivityScopePending.keys().next().value;
    if (typeof oldest !== 'string') break;
    agentActivityScopePending.delete(oldest);
  }
  agentActivityScopePending.set(pendingKey, pending);
  return pending;
}

/** Agent Chat is the elevated, host-wide operator control plane. */
function requireHostOperatorExecutionContext(user: JwtPayload): HostOperatorExecutionContext {
  if (!isElevatedRole(user.role)) throw new Error('Admin access required');
  return createHostOperatorExecutionContext(user.userId);
}

function assertProviderExecutionContext(providerName: AgentProviderName, executionContext: AgentExecutionContext): void {
  assertExecutionContextBinding(executionContext, executionContext.userId);
  assertProviderSupportsExecutionScope(
    providerName,
    getProviderCapabilities(providerName)?.supportedExecutionScopes,
    executionContext,
  );
}

const REGISTERED_AGENT_PROVIDER_NAMES = new Set<AgentProviderName>([
  'OPENCLAW',
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
]);

class UnknownAgentProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown provider: ${provider || 'empty'}`);
    this.name = 'UnknownAgentProviderError';
  }
}

function normalizeProviderName(input: unknown): AgentProviderName {
  const normalized = String(input || 'OPENCLAW').trim().toUpperCase();
  const provider = normalized || 'OPENCLAW';
  if (!REGISTERED_AGENT_PROVIDER_NAMES.has(provider as AgentProviderName)) {
    throw new UnknownAgentProviderError(provider);
  }
  return provider as AgentProviderName;
}

function isProviderModelResetAlias(value: unknown): boolean {
  return /^(?:default|reset)$/i.test(String(value || '').trim());
}

function routeProviderForRequestedModel(providerName: unknown, _requestedModel: unknown): AgentProviderName {
  // A model identifier may resemble another harness's catalog namespace, but
  // it must never silently change the selected provider. OpenClaw-owned model
  // rows stay on OpenClaw; native Gemini is selected only when the user chose
  // the Gemini harness. This keeps history, capabilities, and execution scope
  // bound to the provider shown in the UI.
  return normalizeProviderName(providerName);
}

function isNativeSessionPlaceholder(rawSession: unknown): boolean {
  const session = typeof rawSession === 'string' ? rawSession.trim() : '';
  return !session || session === 'main' || session.startsWith('new-') || session.startsWith('agent:');
}

function getOwnedNativeSession(
  providerName: AgentProviderName,
  userId: string,
  rawSession: unknown,
  executionContext?: AgentExecutionContext,
  options?: { metadataOnly?: boolean },
) {
  if (isNativeSessionPlaceholder(rawSession)) return null;
  const sessionId = typeof rawSession === 'string' ? rawSession.trim() : '';
  if (!sessionId) return null;
  let session = options?.metadataOnly
    ? loadNativeSessionMetadata(providerName, sessionId)
    : loadNativeSession(providerName, sessionId);
  if (!session || session.userId !== userId) return null;
  if (executionContext) {
    session = ensureNativeSessionExecutionContext(providerName, sessionId, executionContext);
    if (!session) return null;
    assertExecutionContextBinding(session.executionContext, userId, executionContext.scope);
  }
  return session;
}

async function validatedNativeModelSelection(
  providerName: AgentProviderName,
  rawModel: unknown,
): Promise<string> {
  const normalized = normalizeRequestedModel(
    providerName,
    typeof rawModel === 'string' ? rawModel.trim() : '',
  );
  if (providerName === 'AGENT_ZERO') {
    return (await validateAgentZeroOAuthModelSelection(normalized)).id;
  }
  return normalized;
}

interface NativeSessionForTurnInput {
  provider: AgentProvider;
  userId: string;
  userEmail: string;
  clientSession: string;
  executionContext: AgentExecutionContext;
  requestedModel: unknown;
}

async function resolveNativeSessionForTurn(input: NativeSessionForTurnInput): Promise<string> {
  const providerName = input.provider.providerName;
  const requestedText = typeof input.requestedModel === 'string'
    ? input.requestedModel.trim()
    : '';
  const requested = requestedText
    ? normalizeRequestedModel(providerName, requestedText)
    : '';
  const reusable = getOwnedNativeSession(
    providerName,
    input.userId,
    input.clientSession,
    input.executionContext,
  );

  if (!reusable) {
    const initialModel = providerName === 'AGENT_ZERO'
      ? await validatedNativeModelSelection(providerName, requested)
      : requested || undefined;
    return input.provider.startSession(input.userId, {
      executionContext: input.executionContext,
      model: initialModel,
      metadata: { requestedBy: input.userEmail },
    });
  }

  const capabilities = getProviderCapabilities(providerName);
  if (capabilities?.modelSelectionMode === 'launch') {
    const existingModel = normalizeRequestedModel(providerName, reusable.model || '');
    if (requested && requested !== existingModel) {
      return input.provider.startSession(input.userId, {
        executionContext: input.executionContext,
        model: requested,
        metadata: {
          requestedBy: input.userEmail,
          replacedSessionId: reusable.sessionId,
          replacementReason: 'launch-bound-model-change',
        },
      });
    }
    return reusable.sessionId;
  }

  if (providerName === 'AGENT_ZERO') {
    // Revalidate and re-assert every reused context. This repairs sessions
    // created by the old local-only switcher and prevents stale OAuth models
    // from silently falling through to Agent Zero's global/OpenRouter default.
    const selected = await validatedNativeModelSelection(
      providerName,
      requested || reusable.model || '',
    );
    await setNativeSessionModel(providerName, reusable.sessionId, selected);
  } else if (requested) {
    await setNativeSessionModel(providerName, reusable.sessionId, requested);
  }
  return reusable.sessionId;
}

function humanizeProviderError(providerName: AgentProviderName, rawMessage: string): string {
  const message = String(rawMessage || '').trim();
  if (!message) return 'The agent failed to respond.';

  if (providerName === 'AGENT_ZERO') {
    if (message.includes(AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE)) {
      return AGENT_ZERO_MODEL_PROTOCOL_INCOMPATIBLE_MESSAGE;
    }
    if (/^(?:Agent Zero (?:could not verify its official OAuth model catalog|did not advertise its complete official OAuth provider catalog|has no connected OAuth provider with selectable models)|Choose a model from a connected Agent Zero OAuth provider|The selected Agent Zero OAuth model is not available)/i.test(message)) {
      return redactNativeProviderText(message, 2_048);
    }
    return safeAgentZeroErrorMessage(message);
  }

  if (/not logged in|not signed in|please run \/login|grok login/i.test(message)) {
    if (providerName === 'CLAUDE_CODE') {
      return 'Claude Code is installed on the server but not logged in yet. Run /login in Claude Code, then try again.';
    }
    if (providerName === 'GROK') {
      return 'Grok Build is installed but not signed in on this server. Complete the native Grok device login in AI Setup, then try again. OpenClaw xAI auth is separate.';
    }
    return 'This provider is installed on the server but not logged in yet. Complete CLI login, then try again.';
  }

  if (/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|Auth method/i.test(message)) {
    return 'Antigravity is installed but not authenticated on the server. Run the native Antigravity login flow in AI Setup and try again.';
  }

  if (/failed to connect to websocket: HTTP error: 500 Internal Server Error, url: wss:\/\/api\.openai\.com\/v1\/responses/i.test(message)) {
    return 'Codex could not reach the OpenAI Responses service from this server. Check Codex authentication/networking and try again.';
  }

  if (/ECONNREFUSED|connect ECONNREFUSED|gateway.*not connected|Cannot connect to OpenClaw gateway/i.test(message)) {
    return providerName === 'OPENCLAW'
      ? 'OpenClaw is reconnecting right now. Give it a few seconds, then try again.'
      : 'The agent backend is temporarily unavailable. Give it a few seconds, then try again.';
  }

  return message;
}

function readConfigPath(source: any, pathStr: string): any {
  const parts = String(pathStr || '').split('.').map((part) => part.trim()).filter(Boolean);
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function writeConfigPath(target: any, pathStr: string, value: any): void {
  const parts = String(pathStr || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function deleteConfigPath(target: any, pathStr: string): void {
  const parts = String(pathStr || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') return;
    cursor = cursor[key];
  }
  delete cursor[parts[parts.length - 1]];
}

function readOpenClawAgentsFromDisk(): any[] {
  if (!existsSync(AGENTS_BASE)) return [];

  return readdirSync(AGENTS_BASE)
    .filter((entry) => {
      if (!entry || entry.startsWith('portal-')) return false;
      const agentRoot = path.join(AGENTS_BASE, entry);
      return statSync(agentRoot).isDirectory();
    })
    .map((entry) => {
      const modelsPath = path.join(AGENTS_BASE, entry, 'agent', 'models.json');
      let defaultModel: string | undefined;
      try {
        if (existsSync(modelsPath)) {
          const parsed = JSON.parse(readFileSync(modelsPath, 'utf-8'));
          defaultModel = parsed?.currentModel || parsed?.defaultModel || parsed?.model;
        }
      } catch {}

      return {
        id: entry,
        workspace: path.join(AGENTS_BASE, entry, 'workspace'),
        defaultModel,
      };
    });
}

async function listOpenClawAgentsForSelector(): Promise<any[]> {
  const rpcResult = await Promise.race([
    gatewayRpcCall('agents.list', {}, 1500),
    new Promise<{ ok: false; error: string }>((resolve) => setTimeout(() => resolve({ ok: false, error: 'Gateway RPC timeout' }), 1600)),
  ]);
  const fromRpc = rpcResult.ok ? normalizeOpenClawAgentList(rpcResult.data?.agents) : [];
  const fallback = readOpenClawAgentsFromDisk();
  const merged = new Map<string, any>();

  for (const source of [fallback, fromRpc]) {
    for (const agent of source) {
      const id = String(agent?.id || agent?.name || '').trim();
      if (!id) continue;
      merged.set(id, {
        ...(merged.get(id) || {}),
        ...agent,
        id,
      });
    }
  }

  if (!merged.has('main')) {
    merged.set('main', { id: 'main' });
  }

  return Array.from(merged.values()).map((agent) => ({
    ...agent,
    model: normalizeGatewayModelId(agent?.model ?? agent?.defaultModel ?? agent?.currentModel),
    defaultModel: normalizeGatewayModelId(agent?.defaultModel),
    currentModel: normalizeGatewayModelId(agent?.currentModel),
  }));
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function extractText(content: any): string {
  return extractSanitizedText(content);
}

function defaultCompactionNoticeText(compactionMeta?: any): string {
  const signal = String(compactionMeta?.phase || compactionMeta?.status || '').trim().toLowerCase();
  if (signal === 'start' || signal === 'started' || signal === 'compacting' || signal === 'compaction_start') {
    return 'Compacting context…';
  }
  if (compactionMeta?.completed === false || signal === 'incomplete' || signal === 'did_not_complete') {
    return 'Context maintenance finished.';
  }
  return 'Context compacted';
}

function extractCompactionNoticeText(content: any, compactionMeta?: any): string {
  const text = extractText(content);
  return text || defaultCompactionNoticeText(compactionMeta);
}

function isCompactionNoticeText(text: unknown): boolean {
  const normalized = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!normalized) return false;
  if (!/(?:\b(context compacted|compaction (?:complete(?:d)?|finished|in progress|started|incomplete|did not complete|skipped)|compacting context|context maintenance(?: in progress| finished| complete(?:d)?)?|auto-compaction|preparing context maintenance|preparing compaction|memory flush(?: started| complete(?:d)?| in progress)?|heartbeat check (?:started|complete(?:d)?)|heartbeat_ok)\b|(?:^|[^\w])compacted\s*\()/i.test(normalized)) return false;

  const marker = normalized.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return [
    /^context compacted\.?$/i,
    /^context maintenance (?:in progress|finished|complete(?:d)?)\.?$/i,
    /^compacting context[.…]*$/i,
    /^preparing (?:context maintenance|compaction)[.…]*$/i,
    /^memory flush(?: started| complete(?:d)?| in progress)?[.…]*$/i,
    /^heartbeat check (?:started|complete(?:d)?)[.…]*$/i,
    /^heartbeat_ok\.?$/i,
    /^compacted\s*\([^)]{1,80}\)(?:\s*[•-]\s*context\b.*)?$/i,
    /^compaction (?:complete(?:d)?|finished|in progress|started|incomplete|did not complete)\.?$/i,
    /^compaction skipped(?::.*)?$/i,
  ].some((pattern) => pattern.test(marker));
}


function maintenanceHistoryPathForSession(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey || 'main').digest('hex').slice(0, 32);
  return path.join(MAINTENANCE_HISTORY_DIR, `${digest}.jsonl`);
}

function defaultMaintenanceNoticeText(evt: StreamEvent): string {
  if (evt.type === 'compaction_start') return 'Compacting context…';
  if (evt.type === 'compaction_end') return evt.completed === false ? 'Context maintenance finished.' : 'Context compacted';
  return evt.maintenanceKind === 'maintenance' ? 'Context maintenance in progress…' : 'Context maintenance finished.';
}

function buildMaintenanceHistoryMarker(sessionKey: string, evt: StreamEvent): any | null {
  if (!sessionKey) return null;
  const text = typeof evt.content === 'string' && evt.content.trim()
    ? evt.content.trim()
    : defaultMaintenanceNoticeText(evt);
  if (!text || !isCompactionNoticeText(text)) return null;

  const isCompaction = evt.type === 'compaction_start'
    || (evt.type === 'compaction_end' && evt.completed !== false && evt.maintenanceKind !== 'maintenance');
  const timestamp = new Date().toISOString();
  const markerId = `maintenance-${createHash('sha256').update(`${sessionKey}:${timestamp}:${evt.type}:${text}`).digest('hex').slice(0, 24)}`;
  return {
    id: markerId,
    role: 'system',
    content: text,
    provenance: isCompaction ? 'compaction' : 'hidden-history-artifact',
    timestamp,
    maintenanceKind: isCompaction ? 'compaction' : 'maintenance',
    __portal: {
      kind: isCompaction ? 'compaction' : 'maintenance',
      source: 'stream-event',
      eventType: evt.type,
    },
  };
}

function recordMaintenanceHistoryMarker(sessionKey: string, evt: StreamEvent): void {
  const marker = buildMaintenanceHistoryMarker(sessionKey, evt);
  if (!marker) return;
  const dedupKey = `${sessionKey}:${marker.maintenanceKind}:${marker.content}`;
  const now = Date.now();
  const last = maintenanceHistoryDedup.get(dedupKey) || 0;
  if (now - last < MAINTENANCE_HISTORY_DEDUP_WINDOW_MS) return;
  maintenanceHistoryDedup.set(dedupKey, now);

  try {
    mkdirSync(MAINTENANCE_HISTORY_DIR, { recursive: true });
    appendFileSync(maintenanceHistoryPathForSession(sessionKey), JSON.stringify(marker) + '\n', 'utf8');
  } catch (err: any) {
    console.warn('[gateway-maintenance-history] Failed to record maintenance marker:', err?.message || err);
  }
}

function readMaintenanceHistoryMarkers(sessionKey: string, limit = 200): any[] {
  if (!sessionKey || limit <= 0) return [];
  const filePath = maintenanceHistoryPathForSession(sessionKey);
  if (!existsSync(filePath)) return [];

  try {
    const lines = readLastJsonlLines(filePath, Math.max(limit * 2, limit)).lines;
    return lines
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((entry) => entry?.role === 'system' && typeof entry?.content === 'string' && entry.content.trim())
      .slice(-Math.max(limit, 1));
  } catch (err: any) {
    console.warn('[gateway-maintenance-history] Failed to read maintenance markers:', err?.message || err);
    return [];
  }
}

function mergeMaintenanceHistoryMarkers(sessionKey: string, messages: any[], limit = 200): any[] {
  const markers = readMaintenanceHistoryMarkers(sessionKey, limit);
  if (markers.length === 0) return messages;

  const seenIds = new Set<string>();
  const combined = [...messages, ...markers]
    .filter((message) => {
      const id = typeof message?.id === 'string' ? message.id : '';
      if (id && seenIds.has(id)) return false;
      if (id) seenIds.add(id);
      return true;
    })
    .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp));
  return combined.slice(-Math.max(limit, 1));
}

function sanitizeHistoryText(text: string): string {
  return stripOpenClawReplyTags(stripEnvelope(text || '')).replace(/\r\n/g, '\n').trim();
}

function stripReasoningMirrorPrefix(text: string): string {
  return sanitizeHistoryText(text || '')
    .replace(/^\s*(?:Codex|OpenClaw) reasoning:\s*/i, '')
    .trim();
}

function isReasoningMirrorHistoryMessage(message: any, text?: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const meta = (message.__openclaw && typeof message.__openclaw === 'object' ? message.__openclaw : null)
    || (message.metadata?.__openclaw && typeof message.metadata.__openclaw === 'object' ? message.metadata.__openclaw : null);
  const mirrorIdentity = typeof meta?.mirrorIdentity === 'string' ? meta.mirrorIdentity : '';
  if (/:reasoning$/i.test(mirrorIdentity)) return true;
  const idempotencyKey = typeof message.idempotencyKey === 'string' ? message.idempotencyKey : '';
  if (/:reasoning(?:$|:)/i.test(idempotencyKey)) return true;
  const candidate = typeof text === 'string' ? text : extractText(message.content ?? message.text ?? '');
  return /^\s*(?:Codex|OpenClaw) reasoning:\s*/i.test(candidate || '');
}

function extractReasoningMirrorHistoryText(message: any, text?: string): string {
  if (!isReasoningMirrorHistoryMessage(message, text)) return '';
  return stripReasoningMirrorPrefix(typeof text === 'string' ? text : extractText(message.content ?? message.text ?? ''));
}

function normalizeGeminiModelId(rawModel: unknown): string | undefined {
  const normalized = normalizeGatewayModelId(rawModel);
  if (!normalized) return undefined;
  if (normalized.includes('/')) return normalized;
  return `${GEMINI_CLI_PROVIDER}/${normalized}`;
}

function getSessionKeyLookupVariants(sessionKey: string): string[] {
  const variants = new Set<string>();
  const normalized = String(sessionKey || '').trim();
  if (!normalized) return [];

  const add = (value: string) => {
    const trimmed = String(value || '').trim();
    if (trimmed) variants.add(trimmed);
  };

  add(normalized);
  add(normalizePortalNewSessionAlias(normalized));

  const agentMatch = normalized.match(/^agent:([^:]+):(.+)$/);
  if (agentMatch) {
    const [, agentId, sessionName] = agentMatch;
    if (sessionName.startsWith('new-')) add(`agent:${agentId}:portal-${sessionName}`);
    if (sessionName.startsWith('portal-new-')) add(`agent:${agentId}:${sessionName.replace(/^portal-/, '')}`);
  } else {
    if (normalized.startsWith('new-')) add(`portal-${normalized}`);
    if (normalized.startsWith('portal-new-')) add(normalized.replace(/^portal-/, ''));
  }

  return Array.from(variants);
}

function resolveSessionRegistryEntries(sessionKey: string, sessionsDir = SESSIONS_DIR): any[] {
  const sessionsFile = path.join(sessionsDir, 'sessions.json');
  if (!existsSync(sessionsFile)) return [];

  try {
    const data = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
    const sessions = (Array.isArray(data.sessions) && data.sessions.length === 0) ? data : (data.sessions || data);
    const variants = new Set(getSessionKeyLookupVariants(sessionKey));
    const entries: any[] = [];

    if (typeof sessions === 'object' && !Array.isArray(sessions)) {
      for (const key of variants) {
        if (sessions[key]) entries.push(sessions[key]);
      }
      return entries;
    }

    if (Array.isArray(sessions)) {
      return sessions.filter((session: any) => {
        const key = String(session?.key || session?.sessionKey || session?.id || '').trim();
        return key && variants.has(key);
      });
    }
  } catch {
    return [];
  }

  return [];
}

function resolveGeminiCliBindingSessionId(entry: any): string | null {
  const bindingSessionId = typeof entry?.cliSessionBindings?.[GEMINI_CLI_PROVIDER]?.sessionId === 'string'
    ? entry.cliSessionBindings[GEMINI_CLI_PROVIDER].sessionId.trim()
    : '';
  if (bindingSessionId) return bindingSessionId;

  const legacySessionId = typeof entry?.cliSessionIds?.[GEMINI_CLI_PROVIDER] === 'string'
    ? entry.cliSessionIds[GEMINI_CLI_PROVIDER].trim()
    : '';
  return legacySessionId || null;
}

function walkGeminiCliTranscriptFiles(dirPath: string, results: string[], depth = 0): void {
  if (depth > 6 || !existsSync(dirPath)) return;

  let entries: any[] = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true }) as any[];
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory?.()) {
      walkGeminiCliTranscriptFiles(fullPath, results, depth + 1);
      continue;
    }
    if (!entry.isFile?.() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl'))) continue;
    if (!fullPath.includes(`${path.sep}chats${path.sep}`)) continue;
    results.push(fullPath);
  }
}

function mergeGeminiCliTranscriptRecord(existing: any, next: any): any {
  if (!existing) return next;
  return {
    ...existing,
    ...next,
    timestamp: next?.timestamp || existing?.timestamp,
    type: next?.type || existing?.type,
    model: next?.model || existing?.model,
    content: typeof next?.content === 'string'
      ? (next.content || existing?.content || '')
      : (next?.content ?? existing?.content),
    thoughts: Array.isArray(next?.thoughts) && next.thoughts.length > 0
      ? next.thoughts
      : (existing?.thoughts || []),
    toolCalls: Array.isArray(next?.toolCalls) && next.toolCalls.length > 0
      ? next.toolCalls
      : (existing?.toolCalls || []),
    tokens: next?.tokens || existing?.tokens,
  };
}

function loadGeminiCliTranscript(filePath: string): { sessionId: string; messages: any[] } | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;

    if (filePath.endsWith('.jsonl')) {
      const records = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as any[];

      if (records.length === 0) return null;

      const header = records.find((record) => typeof record?.sessionId === 'string');
      const sessionId = typeof header?.sessionId === 'string' ? header.sessionId.trim() : '';
      if (!sessionId) return null;

      const order: string[] = [];
      const byId = new Map<string, any>();
      for (const record of records) {
        const type = typeof record?.type === 'string' ? record.type.trim().toLowerCase() : '';
        if (!type) continue;
        const id = typeof record?.id === 'string' ? record.id.trim() : '';
        if (!id) continue;
        if (!byId.has(id)) order.push(id);
        byId.set(id, mergeGeminiCliTranscriptRecord(byId.get(id), record));
      }

      return {
        sessionId,
        messages: order.map((id) => byId.get(id)).filter(Boolean),
      };
    }

    const parsed = JSON.parse(raw);
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() : '';
    if (!sessionId) return null;
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return { sessionId, messages };
  } catch {
    return null;
  }
}

function getGeminiCliTranscriptIndex(): Map<string, string> {
  const now = Date.now();
  if (geminiCliTranscriptIndexCache && (now - geminiCliTranscriptIndexCache.at) < GEMINI_CLI_TRANSCRIPT_INDEX_TTL_MS) {
    return geminiCliTranscriptIndexCache.index;
  }

  const index = new Map<string, string>();
  const files: string[] = [];
  walkGeminiCliTranscriptFiles(GEMINI_CLI_TMP_DIR, files);

  for (const filePath of files) {
    const loaded = loadGeminiCliTranscript(filePath);
    const sessionId = loaded?.sessionId || '';
    if (!sessionId) continue;

    const existing = index.get(sessionId);
    if (!existing) {
      index.set(sessionId, filePath);
      continue;
    }

    try {
      const existingMtime = statSync(existing).mtimeMs;
      const nextMtime = statSync(filePath).mtimeMs;
      if (nextMtime >= existingMtime) index.set(sessionId, filePath);
    } catch {
      index.set(sessionId, filePath);
    }
  }

  geminiCliTranscriptIndexCache = { at: now, index };
  return index;
}

function resolveGeminiCliTranscriptPath(cliSessionId: string): string | null {
  if (!cliSessionId) return null;
  return getGeminiCliTranscriptIndex().get(cliSessionId) || null;
}

function extractGeminiCliText(content: unknown): string {
  if (typeof content === 'string') return sanitizeHistoryText(content);
  if (Array.isArray(content)) {
    const joined = content
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n');
    return sanitizeHistoryText(joined);
  }
  return '';
}

function extractGeminiCliToolResult(rawResult: unknown): string {
  const parts: string[] = [];

  const pushValue = (value: unknown) => {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) parts.push(normalized);
      return;
    }
    if (value && typeof value === 'object') {
      try {
        parts.push(JSON.stringify(value, null, 2));
      } catch {
        // ignore unserializable objects
      }
    }
  };

  if (Array.isArray(rawResult)) {
    for (const entry of rawResult) {
      const response = entry?.functionResponse?.response;
      if (response && typeof response === 'object' && typeof response.output === 'string') {
        pushValue(response.output);
        continue;
      }
      pushValue(response);
      pushValue(entry?.text);
    }
  } else {
    pushValue(rawResult);
  }

  return parts.join('\n\n').trim();
}

function readGeminiCliImportedMessages(cliSessionId: string, limit = 200): any[] {
  const transcriptPath = resolveGeminiCliTranscriptPath(cliSessionId);
  if (!transcriptPath) return [];

  try {
    const loaded = loadGeminiCliTranscript(transcriptPath);
    const rawMessages = Array.isArray(loaded?.messages) ? loaded.messages : [];
    const importedMessages: any[] = [];

    for (const message of rawMessages) {
      const type = typeof message?.type === 'string' ? message.type.trim().toLowerCase() : '';
      const timestamp = message?.timestamp;
      const messageId = typeof message?.id === 'string' ? message.id : `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (type === 'user') {
        const text = extractGeminiCliText(message?.content);
        if (!text || isHiddenHistoryArtifactText(text)) continue;
        importedMessages.push({
          id: messageId,
          role: 'user',
          content: text,
          timestamp,
          provenance: 'gemini-cli-import',
        });
        continue;
      }

      if (type !== 'gemini' && type !== 'model') continue;

      const content = extractGeminiCliText(message?.content);
      const thinkingContent = sanitizeHistoryText(
        Array.isArray(message?.thoughts)
          ? message.thoughts
              .map((thought: any) => typeof thought?.description === 'string'
                ? thought.description
                : (typeof thought?.text === 'string' ? thought.text : ''))
              .filter(Boolean)
              .join('\n\n')
          : '',
      );
      const toolCalls = Array.isArray(message?.toolCalls)
        ? message.toolCalls
            .map((toolCall: any) => {
              const toolName = typeof toolCall?.name === 'string' ? toolCall.name.trim() : '';
              if (!toolName) return null;
              const endedAt = toHistoryTimestampMs(toolCall?.timestamp || timestamp);
              return {
                id: typeof toolCall?.id === 'string' && toolCall.id.trim() ? toolCall.id : `${messageId}-tool-${toolName}`,
                name: toolName,
                arguments: toolCall?.args,
                startedAt: endedAt,
                endedAt,
                result: extractGeminiCliToolResult(toolCall?.result),
                status: String(toolCall?.status || '').toLowerCase() === 'error' ? 'error' : 'done',
              };
            })
            .filter(Boolean)
        : [];

      if (!content && !thinkingContent && toolCalls.length === 0) continue;
      if (content && isHiddenHistoryArtifactText(content)) continue;

      importedMessages.push({
        id: messageId,
        role: 'assistant',
        content,
        timestamp,
        model: normalizeGeminiModelId(message?.model),
        thinkingContent: thinkingContent || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        provenance: 'gemini-cli-import',
      });
    }

    return importedMessages.slice(-limit);
  } catch {
    return [];
  }
}

function hasMeaningfulConversationTurns(messages: any[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    if (message.role === 'user' && typeof message.content === 'string' && message.content.trim()) return true;
    if (message.role !== 'assistant') return false;
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return true;
    if (typeof message.thinkingContent === 'string' && message.thinkingContent.trim()) return true;
    if (typeof message.content !== 'string') return false;
    const normalized = message.content.trim();
    return Boolean(normalized) && !/^Model set to /i.test(normalized);
  });
}

function getLatestMeaningfulConversationTimestamp(messages: any[]): number {
  return getLatestMeaningfulConversationMarker(messages)?.timestamp || 0;
}

function getLatestMeaningfulConversationMarker(messages: any[]): { role: 'user' | 'assistant'; timestamp: number; content: string } | null {
  let latest: { role: 'user' | 'assistant'; timestamp: number; content: string } | null = null;
  const consider = (role: 'user' | 'assistant', timestamp: number, content: string) => {
    if (!latest || timestamp > latest.timestamp) latest = { role, timestamp, content };
  };
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    // The runtime-turn-event overlay is portal-synthesized LIVE state whose
    // timestamp tracks the newest stream event. Treating it as durable-turn
    // evidence made the terminal heuristics compare the live lane against
    // itself and declare healthy mid-turn Anthropic sessions finished on
    // every reconnect (the false "interrupted" reports).
    if (message?.__portal?.kind === 'runtime-turn-event-history') continue;
    const timestampMs = toHistoryTimestampMs(message?.timestamp);
    if (!timestampMs) continue;

    if (message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      consider('user', timestampMs, message.content.trim());
      continue;
    }

    if (message.role !== 'assistant') continue;
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      consider('assistant', timestampMs, typeof message.content === 'string' ? message.content.trim() : 'tool call');
      continue;
    }
    if (typeof message.thinkingContent === 'string' && message.thinkingContent.trim()) {
      consider('assistant', timestampMs, typeof message.content === 'string' ? message.content.trim() : message.thinkingContent.trim());
      continue;
    }
    if (typeof message.content !== 'string') continue;
    const normalized = message.content.trim();
    if (normalized && !/^Model set to /i.test(normalized) && !isCompactionNoticeText(normalized)) consider('assistant', timestampMs, normalized);
  }
  return latest;
}

type OpenClawActiveStreamSnapshot = {
  active: boolean;
  inactiveReason?: 'idle' | 'stale' | 'terminal' | 'unknown';
  safeToClear?: boolean;
  phase?: StreamInfo['phase'];
  toolName?: string | null;
  toolCalls?: StreamInfo['toolCalls'];
  statusText?: string | null;
  provenance?: string | null;
  model?: string | null;
  compactionPhase?: StreamInfo['compactionPhase'];
  startedAt?: number;
  runId?: string | null;
  content?: string;
  turnEvents?: RuntimeTurnEvent[];
  lastEventAt?: number;
  staleAfterMs?: number;
};

const OPENCLAW_STREAMING_STALE_CUTOFF_MS = 10 * 60_000;
const OPENCLAW_THINKING_STALE_CUTOFF_MS = 10 * 60_000;
const OPENCLAW_TOOL_STALE_CUTOFF_MS = 15 * 60_000;
const OPENCLAW_RUNNING_TOOL_STALE_CUTOFF_MS = 30 * 60_000;

function inactiveOpenClawSnapshot(
  inactiveReason: NonNullable<OpenClawActiveStreamSnapshot['inactiveReason']>,
  safeToClear = inactiveReason === 'terminal' || inactiveReason === 'stale',
): OpenClawActiveStreamSnapshot {
  return { active: false, inactiveReason, safeToClear };
}

function browserSafeActiveStreamSnapshot(
  providerName: AgentProviderName,
  snapshot: OpenClawActiveStreamSnapshot,
): OpenClawActiveStreamSnapshot {
  if (providerName !== 'OPENCLAW' || !snapshot.active || !Array.isArray(snapshot.turnEvents)) {
    return snapshot;
  }
  const activeRunId = normalizeHostStreamRunId(snapshot.runId);
  return {
    ...snapshot,
    // A real terminal event cannot coexist with an active lane: terminal
    // publication and settlement are synchronous. Exclude stale/preliminary
    // terminal projections from browser hydration, and bind the remainder to
    // the exact active run.
    turnEvents: snapshot.turnEvents.filter((event) => {
      if (event.terminal || event.type === 'turn_error' || event.type === 'assistant_final' || event.type === 'turn_done') {
        return false;
      }
      return !activeRunId || !event.runId || event.runId === activeRunId;
    }),
  };
}

function getProviderOwnedBusStreamSnapshot(sessionKey: string): OpenClawActiveStreamSnapshot {
  const info = streamEventBus.getStreamStatus(sessionKey);
  if (!info) {
    const tracked = streamEventBus.getTrackedStream(sessionKey);
    return tracked?.active === false
      ? inactiveOpenClawSnapshot('terminal', true)
      : inactiveOpenClawSnapshot('unknown', false);
  }

  const capturedRunIdentity = captureHostStreamRunIdentity(sessionKey);

  const lastEventAt = info.lastEventAt || info.startedAt;
  const hasRunningTool = Array.isArray(info.toolCalls)
    && info.toolCalls.some((toolCall) => toolCall?.status === 'running');
  const staleAfterMs = info.phase === 'streaming'
    ? OPENCLAW_STREAMING_STALE_CUTOFF_MS
    : (hasRunningTool || info.phase === 'tool')
      ? OPENCLAW_RUNNING_TOOL_STALE_CUTOFF_MS
      : OPENCLAW_THINKING_STALE_CUTOFF_MS;
  if (lastEventAt && Date.now() - lastEventAt > staleAfterMs) {
    clearHostStreamIfCurrentRun(sessionKey, capturedRunIdentity);
    return inactiveOpenClawSnapshot('stale', true);
  }

  // A tool/status event can move the phase away from `streaming` after visible
  // text has already arrived. Keep that partial answer in the reconnect
  // snapshot instead of making it disappear until the next text delta.
  const content = streamEventBus.getLatestText(sessionKey) || info.latestText || '';
  return {
    active: true,
    phase: info.phase,
    toolName: info.toolName || null,
    toolCalls: Array.isArray(info.toolCalls) ? info.toolCalls : [],
    statusText: info.statusText || null,
    provenance: info.provenance || null,
    model: info.model || null,
    compactionPhase: info.compactionPhase || 'idle',
    startedAt: info.startedAt,
    runId: info.runId || null,
    content: content || undefined,
    turnEvents: streamEventBus.getRecentTurnEvents(sessionKey, 100),
    lastEventAt,
    staleAfterMs,
  };
}

async function getProviderActiveStreamSnapshot(
  providerName: AgentProviderName,
  sessionKey: string,
): Promise<OpenClawActiveStreamSnapshot> {
  if (providerName === 'OPENCLAW') return getOpenClawActiveStreamSnapshot(sessionKey);
  if (providerUsesHostStreamBus(providerName)) return getProviderOwnedBusStreamSnapshot(sessionKey);
  return inactiveOpenClawSnapshot('idle', true);
}

function getOpenClawRunIdFromSessionInfo(sess: any): string | null {
  for (const key of ['runId', 'activeRunId', 'currentRunId']) {
    const value = sess?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeOpenClawChatState(sess: any): 'streaming' | 'thinking' | 'tool' | '' {
  const rawChatState = typeof sess?.chatState === 'string' ? sess.chatState.trim().toLowerCase() : '';
  if (rawChatState === 'streaming' || rawChatState === 'thinking' || rawChatState === 'tool') return rawChatState;

  const rawStatus = typeof sess?.status === 'string' ? sess.status.trim().toLowerCase() : '';
  if (/^(?:running|active|streaming|thinking|tool)$/.test(rawStatus)) return 'thinking';
  return '';
}

function getOpenClawSessionLastActivity(sess: any): number | undefined {
  return [
    sess?.lastActivity,
    sess?.lastActivityMs,
    sess?.updatedAt,
    sess?.updatedAtMs,
    sess?.startedAt,
    sess?.createdAt,
  ].find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) as number | undefined;
}

function getOpenClawRuntimeActiveStreamSnapshot(
  sessionKey: string,
  latestMarker?: { role: 'user' | 'assistant'; timestamp: number; content: string } | null,
): OpenClawActiveStreamSnapshot | null {
  const events = readRuntimeTurnEvents(sessionKey, 250);
  const latest = events[events.length - 1];
  if (!latest) return null;

  if (latest.terminal || latest.type === 'assistant_final' || latest.type === 'turn_done' || latest.type === 'turn_error') {
    return inactiveOpenClawSnapshot('terminal', true);
  }

  // If the durable transcript already has a newer assistant message, the runtime
  // overlay is no longer the live authority. This prevents stale non-terminal
  // tool/status events from keeping Agent Chat in a fake running state forever.
  // (latestMarker excludes the portal runtime overlay itself, so mid-turn
  // overlay state can no longer masquerade as durable completion evidence.)
  if (latestMarker?.role === 'assistant' && latestMarker.timestamp >= latest.ts - 30_000) {
    return inactiveOpenClawSnapshot('terminal', true);
  }

  const hasRunningTool = latest.type === 'tool_started' || latest.tool?.status === 'running';
  // assistant_delta cutoff must tolerate long silent reasoning gaps after a text
  // delta (Claude CLI runtimes routinely pause >3min mid-turn); a tight cutoff
  // here makes stream-status report stale/safeToClear during healthy runs and
  // the browser fuse then wipes live thought bubbles mid-turn.
  const staleCutoffMs = latest.type === 'assistant_delta'
    ? OPENCLAW_STREAMING_STALE_CUTOFF_MS
    : hasRunningTool
      ? OPENCLAW_RUNNING_TOOL_STALE_CUTOFF_MS
      : OPENCLAW_TOOL_STALE_CUTOFF_MS;

  if ((Date.now() - latest.ts) > staleCutoffMs) {
    return inactiveOpenClawSnapshot('stale', true);
  }

  const phase: StreamInfo['phase'] = hasRunningTool
    ? 'tool'
    : latest.type === 'assistant_delta'
      ? 'streaming'
      : 'thinking';
  const statusText = latest.type === 'assistant_status' && latest.text ? latest.text : null;
  const activeRunEvents = events.filter((event) => (
    latest.runId ? event.runId === latest.runId : !event.runId
  ));
  const reconstructedContent = activeRunEvents.reduce((text, event) => {
    if (event.type !== 'assistant_delta' || !event.text) return text;
    return event.replace === true ? event.text : `${text}${event.text}`;
  }, '');

  return {
    active: true,
    phase,
    toolName: latest.tool?.name || null,
    toolCalls: latest.tool
      ? [{
          id: latest.tool.id || `runtime-tool-${latest.ts}`,
          name: latest.tool.name,
          arguments: latest.tool.arguments,
          result: latest.tool.result,
          startedAt: latest.ts,
          status: latest.tool.status || (hasRunningTool ? 'running' : 'done'),
        }]
      : [],
    statusText,
    provenance: latest.provenance || null,
    model: latest.model || null,
    compactionPhase: 'idle',
    startedAt: latest.ts,
    runId: latest.runId || null,
    content: reconstructedContent || undefined,
    turnEvents: activeRunEvents.slice(-100),
    lastEventAt: latest.ts,
    staleAfterMs: staleCutoffMs,
  };
}

async function getOpenClawActiveStreamSnapshot(sessionKey: string): Promise<OpenClawActiveStreamSnapshot> {
  if (!sessionKey) return inactiveOpenClawSnapshot('unknown', false);

  const latestMarker = getLatestMeaningfulConversationMarker(readSessionMessagesEnhancedForSessionKey(sessionKey, 20));

  const info = streamEventBus.getStreamStatus(sessionKey);
  if (info) {
    // Keep an immutable identity across gateway probes. StreamInfo is mutable,
    // so retaining the object reference itself would not detect run replacement
    // while getSessionInfo() is in flight.
    const capturedRunIdentity = captureHostStreamRunIdentity(sessionKey);
    const lastEvent = info.lastEventAt || info.startedAt;
    const hasRunningTool = Array.isArray(info.toolCalls) && info.toolCalls.some((toolCall: any) => toolCall?.status === 'running');
    const staleCutoffMs = info.phase === 'streaming'
      ? OPENCLAW_STREAMING_STALE_CUTOFF_MS
      : (hasRunningTool || info.phase === 'tool' || info.compactionPhase === 'compacting')
        ? OPENCLAW_TOOL_STALE_CUTOFF_MS
        : OPENCLAW_THINKING_STALE_CUTOFF_MS;

    if (lastEvent && (Date.now() - lastEvent) > staleCutoffMs) {
      debugLog(`[stream-status] StreamEventBus has entry but lastEvent=${new Date(lastEvent).toISOString()} exceeded cutoff=${staleCutoffMs}ms for phase=${info.phase} — clearing stale entry`);
      clearHostStreamIfCurrentRun(sessionKey, capturedRunIdentity);
    } else if (latestMarker?.role === 'assistant' && lastEvent && latestMarker.timestamp >= lastEvent - 30_000) {
      // A durable transcript assistant message at/after the live lane usually
      // means the turn finished and the bus entry leaked — but transcripts can
      // also record assistant entries mid-turn (steer boundaries, some
      // harnesses). Ask the gateway which one it is instead of guessing.
      let gatewayLooksLive = false;
      try {
        const sessResult = await getSessionInfo(sessionKey);
        const chatState = sessResult.ok && sessResult.data ? normalizeOpenClawChatState(sessResult.data) : '';
        const lastActivity = sessResult.ok && sessResult.data ? getOpenClawSessionLastActivity(sessResult.data) : undefined;
        gatewayLooksLive = Boolean(chatState) && (!lastActivity || (Date.now() - lastActivity) <= OPENCLAW_TOOL_STALE_CUTOFF_MS);
      } catch {
        // Gateway unreachable: keep the stream alive; the stale cutoff above
        // still bounds how long a genuinely dead entry can linger.
        gatewayLooksLive = true;
      }

      // A different run may have replaced the captured one while the gateway
      // probe awaited. Never clear or return the stale snapshot in that case.
      const currentTracked = streamEventBus.getTrackedStream(sessionKey);
      if (!hostStreamRunIdentityMatches(currentTracked, capturedRunIdentity)) {
        return getProviderOwnedBusStreamSnapshot(sessionKey);
      }
      if (!gatewayLooksLive) {
        debugLog(`[stream-status] StreamEventBus reports active, but durable assistant message at ${new Date(latestMarker.timestamp).toISOString()} and gateway reports no active run — reporting inactive`);
        clearHostStreamIfCurrentRun(sessionKey, capturedRunIdentity);
        return inactiveOpenClawSnapshot('terminal', true);
      }
      debugLog('[stream-status] Durable assistant marker near live lane but gateway confirms the run is live — still active');
      return getProviderOwnedBusStreamSnapshot(sessionKey);
    } else {
      const content = streamEventBus.getLatestText(sessionKey) || info.latestText || '';
      return {
        active: true,
        phase: info.phase,
        toolName: info.toolName || null,
        toolCalls: Array.isArray(info.toolCalls) ? info.toolCalls : [],
        statusText: info.statusText || null,
        provenance: info.provenance || null,
        model: info.model || null,
        compactionPhase: info.compactionPhase || 'idle',
        startedAt: info.startedAt,
        runId: info.runId || null,
        content: content || undefined,
        turnEvents: streamEventBus.getRecentTurnEvents(sessionKey, 100),
        lastEventAt: lastEvent,
        staleAfterMs: staleCutoffMs,
      };
    }
  }

  // StreamEventBus is process memory. After a Portal backend restart it can be
  // empty while OpenClaw is still running the turn, so ask the gateway before
  // telling the browser the stream ended.
  try {
    const sessResult = await getSessionInfo(sessionKey);
    if (streamEventBus.getTrackedStream(sessionKey)) {
      return getProviderOwnedBusStreamSnapshot(sessionKey);
    }
    if (sessResult.ok && sessResult.data) {
      const sess = sessResult.data;
      const chatState = normalizeOpenClawChatState(sess);
      const lastActivity = getOpenClawSessionLastActivity(sess);
      if (chatState) {
        const fallbackStaleCutoffMs = chatState === 'streaming'
          ? OPENCLAW_STREAMING_STALE_CUTOFF_MS
          : OPENCLAW_TOOL_STALE_CUTOFF_MS;
        if (lastActivity && (Date.now() - lastActivity) > fallbackStaleCutoffMs) {
          debugLog(`[stream-status] Gateway reports chatState=${chatState} but lastActivity=${new Date(lastActivity).toISOString()} exceeded fallback cutoff=${fallbackStaleCutoffMs}ms`);
        } else {
          // latestMarker now reflects only the durable transcript (the portal
          // runtime overlay is excluded), so an assistant marker at/after the
          // gateway's activity signal genuinely indicates a completed turn
          // behind a stale chatState.
          const latestAssistantLooksTerminal = latestMarker?.role === 'assistant' && Boolean(latestMarker.content?.trim());
          if (latestAssistantLooksTerminal && (!lastActivity || latestMarker.timestamp >= lastActivity - 30_000)) {
            debugLog(`[stream-status] Gateway reports chatState=${chatState}, but latest durable meaningful message is assistant at ${new Date(latestMarker.timestamp).toISOString()} — reporting inactive`);
            return inactiveOpenClawSnapshot('terminal', true);
          }

          debugLog(`[stream-status] StreamEventBus empty but gateway reports chatState=${chatState} within fallback cutoff and latest durable turn is not terminal assistant — reporting active`);
          return {
            active: true,
            phase: chatState === 'tool' ? 'tool' : chatState === 'streaming' ? 'streaming' : 'thinking',
            toolName: null,
            toolCalls: [],
            statusText: null,
            provenance: null,
            model: normalizeGatewayModelId(sess.model || sess.currentModel || sess.defaultModel) || null,
            compactionPhase: 'idle',
            startedAt: lastActivity || Date.now(),
            lastEventAt: lastActivity || undefined,
            runId: getOpenClawRunIdFromSessionInfo(sess),
            staleAfterMs: fallbackStaleCutoffMs,
          };
        }
      }
    }
  } catch {
    // Fall through to runtime-turn-event recovery. Gateway status can be
    // temporarily unavailable during the exact reconnect path we are trying to heal.
  }

  // The bus was empty before the gateway probe, but a local run can begin while
  // that RPC is in flight. Prefer the newly tracked lane over the older gateway
  // or runtime-history candidate.
  if (streamEventBus.getTrackedStream(sessionKey)) {
    return getProviderOwnedBusStreamSnapshot(sessionKey);
  }

  const runtimeSnapshot = getOpenClawRuntimeActiveStreamSnapshot(sessionKey, latestMarker);
  if (runtimeSnapshot) return runtimeSnapshot;

  return inactiveOpenClawSnapshot('unknown', false);
}

type OpenClawConflictRunProbe =
  | { state: 'active'; runId: string }
  | { state: 'inactive' }
  | { state: 'unknown' };

function exactOpenClawSessionRows(payload: any, agentId: string): any[] {
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  const requested = payload?.agents?.[agentId]?.sessions;
  if (Array.isArray(requested)) return requested;
  if (!payload?.agents || typeof payload.agents !== 'object') return [];
  return Object.values(payload.agents).flatMap((agent: any) => (
    Array.isArray(agent?.sessions) ? agent.sessions : []
  ));
}

function parseExactOpenClawConflictRun(
  payload: any,
  sessionKey: string,
): OpenClawConflictRunProbe {
  const agentId = sessionKey.startsWith('agent:') ? sessionKey.split(':')[1] : 'portal';
  const exactRows = exactOpenClawSessionRows(payload, agentId)
    .filter((candidate: any) => candidate?.key === sessionKey);
  if (exactRows.length !== 1) return { state: 'unknown' };

  const row = exactRows[0];
  const runIds: string[] = Array.isArray(row.activeRunIds)
    ? [...new Set<string>(row.activeRunIds
      .map((value: unknown) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean))]
    : [];
  if (runIds.length === 1 && row.hasActiveRun === true) {
    return { state: 'active', runId: runIds[0] };
  }
  if (runIds.length === 0 && row.hasActiveRun === false) {
    return { state: 'inactive' };
  }
  return { state: 'unknown' };
}

/**
 * A chat.send conflict can come from OpenClaw after the Portal's pending
 * reservation has already been cleared. In that state sessions.describe does
 * not expose the replacement run identity, so attaching its projection leaves
 * the browser fenced forever. Rebuild the local lane only from one exact
 * sessions.list identity; contradictory/multiple results remain fail-closed.
 */
async function reconcileOpenClawActiveTurnConflict(
  sessionKey: string,
): Promise<OpenClawActiveStreamSnapshot> {
  const agentId = sessionKey.startsWith('agent:') ? sessionKey.split(':')[1] : 'portal';
  // sessions.list is an asynchronous observation. Bind its result to the
  // exact local lane that existed when the probe began so a new tab/queued
  // send cannot be replaced or cleared by an older upstream snapshot.
  const predecessorWasTracked = Boolean(streamEventBus.getTrackedStream(sessionKey));
  const predecessorIdentity = captureHostStreamRunIdentity(sessionKey);
  let result: Awaited<ReturnType<typeof gatewayRpcCall>>;
  try {
    result = await gatewayRpcCall('sessions.list', {
      agentId,
      search: sessionKey,
      limit: 50,
    }, 10_000);
  } catch {
    return inactiveOpenClawSnapshot('unknown', false);
  }
  if (!result.ok) return inactiveOpenClawSnapshot('unknown', false);

  const currentTracked = streamEventBus.getTrackedStream(sessionKey);
  const predecessorIsCurrent = predecessorWasTracked
    ? hostStreamRunIdentityMatches(currentTracked, predecessorIdentity)
    : currentTracked === null;
  if (!predecessorIsCurrent) {
    return inactiveOpenClawSnapshot('unknown', false);
  }

  const probe = parseExactOpenClawConflictRun(result.data, sessionKey);
  if (probe.state === 'inactive') {
    // The exact upstream row proves the conflicting turn is gone. Clear any
    // stale local reservation and the exact captured bus lane so the queued
    // browser message can proceed. clearRun owns provider correlation state;
    // the bus is a separate concurrency fence and must be CAS-cleared too.
    clearRun(sessionKey);
    clearHostStreamIfCurrentRun(sessionKey, predecessorIdentity);
    return inactiveOpenClawSnapshot('terminal', true);
  }
  if (probe.state !== 'active') return inactiveOpenClawSnapshot('unknown', false);

  const trackedRunId = normalizeHostStreamRunId(streamEventBus.getTrackedStream(sessionKey)?.runId);
  if (trackedRunId && trackedRunId !== probe.runId) {
    // Exact predecessor CAS: never replace an in-memory lane merely because an
    // unrelated run appeared somewhere in the sessions.list response.
    if (!registerRun(sessionKey, probe.runId, trackedRunId)) {
      return inactiveOpenClawSnapshot('unknown', false);
    }
  }

  // reserve+ack clears the provider's failed-reservation fence as well as
  // installing the exact run in StreamEventBus. Calling startStream alone
  // would look healthy in the browser while PersistentGatewayWs still dropped
  // every subsequent frame.
  if (!reserveLogicalRun(sessionKey, probe.runId)) {
    return inactiveOpenClawSnapshot('unknown', false);
  }
  if (!acknowledgeRunReservation(sessionKey, probe.runId, probe.runId)) {
    failPendingRunReservation(sessionKey, probe.runId);
    return inactiveOpenClawSnapshot('unknown', false);
  }
  streamEventBus.publish(sessionKey, {
    type: 'run_resumed',
    content: '',
    runId: probe.runId,
  });
  return getProviderOwnedBusStreamSnapshot(sessionKey);
}

function normalizeRuntimeHistoryMatchText(text: unknown): string {
  return sanitizeHistoryText(typeof text === 'string' ? text : '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mergeRuntimeText(current: string, incoming: string, replace?: boolean): string {
  // Deltas are recorded with exact whitespace. Claude CLI streams append-style
  // chunks that can split mid-word, so non-overlapping chunks must concatenate
  // verbatim — inserting a newline (markdown-rendered as a space) or trimming
  // per chunk puts phantom spaces inside words. The final assembled text is
  // sanitized once by the caller.
  const chunk = incoming || '';
  if (!chunk) return current;
  if (replace || !current) return chunk;
  if (chunk === current) return current;
  if (chunk.startsWith(current)) return chunk;

  const minOverlap = 8;
  const maxOverlap = Math.min(current.length, chunk.length);
  for (let overlap = maxOverlap; overlap >= minOverlap; overlap -= 1) {
    if (current.slice(-overlap) === chunk.slice(0, overlap)) {
      return current + chunk.slice(overlap);
    }
  }
  // Substring dedupe guards against replayed full snapshots, but only for long
  // chunks: short append deltas (single words, spaces, letters) legitimately
  // repeat inside earlier text and must never be dropped.
  if (chunk.length >= 24 && current.includes(chunk)) return current;
  return current + chunk;
}

function reconcileRuntimeCumulativeFinalTail(
  graduatedText: readonly string[],
  rawFinalContent: string,
): string {
  const finalContent = String(rawFinalContent || '');
  const represented = graduatedText.filter((value) => String(value || '').trim());
  if (!finalContent || represented.length === 0) return finalContent;

  let cursor = 0;
  let matched = 0;
  for (const value of represented) {
    const text = String(value || '');
    const index = finalContent.indexOf(text, cursor);
    if (index < 0 || finalContent.slice(cursor, index).trim()) {
      matched = 0;
      break;
    }
    cursor = index + text.length;
    matched += 1;
  }
  if (matched === represented.length) {
    return finalContent.slice(cursor).replace(/^\s+/, '');
  }

  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const representedComparable = normalize(represented.join(''));
  const finalComparable = normalize(finalContent);
  if (!representedComparable) return finalContent;
  if (finalComparable === representedComparable) return '';
  if (finalComparable.startsWith(`${representedComparable} `)) {
    return finalComparable.slice(representedComparable.length).trimStart();
  }
  return finalContent;
}

type RuntimeHistorySegment = {
  text: string;
  subject?: string;
  position: 'before' | 'after' | 'between';
  kind: 'thinking' | 'text';
  source?: 'status' | 'reasoning' | 'preamble' | 'text';
  ts: number;
  order: number;
};

type RuntimeHistoryToolCall = {
  id: string;
  name: string;
  arguments?: unknown;
  result?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error';
  order: number;
};

// Rail placeholders ("Thinking…") and maintenance notices are transient status
// strip material; persisted status events replaying them as durable thought
// bubbles resurrects the pre-rail thinking bubble in history.
function isGenericStatusPlaceholderText(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return true;
  if (/^(thinking|working|reasoning|processing|responding|running|typing)\s*(…|\.{1,3})?$/i.test(normalized)) return true;
  return isCompactionNoticeText(normalized);
}

function runtimeTurnEventGroupKey(event: RuntimeTurnEvent, fallbackIndex: number): string {
  const runId = typeof event.runId === 'string' && event.runId.trim() ? event.runId.trim() : '';
  if (runId) return runId;
  return `runtime-${Math.floor((event.ts || Date.now()) / 300000)}-${fallbackIndex}`;
}

function buildRuntimeHistoryMessages(events: RuntimeTurnEvent[]): any[] {
  if (!Array.isArray(events) || events.length === 0) return [];

  const groups: Array<{ key: string; events: RuntimeTurnEvent[]; terminal: boolean }> = [];
  let current: { key: string; events: RuntimeTurnEvent[]; terminal: boolean } | null = null;

  for (const event of [...events].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))) {
    if (!event || event.schema !== 'bridgesllm.runtime-turn-event.v1') continue;
    const key = runtimeTurnEventGroupKey(event, groups.length);
    if (!current || current.terminal || current.key !== key) {
      current = { key, events: [], terminal: false };
      groups.push(current);
    }
    current.events.push(event);
    if (event.terminal) current.terminal = true;
  }

  return groups.flatMap((group) => {
    const timeline: Array<{ kind: 'segment'; segment: RuntimeHistorySegment } | { kind: 'tool'; tool: RuntimeHistoryToolCall }> = [];
    const toolsByKey = new Map<string, RuntimeHistoryToolCall>();
    let finalText = '';
    let model: string | undefined;
    let provenance: string | undefined;
    let lastTs = 0;

    const appendSegment = (
      kind: 'thinking' | 'text',
      text: string,
      ts: number,
      replace?: boolean,
      source: RuntimeHistorySegment['source'] = kind === 'thinking' ? 'reasoning' : 'text',
      rawSubject?: unknown,
    ) => {
      const value = sanitizeHistoryText(text || '');
      const subject = kind === 'thinking' ? sanitizeThinkingSubject(rawSubject) : '';
      if ((!value && !subject) || (value && isHiddenHistoryArtifactText(value))) return;
      const last = timeline[timeline.length - 1];
      if (last?.kind === 'segment' && last.segment.kind === kind && last.segment.source === source) {
        if (
          subject
          && last.segment.subject !== subject
          && (last.segment.text || last.segment.subject)
        ) {
          // A new provider preamble starts a distinct reasoning phase.
        } else {
          if (subject) last.segment.subject = subject;
          last.segment.text = replace
            ? value
            : mergeRuntimeText(last.segment.text, value);
          last.segment.ts = ts;
          return;
        }
      }
      timeline.push({
        kind: 'segment',
        segment: {
          text: value,
          ...(subject ? { subject } : {}),
          position: 'before',
          kind,
          source,
          ts,
          order: timeline.length,
        },
      });
    };

    let pendingTextTs = 0;
    // Claude/Codex finals replace the accumulated deltas with only the last
    // post-tool text block, so text streamed before a tool call would vanish
    // from durable history. Flush it as a timestamped text segment instead.
    const flushPendingTextBeforeTool = (ts: number) => {
      const value = sanitizeHistoryText(finalText || '');
      finalText = '';
      if (!value || isHiddenHistoryArtifactText(value)) return;
      appendSegment('text', value, pendingTextTs || ts);
    };

    const upsertTool = (event: RuntimeTurnEvent) => {
      const rawName = typeof event.tool?.name === 'string' ? event.tool.name.trim() : '';
      if (!rawName) return;
      const eventStatus = event.tool?.status === 'error'
        ? 'error'
        : event.tool?.status === 'running'
          ? 'running'
          : event.type === 'tool_output'
            ? 'done'
            : 'running';
      const rawId = typeof event.tool?.id === 'string' && event.tool.id.trim() ? event.tool.id.trim() : '';
      const key = rawId || `${rawName}:${toolsByKey.size}`;
      const existing = toolsByKey.get(key);
      if (existing) {
        existing.arguments = existing.arguments ?? event.tool?.arguments;
        existing.result = typeof event.tool?.result === 'string' ? event.tool.result : existing.result;
        existing.endedAt = eventStatus === 'running' ? existing.endedAt : event.ts;
        existing.status = eventStatus;
        return;
      }
      // The stream lane synthesizes an id when a tool_started event arrives
      // without one, while the matching tool_output can carry the provider's
      // real id. Land the result on the open call of the same name instead of
      // rendering a second, unpaired entry.
      if (event.type === 'tool_output') {
        const open = [...toolsByKey.values()].reverse().find((tool) => (
          tool.name === rawName && tool.status === 'running' && tool.result === undefined
        ));
        if (open) {
          open.arguments = open.arguments ?? event.tool?.arguments;
          open.result = typeof event.tool?.result === 'string' ? event.tool.result : open.result;
          open.endedAt = eventStatus === 'running' ? open.endedAt : event.ts;
          open.status = eventStatus;
          if (rawId && open.id !== rawId) {
            toolsByKey.delete(open.id);
            open.id = rawId;
            toolsByKey.set(rawId, open);
          }
          return;
        }
      }
      const tool: RuntimeHistoryToolCall = {
        id: key,
        name: rawName,
        arguments: event.tool?.arguments,
        result: typeof event.tool?.result === 'string' ? event.tool.result : undefined,
        startedAt: event.ts,
        endedAt: eventStatus === 'running' ? undefined : event.ts,
        status: eventStatus,
        order: timeline.length,
      };
      toolsByKey.set(key, tool);
      timeline.push({ kind: 'tool', tool });
    };

    for (const event of group.events) {
      lastTs = Math.max(lastTs, event.ts || 0);
      if (typeof event.model === 'string' && event.model.trim()) model = event.model.trim();
      if (typeof event.provenance === 'string' && event.provenance.trim()) provenance = event.provenance.trim();

      if (event.type === 'assistant_status') {
        if (event.visible && event.text && !isGenericStatusPlaceholderText(event.text)) {
          appendSegment('thinking', event.text, event.ts, event.replace === true, 'status');
        }
      } else if (event.type === 'assistant_reasoning') {
        appendSegment(
          'thinking',
          event.text || '',
          event.ts,
          event.replace === true,
          event.source?.preambleProgress === true ? 'preamble' : 'reasoning',
          event.subject,
        );
      } else if (event.type === 'tool_started' || event.type === 'tool_output') {
        flushPendingTextBeforeTool(event.ts);
        upsertTool(event);
      } else if (event.type === 'assistant_delta') {
        finalText = mergeRuntimeText(finalText, event.text || '', event.replace === true);
        pendingTextTs = event.ts;
      } else if (event.type === 'assistant_final') {
        const representedText = timeline
          .filter((item): item is { kind: 'segment'; segment: RuntimeHistorySegment } => (
            item.kind === 'segment'
            && item.segment.kind === 'text'
            && item.segment.source === 'text'
          ))
          .map((item) => item.segment.text);
        const terminalTail = reconcileRuntimeCumulativeFinalTail(
          representedText,
          event.text || '',
        );
        if (!terminalTail && !finalText.trim() && representedText.length > 0 && String(event.text || '').trim()) {
          // Some agents emit their eventual final response before late tool or
          // sub-agent activity, then repeat that exact response in the terminal
          // frame. Leaving it as an early timeline segment makes the answer look
          // buried at the top of the turn. The terminal frame is authoritative:
          // remove the duplicate text activity and anchor the answer at the end.
          for (let index = timeline.length - 1; index >= 0; index -= 1) {
            const item = timeline[index];
            if (item.kind === 'segment' && item.segment.kind === 'text' && item.segment.source === 'text') {
              timeline.splice(index, 1);
            }
          }
          finalText = mergeRuntimeText(finalText, event.text || '', true);
        } else {
          finalText = mergeRuntimeText(finalText, terminalTail, event.replace === true);
        }
      } else if (event.type === 'turn_error' && !finalText) {
        finalText = sanitizeHistoryText(event.text || '');
      }
    }

    const content = sanitizeHistoryText(finalText || '');
    const segments = timeline
      .filter((item): item is { kind: 'segment'; segment: RuntimeHistorySegment } => item.kind === 'segment')
      .map((item) => item.segment);
    const toolCalls = [...toolsByKey.values()].map((tool) => ({
      ...tool,
      status: tool.status === 'running' ? 'done' : tool.status,
      endedAt: tool.endedAt ?? lastTs,
    }));

    if (!content && segments.length === 0 && toolCalls.length === 0) return [];

    const timestamp = new Date(lastTs || Date.now()).toISOString();
    const id = `runtime-turn-${createHash('sha256').update(`${group.key}:${timestamp}:${content}`).digest('hex').slice(0, 24)}`;
    return [{
      id,
      role: 'assistant',
      content,
      timestamp,
      model,
      provenance: provenance || 'runtime-turn-event-history',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      segments: segments.length > 0 ? segments : undefined,
      __portal: { kind: 'runtime-turn-event-history', runId: group.key },
    }];
  });
}

const RUNTIME_HISTORY_MATCH_WINDOW_MS = 5 * 60_000;
const RUNTIME_HISTORY_ACTIVITY_MAX_SPAN_MS = 24 * 60 * 60_000;
const RUNTIME_HISTORY_INDEX_WORK_LIMIT = 200_000;
const RUNTIME_HISTORY_OWNERSHIP_ENTRY_LIMIT = 20_000;

type RuntimeHistoryWorkBudget = { remaining: number; exhausted?: boolean };

type RuntimeHistoryWorkLimits = {
  turnIndex?: number;
  ownership?: number;
  match?: number;
  prune?: number;
};

type RuntimeHistoryTurnIndex = {
  sourceTurns: number[];
  users: Array<{ timestamp: number; turn: number }>;
  assistantsByTurn: Map<number, number[]>;
  exactAssistants: Map<string, number[]>;
};

type RuntimeHistoryRepresentation = {
  ownerIndex: number;
  timestamp: number;
  explicit: boolean;
};

type RuntimeHistoryToolRepresentation = RuntimeHistoryRepresentation & { tool: any };

type RuntimeHistoryOwnershipIndex = {
  segments: Map<string, RuntimeHistoryRepresentation[]>;
  tools: Map<string, RuntimeHistoryToolRepresentation[]>;
};

type RuntimeHistoryMatch = {
  runtimeMessage: any;
  matchIndex: number;
  coherentRepresentedText: string[];
};

function consumeRuntimeHistoryWork(budget: RuntimeHistoryWorkBudget, amount = 1): boolean {
  if (amount <= 0) return true;
  if (budget.remaining < amount) {
    budget.remaining = 0;
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= amount;
  return true;
}

function runtimeHistoryWorkLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : RUNTIME_HISTORY_INDEX_WORK_LIMIT;
}

function finiteRuntimeHistoryTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isCanonicalRuntimeHistoryAssistant(message: any): boolean {
  if (message?.role !== 'assistant' || message?.__portal?.kind === 'runtime-turn-event-history') return false;
  const provenance = typeof message?.provenance === 'string'
    ? message.provenance.trim().toLowerCase()
    : '';
  return !['gemini-cli-import', 'trajectory-recovery', 'runtime-turn-event-history'].includes(provenance);
}

function runtimeHistoryTurnContentKey(turn: number, content: string): string {
  return JSON.stringify([turn, content]);
}

function normalizeRuntimeHistorySegmentSource(kind: 'text' | 'thinking', value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : kind === 'thinking' ? 'reasoning' : 'text';
}

function normalizeRuntimeHistorySegmentPosition(value: unknown): 'before' | 'between' | 'after' {
  return value === 'between' || value === 'after' ? value : 'before';
}

function runtimeHistorySegmentKey(
  turn: number,
  kind: 'text' | 'thinking',
  text: string,
  subject: unknown,
  source: unknown,
  position: unknown,
): string {
  return JSON.stringify([
    turn,
    kind,
    kind === 'thinking' ? sanitizeThinkingSubject(subject) : '',
    normalizeRuntimeHistorySegmentSource(kind, source),
    normalizeRuntimeHistorySegmentPosition(position),
    text,
  ]);
}

function runtimeHistoryToolMergeKey(tool: any): string {
  const id = typeof tool?.id === 'string' ? tool.id.trim() : '';
  if (id) return JSON.stringify(['id', id]);
  return JSON.stringify(['fallback',
    typeof tool?.name === 'string' ? tool.name.trim() : '',
    typeof tool?.startedAt === 'number' ? tool.startedAt : null,
    typeof tool?.endedAt === 'number' ? tool.endedAt : null,
  ]);
}

function runtimeHistoryToolOwnershipKey(tool: any): string {
  return runtimeHistoryToolMergeKey(tool);
}

function normalizeRuntimeHistoryToolValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n');
  try {
    return JSON.stringify(value) || '';
  } catch {
    return null;
  }
}

function runtimeHistoryTerminalStatus(value: unknown): 'done' | 'error' | null {
  return value === 'done' || value === 'error' ? value : null;
}

function buildRuntimeHistoryTurnIndex(
  messages: any[],
  budget: RuntimeHistoryWorkBudget,
): RuntimeHistoryTurnIndex | null {
  const sourceTurns: number[] = [];
  const users: RuntimeHistoryTurnIndex['users'] = [];
  const assistantsByTurn = new Map<number, number[]>();
  const exactAssistants = new Map<string, number[]>();
  let turn = -1;

  for (let index = 0; index < messages.length; index += 1) {
    if (!consumeRuntimeHistoryWork(budget)) return null;
    const message = messages[index];
    if (message?.role === 'user') {
      const timestamp = finiteRuntimeHistoryTimestamp(message?.timestamp);
      // An unorderable user prompt is a hard turn fence. Guessing around it can
      // prune a different turn's evidence, so disable reconciliation entirely.
      if (timestamp === null) return null;
      turn += 1;
      users.push({ timestamp, turn });
      sourceTurns[index] = turn;
      continue;
    }
    sourceTurns[index] = turn;
    if (!isCanonicalRuntimeHistoryAssistant(message) || isToolOnlyAssistantHistoryMessage(message)) continue;
    const assistants = assistantsByTurn.get(turn) || [];
    assistants.push(index);
    assistantsByTurn.set(turn, assistants);
    const content = normalizeRuntimeHistoryMatchText(message?.content);
    if (!content) continue;
    const key = runtimeHistoryTurnContentKey(turn, content);
    const exact = exactAssistants.get(key) || [];
    exact.push(index);
    exactAssistants.set(key, exact);
  }

  return { sourceTurns, users, assistantsByTurn, exactAssistants };
}

function resolveRuntimeHistoryTurnAt(
  turnIndex: RuntimeHistoryTurnIndex,
  timestamp: number,
): number | null {
  let low = 0;
  let high = turnIndex.users.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (turnIndex.users[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  // Millisecond timestamps do not establish whether the event came before or
  // after a user row at the same instant. Keep evidence instead of guessing.
  if (low < turnIndex.users.length && turnIndex.users[low].timestamp === timestamp) return null;
  return low > 0 ? turnIndex.users[low - 1].turn : -1;
}

function buildRuntimeHistoryOwnershipIndex(
  messages: any[],
  turnIndex: RuntimeHistoryTurnIndex,
  budget: RuntimeHistoryWorkBudget,
): RuntimeHistoryOwnershipIndex | null {
  const segments = new Map<string, RuntimeHistoryRepresentation[]>();
  const tools = new Map<string, RuntimeHistoryToolRepresentation[]>();
  let entries = 0;
  const addSegment = (
    ownerIndex: number,
    kind: 'text' | 'thinking',
    textValue: unknown,
    timestampValue: unknown,
    subjectValue?: unknown,
    sourceValue?: unknown,
    positionValue?: unknown,
    explicit = false,
  ): boolean => {
    if (typeof textValue !== 'string' || !textValue.trim()) return true;
    if (!consumeRuntimeHistoryWork(budget)) return false;
    const timestamp = finiteRuntimeHistoryTimestamp(timestampValue);
    const text = normalizeRuntimeHistoryMatchText(textValue);
    if (timestamp === null || !text) return true;
    entries += 1;
    if (entries > RUNTIME_HISTORY_OWNERSHIP_ENTRY_LIMIT) {
      budget.exhausted = true;
      return false;
    }
    const key = runtimeHistorySegmentKey(
      turnIndex.sourceTurns[ownerIndex] ?? -1,
      kind,
      text,
      subjectValue,
      sourceValue,
      positionValue,
    );
    const owners = segments.get(key) || [];
    owners.push({ ownerIndex, timestamp, explicit });
    segments.set(key, owners);
    return true;
  };

  for (let ownerIndex = 0; ownerIndex < messages.length; ownerIndex += 1) {
    if (!consumeRuntimeHistoryWork(budget)) return null;
    const message = messages[ownerIndex];
    if (!isCanonicalRuntimeHistoryAssistant(message)) continue;
    const messageTimestamp = finiteRuntimeHistoryTimestamp(message?.timestamp);
    if (messageTimestamp === null) continue;
    if (!addSegment(ownerIndex, 'text', message?.content, messageTimestamp, '', 'text', 'before')) return null;
    if (!addSegment(
      ownerIndex,
      'thinking',
      message?.thinkingContent,
      messageTimestamp,
      '',
      'reasoning',
      'before',
    )) return null;
    for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
      if (!addSegment(
        ownerIndex,
        segment?.kind === 'thinking' ? 'thinking' : 'text',
        segment?.text,
        segment?.ts ?? messageTimestamp,
        segment?.subject,
        segment?.source,
        segment?.position,
        true,
      )) return null;
    }
    for (const tool of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
      if (!consumeRuntimeHistoryWork(budget)) return null;
      const timestamp = finiteRuntimeHistoryTimestamp(tool?.startedAt ?? messageTimestamp);
      if (timestamp === null) continue;
      entries += 1;
      if (entries > RUNTIME_HISTORY_OWNERSHIP_ENTRY_LIMIT) {
        budget.exhausted = true;
        return null;
      }
      const key = JSON.stringify([
        turnIndex.sourceTurns[ownerIndex] ?? -1,
        runtimeHistoryToolOwnershipKey(tool),
      ]);
      const owners = tools.get(key) || [];
      owners.push({ ownerIndex, timestamp, explicit: true, tool });
      tools.set(key, owners);
    }
  }

  return { segments, tools };
}

function isCoherentRuntimeHistoryActivityTimestamp(runtimeMessage: any, timestamp: number): boolean {
  const terminalTimestamp = finiteRuntimeHistoryTimestamp(runtimeMessage?.timestamp);
  return terminalTimestamp !== null
    && timestamp >= terminalTimestamp - RUNTIME_HISTORY_ACTIVITY_MAX_SPAN_MS
    && timestamp <= terminalTimestamp + RUNTIME_HISTORY_MATCH_WINDOW_MS;
}

function findUniqueRuntimeHistorySegmentOwner(
  runtimeMessage: any,
  segment: any,
  turnIndex: RuntimeHistoryTurnIndex,
  ownership: RuntimeHistoryOwnershipIndex,
  allowedIndexes: ReadonlySet<number>,
  excludedIndex: number,
  budget: RuntimeHistoryWorkBudget,
): number {
  const timestamp = finiteRuntimeHistoryTimestamp(segment?.ts);
  const text = normalizeRuntimeHistoryMatchText(segment?.text);
  if (timestamp === null || !text || !isCoherentRuntimeHistoryActivityTimestamp(runtimeMessage, timestamp)) return -1;
  const turn = resolveRuntimeHistoryTurnAt(turnIndex, timestamp);
  if (turn === null) return -1;
  const key = runtimeHistorySegmentKey(
    turn,
    segment?.kind === 'thinking' ? 'thinking' : 'text',
    text,
    segment?.subject,
    segment?.source,
    segment?.position,
  );
  const owners = new Set<number>();
  for (const entry of ownership.segments.get(key) || []) {
    if (!consumeRuntimeHistoryWork(budget)) return -1;
    if (
      (entry.ownerIndex === excludedIndex && !entry.explicit)
      || !allowedIndexes.has(entry.ownerIndex)
      || Math.abs(entry.timestamp - timestamp) > RUNTIME_HISTORY_MATCH_WINDOW_MS
    ) continue;
    owners.add(entry.ownerIndex);
    if (owners.size > 1) return -1;
  }
  return owners.size === 1 ? [...owners][0] : -1;
}

function durableToolFullyRepresentsRuntimeTool(durable: any, runtime: any): boolean {
  const runtimeName = typeof runtime?.name === 'string' ? runtime.name.trim() : '';
  const durableName = typeof durable?.name === 'string' ? durable.name.trim() : '';
  if (runtimeName && durableName !== runtimeName) return false;
  const runtimeArguments = normalizeRuntimeHistoryToolValue(runtime?.arguments);
  const durableArguments = normalizeRuntimeHistoryToolValue(durable?.arguments);
  if (runtimeArguments !== null && durableArguments !== runtimeArguments) return false;
  const runtimeResult = normalizeRuntimeHistoryToolValue(runtime?.result);
  const durableResult = normalizeRuntimeHistoryToolValue(durable?.result);
  if (runtimeResult !== null && durableResult !== runtimeResult) return false;
  const runtimeStatus = runtimeHistoryTerminalStatus(runtime?.status);
  const durableStatus = runtimeHistoryTerminalStatus(durable?.status);
  return !runtimeStatus || durableStatus === runtimeStatus;
}

function hasUniqueRuntimeHistoryToolOwner(
  runtimeMessage: any,
  runtimeTool: any,
  turnIndex: RuntimeHistoryTurnIndex,
  ownership: RuntimeHistoryOwnershipIndex,
  allowedIndexes: ReadonlySet<number>,
  budget: RuntimeHistoryWorkBudget,
): boolean {
  const timestamp = finiteRuntimeHistoryTimestamp(runtimeTool?.startedAt);
  if (timestamp === null || !isCoherentRuntimeHistoryActivityTimestamp(runtimeMessage, timestamp)) return false;
  const hasEndedAt = runtimeTool?.endedAt !== undefined;
  const rawEndedAt = finiteRuntimeHistoryTimestamp(runtimeTool?.endedAt);
  if (
    hasEndedAt
    && (
      rawEndedAt === null
      || rawEndedAt < timestamp
      || !isCoherentRuntimeHistoryActivityTimestamp(runtimeMessage, rawEndedAt)
    )
  ) return false;
  const endedAt = rawEndedAt !== null
    ? rawEndedAt
    : null;
  const turn = resolveRuntimeHistoryTurnAt(turnIndex, timestamp);
  if (turn === null) return false;
  const key = JSON.stringify([turn, runtimeHistoryToolOwnershipKey(runtimeTool)]);
  const entriesByOwner = new Map<number, RuntimeHistoryToolRepresentation[]>();
  for (const entry of ownership.tools.get(key) || []) {
    if (!consumeRuntimeHistoryWork(budget)) return false;
    if (
      !allowedIndexes.has(entry.ownerIndex)
      || Math.min(
        Math.abs(entry.timestamp - timestamp),
        endedAt === null ? Number.POSITIVE_INFINITY : Math.abs(entry.timestamp - endedAt),
      ) > RUNTIME_HISTORY_MATCH_WINDOW_MS
    ) continue;
    const entries = entriesByOwner.get(entry.ownerIndex) || [];
    entries.push(entry);
    entriesByOwner.set(entry.ownerIndex, entries);
  }
  if (entriesByOwner.size !== 1) return false;
  const entries = [...entriesByOwner.values()][0];
  return entries.length > 0 && entries.every((entry) => (
    durableToolFullyRepresentsRuntimeTool(entry.tool, runtimeTool)
  ));
}

function reconcileMergedRuntimeHistoryContent(
  existing: any,
  runtimeMessage: any,
  coherentRepresentedRuntimeText?: string[],
): string {
  const existingContent = typeof existing?.content === 'string' ? existing.content : '';
  const runtimeContent = typeof runtimeMessage?.content === 'string' ? runtimeMessage.content : '';
  if (!runtimeContent.trim()) return existingContent;
  const representedRuntimeText = coherentRepresentedRuntimeText
    ?? (Array.isArray(runtimeMessage?.segments) ? runtimeMessage.segments : [])
      .filter((segment: any) => segment?.kind === 'text' && typeof segment?.text === 'string')
      .map((segment: any) => segment.text);
  if (representedRuntimeText.length === 0) return existingContent;

  const runtimeResidual = reconcileRuntimeCumulativeFinalTail(representedRuntimeText, runtimeContent);
  const existingResidual = reconcileRuntimeCumulativeFinalTail(
    representedRuntimeText,
    existingContent,
  );
  return normalizeRuntimeHistoryMatchText(existingResidual)
    === normalizeRuntimeHistoryMatchText(runtimeResidual)
    ? runtimeResidual
    : existingContent;
}

function residualRuntimeHistoryTimestamp(
  runtimeMessage: any,
  segments: any[],
  tools: any[],
): unknown {
  const terminalTimestamp = finiteRuntimeHistoryTimestamp(runtimeMessage?.timestamp);
  if (terminalTimestamp === null) return runtimeMessage?.timestamp;
  const activityTimestamps = [
    ...segments.map((segment) => finiteRuntimeHistoryTimestamp(segment?.ts)),
    ...tools.map((tool) => finiteRuntimeHistoryTimestamp(tool?.startedAt)),
  ].filter((timestamp): timestamp is number => (
    timestamp !== null
    && timestamp <= terminalTimestamp
    && isCoherentRuntimeHistoryActivityTimestamp(runtimeMessage, timestamp)
  ));
  return activityTimestamps.length > 0
    ? new Date(Math.min(...activityTimestamps)).toISOString()
    : runtimeMessage?.timestamp;
}

function findRuntimeHistoryTerminalMatch(
  messages: any[],
  runtimeMessage: any,
  turnIndex: RuntimeHistoryTurnIndex,
  ownership: RuntimeHistoryOwnershipIndex | null,
  allSourceIndexes: ReadonlySet<number>,
  availableIndexes: ReadonlySet<number>,
  budget: RuntimeHistoryWorkBudget,
): { matchIndex: number; coherentRepresentedText: string[] } {
  const runtimeTimestamp = finiteRuntimeHistoryTimestamp(runtimeMessage?.timestamp);
  const runtimeText = normalizeRuntimeHistoryMatchText(runtimeMessage?.content);
  if (runtimeTimestamp === null || !runtimeText) return { matchIndex: -1, coherentRepresentedText: [] };
  const turn = resolveRuntimeHistoryTurnAt(turnIndex, runtimeTimestamp);
  if (turn === null) return { matchIndex: -1, coherentRepresentedText: [] };

  const coherentRepresentedText: string[] = [];
  if (ownership) {
    for (const segment of Array.isArray(runtimeMessage?.segments) ? runtimeMessage.segments : []) {
      if (!consumeRuntimeHistoryWork(budget)) return { matchIndex: -1, coherentRepresentedText: [] };
      if (
        segment?.kind === 'text'
        && segment?.source === 'text'
        && findUniqueRuntimeHistorySegmentOwner(
          runtimeMessage,
          segment,
          turnIndex,
          ownership,
          allSourceIndexes,
          -1,
          budget,
        ) >= 0
      ) coherentRepresentedText.push(segment.text);
    }
  }

  const candidates = new Set<number>();
  for (const index of turnIndex.exactAssistants.get(runtimeHistoryTurnContentKey(turn, runtimeText)) || []) {
    if (!consumeRuntimeHistoryWork(budget)) return { matchIndex: -1, coherentRepresentedText: [] };
    candidates.add(index);
  }
  for (const index of turnIndex.assistantsByTurn.get(turn) || []) {
    if (!consumeRuntimeHistoryWork(budget)) return { matchIndex: -1, coherentRepresentedText: [] };
    const hasExactStructuredTerminal = (Array.isArray(messages[index]?.segments)
      ? messages[index].segments
      : []).some((segment: any) => (
      segment?.position === 'after'
      && segment?.kind !== 'thinking'
      && normalizeRuntimeHistoryMatchText(segment?.text) === runtimeText
    ));
    if (hasExactStructuredTerminal) candidates.add(index);
  }
  if (coherentRepresentedText.length > 0) {
    const runtimeResidual = normalizeRuntimeHistoryMatchText(
      reconcileRuntimeCumulativeFinalTail(coherentRepresentedText, runtimeMessage.content),
    );
    for (const index of turnIndex.assistantsByTurn.get(turn) || []) {
      if (!consumeRuntimeHistoryWork(budget)) return { matchIndex: -1, coherentRepresentedText: [] };
      const candidateResidual = normalizeRuntimeHistoryMatchText(
        reconcileRuntimeCumulativeFinalTail(coherentRepresentedText, messages[index]?.content || ''),
      );
      if (candidateResidual && candidateResidual === runtimeResidual) candidates.add(index);
    }
  }

  const eligible = [...candidates].filter((index) => {
    if (!availableIndexes.has(index)) return false;
    const candidateTimestamp = finiteRuntimeHistoryTimestamp(messages[index]?.timestamp);
    return candidateTimestamp !== null
      && Math.abs(candidateTimestamp - runtimeTimestamp) <= RUNTIME_HISTORY_MATCH_WINDOW_MS;
  });
  return eligible.length === 1
    ? { matchIndex: eligible[0], coherentRepresentedText }
    : { matchIndex: -1, coherentRepresentedText };
}

function getRuntimeHistoryPreviewRetainedSourceIndexes(
  messages: any[],
  overlayMessages: any[],
  limit: number,
  budget: RuntimeHistoryWorkBudget,
): { sourceIndexes: ReadonlySet<number>; overlayIndexes: ReadonlySet<number> } | null {
  if (!consumeRuntimeHistoryWork(
    budget,
    messages.length + overlayMessages.length,
  )) return null;
  const retained = [
    ...messages.map((message, sourceIndex) => ({ message, sourceIndex, overlayIndex: -1 })),
    ...overlayMessages.map((message, overlayIndex) => ({ message, sourceIndex: -1, overlayIndex })),
  ]
    .sort((left, right) => (
      toHistoryTimestampMs(left.message?.timestamp) - toHistoryTimestampMs(right.message?.timestamp)
    ))
    .slice(-Math.max(limit, 1));
  return {
    sourceIndexes: new Set(retained.flatMap((entry) => (
      entry.sourceIndex >= 0 ? [entry.sourceIndex] : []
    ))),
    overlayIndexes: new Set(retained.flatMap((entry) => (
      entry.overlayIndex >= 0 ? [entry.overlayIndex] : []
    ))),
  };
}

function failClosedRuntimeHistory(
  messages: any[],
  runtimeMessages: any[],
  limit: number,
): any[] {
  return [...messages, ...runtimeMessages]
    .sort((left, right) => toHistoryTimestampMs(left?.timestamp) - toHistoryTimestampMs(right?.timestamp))
    .slice(-Math.max(limit, 1));
}

function mergeRuntimeHistoryMessages(
  messages: any[],
  runtimeMessages: any[],
  limit = 200,
  workLimits: RuntimeHistoryWorkLimits = {},
): any[] {
  if (runtimeMessages.length === 0) return messages;
  const combined = messages
    .map((message) => ({ ...message }))
    .sort((left, right) => toHistoryTimestampMs(left?.timestamp) - toHistoryTimestampMs(right?.timestamp));
  const turnIndexBudget: RuntimeHistoryWorkBudget = {
    remaining: runtimeHistoryWorkLimit(workLimits.turnIndex),
  };
  const turnIndex = buildRuntimeHistoryTurnIndex(
    combined,
    turnIndexBudget,
  );
  if (!turnIndex) return failClosedRuntimeHistory(combined, runtimeMessages, limit);
  const ownershipBudget: RuntimeHistoryWorkBudget = {
    remaining: runtimeHistoryWorkLimit(workLimits.ownership),
  };
  const ownership = buildRuntimeHistoryOwnershipIndex(
    combined,
    turnIndex,
    ownershipBudget,
  );
  if (!ownership) return failClosedRuntimeHistory(combined, runtimeMessages, limit);
  const matchBudget: RuntimeHistoryWorkBudget = {
    remaining: runtimeHistoryWorkLimit(workLimits.match),
  };
  const allSourceIndexes = new Set(combined.map((_message, index) => index));
  const availableIndexes = new Set(allSourceIndexes);
  const matches: RuntimeHistoryMatch[] = runtimeMessages.map((runtimeMessage) => {
    const match = findRuntimeHistoryTerminalMatch(
      combined,
      runtimeMessage,
      turnIndex,
      ownership,
      allSourceIndexes,
      availableIndexes,
      matchBudget,
    );
    if (match.matchIndex >= 0) availableIndexes.delete(match.matchIndex);
    return { runtimeMessage, ...match };
  });
  if (matchBudget.exhausted) return failClosedRuntimeHistory(combined, runtimeMessages, limit);

  const unmatchedRuntimeIndexes = new Set<number>();
  matches.forEach((entry, index) => {
    if (entry.matchIndex < 0) unmatchedRuntimeIndexes.add(index);
  });
  let plannedCombined: any[] | null = null;
  let unmatchedRuntimeMessages: any[] = [];
  let residualRuntimeMessages: any[] = [];
  const pruneBudget: RuntimeHistoryWorkBudget = {
    remaining: runtimeHistoryWorkLimit(workLimits.prune),
  };
  const initialRetainedIndexes = getRuntimeHistoryPreviewRetainedSourceIndexes(
    combined,
    [],
    limit,
    pruneBudget,
  );
  if (!initialRetainedIndexes) return failClosedRuntimeHistory(combined, runtimeMessages, limit);
  let retainedIndexes: ReadonlySet<number> = initialRetainedIndexes.sourceIndexes;
  while (!plannedCombined) {
    let changed = false;
    matches.forEach((entry, index) => {
      if (
        entry.matchIndex >= 0
        && !retainedIndexes.has(entry.matchIndex)
        && !unmatchedRuntimeIndexes.has(index)
      ) {
        unmatchedRuntimeIndexes.add(index);
        changed = true;
      }
    });
    if (changed) continue;

    const staged = combined.map((message) => ({ ...message }));
    const stagedResidualRuntimeMessages: any[] = [];
    const stagedResidualRuntimeIndexes: number[] = [];
    const contentUnsafeRuntimeIndexes = new Set<number>();
    for (let runtimeIndex = 0; runtimeIndex < matches.length; runtimeIndex += 1) {
      const entry = matches[runtimeIndex];
      if (unmatchedRuntimeIndexes.has(runtimeIndex)) continue;
      const existing = staged[entry.matchIndex];
      const runtimeSegments = Array.isArray(entry.runtimeMessage?.segments)
        ? entry.runtimeMessage.segments
        : [];
      const runtimeTools = Array.isArray(entry.runtimeMessage?.toolCalls)
        ? entry.runtimeMessage.toolCalls
        : [];
      const remainingSegments: any[] = [];
      const retainedRepresentedText: string[] = [];
      for (const segment of runtimeSegments) {
        const ownerIndex = findUniqueRuntimeHistorySegmentOwner(
          entry.runtimeMessage,
          segment,
          turnIndex,
          ownership,
          retainedIndexes,
          entry.matchIndex,
          pruneBudget,
        );
        if (ownerIndex < 0) remainingSegments.push(segment);
        else if (segment?.kind === 'text' && segment?.source === 'text') {
          retainedRepresentedText.push(segment.text);
        }
      }
      const remainingTools: any[] = [];
      for (const tool of runtimeTools) {
        if (!hasUniqueRuntimeHistoryToolOwner(
          entry.runtimeMessage,
          tool,
          turnIndex,
          ownership,
          retainedIndexes,
          pruneBudget,
        )) remainingTools.push(tool);
      }
      if (pruneBudget.exhausted) {
        return failClosedRuntimeHistory(combined, runtimeMessages, limit);
      }
      const runtimeText = normalizeRuntimeHistoryMatchText(entry.runtimeMessage?.content);
      const exactContent = normalizeRuntimeHistoryMatchText(existing?.content) === runtimeText;
      const exactStructuredTerminal = (Array.isArray(existing?.segments) ? existing.segments : [])
        .some((segment: any) => (
          segment?.position === 'after'
          && segment?.kind !== 'thinking'
          && normalizeRuntimeHistoryMatchText(segment?.text) === runtimeText
        ));
      const reconciledContent = reconcileMergedRuntimeHistoryContent(
        existing,
        entry.runtimeMessage,
        retainedRepresentedText,
      );
      const cumulativeContent = normalizeRuntimeHistoryMatchText(reconciledContent)
        === normalizeRuntimeHistoryMatchText(reconcileRuntimeCumulativeFinalTail(
          retainedRepresentedText,
          entry.runtimeMessage?.content || '',
        ));
      if (!exactContent && !exactStructuredTerminal && !cumulativeContent) {
        contentUnsafeRuntimeIndexes.add(runtimeIndex);
        continue;
      }
      if (reconciledContent !== existing?.content) {
        staged[entry.matchIndex] = { ...existing, content: reconciledContent };
      }
      const residualRuntimeMessage = {
        ...entry.runtimeMessage,
        content: '',
        timestamp: residualRuntimeHistoryTimestamp(
          entry.runtimeMessage,
          remainingSegments,
          remainingTools,
        ),
        segments: remainingSegments.length > 0 ? remainingSegments : undefined,
        toolCalls: remainingTools.length > 0 ? remainingTools : undefined,
      };
      if (
        remainingSegments.length > 0
        || remainingTools.length > 0
        || (typeof residualRuntimeMessage.thinkingContent === 'string'
          && residualRuntimeMessage.thinkingContent.trim())
      ) {
        stagedResidualRuntimeMessages.push(residualRuntimeMessage);
        stagedResidualRuntimeIndexes.push(runtimeIndex);
      }
    }
    if (contentUnsafeRuntimeIndexes.size > 0) {
      contentUnsafeRuntimeIndexes.forEach((index) => unmatchedRuntimeIndexes.add(index));
      continue;
    }
    const stagedUnmatchedRuntimeMessages = matches.flatMap((entry, index) => (
      unmatchedRuntimeIndexes.has(index) ? [entry.runtimeMessage] : []
    ));
    const actualRetainedIndexes = getRuntimeHistoryPreviewRetainedSourceIndexes(
      staged,
      [...stagedUnmatchedRuntimeMessages, ...stagedResidualRuntimeMessages],
      limit,
      pruneBudget,
    );
    if (!actualRetainedIndexes || pruneBudget.exhausted) {
      return failClosedRuntimeHistory(combined, runtimeMessages, limit);
    }
    const unretainedResidualRuntimeIndexes = stagedResidualRuntimeIndexes.filter((_, index) => (
      !actualRetainedIndexes.overlayIndexes.has(stagedUnmatchedRuntimeMessages.length + index)
    ));
    if (unretainedResidualRuntimeIndexes.length > 0) {
      unretainedResidualRuntimeIndexes.forEach((index) => unmatchedRuntimeIndexes.add(index));
      continue;
    }
    const narrowedRetainedIndexes = new Set(
      [...retainedIndexes].filter((index) => actualRetainedIndexes.sourceIndexes.has(index)),
    );
    if (narrowedRetainedIndexes.size !== retainedIndexes.size) {
      retainedIndexes = narrowedRetainedIndexes;
      continue;
    }
    plannedCombined = staged;
    unmatchedRuntimeMessages = stagedUnmatchedRuntimeMessages;
    residualRuntimeMessages = stagedResidualRuntimeMessages;
  }

  const seen = new Set<string>();
  return [...plannedCombined, ...unmatchedRuntimeMessages, ...residualRuntimeMessages]
    .filter((message, index, all) => (
      message?.__portal?.kind === 'runtime-turn-event-history'
      || !isDuplicateToolOnlyAssistantHistoryMessage(message, index, all)
    ))
    .filter((message) => {
      const id = typeof message?.id === 'string' ? message.id : '';
      const key = id || `${message?.role}:${message?.timestamp}:${normalizeRuntimeHistoryMatchText(message?.content)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp))
    .slice(-Math.max(limit, 1));
}

function mergeRuntimeTurnEventHistory(sessionKey: string, messages: any[], limit = 200): any[] {
  const earliestMessageTs = messages.reduce((earliest, message) => {
    const ts = toHistoryTimestampMs(message?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? Math.min(earliest, ts) : earliest;
  }, Number.POSITIVE_INFINITY);
  let eventLimit = Math.min(Math.max(limit * 4, 200), MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES);
  let runtimeEvents: RuntimeTurnEvent[] = [];

  while (true) {
    runtimeEvents = readRuntimeTurnEvents(sessionKey, eventLimit);
    const oldestEventTs = runtimeEvents[0]?.ts;
    const reachedRelevantBoundary = !Number.isFinite(earliestMessageTs)
      || !oldestEventTs
      || oldestEventTs <= earliestMessageTs;
    const exhaustedSource = runtimeEvents.length < eventLimit;
    if (reachedRelevantBoundary || exhaustedSource || eventLimit >= MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES) break;
    eventLimit = Math.min(eventLimit * 2, MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES);
  }

  return mergeRuntimeHistoryMessages(
    messages,
    buildRuntimeHistoryMessages(runtimeEvents),
    limit,
  );
}

function getHistoryToolIds(message: any): string[] {
  return (Array.isArray(message?.toolCalls) ? message.toolCalls : [])
    .map((tool: any) => (typeof tool?.id === 'string' ? tool.id.trim() : ''))
    .filter(Boolean);
}

function isToolOnlyAssistantHistoryMessage(message: any): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (message?.__portal?.kind === 'runtime-turn-event-history') return false;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const hasThinking = typeof message.thinkingContent === 'string' && message.thinkingContent.trim().length > 0;
  const hasSegments = Array.isArray(message.segments) && message.segments.length > 0;
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  return !content && !hasThinking && !hasSegments && toolCalls.length > 0;
}

function isDuplicateToolOnlyAssistantHistoryMessage(message: any, index: number, messages: any[]): boolean {
  if (!isToolOnlyAssistantHistoryMessage(message)) return false;
  const toolIds = getHistoryToolIds(message);
  if (toolIds.length === 0) return false;

  return messages.some((candidate, candidateIndex) => {
    if (candidateIndex === index || candidate?.role !== 'assistant') return false;
    if (isToolOnlyAssistantHistoryMessage(candidate)) return false;

    const candidateToolIds = new Set(getHistoryToolIds(candidate));
    if (candidateToolIds.size === 0) return false;
    return toolIds.every((toolId) => candidateToolIds.has(toolId));
  });
}

function mergeHistorySegments(existing: any[] | undefined, incoming: any[]): any[] {
  const merged: any[] = [];
  const indexes = new Map<string, number>();
  const add = (segment: any) => {
    if (!segment || typeof segment !== 'object') return;
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    const kind = segment.kind === 'thinking' ? 'thinking' : 'text';
    const subject = kind === 'thinking' ? sanitizeThinkingSubject(segment.subject) : '';
    if (!text && !subject) return;
    const key = `${kind}:${subject}:${normalizeRuntimeHistoryMatchText(text)}`;
    const normalized = {
      ...segment,
      text,
      ...(subject ? { subject } : {}),
      kind,
      position: segment.position === 'after' || segment.position === 'between' ? segment.position : 'before',
    };
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      const current = merged[existingIndex];
      merged[existingIndex] = {
        ...current,
        ...(
          !(typeof current.order === 'number' && Number.isFinite(current.order))
          && typeof normalized.order === 'number'
          && Number.isFinite(normalized.order)
            ? { order: normalized.order }
            : {}
        ),
        ...(
          !(typeof current.ts === 'number' && Number.isFinite(current.ts))
          && typeof normalized.ts === 'number'
          && Number.isFinite(normalized.ts)
            ? { ts: normalized.ts }
            : {}
        ),
      };
      return;
    }
    indexes.set(key, merged.length);
    merged.push(normalized);
  };

  for (const segment of Array.isArray(existing) ? existing : []) add(segment);
  for (const segment of incoming) add(segment);

  return merged
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      const leftOrder = typeof left.segment.order === 'number' && Number.isFinite(left.segment.order)
        ? left.segment.order
        : null;
      const rightOrder = typeof right.segment.order === 'number' && Number.isFinite(right.segment.order)
        ? right.segment.order
        : null;
      if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const leftTs = typeof left.segment.ts === 'number' && Number.isFinite(left.segment.ts)
        ? left.segment.ts
        : null;
      const rightTs = typeof right.segment.ts === 'number' && Number.isFinite(right.segment.ts)
        ? right.segment.ts
        : null;
      if (leftTs != null && rightTs != null && leftTs !== rightTs) return leftTs - rightTs;
      return left.index - right.index;
    })
    .map(({ segment }) => segment);
}

function mergeHistoryToolCalls(existing: any[] | undefined, incoming: any[]): any[] {
  const merged: any[] = [];
  const indexes = new Map<string, number>();
  const add = (toolCall: any) => {
    if (!toolCall || typeof toolCall !== 'object') return;
    const id = typeof toolCall.id === 'string' ? toolCall.id.trim() : '';
    const fallbackKey = [
      typeof toolCall.name === 'string' ? toolCall.name.trim() : '',
      typeof toolCall.startedAt === 'number' ? toolCall.startedAt : '',
      typeof toolCall.endedAt === 'number' ? toolCall.endedAt : '',
    ].join(':');
    const key = id || fallbackKey;
    const existingIndex = key ? indexes.get(key) : undefined;
    if (existingIndex !== undefined) {
      const current = merged[existingIndex];
      merged[existingIndex] = {
        ...current,
        arguments: current.arguments ?? toolCall.arguments,
        result: current.result ?? toolCall.result,
        startedAt: Number.isFinite(current.startedAt) ? current.startedAt : toolCall.startedAt,
        endedAt: Number.isFinite(current.endedAt) ? current.endedAt : toolCall.endedAt,
        order: Number.isFinite(current.order) ? current.order : toolCall.order,
        status: current.status === 'done' || current.status === 'error'
          ? current.status
          : toolCall.status ?? current.status,
      };
      return;
    }
    if (key) indexes.set(key, merged.length);
    merged.push(toolCall);
  };

  for (const toolCall of Array.isArray(existing) ? existing : []) add(toolCall);
  for (const toolCall of incoming) add(toolCall);

  // The same tool call can arrive from two event lanes (stream tool events vs
  // transcript blocks) with different ids: one rich (arguments/result) and one
  // metadata-free ghost with a generic name. Id-based dedupe misses those, so
  // collapse ghosts that shadow a substantive call of a related name.
  const hasSubstance = (tool: any) => Boolean(
    (tool?.arguments && (typeof tool.arguments !== 'object' || Object.keys(tool.arguments).length > 0))
    || (typeof tool?.result === 'string' && tool.result.trim()),
  );
  return merged.filter((tool, index) => {
    if (hasSubstance(tool)) return true;
    const name = String(tool?.name || '').trim().toLowerCase();
    const started = typeof tool?.startedAt === 'number' ? tool.startedAt : null;
    return !merged.some((other, otherIndex) => {
      if (otherIndex === index || !hasSubstance(other)) return false;
      const otherName = String(other?.name || '').trim().toLowerCase();
      const namesRelated = !name || name === 'tool' || name === 'command' || name === otherName;
      if (!namesRelated) return false;
      const otherStarted = typeof other?.startedAt === 'number' ? other.startedAt : null;
      if (started === null || otherStarted === null) return true;
      return Math.abs(started - otherStarted) < 20_000;
    });
  });
}

function collapseFragmentedToolOnlyAssistantHistory(messages: any[]): any[] {
  const collapsed: any[] = [];
  let pendingToolOnly: any[] = [];

  const flushPendingAsAggregate = () => {
    if (pendingToolOnly.length === 0) return;
    const first = pendingToolOnly[0];
    const last = pendingToolOnly[pendingToolOnly.length - 1];
    const toolCalls = pendingToolOnly.flatMap((message) => Array.isArray(message?.toolCalls) ? message.toolCalls : []);
    collapsed.push({
      ...last,
      id: `tool-history-${createHash('sha256')
        // The last durable fragment is invariant when a wider older page adds
        // adjacent fragments to the front of this aggregate. Cursor identity
        // must therefore derive from the tail, not from the whole window.
        .update(String(last?.id || last?.timestamp || ''))
        .digest('hex')
        .slice(0, 24)}`,
      role: 'assistant',
      content: '',
      timestamp: last?.timestamp || first?.timestamp,
      toolCalls: mergeHistoryToolCalls(undefined, toolCalls),
    });
    pendingToolOnly = [];
  };

  for (const message of messages) {
    if (isToolOnlyAssistantHistoryMessage(message)) {
      pendingToolOnly.push(message);
      continue;
    }

    if (message?.__portal?.kind === 'runtime-turn-event-history' && pendingToolOnly.length > 0) {
      flushPendingAsAggregate();
      collapsed.push(message);
      continue;
    }

    if (message?.role === 'assistant' && pendingToolOnly.length > 0) {
      const toolCalls = pendingToolOnly.flatMap((entry) => Array.isArray(entry?.toolCalls) ? entry.toolCalls : []);
      collapsed.push({
        ...message,
        toolCalls: mergeHistoryToolCalls(message.toolCalls, toolCalls),
      });
      pendingToolOnly = [];
      continue;
    }

    flushPendingAsAggregate();
    collapsed.push(message);
  }

  flushPendingAsAggregate();
  return collapsed;
}

function finalizeEnhancedHistoryMessages(sessionKey: string, messages: any[], limit = 200): any[] {
  return collapseFragmentedToolOnlyAssistantHistory(mergeRuntimeTurnEventHistory(
    sessionKey,
    mergeMaintenanceHistoryMarkers(sessionKey, messages, Math.max(limit * 2, 200)),
    limit,
  ));
}

function readSessionMessagesEnhancedForSessionKey(sessionKey: string, limit = 200, sessionsDir = SESSIONS_DIR): any[] {
  // Transcript rows are sparse among tool plumbing and control artifacts, so
  // start with a modest enrichment window and let the lower-level tail reader
  // grow only when filtering proves that more raw lines are actually needed.
  const geminiCliSessionIds = resolveSessionRegistryEntries(sessionKey, sessionsDir)
    .map((entry) => resolveGeminiCliBindingSessionId(entry))
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  let readLimit = Math.min(Math.max(limit * 3, 200), MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES);

  while (true) {
    const localMessages = readBestOpenClawSessionMessagesForSessionKey(sessionKey, readLimit, sessionsDir);
    const importedMessages = geminiCliSessionIds
      .flatMap((cliSessionId) => readGeminiCliImportedMessages(cliSessionId, readLimit))
      .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp))
      .slice(-Math.max(readLimit, 1));

    let combined = localMessages;
    if (importedMessages.length > 0) {
      const localLatestTimestamp = getLatestMeaningfulConversationTimestamp(localMessages);
      if (!hasMeaningfulConversationTurns(localMessages) || !localLatestTimestamp) {
        combined = [...localMessages, ...importedMessages]
          .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp));
      } else {
        const importedTail = importedMessages.filter((message) => toHistoryTimestampMs(message?.timestamp) > localLatestTimestamp);
        if (importedTail.length > 0) {
          combined = [...localMessages, ...importedTail]
            .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp));
        }
      }
    }

    const finalized = finalizeEnhancedHistoryMessages(
      sessionKey,
      combined.slice(-Math.max(readLimit, 1)),
      limit,
    );
    const sourceFilledWindow = localMessages.length >= readLimit || importedMessages.length >= readLimit;
    if (
      finalized.length >= limit
      || !sourceFilledWindow
      || readLimit >= MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES
    ) {
      return finalized;
    }
    readLimit = Math.min(readLimit * 2, MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES);
  }
}

async function recoverRecentOpenClawAssistantReply(
  sessionKey: string,
  startedAtMs: number,
  options?: { waitMs?: number; pollMs?: number },
): Promise<{ content: string; model: string | null } | null> {
  const waitMs = Math.max(500, options?.waitMs ?? 8000);
  const pollMs = Math.max(200, options?.pollMs ?? 500);
  const deadline = Date.now() + waitMs;
  const sessionsDir = resolveSessionsDir(sessionKey);
  let explicitSessionId = '';

  try {
    const info = await getSessionInfo(sessionKey);
    explicitSessionId = typeof info?.data?.sessionId === 'string' ? info.data.sessionId.trim() : '';
  } catch {}

  while (Date.now() <= deadline) {
    let messages = readSessionMessagesEnhancedForSessionKey(sessionKey, 30, sessionsDir);
    if ((!messages || messages.length === 0) && explicitSessionId) {
      messages = readSessionMessagesEnhanced(explicitSessionId, 30, sessionsDir);
    }
    const recovered = [...messages]
      .reverse()
      .find((entry) => {
        if (entry?.role !== 'assistant') return false;
        const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
        if (!content) return false;
        const ts = Date.parse(String(entry?.timestamp || ''));
        return Number.isFinite(ts) && ts >= (startedAtMs - 1000);
      });

    if (recovered) {
      return {
        content: recovered.content,
        model: normalizeGatewayModelId(recovered.model) || null,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

function shouldAttemptOpenClawReplyRecovery(
  providerName: AgentProviderName,
  pendingError: string | null,
  requestedModel: unknown,
): boolean {
  return providerName === 'OPENCLAW'
    && Boolean(pendingError || (typeof requestedModel === 'string' && requestedModel.trim()));
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
    /^\[System\]\s+Your previous turn was interrupted by a gateway restart/i,
    /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i,
    /Handle the result internally\./i,
    /Sender \(untrusted metadata\):/i,
    /Conversation info \(untrusted metadata\):/i,
  ].some((pattern) => pattern.test(normalized));
}

function isDeliveryStatusArtifactText(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return [
    /^sent (?:the |a |an )?.{1,180}(?:recommendations|recipe|recipes|code|answer|response|reply|message|summary|details|instructions|analysis|report|results|update)s?\.?$/i,
    /^sent\b.{0,260}\.?$/i,
    /^sent message to (?:web ?chat|current(?: chat| run)?|the user)\.?$/i,
    /^message sent(?: to (?:web ?chat|current(?: chat| run)?|the user))?\.?$/i,
    /^answered in (?:the )?web ?chat(?:\b.*)?\.?$/i,
    /^reported .{1,180} in (?:the )?web ?chat\.?$/i,
    /^elaborated in (?:the )?web ?chat(?:\b.*)?\.?$/i,
  ].some((pattern) => pattern.test(normalized));
}

function stripMessageDeliveryArtifactsFromHistory(messages: any[]): any[] {
  return messages.flatMap((message) => {
    if (!message || message.role !== 'assistant') return [message];

    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const nonMessageToolCalls = toolCalls.filter((tool: any) => String(tool?.name || '').trim().toLowerCase() !== 'message');
    const messageToolCount = toolCalls.length - nonMessageToolCalls.length;
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    const hasThinking = typeof message.thinkingContent === 'string' && message.thinkingContent.trim();
    const hasSegments = Array.isArray(message.segments) && message.segments.length > 0;

    if (messageToolCount === 0) {
      return !hasThinking && !hasSegments && isDeliveryStatusArtifactText(content) ? [] : [message];
    }

    if (nonMessageToolCalls.length === 0) {
      // The OpenClaw `message` tool is delivery plumbing for webchat; its result
      // often becomes transcript noise like "Sent message to Web chat". Do not
      // render it as an assistant turn or tool pill in portal history.
      if (!hasThinking && !hasSegments) return [];
      return [{ ...message, toolCalls: undefined, content: isDeliveryStatusArtifactText(content) ? '' : content }];
    }

    return [{
      ...message,
      toolCalls: nonMessageToolCalls,
      content: isDeliveryStatusArtifactText(content) ? '' : message.content,
    }];
  });
}

function extractReadableReasoningSummary(payload: any): string {
  const parts: string[] = [];
  const collect = (value: any) => {
    if (!value) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === 'object') {
      collect(value.text ?? value.content ?? value.summary ?? value.description);
    }
  };

  collect(payload?.summary);
  collect(payload?.item?.summary);
  collect(payload?.text);
  collect(payload?.item?.text);
  // Intentionally do not read encrypted_content. If OpenClaw only stored private
  // encrypted reasoning with no summary, there is nothing displayable here.
  return extractSanitizedText(parts.join('\n\n'));
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

  if (/^\[System\]\s+Your previous turn was interrupted by a gateway restart/i.test(normalized)) {
    return 'Previous turn interrupted by gateway restart';
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

function summarizeTaskText(raw: unknown, max = 220): string | null {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function pickTaskSummaryCandidate(session: any): string | null {
  return summarizeTaskText(
    session?.preview
      ?? session?.lastMessagePreview
      ?? session?.summary
      ?? session?.origin?.preview
      ?? session?.origin?.summary,
  );
}

function pickTaskPromptCandidate(session: any): string | null {
  return summarizeTaskText(
    session?.origin?.task
      ?? session?.origin?.message
      ?? session?.origin?.label
      ?? session?.displayName
      ?? session?.summary,
    240,
  );
}

function readLastJsonlLines(filePath: string, maxLines: number): { lines: string[]; hitStart: boolean } {
  if (!existsSync(filePath) || maxLines <= 0) return { lines: [], hitStart: true };

  const stat = statSync(filePath);
  if (!stat.size) return { lines: [], hitStart: true };

  const fd = openSync(filePath, 'r');
  const chunkSize = 64 * 1024;
  let position = stat.size;
  let text = '';
  let newlineCount = 0;
  let hitStart = false;

  try {
    while (position > 0 && newlineCount <= maxLines) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) newlineCount++;
      }
      text = buffer.subarray(0, bytesRead).toString('utf-8') + text;
    }
    hitStart = position === 0;
  } finally {
    closeSync(fd);
  }

  const lines = text.split('\n').filter((line) => line.trim());
  return { lines: lines.slice(-maxLines), hitStart };
}

function readRecentSessionMessages<T>(params: {
  sessionId: string;
  limit: number;
  sessionsDir?: string;
  parseLine: (line: string) => T | null;
  minRawLineWindow?: number;
  growthFactor?: number;
}): T[] {
  const {
    sessionId,
    limit,
    sessionsDir = SESSIONS_DIR,
    parseLine,
    minRawLineWindow = 200,
    growthFactor = 4,
  } = params;

  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(filePath) || limit <= 0) return [];

  const rawWindowFloor = Math.max(limit, minRawLineWindow);
  let rawLineWindow = Math.max(rawWindowFloor, limit * growthFactor);
  let hitStart = false;

  while (true) {
    const { lines, hitStart: reachedStart } = readLastJsonlLines(filePath, rawLineWindow);
    hitStart = reachedStart;
    const parsed: T[] = [];

    for (const line of lines) {
      const message = parseLine(line);
      if (message) parsed.push(message);
    }

    if (parsed.length >= limit || hitStart) {
      return parsed.slice(-limit);
    }

    rawLineWindow *= 2;
  }
}

/** Legacy text-only history reader (kept for backward compat) */
async function readSessionMessages(sessionId: string, limit = 100, sessionsDir = SESSIONS_DIR): Promise<any[]> {
  return readRecentSessionMessages({
    sessionId,
    limit,
    sessionsDir,
    parseLine: (line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || !entry.message) return null;
        const role = entry.message.role;
        if (role !== 'user' && role !== 'assistant') return null;
        const text = extractText(entry.message.content);
        if (!text) return null;
        if (role === 'assistant') {
          const reasoningMirrorText = extractReasoningMirrorHistoryText(entry.message, text);
          if (reasoningMirrorText && !isHiddenHistoryArtifactText(reasoningMirrorText)) {
            return {
              id: entry.id,
              role: 'assistant',
              content: '',
              thinkingContent: reasoningMirrorText,
              timestamp: entry.timestamp,
              provenance: 'reasoning-mirror',
            };
          }
          if (isControlOnlyAssistantText(text)) return null;
        }
        return { id: entry.id, role, content: text, timestamp: entry.timestamp };
      } catch {
        return null;
      }
    },
  });
}

// Narrow test surface for legacy history compatibility. Keep private helpers
// private; export only the behavior the /api/gateway/history legacy path uses.
export const __gatewayHistoryTest = {
  readSessionMessages,
  readRecentSessionMessages,
  readSessionMessagesEnhanced,
  readSessionMessagesEnhancedForSessionKey,
  buildHistoryPage,
  decodeHistoryCursor,
  historyCursorScope,
  parseHistoryLimit,
  readNativeHistoryPage,
  readAgentZeroHistoryPage,
  readBoundedJsonlTailText,
  mergeHistorySegments,
  mergeHistoryToolCalls,
  collapseFragmentedToolOnlyAssistantHistory,
  readBestOpenClawSessionMessagesForSessionKey,
  getOpenClawRuntimeActiveStreamSnapshot,
  getOpenClawActiveStreamSnapshot,
  buildRuntimeHistoryMessages,
  mergeRuntimeHistoryMessages,
  mergeRuntimeText,
  reconcileRuntimeCumulativeFinalTail,
  reconcileMergedRuntimeHistoryContent,
  getLatestMeaningfulConversationMarker,
  annotateAgentChatSessionRunActivity,
};

/**
 * Enhanced history reader — includes tool calls and tool results from JSONL.
 */
function readSessionMessagesEnhanced(sessionId: string, limit = 200, sessionsDir = SESSIONS_DIR): any[] {
  const messages = readRecentSessionMessages({
    sessionId,
    limit,
    sessionsDir,
    parseLine: (line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
          const thinkingContent = extractReadableReasoningSummary(entry.payload);
          if (!thinkingContent || isHiddenHistoryArtifactText(thinkingContent)) return null;
          return {
            id: entry.id || `reasoning-${entry.timestamp || Date.now()}`,
            role: 'assistant',
            content: '',
            thinkingContent,
            timestamp: entry.timestamp,
            provenance: 'reasoning-summary',
          };
        }
        if (entry.type === 'compaction') {
          const compactionMeta = typeof entry.__openclaw === 'object' && entry.__openclaw
            ? entry.__openclaw
            : {};
          return {
            id: entry.id,
            role: 'system',
            content: extractCompactionNoticeText(null, compactionMeta),
            timestamp: entry.timestamp,
            __openclaw: {
              ...compactionMeta,
              kind: 'compaction',
              id: compactionMeta.id || entry.id,
            },
          };
        }

        if (entry.type !== 'message' || !entry.message) return null;
        const compactionMeta = entry.message?.__openclaw ?? entry.__openclaw;
        if (compactionMeta?.kind === 'compaction') {
          return {
            id: entry.id,
            role: 'system',
            content: extractCompactionNoticeText(entry.message.content, compactionMeta),
            timestamp: entry.timestamp,
            __openclaw: compactionMeta,
          };
        }
        const role = entry.message.role;
        const content = entry.message.content;
        const executedModel = normalizeGatewayModelId(
          entry.message.model
          ?? entry.message.modelId
          ?? entry.message.model_id
          ?? entry.message.actualModel
          ?? entry.message.executedModel
          ?? entry.message.metadata?.model
          ?? entry.message.providerResponse?.model
          ?? entry.model
          ?? entry.modelId
          ?? entry.actualModel
          ?? entry.executedModel
          ?? entry.metadata?.model
          ?? entry.providerResponse?.model,
        );

        if (role === 'user') {
          const text = extractText(content);
          if (!text) return null;
          if (isHiddenHistoryArtifactText(text)) {
            const summary = summarizeHiddenHistoryArtifactText(text);
            if (!summary) return null;
            return {
              id: entry.id,
              role: 'system',
              content: summary,
              provenance: 'hidden-history-artifact',
              timestamp: entry.timestamp,
            };
          }
          return { id: entry.id, role: 'user', content: text, timestamp: entry.timestamp };
        }

        if (role === 'assistant') {
          if (Array.isArray(content)) {
            const toolCalls: any[] = [];
            const thinkingBlocks: string[] = [];
            const messageIsReasoningMirror = isReasoningMirrorHistoryMessage(entry.message);
            // Track text blocks and where tool calls appear so we can separate
            // narration (text before tools) from the final response (text after tools).
            const allBlocks: { type: 'text' | 'tool'; text?: string }[] = [];
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                if (messageIsReasoningMirror || isReasoningMirrorHistoryMessage(entry.message, block.text)) {
                  const reasoningText = extractReasoningMirrorHistoryText(entry.message, block.text);
                  if (reasoningText) thinkingBlocks.push(reasoningText);
                } else {
                  allBlocks.push({ type: 'text', text: block.text });
                }
              } else if (block.type === 'thinking' && (typeof block.thinking === 'string' || typeof block.text === 'string')) {
                thinkingBlocks.push(typeof block.thinking === 'string' ? block.thinking : block.text);
              } else if (block.type === 'toolCall' && block.name) {
                toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
                allBlocks.push({ type: 'tool' });
              }
            }
            const hasToolCalls = toolCalls.length > 0;

            // Build segments array: all text blocks with their position relative to tools.
            // This allows the frontend to reconstruct the streaming timeline on history load.
            const segments: { text: string; position: 'before' | 'after' | 'between' }[] = [];
            let lastToolSeen = false;
            let toolCount = 0;
            for (const block of allBlocks) {
              if (block.type === 'tool') {
                lastToolSeen = true;
                toolCount++;
              } else if (block.type === 'text' && block.text) {
                const position = !lastToolSeen ? 'before' :
                                 (toolCount === toolCalls.length ? 'after' : 'between');
                const segmentText = extractSanitizedText(block.text);
                if (segmentText && !isHiddenHistoryArtifactText(segmentText)) {
                  segments.push({ text: segmentText, position });
                }
              }
            }

            // For display content, join all text blocks (streaming shows them inline anyway)
            const allText = allBlocks
              .filter(b => b.type === 'text')
              .map(b => b.text!)
              .join('\n');
            const text = extractSanitizedText(allText);
            const thinkingContent = extractSanitizedText(thinkingBlocks.join('\n'));
            const hasVisibleText = Boolean(text)
              && !isControlOnlyAssistantText(text)
              && !isHiddenHistoryArtifactText(text);
            const hasVisibleThinking = Boolean(thinkingContent) && !isHiddenHistoryArtifactText(thinkingContent);
            if (!hasVisibleText && !hasVisibleThinking && !hasToolCalls) return null;

            return {
              id: entry.id,
              role: 'assistant',
              content: hasVisibleText ? text : '',
              model: executedModel,
              thinkingContent: hasVisibleThinking ? thinkingContent : undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              // Include segments for frontend to reconstruct graduated timeline
              segments: hasToolCalls && segments.length > 0 ? segments : undefined,
              timestamp: entry.timestamp,
            };
          }

          const text = extractText(content);
          const reasoningMirrorText = extractReasoningMirrorHistoryText(entry.message, text);
          if (reasoningMirrorText && !isHiddenHistoryArtifactText(reasoningMirrorText)) {
            return {
              id: entry.id,
              role: 'assistant',
              content: '',
              model: executedModel,
              thinkingContent: reasoningMirrorText,
              timestamp: entry.timestamp,
              provenance: 'reasoning-mirror',
            };
          }
          if (!text || isControlOnlyAssistantText(text) || isHiddenHistoryArtifactText(text)) return null;
          return { id: entry.id, role: 'assistant', content: text, model: executedModel, timestamp: entry.timestamp };
        }

        if (role === 'toolResult') {
          return {
            id: entry.id,
            role: 'toolResult',
            toolCallId: entry.message.toolCallId,
            toolName: entry.message.toolName,
            content: extractText(content),
            timestamp: entry.timestamp,
          };
        }

        return null;
      } catch {
        return null;
      }
    },
  });

  return stripMessageDeliveryArtifactsFromHistory(hydrateHistoryToolCalls(messages));
}

function toHistoryTimestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function findHistoryToolResultMatchIndex(toolCalls: any[], toolResult: any): number {
  return toolCalls.findIndex((toolCall: any) => {
    if (!toolCall || typeof toolCall !== 'object') return false;
    return Boolean(toolResult?.toolCallId && toolCall.id === toolResult.toolCallId);
  });
}

function buildHistoryToolCallFromResult(toolResult: any, fallbackBaseId: string, index: number) {
  const ts = toHistoryTimestampMs(toolResult?.timestamp);
  const toolName = typeof toolResult?.toolName === 'string' && toolResult.toolName.trim()
    ? toolResult.toolName.trim()
    : 'tool';

  return {
    id: typeof toolResult?.toolCallId === 'string' && toolResult.toolCallId.trim()
      ? toolResult.toolCallId
      : `${fallbackBaseId}-tool-${index + 1}`,
    name: toolName,
    arguments: undefined,
    startedAt: ts,
    endedAt: ts,
    status: 'done',
    result: typeof toolResult?.content === 'string' ? toolResult.content : '',
  };
}

function mergePendingToolResultsIntoAssistant(assistant: any, pendingToolResults: any[]): any {
  const existingToolCalls = Array.isArray(assistant?.toolCalls) ? [...assistant.toolCalls] : [];
  const fallbackBaseId = assistant?.id || pendingToolResults[0]?.id || 'history';

  for (let index = 0; index < pendingToolResults.length; index += 1) {
    const toolResult = pendingToolResults[index];
    const synthesized = buildHistoryToolCallFromResult(toolResult, fallbackBaseId, index);
    const matchIndex = findHistoryToolResultMatchIndex(existingToolCalls, toolResult);

    if (matchIndex >= 0) {
      existingToolCalls[matchIndex] = {
        ...existingToolCalls[matchIndex],
        startedAt: typeof existingToolCalls[matchIndex].startedAt === 'number'
          ? existingToolCalls[matchIndex].startedAt
          : synthesized.startedAt,
        endedAt: synthesized.endedAt,
        status: 'done',
        result: synthesized.result,
      };
      continue;
    }

    // No exact match. Do not attach by toolName or position; that corrupts
    // history when OpenClaw delivery/tool plumbing interleaves with real turns.
  }

  if (existingToolCalls.length === 0) return assistant;

  return {
    ...assistant,
    toolCalls: existingToolCalls,
  };
}

function hydrateHistoryToolCalls(messages: any[]): any[] {
  const hydrated: any[] = [];
  let pendingToolResults: any[] = [];

  const flushPendingToolResults = () => {
    // Unmatched toolResult messages are not user-visible conversation turns.
    // If they cannot be attached by exact toolCallId, dropping them is safer
    // than inventing synthetic empty tool-card messages or contaminating the
    // next assistant turn by tool name.
    pendingToolResults = [];
  };

  const mergeToolResultIntoExistingAssistant = (toolResult: any): boolean => {
    for (let index = hydrated.length - 1; index >= 0; index -= 1) {
      const candidate = hydrated[index];
      if (!candidate || candidate.role !== 'assistant') continue;
      const toolCalls = Array.isArray(candidate.toolCalls) ? candidate.toolCalls : [];
      if (toolCalls.length === 0) continue;

      const matchIndex = findHistoryToolResultMatchIndex(toolCalls, toolResult);
      if (matchIndex < 0) continue;
      hydrated[index] = mergePendingToolResultsIntoAssistant(candidate, [toolResult]);
      return true;
    }
    return false;
  };

  for (const message of messages) {
    if (!message) continue;

    if (message.role === 'toolResult') {
      if (mergeToolResultIntoExistingAssistant(message)) continue;
      pendingToolResults.push(message);
      continue;
    }

    if (message.role === 'assistant' && pendingToolResults.length > 0) {
      hydrated.push(mergePendingToolResultsIntoAssistant(message, pendingToolResults));
      pendingToolResults = [];
      continue;
    }

    flushPendingToolResults();
    hydrated.push(message);
  }

  flushPendingToolResults();
  return hydrated;
}

function augmentDirectHistoryPayload(payload: any, sessionKey: string, limit = 200): any {
  if (!payload || !Array.isArray(payload.messages) || !sessionKey) return payload;

  try {
    const sessionsDir = resolveSessionsDir(sessionKey);
    const enhancedMessages = readSessionMessagesEnhancedForSessionKey(sessionKey, limit, sessionsDir);
    if (enhancedMessages.length === 0) return payload;

    const compactionMessages = enhancedMessages
      .filter((message) => message?.role === 'system' && (message?.__openclaw?.kind === 'compaction' || isCompactionNoticeText(message?.content)))
      .map((message) => ({
        id: message.id,
        role: 'system',
        content: extractCompactionNoticeText(message?.content, message?.__openclaw),
        timestamp: message.timestamp,
        __openclaw: message.__openclaw || { kind: 'compaction', id: message.id },
      }));

    if (compactionMessages.length === 0) return payload;

    const seenIds = new Set<string>();
    const combined = [...payload.messages, ...compactionMessages]
      .filter((message) => {
        const messageId = typeof message?.id === 'string' ? message.id : '';
        if (messageId && seenIds.has(messageId)) return false;
        if (messageId) seenIds.add(messageId);
        return true;
      })
      .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp));

    return {
      ...payload,
      messages: combined.slice(-Math.max(limit, 1)),
    };
  } catch (err) {
    console.warn('[gateway-direct] Failed to augment chat.history payload:', err);
    return payload;
  }
}


function addSessionFileCandidate(candidates: string[], seen: Set<string>, sessionId: unknown, sessionsDir: string): void {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalized || seen.has(normalized)) return;
  if (!existsSync(path.join(sessionsDir, `${normalized}.jsonl`))) return;
  seen.add(normalized);
  candidates.push(normalized);
}

// Trajectory logs are large (tens of MB across a session dir) and history /
// stream-status requests used to re-read every file on every call, which cost
// multiple seconds per session switch and blocked the event loop. Index which
// session keys each trajectory file contains, keyed by mtime+size, so requests
// only read the few files that actually mention the requested session.
type TrajectoryFileIndexEntry = {
  mtimeMs: number;
  size: number;
  sessionKeys: Set<string>;
};
const trajectoryFileIndexCache = new Map<string, TrajectoryFileIndexEntry>();
const TRAJECTORY_SESSION_KEY_RE = /"sessionKey"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
// Trajectory files are a best-effort recovery source, not the canonical
// transcript. Long-running agents can grow them to hundreds of megabytes, so
// opening a chat must never synchronously deserialize their lifetime contents.
// Keep recovery bounded to recent complete JSONL records; canonical session
// history remains responsible for older pages and complete export.
const MAX_TRAJECTORY_RECOVERY_BYTES = 8 * 1024 * 1024;
const MAX_TRAJECTORY_RECOVERY_FILES = 24;

function readBoundedJsonlTailText(filePath: string, maxBytes = MAX_TRAJECTORY_RECOVERY_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return '';
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return '';
  }
  if (!stat.isFile() || stat.size <= 0) return '';

  const length = Math.min(stat.size, maxBytes);
  const start = stat.size - length;
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    if (bytesRead <= 0) return '';
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // A bounded tail can begin in the middle of a JSON record. Discard that
    // fragment rather than feeding malformed or attacker-shaped bytes to the
    // parser. The final record is retained only when newline-terminated.
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return '';
      text = text.slice(firstNewline + 1);
    }
    if (!text.endsWith('\n')) {
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function getTrajectoryFileIndex(filePath: string): TrajectoryFileIndexEntry | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    trajectoryFileIndexCache.delete(filePath);
    return null;
  }

  const cached = trajectoryFileIndexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

  const raw = readBoundedJsonlTailText(filePath);
  if (!raw) {
    trajectoryFileIndexCache.delete(filePath);
    return null;
  }

  const sessionKeys = new Set<string>();
  TRAJECTORY_SESSION_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRAJECTORY_SESSION_KEY_RE.exec(raw))) {
    try {
      sessionKeys.add(JSON.parse(`"${match[1]}"`));
    } catch {
      sessionKeys.add(match[1]);
    }
  }

  const entry: TrajectoryFileIndexEntry = { mtimeMs: stat.mtimeMs, size: stat.size, sessionKeys };
  trajectoryFileIndexCache.set(filePath, entry);
  return entry;
}

function listTrajectoryFilesForSessionVariants(variants: Set<string>, sessionsDir: string): string[] {
  let entries: any[] = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true }) as any[];
  } catch {
    return [];
  }

  const recentFiles = entries
    .filter((entry) => entry.isFile?.() && entry.name.endsWith('.trajectory.jsonl'))
    .map((entry) => {
      const filePath = path.join(sessionsDir, entry.name);
      try {
        return { filePath, mtimeMs: statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_TRAJECTORY_RECOVERY_FILES);

  const matching: string[] = [];
  for (const { filePath } of recentFiles) {
    const index = getTrajectoryFileIndex(filePath);
    if (!index) continue;
    for (const variant of variants) {
      if (index.sessionKeys.has(variant)) {
        matching.push(filePath);
        break;
      }
    }
  }
  return matching;
}

// Long-lived sessions (agent:main:main) appear in nearly every trajectory file,
// so the key index alone cannot skip reads for them. Cache each file's parsed
// per-session extraction keyed by mtime+size: finished trajectory files parse
// once for the process lifetime and only the actively-written file re-parses.
type TrajectoryParsedExtraction = {
  candidateSessionIds: string[];
  messages: any[];
};
type TrajectoryParsedCacheEntry = {
  mtimeMs: number;
  size: number;
  bySessionKey: Map<string, TrajectoryParsedExtraction>;
};
const trajectoryParsedCache = new Map<string, TrajectoryParsedCacheEntry>();
const TRAJECTORY_PARSED_CACHE_MAX_SESSION_KEYS_PER_FILE = 8;

function readTrajectoryFileExtraction(filePath: string, sessionKey: string, variants: Set<string>): TrajectoryParsedExtraction | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    trajectoryParsedCache.delete(filePath);
    return null;
  }

  let entry = trajectoryParsedCache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, bySessionKey: new Map() };
    trajectoryParsedCache.set(filePath, entry);
  }

  const cached = entry.bySessionKey.get(sessionKey);
  if (cached) {
    return {
      candidateSessionIds: [...cached.candidateSessionIds],
      messages: structuredClone(cached.messages),
    };
  }

  const raw = readBoundedJsonlTailText(filePath);
  if (!raw) {
    trajectoryParsedCache.delete(filePath);
    return null;
  }

  const fileName = path.basename(filePath);
  const variantList = Array.from(variants);
  const candidateSessionIds: string[] = [];
  const seenCandidates = new Set<string>();
  const messages: any[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || !variantList.some((key) => line.includes(key))) continue;
    try {
      const parsed = JSON.parse(line);
      const key = typeof parsed?.sessionKey === 'string' ? parsed.sessionKey.trim() : '';
      if (!key || !variants.has(key)) continue;

      for (const candidate of [parsed?.sessionId, parsed?.data?.sessionId]) {
        const clean = typeof candidate === 'string' ? candidate.trim() : '';
        if (clean && !seenCandidates.has(clean)) {
          seenCandidates.add(clean);
          candidateSessionIds.push(clean);
        }
      }

      const snapshot = Array.isArray(parsed?.data?.messagesSnapshot) ? parsed.data.messagesSnapshot : [];
      snapshot.forEach((message: any, index: number) => {
        const mapped = mapTrajectoryRuntimeMessage(message, `trajectory-${parsed.runId || fileName}-${index}`, message?.timestamp || parsed.ts);
        if (mapped) messages.push(mapped);
      });
    } catch {
      continue;
    }
  }

  if (entry.bySessionKey.size >= TRAJECTORY_PARSED_CACHE_MAX_SESSION_KEYS_PER_FILE) {
    entry.bySessionKey.clear();
  }
  entry.bySessionKey.set(sessionKey, {
    candidateSessionIds: [...candidateSessionIds],
    messages: structuredClone(messages),
  });

  return { candidateSessionIds, messages };
}

function findTrajectorySessionFileIdsForSessionKey(sessionKey: string, sessionsDir = SESSIONS_DIR): string[] {
  const variants = new Set(getSessionKeyLookupVariants(sessionKey));
  if (variants.size === 0 || !existsSync(sessionsDir)) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const filePath of listTrajectoryFilesForSessionVariants(variants, sessionsDir)) {
    const extraction = readTrajectoryFileExtraction(filePath, sessionKey, variants);
    if (!extraction) continue;
    for (const candidateSessionId of extraction.candidateSessionIds) {
      addSessionFileCandidate(candidates, seen, candidateSessionId, sessionsDir);
    }
  }

  return candidates;
}

function findSessionFileIdsForSessionKey(sessionKey: string, sessionsDir = SESSIONS_DIR): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const entry of resolveSessionRegistryEntries(sessionKey, sessionsDir)) {
    addSessionFileCandidate(candidates, seen, entry?.sessionId || entry?.id, sessionsDir);
    const usageFamilySessionIds = Array.isArray(entry?.usageFamilySessionIds)
      ? entry.usageFamilySessionIds
      : [];
    for (const familySessionId of usageFamilySessionIds) {
      addSessionFileCandidate(candidates, seen, familySessionId, sessionsDir);
    }
  }

  for (const key of getSessionKeyLookupVariants(sessionKey)) {
    addSessionFileCandidate(candidates, seen, key, sessionsDir);
    const parts = key.split(':');
    if (parts.length >= 3) addSessionFileCandidate(candidates, seen, parts.slice(2).join(':'), sessionsDir);
  }

  for (const sessionId of findTrajectorySessionFileIdsForSessionKey(sessionKey, sessionsDir)) {
    addSessionFileCandidate(candidates, seen, sessionId, sessionsDir);
  }

  return candidates;
}

/** Resolve a session key to its JSONL file id */
function resolveSessionFileId(sessionKey: string, sessionsDir = SESSIONS_DIR): string | null {
  return findSessionFileIdsForSessionKey(sessionKey, sessionsDir)[0] || null;
}

function mapTrajectoryRuntimeMessage(rawMessage: any, fallbackId: string, fallbackTimestamp: unknown): any | null {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const role = rawMessage.role;
  const timestamp = rawMessage.timestamp || fallbackTimestamp;
  const id = typeof rawMessage.id === 'string' && rawMessage.id.trim()
    ? rawMessage.id.trim()
    : (typeof rawMessage.responseId === 'string' && rawMessage.responseId.trim() ? rawMessage.responseId.trim() : fallbackId);
  if (role === 'user') {
    const text = extractText(rawMessage.content);
    if (!text || isHiddenHistoryArtifactText(text)) return null;
    return { id, role: 'user', content: text, timestamp, provenance: 'trajectory-recovery' };
  }

  if (role === 'assistant') {
    const content = rawMessage.content;
    const executedModel = normalizeGatewayModelId(rawMessage.model ?? rawMessage.modelId ?? rawMessage.actualModel);

    if (Array.isArray(content)) {
      const toolCalls: any[] = [];
      const thinkingBlocks: string[] = [];
      const textBlocks: string[] = [];
      const messageIsReasoningMirror = isReasoningMirrorHistoryMessage(rawMessage);

      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          if (messageIsReasoningMirror || isReasoningMirrorHistoryMessage(rawMessage, block.text)) {
            const reasoningText = extractReasoningMirrorHistoryText(rawMessage, block.text);
            if (reasoningText) thinkingBlocks.push(reasoningText);
          } else {
            textBlocks.push(block.text);
          }
        }
        if (block?.type === 'thinking' && (typeof block.thinking === 'string' || typeof block.text === 'string')) {
          thinkingBlocks.push(typeof block.thinking === 'string' ? block.thinking : block.text);
        }
        if (block?.type === 'toolCall' && block.name) {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
        }
      }

      const text = extractSanitizedText(textBlocks.join('\n'));
      const thinkingContent = extractSanitizedText(thinkingBlocks.join('\n'));
      const hasVisibleText = Boolean(text) && !isControlOnlyAssistantText(text) && !isHiddenHistoryArtifactText(text);
      const hasVisibleThinking = Boolean(thinkingContent) && !isHiddenHistoryArtifactText(thinkingContent);
      if (!hasVisibleText && !hasVisibleThinking && toolCalls.length === 0) return null;

      return {
        id,
        role: 'assistant',
        content: hasVisibleText ? text : '',
        model: executedModel,
        thinkingContent: hasVisibleThinking ? thinkingContent : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp,
        provenance: 'trajectory-recovery',
      };
    }

    const text = extractText(content);
    const reasoningMirrorText = extractReasoningMirrorHistoryText(rawMessage, text);
    if (reasoningMirrorText && !isHiddenHistoryArtifactText(reasoningMirrorText)) {
      return { id, role: 'assistant', content: '', model: executedModel, thinkingContent: reasoningMirrorText, timestamp, provenance: 'reasoning-mirror' };
    }
    if (!text || isControlOnlyAssistantText(text) || isHiddenHistoryArtifactText(text)) return null;
    return { id, role: 'assistant', content: text, model: executedModel, timestamp, provenance: 'trajectory-recovery' };
  }

  if (role === 'toolResult') {
    return null;
  }

  return null;
}

function readTrajectoryMessagesForSessionKey(sessionKey: string, limit = 200, sessionsDir = SESSIONS_DIR): any[] {
  const variants = new Set(getSessionKeyLookupVariants(sessionKey));
  if (variants.size === 0 || !existsSync(sessionsDir)) return [];

  const rawMessages: any[] = [];

  for (const filePath of listTrajectoryFilesForSessionVariants(variants, sessionsDir)) {
    const extraction = readTrajectoryFileExtraction(filePath, sessionKey, variants);
    if (!extraction) continue;
    rawMessages.push(...extraction.messages);
  }

  const seen = new Set<string>();
  const deduped = rawMessages
    .sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp))
    .filter((message) => {
      const toolNames = Array.isArray(message?.toolCalls) ? message.toolCalls.map((tool: any) => tool?.name || '').join(',') : '';
      const key = [message?.role || '', toHistoryTimestampMs(message?.timestamp), message?.content || '', message?.toolName || '', toolNames].join('::');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return stripMessageDeliveryArtifactsFromHistory(hydrateHistoryToolCalls(deduped)).slice(-Math.max(limit, 1));
}

function getHistoryTimestampRange(messages: any[]): { min: number; max: number } | null {
  const timestamps = messages
    .map((message) => toHistoryTimestampMs(message?.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  if (timestamps.length === 0) return null;
  return { min: Math.min(...timestamps), max: Math.max(...timestamps) };
}

function filterTrajectoryMessagesNearCanonicalMessages(trajectoryMessages: any[], canonicalMessages: any[]): any[] {
  if (trajectoryMessages.length === 0 || canonicalMessages.length === 0) return trajectoryMessages;

  const canonicalRange = getHistoryTimestampRange(canonicalMessages);
  if (!canonicalRange) return trajectoryMessages;

  // Trajectory logs are a recovery source, not a second durable transcript. Session keys
  // can be reused across Portal turns, so blindly appending every matching trajectory
  // snapshot leaks stale tool cards/model labels from earlier runs into the current chat.
  // Keep recovery data only when it is plausibly part of the same canonical history span.
  const recoveryWindowMs = 30 * 60 * 1000;
  const minAllowed = canonicalRange.min - recoveryWindowMs;
  const maxAllowed = canonicalRange.max + recoveryWindowMs;

  return trajectoryMessages.filter((message) => {
    const timestamp = toHistoryTimestampMs(message?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
    return timestamp >= minAllowed && timestamp <= maxAllowed;
  });
}

function readBestOpenClawSessionMessagesForSessionKey(sessionKey: string, limit = 200, sessionsDir = SESSIONS_DIR): any[] {
  const candidates = findSessionFileIdsForSessionKey(sessionKey, sessionsDir);
  const seen = new Set<string>();
  const combined: any[] = [];
  const canonicalMessages: any[] = [];

  const normalizedDuplicateSignature = (message: any) => {
    const toolNames = Array.isArray(message?.toolCalls) ? message.toolCalls.map((tool: any) => tool?.name || '').join(',') : '';
    return [message?.role || '', String(message?.content || '').trim(), message?.toolName || '', toolNames].join('::');
  };

  const isTrajectoryDuplicateOfCanonical = (message: any): boolean => {
    if (message?.provenance !== 'trajectory-recovery') return false;
    const signature = normalizedDuplicateSignature(message);
    const ts = toHistoryTimestampMs(message?.timestamp);
    return combined.some((existing) => {
      if (existing?.provenance === 'trajectory-recovery') return false;
      if (normalizedDuplicateSignature(existing) !== signature) return false;
      return Math.abs(toHistoryTimestampMs(existing?.timestamp) - ts) <= 10 * 60 * 1000;
    });
  };

  const pushMessage = (message: any) => {
    if (isTrajectoryDuplicateOfCanonical(message)) return;
    const toolNames = Array.isArray(message?.toolCalls) ? message.toolCalls.map((tool: any) => tool?.name || '').join(',') : '';
    const contentKey = [message?.role || '', toHistoryTimestampMs(message?.timestamp), message?.content || '', message?.toolName || '', toolNames].join('::');
    const messageId = typeof message?.id === 'string' ? message.id.trim() : '';
    const key = contentKey || messageId;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    combined.push(message);
  };

  for (const sessionId of candidates) {
    const messages = readSessionMessagesEnhanced(sessionId, limit, sessionsDir);
    for (const message of messages) {
      canonicalMessages.push(message);
      pushMessage(message);
    }
  }

  const trajectoryMessages = filterTrajectoryMessagesNearCanonicalMessages(
    readTrajectoryMessagesForSessionKey(sessionKey, limit, sessionsDir),
    canonicalMessages,
  );

  for (const message of trajectoryMessages) {
    pushMessage(message);
  }

  combined.sort((a, b) => toHistoryTimestampMs(a?.timestamp) - toHistoryTimestampMs(b?.timestamp));
  return stripMessageDeliveryArtifactsFromHistory(combined).slice(-Math.max(limit, 1));
}

async function readOpenClawHistoryPage(params: {
  sessionKey: string;
  sessionId: string;
  sessionsDir: string;
  enhanced: boolean;
  limit: number;
  scope: string;
  beforeCursor?: unknown;
}): Promise<HistoryPageResult> {
  const anchor = params.beforeCursor
    ? decodeHistoryCursor(params.beforeCursor, params.scope)
    : undefined;
  let scanLimit = anchor
    ? Math.min(Math.max(params.limit * 2 + 1, 200), MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES)
    : params.limit + 1;

  while (true) {
    const messages = params.enhanced
      ? readSessionMessagesEnhancedForSessionKey(params.sessionKey, scanLimit, params.sessionsDir)
      : await readSessionMessages(params.sessionId, scanLimit, params.sessionsDir);
    const sourceComplete = messages.length < scanLimit;

    if (!anchor) {
      return buildHistoryPage(messages, params.limit, params.scope, undefined, sourceComplete);
    }

    const anchorIndex = findHistoryAnchorIndex(messages, anchor);
    if (anchorIndex >= 0 && (anchorIndex > params.limit || sourceComplete)) {
      return buildHistoryPage(messages, params.limit, params.scope, anchor, sourceComplete);
    }

    if (sourceComplete) {
      throw new HistoryCursorError('History cursor is no longer available');
    }
    if (scanLimit >= MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES) {
      throw new HistoryCursorError('History cursor is outside the retained pagination window');
    }
    scanLimit = Math.min(scanLimit * 2, MAX_HISTORY_ADAPTIVE_SCAN_MESSAGES);
  }
}

const PROVENANCE: Record<string, string> = {
  OPENCLAW: 'via OpenClaw',
  CLAUDE_CODE: 'via Claude CLI',
  CODEX: 'via Codex CLI',
  GROK: 'via Grok Build CLI',
  GEMINI: 'via Antigravity',
  AGENT_ZERO: 'via Agent Zero',
};

// These providers publish HOST_OPERATOR turns into StreamEventBus themselves.
// Their browser transport must consume that bus and leave the legacy callback
// arguments as no-ops, otherwise every chunk/status/tool/terminal event is sent
// twice (once by the callback and once by the bus/global reconnect path).
const PROVIDER_OWNED_HOST_STREAMS = new Set<AgentProviderName>([
  'OPENCLAW',
  'CLAUDE_CODE',
  'CODEX',
  'GEMINI',
]);

function providerPublishesHostStream(providerName: AgentProviderName): boolean {
  return PROVIDER_OWNED_HOST_STREAMS.has(providerName);
}

function providerUsesHostStreamBus(providerName: AgentProviderName): boolean {
  return providerName === 'OPENCLAW'
    || providerName === 'CLAUDE_CODE'
    || providerName === 'CODEX'
    || providerName === 'GROK'
    || providerName === 'AGENT_ZERO'
    || providerName === 'GEMINI'
    || providerName === 'OLLAMA';
}

function reserveHostStreamRoute(params: {
  sessionId: string;
  runId: string;
  provenance: string;
  model?: string;
}): boolean {
  const existing = streamEventBus.getTrackedStream(params.sessionId);
  const existingRunId = normalizeHostStreamRunId(existing?.runId);
  if (existing && !existing.active && existingRunId && existingRunId !== params.runId) {
    const adopted = streamEventBus.adoptStreamRun(
      params.sessionId,
      existingRunId,
      params.runId,
      { provenance: params.provenance, model: params.model },
    );
    return adopted && streamEventBus.resumeStream(params.sessionId, params.runId, {
      provenance: params.provenance,
      model: params.model,
    });
  }
  return streamEventBus.startStream(params.sessionId, params.runId, {
    provenance: params.provenance,
    model: params.model,
  });
}

function reserveDirectGatewayChatRun(sessionId: string, reservationRunId: string): boolean {
  if (!reserveHostStreamRoute({
    sessionId,
    runId: reservationRunId,
    provenance: 'via OpenClaw',
  })) return false;
  if (reserveLogicalRun(sessionId, reservationRunId)) return true;
  streamEventBus.clearStream(sessionId, reservationRunId);
  return false;
}

function acknowledgeDirectGatewayChatRun(
  sessionId: string,
  reservationRunId: string,
  upstreamRunId: string,
): boolean {
  return acknowledgeRunReservation(sessionId, reservationRunId, upstreamRunId);
}

function failDirectGatewayChatRun(sessionId: string, reservationRunId: string): void {
  failPendingRunReservation(sessionId, reservationRunId);
}

interface DirectGatewayChatSendMeta {
  method?: string;
  sessionKey?: string;
  reservationRunId?: string;
  clientMessageId?: string;
  idempotencyKey?: string;
}

function normalizeDirectGatewayClientMessageId(value: unknown): string | undefined {
  const embedded = portalClientMessageIdFromIdempotencyKey(value);
  if (embedded) return embedded;
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return undefined;
  }
  if (normalized.endsWith(':user')) normalized = normalized.slice(0, -':user'.length);
  if (normalized.startsWith('portal-')) normalized = normalized.slice('portal-'.length);
  return normalizePortalClientMessageId(normalized);
}

function isDirectGatewayActiveTurnError(error: unknown): boolean {
  if (typeof error === 'string') return /different run is already active|already has an active turn/i.test(error);
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code === 'string' && candidate.code.trim().toUpperCase() === 'TURN_ACTIVE') {
    return true;
  }
  const message = [candidate.message, candidate.error]
    .find((value) => typeof value === 'string');
  return typeof message === 'string'
    && /different run is already active|already has an active turn/i.test(message);
}

async function buildDirectGatewayActiveTurnError(
  sessionKey: string,
  clientMessageId?: string,
): Promise<Record<string, unknown>> {
  let activeStream = getProviderOwnedBusStreamSnapshot(sessionKey);
  if (!activeStream.active) {
    activeStream = await reconcileOpenClawActiveTurnConflict(sessionKey);
  }
  return {
    code: 'TURN_ACTIVE',
    message: 'This chat already has an active turn. The Portal is reconnecting to it and queued your message.',
    sessionKey,
    ...(clientMessageId ? { clientMessageId } : {}),
    activeStream: browserSafeActiveStreamSnapshot('OPENCLAW', activeStream),
  };
}

/**
 * Settle the direct proxy's synthetic run reservation before exposing the
 * upstream chat.send response to the browser. Fast frames can arrive before
 * this response and are buffered behind the reservation; forwarding success
 * first leaves those frames quarantined forever and wedges the next send.
 */
async function settleDirectGatewayChatSendResponse(
  meta: DirectGatewayChatSendMeta | undefined,
  response: Record<string, any>,
): Promise<Record<string, any>> {
  if (
    meta?.method !== 'chat.send'
    || !meta.sessionKey
    || !meta.reservationRunId
  ) {
    return response;
  }

  if (response.ok === true) {
    const upstreamRunId = normalizeHostStreamRunId(
      response.payload?.runId ?? response.result?.runId,
    );
    if (
      upstreamRunId
      && acknowledgeDirectGatewayChatRun(
        meta.sessionKey,
        meta.reservationRunId,
        upstreamRunId,
      )
    ) {
      return response;
    }

    // An accepted response without a usable run identity is ambiguous, not a
    // rejection. Park the exact origin fence so a later trusted user mirror,
    // sessions.list probe, or durable-history match can adopt the real run.
    // Marking it failed here would tombstone the accepted turn while the
    // browser is explicitly entering recovery.
    parkUnconfirmedRunReservation(
      meta.sessionKey,
      meta.reservationRunId,
      meta.idempotencyKey || '',
    );
    return {
      ...response,
      ok: false,
      payload: undefined,
      result: undefined,
      error: {
        code: 'CHAT_SEND_UNCONFIRMED',
        message: upstreamRunId
          ? 'The gateway acknowledged a stale chat turn. Reconnect and retry.'
          : 'The gateway did not identify the accepted chat turn. Reconnect and retry.',
        sessionKey: meta.sessionKey,
        ...(meta.clientMessageId ? { clientMessageId: meta.clientMessageId } : {}),
      },
    };
  }

  failDirectGatewayChatRun(meta.sessionKey, meta.reservationRunId);
  if (!isDirectGatewayActiveTurnError(response.error)) return response;

  return {
    ...response,
    ok: false,
    error: await buildDirectGatewayActiveTurnError(
      meta.sessionKey,
      meta.clientMessageId,
    ),
  };
}

function scheduleDirectGatewayChatRunTimeout(
  sessionId: string,
  reservationRunId: string,
  idempotencyKey: string,
  onExpire: () => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    parkUnconfirmedRunReservation(sessionId, reservationRunId, idempotencyKey);
    onExpire();
  }, DIRECT_GATEWAY_CHAT_SEND_TIMEOUT_MS);
}

function createHostStreamRunMatcher(
  providerName: AgentProviderName,
  routeRunId: string,
  options?: { openClawRunIdKnown?: boolean },
): { matches: (event: StreamEvent) => boolean; currentRunId: () => string } {
  let observedRunId = providerName === 'OPENCLAW' && options?.openClawRunIdKnown !== true
    ? ''
    : routeRunId;
  return {
    matches: (event: StreamEvent) => {
      const eventRunId = typeof event.runId === 'string' ? event.runId.trim() : '';
      if (!eventRunId) return true;
      if (!observedRunId) observedRunId = eventRunId;
      if (providerName === 'OPENCLAW' && event.type === 'run_resumed' && eventRunId !== observedRunId) {
        observedRunId = eventRunId;
        return true;
      }
      return eventRunId === observedRunId;
    },
    currentRunId: () => observedRunId || routeRunId,
  };
}

function softClearHostStreamIfCurrent(sessionId: string, runId: string): void {
  streamEventBus.softClearStream(sessionId, runId);
}

type HostStreamRunIdentity = {
  runId: string | null;
  startedAt: number | null;
};

function normalizeHostStreamRunId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function captureHostStreamRunIdentity(
  sessionId: string,
  requestedRunId?: unknown,
): HostStreamRunIdentity {
  const tracked = streamEventBus.getTrackedStream(sessionId);
  const explicitRunId = normalizeHostStreamRunId(requestedRunId);
  const trackedRunId = normalizeHostStreamRunId(tracked?.runId);
  return {
    runId: explicitRunId || trackedRunId,
    // A caller-supplied run ID that does not match the locally tracked run is
    // intentionally not allowed to borrow that run's timestamp as a fallback.
    startedAt: explicitRunId && trackedRunId !== explicitRunId
      ? null
      : (typeof tracked?.startedAt === 'number' ? tracked.startedAt : null),
  };
}

function hostStreamRunIdentityMatches(
  tracked: StreamInfo | null,
  identity: HostStreamRunIdentity,
): boolean {
  if (!tracked) return false;
  const trackedRunId = normalizeHostStreamRunId(tracked.runId);
  if (identity.runId) return trackedRunId === identity.runId;
  return identity.startedAt !== null
    && trackedRunId === null
    && tracked.startedAt === identity.startedAt;
}

/**
 * Hard-clear only the logical run captured before an asynchronous operation.
 * A false result means a replacement run is now active and must be preserved.
 */
function clearHostStreamIfCurrentRun(
  sessionId: string,
  identity: HostStreamRunIdentity,
): boolean {
  const tracked = streamEventBus.getTrackedStream(sessionId);
  if (!tracked) return true;
  if (!hostStreamRunIdentityMatches(tracked, identity)) return false;
  return streamEventBus.clearStream(sessionId, identity.runId);
}

const activeSseDeliveries = new Map<string, () => void>();

function normalizeStreamClientId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(normalized) ? normalized : null;
}

function sseDeliveryKey(userId: string, sessionId: string, streamClientId: string): string {
  return `${userId}\0${sessionId}\0${streamClientId}`;
}

function registerSseDelivery(
  userId: string,
  sessionId: string,
  rawStreamClientId: unknown,
  cleanup: () => void,
): () => void {
  const streamClientId = normalizeStreamClientId(rawStreamClientId);
  if (!streamClientId) return () => {};
  const key = sseDeliveryKey(userId, sessionId, streamClientId);
  activeSseDeliveries.get(key)?.();
  activeSseDeliveries.set(key, cleanup);
  return () => {
    if (activeSseDeliveries.get(key) === cleanup) activeSseDeliveries.delete(key);
  };
}

function takeOverSseDelivery(userId: string, sessionId: string, rawStreamClientId: unknown): boolean {
  const streamClientId = normalizeStreamClientId(rawStreamClientId);
  if (!streamClientId) return false;
  const key = sseDeliveryKey(userId, sessionId, streamClientId);
  const cleanup = activeSseDeliveries.get(key);
  if (!cleanup) return false;
  activeSseDeliveries.delete(key);
  cleanup();
  return true;
}

const HOST_STREAM_EVENT_TYPES = new Set<StreamEvent['type']>([
  'text',
  'thinking',
  'tool_start',
  'tool_update',
  'tool_end',
  'tool_used',
  'status',
  'done',
  'error',
  'exec_approval',
  'segment_break',
  'compaction_start',
  'compaction_end',
  'run_resumed',
]);

function sanitizeRouteOwnedHostStreamEvent(
  rawEvent: { type?: string; content?: string; [key: string]: unknown },
  runId: string,
): StreamEvent {
  const rawType = typeof rawEvent?.type === 'string' ? rawEvent.type.trim() : '';
  let type = HOST_STREAM_EVENT_TYPES.has(rawType as StreamEvent['type'])
    ? rawType as StreamEvent['type']
    : 'status';
  const sanitized = sanitizeNativeProviderEvent(rawEvent || {}) as Record<string, unknown>;

  // Route-owned providers settle through their sendMessage Promise. A
  // callback-level diagnostic named "error" can be followed by a successful
  // completion, so it is nonterminal unless the provider explicitly proves
  // otherwise.
  if (type === 'error' && rawEvent.terminal !== true) {
    type = 'status';
    sanitized.severity = 'error';
    sanitized.terminal = false;
  }

  // Text events are primary assistant output, not diagnostics. Preserve their
  // exact content while still sanitizing every attached metadata field.
  if (type === 'text' && typeof rawEvent?.content === 'string') {
    sanitized.content = rawEvent.content;
  }

  return {
    ...sanitized,
    type,
    runId,
    ...(rawType && rawType !== type ? { providerEventType: rawType } : {}),
  } as StreamEvent;
}

function publishRouteOwnedHostStreamEvent(params: {
  sessionId: string;
  runId: string;
  provenance: string;
  model?: string;
  event: { type?: string; content?: string; [key: string]: unknown };
}): void {
  const { sessionId, runId, provenance, model } = params;
  const tracked = streamEventBus.getTrackedStream(sessionId);
  if (tracked?.active && tracked.runId && tracked.runId !== runId) return;
  const event = sanitizeRouteOwnedHostStreamEvent(params.event, runId);
  if (!streamEventBus.startStream(sessionId, runId, { provenance, model })) return;

  if (event.type === 'text') {
    if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'streaming', runId, provenance, model })) return;
  } else if (event.type === 'tool_start' || event.type === 'tool_update') {
    if (!streamEventBus.updateStreamPhase(sessionId, {
      phase: 'tool',
      toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
      runId,
      provenance,
      model,
    })) return;
  } else if (event.type === 'tool_end' || event.type === 'thinking' || event.type === 'status') {
    if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'thinking', runId, provenance, model })) return;
  }

  streamEventBus.publish(sessionId, event);
}

function publishRouteOwnedHostStreamDone(params: {
  sessionId: string;
  runId: string;
  provenance: string;
  result?: { fullText?: unknown; metadata?: unknown };
  aborted?: boolean;
}): void {
  const metadata = sanitizeNativeProviderEvent(
    params.result?.metadata && typeof params.result.metadata === 'object'
      ? params.result.metadata
      : {},
  );
  const model = normalizeGatewayModelId((metadata as Record<string, unknown>)?.model) || null;
  streamEventBus.publish(params.sessionId, {
    type: 'done',
    content: typeof params.result?.fullText === 'string' ? params.result.fullText : '',
    provenance: params.provenance,
    model,
    metadata: params.aborted ? { ...metadata, aborted: true } : metadata,
    runId: params.runId,
  });
  softClearHostStreamIfCurrent(params.sessionId, params.runId);
}

function publishRouteOwnedHostStreamError(params: {
  sessionId: string;
  runId: string;
  content: string;
}): void {
  streamEventBus.publish(params.sessionId, {
    type: 'error',
    content: redactNativeProviderText(params.content) || 'Agent error',
    terminal: true,
    runId: params.runId,
  });
  softClearHostStreamIfCurrent(params.sessionId, params.runId);
}

/* ─── REST Routes (kept as fallback) ───────────────────────────────────── */

router.get('/status', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const probe = await fetch(`${GATEWAY_URL}/`, { signal: AbortSignal.timeout(3000) });
    if (probe.ok) {
      res.json({ connected: true, ok: true, status: 'ok', message: 'Gateway is running' });
    } else {
      res.json({ connected: false, ok: false, status: 'error', message: `Gateway returned ${probe.status}` });
    }
  } catch (err: any) {
    res.json({ connected: false, ok: false, status: 'error', message: err.message || 'Gateway unreachable' });
  }
});

// Dashboard health check — includes connectivity + config validation.
// By default this keeps the dashboard cheap and schedules the expensive
// CLI/version probe in the background. Admin/status flows can pass
// ?forceVersion=1 to wait for the real installed-vs-running Gateway version
// check, which catches stale detached OpenClaw listeners after updates.
// Dashboard views opt into a short server-side cooldown: repeat
// opens within the window replay the last health snapshot instead of
// re-probing the gateway, models, and version state. Live consumers (admin
// status flows, restart polling) omit the flag and stay uncached; any forced
// version probe always runs live and refreshes the snapshot.
const DASHBOARD_HEALTH_COOLDOWN_MS = 5 * 60_000;
let dashboardHealthSnapshot: { payload: Record<string, unknown>; at: number } | null = null;

router.get('/health', authenticateToken, async (req: Request, res: Response) => {
  try {
    const forceVersionProbe = ['1', 'true', 'yes'].includes(String(req.query.forceVersion || req.query.force || '').toLowerCase());
    const allowCooldownReplay = !forceVersionProbe
      && ['1', 'true', 'yes'].includes(String(req.query.cooldown || '').toLowerCase());
    if (allowCooldownReplay && dashboardHealthSnapshot
      && Date.now() - dashboardHealthSnapshot.at < DASHBOARD_HEALTH_COOLDOWN_MS) {
      res.json({
        ...dashboardHealthSnapshot.payload,
        checkedAt: dashboardHealthSnapshot.at,
        cached: true,
      });
      return;
    }
    const wsConnected = isPersistentWsConnected();
    const probe = await fetch(`${GATEWAY_URL}/`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false);
    // Gateway is reachable if the HTTP probe passes OR the persistent WS is up
    const gatewayReachable = probe;
    // Chat-ready requires the authenticated persistent WS — HTTP probe alone is NOT sufficient
    // (the probe just hits the gateway's web UI, not the authenticated WS channel)
    const chatReady = wsConnected;
    // Overall "connected" = gateway process is reachable (for dashboard display)
    const connected = wsConnected || probe;

    // If connected, also check if models are configured
    let modelsConfigured = false;
    let modelCount = 0;
    const issues: string[] = [];
    const openclawVersion = await getOpenClawVersionStatus({
      force: forceVersionProbe,
      refreshReadiness: forceVersionProbe,
    }).catch((err: any) => ({
      installedVersion: null,
      installedPackageVersion: null,
      runningVersion: null,
      codexPluginVersion: null,
      codexPluginInstallSpec: null,
      latestVersion: null,
      updateChannel: null,
      testedCorePackageVersion: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
      testedRuntimeVersion: TESTED_OPENCLAW_RUNTIME_VERSION,
      testedCodexPluginVersion: OPENCLAW_CODEX_PLUGIN_VERSION,
      testedPairReady: false,
      testedPairReason: err?.message || 'Tested OpenClaw pair verification failed',
      mismatch: false,
      restartRecommended: false,
      reason: null,
      listenerPid: null,
      listenerStartedAt: null,
      installedPackageMtime: null,
      probeOk: false,
      probeError: err?.message || 'Version status check failed',
    }));

    if (openclawVersion.restartRecommended && openclawVersion.reason) {
      issues.push(openclawVersion.reason);
    }
    if (openclawVersion.testedPairReady === false && openclawVersion.testedPairReason) {
      issues.push(openclawVersion.testedPairReason);
    }

    if (connected) {
      try {
        const models = await listProviderModels('OPENCLAW');
        modelCount = models.length;
        modelsConfigured = modelCount > 0;
      } catch { /* model catalog may be temporarily unavailable — treat as unknown */ }

      if (!modelsConfigured) {
        issues.push('No AI models configured. Run "openclaw onboard" on the server to set up API keys.');
      }

      // Gateway is reachable but persistent WS is not authenticated — chat won't work
      if (!wsConnected) {
        issues.push('Gateway is reachable but the real-time connection failed. Agent chat may not work. Try restarting the portal service.');
        // Try to reconnect in background
        reconnectPersistentWs();
      }
    } else {
      if (!hasGatewayToken()) {
        issues.push('Gateway token not configured. Run "openclaw onboard" to set up, or re-run the installer.');
      } else {
        issues.push('Cannot reach OpenClaw gateway. Check that the openclaw-gateway service is running and the gateway token matches.');
        // Token exists but WS not connected — try to reconnect in background
        // This handles the case where `openclaw onboard` changed the token after portal started
        reconnectPersistentWs();
      }
    }

    const ok = chatReady
      && modelsConfigured
      && !openclawVersion.restartRecommended
      && openclawVersion.testedPairReady !== false;
    const payload = { ok, connected, wsConnected, chatReady, gatewayReachable, modelsConfigured, modelCount, issues, openclawVersion };
    const checkedAt = Date.now();
    dashboardHealthSnapshot = { payload, at: checkedAt };
    res.json({ ...payload, checkedAt, cached: false });
  } catch {
    res.json({ ok: false, connected: false, wsConnected: false, gatewayReachable: false, modelsConfigured: false, modelCount: 0, issues: ['Health check failed'], openclawVersion: null });
  }
});

// Restart the OpenClaw gateway process. Used when the installed package changed
// but the detached listener is still the older in-memory runtime.
router.post('/restart', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const before = await getOpenClawVersionStatus({ force: true }).catch(() => null);
    const restartOutput = await restartOpenClawGatewayBySystemService();
    const after = await waitForGatewayVersionClear(
      OPENCLAW_VERSION_STATUS_COLD_PROBE_BUDGET_MS,
    );

    reconnectPersistentWs();
    const ok = Boolean(after && !after.restartRecommended && after.probeOk);

    res.status(ok ? 200 : 500).json({
      ok,
      restarted: ok,
      message: ok
        ? 'OpenClaw gateway restarted.'
        : 'The installer-owned OpenClaw gateway service restarted but did not pass its version probe.',
      before,
      after,
      stdout: restartOutput.slice(-4000),
      stderr: '',
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, restarted: false, error: err?.message || 'OpenClaw gateway restart failed' });
  }
});

// Force reconnect the persistent WS to the OpenClaw gateway.
// Useful when the initial connection failed (timing race, token update, etc.)
router.post('/reconnect', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    if (isPersistentWsConnected()) {
      res.json({ ok: true, wasConnected: true, message: 'Already connected' });
      return;
    }
    reconnectPersistentWs();
    // Wait up to 8s for connection to establish
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (isPersistentWsConnected()) {
        res.json({ ok: true, wasConnected: false, message: 'Reconnected successfully' });
        return;
      }
    }
    res.json({ ok: false, wasConnected: false, message: 'Reconnect attempt timed out. Check gateway service and token.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/compatibility-hotfix', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const status = getOpenClawCompatibilityHotfixStatus();
    res.json({
      ok: true,
      ...status,
      note: status.applied
        ? 'Portal compatibility hotfixes are already present in the installed OpenClaw bundles.'
        : 'Installer/update usually auto-apply this temporary patch on affected installs. Use it as a fallback after a separate OpenClaw upgrade or if the compatibility markers are missing; it will restart the OpenClaw gateway.',
      confirmationPhrase: PRIVILEGED_CONFIRMATION.compatibilityHotfix,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to inspect compatibility hotfix status', detail: err.message });
  }
});

router.post('/compatibility-hotfix/apply', authenticateToken, requireOwner, async (req: Request, res: Response) => {
  try {
    if (!isTypedConfirmationMatch(PRIVILEGED_CONFIRMATION.compatibilityHotfix, req.body?.confirmation)) {
      res.status(400).json({
        error: `Type ${PRIVILEGED_CONFIRMATION.compatibilityHotfix} to confirm patching the installed runtime and restarting OpenClaw.`,
        confirmationPhrase: PRIVILEGED_CONFIRMATION.compatibilityHotfix,
      });
      return;
    }
    const before = getOpenClawCompatibilityHotfixStatus();
    if (!before.scriptExists) {
      res.status(500).json({ error: 'Portal hotfix script is missing from this install.' });
      return;
    }
    if (!before.supported) {
      res.status(500).json({ error: 'This OpenClaw install does not expose the runtime bundles expected by the compatibility hotfix.', status: before });
      return;
    }
    const beforeAskUserRuntime = await getOpenClawAskUserRuntimeReadiness();
    if (!beforeAskUserRuntime.ready) {
      res.status(500).json({
        error: 'The Portal ask-user bridge is not active in the running OpenClaw gateway; refusing to disable Claude native questions.',
        status: before,
        askUserRuntime: beforeAskUserRuntime,
      });
      return;
    }

    const openClawDistDir = getOpenClawDistDir();
    const patchRun = await execFileText('bash', [OPENCLAW_COMPAT_HOTFIX_SCRIPT, openClawDistDir], 30000, {
      PORTAL_OPENCLAW_HOTFIX_STRICT: '1',
      PORTAL_REQUIRED_OPENCLAW_PACKAGE_VERSION: TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
    });
    const restartOutput = await restartOpenClawGateway();
    const after = getOpenClawCompatibilityHotfixStatus();
    const afterAskUserRuntime = await getOpenClawAskUserRuntimeReadiness();
    const applied = after.applied && afterAskUserRuntime.ready;

    res.json({
      ok: applied,
      alreadyApplied: before.applied,
      status: after,
      askUserRuntime: afterAskUserRuntime,
      patchOutput: [patchRun.stdout, patchRun.stderr].filter(Boolean).join('\n'),
      restartOutput,
      message: applied
        ? 'Compatibility hotfix applied; OpenClaw restarted with the ask-user runtime bridge active.'
        : 'Hotfix command ran, but the patched runtime and callable ask-user bridge were not both verified afterward.',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to apply compatibility hotfix', detail: err.message });
  }
});

router.get('/providers', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.vary('Authorization');
    res.vary('Cookie');
    res.json({ providers: await AgentRegistry.listProvidersAsync() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list providers', detail: err.message });
  }
});

router.get('/models', authenticateToken, async (req: Request, res: Response) => {
  try {
    const providerName = normalizeProviderName(req.query.provider);
    const capabilities = getProviderCapabilities(providerName);
    if (!capabilities) {
      res.status(400).json({ error: `Unknown provider: ${providerName}` });
      return;
    }

    const models = await listProviderModels(providerName);
    // a model the catalog knows but cannot run was simply absent from
    // the picker, so an operator looking for gpt-5.6 saw no model and no
    // reason. Report the count so the UI can explain the gap.
    const unavailableModelIds = providerName === 'OPENCLAW'
      ? readLastOpenClawUnavailableModelIds()
      : [];
    res.json({
      provider: providerName,
      capabilities,
      models,
      ...(unavailableModelIds.length > 0 ? { unavailableModelIds } : {}),
    });
  } catch (err: any) {
    if (err instanceof UnknownAgentProviderError) {
      res.status(400).json({ error: err.message });
      return;
    }
    const providerName = String(req.query.provider || 'OPENCLAW').trim().toUpperCase();
    if (providerName === 'AGENT_ZERO') {
      const status = err instanceof AgentZeroOAuthModelCatalogError
        && err.code !== 'CATALOG_UNAVAILABLE'
        ? 409
        : 503;
      res.status(status).json({
        error: err instanceof AgentZeroOAuthModelCatalogError
          ? err.message
          : 'Agent Zero could not verify its selectable OAuth models. Retry, or reconnect Agent Zero OAuth in AI Settings.',
        ...(err?.code ? { code: err.code } : {}),
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to list models',
      detail: redactNativeProviderText(err?.message || String(err), 2_048),
    });
  }
});

router.get('/commands', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const providerName = normalizeProviderName(req.query.provider);
    const providerInfo = AgentRegistry.listProviders().find((p) => p.name === providerName);
    if (!providerInfo) {
      res.status(400).json({ error: `Unknown provider: ${providerName}` });
      return;
    }

    const commands = await getProviderCommandCatalog(providerName);
    res.json({
      provider: providerName,
      capabilities: providerInfo.capabilities,
      commands,
    });
  } catch (err: any) {
    if (err instanceof UnknownAgentProviderError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to list commands', detail: err.message });
  }
});

type AgentChatSessionActivitySummary = {
  sessionId: string;
  metadata?: Record<string, unknown>;
};

function annotateAgentChatSessionRunActivity<T extends AgentChatSessionActivitySummary>(
  sessions: readonly T[],
  isRunActive: (sessionId: string) => boolean = (sessionId) => (
    getProviderOwnedBusStreamSnapshot(sessionId).active === true
  ),
): Array<T & { runActive: boolean }> {
  return sessions.map((session) => {
    // Native Project Chat sessions can share a provider store with Agent Chat,
    // but their activity belongs to the durable Project coordination rail.
    // Never project a PROJECT_SANDBOX run into the host-operator session list.
    const belongsToAgentChat = session.metadata?.executionScope !== 'PROJECT_SANDBOX';
    return {
      ...session,
      runActive: belongsToAgentChat && Boolean(session.sessionId) && isRunActive(session.sessionId),
    };
  });
}

router.get('/sessions', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const providerName = req.query.provider === undefined
      ? undefined
      : normalizeProviderName(req.query.provider);
    if (providerName) {
      try {
        const provider = AgentRegistry.get(providerName);
        const sessions = await provider.listSessions(req.user!.userId);
        res.json({ sessions: annotateAgentChatSessionRunActivity(sessions) });
        return;
      } catch (err: any) {
        console.warn(`[gateway] Provider ${providerName} listSessions failed: ${err.message}`);
        res.status(502).json({
          error: `Failed to list ${providerName === 'AGENT_ZERO' ? 'Agent Zero' : 'provider'} sessions`,
          detail: providerName === 'AGENT_ZERO'
            ? 'Portal could not read Agent Zero session metadata. Retry, then repair the managed runtime if the problem continues.'
            : redactNativeProviderText(err?.message || String(err), 2_048),
        });
        return;
      }
    }

    // Support agentId filter — defaults to all agents for full visibility
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (agentId && !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      res.status(400).json({ error: 'Invalid OpenClaw agent' });
      return;
    }
    const openClawProvider = AgentRegistry.get('OPENCLAW');
    // The OWNER runs this host, so Agent Chat shows the sessions that already
    // exist on it — including ones OpenClaw itself created. Without this, any
    // chat started outside the Portal is invisible here forever, because only
    // Portal-created sessions ever get a claim row.
    // Scoped to the agent actually being viewed. Sweeping every agent would
    // pull in machine lanes such as `agent:api:*`, which are `direct` sessions
    // by kind but are OpenAI-compatible API traffic, not anyone's chat history.
    const includeHostSessions = isOwnerRole(req.user!.role);
    const hostAgentIds = includeHostSessions
      ? [agentId || DEFAULT_HOST_AGENT_ID]
      : [];
    const ownedSessions = await openClawProvider.listSessions(req.user!.userId, {
      includeHostSessions,
      hostAgentIds,
    });
    const sessions = agentId
      ? ownedSessions.filter((session) => String(session.sessionId || '').startsWith(`agent:${agentId}:`))
      : ownedSessions;
    res.json({ sessions: annotateAgentChatSessionRunActivity(sessions) });
    return;

  } catch (err: any) {
    const status = err instanceof UnknownAgentProviderError ? 400 : 500;
    res.status(status).json({
      error: status === 400 ? err.message : 'Failed to list sessions',
      ...(status === 500 ? { detail: err.message } : {}),
    });
  }
});

const USAGE_STATS_CACHE_TTL_MS = 15000;
const USAGE_STATS_CACHE_MAX_ENTRIES = 64;
const usageStatsCache = new Map<string, { at: number; payload: UsageStatsPayload }>();
const usageStatsInflight = new Map<string, Promise<UsageStatsPayload>>();

function cacheUsageStats(cacheKey: string, payload: UsageStatsPayload): void {
  usageStatsCache.delete(cacheKey);
  while (usageStatsCache.size >= USAGE_STATS_CACHE_MAX_ENTRIES) {
    const oldestKey = usageStatsCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    usageStatsCache.delete(oldestKey);
  }
  usageStatsCache.set(cacheKey, { at: Date.now(), payload });
}

async function getUsageStatsSnapshot(selectedAgent: string) {
  const cacheKey = selectedAgent || '__all__';
  const now = Date.now();
  const cached = usageStatsCache.get(cacheKey);
  if (cached && (now - cached.at) < USAGE_STATS_CACHE_TTL_MS) {
    usageStatsCache.delete(cacheKey);
    usageStatsCache.set(cacheKey, cached);
    return cached.payload;
  }
  if (cached) usageStatsCache.delete(cacheKey);

  const existing = usageStatsInflight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const { sessions, cronJobs } = await loadUsageStatsSources(selectedAgent, {
      agentsDir: path.join(process.env.HOME || '/root', '.openclaw/agents'),
      gatewayCall: gatewayRpcCall,
      runOpenClaw: async (args, timeoutMs) => (
        await execFileText('openclaw', args, timeoutMs)
      ).stdout,
    });

    const payload = buildUsageStatsPayload(
      sessions,
      cronJobs,
      selectedAgent,
      (model) => normalizeGatewayModelId(model) || 'unknown',
      Date.now(),
    );

    cacheUsageStats(cacheKey, payload);
    return payload;
  })();

  usageStatsInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    usageStatsInflight.delete(cacheKey);
  }
}

// GET /api/gateway/usage-stats — aggregates session and cron data for usage dashboard
router.get('/usage-stats', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const selectedAgent =
      (typeof req.query.agent === 'string' && req.query.agent.trim())
      || (typeof req.query.agentId === 'string' && req.query.agentId.trim())
      || '';

    if (selectedAgent && !isValidUsageAgentFilter(selectedAgent)) {
      res.status(400).json({ error: 'Invalid agent filter' });
      return;
    }

    res.json(await getUsageStatsSnapshot(selectedAgent));
  } catch (err: any) {
    console.error('[gateway] usage-stats error:', err);
    const statusCode = Number(err?.statusCode);
    res.status(Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500)
      .json({ error: err.message || 'Failed to get usage stats' });
  }
});

const TASKS_ROUTE_CACHE_TTL_MS = 10000;
let tasksRouteCache: { at: number; payload: any } | null = null;
let tasksRouteInflight: Promise<any> | null = null;

function normalizeGatewayTaskStatus(status: unknown, endedAt?: unknown): 'running' | 'done' | 'failed' | 'cancelled' | 'unknown' {
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  if (['done', 'completed', 'success', 'succeeded'].includes(normalized)) return 'done';
  if (['cancelled', 'canceled', 'killed', 'aborted'].includes(normalized)) return 'cancelled';
  if (['failed', 'error', 'errored'].includes(normalized)) return 'failed';
  if (['running', 'active', 'pending', 'queued', 'starting'].includes(normalized)) return 'running';
  if (endedAt) return 'done';
  return 'unknown';
}

function mapOpenClawLedgerTask(task: any) {
  const id = String(task?.taskId || task?.id || task?.runId || task?.sourceId || '').trim();
  if (!id) return null;
  const kind = String(task?.kind || task?.runtime || '').toLowerCase() || 'task';
  const status = normalizeGatewayTaskStatus(task?.status, task?.endedAt);

  return {
    id,
    name: summarizeTaskText(task?.title ?? task?.name ?? task?.label ?? task?.message ?? id, 120) || id,
    status,
    model: normalizeGatewayModelId(task?.model ?? task?.modelId ?? task?.modelProvider) || 'unknown',
    kind: kind.includes('cron') ? 'cron' : kind.includes('subagent') ? 'subagent' : kind,
    createdAt: task?.createdAt ?? task?.startedAt,
    updatedAt: task?.updatedAt ?? task?.endedAt ?? task?.startedAt,
    duration: task?.runtimeMs ?? (typeof task?.startedAt === 'number' && typeof task?.endedAt === 'number' ? task.endedAt - task.startedAt : undefined),
    summary: summarizeTaskText(task?.summary ?? task?.terminalSummary ?? task?.finalSummary ?? task?.result),
    prompt: summarizeTaskText(task?.prompt ?? task?.message ?? task?.title, 240),
    detail: summarizeTaskText(task?.detail ?? task?.terminalSummary ?? task?.error, 500),
    parentSession: task?.ownerKey ?? task?.parentSession ?? task?.sessionKey ?? null,
    error: status === 'failed' ? summarizeTaskText(task?.error ?? task?.terminalSummary ?? 'Task failed') : null,
  };
}

function collapseKeyForTaskSession(session: any) {
  const key = String(session?.key || session?.sessionKey || '');
  const cronRunMatch = key.match(/^(agent:[^:]+:cron:[^:]+):run:[^:]+$/);
  if (cronRunMatch) return cronRunMatch[1];
  return key;
}

function mapOpenClawTaskSession(session: any) {
  const status = normalizeGatewayTaskStatus(session.status, session.endedAt);
  return {
    id: collapseKeyForTaskSession(session) || session.key || session.sessionKey || session.id || 'unknown',
    name: session.displayName || session.origin?.label || session.key?.split(':').pop() || 'Task',
    status,
    model: normalizeGatewayModelId(session.model) || session.modelProvider || 'unknown',
    kind: String(session.kind || session.key || session.sessionKey || '').includes('cron') ? 'cron' : 'subagent',
    createdAt: session.startedAt,
    updatedAt: session.endedAt || session.updatedAt,
    duration: session.runtimeMs,
    summary: pickTaskSummaryCandidate(session),
    prompt: pickTaskPromptCandidate(session),
    detail: null,
    parentSession: session.origin?.from || null,
    error: status === 'failed' ? summarizeTaskText(session.error || 'Task failed') : null,
  };
}

async function fetchTasksSnapshot() {
  const [sessionsResult, ledgerResult] = await Promise.all([
    gatewayRpcCall('sessions.list', {}, 30000),
    gatewayRpcCall('tasks.list', { limit: 100 }, 15000).catch((err: any) => ({ ok: false, error: err?.message || String(err) })),
  ]);

  if (!sessionsResult.ok || !sessionsResult.data?.sessions) {
    throw new Error(sessionsResult.error || 'Gateway unavailable');
  }

  const sessions = Array.isArray(sessionsResult.data.sessions) ? sessionsResult.data.sessions : [];
  const taskSessions = sessions.filter((s: any) => {
    const key = s.key || s.sessionKey || '';
    const kind = String(s.kind || '').toLowerCase();
    return kind === 'subagent' || kind === 'cron' || key.includes(':subagent:') || key.includes(':cron:');
  });

  const collapsedTaskSessions = new Map<string, any>();
  for (const session of taskSessions) {
    const collapseKey = collapseKeyForTaskSession(session);
    const existing = collapsedTaskSessions.get(collapseKey);
    if (!existing) {
      collapsedTaskSessions.set(collapseKey, session);
      continue;
    }

    const existingStatus = String(existing?.status || '').toLowerCase();
    const sessionStatus = String(session?.status || '').toLowerCase();
    const existingRunning = !existing?.endedAt && existingStatus !== 'done' && existingStatus !== 'error';
    const sessionRunning = !session?.endedAt && sessionStatus !== 'done' && sessionStatus !== 'error';
    const existingTime = Number(existing?.endedAt || existing?.updatedAt || existing?.startedAt || 0);
    const sessionTime = Number(session?.endedAt || session?.updatedAt || session?.startedAt || 0);

    if ((!existingRunning && sessionRunning) || (existingRunning === sessionRunning && sessionTime >= existingTime)) {
      collapsedTaskSessions.set(collapseKey, session);
    }
  }

  const tasksById = new Map<string, any>();
  for (const task of Array.from(collapsedTaskSessions.values()).map(mapOpenClawTaskSession)) {
    tasksById.set(task.id, task);
  }

  if (ledgerResult.ok && Array.isArray((ledgerResult as any).data?.tasks)) {
    for (const task of (ledgerResult as any).data.tasks.map(mapOpenClawLedgerTask).filter(Boolean)) {
      tasksById.set(task.id, task);
    }
  }

  const tasks = Array.from(tasksById.values());

  tasks.sort((a: any, b: any) => {
    const aTime = Number(a.updatedAt || a.createdAt || 0);
    const bTime = Number(b.updatedAt || b.createdAt || 0);
    return bTime - aTime;
  });

  return {
    ok: true,
    tasks,
    fetchedAt: new Date().toISOString(),
    source: ledgerResult.ok ? 'tasks.list+sessions.list' : 'sessions.list',
    warning: ledgerResult.ok ? undefined : (ledgerResult as any).error || 'OpenClaw tasks.list unavailable; showing session-derived tasks only',
  };
}

// GET /api/gateway/tasks — Query OpenClaw gateway for task/subagent state
router.get('/tasks', requireAdmin, async (_req: Request, res: Response) => {
  const now = Date.now();
  if (tasksRouteCache && now - tasksRouteCache.at < TASKS_ROUTE_CACHE_TTL_MS) {
    res.json(tasksRouteCache.payload);
    return;
  }

  try {
    if (!tasksRouteInflight) {
      tasksRouteInflight = fetchTasksSnapshot().finally(() => {
        tasksRouteInflight = null;
      });
    }
    const payload = await tasksRouteInflight;
    tasksRouteCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err: any) {
    console.error('[gateway] tasks error:', err);
    if (tasksRouteCache) {
      res.json({ ...tasksRouteCache.payload, stale: true, warning: err.message || 'Tasks temporarily unavailable' });
      return;
    }
    res.json({ ok: false, tasks: [], stale: true, warning: err.message || 'Tasks temporarily unavailable' });
  }
});

router.get('/session-info', authenticateToken, async (req: Request, res: Response) => {
  try {
    const sessionKey = await resolveOpenClawSessionKey(req.query.session as string, req.user);
    await assertGatewaySessionAccess(sessionKey, req.user!);
    let result = await getSessionInfo(sessionKey);
    if ((!result.ok || !result.data) && sessionKey.includes(':new-')) {
      const created = await createSession(sessionKey);
      if (created.ok) {
        result = await getSessionInfo(created.key || sessionKey);
      }
    }
    if (!result.ok) {
      // Silent probes are used by UI components that can legitimately mount
      // before a just-created gateway session has durable metadata. Return a
      // non-error payload so Chrome does not report expected 404s as console
      // noise during normal Project Chat startup.
      const silentProbe = ['1', 'true', 'yes'].includes(String(req.query.silent || '').toLowerCase());
      if (silentProbe && !isGatewayTransportError(result.error)) {
        res.json({ session: null, missing: true, error: result.error || 'Session not found' });
        return;
      }
      // Distinguish gateway transport failures (timeout, WS error) from "session not found"
      const status = isGatewayTransportError(result.error) ? 502 : 404;
      res.status(status).json({ error: result.error || 'Session not found' });
      return;
    }
    res.json({ session: result.data });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Failed to get session info', detail: err.message });
  }
});

router.post('/session-create', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const providerName = normalizeProviderName(req.body?.provider);
    if (providerName !== 'OPENCLAW') {
      res.status(400).json({ error: 'Session creation only supported for OPENCLAW provider' });
      return;
    }

    const rawSession = typeof req.body?.session === 'string' ? req.body.session.trim() : '';
    if (!rawSession) {
      res.status(400).json({ error: 'session required' });
      return;
    }

    const sessionKey = await resolveOpenClawSessionKey(rawSession, req.user);
    await assertGatewaySessionAccess(sessionKey, req.user!, { providerName });

    const created = await createSession(sessionKey);
    if (!created.ok) {
      const status = isGatewayTransportError(created.error) ? 502 : 400;
      res.status(status).json({ error: created.error || 'Failed to create session' });
      return;
    }

    const createdKey = created.key || sessionKey;
    await ensurePortalAgentChatLabel(createdKey, req.user!).catch(() => undefined);
    const info = await withOpenClawSessionMutation(createdKey, async () => {
      let current = await getSessionInfo(createdKey);
      if (current.ok && current.data) {
        const currentThinking = String(current.data.thinkingLevel || '').trim().toLowerCase();
        const currentReasoning = String(current.data.reasoningLevel || '').trim().toLowerCase();
        const shouldDefaultThinking = !currentThinking;
        const shouldDefaultReasoning = !currentReasoning;
        if (shouldDefaultThinking || shouldDefaultReasoning) {
          await gatewayRpcCall('sessions.patch', {
            key: createdKey,
            ...(shouldDefaultThinking ? { thinkingLevel: 'high' } : {}),
            ...(shouldDefaultReasoning ? { reasoningLevel: 'stream' } : {}),
          });
          current = await getSessionInfo(createdKey);
        }
      }
      return current;
    });
    res.json({ ok: true, key: createdKey, session: info.ok ? info.data : null });
  } catch (err: any) {
    const status = err instanceof UnknownAgentProviderError
      ? 400
      : err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({
      error: status === 400
        ? err.message
        : status === 403 ? 'Admin access required' : 'Failed to create session',
      ...(status === 500 ? { detail: err.message } : {}),
    });
  }
});

router.post('/session-model', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const providerName = normalizeProviderName(req.body?.provider);
    const rawModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    const explicitResetRequested = req.body?.reset === true;
    const resetAliasRequested = isProviderModelResetAlias(rawModel);
    const resetRequested = explicitResetRequested || resetAliasRequested;
    if (explicitResetRequested && rawModel) {
      res.status(400).json({ error: 'Specify either a model or reset, not both.' });
      return;
    }
    if (providerName === 'AGENT_ZERO' && resetRequested) {
      res.status(409).json({
        error: 'Agent Zero requires an exact model from a connected OAuth provider. Choose one of its available models instead of Default or reset.',
        code: 'AGENT_ZERO_MODEL_REQUIRED',
      });
      return;
    }
    const model = resetRequested ? null : normalizeRequestedModel(providerName, rawModel);

    if (!resetRequested && !model) {
      res.status(400).json({ error: 'model required; use reset=true to clear a session override' });
      return;
    }

    if (providerName === 'OPENCLAW') {
      if (model && !model.includes('/')) {
        res.status(400).json({ error: 'model must include provider prefix' });
        return;
      }
      const rawSession = typeof req.body?.session === 'string' ? req.body.session.trim() : '';
      const sessionKey = await resolveOpenClawSessionKey(rawSession, req.user);
      await assertGatewaySessionAccess(sessionKey, req.user!, { providerName });
      const isConcreteSession = sessionKey.startsWith('agent:');
      if (!isConcreteSession) {
        res.status(409).json({ error: 'No concrete OpenClaw session selected', code: 'NO_CONCRETE_SESSION' });
        return;
      }

      let info = await getSessionInfo(sessionKey);
      if ((!info.ok || !info.data) && sessionKey.includes(':new-')) {
        const created = await createSession(sessionKey);
        if (created.ok) {
          info = await getSessionInfo(created.key || sessionKey);
        }
      }
      if (!info.ok || !info.data) {
        const status = isGatewayTransportError(info.error) ? 502 : 404;
        res.status(status).json({ error: info.error || 'Session not found' });
        return;
      }

      const resolvedModel = model ? await resolveOpenClawPatchModel(model) : null;
      const runtimeModel = model
        ? modelForOpenClawSessionPatch(info.data, resolvedModel || model)
        : null;
      const patched = await patchSessionModel(
        sessionKey,
        model ? runtimeModel || resolvedModel || model : null,
      );
      if (!patched.ok) {
        res.status(502).json({ error: patched.error || 'Failed to patch session model' });
        return;
      }

      const refreshed = await getSessionInfo(sessionKey);
      res.json({
        ok: true,
        session: refreshed.ok ? refreshed.data : info.data,
        resolved: patched.resolved || null,
        reset: resetRequested,
      });
      return;
    }

    if (!isElevatedRole(req.user!.role)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const rawSession = typeof req.body?.session === 'string' ? req.body.session.trim() : '';
    if (!rawSession || rawSession === 'main' || rawSession.startsWith('new-')) {
      res.status(409).json({ error: 'No concrete native session selected', code: 'NO_CONCRETE_SESSION' });
      return;
    }

    const nativeSession = loadNativeSession(providerName, rawSession);
    if (!nativeSession || nativeSession.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const selectedModel = providerName === 'AGENT_ZERO' && model
      ? (await validateAgentZeroOAuthModelSelection(model)).id
      : model;
    const result = await setNativeSessionModel(providerName, rawSession, selectedModel || null);
    res.json({
      ok: true,
      session: {
        sessionId: nativeSession.sessionId,
        model: result.model,
        modelProvider: providerName.toLowerCase(),
        metadata: result.metadata || nativeSession.metadata || {},
      },
      resolved: result.model
        ? { modelProvider: providerName.toLowerCase(), model: result.model }
        : null,
      reset: resetRequested,
    });
  } catch (err: any) {
    const rawProviderName = String(req.body?.provider || 'OPENCLAW').trim().toUpperCase();
    const status = err instanceof UnknownAgentProviderError
      ? 400
      : err instanceof NativeSessionModelMutationError
      ? err.status
      : err instanceof AgentZeroOAuthModelCatalogError
        ? err.code === 'CATALOG_UNAVAILABLE' ? 503 : 409
        : 500;
    const safeDetail = err instanceof NativeSessionModelMutationError
      || err instanceof AgentZeroOAuthModelCatalogError
      ? err.message
      : rawProviderName === 'AGENT_ZERO'
        ? humanizeProviderError('AGENT_ZERO', err?.message || String(err))
        : redactNativeProviderText(err?.message || String(err), 2_048);
    res.status(status).json({
      error: safeDetail || 'Failed to patch session model',
      ...(err?.code ? { code: err.code } : {}),
    });
  }
});

/**
 * Patch session settings (thinking level, fast mode, etc.)
 * Only works for OPENCLAW provider with concrete sessions.
 */
router.post('/session-patch', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const providerName = normalizeProviderName(req.body?.provider);
    const rawSession = typeof req.body?.session === 'string' ? req.body.session.trim() : '';
    const settings = typeof req.body?.settings === 'object' && req.body.settings !== null ? req.body.settings : {};

    if (!rawSession) {
      res.status(400).json({ error: 'Session required' });
      return;
    }

    // Only OPENCLAW supports session patching via gateway RPC
    if (providerName !== 'OPENCLAW') {
      res.status(400).json({ error: 'Session patching only supported for OPENCLAW provider' });
      return;
    }

    const sessionKey = await resolveOpenClawSessionKey(rawSession, req.user);
    await assertGatewaySessionAccess(sessionKey, req.user!, { providerName });

    const isConcreteSession = sessionKey.startsWith('agent:');
    if (!isConcreteSession) {
      res.status(409).json({ error: 'No concrete OpenClaw session selected', code: 'NO_CONCRETE_SESSION' });
      return;
    }

    const thinking = typeof settings.thinking === 'string' ? settings.thinking.trim().toLowerCase() : '';
    const reasoning = typeof settings.reasoning === 'string' ? settings.reasoning.trim().toLowerCase() : '';
    const model = typeof settings.model === 'string' ? settings.model.trim() : '';
    const rawFastMode = settings.fastMode;

    const patch: Record<string, any> = { key: sessionKey };

    if (thinking) {
      // Full OpenClaw 2026.7.1 ladder. Per-model support (e.g. ultra on
      // GPT-5.6 Sol/Terra, adaptive on Claude) is validated by the gateway
      // against the model's provider profile, which returns the valid options.
      const allowedThinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra']);
      if (!allowedThinking.has(thinking)) {
        res.status(400).json({ error: `Unsupported thinking level: ${thinking}` });
        return;
      }
      patch.thinkingLevel = thinking;
    }

    if (reasoning) {
      const allowedReasoning = new Set(['off', 'on', 'stream']);
      if (!allowedReasoning.has(reasoning)) {
        res.status(400).json({ error: `Unsupported reasoning visibility: ${reasoning}` });
        return;
      }
      patch.reasoningLevel = reasoning;
    }

    if (typeof rawFastMode === 'boolean' || rawFastMode === null) {
      patch.fastMode = rawFastMode;
    } else if (typeof rawFastMode === 'string') {
      const normalizedFastMode = rawFastMode.trim().toLowerCase();
      if (normalizedFastMode === 'on' || normalizedFastMode === 'true') {
        patch.fastMode = true;
      } else if (normalizedFastMode === 'off' || normalizedFastMode === 'false') {
        patch.fastMode = false;
      } else if (normalizedFastMode === 'inherit' || normalizedFastMode === 'default' || normalizedFastMode === 'auto' || normalizedFastMode === 'null') {
        patch.fastMode = null;
      } else if (normalizedFastMode) {
        res.status(400).json({ error: `Unsupported fast mode value: ${rawFastMode}` });
        return;
      }
    }

    if (model) {
      const resolvedModel = await resolveOpenClawPatchModel(model);
      let sessionInfoForPatch: any = null;
      try {
        const sessionInfo = await getSessionInfo(sessionKey);
        if (sessionInfo.ok) sessionInfoForPatch = sessionInfo.data;
      } catch {}
      patch.model = modelForOpenClawSessionPatch(sessionInfoForPatch, resolvedModel || model) || resolvedModel || model;
    }

    if (Object.keys(patch).length === 1) {
      res.json({ ok: true, session: null });
      return;
    }

    // OpenClaw validates thinkingLevel patches against the agent DEFAULT model
    // unless the patch carries a model. Sessions with their own model override
    // must validate against that override (e.g. ultra is valid on a GPT-5.6
    // session even when the default model is a Claude model), so attach the
    // session's recorded override when patching thinking without a model.
    if (patch.thinkingLevel && !patch.model) {
      try {
        const registryEntry = readLocalSessionRegistryEntry(sessionKey);
        const overrideModel = typeof registryEntry?.model === 'string' ? registryEntry.model.trim() : '';
        if (overrideModel) {
          const overrideProvider = typeof registryEntry?.modelProvider === 'string' ? registryEntry.modelProvider.trim() : '';
          const qualified = overrideModel.includes('/')
            ? overrideModel
            : (overrideProvider ? `${overrideProvider}/${overrideModel}` : '');
          if (qualified) patch.model = qualified;
        }
      } catch {}
    }

    const result = await withOpenClawSessionMutation(
      sessionKey,
      () => gatewayRpcCall('sessions.patch', patch),
    );
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to patch session' });
      return;
    }

    res.json({ ok: true, session: result.data || null });
  } catch (err: any) {
    console.error('[gateway] session-patch error:', err);
    const status = err instanceof UnknownAgentProviderError
      ? 400
      : err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({
      error: status === 400
        ? err.message
        : status === 403 ? 'Admin access required' : 'Failed to patch session',
      ...(status === 500 ? { detail: err.message } : {}),
    });
  }
});


router.get('/config-path', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    if (!isElevatedRole(req.user!.role)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const pathStr = typeof req.query?.path === 'string' ? req.query.path.trim() : '';
    if (!pathStr) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const cfgResult = await gatewayRpcCall('config.get', {});
    if (!cfgResult.ok) {
      res.status(502).json({ error: cfgResult.error || 'config.get failed' });
      return;
    }
    const config = cfgResult.data?.config || cfgResult.data?.parsed || {};
    res.json({ ok: true, path: pathStr, value: readConfigPath(config, pathStr) });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read config path', detail: err.message });
  }
});

router.post('/config-path', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    if (!isElevatedRole(req.user!.role)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const pathStr = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!pathStr) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const cfgResult = await gatewayRpcCall('config.get', {});
    if (!cfgResult.ok) {
      res.status(502).json({ error: cfgResult.error || 'config.get failed' });
      return;
    }
    const config = cfgResult.data?.config || cfgResult.data?.parsed || {};
    const updated = JSON.parse(JSON.stringify(config || {}));
    const nextValue = req.body?.value;
    if (nextValue === null || nextValue === undefined || nextValue === '') {
      deleteConfigPath(updated, pathStr);
    } else {
      writeConfigPath(updated, pathStr, nextValue);
    }
    const patchResult = await gatewayRpcCall('config.patch', {
      raw: JSON.stringify(updated),
      baseHash: cfgResult.data?.hash || '',
    }, 15000);
    if (!patchResult.ok) {
      res.status(502).json({ error: patchResult.error || 'config.patch failed' });
      return;
    }
    res.json({ ok: true, path: pathStr, value: readConfigPath(updated, pathStr) });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to patch config path', detail: err.message });
  }
});

interface ParsedPortalSlashCommand {
  command: string;
  raw: string;
  args: string[];
  rest: string;
}

function parsePortalSlashCommand(rawMessage: string): ParsedPortalSlashCommand | null {
  const raw = String(rawMessage || '').trim();
  if (!raw.startsWith('/')) return null;
  const match = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    command: `/${match[1].toLowerCase()}`,
    raw,
    args: match[2] ? match[2].trim().split(/\s+/).filter(Boolean) : [],
    rest: match[2] ? match[2].trim() : '',
  };
}

function nextNativePortalMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatCommandCatalogText(commands: Awaited<ReturnType<typeof getProviderCommandCatalog>>): string {
  if (!commands.length) return 'No slash commands are exposed for this provider in the portal.';
  const grouped = new Map<string, typeof commands>();
  for (const entry of commands) {
    const category = entry.category || 'General';
    grouped.set(category, [...(grouped.get(category) || []), entry]);
  }
  return Array.from(grouped.entries())
    .map(([category, items]) => [
      `${category}:`,
      ...items.map((item) => `- ${item.command}${item.argsHint ? ` ${item.argsHint}` : ''} — ${item.description}`),
    ].join('\n'))
    .join('\n\n');
}

function describeModelSelectionMode(mode?: string): string {
  if (mode === 'launch') return 'per chat (new session needed after changes)';
  if (mode === 'session') return 'live in the current session';
  return 'not supported';
}

function describeModelCatalog(capabilities: any, models: Array<{ id: string }> = []): string {
  if (capabilities?.canEnumerateModels || models.length > 0) {
    if (capabilities?.modelCatalogKind === 'declared') return `declared catalog${models.length ? ` (${models.length} shown in portal)` : ''}`;
    return `runtime catalog${models.length ? ` (${models.length} shown in portal)` : ''}`;
  }
  return capabilities?.supportsCustomModelInput === false
    ? 'no model picker exposed'
    : 'manual model entry only (/model <id>)';
}

function formatProviderCapabilitySummary(params: {
  providerInfo: ReturnType<typeof AgentRegistry.listProviders>[number] | undefined;
  providerDisplayName: string;
  commandCount: number;
  models?: Array<{ id: string }>;
  sessionId?: string;
  currentModel?: string | null;
}): string {
  const providerInfo = params.providerInfo;
  const capabilities = (providerInfo?.capabilities ?? {}) as Partial<ReturnType<typeof AgentRegistry.listProviders>[number]['capabilities']>;
  const lines = [
    `${params.providerDisplayName} portal capabilities`,
    params.sessionId ? `- session: ${params.sessionId}` : null,
    `- provider: ${providerInfo?.name || params.providerDisplayName}`,
    params.currentModel !== undefined ? `- model: ${params.currentModel || 'default'}` : null,
    `- slash commands: ${params.commandCount || 0} exposed`,
    `- model switching: ${capabilities.supportsModelSelection ? describeModelSelectionMode(capabilities.modelSelectionMode) : 'not supported'}`,
    `- model catalog: ${describeModelCatalog(capabilities, params.models || [])}`,
    `- custom model input: ${capabilities.supportsCustomModelInput === false ? 'no' : 'yes'}`,
    `- session history: ${capabilities.supportsHistory ? 'yes' : 'no'}`,
    `- session list: ${capabilities.supportsSessionList ? 'yes' : 'no'}`,
    `- exec approvals: ${capabilities.supportsExecApproval ? 'yes' : 'no'}`,
    `- execution scopes: ${capabilities.supportedExecutionScopes?.join(', ') || 'none'}`,
    `- follow-ups while running: ${capabilities.supportsInTurnSteering ? 'live FYI / steer' : capabilities.supportsQueuedFollowUps === false ? 'not supported' : 'queued for next turn'}`,
    `- transport: ${capabilities.requiresGateway ? 'gateway' : 'native CLI'}`,
    `- adapter: ${capabilities.adapterFamily || 'unknown'}${capabilities.adapterKey ? ` (${capabilities.adapterKey})` : ''}`,
    `- installed: ${providerInfo?.installed ? 'yes' : 'no'}`,
    `- version: ${providerInfo?.version || 'unknown'}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function formatCommandCatalogWithSummary(params: {
  providerInfo: ReturnType<typeof AgentRegistry.listProviders>[number] | undefined;
  providerDisplayName: string;
  commands: Awaited<ReturnType<typeof getProviderCommandCatalog>>;
  models?: Array<{ id: string }>;
  currentModel?: string | null;
  sessionId?: string;
}): string {
  const summary = formatProviderCapabilitySummary({
    providerInfo: params.providerInfo,
    providerDisplayName: params.providerDisplayName,
    commandCount: params.commands.length,
    models: params.models,
    currentModel: params.currentModel,
    sessionId: params.sessionId,
  });
  return `${summary}\n\n${formatCommandCatalogText(params.commands)}`;
}

async function handleNativePortalSlashCommand(params: {
  providerName: AgentProviderName;
  providerDisplayName: string;
  userId: string;
  userEmail: string;
  sessionId: string;
  requestedModel?: string;
  message: string;
  executionContext: AgentExecutionContext;
}): Promise<{ handled: boolean; sessionId: string; content?: string; metadata?: Record<string, unknown> }> {
  const parsed = parsePortalSlashCommand(params.message);
  if (!parsed) return { handled: false, sessionId: params.sessionId };

  const session = loadNativeSession(params.providerName, params.sessionId);
  if (!session) {
    return { handled: true, sessionId: params.sessionId, content: `Error: Session not found (${params.sessionId})` };
  }

  const appendExchange = (content: string, metadata?: Record<string, unknown>) => {
    appendNativeMessage(session, {
      id: nextNativePortalMessageId('user'),
      role: 'user',
      content: parsed.raw,
      timestamp: new Date().toISOString(),
    });
    appendNativeMessage(session, {
      id: nextNativePortalMessageId('assistant'),
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
    });
    return { handled: true, sessionId: session.sessionId, content, metadata };
  };

  switch (parsed.command) {
    case '/help':
    case '/commands': {
      const providerInfo = AgentRegistry.listProviders().find((entry) => entry.name === params.providerName);
      const [commands, models] = await Promise.all([
        getProviderCommandCatalog(params.providerName),
        listProviderModels(params.providerName),
      ]);
      return appendExchange(formatCommandCatalogWithSummary({
        providerInfo,
        providerDisplayName: params.providerDisplayName,
        commands,
        models,
        currentModel: session.model || null,
        sessionId: session.sessionId,
      }), { command: parsed.command, model: session.model || null, commandCount: commands.length });
    }
    case '/status': {
      const providerInfo = AgentRegistry.listProviders().find((entry) => entry.name === params.providerName);
      const [commands, models] = await Promise.all([
        getProviderCommandCatalog(params.providerName),
        listProviderModels(params.providerName),
      ]);
      return appendExchange(formatProviderCapabilitySummary({
        providerInfo,
        providerDisplayName: params.providerDisplayName,
        commandCount: commands.length,
        models,
        currentModel: session.model || null,
        sessionId: session.sessionId,
      }), { command: parsed.command, model: session.model || null, commandCount: commands.length });
    }
    case '/model': {
      if (!parsed.rest) {
        return appendExchange(`Current model: ${session.model || 'default'}`, { command: parsed.command, model: session.model || null });
      }
      const resetModel = isProviderModelResetAlias(parsed.rest);
      if (params.providerName === 'AGENT_ZERO' && resetModel) {
        return appendExchange(
          'Agent Zero requires an exact model from a connected OAuth provider. Choose one of the available Agent Zero models instead of Default or reset.',
          { command: parsed.command, model: session.model || null },
        );
      }
      const normalized = resetModel
        ? null
        : await validatedNativeModelSelection(params.providerName, parsed.rest);
      const updated = await setNativeSessionModel(
        params.providerName,
        session.sessionId,
        normalized,
      );
      return appendExchange(
        updated.model ? `Model set to ${updated.model}` : 'Session model reset to the provider default.',
        { command: parsed.command, model: updated.model },
      );
    }
    case '/models': {
      const targetProvider = (parsed.args[0] || params.providerName).trim().toUpperCase() as AgentProviderName;
      const providerInfo = AgentRegistry.listProviders().find((entry) => entry.name === targetProvider);
      if (!providerInfo) return appendExchange(`Unknown provider: ${targetProvider}`, { command: parsed.command });
      const models = await listProviderModels(targetProvider);
      const heading = `${providerInfo.displayName} models`;
      if (models.length > 0) {
        const lines = [heading, ...models.slice(0, 40).map((model) => `- ${model.id}${model.alias ? ` (${model.alias})` : ''}`)];
        return appendExchange(lines.join('\n'), { command: parsed.command, provider: targetProvider, count: models.length });
      }
      const fallback = providerInfo.capabilities.canEnumerateModels
        ? 'No models were returned from the current runtime.'
        : 'This provider does not expose a model catalog; enter a model id manually with /model <id>.';
      return appendExchange(`${heading}\n${fallback}`, { command: parsed.command, provider: targetProvider, count: 0 });
    }
    case '/new':
    case '/reset': {
      const nextModel = params.providerName === 'AGENT_ZERO'
        ? await validatedNativeModelSelection(
          params.providerName,
          params.requestedModel || session.model || '',
        )
        : params.requestedModel
          ? normalizeRequestedModel(params.providerName, params.requestedModel)
          : session.model;
      const newSessionId = await AgentRegistry.get(params.providerName).startSession(params.userId, {
        executionContext: params.executionContext,
        model: nextModel || undefined,
        metadata: { requestedBy: params.userEmail },
      });
      const content = `Started a new ${params.providerDisplayName} session.`;
      const newSession = loadNativeSession(params.providerName, newSessionId);
      if (newSession) {
        appendNativeMessage(newSession, {
          id: nextNativePortalMessageId('user'),
          role: 'user',
          content: parsed.raw,
          timestamp: new Date().toISOString(),
        });
        appendNativeMessage(newSession, {
          id: nextNativePortalMessageId('assistant'),
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        });
      }
      return { handled: true, sessionId: newSessionId, content, metadata: { command: parsed.command, reset: true } };
    }
    default:
      return { handled: false, sessionId: params.sessionId };
  }
}

router.get('/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const providerName = normalizeProviderName(req.query.provider);
    const sessionKey = providerName === 'OPENCLAW'
      ? await resolveOpenClawSessionKey(req.query.session as string, req.user)
      : String(req.query.session || '').trim();
    const limit = parseHistoryLimit(req.query.limit);
    const afterId = req.query.after as string;
    const beforeCursor = req.query.before;
    const enhanced = req.query.enhanced === '1';

    if (afterId && beforeCursor) {
      res.status(400).json({ error: 'History requests cannot combine after and before cursors' });
      return;
    }

    await assertGatewaySessionAccess(sessionKey, req.user!, { providerName });
    if (providerName === 'OPENCLAW') {
      if (isElevatedRole(req.user!.role)) {
        try {
          // History is the authenticated Agent Chat bootstrap/reconnect path,
          // including the optional direct transport. Registering here covers
          // pre-upgrade and resumed sessions before their next send.
          await attestAgentChatActivitySession(sessionKey, req.user!.userId, undefined, req.user!.role);
        } catch (error) {
          console.warn('[gateway] Agent activity history attestation could not be persisted:', error);
        }
      }
      subscribeBackendToLiveSessionEvents(sessionKey);
    }

    // For non-OPENCLAW providers use the provider abstraction
    if (providerName !== 'OPENCLAW') {
      try {
        const nativeSession = getOwnedNativeSession(
          providerName,
          req.user!.userId,
          req.query.session,
          undefined,
          { metadataOnly: true },
        );
        if (!nativeSession) {
          res.json({
            messages: [],
            sessionId: typeof req.query.session === 'string' ? req.query.session : '',
            activeStream: inactiveOpenClawSnapshot('idle', true),
            pagination: { beforeCursor: null, hasMoreBefore: false, pageSize: limit },
          });
          return;
        }
        const scope = historyCursorScope(req.user!.userId, providerName, nativeSession.sessionId);
        const activeStreamCandidate = await getProviderActiveStreamSnapshot(providerName, nativeSession.sessionId);
        const activeStream = resolveAttachableHostStreamSnapshot(
          nativeSession.sessionId,
          activeStreamCandidate,
        ) || activeStreamCandidate;
        if (!afterId && providerName !== 'AGENT_ZERO') {
          const page = readNativeHistoryPage({
            providerName,
            sessionId: nativeSession.sessionId,
            limit,
            scope,
            beforeCursor,
          });
          res.json({
            messages: page.messages,
            sessionId: nativeSession.sessionId,
            activeStream,
            pagination: {
              beforeCursor: page.beforeCursor,
              hasMoreBefore: page.hasMoreBefore,
              pageSize: limit,
            },
          });
          return;
        }

        if (!afterId && providerName === 'AGENT_ZERO') {
          const provider = AgentRegistry.get(providerName);
          const page = await readAgentZeroHistoryPage({
            provider,
            sessionId: nativeSession.sessionId,
            limit,
            scope,
            beforeCursor,
          });
          res.json({
            messages: page.messages,
            sessionId: nativeSession.sessionId,
            activeStream,
            pagination: {
              beforeCursor: page.beforeCursor,
              hasMoreBefore: page.hasMoreBefore,
              pageSize: limit,
            },
          });
          return;
        }

        // Forward-cursor reconnect remains a bounded provider projection. The
        // initial/older-page path above uses Agent Zero's stable sequence cursor.
        const provider = AgentRegistry.get(providerName);
        let messages = await provider.getHistory(nativeSession.sessionId);
        if (afterId) {
          const idx = messages.findIndex((message: any) => message.id === afterId);
          if (idx >= 0) messages = messages.slice(idx + 1);
          res.json({ messages: messages.slice(-limit), sessionId: nativeSession.sessionId, activeStream });
          return;
        }

        const anchor = beforeCursor ? decodeHistoryCursor(beforeCursor, scope) : undefined;
        const page = buildHistoryPage(messages, limit, scope, anchor, true);
        res.json({
          messages: page.messages,
          sessionId: nativeSession.sessionId,
          activeStream,
          pagination: {
            beforeCursor: page.beforeCursor,
            hasMoreBefore: page.hasMoreBefore,
            pageSize: limit,
          },
        });
        return;
      } catch (err: any) {
        console.warn(`[gateway] Provider ${providerName} getHistory failed: ${err.message}`);
        if (err instanceof HistoryCursorError) throw err;
        res.status(502).json({
          error: 'Failed to get provider history',
          detail: redactNativeProviderText(err?.message || String(err)) || 'Provider history failed',
        });
        return;
      }
    }

    // OPENCLAW (and default): resolve directly from JSONL, with Gemini CLI import fallback
    const sessionsDir = resolveSessionsDir(sessionKey);
    const fileId = resolveSessionFileId(sessionKey, sessionsDir);
    const sessionId = fileId || sessionKey;
    const scope = historyCursorScope(req.user!.userId, providerName, sessionKey);

    if (afterId) {
      let messages = enhanced
        ? readSessionMessagesEnhancedForSessionKey(sessionKey, limit, sessionsDir)
        : await readSessionMessages(sessionId, limit, sessionsDir);

      if (!fileId && messages.length === 0) {
        const activeStreamCandidate = await getOpenClawActiveStreamSnapshot(sessionKey);
        const activeStream = browserSafeActiveStreamSnapshot(
          providerName,
          resolveAttachableHostStreamSnapshot(sessionKey, activeStreamCandidate) || activeStreamCandidate,
        );
        res.json({ messages: [], sessionId, activeStream });
        return;
      }

      const idx = messages.findIndex((message: any) => message.id === afterId);
      if (idx >= 0) messages = messages.slice(idx + 1);
      const activeStreamCandidate = await getOpenClawActiveStreamSnapshot(sessionKey);
      const revalidatedActiveStream = resolveAttachableHostStreamSnapshot(sessionKey, activeStreamCandidate)
        || activeStreamCandidate;
      const activeStream = browserSafeActiveStreamSnapshot(providerName, revalidatedActiveStream);
      res.json({ messages, sessionId, activeStream });
      return;
    }

    const page = await readOpenClawHistoryPage({
      sessionKey,
      sessionId,
      sessionsDir,
      enhanced,
      limit,
      scope,
      beforeCursor,
    });

    if (!fileId && page.messages.length === 0) {
      const activeStreamCandidate = await getOpenClawActiveStreamSnapshot(sessionKey);
      const activeStream = browserSafeActiveStreamSnapshot(
        providerName,
        resolveAttachableHostStreamSnapshot(sessionKey, activeStreamCandidate) || activeStreamCandidate,
      );
      res.json({
        messages: [],
        sessionId,
        activeStream,
        pagination: { beforeCursor: null, hasMoreBefore: false, pageSize: limit },
      });
      return;
    }

    const activeStreamCandidate = await getOpenClawActiveStreamSnapshot(sessionKey);
    const activeStream = browserSafeActiveStreamSnapshot(
      providerName,
      resolveAttachableHostStreamSnapshot(sessionKey, activeStreamCandidate) || activeStreamCandidate,
    );

    res.json({
      messages: page.messages,
      sessionId,
      activeStream,
      pagination: {
        beforeCursor: page.beforeCursor,
        hasMoreBefore: page.hasMoreBefore,
        pageSize: limit,
      },
    });
  } catch (err: any) {
    const status = err?.message === 'Admin access required'
      ? 403
      : err instanceof UnknownAgentProviderError
        ? 400
      : err instanceof HistoryCursorError
        ? 400
        : 500;
    res.status(status).json({
      error: status === 403
        ? 'Admin access required'
        : status === 400
          ? err.message
          : 'Failed to get history',
      detail: status === 400
        ? err.message
        : (redactNativeProviderText(err?.message || String(err)) || 'History failed'),
    });
  }
});

// POST /api/gateway/send — SSE streaming (kept as fallback)
router.post('/send', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const { message, session = 'main', provider: providerName, model: requestedModel, agentId } = req.body;
  if (!message) { res.status(400).json({ error: 'message required' }); return; }

  let releaseAuthorizationLease: () => void;
  let authorizationLeaseReleaseSafe = true;
  try {
    // The response can close while a provider continues settling. Keep a
    // detached mutation lease so that disconnecting the browser cannot let an
    // old-generation host agent outlive a successful authorization change.
    releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
  } catch {
    res.status(409).json({
      error: 'Workspace authorization is changing. Reload the Portal before sending another message.',
      code: 'WORKSPACE_SCOPE_CHANGED',
    });
    return;
  }

  const wantStream = req.query.stream === '1' || req.headers.accept === 'text/event-stream';

  try {
    const routedProviderName = routeProviderForRequestedModel(providerName, requestedModel);
    // Authorize the host trust zone before provider lookup or any session write.
    // Project Chat sends through its project route and only uses this gateway
    // transport for its already-bound sandbox session history/reconnect lane.
    const executionContext = requireHostOperatorExecutionContext(req.user!);
    assertProviderExecutionContext(routedProviderName, executionContext);
    const provider = AgentRegistry.get(routedProviderName);
    const provenance = PROVENANCE[provider.providerName] || `via ${provider.displayName}`;
    const providerPublishesStream = providerPublishesHostStream(provider.providerName);

    const clientSession = typeof session === 'string' && session.trim().length > 0 ? session.trim() : '';
    let sessionId: string;
    if (provider.providerName === 'OPENCLAW') {
      sessionId = await resolveOpenClawTurnSessionKey(
        clientSession,
        agentId,
        req.user!,
      );
    } else {
      sessionId = await resolveNativeSessionForTurn({
        provider,
        userId: req.user!.userId,
        userEmail: req.user!.email,
        clientSession,
        executionContext,
        requestedModel,
      });
    }

    await assertGatewaySessionAccess(sessionId, req.user!, { providerName: provider.providerName });
    if (requestedModel && provider.providerName === 'OPENCLAW') {
      if (!String(requestedModel).includes('/')) {
        res.status(400).json({ error: 'model must include provider prefix' });
        return;
      }
      try {
        const resolvedModel = await resolveOpenClawPatchModel(requestedModel);
        let sessionInfoForPatch: any = null;
        try {
          const sessionInfo = await getSessionInfo(sessionId);
          if (sessionInfo.ok) sessionInfoForPatch = sessionInfo.data;
        } catch {}
        const runtimeModel = modelForOpenClawSessionPatch(sessionInfoForPatch, resolvedModel || requestedModel);
        await patchSessionModel(sessionId, runtimeModel || resolvedModel || requestedModel);
      } catch (err: any) {
        console.warn(`[gateway] Failed to patch session model: ${err.message}`);
      }
    }

    if (provider.providerName !== 'OPENCLAW') {
      const slashResult = await handleNativePortalSlashCommand({
        providerName: provider.providerName,
        providerDisplayName: provider.displayName,
        userId: req.user!.userId,
        userEmail: req.user!.email,
        sessionId,
        requestedModel: typeof requestedModel === 'string' ? requestedModel : undefined,
        message,
        executionContext,
      });
      if (slashResult.handled) {
        res.json({
          response: slashResult.content || '',
          model: normalizeGatewayModelId(slashResult.metadata?.model)
            || normalizeGatewayModelId(loadNativeSession(provider.providerName, slashResult.sessionId)?.model)
            || null,
          provider: provider.providerName,
          provenance,
          sessionId: slashResult.sessionId,
          metadata: slashResult.metadata || {},
        });
        return;
      }
    }

    if (wantStream) {
      res.socket?.setNoDelay?.(true);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'private, no-store, no-transform, max-age=0');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders();

      const sseWrite = (data: string) => {
        res.write(data);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      };
      sseWrite(`data: ${JSON.stringify({ type: 'session', sessionId, provenance, model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || null })}\n\n`);

      let sseAlive = true;
      let sseFinished = false;
      let gotRealStatus = false;
      let streamUnsub: (() => void) | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let unregisterSseDelivery = () => {};
      let unsubscribeAuthorization = () => {};
      const keepaliveTimer = setInterval(() => { if (sseAlive) try { sseWrite(': keepalive\n\n'); } catch { sseAlive = false; } }, 15000);
      const finishSse = () => {
        if (sseFinished) return;
        sseFinished = true;
        sseAlive = false;
        unsubscribeAuthorization();
        unsubscribeAuthorization = () => {};
        unregisterSseDelivery();
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        clearInterval(keepaliveTimer);
        if (streamUnsub) {
          streamUnsub();
          streamUnsub = null;
        }
        try { sseWrite('data: [DONE]\n\n'); } catch {}
        res.end();
      };
      req.on('close', () => {
        sseAlive = false;
        unsubscribeAuthorization();
        unsubscribeAuthorization = () => {};
        unregisterSseDelivery();
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        clearInterval(keepaliveTimer);
        if (streamUnsub) {
          streamUnsub();
          streamUnsub = null;
        }
      });

      if (req.user?.userId) {
        const cleanup = () => finishSse();
        unregisterSseDelivery = registerSseDelivery(
          req.user.userId,
          sessionId,
          req.body?.streamClientId,
          cleanup,
        );
      }

      fallbackTimer = setTimeout(() => {
        if (!gotRealStatus && sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'status', content: `${provider.displayName} is thinking…` })}\n\n`); } catch { sseAlive = false; }
      }, 2000);

      const routeRunId = randomUUID();
      unsubscribeAuthorization = subscribeToAuthorizationChanges(req.user!.userId, () => {
        void provider.abortActiveRun?.(sessionId, routeRunId).catch(() => false);
        finishSse();
      });
      const streamStartedAtMs = Date.now();
      const requestedStreamModel = normalizeGatewayModelId(
        typeof requestedModel === 'string' ? requestedModel : '',
      ) || undefined;
      const clientMessageId = normalizeDirectGatewayClientMessageId(req.body?.clientMessageId);
      const senderIdentity = req.user
        ? {
            label: req.user.email,
            userId: req.user.userId,
            role: req.user.role,
            authorizationVersion: Number(req.user.authorizationVersion ?? 1),
            requestId: routeRunId,
            ...(clientMessageId ? { clientMessageId } : {}),
          }
        : undefined;
      const recoverSseActiveTurnConflict = async () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        gotRealStatus = true;
        sseWrite(`data: ${JSON.stringify({
          type: 'active_turn_conflict',
          content: 'This chat already has an active turn. The Portal is reconnecting to it and queued your message.',
          sessionKey: sessionId,
          clientMessageId,
        })}\n\n`);

        let activeStream: OpenClawActiveStreamSnapshot;
        if (provider.providerName === 'OPENCLAW') {
          // A local active snapshot without an exact run ID is not safe to
          // attach: its dynamic matcher can bind to an unrelated future run
          // or wait forever. Every OpenClaw conflict crosses the authoritative
          // sessions.list fence before browser ownership transfers.
          activeStream = await reconcileOpenClawActiveTurnConflict(sessionId);
        } else {
          const candidate = await getProviderActiveStreamSnapshot(provider.providerName, sessionId);
          activeStream = (resolveAttachableHostStreamSnapshot(sessionId, candidate) || candidate) as OpenClawActiveStreamSnapshot;
        }

        if (streamUnsub) {
          streamUnsub();
          streamUnsub = null;
        }
        if (activeStream.active) {
          streamUnsub = attachSseToSessionStream({
            sessionKey: sessionId,
            providerName: provider.providerName,
            streamInfo: activeStream,
            user: req.user!,
            write: sseWrite,
            finish: finishSse,
          });
          if (streamUnsub) return;
        }
        if (activeStream.safeToClear) {
          sseWrite(`data: ${JSON.stringify({
            type: 'stream_ended',
            sessionKey: sessionId,
            inactiveReason: activeStream.inactiveReason,
            safeToClear: true,
          })}\n\n`);
          finishSse();
          return;
        }
        // Unknown/multiple upstream identities remain fail-closed. Keep this
        // delivery alive so the independently reconnecting Portal WS can take
        // it over instead of converting uncertainty into a fake terminal.
        sseWrite(`data: ${JSON.stringify({
          type: 'stream_status',
          sessionKey: sessionId,
          active: false,
          inactiveReason: activeStream.inactiveReason || 'unknown',
          safeToClear: false,
        })}\n\n`);
      };

      if (providerUsesHostStreamBus(provider.providerName)) {
        // Single-path SSE delivery for bus-owning providers. OpenClaw's
        // persistent gateway and host-native CLI providers both publish their
        // complete turn into StreamEventBus. The response forwards that bus
        // directly and leaves provider callbacks as no-ops.
        const routeReserved = provider.providerName === 'OPENCLAW'
          ? reserveDirectGatewayChatRun(sessionId, routeRunId)
          : reserveHostStreamRoute({
              sessionId,
              runId: routeRunId,
              provenance,
              model: requestedStreamModel,
            });
        if (!routeReserved) {
          await recoverSseActiveTurnConflict();
          return;
        }

        const runMatcher = createHostStreamRunMatcher(provider.providerName, routeRunId);
        let sawTerminalEvent = false;
        let pendingStreamError: string | null = null;
        const terminalUnsub = streamEventBus.subscribe(sessionId, (evt: StreamEvent) => {
          if (!runMatcher.matches(evt)) return;
          gotRealStatus = true;
          if (evt.type === 'done') {
            sawTerminalEvent = true;
            return;
          }
          if (evt.type !== 'error') return;
          const errorText = redactNativeProviderText(
            typeof evt.content === 'string' && evt.content.trim() ? evt.content.trim() : 'Agent error',
          ) || 'Agent error';
          if (provider.providerName === 'OPENCLAW' && (evt as any).terminal !== true) {
            pendingStreamError = errorText;
            return;
          }
          sawTerminalEvent = true;
        });
        const deniedApprovalIds = new Set<string>();
        streamUnsub = streamEventBus.subscribe(sessionId, (evt: StreamEvent) => {
          if (!runMatcher.matches(evt)) return;
          if (!sseAlive || sseFinished) return;
          gotRealStatus = true;
          const runtimeEvt = evt as any;
          if (runtimeEvt.type === 'exec_approval' && runtimeEvt.approval) {
            const approval = runtimeEvt.approval as ExecApprovalRequest;
            if (!isElevatedRole(req.user?.role)) {
              if (approval?.id && !deniedApprovalIds.has(approval.id)) {
                deniedApprovalIds.add(approval.id);
                void denyExecApprovalForUnauthorizedUser(approval, req.user);
              }
              try {
                sseWrite(`data: ${JSON.stringify({
                  type: 'status',
                  content: 'Command approval is only available to portal admins. This request was denied automatically.',
                })}\n\n`);
              } catch {
                sseAlive = false;
              }
              return;
            }
          }
          if (evt.type === 'error') {
            const errorText = redactNativeProviderText(
              typeof evt.content === 'string' && evt.content.trim() ? evt.content.trim() : 'Agent error',
            ) || 'Agent error';
            if (provider.providerName === 'OPENCLAW' && (evt as any).terminal !== true) {
              pendingStreamError = errorText;
              return;
            }
            sawTerminalEvent = true;
            try {
              sseWrite(`data: ${JSON.stringify(evt)}\n\n`);
            } catch {
              sseAlive = false;
            }
            finishSse();
            return;
          }
          try {
            sseWrite(`data: ${JSON.stringify(evt)}\n\n`);
          } catch {
            sseAlive = false;
            return;
          }
          if (evt.type === 'done') {
            sawTerminalEvent = true;
            finishSse();
          }
        });

        try {
          const result = await sendHostOperatorProviderMessage({
            provider,
            sessionId,
            message,
            onChunk: providerPublishesStream
              ? (_chunk: string) => {}
              : (chunk: string) => {
                  if (!chunk) return;
                  publishRouteOwnedHostStreamEvent({
                    sessionId,
                    runId: routeRunId,
                    provenance,
                    model: requestedStreamModel,
                    event: { type: 'text', content: chunk },
                  });
                },
            onStatus: providerPublishesStream
              ? (_evt: { type: string; content?: string; [key: string]: any }) => {}
              : (evt: { type: string; content?: string; [key: string]: any }) => {
                  publishRouteOwnedHostStreamEvent({
                    sessionId,
                    runId: routeRunId,
                    provenance,
                    model: requestedStreamModel,
                    event: evt,
                  });
                },
            onExecApproval: providerPublishesStream
              ? (_approval: ExecApprovalRequest) => {}
              : (approval: ExecApprovalRequest) => {
                  publishRouteOwnedHostStreamEvent({
                    sessionId,
                    runId: routeRunId,
                    provenance,
                    model: requestedStreamModel,
                    event: { type: 'exec_approval', approval },
                  });
                },
            sender: senderIdentity,
            onQuarantinePersistenceFailure: () => {
              authorizationLeaseReleaseSafe = false;
            },
          });
          if (!sawTerminalEvent) {
            publishRouteOwnedHostStreamDone({
              sessionId,
              runId: runMatcher.currentRunId(),
              provenance,
              result,
            });
          } else if (!providerPublishesStream) {
            softClearHostStreamIfCurrent(sessionId, routeRunId);
          }
        } catch (err: any) {
          if (sawTerminalEvent) {
            if (!providerPublishesStream) softClearHostStreamIfCurrent(sessionId, routeRunId);
            finishSse();
            return;
          }
          if (err instanceof AgentAbortError) {
            publishRouteOwnedHostStreamDone({
              sessionId,
              runId: runMatcher.currentRunId(),
              provenance,
              result: { fullText: '', metadata: {} },
              aborted: true,
            });
            return;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          if (provider.providerName === 'OPENCLAW' && /different run is already active/i.test(errMsg)) {
            await recoverSseActiveTurnConflict();
            return;
          }
          const friendlyError = humanizeProviderError(provider.providerName, err?.message || String(err));
          const shouldAttemptRecovery = shouldAttemptOpenClawReplyRecovery(
            provider.providerName,
            pendingStreamError,
            requestedModel,
          );
          if (shouldAttemptRecovery) {
            const recovered = await recoverRecentOpenClawAssistantReply(sessionId, streamStartedAtMs);
            if (recovered) {
              publishRouteOwnedHostStreamDone({
                sessionId,
                runId: runMatcher.currentRunId(),
                provenance,
                result: {
                  fullText: recovered.content,
                  metadata: { model: recovered.model, recoveredAfterError: true },
                },
              });
              return;
            }
          }
          const errorContent = redactNativeProviderText(pendingStreamError || friendlyError) || 'Agent error';
          publishRouteOwnedHostStreamError({
            sessionId,
            runId: runMatcher.currentRunId(),
            content: errorContent,
          });
        } finally {
          terminalUnsub();
        }
        return;
      }

      const onStatus = (evt: { type: string; content: string; [key: string]: any }) => {
        gotRealStatus = true;
        if (evt.type === 'exec_approval' && evt.approval) {
          const approval = evt.approval as ExecApprovalRequest;
          if (!isElevatedRole(req.user?.role)) {
            void denyExecApprovalForUnauthorizedUser(approval, req.user);
            if (sseAlive) {
              try {
                sseWrite(`data: ${JSON.stringify({
                  type: 'status',
                  content: 'Command approval is only available to portal admins. This request was denied automatically.',
                })}\n\n`);
              } catch { sseAlive = false; }
            }
            return;
          }
          if (sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'exec_approval', approval })}\n\n`); } catch { sseAlive = false; }
          return;
        }
        const runId = routeRunId;
        if (evt.type === 'tool_start') {
          if (!streamEventBus.startStream(sessionId, runId, {
            provenance,
            model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
          })) return;
          if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'tool', toolName: typeof evt.toolName === 'string' ? evt.toolName : undefined, runId })) return;
        } else if (evt.type === 'tool_update') {
          if (!streamEventBus.startStream(sessionId, runId, {
            provenance,
            model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
          })) return;
          if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'tool', toolName: typeof evt.toolName === 'string' ? evt.toolName : undefined, runId })) return;
        } else if (evt.type === 'tool_end') {
          if (!streamEventBus.startStream(sessionId, runId, {
            provenance,
            model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
          })) return;
          if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'thinking', runId })) return;
        } else if (evt.type === 'thinking' || evt.type === 'status') {
          if (!streamEventBus.startStream(sessionId, runId, {
            provenance,
            model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
          })) return;
          if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'thinking', runId })) return;
        } else if (evt.type === 'run_resumed') {
          if (!streamEventBus.startStream(sessionId, runId, {
            provenance,
            model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
          })) return;
        }
        streamEventBus.publish(sessionId, { ...evt, runId } as StreamEvent);
        if (sseAlive) try { sseWrite(`data: ${JSON.stringify(evt)}\n\n`); } catch { sseAlive = false; }
      };
      const onExecApproval = (approval: ExecApprovalRequest) => {
        if (!isElevatedRole(req.user?.role)) {
          void denyExecApprovalForUnauthorizedUser(approval, req.user);
          if (sseAlive) {
            try {
              sseWrite(`data: ${JSON.stringify({
                type: 'status',
                content: 'Command approval is only available to portal admins. This request was denied automatically.',
              })}\n\n`);
            } catch { sseAlive = false; }
          }
          return;
        }
        if (sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'exec_approval', approval })}\n\n`); } catch { sseAlive = false; }
      };
      if (!streamEventBus.startStream(sessionId, routeRunId, {
        provenance,
        model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
      })) {
        sseWrite(`data: ${JSON.stringify({ type: 'error', content: 'This chat already has an active turn.', runId: routeRunId })}\n\n`);
        finishSse();
        return;
      }

      try {
        const result = await (provider as any).sendMessage(
          sessionId,
          message,
          (chunk: string) => {
            if (!streamEventBus.startStream(sessionId, routeRunId, {
              provenance,
              model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
            })) return;
            if (!streamEventBus.updateStreamPhase(sessionId, { phase: 'streaming', runId: routeRunId })) return;
            streamEventBus.publish(sessionId, { type: 'text', content: chunk, runId: routeRunId } as StreamEvent);
            if (sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`); } catch { sseAlive = false; }
          },
          onStatus,
          onExecApproval,
          senderIdentity,
        );
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        clearInterval(keepaliveTimer);
        streamEventBus.publish(sessionId, {
          type: 'done',
          content: result.fullText,
          model: normalizeGatewayModelId(result.metadata?.model) || null,
          runId: routeRunId,
        } as StreamEvent);
        streamEventBus.softClearStream(sessionId, routeRunId);
        if (sseAlive) {
          sseWrite(`data: ${JSON.stringify({
            type: 'done',
            content: result.fullText,
            provenance,
            model: normalizeGatewayModelId(result.metadata?.model) || null,
            metadata: result.metadata || {},
          })}\n\n`);
        }
        finishSse();
      } catch (err: any) {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        clearInterval(keepaliveTimer);
        const friendlyError = redactNativeProviderText(
          humanizeProviderError(provider.providerName, err?.message || String(err)),
        ) || 'Agent error';
        streamEventBus.publish(sessionId, { type: 'error', content: friendlyError, terminal: true, runId: routeRunId } as StreamEvent);
        streamEventBus.clearStream(sessionId, routeRunId);
        if (sseAlive) {
          sseWrite(`data: ${JSON.stringify({ type: 'error', content: friendlyError })}\n\n`);
        }
        finishSse();
      }
      return;
    }

    // Non-streaming
    const nonStreamingRunId = randomUUID();
    const senderIdentity = req.user
      ? {
          label: req.user.email,
          userId: req.user.userId,
          role: req.user.role,
          authorizationVersion: Number(req.user.authorizationVersion ?? 1),
          requestId: nonStreamingRunId,
        }
      : undefined;
    const nonStreamingStartedAtMs = Date.now();
    const nonStreamingRunMatcher = createHostStreamRunMatcher(provider.providerName, nonStreamingRunId);
    let sawNonStreamingTerminal = false;
    let pendingNonStreamingError: string | null = null;
    let nonStreamingTerminalUnsub: (() => void) | null = null;
    if (providerUsesHostStreamBus(provider.providerName)) {
      if (!reserveHostStreamRoute({
        sessionId,
        runId: nonStreamingRunId,
        provenance,
        model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || undefined,
      })) {
        res.status(409).json({ error: 'This chat already has an active turn.' });
        return;
      }
      nonStreamingTerminalUnsub = streamEventBus.subscribe(sessionId, (event: StreamEvent) => {
        if (!nonStreamingRunMatcher.matches(event)) return;
        if (event.type === 'error' && provider.providerName === 'OPENCLAW' && (event as any).terminal !== true) {
          pendingNonStreamingError = redactNativeProviderText(
            typeof event.content === 'string' && event.content.trim() ? event.content.trim() : 'Agent error',
          ) || 'Agent error';
          return;
        }
        if (event.type === 'done' || event.type === 'error') {
          sawNonStreamingTerminal = true;
        }
      });
    }
    try {
      const result = await sendHostOperatorProviderMessage({
        provider,
        sessionId,
        message,
        onChunk: providerPublishesStream
          ? undefined
          : (chunk: string) => {
              if (!chunk) return;
              publishRouteOwnedHostStreamEvent({
                sessionId,
                runId: nonStreamingRunId,
                provenance,
                event: { type: 'text', content: chunk },
              });
            },
        onStatus: providerPublishesStream
          ? undefined
          : (event: { type?: string; content?: string; [key: string]: unknown }) => {
              publishRouteOwnedHostStreamEvent({
                sessionId,
                runId: nonStreamingRunId,
                provenance,
                event,
              });
            },
        onExecApproval: undefined,
        sender: senderIdentity,
        onQuarantinePersistenceFailure: () => {
          authorizationLeaseReleaseSafe = false;
        },
      });
      if (providerUsesHostStreamBus(provider.providerName) && !sawNonStreamingTerminal) {
        publishRouteOwnedHostStreamDone({
          sessionId,
          runId: nonStreamingRunMatcher.currentRunId(),
          provenance,
          result,
        });
      }
      const resolvedSessionId = typeof result?.metadata?.resolvedSessionId === 'string' && result.metadata.resolvedSessionId.trim()
        ? result.metadata.resolvedSessionId.trim()
        : sessionId;
      res.json({
        response: result.fullText,
        model: normalizeGatewayModelId(result.metadata?.model) || null,
        provider: provider.providerName,
        provenance,
        sessionId: resolvedSessionId,
      });
      return;
    } catch (sendErr: any) {
      const shouldAttemptRecovery = shouldAttemptOpenClawReplyRecovery(
        provider.providerName,
        pendingNonStreamingError,
        requestedModel,
      );
      if (shouldAttemptRecovery) {
        const recovered = await recoverRecentOpenClawAssistantReply(sessionId, nonStreamingStartedAtMs);
        if (recovered) {
          if (providerUsesHostStreamBus(provider.providerName) && !sawNonStreamingTerminal) {
            publishRouteOwnedHostStreamDone({
              sessionId,
              runId: nonStreamingRunMatcher.currentRunId(),
              provenance,
              result: {
                fullText: recovered.content,
                metadata: { model: recovered.model, recoveredAfterError: true },
              },
            });
          }
          res.json({
            response: recovered.content,
            model: recovered.model,
            provider: provider.providerName,
            provenance,
            sessionId,
            recoveredAfterError: true,
          });
          return;
        }
      }
      if (providerUsesHostStreamBus(provider.providerName) && !sawNonStreamingTerminal) {
        if (sendErr instanceof AgentAbortError) {
          publishRouteOwnedHostStreamDone({
            sessionId,
            runId: nonStreamingRunMatcher.currentRunId(),
            provenance,
            result: { fullText: '', metadata: {} },
            aborted: true,
          });
        } else {
          publishRouteOwnedHostStreamError({
            sessionId,
            runId: nonStreamingRunMatcher.currentRunId(),
            content: pendingNonStreamingError || sendErr?.message || String(sendErr),
          });
        }
      }
      throw sendErr;
    } finally {
      nonStreamingTerminalUnsub?.();
    }
  } catch (err: any) {
    const status = err instanceof UnknownAgentProviderError
      ? 400
      : err?.message === 'Admin access required'
        ? 403
        : err instanceof AgentZeroOAuthModelCatalogError
          ? err.code === 'CATALOG_UNAVAILABLE' ? 503 : 409
          : 503;
    const safeDetail = err instanceof AgentZeroOAuthModelCatalogError
      ? err.message
      : redactNativeProviderText(err?.message || String(err)) || 'Agent error';
    const friendlyError = err instanceof AgentZeroOAuthModelCatalogError
      ? err.message
      : status === 400
        ? err.message
        : status === 403
          ? 'Admin access required'
          : (redactNativeProviderText(
              humanizeProviderError(normalizeProviderName(req.body?.provider), err?.message || String(err)),
            ) || 'Agent error');
    res.status(status).json({
      error: friendlyError,
      detail: safeDetail,
      ...(err instanceof AgentZeroOAuthModelCatalogError ? { code: err.code } : {}),
    });
  } finally {
    settleWorkspaceAuthorizationRequest(req);
    if (authorizationLeaseReleaseSafe) {
      releaseAuthorizationLease();
    } else {
      console.error(
        '[gateway] Retaining the workspace authorization lease because an OpenClaw host-run ambiguity could not be quarantined',
      );
    }
  }
});

/* GET /api/gateway/agents — list OpenClaw sub-agents */
router.get('/agents', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const raw = await listOpenClawAgentsForSelector();

    // Fetch sub-agent avatars from DB
    const subAgentAvatarMap: Record<string, string> = {};
    try {
      const { prisma } = await import('../config/database');
      const rows = await prisma.systemSetting.findMany({
        where: { key: { startsWith: 'appearance.subAgentAvatar.' } },
      });
      for (const row of rows) {
        const agentId = row.key.replace('appearance.subAgentAvatar.', '');
        if (agentId && row.value) subAgentAvatarMap[agentId] = row.value;
      }
    } catch {}

    // Filter out hidden/confusing OpenClaw agents from the portal selector.
    const hiddenAgentIds = new Set(['portal', 'opus', 'codex', 'claude', 'desktop']);
    const agents = raw
      .filter((a: any) => {
        const id = String(a.id || a.name || '');
        if (!id) return false;
        if (id.startsWith('portal-')) return false;
        if (hiddenAgentIds.has(id)) return false;
        return true;
      })
      .map((a: any) => {
        // identity may be an object { emoji, name } or a string
        const identity = typeof a.identity === 'object' && a.identity
          ? a.identity.emoji || undefined
          : (a.identity || a.emoji || undefined);
        const id = a.id || a.name;
        return {
          id,
          name: a.name || undefined,
          identity,
          model: normalizeGatewayModelId(a.model ?? a.defaultModel ?? a.currentModel),
          workspace: a.workspace || undefined,
          avatarUrl: subAgentAvatarMap[id] || undefined,
        };
      });
    res.json({ agents });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list agents', detail: err.message });
  }
});

// GET /api/gateway/stream-status — check if a stream is active for a session
router.get('/stream-status', authenticateToken, async (req: Request, res: Response) => {
  const providerName = normalizeProviderName(req.query.provider);
  const sessionKey = providerName === 'OPENCLAW'
    ? await resolveOpenClawSessionKey(req.query.session as string, req.user)
    : String(req.query.session || '').trim();
  try {
    await assertGatewaySessionAccess(sessionKey, req.user!, { providerName });
  } catch (err: any) {
    res.status(403).json({ error: 'Admin access required', detail: err.message });
    return;
  }
  if (!sessionKey) {
    res.json({ active: false });
    return;
  }
  const streamStatusCandidate = await getProviderActiveStreamSnapshot(providerName, sessionKey);
  const streamStatus = resolveAttachableHostStreamSnapshot(sessionKey, streamStatusCandidate)
    || streamStatusCandidate;
  res.json(browserSafeActiveStreamSnapshot(providerName, streamStatus));
});

router.post('/chat/abort', authenticateToken, requireApproved, async (req: Request, res: Response): Promise<void> => {
  const { session, runId } = req.body;
  const providerName = normalizeProviderName(req.body?.provider);
  const sessionKey = providerName === 'OPENCLAW'
    ? await resolveOpenClawSessionKey(session, req.user)
    : String(session || '').trim();
  console.log(`[gateway] HTTP ABORT REQUEST: provider=${providerName} session=${sessionKey} runId=${runId || 'none'}`);
  try {
    await assertGatewaySessionAccess(sessionKey, req.user!, { providerName });

    if (providerName !== 'OPENCLAW') {
      const provider = AgentRegistry.get(providerName);
      const expectedRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
      const aborted = await provider.abortActiveRun?.(sessionKey, expectedRunId);
      res.json({ ok: aborted === true, sessionKey, provider: providerName, runId: expectedRunId || null });
      return;
    }

    const payload: Record<string, string> = { sessionKey };
    if (runId) payload.runId = runId;
    const abortRunIdentity = captureHostStreamRunIdentity(sessionKey, runId);
    const result = await gatewayRpcCall('chat.abort', payload);
    console.log(`[gateway] HTTP ABORT RESULT: ok=${result.ok} error=${result.error || 'none'}`);
    if (!result.ok) {
      res.status(500).json({
        error: 'Abort failed',
        detail: redactNativeProviderText(result.error || 'Abort was not confirmed') || 'Abort was not confirmed',
      });
      return;
    }
    // Stop has to fail closed. The gateway always answers a successful
    // chat.abort with a strict boolean `aborted` plus the `runIds` it actually
    // cancelled, so anything else — a missing payload, a truthy non-boolean, an
    // empty body — means we did not confirm a stop. Treating that as success is
    // what made the button clear the UI while the agent kept running.
    const abortedRunIds = Array.isArray(result.data?.runIds)
      ? result.data.runIds.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
      : [];
    const aborted = result.data?.aborted === true;
    if (!aborted) {
      console.warn(
        `[gateway] HTTP ABORT NOT CONFIRMED: session=${sessionKey} runId=${runId || 'none'} `
        + `payload=${JSON.stringify(result.data ?? null)}`,
      );
      res.json({
        ok: false,
        sessionKey,
        provider: providerName,
        runId: runId || null,
        runIds: abortedRunIds,
        detail: 'The gateway did not confirm that a run was aborted. It may have already finished, or the run is still active.',
      });
      return;
    }
    clearHostStreamIfCurrentRun(sessionKey, abortRunIdentity);
    res.json({ ok: true, sessionKey, provider: providerName, runId: runId || null, runIds: abortedRunIds });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({
      error: status === 403 ? 'Admin access required' : 'Failed to abort',
      detail: status === 403
        ? 'Admin access required'
        : (redactNativeProviderText(err?.message || String(err)) || 'Abort failed'),
    });
  }
});


router.post('/chat/inject', authenticateToken, requireApproved, async (req: Request, res: Response): Promise<void> => {
  const sessionKey = await resolveOpenClawSessionKey(req.body?.session, req.user);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!isElevatedRole(req.user!.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  if (!text) {
    res.status(400).json({ error: 'text required' });
    return;
  }
  try {
    await assertGatewaySessionAccess(sessionKey, req.user!);
    await injectChatMessage(sessionKey, text);
    res.json({ ok: true, sessionKey });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Failed to inject chat message', detail: err.message });
  }
});

function pendingUserInputRouteError(res: Response, error: unknown): void {
  if (error instanceof PendingUserInputAnswerError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof AskUserQuestionError) {
    if (error.code === 'ASK_USER_AUTHORIZATION_TRANSITION') {
      res.status(503).json({ error: error.message, code: error.code });
      return;
    }
    if (error.code === 'ASK_USER_RUN_IDENTITY_REQUIRED') {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    if (error.code === 'ASK_USER_RUN_AMBIGUOUS') {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    // Ownership mismatches are deliberately indistinguishable from stale
    // runs so one Portal user cannot probe another user's active run IDs.
    res.status(404).json({ error: 'That OpenClaw run is no longer waiting for input.' });
    return;
  }
  const message = String((error as any)?.message || error || '');
  if (message === 'Admin access required') {
    res.status(404).json({ error: 'That OpenClaw run is no longer waiting for input.' });
    return;
  }
  console.error('[gateway] pending-user-input answer failed:', error);
  res.status(500).json({ error: 'Failed to answer the OpenClaw prompt.' });
}

router.post('/answer-user-input', authenticateToken, requireApproved, async (req: Request, res: Response): Promise<void> => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!message || !runId || !requestId) {
    res.status(400).json({ error: 'message, runId, and requestId are required' });
    return;
  }
  try {
    const sessionKey = await resolveOpenClawSessionKey(req.body?.session, req.user);
    const ownership = await resolveAskUserQuestionRunOwner({
      sessionKey,
      runId,
      toolCallId: requestId,
    });
    const actorAuthorizationVersion = Number(req.user?.authorizationVersion ?? 1);
    if (
      ownership.surface !== 'agent-chat'
      || ownership.ownerUserId !== req.user?.userId
      || ownership.actorAuthorizationVersion !== actorAuthorizationVersion
    ) {
      res.status(404).json({ error: 'That OpenClaw run is no longer waiting for input.' });
      return;
    }
    await assertExistingGatewaySessionAccess(sessionKey, req.user!);
    const result = await answerPendingUserInput(sessionKey, runId, requestId, message);
    res.json({ ok: true, sessionKey, ...result });
  } catch (error) {
    pendingUserInputRouteError(res, error);
  }
});

router.post('/session-steer', authenticateToken, requireApproved, async (req: Request, res: Response): Promise<void> => {
  const sessionKey = await resolveOpenClawSessionKey(req.body?.session, req.user);
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : undefined;
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }
  try {
    await assertGatewaySessionAccess(sessionKey, req.user!);
    const result = await steerSessionMessage(sessionKey, message, requestId);
    res.json({ ok: true, sessionKey, ...result });
  } catch (error) {
    pendingUserInputRouteError(res, error);
  }
});

async function resolveAnyExecApproval(
  approvalId: string,
  decision: NativeCliApprovalDecision,
): Promise<{ ok: boolean; error?: string; notFound?: boolean }> {
  const nativeResult = resolveNativeCliApproval(approvalId, decision);
  if (nativeResult.ok) return nativeResult;

  // Native-prefixed ids live only in the in-process registry; a miss means
  // the approval expired, was resolved elsewhere, or the backend restarted.
  if (approvalId.startsWith('native-')) {
    return { ok: false, error: 'Approval no longer pending', notFound: true };
  }

  if (!isPersistentWsConnected()) {
    return { ok: false, error: 'OpenClaw gateway connection is down' };
  }

  const persistentResult = await sendApprovalDecision(approvalId, decision);
  if (persistentResult.ok) return persistentResult;
  console.warn(`[gateway] Persistent WS resolution failed: ${persistentResult.error}`);
  const message = String(persistentResult.error || 'Failed to resolve approval');
  return { ok: false, error: message, notFound: /not.?found|unknown|expired|no such/i.test(message) };
}

router.post('/exec-approval/resolve', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { approvalId, decision } = req.body;
  if (!approvalId || typeof approvalId !== 'string') { res.status(400).json({ error: 'Missing approvalId' }); return; }
  if (!decision || !['allow-once', 'deny', 'allow-always'].includes(decision)) { res.status(400).json({ error: 'Invalid decision' }); return; }
  try {
    const result = await resolveAnyExecApproval(approvalId, decision);
    if (!result.ok) {
      // 404 tells the client the approval is gone for good (safe to drop the
      // popup); 502 means delivery failed and a retry can still succeed.
      res.status(result.notFound ? 404 : 502).json({ error: result.error || 'Failed' });
      return;
    }
    res.json({ ok: true, approvalId, decision });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// GET /api/gateway/approvals/stream — SSE for exec approval events (kept as fallback)
router.get('/approvals/stream', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  res.socket?.setNoDelay?.(true);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'private, no-store, no-transform, max-age=0');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  let alive = true;
  let cleaned = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeAuthorization = () => {};
  let unsubReq = () => {};
  let unsubRes = () => {};
  let unsubNativeReq = () => {};
  let unsubNativeRes = () => {};
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    alive = false;
    unsubscribeAuthorization();
    unsubscribeAuthorization = () => {};
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    unsubReq();
    unsubReq = () => {};
    unsubRes();
    unsubRes = () => {};
    unsubNativeReq();
    unsubNativeReq = () => {};
    unsubNativeRes();
    unsubNativeRes = () => {};
  };
  const terminateStream = () => {
    cleanup();
    if (!res.destroyed) res.destroy();
  };
  const sseWrite = (data: string): boolean => {
    if (!alive) return false;
    try {
      res.write(data);
      if (typeof (res as any).flush === 'function') (res as any).flush();
      return true;
    } catch {
      terminateStream();
      return false;
    }
  };
  if (!sseWrite(`data: ${JSON.stringify({ type: 'connected', persistentWsConnected: isPersistentWsConnected() })}\n\n`)) {
    return;
  }
  // Replay any in-flight approval requests so a reconnecting / late SSE client still
  // renders the popup. The frontend upserts by id, so re-delivery is idempotent.
  for (const approval of await pendingApprovalsForUser(req.user!)) {
    if (!sseWrite(`data: ${JSON.stringify({ type: 'exec_approval_requested', approval })}\n\n`)) {
      return;
    }
  }
  keepaliveTimer = setInterval(() => {
    sseWrite(': keepalive\n\n');
  }, 15000);
  const deliverApprovalRequest = (approval: ExecApprovalRequest) => {
    void (async () => {
      let releaseAuthorizationLease: (() => void) | null = null;
      try {
        releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
        await assertGatewayActorIsCurrent(req.user!);
        await assertApprovalAccess(approval, req.user!);
        await assertGatewayActorIsCurrent(req.user!);
        sseWrite(`data: ${JSON.stringify({ type: 'exec_approval_requested', approval })}\n\n`);
      } catch {
        // Fenced, stale, or cross-user approvals are deliberately invisible.
      } finally {
        releaseAuthorizationLease?.();
      }
    })();
  };
  const deliverApprovalResolved = (resolved: ExecApprovalResolved) => {
    void (async () => {
      const sessionKey = approvalSessionKeys.get(resolved.id);
      if (!sessionKey) return;
      let releaseAuthorizationLease: (() => void) | null = null;
      try {
        releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
        await assertGatewayActorIsCurrent(req.user!);
        await assertAgentStreamSessionAccess(sessionKey, req.user!);
        await assertGatewayActorIsCurrent(req.user!);
        sseWrite(`data: ${JSON.stringify({ type: 'exec_approval_resolved', resolved })}\n\n`);
      } catch {
        // Fenced, stale, or cross-user resolutions are deliberately invisible.
      } finally {
        releaseAuthorizationLease?.();
      }
    })();
  };
  unsubReq = onApprovalRequest(deliverApprovalRequest);
  unsubRes = onApprovalResolved(deliverApprovalResolved);
  unsubNativeReq = onNativeCliApprovalRequest(deliverApprovalRequest);
  unsubNativeRes = onNativeCliApprovalResolved(deliverApprovalResolved);
  unsubscribeAuthorization = subscribeToAuthorizationChanges(req.user!.userId, () => {
    terminateStream();
  });
  req.on('close', cleanup);
});


/* ═══════════════════════════════════════════════════════════════════════════
 * BROWSER ↔ PORTAL PERSISTENT WEBSOCKET
 * ═══════════════════════════════════════════════════════════════════════════ */

// Track active portal WS clients for approval broadcasting
const portalWsClients: Set<WebSocket> = new Set();
const approvalSessionKeys = new Map<string, string>();

// Broadcast approval events to all portal WS clients
let approvalBroadcastInit = false;
function initApprovalWsBroadcast() {
  if (approvalBroadcastInit) return;
  approvalBroadcastInit = true;
  const broadcastApprovalRequest = (approval: ExecApprovalRequest) => {
    const msg = JSON.stringify({ type: 'exec_approval', approval });
    const sessionKey = approval?.request?.sessionKey;
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) return;
    approvalSessionKeys.set(approval.id, sessionKey.trim());
    for (const c of portalWsClients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const user = (c as any).__portalUser as JwtPayload | undefined;
      if (!user || !isElevatedRole(user.role)) continue;
      void (async () => {
        let releaseAuthorizationLease: (() => void) | null = null;
        try {
          releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(user.userId);
          const binding = (c as any).__portalAuthorizationBinding as
            | GatewayWebSocketAuthorizationBinding
            | undefined;
          await assertGatewayWebSocketActorIsCurrent(user, binding);
          await assertAgentStreamSessionAccess(sessionKey, user);
          await assertGatewayWebSocketActorIsCurrent(user, binding);
          if (c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch {}
          }
        } catch {
          // Fenced, stale, or cross-user approvals are deliberately invisible.
        } finally {
          releaseAuthorizationLease?.();
        }
      })();
    }
  };
  const broadcastApprovalResolved = (resolved: ExecApprovalResolved) => {
    const msg = JSON.stringify({ type: 'exec_approval_resolved', resolved });
    const sessionKey = approvalSessionKeys.get(resolved.id);
    if (!sessionKey) return;
    const cleanupTimer = setTimeout(() => {
      if (approvalSessionKeys.get(resolved.id) === sessionKey) {
        approvalSessionKeys.delete(resolved.id);
      }
    }, 60_000);
    cleanupTimer.unref?.();
    for (const c of portalWsClients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const user = (c as any).__portalUser as JwtPayload | undefined;
      if (!user || !isElevatedRole(user.role)) continue;
      void (async () => {
        let releaseAuthorizationLease: (() => void) | null = null;
        try {
          releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(user.userId);
          const binding = (c as any).__portalAuthorizationBinding as
            | GatewayWebSocketAuthorizationBinding
            | undefined;
          await assertGatewayWebSocketActorIsCurrent(user, binding);
          await assertAgentStreamSessionAccess(sessionKey, user);
          await assertGatewayWebSocketActorIsCurrent(user, binding);
          if (c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch {}
          }
        } catch {
          // Fenced, stale, or cross-user resolutions are deliberately invisible.
        } finally {
          releaseAuthorizationLease?.();
        }
      })();
    }
  };
  onApprovalRequest((approval: PersistentApprovalRequest) => broadcastApprovalRequest(approval));
  onNativeCliApprovalRequest((approval: ExecApprovalRequest) => broadcastApprovalRequest(approval));
  onApprovalResolved((resolved: ExecApprovalResolved) => broadcastApprovalResolved(resolved));
  onNativeCliApprovalResolved((resolved: ExecApprovalResolved) => broadcastApprovalResolved(resolved));
}

function wsSend(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(data)); } catch {}
}

interface GatewayWebSocketAuthorizationBinding {
  revoked: boolean;
}

async function assertGatewayActorIsCurrent(user: JwtPayload): Promise<void> {
  const current = await prisma.user.findUnique({
    where: { id: user.userId },
    select: {
      role: true,
      accountStatus: true,
      isActive: true,
      authorizationVersion: true,
    },
  } as any);
  if (!current
    || !canUseInteractivePortal(current.role, (current as any).accountStatus, current.isActive)
    || Number((current as any).authorizationVersion ?? 1) !== Number(user.authorizationVersion ?? 1)) {
    throw new Error('Authorization changed; reload the Portal');
  }
}

async function assertGatewayWebSocketActorIsCurrent(
  user: JwtPayload,
  binding: GatewayWebSocketAuthorizationBinding | undefined,
): Promise<void> {
  if (!binding || binding.revoked) {
    throw new Error('Authorization changed; reload the Portal');
  }
  await assertGatewayActorIsCurrent(user);
  if (binding.revoked) {
    throw new Error('Authorization changed; reload the Portal');
  }
}

/* ─── Active stream tracking (via StreamEventBus) ─────────────────────── */
// Stream status is now managed by StreamEventBus (populated by PersistentGatewayWs).
// The per-message WS in handleWsSend also updates it for consistency.

/* ─── WS message handlers ─────────────────────────────────────────────── */

// Per-WS stream cleanup: maps sessionKey → unsubscribe function.
// Used by handleWsAbort to tear down the stream when the user aborts.
const wsStreamCleanups = new WeakMap<WebSocket, Map<string, () => void>>();

function registerWsStreamCleanup(ws: WebSocket, sessionKey: string, unsub: () => void): void {
  let map = wsStreamCleanups.get(ws);
  if (!map) { map = new Map(); wsStreamCleanups.set(ws, map); }
  // If there's an existing subscription for this session, clean it up first
  const existing = map.get(sessionKey);
  if (existing) existing();
  map.set(sessionKey, unsub);
}

function runWsStreamCleanup(ws: WebSocket, sessionKey: string): void {
  const map = wsStreamCleanups.get(ws);
  if (!map) return;
  const unsub = map.get(sessionKey);
  if (unsub) { unsub(); map.delete(sessionKey); }
}

function wsHasSessionStreamSubscription(ws: WebSocket, sessionKey: string): boolean {
  return wsStreamCleanups.get(ws)?.has(sessionKey) === true;
}

function subscribeBackendToLiveSessionEvents(sessionKey: string): void {
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (!key) return;
  void subscribeGatewaySessionMessages(key).catch((err: any) => {
    debugLog(`[gateway-ws] live session-message subscribe failed for ${key}: ${err?.message || err}`);
  });
}

function resolveAttachableHostStreamSnapshot(
  sessionKey: string,
  candidate?: StreamInfo | OpenClawActiveStreamSnapshot | null,
): StreamInfo | OpenClawActiveStreamSnapshot | null {
  // Stream snapshots can require asynchronous gateway or disk probes. If the
  // in-memory lane changed before attachment, its current state is the only
  // safe authority. When memory is empty (for example after a Portal restart),
  // retain the externally reconstructed candidate.
  const tracked = streamEventBus.getTrackedStream(sessionKey);
  if (!tracked) return candidate ?? null;
  return getProviderOwnedBusStreamSnapshot(sessionKey);
}

function isPreliminaryOpenClawStreamError(
  providerName: AgentProviderName | undefined,
  event: StreamEvent,
): boolean {
  return providerName === 'OPENCLAW'
    && event.type === 'error'
    && (event as any).terminal !== true;
}

function attachBrowserWsToSessionStream(params: {
  ws: WebSocket;
  sessionKey: string;
  providerName?: AgentProviderName;
  streamInfo?: StreamInfo | OpenClawActiveStreamSnapshot | null;
  sendResume?: boolean;
  keepSubscriptionAfterDone?: boolean;
  acceptEvent?: (evt: StreamEvent) => boolean;
  onEvent?: (evt: StreamEvent) => void;
  shouldForwardEvent?: (evt: StreamEvent) => boolean;
}): boolean {
  const {
    ws,
    sessionKey,
    providerName,
    streamInfo,
    sendResume = false,
    keepSubscriptionAfterDone = true,
    acceptEvent,
    onEvent,
    shouldForwardEvent,
  } = params;

  const status = resolveAttachableHostStreamSnapshot(sessionKey, streamInfo);
  if (!status) return false;

  if (!status.active) {
    if (sendResume) wsSend(ws, { type: 'stream_ended', sessionKey });
    return false;
  }

  // Snapshot/history/reconnect attachments lock to the synchronously
  // revalidated run. Live-send attachments pass no streamInfo and retain their
  // dynamic matcher so OpenClaw can adopt its first upstream run ID.
  const revalidatedRunId = normalizeHostStreamRunId(status.runId);
  const snapshotRunMatcher = streamInfo && providerName && status.active && revalidatedRunId
    ? createHostStreamRunMatcher(providerName, revalidatedRunId, { openClawRunIdKnown: true })
    : null;

  let unsubscribed = false;
  const unsub = streamEventBus.subscribe(sessionKey, (evt: StreamEvent) => {
    if (snapshotRunMatcher?.matches(evt) === false) return;
    if (acceptEvent?.(evt) === false) return;
    onEvent?.(evt);
    if (isPreliminaryOpenClawStreamError(providerName, evt)) return;
    if (shouldForwardEvent?.(evt) === false) {
      return;
    }
    const activeStream = streamEventBus.getTrackedStream(sessionKey);
    const runId = typeof evt.runId === 'string' && evt.runId.trim()
      ? evt.runId.trim()
      : (typeof activeStream?.runId === 'string' && activeStream.runId.trim() ? activeStream.runId.trim() : undefined);
    wsSend(ws, { ...evt, sessionKey, ...(runId ? { runId } : {}) });
    if (evt.type === 'error') {
      // StreamEventBus notifies the session subscribers before its global
      // subscribers. Keep this socket registered through the rest of the
      // synchronous publish so the global fallback can see that direct
      // delivery already occurred instead of sending the terminal twice.
      queueMicrotask(() => runWsStreamCleanup(ws, sessionKey));
      return;
    }
    if (evt.type === 'done' && !keepSubscriptionAfterDone) {
      queueMicrotask(() => runWsStreamCleanup(ws, sessionKey));
    }
  });

  const onClose = () => runWsStreamCleanup(ws, sessionKey);
  const cleanup = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    ws.removeListener('close', onClose);
    unsub();
  };

  ws.once('close', onClose);
  registerWsStreamCleanup(ws, sessionKey, cleanup);

  // Register delivery before exposing the snapshot. A terminal event can be
  // published from the same turn as ws.send(), and subscribing afterward
  // would lose it and leave the browser permanently "streaming".
  if (sendResume) {
    const phase = status.phase || 'thinking';
    const snapshotContent = 'content' in status && typeof status.content === 'string'
      ? status.content
      : '';
    const snapshotLatestText = 'latestText' in status && typeof status.latestText === 'string'
      ? status.latestText
      : '';
    const latestText = snapshotContent || streamEventBus.getLatestText(sessionKey) || snapshotLatestText || '';
    const rawTurnEvents = 'turnEvents' in status && Array.isArray(status.turnEvents)
      ? status.turnEvents
      : streamEventBus.getRecentTurnEvents(sessionKey, 100);
    const turnEvents = rawTurnEvents.filter((event) => {
      if (event.terminal || event.type === 'turn_error' || event.type === 'assistant_final' || event.type === 'turn_done') {
        return false;
      }
      return !revalidatedRunId || !event.runId || event.runId === revalidatedRunId;
    });
    wsSend(ws, {
      type: 'stream_resume',
      sessionKey,
      phase,
      toolName: status.toolName || null,
      toolCalls: Array.isArray(status.toolCalls) ? status.toolCalls : [],
      statusText: status.statusText || null,
      provenance: status.provenance || null,
      model: status.model || null,
      compactionPhase: status.compactionPhase || 'idle',
      runId: status.runId || null,
      content: latestText || undefined,
      turnEvents,
    });
  }
  return true;
}

function attachSseToSessionStream(params: {
  sessionKey: string;
  providerName: AgentProviderName;
  streamInfo: StreamInfo | OpenClawActiveStreamSnapshot;
  user: JwtPayload;
  write: (data: string) => void;
  finish: () => void;
}): (() => void) | null {
  const { sessionKey, providerName, streamInfo, user, write, finish } = params;
  const status = resolveAttachableHostStreamSnapshot(sessionKey, streamInfo);
  if (!status?.active) return null;

  const revalidatedRunId = normalizeHostStreamRunId(status.runId);
  const runMatcher = revalidatedRunId
    ? createHostStreamRunMatcher(providerName, revalidatedRunId, { openClawRunIdKnown: true })
    : createHostStreamRunMatcher(providerName, '', { openClawRunIdKnown: false });
  let closed = false;
  const unsubscribe = streamEventBus.subscribe(sessionKey, (event: StreamEvent) => {
    if (closed || !runMatcher.matches(event)) return;
    if (isPreliminaryOpenClawStreamError(providerName, event)) return;
    const runtimeEvent = event as any;
    if (runtimeEvent.type === 'exec_approval' && runtimeEvent.approval && !isElevatedRole(user.role)) {
      void denyExecApprovalForUnauthorizedUser(runtimeEvent.approval as ExecApprovalRequest, user);
      try {
        write(`data: ${JSON.stringify({
          type: 'status',
          content: 'Command approval is only available to portal admins. This request was denied automatically.',
          sessionKey,
          runId: revalidatedRunId || undefined,
        })}\n\n`);
      } catch {
        finish();
      }
      return;
    }
    const eventRunId = normalizeHostStreamRunId(event.runId) || runMatcher.currentRunId();
    try {
      write(`data: ${JSON.stringify({
        ...event,
        sessionKey,
        ...(eventRunId ? { runId: eventRunId } : {}),
      })}\n\n`);
    } catch {
      finish();
      return;
    }
    if (event.type === 'done' || event.type === 'error') finish();
  });

  const phase = status.phase || 'thinking';
  const snapshotContent = 'content' in status && typeof status.content === 'string'
    ? status.content
    : '';
  const snapshotLatestText = 'latestText' in status && typeof status.latestText === 'string'
    ? status.latestText
    : '';
  const latestText = snapshotContent || streamEventBus.getLatestText(sessionKey) || snapshotLatestText || '';
  const rawTurnEvents = 'turnEvents' in status && Array.isArray(status.turnEvents)
    ? status.turnEvents
    : streamEventBus.getRecentTurnEvents(sessionKey, 100);
  const turnEvents = rawTurnEvents.filter((event) => {
    if (event.terminal || event.type === 'turn_error' || event.type === 'assistant_final' || event.type === 'turn_done') {
      return false;
    }
    return !revalidatedRunId || !event.runId || event.runId === revalidatedRunId;
  });
  try {
    write(`data: ${JSON.stringify({
      type: 'stream_resume',
      sessionKey,
      phase,
      toolName: status.toolName || null,
      toolCalls: Array.isArray(status.toolCalls) ? status.toolCalls : [],
      statusText: status.statusText || null,
      provenance: status.provenance || null,
      model: status.model || null,
      compactionPhase: status.compactionPhase || 'idle',
      runId: status.runId || null,
      content: latestText || undefined,
      turnEvents,
    })}\n\n`);
  } catch {
    closed = true;
    unsubscribe();
    finish();
    return null;
  }

  return () => {
    if (closed) return;
    closed = true;
    unsubscribe();
  };
}

async function handleWsHistory(ws: WebSocket, msg: any, user: JwtPayload) {
  const providerName = normalizeProviderName(msg.provider);
  const sessionKey = providerName === 'OPENCLAW'
    ? await resolveOpenClawSessionKey(msg.session, user)
    : String(msg.session || '').trim();
  const requestId = msg.requestId; // For client-side correlation

  try {
    const limit = parseHistoryLimit(msg.limit);
    await assertGatewaySessionAccess(sessionKey, user, { providerName });
    if (providerName === 'OPENCLAW') subscribeBackendToLiveSessionEvents(sessionKey);
    // Try provider abstraction for non-OpenClaw providers only.
    if (providerName !== 'OPENCLAW') {
      try {
        const nativeSession = getOwnedNativeSession(
          providerName,
          user.userId,
          msg.session,
          undefined,
          { metadataOnly: true },
        );
        if (!nativeSession) {
          wsSend(ws, {
            type: 'history',
            messages: [],
            sessionId: typeof msg.session === 'string' ? msg.session : '',
            activeStream: inactiveOpenClawSnapshot('idle', true),
            pagination: { beforeCursor: null, hasMoreBefore: false, pageSize: limit },
            requestId,
          });
          return;
        }
        const scope = historyCursorScope(user.userId, providerName, nativeSession.sessionId);
        let resolvedPage: HistoryPageResult;
        if (providerName === 'AGENT_ZERO') {
          const provider = AgentRegistry.get(providerName);
          resolvedPage = await readAgentZeroHistoryPage({
            provider,
            sessionId: nativeSession.sessionId,
            limit,
            scope,
            beforeCursor: msg.before,
          });
        } else {
          resolvedPage = readNativeHistoryPage({
            providerName,
            sessionId: nativeSession.sessionId,
            limit,
            scope,
            beforeCursor: msg.before,
          });
        }
        const activeStreamCandidate = await getProviderActiveStreamSnapshot(providerName, nativeSession.sessionId);
        const activeStream = resolveAttachableHostStreamSnapshot(
          nativeSession.sessionId,
          activeStreamCandidate,
        ) || activeStreamCandidate;
        wsSend(ws, {
          type: 'history',
          messages: resolvedPage.messages,
          sessionId: nativeSession.sessionId,
          activeStream,
          pagination: {
            beforeCursor: resolvedPage.beforeCursor,
            hasMoreBefore: resolvedPage.hasMoreBefore,
            pageSize: limit,
          },
          requestId,
        });
        if (activeStream.active && providerUsesHostStreamBus(providerName)) {
          attachBrowserWsToSessionStream({
            ws,
            sessionKey: nativeSession.sessionId,
            providerName,
            streamInfo: activeStream,
            sendResume: true,
            keepSubscriptionAfterDone: false,
          });
        }
        return;
      } catch (err: any) {
        if (err instanceof HistoryCursorError) throw err;
        throw new Error(`Provider history failed: ${err?.message || err}`);
      }
    }

    // JSONL-based enhanced history with Gemini CLI import fallback
    const sessionsDir = resolveSessionsDir(sessionKey);
    const fileId = resolveSessionFileId(sessionKey, sessionsDir);
    const sessionId = fileId || sessionKey;
    const scope = historyCursorScope(user.userId, providerName, sessionKey);
    const page = await readOpenClawHistoryPage({
      sessionKey,
      sessionId,
      sessionsDir,
      enhanced: true,
      limit,
      scope,
      beforeCursor: msg.before,
    });
    wsSend(ws, {
      type: 'history',
      messages: page.messages,
      sessionId,
      pagination: {
        beforeCursor: page.beforeCursor,
        hasMoreBefore: page.hasMoreBefore,
        pageSize: limit,
      },
      requestId,
    });

    // After sending history, check if there's an active stream on this session.
    // If so, send a stream_resume event and subscribe to StreamEventBus.
    const activeStreamCandidate = await getOpenClawActiveStreamSnapshot(sessionKey);
    const activeStream = browserSafeActiveStreamSnapshot(
      providerName,
      resolveAttachableHostStreamSnapshot(sessionKey, activeStreamCandidate) || activeStreamCandidate,
    );
    if (activeStream.active) {
      attachBrowserWsToSessionStream({
        ws,
        sessionKey,
        providerName,
        streamInfo: activeStream,
        sendResume: true,
        // Keep subscription alive after done so resumed runs continue forwarding.
        keepSubscriptionAfterDone: true,
      });
    }
  } catch (err: any) {
    const historyError = err?.message === 'Admin access required'
      ? 'Admin access required'
      : `History failed: ${redactNativeProviderText(err?.message || String(err)) || 'Provider history failed'}`;
    wsSend(ws, { type: 'error', content: historyError, requestId });
  }
}

async function handleWsSend(
  ws: WebSocket,
  msg: any,
  user: JwtPayload,
  onQuarantinePersistenceFailure?: () => void,
) {
  const { message, session = 'main', provider: providerName, model: requestedModel, agentId } = msg;
  if (!message) { wsSend(ws, { type: 'error', content: 'message required' }); return; }

  let streamKeepalive: ReturnType<typeof setInterval> | null = null;
  let reservedStream: { sessionId: string; runId: string } | null = null;
  let routedProviderName: AgentProviderName = 'OPENCLAW';
  let providerNameForError: AgentProviderName = 'OPENCLAW';

  try {
    routedProviderName = routeProviderForRequestedModel(providerName, requestedModel);
    providerNameForError = routedProviderName;
    // Reject unauthorized Agent Chat sends before provider lookup/session creation.
    const executionContext = requireHostOperatorExecutionContext(user);
    assertProviderExecutionContext(routedProviderName, executionContext);
    const provider = AgentRegistry.get(routedProviderName);
    providerNameForError = provider.providerName;
    const provenance = PROVENANCE[provider.providerName] || `via ${provider.displayName}`;
    const isOpenClawProvider = provider.providerName === 'OPENCLAW';
    const providerPublishesStream = providerPublishesHostStream(provider.providerName);

    const clientSession = typeof session === 'string' && session.trim().length > 0 ? session.trim() : '';
    let sessionId: string;
    if (isOpenClawProvider) {
      sessionId = await resolveOpenClawTurnSessionKey(
        clientSession,
        agentId,
        user,
      );
    } else {
      sessionId = await resolveNativeSessionForTurn({
        provider,
        userId: user.userId,
        userEmail: user.email,
        clientSession,
        executionContext,
        requestedModel,
      });
    }

    await assertGatewaySessionAccess(sessionId, user, { providerName: provider.providerName });
    if (isOpenClawProvider) {
      await ensurePortalAgentChatLabel(sessionId, user, message).catch(() => undefined);
    }

    if (requestedModel && isOpenClawProvider) {
      try {
        if (!requestedModel.includes('/')) {
          console.warn(`[gateway-ws] Rejecting bare model name without provider prefix: "${requestedModel}". Select a fully-qualified model ID.`);
          wsSend(ws, { type: 'error', content: `Invalid model "${requestedModel}": must include provider prefix (e.g. openai/gpt-5.6-sol). Please reselect your model.` });
          return;
        }
        const resolvedModel = await resolveOpenClawPatchModel(requestedModel);
        let sessionInfoForPatch: any = null;
        try {
          const sessionInfo = await getSessionInfo(sessionId);
          if (sessionInfo.ok) sessionInfoForPatch = sessionInfo.data;
        } catch {}
        const runtimeModel = modelForOpenClawSessionPatch(sessionInfoForPatch, resolvedModel || requestedModel);
        await patchSessionModel(sessionId, runtimeModel || resolvedModel || requestedModel);
      } catch (err: any) {
        console.warn(`[gateway-ws] Failed to patch model: ${err.message}`);
      }
    }

    if (!isOpenClawProvider) {
      const slashResult = await handleNativePortalSlashCommand({
        providerName: provider.providerName,
        providerDisplayName: provider.displayName,
        userId: user.userId,
        userEmail: user.email,
        sessionId,
        requestedModel: typeof requestedModel === 'string' ? requestedModel : undefined,
        message,
        executionContext,
      });
      if (slashResult.handled) {
        wsSend(ws, {
          type: 'session',
          sessionId: slashResult.sessionId,
          provenance,
          model: normalizeGatewayModelId(slashResult.metadata?.model)
            || normalizeGatewayModelId(loadNativeSession(provider.providerName, slashResult.sessionId)?.model)
            || null,
        });
        wsSend(ws, {
          type: 'done',
          content: slashResult.content || '',
          provenance,
          model: normalizeGatewayModelId(slashResult.metadata?.model)
            || normalizeGatewayModelId(loadNativeSession(provider.providerName, slashResult.sessionId)?.model)
            || null,
          metadata: slashResult.metadata || {},
        });
        return;
      }
    }

    wsSend(ws, {
      type: 'session',
      sessionId,
      provenance,
      model: normalizeGatewayModelId(typeof requestedModel === 'string' ? requestedModel : '') || null,
    });

    let gotRealStatus = false;
    const fallbackTimer = setTimeout(() => {
      if (!gotRealStatus) wsSend(ws, { type: 'status', content: `${provider.displayName} is thinking…` });
    }, 2000);

    streamKeepalive = setInterval(() => {
      wsSend(ws, { type: 'keepalive', ts: Date.now() });
    }, 10000);

    const routeRunId = randomUUID();
    const streamStartedAtMs = Date.now();
    const requestedStreamModel = normalizeGatewayModelId(
      typeof requestedModel === 'string' ? requestedModel : '',
    ) || undefined;

    if (providerUsesHostStreamBus(provider.providerName)) {
      if (isOpenClawProvider) subscribeBackendToLiveSessionEvents(sessionId);
      // ── Single-path streaming via StreamEventBus ──────────────────────
      // OpenClaw and host-native CLI providers publish the complete turn into
      // StreamEventBus and internally use it for reconnect/settlement state.
      //
      // We subscribe to that same bus to forward events to the browser. Provider
      // callbacks intentionally remain no-ops; using both paths duplicates
      // chunks, statuses, tools, and terminal events.
      //
      // The provider's sendMessage() returns when the bus publishes 'done' or 'error'.
      // Our subscription below also sees the same 'done'/'error' and cleans up.
      // Because both are subscribing to the SAME event, the order doesn't matter —
      // the 'done' event is emitted once from PersistentGatewayWs, and both
      // subscribers see it in the same publish() call.

      const routeReserved = isOpenClawProvider
        ? reserveDirectGatewayChatRun(sessionId, routeRunId)
        : reserveHostStreamRoute({
            sessionId,
            runId: routeRunId,
            provenance,
            model: requestedStreamModel,
          });
      if (!routeReserved) {
        clearTimeout(fallbackTimer);
        if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
        wsSend(ws, {
          type: 'active_turn_conflict',
          content: 'This chat already has an active turn. The Portal is reconnecting to it and queued your message.',
          sessionKey: sessionId,
          clientMessageId: typeof msg.clientMessageId === 'string' ? msg.clientMessageId : undefined,
        });
        const activeStreamCandidate = provider.providerName === 'OPENCLAW'
          ? await reconcileOpenClawActiveTurnConflict(sessionId)
          : await getProviderActiveStreamSnapshot(provider.providerName, sessionId);
        const activeStream: OpenClawActiveStreamSnapshot = provider.providerName === 'OPENCLAW'
          ? activeStreamCandidate
          : (resolveAttachableHostStreamSnapshot(sessionId, activeStreamCandidate) || activeStreamCandidate) as OpenClawActiveStreamSnapshot;
        if (activeStream.active) {
          attachBrowserWsToSessionStream({
            ws,
            sessionKey: sessionId,
            providerName: provider.providerName,
            streamInfo: activeStream,
            sendResume: true,
            keepSubscriptionAfterDone: isOpenClawProvider,
          });
        } else if (activeStream.safeToClear) {
          wsSend(ws, {
            type: 'stream_ended',
            sessionKey: sessionId,
            inactiveReason: activeStream.inactiveReason,
            safeToClear: true,
          });
        } else {
          wsSend(ws, {
            type: 'stream_status',
            sessionKey: sessionId,
            active: false,
            inactiveReason: activeStream.inactiveReason || 'unknown',
            safeToClear: false,
          });
        }
        return;
      }
      reservedStream = { sessionId, runId: routeRunId };

      // Subscribe to StreamEventBus for this session.
      // OpenClaw stays subscribed after 'done' because a yielded agent can
      // resume under a new runId. Native CLI turns are terminal at 'done' and
      // release this per-session subscription immediately.
      const runMatcher = createHostStreamRunMatcher(provider.providerName, routeRunId);
      const deniedApprovalIds = new Set<string>();
      let sawStreamTerminal = false;
      let pendingStreamError: string | null = null;
      const terminalUnsub = streamEventBus.subscribe(sessionId, (evt: StreamEvent) => {
        if (!runMatcher.matches(evt)) return;
        gotRealStatus = true;
        if (evt.type === 'run_resumed') return;
        if (evt.type === 'done') {
          sawStreamTerminal = true;
        } else if (evt.type === 'error') {
          const errorText = redactNativeProviderText(
            typeof evt.content === 'string' && evt.content.trim() ? evt.content.trim() : 'Agent error',
          ) || 'Agent error';
          if (provider.providerName === 'OPENCLAW' && (evt as any).terminal !== true) {
            pendingStreamError = errorText;
            return;
          }
          sawStreamTerminal = true;
        } else {
          return;
        }
        if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
      });
      attachBrowserWsToSessionStream({
        ws,
        sessionKey: sessionId,
        providerName: provider.providerName,
        keepSubscriptionAfterDone: isOpenClawProvider,
        acceptEvent: runMatcher.matches,
        onEvent: (evt: StreamEvent) => {
        gotRealStatus = true;
        const runtimeEvt = evt as any;
        if (runtimeEvt.type === 'exec_approval' && runtimeEvt.approval && !isElevatedRole(user.role)) {
          const approval = runtimeEvt.approval as ExecApprovalRequest;
          if (approval?.id && !deniedApprovalIds.has(approval.id)) {
            deniedApprovalIds.add(approval.id);
            void denyExecApprovalForUnauthorizedUser(approval, user);
          }
          wsSend(ws, {
            type: 'status',
            content: 'Command approval is only available to portal admins. This request was denied automatically.',
            sessionKey: sessionId,
          });
          return;
        }
        if (evt.type === 'done') {
          sawStreamTerminal = true;
          // Stop keepalive during idle gap, but do NOT unsub — agent may resume
          if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
        }
        if (evt.type === 'run_resumed') {
          // Agent resumed after sub-agent — restart keepalive
          if (!streamKeepalive) {
            streamKeepalive = setInterval(() => {
              wsSend(ws, { type: 'keepalive', ts: Date.now() });
            }, 10000);
          }
          debugLog(`[handleWsSend] run_resumed detected for ${sessionId} — keepalive restarted`);
        }
        if (evt.type === 'error' && !(provider.providerName === 'OPENCLAW' && (evt as any).terminal !== true)) {
          sawStreamTerminal = true;
          // Hard error — clean up fully
          if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
        }
        },
        shouldForwardEvent: (evt: StreamEvent) => {
          const runtimeEvt = evt as any;
          if (provider.providerName === 'OPENCLAW' && runtimeEvt.type === 'error' && runtimeEvt.terminal !== true) {
            return false;
          }
          return !(runtimeEvt.type === 'exec_approval' && !isElevatedRole(user.role));
        },
      });

      // Provider-owned streams already publish into the bus. Route-owned
      // providers (Agent Zero/Ollama) are mirrored here so reconnect and
      // replay use the same transport without double-sending to the browser.
      const onChunk = providerPublishesStream
        ? (_chunk: string) => {}
        : (chunk: string) => {
            if (!chunk) return;
            publishRouteOwnedHostStreamEvent({
              sessionId,
              runId: routeRunId,
              provenance,
              model: requestedStreamModel,
              event: { type: 'text', content: chunk },
            });
          };
      const onStatus = providerPublishesStream
        ? (_evt: { type: string; content?: string; [key: string]: any }) => {}
        : (evt: { type: string; content?: string; [key: string]: any }) => {
            publishRouteOwnedHostStreamEvent({
              sessionId,
              runId: routeRunId,
              provenance,
              model: requestedStreamModel,
              event: evt,
            });
          };
      const onExecApproval = providerPublishesStream
        ? (_approval: ExecApprovalRequest) => {}
        : (approval: ExecApprovalRequest) => {
            publishRouteOwnedHostStreamEvent({
              sessionId,
              runId: routeRunId,
              provenance,
              model: requestedStreamModel,
              event: { type: 'exec_approval', approval },
            });
          };
      const clientMessageId = normalizeDirectGatewayClientMessageId(msg.clientMessageId);
      const senderIdentity = {
        label: user.email,
        userId: user.userId,
        role: user.role,
        authorizationVersion: Number(user.authorizationVersion ?? 1),
        requestId: routeRunId,
        ...(clientMessageId ? { clientMessageId } : {}),
      };

      try {
        const result = await sendHostOperatorProviderMessage({
          provider,
          sessionId,
          message,
          onChunk,
          onStatus,
          onExecApproval,
          sender: senderIdentity,
          onQuarantinePersistenceFailure,
        });
        clearTimeout(fallbackTimer);
        if (!sawStreamTerminal) {
          publishRouteOwnedHostStreamDone({
            sessionId,
            runId: runMatcher.currentRunId(),
            provenance,
            result,
          });
        } else if (!providerPublishesStream) {
          softClearHostStreamIfCurrent(sessionId, routeRunId);
        }
      } catch (sendErr: unknown) {
        clearTimeout(fallbackTimer);
        if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
        // The bus already delivered the provider's sanitized terminal event.
        if (sawStreamTerminal) {
          if (!providerPublishesStream) softClearHostStreamIfCurrent(sessionId, routeRunId);
          runWsStreamCleanup(ws, sessionId);
          return;
        }
        if (sendErr instanceof AgentAbortError) {
          publishRouteOwnedHostStreamDone({
            sessionId,
            runId: runMatcher.currentRunId(),
            provenance,
            result: { fullText: '', metadata: {} },
            aborted: true,
          });
          return;
        }
        const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        if (provider.providerName === 'OPENCLAW' && /different run is already active/i.test(errMsg)) {
          wsSend(ws, {
            type: 'active_turn_conflict',
            content: 'This chat already has an active turn. The Portal is reconnecting to it and queued your message.',
            sessionKey: sessionId,
            clientMessageId: typeof msg.clientMessageId === 'string' ? msg.clientMessageId : undefined,
          });
          const activeStream = await reconcileOpenClawActiveTurnConflict(sessionId);
          if (activeStream.active) {
            attachBrowserWsToSessionStream({
              ws,
              sessionKey: sessionId,
              providerName: provider.providerName,
              streamInfo: activeStream,
              sendResume: true,
              keepSubscriptionAfterDone: true,
            });
          } else if (activeStream.safeToClear) {
            wsSend(ws, {
              type: 'stream_ended',
              sessionKey: sessionId,
              inactiveReason: activeStream.inactiveReason,
              safeToClear: true,
            });
          } else {
            wsSend(ws, {
              type: 'stream_status',
              sessionKey: sessionId,
              active: false,
              inactiveReason: activeStream.inactiveReason || 'unknown',
              safeToClear: false,
            });
          }
          return;
        }
        const shouldAttemptRecovery = shouldAttemptOpenClawReplyRecovery(
          provider.providerName,
          pendingStreamError,
          requestedModel,
        );
        if (shouldAttemptRecovery) {
          const recovered = await recoverRecentOpenClawAssistantReply(sessionId, streamStartedAtMs);
          if (recovered) {
            publishRouteOwnedHostStreamDone({
              sessionId,
              runId: runMatcher.currentRunId(),
              provenance,
              result: {
                fullText: recovered.content,
                metadata: { model: recovered.model, recoveredAfterError: true },
              },
            });
            return;
          }
        }
        publishRouteOwnedHostStreamError({
          sessionId,
          runId: runMatcher.currentRunId(),
          content: pendingStreamError || humanizeProviderError(provider.providerName, errMsg),
        });
      } finally {
        terminalUnsub();
      }
      return;
    }

    // ── Non-OpenClaw providers: direct callbacks ───────────────────────
    const onChunk = (chunk: string) => {
      if (chunk) wsSend(ws, { type: 'text', content: chunk });
    };
    const onStatus = (evt: { type: string; content?: string; [key: string]: any }) => {
      gotRealStatus = true;
      if (evt?.type === 'exec_approval' && evt.approval) {
        if (!isElevatedRole(user.role)) {
          void denyExecApprovalForUnauthorizedUser(evt.approval as ExecApprovalRequest, user);
          wsSend(ws, {
            type: 'status',
            content: 'Command approval is only available to portal admins. This request was denied automatically.',
            sessionKey: sessionId,
          });
          return;
        }
        wsSend(ws, { type: 'exec_approval', approval: evt.approval });
        return;
      }
      const eventType = evt?.type || 'status';
      wsSend(ws, { ...evt, type: eventType });
    };
    const onExecApproval = (approval: any) => {
      if (!isElevatedRole(user.role)) {
        void denyExecApprovalForUnauthorizedUser(approval as ExecApprovalRequest, user);
        wsSend(ws, {
          type: 'status',
          content: 'Command approval is only available to portal admins. This request was denied automatically.',
          sessionKey: sessionId,
        });
        return;
      }
      wsSend(ws, { type: 'exec_approval', approval });
    };

    try {
      const result = await (provider as any).sendMessage(
        sessionId,
        message,
        onChunk,
        onStatus,
        onExecApproval,
        {
          label: user.email,
          userId: user.userId,
          role: user.role,
          authorizationVersion: Number(user.authorizationVersion ?? 1),
        },
      );
      clearTimeout(fallbackTimer);
      if (streamKeepalive) clearInterval(streamKeepalive);
      wsSend(ws, { type: 'done', content: result.fullText, provenance, metadata: result.metadata });
    } catch (sendErr: unknown) {
      clearTimeout(fallbackTimer);
      throw sendErr;
    }
  } catch (err: unknown) {
    if (streamKeepalive) clearInterval(streamKeepalive);
    if (reservedStream) {
      const tracked = streamEventBus.getTrackedStream(reservedStream.sessionId);
      if (tracked?.active && tracked.runId === reservedStream.runId) {
        streamEventBus.clearStream(reservedStream.sessionId, reservedStream.runId);
      }
    }
    if (err instanceof AgentAbortError) {
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    wsSend(ws, {
      type: 'error',
      content: err instanceof UnknownAgentProviderError
        ? err.message
        : redactNativeProviderText(humanizeProviderError(providerNameForError, errMsg)) || 'Agent error',
      ...(err instanceof AgentZeroOAuthModelCatalogError ? { code: err.code } : {}),
    });
  }
}

async function handleWsAbort(ws: WebSocket, msg: any, user?: JwtPayload) {
  const providerName = normalizeProviderName(msg.provider);
  const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() ? msg.requestId.trim() : null;
  const sessionKey = providerName === 'OPENCLAW'
    ? await resolveOpenClawSessionKey(msg.session, user)
    : String(msg.session || '').trim();
  console.log(`[gateway] ABORT REQUEST: provider=${providerName} session=${sessionKey} runId=${msg.runId || 'none'}`);
  try {
    if (user) await assertGatewaySessionAccess(sessionKey, user, { providerName });

    if (providerName !== 'OPENCLAW') {
      const provider = AgentRegistry.get(providerName);
      const expectedRunId = typeof msg.runId === 'string' && msg.runId.trim() ? msg.runId.trim() : undefined;
      const aborted = await provider.abortActiveRun?.(sessionKey, expectedRunId);
      wsSend(ws, {
        type: 'abort_result',
        ok: aborted === true,
        sessionKey,
        provider: providerName,
        runId: expectedRunId || null,
        requestId,
      });
      return;
    }

    const payload: Record<string, string> = { sessionKey };
    if (msg.runId) payload.runId = msg.runId;
    const abortRunIdentity = captureHostStreamRunIdentity(sessionKey, msg.runId);
    const result = await gatewayRpcCall('chat.abort', payload);
    console.log(`[gateway] ABORT RESULT: ok=${result.ok} error=${result.error || 'none'}`);
    const aborted = result.ok && result.data?.aborted !== false;

    // Tear down the stream subscription for this WS + session.
    // Without this, the subscription stays alive (for sub-agent resume),
    // and any subsequent gateway events for this session (heartbeat, system
    // event, etc.) would re-trigger the frontend into streaming state.
    if (aborted) {
      const clearedAbortedRun = clearHostStreamIfCurrentRun(sessionKey, abortRunIdentity);
      if (clearedAbortedRun) runWsStreamCleanup(ws, sessionKey);
    }

    wsSend(ws, {
      type: 'abort_result',
      ok: aborted,
      sessionKey,
      provider: providerName,
      runId: typeof msg.runId === 'string' && msg.runId.trim() ? msg.runId.trim() : null,
      requestId,
      error: aborted
        ? undefined
        : (redactNativeProviderText(result.error || 'Abort was not confirmed') || 'Abort was not confirmed'),
    });
  } catch (err: any) {
    wsSend(ws, {
      type: 'abort_result',
      ok: false,
      sessionKey,
      provider: providerName,
      runId: typeof msg.runId === 'string' && msg.runId.trim() ? msg.runId.trim() : null,
      requestId,
      error: redactNativeProviderText(err.message) || 'Abort failed',
    });
  }
}


async function handleWsInject(ws: WebSocket, msg: any, user?: JwtPayload) {
  const sessionKey = await resolveOpenClawSessionKey(msg.session, user);
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!user || !isElevatedRole(user.role)) {
    wsSend(ws, { type: 'inject_result', ok: false, error: 'Admin access required' });
    return;
  }
  if (!text) {
    wsSend(ws, { type: 'inject_result', ok: false, error: 'text required' });
    return;
  }
  try {
    await assertGatewaySessionAccess(sessionKey, user);
    await injectChatMessage(sessionKey, text);
    wsSend(ws, { type: 'inject_result', ok: true, sessionKey });
  } catch (err: any) {
    wsSend(ws, { type: 'inject_result', ok: false, error: err.message });
  }
}

async function handleWsExecApproval(ws: WebSocket, msg: any, user?: JwtPayload) {
  if (!user || !isElevatedRole(user.role)) {
    wsSend(ws, { type: 'approval_result', ok: false, error: 'Admin access required' });
    return;
  }

  const { approvalId, decision } = msg;
  if (!approvalId || !['allow-once', 'deny', 'allow-always'].includes(decision)) {
    wsSend(ws, { type: 'approval_result', ok: false, error: 'Invalid params' });
    return;
  }
  try {
    const result = await resolveAnyExecApproval(approvalId, decision);
    wsSend(ws, { type: 'approval_result', ok: result.ok, approvalId, decision, error: result.ok ? undefined : result.error });
  } catch (err: any) {
    wsSend(ws, { type: 'approval_result', ok: false, approvalId, error: err.message });
  }
}

/**
 * Handle browser reconnect request.
 * When a browser WS reconnects after a disconnect, it sends { type: 'reconnect', session }
 * to re-subscribe to an active stream.
 */
async function denyExecApprovalForUnauthorizedUser(approval: ExecApprovalRequest, user?: JwtPayload): Promise<void> {
  if (!approval?.id || !user || isElevatedRole(user.role)) return;
  try {
    const nativeResult = resolveNativeCliApproval(approval.id, 'deny');
    if (nativeResult.ok) return;

    const result = await sendApprovalDecision(approval.id, 'deny');
    if (!result.ok) {
      console.warn(`[gateway] Failed to auto-deny exec approval ${approval.id} for unauthorized user ${user.userId}: ${result.error || 'unknown error'}`);
    }
  } catch (err: any) {
    console.warn(`[gateway] Failed to auto-deny exec approval ${approval.id} for unauthorized user ${user.userId}: ${err?.message || String(err)}`);
  }
}

async function handleWsReconnect(
  ws: WebSocket,
  msg: { session?: string; provider?: string; streamClientId?: string },
  user?: JwtPayload,
): Promise<void> {
  const providerName = normalizeProviderName(msg.provider);
  const sessionKey = providerName === 'OPENCLAW'
    ? await resolveOpenClawSessionKey(msg.session, user)
    : String(msg.session || '').trim();
  if (!sessionKey) {
    wsSend(ws, { type: 'error', content: 'reconnect requires session' });
    return;
  }

  try {
    if (user) await assertGatewaySessionAccess(sessionKey, user, { providerName });
    if (providerName === 'OPENCLAW') subscribeBackendToLiveSessionEvents(sessionKey);
  } catch (err: any) {
    const reconnectError = err?.message === 'Admin access required'
      ? 'Admin access required'
      : `Reconnect failed: ${redactNativeProviderText(err?.message || String(err)) || 'Agent error'}`;
    wsSend(ws, { type: 'error', content: reconnectError });
    return;
  }

  if (user?.userId) {
    takeOverSseDelivery(user.userId, sessionKey, msg.streamClientId);
  }

  const streamInfoCandidate = await getProviderActiveStreamSnapshot(providerName, sessionKey);
  const streamInfo = resolveAttachableHostStreamSnapshot(sessionKey, streamInfoCandidate)
    || streamInfoCandidate;
  if (!streamInfo.active) {
    const inactiveReason = 'inactiveReason' in streamInfo ? streamInfo.inactiveReason : 'unknown';
    const safeToClear = 'safeToClear' in streamInfo && streamInfo.safeToClear === true;
    runWsStreamCleanup(ws, sessionKey);
    wsSend(ws, {
      type: 'stream_status',
      sessionKey,
      active: false,
      inactiveReason: inactiveReason || 'unknown',
      safeToClear,
    });
    debugLog(`[gateway-ws] Reconnect found no active stream for ${sessionKey}: reason=${inactiveReason || 'unknown'} safeToClear=${safeToClear}`);
    return;
  }

  attachBrowserWsToSessionStream({
    ws,
    sessionKey,
    providerName,
    streamInfo,
    sendResume: true,
    keepSubscriptionAfterDone: providerName === 'OPENCLAW',
    onEvent: (evt: StreamEvent) => {
      if (evt.type === 'text') debugLog(`[Gateway] RECONNECT→browser TEXT: len=${(evt.content||'').length} "${(evt.content||'').substring(0, 40)}..."`);
    },
  });
  debugLog(`[gateway-ws] Client reconnected to active stream: ${sessionKey}`);
}

/* ─── WS connection handler ────────────────────────────────────────────── */

// Pending native-CLI (e.g. Claude Code) approvals a given user is allowed to see.
// Used to replay in-flight approval popups to a freshly (re)connected client so a
// reload / chat switch / reconnect mid-turn does not silently drop the request.
async function assertApprovalAccess(
  approval: ExecApprovalRequest,
  user: JwtPayload,
): Promise<void> {
  const sessionKey = typeof approval?.request?.sessionKey === 'string'
    ? approval.request.sessionKey.trim()
    : '';
  if (!sessionKey) throw new Error('Admin access required');
  await assertAgentStreamSessionAccess(sessionKey, user);
}

async function pendingApprovalsForUser(user: JwtPayload): Promise<ExecApprovalRequest[]> {
  if (!isElevatedRole(user.role)) return [];
  const visible: ExecApprovalRequest[] = [];
  for (const approval of listPendingNativeCliApprovals()) {
    try {
      await assertApprovalAccess(approval, user);
      approvalSessionKeys.set(approval.id, approval.request.sessionKey!.trim());
      visible.push(approval);
    } catch {
      // Cross-user or unowned approvals are never replayed.
    }
  }
  return visible;
}

function enqueueOrderedSessionDelivery(
  chains: Map<string, Promise<void>>,
  sessionKey: string,
  deliver: () => Promise<void>,
): Promise<void> {
  const previous = chains.get(sessionKey) || Promise.resolve();
  // A rejected delivery must not break ordering for later events. Return the
  // original promise to callers/tests, while the stored fence always settles
  // and is removed once the exact tail completes.
  const current = previous.then(deliver, deliver);
  const settled = current.catch(() => undefined);
  chains.set(sessionKey, settled);
  void settled.then(() => {
    if (chains.get(sessionKey) === settled) chains.delete(sessionKey);
  });
  return current;
}

function shouldSendGlobalStreamCopy(
  socketHadDirectSubscription: boolean,
  evt: Pick<StreamEvent, 'type' | 'maintenanceKind'>,
): boolean {
  const isMaintenanceEvent = evt.type === 'compaction_start'
    || evt.type === 'compaction_end'
    || evt.maintenanceKind === 'maintenance';
  return !socketHadDirectSubscription || isMaintenanceEvent;
}

function handlePortalWsConnection(ws: WebSocket, user: JwtPayload) {
  (ws as any).__portalUser = user;
  const authorizationBinding = (ws as any).__portalAuthorizationBinding as
    | GatewayWebSocketAuthorizationBinding
    | undefined;
  portalWsClients.add(ws);
  debugLog(`[gateway-ws] Client connected: ${user.email}`);

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) try { ws.ping(); } catch {}
  }, 15000);
  const globalDeliveryChains = new Map<string, Promise<void>>();

  // Subscribe to global StreamEventBus events.
  // This serves two purposes:
  // 1. Forward compaction events even when no per-session subscriber is active
  // 2. After backend restart, forward ALL stream events for active sessions
  //    before the user re-subscribes via a new send/reconnect request.
  //    Without this, events from PersistentGatewayWs are received but never
  //    reach the browser (no per-session subscriber exists yet).
  const unsubGlobal = streamEventBus.subscribeGlobal((sessionKey, evt) => {
    // Capture subscription ownership synchronously with publication. The
    // authorization checks below can await database work; consulting mutable
    // subscription state afterward can either drop the only copy (attached
    // after publish) or duplicate it (detached after publish).
    const socketHadDirectSubscription = wsHasSessionStreamSubscription(ws, sessionKey);
    const sendGlobalCopy = shouldSendGlobalStreamCopy(socketHadDirectSubscription, evt);
    const activityType = evt.type;
    const activitySubject = activityType === 'thinking'
      ? sanitizeThinkingSubject(evt.subject)
      : '';
    const needsActivityEnvelope = Boolean(
      activitySubject
      || activityType === 'done'
      || activityType === 'error'
      || activityType === 'run_resumed',
    );
    if (!sendGlobalCopy && !needsActivityEnvelope) return;
    void enqueueOrderedSessionDelivery(globalDeliveryChains, sessionKey, async () => {
      let releaseAuthorizationLease: (() => void) | null = null;
      try {
        releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(user.userId);
        await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
        await assertAgentStreamSessionAccess(sessionKey, user);
        await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);

        // Maintenance history is a durable write and therefore remains inside
        // the short event-delivery lease.
        recordMaintenanceHistoryMarker(sessionKey, evt);

        if (
          activitySubject
          || activityType === 'done'
          || activityType === 'error'
          || activityType === 'run_resumed'
        ) {
          // The browser never guesses Project scope from a key pattern. This
          // narrow envelope is emitted only after exact database attestation
          // and a second authorization-generation check.
          const eligible = await isAgentChatActivitySession(sessionKey, user.userId);
          await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
          if (eligible && ws.readyState === WebSocket.OPEN) {
            wsSend(ws, {
              type: 'activity_title',
              activityScope: 'agent-chat',
              activityType,
              sessionKey,
              runId: evt.runId,
              ...(activitySubject ? { subject: activitySubject } : {}),
            });
          }
        }

        // Skip the global copy only when this exact browser socket already owns
        // a direct subscription. Maintenance events deliberately use both
        // paths so the composer rail and durable marker survive transitions.
        if (!sendGlobalCopy) return;

        await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
        if (ws.readyState === WebSocket.OPEN) {
          wsSend(ws, { ...evt, sessionKey });
        }
      } catch {
        // A fence, ownership drift, or revoked generation drops the event.
      } finally {
        releaseAuthorizationLease?.();
      }
    });
  });

  ws.on('message', async (raw: Buffer | string) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { wsSend(ws, { type: 'error', content: 'Invalid JSON' }); return; }
    let releaseAuthorizationLease: (() => void) | null = null;
    let authorizationLeaseReleaseSafe = true;
    try {
      if (!authorizationBinding || authorizationBinding.revoked) return;
      // Every portal WS frame is actor-scoped. Hold the same fence across
      // history/reconnect reads and host mutations so a queued old-generation
      // frame cannot settle after a successful authorization change.
      releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(user.userId);
      await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
      switch (msg.type) {
        case 'history': await handleWsHistory(ws, msg, user); break;
        case 'send':
          await handleWsSend(ws, msg, user, () => {
            authorizationLeaseReleaseSafe = false;
          });
          break;
        case 'abort':   await handleWsAbort(ws, msg, user);   break;
        case 'inject':  await handleWsInject(ws, msg, user);  break;
        case 'exec_approval_resolve': await handleWsExecApproval(ws, msg, user); break;
        case 'reconnect': await handleWsReconnect(ws, msg, user);   break;
        default: wsSend(ws, { type: 'error', content: `Unknown type: ${msg.type}` });
      }
    } catch (error) {
      wsSend(ws, {
        type: 'error',
        content: redactNativeProviderText((error as Error)?.message || String(error)) || 'Authorization changed',
      });
    } finally {
      if (authorizationLeaseReleaseSafe) {
        releaseAuthorizationLease?.();
      } else {
        console.error(
          '[gateway-ws] Retaining the workspace authorization lease because an OpenClaw host-run ambiguity could not be quarantined',
        );
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
    unsubGlobal();
    portalWsClients.delete(ws);
    debugLog(`[gateway-ws] Client disconnected: ${user.email}`);
  });
  ws.on('error', (err: Error) => console.error(`[gateway-ws] Error (${user.email}):`, err.message));

  wsSend(ws, { type: 'connected' });

  // Replay any in-flight approval requests so a reconnecting / late client still
  // renders the popup. The frontend upserts by id, so re-delivery is idempotent.
  void (async () => {
    let releaseAuthorizationLease: (() => void) | null = null;
    try {
      releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(user.userId);
      await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
      for (const approval of await pendingApprovalsForUser(user)) {
        await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
        wsSend(ws, { type: 'exec_approval', approval });
      }
    } catch {
      // A transition or generation change suppresses approval replay.
    } finally {
      releaseAuthorizationLease?.();
    }
  })();
}

/* ─── WS Server setup (called from server.ts) ─────────────────────────── */

let portalWss: WebSocketServer | null = null;
let directWss: WebSocketServer | null = null;

// Per-user connection tracking for direct proxy WebSocket
const directUserConnections = new Map<string, number>();
const MAX_DIRECT_WS_PER_USER = 5;

// Allowlist of gateway methods that the direct proxy can forward
// Device identity for direct WS proxy — loaded lazily, then reused for all
// proxy connections. Importing this router must never create host state.
// Use the SAME device keys as PersistentGatewayWs — the gateway allows
// multiple connections from the same device with different instanceIds.
// Separate unpaired keys are rejected by the gateway as "pairing required".
let directProxyDeviceKeys: ReturnType<typeof getOrCreateDeviceKeys> | undefined;
function getDirectProxyDeviceKeys(): ReturnType<typeof getOrCreateDeviceKeys> {
  if (!directProxyDeviceKeys) directProxyDeviceKeys = getOrCreateDeviceKeys();
  return directProxyDeviceKeys;
}
const DIRECT_PROXY_CLIENT_ID = 'gateway-client';
const DIRECT_PROXY_CLIENT_MODE = 'backend';
const DIRECT_PROXY_ROLE = 'operator';
const DIRECT_PROXY_SCOPES = Object.freeze(['operator.read'] as const);
const DIRECT_PROXY_MIN_PROTOCOL = 3;
const DIRECT_PROXY_MAX_PROTOCOL = 4;

function getDirectProxyScopes(): string[] {
  return [...DIRECT_PROXY_SCOPES];
}

const ALLOWED_GATEWAY_METHODS = new Set([
  'connect',
  'chat.history',
  'sessions.messages.subscribe',
]);

const DIRECT_PROXY_SESSION_EVENTS = new Set([
  'agent',
  'chat',
  'chat.side_result',
  'session.message',
  'session.tool',
]);

function directGatewayEventSessionKey(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const frame = message as Record<string, any>;
  if (
    frame.type !== 'event'
    || typeof frame.event !== 'string'
    || !DIRECT_PROXY_SESSION_EVENTS.has(frame.event)
  ) {
    return null;
  }
  const value = frame.payload?.sessionKey;
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value.trim();
}

async function isDirectGatewayEventAllowed(
  message: unknown,
  user: JwtPayload,
  database: ProjectActivityScopeDatabase = prisma,
): Promise<boolean> {
  if (!message || typeof message !== 'object') return false;
  const frame = message as Record<string, any>;
  if (frame.type !== 'event' || typeof frame.event !== 'string') return false;
  if (frame.event === 'connect.challenge') {
    const nonce = frame.payload?.nonce;
    return typeof nonce === 'string'
      && nonce.length >= 16
      && nonce.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(nonce);
  }
  const sessionKey = directGatewayEventSessionKey(frame);
  if (!sessionKey) return false;
  try {
    await assertExistingGatewaySessionAccess(sessionKey, user, { database });
    return true;
  } catch {
    return false;
  }
}

function isDirectGatewayMethodAllowed(method: unknown, user: JwtPayload): boolean {
  if (typeof method !== 'string') return false;
  void user;
  // Mutating methods stay on the Portal broker, which owns authorization
  // leases through provider settlement. The transparent proxy cannot yet
  // prove quiescence after a browser disconnect.
  return ALLOWED_GATEWAY_METHODS.has(method);
}

function sameDirectParamKeys(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function isDirectGatewayRequestShapeAllowed(frame: unknown): boolean {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;
  const request = frame as Record<string, any>;
  if (request.type !== 'req' || typeof request.method !== 'string') return false;
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    return false;
  }
  const paramKeys = Object.keys(request.params).sort();
  if (request.method === 'connect') {
    const nonce = request.params.nonce;
    return typeof nonce === 'string'
      && nonce.length >= 16
      && nonce.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(nonce);
  }
  if (request.method === 'chat.history') {
    if (
      !sameDirectParamKeys(
        paramKeys,
        request.params.limit === undefined
          ? ['sessionKey']
          : ['limit', 'sessionKey'],
      )
    ) {
      return false;
    }
    return request.params.limit === undefined
      || (
        Number.isSafeInteger(request.params.limit)
        && request.params.limit >= 1
        && request.params.limit <= 500
      );
  }
  if (request.method === 'sessions.messages.subscribe') {
    return sameDirectParamKeys(paramKeys, ['key']);
  }
  // Unknown methods are rejected by the method allowlist. Their shape is not
  // forwarded, so no protocol-differential surface remains.
  return true;
}

interface DirectProxyConnectDependencies {
  getToken(): string;
  getKeys(): ReturnType<typeof getOrCreateDeviceKeys>;
  buildDevice(
    input: Parameters<typeof buildSignedDevice>[0],
  ): ReturnType<typeof buildSignedDevice>;
}

const directProxyConnectDependencies: DirectProxyConnectDependencies = {
  getToken: getGatewayToken,
  getKeys: getDirectProxyDeviceKeys,
  buildDevice: buildSignedDevice,
};

function buildDirectProxyConnectFrame(
  browserFrame: Record<string, any>,
  user: JwtPayload,
  dependencies: DirectProxyConnectDependencies = directProxyConnectDependencies,
): Record<string, unknown> {
  if (!isDirectGatewayRequestShapeAllowed(browserFrame) || browserFrame.method !== 'connect') {
    throw new Error('Invalid direct gateway connect request');
  }
  const token = dependencies.getToken();
  const nonce = browserFrame.params.nonce;
  const scopes = getDirectProxyScopes();
  return {
    type: 'req',
    id: String(browserFrame.id),
    method: 'connect',
    params: {
      auth: { token },
      client: {
        id: DIRECT_PROXY_CLIENT_ID,
        mode: DIRECT_PROXY_CLIENT_MODE,
        version: '1.0.0',
        displayName: `Portal (${user.email})`,
        platform: 'linux',
        instanceId: `portal-direct-${user.userId.substring(0, 8)}`,
      },
      device: dependencies.buildDevice({
        keys: dependencies.getKeys(),
        clientId: DIRECT_PROXY_CLIENT_ID,
        clientMode: DIRECT_PROXY_CLIENT_MODE,
        role: DIRECT_PROXY_ROLE,
        scopes,
        token,
        nonce,
      }),
      role: DIRECT_PROXY_ROLE,
      scopes,
      caps: ['tool-events'],
      minProtocol: DIRECT_PROXY_MIN_PROTOCOL,
      maxProtocol: DIRECT_PROXY_MAX_PROTOCOL,
    },
  };
}

/**
 * Handle a direct WebSocket proxy connection.
 * This creates a transparent pipe between the browser and the OpenClaw gateway,
 * with one exception: 'connect' requests have the auth token injected server-side.
 */
function handleDirectProxyConnection(browserWs: WebSocket, user: JwtPayload) {
  const userId = user.userId;
  const authorizationBinding = (browserWs as any).__portalAuthorizationBinding as
    | GatewayWebSocketAuthorizationBinding
    | undefined;
  const withAuthorizationLease = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    const release = acquireWorkspaceAuthorizationMutationLease(user.userId);
    try {
      await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
      const result = await operation();
      // Any ownership lookup above may have yielded while an authorization
      // change was published. Recheck immediately before exposing/forwarding
      // the frame while the short lease still owns the transition boundary.
      await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
      return result;
    } finally {
      release();
    }
  };

  // Enforce per-user connection limit
  const currentCount = directUserConnections.get(userId) || 0;
  if (currentCount >= MAX_DIRECT_WS_PER_USER) {
    browserWs.close(4029, 'Too many connections');
    return;
  }
  directUserConnections.set(userId, currentCount + 1);
  let connectionSlotReleased = false;
  const releaseConnectionSlot = () => {
    if (connectionSlotReleased) return;
    connectionSlotReleased = true;
    const count = directUserConnections.get(userId) || 0;
    if (count <= 1) directUserConnections.delete(userId);
    else directUserConnections.set(userId, count - 1);
  };

  const gatewayUrl = getOpenClawWsUrl();
  let gatewayWs: WebSocket | null = null;
  let browserClosed = false;
  let gatewayClosed = false;

  debugLog(`[gateway-direct] Creating proxy for user ${user.email} to ${gatewayUrl}`);

  try {
    gatewayWs = new WebSocket(gatewayUrl);
  } catch (err: any) {
    console.error('[gateway-direct] Failed to connect to gateway:', err.message);
    releaseConnectionSlot();
    browserWs.close(1011, 'Gateway connection failed');
    return;
  }

  gatewayWs.on('open', () => {
    debugLog('[gateway-direct] Connected to gateway');
    // Send a connected event to the browser
    try {
      browserWs.send(JSON.stringify({ type: 'connected' }));
    } catch {}
  });

  // Track browser→gateway id mapping so we can convert string IDs back to numeric
  const idMap = new Map<string, number>(); // gateway string ID → browser numeric ID
  type DirectRequestMeta = DirectGatewayChatSendMeta & {
    limit?: number;
    expectedRunId?: string | null;
    browserRequestId?: string | number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
  };
  const requestMeta = new Map<string, DirectRequestMeta>();
  const expiredRequestIds = new Set<string>();

  const markDirectRequestExpired = (gatewayId: string) => {
    expiredRequestIds.delete(gatewayId);
    expiredRequestIds.add(gatewayId);
    while (expiredRequestIds.size > 256) {
      const oldest = expiredRequestIds.values().next().value;
      if (typeof oldest !== 'string') break;
      expiredRequestIds.delete(oldest);
    }
  };

  const clearDirectRequestMeta = (gatewayId: string): DirectRequestMeta | undefined => {
    const meta = requestMeta.get(gatewayId);
    if (meta?.timeoutTimer) clearTimeout(meta.timeoutTimer);
    requestMeta.delete(gatewayId);
    idMap.delete(gatewayId);
    return meta;
  };

  const registerDirectRequestMeta = (gatewayId: string, meta: DirectRequestMeta) => {
    requestMeta.set(gatewayId, meta);
    if (meta.method !== 'chat.send' || !meta.sessionKey || !meta.reservationRunId) return;
    meta.timeoutTimer = scheduleDirectGatewayChatRunTimeout(
      meta.sessionKey,
      meta.reservationRunId,
      meta.idempotencyKey || '',
      () => {
        if (requestMeta.get(gatewayId) !== meta) return;
        requestMeta.delete(gatewayId);
        idMap.delete(gatewayId);
        markDirectRequestExpired(gatewayId);
        if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
          try {
            browserWs.send(JSON.stringify({
              type: 'res',
              id: meta.browserRequestId ?? gatewayId,
              ok: false,
              error: {
                code: 'CHAT_SEND_UNCONFIRMED',
                message: 'The gateway did not acknowledge the chat turn before the recovery window began.',
                sessionKey: meta.sessionKey,
                ...(meta.clientMessageId ? { clientMessageId: meta.clientMessageId } : {}),
              },
            }));
          } catch {}
        }
      },
    );
  };

  const failOutstandingDirectChatRuns = () => {
    for (const meta of requestMeta.values()) {
      if (meta.timeoutTimer) clearTimeout(meta.timeoutTimer);
      if (meta.sessionKey && meta.reservationRunId) {
        const parked = meta.method === 'chat.send' && parkUnconfirmedRunReservation(
          meta.sessionKey,
          meta.reservationRunId,
          meta.idempotencyKey || '',
        );
        if (!parked) failDirectGatewayChatRun(meta.sessionKey, meta.reservationRunId);
      }
    }
    requestMeta.clear();
    idMap.clear();
    expiredRequestIds.clear();
  };

  gatewayWs.on('message', async (data: RawData, isBinary: boolean) => {
    if (browserClosed) return;
    if (isBinary) {
      try { browserWs.close(1003, 'Binary gateway frames are not supported'); } catch {}
      return;
    }
    // Convert response string IDs back to the numeric IDs the browser expects
    try {
      const str = data.toString();
      const msg = JSON.parse(str);
      if (msg.type === 'event') {
        const allowed = await withAuthorizationLease(
          () => isDirectGatewayEventAllowed(msg, user),
        );
        if (!allowed) return;
      }

      if (DEBUG_GATEWAY_WS && msg.type === 'event') {
        if (msg.event === 'chat') {
          const state = msg.payload?.state;
          const content = msg.payload?.message?.content;
          const textBlocks = Array.isArray(content) ? content.filter((b: any) => b.type === 'text') : [];
          const thinkBlocks = Array.isArray(content) ? content.filter((b: any) => b.type === 'thinking') : [];
          const textLen = textBlocks.reduce((a: number, b: any) => a + (b.text || '').length, 0);
          const thinkLen = thinkBlocks.reduce((a: number, b: any) => a + (b.thinking || b.text || '').length, 0);
          const textPreview = textBlocks.map((b: any) => (b.text || '').substring(0, 60)).join('|');
          debugLog(`[gateway-direct] chat state=${state} textBlocks=${textBlocks.length} textLen=${textLen} thinkBlocks=${thinkBlocks.length} thinkLen=${thinkLen} runId=${msg.payload?.runId||'-'} preview="${textPreview}"`);
        } else if (msg.event === 'agent') {
          const stream = msg.payload?.stream;
          const data = msg.payload?.data;
          debugLog(`[gateway-direct] agent stream=${stream} phase=${data?.phase||'-'} name=${data?.name||'-'} toolCallId=${data?.toolCallId||'-'}`);
        } else {
          debugLog(`[gateway-direct] event=${msg.event}`);
        }
      }

      if (msg.type === 'res' && typeof msg.id === 'string' && expiredRequestIds.has(msg.id)) {
        expiredRequestIds.delete(msg.id);
        return;
      }
      if (msg.type === 'res' && typeof msg.id === 'string' && requestMeta.has(msg.id)) {
        await withAuthorizationLease(async () => {
          const gatewayId = msg.id;
          const meta = requestMeta.get(gatewayId);
          if (meta?.sessionKey) {
            await assertExistingGatewaySessionAccess(meta.sessionKey, user);
          }
          if (meta?.timeoutTimer) {
            clearTimeout(meta.timeoutTimer);
            meta.timeoutTimer = undefined;
          }
          if (msg.ok && meta?.method === 'chat.history' && meta.sessionKey) {
            msg.payload = augmentDirectHistoryPayload(msg.payload, meta.sessionKey, meta.limit || 200);
          }
          const browserResponse = await settleDirectGatewayChatSendResponse(meta, msg);
          const browserRequestId = meta?.browserRequestId ?? idMap.get(gatewayId) ?? gatewayId;
          clearDirectRequestMeta(gatewayId);
          browserResponse.id = browserRequestId;
          browserWs.send(JSON.stringify(browserResponse));
        });
        return;
      }
      // The proxy is a correlated read-only protocol boundary. Unsolicited
      // responses, unknown frame types, and unscoped events are never exposed.
      if (msg.type !== 'event') return;
      await withAuthorizationLease(() => {
        browserWs.send(JSON.stringify(msg));
      });
    } catch {
      // Fail closed on malformed upstream data or authorization drift.
      if (!browserClosed) {
        try { browserWs.close(4003, 'Authorization changed'); } catch {}
      }
    }
  });

  gatewayWs.on('close', (code: number, reason: Buffer) => {
    gatewayClosed = true;
    failOutstandingDirectChatRuns();
    debugLog(`[gateway-direct] Gateway closed: ${code} ${reason?.toString()}`);
    if (!browserClosed) {
      try {
        browserWs.close(code, reason?.toString() || 'Gateway disconnected');
      } catch {}
    }
  });

  gatewayWs.on('error', (err: Error) => {
    console.error('[gateway-direct] Gateway error:', err.message);
    if (!browserClosed) {
      try {
        browserWs.close(1011, 'Gateway error');
      } catch {}
    }
  });

  browserWs.on('message', async (data: RawData, isBinary: boolean) => {
    if (!authorizationBinding || authorizationBinding.revoked) return;
    if (gatewayClosed || !gatewayWs) return;
    if (isBinary) {
      try {
        browserWs.send(JSON.stringify({
          type: 'res',
          id: null,
          ok: false,
          error: { code: 'BINARY_FRAME_REJECTED', message: 'Gateway frames must be JSON text.' },
        }));
      } catch {}
      return;
    }

    // Parse the message to check if it's a 'connect' request
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      try {
        browserWs.send(JSON.stringify({
          type: 'res',
          id: null,
          ok: false,
          error: { code: 'INVALID_JSON', message: 'Gateway frames must be valid JSON.' },
        }));
      } catch {}
      return;
    }

    let releaseAuthorizationLease: (() => void) | null = null;
    try {
      releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(user.userId);
      await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);

    if (frame.type === 'req') {
      const validNumericId = typeof frame.id === 'number' && Number.isSafeInteger(frame.id);
      const validStringId = typeof frame.id === 'string' && frame.id.trim().length > 0;
      if (!validNumericId && !validStringId) {
        browserWs.send(JSON.stringify({
          type: 'res',
          id: frame.id ?? null,
          ok: false,
          error: { code: 'INVALID_REQUEST_ID', message: 'Gateway request IDs must be non-empty strings or safe integers.' },
        }));
        return;
      }
      const gatewayRequestId = String(frame.id);
      if (requestMeta.has(gatewayRequestId)
        || idMap.has(gatewayRequestId)
        || expiredRequestIds.has(gatewayRequestId)) {
        browserWs.send(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'DUPLICATE_REQUEST_ID', message: 'That gateway request ID is already in use.' },
        }));
        return;
      }
      if (!isDirectGatewayRequestShapeAllowed(frame)) {
        browserWs.send(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'The gateway request schema is not allowed.',
          },
        }));
        return;
      }
    }

    // Intercept 'connect' requests — build the full signed connect frame server-side
    // The gateway requires auth token + signed device identity, both must be injected
    if (frame.type === 'req' && frame.method === 'connect') {
      debugLog('[gateway-direct] Intercepting connect request to build full signed connect frame');
      const stringId = String(frame.id);
      if (typeof frame.id === 'number') {
        idMap.set(stringId, frame.id);
      }
      registerDirectRequestMeta(stringId, {
        method: 'connect',
        browserRequestId: frame.id,
      });

      const fullFrame = buildDirectProxyConnectFrame(frame, user);

      const serialized = JSON.stringify(fullFrame);
      debugLog(`[gateway-direct] CONNECT frame forwarding: readyState=${gatewayWs.readyState} bufferedAmount=${gatewayWs.bufferedAmount} id=${stringId} client=${DIRECT_PROXY_CLIENT_ID} scopeCount=${getDirectProxyScopes().length}`);
      try {
        gatewayWs.send(serialized, (err) => {
          if (err) {
            clearDirectRequestMeta(stringId);
            console.error('[gateway-direct] Send callback error:', err.message);
          } else {
            debugLog(`[gateway-direct] CONNECT frame forwarded: bufferedAmount=${gatewayWs?.bufferedAmount} id=${stringId}`);
          }
        });
      } catch (err: any) {
        clearDirectRequestMeta(stringId);
        console.error('[gateway-direct] Failed to send signed connect:', err.message);
      }
      return;
    }

    // Enforce method allowlist — reject anything not explicitly allowed for this user.
    // chat.inject stays admin-only to match the portal WS/HTTP injection paths.
    if (frame.type === 'req' && frame.method && !isDirectGatewayMethodAllowed(frame.method, user)) {
      browserWs.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: `Method '${frame.method}' is not allowed` }
      }));
      return;
    }

    // Filter out non-standard frame types that the gateway doesn't understand
    // (ping, reconnect, etc. — these are client-side keepalive/session management)
    if (frame.type !== 'req') {
      // Silently drop non-request frames — gateway only accepts 'req' type
      debugLog(`[gateway-direct] Dropping non-req frame type=${frame.type}`);
      return;
    }

    const frameMethod = typeof frame.method === 'string' ? frame.method : '';
    let frameSessionKey = typeof frame.params?.sessionKey === 'string' && frame.params.sessionKey.trim()
      ? frame.params.sessionKey.trim()
      : (typeof frame.params?.key === 'string' && frame.params.key.trim()
          ? frame.params.key.trim()
          : (typeof frame.params?.session === 'string' && frame.params.session.trim()
              ? frame.params.session.trim()
              : undefined));
    if (!frameSessionKey) {
      browserWs.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'SESSION_REQUIRED', message: 'A concrete owned session is required.' },
      }));
      return;
    }
    try {
      const resolvedSessionKey = await resolveOpenClawSessionKey(frameSessionKey, user);
      await assertExistingGatewaySessionAccess(resolvedSessionKey, user);
      await assertGatewayWebSocketActorIsCurrent(user, authorizationBinding);
      if (typeof frame.params?.sessionKey === 'string') {
        frame.params.sessionKey = resolvedSessionKey;
      } else if (typeof frame.params?.key === 'string') {
        frame.params.key = resolvedSessionKey;
      } else {
        frame.params.session = resolvedSessionKey;
      }
      frameSessionKey = resolvedSessionKey;
    } catch {
      browserWs.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'SESSION_ACCESS_DENIED', message: 'Session access denied.' },
      }));
      return;
    }
    let directExpectedRunId: string | null | undefined;
    let directReservationRunId: string | undefined;
    if (frameSessionKey && (frameMethod === 'chat.send' || frameMethod === 'sessions.steer')) {
      if (frameMethod === 'chat.send') {
        await ensurePortalAgentChatLabel(frameSessionKey, user, frame.params?.message).catch(() => undefined);
        directReservationRunId = `direct-${randomUUID()}`;
        const directClientMessageId = normalizeDirectGatewayClientMessageId(
          frame.params?.idempotencyKey,
        );
        if (!reserveDirectGatewayChatRun(frameSessionKey, directReservationRunId)) {
          subscribeBackendToLiveSessionEvents(frameSessionKey);
          browserWs.send(JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: false,
            error: await buildDirectGatewayActiveTurnError(
              frameSessionKey,
              directClientMessageId,
            ),
          }));
          return;
        }
        // Never expose the browser-controlled optimistic ID as OpenClaw's
        // global chat.send idempotency/run identity. Bind it behind fresh
        // server entropy, while retaining it as a separately parseable echo
        // identity for same-tab acknowledgement and cross-tab visibility.
        frame.params.idempotencyKey = buildPortalOpenClawIdempotencyKey(
          directReservationRunId,
          directClientMessageId,
        );
        directExpectedRunId = directReservationRunId;
      } else {
        directExpectedRunId = normalizeHostStreamRunId(
          streamEventBus.getTrackedStream(frameSessionKey)?.runId,
        );
      }
      subscribeBackendToLiveSessionEvents(frameSessionKey);
    }

    // Pass through request frames — coerce id to string (gateway requires string IDs)
    if (typeof frame.id === 'number') {
      const numericId = frame.id;
      const stringId = String(frame.id);
      frame.id = stringId;
      idMap.set(stringId, numericId);
      registerDirectRequestMeta(stringId, {
        method: frame.method,
        sessionKey: frameSessionKey,
        expectedRunId: directExpectedRunId,
        reservationRunId: directReservationRunId,
        clientMessageId: normalizeDirectGatewayClientMessageId(frame.params?.idempotencyKey),
        idempotencyKey: typeof frame.params?.idempotencyKey === 'string'
          ? frame.params.idempotencyKey
          : undefined,
        browserRequestId: numericId,
        limit: typeof frame.params?.limit === 'number' && Number.isFinite(frame.params.limit)
          ? frame.params.limit
          : undefined,
      });
      try {
        gatewayWs.send(JSON.stringify(frame));
      } catch (err: any) {
        clearDirectRequestMeta(stringId);
        if (frameSessionKey && directReservationRunId) {
          failDirectGatewayChatRun(frameSessionKey, directReservationRunId);
        }
        debugLog('[gateway-direct] Failed to forward to gateway:', err.message);
      }
    } else {
      const stringId = typeof frame.id === 'string' ? frame.id : undefined;
      if (stringId) {
        registerDirectRequestMeta(stringId, {
          method: frame.method,
          sessionKey: frameSessionKey,
          expectedRunId: directExpectedRunId,
          reservationRunId: directReservationRunId,
          clientMessageId: normalizeDirectGatewayClientMessageId(frame.params?.idempotencyKey),
          idempotencyKey: typeof frame.params?.idempotencyKey === 'string'
            ? frame.params.idempotencyKey
            : undefined,
          browserRequestId: stringId,
          limit: typeof frame.params?.limit === 'number' && Number.isFinite(frame.params.limit)
            ? frame.params.limit
            : undefined,
        });
      }
      try {
        gatewayWs.send(JSON.stringify(frame));
      } catch (err: any) {
        if (stringId) clearDirectRequestMeta(stringId);
        if (frameSessionKey && directReservationRunId) {
          failDirectGatewayChatRun(frameSessionKey, directReservationRunId);
        }
        debugLog('[gateway-direct] Failed to forward to gateway:', err.message);
      }
    }
    } catch {
      try { browserWs.close(4003, 'Authorization changed'); } catch {}
    } finally {
      releaseAuthorizationLease?.();
    }
  });

  browserWs.on('close', (code: number, reason: Buffer) => {
    browserClosed = true;
    failOutstandingDirectChatRuns();
    debugLog(`[gateway-direct] Browser closed: ${code} ${reason?.toString()}`);

    // Decrement per-user connection count
    releaseConnectionSlot();

    if (!gatewayClosed && gatewayWs) {
      try {
        gatewayWs.close(code, reason?.toString() || 'Browser disconnected');
      } catch {}
    }
  });

  browserWs.on('error', (err: Error) => {
    console.error('[gateway-direct] Browser error:', err.message);
    if (!gatewayClosed && gatewayWs) {
      try {
        gatewayWs.close(1011, 'Browser error');
      } catch {}
    }
  });

  // Ping/pong keepalive
  const pingTimer = setInterval(() => {
    if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
      try { browserWs.ping(); } catch {}
    }
    if (!gatewayClosed && gatewayWs?.readyState === WebSocket.OPEN) {
      try { gatewayWs.ping(); } catch {}
    }
  }, 30000);

  browserWs.on('close', () => clearInterval(pingTimer));
}

/**
 * Attach the portal WebSocket server to the HTTP server.
 * Call this from server.ts after creating httpServer.
 * Handles upgrade requests on /api/gateway/ws and /api/gateway/direct.
 */
export function attachPortalWebSocket(httpServer: HttpServer) {
  portalWss = new WebSocketServer({ noServer: true });
  initApprovalWsBroadcast();

  portalWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // User already verified in upgrade handler
    const user = (req as any).__portalUser as JwtPayload;
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    const authorizationBinding = (req as any).__portalAuthorizationBinding as
      | GatewayWebSocketAuthorizationBinding
      | undefined;
    if (!authorizationBinding || authorizationBinding.revoked) {
      ws.close(4003, 'Authorization changed');
      return;
    }
    (ws as any).__portalAuthorizationBinding = authorizationBinding;
    handlePortalWsConnection(ws, user);
  });

  // Initialize the direct proxy WebSocket server
  directWss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

  directWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const user = (req as any).__portalUser as JwtPayload;
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    const authorizationBinding = (req as any).__portalAuthorizationBinding as
      | GatewayWebSocketAuthorizationBinding
      | undefined;
    if (!authorizationBinding || authorizationBinding.revoked) {
      ws.close(4003, 'Authorization changed');
      return;
    }
    (ws as any).__portalAuthorizationBinding = authorizationBinding;
    handleDirectProxyConnection(ws, user);
  });

  // Register upgrade handler for both /api/gateway/ws and /api/gateway/direct
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url || '';
    const isPortalWs = url.startsWith('/api/gateway/ws');
    const isDirectProxy = url.startsWith('/api/gateway/direct');

    if (!isPortalWs && !isDirectProxy) return; // Let other upgrade handlers proceed

    const origin = req.headers.origin;
    if (!isAllowedWebSocketOrigin(origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authenticate via cookie
    const cookies = parseSafeCookieHeader(req.headers.cookie);
    const token = cookies.accessToken;
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = verifyAccessToken(token);
    if (!user) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const authorizationBinding: GatewayWebSocketAuthorizationBinding = { revoked: false };
    (req as any).__portalAuthorizationBinding = authorizationBinding;
    let unsubscribed = false;
    let globalSubscriptionReady = false;
    const revokeForGlobalFence = () => {
      authorizationBinding.revoked = true;
      if (globalSubscriptionReady) socket.destroy();
    };
    let unsubscribeGlobalFence = subscribeToGlobalWorkspaceAuthorizationFence(
      revokeForGlobalFence,
    );
    globalSubscriptionReady = true;
    if (authorizationBinding.revoked) {
      unsubscribeGlobalFence();
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }
    const unsubscribeAuthorization = subscribeToAuthorizationChanges(user.userId, () => {
      authorizationBinding.revoked = true;
      socket.destroy();
    });
    const cleanupAuthorization = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      socket.removeListener('close', cleanupAuthorization);
      unsubscribeGlobalFence();
      unsubscribeGlobalFence = () => {};
      unsubscribeAuthorization();
    };
    socket.once('close', cleanupAuthorization);

    prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        role: true,
        accountStatus: true,
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: true,
      },
    } as any).then((dbUser) => {
      const canUseRequestedTransport = dbUser && (
        isDirectProxy
          ? canUseDirectGateway(dbUser.role, (dbUser as any).accountStatus, dbUser.isActive)
          : canUseInteractivePortal(dbUser.role, (dbUser as any).accountStatus, dbUser.isActive)
      );
      if (authorizationBinding.revoked
        || socket.destroyed
        || !canUseRequestedTransport
        || (user.authorizationVersion ?? 1) !== Number((dbUser as any).authorizationVersion ?? 1)) {
        cleanupAuthorization();
        if (!socket.destroyed) socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      (req as any).__portalUser = {
        userId: dbUser.id,
        email: dbUser.email,
        role: dbUser.role,
        accountStatus: (dbUser as any).accountStatus,
        sandboxEnabled: !!(dbUser as any).sandboxEnabled,
        authorizationVersion: Number((dbUser as any).authorizationVersion ?? 1),
      };

      // Route to the appropriate WebSocket server
      try {
        if (isDirectProxy) {
          directWss!.handleUpgrade(req, socket, head, (ws: any) => {
            directWss!.emit('connection', ws, req);
          });
        } else {
          portalWss!.handleUpgrade(req, socket, head, (ws: any) => {
            portalWss!.emit('connection', ws, req);
          });
        }
      } catch {
        cleanupAuthorization();
        socket.destroy();
      }
    }).catch(() => {
      cleanupAuthorization();
      if (!socket.destroyed) socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  });

  debugLog('[gateway-ws] Portal WebSocket server attached on /api/gateway/ws and /api/gateway/direct');
}

// Narrow test surface for the Agent Chat trust-boundary ordering. Project Chat
// keeps using the shared gateway transport for sandbox history/reconnect.
export const __gatewayExecutionScopeTest = {
  requireHostOperatorExecutionContext,
  openClawAgentChatSessionKey,
  isPortalAgentChatSessionKeyForUser,
  buildPortalAgentChatLabel,
  openClawSessionActorId,
  resolveOpenClawSessionKey,
  resolveOpenClawTurnSessionKey,
  claimOpenClawAgentSession,
  findOpenClawAgentSessionOwner,
  assertGatewaySessionAccess,
  assertExistingGatewaySessionAccess,
  providerPublishesHostStream,
  providerUsesHostStreamBus,
  getProviderOwnedBusStreamSnapshot,
  parseExactOpenClawConflictRun,
  reconcileOpenClawActiveTurnConflict,
  browserSafeActiveStreamSnapshot,
  attachBrowserWsToSessionStream,
  wsHasSessionStreamSubscription,
  shouldSendGlobalStreamCopy,
  captureHostStreamRunIdentity,
  clearHostStreamIfCurrentRun,
  shouldAttemptOpenClawReplyRecovery,
  registerSseDelivery,
  takeOverSseDelivery,
  reserveDirectGatewayChatRun,
  acknowledgeDirectGatewayChatRun,
  failDirectGatewayChatRun,
  normalizeDirectGatewayClientMessageId,
  isDirectGatewayActiveTurnError,
  buildDirectGatewayActiveTurnError,
  settleDirectGatewayChatSendResponse,
  scheduleDirectGatewayChatRunTimeout,
  normalizeRequestedModel,
  isProviderModelResetAlias,
  routeProviderForRequestedModel,
  humanizeProviderError,
  isActorDerivedLegacyProjectSessionKey,
  isProjectChatActivitySession,
  isAgentChatActivitySession,
  attestAgentChatActivitySession,
  isDirectGatewayMethodAllowed,
  isDirectGatewayRequestShapeAllowed,
  buildDirectProxyConnectFrame,
  getDirectProxyScopes,
  directGatewayEventSessionKey,
  isDirectGatewayEventAllowed,
  sendHostOperatorProviderMessage,
  clearAgentActivityScopePending: () => agentActivityScopePending.clear(),
  directGatewayChatSendTimeoutMs: DIRECT_GATEWAY_CHAT_SEND_TIMEOUT_MS,
  handleWsSend,
  handleWsAbort,
  handleWsReconnect,
  enqueueOrderedSessionDelivery,
};

// Narrow test surface for the dashboard's OpenClaw version checks. The
// dependency seam lets regression tests prove that CLI processes never overlap
// without changing production probe inputs or acceptance rules.
export const __gatewayVersionProbeTest = {
  probeOpenClawVersionStatusWithDependencies,
  OPENCLAW_VERSION_STATUS_COLD_PROBE_BUDGET_MS,
};

export const __gatewayCompatibilityHotfixTest = {
  askUserRuntimeReportIsReady,
  getOpenClawAskUserRuntimeReadiness,
};

export default router;
function normalizeRequestedModel(providerName: AgentProviderName, rawModel: string): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  if (providerName === 'OPENCLAW') return normalizePortalModelId(model);
  // Ollama tags are opaque and can resemble Portal/OpenClaw aliases. Preserve
  // the exact `/api/tags` identifier through selection, session launch, and
  // send so a local `codex/gpt-5.5` tag is never rewritten to another model.
  if (providerName === 'OLLAMA') return model;
  if (providerName === 'GEMINI') {
    const normalized = normalizePortalModelId(model).replace(/^models\//, '');
    if (normalized.startsWith('google-antigravity/')) return normalized.slice('google-antigravity/'.length);
    if (normalized.startsWith('google-gemini-cli/')) return normalized.slice('google-gemini-cli/'.length);
    if (normalized.startsWith('google/')) return normalized.slice('google/'.length);
    return normalized;
  }

  const parts = model.split('/').filter(Boolean);
  if (parts.length < 2) return model;

  const lower = model.toLowerCase();
  if (providerName === 'CLAUDE_CODE' && (lower.startsWith('anthropic/') || lower.startsWith('claude/'))) {
    return parts.slice(1).join('/');
  }
  if (providerName === 'CODEX' && (lower.startsWith('codex/') || lower.startsWith('openai-codex/') || lower.startsWith('openai/'))) {
    return parts.slice(1).join('/');
  }
  if (providerName === 'GROK' && (lower.startsWith('xai/') || lower.startsWith('grok/'))) {
    return parts.slice(1).join('/');
  }
  return model;
}

/** Provider-neutral ask-user channel, projected through an owner-scoped broker. */
function askUserErrorResponse(res: Response, error: unknown): void {
  if (error instanceof AskUserQuestionError) {
    if ([
      'ASK_USER_NOT_FOUND',
      'ASK_USER_RUN_UNOWNED',
      'ASK_USER_OWNER_REQUIRED',
      'ASK_USER_AUTHORITY_REQUIRED',
    ].includes(error.code)) {
      res.status(404).json({
        error: 'That question is no longer open.',
        code: 'ASK_USER_NOT_OPEN',
      });
      return;
    }
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof PendingUserInputAnswerError) {
    if (error.statusCode === 404) {
      res.status(404).json({
        error: 'That question is no longer open.',
        code: 'ASK_USER_NOT_OPEN',
      });
      return;
    }
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  console.error('[gateway] ask-user error:', error);
  res.status(500).json({ error: 'The question channel is unavailable.' });
}

// Narrow test seam for the privacy-preserving ask-user error projection. The
// public route must not reveal whether a question belonged to another actor,
// but clients still need one stable code to reconcile ordinary cross-tab races.
export const __gatewayAskUserTest = {
  askUserErrorResponse,
};

router.get('/ask-user/pending', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const actorUserId = req.user?.userId || '';
    const actorAuthorizationVersion = Number(req.user?.authorizationVersion ?? 1);
    const requestedSession = typeof req.query.session === 'string' && req.query.session.trim()
      ? await resolveOpenClawSessionKey(req.query.session, req.user)
      : undefined;
    const pending = await syncAskUserQuestionsForActor({
      actorUserId,
      actorAuthorizationVersion,
      sessionKey: requestedSession,
    });
    res.json({ questions: pending, actorUserId });
  } catch (error) {
    askUserErrorResponse(res, error);
  }
});

router.post('/ask-user/answer', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const id = String(req.body?.id || '');
    const actorUserId = req.user?.userId || '';
    const { record, idempotentReplay } = await deliverAskUserQuestionAnswer({
      id,
      answers: (req.body?.answers && typeof req.body.answers === 'object') ? req.body.answers : {},
      actorUserId,
    });
    res.json({ ok: true, id: record.id, state: record.state, idempotentReplay });
  } catch (error) {
    askUserErrorResponse(res, error);
  }
});

router.post('/ask-user/dismiss', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const id = String(req.body?.id || '');
    const actorUserId = req.user?.userId || '';
    const { idempotentReplay } = await deliverAskUserQuestionDismissal({
      id,
      actorUserId,
    });
    res.json({ ok: true, idempotentReplay });
  } catch (error) {
    askUserErrorResponse(res, error);
  }
});
