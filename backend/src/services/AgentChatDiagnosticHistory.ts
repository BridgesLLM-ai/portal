import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import type {
  StreamEvent,
  StreamEventPresentationPolicy,
} from './StreamEventBus';

export type AgentChatDiagnosticSeverity = 'info' | 'warning' | 'error';
export type AgentChatDiagnosticCategory = 'maintenance' | 'lifecycle' | 'runtime';

export interface AgentChatDiagnosticEvent {
  schema: 'bridgesllm.agent-chat-diagnostic.v1';
  id: string;
  timestamp: string;
  severity: AgentChatDiagnosticSeverity;
  category: AgentChatDiagnosticCategory;
  title: string;
  detail: string;
  sourceType: string;
  presentation: 'rail' | 'banner' | 'internal';
  runId?: string;
}

export interface AgentChatDiagnosticHistoryPage {
  events: AgentChatDiagnosticEvent[];
  truncated: boolean;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DEFAULT_MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_HISTORY_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const READ_CHUNK_BYTES = 128 * 1024;
const MAX_RECORD_BYTES = 4 * 1024;
const DUPLICATE_WINDOW_MS = 5_000;

const recentSignatureBySession = new Map<string, { signature: string; timestamp: number }>();

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveHistoryDir(): string | null {
  const override = process.env.PORTAL_AGENT_CHAT_DIAGNOSTIC_HISTORY_DIR?.trim();
  if (override) return override;
  if (process.env.NODE_ENV === 'test') return null;
  const portalRoot = process.env.PORTAL_ROOT || path.resolve(__dirname, '../../..');
  return path.join(portalRoot, 'backend', '.data', 'agent-chat-diagnostics');
}

function historyPathForSession(sessionKey: string, dir: string): string {
  const digest = createHash('sha256').update(sessionKey || 'main').digest('hex').slice(0, 32);
  return path.join(dir, `${digest}.jsonl`);
}

function rotatedHistoryPath(filePath: string): string {
  return `${filePath}.1`;
}

function safeRunId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9._:@/-]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function maintenanceDetail(content: unknown): string {
  const text = typeof content === 'string' ? content.toLowerCase() : '';
  if (text.includes('heartbeat')) return 'The scheduled heartbeat checked session health.';
  if (text.includes('memory') || text.includes('flush')) return 'Durable memory maintenance ran outside the conversation timeline.';
  if (text.includes('compact')) return 'Context compaction ran outside the conversation timeline.';
  return 'Routine context maintenance ran outside the conversation timeline.';
}

/**
 * Convert a transport event into a browser-safe operational audit record.
 * Raw provider text, tool arguments/results, prompts, and model output are
 * deliberately excluded: the drawer is an audit surface, not a second transcript.
 */
