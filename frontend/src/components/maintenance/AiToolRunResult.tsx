import type { ToolLastRun, ToolStatusItem } from '../../api/maintenanceTools';
import { OPENCLAW_PREFLIGHT_FRESH_MS, TOOL_TONE_CLASSES, formatAge, type ToolTone } from './toolsPresentation';

/** Next steps the panel can start itself; anything else is shown as an instruction (g.3, c.6). */
export type ToolNextAction = 'retry-checks' | 'recover-native' | 'node-runtime';

const NEXT_ACTION_LABELS: Record<ToolNextAction, string> = {
  'retry-checks': 'Retry checks',
  'recover-native': 'Run OpenClaw repair',
  'node-runtime': 'Review the update with Node.js',
};

/** Known next-action ids in plain words; free text from OpenClaw is shown as it is. */
const NEXT_ACTION_TEXT: Record<string, string> = {
  'retry-checks': 'Run the Portal feature checks again.',
  'recover-native': 'Run OpenClaw repair.',
  'node-runtime': 'Update Node.js together with OpenClaw: tick "Also update Node.js" in the update review.',
  'openclaw-status': 'Check that OpenClaw is running and healthy, then try again.',
  'recover-legacy': 'Recover the interrupted maintenance first.',
  'free-disk': 'Free disk space on the server, then try again.',
  // toolctl after a failed re-check: an update it admits, else a re-check (the update would change nothing).
  'update-recommended': 'Update it to the recommended version.',
  requalify: 'Re-check it once the cause above is fixed.',
};

export function nextActionInstruction(nextAction: string): string {
  return NEXT_ACTION_TEXT[nextAction] || nextAction;
}

/** A button only when the API accepts the action for this tool right now. */
export function acceptedNextAction(tool: Pick<ToolStatusItem, 'runActions'>, nextAction: string | null): ToolNextAction | null {
  if (nextAction === 'retry-checks' && tool.runActions.includes('retry-checks')) return 'retry-checks';
  if (nextAction === 'recover-native' && tool.runActions.includes('recover-native')) return 'recover-native';
  if (nextAction === 'node-runtime' && tool.runActions.includes('update')) return 'node-runtime';
  return null;
}

/**
 * A refusal's reason is toolctl's present-tense text ("…so the update can't start"). Older than the window in which a
 * pre-flight's answer counts as current, the result says how old it is: after a Portal update an earlier refusal must
 * not read as today's answer. Null for a fresh refusal or any other result.
 */
export function refusalAge(run: Pick<ToolLastRun, 'state' | 'startedAt' | 'endedAt'>, nowMs = Date.now()): string | null {
  if (run.state !== 'refused') return null;
  const at = Date.parse(run.endedAt || run.startedAt || '');
  if (!Number.isFinite(at) || nowMs - at <= OPENCLAW_PREFLIGHT_FRESH_MS) return null;
  return formatAge(new Date(at).toISOString(), nowMs);
}

