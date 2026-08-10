import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { RuntimeTurnEvent, RuntimeTurnEventType } from './RuntimeTurnEvents';

const DEFAULT_LIMIT = 1000;
const MAX_TEXT_CHARS = 80_000;
const DEFAULT_MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_HISTORY_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_REQUESTED_EVENTS = 50_000;
const PERSISTED_TYPES = new Set<RuntimeTurnEventType>([
  'assistant_status',
  'assistant_reasoning',
  'tool_started',
  'tool_output',
  'assistant_delta',
  'assistant_final',
  'turn_error',
  'turn_done',
]);

function resolveHistoryDir(): string | null {
  const override = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR?.trim();
  if (override) return override;

  // Unit tests opt in with PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR. This keeps
  // StreamEventBus tests from writing into a real install path.
  if (process.env.NODE_ENV === 'test') return null;

  const portalRoot = process.env.PORTAL_ROOT || path.resolve(__dirname, '../../..');
  return path.join(portalRoot, 'backend', '.data', 'runtime-turn-events');
}

function historyPathForSession(sessionKey: string, dir: string): string {
  const digest = createHash('sha256').update(sessionKey || 'main').digest('hex').slice(0, 32);
  return path.join(dir, `${digest}.jsonl`);
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function historyMaxBytes(): number {
  return positiveEnvNumber('PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_BYTES', DEFAULT_MAX_HISTORY_BYTES);
}

function historyMaxReadBytes(): number {
  return positiveEnvNumber('PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_READ_BYTES', DEFAULT_MAX_READ_BYTES);
}

function historyMaxAgeMs(): number {
  return positiveEnvNumber('PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_AGE_MS', DEFAULT_MAX_HISTORY_AGE_MS);
}

function rotatedHistoryPath(filePath: string): string {
  return `${filePath}.1`;
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed;
}

// Delta/reasoning text keeps its exact whitespace so chunk boundaries can be
// reassembled without fusing words or inventing separators. Length is still
// capped to bound the history file.
function capText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
}

function sanitizeEvent(event: RuntimeTurnEvent): RuntimeTurnEvent | null {
  if (!event || event.schema !== 'bridgesllm.runtime-turn-event.v1') return null;
  if (!event.sessionKey || !PERSISTED_TYPES.has(event.type)) return null;

  const preserveExactText = event.type === 'assistant_delta' || event.type === 'assistant_reasoning';
  const text = preserveExactText ? capText(event.text) : trimText(event.text);
  const toolResult = trimText(event.tool?.result);
  return {
    ...event,
    ...(text ? { text } : { text: undefined }),
    ...(event.tool
      ? {
          tool: {
            ...event.tool,
            ...(toolResult ? { result: toolResult } : { result: undefined }),
          },
        }
      : {}),
  };
}

// Reasoning snapshots on OpenClaw 2026.7.1 stream as replace-style events that
// each carry the full thought so far. Persisting every intermediate snapshot
// would bloat the JSONL history by orders of magnitude on long thoughts, so
// consecutive replace snapshots for the same run collapse into one pending
// event that is flushed when the thought settles (next non-replace event,
// turn end, or a history read).
const pendingReasoningBySession = new Map<string, RuntimeTurnEvent>();
const pendingStatusBySession = new Map<string, RuntimeTurnEvent>();
const lastRunBySession = new Map<string, string>();

function rotateHistoryFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const rotated = rotatedHistoryPath(filePath);
  if (existsSync(rotated)) unlinkSync(rotated);
  renameSync(filePath, rotated);
}

function maybeRotateHistory(
  sessionKey: string,
  filePath: string,
  event: RuntimeTurnEvent,
  phase: 'before' | 'after',
): void {
  if (!existsSync(filePath)) return;
  const stats = statSync(filePath);
  const overLimit = stats.size >= historyMaxBytes();
  const tooOld = Date.now() - stats.mtimeMs >= historyMaxAgeMs();
  if (!overLimit && !tooOld) return;

  const runId = String(event.runId || '').trim();
  const previousRunId = lastRunBySession.get(sessionKey) || '';
  const startsNewRun = phase === 'before' && (!previousRunId || (runId && runId !== previousRunId));
  const closesRun = phase === 'after' && (event.type === 'turn_done' || event.type === 'turn_error');
  if (startsNewRun || closesRun) rotateHistoryFile(filePath);
}

