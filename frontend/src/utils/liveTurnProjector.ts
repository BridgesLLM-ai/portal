export type LiveTurnToolStatus = 'running' | 'done' | 'error';

export interface LiveTurnToolCall {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  result?: string;
  status: LiveTurnToolStatus;
  arguments?: unknown;
  order?: number;
}

export interface LiveTurnMessage<TToolCall extends LiveTurnToolCall = LiveTurnToolCall> {
  id: string;
  role?: string;
  toolCalls?: TToolCall[];
}

export interface LiveTurnToolProjection<TMessage> {
  messages: TMessage[];
  toolCalls: LiveTurnToolCall[];
  nextRunningToolName: string | null;
  changed: boolean;
}

export function getLastRunningToolCall<TToolCall extends { status?: string }>(toolCalls: TToolCall[] | undefined): TToolCall | null {
  if (!Array.isArray(toolCalls)) return null;
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i]?.status === 'running') return toolCalls[i];
  }
  return null;
}

export function normalizeToolCompletionStatus(status: unknown): 'done' | 'error' {
  return status === 'error' ? 'error' : 'done';
}

export function buildRunningToolCall(params: {
  id: string;
  name: string;
  startedAt?: number;
  arguments?: unknown;
}): LiveTurnToolCall {
  return {
    id: params.id,
    name: params.name,
    startedAt: params.startedAt ?? Date.now(),
    status: 'running',
    ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
  };
}

export function buildCompletedToolCall(params: {
  id: string;
  name: string;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  status?: unknown;
}): LiveTurnToolCall {
  const endedAt = params.endedAt ?? Date.now();
  return {
    id: params.id,
    name: params.name,
    startedAt: params.startedAt ?? endedAt,
    endedAt,
    ...(params.result !== undefined ? { result: params.result } : {}),
    status: normalizeToolCompletionStatus(params.status),
  };
}

export function finishLastRunningToolCall<TToolCall extends LiveTurnToolCall>(
  toolCalls: TToolCall[] | undefined,
  params: { result?: string; status?: unknown; endedAt?: number },
): { toolCalls: TToolCall[]; changed: boolean; completedTool: TToolCall | null } {
  const calls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i]?.status === 'running') {
      const completed = {
        ...calls[i],
        endedAt: params.endedAt ?? Date.now(),
        ...(params.result !== undefined ? { result: params.result } : {}),
        status: normalizeToolCompletionStatus(params.status),
      } as TToolCall;
      calls[i] = completed;
      return { toolCalls: calls, changed: true, completedTool: completed };
    }
  }
  return { toolCalls: calls, changed: false, completedTool: null };
}

export function finishMatchingToolCall<TToolCall extends LiveTurnToolCall>(
  toolCalls: TToolCall[] | undefined,
  params: { toolCallId?: string; toolName?: string; result?: string; status?: unknown; endedAt?: number },
): { toolCalls: TToolCall[]; changed: boolean; completedTool: TToolCall | null } {
  const calls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  const idx = params.toolCallId
    ? calls.findIndex((call) => call.id === params.toolCallId)
    : calls.findIndex((call) => Boolean(params.toolName && call.name === params.toolName));
  if (idx < 0) return { toolCalls: calls, changed: false, completedTool: null };
  const completed = {
    ...calls[idx],
    endedAt: params.endedAt ?? Date.now(),
    ...(params.result !== undefined ? { result: params.result } : {}),
    status: normalizeToolCompletionStatus(params.status),
  } as TToolCall;
  calls[idx] = completed;
  return { toolCalls: calls, changed: true, completedTool: completed };
}

export function hasRecentCompletedTool<TMessage extends LiveTurnMessage>(
  messages: TMessage[],
  toolName: string,
  params: {
    now?: number;
    windowMs?: number;
    stableToolCallId?: string;
    stableOrder?: number;
    assistantId?: string | null;
  } = {},
): boolean {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? 5000;
  const stableToolCallId = typeof params.stableToolCallId === 'string'
    ? params.stableToolCallId.trim()
    : '';
  const stableOrder = Number.isSafeInteger(params.stableOrder)
    ? Number(params.stableOrder)
    : null;
  return messages.some((message) => (
    (!params.assistantId || message.id === params.assistantId)
    && message.role === 'assistant'
    && Array.isArray(message.toolCalls)
    && message.toolCalls.some((toolCall) => (
      toolCall.status !== 'running'
      && toolCall.name === toolName
      && (
        stableToolCallId
          ? toolCall.id === stableToolCallId
          : stableOrder !== null
            ? toolCall.order === stableOrder
            : (
                typeof toolCall.endedAt === 'number'
                && now - toolCall.endedAt < windowMs
              )
      )
    ))
  ));
}

