import { getToolDisplayName, getToolPresentation, getToolStatusText } from '../../utils/toolPresentation';

export type StreamPhase = 'idle' | 'thinking' | 'tool' | 'streaming';

export interface StreamStatusPresentation {
  bg: string;
  text: string;
  dot: string;
  icon: 'spinner' | 'check' | 'clock' | 'refresh' | 'error' | null;
  label: string;
  detail?: string | null;
  bounce: boolean;
  showQueueMeta: boolean;
}

const CONNECTED_RE = /\b(connected|reconnected|recovered)\b/;
const APPROVAL_RE = /approval|waiting for command approval/;
const WAITING_RE = /\b(reconnecting|queued|waiting)\b/;
const ERROR_RE = /denied|failed|error|disconnected/;
const COMPACTING_RE = /\b(compacting context|auto-compaction|context compaction|compaction in progress)\b/;
const COMPACTED_RE = /\b(context compacted|compaction complete(?:d)?)\b/;
const CONTEXT_PRESSURE_RE = /\b(context (?:getting|running) full|context (?:near(?:ing)?|almost) full|approaching (?:the )?context limit|context window (?:is )?(?:near|nearing|almost) full|running out of context|context budget)\b/;
const FLUSH_PREPARING_RE = /\b(memory flush (?:about to start|starting|queued|pending)|preparing (?:for )?(?:a )?memory flush|preparing context maintenance|preparing compaction|preparing to store durable memor(?:y|ies)|about to compact|pre-compaction)\b/;
const FLUSH_RUNNING_RE = /\b(memory flush(?:ing)?|flush in progress|flushing memory|storing durable memor(?:y|ies)|writing durable memor(?:y|ies)|context maintenance|refreshing (?:context|memory)|summariz(?:ing|ation) (?:context|conversation|history)|trimming context)\b/;
const FLUSH_DONE_RE = /\b(memory flush complete(?:d)?|durable memor(?:y|ies) (?:stored|written)|context refreshed|context maintenance complete(?:d)?)\b/;

function normalizeStatusText(statusText?: string | null): string {
  const raw = String(statusText || '').trim();
  if (!raw) return '';
  const withoutLeadingDecorators = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return withoutLeadingDecorators.replace(/^using tool:\s*/i, 'Using ').trim();
}

