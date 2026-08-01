import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { isTypedConfirmationMatch } from "../utils/typedConfirmation";
import ViewportModal from "./ViewportModal";

type TypedConfirmationDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmationPhrase?: string | null;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  /**
   * Optional 0–1 completion when the caller genuinely knows progress. When
   * omitted (the common case — these run arbitrary backend operations of
   * unknown length), the bar is indeterminate and an elapsed-time readout
   * communicates that the operation is alive.
   */
  busyProgress?: number | null;
  tone?: "warning" | "danger";
  details?: ReactNode;
  onCancel: () => void;
  onConfirm: (confirmation: string) => void;
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

export default function TypedConfirmationDialog({
  open,
  title,
  description,
  confirmationPhrase = null,
  confirmLabel,
  busyLabel,
  busy = false,
  busyProgress = null,
  tone = "warning",
  details,
  onCancel,
  onConfirm,
}: TypedConfirmationDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Guards against a fast double-click firing onConfirm twice in the same tick,
  // before the parent's `busy` re-render disables the button. Reset whenever
  // the operation ends (busy clears) or the dialog reopens.
  const submittedRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    setConfirmation("");
    submittedRef.current = false;
  }, [open]);

  // Elapsed-time readout for the pending state: reset on each busy start, then
  // tick once a second so short and long operations both read as progressing.
  useEffect(() => {
    if (!busy) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [busy]);

  const confirmed = isTypedConfirmationMatch(confirmationPhrase, confirmation);
  const danger = tone === "danger";
  const initialFocusRef = confirmationPhrase ? inputRef : closeRef;
  const determinate =
    typeof busyProgress === "number" && Number.isFinite(busyProgress);
  const progressPercent = determinate
    ? Math.min(100, Math.max(0, busyProgress! * 100))
    : 0;

  const handleConfirm = () => {
    if (busy || !confirmed || submittedRef.current) return;
    submittedRef.current = true;
    onConfirm(confirmation.trim());
    // Only guard against a synchronous same-tick double-click; release on the
    // next tick so a deliberate second action (e.g. after ticking a required
    // acknowledgement) still works even when the consumer gates its own
    // side-effect without flipping `busy`.
    setTimeout(() => {
      submittedRef.current = false;
    }, 0);
  };

  return (
    <ViewportModal
      open={open}
      onDismiss={onCancel}
      dismissible={!busy}
      initialFocusRef={initialFocusRef}
      className="bg-black/75 px-4 py-6 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[calc(100dvh-3rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl shadow-black/50"
      >
        <div
          className={`flex shrink-0 items-start gap-3 border-b px-5 py-4 ${danger ? "border-red-500/20 bg-red-500/10" : "border-amber-500/20 bg-amber-500/10"}`}
        >
          <AlertTriangle
            size={20}
            className={`mt-0.5 shrink-0 ${danger ? "text-red-300" : "text-amber-300"}`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="text-base font-semibold text-theme-text"
            >
              {title}
            </h2>
            <p
              id={descriptionId}
              className="mt-1 text-sm leading-6 text-theme-text-muted"
            >
              {description}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text disabled:opacity-50"
            aria-label="Close confirmation dialog"
          >
            <X size={18} className="mx-auto" />
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-5">
          {details}
          {confirmationPhrase && (
            <div>
              <label
                htmlFor={`${titleId}-confirmation`}
                className="block text-sm text-theme-text-muted"
              >
                Type{" "}
                <code className="select-all rounded bg-black/30 px-1.5 py-0.5 font-mono text-amber-200">
                  {confirmationPhrase}
                </code>{" "}
                to continue.
              </label>
              <input
                ref={inputRef}
                id={`${titleId}-confirmation`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleConfirm();
                  }
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                className="mt-2 min-h-[44px] w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 font-mono text-sm text-theme-text outline-none transition focus:border-amber-400/50 focus:ring-2 focus:ring-amber-400/20 disabled:opacity-60"
              />
            </div>
          )}
        </div>

        {busy && (
          <div
            className="shrink-0 border-t border-theme-border bg-theme-bg px-5 pt-4"
            aria-hidden="true"
          >
            <div className="flex items-center justify-between text-[11px] font-medium text-theme-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {busyLabel || confirmLabel}
              </span>
              <span className="tabular-nums">
                {determinate
                  ? `${Math.round(progressPercent)}%`
                  : `Working… ${formatElapsed(elapsedSeconds)}`}
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-theme-border/60">
              {determinate ? (
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${danger ? "bg-red-400/80" : "bg-amber-400/80"}`}
                  style={{ width: `${progressPercent}%` }}
                />
              ) : (
                <div
                  className={`typed-confirmation-progress-sweep h-full w-1/3 rounded-full ${danger ? "bg-red-400/80" : "bg-amber-400/80"}`}
                />
              )}
            </div>
          </div>
        )}

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-theme-border bg-theme-bg px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[44px] rounded-xl border border-theme-border bg-theme-surface px-4 py-2 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            // Only the not-yet-confirmed state dims (opacity-45). The busy state
            // stays full-opacity with its own spinner + progress bar so it can
            // never read as a faded ghost of a still-active approval button.
            disabled={busy || !confirmed}
            aria-busy={busy}
            className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed ${busy ? "cursor-progress opacity-100" : "disabled:opacity-45"} ${danger ? "border-red-400/30 bg-red-500/20 text-red-100 hover:bg-red-500/30" : "border-amber-400/30 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"}`}
          >
            {busy && (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            )}
            {busy ? busyLabel || confirmLabel : confirmLabel}
          </button>
        </div>
      </div>
    </ViewportModal>
  );
}