export function appendToolCallToMessage<TMessage extends LiveTurnMessage>(
  messages: TMessage[],
  assistantId: string | null | undefined,
  toolCall: LiveTurnToolCall,
): LiveTurnToolProjection<TMessage> {
  let projectedToolCalls: LiveTurnToolCall[] = [];
  let changed = false;
  const projectedMessages = messages.map((message) => {
    if (!assistantId || message.id !== assistantId) return message;
    const nextToolCalls = [...(message.toolCalls || []), toolCall] as LiveTurnToolCall[];
    projectedToolCalls = nextToolCalls;
    changed = true;
    return { ...message, toolCalls: nextToolCalls } as TMessage;
  });
  const nextRunningTool = getLastRunningToolCall(projectedToolCalls);
  return {
    messages: projectedMessages,
    toolCalls: projectedToolCalls,
    nextRunningToolName: nextRunningTool?.name || null,
    changed,
  };
}

export function finishRunningToolCallInMessage<TMessage extends LiveTurnMessage>(
  messages: TMessage[],
  assistantId: string | null | undefined,
  params: { result?: string; status?: unknown; endedAt?: number },
): LiveTurnToolProjection<TMessage> {
  let projectedToolCalls: LiveTurnToolCall[] = [];
  let changed = false;
  const projectedMessages = messages.map((message) => {
    if (!assistantId || message.id !== assistantId) return message;
    const result = finishLastRunningToolCall(message.toolCalls, params);
    projectedToolCalls = result.toolCalls;
    changed = result.changed;
    return { ...message, toolCalls: result.toolCalls } as TMessage;
  });
  const nextRunningTool = getLastRunningToolCall(projectedToolCalls);
  return {
    messages: projectedMessages,
    toolCalls: projectedToolCalls,
    nextRunningToolName: nextRunningTool?.name || null,
    changed,
  };
}

export function updateRunningToolCallInMessage<TMessage extends LiveTurnMessage>(
  messages: TMessage[],
  assistantId: string | null | undefined,
  params: { result?: string; toolCallId?: string; toolName?: string },
): LiveTurnToolProjection<TMessage> {
  let projectedToolCalls: LiveTurnToolCall[] = [];
  let changed = false;
  const projectedMessages = messages.map((message) => {
    if (!assistantId || message.id !== assistantId) return message;
    const calls = Array.isArray(message.toolCalls) ? [...message.toolCalls] as LiveTurnToolCall[] : [];
    const idx = params.toolCallId
      ? calls.findIndex((call) => call.status === 'running' && call.id === params.toolCallId)
      : calls.findIndex((call) => call.status === 'running' && Boolean(params.toolName && call.name === params.toolName));
    // Once the server supplies an ID, never fall back to an unrelated running
    // tool: parallel same-name calls may complete in reverse order.
    const runningIdx = idx >= 0
      ? idx
      : (!params.toolCallId && !params.toolName ? calls.findIndex((call) => call.status === 'running') : -1);
    if (runningIdx >= 0) {
      calls[runningIdx] = {
        ...calls[runningIdx],
        ...(params.result !== undefined ? { result: params.result } : {}),
        status: 'running',
      };
      changed = true;
    }
    projectedToolCalls = calls;
    return changed ? { ...message, toolCalls: calls } as TMessage : message;
  });
  const nextRunningTool = getLastRunningToolCall(projectedToolCalls);
  return {
    messages: projectedMessages,
    toolCalls: projectedToolCalls,
    nextRunningToolName: nextRunningTool?.name || null,
    changed,
  };
}

export function finishMatchingToolCallInMessage<TMessage extends LiveTurnMessage>(
  messages: TMessage[],
  assistantId: string | null | undefined,
  params: { toolCallId?: string; toolName?: string; result?: string; status?: unknown; endedAt?: number },
): LiveTurnToolProjection<TMessage> {
  let projectedToolCalls: LiveTurnToolCall[] = [];
  let changed = false;
  const projectedMessages = messages.map((message) => {
    if (!assistantId || message.id !== assistantId) return message;
    const result = finishMatchingToolCall(message.toolCalls, params);
    projectedToolCalls = result.toolCalls;
    changed = result.changed;
    return { ...message, toolCalls: result.toolCalls } as TMessage;
  });
  const nextRunningTool = getLastRunningToolCall(projectedToolCalls);
  return {
    messages: projectedMessages,
    toolCalls: projectedToolCalls,
    nextRunningToolName: nextRunningTool?.name || null,
    changed,
  };
}

export function appendCompletedToolCallIfMissing<TMessage extends LiveTurnMessage>(
  messages: TMessage[],
  assistantId: string | null | undefined,
  toolCall: LiveTurnToolCall,
  params: {
    now?: number;
    windowMs?: number;
    stableToolCallId?: string;
    stableOrder?: number;
  } = {},
): LiveTurnToolProjection<TMessage> {
  if (hasRecentCompletedTool(messages, toolCall.name, {
    ...params,
    assistantId: assistantId || null,
  })) {
    return { messages, toolCalls: [], nextRunningToolName: null, changed: false };
  }
  return appendToolCallToMessage(messages, assistantId, toolCall);
}
