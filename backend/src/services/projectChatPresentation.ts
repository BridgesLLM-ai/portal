import type { ProjectNativeRunEvent } from './projectNativeRunBroker';
import { sanitizeThinkingSubject } from '../utils/thinkingSubject';

const PRESENTATION_VERSION = 2;
export const PROJECT_CHAT_PRESENTATION_MAX_BYTES = 192 * 1024;
const MAX_SEGMENTS = 192;
const MAX_TOOL_CALLS = 96;
const MAX_SEGMENT_CHARS = 24_000;
const MAX_TOOL_NAME_CHARS = 512;
const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_TOOL_ARGUMENT_CHARS = 12_000;

export type ProjectChatPresentationTerminalStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'aborted'
  | 'expired';

export interface PersistedProjectChatToolCall {
  id: string;
  name: string;
  arguments?: unknown;
  result?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error';
  order?: number;
}

export interface PersistedProjectChatSegment {
  text: string;
  subject?: string;
  position: 'before' | 'between' | 'after';
  kind: 'text' | 'thinking';
  ts: number;
  order: number;
}

export interface ProjectChatMessagePresentation {
  version: typeof PRESENTATION_VERSION;
  /** Version-one compatibility only. Version two persists ordered segments. */
  thinkingContent?: string;
  toolCalls?: PersistedProjectChatToolCall[];
  segments?: PersistedProjectChatSegment[];
  truncated?: boolean;
}

export function projectChatPresentationMaterializationMarker(
  resultMetadata: unknown,
): boolean | null {
  if (!resultMetadata || typeof resultMetadata !== 'object' || Array.isArray(resultMetadata)) return null;
  if (!Object.prototype.hasOwnProperty.call(resultMetadata, 'presentationMaterialized')) return null;
  return (resultMetadata as Record<string, unknown>).presentationMaterialized === true;
}

/**
 * Pre-migration terminal turns have no marker and must never be re-projected
 * from a GET. A false marker is an explicit failed materialization; a true
 * marker is idempotently complete unless a persisted tool was left running.
 */
export function shouldRepairProjectChatPresentation(input: {
  resultMetadata: unknown;
  presentation: ProjectChatMessagePresentation | null;
}): boolean {
  const marker = projectChatPresentationMaterializationMarker(input.resultMetadata);
  if (marker === null) return false;
  if (marker === false) return true;
  return input.presentation?.toolCalls?.some((tool) => tool.status === 'running') === true;
}

/**
 * Database recovery reads newest-first so it can retain the terminal edge of
 * very long turns. Return the bounded tail in canonical ascending sequence
 * order and report when earlier evidence was omitted.
 */
export function retainNewestProjectChatPresentationEvents<T>(
  newestFirst: readonly T[],
  limit: number,
): { events: T[]; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Project Chat presentation event limit must be a positive integer');
  }
  return {
    events: newestFirst.slice(0, limit).reverse(),
    truncated: newestFirst.length > limit,
  };
}

