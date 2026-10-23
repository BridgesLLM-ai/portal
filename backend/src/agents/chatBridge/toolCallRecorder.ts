import {
  NATIVE_TOOL_CALL_ARGUMENTS_MAX_BYTES,
  NATIVE_TOOL_CALL_RESULT_MAX_BYTES,
  NATIVE_TOOL_CALLS_MESSAGE_MAX_BYTES,
  NATIVE_TOOL_CALLS_PER_MESSAGE_MAX,
  type NativePersistedToolCall,
} from './contract';

/**
 * Collects the tool activity a native harness reported during one turn so the
 * assistant message can carry it into the durable transcript. Without this the
 * grouped tool cards, answered questions and widgets of every non-OpenClaw
 * harness disappear on reload.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,255}$/;
const NAME_MAX = 160;
const ARGS_DELTA_MAX_BYTES = 64 * 1024;

interface MutableCall {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  arguments?: unknown;
  argsDelta: string;
  result?: string;
  startedAt: number;
  endedAt?: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = '\n… [truncated by Portal]';
  let end = Math.max(0, maxBytes - byteLength(suffix));
  // Back off to a code-point boundary.
  let slice = Buffer.from(value, 'utf8').subarray(0, end).toString('utf8');
  while (slice.endsWith('�') && end > 0) {
    end -= 1;
    slice = Buffer.from(value, 'utf8').subarray(0, end).toString('utf8');
  }
  return slice + suffix;
}

export function boundToolArguments(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  let encoded: string;
  try {
    encoded = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (encoded === undefined) return undefined;
  if (byteLength(encoded) <= NATIVE_TOOL_CALL_ARGUMENTS_MAX_BYTES) {
    return typeof value === 'string' ? value : JSON.parse(encoded);
  }
  return { __truncated: true, preview: truncateUtf8(encoded, Math.floor(NATIVE_TOOL_CALL_ARGUMENTS_MAX_BYTES / 2)) };
}

export function boundToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { return undefined; }
  }
  if (typeof text !== 'string') return undefined;
  return truncateUtf8(text, NATIVE_TOOL_CALL_RESULT_MAX_BYTES);
}

function cleanId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return ID_PATTERN.test(id) ? id : null;
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX)
    : '';
  return name || 'tool';
}

/** Re-bound records from any source (including an old or hostile sidecar line). */
export function sanitizeNativeToolCalls(input: unknown): NativePersistedToolCall[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const output: NativePersistedToolCall[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of input.slice(-NATIVE_TOOL_CALLS_PER_MESSAGE_MAX)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = cleanId(entry.id);
    if (!id || seen.has(id)) continue;
    const record: NativePersistedToolCall = {
      id,
      name: cleanName(entry.name),
      status: entry.status === 'error' ? 'error' : 'done',
      ...(entry.arguments !== undefined ? { arguments: boundToolArguments(entry.arguments) } : {}),
      ...(entry.result !== undefined ? { result: boundToolResult(entry.result) } : {}),
      ...(Number.isSafeInteger(entry.startedAt) ? { startedAt: entry.startedAt as number } : {}),
      ...(Number.isSafeInteger(entry.endedAt) ? { endedAt: entry.endedAt as number } : {}),
    };
    const size = byteLength(JSON.stringify(record));
    if (total + size > NATIVE_TOOL_CALLS_MESSAGE_MAX_BYTES) break;
    total += size;
    seen.add(id);
    output.push(record);
  }
  return output.length ? output : undefined;
}

export class NativeToolCallRecorder {
  private readonly calls = new Map<string, MutableCall>();
  private readonly order: string[] = [];

  /** Feed every status event the adapter emitted; non-tool events are ignored. */
  observe(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const value = event as Record<string, unknown>;
    const type = value.type;
    if (type !== 'tool_start' && type !== 'tool_update' && type !== 'tool_end') return;
    const id = cleanId(value.toolCallId);
    if (!id) return;
    let call = this.calls.get(id);
    if (!call) {
      if (this.order.length >= NATIVE_TOOL_CALLS_PER_MESSAGE_MAX * 2) return;
      call = { id, name: cleanName(value.toolName), status: 'running', argsDelta: '', startedAt: Date.now() };
      this.calls.set(id, call);
      this.order.push(id);
    }
    if (typeof value.toolName === 'string' && value.toolName.trim() && call.name === 'tool') {
      call.name = cleanName(value.toolName);
    }
    if (value.toolArgs !== undefined && value.toolArgs !== null) {
      const hasContent = typeof value.toolArgs !== 'object' || Object.keys(value.toolArgs as object).length > 0;
      if (hasContent || call.arguments === undefined) call.arguments = boundToolArguments(value.toolArgs);
    }
    if (typeof value.toolArgsDelta === 'string' && byteLength(call.argsDelta) < ARGS_DELTA_MAX_BYTES) {
      call.argsDelta += value.toolArgsDelta;
    }
    if (type === 'tool_end') {
      call.status = value.isError === true || value.status === 'failed' || value.status === 'error' ? 'error' : 'done';
      call.result = boundToolResult(value.toolResult ?? value.content);
      call.endedAt = Date.now();
    }
  }

  /** Records for the assistant message; still-running calls settle as interrupted errors. */
  snapshot(): NativePersistedToolCall[] | undefined {
    const output = this.order.map((id) => {
      const call = this.calls.get(id)!;
      let args = call.arguments;
      const emptyArgs = args === undefined || (typeof args === 'object' && args !== null && Object.keys(args).length === 0);
      if (emptyArgs && call.argsDelta.trim()) {
        try { args = JSON.parse(call.argsDelta); } catch { /* partial stream: keep what we have */ }
      }
      return {
        id: call.id,
        name: call.name,
        status: call.status === 'running' ? 'error' as const : call.status,
        ...(args !== undefined ? { arguments: args } : {}),
        ...(call.status === 'running'
          ? { result: 'Interrupted before the harness reported a result.' }
          : call.result !== undefined ? { result: call.result } : {}),
        startedAt: call.startedAt,
        ...(call.endedAt ? { endedAt: call.endedAt } : {}),
      };
    });
    return sanitizeNativeToolCalls(output);
  }
}
