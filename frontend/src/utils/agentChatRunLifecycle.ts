export const CANCELLED_TURN_MARKER = '*(cancelled)*';

interface CancellableAssistantMessage {
  id: string;
  content: string;
  thinkingContent?: string;
  segments?: unknown[];
  toolCalls?: unknown[];
}

function hasCancelledTurnMarker(content: string): boolean {
  return String(content || '').includes(CANCELLED_TURN_MARKER);
}

interface AbortMirrorHistoryMessage {
  role?: string;
  content?: string;
  createdAt?: Date;
  model?: string;
  thinkingContent?: string;
  toolCalls?: unknown[];
}

const ABORT_MIRROR_WINDOW_MS = 2_000;

function normalizedAbortMirrorText(content: unknown): string {
  return String(content || '').replace(/\r\n/g, '\n').trim();
}

function isGatewayInjectedMessage(message: AbortMirrorHistoryMessage | undefined): boolean {
  return String(message?.model || '').trim().toLowerCase() === 'gateway-injected';
}

function isPlainAssistantMessage(message: AbortMirrorHistoryMessage | undefined): boolean {
  return message?.role === 'assistant'
    && !String(message.thinkingContent || '').trim()
    && (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0);
}

/**
 * OpenClaw can persist an abort snapshot as `gateway-injected` immediately
 * before the model's matching terminal message. They are one cancelled turn,
 * not two assistant replies. Collapse only that narrowly proven shape so
 * legitimate repeated assistant answers remain untouched.
 */
export function collapseGatewayInjectedAbortMirrors<T extends AbortMirrorHistoryMessage>(messages: T[]): T[] {
  const collapsed: T[] = [];
  for (const message of messages) {
    const previous = collapsed[collapsed.length - 1];
    const oneIsGateway = isGatewayInjectedMessage(previous) !== isGatewayInjectedMessage(message);
    const previousTime = previous?.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
    const messageTime = message.createdAt instanceof Date ? message.createdAt.getTime() : NaN;
    const samePlainText = isPlainAssistantMessage(previous)
      && isPlainAssistantMessage(message)
      && normalizedAbortMirrorText(previous?.content)
      && normalizedAbortMirrorText(previous?.content) === normalizedAbortMirrorText(message.content);
    const isAdjacentAbortMirror = oneIsGateway
      && samePlainText
      && Number.isFinite(previousTime)
      && Number.isFinite(messageTime)
      && Math.abs(messageTime - previousTime) <= ABORT_MIRROR_WINDOW_MS;

    if (!isAdjacentAbortMirror) {
      collapsed.push(message);
      continue;
    }

    const canonical = isGatewayInjectedMessage(message) ? previous : message;
    const text = String(canonical.content || '').trimEnd();
    collapsed[collapsed.length - 1] = {
      ...canonical,
      content: hasCancelledTurnMarker(text)
        ? text
        : `${text}\n\n${CANCELLED_TURN_MARKER}`,
    } as T;
  }
  return collapsed;
}

/**
 * Settle one streaming assistant bubble after an authoritative cancellation.
 * The helper is deliberately idempotent so a transport terminal and the abort
 * acknowledgement can race without duplicating the marker or resurrecting a
 * placeholder that was already removed.
 */
export function settleCancelledAssistantMessage<T extends CancellableAssistantMessage>(
  messages: T[],
  assistantId: string | null | undefined,
  assembledText: string,
): T[] {
  if (!assistantId) return messages;

  return messages.flatMap((message) => {
    if (message.id !== assistantId) return [message];

    const latestText = String(assembledText || '').trim()
      ? String(assembledText).trimEnd()
      : String(message.content || '').trimEnd();
    const hasStructuredContent = Boolean(
      String(message.thinkingContent || '').trim()
      || (Array.isArray(message.segments) && message.segments.length > 0)
      || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0),
    );

    if (!latestText && !hasStructuredContent) return [];
    if (hasCancelledTurnMarker(latestText)) return [message];

    return [{
      ...message,
      content: latestText
        ? `${latestText}\n\n${CANCELLED_TURN_MARKER}`
        : CANCELLED_TURN_MARKER,
    }];
  });
}

export function isAbortedDoneEvent(event: unknown): boolean {
  const candidate = event as { type?: unknown; metadata?: { aborted?: unknown } } | null;
  return candidate?.type === 'done' && candidate.metadata?.aborted === true;
}

export function resolveToolCompletionStatus(event: unknown): 'done' | 'error' {
  const candidate = event as {
    status?: unknown;
    failed?: unknown;
    isError?: unknown;
    exitCode?: unknown;
    result?: { exitCode?: unknown };
    toolResult?: { exitCode?: unknown };
    metadata?: { exitCode?: unknown };
  } | null;
  const status = String(candidate?.status || '').trim().toLowerCase();
  const exitCodes = [
    candidate?.exitCode,
    candidate?.result?.exitCode,
    candidate?.toolResult?.exitCode,
    candidate?.metadata?.exitCode,
  ];
  const hasNonzeroExit = exitCodes.some((value) => {
    if (value === null || value === undefined || value === '') return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric !== 0;
  });

  return ['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted', 'denied'].includes(status)
    || candidate?.failed === true
    || candidate?.isError === true
    || hasNonzeroExit
    ? 'error'
    : 'done';
}

export function selectSnapshotReasoningEvents<T extends {
  type?: unknown;
  text?: unknown;
  subject?: unknown;
  runId?: unknown;
  seq?: unknown;
  visible?: unknown;
  source?: { eventType?: unknown };
}>(turnEvents: T[], snapshotRunId: unknown): T[] {
  const expectedRunId = typeof snapshotRunId === 'string' ? snapshotRunId.trim() : '';
  if (!expectedRunId) return [];

  return turnEvents
    .filter((event) => (
      (
        event?.type === 'assistant_reasoning'
        || (
          event?.type === 'assistant_status'
          && event?.visible === true
          && event?.source?.eventType === 'status'
        )
      )
      && (
        (typeof event?.text === 'string' && event.text.trim())
        || (
          event?.type === 'assistant_reasoning'
          && typeof event?.subject === 'string'
          && event.subject.trim()
        )
      )
      && typeof event?.runId === 'string'
      && event.runId.trim() === expectedRunId
    ))
    .sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
}

export function supportsAgentChatStop(provider: string): boolean {
  return String(provider || '').trim().toUpperCase() !== 'AGENT_ZERO';
}