function appendEventLine(sessionKey: string, dir: string, event: RuntimeTurnEvent): void {
  // Persisted turn events hold conversation content; keep them out of reach
  // of non-root local accounts (modes apply at creation only — the installer
  // repairs pre-existing files).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = historyPathForSession(sessionKey, dir);
  maybeRotateHistory(sessionKey, filePath, event, 'before');
  appendFileSync(filePath, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  lastRunBySession.set(sessionKey, String(event.runId || '').trim());
  maybeRotateHistory(sessionKey, filePath, event, 'after');
}

function flushPendingReasoning(sessionKey: string, dir: string): void {
  const pending = pendingReasoningBySession.get(sessionKey);
  if (!pending) return;
  pendingReasoningBySession.delete(sessionKey);
  appendEventLine(sessionKey, dir, pending);
}

function flushPendingStatus(sessionKey: string, dir: string): void {
  const pending = pendingStatusBySession.get(sessionKey);
  if (!pending) return;
  pendingStatusBySession.delete(sessionKey);
  appendEventLine(sessionKey, dir, pending);
}

export function recordRuntimeTurnEvent(sessionKey: string, event: RuntimeTurnEvent): void {
  if (!sessionKey || process.env.PORTAL_DISABLE_RUNTIME_TURN_EVENT_HISTORY === '1') return;
  const dir = resolveHistoryDir();
  if (!dir) return;

  const sanitized = sanitizeEvent(event);
  if (!sanitized) return;

  try {
    if (sanitized.type === 'assistant_reasoning') {
      flushPendingStatus(sessionKey, dir);
      const pending = pendingReasoningBySession.get(sessionKey);
      const sameReasoningLane = Boolean(sanitized.source?.preambleProgress)
        === Boolean(pending?.source?.preambleProgress);
      if (
        sanitized.replace === true
        && pending
        && sameReasoningLane
        && (pending.runId || '') === (sanitized.runId || '')
      ) {
        pendingReasoningBySession.set(sessionKey, sanitized);
        return;
      }
      flushPendingReasoning(sessionKey, dir);
      pendingReasoningBySession.set(sessionKey, sanitized);
      return;
    }

    if (sanitized.type === 'assistant_status' && sanitized.replace === true) {
      flushPendingReasoning(sessionKey, dir);
      const pending = pendingStatusBySession.get(sessionKey);
      if (pending && (pending.runId || '') !== (sanitized.runId || '')) {
        flushPendingStatus(sessionKey, dir);
      }
      pendingStatusBySession.set(sessionKey, sanitized);
      return;
    }

    flushPendingReasoning(sessionKey, dir);
    flushPendingStatus(sessionKey, dir);
    appendEventLine(sessionKey, dir, sanitized);
  } catch (err: any) {
    console.warn('[runtime-turn-event-history] Failed to record turn event:', err?.message || err);
  }
}

export function readRuntimeTurnEvents(sessionKey: string, limit = DEFAULT_LIMIT): RuntimeTurnEvent[] {
  if (!sessionKey || limit <= 0) return [];
  const dir = resolveHistoryDir();
  if (!dir) return [];

  // Mid-turn reads (resume replay, history fetch) must see the live thought.
  try {
    flushPendingReasoning(sessionKey, dir);
    flushPendingStatus(sessionKey, dir);
  } catch (err: any) {
    console.warn('[runtime-turn-event-history] Failed to flush pending reasoning:', err?.message || err);
  }

  const filePath = historyPathForSession(sessionKey, dir);
  const rotatedPath = rotatedHistoryPath(filePath);
  if (!existsSync(filePath) && !existsSync(rotatedPath)) return [];

  try {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_REQUESTED_EVENTS);
    const lineBudget = Math.min(Math.max(safeLimit * 2, safeLimit), MAX_REQUESTED_EVENTS * 2);
    const currentLines = readJsonlTail(filePath, lineBudget, historyMaxReadBytes());
    const remaining = Math.max(lineBudget - currentLines.length, 0);
    const rotatedLines = remaining > 0
      ? readJsonlTail(rotatedPath, remaining, historyMaxReadBytes())
      : [];
    const lines = [...rotatedLines, ...currentLines];
    const seen = new Set<string>();
    const events: RuntimeTurnEvent[] = [];

    for (const line of lines) {
      let parsed: RuntimeTurnEvent | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const event = parsed ? sanitizeEvent(parsed) : null;
      if (!event) continue;

      const key = [
        event.runId || '',
        event.seq,
        event.ts,
        event.type,
        event.text || '',
        event.tool?.id || '',
        event.tool?.name || '',
        event.tool?.status || '',
      ].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }

    return events
      .sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))
      .slice(-safeLimit);
  } catch (err: any) {
    console.warn('[runtime-turn-event-history] Failed to read turn events:', err?.message || err);
    return [];
  }
}

/**
 * Read only the newest complete JSONL records. The old implementation loaded
 * and split the entire lifetime file synchronously on every history refresh;
 * a multi-hour agent turn could briefly allocate many times the file size and
 * stall the Node event loop. This bounded tail reader touches only the bytes
 * required for the requested replay window.
 */
function readJsonlTail(filePath: string, maxLines: number, maxBytes: number): string[] {
  if (maxLines <= 0 || maxBytes <= 0 || !existsSync(filePath)) return [];
  const size = statSync(filePath).size;
  if (size <= 0) return [];

  const fd = openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  let position = size;
  let bytesReadTotal = 0;
  let newlineCount = 0;
  try {
    while (position > 0 && bytesReadTotal < maxBytes && newlineCount <= maxLines) {
      const chunkSize = Math.min(READ_CHUNK_BYTES, position, maxBytes - bytesReadTotal);
      if (chunkSize <= 0) break;
      position -= chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const bytesRead = readSync(fd, buffer, 0, chunkSize, position);
      const chunk = bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesReadTotal += bytesRead;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 10) newlineCount += 1;
      }
    }
  } finally {
    closeSync(fd);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  let lines = text.split('\n');
  // A bounded tail may begin inside a UTF-8/JSON record. Drop that partial
  // record; every later newline-delimited event remains intact.
  if (position > 0) lines = lines.slice(1);
  return lines.filter((line) => line.trim()).slice(-maxLines);
}

export const __runtimeTurnEventHistoryTest = {
  readJsonlTail,
  historyPathForSession,
};