function boundedString(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 12))}…[truncated]` : text;
}

function boundedJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_TOOL_ARGUMENT_CHARS) return JSON.parse(serialized);
    return `${serialized.slice(0, MAX_TOOL_ARGUMENT_CHARS - 12)}…[truncated]`;
  } catch {
    return '[unavailable]';
  }
}

function mergeStreamText(current: string, incoming: unknown, replace = false): string {
  const chunk = boundedString(incoming, MAX_SEGMENT_CHARS);
  if (!chunk) return current;
  if (replace) return chunk;
  if (!current) return chunk;
  if (chunk.startsWith(current)) return chunk.slice(0, MAX_SEGMENT_CHARS);
  if (current.endsWith(chunk)) return current;
  return `${current}${chunk}`.slice(0, MAX_SEGMENT_CHARS);
}

function safeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeToolStatus(value: unknown, exitCode?: unknown): 'done' | 'error' {
  if (String(value || '').toLowerCase() === 'error') return 'error';
  if (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0) return 'error';
  return 'done';
}

function findToolIndex(
  tools: PersistedProjectChatToolCall[],
  event: ProjectNativeRunEvent,
): number {
  const callId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
  if (callId) return tools.findIndex((tool) => tool.id === callId);
  const name = typeof event.toolName === 'string' ? event.toolName : '';
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index].status === 'running' && (!name || tools[index].name === name)) return index;
  }
  return -1;
}

function appendTool(
  tools: PersistedProjectChatToolCall[],
  event: ProjectNativeRunEvent,
  status: 'running' | 'done' | 'error',
): PersistedProjectChatToolCall {
  const startedAt = safeTimestamp(event.ts, Date.now());
  const tool: PersistedProjectChatToolCall = {
    id: boundedString(event.toolCallId || `project-tool-${event.seq}`, 256),
    name: boundedString(event.toolName || 'tool', MAX_TOOL_NAME_CHARS) || 'tool',
    startedAt,
    status,
    order: event.seq,
  };
  const args = boundedJsonValue(event.toolArgs);
  if (args !== undefined) tool.arguments = args;
  const result = boundedString(event.toolResult ?? event.content, MAX_TOOL_RESULT_CHARS);
  if (result) tool.result = result;
  if (status !== 'running') tool.endedAt = startedAt;
  tools.push(tool);
  if (tools.length > MAX_TOOL_CALLS) tools.splice(0, tools.length - MAX_TOOL_CALLS);
  return tool;
}

function presentationBytes(value: ProjectChatMessagePresentation): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Enforce one aggregate persistence budget. Per-field caps alone are not a
 * meaningful bound when a turn contains many tools, so oldest presentation
 * detail is discarded until the complete JSON envelope is within budget.
 */
function enforceAggregateBudget(input: ProjectChatMessagePresentation): ProjectChatMessagePresentation {
  const output: ProjectChatMessagePresentation = {
    ...input,
    toolCalls: input.toolCalls ? [...input.toolCalls] : undefined,
    segments: input.segments ? [...input.segments] : undefined,
  };
  let truncated = input.truncated === true;
  while (presentationBytes(output) > PROJECT_CHAT_PRESENTATION_MAX_BYTES) {
    const segments = output.segments || [];
    const tools = output.toolCalls || [];
    if (segments.length > 1 || tools.length > 1) {
      const oldestSegment = segments[0];
      const oldestTool = tools[0];
      if (oldestSegment && (!oldestTool || oldestSegment.ts <= oldestTool.startedAt)) segments.shift();
      else tools.shift();
      truncated = true;
      continue;
    }
    if (segments[0]?.text && segments[0].text.length > 512) {
      segments[0] = { ...segments[0], text: boundedString(segments[0].text, Math.max(512, Math.floor(segments[0].text.length / 2))) };
      truncated = true;
      continue;
    }
    if (tools[0]?.result && tools[0].result!.length > 512) {
      tools[0] = { ...tools[0], result: boundedString(tools[0].result, Math.max(512, Math.floor(tools[0].result.length / 2))) };
      truncated = true;
      continue;
    }
    // Defensive final fallback. The fixed metadata envelope is far smaller
    // than the budget, so this can only be reached for pathological values.
    output.segments = undefined;
    output.toolCalls = undefined;
    truncated = true;
    break;
  }
  if (truncated) output.truncated = true;
  return output;
}

function terminalToolResult(status: ProjectChatPresentationTerminalStatus): string {
  if (status === 'aborted') return '[tool interrupted when the turn was cancelled]';
  if (status === 'expired') return '[tool interrupted when the Portal lease expired]';
  if (status === 'completed') return '[tool result missing when the provider reported completion]';
  return '[tool result unavailable because the turn ended with an error]';
}

export function buildProjectChatMessagePresentation(
  events: readonly ProjectNativeRunEvent[],
  options: {
    terminalStatus?: ProjectChatPresentationTerminalStatus;
    sourceTruncated?: boolean;
  } = {},
): ProjectChatMessagePresentation | null {
  const toolCalls: PersistedProjectChatToolCall[] = [];
  const segments: PersistedProjectChatSegment[] = [];
  let currentKind: 'text' | 'thinking' | null = null;
  let currentText = '';
  let currentSubject = '';
  let currentTs = 0;
  let currentOrder = 0;

  const flushSegment = () => {
    const text = boundedString(currentText, MAX_SEGMENT_CHARS);
    if (currentKind && (text || currentSubject)) {
      segments.push({
        text,
        ...(currentSubject ? { subject: currentSubject } : {}),
        kind: currentKind,
        position: 'after',
        ts: currentTs || Date.now(),
        order: currentOrder,
      });
      if (segments.length > MAX_SEGMENTS) segments.splice(0, segments.length - MAX_SEGMENTS);
    }
    currentKind = null;
    currentText = '';
    currentSubject = '';
    currentTs = 0;
    currentOrder = 0;
  };

  const mergeSegment = (event: ProjectNativeRunEvent, kind: 'text' | 'thinking') => {
    if (currentKind && currentKind !== kind) flushSegment();
    const subject = kind === 'thinking' ? sanitizeThinkingSubject(event.subject) : '';
    if (
      subject
      && currentKind === 'thinking'
      && (currentText || currentSubject)
      && currentSubject !== subject
    ) {
      flushSegment();
    }
    if (!currentKind) {
      currentKind = kind;
      currentTs = safeTimestamp(event.ts, Date.now());
      currentOrder = event.seq;
    }
    if (subject) currentSubject = subject;
    currentText = mergeStreamText(currentText, event.content, event.replace === true);
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'thinking') {
      mergeSegment(event, 'thinking');
      continue;
    }
    if (event.type === 'text') {
      mergeSegment(event, 'text');
      continue;
    }
    if (event.type === 'segment_break') {
      flushSegment();
      continue;
    }
    if (event.type === 'tool_start') {
      flushSegment();
      appendTool(toolCalls, event, 'running');
      continue;
    }
    if (event.type === 'tool_update') {
      const index = findToolIndex(toolCalls, event);
      const tool = index >= 0 ? toolCalls[index] : appendTool(toolCalls, event, 'running');
      if (event.toolArgs !== undefined) tool.arguments = boundedJsonValue(event.toolArgs);
      const update = boundedString(event.toolResult ?? event.content, MAX_TOOL_RESULT_CHARS);
      if (update) tool.result = update;
      continue;
    }
    if (event.type === 'tool_end') {
      const status = normalizeToolStatus(event.status, event.exitCode);
      const index = findToolIndex(toolCalls, event);
      const tool = index >= 0 ? toolCalls[index] : appendTool(toolCalls, event, status);
      tool.status = status;
      tool.endedAt = safeTimestamp(event.ts, tool.startedAt);
      const result = boundedString(event.toolResult ?? event.content, MAX_TOOL_RESULT_CHARS);
      if (result) tool.result = result;
      continue;
    }
    if (event.type === 'tool_used') {
      flushSegment();
      appendTool(toolCalls, event, normalizeToolStatus(event.status, event.exitCode));
    }
  }
  flushSegment();

  const terminalStatus = options.terminalStatus || 'running';
  if (terminalStatus !== 'running') {
    for (const tool of toolCalls) {
      if (tool.status !== 'running') continue;
      tool.status = 'error';
      tool.endedAt = Math.max(tool.startedAt, events.at(-1)?.ts || Date.now());
      if (!tool.result) tool.result = terminalToolResult(terminalStatus);
    }
  }

  if (segments.length > 0 && toolCalls.length > 0) {
    const firstTool = Math.min(...toolCalls.map((tool) => tool.startedAt));
    const lastTool = Math.max(...toolCalls.map((tool) => tool.endedAt || tool.startedAt));
    for (const segment of segments) {
      segment.position = segment.ts < firstTool ? 'before' : segment.ts > lastTool ? 'after' : 'between';
    }
  } else if (toolCalls.length === 0) {
    for (const segment of segments) segment.position = 'after';
  }

  if (segments.length === 0 && toolCalls.length === 0) return null;
  return enforceAggregateBudget({
    version: PRESENTATION_VERSION,
    ...(segments.length > 0 ? { segments } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(options.sourceTruncated ? { truncated: true } : {}),
  });
}

export function parseProjectChatMessagePresentation(value: unknown): ProjectChatMessagePresentation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== PRESENTATION_VERSION) return null;

  const rawTools = Array.isArray(raw.toolCalls) ? raw.toolCalls.slice(-MAX_TOOL_CALLS) : [];
  const toolCalls = rawTools.flatMap((entry, index): PersistedProjectChatToolCall[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const tool = entry as Record<string, unknown>;
    const name = boundedString(tool.name, MAX_TOOL_NAME_CHARS);
    if (!name) return [];
    const startedAt = safeTimestamp(tool.startedAt, Date.now() + index);
    const status = tool.status === 'running' || tool.status === 'error' ? tool.status : 'done';
    const parsed: PersistedProjectChatToolCall = {
      id: boundedString(tool.id || `project-tool-${index}`, 256),
      name,
      startedAt,
      status,
      order: typeof tool.order === 'number' && Number.isSafeInteger(tool.order) ? tool.order : index,
    };
    const args = boundedJsonValue(tool.arguments);
    if (args !== undefined) parsed.arguments = args;
    const result = boundedString(tool.result, MAX_TOOL_RESULT_CHARS);
    if (result) parsed.result = result;
    if (status !== 'running') parsed.endedAt = safeTimestamp(tool.endedAt, startedAt);
    return [parsed];
  });

  const rawSegments = Array.isArray(raw.segments) ? raw.segments.slice(-MAX_SEGMENTS) : [];
  const segments = rawSegments.flatMap((entry, index): PersistedProjectChatSegment[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const segment = entry as Record<string, unknown>;
    const text = boundedString(segment.text, MAX_SEGMENT_CHARS);
    const kind = segment.kind === 'thinking' ? 'thinking' : 'text';
    const subject = kind === 'thinking' ? sanitizeThinkingSubject(segment.subject) : '';
    if (!text && !subject) return [];
    return [{
      text,
      ...(subject ? { subject } : {}),
      kind,
      position: segment.position === 'before' || segment.position === 'between' ? segment.position : 'after',
      ts: safeTimestamp(segment.ts, Date.now() + index),
      order: typeof segment.order === 'number' && Number.isSafeInteger(segment.order) ? segment.order : index,
    }];
  });

  // Read legacy v1 aggregate reasoning without making it part of the v2
  // persistence contract, preserving compatibility across an in-place upgrade.
  const legacyThinking = raw.version === 1 ? boundedString(raw.thinkingContent, MAX_SEGMENT_CHARS) : '';
  if (!legacyThinking && segments.length === 0 && toolCalls.length === 0) return null;
  return enforceAggregateBudget({
    version: PRESENTATION_VERSION,
    ...(legacyThinking ? { thinkingContent: legacyThinking } : {}),
    ...(segments.length > 0 ? { segments } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(raw.truncated === true ? { truncated: true } : {}),
  });
}
