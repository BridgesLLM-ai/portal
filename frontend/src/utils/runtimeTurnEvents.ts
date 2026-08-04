export const RUNTIME_TURN_EVENT_SCHEMA = 'bridgesllm.runtime-turn-event.v1';

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

export interface RuntimeTurnEventTool {
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  status?: 'running' | 'done' | 'error';
}

export interface RuntimeTurnEvent {
  schema: typeof RUNTIME_TURN_EVENT_SCHEMA;
  type: RuntimeTurnEventType;
  seq?: number;
  text?: string;
  subject?: string;
  replace?: boolean;
  runId?: string;
  model?: string;
  provenance?: string;
  sessionKey?: string;
  terminal?: boolean;
  visible?: boolean;
  tool?: RuntimeTurnEventTool;
  source?: {
    transport?: string;
    eventType?: string;
  };
}

export interface PortalStreamEventFromTurnEvent {
  type?: string;
  content?: string;
  subject?: string;
  runId?: string;
  model?: string;
  provenance?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  status?: 'running' | 'done' | 'error';
  replace?: boolean;
  turnEvent?: RuntimeTurnEvent;
  [key: string]: unknown;
}

export function isRuntimeTurnEvent(value: unknown): value is RuntimeTurnEvent {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as RuntimeTurnEvent).schema === RUNTIME_TURN_EVENT_SCHEMA
    && typeof (value as RuntimeTurnEvent).type === 'string',
  );
}

export function mapRuntimeTurnEventToPortalType(turnEvent: RuntimeTurnEvent): string {
  switch (turnEvent.type) {
    case 'assistant_started':
    case 'assistant_status':
      return 'status';
    case 'assistant_reasoning':
      return 'thinking';
    case 'tool_started':
      return 'tool_start';
    case 'tool_output':
      return turnEvent.tool?.status === 'running' ? 'tool_update' : 'tool_end';
    case 'source_reply':
    case 'assistant_delta':
      return 'text';
    case 'assistant_final':
    case 'turn_done':
      return 'done';
    case 'turn_error':
      return 'error';
    default:
      return '';
  }
}

export function normalizePortalStreamEventFromTurnEvent<T extends Record<string, any>>(payload: T): T & PortalStreamEventFromTurnEvent {
  const turnEvent = payload?.turnEvent;
  if (!isRuntimeTurnEvent(turnEvent)) return payload as T & PortalStreamEventFromTurnEvent;

  const sourceEventType = typeof turnEvent.source?.eventType === 'string'
    ? turnEvent.source.eventType
    : '';
  const preservedControlType = ['run_resumed', 'compaction_start', 'compaction_end'].includes(sourceEventType)
    ? sourceEventType
    : '';
  const mappedType = preservedControlType
    || mapRuntimeTurnEventToPortalType(turnEvent)
    || (typeof payload?.type === 'string' ? payload.type : '');
  if (!mappedType) return payload as T & PortalStreamEventFromTurnEvent;

  const text = typeof turnEvent.text === 'string' ? turnEvent.text : '';
  const subject = typeof turnEvent.subject === 'string' ? turnEvent.subject : '';
  const toolName = typeof turnEvent.tool?.name === 'string' ? turnEvent.tool.name : undefined;
  const toolCallId = typeof turnEvent.tool?.id === 'string' ? turnEvent.tool.id : undefined;
  const toolStatus = turnEvent.tool?.status === 'error'
    ? 'error'
    : turnEvent.tool?.status === 'running'
      ? 'running'
      : turnEvent.tool?.status === 'done'
        ? 'done'
        : undefined;

  return {
    ...payload,
    type: mappedType,
    content: text || payload?.content || '',
    subject: subject || payload?.subject,
    runId: turnEvent.runId || payload?.runId,
    model: turnEvent.model || payload?.model,
    provenance: turnEvent.provenance || payload?.provenance,
    sessionKey: turnEvent.sessionKey || payload?.sessionKey,
    ...(turnEvent.replace === true ? { replace: true } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(turnEvent.tool?.arguments !== undefined ? { toolArgs: turnEvent.tool.arguments } : {}),
    ...(turnEvent.tool?.result !== undefined ? { toolResult: turnEvent.tool.result } : {}),
    ...(toolStatus ? { status: toolStatus } : {}),
  } as T & PortalStreamEventFromTurnEvent;
}