function outcome(run: ToolLastRun, label: string): { tone: ToolTone; title: string; body: string | null } {
  const fromTo = run.from && run.to && run.from !== run.to ? `${run.from} → ${run.to}` : (run.to || run.from || null);
  switch (run.state) {
    case 'succeeded':
      if (run.action === 'preflight') return { tone: 'good', title: `Pre-flight passed — ${label} can update.`, body: null };
      if (run.action === 'requalify') return { tone: 'good', title: `Checked — ${label}${run.to ? ` ${run.to}` : ''} is confirmed.`, body: null };
      // Retry checks changes nothing: its result is the checks, never "Updated".
      if (run.action === 'retry-checks') {
        return { tone: 'good', title: `Checks passed — ${label}${run.to ? ` ${run.to}` : ''} answers every required Portal check.`, body: null };
      }
      if (run.action === 'install') return { tone: 'good', title: `Installed ${label}${run.to ? ` ${run.to}` : ''}.`, body: 'All required checks passed.' };
      return { tone: 'good', title: `Updated${fromTo ? `: ${fromTo}` : ''}.`, body: 'All required checks passed.' };
    case 'succeeded-degraded':
      return { tone: 'attention', title: `Updated${fromTo ? `: ${fromTo}` : ''}, but some checks did not pass.`, body: run.message };
    case 'refused':
      // A Re-check or a pre-flight never updates anything: its title is its own result, not "Not updated".
      if (run.action === 'preflight') {
        return { tone: 'attention', title: `Pre-flight refused — ${run.message || `${label} cannot update yet.`}`, body: 'Nothing was changed.' };
      }
      if (run.action === 'requalify') {
        return { tone: 'attention', title: `Checked — ${run.message || `${label} was not confirmed.`}`, body: 'Nothing was changed.' };
      }
      // N4: plugins installed before the refusal are a change; the message names them.
      if (run.pluginsInstalled?.length) {
        return { tone: 'attention', title: `Not ${run.action === 'install' ? 'installed' : 'updated'}.`, body: run.message };
      }
      return { tone: 'attention', title: `Not ${run.action === 'install' ? 'installed' : 'updated'}. Nothing was changed.`, body: run.message };
    case 'rolled-back':
      if (run.action === 'install') {
        return {
          tone: 'attention',
          title: `Install failed; what it added was removed, so ${label} is still not installed.`,
          body: run.message ? `Reason: ${run.message}` : null,
        };
      }
      return {
        tone: 'attention',
        title: `Update failed; ${label} automatically returned to ${run.from || 'the previous version'}.`,
        body: run.message ? `Reason: ${run.message}` : null,
      };
    case 'recovery-required':
      // The update stopped before it replaced anything: the previous version runs again.
      if (run.errorId === 'UPDATE_NOT_APPLIED') {
        return { tone: 'attention', title: `Not updated; ${label}${run.from ? ` ${run.from}` : ''} is running again.`, body: run.message };
      }
      // Started again after its checks failed and the Portal could not return to the previous version.
      if (run.nextAction === 'retry-checks') return { tone: 'bad', title: `${label} is running, but its Portal checks did not pass.`, body: run.message };
      return { tone: 'bad', title: `${label} needs recovery. Chat may be unavailable.`, body: run.message };
    case 'failed':
      return { tone: 'bad', title: 'The last run failed.', body: run.message };
    default:
      return { tone: 'neutral', title: `Last run: ${run.state}.`, body: run.message };
  }
}

export default function AiToolRunResult({
  tool,
  owner,
  busy,
  onNextAction,
}: {
  tool: ToolStatusItem;
  owner: boolean;
  busy: boolean;
  onNextAction: (action: ToolNextAction) => void;
}) {
  const run = tool.lastRun;
  if (!run) return null;
  // A tool that is gone now: an earlier success ("Checked — … is confirmed", "Installed …") would read as current.
  if (tool.status === 'not-installed' && (run.state === 'succeeded' || run.state === 'succeeded-degraded')) return null;
  const result = outcome(run, tool.label);
  const accepted = acceptedNextAction(tool, run.nextAction);
  const refusals = run.state === 'refused' ? run.refusals : [];
  const extraRefusals = refusals.filter((entry) => entry.message !== run.message);
  const age = refusalAge(run);
  return (
    <div
      role="group"
      aria-label={`Last ${tool.label} run`}
      data-testid={`ai-tool-${tool.id}-result`}
      className={`rounded-lg border px-3 py-2 text-xs leading-5 ${TOOL_TONE_CLASSES[result.tone]}`}
    >
      <p className="font-semibold">{result.title}</p>
      {result.body && <p>{result.body}</p>}
      {extraRefusals.length > 0 && (
        <ul aria-label="Other reasons" className="mt-1 list-disc pl-4">
          {extraRefusals.map((entry) => (
            <li key={`${entry.id}:${entry.check}`}>
              {entry.message}
              {entry.nextAction && !acceptedNextAction(tool, entry.nextAction) ? ` ${nextActionInstruction(entry.nextAction)}` : ''}
            </li>
          ))}
        </ul>
      )}
      {age && <p data-testid={`ai-tool-${tool.id}-result-age`} className="mt-1">This result is from a run {age} ago.</p>}
      {run.nextAction && (accepted && owner ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onNextAction(accepted)}
          className="mt-2 inline-flex min-h-[40px] items-center rounded-lg border border-theme-border-strong bg-theme-surface-strong px-3 py-2 text-xs font-medium text-theme-text transition hover:bg-theme-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-50"
        >
          {NEXT_ACTION_LABELS[accepted]}
        </button>
      ) : (
        <p className="mt-1">Next step: {nextActionInstruction(run.nextAction)}</p>
      ))}
    </div>
  );
}