export function classifyAgentChatDiagnosticEvent(params: {
  event: StreamEvent;
  policy: StreamEventPresentationPolicy;
  now?: number;
}): Omit<AgentChatDiagnosticEvent, 'id'> | null {
  const { event, policy } = params;
  const now = params.now ?? Date.now();
  const runId = safeRunId(event.runId);
  const base = {
    schema: 'bridgesllm.agent-chat-diagnostic.v1' as const,
    timestamp: new Date(now).toISOString(),
    sourceType: event.type,
    presentation: (policy.presentation === 'banner'
      ? 'banner'
      : policy.presentation === 'internal'
        ? 'internal'
        : 'rail') as AgentChatDiagnosticEvent['presentation'],
    ...(runId ? { runId } : {}),
  };

  if (event.type === 'compaction_start') {
    return {
      ...base,
      severity: 'info',
      category: 'maintenance',
      title: 'Context compaction started',
      detail: 'The harness began compacting context; no conversation card was created.',
    };
  }
  if (event.type === 'compaction_end') {
    return {
      ...base,
      severity: event.completed === false && event.maintenanceKind !== 'maintenance' ? 'warning' : 'info',
      category: 'maintenance',
      title: event.maintenanceKind === 'maintenance'
        ? 'Context maintenance finished'
        : event.completed === false
          ? 'Context compaction did not confirm completion'
          : 'Context compaction completed',
      detail: event.completed === false && event.maintenanceKind !== 'maintenance'
        ? 'The harness ended the compaction event without a confirmed completion result.'
        : 'The maintenance event remained outside the conversation timeline.',
    };
  }
  if (event.type === 'status' && event.maintenanceKind === 'maintenance') {
    return {
      ...base,
      severity: policy.presentation === 'banner' ? 'warning' : 'info',
      category: 'maintenance',
      title: 'Context maintenance update',
      detail: maintenanceDetail(event.content),
    };
  }
  if (event.type === 'run_resumed') {
    return {
      ...base,
      severity: 'info',
      category: 'lifecycle',
      title: 'Runtime stream resumed',
      detail: 'The Portal reattached to the harness stream for this session.',
    };
  }
  if (event.type === 'history_changed') {
    return {
      ...base,
      severity: 'info',
      category: 'lifecycle',
      title: 'Session history changed',
      detail: 'The harness reported a session-history change; the conversation projection can be refreshed.',
    };
  }
  if (event.type === 'error') {
    const terminal = event.terminal === true;
    return {
      ...base,
      severity: terminal ? 'error' : 'warning',
      category: 'runtime',
      title: terminal ? 'Harness run failed' : 'Harness runtime warning',
      detail: terminal
        ? 'The harness reported a terminal run failure. Recovery details remain in the actionable banner.'
        : 'The harness reported a recoverable runtime warning.',
    };
  }
  if (event.type === 'done') {
    return {
      ...base,
      severity: 'info',
      category: 'lifecycle',
      title: 'Harness turn completed',
      detail: 'The harness emitted its terminal completion event.',
    };
  }

  return null;
}

function rotateIfNeeded(filePath: string, now: number): void {
  if (!existsSync(filePath)) return;
  const stats = statSync(filePath);
  const maxBytes = positiveEnvNumber(
    'PORTAL_AGENT_CHAT_DIAGNOSTIC_HISTORY_MAX_BYTES',
    DEFAULT_MAX_HISTORY_BYTES,
  );
  const maxAgeMs = positiveEnvNumber(
    'PORTAL_AGENT_CHAT_DIAGNOSTIC_HISTORY_MAX_AGE_MS',
    DEFAULT_MAX_HISTORY_AGE_MS,
  );
  if (stats.size < maxBytes && now - stats.mtimeMs < maxAgeMs) return;
  const rotated = rotatedHistoryPath(filePath);
  if (existsSync(rotated)) unlinkSync(rotated);
  renameSync(filePath, rotated);
}

function appendRecord(filePath: string, serialized: string): void {
  const flags = fsConstants.O_CREAT
    | fsConstants.O_APPEND
    | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags, 0o600);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error('Diagnostic history target is not a regular file');
    writeSync(fd, serialized, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordAgentChatDiagnosticEvent(params: {
  sessionKey: string;
  event: StreamEvent;
  policy: StreamEventPresentationPolicy;
  now?: number;
}): void {
  const sessionKey = String(params.sessionKey || '').trim();
  if (!sessionKey || process.env.PORTAL_DISABLE_AGENT_CHAT_DIAGNOSTIC_HISTORY === '1') return;
  const dir = resolveHistoryDir();
  if (!dir) return;
  const now = params.now ?? Date.now();
  const classified = classifyAgentChatDiagnosticEvent({
    event: params.event,
    policy: params.policy,
    now,
  });
  if (!classified) return;

  const signature = [
    classified.sourceType,
    classified.severity,
    classified.title,
    classified.runId || '',
  ].join('\u0000');
  const previous = recentSignatureBySession.get(sessionKey);
  if (previous && previous.signature === signature && now - previous.timestamp < DUPLICATE_WINDOW_MS) {
    return;
  }

  const record: AgentChatDiagnosticEvent = { ...classified, id: randomUUID() };
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) return;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = historyPathForSession(sessionKey, dir);
    rotateIfNeeded(filePath, now);
    appendRecord(filePath, serialized);
    recentSignatureBySession.set(sessionKey, { signature, timestamp: now });
  } catch (error: any) {
    console.warn('[agent-chat-diagnostics] Failed to record session event:', error?.message || error);
  }
}