export function getStreamStatusPresentation({
  phase,
  toolName,
  statusText,
  showConnectionLost,
  compactionPhase,
  queueCount,
}: {
  phase: StreamPhase;
  toolName: string | null;
  statusText?: string | null;
  showConnectionLost?: boolean;
  compactionPhase?: 'idle' | 'compacting' | 'compacted';
  queueCount?: number;
}): StreamStatusPresentation | null {
  const rawStatus = normalizeStatusText(statusText);
  const normalizedStatus = rawStatus.toLowerCase();
  const queueSize = queueCount || 0;
  const connectedLike = CONNECTED_RE.test(normalizedStatus);
  const maintenanceLike = compactionPhase === 'compacting'
    || compactionPhase === 'compacted'
    || COMPACTING_RE.test(normalizedStatus)
    || COMPACTED_RE.test(normalizedStatus)
    || FLUSH_RUNNING_RE.test(normalizedStatus)
    || FLUSH_DONE_RE.test(normalizedStatus)
    || FLUSH_PREPARING_RE.test(normalizedStatus)
    || CONTEXT_PRESSURE_RE.test(normalizedStatus);
  const displayStatus = phase === 'idle' ? rawStatus : (connectedLike ? '' : rawStatus);

  const tones = {
    active: {
      bg: 'bg-[rgba(139,92,246,0.06)] border-[rgba(139,92,246,0.12)]',
      text: 'text-[rgba(196,181,253,0.8)]',
      dot: 'bg-[#a78bfa]',
    },
    reconnecting: {
      bg: 'bg-[rgba(245,158,11,0.08)] border-[rgba(245,158,11,0.2)]',
      text: 'text-[rgba(252,211,77,0.92)]',
      dot: 'bg-[#fbbf24]',
    },
    connected: {
      bg: 'bg-[rgba(16,185,129,0.08)] border-[rgba(16,185,129,0.2)]',
      text: 'text-[rgba(110,231,183,0.92)]',
      dot: 'bg-[#34d399]',
    },
    info: {
      bg: 'bg-[rgba(59,130,246,0.08)] border-[rgba(59,130,246,0.2)]',
      text: 'text-[rgba(147,197,253,0.92)]',
      dot: 'bg-[#60a5fa]',
    },
    error: {
      bg: 'bg-[rgba(244,63,94,0.08)] border-[rgba(244,63,94,0.2)]',
      text: 'text-[rgba(253,164,175,0.92)]',
      dot: 'bg-[#fb7185]',
    },
  };

  let tone: StreamStatusPresentation = {
    ...tones.active,
    icon: null,
    label: displayStatus || (phase === 'tool' ? `Using ${toolName || 'tool'}…` : phase === 'streaming' ? 'Responding…' : 'Thinking…'),
    detail: null,
    bounce: true,
    showQueueMeta: false,
  };

  if (showConnectionLost) {
    tone = {
      ...tones.reconnecting,
      icon: 'refresh',
      label: 'Connection lost, reconnecting to the live stream…',
      detail: 'The run is still active. Tool calls stay visible while we resync.',
      bounce: false,
      showQueueMeta: false,
    };
  } else if (APPROVAL_RE.test(normalizedStatus) || WAITING_RE.test(normalizedStatus)) {
    tone = {
      ...tones.reconnecting,
      icon: APPROVAL_RE.test(normalizedStatus) ? 'clock' : 'refresh',
      label: displayStatus || `${queueSize} queued follow-up${queueSize === 1 ? '' : 's'}`,
      detail: null,
      bounce: false,
      showQueueMeta: false,
    };
  } else if (ERROR_RE.test(normalizedStatus)) {
    tone = {
      ...tones.error,
      icon: 'error',
      label: displayStatus || rawStatus,
      detail: null,
      bounce: false,
      showQueueMeta: false,
    };
  } else if (phase === 'tool') {
    const toolLabel = toolName ? getToolPresentation(toolName).label : 'Tool';
    const toolDisplayName = toolName ? getToolDisplayName(toolName) : 'tool';
    const toolStatusText = maintenanceLike ? null : displayStatus;
    tone = {
      ...tones.active,
      icon: null,
      label: toolName ? getToolStatusText(toolName, toolStatusText) : (toolStatusText || `Using ${toolLabel}…`),
      detail: maintenanceLike
        ? `${toolDisplayName} is still running while context maintenance completes.`
        : (toolName ? `${toolDisplayName} is running right now.` : 'Tool call in progress.'),
      bounce: false,
      showQueueMeta: false,
    };
  } else if (compactionPhase === 'compacting' || COMPACTING_RE.test(normalizedStatus)) {
    tone = {
      ...tones.info,
      icon: 'spinner',
      label: displayStatus || 'Compacting context…',
      detail: 'The run is still active. Tool calls stay visible while the context is compacted.',
      bounce: false,
      showQueueMeta: false,
    };
  } else if (compactionPhase === 'compacted' || COMPACTED_RE.test(normalizedStatus)) {
    tone = {
      ...tones.info,
      icon: 'check',
      label: displayStatus || 'Context compacted',
      detail: 'Context maintenance finished. The agent should continue shortly.',
      bounce: false,
      showQueueMeta: false,
    };
  } else if (FLUSH_RUNNING_RE.test(normalizedStatus)) {
    tone = {
      ...tones.info,
      icon: 'spinner',
      label: displayStatus || 'Context maintenance in progress…',
      detail: 'The run is still active. Tool calls stay visible while memory is flushed.',
      bounce: false,
      showQueueMeta: false,
    };
  } else if (FLUSH_DONE_RE.test(normalizedStatus)) {
    tone = {
      ...tones.info,
      icon: 'check',
      label: displayStatus || 'Context maintenance finished.',
      detail: 'The agent should continue shortly.',
      bounce: false,
      showQueueMeta: false,
    };
  } else if (FLUSH_PREPARING_RE.test(normalizedStatus) || CONTEXT_PRESSURE_RE.test(normalizedStatus)) {
    tone = {
      ...tones.reconnecting,
      icon: 'clock',
      label: displayStatus || 'Preparing context maintenance…',
      detail: 'The run is still active. The agent is making room so it can keep going.',
      bounce: false,
      showQueueMeta: false,
    };
  } else if (phase === 'idle' && connectedLike) {
    tone = {
      ...tones.connected,
      icon: 'check',
      label: rawStatus || 'Connected',
      detail: null,
      bounce: false,
      showQueueMeta: false,
    };
  } else if (phase === 'idle' && queueSize > 0) {
    tone = {
      ...tones.reconnecting,
      icon: 'clock',
      label: `${queueSize} queued follow-up${queueSize === 1 ? '' : 's'}`,
      detail: null,
      bounce: false,
      showQueueMeta: false,
    };
  } else if (phase === 'idle') {
    return null;
  }

  tone.showQueueMeta = queueSize > 0 && !(phase === 'idle' && !showConnectionLost && compactionPhase === 'idle' && !connectedLike);

  return tone;
}
