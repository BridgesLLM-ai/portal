import { Loader2 } from 'lucide-react';
import type { ToolsActiveRun } from '../../api/maintenanceTools';
import { TOOL_TONE_CLASSES, formatDuration, stepDetailText } from './toolsPresentation';

/** Run phases in owner words (DESIGN c, run states). */
const PHASE_LABELS: Record<string, string> = {
  queued: 'Waiting to start',
  preflight: 'Checking…',
  'node-runtime': 'Updating Node.js runtime',
  'plugins-pre': 'Preparing Portal plugins',
  native: 'OpenClaw is updating',
  'plugins-post': 'Reconnecting Portal plugins',
  contract: 'Checking Portal features',
  checks: 'Re-running checks',
  // npm CLI runs report their current step as the phase.
  installed: 'Reading the installed version',
  resolve: 'Finding the release',
  fetch: 'Downloading',
  'verify-source': 'Verifying the download',
  compare: 'Comparing with the installed files',
  probe: 'Testing',
  // Hermes: the installer helper builds the new generation next to the current one (one long step).
  stage: 'Building the new version',
  'probe-candidate': 'Testing the new version',
  swap: 'Switching versions',
  'probe-installed': 'Testing the installed version',
  commit: 'Recording the result',
  cleanup: 'Cleaning up',
};

const NATIVE_PHASE_LABELS: Record<string, string> = {
  requested: 'requested',
  staging: 'staging the new version',
  validating: 'validating it on a copy',
  repairing: 'repairing',
  activating: 'switching over',
  restarting: 'restarting',
  verifying: 'verifying',
  finished: 'finished',
};

function stepStateLabel(state: string): string {
  switch (state) {
    case 'passed': case 'succeeded': case 'done': return 'done';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'unproven': return 'not confirmed';
    case 'not-run': return 'not run';
    case 'running': case 'started': return 'in progress';
    default: return state;
  }
}

export function runPhaseLabel(run: Pick<ToolsActiveRun, 'phase' | 'nativePhase'>): string {
  const base = PHASE_LABELS[run.phase] || run.phase;
  if (run.phase === 'native' && run.nativePhase) return `${base} (${NATIVE_PHASE_LABELS[run.nativePhase] || run.nativePhase})`;
  return base;
}

export default function AiToolsRunProgress({
  run,
  toolLabel,
  nowMs = Date.now(),
  owner = false,
  busy = false,
  onStop,
}: {
  run: ToolsActiveRun;
  toolLabel: string;
  nowMs?: number;
  owner?: boolean;
  busy?: boolean;
  /** Owner asked to stop this run (the panel confirms first). */
  onStop?: () => void;
}) {
  const stopNoteId = 'ai-tools-stop-note';
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const elapsed = Number.isFinite(startedMs) ? formatDuration(nowMs - startedMs) : null;
  const noun = run.action === 'install' ? 'installation' : 'update';
  return (
    <div
      role="region"
      aria-labelledby="ai-tools-progress-heading"
      className={`rounded-lg border px-3 py-3 text-xs leading-5 ${TOOL_TONE_CLASSES.progress}`}
    >
      <div className="flex items-start gap-2">
        <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
        <div className="min-w-0">
          <h3 id="ai-tools-progress-heading" className="text-sm font-semibold">{toolLabel}: {runPhaseLabel(run)}</h3>
          <p aria-live="polite">
            {elapsed ? `Running for ${elapsed}. ` : ''}It is safe to leave this page; the {noun} continues on the server.
          </p>
          {run.gatewayRestarting && (
            // K7: the gateway may be stopped for a switch-over, a repair or a whole mode-B update, not only restarting.
            <p className="mt-1">OpenClaw's gateway is stopped or restarting, so chat is unavailable until it is back; this page keeps checking.</p>
          )}
        </div>
      </div>
      {owner && onStop && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || Boolean(run.stopRefusal)}
            aria-describedby={run.stopRefusal ? stopNoteId : undefined}
            onClick={onStop}
            className="inline-flex min-h-[40px] items-center rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs font-medium text-theme-text transition hover:bg-theme-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stop this {noun}
          </button>
          {run.stopRefusal && <p id={stopNoteId} className="text-theme-text-muted">{run.stopRefusal}</p>}
        </div>
      )}
      {run.steps.length > 0 && (
        <ol aria-label="Update steps" className="mt-2 space-y-1">
          {run.steps.map((step) => (
            <li key={step.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium text-theme-text">{step.label}</span>
              <span className="text-theme-text-muted">— {stepStateLabel(step.state)}</span>
              {step.detail && <span className="w-full text-theme-text-muted">{stepDetailText(step.detail)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
