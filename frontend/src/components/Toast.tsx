import { useEffect, useId, useState } from 'react';
import { CheckCircle, XCircle, AlertCircle, Info, X, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';
import ViewportOverlay from './ViewportOverlay';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastProps {
  id: string;
  type: ToastType;
  message: string;
  detail?: string;       // Expandable detail (stack trace, API response, etc.)
  hint?: string;         // Troubleshooting hint
  duration?: number;
  onClose: (id: string) => void;
}

const icons = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertCircle,
  info: Info,
};

const styles = {
  success: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400',
  error: 'bg-red-500/20 border-red-500/50 text-red-400',
  warning: 'bg-amber-500/20 border-amber-500/50 text-amber-400',
  info: 'bg-blue-500/20 border-blue-500/50 text-blue-400',
};

export function Toast({ id, type, message, detail, hint, duration = 3000, onClose }: ToastProps) {
  const Icon = icons[type];
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailsId = useId();

  useEffect(() => {
    // Don't auto-close if expanded
    if (expanded) return;
    const timer = setTimeout(() => onClose(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, onClose, expanded]);

  const copyDetail = () => {
    const text = [message, detail, hint].filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const hasExtra = !!(detail || hint);

  return (
    <div
      className={`flex w-full flex-col rounded-lg border backdrop-blur-xl ${styles[type]} animate-slide-in`}
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      aria-live={type === 'error' || type === 'warning' ? 'assertive' : 'polite'}
    >
      {/* Main row */}
      <div className="flex items-start gap-2 px-4 py-3">
        <Icon size={18} className="mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium whitespace-pre-line break-words">{message}</span>
          {hint && !expanded && (
            <div className="mt-1 text-xs opacity-70">💡 {hint}</div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {hasExtra && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 hover:opacity-70 transition-opacity"
              title={expanded ? 'Collapse' : 'Show details'}
              aria-label={expanded ? 'Hide notification details' : 'Show notification details'}
              aria-expanded={expanded}
              aria-controls={detailsId}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          <button
            onClick={() => onClose(id)}
            className="p-0.5 hover:opacity-70 transition-opacity"
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (detail || hint) && (
        <div id={detailsId} className="px-4 pb-3 border-t border-white/10 pt-2">
          {hint && (
            <div className="text-xs mb-2 opacity-80">💡 <strong>Hint:</strong> {hint}</div>
          )}
          {detail && (
            <div className="relative">
              <pre className="text-[11px] bg-black/30 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
                {detail}
              </pre>
              <button
                onClick={copyDetail}
                className="absolute top-1 right-1 p-1 rounded bg-black/50 hover:bg-black/70 transition-colors"
                title="Copy error details"
                aria-label={copied ? 'Notification details copied' : 'Copy notification details'}
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToastContainer({ toasts, onClose }: { toasts: ToastProps[]; onClose: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <ViewportOverlay
      anchor="bottom-right"
      zIndex={1200}
      className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto overscroll-contain pr-1"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} onClose={onClose} />
      ))}
    </ViewportOverlay>
  );
}
