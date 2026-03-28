import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, X, ChevronDown, ChevronUp, Square } from 'lucide-react';
import sounds from '../../utils/sounds';

export interface ProgressNotificationProps {
  id: string;
  title: string; // "Installing Dependencies" / "Deploying Project" / "Building..."
  status: 'pending' | 'active' | 'complete' | 'error';
  progress: number; // 0-100
  statusText: string; // Current step: "pip install pygame..."
  logs?: string[]; // Live log lines
  error?: string;
  onCancel?: () => void;
  onDismiss: () => void;
}

export function ProgressNotification({
  id,
  title,
  status,
  progress,
  statusText,
  logs = [],
  error,
  onCancel,
  onDismiss,
}: ProgressNotificationProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const hasPlayedStartSound = useRef(false);
  const hasPlayedEndSound = useRef(false);

  // Auto-scroll logs
  useEffect(() => {
    if (logsExpanded && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, logsExpanded]);

  // Play sounds on status changes
  useEffect(() => {
    if (status === 'active' && !hasPlayedStartSound.current) {
      sounds.notification();
      hasPlayedStartSound.current = true;
    } else if (status === 'complete' && !hasPlayedEndSound.current) {
      sounds.success();
      hasPlayedEndSound.current = true;
    } else if (status === 'error' && !hasPlayedEndSound.current) {
      sounds.error();
      hasPlayedEndSound.current = true;
    }
  }, [status]);

  // Auto-dismiss after success
  useEffect(() => {
    if (status === 'complete') {
      const timer = setTimeout(onDismiss, 3000);
      return () => clearTimeout(timer);
    }
  }, [status, onDismiss]);

  const isActive = status === 'active';
  const isPending = status === 'pending';
  const isComplete = status === 'complete';
  const isError = status === 'error';

  // SVG progress ring
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  const pct = Math.round(progress);

  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 30, scale: 0.9, x: 20 }}
      animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
      exit={{ opacity: 0, y: -20, scale: 0.9 }}
      transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      className={`fixed bottom-4 right-4 z-50 w-80 overflow-hidden rounded-2xl border backdrop-blur-xl shadow-2xl ${
        isError ? 'bg-red-950/80 border-red-500/30' :
        isComplete ? 'bg-emerald-950/80 border-emerald-500/30' :
        'bg-slate-900/90 border-white/10'
      }`}
    >
      {/* Animated background shimmer for active state */}
      {isActive && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div 
            className="absolute inset-0 opacity-20"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(16,185,129,0.3), transparent)',
              animation: 'shimmer 2s infinite',
            }}
          />
        </div>
      )}

      <div className="relative p-4">
        {/* Header row */}
        <div className="flex items-start gap-3">
          {/* Circular progress ring */}
          <div className="relative flex-shrink-0" style={{ width: 72, height: 72 }}>
            <svg width="72" height="72" className={isActive ? 'animate-pulse' : ''}>
              {/* Background ring */}
              <circle 
                cx="36" cy="36" r={radius} 
                fill="none" 
                stroke="rgba(255,255,255,0.08)" 
                strokeWidth="4" 
              />
              {/* Progress ring */}
              <circle
                cx="36" cy="36" r={radius}
                fill="none"
                stroke={
                  isError ? '#EF4444' : 
                  isComplete ? '#10B981' : 
                  isPending ? '#64748b' :
                  'url(#notifProgressGrad)'
                }
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                transform="rotate(-90 36 36)"
                style={{ transition: 'stroke-dashoffset 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
              />
              {/* Gradient definition */}
              <defs>
                <linearGradient id="notifProgressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#10B981" />
                  <stop offset="100%" stopColor="#3B82F6" />
                </linearGradient>
              </defs>
            </svg>
            {/* Center content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {isComplete ? (
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', damping: 10 }}>
                  <CheckCircle size={24} className="text-emerald-400" />
                </motion.div>
              ) : isError ? (
                <AlertCircle size={24} className="text-red-400" />
              ) : isPending ? (
                <span className="text-sm font-medium text-slate-400">...</span>
              ) : (
                <span className="text-lg font-bold tabular-nums">{pct}%</span>
              )}
            </div>
          </div>

          {/* Title and status */}
          <div className="flex-1 min-w-0 pt-1">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
              <button
                onClick={onDismiss}
                className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors flex-shrink-0"
                title="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
            
            <p className={`text-xs truncate ${
              isError ? 'text-red-300' : 
              isComplete ? 'text-emerald-300' : 
              'text-slate-400'
            }`}>
              {error || statusText}
            </p>

            {/* Mini progress bar */}
            <div className="relative h-1 mt-2 bg-white/10 rounded-full overflow-hidden">
              <motion.div
                className={`absolute left-0 top-0 h-full rounded-full ${
                  isError ? 'bg-red-500' : 
                  isComplete ? 'bg-emerald-500' : 
                  'bg-gradient-to-r from-emerald-500 to-blue-500'
                }`}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              />
            </div>
          </div>
        </div>

        {/* Expandable logs section */}
        {logs.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setLogsExpanded(!logsExpanded)}
              className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              {logsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {logsExpanded ? 'Hide' : 'Show'} logs ({logs.length} lines)
            </button>
            
            <AnimatePresence>
              {logsExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] text-slate-400 leading-relaxed">
                    {logs.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap break-all">
                        {line}
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Cancel button for active operations */}
        {(isActive || isPending) && onCancel && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 hover:bg-red-500/20 text-slate-400 hover:text-red-300 transition-colors"
            >
              <Square size={10} />
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* CSS for shimmer animation */}
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </motion.div>
  );
}

// Container for multiple notifications
export function ProgressNotificationContainer({ 
  notifications 
}: { 
  notifications: ProgressNotificationProps[] 
}) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-3">
      <AnimatePresence mode="popLayout">
        {notifications.map((notif, index) => (
          <motion.div
            key={notif.id}
            style={{ position: 'relative', zIndex: notifications.length - index }}
            initial={{ opacity: 0, y: 30, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
          >
            <ProgressNotification {...notif} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default ProgressNotification;
