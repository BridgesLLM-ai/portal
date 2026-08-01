import { motion } from "framer-motion";
import { AlertTriangle, Loader2, Trash2, ShieldAlert, X } from "lucide-react";
import { useId, useRef } from "react";
import ViewportModal from "./ViewportModal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  error?: string | null;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  icon?: "trash" | "shield" | "warning";
  busy?: boolean;
  busyLabel?: string;
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
  error = null,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "danger",
  icon = "trash",
  busy = false,
  busyLabel = "Working…",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const Icon = ICONS[icon];
  const isDanger = variant === "danger";
  const titleId = useId();
  const messageId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <ViewportModal
      open={open}
      onDismiss={onCancel}
      dismissible={!busy}
      initialFocusRef={cancelButtonRef}
      className="bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        initial={{ scale: 0.92, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", damping: 22, stiffness: 300 }}
        className={`relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border bg-theme-surface text-theme-text backdrop-blur-2xl shadow-2xl ${
          isDanger
            ? "border-red-500/25 shadow-red-500/10"
            : "border-amber-500/25 shadow-amber-500/10"
        }`}
      >
        {/* Top accent line */}
        <div
          className={`h-[2px] w-full ${isDanger ? "bg-gradient-to-r from-transparent via-red-500 to-transparent" : "bg-gradient-to-r from-transparent via-amber-500 to-transparent"}`}
        />

        <div className="p-6">
          {/* Icon + Title */}
          <div className="flex items-start gap-4 mb-4">
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                isDanger
                  ? "bg-red-500/10 border border-red-500/20"
                  : "bg-amber-500/10 border border-amber-500/20"
              }`}
            >
              <Icon
                size={22}
                className={isDanger ? "text-red-400" : "text-amber-400"}
              />
            </div>
            <div className="flex-1 min-w-0">
              <h3
                id={titleId}
                className="text-base font-semibold text-theme-text"
              >
                {title}
              </h3>
              <p
                id={messageId}
                className={`text-sm mt-1 ${isDanger ? "text-red-200/60" : "text-amber-200/60"}`}
              >
                {message}
              </p>
            </div>
            <button
              aria-label="Close confirmation dialog"
              onClick={onCancel}
              disabled={busy}
              className="p-1 rounded-lg text-theme-text-muted hover:text-theme-text hover:bg-theme-surface-hover transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </div>

          {/* Detail box */}
          {detail && (
            <div
              className={`rounded-xl p-3 mb-5 text-sm font-mono break-all ${
                isDanger
                  ? "bg-red-500/5 border border-red-500/15 text-red-300/80"
                  : "bg-amber-500/5 border border-amber-500/15 text-amber-300/80"
              }`}
            >
              {detail}
            </div>
          )}

          {error && (
            <div role="alert" className="mb-5 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              ref={cancelButtonRef}
              onClick={onCancel}
              disabled={busy}
              data-contrast-check="confirmation-cancel"
              className="flex-1 py-2.5 rounded-xl bg-theme-surface-raised border border-theme-border text-theme-text text-sm font-medium hover:bg-theme-surface-hover transition-colors disabled:cursor-not-allowed disabled:opacity-45"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              aria-busy={busy}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                isDanger
                  ? "bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25"
                  : "bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25"
              }`}
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Icon size={14} />
              )}
              {busy ? busyLabel : confirmLabel}
            </button>
          </div>
        </div>
      </motion.div>
    </ViewportModal>
  );
}