function validDiagnosticEvent(value: unknown): AgentChatDiagnosticEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AgentChatDiagnosticEvent>;
  if (
    candidate.schema !== 'bridgesllm.agent-chat-diagnostic.v1'
    || typeof candidate.id !== 'string'
    || typeof candidate.timestamp !== 'string'
    || !['info', 'warning', 'error'].includes(String(candidate.severity))
    || !['maintenance', 'lifecycle', 'runtime'].includes(String(candidate.category))
    || typeof candidate.title !== 'string'
    || typeof candidate.detail !== 'string'
    || typeof candidate.sourceType !== 'string'
    || !['rail', 'banner', 'internal'].includes(String(candidate.presentation))
  ) return null;
  const timestamp = Date.parse(candidate.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  return candidate as AgentChatDiagnosticEvent;
}

function readJsonlTail(filePath: string, maxBytes: number): { lines: string[]; truncated: boolean; bytesRead: number } {
  if (!existsSync(filePath) || maxBytes <= 0) return { lines: [], truncated: false, bytesRead: 0 };
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags);
  const chunks: Buffer[] = [];
  let position = 0;
  let bytesReadTotal = 0;
  let size = 0;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { lines: [], truncated: false, bytesRead: 0 };
    size = stats.size;
    position = size;
    while (position > 0 && bytesReadTotal < maxBytes) {
      const chunkSize = Math.min(READ_CHUNK_BYTES, position, maxBytes - bytesReadTotal);
      position -= chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const bytesRead = readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead <= 0) break;
      chunks.unshift(buffer.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  let text = Buffer.concat(chunks).toString('utf8');
  const truncated = position > 0;
  if (truncated) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  return {
    lines: text.split('\n').filter(Boolean),
    truncated,
    bytesRead: bytesReadTotal,
  };
}

export function readAgentChatDiagnosticHistory(
  sessionKey: string,
  limit = DEFAULT_LIMIT,
): AgentChatDiagnosticHistoryPage {
  const normalizedSession = String(sessionKey || '').trim();
  const dir = resolveHistoryDir();
  if (!normalizedSession || !dir) return { events: [], truncated: false };
  const filePath = historyPathForSession(normalizedSession, dir);
  const rotatedPath = rotatedHistoryPath(filePath);
  if (!existsSync(filePath) && !existsSync(rotatedPath)) return { events: [], truncated: false };

  const safeLimit = Math.min(Math.max(Math.floor(limit || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const maxReadBytes = positiveEnvNumber(
    'PORTAL_AGENT_CHAT_DIAGNOSTIC_HISTORY_MAX_READ_BYTES',
    DEFAULT_MAX_READ_BYTES,
  );

  try {
    const current = readJsonlTail(filePath, maxReadBytes);
    const remainingBytes = Math.max(maxReadBytes - current.bytesRead, 0);
    const rotated = remainingBytes > 0
      ? readJsonlTail(rotatedPath, remainingBytes)
      : { lines: [], truncated: existsSync(rotatedPath), bytesRead: 0 };
    const parsed: AgentChatDiagnosticEvent[] = [];
    for (const line of [...rotated.lines, ...current.lines]) {
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) continue;
      try {
        const event = validDiagnosticEvent(JSON.parse(line));
        if (event) parsed.push(event);
      } catch {
        // Ignore interrupted/corrupt tail records without exposing them.
      }
    }
    parsed.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    return {
      events: parsed.slice(-safeLimit),
      truncated: current.truncated || rotated.truncated || parsed.length > safeLimit,
    };
  } catch (error: any) {
    console.warn('[agent-chat-diagnostics] Failed to read session events:', error?.message || error);
    return { events: [], truncated: false };
  }
}
