import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Trash2, ShieldAlert, X } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning';
  icon?: 'trash' | 'shield' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

const ICONS = {
  trash: Trash2,
  shield: ShieldAlert,
  warning: AlertTriangle,
};

export default function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  variant = 'danger',
  icon = 'trash',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const Icon = ICONS[icon];
  const isDanger = variant === 'danger';
  const accent = isDanger ? 'red' : 'amber';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={onCancel}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0, y: 10 }}
            transition={{ type: 'spring', damping: 22, stiffness: 300 }}
            className={`relative max-w-md w-full mx-4 rounded-2xl overflow-hidden border backdrop-blur-2xl shadow-2xl ${
              isDanger
                ? 'bg-[#12080E]/95 border-red-500/25 shadow-red-500/10'
                : 'bg-[#121008]/95 border-amber-500/25 shadow-amber-500/10'
            }`}
            onClick={e => e.stopPropagation()}
          >
            {/* Top accent line */}
            <div className={`h-[2px] w-full ${isDanger ? 'bg-gradient-to-r from-transparent via-red-500 to-transparent' : 'bg-gradient-to-r from-transparent via-amber-500 to-transparent'}`} />

            <div className="p-6">
              {/* Icon + Title */}
              <div className="flex items-start gap-4 mb-4">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  isDanger ? 'bg-red-500/10 border border-red-500/20' : 'bg-amber-500/10 border border-amber-500/20'
                }`}>
                  <Icon size={22} className={isDanger ? 'text-red-400' : 'text-amber-400'} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-white">{title}</h3>
                  <p className={`text-sm mt-1 ${isDanger ? 'text-red-200/60' : 'text-amber-200/60'}`}>
                    {message}
                  </p>
                </div>
                <button
                  onClick={onCancel}
                  className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Detail box */}
              {detail && (
                <div className={`rounded-xl p-3 mb-5 text-sm font-mono break-all ${
                  isDanger ? 'bg-red-500/5 border border-red-500/15 text-red-300/80' : 'bg-amber-500/5 border border-amber-500/15 text-amber-300/80'
                }`}>
                  {detail}
                </div>
              )}

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={onCancel}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors"
                >
                  {cancelLabel}
                </button>
                <button
                  onClick={onConfirm}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                    isDanger
                      ? 'bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25'
                      : 'bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25'
                  }`}
                >
                  <Icon size={14} />
                  {confirmLabel}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
