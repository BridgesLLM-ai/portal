import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { AgentRegistry, AgentProviderName } from '../agents';
import { listProviderModels } from '../agents/providerModels';
import { getProviderCommandCatalog } from '../agents/providerCommandCatalog';
import { resolveExecApproval, ExecApprovalRequest } from '../agents/providers/OpenClawProvider';
import { appendNativeMessage, loadNativeSession, updateNativeSessionModel } from '../agents/providers/NativeSessionStore';
import { gatewayRpcCall, patchSessionModel, getSessionInfo, isGatewayTransportError, chatSend } from '../utils/openclawGatewayRpc';
import {
  sendApprovalDecision,
  injectChatMessage,
  onApprovalRequest,
  onApprovalResolved,
  isConnected as isPersistentWsConnected,
  reconnectNow as reconnectPersistentWs,
  type ExecApprovalRequest as PersistentApprovalRequest,
  type ExecApprovalResolved,
} from '../agents/providers/PersistentGatewayWs';
import { streamEventBus, type StreamEvent } from '../services/StreamEventBus';
import { verifyAccessToken, JwtPayload } from '../utils/jwt';
import { buildSignedDevice, getOrCreateDeviceKeys } from '../utils/deviceIdentity';
import { prisma } from '../config/database';
import { getOpenClawApiUrl } from '../config/openclaw';
import { shouldIsolateUser } from '../utils/workspaceScope';
import { extractTextFromContent as extractSanitizedText } from '../utils/chatText';
import { canAccessPortal, canUseInteractivePortal, isElevatedRole, isOwnerRole } from '../utils/authz';
import { hasGatewayToken, getGatewayToken } from '../utils/gatewayToken';
import { getOpenClawWsUrl } from '../config/openclaw';
import { isAllowedWebSocketOrigin } from '../utils/websocketOrigin';
// @ts-ignore - ws doesn't have type declarations in this project
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';

const DEBUG_GATEWAY_WS = process.env.DEBUG_GATEWAY_WS === '1';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_GATEWAY_WS) console.log('[gateway]', ...args);
};

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

function resolveOpenClawSessionKey(rawSession: unknown, user?: Pick<JwtPayload, 'role'> | null): string {
  const session = typeof rawSession === 'string' ? rawSession.trim() : '';
  if (session.startsWith('agent:')) return session;

  const isOwnerMainAlias = isOwnerRole(user?.role)
    && (!session || session === 'main' || session.startsWith('new-'));
  if (isOwnerMainAlias) return 'agent:main:main';

  return session;
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

function isSandboxProjectAgentIdForUser(agentId: string, user: JwtPayload): boolean {
  const normalized = String(agentId || '').trim();
  if (!normalized) return false;
  return normalized.startsWith(`portal-${user.userId.slice(0, 8)}-`);
}

function isSandboxProjectSessionKeyForUser(sessionKey: string, user: JwtPayload): boolean {
  const normalized = String(sessionKey || '').trim();
  if (!normalized || !user?.sandboxEnabled) return false;

  const match = normalized.match(/^agent:([^:]+):(portal-[^:]+)$/);
  if (!match) return false;

  const [, agentId, sessionId] = match;
  if (!isSandboxProjectAgentIdForUser(agentId, user)) return false;
  return sessionId.startsWith(`portal-${user.userId}-`);
}

function assertGatewaySessionAccess(sessionKey: string, user: JwtPayload, options?: { providerName?: AgentProviderName | string | undefined }): void {
  if (isElevatedRole(user.role)) return;

  const providerName = String(options?.providerName || 'OPENCLAW').trim().toUpperCase();
  if (providerName !== 'OPENCLAW') {
    throw new Error('Admin access required');
  }

  if (isSandboxProjectSessionKeyForUser(sessionKey, user)) return;
  throw new Error('Admin access required');
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

  return Array.from(merged.values());
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function extractText(content: any): string {
  return extractSanitizedText(content);
}

function humanizeSessionKey(sessionKey: string, sessionId: string): string {
  if (sessionKey === 'agent:main:main' || sessionId === 'main') return 'Main session';

  const parts = sessionKey.split(':');
  const slug = parts.slice(2).join(':') || sessionId;
  const normalized = slug.replace(/^portal-[a-f0-9]{8}-/i, '');

  if (/^blip-analysis(?:-\d+)?$/i.test(normalized)) {
    return normalized.replace(/-/g, ' ');
  }

  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(normalized)
      && !/^openai$/i.test(normalized)
      && !/^portal-\d+$/i.test(slug)
      && !/^[a-f0-9-]{24,}$/i.test(normalized)) {
    return normalized.replace(/[-_]+/g, ' ');
  }

  return `Session ${sessionId.slice(0, 8)}`;
}

function extractSenderLabel(text: string): string {
  if (!text || !text.includes('Sender (untrusted metadata)')) return '';
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return '';
  try {
    const parsed = JSON.parse(match[1]);
    const candidates = [parsed?.label, parsed?.name, parsed?.username, parsed?.id]
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean);
    return candidates[0] || '';
  } catch {
    return '';
  }
}

function cleanSessionTitleCandidate(text: string): string {
  return text
    .replace(/^System:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^A new session was started.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsableSessionTitle(title: string): boolean {
  if (!title || title.length > 72) return false;
  if (/^you are\s/i.test(title)) return false;
  if (/^system:/i.test(title)) return false;
  if (/^sender\s*\(/i.test(title)) return false;
  if (/^conversation info\s*\(/i.test(title)) return false;
  return true;
}

function summarizeSessionLabel(params: { sessionKey: string; sessionId: string; lines: string[] }) {
  const { sessionKey, sessionId, lines } = params;
  const fallbackTitle = humanizeSessionKey(sessionKey, sessionId);

  let firstUserText = '';
  let firstUserRawText = '';
  let assistantPreview = '';

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || !entry.message) continue;
      const role = entry.message.role as string;
      const rawText = typeof entry.message.content === 'string'
        ? entry.message.content
        : Array.isArray(entry.message.content)
          ? entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('\n')
          : '';
      const text = extractText(entry.message.content)
        .replace(/\s+/g, ' ')
        .trim();
      if (!text && !rawText) continue;
      if (!firstUserText && role === 'user') {
        firstUserText = text;
        firstUserRawText = rawText;
      }
      if (!assistantPreview && role === 'assistant' && text) assistantPreview = text;
      if (firstUserText && assistantPreview) break;
    } catch {
      // ignore malformed lines
    }
  }

  const senderLabel = extractSenderLabel(firstUserRawText);
  const cleanedPrompt = cleanSessionTitleCandidate(firstUserText);

  const titleSource = isUsableSessionTitle(cleanedPrompt)
    ? cleanedPrompt
    : senderLabel || fallbackTitle;

  return {
    title: titleSource.length > 72 ? `${titleSource.slice(0, 69).trimEnd()}…` : titleSource,
    preview: assistantPreview
      ? (assistantPreview.length > 120 ? `${assistantPreview.slice(0, 117).trimEnd()}…` : assistantPreview)
      : undefined,
    isMainSession: sessionKey === 'agent:main:main' || sessionId === 'main',
  };
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

  const fileSize = statSync(filePath).size;
  if (fileSize <= 2 * 1024 * 1024) {
    const allLines = readFileSync(filePath, 'utf-8').split('\n').filter((line) => line.trim());
    const parsed: T[] = [];
    for (const line of allLines) {
      const message = parseLine(line);
      if (message) parsed.push(message);
    }
    return parsed.slice(-limit);
  }

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
        return { id: entry.id, role, content: text, timestamp: entry.timestamp };
      } catch {
        return null;
      }
    },
  });
}

/**
 * Enhanced history reader — includes tool calls and tool results from JSONL.
 */
