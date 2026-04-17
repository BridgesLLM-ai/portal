import { motion } from 'framer-motion';
import { CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react';
import ToolGlyph from './ToolGlyph';
import { getStreamStatusPresentation, type StreamPhase } from './streamStatusPresentation';
import { getToolPresentation } from '../../utils/toolPresentation';

export interface ComposerContextSummary {
  text: string;
  dot: string;
  label: string;
  detail: string;
}

interface ComposerStatusBadgeProps {
  phase: StreamPhase;
  toolName: string | null;
  statusText?: string | null;
  showConnectionLost?: boolean;
  compactionPhase?: 'idle' | 'compacting' | 'compacted';
  queueCount?: number;
  onClearQueue?: () => void;
  contextSummary?: ComposerContextSummary | null;
}

export default function ComposerStatusBadge({
  phase,
  toolName,
  statusText,
  showConnectionLost,
  compactionPhase,
  queueCount,
  onClearQueue,
  contextSummary,
}: ComposerStatusBadgeProps) {
  const tone = getStreamStatusPresentation({
    phase,
    toolName,
    statusText,
    showConnectionLost,
    compactionPhase,
    queueCount,
  });

  if (!tone && !contextSummary) return null;

  const effectiveTone = tone ?? {
    bg: 'bg-slate-500/[0.04] border-white/[0.06]',
    text: 'text-slate-300/85',
    dot: contextSummary?.dot || 'bg-slate-300',
    icon: null,
    label: contextSummary?.label || 'Status',
    detail: null,
    bounce: false,
    showQueueMeta: false,
  };

  const toolPresentation = phase === 'tool' ? getToolPresentation(toolName || 'tool') : null;

  const icon = effectiveTone.icon === 'refresh'
    ? <RefreshCw size={12} className={`animate-spin ${effectiveTone.text}`} />
    : effectiveTone.icon === 'check'
      ? <CheckCircle2 size={12} className={effectiveTone.text} />
      : effectiveTone.icon === 'spinner'
        ? <Loader2 size={12} className={`animate-spin ${effectiveTone.text}`} />
        : effectiveTone.icon === 'clock'
          ? <Clock size={12} className={effectiveTone.text} />
          : effectiveTone.icon === 'error'
            ? <XCircle size={12} className={effectiveTone.text} />
            : null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className={`flex items-center justify-center gap-2.5 px-4 py-1.5 border-t ${effectiveTone.bg}`}>
        {effectiveTone.bounce && !toolPresentation ? (
          <div className="flex gap-0.5 self-start pt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${effectiveTone.dot} animate-bounce`} style={{ animationDelay: '0ms' }} />
            <span className={`w-1.5 h-1.5 rounded-full ${effectiveTone.dot} animate-bounce`} style={{ animationDelay: '150ms' }} />
            <span className={`w-1.5 h-1.5 rounded-full ${effectiveTone.dot} animate-bounce`} style={{ animationDelay: '300ms' }} />
          </div>
        ) : (
          <div className="flex items-center gap-2 self-start pt-0.5">
            {toolPresentation ? (
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${toolPresentation.iconBadgeClass}`}>
                <ToolGlyph toolName={toolName || 'tool'} size={11} className={toolPresentation.iconClass} />
              </span>
            ) : icon}
          </div>
        )}
        <div className="min-w-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center">
          <span className={`text-xs font-medium ${effectiveTone.text}`}>{effectiveTone.label}</span>
          {effectiveTone.showQueueMeta ? (
            <>
              <span className={`text-xs ${effectiveTone.text}`}>•</span>
              <span className={`text-[11px] ${effectiveTone.text}`}>{queueCount} queued</span>
              {onClearQueue ? (
                <button
                  onClick={onClearQueue}
                  className={`rounded-md px-1.5 py-0.5 text-[10px] ${effectiveTone.text} hover:bg-white/[0.06] hover:text-white`}
                  title="Clear queued messages"
                >
                  clear
                </button>
              ) : null}
            </>
          ) : null}
          {effectiveTone.detail ? (
            <span className={`basis-full text-[10px] ${effectiveTone.text} opacity-90`}>
              {effectiveTone.detail}
            </span>
          ) : null}
          {contextSummary ? (
            <div className={`basis-full flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[10px] ${contextSummary.text} opacity-90`}>
              <span className="inline-flex items-center gap-1.5 font-medium">
                <span className={`h-1.5 w-1.5 rounded-full ${contextSummary.dot}`} />
                {contextSummary.label}
              </span>
              <span className="hidden sm:inline">•</span>
              <span>{contextSummary.detail}</span>
            </div>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
