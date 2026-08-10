import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, X } from "lucide-react";
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
  /** ISO timestamp owned by the backend, so elapsed time survives a refresh. */
  busyStartedAt?: string | null;
  /** Last durable installer checkpoint; used only to expose stalled feedback. */
  busyUpdatedAt?: string | null;
  /** Durable server phase copy shown above the progress bar. */
  busyPhaseLabel?: string | null;
  busyPhaseDetail?: string | null;
  busyConnectionState?: "connected" | "reconnecting";
  busySteps?: Array<{ label: string; detail?: string | null; tone?: "complete" | "attention" }>;
  allowDismissWhileBusy?: boolean;
  confirmDisabled?: boolean;
  showConfirmAction?: boolean;
  cancelLabel?: string;
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
  busyStartedAt = null,
  busyUpdatedAt = null,
  busyPhaseLabel = null,
  busyPhaseDetail = null,
  busyConnectionState = "connected",
  busySteps = [],
  allowDismissWhileBusy = false,
  confirmDisabled = false,
  showConfirmAction = true,
  cancelLabel = "Cancel",
  tone = "warning",
  details,
  onCancel,
  onConfirm,
}: TypedConfirmationDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Keep the RefObject identity stable for the lifetime of the modal. Changing
  // the object while `busy` flips would make ViewportModal unregister and
  // recapture focus from inside the dialog, losing the original opener.
  const initialFocusRef = useRef<HTMLElement | null>(null);
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
    const serverStartedAt = busyStartedAt ? Date.parse(busyStartedAt) : Number.NaN;
    const startedAt = Number.isFinite(serverStartedAt) ? serverStartedAt : Date.now();
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    updateElapsed();
    const interval = window.setInterval(() => {
      updateElapsed();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [busy, busyStartedAt]);

  const confirmed = isTypedConfirmationMatch(confirmationPhrase, confirmation);
  const danger = tone === "danger";
  const determinate =
    typeof busyProgress === "number" && Number.isFinite(busyProgress);
  const progressPercent = determinate
    ? Math.min(100, Math.max(0, busyProgress! * 100))
    : 0;
  const lastFeedbackAt = busyUpdatedAt ? Date.parse(busyUpdatedAt) : Number.NaN;
  const feedbackIsStale = busy
    && busyConnectionState === "connected"
    && Number.isFinite(lastFeedbackAt)
    && Date.now() - lastFeedbackAt >= 90_000;

  const handleConfirm = () => {
    if (busy || confirmDisabled || !confirmed || submittedRef.current) return;
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
      dismissible={!busy || allowDismissWhileBusy}
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
            ref={(node) => {
              if (!busy && !(confirmationPhrase && showConfirmAction)) {
                initialFocusRef.current = node;
              }
            }}
            type="button"
            onClick={onCancel}
            disabled={busy && !allowDismissWhileBusy}
            className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text disabled:opacity-50"
            aria-label="Close confirmation dialog"
          >
            <X size={18} className="mx-auto" />
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-5">
          {details}
          {confirmationPhrase && showConfirmAction && (
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
                ref={(node) => {
                  if (!busy && confirmationPhrase && showConfirmAction) {
                    initialFocusRef.current = node;
                  }
                }}
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
            className="shrink-0 border-t border-theme-border bg-theme-bg px-5 py-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0" aria-live="polite" aria-atomic="true">
                <p
                  ref={(node) => {
                    if (busy) initialFocusRef.current = node;
                  }}
                  tabIndex={-1}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-theme-text outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40"
                >
                  {busyConnectionState === "reconnecting" ? (
                    <RefreshCw size={14} className="animate-spin motion-reduce:animate-none text-amber-300" aria-hidden="true" />
                  ) : (
                    <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  )}
                  {busyPhaseLabel || busyLabel || confirmLabel}
                </p>
                {busyPhaseDetail && (
                  <p className="mt-1 text-xs leading-5 text-theme-text-muted">{busyPhaseDetail}</p>
                )}
              </div>
              <span className="shrink-0 text-[11px] font-medium text-theme-text-muted tabular-nums">
                {determinate
                  ? `${Math.round(progressPercent)}% · ${formatElapsed(elapsedSeconds)}`
                  : `Working… ${formatElapsed(elapsedSeconds)}`}
              </span>
            </div>
            {busyConnectionState === "reconnecting" && (
              <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100" role="status">
                Portal is restarting or temporarily unavailable. The updater continues on the server; live feedback will resume automatically.
              </p>
            )}
            {feedbackIsStale && (
              <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
                No new installer phase has been reported for over 90 seconds. The update is still tracked on the server; this does not permit a second update.
              </p>
            )}
            <div
              role="progressbar"
              aria-label={busyPhaseLabel || busyLabel || `${confirmLabel} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={determinate ? Math.round(progressPercent) : undefined}
              aria-valuetext={determinate
                ? `${Math.round(progressPercent)}% complete. ${busyPhaseLabel || busyLabel || confirmLabel}${busyPhaseDetail ? `. ${busyPhaseDetail}` : ""}`
                : `${busyPhaseLabel || busyLabel || confirmLabel}. Elapsed ${formatElapsed(elapsedSeconds)}`}
              className="mt-3 h-2.5 w-full overflow-hidden rounded-full border border-white/5 bg-theme-border/70 shadow-inner shadow-black/20"
            >
              {determinate ? (
                <div
                  className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${danger ? "bg-gradient-to-r from-red-500 via-rose-400 to-amber-300" : "bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400"}`}
                  style={{ width: `${progressPercent}%` }}
                />
              ) : (
                <div
                  className={`typed-confirmation-progress-sweep h-full w-1/3 rounded-full ${danger ? "bg-gradient-to-r from-red-500 via-rose-400 to-amber-300" : "bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400"}`}
                />
              )}
            </div>
            {busySteps.length > 0 && (
              <div className="mt-3 border-t border-theme-border/70 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Recent installer steps</p>
                <ol className="mt-2 max-h-24 space-y-1.5 overflow-y-auto">
                  {busySteps.slice(-4).map((step, index) => (
                    <li key={`${step.label}-${index}`} className="flex items-start gap-2 text-xs text-theme-text-muted">
                      {step.tone === "attention" ? (
                        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
                      ) : (
                        <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                      )}
                      <span>
                        <span className="font-medium text-theme-text">{step.label}</span>
                        {step.detail ? <span className="block leading-5">{step.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-theme-border bg-theme-bg px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy && !allowDismissWhileBusy}
            className="min-h-[44px] rounded-xl border border-theme-border bg-theme-surface px-4 py-2 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          {showConfirmAction && (
            <button
              type="button"
              onClick={handleConfirm}
              // Only the not-yet-confirmed state dims (opacity-45). The busy state
              // stays full-opacity with its own spinner + progress bar so it can
              // never read as a faded ghost of a still-active approval button.
              disabled={busy || confirmDisabled || !confirmed}
              aria-busy={busy}
              className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed ${busy ? "cursor-progress opacity-100" : "disabled:opacity-45"} ${danger ? "border-red-400/30 bg-red-500/20 text-red-100 hover:bg-red-500/30" : "border-amber-400/30 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"}`}
            >
              {busy && (
                <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              )}
              {busy ? busyLabel || confirmLabel : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </ViewportModal>
  );
}