function readSessionMessagesEnhanced(sessionId: string, limit = 200, sessionsDir = SESSIONS_DIR): any[] {
  return readRecentSessionMessages({
    sessionId,
    limit,
    sessionsDir,
    parseLine: (line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || !entry.message) return null;
        const role = entry.message.role;
        const content = entry.message.content;

        if (role === 'user') {
          const text = extractText(content);
          return text ? { id: entry.id, role: 'user', content: text, timestamp: entry.timestamp } : null;
        }

        if (role === 'assistant') {
          if (Array.isArray(content)) {
            const toolCalls: any[] = [];
            // Track text blocks and where tool calls appear so we can separate
            // narration (text before tools) from the final response (text after tools).
            const allBlocks: { type: 'text' | 'tool'; text?: string }[] = [];
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                allBlocks.push({ type: 'text', text: block.text });
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
                segments.push({ text: block.text, position });
              }
            }
            
            // For display content, join all text blocks (streaming shows them inline anyway)
            const allText = allBlocks
              .filter(b => b.type === 'text')
              .map(b => b.text!)
              .join('\n');
            const text = extractSanitizedText(allText);
            
            return {
              id: entry.id,
              role: 'assistant',
              content: text,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              // Include segments for frontend to reconstruct graduated timeline
              segments: hasToolCalls && segments.length > 0 ? segments : undefined,
              timestamp: entry.timestamp,
            };
          }

          const text = extractText(content);
          return text ? { id: entry.id, role: 'assistant', content: text, timestamp: entry.timestamp } : null;
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
}

/** Resolve a session key to its JSONL file id */
function resolveSessionFileId(sessionKey: string, sessionsDir = SESSIONS_DIR): string | null {
  // Try sessions.json index first
  const sessionsFile = path.join(sessionsDir, 'sessions.json');
  if (existsSync(sessionsFile)) {
    try {
      const data = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
      const sessions = data.sessions || data;
      if (typeof sessions === 'object' && !Array.isArray(sessions)) {
        const entry = sessions[sessionKey];
        if (entry?.sessionId || entry?.id) return entry.sessionId || entry.id;
      }
      if (Array.isArray(sessions)) {
        const match = sessions.find((s: any) => s.key === sessionKey || s.id === sessionKey);
        if (match?.sessionId || match?.id) return match.sessionId || match.id;
      }
    } catch {}
  }
  // Try sessionKey directly as filename
  const directFile = path.join(sessionsDir, `${sessionKey}.jsonl`);
  if (existsSync(directFile)) return sessionKey;
  // Extract the trailing UUID from agent:<agentId>:<fileId> format
  const parts = sessionKey.split(':');
  if (parts.length >= 3) {
    const fileId = parts.slice(2).join(':');
    const agentFile = path.join(sessionsDir, `${fileId}.jsonl`);
    if (existsSync(agentFile)) return fileId;
  }
  return null;
}

const PROVENANCE: Record<string, string> = {
  OPENCLAW: 'via OpenClaw',
  CLAUDE_CODE: 'via Claude CLI',
  CODEX: 'via Codex CLI',
  AGENT_ZERO: 'via Agent Zero',
};

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

// Dashboard health check — includes connectivity + config validation
router.get('/health', authenticateToken, async (_req: Request, res: Response) => {
  try {
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

    if (connected) {
      try {
        const modelsResult = await gatewayRpcCall('models.list', {});
        if (modelsResult.ok && Array.isArray(modelsResult.data?.models)) {
          modelCount = modelsResult.data.models.length;
          modelsConfigured = modelCount > 0;
        }
      } catch { /* gateway may not support models.list — treat as unknown */ }

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

    const ok = chatReady && modelsConfigured;
    res.json({ ok, connected, wsConnected, chatReady, gatewayReachable, modelsConfigured, modelCount, issues });
  } catch {
    res.json({ ok: false, connected: false, wsConnected: false, gatewayReachable: false, modelsConfigured: false, modelCount: 0, issues: ['Health check failed'] });
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

router.get('/providers', authenticateToken, async (_req: Request, res: Response) => {
  try {
    res.json({ providers: AgentRegistry.listProviders() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list providers', detail: err.message });
  }
});

router.get('/models', authenticateToken, async (req: Request, res: Response) => {
  try {
    const providerName = ((req.query.provider as string) || 'OPENCLAW').trim().toUpperCase() as AgentProviderName;
    const providerInfo = AgentRegistry.listProviders().find((p) => p.name === providerName);
    if (!providerInfo) {
      res.status(400).json({ error: `Unknown provider: ${providerName}` });
      return;
    }

    const models = await listProviderModels(providerName);
    res.json({
      provider: providerName,
      capabilities: providerInfo.capabilities,
      models,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list models', detail: err.message });
  }
});

router.get('/commands', authenticateToken, async (req: Request, res: Response) => {
  try {
    const providerName = ((req.query.provider as string) || 'OPENCLAW').trim().toUpperCase() as AgentProviderName;
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
    res.status(500).json({ error: 'Failed to list commands', detail: err.message });
  }
});

router.get('/sessions', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const providerName = (req.query.provider as AgentProviderName) || undefined;
    if (providerName) {
      try {
        const provider = AgentRegistry.get(providerName);
        const sessions = await provider.listSessions(req.user!.userId);
        res.json({ sessions });
        return;
      } catch (err: any) {
        console.warn(`[gateway] Provider ${providerName} listSessions failed: ${err.message}`);
      }
    }

    // Support agentId filter — defaults to all agents for full visibility
    const agentId = req.query.agentId as string | undefined;
    const sanitizedAgentId = agentId ? agentId.replace(/[^a-zA-Z0-9_-]/g, '') : null;

    // For 'main' (or no agentId = show main), use the canonical session registry from sessions.json.
    // The 'main' agent is not in agents.list so the CLI won't enumerate it reliably.
    const isAdmin = isElevatedRole(req.user!.role);
    const isSandboxIsolated = shouldIsolateUser(req.user!);
    const isMainAgent = !sanitizedAgentId || sanitizedAgentId === 'main';

    if (!isAdmin && isSandboxIsolated && isMainAgent) {
      const provider = AgentRegistry.get('OPENCLAW');
      const sessions = await provider.listSessions(req.user!.userId);
      res.json({ sessions });
      return;
    }
    if (isMainAgent) {
      const sessionsDir = path.join(process.env.HOME || '/root', '.openclaw/agents/main/sessions');
      const sessionsFile = path.join(sessionsDir, 'sessions.json');
      try {
        const cutoffMs = isOwnerRole(req.user!.role) ? 0 : Date.now() - 1440 * 60 * 1000;
        if (existsSync(sessionsFile)) {
          const raw = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
          const entries = Object.entries(raw || {});
          const sessions: any[] = [];

          for (const [sessionKey, meta] of entries as Array<[string, any]>) {
            const updatedAt = Number(meta?.updatedAt || 0);
            if (updatedAt && updatedAt < cutoffMs) continue;

            const sessionId = String(meta?.sessionId || meta?.id || '').trim();
            if (!sessionId) continue;

            const filePath = meta?.sessionFile
              || path.join(sessionsDir, `${sessionId}.jsonl`);

            let lines: string[] = [];
            let createdAt = meta?.createdAt || updatedAt || Date.now();
            let lastActivityAt = updatedAt || createdAt;

            try {
              if (existsSync(filePath)) {
                const stat = statSync(filePath);
                const content = readFileSync(filePath, 'utf-8');
                lines = content.split('\n').filter((l: string) => l.trim());
                const firstLine = lines[0];
                if (firstLine) {
                  const first = JSON.parse(firstLine);
                  createdAt = first.timestamp || createdAt || stat.birthtimeMs;
                }
                lastActivityAt = stat.mtimeMs || lastActivityAt;
              }
            } catch {
              // keep metadata-derived timestamps if file read fails
            }

            const summary = summarizeSessionLabel({ sessionKey, sessionId, lines });
            sessions.push({
              key: sessionKey,
              sessionId,
              id: sessionId,
              agentId: 'main',
              status: lastActivityAt > Date.now() - 5 * 60 * 1000 ? 'active' : 'idle',
              createdAt,
              lastActivityAt,
              updatedAt: lastActivityAt,
              title: summary.title,
              preview: summary.preview,
              isMainSession: summary.isMainSession,
            });
          }

          sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          res.json({ sessions });
          return;
        }
      } catch (err: any) {
        // fall through to CLI path
      }
    }

    const args = ['sessions', '--json', '--active', '1440'];
    if (sanitizedAgentId && sanitizedAgentId !== 'main') {
      args.push('--agent', sanitizedAgentId);
    } else {
      args.push('--all-agents');
    }

    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('openclaw', args, { timeout: 10000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
      const parsed = JSON.parse(output.trim());
      // --all-agents returns { agents: { id: { sessions: [...] } } } — flatten
      if (parsed.agents && !parsed.sessions) {
        const allSessions: any[] = [];
        for (const agent of Object.values(parsed.agents) as any[]) {
          if (agent.sessions && Array.isArray(agent.sessions)) {
            allSessions.push(...agent.sessions);
          }
        }
        // Sort by updatedAt descending
        allSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        res.json({ sessions: allSessions });
      } else {
        res.json(parsed);
      }
      return;
    } catch {}

    // Final fallback: sessions.json file
    const fallbackAgent = sanitizedAgentId || 'main';
    const agentSessionsDir = path.join(process.env.HOME || '/root', `.openclaw/agents/${fallbackAgent}/sessions`);
    const sessionsFile = path.join(agentSessionsDir, 'sessions.json');
    if (existsSync(sessionsFile)) {
      res.json(JSON.parse(readFileSync(sessionsFile, 'utf-8')));
      return;
    }
    res.json({ sessions: [] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list sessions', detail: err.message });
  }
});

// GET /api/gateway/usage-stats — aggregates session and cron data for usage dashboard
router.get('/usage-stats', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { execSync } = require('child_process');
    const selectedAgent =
      (typeof req.query.agent === 'string' && req.query.agent.trim())
      || (typeof req.query.agentId === 'string' && req.query.agentId.trim())
      || '';

    // Get session list
    let sessions: any[] = [];
    try {
      const sessionsRaw = execSync('openclaw sessions --json 2>/dev/null', { timeout: 10000, encoding: 'utf-8' });
      const parsed = JSON.parse(sessionsRaw.trim());
      // Handle both { sessions: [...] } and { agents: { id: { sessions: [...] } } } formats
      if (parsed.sessions && Array.isArray(parsed.sessions)) {
        sessions = parsed.sessions;
      } else if (parsed.agents) {
        for (const agent of Object.values(parsed.agents) as any[]) {
          if (agent.sessions && Array.isArray(agent.sessions)) {
            sessions.push(...agent.sessions);
          }
        }
      }
    } catch {
      // Sessions list failed — continue with empty array
    }

    // Get cron job count
    let cronJobs: any[] = [];
    try {
      const cronsRaw = execSync('openclaw cron list --json 2>/dev/null', { timeout: 10000, encoding: 'utf-8' });
      const parsed = JSON.parse(cronsRaw.trim());
      cronJobs = parsed.jobs || [];
    } catch {
      // Cron list failed — continue with empty array
    }

    const agentFilteredSessions = selectedAgent
      ? sessions.filter((s: any) => (s?.agentId || 'main') === selectedAgent)
      : sessions;
    const agentFilteredCrons = selectedAgent
      ? cronJobs.filter((j: any) => (j?.agentId || j?.agent || 'main') === selectedAgent)
      : cronJobs;

    const totalSessions = agentFilteredSessions.length;
    const now = Date.now();
    const activeSessions = agentFilteredSessions.filter((s: any) => {
      const lastMs = s.lastActivityMs || s.updatedAt || s.updatedAtMs || 0;
      return now - lastMs < 3600000; // active in last hour
    }).length;

    // Model breakdown
    const modelCounts: Record<string, number> = {};
    agentFilteredSessions.forEach((s: any) => {
      const model = s.model || s.defaultModel || 'unknown';
      modelCounts[model] = (modelCounts[model] || 0) + 1;
    });
    const modelBreakdown = Object.entries(modelCounts)
      .map(([model, count]) => ({ model, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions);

    // Recent sessions (last 20)
    const recentSessions = agentFilteredSessions
      .sort((a: any, b: any) => (b.lastActivityMs || b.updatedAt || 0) - (a.lastActivityMs || a.updatedAt || 0))
      .slice(0, 20)
      .map((s: any) => ({
        key: s.sessionKey || s.key || s.id,
        agent: s.agentId || 'main',
        model: s.model || s.defaultModel || 'unknown',
        lastActivity: s.lastActivityMs || s.updatedAt || s.updatedAtMs,
        turns: s.turns || 0,
      }));

    res.json({
      totalSessions,
      activeSessions,
      cronJobs: agentFilteredCrons.length,
      activeCrons: agentFilteredCrons.filter((j: any) => j.enabled !== false).length,
      modelBreakdown,
      recentSessions,
    });
  } catch (err: any) {
    console.error('[gateway] usage-stats error:', err);
    res.status(500).json({ error: err.message || 'Failed to get usage stats' });
  }
});

router.get('/session-info', authenticateToken, async (req: Request, res: Response) => {
  try {
    const sessionKey = resolveOpenClawSessionKey(req.query.session as string, req.user);
    assertGatewaySessionAccess(sessionKey, req.user!);
    const result = await getSessionInfo(sessionKey);
    if (!result.ok) {
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

router.post('/session-model', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const providerName = (typeof req.body?.provider === 'string' ? req.body.provider.trim().toUpperCase() : 'OPENCLAW') as AgentProviderName;
    const model = normalizeRequestedModel(providerName, typeof req.body?.model === 'string' ? req.body.model.trim() : '');

    if (!model) {
      res.status(400).json({ error: 'model required' });
      return;
    }

    if (providerName === 'OPENCLAW') {
      if (!model.includes('/')) {
        res.status(400).json({ error: 'model must include provider prefix' });
        return;
      }
      const rawSession = typeof req.body?.session === 'string' ? req.body.session.trim() : '';
      const sessionKey = resolveOpenClawSessionKey(rawSession, req.user);
      assertGatewaySessionAccess(sessionKey, req.user!, { providerName });
      const isConcreteSession = sessionKey.startsWith('agent:');
      if (!isConcreteSession) {
        res.status(409).json({ error: 'No concrete OpenClaw session selected', code: 'NO_CONCRETE_SESSION' });
        return;
      }

      const info = await getSessionInfo(sessionKey);
      if (!info.ok || !info.data) {
        const status = isGatewayTransportError(info.error) ? 502 : 404;
        res.status(status).json({ error: info.error || 'Session not found' });
        return;
      }

      const patched = await patchSessionModel(sessionKey, model);
      if (!patched.ok) {
        res.status(502).json({ error: patched.error || 'Failed to patch session model' });
        return;
      }

      const refreshed = await getSessionInfo(sessionKey);
      res.json({ ok: true, session: refreshed.ok ? refreshed.data : info.data, resolved: patched.resolved || null });
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

    const updated = updateNativeSessionModel(providerName, rawSession, model);
    res.json({
      ok: true,
      session: updated ? {
        sessionId: updated.sessionId,
        model: updated.model,
        modelProvider: providerName.toLowerCase(),
        metadata: updated.metadata || {},
      } : null,
      resolved: updated ? { modelProvider: providerName.toLowerCase(), model } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to patch session model', detail: err.message });
  }
});

/**
 * Patch session settings (thinking level, fast mode, etc.)
 * Only works for OPENCLAW provider with concrete sessions.
 */
router.post('/session-patch', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const providerName = (typeof req.body?.provider === 'string' ? req.body.provider.trim().toUpperCase() : 'OPENCLAW') as AgentProviderName;
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

    const sessionKey = resolveOpenClawSessionKey(rawSession, req.user);
    assertGatewaySessionAccess(sessionKey, req.user!, { providerName });

    const isConcreteSession = sessionKey.startsWith('agent:');
    if (!isConcreteSession) {
      res.status(409).json({ error: 'No concrete OpenClaw session selected', code: 'NO_CONCRETE_SESSION' });
      return;
    }

    const thinking = typeof settings.thinking === 'string' ? settings.thinking.trim().toLowerCase() : '';
    const model = typeof settings.model === 'string' ? settings.model.trim() : '';

    const out: Record<string, any> = { ok: true };

    // Thinking is NOT supported by sessions.patch; apply it by sending /think to the concrete session.
    if (thinking) {
      const allowedThinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive']);
      if (!allowedThinking.has(thinking)) {
        res.status(400).json({ error: `Unsupported thinking level: ${thinking}` });
        return;
      }
      const thinkResult = await chatSend(sessionKey, `/think ${thinking}`, `portal-think-${sessionKey}-${Date.now()}`);
      if (!thinkResult.ok) {
        res.status(502).json({ error: thinkResult.error || 'Failed to set thinking level' });
        return;
      }
      out.thinking = { ok: true, level: thinking, runId: thinkResult.runId, status: thinkResult.status };
    }

    if (model) {
      const result = await gatewayRpcCall('sessions.patch', { key: sessionKey, model });
      if (!result.ok) {
        res.status(502).json({ error: result.error || 'Failed to patch session model' });
        return;
      }
      out.model = result.data;
    }

    res.json(out);
  } catch (err: any) {
    console.error('[gateway] session-patch error:', err);
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Failed to patch session', detail: err.message });
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
      const normalized = normalizeRequestedModel(params.providerName, parsed.rest);
      const updated = updateNativeSessionModel(params.providerName, session.sessionId, normalized);
      return appendExchange(`Model set to ${normalized}`, { command: parsed.command, model: updated?.model || normalized });
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
      const newSessionId = await AgentRegistry.get(params.providerName).startSession(params.userId, {
        model: params.requestedModel ? normalizeRequestedModel(params.providerName, params.requestedModel) : session.model,
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
    const sessionKey = resolveOpenClawSessionKey(req.query.session as string, req.user);
    const limit = parseInt(req.query.limit as string) || 100;
    const afterId = req.query.after as string;
    const providerName = req.query.provider as AgentProviderName | undefined;
    const enhanced = req.query.enhanced === '1';

    assertGatewaySessionAccess(sessionKey, req.user!, { providerName });

    // For non-OPENCLAW providers use the provider abstraction
    if (providerName && providerName !== 'OPENCLAW') {
      try {
        const provider = AgentRegistry.get(providerName);
        const messages = await provider.getHistory(sessionKey);
        res.json({ messages, sessionId: sessionKey });
        return;
      } catch (err: any) {
        console.warn(`[gateway] Provider ${providerName} getHistory failed: ${err.message}`);
      }
    }

    // OPENCLAW (and default): resolve directly from JSONL
    const sessionsDir = resolveSessionsDir(sessionKey);
    const fileId = resolveSessionFileId(sessionKey, sessionsDir);
    if (!fileId) {
      res.json({ messages: [] });
      return;
    }

    const sessionId = fileId;
    let messages = enhanced
      ? readSessionMessagesEnhanced(sessionId, limit, sessionsDir)
      : await readSessionMessages(sessionId, limit, sessionsDir);

    if (afterId) {
      const idx = messages.findIndex((m: any) => m.id === afterId);
      if (idx >= 0) messages = messages.slice(idx + 1);
    }
    res.json({ messages, sessionId });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Failed to get history', detail: err.message });
  }
});

// POST /api/gateway/send — SSE streaming (kept as fallback)
router.post('/send', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const { message, session = 'main', provider: providerName, model: requestedModel, agentId } = req.body;
  if (!message) { res.status(400).json({ error: 'message required' }); return; }

  const wantStream = req.query.stream === '1' || req.headers.accept === 'text/event-stream';

  try {
    const provider = providerName
      ? AgentRegistry.get(providerName as AgentProviderName)
      : AgentRegistry.getDefault();
    const provenance = PROVENANCE[provider.providerName] || `via ${provider.displayName}`;

    const clientSession = typeof session === 'string' && session.trim().length > 0 ? session.trim() : '';
    let sessionId: string;
    if (provider.providerName === 'OPENCLAW') {
      const useCanonicalMainSession = isOwnerRole(req.user!.role)
        && (!agentId || agentId === 'main')
        && (!clientSession || clientSession === 'main' || clientSession.startsWith('new-'));
      if (agentId && agentId !== 'main') {
        // Same sub-agent session resolution as the WS path
        const agentPrefix = `agent:${agentId}:`;
        if (clientSession.startsWith(agentPrefix)) {
          sessionId = clientSession;
        } else {
          let sessionName: string;
          if (!clientSession || clientSession.startsWith('new-')) {
            sessionName = 'main';
          } else if (clientSession.startsWith('agent:')) {
            const parts = clientSession.split(':');
            sessionName = parts.length >= 3 ? parts.slice(2).join(':') : 'main';
          } else {
            sessionName = clientSession;
          }
          sessionId = `agent:${agentId}:${sessionName}`;
        }
      } else if (clientSession.startsWith('agent:')) {
        sessionId = clientSession;
      } else if (useCanonicalMainSession) {
        sessionId = 'agent:main:main';
      } else {
        sessionId = await provider.startSession(req.user!.userId, {
          metadata: clientSession ? { sessionSlug: clientSession } : undefined,
        });
      }
    } else {
      if (!clientSession || clientSession === 'main' || clientSession.startsWith('new-')) {
        sessionId = await provider.startSession(req.user!.userId, {
          model: typeof requestedModel === 'string' && requestedModel.trim() ? normalizeRequestedModel(provider.providerName, requestedModel.trim()) : undefined,
          metadata: { requestedBy: req.user!.email },
        });
      } else {
        sessionId = clientSession;
        if (typeof requestedModel === 'string' && requestedModel.trim()) {
          updateNativeSessionModel(provider.providerName, sessionId, normalizeRequestedModel(provider.providerName, requestedModel.trim()));
        }
      }
    }

    assertGatewaySessionAccess(sessionId, req.user!, { providerName: provider.providerName });

    if (requestedModel && provider.providerName === 'OPENCLAW') {
      try {
        await patchSessionModel(sessionId, requestedModel);
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
      });
      if (slashResult.handled) {
        res.json({
          response: slashResult.content || '',
          model: slashResult.metadata?.model || loadNativeSession(provider.providerName, slashResult.sessionId)?.model || null,
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
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders();

      const sseWrite = (data: string) => {
        res.write(data);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      };
      sseWrite(`data: ${JSON.stringify({ type: 'session', sessionId, provenance })}\n\n`);

      let sseAlive = true;
      const keepaliveTimer = setInterval(() => { if (sseAlive) try { sseWrite(': keepalive\n\n'); } catch { sseAlive = false; } }, 15000);
      req.on('close', () => { sseAlive = false; clearInterval(keepaliveTimer); });

      let gotRealStatus = false;
      const fallbackTimer = setTimeout(() => {
        if (!gotRealStatus && sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'status', content: `${provider.displayName} is thinking…` })}\n\n`); } catch { sseAlive = false; }
      }, 2000);

      const onStatus = (evt: { type: string; content: string; [key: string]: any }) => {
        gotRealStatus = true;
        if (sseAlive) try { sseWrite(`data: ${JSON.stringify(evt)}\n\n`); } catch { sseAlive = false; }
      };
      const onExecApproval = (approval: ExecApprovalRequest) => {
        if (sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'exec_approval', approval })}\n\n`); } catch { sseAlive = false; }
      };
      const senderIdentity = req.user ? { label: req.user.email, userId: req.user.userId } : undefined;

      try {
        const result = await (provider as any).sendMessage(sessionId, message, (chunk: string) => {
          if (sseAlive) try { sseWrite(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`); } catch { sseAlive = false; }
        }, onStatus, onExecApproval, senderIdentity);
        clearTimeout(fallbackTimer); clearInterval(keepaliveTimer);
        if (sseAlive) {
          sseWrite(`data: ${JSON.stringify({ type: 'done', content: result.fullText, provenance })}\n\n`);
          sseWrite('data: [DONE]\n\n');
        }
      } catch (err: any) {
        clearTimeout(fallbackTimer); clearInterval(keepaliveTimer);
        if (sseAlive) {
          sseWrite(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
          sseWrite('data: [DONE]\n\n');
        }
      }
      res.end();
      return;
    }

    // Non-streaming
    const senderIdentity = req.user ? { label: req.user.email, userId: req.user.userId } : undefined;
    const result = await (provider as any).sendMessage(sessionId, message, undefined, undefined, undefined, senderIdentity);
    const resolvedSessionId = typeof result?.metadata?.resolvedSessionId === 'string' && result.metadata.resolvedSessionId.trim()
      ? result.metadata.resolvedSessionId.trim()
      : sessionId;
    res.json({ response: result.fullText, model: result.metadata?.model, provider: provider.providerName, provenance, sessionId: resolvedSessionId });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 503;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Agent unavailable', detail: err.message });
  }
});

/* GET /api/gateway/agents — list OpenClaw sub-agents */
router.get('/agents', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const raw = await listOpenClawAgentsForSelector();

    // Fetch sub-agent avatars from DB
    let subAgentAvatarMap: Record<string, string> = {};
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
    const hiddenAgentIds = new Set(['portal', 'opus', 'codex', 'claude']);
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
          model: a.model || a.defaultModel || undefined,
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
  const sessionKey = resolveOpenClawSessionKey(req.query.session as string, req.user);
  try {
    assertGatewaySessionAccess(sessionKey, req.user!);
  } catch (err: any) {
    res.status(403).json({ error: 'Admin access required', detail: err.message });
    return;
  }
  if (!sessionKey) {
    res.json({ active: false });
    return;
  }
  const info = streamEventBus.getStreamStatus(sessionKey);
  if (info) {
    // Double-check: if last event was >90s ago, the stream is probably stale
    // (e.g., done event was missed). Report inactive to avoid stuck UI.
    const lastEvent = (info as any).lastEventAt || info.startedAt;
    if (lastEvent && (Date.now() - lastEvent) > 90_000) {
      debugLog(`[stream-status] StreamEventBus has entry but lastEvent=${new Date(lastEvent).toISOString()} is stale — reporting inactive`);
      streamEventBus.clearStream(sessionKey);
      res.json({ active: false });
      return;
    }
    const content = streamEventBus.getLatestText(sessionKey);
    res.json({
      active: true,
      phase: info.phase,
      toolName: info.toolName || null,
      startedAt: info.startedAt,
      runId: info.runId || null,
      content: content || undefined,
      lastEventAt: lastEvent,
    });
  } else {
    // StreamEventBus has no active stream — but the gateway might still be running
    // (e.g., after backend restart when PersistentGatewayWs hasn't forwarded events yet).
    // Query the gateway's session state as a fallback.
    // GUARD: only trust the gateway's chatState if there's been recent activity.
    // Stale chatState (from interrupted turns) causes the UI to show "thinking..." forever.
    try {
      const sessResult = await getSessionInfo(sessionKey);
      if (sessResult.ok && sessResult.data) {
        const sess = sessResult.data;
        const chatState = typeof sess.chatState === 'string' ? sess.chatState : '';
        if (chatState === 'streaming' || chatState === 'thinking' || chatState === 'tool') {
          // Check if the run is genuinely active — if lastActivity is older than 60s
          // and we have no stream events, this is almost certainly a stale state.
          const lastActivity = typeof sess.lastActivity === 'number' ? sess.lastActivity : 0;
          const staleCutoff = Date.now() - 60_000; // 60 seconds
          if (lastActivity && lastActivity < staleCutoff) {
            debugLog(`[stream-status] Gateway reports chatState=${chatState} but lastActivity=${new Date(lastActivity).toISOString()} is stale — reporting inactive`);
            res.json({ active: false });
            return;
          }
          debugLog(`[stream-status] StreamEventBus empty but gateway reports chatState=${chatState} — reporting active`);
          res.json({
            active: true,
            phase: chatState === 'tool' ? 'tool' : chatState === 'streaming' ? 'streaming' : 'thinking',
            toolName: null,
            startedAt: Date.now(),
            runId: typeof sess.runId === 'string' ? sess.runId : null,
          });
          return;
        }
      }
    } catch {
      // Gateway RPC failed — fall through to inactive
    }
    res.json({ active: false });
  }
});

router.post('/chat/abort', authenticateToken, requireApproved, async (req: Request, res: Response): Promise<void> => {
  const { session, runId } = req.body;
  const sessionKey = resolveOpenClawSessionKey(session, req.user);
  console.log(`[gateway] HTTP ABORT REQUEST: session=${sessionKey} runId=${runId || 'none'}`);
  try {
    assertGatewaySessionAccess(sessionKey, req.user!);
    const payload: Record<string, string> = { sessionKey };
    if (runId) payload.runId = runId;
    const result = await gatewayRpcCall('chat.abort', payload);
    console.log(`[gateway] HTTP ABORT RESULT: ok=${result.ok} error=${result.error || 'none'}`);
    if (!result.ok) { res.status(500).json({ error: 'Abort failed', detail: result.error }); return; }
    res.json({ ok: true, sessionKey });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Failed to abort', detail: err.message });
  }
});


router.post('/chat/inject', authenticateToken, requireApproved, async (req: Request, res: Response): Promise<void> => {
  const sessionKey = resolveOpenClawSessionKey(req.body?.session, req.user);
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
    assertGatewaySessionAccess(sessionKey, req.user!);
    await injectChatMessage(sessionKey, text);
    res.json({ ok: true, sessionKey });
  } catch (err: any) {
    const status = err?.message === 'Admin access required' ? 403 : 500;
    res.status(status).json({ error: status === 403 ? 'Admin access required' : 'Failed to inject chat message', detail: err.message });
  }
});

router.post('/exec-approval/resolve', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { approvalId, decision } = req.body;
  if (!approvalId || typeof approvalId !== 'string') { res.status(400).json({ error: 'Missing approvalId' }); return; }
  if (!decision || !['allow-once', 'deny', 'allow-always'].includes(decision)) { res.status(400).json({ error: 'Invalid decision' }); return; }
  try {
    if (isPersistentWsConnected()) {
      const result = await sendApprovalDecision(approvalId, decision);
      if (result.ok) { res.json({ ok: true, approvalId, decision }); return; }
      console.warn(`[gateway] Persistent WS resolution failed: ${result.error}`);
    }
    const result = await resolveExecApproval(approvalId, decision);
    if (!result.ok) { res.status(404).json({ error: result.error || 'Failed' }); return; }
    res.json({ ok: true, approvalId, decision });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// GET /api/gateway/approvals/stream — SSE for exec approval events (kept as fallback)
router.get('/approvals/stream', authenticateToken, requireAdmin, (req: Request, res: Response) => {
  res.socket?.setNoDelay?.(true);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  let alive = true;
  const sseWrite = (data: string) => { if (!alive) return; try { res.write(data); if (typeof (res as any).flush === 'function') (res as any).flush(); } catch { alive = false; } };
  sseWrite(`data: ${JSON.stringify({ type: 'connected', persistentWsConnected: isPersistentWsConnected() })}\n\n`);
  const keepaliveTimer = setInterval(() => { if (alive) sseWrite(': keepalive\n\n'); }, 15000);
  const unsubReq = onApprovalRequest((a: PersistentApprovalRequest) => sseWrite(`data: ${JSON.stringify({ type: 'exec_approval_requested', approval: a })}\n\n`));
  const unsubRes = onApprovalResolved((r: ExecApprovalResolved) => sseWrite(`data: ${JSON.stringify({ type: 'exec_approval_resolved', resolved: r })}\n\n`));
  req.on('close', () => { alive = false; clearInterval(keepaliveTimer); unsubReq(); unsubRes(); });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * BROWSER ↔ PORTAL PERSISTENT WEBSOCKET
 * ═══════════════════════════════════════════════════════════════════════════ */

function parseCookiesWs(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      cookies[pair.substring(0, idx).trim()] = decodeURIComponent(pair.substring(idx + 1).trim());
    }
  });
  return cookies;
}

// Track active portal WS clients for approval broadcasting
const portalWsClients: Set<WebSocket> = new Set();

// Broadcast approval events to all portal WS clients
let approvalBroadcastInit = false;
function initApprovalWsBroadcast() {
  if (approvalBroadcastInit) return;
  approvalBroadcastInit = true;
  onApprovalRequest((approval: PersistentApprovalRequest) => {
    const msg = JSON.stringify({ type: 'exec_approval', approval });
    const sessionKey = approval?.request?.sessionKey;
    for (const c of portalWsClients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const user = (c as any).__portalUser as JwtPayload | undefined;
      if (!user) continue;
      if (sessionKey) {
        try {
          assertGatewaySessionAccess(sessionKey, user);
        } catch {
          continue;
        }
      } else if (!isElevatedRole(user.role)) {
        continue;
      }
      try { c.send(msg); } catch {}
    }
  });
  onApprovalResolved((resolved: ExecApprovalResolved) => {
    const msg = JSON.stringify({ type: 'exec_approval_resolved', resolved });
    for (const c of portalWsClients) {
      if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {}
    }
  });
}

function wsSend(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(data)); } catch {}
}

/* ─── Active stream tracking (via StreamEventBus) ─────────────────────── */
// Stream status is now managed by StreamEventBus (populated by PersistentGatewayWs).
// The per-message WS in handleWsSend also updates it for consistency.

/* ─── WS message handlers ─────────────────────────────────────────────── */

async function handleWsHistory(ws: WebSocket, msg: any, user: JwtPayload) {
  const sessionKey = resolveOpenClawSessionKey(msg.session, user);
  const providerName = msg.provider as AgentProviderName | undefined;
  const requestId = msg.requestId; // For client-side correlation

  try {
    assertGatewaySessionAccess(sessionKey, user, { providerName });
    // Try provider abstraction
    if (providerName) {
      try {
        const provider = AgentRegistry.get(providerName);
        const messages = await provider.getHistory(sessionKey);
        wsSend(ws, { type: 'history', messages, sessionId: sessionKey, requestId });
        return;
      } catch {}
    }

    // JSONL-based enhanced history
    const sessionsDir = resolveSessionsDir(sessionKey);
    const fileId = resolveSessionFileId(sessionKey, sessionsDir);
    const sessionId = fileId || sessionKey;
    const messages = readSessionMessagesEnhanced(sessionId, msg.limit || 200, sessionsDir);
    wsSend(ws, { type: 'history', messages, sessionId, requestId });

    // After sending history, check if there's an active stream on this session.
    // If so, send a stream_resume event and subscribe to StreamEventBus.
    const streamInfo = streamEventBus.getStreamStatus(sessionKey);
    if (streamInfo && streamInfo.active) {
      wsSend(ws, {
        type: 'stream_resume',
        sessionKey,
        phase: streamInfo.phase,
        toolName: streamInfo.toolName || null,
        runId: streamInfo.runId || null,
      });

      // Subscribe to StreamEventBus and forward events to this browser WS.
      // Use registerWsStreamCleanup so that if handleWsSend later creates its
      // own subscription for the same session, the old one gets cleaned up first.
      // Without this, both subscribers forward events → browser gets text TWICE → cascade!
      const unsub = streamEventBus.subscribe(sessionKey, (evt: StreamEvent) => {
        wsSend(ws, { ...evt, sessionKey });
        if (evt.type === 'done' || evt.type === 'error') unsub();
      });
      ws.once('close', unsub);
      registerWsStreamCleanup(ws, sessionKey, unsub);
    }
  } catch (err: any) {
    wsSend(ws, { type: 'error', content: err?.message === 'Admin access required' ? 'Admin access required' : `History failed: ${err.message}`, requestId });
  }
}

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

async function handleWsSend(ws: WebSocket, msg: any, user: JwtPayload) {
  const { message, session = 'main', provider: providerName, model: requestedModel, agentId } = msg;
  if (!message) { wsSend(ws, { type: 'error', content: 'message required' }); return; }

  let streamKeepalive: ReturnType<typeof setInterval> | null = null;
  let resolvedSessionId: string | null = null;

  try {
    const provider = providerName
      ? AgentRegistry.get(providerName as AgentProviderName)
      : AgentRegistry.getDefault();
    const provenance = PROVENANCE[provider.providerName] || `via ${provider.displayName}`;
    const isOpenClawProvider = provider.providerName === 'OPENCLAW';

    const clientSession = typeof session === 'string' && session.trim().length > 0 ? session.trim() : '';
    let sessionId: string;
    if (isOpenClawProvider) {
      const useCanonicalMainSession = isOwnerRole(user.role)
        && (!agentId || agentId === 'main')
        && (!clientSession || clientSession === 'main' || clientSession.startsWith('new-'));
      if (agentId && agentId !== 'main') {
        // If clientSession is already a fully-qualified agent: key for this agent, reuse it directly.
        // This prevents the cascading session bug where e.g. 'agent:parity:main' gets wrapped
        // into 'agent:parity:agent:parity:main' on subsequent messages.
        const agentPrefix = `agent:${agentId}:`;
        if (clientSession.startsWith(agentPrefix)) {
          sessionId = clientSession;
        } else {
          // Extract just the session name, stripping any stale agent: prefix from a different agent
          let sessionName: string;
          if (!clientSession || clientSession.startsWith('new-')) {
            sessionName = 'main';
          } else if (clientSession.startsWith('agent:')) {
            // Session key from a different agent — extract the trailing name part
            const parts = clientSession.split(':');
            sessionName = parts.length >= 3 ? parts.slice(2).join(':') : 'main';
          } else {
            sessionName = clientSession;
          }
          sessionId = `agent:${agentId}:${sessionName}`;
        }
      } else if (clientSession.startsWith('agent:')) {
        sessionId = clientSession;
      } else if (useCanonicalMainSession) {
        sessionId = 'agent:main:main';
      } else {
        sessionId = await provider.startSession(user.userId, {
          metadata: clientSession ? { sessionSlug: clientSession } : undefined,
        });
      }
    } else {
      if (!clientSession || clientSession === 'main' || clientSession.startsWith('new-')) {
        sessionId = await provider.startSession(user.userId, {
          model: typeof requestedModel === 'string' && requestedModel.trim() ? normalizeRequestedModel(provider.providerName, requestedModel.trim()) : undefined,
          metadata: { requestedBy: user.email },
        });
      } else {
        sessionId = clientSession;
        if (typeof requestedModel === 'string' && requestedModel.trim()) {
          updateNativeSessionModel(provider.providerName, sessionId, normalizeRequestedModel(provider.providerName, requestedModel.trim()));
        }
      }
    }

    assertGatewaySessionAccess(sessionId, user, { providerName: provider.providerName });

    if (requestedModel && isOpenClawProvider) {
      try {
        if (!requestedModel.includes('/')) {
          console.warn(`[gateway-ws] Rejecting bare model name without provider prefix: "${requestedModel}". Select a fully-qualified model ID.`);
          wsSend(ws, { type: 'error', content: `Invalid model "${requestedModel}": must include provider prefix (e.g. openai-codex/gpt-5.4). Please reselect your model.` });
          return;
        }
        await patchSessionModel(sessionId, requestedModel);
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
      });
      if (slashResult.handled) {
        resolvedSessionId = slashResult.sessionId;
        wsSend(ws, { type: 'session', sessionId: slashResult.sessionId, provenance });
        wsSend(ws, { type: 'done', content: slashResult.content || '', provenance, metadata: slashResult.metadata || {} });
        return;
      }
    }

    resolvedSessionId = sessionId;
    wsSend(ws, { type: 'session', sessionId, provenance });

    let gotRealStatus = false;
    const fallbackTimer = setTimeout(() => {
      if (!gotRealStatus) wsSend(ws, { type: 'status', content: `${provider.displayName} is thinking…` });
    }, 2000);

    streamKeepalive = setInterval(() => {
      wsSend(ws, { type: 'keepalive', ts: Date.now() });
    }, 10000);

    if (isOpenClawProvider) {
      // ── Single-path streaming via StreamEventBus ──────────────────────
      // OpenClawProvider.sendMessage() sends chat.send via the persistent WS
      // and internally subscribes to StreamEventBus for its own resolution.
      //
      // We subscribe to the SAME StreamEventBus to forward events to the browser.
      // To avoid double-processing, the provider's internal subscription fires
      // callbacks (onChunk/onStatus) which we intentionally leave as no-ops here.
      // The bus subscription below is the SOLE path to the browser.
      //
      // The provider's sendMessage() returns when the bus publishes 'done' or 'error'.
      // Our subscription below also sees the same 'done'/'error' and cleans up.
      // Because both are subscribing to the SAME event, the order doesn't matter —
      // the 'done' event is emitted once from PersistentGatewayWs, and both
      // subscribers see it in the same publish() call.

      streamEventBus.startStream(sessionId);

      // Subscribe to StreamEventBus for this session.
      // IMPORTANT: We do NOT unsubscribe on 'done'. The agent may yield to a
      // sub-agent (sessions_yield), which causes a chat.final → 'done', but then
      // the agent resumes with a NEW runId when the sub-agent completes. If we
      // unsubscribe on 'done', the resumed run's events are never forwarded.
      // The subscription stays alive until the browser WS closes.
      const unsubBus = streamEventBus.subscribe(sessionId, (evt: StreamEvent) => {
        gotRealStatus = true;
        wsSend(ws, { ...evt, sessionKey: sessionId });
        if (evt.type === 'done') {
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
        if (evt.type === 'error') {
          // Hard error — clean up fully
          if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
          ws.removeListener('close', busCleanup);
          unsubBus();
        }
      });

      const busCleanup = () => { unsubBus(); runWsStreamCleanup(ws, sessionId); };
      ws.once('close', busCleanup);

      // Register so handleWsAbort can tear down this subscription
      registerWsStreamCleanup(ws, sessionId, () => {
        if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
        ws.removeListener('close', busCleanup);
        unsubBus();
      });

      // No-op callbacks — all events go through StreamEventBus above
      const onChunk = (_chunk: string) => {};
      const onStatus = (_evt: { type: string; content?: string; [key: string]: any }) => {};
      const onExecApproval = (_approval: ExecApprovalRequest) => {};
      const senderIdentity = { label: user.email, userId: user.userId };

      try {
        await (provider as any).sendMessage(
          sessionId, message, onChunk, onStatus, onExecApproval, senderIdentity,
        );
        // Promise resolved — bus already published 'done' and our subscriber handled it.
        // Just clean up the fallback timer.
        clearTimeout(fallbackTimer);
      } catch (sendErr: unknown) {
        clearTimeout(fallbackTimer);
        // The provider rejects if chat.send fails or on timeout.
        // The bus subscriber may already have forwarded an 'error' event.
        // Clean up anything remaining.
        if (streamKeepalive) { clearInterval(streamKeepalive); streamKeepalive = null; }
        ws.removeListener('close', busCleanup);
        unsubBus();
        throw sendErr;
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
        wsSend(ws, { type: 'exec_approval', approval: evt.approval });
        return;
      }
      const eventType = evt?.type || 'status';
      wsSend(ws, { ...evt, type: eventType });
    };
    const onExecApproval = (approval: any) => {
      wsSend(ws, { type: 'exec_approval', approval });
    };

    try {
      const result = await (provider as any).sendMessage(
        sessionId,
        message,
        onChunk,
        onStatus,
        onExecApproval,
        { label: user.email, userId: user.userId },
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
    if (resolvedSessionId) streamEventBus.clearStream(resolvedSessionId);
    const errMsg = err instanceof Error ? err.message : String(err);
    wsSend(ws, { type: 'error', content: errMsg });
  }
}

async function handleWsAbort(ws: WebSocket, msg: any, user?: JwtPayload) {
  const sessionKey = resolveOpenClawSessionKey(msg.session, user);
  console.log(`[gateway] ABORT REQUEST: session=${sessionKey} runId=${msg.runId || 'none'}`);
  try {
    if (user) assertGatewaySessionAccess(sessionKey, user);
    const payload: Record<string, string> = { sessionKey };
    if (msg.runId) payload.runId = msg.runId;
    const result = await gatewayRpcCall('chat.abort', payload);
    console.log(`[gateway] ABORT RESULT: ok=${result.ok} error=${result.error || 'none'}`);

    // Tear down the stream subscription for this WS + session.
    // Without this, the subscription stays alive (for sub-agent resume),
    // and any subsequent gateway events for this session (heartbeat, system
    // event, etc.) would re-trigger the frontend into streaming state.
    runWsStreamCleanup(ws, sessionKey);
    streamEventBus.clearStream(sessionKey);

    wsSend(ws, { type: 'abort_result', ok: result.ok, sessionKey });
  } catch (err: any) {
    wsSend(ws, { type: 'abort_result', ok: false, error: err.message });
  }
}


async function handleWsInject(ws: WebSocket, msg: any, user?: JwtPayload) {
  const sessionKey = resolveOpenClawSessionKey(msg.session, user);
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
    assertGatewaySessionAccess(sessionKey, user);
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
    if (isPersistentWsConnected()) {
      const result = await sendApprovalDecision(approvalId, decision);
      if (result.ok) { wsSend(ws, { type: 'approval_result', ok: true, approvalId, decision }); return; }
    }
    const result = await resolveExecApproval(approvalId, decision);
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
function handleWsReconnect(ws: WebSocket, msg: { session?: string }, user?: JwtPayload): void {
  const sessionKey = resolveOpenClawSessionKey(msg.session, user);
  if (!sessionKey) {
    wsSend(ws, { type: 'error', content: 'reconnect requires session' });
    return;
  }

  try {
    if (user) assertGatewaySessionAccess(sessionKey, user);
  } catch (err: any) {
    wsSend(ws, { type: 'error', content: err?.message === 'Admin access required' ? 'Admin access required' : `Reconnect failed: ${err.message}` });
    return;
  }

  const streamInfo = streamEventBus.getStreamStatus(sessionKey);
  if (streamInfo && streamInfo.active) {
    // Stream is active — subscribe and forward events.
    // Include the latest accumulated text so the browser can recover mid-stream.
    const latestText = streamEventBus.getLatestText(sessionKey);
    wsSend(ws, {
      type: 'stream_resume',
      sessionKey,
      phase: streamInfo.phase,
      toolName: streamInfo.toolName || null,
      runId: streamInfo.runId || null,
      content: latestText || undefined,
    });

    const unsub = streamEventBus.subscribe(sessionKey, (evt: StreamEvent) => {
      if (evt.type === 'text') debugLog(`[Gateway] RECONNECT→browser TEXT: len=${(evt.content||'').length} "${(evt.content||'').substring(0, 40)}..."`);
      wsSend(ws, { ...evt, sessionKey });
      // Keep subscription alive on 'done' for sub-agent resume (same as send handler)
      if (evt.type === 'error') unsub();
    });
    ws.once('close', unsub);
    // Register cleanup so abort can tear it down
    registerWsStreamCleanup(ws, sessionKey, unsub);

    debugLog(`[gateway-ws] Client reconnected to active stream: ${sessionKey}`);
  } else {
    // No active stream
    wsSend(ws, { type: 'stream_ended' });
  }
}

/* ─── WS connection handler ────────────────────────────────────────────── */

function handlePortalWsConnection(ws: WebSocket, user: JwtPayload) {
  (ws as any).__portalUser = user;
  portalWsClients.add(ws);
  debugLog(`[gateway-ws] Client connected: ${user.email}`);

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) try { ws.ping(); } catch {}
  }, 15000);

  // Subscribe to global StreamEventBus events.
  // This serves two purposes:
  // 1. Forward compaction events even when no per-session subscriber is active
  // 2. After backend restart, forward ALL stream events for active sessions
  //    before the user re-subscribes via a new send/reconnect request.
  //    Without this, events from PersistentGatewayWs are received but never
  //    reach the browser (no per-session subscriber exists yet).
  const unsubGlobal = streamEventBus.subscribeGlobal((sessionKey, evt) => {
    try {
      assertGatewaySessionAccess(sessionKey, user);
    } catch {
      return;
    }

    // If per-session subscribers exist, they handle forwarding — skip to avoid duplicates.
    const hasSubs = streamEventBus.hasSubscribers(sessionKey);
    if (hasSubs) {
      return;
    }

    // No per-session subscriber: forward the event directly.
    // This covers compaction events AND regular stream events that arrive
    // after a backend restart (before the user re-subscribes).
    if (ws.readyState === WebSocket.OPEN) {
      wsSend(ws, { ...evt, sessionKey });
    }
  });

  ws.on('message', async (raw: Buffer | string) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { wsSend(ws, { type: 'error', content: 'Invalid JSON' }); return; }

    switch (msg.type) {
      case 'history': await handleWsHistory(ws, msg, user); break;
      case 'send':    await handleWsSend(ws, msg, user);    break;
      case 'abort':   await handleWsAbort(ws, msg, user);   break;
      case 'inject':  await handleWsInject(ws, msg, user);  break;
      case 'exec_approval_resolve': await handleWsExecApproval(ws, msg, user); break;
      case 'reconnect': handleWsReconnect(ws, msg, user);   break;
      default: wsSend(ws, { type: 'error', content: `Unknown type: ${msg.type}` });
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
}

/* ─── WS Server setup (called from server.ts) ─────────────────────────── */

let portalWss: WebSocketServer | null = null;
let directWss: WebSocketServer | null = null;

// Per-user connection tracking for direct proxy WebSocket
const directUserConnections = new Map<string, number>();
const MAX_DIRECT_WS_PER_USER = 5;

// Allowlist of gateway methods that the direct proxy can forward
// Device identity for direct WS proxy — loaded once, reused for all proxy connections
// Use the SAME device keys as PersistentGatewayWs — the gateway allows
// multiple connections from the same device with different instanceIds.
// Using separate (unpaired) keys was the P4.5b blocker: "pairing required".
const DIRECT_PROXY_DEVICE_KEYS = getOrCreateDeviceKeys();
const DIRECT_PROXY_CLIENT_ID = 'gateway-client';
const DIRECT_PROXY_CLIENT_MODE = 'backend';
const DIRECT_PROXY_ROLE = 'operator';
const DIRECT_PROXY_SCOPES = ['operator.admin', 'operator.approvals'];
const DIRECT_PROXY_PROTOCOL = 3;

const ALLOWED_GATEWAY_METHODS = new Set([
  'connect',
  'chat.send',
  'chat.abort',
  'chat.history',
  'chat.inject',
  'sessions.list',
  'sessions.get',
  'sessions.resolve',
  'models.list',
]);

/**
 * Handle a direct WebSocket proxy connection.
 * This creates a transparent pipe between the browser and the OpenClaw gateway,
 * with one exception: 'connect' requests have the auth token injected server-side.
 */
function handleDirectProxyConnection(browserWs: WebSocket, user: JwtPayload) {
  const userId = user.userId;
  let directProxyUnsub: (() => void) | null = null;

  // Enforce per-user connection limit
  const currentCount = directUserConnections.get(userId) || 0;
  if (currentCount >= MAX_DIRECT_WS_PER_USER) {
    browserWs.close(4029, 'Too many connections');
    return;
  }
  directUserConnections.set(userId, currentCount + 1);

  const gatewayUrl = getOpenClawWsUrl();
  let gatewayWs: WebSocket | null = null;
  let browserClosed = false;
  let gatewayClosed = false;

  debugLog(`[gateway-direct] Creating proxy for user ${user.email} to ${gatewayUrl}`);

  try {
    gatewayWs = new WebSocket(gatewayUrl);
  } catch (err: any) {
    console.error('[gateway-direct] Failed to connect to gateway:', err.message);
    browserWs.close(1011, 'Gateway connection failed');
    return;
  }

  gatewayWs.on('open', () => {
    debugLog('[gateway-direct] Connected to gateway');
    // Subscribe to the default main session immediately so tool events
    // from PersistentGatewayWs reach the browser even before first chat.send
    if (!directProxyUnsub) {
      const defaultSession = 'agent:main:main';
      directProxyUnsub = streamEventBus.subscribe(defaultSession, (evt: StreamEvent) => {
        console.log(`[gateway-direct] BUS EVENT for ${defaultSession}: type=${evt.type}`);
        if (evt.type === 'tool_start' || evt.type === 'tool_end' || evt.type === 'tool_used') {
          if (browserWs.readyState === WebSocket.OPEN) {
            const toolPayload = evt.type === 'tool_start' ? {
              phase: 'start',
              name: evt.toolName || 'tool',
              toolCallId: undefined,
              args: evt.toolArgs,
            } : {
              phase: 'end',
              name: evt.toolName || 'tool',
              toolCallId: undefined,
              output: (evt as any).toolResult,
            };
            browserWs.send(JSON.stringify({
              type: 'event',
              event: 'agent',
              sessionKey: defaultSession,
              payload: {
                stream: 'tool',
                data: toolPayload,
              },
            }));
          }
        }
      });
      debugLog(`[gateway-direct] Subscribed to StreamEventBus for session ${defaultSession} on connect`);
    }
    // Send a connected event to the browser
    try {
      browserWs.send(JSON.stringify({ type: 'connected' }));
    } catch {}
  });

  // Track browser→gateway id mapping so we can convert string IDs back to numeric
  const idMap = new Map<string, number>(); // gateway string ID → browser numeric ID

  gatewayWs.on('message', (data: Buffer | string) => {
    if (browserClosed) return;
    // Convert response string IDs back to the numeric IDs the browser expects
    try {
      const str = data.toString();
      const msg = JSON.parse(str);

      // VERBOSE DIAGNOSTIC LOGGING
      if (msg.type === 'event') {
        if (msg.event === 'chat') {
          const state = msg.payload?.state;
          const content = msg.payload?.message?.content;
          const textBlocks = Array.isArray(content) ? content.filter((b: any) => b.type === 'text') : [];
          const thinkBlocks = Array.isArray(content) ? content.filter((b: any) => b.type === 'thinking') : [];
          const textLen = textBlocks.reduce((a: number, b: any) => a + (b.text || '').length, 0);
          const thinkLen = thinkBlocks.reduce((a: number, b: any) => a + (b.thinking || b.text || '').length, 0);
          const textPreview = textBlocks.map((b: any) => (b.text || '').substring(0, 60)).join('|');
          console.log(`[DIAG] chat state=${state} textBlocks=${textBlocks.length} textLen=${textLen} thinkBlocks=${thinkBlocks.length} thinkLen=${thinkLen} runId=${msg.payload?.runId||'-'} preview="${textPreview}"`);
        } else if (msg.event === 'agent') {
          const stream = msg.payload?.stream;
          const data = msg.payload?.data;
          console.log(`[DIAG] agent stream=${stream} phase=${data?.phase||'-'} name=${data?.name||'-'} toolCallId=${data?.toolCallId||'-'}`);
        } else {
          console.log(`[DIAG] event=${msg.event}`);
        }
      }

      if (msg.type === 'res' && typeof msg.id === 'string' && idMap.has(msg.id)) {
        const gatewayId = msg.id;
        msg.id = idMap.get(gatewayId)!;
        idMap.delete(gatewayId);
        browserWs.send(JSON.stringify(msg));
        return;
      }
      browserWs.send(data);
    } catch (err: any) {
      // If JSON parse fails, forward raw
      try { browserWs.send(data); } catch {}
    }
  });

  gatewayWs.on('close', (code: number, reason: Buffer) => {
    gatewayClosed = true;
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

  browserWs.on('message', (data: Buffer | string) => {
    if (gatewayClosed || !gatewayWs) return;

    // Parse the message to check if it's a 'connect' request
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      // Not JSON — pass through unchanged (shouldn't happen with JSON-RPC)
      try {
        gatewayWs.send(data);
      } catch {}
      return;
    }

    // Intercept 'connect' requests — build the full signed connect frame server-side
    // The gateway requires auth token + signed device identity, both must be injected
    if (frame.type === 'req' && frame.method === 'connect') {
      debugLog('[gateway-direct] Intercepting connect request to build full signed connect frame');
      const nonce = frame.params?.nonce;
      const fullParams: Record<string, unknown> = {
        auth: { token: getGatewayToken() },
        client: {
          id: DIRECT_PROXY_CLIENT_ID,
          mode: DIRECT_PROXY_CLIENT_MODE,
          version: '1.0.0',
          displayName: `Portal (${user.email})`,
          platform: 'linux',
          instanceId: `portal-direct-${user.userId.substring(0, 8)}`,
        },
        device: buildSignedDevice({
          keys: DIRECT_PROXY_DEVICE_KEYS,
          clientId: DIRECT_PROXY_CLIENT_ID,
          clientMode: DIRECT_PROXY_CLIENT_MODE,
          role: DIRECT_PROXY_ROLE,
          scopes: DIRECT_PROXY_SCOPES,
          token: getGatewayToken(),
          nonce,
        }),
        role: DIRECT_PROXY_ROLE,
        scopes: DIRECT_PROXY_SCOPES,
        caps: ['tool-events'],
        minProtocol: DIRECT_PROXY_PROTOCOL,
        maxProtocol: DIRECT_PROXY_PROTOCOL,
      };

      const stringId = String(frame.id);
      if (typeof frame.id === 'number') {
        idMap.set(stringId, frame.id);
      }

      const fullFrame = {
        type: 'req',
        id: stringId,
        method: 'connect',
        params: fullParams,
      };

      const serialized = JSON.stringify(fullFrame);
      console.log(`[gateway-direct] CONNECT FRAME SENDING: readyState=${gatewayWs.readyState} bufferedAmount=${gatewayWs.bufferedAmount}`);
      console.log('[gateway-direct] CONNECT FRAME SENT:', serialized.substring(0, 800));
      try {
        gatewayWs.send(serialized, (err) => {
          if (err) {
            console.error('[gateway-direct] Send callback error:', err.message);
          } else {
            console.log(`[gateway-direct] CONNECT FRAME CONFIRMED SENT: bufferedAmount=${gatewayWs?.bufferedAmount}`);
          }
        });
      } catch (err: any) {
        console.error('[gateway-direct] Failed to send signed connect:', err.message);
      }
      return;
    }

    // Enforce method allowlist — reject anything not explicitly allowed
    if (frame.type === 'req' && frame.method && !ALLOWED_GATEWAY_METHODS.has(frame.method)) {
      browserWs.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: `Method '${frame.method}' is not allowed` }
      }));
      return;
    }

    // When the browser sends chat.send via direct proxy, subscribe to StreamEventBus
    // for this session so tool events (which are targeted at PersistentGatewayWs and
    // re-emitted to the bus) are forwarded to the browser alongside raw gateway events.
    if (frame.type === 'req' && frame.method === 'chat.send') {
      const sessionKey = frame.params?.sessionKey || frame.params?.session;
      if (sessionKey) {
        // Unsubscribe previous session if switching
        if (directProxyUnsub) {
          directProxyUnsub();
          directProxyUnsub = null;
        }
        directProxyUnsub = streamEventBus.subscribe(sessionKey, (evt: StreamEvent) => {
          console.log(`[gateway-direct] BUS EVENT for ${sessionKey}: type=${evt.type}`);
          // Only forward tool events — gateway already forwards text/final/etc via raw WS
          if (evt.type === 'tool_start' || evt.type === 'tool_end' || evt.type === 'tool_used') {
            if (browserWs.readyState === WebSocket.OPEN) {
              // Send in the same format the frontend's handleDirectGatewayEvent expects
              // for agent stream=tool events
              const toolPayload = evt.type === 'tool_start' ? {
                phase: 'start',
                name: evt.toolName || 'tool',
                toolCallId: undefined,
                args: evt.toolArgs,
              } : {
                phase: 'end',
                name: evt.toolName || 'tool',
                toolCallId: undefined,
                output: (evt as any).toolResult,
              };
              browserWs.send(JSON.stringify({
                type: 'event',
                event: 'agent',
                sessionKey,
                payload: {
                  stream: 'tool',
                  data: toolPayload,
                },
              }));
            }
          }
        });
        debugLog(`[gateway-direct] Subscribed to StreamEventBus for session ${sessionKey}`);
      }
    }

    // Filter out non-standard frame types that the gateway doesn't understand
    // (ping, reconnect, etc. — these are client-side keepalive/session management)
    if (frame.type !== 'req') {
      // Silently drop non-request frames — gateway only accepts 'req' type
      debugLog(`[gateway-direct] Dropping non-req frame type=${frame.type}`);
      return;
    }

    // Pass through request frames — coerce id to string (gateway requires string IDs)
    if (typeof frame.id === 'number') {
      const numericId = frame.id;
      const stringId = String(frame.id);
      frame.id = stringId;
      idMap.set(stringId, numericId);
      try {
        gatewayWs.send(JSON.stringify(frame));
      } catch (err: any) {
        debugLog('[gateway-direct] Failed to forward to gateway:', err.message);
      }
    } else {
      try {
        gatewayWs.send(JSON.stringify(frame));
      } catch (err: any) {
        debugLog('[gateway-direct] Failed to forward to gateway:', err.message);
      }
    }
  });

  browserWs.on('close', (code: number, reason: Buffer) => {
    browserClosed = true;
    debugLog(`[gateway-direct] Browser closed: ${code} ${reason?.toString()}`);

    // Clean up StreamEventBus subscription
    if (directProxyUnsub) { directProxyUnsub(); directProxyUnsub = null; }

    // Decrement per-user connection count
    const count = directUserConnections.get(userId) || 0;
    if (count <= 1) directUserConnections.delete(userId);
    else directUserConnections.set(userId, count - 1);

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
    handleDirectProxyConnection(ws, user);
  });

  // Register upgrade handler for both /api/gateway/ws and /api/gateway/direct
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url || '';
    const isPortalWs = url.startsWith('/api/gateway/ws');
    const isDirectProxy = url.startsWith('/api/gateway/direct');

    if (!isPortalWs && !isDirectProxy) return; // Let other upgrade handlers proceed

    const origin = req.headers.origin;
    if (!isAllowedWebSocketOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authenticate via cookie
    const cookies = parseCookiesWs(req.headers.cookie || '');
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

    prisma.user.findUnique({
      where: { id: user.userId },
      select: { id: true, email: true, role: true, accountStatus: true, isActive: true, sandboxEnabled: true },
    } as any).then((dbUser) => {
      if (!dbUser || !canUseInteractivePortal(dbUser.role, (dbUser as any).accountStatus, dbUser.isActive)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      (req as any).__portalUser = {
        userId: dbUser.id,
        email: dbUser.email,
        role: dbUser.role,
        accountStatus: (dbUser as any).accountStatus,
        sandboxEnabled: !!(dbUser as any).sandboxEnabled,
      };

      // Route to the appropriate WebSocket server
      if (isDirectProxy) {
        directWss!.handleUpgrade(req, socket, head, (ws: any) => {
          directWss!.emit('connection', ws, req);
        });
      } else {
        portalWss!.handleUpgrade(req, socket, head, (ws: any) => {
          portalWss!.emit('connection', ws, req);
        });
      }
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  });

  debugLog('[gateway-ws] Portal WebSocket server attached on /api/gateway/ws and /api/gateway/direct');
}

export default router;
function normalizeRequestedModel(providerName: AgentProviderName, rawModel: string): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  if (providerName === 'OPENCLAW' || providerName === 'OLLAMA' || providerName === 'GEMINI') return model;

  const parts = model.split('/').filter(Boolean);
  if (parts.length < 2) return model;

  const lower = model.toLowerCase();
  if (providerName === 'CLAUDE_CODE' && (lower.startsWith('anthropic/') || lower.startsWith('claude/'))) {
    return parts.slice(1).join('/');
  }
  if (providerName === 'CODEX' && (lower.startsWith('openai-codex/') || lower.startsWith('openai/'))) {
    return parts.slice(1).join('/');
  }
  return model;
}
