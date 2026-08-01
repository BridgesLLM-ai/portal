import type { StreamEvent, StreamInfo, StreamToolCall } from './StreamEventBus';
import { sanitizeThinkingSubject } from '../utils/thinkingSubject';

export type RuntimeTurnEventType =
  | 'assistant_started'
  | 'assistant_status'
  | 'assistant_reasoning'
  | 'tool_started'
  | 'tool_output'
  | 'source_reply'
  | 'assistant_delta'
  | 'assistant_final'
  | 'turn_error'
  | 'turn_done';

export interface RuntimeTurnToolSnapshot {
  id?: string;
  name: string;
  status?: 'running' | 'done' | 'error';
  arguments?: unknown;
  result?: string;
}

export interface RuntimeTurnEvent {
  schema: 'bridgesllm.runtime-turn-event.v1';
  type: RuntimeTurnEventType;
  sessionKey: string;
  runId?: string;
  seq: number;
  ts: number;
  text?: string;
  subject?: string;
  replace?: boolean;
  visible: boolean;
  terminal?: boolean;
  model?: string;
  provenance?: string;
  tool?: RuntimeTurnToolSnapshot;
  source: {
    transport: 'portal-stream-event-bus';
    eventType: StreamEvent['type'];
    eventProvenance?: string;
  };
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function latestRunningTool(info?: StreamInfo | null): StreamToolCall | null {
  const calls = Array.isArray(info?.toolCalls) ? info!.toolCalls : [];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i]?.status === 'running') return calls[i];
  }
  return null;
}

function normalizeToolStatus(event: StreamEvent): RuntimeTurnToolSnapshot['status'] | undefined {
  if (event.isError === true) return 'error';
  if (typeof event.exitCode === 'number' && Number.isFinite(event.exitCode) && event.exitCode !== 0) return 'error';
  const value = typeof event.status === 'string' ? event.status.trim().toLowerCase() : '';
  if (value === 'running' || value === 'done' || value === 'error') return value;
  if (['failed', 'failure', 'cancelled', 'canceled', 'aborted', 'denied'].includes(value)) return 'error';
  if (['complete', 'completed', 'success', 'succeeded', 'ok'].includes(value)) return 'done';
  return undefined;
}

function eventModel(event: StreamEvent, info?: StreamInfo | null): string | undefined {
  const explicit = cleanText(event.model);
  if (explicit) return explicit;
  const tracked = cleanText(info?.model);
  return tracked || undefined;
}

function eventProvenance(event: StreamEvent, info?: StreamInfo | null): string | undefined {
  const explicit = cleanText(event.provenance);
  if (explicit) return explicit;
  const tracked = cleanText(info?.provenance);
  return tracked || undefined;
}

export function normalizeRuntimeTurnEvent(params: {
  sessionKey: string;
  event: StreamEvent;
  info?: StreamInfo | null;
  seq: number;
  now?: number;
}): RuntimeTurnEvent | null {
  const { sessionKey, event, info, seq } = params;
  const now = params.now ?? Date.now();
  const text = cleanText(event.content);
  const subject = sanitizeThinkingSubject(event.subject);
  const runId = cleanText(event.runId) || cleanText(info?.runId) || undefined;
  const model = eventModel(event, info);
  const provenance = eventProvenance(event, info);

  const base = (type: RuntimeTurnEventType, extra?: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({
    schema: 'bridgesllm.runtime-turn-event.v1',
    type,
    sessionKey,
    ...(runId ? { runId } : {}),
    seq,
    ts: now,
    visible: false,
    ...(model ? { model } : {}),
    ...(provenance ? { provenance } : {}),
    ...(event.replace === true ? { replace: true } : {}),
    source: {
      transport: 'portal-stream-event-bus',
      eventType: event.type,
      ...(cleanText(event.provenance) ? { eventProvenance: cleanText(event.provenance) } : {}),
    },
    ...extra,
  });

  switch (event.type) {
    // Streaming deltas must keep their exact whitespace: a chunk can split a
    // word in half or carry the only space/newline between two words, so
    // trimming here makes faithful reassembly impossible downstream (words
    // fuse together or grow phantom separators).
    case 'text': {
      const rawText = typeof event.content === 'string' ? event.content : '';
      if (!rawText) return null;
      return base('assistant_delta', { text: rawText, visible: true });
    }

    case 'thinking': {
      const rawThinking = typeof event.content === 'string' ? event.content : '';
      if (!rawThinking.trim() && !subject) return null;
      return base('assistant_reasoning', {
        ...(rawThinking ? { text: rawThinking } : {}),
        ...(subject ? { subject } : {}),
        visible: true,
      });
    }

    case 'status':
    case 'run_resumed':
    case 'compaction_start':
    case 'compaction_end':
      return base('assistant_status', {
        ...(text ? { text } : {}),
        visible: Boolean(text),
      });

    case 'tool_start': {
      const name = cleanText(event.toolName) || cleanText(event.name) || cleanText(latestRunningTool(info)?.name) || 'tool';
      return base('tool_started', {
        visible: true,
        ...(text ? { text } : {}),
        tool: {
          id: cleanText(event.toolCallId) || cleanText(latestRunningTool(info)?.id) || undefined,
          name,
          status: 'running',
          arguments: event.toolArgs,
        },
      });
    }

    case 'tool_update':
    case 'tool_end':
    case 'tool_used': {
      const name = cleanText(event.toolName) || cleanText(event.name) || cleanText(latestRunningTool(info)?.name) || 'tool';
      return base('tool_output', {
        visible: true,
        ...(text ? { text } : {}),
        tool: {
          id: cleanText(event.toolCallId) || cleanText(latestRunningTool(info)?.id) || undefined,
          name,
          status: event.type === 'tool_update' ? 'running' : (normalizeToolStatus(event) || 'done'),
          result: cleanText(event.toolResult) || text || undefined,
        },
      });
    }

    case 'done':
      if (text) {
        return base('assistant_final', { text, visible: true, terminal: true });
      }
      return base('turn_done', { visible: false, terminal: true });

    case 'error':
      if (event.terminal !== true) {
        return base('assistant_status', {
          ...(text ? { text } : {}),
          visible: Boolean(text),
        });
      }
      return base('turn_error', {
        ...(text ? { text } : {}),
        visible: true,
        terminal: true,
      });

    case 'segment_break':
      return base('assistant_status', { visible: false });

    default:
      return null;
  }
}
