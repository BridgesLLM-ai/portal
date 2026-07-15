import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { RuntimeTurnEvent, RuntimeTurnEventType } from './RuntimeTurnEvents';

const DEFAULT_LIMIT = 1000;
const MAX_TEXT_CHARS = 80_000;
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

function appendEventLine(sessionKey: string, dir: string, event: RuntimeTurnEvent): void {
  // Persisted turn events hold conversation content; keep them out of reach
  // of non-root local accounts (modes apply at creation only — the installer
  // repairs pre-existing files).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(historyPathForSession(sessionKey, dir), JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function flushPendingReasoning(sessionKey: string, dir: string): void {
  const pending = pendingReasoningBySession.get(sessionKey);
  if (!pending) return;
  pendingReasoningBySession.delete(sessionKey);
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
      const pending = pendingReasoningBySession.get(sessionKey);
      if (sanitized.replace === true && pending && (pending.runId || '') === (sanitized.runId || '')) {
        pendingReasoningBySession.set(sessionKey, sanitized);
        return;
      }
      flushPendingReasoning(sessionKey, dir);
      pendingReasoningBySession.set(sessionKey, sanitized);
      return;
    }

    flushPendingReasoning(sessionKey, dir);
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
  } catch (err: any) {
    console.warn('[runtime-turn-event-history] Failed to flush pending reasoning:', err?.message || err);
  }

  const filePath = historyPathForSession(sessionKey, dir);
  if (!existsSync(filePath)) return [];

  try {
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-Math.max(limit * 3, limit));
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
      .slice(-Math.max(limit, 1));
  } catch (err: any) {
    console.warn('[runtime-turn-event-history] Failed to read turn events:', err?.message || err);
    return [];
  }
}
